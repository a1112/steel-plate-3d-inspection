"""Fail-closed 2D crop, cross-section and diameter analysis for Ranger3 flows.

The module consumes the current ``2d/*.png``, ``3d/*.npz`` and ``json/*.json``
layout.  A preview is always useful, while metric output is only released when
an approved six-camera extrinsic calibration and a synchronized flow are both
available.
"""

from __future__ import annotations

import datetime as dt
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .paths import capture_root, measurement_path
from PIL import Image

from .alignment import _atomic_json, _read_json
from .playback import detect_valid_grayscale_roi


MEASUREMENT_SCHEMA = "steel.ranger3-flow-measurement.v1"
CALIBRATION_SCHEMA = "steel.sick-array-calibration.v1"
DEFAULT_DIAMETER_ANGLES_DEG = (0.0, 30.0, 60.0, 90.0, 120.0, 150.0)


def _calibration_metric_projection_valid(calibration: dict[str, Any]) -> bool:
    """Return whether calibration is approved for metric projection.

    ``approved`` identifies the calibration record selected by the operator;
    ``metricProjectionVerified`` is the separate unit/projection acceptance
    gate.  Both are required before any result may be labelled as metric.
    """
    return bool(
        calibration.get("approved", False)
        and calibration.get("metricProjectionVerified", False)
    )


@dataclass(frozen=True)
class MeasurementConfig:
    row_window: int = 16
    maximum_profile_points: int = 320
    maximum_sections: int = 12
    minimum_circle_points: int = 48
    maximum_circle_residual_mm: float = 0.5

    def bounded(self) -> "MeasurementConfig":
        return MeasurementConfig(
            row_window=max(1, min(128, int(self.row_window))),
            maximum_profile_points=max(32, min(2048, int(self.maximum_profile_points))),
            maximum_sections=max(1, min(64, int(self.maximum_sections))),
            minimum_circle_points=max(8, min(4096, int(self.minimum_circle_points))),
            maximum_circle_residual_mm=max(
                0.001, min(100.0, float(self.maximum_circle_residual_mm))
            ),
        )


def _utc_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _depth(path: Path) -> np.ndarray:
    with np.load(path, allow_pickle=False) as payload:
        if not payload.files:
            raise ValueError(f"depth NPZ has no array: {path}")
        value = np.asarray(payload[payload.files[0]])
    if value.ndim != 2:
        raise ValueError(f"depth plane must be 2D: {path}")
    return value


