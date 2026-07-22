#!/usr/bin/env python3
"""Build an uncalibrated six-camera BKV depth stitching preview."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


CAMERA_IDS = [1, 2, 3, 4, 5, 6]
FORMAT_VERSION = "bkv-depth-v1"


class PreviewInputError(ValueError):
    """Raised when the BKV preview inputs do not satisfy the strict contract."""


@dataclass
class StitchResult:
    depth: np.ndarray
    valid_mask: np.ndarray
    frame_ids: list[int]
    camera_frame_ids: dict[int, list[int]]
    camera_ids: list[int]
    seam_columns: list[int]
    camera_offsets: dict[int, float]
    source_paths: list[Path]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def discover_frame_paths(root: Path, sequence: int) -> dict[int, dict[int, Path]]:
    discovered: dict[int, dict[int, Path]] = {}
    for camera in CAMERA_IDS:
        directory = root / f"CamImageSource{camera}" / str(sequence) / "3D"
        frames: dict[int, Path] = {}
        if directory.is_dir():
            for path in sorted(directory.glob("*.npz")):
                if not path.stem.isdigit():
                    raise PreviewInputError(f"non-numeric frame name: {path}")
                frames[int(path.stem)] = path
        discovered[camera] = frames

    for camera in CAMERA_IDS:
        if not discovered[camera]:
            raise PreviewInputError(f"camera {camera} has no frames for sequence {sequence}")
    return discovered


def load_sampled_frame(
    path: Path,
    *,
    camera: int,
    sequence: int,
    frame: int,
    rows: int,
    columns: int,
) -> tuple[np.ndarray, np.ndarray]:
    with np.load(path, allow_pickle=False) as artifact:
        required = {
            "depth",
            "valid_mask",
            "format_version",
            "camera_id",
            "legacy_seq_no",
            "frame_no",
            "coordinate_space",
            "unit",
        }
        if not required.issubset(artifact.files):
            raise PreviewInputError(f"NPZ fields missing: {path}")
        if str(artifact["format_version"]) != FORMAT_VERSION:
            raise PreviewInputError(f"unsupported NPZ format: {path}")
        if str(artifact["coordinate_space"]) != "legacy-camera-raw" or str(artifact["unit"]) != "legacy-unknown":
            raise PreviewInputError(f"unexpected coordinate metadata: {path}")
        identifiers = (int(artifact["camera_id"]), int(artifact["legacy_seq_no"]), int(artifact["frame_no"]))
        if identifiers != (camera, sequence, frame):
            raise PreviewInputError(f"NPZ identifiers do not match path: {path}")
        depth = artifact["depth"]
        valid_mask = artifact["valid_mask"]
        if depth.dtype != np.float32 or valid_mask.dtype != np.bool_ or depth.shape != valid_mask.shape:
            raise PreviewInputError(f"NPZ depth/mask contract mismatch: {path}")
        if depth.ndim != 2 or depth.shape[0] < 1 or depth.shape[1] < 1:
            raise PreviewInputError(f"NPZ depth shape is invalid: {path}")
        row_indices = np.rint(np.linspace(0, depth.shape[0] - 1, rows)).astype(np.intp)
        column_indices = np.rint(np.linspace(0, depth.shape[1] - 1, columns)).astype(np.intp)
        sampled_depth = depth[np.ix_(row_indices, column_indices)].copy()
        sampled_mask = valid_mask[np.ix_(row_indices, column_indices)].copy()
    return sampled_depth, sampled_mask


def stitch_sequence(
    root: Path,
    sequence: int,
    *,
    rows_per_frame: int = 64,
    cols_per_camera: int = 256,
) -> StitchResult:
    if rows_per_frame < 1 or cols_per_camera < 1:
        raise ValueError("preview sample dimensions must be positive")
    root = Path(root)
    discovered = discover_frame_paths(root, sequence)
    frame_ids = sorted(set().union(*(set(frames) for frames in discovered.values())))
    camera_depths: list[np.ndarray] = []
    camera_masks: list[np.ndarray] = []
    camera_offsets: dict[int, float] = {}
    source_paths: list[Path] = []

    for camera in CAMERA_IDS:
        sampled_frames: list[np.ndarray] = []
        sampled_masks: list[np.ndarray] = []
        for frame in frame_ids:
            path = discovered[camera].get(frame)
            if path is None:
                sampled_frames.append(np.zeros((rows_per_frame, cols_per_camera), dtype=np.float32))
                sampled_masks.append(np.zeros((rows_per_frame, cols_per_camera), dtype=np.bool_))
                continue
            depth, mask = load_sampled_frame(
                path,
                camera=camera,
                sequence=sequence,
                frame=frame,
                rows=rows_per_frame,
                columns=cols_per_camera,
            )
            sampled_frames.append(depth)
            sampled_masks.append(mask)
            source_paths.append(path)
        camera_depth = np.concatenate(sampled_frames, axis=0)
        camera_mask = np.concatenate(sampled_masks, axis=0)
        if not camera_mask.any():
            raise PreviewInputError(f"camera {camera} contains no valid sampled points")
        offset = float(np.median(camera_depth[camera_mask].astype(np.float64)))
        camera_depth = camera_depth.astype(np.float64) - offset
        camera_depth[~camera_mask] = 0.0
        camera_offsets[camera] = offset
        camera_depths.append(camera_depth)
        camera_masks.append(camera_mask)

    depth = np.concatenate(camera_depths, axis=1)
    valid_mask = np.concatenate(camera_masks, axis=1)
    seam_columns = [index * cols_per_camera for index in range(len(CAMERA_IDS) + 1)]
    return StitchResult(
        depth=depth,
        valid_mask=valid_mask,
        frame_ids=frame_ids,
        camera_frame_ids={camera: sorted(discovered[camera]) for camera in CAMERA_IDS},
        camera_ids=list(CAMERA_IDS),
        seam_columns=seam_columns,
        camera_offsets=camera_offsets,
        source_paths=source_paths,
    )


def robust_limits(depth: np.ndarray, valid_mask: np.ndarray) -> tuple[float, float]:
    valid = depth[valid_mask]
    if valid.size == 0:
        raise PreviewInputError("stitched preview contains no valid points")
    lower, upper = np.percentile(valid, [1.0, 99.0])
    if not np.isfinite(lower) or not np.isfinite(upper):
        raise PreviewInputError("stitched preview limits are not finite")
    if upper <= lower:
        upper = lower + 1.0
    return float(lower), float(upper)


def write_unwrapped_png(path: Path, result: StitchResult, lower: float, upper: float) -> None:
    scaled = np.clip((result.depth - lower) / (upper - lower), 0.0, 1.0)
    red = np.clip(1.5 - np.abs(4.0 * scaled - 3.0), 0.0, 1.0)
    green = np.clip(1.5 - np.abs(4.0 * scaled - 2.0), 0.0, 1.0)
    blue = np.clip(1.5 - np.abs(4.0 * scaled - 1.0), 0.0, 1.0)
    rgba = np.stack((red, green, blue, result.valid_mask.astype(np.float64)), axis=2)
    pixels = (rgba * 255.0 + 0.5).astype(np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        Image.fromarray(pixels, mode="RGBA").save(temporary, format="PNG")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def build_cylinder_payload(
    result: StitchResult,
    sequence: int,
    *,
    mesh_rows: int,
    mesh_cols_per_camera: int,
) -> dict[str, Any]:
    if mesh_rows < 2 or mesh_cols_per_camera < 2:
        raise ValueError("cylinder preview dimensions must be at least 2")
    row_indices = np.rint(np.linspace(0, result.depth.shape[0] - 1, mesh_rows)).astype(np.intp)
    column_indices: list[int] = []
    for camera_index in range(len(result.camera_ids)):
        start = result.seam_columns[camera_index]
        stop = result.seam_columns[camera_index + 1] - 1
        column_indices.extend(np.rint(np.linspace(start, stop, mesh_cols_per_camera)).astype(np.intp).tolist())
    sampled_depth = result.depth[np.ix_(row_indices, np.asarray(column_indices, dtype=np.intp))]
    sampled_mask = result.valid_mask[np.ix_(row_indices, np.asarray(column_indices, dtype=np.intp))]
    valid_absolute = np.abs(sampled_depth[sampled_mask])
    display_scale = float(np.percentile(valid_absolute, 98.0)) if valid_absolute.size else 1.0
    if not np.isfinite(display_scale) or display_scale <= 0.0:
        display_scale = 1.0
    display = np.clip(sampled_depth / display_scale, -1.0, 1.0)
    display[~sampled_mask] = 0.0
    angular_samples = mesh_cols_per_camera * len(result.camera_ids)
    return {
        "schema": "bkv-cylinder-preview.v1",
        "sequence": sequence,
        "calibrated": False,
        "unit": "legacy-unknown",
        "coordinate_space": "uncalibrated-six-camera-preview",
        "longitudinal_samples": mesh_rows,
        "angular_samples": angular_samples,
        "camera_ids": [camera for camera in result.camera_ids for _ in range(mesh_cols_per_camera)],
        "seam_indices": [index * mesh_cols_per_camera for index in range(len(result.camera_ids) + 1)],
        "display_scale_legacy_units": display_scale,
        "display_residual": np.round(display, 5).tolist(),
        "valid_mask": sampled_mask.astype(np.uint8).tolist(),
    }


def build_preview(
    source_root: Path,
    output_root: Path,
    sequence: int,
    *,
    rows_per_frame: int = 64,
    cols_per_camera: int = 256,
    mesh_rows: int = 192,
    mesh_cols_per_camera: int = 24,
) -> dict[str, Any]:
    source_root = Path(source_root).resolve()
    output_root = Path(output_root).resolve()
    result = stitch_sequence(
        source_root,
        sequence,
        rows_per_frame=rows_per_frame,
        cols_per_camera=cols_per_camera,
    )
    lower, upper = robust_limits(result.depth, result.valid_mask)
    image_path = output_root / "unwrapped-height.png"
    cylinder_path = output_root / "cylinder-preview.json"
    summary_path = output_root / "stitch-summary.json"
    write_unwrapped_png(image_path, result, lower, upper)
    cylinder = build_cylinder_payload(
        result,
        sequence,
        mesh_rows=mesh_rows,
        mesh_cols_per_camera=mesh_cols_per_camera,
    )
    write_json_atomic(cylinder_path, cylinder)

    inputs: list[dict[str, Any]] = []
    for path in result.source_paths:
        with np.load(path, allow_pickle=False) as artifact:
            source_d3img_sha256 = str(artifact["source_sha256"])
            camera_id = int(artifact["camera_id"])
            frame_no = int(artifact["frame_no"])
        inputs.append(
            {
                "relative_path": path.relative_to(source_root).as_posix(),
                "camera_id": camera_id,
                "frame_no": frame_no,
                "bytes": path.stat().st_size,
                "npz_sha256": sha256_file(path),
                "source_d3img_sha256": source_d3img_sha256,
            }
        )
    summary = {
        "schema": "bkv-3d-stitch-preview.v1",
        "sequence": sequence,
        "calibrated": False,
        "unit": "legacy-unknown",
        "coordinate_space": "uncalibrated-six-camera-preview",
        "warning": "Observation-only preview; camera order, seams, radius and physical units are not calibrated.",
        "source_root": str(source_root),
        "camera_ids": result.camera_ids,
        "frame_ids": result.frame_ids,
        "frame_ids_per_camera": {str(key): value for key, value in result.camera_frame_ids.items()},
        "frames_per_camera": {str(key): len(value) for key, value in result.camera_frame_ids.items()},
        "input_count": len(inputs),
        "inputs": inputs,
        "preview_shape": [int(result.depth.shape[0]), int(result.depth.shape[1])],
        "valid_points": int(result.valid_mask.sum()),
        "total_points": int(result.valid_mask.size),
        "valid_ratio": float(result.valid_mask.mean()),
        "camera_offsets_legacy_units": {str(key): value for key, value in result.camera_offsets.items()},
        "color_limits_legacy_units": [lower, upper],
        "seam_columns": result.seam_columns,
        "outputs": {
            "unwrapped_height": {
                "path": image_path.name,
                "sha256": sha256_file(image_path),
                "width": int(result.depth.shape[1]),
                "height": int(result.depth.shape[0]),
            },
            "cylinder_preview": {
                "path": cylinder_path.name,
                "sha256": sha256_file(cylinder_path),
                "longitudinal_samples": mesh_rows,
                "angular_samples": mesh_cols_per_camera * len(result.camera_ids),
            },
        },
    }
    write_json_atomic(summary_path, summary)
    return summary


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src-dir", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--sequence", required=True, type=int)
    parser.add_argument("--rows-per-frame", type=int, default=64)
    parser.add_argument("--cols-per-camera", type=int, default=256)
    parser.add_argument("--mesh-rows", type=int, default=192)
    parser.add_argument("--mesh-cols-per-camera", type=int, default=24)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    summary = build_preview(
        args.src_dir,
        args.out_dir,
        args.sequence,
        rows_per_frame=args.rows_per_frame,
        cols_per_camera=args.cols_per_camera,
        mesh_rows=args.mesh_rows,
        mesh_cols_per_camera=args.mesh_cols_per_camera,
    )
    print(
        json.dumps(
            {
                "sequence": summary["sequence"],
                "input_count": summary["input_count"],
                "preview_shape": summary["preview_shape"],
                "valid_ratio": summary["valid_ratio"],
                "output": str(Path(args.out_dir).resolve()),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
