"""Synchronized six-camera surface fitting and JET residual visualization.

The longitudinal axis remains display-only until a speed/encoder source is
connected.  Cross-section coordinates and radial residuals are real metric
values from the approved array calibration.
"""

from __future__ import annotations

import datetime as dt
import math
from pathlib import Path
from typing import Any

import numpy as np

from .alignment import _atomic_json
from .measurement import (
    CIRCLE_FIT_ALGORITHM,
    MEASUREMENT_SCHEMA,
    MeasurementConfig,
    _load_calibration,
    _calibration_metric_projection_valid,
    _matrix_for,
    _profile,
    _transform_profile,
    build_fixed_angle_diameter_curves,
    robust_circle_fit,
)
from .paths import (
    camera_surface_jet_path,
    capture_root,
    surface_jet_path,
    surface_path,
)


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
    if maximum_sections <= 0:
        return list(range(anchor_count))
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


def _strict_valid_mask(value: Any, expected_count: int) -> list[int] | None:
    """Validate a persisted vertex mask without coercing arbitrary values.

    Historical JSON must not turn strings such as ``"false"`` into truthy
    vertices.  The mask is part of the mesh topology contract, so a missing,
    truncated, overlong, or non-binary mask makes the archived mesh unusable
    and lets the history worker rebuild it from source frames.
    """
    if not isinstance(value, list) or len(value) != int(expected_count):
        return None
    normalized: list[int] = []
    for item in value:
        if isinstance(item, bool):
            normalized.append(int(item))
            continue
        if isinstance(item, (int, float, np.integer, np.floating)):
            number = float(item)
            if math.isfinite(number) and number in (0.0, 1.0):
                normalized.append(int(number))
                continue
        return None
    return normalized


def _within_metric_limit(value: float, limit: float) -> bool:
    """Avoid a quality flip caused only by sub-per-mille floating noise."""
    bounded_limit = max(0.001, float(limit))
    tolerance = max(1e-6, bounded_limit * 0.001)
    return math.isfinite(float(value)) and float(value) <= bounded_limit + tolerance


def apply_surface_quality_gate(
    measurement: dict[str, Any],
    surface: dict[str, Any],
) -> None:
    """Fail the aggregate measurement closed when the 3D surface gate fails.

    The initial measurement pass evaluates a representative cross-section.
    Surface reconstruction evaluates the full synchronized flow, including
    per-camera depth repeatability, radial calibration bias and pair overlap.
    A later, stricter surface failure must therefore also invalidate the
    aggregate metric result; a successful surface must never elevate an
    already-failed measurement.
    """
    quality = surface.get("quality")
    if not isinstance(quality, dict):
        return
    if quality.get("crossSectionMetricValid") is not False:
        return

    measurement["metricValid"] = False
    measurement["mode"] = "preview"
    gate = measurement.get("qualityGate")
    if not isinstance(gate, dict):
        gate = {}
        measurement["qualityGate"] = gate
    gate["passed"] = False
    reasons = gate.get("reasons")
    if not isinstance(reasons, list):
        reasons = []
    if "surface-quality-gate-failed" not in reasons:
        reasons.append("surface-quality-gate-failed")
    gate["reasons"] = reasons


