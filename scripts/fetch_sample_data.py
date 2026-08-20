#!/usr/bin/env python3
"""Fetch, assemble, extract, and verify the versioned BKV development dataset."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

DEFAULT_REPOSITORY = "https://github.com/a1112/sample-data.git"
DEFAULT_REF = "812b2910099f4e10c4d3db1a1635c61d69f8743c"
DATASET_PATH = "steel-plate-3d-inspection/bkv/1908500/v1"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _run_git(repository: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=repository if repository.exists() else None,
        check=True,
        text=True,
    )


def _safe_member_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(
        part in {"", ".", ".."} for part in path.parts
    ):
        raise ValueError(f"unsafe ZIP member path: {name}")
    return path


def _safe_extract(archive: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    root = destination.resolve()
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            relative = _safe_member_path(info.filename)
            mode = info.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError(f"ZIP symlink is not allowed: {info.filename}")
            target = (root / Path(*relative.parts)).resolve()
            try:
                target.relative_to(root)
            except ValueError as error:
                raise ValueError(
                    f"ZIP member escapes extraction root: {info.filename}"
                ) from error
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(info) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output, length=1024 * 1024)


def _verify_inventory(data_root: Path, inventory_path: Path) -> dict[str, Any]:
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    files = inventory.get("files")
    if not isinstance(files, list):
        raise ValueError("source inventory files must be an array")
    expected: dict[str, dict[str, Any]] = {}
    for entry in files:
        if not isinstance(entry, dict):
            raise ValueError("source inventory entry must be an object")
        relative = _safe_member_path(str(entry.get("path", ""))).as_posix()
        if relative in expected:
            raise ValueError(f"duplicate source inventory path: {relative}")
        expected[relative] = entry

    actual = {
        path.relative_to(data_root).as_posix()
        for path in data_root.rglob("*")
        if path.is_file()
    }
    if actual != set(expected):
        missing = sorted(set(expected) - actual)
        extra = sorted(actual - set(expected))
        raise ValueError(
            f"source inventory coverage mismatch; missing={missing[:5]}, extra={extra[:5]}"
        )

    total = 0
    for relative, entry in expected.items():
        path = data_root / Path(*PurePosixPath(relative).parts)
        size = path.stat().st_size
        total += size
        if size != int(entry.get("size", -1)):
            raise ValueError(f"source size mismatch: {relative}")
        if _sha256(path) != str(entry.get("sha256", "")):
            raise ValueError(f"source sha256 mismatch: {relative}")

    if len(expected) != int(inventory.get("fileCount", -1)):
        raise ValueError("source inventory file count mismatch")
    if total != int(inventory.get("totalBytes", -1)):
        raise ValueError("source inventory total byte mismatch")
    return {"fileCount": len(expected), "totalBytes": total}


def _prepare_repository(
    repository_cache: Path, repository_url: str, ref: str, offline: bool
) -> Path:
    git_dir = repository_cache / ".git"
    if not git_dir.is_dir():
        if offline:
            raise ValueError("offline mode requires an existing sample-data checkout")
        repository_cache.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "git",
                "clone",
                "--filter=blob:none",
                "--no-checkout",
                repository_url,
                str(repository_cache),
            ],
            check=True,
            text=True,
        )
    else:
        _run_git(repository_cache, "remote", "set-url", "origin", repository_url)

    _run_git(repository_cache, "sparse-checkout", "init", "--cone")
    _run_git(repository_cache, "sparse-checkout", "set", DATASET_PATH)
    if not offline:
        _run_git(repository_cache, "fetch", "--depth", "1", "origin", ref)
        _run_git(repository_cache, "checkout", "--detach", "FETCH_HEAD")
    else:
        _run_git(repository_cache, "rev-parse", "--verify", "HEAD")
    dataset_root = repository_cache / DATASET_PATH
    if not (dataset_root / "bundle-manifest.json").is_file():
        raise ValueError(f"dataset is missing after checkout: {dataset_root}")
    return dataset_root


def _publish_content(stage: Path, content_root: Path) -> None:
    backup = content_root.parent / ".content.previous"
    if backup.exists():
        shutil.rmtree(backup)
    if content_root.exists():
        os.replace(content_root, backup)
    try:
        os.replace(stage, content_root)
    except Exception:
        if backup.exists() and not content_root.exists():
            os.replace(backup, content_root)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def fetch_sample_data(
    *,
    project_root: Path,
    cache_root: Path,
    repository_cache: Path,
    repository_url: str,
    ref: str,
    offline: bool,
    check_only: bool,
) -> dict[str, Any]:
    project_root = project_root.resolve()
    cache_root = cache_root.resolve()
    repository_cache = repository_cache.resolve()
    cache_root.mkdir(parents=True, exist_ok=True)
    dataset_root = _prepare_repository(
        repository_cache, repository_url, ref, offline
    )
    manifest = json.loads(
        (dataset_root / "bundle-manifest.json").read_text(encoding="utf-8")
    )
    archive = cache_root / str(manifest["artifactFile"])
    content_root = cache_root / "content"

    if check_only:
        if archive.stat().st_size != int(manifest["artifactSize"]):
            raise ValueError("cached artifact size mismatch")
        if _sha256(archive) != str(manifest["artifactSha256"]):
            raise ValueError("cached artifact sha256 mismatch")
        verified = _verify_inventory(
            content_root / "sample-data", dataset_root / "source-inventory.json"
        )
        return {"mode": "check", "contentRoot": str(content_root), **verified}

    archive_temporary = archive.with_suffix(archive.suffix + ".tmp")
    if archive_temporary.exists():
        archive_temporary.unlink()
    subprocess.run(
        [
            sys.executable,
            str(dataset_root / "assemble.py"),
            "--root",
            str(dataset_root),
            "--output",
            str(archive_temporary),
        ],
        check=True,
        text=True,
    )
    if archive_temporary.stat().st_size != int(manifest["artifactSize"]):
        raise ValueError("assembled artifact size mismatch")
    if _sha256(archive_temporary) != str(manifest["artifactSha256"]):
        raise ValueError("assembled artifact sha256 mismatch")
    os.replace(archive_temporary, archive)

    stage = Path(tempfile.mkdtemp(prefix=".content.", dir=cache_root))
    shutil.rmtree(stage)
    try:
        _safe_extract(archive, stage)
        verified = _verify_inventory(
            stage / "sample-data", dataset_root / "source-inventory.json"
        )
        _publish_content(stage, content_root)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return {"mode": "fetch", "contentRoot": str(content_root), **verified}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    project_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=project_root)
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=project_root / "target" / "sample-data-cache",
    )
    parser.add_argument(
        "--repository-cache",
        type=Path,
        default=project_root / "target" / "sample-data-repository",
    )
    parser.add_argument(
        "--repository-url",
        default=os.environ.get("STEEL_SAMPLE_DATA_REPOSITORY", DEFAULT_REPOSITORY),
    )
    parser.add_argument(
        "--ref",
        default=os.environ.get("STEEL_SAMPLE_DATA_REF", DEFAULT_REF),
    )
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--check", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    result = fetch_sample_data(
        project_root=args.project_root,
        cache_root=args.cache_root,
        repository_cache=args.repository_cache,
        repository_url=args.repository_url,
        ref=args.ref,
        offline=bool(args.offline),
        check_only=bool(args.check),
    )
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
