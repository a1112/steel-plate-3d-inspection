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
    center = height // 2 if row_index is None else max(0, min(height - 1, int(row_index)))
    half = max(1, config.row_window // 2)
    top = max(0, center - half)
    bottom = min(height, center + half + 1)
    step = max(1, math.ceil(width / config.maximum_profile_points))
    columns = np.arange(0, width, step, dtype=np.int32)
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
    crop = _crop_box(depth, intensity)
    if crop is None:
        raise ValueError("stable foreground source unavailable")
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
    residual = np.abs(np.linalg.norm(retained - center, axis=1) - radius)
    return {
        "available": True,
        "centerX": round(float(center[0]), 6),
        "centerZ": round(float(center[1]), 6),
        "radiusMm": round(radius, 6),
        "diameterMm": round(2.0 * radius, 6),
        "meanAbsResidualMm": round(float(np.mean(residual)), 6),
        "p95AbsResidualMm": round(float(np.percentile(residual, 95)), 6),
        "maxAbsResidualMm": round(float(np.max(residual)), 6),
        "pointCount": int(points.shape[0]),
        "robustPointCount": int(retained.shape[0]),
    }


def summarize_cylinder_sections(sections: list[dict[str, Any]]) -> dict[str, Any]:
    accepted = [
        section
        for section in sections
        if section.get("circleFit", {}).get("available")
        and math.isfinite(float(section["circleFit"].get("diameterMm", math.nan)))
    ]
    if len(accepted) < 2:
        return {
            "available": False,
            "reason": "not-enough-valid-sections",
            "sectionsRequested": len(sections),
            "sectionsAccepted": len(accepted),
            "sections": sections,
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
    return {
        "available": True,
        "model": "cylinder-sections-head-relative-time",
        "sectionsRequested": len(sections),
        "sectionsAccepted": len(accepted),
        "diameterMeanMm": round(float(np.mean(diameters)), 6),
        "diameterMinimumMm": round(float(np.min(diameters)), 6),
        "diameterMaximumMm": round(float(np.max(diameters)), 6),
        "diameterStdDevMm": round(float(np.std(diameters)), 6),
        "centerStraightnessMaximumMm": round(float(np.max(straightness)), 6),
        "headRelativeTimeSpanMs": round(max(elapsed) - min(elapsed), 6),
        "sections": sections,
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
    anchors = list(alignment.get("softSyncAnchors", []))
    selected_anchor = anchors[len(anchors) // 2] if anchors else None
    cameras: dict[str, Any] = {}
    global_profiles: list[np.ndarray] = []
    matrices: dict[str, np.ndarray] = {}
    calibrated = 0
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
                        "rowClipped": bool(mapping.get("rowClipped")),
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
    alignment_ok = bool(alignment.get("quality", {}).get("synchronized"))
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
        approved and alignment_ok and row_mapping_ok and every_camera_calibrated and residual_ok
    )
    reasons: list[str] = []
    if not alignment_ok:
        reasons.append("flow-not-synchronized")
    if not row_mapping_ok:
        reasons.append("cross-section-row-clipped")
    if not approved:
        reasons.append("approved-array-calibration-missing")
    if not every_camera_calibrated:
        reasons.append("camera-extrinsics-incomplete")
    if not residual_ok:
        reasons.append("circle-fit-residual-out-of-tolerance")
    section_fits: list[dict[str, Any]] = []
    if approved and every_camera_calibrated and alignment_ok and anchors:
        count = min(settings.maximum_sections, len(anchors))
        anchor_indices = sorted(
            set(int(value) for value in np.linspace(0, len(anchors) - 1, count))
        )
        for anchor_index in anchor_indices:
            anchor = anchors[anchor_index]
            section_points: list[np.ndarray] = []
            section_clipped = False
            for camera_id, camera_root in sorted(camera_roots.items()):
                mapping = anchor.get("cameras", {}).get(camera_id, {})
                if not mapping.get("available") or mapping.get("rowClipped"):
                    section_clipped = True
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
                    "circleFit": fit,
                }
            )
    surface_fit = summarize_cylinder_sections(section_fits)
    surface_metric_valid = bool(
        metric_valid
        and surface_fit.get("available")
        and all(section.get("rowMappingComplete") for section in section_fits)
        and all(
            float(section.get("circleFit", {}).get("p95AbsResidualMm", math.inf))
            <= settings.maximum_circle_residual_mm
            for section in section_fits
        )
    )
    surface_fit.update(
        {
            "metricValid": surface_metric_valid,
            "longitudinalCoordinate": "head-relative-time",
            "absoluteLongitudinalScaleVerified": False,
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
        "alignment": alignment.get("quality", {}),
        "calibration": {
            "path": str(calibration_path) if calibration_path else "",
            "available": bool(calibration),
            "approved": approved,
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
