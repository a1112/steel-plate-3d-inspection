"""Persistent capture history indexes and cropped image pyramids."""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image


PLAYBACK_INDEX_SCHEMA = "steel.capture-playback-index.v1"
PLAYBACK_CATALOG_SCHEMA = "steel.capture-playback-catalog.v1"
PYRAMID_SCHEMA = "steel.capture-image-pyramid.v1"
PYRAMID_ALGORITHM = "flow-horizontal-grayscale-roi-v2"
PYRAMID_WIDTHS = (160, 320, 640, 800, 1280, 2560)


def _utc_text(nanoseconds: int | None = None) -> str:
    instant = (
        dt.datetime.fromtimestamp(nanoseconds / 1_000_000_000, tz=dt.timezone.utc)
        if nanoseconds and nanoseconds > 0
        else dt.datetime.now(dt.timezone.utc)
    )
    return instant.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _atomic_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    _atomic_bytes(path, body)


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON payload must be an object: {path}")
    return value


def _numeric_files(directory: Path, suffix: str) -> list[tuple[int, Path]]:
    result: list[tuple[int, Path]] = []
    if not directory.is_dir():
        return result
    for path in directory.glob(f"*{suffix}"):
        try:
            result.append((int(path.stem), path))
        except ValueError:
            continue
    result.sort(key=lambda item: item[0])
    return result


def _dominant_bounds(
    active: np.ndarray,
    strength: np.ndarray,
    *,
    maximum_gap: int,
) -> tuple[int, int] | None:
    indices = np.flatnonzero(active)
    if indices.size == 0:
        return None
    groups = np.split(indices, np.flatnonzero(np.diff(indices) > maximum_gap) + 1)
    winner = max(
        groups,
        key=lambda group: (
            float(np.sum(strength[int(group[0]) : int(group[-1]) + 1])),
            int(group[-1]) - int(group[0]) + 1,
        ),
    )
    return int(winner[0]), int(winner[-1]) + 1


def detect_valid_grayscale_roi(
    image: np.ndarray,
    *,
    threshold: float = 8.0,
    minimum_occupancy: float = 0.005,
    horizontal_padding: int = 16,
    vertical_padding: int = 4,
) -> list[int]:
    """Find the dominant bright steel region and reject isolated black-border noise."""
    value = np.asarray(image)
    if value.ndim != 2 or value.size == 0:
        raise ValueError("grayscale ROI source must be a non-empty 2D plane")
    height, width = value.shape
    sampled = value[::2, ::2] > threshold
    row_strength = np.mean(sampled, axis=1)
    column_strength = np.mean(sampled, axis=0)
    row_bounds = _dominant_bounds(
        row_strength >= minimum_occupancy,
        row_strength,
        maximum_gap=4,
    )
    column_bounds = _dominant_bounds(
        column_strength >= minimum_occupancy,
        column_strength,
        maximum_gap=16,
    )
    if row_bounds is None or column_bounds is None:
        return [0, 0, width, height]
    top = max(0, row_bounds[0] * 2 - vertical_padding)
    bottom = min(height, row_bounds[1] * 2 + vertical_padding)
    left = max(0, column_bounds[0] * 2 - horizontal_padding)
    right = min(width, column_bounds[1] * 2 + horizontal_padding)
    if right - left < 32 or bottom - top < 8:
        return [0, 0, width, height]
    return [left, top, right, bottom]


def playback_roi_path(storage_root: Path, material_id: str) -> Path:
    return storage_root / "history" / "roi" / f"{material_id}.json"


def _flow_horizontal_roi(
    source_path: Path,
    cache_root: Path,
    image_width: int | None,
) -> tuple[list[int] | None, Path | None]:
    try:
        flow_root = source_path.parent.parent
        material_id = flow_root.name
        camera_id = flow_root.parent.name
        roi_path = playback_roi_path(cache_root.parent, material_id)
        payload = _read_json(roi_path)
        box = payload.get("cameras", {}).get(camera_id)
        if not isinstance(box, list) or len(box) != 4:
            return None, roi_path
        left, _, right, _ = (int(value) for value in box)
        if (
            left < 0
            or (image_width is not None and right > image_width)
            or right - left < 32
        ):
            return None, roi_path
        return [left, 0, right, 0], roi_path
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None, None