def measurement_artifact_from_surface(
    surface: dict[str, Any],
    base_measurement: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the diameter endpoint artifact from the authoritative surface fit.

    Surface reconstruction already performs the calibrated multi-camera circle
    fits and fixed-angle diameter calculation.  Mirroring that result avoids a
    second NPZ pass while preserving the exact same metric quality gate.
    """
    material_id = str(surface.get("materialId", "")).strip()
    quality = surface.get("quality") if isinstance(surface.get("quality"), dict) else {}
    summary = surface.get("summary") if isinstance(surface.get("summary"), dict) else {}
    curves = (
        surface.get("diameterCurves")
        if isinstance(surface.get("diameterCurves"), dict)
        else {}
    )
    curve_sections = curves.get("sections") if isinstance(curves.get("sections"), list) else []
    position_by_anchor = {
        int(row.get("anchorOrdinal", index)): row.get("positionRatio")
        for index, row in enumerate(curve_sections)
        if isinstance(row, dict)
    }
    source_sections = surface.get("sections") if isinstance(surface.get("sections"), list) else []
    sections: list[dict[str, Any]] = []
    for index, source in enumerate(source_sections):
        if not isinstance(source, dict):
            continue
        anchor = int(source.get("anchorOrdinal", index) or 0)
        accepted = bool(source.get("acceptedForSurface"))
        section_quality = (
            source.get("qualityGate")
            if isinstance(source.get("qualityGate"), dict)
            else {"passed": accepted, "reasons": [] if accepted else ["surface-section-rejected"]}
        )
        sections.append(
            {
                "anchorOrdinal": anchor,
                "elapsedFromHeadMs": source.get("elapsedFromHeadMs"),
                "positionRatio": position_by_anchor.get(anchor),
                "rowMappingComplete": bool(source.get("mappingComplete")),
                "timeMappingValid": bool(source.get("mappingMetricValid")),
                "metricValid": accepted,
                "qualityGate": section_quality,
                "circleFit": source.get("circleFit", {}),
            }
        )
    accepted_sections = [row for row in sections if row.get("metricValid")]
    selected = (
        accepted_sections[len(accepted_sections) // 2]
        if accepted_sections
        else sections[len(sections) // 2]
        if sections
        else {}
    )
    diameters = np.asarray(
        [
            float(row.get("circleFit", {}).get("diameterMm"))
            for row in accepted_sections
            if _finite_float(row.get("circleFit", {}).get("diameterMm")) is not None
        ],
        dtype=np.float64,
    )
    roundness = [
        float(row.get("circleFit", {}).get("roundnessMm"))
        for row in accepted_sections
        if _finite_float(row.get("circleFit", {}).get("roundnessMm")) is not None
    ]
    fit_residuals = [
        float(row.get("circleFit", {}).get("p95AbsResidualMm"))
        for row in accepted_sections
        if _finite_float(row.get("circleFit", {}).get("p95AbsResidualMm")) is not None
    ]
    calibration = (
        surface.get("calibration")
        if isinstance(surface.get("calibration"), dict)
        else {}
    )
    jet = surface.get("jet") if isinstance(surface.get("jet"), dict) else {}
    metric_projection_verified = bool(
        quality.get(
            "metricProjectionVerified",
            calibration.get("metricProjectionVerified", False),
        )
    )
    metric_valid = bool(
        quality.get("crossSectionMetricValid")
        and metric_projection_verified
    )
    reasons = [str(value) for value in quality.get("reasons", [])]
    if not metric_projection_verified and "metric-projection-unverified" not in reasons:
        reasons.append("metric-projection-unverified")
    if not metric_valid and "surface-quality-gate-failed" not in reasons:
        reasons.append("surface-quality-gate-failed")
    surface_fit = {
        "available": len(accepted_sections) >= 2,
        "metricValid": metric_valid,
        "metricProjectionVerified": metric_projection_verified,
        "absoluteLongitudinalScaleVerified": bool(
            quality.get("absoluteLongitudinalScaleVerified", False)
        ),
        "model": "calibrated-six-camera-surface-sections",
        "circleFitAlgorithm": CIRCLE_FIT_ALGORITHM,
        "sectionGenerationPolicy": quality.get(
            "sectionGenerationPolicy", "all-soft-sync-anchors"
        ),
        "longitudinalCoordinate": "head-relative-time",
        "note": "Derived from the authoritative calibrated surface artifact without a second depth-data pass.",
        "sectionsRequested": len(sections),
        "sectionsAccepted": len(accepted_sections),
        "sectionsRejected": len(sections) - len(accepted_sections),
        "diameterMeanMm": summary.get("diameterMeanMm"),
        "diameterMedianMm": round(float(np.median(diameters)), 6) if diameters.size else None,
        "diameterMinimumMm": summary.get("diameterMinimumMm"),
        "diameterMaximumMm": summary.get("diameterMaximumMm"),
        "diameterStdDevMm": summary.get("diameterStdDevMm"),
        "diameterP05Mm": round(float(np.percentile(diameters, 5)), 6) if diameters.size else None,
        "diameterP95Mm": round(float(np.percentile(diameters, 95)), 6) if diameters.size else None,
        "diameterRangeMm": (
            round(float(np.max(diameters) - np.min(diameters)), 6)
            if diameters.size
            else None
        ),
        "roundnessMaximumMm": round(max(roundness), 6) if roundness else None,
        "fitResidualP95MaximumMm": round(max(fit_residuals), 6) if fit_residuals else None,
        "sections": sections,
        "diameterCurves": curves,
    }
    artifact = {
        "schema": MEASUREMENT_SCHEMA,
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "mode": "metric" if metric_valid else "preview",
        "metricValid": metric_valid,
        "qualityGate": {"passed": metric_valid, "reasons": reasons},
        "selectedSection": {
            "anchorOrdinal": selected.get("anchorOrdinal"),
            "elapsedFromHeadMs": selected.get("elapsedFromHeadMs"),
            "circleFit": selected.get("circleFit", {}),
        },
        "cameras": {},
        "surfaceFit": surface_fit,
        "surface": {
            "state": surface.get("state"),
            "quality": quality,
            "depthPrecision": surface.get("depthPrecision"),
            "calibrationAccuracy": surface.get("calibrationAccuracy"),
            "summary": summary,
        },
        "sourceArtifact": {
            "schema": surface.get("schema"),
            "generatedAt": surface.get("generatedAt"),
            "mode": "surface-derived-diameter",
            "circleFitAlgorithm": CIRCLE_FIT_ALGORITHM,
            "jetCalculation": jet.get("calculation"),
        },
    }
    if isinstance(base_measurement, dict):
        # The first measurement pass owns source crops and per-camera audit
        # profiles needed by the region builder. Diameter and fit values above
        # remain exclusively sourced from the newer surface calculation.
        for key in (
            "alignment",
            "calibration",
            "twoDimensionalCrop",
            "cameras",
            "regions",
        ):
            if key in base_measurement:
                artifact[key] = base_measurement[key]
    return artifact


def upgrade_surface_display_contract(
    surface: dict[str, Any],
) -> tuple[bool, bool]:
    """Upgrade an existing calibrated mesh without rereading its NPZ frames.

    Returns ``(usable, changed)``. A disconnected historical mesh is rejected
    so the archive worker can perform a full rebuild and recover diagnostic
    geometry from the original camera profiles.
    """
    mesh = surface.get("mesh")
    sections = surface.get("sections")
    if not isinstance(mesh, dict) or not isinstance(sections, list):
        return False, False
    try:
        rows = int(mesh.get("rows", 0) or 0)
        columns = int(mesh.get("columns", 0) or 0)
    except (TypeError, ValueError):
        return False, False
    positions = mesh.get("positions")
    if (
        rows <= 0
        or columns < 3
        or len(sections) < rows
        or not isinstance(positions, list)
        or len(positions) < rows * columns * 3
    ):
        return False, False

    contract = surface.get("crossSections")
    curves = surface.get("diameterCurves")
    if (
        isinstance(contract, dict)
        and contract.get("schema") == "steel.ranger3-cross-sections.v1"
        and mesh.get("pointUnit") == "mm"
        and mesh.get("crossSectionLayout") == "fused-angular-bins"
        and isinstance(curves, dict)
        and bool(curves.get("displayMode"))
    ):
        return bool(mesh.get("indices")), False

    raw_mask = mesh.get("validMask")
    valid_mask: list[int] = []
    residual_grid = np.full((rows, columns), np.nan, dtype=np.float64)
    longitudinal_positions: list[float | None] = []
    for row in range(rows):
        source = sections[row] if isinstance(sections[row], dict) else {}
        fit = source.get("circleFit") if isinstance(source.get("circleFit"), dict) else {}
        center_x = _finite_float(fit.get("centerX"))
        center_z = _finite_float(fit.get("centerZ"))
        radius = _finite_float(fit.get("radiusMm"))
        row_position: float | None = None
        for column in range(columns):
            vertex = row * columns + column
            offset = vertex * 3
            x = _finite_float(positions[offset])
            y = _finite_float(positions[offset + 1])
            z = _finite_float(positions[offset + 2])
            mask_valid = (
                not isinstance(raw_mask, list)
                or vertex >= len(raw_mask)
                or bool(raw_mask[vertex])
            )
            valid = bool(mask_valid and x is not None and y is not None and z is not None)
            valid_mask.append(1 if valid else 0)
            if not valid:
                continue
            row_position = y if row_position is None else row_position
            if center_x is not None and center_z is not None and radius is not None:
                residual_grid[row, column] = math.hypot(x - center_x, z - center_z) - radius
        longitudinal_positions.append(row_position)

    indices: list[int] = []
    for row in range(rows - 1):
        for column in range(columns):
            next_column = (column + 1) % columns
            vertices = (
                row * columns + column,
                row * columns + next_column,
                (row + 1) * columns + column,
                (row + 1) * columns + next_column,
            )
            if all(valid_mask[index] for index in vertices):
                first, second, third, fourth = vertices
                indices.extend([first, third, second, second, third, fourth])
    if not indices:
        return False, False

    quality = surface.get("quality") if isinstance(surface.get("quality"), dict) else {}
    metric_valid = bool(quality.get("crossSectionMetricValid"))
    accepted = any(
        isinstance(section, dict) and section.get("acceptedForSurface")
        for section in sections[:rows]
    )
    display_mode = (
        "metric" if metric_valid else "quality-gated-preview" if accepted else "diagnostic-unqualified"
    )
    longitudinal = mesh.get("longitudinal")
    if not isinstance(longitudinal, dict):
        finite_positions = [value for value in longitudinal_positions if value is not None]
        longitudinal = {
            "source": "historical-surface-mesh",
            "origin": "detected-steel-head",
            "displaySpan": (
                round(max(finite_positions) - min(finite_positions), 6)
                if finite_positions
                else 0.0
            ),
            "displayUnit": "cross-section-mm-scaled-preview",
            "absoluteScaleVerified": False,
        }
    else:
        longitudinal["absoluteScaleVerified"] = bool(
            longitudinal.get("absoluteScaleVerified", False)
        )

    diameter_curves = build_fixed_angle_diameter_curves(
        sections[:rows], residual_grid, surface_metric_valid=metric_valid
    )
    position_by_anchor = {
        int(item.get("anchorOrdinal", index) or 0): item.get("positionRatio")
        for index, item in enumerate(diameter_curves.get("sections", []))
        if isinstance(item, dict)
    }
    cross_sections: list[dict[str, Any]] = []
    for row, source in enumerate(sections[:rows]):
        section = source if isinstance(source, dict) else {}
        fit = section.get("circleFit") if isinstance(section.get("circleFit"), dict) else {}
        anchor = int(section.get("anchorOrdinal", row) or 0)
        section_metric_valid = bool(section.get("acceptedForSurface"))
        finite_points = int(np.count_nonzero(np.isfinite(residual_grid[row])))
        cross_sections.append(
            {
                "row": row,
                "meshRow": row,
                "anchorOrdinal": anchor,
                "elapsedFromHeadMs": section.get("elapsedFromHeadMs"),
                "positionRatio": position_by_anchor.get(anchor),
                "longitudinalDisplayPosition": longitudinal_positions[row],
                "available": finite_points >= 3 and bool(fit.get("available")),
                "metricValid": section_metric_valid,
                "displayMode": "metric" if section_metric_valid else "diagnostic-unqualified",
                "qualityGate": section.get("qualityGate", {}),
                "validPointCount": finite_points,
                "angularPointCount": columns,
                "circleFit": fit,
            }
        )

    mesh.update(
        {
            "displayMode": display_mode,
            "metricValid": metric_valid,
            "pointUnit": "mm",
            "crossSectionLayout": "fused-angular-bins",
            "longitudinal": longitudinal,
            "validMask": valid_mask,
            "indices": indices,
        }
    )
    surface["crossSections"] = {
        "schema": "steel.ranger3-cross-sections.v1",
        "coordinateSpace": "array-calibrated-cross-section-mm",
        "pointSource": "mesh.positions[meshRow,angularColumn]",
        "pointUnit": "mm",
        "angleConvention": "0deg:+X,positive:+Z,right-handed,array-calibration",
        "angularBins": columns,
        "longitudinal": longitudinal,
        "displayMode": display_mode,
        "metricValid": metric_valid,
        "sections": cross_sections,
    }
    surface["diameterCurves"] = diameter_curves
    jet = surface.get("jet")
    if isinstance(jet, dict):
        jet["metricValid"] = metric_valid
    surface["displayContractUpdatedAt"] = _utc_text()
    return True, True


def _head_aligned_longitudinal_axis(
    sections: list[dict[str, Any]],
    display_span: float,
) -> tuple[list[float], dict[str, Any]]:
    """Place the first and last complete reconstructed sections at the ends.

    Scanner timestamps provide a reliable head-relative ordering but there is
    no encoder-derived millimetre scale yet.  Keep the 3D preview aspect ratio
    bounded while preserving the actual time spacing between accepted
    sections.  Partial entry/exit sections remain in the audit list but do not
    move the visible reconstructed head or tail away from the mesh ends.
    """
    elapsed = [
        _finite_float(section.get("elapsedFromHeadMs"))
        for section in sections
    ]
    qualified = [
        value
        for section, value in zip(sections, elapsed)
        if section.get("acceptedForSurface") and value is not None
    ]
    available = [value for value in elapsed if value is not None]
    origin = min(qualified) if qualified else min(available, default=0.0)
    end = max(qualified) if qualified else max(available, default=origin)
    duration = max(0.0, end - origin)
    bounded_span = max(1.0, float(display_span))
    positions: list[float] = []
    for row, value in enumerate(elapsed):
        if value is None:
            ratio = row / max(1, len(sections) - 1)
        elif duration > 0.0:
            ratio = float(np.clip((value - origin) / duration, 0.0, 1.0))
        else:
            ratio = 0.0
        positions.append(ratio * bounded_span)
    return positions, {
        "source": "soft-sync-anchor-head-relative-time",
        "origin": "first-qualified-complete-cross-section",
        "originElapsedFromHeadMs": round(origin, 6),
        "endElapsedFromHeadMs": round(end, 6),
        "qualifiedDurationMs": round(duration, 6),
        "headTransitionTrimMs": round(max(0.0, origin), 6),
        "displaySpan": round(bounded_span, 6),
        "displayUnit": "cross-section-mm-scaled-preview",
        "absoluteScaleVerified": False,
    }


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
        source_columns.astype(int), residuals, angles
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


def _camera_radial_quality(
    points: np.ndarray,
    fit: dict[str, Any],
    maximum_error_mm: float,
) -> dict[str, Any]:
    """Separate per-camera depth repeatability from calibration radial bias."""
    if not fit.get("available") or points.ndim != 2 or points.shape[0] == 0:
        return {
            "available": False,
            "metricValid": False,
            "reason": "camera-radial-quality-unavailable",
        }
    center = np.asarray(
        [float(fit["centerX"]), float(fit["centerZ"])], dtype=np.float64
    )
    signed = np.linalg.norm(points - center, axis=1) - float(fit["radiusMm"])
    signed = signed[np.isfinite(signed)]
    if not signed.size:
        return {
            "available": False,
            "metricValid": False,
            "reason": "camera-radial-quality-unavailable",
        }
    radial_bias = float(np.median(signed))
    centered = signed - radial_bias
    absolute_centered = np.abs(centered)
    depth_precision_p95 = float(np.percentile(absolute_centered, 95))
    p95_absolute = float(np.percentile(np.abs(signed), 95))
    threshold = max(0.001, float(maximum_error_mm))
    precision_valid = _within_metric_limit(depth_precision_p95, threshold)
    bias_valid = _within_metric_limit(abs(radial_bias), threshold)
    return {
        "available": True,
        "metricValid": precision_valid and bias_valid,
        "pointCount": int(signed.size),
        "radialBiasMedianMm": round(radial_bias, 6),
        "depthPrecisionMadMm": round(
            float(np.median(absolute_centered)), 6
        ),
        "depthPrecisionP95Mm": round(depth_precision_p95, 6),
        "depthPrecisionMaximumMm": round(float(np.max(absolute_centered)), 6),
        "p95AbsoluteRadialErrorMm": round(p95_absolute, 6),
        "precisionThresholdMm": round(threshold, 6),
        "depthPrecisionMetricValid": precision_valid,
        "calibrationBiasMetricValid": bias_valid,
    }


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
            pair_p95 = float(np.percentile(differences, 95))
            pairs.append(
                {
                    "cameras": [left_id, right_id],
                    "sampleCount": int(differences.size),
                    "p95AbsRadialDifferenceMm": round(pair_p95, 6),
                    "maximumAbsRadialDifferenceMm": round(
                        float(np.max(differences)), 6
                    ),
                    "overlapAngularBinIndices": np.flatnonzero(overlap).astype(int).tolist(),
                    "metricValid": _within_metric_limit(
                        pair_p95, maximum_p95_difference_mm
                    ),
                }
            )
    values = np.asarray(all_differences, dtype=np.float64)
    p95 = float(np.percentile(values, 95)) if values.size else None
    maximum = float(np.max(values)) if values.size else None
    overlap_required = len(profiles) > 1
    reasons: list[str] = []
    if overlap_required and not values.size:
        reasons.append("calibrated-camera-overlap-unavailable")
    if p95 is not None and not _within_metric_limit(
        p95, maximum_p95_difference_mm
    ):
        reasons.append("calibrated-camera-overlap-out-of-tolerance")
    if any(not pair.get("metricValid") for pair in pairs):
        reasons.append("calibrated-camera-pair-overlap-out-of-tolerance")
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
    diagnostic_fallback: bool = False,
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
            if (accepted or diagnostic_fallback) and 0 <= local_column < columns:
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
            "source": (
                "diagnostic-unqualified"
                if diagnostic_fallback
                else "quality-gated-surface"
            ),
            "metricValid": not diagnostic_fallback,
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
    diagnostic_grids: list[np.ndarray] = []
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
        diagnostic_grids.append(grid.copy())
        observed_bins = int(np.count_nonzero(np.isfinite(grid)))
        overlap_consistency = _camera_overlap_consistency(
            transformed_profiles,
            fit,
            angular_bins,
            settings.maximum_circle_residual_mm,
        )
        camera_radial_quality = {
            camera_id: _camera_radial_quality(
                profile,
                fit,
                settings.maximum_circle_residual_mm,
            )
            for camera_id, profile in transformed_profiles.items()
        }
        for camera_id, quality in camera_radial_quality.items():
            camera_details.setdefault(camera_id, {})["radialQuality"] = quality
        depth_precision_complete = bool(
            len(camera_radial_quality) == len(camera_roots)
            and all(
                quality.get("depthPrecisionMetricValid")
                for quality in camera_radial_quality.values()
            )
        )
        calibration_bias_complete = bool(
            len(camera_radial_quality) == len(camera_roots)
            and all(
                quality.get("calibrationBiasMetricValid")
                for quality in camera_radial_quality.values()
            )
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
            and depth_precision_complete
            and calibration_bias_complete
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
        if not depth_precision_complete:
            section_reasons.append("camera-depth-precision-out-of-tolerance")
        if not calibration_bias_complete:
            section_reasons.append("camera-calibration-bias-out-of-tolerance")
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
                "cameraDepthPrecisionMetricValid": depth_precision_complete,
                "cameraCalibrationBiasMetricValid": calibration_bias_complete,
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
    diagnostic_grid = (
        np.vstack(diagnostic_grids)
        if diagnostic_grids
        else np.empty((0, angular_bins))
    )
    count_grid = np.vstack(counts) if counts else np.empty((0, angular_bins), dtype=np.int32)
    finite_values = residual_grid[np.isfinite(residual_grid)]
    if not finite_values.size:
        finite_values = diagnostic_grid[np.isfinite(diagnostic_grid)]
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
    interior_sections = sections[1:-1] if len(sections) > 2 else sections
    diagnostic_sections = [
        row
        for row in interior_sections
        if row.get("mappingComplete")
        and row.get("mappingMetricValid")
        and row.get("circleFit", {}).get("available")
        and float(row.get("circleFit", {}).get("p95AbsResidualMm", math.inf))
        <= settings.maximum_circle_residual_mm
        and int(row.get("angularBinsObserved", 0))
        >= math.ceil(angular_bins * 0.80)
    ]
    camera_accuracy: dict[str, dict[str, Any]] = {}
    for camera_id in sorted(camera_roots):
        samples = [
            row.get("cameras", {}).get(camera_id, {}).get("radialQuality", {})
            for row in diagnostic_sections
        ]
        samples = [sample for sample in samples if sample.get("available")]
        precision_values = [
            float(sample["depthPrecisionP95Mm"])
            for sample in samples
            if _finite_float(sample.get("depthPrecisionP95Mm")) is not None
        ]
        bias_values = [
            float(sample["radialBiasMedianMm"])
            for sample in samples
            if _finite_float(sample.get("radialBiasMedianMm")) is not None
        ]
        camera_accuracy[camera_id] = {
            "sampledSectionCount": len(samples),
            "depthPrecisionP95MedianMm": (
                round(float(np.median(precision_values)), 6)
                if precision_values
                else None
            ),
            "depthPrecisionP95MaximumMm": (
                round(max(precision_values), 6) if precision_values else None
            ),
            "calibrationRadialBiasMedianMm": (
                round(float(np.median(bias_values)), 6) if bias_values else None
            ),
            "calibrationRadialBiasP95AbsMm": (
                round(float(np.percentile(np.abs(bias_values), 95)), 6)
                if bias_values
                else None
            ),
            "depthPrecisionMetricValid": bool(
                precision_values
                and _within_metric_limit(
                    max(precision_values), settings.maximum_circle_residual_mm
                )
            ),
            "calibrationBiasMetricValid": bool(
                bias_values
                and _within_metric_limit(
                    max(abs(value) for value in bias_values),
                    settings.maximum_circle_residual_mm,
                )
            ),
        }
    depth_precision_metric_valid = bool(
        camera_accuracy
        and all(
            item.get("depthPrecisionMetricValid")
            for item in camera_accuracy.values()
        )
    )
    calibration_bias_metric_valid = bool(
        camera_accuracy
        and all(
            item.get("calibrationBiasMetricValid")
            for item in camera_accuracy.values()
        )
    )
    calibration_overlap_metric_valid = bool(
        diagnostic_sections
        and all(
            row.get("cameraOverlapConsistency", {}).get("metricValid")
            for row in diagnostic_sections
        )
    )
    calibration_accuracy_metric_valid = bool(
        approved
        and calibration_bias_metric_valid
        and calibration_overlap_metric_valid
    )
    if not depth_precision_metric_valid:
        reasons.append("camera-depth-precision-out-of-tolerance")
    if not calibration_accuracy_metric_valid:
        reasons.append("camera-calibration-accuracy-out-of-tolerance")
    cross_section_metric_valid = bool(
        cross_section_metric_valid
        and depth_precision_metric_valid
        and calibration_accuracy_metric_valid
    )
    diameter_curves = build_fixed_angle_diameter_curves(
        sections,
        residual_grid,
        surface_metric_valid=cross_section_metric_valid,
    )
    overlap_pairs = [
        {
            **pair,
            "anchorOrdinal": row.get("anchorOrdinal"),
            "elapsedFromHeadMs": row.get("elapsedFromHeadMs"),
        }
        for row in diagnostic_sections
        for pair in row.get("cameraOverlapConsistency", {}).get("pairs", [])
        if _finite_float(pair.get("p95AbsRadialDifferenceMm")) is not None
    ]
    worst_overlap_pair = (
        max(
            overlap_pairs,
            key=lambda pair: float(pair["p95AbsRadialDifferenceMm"]),
        )
        if overlap_pairs
        else None
    )

    camera_tiles: list[dict[str, Any]] = []
    for camera_id in sorted(camera_roots):
        tile, _tile_grid = _camera_tile_payload(
            camera_id,
            camera_samples[camera_id],
            region_map=region_map,
            fixed_angle_deg=camera_fixed_angles[camera_id],
            display_range_mm=display_range,
            diagnostic_fallback=not accepted,
        )
        camera_tiles.append(tile)

    positions: list[float | None] = []
    colors: list[float] = []
    valid_mask: list[int] = []
    indices: list[int] = []
    representative_radius = float(np.median(diameters) / 2.0) if diameters.size else 1.0
    longitudinal_span = max(1.0, representative_radius * 4.0)
    longitudinal_positions, longitudinal_axis = _head_aligned_longitudinal_axis(
        sections,
        longitudinal_span,
    )
    common_overlap_ms = _finite_float(
        alignment.get("quality", {}).get("commonSteelOverlapMs")
    )
    if common_overlap_ms is not None:
        longitudinal_axis["commonSteelOverlapMs"] = round(common_overlap_ms, 6)
        longitudinal_axis["tailTransitionTrimMs"] = round(
            max(
                0.0,
                common_overlap_ms
                - float(longitudinal_axis["endElapsedFromHeadMs"]),
            ),
            6,
        )
    accepted_finite = np.isfinite(residual_grid)
    accepted_quads = (
        accepted_finite[:-1]
        & np.roll(accepted_finite[:-1], -1, axis=1)
        & accepted_finite[1:]
        & np.roll(accepted_finite[1:], -1, axis=1)
        if residual_grid.shape[0] >= 2
        else np.zeros((0, angular_bins), dtype=bool)
    )
    diagnostic_mesh = not bool(np.any(accepted_quads))
    display_residual_grid = diagnostic_grid if diagnostic_mesh else residual_grid
    row_count = display_residual_grid.shape[0]
    jet_valid_bin_count = int(np.count_nonzero(np.isfinite(display_residual_grid)))
    jet_source_sample_count = int(np.sum(count_grid, dtype=np.int64))
    for row in range(row_count):
        y = longitudinal_positions[row]
        fit = sections[row].get("circleFit", {})
        radius = float(fit.get("radiusMm", representative_radius))
        center_x = float(fit.get("centerX", 0.0))
        center_z = float(fit.get("centerZ", 0.0))
        for column in range(angular_bins):
            residual = display_residual_grid[row, column]
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

    curve_position_by_anchor = {
        int(item.get("anchorOrdinal", index) or 0): item.get("positionRatio")
        for index, item in enumerate(diameter_curves.get("sections", []))
        if isinstance(item, dict)
    }
    cross_sections = []
    for row, section in enumerate(sections):
        fit = section.get("circleFit", {})
        finite_points = int(
            np.count_nonzero(np.isfinite(display_residual_grid[row]))
        ) if row < display_residual_grid.shape[0] else 0
        anchor = int(section.get("anchorOrdinal", row) or 0)
        metric_valid = bool(section.get("acceptedForSurface"))
        cross_sections.append(
            {
                "row": row,
                "meshRow": row,
                "anchorOrdinal": anchor,
                "elapsedFromHeadMs": section.get("elapsedFromHeadMs"),
                "positionRatio": curve_position_by_anchor.get(anchor),
                "longitudinalDisplayPosition": (
                    round(float(longitudinal_positions[row]), 6)
                    if row < len(longitudinal_positions)
                    else None
                ),
                "available": finite_points >= 3 and bool(fit.get("available")),
                "metricValid": metric_valid,
                "displayMode": "metric" if metric_valid else "diagnostic-unqualified",
                "qualityGate": section.get("qualityGate", {}),
                "validPointCount": finite_points,
                "angularPointCount": angular_bins,
                "circleFit": fit,
            }
        )

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
            "cameraOverlapMetricValid": calibration_overlap_metric_valid,
            "depthPrecisionMetricValid": depth_precision_metric_valid,
            "cameraCalibrationBiasMetricValid": calibration_bias_metric_valid,
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
            "sectionGenerationPolicy": (
                "all-soft-sync-anchors"
                if settings.maximum_sections <= 0
                else "uniformly-sampled-soft-sync-anchors"
            ),
            "passed": cross_section_metric_valid,
            "reasons": reasons,
            "rejectedTransitionSections": len(sections) - len(accepted),
            "angularCoverageRatio": round(coverage, 6),
        },
        "depthPrecision": {
            "metricValid": depth_precision_metric_valid,
            "definition": "per-camera-p95-absolute-radial-error-after-median-bias-removal",
            "thresholdMm": settings.maximum_circle_residual_mm,
            "diagnosticSectionCount": len(diagnostic_sections),
            "cameras": camera_accuracy,
        },
        "calibrationAccuracy": {
            "metricValid": calibration_accuracy_metric_valid,
            "overlapP95ThresholdMm": settings.maximum_circle_residual_mm,
            "radialBiasThresholdMm": settings.maximum_circle_residual_mm,
            "diagnosticSectionCount": len(diagnostic_sections),
            "worstOverlapPair": worst_overlap_pair,
            "cameras": camera_accuracy,
        },
        "coordinateSystem": {
            "x": "cross-section-horizontal-mm",
            "y": "display-only-head-relative-position",
            "z": "cross-section-vertical-mm",
            "longitudinalSource": "soft-sync-anchor-head-relative-time",
            "longitudinalScale": "not-metric-until-speed-or-encoder-is-connected",
        },
        "headAlignment": {
            "referenceCameraId": alignment.get("referenceCameraId"),
            "origin": "detected-steel-head",
            "aligned": bool(geometry_synchronized),
            "mode": alignment.get("headAlignment", {}).get("mode"),
            "displayAligned": bool(
                alignment.get("headAlignment", {}).get("displayAligned")
            ),
            "referenceTimelinePositionFrames": alignment.get(
                "headAlignment", {}
            ).get("referenceTimelinePositionFrames"),
            "alignedTimelinePositionFrames": alignment.get(
                "headAlignment", {}
            ).get("alignedTimelinePositionFrames"),
            "timelineSpreadFrames": alignment.get("headAlignment", {}).get(
                "timelineSpreadFrames"
            ),
            "maximumDisplayPaddingFrames": alignment.get(
                "headAlignment", {}
            ).get("maximumDisplayPaddingFrames"),
            "cameras": {
                camera_id: {
                    "detected": bool(camera.get("head", {}).get("detected")),
                    "clipped": bool(camera.get("head", {}).get("clipped")),
                    "confidence": camera.get("head", {}).get("confidence"),
                    "frameIndex": camera.get("head", {}).get("frameIndex"),
                    "row": camera.get("head", {}).get("row"),
                    "globalRow": camera.get("head", {}).get("globalRow"),
                    "offsetRowsFromReference": camera.get("head", {}).get(
                        "offsetRowsFromReference"
                    ),
                    "captureRound": camera.get("head", {}).get("captureRound"),
                    "timelinePositionFrames": camera.get("head", {}).get(
                        "timelinePositionFrames"
                    ),
                    "offsetFramesFromReference": camera.get("head", {}).get(
                        "offsetFramesFromReference"
                    ),
                    "offsetMsFromReference": camera.get("head", {}).get(
                        "offsetMsFromReference"
                    ),
                    "displayPaddingFrames": camera.get("head", {}).get(
                        "displayPaddingFrames"
                    ),
                    "displayPaddingRows": camera.get("head", {}).get(
                        "displayPaddingRows"
                    ),
                    "alignedTimelinePositionFrames": camera.get("head", {}).get(
                        "alignedTimelinePositionFrames"
                    ),
                    "displayAligned": bool(
                        camera.get("head", {}).get("displayAligned")
                    ),
                    "expandedSearch": bool(
                        camera.get("head", {}).get("expandedSearch")
                    ),
                }
                for camera_id, camera in sorted(
                    alignment.get("cameras", {}).items()
                )
            },
        },
        "summary": {
            "sectionCount": len(sections),
            "acceptedSectionCount": len(accepted),
            "diameterMeanMm": round(float(np.mean(diameters)), 6) if diameters.size else None,
            "diameterMinimumMm": round(float(np.min(diameters)), 6) if diameters.size else None,
            "diameterMaximumMm": round(float(np.max(diameters)), 6) if diameters.size else None,
            "diameterStdDevMm": round(float(np.std(diameters)), 6) if diameters.size else None,
            "jetResidualRangeMm": round(display_range, 6),
            "jetValidBinCount": jet_valid_bin_count,
            "jetSourceSampleCount": jet_source_sample_count,
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
            "displayMode": (
                "metric"
                if cross_section_metric_valid
                else "diagnostic-unqualified"
                if diagnostic_mesh
                else "quality-gated-preview"
            ),
            "metricValid": cross_section_metric_valid,
            "pointUnit": "mm",
            "crossSectionLayout": "fused-angular-bins",
            "longitudinal": longitudinal_axis,
            "positions": positions,
            "colors": [round(value, 5) for value in colors],
            "indices": indices,
            "validMask": valid_mask,
        },
        "crossSections": {
            "schema": "steel.ranger3-cross-sections.v1",
            "coordinateSpace": "array-calibrated-cross-section-mm",
            "pointSource": "mesh.positions[meshRow,angularColumn]",
            "pointUnit": "mm",
            "angleConvention": "0deg:+X,positive:+Z,right-handed,array-calibration",
            "angularBins": angular_bins,
            "longitudinal": longitudinal_axis,
            "displayMode": (
                "metric"
                if cross_section_metric_valid
                else "diagnostic-unqualified"
                if diagnostic_mesh
                else "quality-gated-preview"
            ),
            "metricValid": cross_section_metric_valid,
            "sections": cross_sections,
        },
        "jet": {
            "palette": "JET",
            "calculation": "measured-radius-minus-robust-section-circle-radius-mm",
            "circleFitAlgorithm": CIRCLE_FIT_ALGORITHM,
            "source": (
                "quality-gated-surface" if accepted else "diagnostic-unqualified"
            ),
            "metricValid": cross_section_metric_valid,
            "minimumMm": round(-display_range, 6),
            "maximumMm": round(display_range, 6),
            "zeroMm": 0.0,
            "missingColor": "#07121b",
            "validBinCount": jet_valid_bin_count,
            "sourceSampleCount": jet_source_sample_count,
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
    return payload, residual_grid if np.any(np.isfinite(residual_grid)) else diagnostic_grid


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
) -> tuple[Path, dict[str, Any]]:
    payload, _residuals = build_flow_surface(
        camera_roots,
        material_id,
        alignment,
        calibration_path=calibration_path,
        config=config,
        angular_bins=angular_bins,
        region_map=region_map,
    )
    payload["jet"].pop("imagePath", None)
    payload["jet"]["storage"] = "per-frame-two-level-renditions"
    for tile in payload.get("cameraTiles", {}).get("cameras", []):
        tile.setdefault("jet", {}).pop("imagePath", None)
        tile.setdefault("jet", {})["storage"] = "per-frame-two-level-renditions"
    path = surface_path(storage_root, material_id)
    _atomic_json(path, payload)
    # Aggregate surface JPEGs were lossy duplicates which could outlive the
    # fitting revision that produced them. The fitted JSON and eager per-frame
    # two-level JET renditions are now the only authoritative representations.
    for camera_root in camera_roots.values():
        for legacy in (
            camera_surface_jet_path(camera_root, material_id),
            surface_jet_path(camera_root, material_id),
        ):
            if legacy.is_file() and not legacy.is_symlink():
                legacy.unlink()
    legacy_root = surface_path(storage_root, material_id).parent
    for legacy in [legacy_root / "surface-jet.png", *legacy_root.glob("surface-jet-c*.png")]:
        if legacy.is_file() and not legacy.is_symlink():
            legacy.unlink()
    return path, payload
