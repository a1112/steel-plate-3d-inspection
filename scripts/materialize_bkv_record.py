#!/usr/bin/env python3
"""Materialize one bounded BKV history record into the unified input layout.

The history recovery pass intentionally publishes metadata first.  This
utility is the explicit, bounded second phase: it copies only the selected
record's six-camera 2D frames from the read-only BKV shares, writes a complete
``steel.standard-record.v2`` input, and atomically exposes it to the algorithm
service.  It never deletes or rewrites the source share.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from recover_bkv_history import (
    CAMERA_COUNT,
    _atomic_json,
    _candidate,
    _iter_candidates,
    _record,
)


def _sha256(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def _numbered_files(directory: Path, limit: int) -> list[Path]:
    files = [
        path
        for path in directory.iterdir()
        if path.is_file()
        and path.suffix.lower() in {".bmp", ".jpg", ".jpeg"}
    ]

    def sort_key(path: Path) -> tuple[int, int, str]:
        match = re.search(r"(\d+)", path.stem)
        return (0 if match else 1, int(match.group(1)) if match else 0, path.name)

    return sorted(files, key=sort_key)[:limit]


def _write_image(source: Path, target: Path, compress_jpeg: bool) -> tuple[int, str, str]:
    """Copy one source frame, optionally converting a BMP to a bounded JPEG.

    Historical BKV frames are commonly uncompressed BMPs.  Keeping the source
    extension is the lossless/default path; the optional JPEG path is useful
    for a long-running recovery queue where the raw share must not be copied
    twice into the result store.
    """
    if not compress_jpeg or source.suffix.lower() not in {".bmp", ".dib"}:
        shutil.copy2(source, target)
        size, digest = _sha256(target)
        return size, digest, source.suffix.lower()
    try:
        from PIL import Image
    except ImportError as error:  # pragma: no cover - exercised on deployments without Pillow
        raise RuntimeError("JPEG history materialization requires Pillow") from error
    target = target.with_suffix(".jpg")
    with Image.open(source) as image:
        image.convert("RGB").save(target, format="JPEG", quality=88, optimize=True)
    size, digest = _sha256(target)
    return size, digest, ".jpg"


def _find_candidate(runs_root: Path, record_id: str, run_dir: Path | None = None):
    if run_dir is not None:
        selected = _candidate(run_dir.resolve())
        if selected.canonical_id != record_id:
            raise ValueError(
                f"history run {run_dir} belongs to {selected.canonical_id}, not {record_id}"
            )
        return selected
    selected = None
    for run_dir, candidate, _error in _iter_candidates(runs_root):
        if candidate is None or candidate.canonical_id != record_id:
            continue
        if selected is None or candidate.rank > selected.rank:
            selected = candidate
    if selected is None:
        direct = runs_root / record_id
        if (direct / "inspection-world-v1" / "manifest.json").is_file():
            selected = _candidate(direct)
    if selected is None:
        raise ValueError(f"historical record {record_id} was not found under {runs_root}")
    return selected


def _materialize_camera(
    candidate,
    camera: int,
    source_host: str,
    max_frames: int,
    compress_jpeg: bool,
    staged_record: Path,
) -> tuple[str, list[dict[str, Any]], list[str], int]:
    source_directory = _source_directory(candidate.manifest, camera, source_host)
    if not source_directory.is_dir():
        raise ValueError(f"camera C{camera} source directory is unavailable: {source_directory}")
    source_files = _numbered_files(source_directory, max_frames)
    if not source_files:
        raise ValueError(f"camera C{camera} has no 2D frames: {source_directory}")
    camera_id = f"C{camera}"
    target_directory = staged_record / "cameras" / camera_id / "intensity"
    target_directory.mkdir(parents=True, exist_ok=True)
    copied_files: list[dict[str, Any]] = []
    source_hashes: list[str] = []
    total_bytes = 0
    for sequence, source in enumerate(source_files):
        target = target_directory / f"{sequence:06d}{source.suffix.lower()}"
        size, digest, output_suffix = _write_image(source, target, compress_jpeg)
        total_bytes += size
        source_hashes.append(digest)
        copied_files.append(
            {
                "cameraId": camera_id,
                "kind": "intensity",
                "path": target.with_suffix(output_suffix).relative_to(staged_record).as_posix(),
                "sequenceNo": sequence,
                "size": size,
                "sha256": digest,
            }
        )
    return camera_id, copied_files, source_hashes, total_bytes


def _source_directory(manifest: dict[str, Any], camera: int, source_host: str) -> Path:
    cameras = manifest.get("cameras")
    if isinstance(cameras, list):
        for value in cameras:
            if not isinstance(value, dict):
                continue
            try:
                camera_id = int(value.get("cameraId"))
            except (TypeError, ValueError):
                continue
            if camera_id == camera and value.get("sourceDirectory"):
                return Path(str(value["sourceDirectory"]))
    return Path(source_host) / f"CamImageSource{camera}" / str(manifest.get("recordId") or "") / "2D"


def materialize(
    runs_root: Path,
    input_root: Path,
    record_id: str,
    source_host: str,
    max_frames: int,
    force: bool,
    compress_jpeg: bool,
    run_dir: Path | None = None,
) -> dict[str, Any]:
    runs_root = runs_root.resolve()
    input_root = input_root.resolve()
    candidate = _find_candidate(runs_root, record_id, run_dir)
    record, defects_document, provenance = _record(candidate)
    destination = input_root / "records" / record_id
    if destination.exists() and not force:
        raise ValueError(f"destination already exists; pass --force to replace: {destination}")
    input_root.mkdir(parents=True, exist_ok=True)

    staging_parent = input_root.parent / ".bkv-materialize-staging"
    staging_parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f"{record_id}-", dir=staging_parent))
    staged_record = staging / "record"
    copied_files: list[dict[str, Any]] = []
    source_hashes: list[str] = []
    total_bytes = 0
    camera_counts: dict[str, int] = {}
    try:
        # Each camera is an independent SMB root.  Bounded parallelism keeps a
        # single record switch responsive without opening an unbounded number
        # of handles on the production share.
        with ThreadPoolExecutor(max_workers=CAMERA_COUNT, thread_name_prefix="bkv-camera") as pool:
            futures = [
                pool.submit(
                    _materialize_camera,
                    candidate,
                    camera,
                    source_host,
                    max_frames,
                    compress_jpeg,
                    staged_record,
                )
                for camera in range(1, CAMERA_COUNT + 1)
            ]
            camera_results = [future.result() for future in futures]
        for camera_id, camera_files, camera_hashes, camera_bytes in camera_results:
            camera_counts[camera_id] = len(camera_files)
            copied_files.extend(camera_files)
            source_hashes.extend(camera_hashes)
            total_bytes += camera_bytes
        copied_files.sort(key=lambda value: (value["cameraId"], value["sequenceNo"]))

        digest = hashlib.sha256()
        digest.update(str(record.get("sourceHash") or "").encode("utf-8"))
        for value in source_hashes:
            digest.update(value.encode("ascii"))
        record["captureFiles"] = copied_files
        record["sourceHash"] = digest.hexdigest()
        record["configHash"] = "bkv-history-materialize-v1"
        _atomic_json(staged_record / "record.json", record)
        _atomic_json(
            staged_record / "defects" / "defects.json",
            defects_document,
        )
        provenance.update(
            {
                "rawAssetsDeferred": False,
                "rawAssetsAvailable": True,
                "materializedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                "materializedFrameCount": len(copied_files),
                "materializedBytes": total_bytes,
                "materializedCameraCounts": camera_counts,
                "compressedJpeg": compress_jpeg,
                "materializer": "bkv-history-materialize-v1",
            }
        )
        _atomic_json(staged_record / "source-provenance.json", provenance)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            # Keep interrupted/previous inputs outside the recursive input
            # scan.  Hidden siblings under records/ would otherwise be picked
            # up as additional algorithm jobs and could roll a new result back
            # to the metadata-only copy.
            backup_root = input_root.parent / ".bkv-materialize-backups"
            backup_root.mkdir(parents=True, exist_ok=True)
            backup = backup_root / f"{record_id}-{os.getpid()}-{int(datetime.now(timezone.utc).timestamp() * 1000)}"
            os.replace(destination, backup)
        os.replace(staged_record, destination)
        return {
            "recordId": record_id,
            "inputRecord": str(destination),
            "sourceDirectories": [
                str(_source_directory(candidate.manifest, camera, source_host))
                for camera in range(1, CAMERA_COUNT + 1)
            ],
            "frameCount": len(copied_files),
            "cameraCounts": camera_counts,
            "bytes": total_bytes,
            "sourceHash": record["sourceHash"],
            "rawAssetsDeferred": False,
            "compressedJpeg": compress_jpeg,
        }
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs-root", type=Path, required=True)
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--record-id", required=True)
    parser.add_argument("--run-dir", type=Path, default=None)
    parser.add_argument("--source-host", default=r"\\10.5.241.17")
    parser.add_argument("--max-frames-per-camera", type=int, default=256)
    parser.add_argument("--force", action="store_true")
    parser.add_argument(
        "--compress-jpeg",
        action="store_true",
        help="convert BMP frames to quality-88 JPEGs before publishing",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.max_frames_per_camera < 1 or args.max_frames_per_camera > 4096:
        raise SystemExit("--max-frames-per-camera must be between 1 and 4096")
    result = materialize(
        args.runs_root,
        args.input_root,
        str(args.record_id),
        args.source_host,
        args.max_frames_per_camera,
        args.force,
        args.compress_jpeg,
        args.run_dir,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