def _intensity(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        value = np.asarray(image.convert("L"))
    if value.ndim != 2:
        raise ValueError(f"intensity plane must be 2D: {path}")
    return value


def _crop_box(depth: np.ndarray, intensity: np.ndarray) -> list[int] | None:
    if depth.shape != intensity.shape:
        raise ValueError("depth/intensity shape mismatch")
    # Match the online grayscale gate. Sparse valid depth from fixtures or
    # dust must not expand the algorithm ROI back into invalid black borders.
    return detect_valid_grayscale_roi(intensity)


def _coordinate(metadata: dict[str, Any], axis: str) -> tuple[float, float, float]:
    item = metadata.get("bdConfig", {}).get(axis, {})
    scale = float(item.get("Scan3dCoordinateScale", 1.0) or 1.0)
    offset = float(item.get("Scan3dCoordinateOffset", 0.0) or 0.0)
    invalid = float(item.get("Scan3dInvalidDataValue", 0.0) or 0.0)
    return scale, offset, invalid


def _profile(
    flow_root: Path,
    storage_index: int,
    row_index: int | None,
    config: MeasurementConfig,
) -> tuple[np.ndarray, dict[str, Any]]:
    depth_path = flow_root / "3d" / f"{storage_index}.npz"
    intensity_path = flow_root / "2d" / f"{storage_index}.png"
    metadata_path = flow_root / "json" / f"{storage_index}.json"
    depth = _depth(depth_path)
    intensity = _intensity(intensity_path)
    metadata = _read_json(metadata_path)
    height, width = depth.shape
    crop = _crop_box(depth, intensity)
    if crop is None:
        raise ValueError("stable foreground source unavailable")
    crop_left, _crop_top, crop_right, _crop_bottom = crop
    center = height // 2 if row_index is None else max(0, min(height - 1, int(row_index)))
    half = max(1, config.row_window // 2)
    top = max(0, center - half)
    bottom = min(height, center + half + 1)
    # Reconstruct only the same 2D foreground columns shown by playback and
    # defect inference.  Sampling the full sensor plane admitted static valid
    # depth outside the bar and made the fitted circle disagree with its 2D
    # tile.  Base the sampling step on the cropped width as well, so a narrow
    # bar still retains the configured profile resolution.
    step = max(
        1, math.ceil(max(1, crop_right - crop_left) / config.maximum_profile_points)
    )
    columns = np.arange(crop_left, crop_right, step, dtype=np.int32)
    window = depth[top:bottom, :][:, columns].astype(np.float64)
    invalid_mask = window == 0
    window[invalid_mask] = np.nan
    raw_z = np.full(window.shape[1], np.nan, dtype=np.float64)
    usable_columns = np.any(np.isfinite(window), axis=0)
    if np.any(usable_columns):
        raw_z[usable_columns] = np.nanmedian(window[:, usable_columns], axis=0)
    sx, ox, _ = _coordinate(metadata, "CoordinateA")
    sz, oz, invalid = _coordinate(metadata, "CoordinateC")
    valid = np.isfinite(raw_z) & (raw_z != invalid)
    points = np.column_stack(
        (
            columns[valid].astype(np.float64) * sx + ox,
            raw_z[valid] * sz + oz,
        )
    )
    return points, {
        "storageIndex": storage_index,
        "rowIndex": center,
        "rowWindow": [top, bottom],
        "shape": [height, width],
        "cropBox": crop,
        "validRoi": crop,
        "croppedShape": [crop[3] - crop[1], crop[2] - crop[0]],
        "sourceCoordinateOffset": {"x": crop[0], "row": crop[1]},
        "validProfilePoints": int(points.shape[0]),
        "validProfileColumns": columns[valid].astype(int).tolist(),
        "depthPath": str(depth_path),
        "intensityPath": str(intensity_path),
        "metadataPath": str(metadata_path),
        "serialNumber": str(metadata.get("cameraSerialNumber", "")),
    }


def _load_calibration(path: Path | None) -> dict[str, Any]:
    if path is None or not path.is_file():
        return {}
    payload = _read_json(path)
    if payload.get("schema") != CALIBRATION_SCHEMA:
        raise ValueError(f"array calibration schema must be {CALIBRATION_SCHEMA}")
    return payload


def _matrix_for(
    calibration: dict[str, Any], camera_id: str, serial_number: str
) -> np.ndarray | None:
    row = calibration.get("cameras", {}).get(camera_id)
    if not isinstance(row, dict) or str(row.get("serialNumber", "")) != serial_number:
        return None
    matrix = np.asarray(row.get("localToArray", []), dtype=np.float64)
    if matrix.shape != (4, 4) or not np.all(np.isfinite(matrix)):
        return None
    return matrix


def _transform_profile(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    local = np.column_stack(
        (points[:, 0], np.zeros(points.shape[0]), points[:, 1], np.ones(points.shape[0]))
    )
    global_points = local @ matrix.T
    return global_points[:, [0, 2]]


def _anchor_mapping_metric_valid(
    mapping: dict[str, Any], maximum_residual_ms: float
) -> bool:
    if not mapping.get("available") or mapping.get("rowClipped"):
        return False
    residual_value = mapping.get(
        "interpolationResidualMs", mapping.get("timeResidualMs")
    )
    if residual_value is None:
        return True
    try:
        residual = float(residual_value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(residual) and abs(residual) <= maximum_residual_ms


def robust_circle_fit(points: np.ndarray, minimum_points: int = 8) -> dict[str, Any]:
    points = np.asarray(points, dtype=np.float64)
    points = points[np.all(np.isfinite(points), axis=1)] if points.ndim == 2 else np.empty((0, 2))
    if points.shape[0] < minimum_points:
        return {"available": False, "reason": "not-enough-points", "pointCount": int(points.shape[0])}
    retained = points
    center = np.zeros(2, dtype=np.float64)
    radius = 0.0
    residual = np.empty(0, dtype=np.float64)
    for _ in range(4):
        x = retained[:, 0]
        z = retained[:, 1]
        design = np.column_stack((2.0 * x, 2.0 * z, np.ones(x.size)))
        solution, *_ = np.linalg.lstsq(design, x * x + z * z, rcond=None)
        center = solution[:2]
        radius = float(math.sqrt(max(0.0, solution[2] + np.dot(center, center))))
        residual = np.abs(np.linalg.norm(retained - center, axis=1) - radius)
        median = float(np.median(residual))
        mad = float(np.median(np.abs(residual - median)))
        threshold = max(0.01, median + 6.0 * 1.4826 * mad)
        next_retained = retained[residual <= threshold]
        if next_retained.shape[0] < minimum_points or next_retained.shape[0] == retained.shape[0]:
            break
        retained = next_retained
    # Refit once after the final rejection pass.  Without this final solve the
    # reported diameter can still use the center from the pre-rejection set.
    x = retained[:, 0]
    z = retained[:, 1]
    design = np.column_stack((2.0 * x, 2.0 * z, np.ones(x.size)))
    solution, *_ = np.linalg.lstsq(design, x * x + z * z, rcond=None)
    center = solution[:2]
    radius = float(math.sqrt(max(0.0, solution[2] + np.dot(center, center))))
    signed_residual = np.linalg.norm(retained - center, axis=1) - radius
    residual = np.abs(signed_residual)
    return {
        "available": True,
        "centerX": round(float(center[0]), 6),
        "centerZ": round(float(center[1]), 6),
        "radiusMm": round(radius, 6),
        "diameterMm": round(2.0 * radius, 6),
        "meanAbsResidualMm": round(float(np.mean(residual)), 6),
        "p95AbsResidualMm": round(float(np.percentile(residual, 95)), 6),
        "maxAbsResidualMm": round(float(np.max(residual)), 6),
        "roundnessMm": round(
            float(np.max(signed_residual) - np.min(signed_residual)), 6
        ),
        "pointCount": int(points.shape[0]),
        "robustPointCount": int(retained.shape[0]),
    }


def _fixed_angle_radial_residual(
    residuals: np.ndarray,
    angle_deg: float,
    *,
    minimum_half_window_deg: float = 3.0,
) -> float | None:
    """Sample one fixed array angle from a reconstructed radial surface row.

    Surface bins are centred between whole-degree boundaries, so sampling a
    nominal direction such as 0 degrees from a single bin would introduce an
    angular-bin bias.  Use a small circular median window around that physical
    direction.  The window is never narrower than half a source bin.
    """

    values = np.asarray(residuals, dtype=np.float64).reshape(-1)
    if values.size <= 0:
        return None
    bin_width_deg = 360.0 / float(values.size)
    half_window_deg = max(
        float(minimum_half_window_deg),
        bin_width_deg / 2.0 + np.finfo(np.float64).eps,
    )
    centers_deg = (np.arange(values.size, dtype=np.float64) + 0.5) * bin_width_deg
    angular_delta = np.abs(
        np.mod(centers_deg - float(angle_deg) + 180.0, 360.0) - 180.0
    )
    selected = values[(angular_delta <= half_window_deg) & np.isfinite(values)]
    if selected.size <= 0:
        return None
    return float(np.median(selected))


def build_fixed_angle_diameter_curves(
    sections: list[dict[str, Any]],
    residual_grid: np.ndarray,
    fixed_angles_deg: tuple[float, ...] = DEFAULT_DIAMETER_ANGLES_DEG,
    *,
    surface_metric_valid: bool = True,
) -> dict[str, Any]:
    """Build directional diameter curves from reconstructed surface radii.

    A diameter at fixed angle ``theta`` is the sum of the two opposed radii
    reconstructed at ``theta`` and ``theta + 180 degrees``.  Values are emitted
    for every selected longitudinal section so every series remains aligned
    with ``sections``.  Rejected transition/head/tail sections are deliberately
    represented by ``null`` values even if their raw residual row contains
    finite samples.
    """

    grid = np.asarray(residual_grid, dtype=np.float64)
    if grid.ndim != 2:
        raise ValueError("surface residual grid must be 2D")
    if grid.shape[0] != len(sections):
        raise ValueError("surface residual rows must align with sections")

    normalized_angles: list[float] = []
    for raw_angle in fixed_angles_deg:
        angle = float(raw_angle)
        if not math.isfinite(angle):
            raise ValueError("fixed diameter angles must be finite")
        angle = angle % 180.0
        if not any(abs(angle - existing) < 1e-9 for existing in normalized_angles):
            normalized_angles.append(angle)
    if not normalized_angles:
        raise ValueError("at least one fixed diameter angle is required")

    elapsed_values: list[float | None] = []
    for section in sections:
        try:
            elapsed = float(section.get("elapsedFromHeadMs"))
        except (TypeError, ValueError):
            elapsed = math.nan
        elapsed_values.append(elapsed if math.isfinite(elapsed) else None)
    finite_elapsed = [value for value in elapsed_values if value is not None]
    elapsed_start = min(finite_elapsed, default=0.0)
    elapsed_end = max(finite_elapsed, default=elapsed_start)
    elapsed_span = max(0.0, elapsed_end - elapsed_start)

    curve_sections: list[dict[str, Any]] = []
    angle_values: list[list[float | None]] = [
        [] for _ in normalized_angles
    ]
    minimum_values: list[float | None] = []
    maximum_values: list[float | None] = []
    average_values: list[float | None] = []
    all_valid_values: list[float] = []
    minimum_required_angles = min(
        len(normalized_angles),
        max(2, math.ceil(len(normalized_angles) / 2.0)),
    )

    for row_index, section in enumerate(sections):
        elapsed = elapsed_values[row_index]
        if elapsed is not None and elapsed_span > 0.0:
            position_ratio = (elapsed - elapsed_start) / elapsed_span
        elif len(sections) > 1:
            position_ratio = row_index / float(len(sections) - 1)
        else:
            position_ratio = 0.0

        fit = section.get("circleFit", {})
        try:
            radius_mm = float(fit.get("radiusMm"))
        except (TypeError, ValueError):
            radius_mm = math.nan
        surface_accepted = bool(section.get("acceptedForSurface"))
        reasons: list[str] = []
        if not surface_accepted:
            reasons.append("surface-section-rejected")
        if not bool(fit.get("available")) or not math.isfinite(radius_mm) or radius_mm <= 0.0:
            reasons.append("circle-fit-unavailable")

        diameters: list[float | None] = [None] * len(normalized_angles)
        if not reasons:
            row_residuals = grid[row_index]
            for angle_index, angle_deg in enumerate(normalized_angles):
                near_residual = _fixed_angle_radial_residual(
                    row_residuals, angle_deg
                )
                opposite_residual = _fixed_angle_radial_residual(
                    row_residuals, angle_deg + 180.0
                )
                if near_residual is None or opposite_residual is None:
                    continue
                diameter = 2.0 * radius_mm + near_residual + opposite_residual
                if math.isfinite(diameter) and diameter > 0.0:
                    diameters[angle_index] = round(float(diameter), 6)

        valid_diameters = [value for value in diameters if value is not None]
        if not reasons and len(valid_diameters) < minimum_required_angles:
            reasons.append("fixed-angle-coverage-insufficient")
            # Fail closed as a whole section.  This keeps aggregate curves and
            # fixed-angle curves from silently using different section sets.
            diameters = [None] * len(normalized_angles)
            valid_diameters = []

        metric_valid = not reasons
        minimum_mm = (
            round(float(min(valid_diameters)), 6) if valid_diameters else None
        )
        maximum_mm = (
            round(float(max(valid_diameters)), 6) if valid_diameters else None
        )
        average_mm = (
            round(float(np.mean(valid_diameters)), 6) if valid_diameters else None
        )
        for angle_index, value in enumerate(diameters):
            angle_values[angle_index].append(value)
        minimum_values.append(minimum_mm)
        maximum_values.append(maximum_mm)
        average_values.append(average_mm)
        all_valid_values.extend(valid_diameters)
        curve_sections.append(
            {
                "anchorOrdinal": section.get("anchorOrdinal"),
                "elapsedFromHeadMs": elapsed,
                "positionRatio": round(float(position_ratio), 8),
                "metricValid": metric_valid,
                "qualityGate": {"passed": metric_valid, "reasons": reasons},
                "validAngleCount": len(valid_diameters),
                "diametersMm": diameters,
                "minimumMm": minimum_mm,
                "maximumMm": maximum_mm,
                "averageMm": average_mm,
            }
        )

    angle_series: list[dict[str, Any]] = []
    by_angle: list[dict[str, Any]] = []
    for angle_index, angle_deg in enumerate(normalized_angles):
        values = angle_values[angle_index]
        finite_values = [value for value in values if value is not None]
        angle_token = (
            f"{int(round(angle_deg)):03d}"
            if math.isclose(angle_deg, round(angle_deg), abs_tol=1e-9)
            else f"{angle_deg:06.2f}".replace(".", "-")
        )
        angle_series.append(
            {
                "id": f"angle-{angle_token}",
                "kind": "fixed-angle",
                "angleDeg": round(angle_deg, 6),
                "label": f"{angle_deg:g}\u00b0",
                "valuesMm": values,
            }
        )
        by_angle.append(
            {
                "angleDeg": round(angle_deg, 6),
                "minimumMm": round(float(min(finite_values)), 6)
                if finite_values
                else None,
                "maximumMm": round(float(max(finite_values)), 6)
                if finite_values
                else None,
                "averageMm": round(float(np.mean(finite_values)), 6)
                if finite_values
                else None,
                "validSampleCount": len(finite_values),
            }
        )

    series = angle_series + [
        {
            "id": "minimum",
            "kind": "aggregate",
            "label": "minimum",
            "valuesMm": minimum_values,
        },
        {
            "id": "maximum",
            "kind": "aggregate",
            "label": "maximum",
            "valuesMm": maximum_values,
        },
        {
            "id": "average",
            "kind": "aggregate",
            "label": "average",
            "valuesMm": average_values,
        },
    ]
    valid_section_count = sum(
        1 for section in curve_sections if section["metricValid"]
    )
    curves_available = valid_section_count >= 2
    curves_metric_valid = bool(surface_metric_valid and curves_available)
    return {
        "available": curves_available,
        "metricValid": curves_metric_valid,
        "displayMode": (
            "metric"
            if curves_metric_valid
            else "diagnostic-unqualified"
            if curves_available
            else "unavailable"
        ),
        "qualityGate": {
            "passed": curves_metric_valid,
            "reasons": []
            if curves_metric_valid
            else ["surface-metric-quality-gate-failed"]
            if curves_available and not surface_metric_valid
            else ["not-enough-valid-sections"],
        },
        "model": "opposed-radial-pairs-from-reconstructed-surface",
        "angleConvention": "array-x-axis-ccw-period-180",
        "longitudinalCoordinate": "head-relative-time",
        "absoluteLongitudinalScaleVerified": False,
        "angularSampleHalfWindowDeg": round(
            float(
                max(
                    3.0,
                    180.0 / float(grid.shape[1]) + np.finfo(np.float64).eps,
                )
                if grid.shape[1]
                else 3.0
            ),
            6,
        ),
        "fixedAnglesDeg": [round(value, 6) for value in normalized_angles],
        "sections": curve_sections,
        "series": series,
        "summary": {
            "metricValid": curves_metric_valid,
            "minimumMm": round(float(min(all_valid_values)), 6)
            if all_valid_values
            else None,
            "maximumMm": round(float(max(all_valid_values)), 6)
            if all_valid_values
            else None,
            "averageMm": round(float(np.mean(all_valid_values)), 6)
            if all_valid_values
            else None,
            "validSectionCount": valid_section_count,
            "validSampleCount": len(all_valid_values),
            "byAngle": by_angle,
        },
    }


def summarize_cylinder_sections(
    sections: list[dict[str, Any]],
    maximum_circle_residual_mm: float = math.inf,
) -> dict[str, Any]:
    elapsed_values = [
        float(section.get("elapsedFromHeadMs", 0.0) or 0.0) for section in sections
    ]
    elapsed_start = min(elapsed_values, default=0.0)
    elapsed_end = max(elapsed_values, default=elapsed_start)
    elapsed_span = max(0.0, elapsed_end - elapsed_start)
    evaluated: list[dict[str, Any]] = []
    accepted: list[dict[str, Any]] = []
    for section in sections:
        fit = section.get("circleFit", {})
        mapping_complete = bool(section.get("rowMappingComplete", True))
        time_mapping_valid = bool(section.get("timeMappingValid", True))
        fit_available = bool(fit.get("available"))
        diameter = float(fit.get("diameterMm", math.nan))
        residual = float(fit.get("p95AbsResidualMm", math.inf))
        reasons: list[str] = []
        if not mapping_complete:
            reasons.append("cross-section-mapping-incomplete")
        if not time_mapping_valid:
            reasons.append("cross-section-time-residual-out-of-tolerance")
        if not fit_available or not math.isfinite(diameter):
            reasons.append("circle-fit-unavailable")
        if residual > maximum_circle_residual_mm:
            reasons.append("circle-fit-residual-out-of-tolerance")
        elapsed = float(section.get("elapsedFromHeadMs", 0.0) or 0.0)
        evaluated_section = {
            **section,
            "positionRatio": round(
                (elapsed - elapsed_start) / elapsed_span if elapsed_span > 0 else 0.0,
                8,
            ),
            "metricValid": not reasons,
            "qualityGate": {"passed": not reasons, "reasons": reasons},
        }
        evaluated.append(evaluated_section)
        if not reasons:
            accepted.append(evaluated_section)
    if len(accepted) < 2:
        return {
            "available": False,
            "reason": "not-enough-valid-sections",
            "sectionsRequested": len(sections),
            "sectionsAccepted": len(accepted),
            "sectionsRejected": len(evaluated) - len(accepted),
            "sections": evaluated,
        }
    diameters = np.asarray(
        [float(section["circleFit"]["diameterMm"]) for section in accepted],
        dtype=np.float64,
    )
    centers = np.asarray(
        [
            [
                float(section["circleFit"]["centerX"]),
                float(section["circleFit"]["centerZ"]),
            ]
            for section in accepted
        ],
        dtype=np.float64,
    )
    center_reference = np.median(centers, axis=0)
    straightness = np.linalg.norm(centers - center_reference, axis=1)
    elapsed = [float(section.get("elapsedFromHeadMs", 0.0)) for section in accepted]
    roundness = np.asarray(
        [float(section["circleFit"].get("roundnessMm", 0.0)) for section in accepted],
        dtype=np.float64,
    )
    p95_residuals = np.asarray(
        [float(section["circleFit"].get("p95AbsResidualMm", 0.0)) for section in accepted],
        dtype=np.float64,
    )
    return {
        "available": True,
        "model": "cylinder-sections-head-relative-time",
        "sectionsRequested": len(sections),
        "sectionsAccepted": len(accepted),
        "diameterMeanMm": round(float(np.mean(diameters)), 6),
        "diameterMinimumMm": round(float(np.min(diameters)), 6),
        "diameterMaximumMm": round(float(np.max(diameters)), 6),
        "diameterStdDevMm": round(float(np.std(diameters)), 6),
        "diameterMedianMm": round(float(np.median(diameters)), 6),
        "diameterP05Mm": round(float(np.percentile(diameters, 5)), 6),
        "diameterP95Mm": round(float(np.percentile(diameters, 95)), 6),
        "diameterRangeMm": round(float(np.max(diameters) - np.min(diameters)), 6),
        "roundnessMaximumMm": round(float(np.max(roundness)), 6),
        "fitResidualP95MaximumMm": round(float(np.max(p95_residuals)), 6),
        "centerStraightnessMaximumMm": round(float(np.max(straightness)), 6),
        "headRelativeTimeSpanMs": round(max(elapsed) - min(elapsed), 6),
        "fullHeadRelativeTimeSpanMs": round(elapsed_span, 6),
        "sectionsRejected": len(evaluated) - len(accepted),
        "sections": evaluated,
    }


def build_flow_measurement(
    camera_roots: dict[str, Path],
    material_id: str,
    alignment: dict[str, Any],
    *,
    calibration_path: Path | None = None,
    config: MeasurementConfig | None = None,
) -> dict[str, Any]:
    settings = (config or MeasurementConfig()).bounded()
    calibration = _load_calibration(calibration_path)
    approved = bool(calibration.get("approved", False))
    metric_projection_verified = bool(
        calibration.get("metricProjectionVerified", False)
    )
    calibration_metric_valid = _calibration_metric_projection_valid(calibration)
    anchors = list(alignment.get("softSyncAnchors", []))
    selected_anchor = anchors[len(anchors) // 2] if anchors else None
    cameras: dict[str, Any] = {}
    global_profiles: list[np.ndarray] = []
    matrices: dict[str, np.ndarray] = {}
    calibrated = 0
    maximum_sync_residual_ms = float(
        alignment.get("settings", {}).get("maximumAnchorResidualMs", 40.0) or 40.0
    )
    if selected_anchor:
        for camera_id, camera_root in sorted(camera_roots.items()):
            mapping = selected_anchor.get("cameras", {}).get(camera_id, {})
            if not mapping.get("available"):
                cameras[camera_id] = {"available": False, "reason": "sync-anchor-unavailable"}
                continue
            try:
                profile, details = _profile(
                    capture_root(camera_root, material_id, camera_id),
                    int(mapping["storageIndex"]),
                    mapping.get("rowIndex"),
                    settings,
                )
                matrix = _matrix_for(calibration, camera_id, details["serialNumber"])
                transformed = _transform_profile(profile, matrix) if matrix is not None else None
                if transformed is not None:
                    global_profiles.append(transformed)
                    matrices[camera_id] = matrix
                    calibrated += 1
                details.update(
                    {
                        "available": True,
                        "timeResidualMs": mapping.get("timeResidualMs"),
                        "interpolationResidualMs": mapping.get("interpolationResidualMs"),
                        "rowClipped": bool(mapping.get("rowClipped")),
                        "mappingMetricValid": _anchor_mapping_metric_valid(
                            mapping, maximum_sync_residual_ms
                        ),
                        "localBoundsMm": {
                            "x": [round(float(np.min(profile[:, 0])), 6), round(float(np.max(profile[:, 0])), 6)] if profile.size else None,
                            "z": [round(float(np.min(profile[:, 1])), 6), round(float(np.max(profile[:, 1])), 6)] if profile.size else None,
                        },
                        "localProfile": np.round(profile, 5).tolist(),
                        "arrayProfile": np.round(transformed, 5).tolist()
                        if transformed is not None
                        else None,
                        "calibrationApplied": matrix is not None,
                    }
                )
                cameras[camera_id] = details
            except Exception as error:
                cameras[camera_id] = {"available": False, "reason": str(error)}

    combined = np.vstack(global_profiles) if global_profiles else np.empty((0, 2))
    circle = robust_circle_fit(combined, settings.minimum_circle_points)
    alignment_quality = alignment.get("quality", {})
    whole_flow_geometry_synchronized = bool(
        alignment_quality.get(
            "geometrySynchronized", alignment_quality.get("synchronized")
        )
    )
    selected_section_synchronized = bool(
        selected_anchor
        and len(cameras) == len(camera_roots)
        and all(row.get("mappingMetricValid") for row in cameras.values())
    )
    row_mapping_ok = bool(
        cameras and all(not row.get("rowClipped", True) for row in cameras.values() if row.get("available"))
    )
    every_camera_calibrated = calibrated == len(camera_roots)
    residual_ok = bool(
        circle.get("available")
        and float(circle.get("p95AbsResidualMm", math.inf))
        <= settings.maximum_circle_residual_mm
    )
    metric_valid = bool(
        calibration_metric_valid
        and selected_section_synchronized
        and row_mapping_ok
        and every_camera_calibrated
        and residual_ok
    )
    reasons: list[str] = []
    if not selected_section_synchronized:
        reasons.append("cross-section-not-synchronized")
    if not row_mapping_ok:
        reasons.append("cross-section-row-clipped")
    if not approved:
        reasons.append("approved-array-calibration-missing")
    if not metric_projection_verified:
        reasons.append("metric-projection-unverified")
    if not every_camera_calibrated:
        reasons.append("camera-extrinsics-incomplete")
    if not residual_ok:
        reasons.append("circle-fit-residual-out-of-tolerance")
    section_fits: list[dict[str, Any]] = []
    if approved and every_camera_calibrated and anchors:
        count = min(settings.maximum_sections, len(anchors))
        anchor_indices = sorted(
            set(int(value) for value in np.linspace(0, len(anchors) - 1, count))
        )
        for anchor_index in anchor_indices:
            anchor = anchors[anchor_index]
            section_points: list[np.ndarray] = []
            section_clipped = False
            section_time_mapping_valid = True
            for camera_id, camera_root in sorted(camera_roots.items()):
                mapping = anchor.get("cameras", {}).get(camera_id, {})
                if not _anchor_mapping_metric_valid(
                    mapping, maximum_sync_residual_ms
                ):
                    section_clipped = True
                    section_time_mapping_valid = False
                    continue
                try:
                    profile, _ = _profile(
                        capture_root(camera_root, material_id, camera_id),
                        int(mapping["storageIndex"]),
                        mapping.get("rowIndex"),
                        settings,
                    )
                    section_points.append(
                        _transform_profile(profile, matrices[camera_id])
                    )
                except Exception:
                    section_clipped = True
            section_combined = (
                np.vstack(section_points) if section_points else np.empty((0, 2))
            )
            fit = robust_circle_fit(section_combined, settings.minimum_circle_points)
            section_fits.append(
                {
                    "anchorOrdinal": anchor.get("ordinal"),
                    "elapsedFromHeadMs": anchor.get("elapsedFromHeadMs"),
                    "rowMappingComplete": not section_clipped
                    and len(section_points) == len(camera_roots),
                    "timeMappingValid": section_time_mapping_valid,
                    "circleFit": fit,
                }
            )
    surface_fit = summarize_cylinder_sections(
        section_fits, settings.maximum_circle_residual_mm
    )
    surface_metric_valid = bool(
        calibration_metric_valid
        and every_camera_calibrated
        and surface_fit.get("available")
        and int(surface_fit.get("sectionsAccepted", 0)) >= 2
    )
    surface_fit.update(
        {
            "metricValid": surface_metric_valid,
            "metricProjectionVerified": metric_projection_verified,
            "calibrationMetricValid": calibration_metric_valid,
            "longitudinalCoordinate": "head-relative-time",
            "absoluteLongitudinalScaleVerified": False,
            "maximumCircleResidualMm": settings.maximum_circle_residual_mm,
            "maximumAnchorResidualMs": maximum_sync_residual_ms,
            "sectionSynchronizationPolicy": "per-anchor-interpolated-row-residual",
            "wholeFlowGeometrySynchronized": whole_flow_geometry_synchronized,
            "note": "Encoder/speed input is required before reporting longitudinal millimetres.",
        }
    )
    return {
        "schema": MEASUREMENT_SCHEMA,
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "mode": "metric" if metric_valid else "preview",
        "metricValid": metric_valid,
        "qualityGate": {"passed": metric_valid, "reasons": reasons},
        "alignment": alignment_quality,
        "calibration": {
            "path": str(calibration_path) if calibration_path else "",
            "available": bool(calibration),
            "approved": approved,
            "metricProjectionVerified": metric_projection_verified,
            "metricProjectionValid": calibration_metric_valid,
            "calibratedCameras": calibrated,
            "expectedCameras": len(camera_roots),
            "revision": calibration.get("revision"),
        },
        "selectedSection": {
            "anchorOrdinal": selected_anchor.get("ordinal") if selected_anchor else None,
            "elapsedFromHeadMs": selected_anchor.get("elapsedFromHeadMs") if selected_anchor else None,
            "circleFit": circle,
        },
        "twoDimensionalCrop": {
            camera_id: row.get("cropBox") for camera_id, row in cameras.items() if row.get("available")
        },
        "cameras": cameras,
        "surfaceFit": surface_fit,
    }


def measurement_manifest_path(storage_root: Path, material_id: str) -> Path:
    return measurement_path(storage_root, material_id)


def build_and_write_flow_measurement(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment: dict[str, Any],
    *,
    calibration_path: Path | None = None,
    config: MeasurementConfig | None = None,
) -> tuple[Path, dict[str, Any]]:
    result = build_flow_measurement(
        camera_roots,
        material_id,
        alignment,
        calibration_path=calibration_path,
        config=config,
    )
    path = measurement_manifest_path(storage_root, material_id)
    _atomic_json(path, result)
    return path, result