def source_fingerprint(path: Path, cache_root: Path | None = None) -> str:
    stat = path.stat()
    digest = hashlib.sha256()
    digest.update(PYRAMID_ALGORITHM.encode("ascii"))
    digest.update(str(path.resolve()).lower().encode("utf-8"))
    digest.update(stat.st_size.to_bytes(8, "little", signed=False))
    digest.update(stat.st_mtime_ns.to_bytes(8, "little", signed=False))
    if cache_root is not None:
        flow_roi, _ = _flow_horizontal_roi(path, cache_root, None)
        digest.update(json.dumps(flow_roi, separators=(",", ":")).encode("ascii"))
    return digest.hexdigest()


def pyramid_directory(cache_root: Path, fingerprint: str) -> Path:
    return cache_root / "playback-pyramid" / "v1" / fingerprint[:2] / fingerprint


def read_image_pyramid(
    cache_root: Path,
    fingerprint: str,
) -> tuple[Path, dict[str, Any]] | None:
    directory = pyramid_directory(cache_root, fingerprint)
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        return None
    try:
        manifest = _read_json(manifest_path)
        if (
            manifest.get("schema") != PYRAMID_SCHEMA
            or manifest.get("sourceFingerprint") != fingerprint
            or not manifest.get("levels")
            or not all(
                (directory / str(row["file"])).is_file()
                for row in manifest.get("levels", [])
            )
        ):
            return None
        return manifest_path, manifest
    except (OSError, ValueError, json.JSONDecodeError, KeyError, TypeError):
        return None


def build_image_pyramid(source_path: Path, cache_root: Path) -> tuple[Path, dict[str, Any]]:
    fingerprint = source_fingerprint(source_path, cache_root)
    directory = pyramid_directory(cache_root, fingerprint)
    manifest_path = directory / "manifest.json"
    existing = read_image_pyramid(cache_root, fingerprint)
    if existing is not None:
        return existing

    with Image.open(source_path) as opened:
        grayscale = opened.convert("L")
    try:
        plane = np.asarray(grayscale)
        original_width, original_height = grayscale.size
        detected_box = detect_valid_grayscale_roi(plane)
        flow_roi, flow_roi_path = _flow_horizontal_roi(
            source_path, cache_root, original_width
        )
        crop_box = list(detected_box)
        if flow_roi is not None:
            crop_box[0] = flow_roi[0]
            crop_box[2] = flow_roi[2]
        cropped = grayscale.crop(tuple(crop_box))
    finally:
        grayscale.close()

    try:
        crop_width, crop_height = cropped.size
        widths = sorted(
            {width for width in PYRAMID_WIDTHS if width < crop_width} | {crop_width},
            reverse=True,
        )
        levels: list[dict[str, Any]] = []
        current = cropped.copy()
        try:
            for width in widths:
                height = max(1, round(crop_height * width / crop_width))
                if current.size != (width, height):
                    resized = current.resize((width, height), Image.Resampling.BILINEAR)
                    current.close()
                    current = resized
                output = io.BytesIO()
                current.save(output, format="JPEG", quality=84, optimize=False)
                body = output.getvalue()
                name = f"w{width}.jpg"
                _atomic_bytes(directory / name, body)
                levels.append(
                    {"width": width, "height": height, "file": name, "bytes": len(body)}
                )
        finally:
            current.close()
        levels.sort(key=lambda row: int(row["width"]))
        manifest = {
            "schema": PYRAMID_SCHEMA,
            "algorithm": PYRAMID_ALGORITHM,
            "generatedAt": _utc_text(),
            "source": str(source_path),
            "sourceFingerprint": fingerprint,
            "originalSize": [original_width, original_height],
            "validRoi": crop_box,
            "frameDetectedRoi": detected_box,
            "flowHorizontalRoi": flow_roi,
            "flowRoiPath": str(flow_roi_path) if flow_roi_path else "",
            "cropSize": [crop_width, crop_height],
            "blackBorderCropped": crop_box != [0, 0, original_width, original_height],
            "levels": levels,
        }
        _atomic_json(manifest_path, manifest)
        return manifest_path, manifest
    finally:
        cropped.close()


def select_pyramid_image(
    manifest_path: Path,
    manifest: dict[str, Any],
    maximum_width: int,
) -> tuple[Path, dict[str, Any]]:
    levels = sorted(manifest.get("levels", []), key=lambda row: int(row["width"]))
    if not levels:
        raise ValueError(f"image pyramid has no levels: {manifest_path}")
    target = next(
        (row for row in levels if int(row["width"]) >= maximum_width),
        levels[-1],
    )
    return manifest_path.parent / str(target["file"]), target


