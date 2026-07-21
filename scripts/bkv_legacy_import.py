#!/usr/bin/env python3
"""Fail-closed inventory tooling for untrusted BKV legacy archives."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Callable, Iterable, Sequence


TARGET_SEQ_NOS = tuple(range(1_893_700, 1_893_711))
MANIFEST_NAME = "manifest.inventory.json"
MANIFEST_SCHEMA = "steel.bkv-archive-inventory.v1"
_BATCH_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_IMAGE_MEMBER = re.compile(
    r"image_copy/CamImageSource(?P<camera>[1-6])/(?P<seq>\d+)/"
    r"(?P<kind>2D|3D)/(?P<name>[^/]+(?P<extension>\.jpg|\.d3img|\.dat))\Z",
    re.IGNORECASE,
)


def wanted_seq_no(value: int) -> bool:
    """Return whether value belongs to the exact approved legacy batch."""
    return value in TARGET_SEQ_NOS


def normalize_member(value: str) -> str | None:
    """Return a safe canonical archive member, or None for unsafe syntax."""
    if not isinstance(value, str) or not value or "\x00" in value:
        return None
    if value.startswith(("/", "\\")) or PureWindowsPath(value).drive:
        return None
    canonical = value.replace("\\", "/")
    path = PurePosixPath(canonical)
    if path.is_absolute() or any(part in ("", ".", "..") for part in canonical.split("/")):
        return None
    return path.as_posix()


def _image_metadata(member: str) -> dict[str, object] | None:
    normalized = normalize_member(member)
    if normalized is None:
        return None
    match = _IMAGE_MEMBER.fullmatch(normalized)
    if match is None:
        return None
    seq_no = int(match.group("seq"))
    if not wanted_seq_no(seq_no):
        return None
    return {
        "cameraNumber": int(match.group("camera")),
        "seqNo": seq_no,
        "kind": match.group("kind").upper(),
        "extension": match.group("extension").lower(),
    }


def wanted_image_member(value: str) -> bool:
    return _image_metadata(value) is not None


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_reparse_point(path: Path) -> bool:
    """Detect links and Windows reparse points without following them."""
    try:
        details = path.lstat()
    except FileNotFoundError:
        return False
    attributes = getattr(details, "st_file_attributes", 0)
    reparse_attribute = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return path.is_symlink() or bool(attributes & reparse_attribute)


def _existing_chain(path: Path) -> Iterable[Path]:
    current = path
    while True:
        if current.exists() or is_reparse_point(current):
            yield current
        if current == current.parent:
            return
        current = current.parent


def _validate_output_path(output_root: Path, batch_id: str, inputs: Sequence[Path]) -> Path:
    if not _BATCH_ID.fullmatch(batch_id) or batch_id in (".", ".."):
        raise ValueError("batch-id must be a safe single path component")

    raw_output_root = output_root.expanduser()
    if ".." in raw_output_root.parts:
        raise ValueError("output-root must not contain parent traversal")
    if not raw_output_root.is_absolute():
        raw_output_root = Path.cwd() / raw_output_root
    raw_batch_root = raw_output_root / batch_id
    for candidate in _existing_chain(raw_batch_root):
        if is_reparse_point(candidate):
            raise ValueError(f"output path contains a reparse point: {candidate}")

    output_root = raw_output_root.resolve(strict=False)
    batch_root = (output_root / batch_id).resolve(strict=False)
    if batch_root.parent != output_root:
        raise ValueError("batch output escapes output-root")

    for input_path in inputs:
        if output_root == input_path or output_root.is_relative_to(input_path):
            raise ValueError(f"output-root overlaps input archive: {input_path}")
        if input_path.is_relative_to(output_root):
            raise ValueError(f"input archive overlaps output-root: {input_path}")

    for candidate in _existing_chain(batch_root):
        if is_reparse_point(candidate):
            raise ValueError(f"output path contains a reparse point: {candidate}")
    return batch_root


def _resolve_input(path: os.PathLike[str] | str, label: str) -> Path:
    resolved = Path(path).resolve(strict=True)
    if not resolved.is_file():
        raise ValueError(f"{label} must be a file: {resolved}")
    return resolved


def locate_unrar(explicit: os.PathLike[str] | str | None = None) -> Path:
    candidates: list[Path] = []
    if explicit is not None:
        candidates.append(Path(explicit))
    else:
        configured = os.environ.get("UNRAR_EXE")
        if configured:
            candidates.append(Path(configured))
        discovered = shutil.which("UnRAR.exe")
        if discovered:
            candidates.append(Path(discovered))
        for variable in ("ProgramFiles", "ProgramFiles(x86)"):
            root = os.environ.get(variable)
            if root:
                candidates.append(Path(root) / "WinRAR" / "UnRAR.exe")

    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=True)
        except FileNotFoundError:
            continue
        if resolved.is_file() and not is_reparse_point(resolved):
            return resolved
    raise FileNotFoundError(
        "UnRAR.exe was not found; pass --unrar or set UNRAR_EXE to its absolute path"
    )


def _base_entry(
    *,
    archive_part: str,
    member: str,
    size: int,
    sha256: str | None,
    integrity_status: str,
    integrity_evidence: str | None,
) -> dict[str, object]:
    return {
        "sha256": sha256,
        "size": size,
        "archivePart": archive_part,
        "memberPath": member,
        "cameraNumber": None,
        "seqNo": None,
        "kind": "database" if archive_part == "database-zip" else None,
        "extension": PurePosixPath(member).suffix.lower(),
        "integrityStatus": integrity_status,
        "integrityEvidence": integrity_evidence,
    }


def _inventory_zip(path: Path) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    with zipfile.ZipFile(path) as archive:
        for info in sorted(archive.infolist(), key=lambda item: item.filename):
            if info.is_dir():
                continue
            member = normalize_member(info.filename)
            if member is None:
                raise ValueError(f"unsafe ZIP member path: {info.filename!r}")
            unix_mode = info.external_attr >> 16
            if stat.S_ISLNK(unix_mode):
                raise ValueError(f"ZIP link member is not allowed: {member}")
            digest = hashlib.sha256()
            status = "ok"
            evidence = None
            try:
                with archive.open(info, "r") as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        digest.update(chunk)
                member_sha256: str | None = digest.hexdigest()
            except (zipfile.BadZipFile, RuntimeError, OSError) as error:
                member_sha256 = None
                status = "crc-failed" if "CRC" in str(error).upper() else "read-failed"
                evidence = str(error)
            entries.append(
                _base_entry(
                    archive_part="database-zip",
                    member=member,
                    size=info.file_size,
                    sha256=member_sha256,
                    integrity_status=status,
                    integrity_evidence=evidence,
                )
            )
    return entries


def _parse_unrar_listing(output: str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for line in [*output.splitlines(), ""]:
        stripped = line.strip()
        if not stripped:
            if current:
                records.append(current)
                current = {}
            continue
        key, separator, value = stripped.partition(":")
        if separator:
            current[key.strip().lower()] = value.strip()
    return records


def _inventory_rar(
    path: Path,
    archive_part: str,
    unrar: Path,
    runner: Callable[..., subprocess.CompletedProcess[str]],
) -> list[dict[str, object]]:
    command = [str(unrar), "lt", "-c-", "-p-", str(path)]
    result = runner(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(
            f"UnRAR listing failed for {path} with exit {result.returncode}: "
            f"{result.stderr.strip()}"
        )

    entries: list[dict[str, object]] = []
    for record in _parse_unrar_listing(result.stdout):
        if "name" not in record:
            continue
        raw_member = record["name"]
        member = normalize_member(raw_member)
        if member is None:
            raise ValueError(f"unsafe RAR member path: {raw_member!r}")
        metadata = _image_metadata(member)
        if metadata is None:
            continue
        member_type = record.get("type", "File").lower()
        if "link" in member_type or "target" in record or "redirection" in record:
            raise ValueError(f"RAR link member is not allowed: {member}")
        if member_type != "file":
            continue
        try:
            size = int(record["size"])
        except (KeyError, ValueError) as error:
            raise ValueError(f"RAR member lacks a valid size: {member}") from error
        if size < 0:
            raise ValueError(f"RAR member has a negative size: {member}")
        entry = _base_entry(
            archive_part=archive_part,
            member=member,
            size=size,
            sha256=None,
            integrity_status="listed-unverified",
            integrity_evidence=(
                f"UnRAR CRC32={record['crc32']}" if record.get("crc32") else None
            ),
        )
        entry.update(metadata)
        entries.append(entry)
    return entries


def _archive_evidence(path: Path) -> dict[str, object]:
    return {"path": str(path), "size": path.stat().st_size, "sha256": _sha256_file(path)}


def _write_json_atomic(destination: Path, document: object) -> None:
    if is_reparse_point(destination):
        raise ValueError(f"manifest destination is a reparse point: {destination}")
    payload = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{destination.name}.",
            suffix=".tmp",
            dir=destination.parent,
            delete=False,
        ) as output:
            temporary = Path(output.name)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def inventory_archives(
    *,
    database_zip: os.PathLike[str] | str,
    image_part1: os.PathLike[str] | str,
    image_part2: os.PathLike[str] | str,
    output_root: os.PathLike[str] | str,
    batch_id: str,
    unrar: os.PathLike[str] | str | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> Path:
    database = _resolve_input(database_zip, "database ZIP")
    part1 = _resolve_input(image_part1, "image part 1")
    part2 = _resolve_input(image_part2, "image part 2")
    inputs = (database, part1, part2)
    if len(set(inputs)) != len(inputs):
        raise ValueError("input archives must be distinct files")
    unrar_path = locate_unrar(unrar)
    batch_root = _validate_output_path(Path(output_root), batch_id, inputs)

    entries = _inventory_zip(database)
    entries.extend(_inventory_rar(part1, "image-part1", unrar_path, runner))
    entries.extend(_inventory_rar(part2, "image-part2", unrar_path, runner))
    entries.sort(key=lambda item: (str(item["archivePart"]), str(item["memberPath"])))
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "batchId": batch_id,
        "archives": {
            "database-zip": _archive_evidence(database),
            "image-part1": _archive_evidence(part1),
            "image-part2": _archive_evidence(part2),
        },
        "entries": entries,
    }

    batch_root.mkdir(parents=True, exist_ok=True)
    for candidate in _existing_chain(batch_root):
        if is_reparse_point(candidate):
            raise ValueError(f"output path contains a reparse point: {candidate}")
    destination = batch_root / MANIFEST_NAME
    _write_json_atomic(destination, manifest)
    return destination


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    inventory = subparsers.add_parser("inventory", help="inventory legacy archives")
    inventory.add_argument("--database-zip", required=True, type=Path)
    inventory.add_argument("--image-part1", required=True, type=Path)
    inventory.add_argument("--image-part2", required=True, type=Path)
    inventory.add_argument("--output-root", required=True, type=Path)
    inventory.add_argument("--batch-id", required=True)
    inventory.add_argument("--unrar", type=Path, help="absolute path to UnRAR.exe")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "inventory":
        destination = inventory_archives(
            database_zip=args.database_zip,
            image_part1=args.image_part1,
            image_part2=args.image_part2,
            output_root=args.output_root,
            batch_id=args.batch_id,
            unrar=args.unrar,
        )
        print(destination)
        return 0
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
