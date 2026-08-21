#!/usr/bin/env python3
"""Build a BKV offline runtime manifest from a verified JPG/NPZ sample."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

from PIL import Image


SAMPLE_SCHEMAS = {
    "steel.bkv-depth-sample.v1",
    "steel.bkv-paired-sample.v1",
}
RUNTIME_SCHEMA = "bkv-runtime-v1"
EXPECTED_CAMERAS = 6
MAX_FRAMES_PER_CAMERA = 512


def _severity_grade(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = value.strip().lower()
        named = {
            "minor": 1,
            "review": 2,
            "moderate": 2,
            "warning": 2,
            "severe": 3,
            "critical": 3,
        }
        if normalized in named:
            return named[normalized]
    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"sample defect severity is invalid: {value}") from error


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _contained_file(root: Path, path: Path, label: str) -> Path:
    root = root.resolve()
    path = path.resolve()
    try:
        path.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label} escapes project root: {path}") from error
    if not path.is_file():
        raise ValueError(f"{label} is missing: {path}")
    return path


def _artifact(project_root: Path, path: Path, label: str) -> dict[str, Any]:
    path = _contained_file(project_root, path, label)
    return {
        "path": path.relative_to(project_root).as_posix(),
        "size": path.stat().st_size,
        "sha256": _sha256(path),
    }


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def build_sample_runtime_manifest(
    *, project_root: Path, sample_root: Path
) -> dict[str, Any]:
    project_root = Path(project_root).resolve()
    sample_root = Path(sample_root).resolve()
    try:
        sample_root.relative_to(project_root)
    except ValueError as error:
        raise ValueError("sample root must remain beneath the project root") from error

    source_manifest_path = _contained_file(
        project_root, sample_root / "manifest.json", "sample manifest"
    )
    try:
        source = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"sample manifest is invalid: {error}") from error
    if source.get("schema") not in SAMPLE_SCHEMAS:
        raise ValueError(
            "sample manifest schema must be one of "
            + ", ".join(sorted(SAMPLE_SCHEMAS))
        )

    camera_count = int(source.get("camera_count", 0))
    frames_per_camera = int(source.get("frames_per_camera", 0))
    legacy_sequence = int(source.get("legacy_seq_no", 0))
    if camera_count != EXPECTED_CAMERAS:
        raise ValueError(f"sample must contain exactly {EXPECTED_CAMERAS} cameras")
    if not 1 <= frames_per_camera <= MAX_FRAMES_PER_CAMERA:
        raise ValueError(
            f"sample frames_per_camera must be between 1 and {MAX_FRAMES_PER_CAMERA}"
        )
    if legacy_sequence <= 0:
        raise ValueError("sample legacy_seq_no must be positive")

    grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
    identities: set[tuple[int, int]] = set()
    entries = source.get("entries")
    if not isinstance(entries, list):
        raise ValueError("sample manifest entries must be an array")
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("status") != "ok":
            raise ValueError("sample manifest contains a non-success entry")
        camera_id = int(entry.get("camera_id", 0))
        frame_no = int(entry.get("frame_no", -1))
        if int(entry.get("legacy_seq_no", 0)) != legacy_sequence:
            raise ValueError("sample entry legacy sequence does not match the batch")
        identity = (camera_id, frame_no)
        if (
            not 1 <= camera_id <= camera_count
            or not 0 <= frame_no < frames_per_camera
            or identity in identities
        ):
            raise ValueError(f"sample frame identity is invalid or duplicated: {identity}")
        identities.add(identity)
        grouped[camera_id].append(entry)

    expected_entry_count = camera_count * frames_per_camera
    if len(identities) != expected_entry_count:
        raise ValueError(
            f"sample frame coverage mismatch: expected {expected_entry_count}, "
            f"found {len(identities)}"
        )

    cameras: list[dict[str, Any]] = []
    for camera_id in range(1, camera_count + 1):
        camera_entries = sorted(
            grouped.get(camera_id, []), key=lambda item: int(item["frame_no"])
        )
        if [int(item["frame_no"]) for item in camera_entries] != list(
            range(frames_per_camera)
        ):
            raise ValueError(f"sample camera {camera_id} frame coverage is incomplete")

        intensity_frames: list[dict[str, Any]] = []
        depth_frames: list[dict[str, Any]] = []
        frame_size: tuple[int, int] | None = None
        for entry in camera_entries:
            frame_no = int(entry["frame_no"])
            relative_depth = Path(str(entry.get("output_relative_path", "")))
            if relative_depth.is_absolute() or ".." in relative_depth.parts:
                raise ValueError(f"sample NPZ path escapes the sample root: {relative_depth}")
            depth_path = _contained_file(
                project_root, sample_root / relative_depth, "sample NPZ frame"
            )
            declared_hash = str(entry.get("output_sha256", ""))
            actual_hash = _sha256(depth_path)
            if len(declared_hash) != 64 or actual_hash != declared_hash:
                raise ValueError(f"sample NPZ hash mismatch: {relative_depth}")

            relative_image = Path(
                str(
                    entry.get("image_relative_path")
                    or f"camera-{camera_id}/2D/{frame_no:04d}.jpg"
                )
            )
            if relative_image.is_absolute() or ".." in relative_image.parts:
                raise ValueError(
                    f"sample JPG path escapes the sample root: {relative_image}"
                )
            image_path = _contained_file(
                project_root, sample_root / relative_image, "sample JPG frame"
            )
            declared_image_hash = entry.get("image_sha256")
            if declared_image_hash is not None and (
                len(str(declared_image_hash)) != 64
                or _sha256(image_path) != str(declared_image_hash)
            ):
                raise ValueError(f"sample JPG hash mismatch: {relative_image}")
            with Image.open(image_path) as image:
                current_size = image.size
            if frame_size is None:
                frame_size = current_size
            elif current_size != frame_size:
                raise ValueError(
                    f"sample camera {camera_id} JPG dimensions are inconsistent"
                )
            declared_shape = entry.get("shape")
            if (
                not isinstance(declared_shape, list)
                or len(declared_shape) != 2
                or [int(declared_shape[0]), int(declared_shape[1])]
                != [current_size[1], current_size[0]]
            ):
                raise ValueError(
                    f"sample camera {camera_id} frame {frame_no} shape mismatch"
                )

            intensity_frames.append(
                {"frameNo": frame_no, **_artifact(project_root, image_path, "JPG frame")}
            )
            depth_frames.append(
                {
                    "frameNo": frame_no,
                    "path": depth_path.relative_to(project_root).as_posix(),
                    "size": depth_path.stat().st_size,
                    "sha256": actual_hash,
                }
            )

        assert frame_size is not None
        cameras.append(
            {
                "cameraId": camera_id,
                "mode": "offline-file",
                "frameWidth": frame_size[0],
                "frameHeight": frame_size[1],
                "orientation": {
                    "frameOrder": "ascending",
                    "rotation": 0,
                    "flipX": False,
                    "flipY": False,
                },
                "twoDFrameCount": len(intensity_frames),
                "npzFrameCount": len(depth_frames),
                "twoDFrames": intensity_frames,
                "npzFrames": depth_frames,
            }
        )

    database_path: Path | None = None
    database: dict[str, Any] = {}
    declared_database_path = source.get("database_path")
    if declared_database_path:
        relative_database = Path(str(declared_database_path))
        if relative_database.is_absolute() or ".." in relative_database.parts:
            raise ValueError("sample database path escapes the sample root")
        database_path = _contained_file(
            project_root, sample_root / relative_database, "sample database snapshot"
        )
        declared_database_hash = str(source.get("database_sha256", ""))
        if len(declared_database_hash) != 64 or _sha256(database_path) != declared_database_hash:
            raise ValueError("sample database snapshot hash mismatch")
        try:
            database = json.loads(database_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"sample database snapshot is invalid: {error}") from error
        if int(database.get("legacy_seq_no", 0)) != legacy_sequence:
            raise ValueError("sample database snapshot sequence does not match the batch")

    inspections = database.get("inspections", [])
    inspection = inspections[0] if isinstance(inspections, list) and inspections else {}
    if not isinstance(inspection, dict):
        raise ValueError("sample database inspection is invalid")
    plate = inspection.get("plate", {})
    if not isinstance(plate, dict):
        raise ValueError("sample database plate is invalid")
    database_defects = inspection.get("defects", [])
    if not isinstance(database_defects, list):
        raise ValueError("sample database defects must be an array")
    defects = []
    for index, defect in enumerate(database_defects, start=1):
        if not isinstance(defect, dict):
            raise ValueError("sample database defect is invalid")
        camera_id = int(defect.get("cameraIndex", 0))
        image_index = int(defect.get("imageIndex", -1))
        if camera_id not in grouped or image_index not in {
            int(item["frame_no"]) for item in grouped[camera_id]
        }:
            raise ValueError("sample database defect references a missing frame")
        defects.append(
            {
                "legacyDefectId": str(defect.get("id") or index),
                "cameraId": camera_id,
                "imageIndex": image_index,
                "className": str(defect.get("typeLabel") or defect.get("typeId") or ""),
                "grade": _severity_grade(defect.get("severity")),
                "confidence": defect.get("confidence"),
                "source": defect,
            }
        )

    sources = {
        "sampleManifest": _artifact(
            project_root, source_manifest_path, "sample manifest"
        )
    }
    if database_path is not None:
        sources["databaseSnapshot"] = _artifact(
            project_root, database_path, "sample database snapshot"
        )

    return {
        "schema": RUNTIME_SCHEMA,
        "batchId": f"sample-{legacy_sequence}",
        "range": {"start": legacy_sequence, "end": legacy_sequence},
        "cameraCount": camera_count,
        "materialCount": 1,
        "previewRequired": False,
        "materials": [
            {
                "legacySeqNo": legacy_sequence,
                "legacyCheckRecordSeqNo": legacy_sequence,
                "steelId": str(
                    plate.get("plateNo") or f"BKV-SAMPLE-{legacy_sequence}"
                ),
                "steelType": str(
                    plate.get("steelGrade") or "BKV committed sample"
                ),
                "lengthMm": plate.get("lengthMm"),
                "outerDiameterLegacyValue": plate.get("widthMm"),
                "wallThicknessMm": plate.get("thicknessMm"),
                "inspectionTime": plate.get("detectedAt"),
                "legacyDeclaredDefectCount": len(defects),
                "defects": defects,
                "cameras": cameras,
                "artifacts": {},
            }
        ],
        "sources": sources,
        "conversion": {
            "format": source.get("format_version"),
            "entryCount": expected_entry_count,
            "unit": source.get("unit"),
            "invalidSentinel": source.get("invalid_sentinel"),
        },
        "quarantine": {},
        "notes": {
            "mode": "offline-replay-no-camera-hardware",
            "source": "versioned-external-bkv-sample",
            "preview": "JPG/NPZ inspection world; no precomputed legacy preview artifacts",
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    project_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=project_root)
    parser.add_argument(
        "--sample-root",
        type=Path,
        default=project_root / "target" / "sample-data-cache" / "content" / "sample-data" / "bkv" / "1908500",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify that the committed output exactly matches the sample",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    project_root = args.project_root.resolve()
    sample_root = args.sample_root.resolve()
    output = (args.output or sample_root / "bkv-runtime-manifest.json").resolve()
    manifest = build_sample_runtime_manifest(
        project_root=project_root, sample_root=sample_root
    )
    if args.check:
        try:
            committed = json.loads(output.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"committed BKV sample runtime manifest is invalid: {error}")
        if committed != manifest:
            raise ValueError(
                "committed BKV sample runtime manifest is stale; "
                "run scripts/build_bkv_sample_runtime.py"
            )
    else:
        _atomic_json(output, manifest)
    print(
        json.dumps(
            {
                "schema": manifest["schema"],
                "batchId": manifest["batchId"],
                "materials": manifest["materialCount"],
                "frames": manifest["conversion"]["entryCount"],
                "output": str(output),
                "checked": bool(args.check),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
