"""Synchronized six-camera surface fitting and JET residual visualization.

The longitudinal axis remains display-only until a speed/encoder source is
connected.  Cross-section coordinates and radial residuals are real metric
values from the approved array calibration.
"""

from __future__ import annotations

import datetime as dt
import math
import uuid
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .alignment import _atomic_json
from .measurement import (
    MeasurementConfig,
    _load_calibration,
    _matrix_for,
    _profile,
    _transform_profile,
    build_fixed_angle_diameter_curves,
    robust_circle_fit,
)
from .paths import capture_root, surface_jet_path, surface_path
from .storage import replace_file


SURFACE_SCHEMA = "steel.ranger3-flow-surface.v1"
CAMERA_TILE_SCHEMA = "steel.ranger3-camera-jet-tiles.v1"


def _utc_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def jet_rgb(value: float) -> tuple[int, int, int]:
    """Return the conventional blue-to-red JET colour for a value in [0, 1]."""
    value = max(0.0, min(1.0, float(value)))
    channels = (
        1.5 - abs(4.0 * value - 3.0),
        1.5 - abs(4.0 * value - 2.0),
        1.5 - abs(4.0 * value - 1.0),
    )
    return tuple(int(round(255.0 * max(0.0, min(1.0, item)))) for item in channels)


def _selected_anchor_indices(anchor_count: int, maximum_sections: int) -> list[int]:
    if anchor_count <= 0:
        return []
    count = min(anchor_count, max(1, int(maximum_sections)))
    return sorted(set(int(value) for value in np.linspace(0, anchor_count - 1, count)))


def _binned_section(
    points: np.ndarray,
    fit: dict[str, Any],
    angular_bins: int,
) -> tuple[np.ndarray, np.ndarray]:
    values = np.full(angular_bins, np.nan, dtype=np.float64)
    counts = np.zeros(angular_bins, dtype=np.int32)
    if not fit.get("available") or not points.size:
        return values, counts
    center_x = float(fit["centerX"])
    center_z = float(fit["centerZ"])
    radius = float(fit["radiusMm"])
    offsets = points - np.asarray([center_x, center_z], dtype=np.float64)
    angles = np.mod(np.arctan2(offsets[:, 1], offsets[:, 0]), 2.0 * math.pi)
    bins = np.floor(angles * angular_bins / (2.0 * math.pi)).astype(np.int32)
    bins = np.clip(bins, 0, angular_bins - 1)
    residuals = np.linalg.norm(offsets, axis=1) - radius
    for index in np.unique(bins):
        selected = residuals[bins == index]
        selected = selected[np.isfinite(selected)]
        if selected.size:
            values[index] = float(np.median(selected))
            counts[index] = int(selected.size)
    return values, counts


