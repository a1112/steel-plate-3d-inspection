"""Persistent capture history indexes and cropped image pyramids."""

from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import os
import re
import tempfile
import time
from collections.abc import Callable, Sequence
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .regions import (
    detect_valid_sensor_roi,
    read_region_manifest,
    region_manifest_path,
)
from .paths import (
    cache_root as flow_cache_root,
    capture_root,
    playback_index_path as canonical_playback_index_path,
    playback_roi_path as canonical_playback_roi_path,
    pyramid_status_path,
)
from .storage import replace_file


PLAYBACK_INDEX_SCHEMA = "steel.capture-playback-index.v1"
PLAYBACK_CATALOG_SCHEMA = "steel.capture-playback-catalog.v1"
PYRAMID_SCHEMA = "steel.capture-image-pyramid.v1"
PYRAMID_ALGORITHM = "flow-stable-full-height-valid-region-v4"
PYRAMID_WIDTHS = (160, 320, 640, 800, 1280, 2560)

CameraRootValue = Path | Sequence[Path]

_INDEX_NUMBER_FIELD = re.compile(
    r'"(?P<key>cameraIndex|captureRound|hostUtcNs|width|height|intensityBytes)"\s*:\s*'
    r'(?P<value>-?[0-9]+(?:\.[0-9eE+\-]+)?)'
)
_INDEX_STRING_FIELD = re.compile(
    r'"(?P<key>cameraId|cameraIp)"\s*:\s*(?P<value>"(?:\\.|[^"\\])*")'
)


def _camera_root_candidates(value: CameraRootValue) -> list[Path]:
    values = [value] if isinstance(value, Path) else list(value)
    roots: list[Path] = []
    seen: set[str] = set()
    for item in values:
        root = Path(item)
        identity = str(root.resolve()).lower()
        if identity not in seen:
            seen.add(identity)
            roots.append(root)
    return roots


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
        replace_file(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    _atomic_bytes(path, body)


def _atomic_compact_json(path: Path, payload: dict[str, Any]) -> None:
    body = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    _atomic_bytes(path, body)


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON payload must be an object: {path}")
    return value


def _read_index_metadata(path: Path) -> dict[str, Any]:
    """Read only playback index scalars from large capture audit metadata.

    Capture metadata can contain a sizeable SDK audit tree.  Fully decoding it
    for every historical frame made a catalog rebuild CPU- and memory-bound.
    The fields below are top-level immutable scalars; first occurrence wins.
    """
    text = path.read_text(encoding="utf-8-sig")
    numbers: dict[str, str] = {}
    strings: dict[str, str] = {}
    for match in _INDEX_NUMBER_FIELD.finditer(text):
        numbers.setdefault(match.group("key"), match.group("value"))
    for match in _INDEX_STRING_FIELD.finditer(text):
        strings.setdefault(match.group("key"), match.group("value"))

    def integer(key: str, default: int = 0) -> int:
        try:
            return int(float(numbers.get(key, default)))
        except (TypeError, ValueError):
            return default

    def string(key: str, default: str = "") -> str:
        try:
            return str(json.loads(strings[key]))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return default

    return {
        "cameraId": string("cameraId"),
        "cameraIp": string("cameraIp"),
        "cameraIndex": integer("cameraIndex", 0),
        "captureRound": integer("captureRound", 0),
        "hostUtcNs": integer("hostUtcNs", 0),
        "width": integer("width", 0),
        "height": integer("height", 0),
        "intensityBytes": integer("intensityBytes", 0),
    }


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


def _stored_image_suffix(flow_root: Path) -> str | None:
    """Return the on-disk 2D format used by one material directory."""
    directory = flow_root / "2d"
    if not directory.is_dir():
        return None
    found: set[str] = set()
    try:
        for path in directory.iterdir():
            suffix = path.suffix.lower()
            if path.stem.isdecimal() and suffix in {".png", ".jpg", ".jpeg"}:
                found.add(suffix)
    except OSError:
        return None
    return next(
        (suffix for suffix in (".png", ".jpg", ".jpeg") if suffix in found),
        None,
    )


def _png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as stream:
        header = stream.read(24)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"invalid PNG header: {path}")
    return int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")


