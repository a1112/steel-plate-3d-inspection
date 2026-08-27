"""Readable two-level gray/JET renditions built from immutable Ranger3 data.

The file name is always the raw storage index (``0.jpg``, ``1.jpg`` ...).
Ordering and synchronization remain owned by the playback/alignment manifests.
"""

from __future__ import annotations

import bisect
import copy
import datetime as dt
import hashlib
import io
import json
import math
import re
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .measurement import (
    MeasurementConfig,
    _coordinate,
    _load_calibration,
    _matrix_for,
    _transform_profile,
    robust_circle_fit,
)
from .paths import (
    alignment_path,
    capture_root,
    rendition_image_path,
    rendition_metadata_path,
    rendition_root,
    rendition_status_path,
)
from .playback import _atomic_bytes, _atomic_json, detect_valid_grayscale_roi
from .profile import sha256_file
from .regions import RegionConfig, stable_horizontal_roi


RENDITION_SCHEMA = "steel.capture-readable-rendition.v2"
RENDITION_STATUS_SCHEMA = "steel.capture-readable-rendition-status.v2"
GRAY_ALGORITHM = "2d-stable-horizontal-row-envelope-v1"
JET_ALGORITHM = "six-camera-dynamic-circle-row-residual-v1"
THUMBNAIL_WIDTH = 384
JET_RANGE_MM = 1.0
_LEGACY_CACHE_FILE = re.compile(r"^[0-9a-f]{64}(?:-w[0-9]+)?\.(?:jpg|json)$", re.IGNORECASE)


def rendition_measurement_config(defaults: dict[str, Any]) -> MeasurementConfig:
    """Build the small geometry policy needed by readable JET renditions."""
    return MeasurementConfig(
        row_window=int(defaults.get("measurementRowWindow", 16)),
        maximum_profile_points=int(defaults.get("measurementMaximumProfilePoints", 320)),
        maximum_sections=int(defaults.get("measurementMaximumSections", 12)),
        minimum_circle_points=int(defaults.get("measurementMinimumCirclePoints", 48)),
        maximum_circle_residual_mm=float(
            defaults.get("measurementMaximumCircleResidualMm", 0.5)
        ),
    ).bounded()


class _BoundedMemoryLRU:
    """Small process-local cache for data read from immutable capture files.

    Capture workers are long-lived while a historical flow is being rebuilt, so
    avoiding repeated PNG/NPZ/JSON decoding matters.  The cache is deliberately
    bounded by both entry count and an approximate payload size.  Arrays are
    stored read-only below; callers therefore cannot accidentally mutate a
    value which is shared by later renditions.
    """

    def __init__(self, maximum_entries: int, maximum_bytes: int) -> None:
        self._maximum_entries = max(1, int(maximum_entries))
        self._maximum_bytes = max(1, int(maximum_bytes))
        self._entries: OrderedDict[object, tuple[Any, int]] = OrderedDict()
        self._bytes = 0
        self._lock = threading.RLock()

    def get(self, key: object) -> Any | None:
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            self._entries.move_to_end(key)
            return entry[0]

    def put(self, key: object, value: Any, size: int | None = None) -> None:
        payload_size = max(1, int(_cache_value_size(value) if size is None else size))
        if payload_size > self._maximum_bytes:
            return
        with self._lock:
            previous = self._entries.pop(key, None)
            if previous is not None:
                self._bytes -= previous[1]
            self._entries[key] = (value, payload_size)
            self._bytes += payload_size
            while self._entries and (
                len(self._entries) > self._maximum_entries
                or self._bytes > self._maximum_bytes
            ):
                _old_key, (_old_value, old_size) = self._entries.popitem(last=False)
                self._bytes -= old_size

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._bytes = 0