def _finite_float(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _anchor_mapping_quality(
    mapping: dict[str, Any], maximum_residual_ms: float
) -> tuple[bool, float | None, list[str]]:
    """Validate one camera row without invalidating unrelated anchors.

    ``timeResidualMs`` is the distance to the beginning of a Ranger3 block.
    Once a scan row has been selected the relevant error is
    ``interpolationResidualMs``.  Older fixtures do not contain that field, so
    a present, unclipped row remains usable when neither residual is available.
    """
    reasons: list[str] = []
    if not mapping.get("available"):
        reasons.append("sync-row-unavailable")
    if mapping.get("rowClipped"):
        reasons.append("sync-row-clipped")
    interpolation = _finite_float(mapping.get("interpolationResidualMs"))
    if interpolation is None:
        interpolation = _finite_float(mapping.get("timeResidualMs"))
    if interpolation is not None and abs(interpolation) > maximum_residual_ms:
        reasons.append("sync-row-residual-out-of-tolerance")
    return not reasons, interpolation, reasons


def _calibration_fixed_angle_deg(matrix: np.ndarray) -> float:
    """Return the calibrated local +Z direction in the array X/Z plane."""
    return round(
        float(np.mod(np.degrees(np.arctan2(matrix[2, 2], matrix[0, 2])), 360.0)),
        6,
    )


def _source_column_samples(
    points: np.ndarray,
    source_columns: np.ndarray,
    fit: dict[str, Any],
) -> tuple[dict[int, float], dict[int, float], dict[int, int]]:
    """Map fitted radial residuals back to their original 2D sensor columns."""
    residual_by_column: dict[int, list[float]] = {}
    angle_by_column: dict[int, list[float]] = {}
    if not fit.get("available") or points.shape[0] != source_columns.size:
        return {}, {}, {}
    center = np.asarray(
        [float(fit["centerX"]), float(fit["centerZ"])], dtype=np.float64
    )
    offsets = points - center
    radii = np.linalg.norm(offsets, axis=1)
    residuals = radii - float(fit["radiusMm"])
    angles = np.mod(np.degrees(np.arctan2(offsets[:, 1], offsets[:, 0])), 360.0)
    for column, residual, angle in zip(
        source_columns.astype(int), residuals, angles, strict=True
    ):
        if not math.isfinite(float(residual)) or not math.isfinite(float(angle)):
            continue
        residual_by_column.setdefault(int(column), []).append(float(residual))
        angle_by_column.setdefault(int(column), []).append(float(angle))
    residual_medians = {
        column: float(np.median(values)) for column, values in residual_by_column.items()
    }
    # Use a circular mean so samples around 0/360 degrees do not average to 180.
    angle_means = {
        column: float(
            np.mod(
                np.degrees(
                    np.angle(np.mean(np.exp(1j * np.radians(values))))
                ),
                360.0,
            )
        )
        for column, values in angle_by_column.items()
    }
    sample_counts = {column: len(values) for column, values in residual_by_column.items()}
    return residual_medians, angle_means, sample_counts


def _camera_overlap_consistency(
    profiles: dict[str, np.ndarray],
    fit: dict[str, Any],
    angular_bins: int,
    maximum_p95_difference_mm: float,
) -> dict[str, Any]:
    """Measure calibration stitching error where camera angular coverage overlaps."""
    camera_grids = {
        camera_id: _binned_section(points, fit, angular_bins)[0]
        for camera_id, points in profiles.items()
    }
    pairs: list[dict[str, Any]] = []
    all_differences: list[float] = []
    camera_ids = sorted(camera_grids)
    for left_index, left_id in enumerate(camera_ids):
        left = camera_grids[left_id]
        for right_id in camera_ids[left_index + 1 :]:
            right = camera_grids[right_id]
            overlap = np.isfinite(left) & np.isfinite(right)
            if not np.any(overlap):
                continue
            differences = np.abs(left[overlap] - right[overlap])
            differences = differences[np.isfinite(differences)]
            if not differences.size:
                continue
            all_differences.extend(differences.astype(float).tolist())
            pairs.append(
                {
                    "cameras": [left_id, right_id],
                    "sampleCount": int(differences.size),
                    "p95AbsRadialDifferenceMm": round(
                        float(np.percentile(differences, 95)), 6
                    ),
                    "maximumAbsRadialDifferenceMm": round(
                        float(np.max(differences)), 6
                    ),
                    "overlapAngularBinIndices": np.flatnonzero(overlap).astype(int).tolist(),
                }
            )
    values = np.asarray(all_differences, dtype=np.float64)
    p95 = float(np.percentile(values, 95)) if values.size else None
    maximum = float(np.max(values)) if values.size else None
    overlap_required = len(profiles) > 1
    reasons: list[str] = []
    if overlap_required and not values.size:
        reasons.append("calibrated-camera-overlap-unavailable")
    if p95 is not None and p95 > maximum_p95_difference_mm:
        reasons.append("calibrated-camera-overlap-out-of-tolerance")
    maximum_advisory_mm = maximum_p95_difference_mm * 4.0
    warnings: list[str] = []
    if maximum is not None and maximum > maximum_advisory_mm:
        warnings.append("calibrated-camera-overlap-maximum-outlier")
    return {
        "available": bool(values.size),
        "metricValid": not reasons,
        "qualityGate": {"passed": not reasons, "reasons": reasons},
        "thresholdP95Mm": round(maximum_p95_difference_mm, 6),
        "maximumAdvisoryThresholdMm": round(maximum_advisory_mm, 6),
        "warnings": warnings,
        "pairCount": len(pairs),
        "sampleCount": int(values.size),
        "p95AbsRadialDifferenceMm": round(p95, 6) if p95 is not None else None,
        "maximumAbsRadialDifferenceMm": (
            round(maximum, 6) if maximum is not None else None
        ),
        "pairs": pairs,
    }


def _stable_tile_crop(
    camera_id: str,
    samples: list[dict[str, Any]],
    region_map: dict[str, Any] | None,
) -> tuple[list[int], list[int]] | None:
    region_camera = (
        region_map.get("cameras", {}).get(camera_id, {})
        if isinstance(region_map, dict)
        else {}
    )
    stable = region_camera.get("stableCrop")
    source_shape = region_camera.get("sourceSize")
    if (
        isinstance(stable, list)
        and len(stable) == 4
        and isinstance(source_shape, list)
        and len(source_shape) == 2
        and int(source_shape[0]) > 0
        and int(source_shape[1]) > 0
    ):
        return [int(value) for value in stable], [int(value) for value in source_shape]
    usable = [row for row in samples if row.get("available")]
    if not usable:
        return None
    shapes = [row.get("sourceShape") for row in usable]
    crops = [row.get("frameCropBox") for row in usable]
    shapes = [row for row in shapes if isinstance(row, list) and len(row) == 2]
    crops = [row for row in crops if isinstance(row, list) and len(row) == 4]
    if not shapes or not crops:
        return None
    # Crop bounds from the median section suppress transient head/tail partial
    # foreground while preserving the same source coordinate system as 2D.
    width = int(np.median([int(row[0]) for row in shapes]))
    height = int(np.median([int(row[1]) for row in shapes]))
    left = max(0, min(width - 1, int(np.median([int(row[0]) for row in crops]))))
    right = min(width, max(left + 1, int(np.median([int(row[2]) for row in crops]))))
    return [left, 0, right, height], [width, height]


def _camera_tile_payload(
    camera_id: str,
    samples: list[dict[str, Any]],
    *,
    region_map: dict[str, Any] | None,
    fixed_angle_deg: float | None,
    display_range_mm: float,
) -> tuple[dict[str, Any], np.ndarray]:
    stable = _stable_tile_crop(camera_id, samples, region_map)
    rows = len(samples)
    if stable is None:
        return {
            "cameraId": camera_id,
            "state": "unavailable",
            "fixedAngleDeg": fixed_angle_deg,
            "rows": rows,
            "columns": 0,
            "reason": "stable-2d-crop-unavailable",
        }, np.empty((rows, 0), dtype=np.float64)
    crop_box, source_shape = stable
    left, _top, right, _bottom = crop_box
    columns = max(0, right - left)
    residual_grid = np.full((rows, columns), np.nan, dtype=np.float64)
    count_grid = np.zeros((rows, columns), dtype=np.int32)
    angle_rows: list[list[list[float]]] = [
        [[] for _ in range(columns)] for _ in range(rows)
    ]
    row_anchors: list[dict[str, Any]] = []
    elapsed_values = [
        float(row.get("elapsedFromHeadMs", 0.0) or 0.0) for row in samples
    ]
    start = min(elapsed_values, default=0.0)
    span = max(elapsed_values, default=start) - start
    for row_index, sample in enumerate(samples):
        accepted = bool(sample.get("acceptedForSurface"))
        for source_column, value in sample.get("residualByColumn", {}).items():
            local_column = int(source_column) - left
            if accepted and 0 <= local_column < columns:
                residual_grid[row_index, local_column] = float(value)
                count_grid[row_index, local_column] = int(
                    sample.get("sampleCountByColumn", {}).get(source_column, 1)
                )
                angle = sample.get("angleByColumn", {}).get(source_column)
                if angle is not None:
                    angle_rows[row_index][local_column].append(float(angle))
        elapsed = float(sample.get("elapsedFromHeadMs", 0.0) or 0.0)
        source_row = sample.get("sourceRow")
        storage_index = sample.get("storageIndex")
        source_height = int(source_shape[1])
        row_anchors.append(
            {
                "row": row_index,
                "anchorOrdinal": sample.get("anchorOrdinal"),
                "elapsedFromHeadMs": sample.get("elapsedFromHeadMs"),
                "positionRatio": round((elapsed - start) / span if span > 0 else 0.0, 8),
                "storageIndex": storage_index,
                "sourceRow": source_row,
                "sourceGlobalRow": (
                    int(storage_index) * source_height + int(source_row)
                    if storage_index is not None and source_row is not None
                    else None
                ),
                "timeResidualMs": sample.get("timeResidualMs"),
                "interpolationResidualMs": sample.get("interpolationResidualMs"),
                "mappingMetricValid": bool(sample.get("mappingMetricValid")),
                "acceptedForSurface": accepted,
                "cropBox": sample.get("frameCropBox"),
            }
        )
    angle_by_column: list[float | None] = []
    for local_column in range(columns):
        values = [
            value
            for row in range(rows)
            for value in angle_rows[row][local_column]
        ]
        angle_by_column.append(
            round(
                float(
                    np.mod(
                        np.degrees(np.angle(np.mean(np.exp(1j * np.radians(values))))),
                        360.0,
                    )
                ),
                6,
            )
            if values
            else None
        )
    finite = np.isfinite(residual_grid)
    region_camera = (
        region_map.get("cameras", {}).get(camera_id, {})
        if isinstance(region_map, dict)
        else {}
    )
    payload = {
        "cameraId": camera_id,
        "state": "ready" if np.any(finite) else "unavailable",
        "fixedAngleDeg": fixed_angle_deg,
        "sourceShape": source_shape,
        "cropBox": crop_box,
        "sourceOffset": {"x": left, "y": crop_box[1]},
        "rows": rows,
        "columns": columns,
        "coordinateLayout": "row-major-head-to-tail/source-crop-left-to-right",
        "residualUnit": "mm",
        "residuals": [
            round(float(value), 6) if math.isfinite(float(value)) else None
            for value in residual_grid.ravel()
        ],
        "validMask": finite.astype(np.uint8).ravel().astype(int).tolist(),
        "sampleCounts": count_grid.ravel().astype(int).tolist(),
        "angleDegByColumn": angle_by_column,
        "rowAnchors": row_anchors,
        "coverage": {
            "validSampleCount": int(np.count_nonzero(finite)),
            "validRatio": round(float(np.mean(finite)) if finite.size else 0.0, 8),
            "coverageAngleIntervalsDeg": region_camera.get(
                "coverageAngleIntervalsDeg", []
            ),
            "ownedAngleIntervalsDeg": region_camera.get("ownedAngleIntervalsDeg", []),
            "ownedColumnIntervals": region_camera.get("ownedColumnIntervals", []),
            "overlapColumnIntervals": region_camera.get("overlapColumnIntervals", []),
        },
        "jet": {
            "palette": "JET",
            "minimumMm": round(-display_range_mm, 6),
            "maximumMm": round(display_range_mm, 6),
            "zeroMm": 0.0,
            "missingColor": "#07121b",
            "imagePath": "",
        },
        "defectMapping": {
            "coordinateSpace": "source-image-pixels",
            "sourceCropBox": crop_box,
            "cameraRequired": camera_id,
            "tileX": "sourceX-cropBox.left",
            "tileXRatio": "(sourceX-cropBox.left)/cropBox.width",
            "tileRow": "nearest rowAnchors.sourceGlobalRow to storageIndex*sourceHeight+sourceY",
            "longitudinalCoordinate": "head-relative-time-nearest-anchor",
            "angleLookup": "angleDegByColumn[tileX]",
        },
    }
    return payload, residual_grid


def _write_jet_image(path: Path, residuals: np.ndarray, display_range_mm: float) -> None:
    height, width = residuals.shape
    rgb = np.zeros((height, width, 3), dtype=np.uint8)
    rgb[:, :] = np.asarray([7, 18, 27], dtype=np.uint8)
    finite = np.isfinite(residuals)
    normalized = np.clip(0.5 + residuals / (2.0 * display_range_mm), 0.0, 1.0)
    for row, column in zip(*np.nonzero(finite)):
        rgb[row, column] = jet_rgb(float(normalized[row, column]))
    # Preserve each synchronized section as a visible band without inventing
    # longitudinal samples between anchors.
    image = Image.fromarray(rgb, mode="RGB").resize(
        (max(720, width * 4), max(96, height * 12)),
        Image.Resampling.NEAREST,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        image.save(temporary, format="PNG", optimize=False)
        replace_file(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def build_flow_surface(
    camera_roots: dict[str, Path],
    material_id: str,
    alignment: dict[str, Any],
    *,
    calibration_path: Path | None,
    config: MeasurementConfig | None = None,
    angular_bins: int = 180,
    region_map: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], np.ndarray]:
    settings = (config or MeasurementConfig()).bounded()
    angular_bins = max(72, min(720, int(angular_bins)))
    calibration = _load_calibration(calibration_path)
    approved = bool(calibration.get("approved", False))
    geometry_synchronized = bool(
        alignment.get("quality", {}).get(
            "geometrySynchronized", alignment.get("quality", {}).get("synchronized")
        )
    )
    anchors = list(alignment.get("softSyncAnchors", []))
    selected_indices = _selected_anchor_indices(len(anchors), settings.maximum_sections)
    sections: list[dict[str, Any]] = []
    grids: list[np.ndarray] = []
    counts: list[np.ndarray] = []
    maximum_sync_residual_ms = float(
        alignment.get("settings", {}).get("maximumAnchorResidualMs", 40.0) or 40.0
    )
    camera_samples: dict[str, list[dict[str, Any]]] = {
        camera_id: [] for camera_id in sorted(camera_roots)
    }
    camera_fixed_angles: dict[str, float | None] = {
        camera_id: None for camera_id in sorted(camera_roots)
    }

    for anchor_index in selected_indices:
        anchor = anchors[anchor_index]
        transformed_profiles: dict[str, np.ndarray] = {}
        source_columns_by_camera: dict[str, np.ndarray] = {}
        profile_details_by_camera: dict[str, dict[str, Any]] = {}
        camera_details: dict[str, Any] = {}
        complete = True
        mapping_metric_complete = True
        for camera_id, camera_root in sorted(camera_roots.items()):
            mapping = anchor.get("cameras", {}).get(camera_id, {})
            mapping_valid, interpolation_residual, mapping_reasons = (
                _anchor_mapping_quality(mapping, maximum_sync_residual_ms)
            )
            if not mapping_valid:
                complete = False
                mapping_metric_complete = False
                camera_details[camera_id] = {
                    "available": False,
                    "mappingMetricValid": False,
                    "qualityReasons": mapping_reasons,
                    "reason": mapping_reasons[0],
                }
                continue
            try:
                profile, details = _profile(
                    capture_root(camera_root, material_id, camera_id),
                    int(mapping["storageIndex"]),
                    mapping.get("rowIndex"),
                    settings,
                )
                matrix = _matrix_for(calibration, camera_id, details["serialNumber"])
                if matrix is None:
                    raise ValueError("camera-calibration-unavailable")
                source_columns = np.asarray(
                    details.get("validProfileColumns", []), dtype=np.int32
                )
                region_camera = (
                    region_map.get("cameras", {}).get(camera_id, {})
                    if isinstance(region_map, dict)
                    else {}
                )
                stable_crop = region_camera.get("stableCrop")
                if isinstance(stable_crop, list) and len(stable_crop) == 4:
                    keep = (source_columns >= int(stable_crop[0])) & (
                        source_columns < int(stable_crop[2])
                    )
                    profile = profile[keep]
                    source_columns = source_columns[keep]
                transformed = _transform_profile(profile, matrix)
                transformed_profiles[camera_id] = transformed
                source_columns_by_camera[camera_id] = source_columns
                profile_details_by_camera[camera_id] = details
                camera_fixed_angles[camera_id] = _calibration_fixed_angle_deg(matrix)
                camera_details[camera_id] = {
                    "available": True,
                    "storageIndex": int(mapping["storageIndex"]),
                    "rowIndex": int(details["rowIndex"]),
                    "timeResidualMs": mapping.get("timeResidualMs"),
                    "interpolationResidualMs": interpolation_residual,
                    "mappingMetricValid": True,
                    "cropBox": details.get("cropBox"),
                    "sourceShape": [int(details["shape"][1]), int(details["shape"][0])],
                    "sourceCoordinateOffset": details.get("sourceCoordinateOffset"),
                    "validProfileColumns": source_columns.astype(int).tolist(),
                    "pointCount": int(transformed.shape[0]),
                    "fixedAngleDeg": camera_fixed_angles[camera_id],
                }
            except Exception as error:
                complete = False
                mapping_metric_complete = False
                camera_details[camera_id] = {"available": False, "reason": str(error)}
        points = (
            np.vstack(list(transformed_profiles.values()))
            if transformed_profiles
            else np.empty((0, 2))
        )
        fit = robust_circle_fit(points, settings.minimum_circle_points)
        grid, count = _binned_section(points, fit, angular_bins)
        observed_bins = int(np.count_nonzero(np.isfinite(grid)))
        overlap_consistency = _camera_overlap_consistency(
            transformed_profiles,
            fit,
            angular_bins,
            settings.maximum_circle_residual_mm,
        )
        accepted_for_surface = bool(
            complete
            and len(transformed_profiles) == len(camera_roots)
            and mapping_metric_complete
            and fit.get("available")
            and observed_bins >= math.ceil(angular_bins * 0.80)
            and float(fit.get("p95AbsResidualMm", math.inf))
            <= settings.maximum_circle_residual_mm
            and overlap_consistency.get("metricValid")
        )
        if not accepted_for_surface:
            grid[:] = np.nan
        grids.append(grid)
        counts.append(count)
        section_reasons: list[str] = []
        if not complete or len(transformed_profiles) != len(camera_roots):
            section_reasons.append("cross-section-mapping-incomplete")
        if not mapping_metric_complete:
            section_reasons.append("cross-section-time-residual-out-of-tolerance")
        if not fit.get("available"):
            section_reasons.append("circle-fit-unavailable")
        if observed_bins < math.ceil(angular_bins * 0.80):
            section_reasons.append("angular-coverage-insufficient")
        if float(fit.get("p95AbsResidualMm", math.inf)) > settings.maximum_circle_residual_mm:
            section_reasons.append("circle-fit-residual-out-of-tolerance")
        section_reasons.extend(
            str(reason)
            for reason in overlap_consistency.get("qualityGate", {}).get("reasons", [])
        )
        sections.append(
            {
                "anchorOrdinal": anchor.get("ordinal"),
                "elapsedFromHeadMs": anchor.get("elapsedFromHeadMs"),
                "mappingComplete": complete and len(transformed_profiles) == len(camera_roots),
                "mappingMetricValid": mapping_metric_complete,
                "circleFit": fit,
                "angularBinsObserved": observed_bins,
                "angularCoverageRatio": round(observed_bins / angular_bins, 8),
                "cameraOverlapConsistency": overlap_consistency,
                "acceptedForSurface": accepted_for_surface,
                "qualityGate": {
                    "passed": accepted_for_surface,
                    "reasons": list(dict.fromkeys(section_reasons)),
                },
                "cameras": camera_details,
            }
        )
        for camera_id in sorted(camera_roots):
            details = profile_details_by_camera.get(camera_id, {})
            mapping = anchor.get("cameras", {}).get(camera_id, {})
            transformed = transformed_profiles.get(camera_id)
            source_columns = source_columns_by_camera.get(
                camera_id, np.empty(0, dtype=np.int32)
            )
            residual_by_column, angle_by_column, sample_count_by_column = (
                _source_column_samples(transformed, source_columns, fit)
                if transformed is not None
                else ({}, {}, {})
            )
            camera_samples[camera_id].append(
                {
                    "available": transformed is not None,
                    "anchorOrdinal": anchor.get("ordinal"),
                    "elapsedFromHeadMs": anchor.get("elapsedFromHeadMs"),
                    "storageIndex": mapping.get("storageIndex"),
                    "sourceRow": details.get("rowIndex", mapping.get("rowIndex")),
                    "sourceShape": (
                        [int(details["shape"][1]), int(details["shape"][0])]
                        if details.get("shape")
                        else None
                    ),
                    "frameCropBox": details.get("cropBox"),
                    "timeResidualMs": mapping.get("timeResidualMs"),
                    "interpolationResidualMs": mapping.get("interpolationResidualMs"),
                    "mappingMetricValid": bool(
                        camera_details.get(camera_id, {}).get("mappingMetricValid")
                    ),
                    "acceptedForSurface": accepted_for_surface,
                    "residualByColumn": residual_by_column,
                    "angleByColumn": angle_by_column,
                    "sampleCountByColumn": sample_count_by_column,
                }
            )

    residual_grid = np.vstack(grids) if grids else np.empty((0, angular_bins))
    count_grid = np.vstack(counts) if counts else np.empty((0, angular_bins), dtype=np.int32)
    finite_values = residual_grid[np.isfinite(residual_grid)]
    display_range = max(
        0.05,
        float(np.percentile(np.abs(finite_values), 98)) if finite_values.size else 0.05,
    )
    accepted = [row for row in sections if row.get("acceptedForSurface")]
    diameters = np.asarray(
        [float(row["circleFit"]["diameterMm"]) for row in accepted], dtype=np.float64
    )
    coverage = (
        float(np.count_nonzero(np.isfinite(residual_grid)))
        / float(max(1, len(accepted) * angular_bins))
        if residual_grid.size and accepted
        else 0.0
    )
    # Whole-flow synchronization can be degraded by a clipped transition or a
    # transport omission outside the selected rows.  Metric cross sections are
    # therefore gated per anchor above; unrelated bad rows must not invalidate
    # every reconstructed section.
    cross_section_metric_valid = bool(approved and len(accepted) >= 2)
    reasons: list[str] = []
    if not approved:
        reasons.append("approved-array-calibration-missing")
    if len(accepted) < 2:
        reasons.append("not-enough-qualified-surface-sections")
    diameter_curves = build_fixed_angle_diameter_curves(
        sections,
        residual_grid,
        surface_metric_valid=cross_section_metric_valid,
    )

    circle_fit_p95_values = [
        float(row.get("circleFit", {}).get("p95AbsResidualMm"))
        for row in accepted
        if _finite_float(row.get("circleFit", {}).get("p95AbsResidualMm")) is not None
    ]
    overlap_p95_values = [
        float(row.get("cameraOverlapConsistency", {}).get("p95AbsRadialDifferenceMm"))
        for row in accepted
        if _finite_float(
            row.get("cameraOverlapConsistency", {}).get("p95AbsRadialDifferenceMm")
        )
        is not None
    ]
    overlap_max_values = [
        float(row.get("cameraOverlapConsistency", {}).get("maximumAbsRadialDifferenceMm"))
        for row in accepted
        if _finite_float(
            row.get("cameraOverlapConsistency", {}).get("maximumAbsRadialDifferenceMm")
        )
        is not None
    ]
    overlap_sample_count = sum(
        int(row.get("cameraOverlapConsistency", {}).get("sampleCount", 0) or 0)
        for row in accepted
    )
    overlap_warnings = list(
        dict.fromkeys(
            str(warning)
            for row in accepted
            for warning in row.get("cameraOverlapConsistency", {}).get("warnings", [])
        )
    )

    camera_tiles: list[dict[str, Any]] = []
    for camera_id in sorted(camera_roots):
        tile, _tile_grid = _camera_tile_payload(
            camera_id,
            camera_samples[camera_id],
            region_map=region_map,
            fixed_angle_deg=camera_fixed_angles[camera_id],
            display_range_mm=display_range,
        )
        camera_tiles.append(tile)

    positions: list[float | None] = []
    colors: list[float] = []
    valid_mask: list[int] = []
    indices: list[int] = []
    representative_radius = float(np.median(diameters) / 2.0) if diameters.size else 1.0
    longitudinal_span = max(1.0, representative_radius * 4.0)
    row_count = residual_grid.shape[0]
    for row in range(row_count):
        y = 0.0 if row_count == 1 else row * longitudinal_span / (row_count - 1)
        fit = sections[row].get("circleFit", {})
        radius = float(fit.get("radiusMm", representative_radius))
        center_x = float(fit.get("centerX", 0.0))
        center_z = float(fit.get("centerZ", 0.0))
        for column in range(angular_bins):
            residual = residual_grid[row, column]
            angle = (column + 0.5) * 2.0 * math.pi / angular_bins
            valid = bool(np.isfinite(residual))
            fitted_radius = radius + (float(residual) if valid else 0.0)
            positions.extend(
                [
                    round(center_x + fitted_radius * math.cos(angle), 5) if valid else None,
                    round(y, 5) if valid else None,
                    round(center_z + fitted_radius * math.sin(angle), 5) if valid else None,
                ]
            )
            red, green, blue = jet_rgb(
                0.5 + (float(residual) if valid else 0.0) / (2.0 * display_range)
            )
            colors.extend([red / 255.0, green / 255.0, blue / 255.0])
            valid_mask.append(1 if valid else 0)
    if row_count >= 2:
        for row in range(row_count - 1):
            for column in range(angular_bins):
                next_column = (column + 1) % angular_bins
                vertices = (
                    row * angular_bins + column,
                    row * angular_bins + next_column,
                    (row + 1) * angular_bins + column,
                    (row + 1) * angular_bins + next_column,
                )
                if all(valid_mask[index] for index in vertices):
                    first, second, third, fourth = vertices
                    indices.extend([first, third, second, second, third, fourth])

    payload = {
        "schema": SURFACE_SCHEMA,
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "state": "ready" if cross_section_metric_valid else "preview" if accepted else "unavailable",
        "calibration": {
            "path": str(calibration_path) if calibration_path else "",
            "revision": calibration.get("revision"),
            "approved": approved,
            "metricProjectionVerified": bool(calibration.get("metricProjectionVerified", False)),
        },
        "quality": {
            "crossSectionMetricValid": cross_section_metric_valid,
            "absoluteLongitudinalScaleVerified": False,
            "geometrySynchronized": geometry_synchronized,
            "wholeFlowGeometrySynchronized": geometry_synchronized,
            "sectionSynchronizationPolicy": "per-anchor-interpolated-row-residual",
            "maximumAnchorResidualMs": maximum_sync_residual_ms,
            "cameraOverlapMetricValid": bool(
                accepted
                and all(
                    row.get("cameraOverlapConsistency", {}).get("metricValid")
                    for row in accepted
                )
            ),
            "cameraOverlapP95ThresholdMm": settings.maximum_circle_residual_mm,
            "cameraOverlapMaximumAdvisoryThresholdMm": round(
                settings.maximum_circle_residual_mm * 4.0, 6
            ),
            "warnings": overlap_warnings,
            "regionOwnershipReady": bool(
                region_map.get("ownership", {}).get("ready")
                if isinstance(region_map, dict)
                else False
            ),
            "candidateRegionPolicy": "owned-columns-valid,calibrated-overlap-recorded",
            "passed": cross_section_metric_valid,
            "reasons": reasons,
            "rejectedTransitionSections": len(sections) - len(accepted),
            "angularCoverageRatio": round(coverage, 6),
        },
        "coordinateSystem": {
            "x": "cross-section-horizontal-mm",
            "y": "display-only-head-relative-position",
            "z": "cross-section-vertical-mm",
            "longitudinalSource": "soft-sync-anchor-head-relative-time",
            "longitudinalScale": "not-metric-until-speed-or-encoder-is-connected",
        },
        "summary": {
            "sectionCount": len(sections),
            "acceptedSectionCount": len(accepted),
            "diameterMeanMm": round(float(np.mean(diameters)), 6) if diameters.size else None,
            "diameterMinimumMm": round(float(np.min(diameters)), 6) if diameters.size else None,
            "diameterMaximumMm": round(float(np.max(diameters)), 6) if diameters.size else None,
            "diameterStdDevMm": round(float(np.std(diameters)), 6) if diameters.size else None,
            "jetResidualRangeMm": round(display_range, 6),
            "circleFitP95MaximumMm": (
                round(max(circle_fit_p95_values), 6) if circle_fit_p95_values else None
            ),
            "angularCoverageMinimumRatio": (
                round(
                    min(float(row.get("angularCoverageRatio", 0.0)) for row in accepted),
                    6,
                )
                if accepted
                else 0.0
            ),
            "cameraOverlapSampleCount": overlap_sample_count,
            "cameraOverlapP95MaximumMm": (
                round(max(overlap_p95_values), 6) if overlap_p95_values else None
            ),
            "cameraOverlapMaximumMm": (
                round(max(overlap_max_values), 6) if overlap_max_values else None
            ),
            "cameraOverlapP95ThresholdMm": settings.maximum_circle_residual_mm,
            "cameraOverlapMaximumAdvisoryThresholdMm": round(
                settings.maximum_circle_residual_mm * 4.0, 6
            ),
        },
        "mesh": {
            "rows": row_count,
            "columns": angular_bins,
            "positions": positions,
            "colors": [round(value, 5) for value in colors],
            "indices": indices,
            "validMask": valid_mask,
        },
        "jet": {
            "palette": "JET",
            "minimumMm": round(-display_range, 6),
            "maximumMm": round(display_range, 6),
            "zeroMm": 0.0,
            "missingColor": "#07121b",
        },
        "cameraTiles": {
            "schema": CAMERA_TILE_SCHEMA,
            "coordinateSpace": "source-image-pixels-to-array-cross-section-mm",
            "angleConvention": "0deg:+X,positive:+Z,right-handed,array-calibration",
            "rowOrder": "head-to-tail-soft-sync-anchor",
            "residualDefinition": "measured-radius-minus-robust-section-circle-radius-mm",
            "twoDimensionalCropSource": (
                "steel.capture-region-map.v1"
                if isinstance(region_map, dict)
                else "per-frame-stable-foreground-median"
            ),
            "regionManifestPath": (
                region_map.get("manifestPath", "")
                if isinstance(region_map, dict)
                else ""
            ),
            "cameras": camera_tiles,
        },
        "diameterCurves": diameter_curves,
        "sections": sections,
        "sampleCounts": count_grid.astype(int).tolist(),
    }
    return payload, residual_grid


def build_and_write_flow_surface(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment: dict[str, Any],
    *,
    calibration_path: Path | None,
    config: MeasurementConfig | None = None,
    angular_bins: int = 180,
    region_map: dict[str, Any] | None = None,
) -> tuple[Path, dict[str, Any], Path]:
    payload, residuals = build_flow_surface(
        camera_roots,
        material_id,
        alignment,
        calibration_path=calibration_path,
        config=config,
        angular_bins=angular_bins,
        region_map=region_map,
    )
    jet_path = surface_jet_path(storage_root, material_id)
    if residuals.size:
        _write_jet_image(
            jet_path,
            residuals,
            float(payload["summary"]["jetResidualRangeMm"]),
        )
        payload["jet"]["imagePath"] = str(jet_path)
    else:
        payload["jet"]["imagePath"] = ""
    for tile in payload.get("cameraTiles", {}).get("cameras", []):
        rows = int(tile.get("rows", 0) or 0)
        columns = int(tile.get("columns", 0) or 0)
        serialized = tile.get("residuals", [])
        camera_id = str(tile.get("cameraId", "")).strip()
        if (
            not camera_id
            or rows <= 0
            or columns <= 0
            or len(serialized) != rows * columns
        ):
            tile.setdefault("jet", {})["imagePath"] = ""
            continue
        camera_grid = np.asarray(
            [np.nan if value is None else float(value) for value in serialized],
            dtype=np.float64,
        ).reshape(rows, columns)
        if not np.any(np.isfinite(camera_grid)):
            tile.setdefault("jet", {})["imagePath"] = ""
            continue
        camera_path = jet_path.with_name(f"surface-jet-{camera_id.lower()}.png")
        _write_jet_image(
            camera_path,
            camera_grid,
            float(payload["summary"]["jetResidualRangeMm"]),
        )
        tile.setdefault("jet", {})["imagePath"] = str(camera_path)
    path = surface_path(storage_root, material_id)
    _atomic_json(path, payload)
    return path, payload, jet_path