def _stored_image_size(path: Path) -> tuple[int, int]:
    if path.suffix.lower() == ".png":
        return _png_size(path)
    with Image.open(path) as image:
        return image.size


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
) -> list[int] | None:
    """Find the dominant bright steel region and reject isolated black-border noise."""
    return detect_valid_sensor_roi(
        image,
        threshold=threshold,
        minimum_occupancy=minimum_occupancy,
        horizontal_padding=horizontal_padding,
        vertical_padding=vertical_padding,
        minimum_width=32,
    )


def playback_roi_path(storage_root: Path, material_id: str) -> Path:
    return canonical_playback_roi_path(storage_root, material_id)


def _capture_image_identity(source_path: Path) -> tuple[str, str] | None:
    """Return strict v2 flow/camera identity only for immutable raw 2D files."""
    try:
        material_id = source_path.parents[3].name
        camera_id = source_path.parents[1].name
        if (
            not material_id.isdecimal()
            or int(material_id) <= 0
            or source_path.parent.name != "2d"
            or source_path.parents[2].name != "capture"
            or not camera_id
        ):
            return None
        return str(int(material_id)), camera_id
    except (IndexError, ValueError):
        return None


def _is_defect_review_image(source_path: Path) -> bool:
    try:
        return (
            source_path.parent.name == "review"
            and source_path.parents[1].name == "defects"
            and source_path.parents[2].name == "derived"
            and source_path.parents[3].name.isdecimal()
        )
    except IndexError:
        return False


def _flow_horizontal_roi(
    source_path: Path,
    cache_root: Path,
    image_width: int | None,
) -> tuple[list[int] | None, Path | None]:
    try:
        identity = _capture_image_identity(source_path)
        if identity is None:
            return None, None
        material_id, camera_id = identity
        storage_root = cache_root.parent.parent
        roi_path = playback_roi_path(storage_root, material_id)
        payload = _read_json(roi_path)
        box = payload.get("cameras", {}).get(camera_id)
        if isinstance(box, dict):
            box = box.get("stableCrop")
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


def source_fingerprint(
    path: Path,
    cache_root: Path | None = None,
    crop_box: list[int] | None = None,
) -> str:
    stat = path.stat()
    digest = hashlib.sha256()
    digest.update(PYRAMID_ALGORITHM.encode("ascii"))
    digest.update(str(path.resolve()).lower().encode("utf-8"))
    digest.update(stat.st_size.to_bytes(8, "little", signed=False))
    digest.update(stat.st_mtime_ns.to_bytes(8, "little", signed=False))
    if crop_box is not None:
        if len(crop_box) != 4 or any(
            isinstance(value, bool) or not isinstance(value, (int, np.integer))
            for value in crop_box
        ):
            raise ValueError("playback crop coordinates must be four integers")
        # The explicit algorithm ROI is part of the immutable browser/cache
        # identity.  Prefix the field so it can never alias a future metadata
        # component which happens to serialize to the same JSON array.
        digest.update(b"\0explicit-crop\0")
        digest.update(
            json.dumps([int(value) for value in crop_box], separators=(",", ":")).encode(
                "ascii"
            )
        )
    elif cache_root is not None:
        flow_roi, _ = _flow_horizontal_roi(path, cache_root, None)
        digest.update(json.dumps(flow_roi, separators=(",", ":")).encode("ascii"))
    return digest.hexdigest()


def pyramid_directory(cache_root: Path, fingerprint: str) -> Path:
    return cache_root / "playback-pyramid" / "v2" / fingerprint[:2] / fingerprint


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


