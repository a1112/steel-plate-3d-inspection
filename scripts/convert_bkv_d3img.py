#!/usr/bin/env python3
"""Convert legacy BKV .d3img depth frames to the bkv-depth-v1 NPZ format."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import sys
from pathlib import Path
from typing import Any, Iterable

import numpy as np


FORMAT_VERSION = "bkv-depth-v1"
MAGIC_PREFIX = b"3DImg"
HEADER_SIZE = 84
INVALID_SENTINEL = np.float32(-1_000_000.0)
MAX_SIDE = 20_000
MAX_POINTS = 2_000_000_000
NPZ_FIELDS = {
    "depth",
    "valid_mask",
    "format_version",
    "camera_id",
    "legacy_seq_no",
    "frame_no",
    "invalid_sentinel",
    "coordinate_space",
    "unit",
    "source_sha256",
}


class D3ImgFormatError(ValueError):
    """Raised when a legacy frame fails strict structural validation."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_identifiers(source: Path) -> tuple[int, int, int]:
    try:
        camera_dir = source.parents[2].name
        seq_dir = source.parents[1].name
    except IndexError as exc:
        raise D3ImgFormatError(f"source path does not contain camera/sequence hierarchy: {source}") from exc

    camera_match = re.fullmatch(r"CamImageSource(\d+)", camera_dir)
    if camera_match is None or not seq_dir.isdigit() or not source.stem.isdigit():
        raise D3ImgFormatError(f"source path identifiers are invalid: {source}")
    return int(camera_match.group(1)), int(seq_dir), int(source.stem)


def parse_depth(source: Path) -> np.ndarray:
    data = source.read_bytes()
    if len(data) < HEADER_SIZE:
        raise D3ImgFormatError(f"file is shorter than {HEADER_SIZE}-byte header")
    if not data.startswith(MAGIC_PREFIX):
        raise D3ImgFormatError("unexpected d3img magic")

    height = struct.unpack_from("<I", data, 20)[0]
    width = struct.unpack_from("<I", data, 24)[0]
    if not (1 <= height <= MAX_SIDE and 1 <= width <= MAX_SIDE):
        raise D3ImgFormatError(f"invalid dimensions: {height}x{width}")
    if width * height > MAX_POINTS:
        raise D3ImgFormatError(f"point count exceeds limit: {width * height}")

    expected_size = HEADER_SIZE + width * height * 4
    if len(data) != expected_size:
        raise D3ImgFormatError(f"file size mismatch: got {len(data)}, expected {expected_size}")

    return np.frombuffer(data, dtype="<f4", count=width * height, offset=HEADER_SIZE).reshape(height, width)


def validate_artifact(
    path: Path,
    *,
    expected_shape: tuple[int, int],
    expected_source_sha256: str,
    expected_valid_points: int,
) -> None:
    with np.load(path, allow_pickle=False) as artifact:
        if set(artifact.files) != NPZ_FIELDS:
            raise D3ImgFormatError(f"NPZ field mismatch: {sorted(artifact.files)}")
        if artifact["depth"].dtype != np.dtype("float32") or artifact["depth"].shape != expected_shape:
            raise D3ImgFormatError("NPZ depth dtype or shape mismatch")
        if artifact["valid_mask"].dtype != np.dtype("bool") or artifact["valid_mask"].shape != expected_shape:
            raise D3ImgFormatError("NPZ valid_mask dtype or shape mismatch")
        if str(artifact["format_version"]) != FORMAT_VERSION:
            raise D3ImgFormatError("NPZ format version mismatch")
        if str(artifact["source_sha256"]) != expected_source_sha256:
            raise D3ImgFormatError("NPZ source hash mismatch")
        if int(artifact["valid_mask"].sum()) != expected_valid_points:
            raise D3ImgFormatError("NPZ valid point count mismatch")


def write_preview_atomic(path: Path, depth: np.ndarray, valid_mask: np.ndarray) -> None:
    from PIL import Image

    grayscale = np.zeros(depth.shape, dtype=np.uint8)
    valid_values = depth[valid_mask]
    if valid_values.size:
        minimum = float(valid_values.min())
        maximum = float(valid_values.max())
        if maximum > minimum:
            normalized = np.clip((depth - minimum) / (maximum - minimum), 0.0, 1.0)
            grayscale[valid_mask] = (normalized[valid_mask] * 255.0 + 0.5).astype(np.uint8)
    rgba = np.repeat(grayscale[:, :, None], 4, axis=2)
    rgba[:, :, 3] = valid_mask.astype(np.uint8) * 255

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        Image.fromarray(rgba, mode="RGBA").save(temporary, format="PNG")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def convert_file(
    source: Path,
    output: Path,
    *,
    sentinel: np.float32 = INVALID_SENTINEL,
    preview_output: Path | None = None,
) -> dict[str, Any]:
    source = Path(source)
    output = Path(output)
    camera_id, legacy_seq_no, frame_no = parse_identifiers(source)
    depth = parse_depth(source)
    valid_mask = np.isfinite(depth) & (depth != sentinel)
    source_sha256 = sha256_file(source)
    valid_points = int(valid_mask.sum())

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("wb") as stream:
            np.savez_compressed(
                stream,
                depth=depth,
                valid_mask=valid_mask,
                format_version=np.asarray(FORMAT_VERSION),
                camera_id=np.asarray(camera_id, dtype=np.int16),
                legacy_seq_no=np.asarray(legacy_seq_no, dtype=np.int64),
                frame_no=np.asarray(frame_no, dtype=np.int32),
                invalid_sentinel=np.asarray(sentinel, dtype=np.float32),
                coordinate_space=np.asarray("legacy-camera-raw"),
                unit=np.asarray("legacy-unknown"),
                source_sha256=np.asarray(source_sha256),
            )
        validate_artifact(
            temporary,
            expected_shape=depth.shape,
            expected_source_sha256=source_sha256,
            expected_valid_points=valid_points,
        )
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)

    if preview_output is not None:
        preview_output = Path(preview_output)
        write_preview_atomic(preview_output, depth, valid_mask)

    valid_values = depth[valid_mask]
    return {
        "status": "ok",
        "camera_id": camera_id,
        "legacy_seq_no": legacy_seq_no,
        "frame_no": frame_no,
        "shape": [int(depth.shape[0]), int(depth.shape[1])],
        "total_points": int(depth.size),
        "valid_points": valid_points,
        "valid_min": float(valid_values.min()) if valid_values.size else None,
        "valid_max": float(valid_values.max()) if valid_values.size else None,
        "source_sha256": source_sha256,
        "output_sha256": sha256_file(output),
        "preview_path": str(preview_output) if preview_output is not None else None,
    }


