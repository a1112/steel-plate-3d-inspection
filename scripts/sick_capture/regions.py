"""Material-level foreground crops and calibrated camera ownership regions.

Raw capture artifacts are immutable.  This module produces a small, versioned
manifest that lets preview, playback and inference use the same source-space
coordinates without treating a failed black-frame probe as a full-frame ROI.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .alignment import _atomic_json, _numeric_files, _read_json
from .paths import capture_root, region_path


REGION_MAP_SCHEMA = "steel.capture-region-map.v1"
REGION_ALGORITHM = "stable-2d-grayscale-horizontal-v2"


@dataclass(frozen=True)
class RegionConfig:
    intensity_threshold: float = 8.0
    minimum_occupancy: float = 0.005
    minimum_full_height_ratio: float = 0.80
    minimum_crop_width: int = 64
    horizontal_padding: int = 16
    lower_bound_percentile: float = 5.0
    upper_bound_percentile: float = 95.0
    angle_bin_count: int = 3600
    maximum_coverage_gap_degrees: float = 2.0

    def bounded(self) -> "RegionConfig":
        return RegionConfig(
            intensity_threshold=max(0.0, min(255.0, float(self.intensity_threshold))),
            minimum_occupancy=max(0.0001, min(0.5, float(self.minimum_occupancy))),
            minimum_full_height_ratio=max(
                0.25, min(1.0, float(self.minimum_full_height_ratio))
            ),
            minimum_crop_width=max(32, min(1024, int(self.minimum_crop_width))),
            horizontal_padding=max(0, min(256, int(self.horizontal_padding))),
            lower_bound_percentile=max(
                0.0, min(49.0, float(self.lower_bound_percentile))
            ),
            upper_bound_percentile=max(
                51.0, min(100.0, float(self.upper_bound_percentile))
            ),
            angle_bin_count=max(360, min(36000, int(self.angle_bin_count))),
            maximum_coverage_gap_degrees=max(
                0.0, min(30.0, float(self.maximum_coverage_gap_degrees))
            ),
        )


def _utc_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def region_manifest_path(storage_root: Path, material_id: str) -> Path:
    return region_path(storage_root, material_id)


def read_region_manifest(storage_root: Path, material_id: str) -> dict[str, Any] | None:
    path = region_manifest_path(storage_root, material_id)
    try:
        payload = _read_json(path)
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return payload if payload.get("schema") == REGION_MAP_SCHEMA else None


def _dominant_bounds(
    active: np.ndarray, strength: np.ndarray, *, maximum_gap: int
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


def detect_valid_sensor_roi(
    intensity: np.ndarray,
    depth: np.ndarray | None = None,
    *,
    threshold: float = 8.0,
    minimum_occupancy: float = 0.005,
    horizontal_padding: int = 16,
    vertical_padding: int = 4,
    minimum_width: int = 64,
) -> list[int] | None:
    """Return the dominant sensor ROI, or ``None`` when no steel is visible."""
    value = np.asarray(intensity)
    if value.ndim != 2 or value.size == 0:
        raise ValueError("region source must be a non-empty 2D plane")
    active = value[::2, ::2] > threshold
    if depth is not None:
        depth_value = np.asarray(depth)
        if depth_value.shape == value.shape:
            depth_active = np.isfinite(depth_value[::2, ::2]) & (
                depth_value[::2, ::2] != 0
            )
            if float(np.mean(depth_active)) >= minimum_occupancy:
                active = depth_active
    row_strength = np.mean(active, axis=1)
    column_strength = np.mean(active, axis=0)
    row_bounds = _dominant_bounds(
        row_strength >= minimum_occupancy, row_strength, maximum_gap=4
    )
    column_bounds = _dominant_bounds(
        column_strength >= minimum_occupancy, column_strength, maximum_gap=16
    )
    if row_bounds is None or column_bounds is None:
        return None
    height, width = value.shape
    top = max(0, row_bounds[0] * 2 - vertical_padding)
    bottom = min(height, row_bounds[1] * 2 + vertical_padding)
    left = max(0, column_bounds[0] * 2 - horizontal_padding)
    right = min(width, column_bounds[1] * 2 + horizontal_padding)
    if right - left < min(minimum_width, width) or bottom - top < min(8, height):
        return None
    return [left, top, right, bottom]


def stable_horizontal_roi(
    rois: list[list[int]], width: int, height: int, config: RegionConfig | None = None
) -> list[int] | None:
    settings = (config or RegionConfig()).bounded()
    full_height = [
        roi
        for roi in rois
        if len(roi) == 4
        and roi[3] - roi[1] >= height * settings.minimum_full_height_ratio
        and roi[2] - roi[0] >= settings.minimum_crop_width
        and not (roi[0] == 0 and roi[2] == width)
    ]
    if not full_height:
        return None
    left = int(math.floor(np.percentile([roi[0] for roi in full_height], settings.lower_bound_percentile)))
    right = int(math.ceil(np.percentile([roi[2] for roi in full_height], settings.upper_bound_percentile)))
    left = max(0, min(width - settings.minimum_crop_width, left))
    right = min(width, max(left + settings.minimum_crop_width, right))
    return [left, 0, right, height]


def _contiguous_intervals(mask: np.ndarray, scale: float = 1.0) -> list[list[float]]:
    indices = np.flatnonzero(mask)
    if indices.size == 0:
        return []
    groups = np.split(indices, np.flatnonzero(np.diff(indices) > 1) + 1)
    return [
        [round(float(group[0]) * scale, 6), round(float(group[-1] + 1) * scale, 6)]
        for group in groups
    ]


def _maximum_circular_gap(mask: np.ndarray) -> int:
    if np.all(mask):
        return 0
    if not np.any(mask):
        return int(mask.size)
    doubled = np.concatenate((~mask, ~mask))
    best = current = 0
    for value in doubled:
        current = current + 1 if value else 0
        best = max(best, current)
    return min(int(mask.size), best)


def _calibrated_ownership(
    measurement: dict[str, Any], camera_rows: dict[str, dict[str, Any]], settings: RegionConfig
) -> dict[str, Any]:
    calibration = measurement.get("calibration", {})
    reasons: list[str] = []
    expected = len(camera_rows)
    if not calibration.get("approved"):
        reasons.append("approved-ranger3-array-calibration-missing")
    if int(calibration.get("calibratedCameras", 0) or 0) != expected:
        reasons.append("ranger3-camera-extrinsics-incomplete")
    if not measurement.get("metricValid"):
        reasons.extend(
            str(reason) for reason in measurement.get("qualityGate", {}).get("reasons", [])
        )
    circle = measurement.get("selectedSection", {}).get("circleFit", {})
    if not circle.get("available"):
        reasons.append("calibrated-circle-fit-unavailable")
    if reasons:
        return {
            "ready": False,
            "reasons": list(dict.fromkeys(reasons)),
            "overlapPairCount": 0,
            "pairs": [],
        }

    center = np.asarray([circle["centerX"], circle["centerZ"]], dtype=np.float64)
    bins = settings.angle_bin_count
    coverage: dict[str, np.ndarray] = {}
    centers: dict[str, float] = {}
    columns_by_camera: dict[str, np.ndarray] = {}
    angle_bins_by_camera: dict[str, np.ndarray] = {}
    for camera_id, row in camera_rows.items():
        details = measurement.get("cameras", {}).get(camera_id, {})
        points = np.asarray(details.get("arrayProfile", []), dtype=np.float64)
        columns = np.asarray(details.get("validProfileColumns", []), dtype=np.int32)
        if points.ndim != 2 or points.shape[1] != 2 or points.shape[0] != columns.size:
            reasons.append(f"{camera_id}:calibrated-profile-columns-missing")
            continue
        crop = row["stableCrop"]
        keep = (columns >= crop[0]) & (columns < crop[2]) & np.all(np.isfinite(points), axis=1)
        points, columns = points[keep], columns[keep]
        if points.shape[0] < 8:
            reasons.append(f"{camera_id}:calibrated-profile-too-small")
            continue
        angles = np.mod(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]), 2 * np.pi)
        circular_center = float(np.mod(np.angle(np.mean(np.exp(1j * angles))), 2 * np.pi))
        unwrapped = circular_center + np.angle(np.exp(1j * (angles - circular_center)))
        lower, upper = float(np.min(unwrapped)), float(np.max(unwrapped))
        sample_angles = np.arange(bins, dtype=np.float64) * 2 * np.pi / bins
        sample_unwrapped = circular_center + np.angle(np.exp(1j * (sample_angles - circular_center)))
        mask = (sample_unwrapped >= lower) & (sample_unwrapped <= upper)
        coverage[camera_id] = mask
        centers[camera_id] = circular_center
        columns_by_camera[camera_id] = columns
        angle_bins_by_camera[camera_id] = np.mod(np.rint(angles * bins / (2 * np.pi)).astype(np.int32), bins)
    if reasons or len(coverage) != expected:
        return {
            "ready": False,
            "reasons": list(dict.fromkeys(reasons)),
            "overlapPairCount": 0,
            "pairs": [],
        }

    camera_ids = sorted(coverage)
    coverage_count = np.sum(np.stack([coverage[camera_id] for camera_id in camera_ids]), axis=0)
    gap_degrees = _maximum_circular_gap(coverage_count > 0) * 360.0 / bins
    if gap_degrees > settings.maximum_coverage_gap_degrees:
        return {
            "ready": False,
            "reasons": ["calibrated-circumference-coverage-gap"],
            "maximumCoverageGapDegrees": round(gap_degrees, 6),
            "overlapPairCount": 0,
            "pairs": [],
        }
    owner = np.full(bins, "", dtype=object)
    for index in np.flatnonzero(coverage_count > 0):
        angle = index * 2 * np.pi / bins
        candidates = [camera_id for camera_id in camera_ids if coverage[camera_id][index]]
        owner[index] = min(
            candidates,
            key=lambda camera_id: (
                abs(float(np.angle(np.exp(1j * (angle - centers[camera_id]))))),
                camera_id,
            ),
        )
    pairs: list[dict[str, Any]] = []
    for left_index, left_id in enumerate(camera_ids):
        for right_id in camera_ids[left_index + 1 :]:
            overlap = coverage[left_id] & coverage[right_id]
            if np.any(overlap):
                pairs.append(
                    {
                        "cameras": [left_id, right_id],
                        "angleIntervalsDeg": _contiguous_intervals(overlap, 360.0 / bins),
                        "binCount": int(np.count_nonzero(overlap)),
                    }
                )
    for camera_id, row in camera_rows.items():
        camera_owner = owner == camera_id
        camera_overlap = coverage_count > 1
        mapped_bins = angle_bins_by_camera[camera_id]
        columns = columns_by_camera[camera_id]
        owned_columns = np.zeros(int(row["sourceSize"][0]), dtype=bool)
        overlap_columns = np.zeros_like(owned_columns)
        owned_columns[columns[camera_owner[mapped_bins]]] = True
        overlap_columns[columns[camera_overlap[mapped_bins]]] = True
        # Profiles are sampled; close sampling gaps before serialising source intervals.
        step = max(1, int(np.median(np.diff(columns))) if columns.size > 1 else 1)
        for mask in (owned_columns, overlap_columns):
            active = np.flatnonzero(mask)
            for column in active:
                mask[column : min(mask.size, column + step)] = True
        row["ownedColumnIntervals"] = _contiguous_intervals(owned_columns)
        row["overlapColumnIntervals"] = _contiguous_intervals(overlap_columns)
        row["coverageAngleIntervalsDeg"] = _contiguous_intervals(
            coverage[camera_id], 360.0 / bins
        )
        row["ownedAngleIntervalsDeg"] = _contiguous_intervals(
            camera_owner, 360.0 / bins
        )
        if not row["ownedColumnIntervals"]:
            reasons.append(f"{camera_id}:owned-region-empty")
    if reasons:
        return {
            "ready": False,
            "reasons": list(dict.fromkeys(reasons)),
            "maximumCoverageGapDegrees": round(gap_degrees, 6),
            "overlapPairCount": len(pairs),
            "pairs": pairs,
        }
    return {
        "ready": True,
        "reasons": [],
        "policy": "central-angle-single-owner-candidate-center",
        "contextHaloPixels": 64,
        "angleBinCount": bins,
        "maximumCoverageGapDegrees": round(gap_degrees, 6),
        "overlapPairCount": len(pairs),
        "pairs": pairs,
    }


def build_flow_region_map(
    camera_roots: dict[str, Path],
    material_id: str,
    measurement: dict[str, Any],
    *,
    config: RegionConfig | None = None,
) -> dict[str, Any]:
    settings = (config or RegionConfig()).bounded()
    cameras: dict[str, dict[str, Any]] = {}
    reasons: list[str] = []
    for camera_id, camera_root in sorted(camera_roots.items()):
        flow_root = capture_root(camera_root, material_id, camera_id)
        intensity_files = _numeric_files(flow_root / "2d", ".png")
        available_indices = sorted(intensity_files)
        sampled_indices = (
            available_indices
            if len(available_indices) <= 64
            else [
                available_indices[int(index)]
                for index in np.linspace(0, len(available_indices) - 1, 64)
            ]
        )
        rois: list[list[int]] = []
        source_width = source_height = 0
        for storage_index in sampled_indices:
            intensity_path = intensity_files[storage_index]
            try:
                with Image.open(intensity_path) as opened:
                    intensity = np.asarray(opened.convert("L"))
                source_height, source_width = intensity.shape
                roi = detect_valid_sensor_roi(
                    intensity,
                    None,
                    threshold=settings.intensity_threshold,
                    minimum_occupancy=settings.minimum_occupancy,
                    horizontal_padding=settings.horizontal_padding,
                    minimum_width=settings.minimum_crop_width,
                )
                if roi is not None:
                    rois.append(roi)
            except (OSError, ValueError):
                continue
        stable = stable_horizontal_roi(rois, source_width, source_height, settings) if source_width else None
        state = "ready" if stable is not None else "unavailable"
        if stable is None:
            reasons.append(f"{camera_id}:stable-foreground-roi-unavailable")
        cameras[camera_id] = {
            "cameraId": camera_id,
            "state": state,
            "sourceSize": [source_width, source_height],
            "stableCrop": stable,
            "sourceOffset": {"x": stable[0], "y": 0} if stable else None,
            "displaySize": [stable[2] - stable[0], source_height] if stable else [0, 0],
            "sourceFrameCount": len(intensity_files),
            "sampledFrameCount": len(sampled_indices),
            "validFullHeightFrameCount": sum(
                1 for roi in rois if source_height and roi[3] - roi[1] >= source_height * settings.minimum_full_height_ratio
            ),
            "foregroundPixelPolicy": "2d-grayscale-only-row-envelope-compatible",
            "ownedColumnIntervals": [],
            "overlapColumnIntervals": [],
        }
    ownership = _calibrated_ownership(measurement, cameras, settings) if not reasons else {
        "ready": False,
        "reasons": reasons,
        "overlapPairCount": 0,
        "pairs": [],
    }
    all_reasons = list(dict.fromkeys([*reasons, *ownership.get("reasons", [])]))
    background_ready = not reasons and bool(cameras)
    defect_allowed = background_ready and bool(ownership.get("ready"))
    calibration = measurement.get("calibration", {})
    calibration_path = Path(str(calibration.get("path", ""))) if calibration.get("path") else None
    calibration_sha256 = ""
    if calibration_path and calibration_path.is_file():
        calibration_sha256 = hashlib.sha256(calibration_path.read_bytes()).hexdigest()
    return {
        "schema": REGION_MAP_SCHEMA,
        "algorithm": REGION_ALGORITHM,
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "state": "ready" if defect_allowed else "background-ready-overlap-blocked" if background_ready else "blocked",
        "backgroundReady": background_ready,
        "defectDetectionAllowed": defect_allowed,
        "qualityGate": {"passed": defect_allowed, "reasons": all_reasons},
        "calibration": {
            "path": str(calibration_path) if calibration_path else "",
            "revision": calibration.get("revision"),
            "approved": bool(calibration.get("approved")),
            "sha256": calibration_sha256,
        },
        "ownership": ownership,
        "cameras": cameras,
    }


def build_and_write_flow_region_map(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    measurement: dict[str, Any],
    *,
    config: RegionConfig | None = None,
) -> tuple[Path, dict[str, Any]]:
    payload = build_flow_region_map(
        camera_roots, material_id, measurement, config=config
    )
    path = region_manifest_path(storage_root, material_id)
    payload["manifestPath"] = str(path)
    _atomic_json(path, payload)
    return path, payload
