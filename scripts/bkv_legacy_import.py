#!/usr/bin/env python3
"""Fail-closed inventory tooling for untrusted BKV legacy archives."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import locale
import os
import re
import stat
import subprocess
import tempfile
import threading
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Callable, Iterable, Sequence


TARGET_SEQ_NOS = tuple(range(1_893_700, 1_893_711))
MANIFEST_NAME = "manifest.inventory.json"
MANIFEST_SCHEMA = "steel.bkv-archive-inventory.v1"
MAX_ZIP_MEMBERS = 100_000
MAX_ZIP_MEMBER_BYTES = 64 * 1024 * 1024 * 1024
MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024 * 1024
MAX_ZIP_COMPRESSION_RATIO = 1_000
MAX_RAR_LISTING_RECORDS = 1_000_000
MAX_UNRAR_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 128 * 1024 * 1024
UNRAR_TIMEOUT_SECONDS = 300
_IO_CHUNK_BYTES = 64 * 1024
_BATCH_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_IMAGE_MEMBER = re.compile(
    r"image_copy/CamImageSource(?P<camera>[1-6])/(?P<seq>\d+)/"
    r"(?P<kind>2D|3D)/(?P<name>[^/]+(?P<extension>\.jpg|\.d3img|\.dat))\Z",
    re.IGNORECASE,
)
_WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}
_UNRAR_KEY_ALIASES = {
    "name": "name",
    "名称": "name",
    "type": "type",
    "类型": "type",
    "size": "size",
    "大小": "size",
    "target": "target",
    "目标": "target",
    "redirection": "redirection",
    "重定向": "redirection",
    "crc32": "crc32",
}


class InventoryLimitError(RuntimeError):
    """Raised when untrusted input exceeds a named inventory bound."""


@dataclass(frozen=True)
class FileSnapshot:
    device: int
    inode: int
    size: int
    mtime_ns: int


def wanted_seq_no(value: int) -> bool:
    """Return whether value belongs to the exact approved legacy batch."""
    return value in TARGET_SEQ_NOS


def _safe_windows_component(value: str) -> bool:
    if not value or value in (".", ".."):
        return False
    if any(ord(character) < 32 for character in value):
        return False
    if any(character in '<>:"/\\|?*' for character in value):
        return False
    if value.endswith((".", " ")):
        return False
    stem = value.split(".", 1)[0].upper()
    return stem not in _WINDOWS_RESERVED_NAMES


def normalize_member(value: str) -> str | None:
    """Return a safe canonical archive member, or None for unsafe syntax."""
    if not isinstance(value, str) or not value or "\x00" in value:
        return None
    if value.startswith(("/", "\\")) or PureWindowsPath(value).drive:
        return None
    canonical = value.replace("\\", "/")
    path = PurePosixPath(canonical)
    components = canonical.split("/")
    if path.is_absolute() or any(
        not _safe_windows_component(component) for component in components
    ):
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


def _file_snapshot(path: Path) -> FileSnapshot:
    details = path.stat()
    return FileSnapshot(
        device=details.st_dev,
        inode=details.st_ino,
        size=details.st_size,
        mtime_ns=details.st_mtime_ns,
    )


def _assert_snapshot(path: Path, expected: FileSnapshot) -> None:
    if _file_snapshot(path) != expected:
        raise RuntimeError(f"input archive changed during inventory: {path}")


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
    if not _BATCH_ID.fullmatch(batch_id) or not _safe_windows_component(batch_id):
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


def _trusted_unrar_candidate(candidate: Path, source: str) -> Path:
    candidate = candidate.expanduser()
    if not candidate.is_absolute():
        raise ValueError(f"{source} must be an absolute path to UnRAR.exe")
    if is_reparse_point(candidate):
        raise ValueError(f"{source} must not be a reparse point: {candidate}")
    try:
        details = candidate.lstat()
    except FileNotFoundError as error:
        raise FileNotFoundError(f"{source} does not exist: {candidate}") from error
    if not stat.S_ISREG(details.st_mode):
        raise ValueError(f"{source} must be a regular file: {candidate}")
    resolved = candidate.resolve(strict=True)
    if resolved.name.casefold() != "unrar.exe":
        raise ValueError(f"{source} must name UnRAR.exe: {resolved}")
    return resolved


def locate_unrar(explicit: os.PathLike[str] | str | None = None) -> Path:
    if explicit is not None:
        return _trusted_unrar_candidate(Path(explicit), "--unrar")

    configured = os.environ.get("UNRAR_EXE")
    if configured:
        return _trusted_unrar_candidate(Path(configured), "UNRAR_EXE")

    candidates: list[Path] = []
    for variable in ("ProgramFiles", "ProgramFiles(x86)"):
        root = os.environ.get(variable)
        if root and Path(root).is_absolute():
            candidates.append(Path(root) / "WinRAR" / "UnRAR.exe")
    for candidate in candidates:
        try:
            return _trusted_unrar_candidate(candidate, f"fixed {candidate.parent} candidate")
        except (FileNotFoundError, ValueError):
            continue
    raise FileNotFoundError(
        "UnRAR.exe was not found in fixed Program Files locations; pass an absolute "
        "--unrar or set UNRAR_EXE to an absolute path"
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


def _inventory_zip(
    path: Path,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    entries: list[dict[str, object]] = []
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ZIP_MEMBERS:
            raise InventoryLimitError(
                f"ZIP member count {len(infos)} exceeds MAX_ZIP_MEMBERS={MAX_ZIP_MEMBERS}"
            )
        total_declared = 0
        for info in infos:
            if info.file_size > MAX_ZIP_MEMBER_BYTES:
                raise InventoryLimitError(
                    f"ZIP member bytes {info.file_size} exceeds "
                    f"MAX_ZIP_MEMBER_BYTES={MAX_ZIP_MEMBER_BYTES}: {info.filename}"
                )
            total_declared += info.file_size
            if total_declared > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES:
                raise InventoryLimitError(
                    f"ZIP total uncompressed bytes {total_declared} exceeds "
                    "MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES="
                    f"{MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES}"
                )
            ratio = (
                info.file_size / info.compress_size
                if info.compress_size
                else (float("inf") if info.file_size else 0)
            )
            if ratio > MAX_ZIP_COMPRESSION_RATIO:
                raise InventoryLimitError(
                    f"ZIP compression ratio {ratio:.2f} exceeds "
                    f"MAX_ZIP_COMPRESSION_RATIO={MAX_ZIP_COMPRESSION_RATIO}: "
                    f"{info.filename}"
                )

        actual_total = 0
        for info in sorted(infos, key=lambda item: item.filename):
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
                    actual_member = 0
                    for chunk in iter(lambda: source.read(_IO_CHUNK_BYTES), b""):
                        actual_member += len(chunk)
                        actual_total += len(chunk)
                        if actual_member > MAX_ZIP_MEMBER_BYTES:
                            raise InventoryLimitError(
                                f"ZIP member bytes exceed MAX_ZIP_MEMBER_BYTES="
                                f"{MAX_ZIP_MEMBER_BYTES}: {member}"
                            )
                        if actual_total > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES:
                            raise InventoryLimitError(
                                "ZIP total uncompressed bytes exceed "
                                "MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES="
                                f"{MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES}"
                            )
                        digest.update(chunk)
                member_sha256: str | None = digest.hexdigest()
            except InventoryLimitError:
                raise
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
    statistics = {
        "recordsSeen": len([info for info in infos if not info.is_dir()]),
        "accepted": len(entries),
        "rejected": 0,
    }
    return entries, statistics


def _decode_console(data: bytes) -> str:
    encodings = [locale.getpreferredencoding(False), "utf-8", "gb18030"]
    for encoding in dict.fromkeys(encodings):
        try:
            return data.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", errors="replace")


def _run_process_bounded(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    process = subprocess.Popen(
        list(command),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=(
            getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        ),
    )
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    lock = threading.Lock()
    exceeded = threading.Event()

    def drain(name: str, stream: object) -> None:
        try:
            while True:
                chunk = stream.read(_IO_CHUNK_BYTES)  # type: ignore[attr-defined]
                if not chunk:
                    return
                with lock:
                    captured = len(buffers["stdout"]) + len(buffers["stderr"])
                    remaining = MAX_UNRAR_OUTPUT_BYTES - captured
                    if len(chunk) > remaining:
                        if remaining > 0:
                            buffers[name].extend(chunk[:remaining])
                        exceeded.set()
                    else:
                        buffers[name].extend(chunk)
                if exceeded.is_set():
                    try:
                        process.kill()
                    except OSError:
                        pass
                    return
        finally:
            stream.close()  # type: ignore[attr-defined]

    threads = [
        threading.Thread(target=drain, args=("stdout", process.stdout), daemon=True),
        threading.Thread(target=drain, args=("stderr", process.stderr), daemon=True),
    ]
    for thread in threads:
        thread.start()
    try:
        return_code = process.wait(timeout=UNRAR_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        process.kill()
        process.wait()
        for thread in threads:
            thread.join(timeout=5)
        raise RuntimeError(
            f"UnRAR timed out after {UNRAR_TIMEOUT_SECONDS} seconds"
        ) from error
    for thread in threads:
        thread.join(timeout=5)
    if any(thread.is_alive() for thread in threads):
        process.kill()
        raise RuntimeError("UnRAR output readers did not terminate")
    if exceeded.is_set():
        raise InventoryLimitError(
            "UnRAR output bytes exceed "
            f"MAX_UNRAR_OUTPUT_BYTES={MAX_UNRAR_OUTPUT_BYTES}"
        )
    return subprocess.CompletedProcess(
        list(command),
        return_code,
        _decode_console(bytes(buffers["stdout"])),
        _decode_console(bytes(buffers["stderr"])),
    )


def _run_unrar_listing(
    unrar: Path,
    path: Path,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
) -> str:
    command = [str(unrar), "lt", "-cfg-", "-c-", "-p-", str(path)]
    if runner is None:
        result = _run_process_bounded(command)
    else:
        try:
            result = runner(
                command,
                timeout=UNRAR_TIMEOUT_SECONDS,
                max_output_bytes=MAX_UNRAR_OUTPUT_BYTES,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(
                f"UnRAR timed out after {UNRAR_TIMEOUT_SECONDS} seconds"
            ) from error
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        output_bytes = len(stdout.encode("utf-8")) + len(stderr.encode("utf-8"))
        if output_bytes > MAX_UNRAR_OUTPUT_BYTES:
            raise InventoryLimitError(
                f"UnRAR output bytes {output_bytes} exceed "
                f"MAX_UNRAR_OUTPUT_BYTES={MAX_UNRAR_OUTPUT_BYTES}"
            )
    if result.returncode != 0:
        raise RuntimeError(
            f"UnRAR listing failed for {path} with exit {result.returncode}: "
            f"{(result.stderr or '').strip()}"
        )
    output = result.stdout or ""
    if output.strip() and not _parse_unrar_listing(output):
        raise RuntimeError("UnRAR produced output but no structured technical records")
    return output


def _parse_unrar_listing(output: str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    current: dict[str, str] = {}

    def finish_record() -> None:
        nonlocal current
        if not current:
            return
        records.append(current)
        if len(records) > MAX_RAR_LISTING_RECORDS:
            raise InventoryLimitError(
                "UnRAR listing record count exceeds "
                f"MAX_RAR_LISTING_RECORDS={MAX_RAR_LISTING_RECORDS}"
            )
        current = {}

    for line in io.StringIO(output):
        stripped = line.strip()
        if not stripped:
            finish_record()
            continue
        key, separator, value = stripped.partition(":")
        if not separator:
            key, separator, value = stripped.partition("：")
        if separator:
            canonical_key = _UNRAR_KEY_ALIASES.get(key.strip().lower())
            if canonical_key:
                current[canonical_key] = value.strip()
    finish_record()
    return records


def _records_to_rar_entries(
    records: Sequence[dict[str, str]],
    archive_part: str,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    entries: list[dict[str, object]] = []
    statistics = {"recordsSeen": len(records), "accepted": 0, "rejected": 0}
    seen_candidates: dict[str, str] = {}
    for record in records:
        if "name" not in record:
            statistics["rejected"] += 1
            continue
        raw_member = record["name"]
        member = normalize_member(raw_member)
        if member is None:
            raise ValueError(f"unsafe RAR member path: {raw_member!r}")
        metadata = _image_metadata(member)
        if metadata is None:
            statistics["rejected"] += 1
            continue
        member_type = record.get("type", "File").lower()
        if "link" in member_type or "target" in record or "redirection" in record:
            raise ValueError(f"RAR link member is not allowed: {member}")
        if member_type not in ("file", "文件"):
            statistics["rejected"] += 1
            continue
        try:
            size = int(record["size"])
        except (KeyError, ValueError) as error:
            raise ValueError(f"RAR member lacks a valid size: {member}") from error
        if size < 0:
            raise ValueError(f"RAR member has a negative size: {member}")
        collision_key = unicodedata.normalize("NFC", member).casefold()
        previous = seen_candidates.get(collision_key)
        if previous is not None:
            raise ValueError(
                f"Windows case-insensitive collision: {previous!r} and {member!r}"
            )
        seen_candidates[collision_key] = member
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
        statistics["accepted"] += 1
    return entries, statistics


def _inventory_rar(
    path: Path,
    archive_part: str,
    unrar: Path,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    output = _run_unrar_listing(unrar, path, runner)
    records = _parse_unrar_listing(output)
    if output.strip() and not any("name" in record and "type" in record for record in records):
        raise RuntimeError("UnRAR output contained no structured member records")
    return _records_to_rar_entries(records, archive_part)


def _archive_evidence(path: Path, snapshot: FileSnapshot) -> dict[str, object]:
    digest = _sha256_file(path)
    _assert_snapshot(path, snapshot)
    return {
        "path": str(path),
        "size": snapshot.size,
        "sha256": digest,
        "fileIdentity": f"{snapshot.device}:{snapshot.inode}",
        "mtimeNs": snapshot.mtime_ns,
    }


def _assert_casefold_unique(entries: Sequence[dict[str, object]]) -> None:
    candidates: dict[str, str] = {}
    for entry in entries:
        member = str(entry["memberPath"])
        key = unicodedata.normalize("NFC", member).casefold()
        previous = candidates.get(key)
        if previous is not None:
            raise ValueError(
                f"Windows case-insensitive collision: {previous!r} and {member!r}"
            )
        candidates[key] = member


def _assert_publish_path(destination: Path) -> None:
    for candidate in _existing_chain(destination):
        if is_reparse_point(candidate):
            raise ValueError(f"manifest output contains a reparse point: {candidate}")


def _write_json_atomic(
    destination: Path,
    document: object,
    pre_publish: Callable[[], None] | None = None,
) -> None:
    _assert_publish_path(destination)
    payload = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    payload_bytes = len(payload.encode("utf-8"))
    if payload_bytes > MAX_MANIFEST_BYTES:
        raise InventoryLimitError(
            f"manifest bytes {payload_bytes} exceed "
            f"MAX_MANIFEST_BYTES={MAX_MANIFEST_BYTES}"
        )
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
        _assert_publish_path(destination)
        if is_reparse_point(temporary):
            raise ValueError(f"temporary manifest became a reparse point: {temporary}")
        if pre_publish is not None:
            pre_publish()
        os.replace(temporary, destination)
        temporary = None
        _assert_publish_path(destination)
        if not destination.is_file():
            raise RuntimeError(f"manifest publication did not create a regular file: {destination}")
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
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
) -> Path:
    database = _resolve_input(database_zip, "database ZIP")
    part1 = _resolve_input(image_part1, "image part 1")
    part2 = _resolve_input(image_part2, "image part 2")
    inputs = (database, part1, part2)
    if len(set(inputs)) != len(inputs):
        raise ValueError("input archives must be distinct files")
    unrar_path = locate_unrar(unrar)
    batch_root = _validate_output_path(Path(output_root), batch_id, inputs)

    snapshots = {path: _file_snapshot(path) for path in inputs}
    archives = {
        "database-zip": _archive_evidence(database, snapshots[database]),
        "image-part1": _archive_evidence(part1, snapshots[part1]),
        "image-part2": _archive_evidence(part2, snapshots[part2]),
    }
    entries, zip_statistics = _inventory_zip(database)
    rar_entries, rar_statistics = _inventory_rar(
        part1, "image-part1", unrar_path, runner
    )
    entries.extend(rar_entries)
    _assert_casefold_unique(entries)
    for path in inputs:
        _assert_snapshot(path, snapshots[path])
    entries.sort(key=lambda item: (str(item["archivePart"]), str(item["memberPath"])))
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "batchId": batch_id,
        "archives": archives,
        "statistics": {
            "database-zip": zip_statistics,
            "image-part1": rar_statistics,
            "image-part2": {"recordsSeen": 0, "accepted": 0, "rejected": 0},
        },
        "entries": entries,
    }

    batch_root.mkdir(parents=True, exist_ok=True)
    for candidate in _existing_chain(batch_root):
        if is_reparse_point(candidate):
            raise ValueError(f"output path contains a reparse point: {candidate}")
    destination = batch_root / MANIFEST_NAME
    def assert_inputs_unchanged() -> None:
        for path in inputs:
            _assert_snapshot(path, snapshots[path])

    _write_json_atomic(destination, manifest, pre_publish=assert_inputs_unchanged)
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
