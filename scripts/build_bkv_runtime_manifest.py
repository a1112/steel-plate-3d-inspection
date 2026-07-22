#!/usr/bin/env python3
"""Build the authoritative manifest for the formal BKV offline replay provider."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any


SCHEMA = "bkv-runtime-v1"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_csv(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        raise ValueError(f"required CSV is missing: {path}")
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _int(value: Any, field: str) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError) as error:
        raise ValueError(f"invalid integer for {field}: {value!r}") from error


def _positive_float_or_none(value: Any) -> float | None:
    try:
        parsed = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _relative_file(root: Path, path: Path, label: str) -> str:
    root = root.resolve()
    path = path.resolve()
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label} path escapes BKV data root: {path}") from error
    if not path.is_file():
        raise ValueError(f"missing {label}: {path}")
    return relative.as_posix()


def _artifact(root: Path, path: Path, label: str) -> dict[str, Any]:
    relative = _relative_file(root, path, label)
    return {"path": relative, "size": path.stat().st_size, "sha256": _sha256(path)}


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _source(root: Path, path: Path, label: str) -> dict[str, Any]:
    return _artifact(root, path, label)


def _load_npz_entries(root: Path, npz_root: Path) -> tuple[dict[tuple[int, int], list[dict[str, Any]]], dict[str, Any]]:
    manifest_path = npz_root / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid NPZ manifest: {manifest_path}: {error}") from error
    if manifest.get("format_version") != "bkv-depth-v1" or int(manifest.get("error", -1)) != 0:
        raise ValueError("NPZ manifest is not a successful bkv-depth-v1 conversion")

    grouped: dict[tuple[int, int], list[dict[str, Any]]] = defaultdict(list)
    seen: set[tuple[int, int, int]] = set()
    for entry in manifest.get("entries", []):
        if entry.get("status") != "ok":
            continue
        material = _int(entry.get("legacy_seq_no"), "NPZ legacy_seq_no")
        camera = _int(entry.get("camera_id"), "NPZ camera_id")
        frame = _int(entry.get("frame_no"), "NPZ frame_no")
        identity = (material, camera, frame)
        if identity in seen:
            raise ValueError(f"duplicate NPZ identity: {identity}")
        seen.add(identity)
        relative = Path(str(entry.get("output_relative_path", "")))
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"NPZ output path escapes NPZ root: {relative}")
        path = (npz_root / relative).resolve()
        expected_root = npz_root.resolve()
        try:
            path.relative_to(expected_root)
        except ValueError as error:
            raise ValueError(f"NPZ output path escapes NPZ root: {relative}") from error
        if not path.is_file():
            raise ValueError(f"missing NPZ artifact for material {material}, camera {camera}, frame {frame}: {path}")
        actual_hash = _sha256(path)
        declared_hash = str(entry.get("output_sha256", ""))
        if declared_hash and actual_hash != declared_hash:
            raise ValueError(f"NPZ hash mismatch for {relative}")
        grouped[(material, camera)].append({
            "frameNo": frame,
            "path": _relative_file(root, path, "NPZ artifact"),
            "size": path.stat().st_size,
            "sha256": actual_hash,
        })
    for entries in grouped.values():
        entries.sort(key=lambda item: item["frameNo"])
    return grouped, manifest


def build_runtime_manifest(
    *,
    data_root: Path,
    extract_root: Path,
    image_root: Path,
    npz_root: Path,
    preview_root: Path,
    output_path: Path,
    seq_start: int = 1893700,
    seq_end: int = 1893710,
    expected_cameras: int = 6,
    expected_materials: int = 11,
) -> dict[str, Any]:
    data_root = Path(data_root).resolve()
    extract_root = Path(extract_root).resolve()
    image_root = Path(image_root).resolve()
    npz_root = Path(npz_root).resolve()
    preview_root = Path(preview_root).resolve()
    output_path = Path(output_path).resolve()
    if seq_start > seq_end:
        raise ValueError("seq_start must not exceed seq_end")
    _relative_file(data_root, extract_root / "checkrecord.csv", "checkrecord source")
    _relative_file(data_root, extract_root / "defect.csv", "defect source")
    _relative_file(data_root, extract_root / "defectclass.csv", "defectclass source")

    check_rows = [row for row in _read_csv(extract_root / "checkrecord.csv") if seq_start <= _int(row.get("ID"), "checkrecord.ID") <= seq_end]
    check_rows.sort(key=lambda row: _int(row["ID"], "checkrecord.ID"))
    identities = [_int(row["ID"], "checkrecord.ID") for row in check_rows]
    duplicate = next((identity for identity in identities if identities.count(identity) > 1), None)
    if duplicate is not None:
        raise ValueError(f"duplicate material identity {duplicate}")
    if len(check_rows) != expected_materials:
        raise ValueError(f"expected {expected_materials} materials, found {len(check_rows)}")
    expected_ids = list(range(seq_start, seq_end + 1))
    if identities != expected_ids:
        raise ValueError(f"material coverage mismatch: expected {expected_ids}, found {identities}")

    classes = {_int(row.get("ClassNo"), "defectclass.ClassNo"): row.get("ClassName", "") for row in _read_csv(extract_root / "defectclass.csv")}
    check_by_capture_seq = {_int(row["SeqNo"], "checkrecord.SeqNo"): _int(row["ID"], "checkrecord.ID") for row in check_rows}
    defects_by_material: dict[int, list[dict[str, Any]]] = defaultdict(list)
    unassociated: list[dict[str, str]] = []
    for row in _read_csv(extract_root / "defect.csv"):
        capture_seq = _int(row.get("SeqNo"), "defect.SeqNo")
        material = check_by_capture_seq.get(capture_seq)
        if material is None:
            if seq_start <= _int(row.get("ID"), "defect.ID") <= seq_end:
                unassociated.append(row)
            continue
        class_no = _int(row.get("Class"), "defect.Class")
        defects_by_material[material].append({
            "legacyDefectId": _int(row.get("ID"), "defect.ID"),
            "defectNo": _int(row.get("DefectNo"), "defect.DefectNo"),
            "cameraId": _int(row.get("CamNo"), "defect.CamNo"),
            "classNo": class_no,
            "className": classes.get(class_no, f"未知类别 {class_no}"),
            "grade": _int(row.get("Grade"), "defect.Grade"),
            "confidence": _int(row.get("Confidence"), "defect.Confidence"),
            "imageIndex": _int(row.get("ImgIndex"), "defect.ImgIndex"),
            "area3d": _positive_float_or_none(row.get("AreaSteel3D")),
            "depth3d": _positive_float_or_none(row.get("DepthSteel3D")),
        })

    npz_by_camera, npz_manifest = _load_npz_entries(data_root, npz_root)
    materials: list[dict[str, Any]] = []
    for row in check_rows:
        material = _int(row["ID"], "checkrecord.ID")
        cameras = []
        for camera in range(1, expected_cameras + 1):
            image_dir = image_root / f"CamImageSource{camera}" / str(material) / "2D"
            image_paths = sorted(image_dir.glob("*.jpg")) if image_dir.is_dir() else []
            if not image_paths:
                raise ValueError(f"missing camera {camera} 2D frames for material {material}")
            two_d_frames = [
                {"frameNo": _int(path.stem, "2D frame filename"), **_artifact(data_root, path, "2D frame")}
                for path in image_paths
            ]
            npz_frames = npz_by_camera.get((material, camera), [])
            if not npz_frames:
                raise ValueError(f"missing NPZ coverage for material {material}, camera {camera}")
            image_frame_numbers = [item["frameNo"] for item in two_d_frames]
            npz_frame_numbers = [item["frameNo"] for item in npz_frames]
            if image_frame_numbers != npz_frame_numbers:
                raise ValueError(f"NPZ coverage mismatch for material {material}, camera {camera}: 2D={image_frame_numbers}, NPZ={npz_frame_numbers}")
            cameras.append({
                "cameraId": camera,
                "mode": "offline-file",
                "twoDFrameCount": len(two_d_frames),
                "npzFrameCount": len(npz_frames),
                "twoDFrames": two_d_frames,
                "npzFrames": npz_frames,
            })
        preview_dir = preview_root / str(material)
        artifacts = {
            "unwrapped": _artifact(data_root, preview_dir / "unwrapped-height.png", "preview unwrapped artifact"),
            "cylinder": _artifact(data_root, preview_dir / "cylinder-preview.json", "preview cylinder artifact"),
            "summary": _artifact(data_root, preview_dir / "stitch-summary.json", "preview summary artifact"),
        }
        materials.append({
            "legacySeqNo": material,
            "legacyCheckRecordSeqNo": _int(row["SeqNo"], "checkrecord.SeqNo"),
            "steelId": row.get("SteelID", ""),
            "steelType": row.get("SteelType", ""),
            "lengthMm": _positive_float_or_none(row.get("RcvLen")),
            "outerDiameterLegacyValue": _positive_float_or_none(row.get("Radius")),
            "wallThicknessMm": _positive_float_or_none(row.get("WallThick")),
            "inspectionTime": row.get("DefectTime", ""),
            "legacyDeclaredDefectCount": _int(row.get("DefectNum"), "checkrecord.DefectNum"),
            "defects": sorted(defects_by_material.get(material, []), key=lambda item: item["legacyDefectId"]),
            "cameras": cameras,
            "artifacts": artifacts,
        })

    allexcel_path = extract_root / "allexcel.csv"
    all_excel = _read_csv(allexcel_path) if allexcel_path.is_file() else []
    conflicts = [row for row in all_excel if seq_start <= _int(row.get("ID"), "allexcel.ID") <= seq_end]
    sources = {
        "checkrecord": _source(data_root, extract_root / "checkrecord.csv", "checkrecord source"),
        "defect": _source(data_root, extract_root / "defect.csv", "defect source"),
        "defectclass": _source(data_root, extract_root / "defectclass.csv", "defectclass source"),
        "npzManifest": _source(data_root, npz_root / "manifest.json", "NPZ manifest source"),
    }
    if allexcel_path.is_file():
        sources["allexcel"] = _source(data_root, allexcel_path, "allexcel source")
    manifest = {
        "schema": SCHEMA,
        "batchId": f"legacy-{seq_start}-{seq_end}",
        "range": {"start": seq_start, "end": seq_end},
        "cameraCount": expected_cameras,
        "materialCount": len(materials),
        "materials": materials,
        "sources": sources,
        "conversion": {"format": npz_manifest.get("format_version"), "entryCount": int(npz_manifest.get("ok", 0))},
        "quarantine": {
            "unassociatedDefects": sorted(unassociated, key=lambda row: (_int(row.get("ID"), "defect.ID"), _int(row.get("SeqNo"), "defect.SeqNo"))),
            "conflictingAllExcelRows": sorted(conflicts, key=lambda row: _int(row.get("ID"), "allexcel.ID")),
        },
        "notes": {
            "mode": "offline-replay-no-camera-hardware",
            "diameterField": "outerDiameterLegacyValue preserves checkrecord.Radius without asserting calibrated semantics",
            "preview": "uncalibrated observation-only six-camera visualization",
        },
    }
    _atomic_json(output_path, manifest)
    return manifest


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", required=True, type=Path)
    parser.add_argument("--extract-root", type=Path)
    parser.add_argument("--image-root", type=Path)
    parser.add_argument("--npz-root", type=Path)
    parser.add_argument("--preview-root", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--seq-start", type=int, default=1893700)
    parser.add_argument("--seq-end", type=int, default=1893710)
    parser.add_argument("--expected-cameras", type=int, default=6)
    parser.add_argument("--expected-materials", type=int, default=11)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    root = args.data_root.resolve()
    manifest = build_runtime_manifest(
        data_root=root,
        extract_root=args.extract_root or root / "extract_run_2",
        image_root=args.image_root or root / "image_copy2" / "image_copy",
        npz_root=args.npz_root or root / "bkv-standard-v1",
        preview_root=args.preview_root or root / "stitch-preview",
        output_path=args.output or root / "bkv-runtime-manifest.json",
        seq_start=args.seq_start,
        seq_end=args.seq_end,
        expected_cameras=args.expected_cameras,
        expected_materials=args.expected_materials,
    )
    print(json.dumps({"schema": manifest["schema"], "materials": manifest["materialCount"], "output": str(args.output or root / "bkv-runtime-manifest.json")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