def validate_playback_crop_box(
    crop_box: list[int],
    image_width: int,
    image_height: int,
) -> list[int]:
    """Validate an algorithm-owned crop without silently coercing coordinates."""
    if len(crop_box) != 4:
        raise ValueError("playback crop must contain four coordinates")
    if any(
        isinstance(value, bool) or not isinstance(value, (int, np.integer))
        for value in crop_box
    ):
        raise ValueError("playback crop coordinates must be integers")
    left, top, right, bottom = (int(value) for value in crop_box)
    if (
        image_width <= 0
        or image_height <= 0
        or left < 0
        or top < 0
        or right <= left
        or bottom <= top
        or right > image_width
        or bottom > image_height
    ):
        raise ValueError(
            f"playback crop is outside source image: {crop_box} "
            f"for {image_width}x{image_height}"
        )
    return [left, top, right, bottom]


def read_indexed_playback_crop(
    source_path: Path,
    cache_root: Path,
    image_width: int,
    image_height: int,
) -> list[int] | None:
    """Return the committed ready ROI for one immutable v2 capture image."""
    identity = _capture_image_identity(source_path)
    if identity is None:
        return None
    material_id, camera_id = identity
    storage_root = cache_root.parent.parent
    roi_path = playback_roi_path(storage_root, material_id)
    try:
        payload = _read_json(roi_path)
        if (
            payload.get("schema") != "steel.capture-playback-roi.v2"
            or str(payload.get("materialId", "")) != material_id
        ):
            return None
        cameras = payload.get("cameras")
        if not isinstance(cameras, dict):
            return None
        camera = cameras.get(camera_id)
        if not isinstance(camera, dict) or camera.get("state") != "ready":
            return None
        box = camera.get("stableCrop")
        if not isinstance(box, list):
            return None
        return validate_playback_crop_box(box, image_width, image_height)
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def build_image_pyramid(
    source_path: Path,
    cache_root: Path,
    requested_crop_box: list[int] | None = None,
) -> tuple[Path, dict[str, Any]]:
    fingerprint = source_fingerprint(source_path, cache_root, requested_crop_box)
    directory = pyramid_directory(cache_root, fingerprint)
    manifest_path = directory / "manifest.json"
    existing = read_image_pyramid(cache_root, fingerprint)
    if existing is not None:
        return existing

    with Image.open(source_path) as opened:
        grayscale = opened.convert("L")
    try:
        original_width, original_height = grayscale.size
        if requested_crop_box is not None:
            # The online inspection request is already bound to the ROI stored
            # in the indexed algorithm result.  Do not rerun frame thresholding
            # here: doing so both wastes CPU and risks replacing that immutable
            # result with a different frame-local crop.
            crop_box = validate_playback_crop_box(
                requested_crop_box,
                original_width,
                original_height,
            )
            detected_box = None
            flow_roi = None
            flow_roi_path = None
            crop_source = "explicit-algorithm-roi"
        else:
            plane = np.asarray(grayscale)
            # Defect review crops are already the final >=64-pixel algorithm
            # artifact.  Cropping them a second time in the playback cache can
            # remove context and violate the small-image contract.
            detected_box = (
                None
                if _is_defect_review_image(source_path)
                else detect_valid_grayscale_roi(plane)
            )
            flow_roi, flow_roi_path = _flow_horizontal_roi(
                source_path, cache_root, original_width
            )
            crop_box = list(detected_box or [0, 0, original_width, original_height])
            crop_source = "frame-detected-roi" if detected_box is not None else "full-source"
            if flow_roi is not None:
                # A material-level region is deliberately stable in sensor space:
                # crop only the black horizontal margins and retain every line of
                # the longitudinal scan.  Frame-local vertical threshold bounds
                # can otherwise cut the head/tail and make online lanes jump.
                crop_box = [flow_roi[0], 0, flow_roi[2], original_height]
                crop_source = "flow-stable-horizontal-roi"
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
            "cropSource": crop_source,
            "requestedCrop": crop_box if requested_crop_box is not None else None,
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
    return canonical_playback_index_path(storage_root, material_id)


def playback_catalog_path(storage_root: Path) -> Path:
    return storage_root / "catalog.json"