def playback_index_path(storage_root: Path, material_id: str) -> Path:
    return storage_root / "history" / f"{material_id}.json"


def playback_catalog_path(storage_root: Path) -> Path:
    return storage_root / "history" / "catalog.json"


def flow_pyramid_cache_status_path(storage_root: Path, material_id: str) -> Path:
    return (
        storage_root
        / "cache"
        / "playback-pyramid"
        / "flows"
        / f"{material_id}.json"
    )


def write_flow_pyramid_cache_status(
    storage_root: Path,
    payload: dict[str, Any],
) -> Path:
    path = flow_pyramid_cache_status_path(
        storage_root, str(payload.get("materialId", "unknown"))
    )
    _atomic_json(path, payload)
    return path


def build_and_write_playback_index(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
) -> tuple[Path, dict[str, Any]]:
    grouped: dict[int, dict[str, Any]] = {}
    for fallback_index, (camera_id, camera_root) in enumerate(sorted(camera_roots.items()), start=1):
        flow_root = camera_root / material_id
        for storage_index, metadata_path in _numeric_files(flow_root / "json", ".json"):
            intensity_path = flow_root / "2d" / f"{storage_index}.png"
            if not intensity_path.is_file() or intensity_path.is_symlink():
                continue
            try:
                metadata = _read_json(metadata_path)
                stat = intensity_path.stat()
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            capture_round = int(metadata.get("captureRound", storage_index + 1) or storage_index + 1)
            host_ns = int(metadata.get("hostUtcNs", 0) or 0) or stat.st_mtime_ns
            width = int(metadata.get("width", 0) or 0)
            height = int(metadata.get("height", 0) or 0)
            if width <= 0 or height <= 0:
                try:
                    with Image.open(intensity_path) as image:
                        width, height = image.size
                except OSError:
                    continue
            frame = grouped.setdefault(
                capture_round,
                {
                    "frameId": f"{material_id}:{capture_round:012d}",
                    "materialId": material_id,
                    "sequence": capture_round,
                    "capturedAt": _utc_text(host_ns),
                    "sortNs": host_ns,
                    "cameras": [],
                },
            )
            if host_ns < int(frame["sortNs"]):
                frame["sortNs"] = host_ns
                frame["capturedAt"] = _utc_text(host_ns)
            camera_key = str(metadata.get("cameraKey", camera_id) or camera_id)
            numeric_index = "".join(character for character in camera_id if character.isdigit())
            frame["cameras"].append(
                {
                    "cameraId": str(metadata.get("cameraId", camera_id) or camera_id),
                    "cameraIndex": int(numeric_index) if numeric_index else fallback_index,
                    "ip": str(metadata.get("cameraIp", "")),
                    "artifactRef": f"{camera_key}/{material_id}/2d/{storage_index}.png",
                    "storageIndex": storage_index,
                    "captureRound": capture_round,
                    "width": width,
                    "height": height,
                    "bytes": stat.st_size,
                    "storedAt": _utc_text(host_ns),
                }
            )

    frames = sorted(grouped.values(), key=lambda row: int(row["sortNs"]))
    for frame in frames:
        frame["cameras"].sort(key=lambda row: int(row["cameraIndex"]))
    first_ns = int(frames[0]["sortNs"]) if frames else 0
    last_ns = int(frames[-1]["sortNs"]) if frames else 0
    payload = {
        "schema": PLAYBACK_INDEX_SCHEMA,
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "frameCount": len(frames),
        "firstHostUtcNs": first_ns,
        "lastHostUtcNs": last_ns,
        "frames": frames,
    }
    path = playback_index_path(storage_root, material_id)

    measurement_path = storage_root / "measurements" / f"{material_id}.json"
    if not measurement_path.is_file():
        measurement_path = next(
            (
                root / material_id / "measurement.json"
                for root in camera_roots.values()
                if (root / material_id / "measurement.json").is_file()
            ),
            measurement_path,
        )
    try:
        measurement = _read_json(measurement_path)
        source_boxes = measurement.get("twoDimensionalCrop", {})
        camera_boxes = {
            str(camera_id): [int(value) for value in box]
            for camera_id, box in source_boxes.items()
            if isinstance(box, list)
            and len(box) == 4
            and int(box[2]) - int(box[0]) >= 32
        }
        if camera_boxes:
            for frame in frames:
                for camera in frame["cameras"]:
                    box = camera_boxes.get(str(camera.get("cameraId", "")))
                    if box is None:
                        continue
                    camera["validRoi"] = box
                    camera["playbackWidth"] = box[2] - box[0]
                    camera["playbackHeight"] = int(camera.get("height", 0))
            _atomic_json(
                playback_roi_path(storage_root, material_id),
                {
                    "schema": "steel.capture-playback-roi.v1",
                    "generatedAt": _utc_text(),
                    "materialId": material_id,
                    "measurementPath": str(measurement_path),
                    "cameras": camera_boxes,
                },
            )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    _atomic_json(path, payload)

    catalog_path = playback_catalog_path(storage_root)
    try:
        catalog = _read_json(catalog_path) if catalog_path.is_file() else {}
    except (OSError, ValueError, json.JSONDecodeError):
        catalog = {}
    entries = [
        row
        for row in catalog.get("materials", [])
        if isinstance(row, dict) and row.get("materialId") != material_id
    ]
    entries.append(
        {
            "materialId": material_id,
            "indexFile": path.name,
            "frameCount": len(frames),
            "firstHostUtcNs": first_ns,
            "lastHostUtcNs": last_ns,
        }
    )
    entries.sort(key=lambda row: int(row.get("lastHostUtcNs", 0)), reverse=True)
    _atomic_json(
        catalog_path,
        {
            "schema": PLAYBACK_CATALOG_SCHEMA,
            "generatedAt": _utc_text(),
            "materialCount": len(entries),
            "frameCount": sum(int(row.get("frameCount", 0)) for row in entries),
            "materials": entries,
        },
    )
    return path, payload