def _cache_value_size(value: Any) -> int:
    if isinstance(value, np.ndarray):
        return int(value.nbytes)
    if isinstance(value, (bytes, bytearray, memoryview, str)):
        return len(value)
    if isinstance(value, dict):
        return sum(_cache_value_size(key) + _cache_value_size(item) for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return sum(_cache_value_size(item) for item in value)
    if isinstance(value, Path):
        return len(str(value))
    return 1


# Each worker gets its own caches.  These limits keep a pair of playback
# workers bounded while still retaining adjacent frames used by row mapping.
_DISPLAY_CROP_CACHE = _BoundedMemoryLRU(64, 1 * 1024 * 1024)
_METADATA_RECORDS_CACHE = _BoundedMemoryLRU(8, 8 * 1024 * 1024)
_DEPTH_CACHE = _BoundedMemoryLRU(8, 64 * 1024 * 1024)
_GRAYSCALE_CACHE = _BoundedMemoryLRU(16, 32 * 1024 * 1024)
_FOREGROUND_MASK_CACHE = _BoundedMemoryLRU(16, 32 * 1024 * 1024)
_JSON_CACHE = _BoundedMemoryLRU(128, 8 * 1024 * 1024)
_CALIBRATION_CACHE = _BoundedMemoryLRU(4, 4 * 1024 * 1024)
_SHA256_CACHE = _BoundedMemoryLRU(2048, 256 * 1024)


def clear_rendition_memory_cache() -> None:
    """Clear process-local rendition read caches (primarily useful in tests)."""
    for cache in (
        _DISPLAY_CROP_CACHE,
        _METADATA_RECORDS_CACHE,
        _DEPTH_CACHE,
        _GRAYSCALE_CACHE,
        _FOREGROUND_MASK_CACHE,
        _JSON_CACHE,
        _CALIBRATION_CACHE,
        _SHA256_CACHE,
    ):
        cache.clear()


class RenditionNotReady(RuntimeError):
    def __init__(self, reason: str, *, processing: bool = False) -> None:
        super().__init__(reason)
        self.reason = reason
        self.processing = processing

    def __reduce__(self) -> tuple[Any, tuple[str, bool]]:
        # Preserve the retryable/processing flag when this exception crosses the
        # ProcessPoolExecutor boundary used by the HTTP rendition builder.
        return (_restore_rendition_not_ready, (self.reason, self.processing))


def _restore_rendition_not_ready(reason: str, processing: bool) -> RenditionNotReady:
    return RenditionNotReady(reason, processing=processing)


def _utc_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError(f"JSON payload must be an object: {path}")
    return payload


def _cached_json(path: Path) -> dict[str, Any]:
    """Read an immutable JSON source once per path/size/mtime signature."""
    cache_key = _file_cache_key(path)
    cached = _JSON_CACHE.get(cache_key)
    if cached is not None:
        return copy.deepcopy(cached)
    snapshot = copy.deepcopy(_read_json(path))
    _JSON_CACHE.put(cache_key, snapshot)
    # Return a separate object so the first caller cannot mutate the cached
    # snapshot either.
    return copy.deepcopy(snapshot)


def _cached_calibration(path: Path | None) -> dict[str, Any]:
    """Cache validated calibration loading without sharing mutable mappings."""
    if path is None or not path.is_file():
        return {}
    cache_key = _file_cache_key(path)
    cached = _CALIBRATION_CACHE.get(cache_key)
    if cached is not None:
        return copy.deepcopy(cached)
    snapshot = copy.deepcopy(_load_calibration(path))
    _CALIBRATION_CACHE.put(cache_key, snapshot)
    return copy.deepcopy(snapshot)


def _cached_sha256_file(path: Path) -> str:
    """Cache a file digest while invalidating on replacement or mtime change."""
    cache_key = _file_cache_key(path)
    cached = _SHA256_CACHE.get(cache_key)
    if cached is not None:
        return cached
    digest = sha256_file(path)
    _SHA256_CACHE.put(cache_key, digest)
    return digest


def _numeric_images(directory: Path) -> list[Path]:
    values: list[tuple[int, Path]] = []
    if directory.is_dir():
        for path in directory.iterdir():
            if path.is_file() and path.stem.isdecimal() and path.suffix.lower() in {
                ".png",
                ".jpg",
                ".jpeg",
            }:
                values.append((int(path.stem), path))
    return [path for _, path in sorted(values)]


def _sample_paths(paths: list[Path], maximum: int = 64) -> list[Path]:
    if len(paths) <= maximum:
        return paths
    indices = np.linspace(0, len(paths) - 1, maximum, dtype=np.int32)
    return [paths[int(index)] for index in indices]


def _file_cache_key(path: Path) -> tuple[str, int, int]:
    """Return a stable identity which invalidates after a file replacement."""
    stat = path.stat()
    return (
        str(path.resolve(strict=False)),
        int(stat.st_size),
        int(stat.st_mtime_ns),
    )


def _directory_cache_key(
    directory: Path,
    paths: list[Path],
    *parts: object,
) -> tuple[object, ...]:
    """Key a flow-level cache by directory and every source file signature."""
    directory_stat = directory.stat()
    digest = hashlib.sha256()
    for path in paths:
        stat = path.stat()
        digest.update(path.name.encode("utf-8", errors="surrogatepass"))
        digest.update(int(stat.st_size).to_bytes(8, "little", signed=False))
        digest.update(int(stat.st_mtime_ns).to_bytes(8, "little", signed=False))
    return (
        str(directory.resolve(strict=False)),
        int(directory_stat.st_mtime_ns),
        int(directory_stat.st_size),
        digest.hexdigest(),
        *parts,
    )


def _flow_2d_signature(paths: list[Path]) -> str:
    digest = hashlib.sha256(GRAY_ALGORITHM.encode("ascii"))
    for path in _sample_paths(paths):
        stat = path.stat()
        digest.update(path.name.encode("ascii", errors="ignore"))
        digest.update(stat.st_size.to_bytes(8, "little", signed=False))
        digest.update(stat.st_mtime_ns.to_bytes(8, "little", signed=False))
    return digest.hexdigest()


def _read_grayscale(path: Path) -> np.ndarray:
    cache_key = _file_cache_key(path)
    cached = _GRAYSCALE_CACHE.get(cache_key)
    if cached is not None:
        return cached
    with Image.open(path) as opened:
        value = np.asarray(opened.convert("L")).copy()
    if value.ndim != 2 or value.size == 0:
        raise ValueError(f"grayscale source must be a non-empty plane: {path}")
    value.setflags(write=False)
    _GRAYSCALE_CACHE.put(cache_key, value)
    return value


def resolve_display_crop(source_path: Path) -> tuple[list[int], dict[str, Any]]:
    """Resolve a material-stable horizontal crop using 2D intensity only."""
    flow_root = source_path.parents[1]
    camera_root = flow_root.parent
    material_id = flow_root.name
    camera_id = camera_root.name
    flow_2d = flow_root / "2d"
    images = _numeric_images(flow_2d)
    if not images:
        raise RenditionNotReady("gray-source-unavailable")
    crop_cache_key = _directory_cache_key(flow_2d, images, GRAY_ALGORITHM)
    cached_crop = _DISPLAY_CROP_CACHE.get(crop_cache_key)
    if cached_crop is not None:
        cached_values, cached_status = cached_crop
        return list(cached_values), copy.deepcopy(cached_status)
    signature = _flow_2d_signature(images)
    status_path = rendition_status_path(camera_root, material_id, "gray")
    try:
        status = _read_json(status_path)
        crop = status.get("displayCrop")
        if (
            status.get("schema") == RENDITION_STATUS_SCHEMA
            and status.get("displayCropAlgorithm") == GRAY_ALGORITHM
            and status.get("flow2dSignature") == signature
            and isinstance(crop, list)
            and len(crop) == 4
        ):
            resolved_crop = [int(value) for value in crop]
            _DISPLAY_CROP_CACHE.put(
                crop_cache_key,
                (tuple(resolved_crop), copy.deepcopy(status)),
            )
            return resolved_crop, status
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass

    sampled = _sample_paths(images)
    rois: list[list[int]] = []
    width = height = 0
    for path in sampled:
        try:
            plane = _read_grayscale(path)
            height, width = plane.shape
            roi = detect_valid_grayscale_roi(plane)
            if roi is not None:
                rois.append(roi)
        except (OSError, ValueError):
            continue
    crop = stable_horizontal_roi(rois, width, height, RegionConfig()) if width else None
    if crop is None:
        # Head/tail-only fixtures may not contain a frame whose detected region
        # spans the configured fraction of the height. Keep the best 2D-only
        # horizontal envelope while still preserving every source row.
        usable = [roi for roi in rois if roi[2] - roi[0] >= min(64, width)]
        if usable:
            crop = [
                max(0, int(np.percentile([row[0] for row in usable], 5))),
                0,
                min(width, int(np.percentile([row[2] for row in usable], 95))),
                height,
            ]
    if crop is None or crop[2] <= crop[0]:
        raise RenditionNotReady("2d-display-crop-unavailable")
    crop = [int(crop[0]), 0, int(crop[2]), int(height)]
    status = {
        "schema": RENDITION_STATUS_SCHEMA,
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "cameraId": camera_id,
        "modality": "gray",
        "levels": ["thumbnail", "original"],
        "thumbnailWidth": THUMBNAIL_WIDTH,
        "displayCropAlgorithm": GRAY_ALGORITHM,
        "displayCropSource": "2d-intensity-only",
        "displayCrop": crop,
        "foregroundMask": "per-row-bright-envelope-dark-interior-preserved",
        "sourceFrameCount": len(images),
        "sampledFrameCount": len(sampled),
        "flow2dSignature": signature,
    }
    _atomic_json(status_path, status)
    _DISPLAY_CROP_CACHE.put(
        crop_cache_key,
        (tuple(crop), copy.deepcopy(status)),
    )
    return crop, status


def row_foreground_mask(
    grayscale: np.ndarray,
    crop: list[int],
    *,
    threshold: int = 8,
) -> np.ndarray:
    """Build a per-row material envelope while retaining dark interior pixels."""
    left, _top, right, _bottom = crop
    plane = np.asarray(grayscale[:, left:right], dtype=np.uint8)
    height, width = plane.shape
    mask = np.zeros((height, width), dtype=bool)
    previous: tuple[int, int] | None = None
    for row_index in range(height):
        active = np.flatnonzero(plane[row_index] > threshold)
        if active.size < 4:
            continue
        groups = np.split(active, np.flatnonzero(np.diff(active) > 32) + 1)
        group = max(
            groups,
            key=lambda values: (
                int(values[-1] - values[0] + 1),
                int(np.sum(plane[row_index, values], dtype=np.int64)),
            ),
        )
        bounds = (max(0, int(group[0]) - 4), min(width, int(group[-1]) + 5))
        # A sudden one-line contraction is generally a dark surface defect.
        # Borrow the adjacent envelope so the defect remains visible.
        if previous is not None and bounds[1] - bounds[0] < (previous[1] - previous[0]) * 0.65:
            bounds = previous
        mask[row_index, bounds[0] : bounds[1]] = True
        previous = bounds
    # Fill isolated missing rows from their neighbours without inventing steel
    # across a long black head/tail interval.
    occupied = np.any(mask, axis=1)
    for row_index in np.flatnonzero(~occupied):
        before = row_index - 1
        after = row_index + 1
        if before >= 0 and after < height and occupied[before] and occupied[after]:
            mask[row_index] = mask[before] | mask[after]
    return mask


def _cached_foreground_mask(
    source_path: Path,
    crop: list[int],
    *,
    threshold: int = 8,
) -> np.ndarray:
    """Read and envelope one 2D frame once per source signature/crop."""
    cache_key = (_file_cache_key(source_path), tuple(int(value) for value in crop), int(threshold))
    cached = _FOREGROUND_MASK_CACHE.get(cache_key)
    if cached is not None:
        return cached
    mask = row_foreground_mask(
        _read_grayscale(source_path),
        crop,
        threshold=threshold,
    )
    mask.setflags(write=False)
    _FOREGROUND_MASK_CACHE.put(cache_key, mask)
    return mask


def _jpeg_bytes(plane: np.ndarray, width: int | None = None) -> tuple[bytes, list[int]]:
    image = Image.fromarray(np.asarray(plane, dtype=np.uint8))
    try:
        if width is not None and image.width > width:
            height = max(1, round(image.height * width / image.width))
            resized = image.resize((width, height), Image.Resampling.BILINEAR)
        else:
            resized = image.copy()
        try:
            output = io.BytesIO()
            resized.save(output, format="JPEG", quality=90, optimize=False)
            return output.getvalue(), [resized.width, resized.height]
        finally:
            resized.close()
    finally:
        image.close()


def _source_signature(source_path: Path, crop: list[int], algorithm: str) -> str:
    stat = source_path.stat()
    digest = hashlib.sha256(algorithm.encode("ascii"))
    digest.update(str(source_path.resolve()).lower().encode("utf-8"))
    digest.update(stat.st_size.to_bytes(8, "little", signed=False))
    digest.update(stat.st_mtime_ns.to_bytes(8, "little", signed=False))
    digest.update(json.dumps(crop, separators=(",", ":")).encode("ascii"))
    metadata_path = source_path.parents[1] / "json" / f"{source_path.stem}.json"
    try:
        metadata = _cached_json(metadata_path)
        checksum = str(metadata.get("checksums", {}).get("steelIntensity", ""))
        digest.update(checksum.encode("ascii"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    return digest.hexdigest()


def _existing_rendition(
    camera_root: Path,
    material_id: str,
    modality: str,
    storage_index: int,
    signature: str,
) -> dict[str, Any] | None:
    metadata_path = rendition_metadata_path(camera_root, material_id, modality, storage_index)
    try:
        metadata = _read_json(metadata_path)
        if (
            metadata.get("schema") == RENDITION_SCHEMA
            and metadata.get("signature") == signature
            and rendition_image_path(camera_root, material_id, modality, "thumbnail", storage_index).is_file()
            and rendition_image_path(camera_root, material_id, modality, "original", storage_index).is_file()
        ):
            return metadata
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    return None


def committed_rendition_file(
    source_path: Path,
    modality: str,
    level: str,
    *,
    calibration_path: Path | None = None,
) -> Path | None:
    """Read a committed rendition without entering the bounded build queue."""
    try:
        normalized_modality = modality.strip().lower()
        normalized_level = level.strip().lower()
        if normalized_modality not in {"gray", "jet"} or normalized_level not in {
            "thumbnail",
            "original",
        }:
            return None
        camera_root = source_path.parents[2]
        material_id = source_path.parents[1].name
        storage_index = int(source_path.stem)
        metadata = _read_json(
            rendition_metadata_path(
                camera_root, material_id, normalized_modality, storage_index
            )
        )
        expected_algorithm = GRAY_ALGORITHM if normalized_modality == "gray" else JET_ALGORITHM
        if (
            metadata.get("schema") != RENDITION_SCHEMA
            or metadata.get("modality") != normalized_modality
            or metadata.get("algorithm") != expected_algorithm
            or int(metadata.get("storageIndex", -1)) != storage_index
        ):
            return None
        if normalized_modality == "jet" and calibration_path is not None:
            if metadata.get("calibration", {}).get("sha256") != _cached_sha256_file(
                calibration_path
            ):
                return None
        for required_level in ("thumbnail", "original"):
            if not rendition_image_path(
                camera_root,
                material_id,
                normalized_modality,
                required_level,
                storage_index,
            ).is_file():
                return None
        selected = rendition_image_path(
            camera_root,
            material_id,
            normalized_modality,
            normalized_level,
            storage_index,
        )
        with selected.open("rb") as stream:
            if stream.read(2) != b"\xff\xd8":
                return None
        return selected
    except (OSError, ValueError, TypeError, json.JSONDecodeError, IndexError):
        return None


def build_gray_rendition(source_path: Path) -> dict[str, Any]:
    if not source_path.stem.isdecimal() or source_path.parent.name != "2d":
        raise ValueError("gray rendition source must be a numeric raw 2d frame")
    flow_root = source_path.parents[1]
    camera_root = flow_root.parent
    material_id = flow_root.name
    storage_index = int(source_path.stem)
    crop, _ = resolve_display_crop(source_path)
    signature = _source_signature(source_path, crop, GRAY_ALGORITHM)
    existing = _existing_rendition(
        camera_root, material_id, "gray", storage_index, signature
    )
    if existing is not None:
        return existing
    grayscale = _read_grayscale(source_path)
    if grayscale.shape[0] != crop[3] or crop[2] > grayscale.shape[1]:
        raise RenditionNotReady("2d-display-crop-source-size-mismatch")
    mask = _cached_foreground_mask(source_path, crop)
    cropped = grayscale[:, crop[0] : crop[2]].copy()
    cropped[~mask] = 0
    original_body, original_size = _jpeg_bytes(cropped)
    thumbnail_body, thumbnail_size = _jpeg_bytes(cropped, THUMBNAIL_WIDTH)
    original_path = rendition_image_path(
        camera_root, material_id, "gray", "original", storage_index
    )
    thumbnail_path = rendition_image_path(
        camera_root, material_id, "gray", "thumbnail", storage_index
    )
    _atomic_bytes(original_path, original_body)
    _atomic_bytes(thumbnail_path, thumbnail_body)
    metadata_path = rendition_metadata_path(camera_root, material_id, "gray", storage_index)
    metadata = {
        "schema": RENDITION_SCHEMA,
        "algorithm": GRAY_ALGORITHM,
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "cameraId": camera_root.name,
        "storageIndex": storage_index,
        "modality": "gray",
        "source": str(source_path),
        "signature": signature,
        "displayCrop": crop,
        "foregroundMask": "per-row-bright-envelope-dark-interior-preserved",
        "validForegroundRows": int(np.count_nonzero(np.any(mask, axis=1))),
        "levels": {
            "thumbnail": {"file": f"thumbnail/{storage_index}.jpg", "size": thumbnail_size},
            "original": {"file": f"original/{storage_index}.jpg", "size": original_size},
        },
    }
    _atomic_json(metadata_path, metadata)
    return metadata


def _metadata_records(flow_root: Path, head_time: float) -> list[dict[str, Any]]:
    metadata_root = flow_root / "json"
    if not metadata_root.is_dir():
        return []
    paths = sorted(
        (item for item in metadata_root.glob("*.json") if item.stem.isdecimal()),
        key=lambda item: int(item.stem),
    )
    cache_key = _directory_cache_key(metadata_root, paths, float(head_time))
    cached = _METADATA_RECORDS_CACHE.get(cache_key)
    if cached is not None:
        # The list is a per-call view; cached records and their input payloads
        # remain private to this process and are never mutated by the builder.
        return list(cached)
    records: list[dict[str, Any]] = []
    for path in paths:
        payload = _cached_json(path)
        timestamp = int(payload.get("timestamp", payload.get("deviceTimestamp", 0)) or 0)
        frequency = int(
            payload.get("timestamp_frequency", payload.get("timestampFrequency", 0)) or 0
        )
        if timestamp <= 0 or frequency <= 0:
            continue
        records.append(
            {
                "storageIndex": int(path.stem),
                "start": timestamp / frequency - head_time,
                "height": int(payload.get("height", 0) or 0),
                "width": int(payload.get("width", 0) or 0),
                "metadata": payload,
                "metadataPath": path,
            }
        )
    cached_records = tuple(records)
    _METADATA_RECORDS_CACHE.put(cache_key, cached_records)
    return list(cached_records)


def _map_row(
    records: list[dict[str, Any]], starts: list[float], elapsed: float, rate: float
) -> tuple[dict[str, Any], int] | None:
    index = bisect.bisect_right(starts, elapsed) - 1
    if index < 0 or index >= len(records):
        return None
    record = records[index]
    row = int(round((elapsed - float(record["start"])) * rate))
    if row < 0 or row >= int(record["height"]):
        return None
    return record, row


def _load_depth(path: Path) -> np.ndarray:
    cache_key = _file_cache_key(path)
    cached = _DEPTH_CACHE.get(cache_key)
    if cached is not None:
        return cached
    with np.load(path, allow_pickle=False) as payload:
        if not payload.files:
            raise ValueError(f"depth NPZ has no array: {path}")
        value = np.asarray(payload[payload.files[0]]).copy()
    if value.ndim != 2:
        raise ValueError(f"depth plane must be 2D: {path}")
    value.setflags(write=False)
    _DEPTH_CACHE.put(cache_key, value)
    return value


def _jet_rgb(residual: np.ndarray, valid: np.ndarray) -> np.ndarray:
    normalized = np.clip((residual + JET_RANGE_MM) / (2.0 * JET_RANGE_MM), 0.0, 1.0)
    four = 4.0 * normalized
    red = np.clip(1.5 - np.abs(four - 3.0), 0.0, 1.0)
    green = np.clip(1.5 - np.abs(four - 2.0), 0.0, 1.0)
    blue = np.clip(1.5 - np.abs(four - 1.0), 0.0, 1.0)
    rgb = np.rint(np.stack((red, green, blue), axis=-1) * 255.0).astype(np.uint8)
    rgb[~valid] = 0
    return rgb


def _file_stat_signature(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def build_jet_rendition(
    source_path: Path,
    *,
    camera_id: str,
    camera_roots: dict[str, Path],
    storage_root: Path,
    calibration_path: Path,
    config: MeasurementConfig,
) -> dict[str, Any]:
    if len(camera_roots) != 6:
        raise RenditionNotReady("jet-requires-six-cameras")
    flow_root = source_path.parents[1]
    camera_root = flow_root.parent
    material_id = flow_root.name
    storage_index = int(source_path.stem)
    alignment_file = alignment_path(storage_root, material_id)
    if not alignment_file.is_file():
        raise RenditionNotReady("alignment-manifest-unavailable", processing=True)
    alignment = _cached_json(alignment_file)
    quality = alignment.get("quality", {})
    if not quality.get("geometrySynchronized") or int(quality.get("completeCameras", 0)) != 6:
        raise RenditionNotReady("six-camera-alignment-not-ready", processing=True)
    calibration = _cached_calibration(calibration_path)
    if not calibration.get("approved"):
        raise RenditionNotReady("approved-array-calibration-unavailable")
    crop, _ = resolve_display_crop(source_path)
    base_signature = hashlib.sha256(
        "|".join(
            (
                JET_ALGORITHM,
                _source_signature(source_path, crop, GRAY_ALGORITHM),
                _file_stat_signature(flow_root / "3d" / f"{storage_index}.npz"),
                _file_stat_signature(flow_root / "json" / f"{storage_index}.json"),
                _cached_sha256_file(calibration_path),
                _cached_sha256_file(alignment_file),
                str(JET_RANGE_MM),
                str(config.row_window),
                str(config.maximum_profile_points),
            )
        ).encode("utf-8")
    ).hexdigest()
    existing = _existing_rendition(
        camera_root, material_id, "jet", storage_index, base_signature
    )
    if existing is not None:
        return existing

    camera_context: dict[str, dict[str, Any]] = {}
    watermark = math.inf
    for current_id, current_root in sorted(camera_roots.items()):
        alignment_camera = alignment.get("cameras", {}).get(current_id, {})
        head_time = alignment_camera.get("headDeviceTime")
        rate = float(alignment_camera.get("lineRateHz", 0) or 0)
        if head_time is None or rate <= 0:
            raise RenditionNotReady(f"{current_id}:alignment-timing-unavailable", processing=True)
        current_flow = capture_root(current_root, material_id, current_id)
        records = _metadata_records(current_flow, float(head_time))
        if not records:
            raise RenditionNotReady(f"{current_id}:metadata-unavailable", processing=True)
        starts = [float(record["start"]) for record in records]
        watermark = min(
            watermark,
            starts[-1] + int(records[-1]["height"]) / rate,
        )
        sample_source = current_flow / "2d" / f"{records[len(records) // 2]['storageIndex']}.png"
        current_crop, _ = resolve_display_crop(sample_source)
        camera_context[current_id] = {
            "flowRoot": current_flow,
            "records": records,
            "starts": starts,
            "rate": rate,
            "crop": current_crop,
            "depth": {},
            "intensity": {},
            "mask": {},
        }

    target_context = camera_context[camera_id]
    target_record = next(
        (row for row in target_context["records"] if row["storageIndex"] == storage_index),
        None,
    )
    if target_record is None:
        raise RenditionNotReady("target-frame-metadata-unavailable", processing=True)
    target_end = float(target_record["start"]) + int(target_record["height"]) / float(
        target_context["rate"]
    )
    flow_closed = False
    try:
        flow_closed = (
            _cached_json(Path(storage_root) / material_id / "flow.json").get("state")
            == "closed"
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    if target_end > watermark + 1e-9 and not flow_closed:
        raise RenditionNotReady("six-camera-sync-watermark-not-reached", processing=True)

    def planes(current_id: str, record: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        context = camera_context[current_id]
        index = int(record["storageIndex"])
        if index not in context["depth"]:
            depth_path = context["flowRoot"] / "3d" / f"{index}.npz"
            intensity_path = context["flowRoot"] / "2d" / f"{index}.png"
            context["depth"][index] = _load_depth(depth_path)
            intensity = _read_grayscale(intensity_path)
            context["intensity"][index] = intensity
            context["mask"][index] = _cached_foreground_mask(
                intensity_path, context["crop"]
            )
        return (
            context["depth"][index],
            context["intensity"][index],
            context["mask"][index],
        )

    target_depth, target_intensity, target_mask = planes(camera_id, target_record)
    output_width = crop[2] - crop[0]
    residual_plane = np.zeros((target_depth.shape[0], output_width), dtype=np.float32)
    valid_plane = np.zeros_like(residual_plane, dtype=bool)
    accepted_rows = 0
    fit_p95_values: list[float] = []
    source_records: dict[str, set[int]] = {current_id: set() for current_id in camera_roots}
    half = max(1, int(config.row_window) // 2)
    for target_row in range(target_depth.shape[0]):
        elapsed = float(target_record["start"]) + target_row / float(target_context["rate"])
        mapped: dict[str, tuple[dict[str, Any], int]] = {}
        profiles: list[np.ndarray] = []
        complete = True
        for current_id, context in camera_context.items():
            mapping = _map_row(context["records"], context["starts"], elapsed, context["rate"])
            if mapping is None:
                complete = False
                break
            record, row_index = mapping
            source_records[current_id].add(int(record["storageIndex"]))
            depth, _intensity, mask = planes(current_id, record)
            left, _top, right, _bottom = context["crop"]
            top = max(0, row_index - half)
            bottom = min(depth.shape[0], top + int(config.row_window))
            top = max(0, bottom - int(config.row_window))
            raw = depth[top:bottom, left:right].astype(np.float64)
            raw[raw == 0] = np.nan
            median = np.full(raw.shape[1], np.nan, dtype=np.float64)
            usable = np.any(np.isfinite(raw), axis=0)
            if np.any(usable):
                median[usable] = np.nanmedian(raw[:, usable], axis=0)
            metadata = record["metadata"]
            _sx, _ox, _ = _coordinate(metadata, "CoordinateA")
            _sz, _oz, invalid = _coordinate(metadata, "CoordinateC")
            valid_columns = np.isfinite(median) & (median != invalid) & mask[row_index]
            columns = np.flatnonzero(valid_columns)
            if columns.size < 8:
                complete = False
                break
            step = max(1, math.ceil(columns.size / int(config.maximum_profile_points)))
            columns = columns[::step]
            absolute_columns = columns + left
            points = np.column_stack(
                (
                    absolute_columns.astype(np.float64) * _sx + _ox,
                    median[columns] * _sz + _oz,
                )
            )
            matrix = _matrix_for(
                calibration,
                current_id,
                str(metadata.get("cameraSerialNumber", "")),
            )
            if matrix is None:
                raise RenditionNotReady(f"{current_id}:camera-calibration-unavailable")
            profiles.append(_transform_profile(points, matrix))
            mapped[current_id] = mapping
        if not complete or len(profiles) != 6:
            continue
        fit = robust_circle_fit(np.vstack(profiles), config.minimum_circle_points)
        fit_p95 = float(fit.get("p95AbsResidualMm", math.inf))
        if not fit.get("available") or fit_p95 > float(config.maximum_circle_residual_mm):
            continue
        raw_row = target_depth[target_row, crop[0] : crop[2]].astype(np.float64)
        target_metadata = target_record["metadata"]
        sx, ox, _ = _coordinate(target_metadata, "CoordinateA")
        sz, oz, invalid = _coordinate(target_metadata, "CoordinateC")
        valid = (raw_row != 0) & (raw_row != invalid) & target_mask[target_row]
        columns = np.flatnonzero(valid)
        if not columns.size:
            continue
        absolute_columns = columns + crop[0]
        local = np.column_stack(
            (
                absolute_columns.astype(np.float64) * sx + ox,
                raw_row[columns] * sz + oz,
            )
        )
        matrix = _matrix_for(
            calibration,
            camera_id,
            str(target_metadata.get("cameraSerialNumber", "")),
        )
        if matrix is None:
            raise RenditionNotReady(f"{camera_id}:camera-calibration-unavailable")
        transformed = _transform_profile(local, matrix)
        center = np.asarray([fit["centerX"], fit["centerZ"]], dtype=np.float64)
        residual = np.linalg.norm(transformed - center, axis=1) - float(fit["radiusMm"])
        residual_plane[target_row, columns] = residual.astype(np.float32)
        valid_plane[target_row, columns] = True
        accepted_rows += 1
        fit_p95_values.append(fit_p95)

    rgb = _jet_rgb(residual_plane, valid_plane)
    original_body, original_size = _jpeg_bytes(rgb)
    thumbnail_body, thumbnail_size = _jpeg_bytes(rgb, THUMBNAIL_WIDTH)
    original_path = rendition_image_path(
        camera_root, material_id, "jet", "original", storage_index
    )
    thumbnail_path = rendition_image_path(
        camera_root, material_id, "jet", "thumbnail", storage_index
    )
    _atomic_bytes(original_path, original_body)
    _atomic_bytes(thumbnail_path, thumbnail_body)
    metadata_path = rendition_metadata_path(camera_root, material_id, "jet", storage_index)
    mapped_sources: dict[str, list[dict[str, Any]]] = {}
    for current_id, indices in source_records.items():
        records_by_index = {
            int(record["storageIndex"]): record
            for record in camera_context[current_id]["records"]
        }
        mapped_sources[current_id] = []
        for index in sorted(indices):
            record = records_by_index[index]
            checksums = record["metadata"].get("checksums", {})
            mapped_sources[current_id].append(
                {
                    "storageIndex": index,
                    "intensitySha256": str(checksums.get("steelIntensity", "")),
                    "depthSha256": str(checksums.get("steelDepth", "")),
                    "metadataSha256": _cached_sha256_file(record["metadataPath"]),
                }
            )
    metadata = {
        "schema": RENDITION_SCHEMA,
        "algorithm": JET_ALGORITHM,
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "cameraId": camera_id,
        "storageIndex": storage_index,
        "modality": "jet",
        "source": {
            "intensity": str(source_path),
            "depth": str(flow_root / "3d" / f"{storage_index}.npz"),
            "metadata": str(flow_root / "json" / f"{storage_index}.json"),
            "mappedStorageIndices": {
                current_id: sorted(indices) for current_id, indices in source_records.items()
            },
            "mappedSources": mapped_sources,
        },
        "signature": base_signature,
        "displayCrop": crop,
        "foregroundMask": "same-as-gray-per-row-envelope",
        "alignment": {
            "path": str(alignment_file),
            "sha256": _cached_sha256_file(alignment_file),
            "strictSixCamera": True,
            "commonWatermarkSeconds": round(watermark, 9),
            "flowClosed": flow_closed,
        },
        "calibration": {
            "path": str(calibration_path),
            "sha256": _cached_sha256_file(calibration_path),
            "revision": calibration.get("revision"),
            "approved": bool(calibration.get("approved")),
        },
        "rowWindow": int(config.row_window),
        "maximumFitPointsPerCamera": int(config.maximum_profile_points),
        "maximumCircleResidualMm": float(config.maximum_circle_residual_mm),
        "jetRangeMm": [-JET_RANGE_MM, JET_RANGE_MM],
        "acceptedRows": accepted_rows,
        "invalidRows": int(target_depth.shape[0] - accepted_rows),
        "circleFitP95MaximumMm": round(max(fit_p95_values), 6) if fit_p95_values else None,
        "levels": {
            "thumbnail": {"file": f"thumbnail/{storage_index}.jpg", "size": thumbnail_size},
            "original": {"file": f"original/{storage_index}.jpg", "size": original_size},
        },
    }
    _atomic_json(metadata_path, metadata)
    status = {
        "schema": RENDITION_STATUS_SCHEMA,
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "cameraId": camera_id,
        "modality": "jet",
        "levels": ["thumbnail", "original"],
        "thumbnailWidth": THUMBNAIL_WIDTH,
        "source": "3d-plus-alignment-plus-dynamic-six-camera-circle-fit",
        "displayCrop": crop,
        "foregroundMask": "same-as-gray-per-row-envelope",
        "jetRangeMm": [-JET_RANGE_MM, JET_RANGE_MM],
        "calibrationRevision": calibration.get("revision"),
    }
    _atomic_json(rendition_status_path(camera_root, material_id, "jet"), status)
    return metadata


def rendition_file(
    source_path: Path,
    modality: str,
    level: str,
    *,
    camera_id: str,
    camera_roots: dict[str, Path],
    storage_root: Path,
    calibration_path: Path,
    config: MeasurementConfig,
) -> Path:
    normalized_modality = modality.strip().lower()
    normalized_level = level.strip().lower()
    if normalized_modality not in {"gray", "jet"}:
        raise ValueError("modality must be gray or jet")
    if normalized_level not in {"thumbnail", "original"}:
        raise ValueError("level must be thumbnail or original")
    if normalized_modality == "gray":
        build_gray_rendition(source_path)
    else:
        build_jet_rendition(
            source_path,
            camera_id=camera_id,
            camera_roots=camera_roots,
            storage_root=storage_root,
            calibration_path=calibration_path,
            config=config,
        )
    return rendition_image_path(
        source_path.parents[2],
        source_path.parents[1].name,
        normalized_modality,
        normalized_level,
        int(source_path.stem),
    )


def verify_and_cleanup_legacy_renditions(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
) -> dict[str, Any]:
    """Delete obsolete hashed/aggregate images only after a closed-flow audit."""
    flow_manifest = Path(storage_root) / material_id / "flow.json"
    try:
        if _read_json(flow_manifest).get("state") != "closed":
            return {"verified": False, "reason": "flow-not-closed", "deleted": []}
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {"verified": False, "reason": "flow-manifest-unavailable", "deleted": []}
    missing: list[str] = []
    for camera_id, camera_root in sorted(camera_roots.items()):
        current_flow = capture_root(camera_root, material_id, camera_id)
        for source in _numeric_images(current_flow / "2d"):
            storage_index = int(source.stem)
            for modality in ("gray", "jet"):
                metadata_path = rendition_metadata_path(
                    camera_root, material_id, modality, storage_index
                )
                try:
                    metadata = _read_json(metadata_path)
                except (OSError, ValueError, TypeError, json.JSONDecodeError):
                    missing.append(str(metadata_path))
                    continue
                if (
                    metadata.get("schema") != RENDITION_SCHEMA
                    or metadata.get("modality") != modality
                    or int(metadata.get("storageIndex", -1)) != storage_index
                ):
                    missing.append(str(metadata_path))
                    continue
                for level in ("thumbnail", "original"):
                    image_path = rendition_image_path(
                        camera_root, material_id, modality, level, storage_index
                    )
                    try:
                        if image_path.read_bytes()[:2] != b"\xff\xd8":
                            missing.append(str(image_path))
                    except OSError:
                        missing.append(str(image_path))
    if missing:
        return {
            "verified": False,
            "reason": "two-level-renditions-incomplete",
            "missingCount": len(missing),
            "missing": missing[:50],
            "deleted": [],
        }

    targets: list[Path] = []
    for camera_id, camera_root in sorted(camera_roots.items()):
        current_flow = capture_root(camera_root, material_id, camera_id)
        gray_root = rendition_root(camera_root, material_id, "gray")
        if gray_root.is_dir():
            targets.extend(
                path
                for path in gray_root.iterdir()
                if path.is_file() and _LEGACY_CACHE_FILE.fullmatch(path.name)
            )
        targets.extend(
            path
            for path in (
                current_flow / "jet" / "surface.jpg",
                current_flow / "jet" / "surface-all.jpg",
            )
            if path.is_file()
        )
    deleted: list[str] = []
    for target in targets:
        # Every target was constructed below one explicit camera/flow root; do
        # not accept symlinks or computed paths outside that verified scope.
        if target.is_symlink():
            continue
        target.unlink()
        deleted.append(str(target))
    report = {
        "schema": "steel.capture-rendition-cleanup.v1",
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "verified": True,
        "deletedCount": len(deleted),
        "deleted": deleted,
        "rebuildableFromRaw": True,
    }
    _atomic_json(
        Path(storage_root) / material_id / "derived" / "playback" / "cache-cleanup.json",
        report,
    )
    return report