def flow_pyramid_cache_status_path(storage_root: Path, material_id: str) -> Path:
    return pyramid_status_path(storage_root, material_id)


def write_flow_pyramid_cache_status(
    storage_root: Path,
    payload: dict[str, Any],
) -> Path:
    path = flow_pyramid_cache_status_path(
        storage_root, str(payload.get("materialId", "unknown"))
    )
    _atomic_compact_json(path, payload)
    return path


def build_and_write_playback_index(
    camera_roots: dict[str, CameraRootValue],
    storage_root: Path,
    material_id: str,
    *,
    update_catalog: bool = True,
    camera_scan_workers: int = 6,
    validate_image_files: bool = True,
    metadata_mode: str = "scalars",
) -> tuple[Path, dict[str, Any]]:
    if metadata_mode not in {"scalars", "filesystem"}:
        raise ValueError(f"unsupported playback metadata mode: {metadata_mode}")

    def scan_camera(
        item: tuple[int, tuple[str, CameraRootValue]],
    ) -> list[tuple[int, int, dict[str, Any]]]:
        fallback_index, (camera_id, root_value) = item
        result: list[tuple[int, int, dict[str, Any]]] = []
        roots = _camera_root_candidates(root_value)
        seen_storage_indices: set[int] = set()
        for root_index, camera_root in enumerate(roots):
            flow_root = capture_root(camera_root, material_id, camera_id)
            image_suffix = _stored_image_suffix(flow_root)
            if image_suffix is None:
                continue
            filesystem_host_ns = 0
            filesystem_size = (0, 0)
            if metadata_mode == "filesystem":
                try:
                    filesystem_host_ns = (flow_root / "json").stat().st_mtime_ns
                    first_image = next(
                        path
                        for _, path in _numeric_files(flow_root / "2d", image_suffix)
                    )
                    filesystem_size = _stored_image_size(first_image)
                except (OSError, StopIteration, ValueError):
                    continue
            for storage_index, metadata_path in _numeric_files(
                flow_root / "json", ".json"
            ):
                if storage_index in seen_storage_indices:
                    continue
                intensity_path = flow_root / "2d" / f"{storage_index}{image_suffix}"
                if metadata_mode == "filesystem":
                    metadata: dict[str, Any] = {
                        "cameraId": camera_id,
                        "cameraIp": "",
                        "captureRound": storage_index + 1,
                        "hostUtcNs": filesystem_host_ns + storage_index,
                        "width": filesystem_size[0],
                        "height": filesystem_size[1],
                        "intensityBytes": 0,
                    }
                else:
                    try:
                        metadata = _read_index_metadata(metadata_path)
                    except (OSError, ValueError, json.JSONDecodeError):
                        continue
                stat = None
                if validate_image_files:
                    try:
                        if intensity_path.is_symlink():
                            continue
                        stat = intensity_path.stat()
                        if not intensity_path.is_file():
                            continue
                    except OSError:
                        continue
                capture_round = int(
                    metadata.get("captureRound", storage_index + 1)
                    or storage_index + 1
                )
                host_ns = int(metadata.get("hostUtcNs", 0) or 0)
                if host_ns <= 0:
                    try:
                        host_ns = (
                            stat.st_mtime_ns
                            if stat is not None
                            else metadata_path.stat().st_mtime_ns
                        )
                    except OSError:
                        continue
                width = int(metadata.get("width", 0) or 0)
                height = int(metadata.get("height", 0) or 0)
                if width <= 0 or height <= 0:
                    try:
                        if intensity_path.suffix.lower() == ".png":
                            width, height = _png_size(intensity_path)
                        else:
                            with Image.open(intensity_path) as image:
                                width, height = image.size
                    except (OSError, ValueError):
                        continue
                numeric_index = "".join(
                    character for character in camera_id if character.isdigit()
                )
                camera_payload = {
                    "cameraId": str(
                        metadata.get("cameraId", camera_id) or camera_id
                    ),
                    "cameraIndex": (
                        int(numeric_index) if numeric_index else fallback_index
                    ),
                    "ip": str(metadata.get("cameraIp", "")),
                    "artifactRef": (
                        f"{material_id}/capture/{camera_id}/2d/"
                        f"{storage_index}{image_suffix}"
                        if root_index == 0
                        else str(intensity_path.resolve())
                    ),
                    "storageIndex": storage_index,
                    "captureRound": capture_round,
                    "width": width,
                    "height": height,
                    "bytes": (
                        stat.st_size
                        if stat is not None
                        else int(metadata.get("intensityBytes", 0) or 0)
                    ),
                    "storedAt": _utc_text(host_ns),
                }
                result.append((capture_round, host_ns, camera_payload))
                seen_storage_indices.add(storage_index)
        return result

    camera_items = list(enumerate(sorted(camera_roots.items()), start=1))
    grouped: dict[int, dict[str, Any]] = {}
    with ThreadPoolExecutor(
        max_workers=max(1, min(camera_scan_workers, len(camera_items))),
        thread_name_prefix="history-camera-scan",
    ) as executor:
        for camera_entries in executor.map(scan_camera, camera_items):
            for capture_round, host_ns, camera in camera_entries:
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
                frame["cameras"].append(camera)

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

    from .measurement import measurement_manifest_path

    measurement_path = measurement_manifest_path(storage_root, material_id)
    try:
        region_map = read_region_manifest(storage_root, material_id)
        measurement = _read_json(measurement_path)
        source_boxes = (
            {
                camera_id: row.get("stableCrop")
                for camera_id, row in region_map.get("cameras", {}).items()
                if isinstance(row, dict)
            }
            if region_map is not None
            else measurement.get("twoDimensionalCrop", {})
        )
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
                    camera["sourceSize"] = [
                        int(camera.get("width", 0)),
                        int(camera.get("height", 0)),
                    ]
                    camera["displaySize"] = [
                        box[2] - box[0],
                        int(camera.get("height", 0)),
                    ]
                    camera["sourceOffset"] = {"x": box[0], "y": 0}
                    if region_map is not None:
                        region_row = region_map.get("cameras", {}).get(
                            str(camera.get("cameraId", "")), {}
                        )
                        camera["regionState"] = region_row.get("state")
                        camera["calibrationRevision"] = region_map.get(
                            "calibration", {}
                        ).get("revision")
            _atomic_json(
                playback_roi_path(storage_root, material_id),
                {
                    "schema": "steel.capture-playback-roi.v2",
                    "generatedAt": _utc_text(),
                    "materialId": material_id,
                    "measurementPath": str(measurement_path),
                    "regionManifestPath": str(region_manifest_path(storage_root, material_id)) if region_map else "",
                    "cameras": {
                        camera_id: (
                            region_map.get("cameras", {}).get(camera_id)
                            if region_map is not None
                            else box
                        )
                        for camera_id, box in camera_boxes.items()
                    },
                },
            )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    _atomic_compact_json(path, payload)

    if not update_catalog:
        return path, payload

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
            "indexFile": path.relative_to(storage_root).as_posix(),
            "frameCount": len(frames),
            "firstHostUtcNs": first_ns,
            "lastHostUtcNs": last_ns,
        }
    )
    entries.sort(key=lambda row: int(row.get("lastHostUtcNs", 0)), reverse=True)
    _atomic_compact_json(
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


def rebuild_playback_history(
    camera_roots: dict[str, CameraRootValue],
    storage_root: Path,
    *,
    max_workers: int = 6,
    progress: Callable[[int, int, int], None] | None = None,
) -> dict[str, Any]:
    """Rebuild every numeric material index and publish one atomic catalog.

    Derived indexes are always regenerated from committed raw metadata.  The
    v2 layout intentionally has no compatibility/normalization branch for old
    history files: rebuilding means rebuilding.
    """
    material_ids: set[str] = set()
    for value in camera_roots.values():
        for root in _camera_root_candidates(value):
            try:
                material_ids.update(
                    path.name
                    for path in root.iterdir()
                    if path.is_dir() and path.name.isdecimal()
                )
            except OSError:
                continue

    entries: list[dict[str, Any]] = []
    frame_count = 0
    reused_count = 0
    rebuilt_count = 0
    ordered_material_ids = sorted(material_ids, key=int)
    completed = 0
    worker_count = max(1, min(max_workers, len(ordered_material_ids) or 1))

    def record(material_id: str, path: Path, payload: dict[str, Any]) -> None:
        nonlocal frame_count
        count = int(payload.get("frameCount", 0))
        if count <= 0:
            return
        frame_count += count
        entries.append(
            {
                "materialId": material_id,
                "indexFile": path.relative_to(storage_root).as_posix(),
                "frameCount": count,
                "firstHostUtcNs": int(payload.get("firstHostUtcNs", 0)),
                "lastHostUtcNs": int(payload.get("lastHostUtcNs", 0)),
            }
        )

    def rebuild_one(
        material_id: str,
    ) -> tuple[str, Path, dict[str, Any]]:
        path, payload = build_and_write_playback_index(
            camera_roots,
            storage_root,
            material_id,
            update_catalog=False,
            camera_scan_workers=1,
            validate_image_files=False,
            metadata_mode="filesystem",
        )
        return material_id, path, payload

    with ThreadPoolExecutor(
        max_workers=worker_count,
        thread_name_prefix="history-flow-rebuild",
    ) as executor:
        source = iter(ordered_material_ids)
        pending = {
            executor.submit(rebuild_one, material_id)
            for material_id in (
                next(source, None) for _ in range(worker_count)
            )
            if material_id is not None
        }
        while pending:
            done, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                material_id, path, payload = future.result()
                if int(payload.get("frameCount", 0)) > 0:
                    rebuilt_count += 1
                else:
                    path.unlink(missing_ok=True)
                completed += 1
                record(material_id, path, payload)
                if progress is not None:
                    progress(completed, len(ordered_material_ids), rebuilt_count)
                next_material = next(source, None)
                if next_material is not None:
                    pending.add(executor.submit(rebuild_one, next_material))

    entries.sort(key=lambda row: int(row.get("lastHostUtcNs", 0)), reverse=True)
    catalog = {
        "schema": PLAYBACK_CATALOG_SCHEMA,
        "generatedAt": _utc_text(),
        "materialCount": len(entries),
        "frameCount": frame_count,
        "materials": entries,
    }
    path = playback_catalog_path(storage_root)
    _atomic_compact_json(path, catalog)
    return {
        "catalogPath": str(path),
        "materialCount": len(entries),
        "frameCount": frame_count,
        "reusedIndexCount": reused_count,
        "rebuiltIndexCount": rebuilt_count,
        "workerCount": worker_count,
    }


def warm_flow_image_pyramids(
    camera_roots: dict[str, CameraRootValue],
    storage_root: Path,
    index: dict[str, Any],
) -> dict[str, Any]:
    """Persist every pyramid level for a completed flow in a low-priority worker."""
    started = time.perf_counter()
    material_id = str(index.get("materialId", ""))
    cache_root = flow_cache_root(storage_root, material_id)
    cached = 0
    failures: list[dict[str, str]] = []
    for frame in index.get("frames", []):
        for camera in frame.get("cameras", []):
            camera_id = str(camera.get("cameraId", ""))
            artifact = str(camera.get("artifactRef", ""))
            parts = Path(artifact).parts
            root_value = camera_roots.get(camera_id)
            if root_value is None or len(parts) < 2:
                continue
            if Path(artifact).is_absolute():
                source = Path(artifact)
            else:
                source = next(
                    (
                        root.joinpath(*parts)
                        for root in _camera_root_candidates(root_value)
                        if root.joinpath(*parts).is_file()
                    ),
                    _camera_root_candidates(root_value)[0].joinpath(*parts),
                )
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
        index_path = storage_root / str(entry.get("indexFile", ""))
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