def warm_flow_image_pyramids(
    camera_roots: dict[str, Path],
    storage_root: Path,
    index: dict[str, Any],
) -> dict[str, Any]:
    """Persist every pyramid level for a completed flow in a low-priority worker."""
    started = time.perf_counter()
    material_id = str(index.get("materialId", ""))
    cache_root = storage_root / "cache"
    cached = 0
    failures: list[dict[str, str]] = []
    for frame in index.get("frames", []):
        for camera in frame.get("cameras", []):
            camera_id = str(camera.get("cameraId", ""))
            artifact = str(camera.get("artifactRef", ""))
            parts = Path(artifact).parts
            camera_root = camera_roots.get(camera_id)
            if camera_root is None or len(parts) < 2:
                continue
            source = camera_root.joinpath(*parts[1:])
            try:
                if not source.is_file() or source.is_symlink():
                    continue
                build_image_pyramid(source, cache_root)
                cached += 1
            except (OSError, ValueError) as error:
                failures.append({"source": str(source), "error": str(error)})
    result = {
        "schema": "steel.capture-flow-pyramid-cache.v1",
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "frameCount": int(index.get("frameCount", 0)),
        "sourceImageCount": cached + len(failures),
        "cachedImageCount": cached,
        "failureCount": len(failures),
        "failures": failures[:20],
        "elapsedMs": round((time.perf_counter() - started) * 1000.0, 3),
    }
    write_flow_pyramid_cache_status(storage_root, result)
    return result


def read_indexed_history(
    storage_root: Path,
    limit: int,
    material_id: str = "",
) -> tuple[list[dict[str, Any]], bool, int] | None:
    catalog_path = playback_catalog_path(storage_root)
    if not catalog_path.is_file():
        return None
    try:
        catalog = _read_json(catalog_path)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    entries = [row for row in catalog.get("materials", []) if isinstance(row, dict)]
    if material_id:
        entries = [row for row in entries if row.get("materialId") == material_id]
    if not entries:
        return None
    total = sum(int(row.get("frameCount", 0)) for row in entries)
    frames: list[dict[str, Any]] = []
    for entry in entries:
        index_path = storage_root / "history" / str(entry.get("indexFile", ""))
        try:
            payload = _read_json(index_path)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        material_frames = [row for row in payload.get("frames", []) if isinstance(row, dict)]
        frames.extend(material_frames)
        if len(frames) >= limit:
            break
    frames.sort(key=lambda row: int(row.get("sortNs", 0)))
    selected = frames[-limit:]
    result: list[dict[str, Any]] = []
    for source in selected:
        row = dict(source)
        row.pop("sortNs", None)
        result.append(row)
    return result, total > len(selected), total