def discover_files(
    source_root: Path,
    *,
    seq_start: int | None = None,
    seq_end: int | None = None,
) -> Iterable[Path]:
    camera_dirs = sorted(
        (path for path in source_root.glob("CamImageSource*") if path.is_dir()),
        key=lambda path: int(path.name.removeprefix("CamImageSource"))
        if path.name.removeprefix("CamImageSource").isdigit()
        else sys.maxsize,
    )
    for camera_dir in camera_dirs:
        if not camera_dir.name.removeprefix("CamImageSource").isdigit():
            continue
        sequence_dirs = sorted(
            (path for path in camera_dir.iterdir() if path.is_dir() and path.name.isdigit()),
            key=lambda path: int(path.name),
        )
        for sequence_dir in sequence_dirs:
            sequence = int(sequence_dir.name)
            if seq_start is not None and sequence < seq_start:
                continue
            if seq_end is not None and sequence > seq_end:
                continue
            depth_dir = sequence_dir / "3D"
            if depth_dir.is_dir():
                yield from sorted(depth_dir.glob("*.d3img"), key=lambda path: path.name)


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def convert_batch(
    source_root: Path,
    output_root: Path,
    *,
    seq_start: int | None = None,
    seq_end: int | None = None,
    sentinel: np.float32 = INVALID_SENTINEL,
    save_png: bool = False,
) -> dict[str, Any]:
    source_root = Path(source_root).resolve()
    output_root = Path(output_root).resolve()
    files = list(discover_files(source_root, seq_start=seq_start, seq_end=seq_end))
    entries: list[dict[str, Any]] = []

    for source in files:
        source_relative = source.relative_to(source_root)
        output_relative = source_relative.with_suffix(".npz")
        output = output_root / output_relative
        preview_relative = source_relative.with_suffix(".png") if save_png else None
        try:
            record = convert_file(
                source,
                output,
                sentinel=sentinel,
                preview_output=output_root / preview_relative if preview_relative is not None else None,
            )
        except Exception as exc:
            record = {
                "status": "error",
                "error_code": type(exc).__name__,
                "message": str(exc),
            }
        record["source_relative_path"] = source_relative.as_posix()
        record["output_relative_path"] = output_relative.as_posix()
        record.pop("preview_path", None)
        record["preview_relative_path"] = preview_relative.as_posix() if preview_relative is not None else None
        entries.append(record)

    ok_count = sum(entry["status"] == "ok" for entry in entries)
    manifest = {
        "format_version": FORMAT_VERSION,
        "source_root": str(source_root),
        "output_root": str(output_root),
        "criteria": {
            "seq_start": seq_start,
            "seq_end": seq_end,
            "invalid_sentinel": float(sentinel),
            "save_png": save_png,
        },
        "files_scanned": len(files),
        "ok": ok_count,
        "error": len(files) - ok_count,
        "entries": entries,
    }
    write_json_atomic(output_root / "manifest.json", manifest)
    return manifest


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src-dir", required=True, type=Path, help="Root containing CamImageSourceN directories")
    parser.add_argument("--out-dir", required=True, type=Path, help="Output root for NPZ artifacts and manifest")
    parser.add_argument("--seq-start", type=int, default=None, help="First legacy sequence number, inclusive")
    parser.add_argument("--seq-end", type=int, default=None, help="Last legacy sequence number, inclusive")
    parser.add_argument("--sentinel", type=float, default=float(INVALID_SENTINEL), help="Legacy invalid depth value")
    parser.add_argument("--save-png", action="store_true", help="Also write RGBA depth previews for manual review")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    manifest = convert_batch(
        args.src_dir,
        args.out_dir,
        seq_start=args.seq_start,
        seq_end=args.seq_end,
        sentinel=np.float32(args.sentinel),
        save_png=args.save_png,
    )
    print(
        json.dumps(
            {
                "files_scanned": manifest["files_scanned"],
                "ok": manifest["ok"],
                "error": manifest["error"],
                "manifest": str(Path(args.out_dir).resolve() / "manifest.json"),
            },
            ensure_ascii=False,
        )
    )
    return 0 if manifest["error"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
