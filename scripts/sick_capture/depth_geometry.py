"""Pure, review-only 3-D depth geometry defect detection for SICK frames.

This module deliberately has no dependency on the ONNX detector or on the
surface/calibration quality gate.  It operates on each camera's local depth
planes and reports pixel-space geometry candidates.  Longitudinal millimetres
and physical area are intentionally left unavailable: the SICK line-scan
capture does not provide an encoder scale that can make those measurements
authoritative.

The public entry points are :func:`detect_depth_geometry` for in-memory frames
and :func:`build_flow_depth_geometry` for the camera-root storage layout used
by the SICK capture service.  All output is JSON-compatible except the small
ROI rendering helpers, which return ``numpy`` arrays (or a Pillow image when
requested by the caller).
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import numpy as np
from PIL import Image

from .paths import capture_root


DEPTH_GEOMETRY_SCHEMA = "steel.sick-depth-geometry.v1"
DEPTH_GEOMETRY_CONFIG_SCHEMA = "steel.sick-depth-geometry-config.v1"
DEPTH_GEOMETRY_SOURCE = "sick-depth-geometry"


def _first(mapping: Mapping[str, Any], *names: str, default: Any = None) -> Any:
    """Return the first present value, accepting snake/camel JSON names."""

    for name in names:
        if name in mapping:
            return mapping[name]
        camel = "".join(
            part.capitalize() if index else part
            for index, part in enumerate(name.split("_"))
        )
        if camel in mapping:
            return mapping[camel]
    return default


def _finite_float(value: Any, default: float | None = None) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def _bounded_int(value: Any, lower: int, upper: int, default: int) -> int:
    try:
        return max(lower, min(upper, int(value)))
    except (TypeError, ValueError):
        return default


def _float_or(value: Any, default: float) -> float:
    parsed = _finite_float(value)
    return float(default if parsed is None else parsed)


@dataclass(frozen=True)
class DepthGeometryConfig:
    """Configuration for the local depth residual/rule detector.

    Values are intentionally explicit and bounded.  ``roi`` uses the source
    image convention ``[left, top, right, bottom]`` and is applied equally to
    every frame in a flow.  A missing ROI means the common full-frame extent.
    """

    schema: str = DEPTH_GEOMETRY_CONFIG_SCHEMA
    enabled: bool = True
    revision: int = 1
    roi: tuple[int, int, int, int] | None = None
    baseline_max_frames: int = 32
    baseline_row_step: int = 4
    minimum_depth_mm: float = 1.2
    noise_multiplier: float = 6.0
    support_window: int = 3
    minimum_support: int = 3
    minimum_component_points: int = 16
    maximum_candidates_per_flow: int = 100
    cross_frame_max_gap: int = 1
    cross_frame_merge_pixels: int = 2
    minimum_merge_iou: float = 0.20
    elongated_aspect_ratio: float = 3.0
    horizontal_pixel_pitch_mm: float | None = None
    horizontal_origin_mm: float = 0.0
    calibration_valid: bool = False
    roi_padding: int = 8
    review_crop_minimum_size: int = 64
    jet_range_mm: float = 2.0
    max_frames: int = 0
    # Alignment head/tail detections identify the first/last frame that may
    # contain steel, but those frames are often partial transition blocks.
    # Keep a bounded temporal guard around the reliable detections.
    longitudinal_edge_guard_frames: int = 8
    # Camera flows are independent filesystems/streams.  Bound parallelism so
    # six-camera processing cannot create an unbounded decode fan-out.
    camera_workers: int = 4
    # A stable version can be raised by the administrator when rule semantics
    # change without changing the threshold values.
    rule_version: str = "1"

    def bounded(self) -> "DepthGeometryConfig":
        roi: tuple[int, int, int, int] | None = None
        if self.roi is not None:
            try:
                values = tuple(int(item) for item in self.roi)
            except (TypeError, ValueError):
                values = ()
            if len(values) == 4:
                left, top, right, bottom = values
                if right > left and bottom > top:
                    roi = (max(0, left), max(0, top), right, bottom)
        pitch = _finite_float(self.horizontal_pixel_pitch_mm)
        if pitch is not None and pitch <= 0:
            pitch = None
        return replace(
            self,
            schema=DEPTH_GEOMETRY_CONFIG_SCHEMA,
            enabled=bool(self.enabled),
            revision=_bounded_int(self.revision, 1, 2_147_483_647, 1),
            roi=roi,
            baseline_max_frames=_bounded_int(
                self.baseline_max_frames, 1, 32, 32
            ),
            baseline_row_step=_bounded_int(self.baseline_row_step, 1, 64, 4),
            minimum_depth_mm=max(
                0.0, _float_or(self.minimum_depth_mm, 1.2)
            ),
            noise_multiplier=max(
                0.0, _float_or(self.noise_multiplier, 6.0)
            ),
            support_window=3,
            minimum_support=_bounded_int(self.minimum_support, 1, 9, 3),
            minimum_component_points=_bounded_int(
                self.minimum_component_points, 1, 1_000_000, 16
            ),
            maximum_candidates_per_flow=_bounded_int(
                self.maximum_candidates_per_flow, 1, 100, 100
            ),
            cross_frame_max_gap=_bounded_int(self.cross_frame_max_gap, 0, 32, 1),
            cross_frame_merge_pixels=_bounded_int(
                self.cross_frame_merge_pixels, 0, 64, 2
            ),
            minimum_merge_iou=max(
                0.0, min(1.0, _float_or(self.minimum_merge_iou, 0.20))
            ),
            elongated_aspect_ratio=max(
                1.0, _float_or(self.elongated_aspect_ratio, 3.0)
            ),
            horizontal_pixel_pitch_mm=pitch,
            horizontal_origin_mm=(
                _float_or(self.horizontal_origin_mm, 0.0)
            ),
            calibration_valid=bool(self.calibration_valid),
            roi_padding=_bounded_int(self.roi_padding, 0, 256, 8),
            review_crop_minimum_size=_bounded_int(
                self.review_crop_minimum_size, 8, 1024, 64
            ),
            jet_range_mm=max(0.01, _float_or(self.jet_range_mm, 2.0)),
            max_frames=_bounded_int(self.max_frames, 0, 10_000_000, 0),
            longitudinal_edge_guard_frames=_bounded_int(
                self.longitudinal_edge_guard_frames, 0, 64, 8
            ),
            camera_workers=_bounded_int(self.camera_workers, 1, 6, 4),
            rule_version=str(self.rule_version or "1"),
        )

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any] | None) -> "DepthGeometryConfig":
        if value is None:
            return cls().bounded()
        # Accept a wrapped config as used by algorithm.json and admin APIs.
        source: Mapping[str, Any] = value
        for key in ("depthGeometry", "depth_geometry", "geometry"):
            nested = value.get(key)
            if isinstance(nested, Mapping):
                source = nested
                break
        kwargs: dict[str, Any] = {}
        names = {
            field_name
            for field_name in cls.__dataclass_fields__
            if field_name != "schema"
        }
        for field_name in names:
            found = _first(source, field_name, default=None)
            if found is not None:
                kwargs[field_name] = found
        # The seed config intentionally groups the tunables by function.  Keep
        # the dataclass flat for Python callers while accepting that stable
        # JSON shape (and its camelCase names) for runtime/admin updates.
        baseline = source.get("baseline")
        thresholds = source.get("thresholds")
        merge = source.get("merge")
        baseline = baseline if isinstance(baseline, Mapping) else {}
        thresholds = thresholds if isinstance(thresholds, Mapping) else {}
        merge = merge if isinstance(merge, Mapping) else {}
        nested_names: dict[str, tuple[Mapping[str, Any], tuple[str, ...]]] = {
            "baseline_max_frames": (
                baseline,
                ("maximumFrames", "maxFrames", "maximum_frames"),
            ),
            "baseline_row_step": (
                baseline,
                ("rowSampleStep", "baselineRowStep", "row_step"),
            ),
            "minimum_depth_mm": (
                thresholds,
                ("minimumAbsoluteDeviationMm", "minimumDepthMm"),
            ),
            "noise_multiplier": (
                thresholds,
                ("columnNoiseMultiplier", "noiseMultiplier"),
            ),
            "minimum_support": (
                thresholds,
                ("minimumNeighborhoodSupport", "minimumSupport"),
            ),
            "minimum_component_points": (
                thresholds,
                ("minimumComponentPoints",),
            ),
            "elongated_aspect_ratio": (
                thresholds,
                ("elongatedAspectRatio",),
            ),
            "cross_frame_max_gap": (
                merge,
                ("maximumFrameGap", "crossFrameMaxGap"),
            ),
            "cross_frame_merge_pixels": (
                merge,
                ("crossFrameMergePixels", "mergePixels"),
            ),
            "minimum_merge_iou": (
                merge,
                ("minimumIoU", "minimumIou", "minimumMergeIoU"),
            ),
            "review_crop_minimum_size": (
                source,
                ("reviewCropMinimumSize",),
            ),
        }
        for field_name, (nested, nested_keys) in nested_names.items():
            if field_name in kwargs:
                continue
            found = _first(nested, *nested_keys, default=None)
            if found is not None:
                kwargs[field_name] = found
        if "schema" in source and source.get("schema"):
            kwargs["schema"] = str(source["schema"])
        roi = kwargs.get("roi")
        if roi is not None:
            try:
                kwargs["roi"] = tuple(int(item) for item in roi)
            except (TypeError, ValueError):
                kwargs["roi"] = None
        return cls(**kwargs).bounded()

    @classmethod
    def from_json(cls, path: str | Path) -> "DepthGeometryConfig":
        # The module-level loader performs the schema check while this class
        # method keeps the convenient dataclass-oriented API.
        return load_depth_geometry_config(path)

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self.bounded())
        if result.get("roi") is not None:
            result["roi"] = list(result["roi"])
        return result

    @property
    def minimum_iou(self) -> float:
        """Compatibility alias for the seed's ``merge.minimumIoU`` field."""

        return self.minimum_merge_iou


def load_depth_geometry_config(path: str | Path) -> DepthGeometryConfig:
    """Load and validate the depth geometry section from an algorithm JSON."""

    with Path(path).open("r", encoding="utf-8-sig") as stream:
        payload = json.load(stream)
    if not isinstance(payload, Mapping):
        raise ValueError("depth geometry config JSON must be an object")
    nested = payload.get("depthGeometry", payload.get("depth_geometry"))
    candidate = nested if isinstance(nested, Mapping) else payload
    if candidate.get("schema") != DEPTH_GEOMETRY_CONFIG_SCHEMA:
        raise ValueError(
            f"depth geometry schema must be {DEPTH_GEOMETRY_CONFIG_SCHEMA}"
        )
    return DepthGeometryConfig.from_mapping(payload)


def parse_depth_geometry_config(
    value: Mapping[str, Any] | None,
) -> DepthGeometryConfig:
    """Parse an in-memory seed/admin value (convenience API)."""

    return DepthGeometryConfig.from_mapping(value)


def config_hash(config: DepthGeometryConfig | Mapping[str, Any]) -> str:
    """Return the deterministic hash used for backfill/config traceability."""

    normalized = (
        config.bounded().to_dict()
        if isinstance(config, DepthGeometryConfig)
        else DepthGeometryConfig.from_mapping(config).to_dict()
    )
    encoded = json.dumps(
        normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class DepthFrame:
    """Decoded depth frame with source metadata."""

    millimeters: np.ndarray
    valid: np.ndarray
    frame_number: int
    metadata: Mapping[str, Any] = field(default_factory=dict)
    intensity: np.ndarray | None = None
    source_path: str | None = None


@dataclass(frozen=True)
class BaselineEstimate:
    baseline_mm: np.ndarray
    column_noise_mm: np.ndarray
    sampled_frame_indices: tuple[int, ...]
    row_step: int

    def to_dict(self) -> dict[str, Any]:
        finite = np.isfinite(self.baseline_mm)
        noise_finite = np.isfinite(self.column_noise_mm)
        baseline_values = self.baseline_mm[finite]
        noise_values = self.column_noise_mm[noise_finite]
        return {
            "sampledFrameIndices": list(self.sampled_frame_indices),
            "rowStep": int(self.row_step),
            "columnCount": int(self.baseline_mm.shape[0]),
            "finiteColumnCount": int(np.count_nonzero(finite)),
            "noiseFiniteColumnCount": int(np.count_nonzero(noise_finite)),
            "baselineMedianMm": _safe_float(
                np.median(baseline_values) if baseline_values.size else None
            ),
            "columnNoiseMedianMm": _safe_float(
                np.median(noise_values) if noise_values.size else None
            ),
        }


def _safe_float(value: Any) -> float | None:
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _coordinate_metadata(
    metadata: Mapping[str, Any] | None,
    coordinate_name: str = "CoordinateC",
) -> Mapping[str, Any]:
    if not isinstance(metadata, Mapping):
        return {}
    for parent in ("bdConfig", "bd_config", "coordinate", "depth"):
        value = metadata.get(parent)
        if isinstance(value, Mapping):
            children = (
                coordinate_name,
                coordinate_name[:1].lower() + coordinate_name[1:],
                "coordinate",
                "depth",
            )
            for child in children:
                nested = value.get(child)
                if isinstance(nested, Mapping):
                    return nested
            # Some exports put the Scan3d values directly under bdConfig.
            if any(str(key).lower().startswith("scan3d") for key in value):
                return value
    return metadata


def _metadata_value(
    metadata: Mapping[str, Any], *names: str, coordinate_name: str = "CoordinateC"
) -> Any:
    coordinate = _coordinate_metadata(metadata, coordinate_name)
    for name in names:
        value = _first(coordinate, name, default=None)
        if value is not None:
            return value
    # A few files use short lower-case names.
    lowered = {str(key).lower(): value for key, value in coordinate.items()}
    for name in names:
        value = lowered.get(name.lower())
        if value is not None:
            return value
    return None


def depth_scale_offset_invalid(
    metadata: Mapping[str, Any] | None,
) -> tuple[float, float, float | None]:
    """Extract SICK ``raw * scale + offset`` conversion parameters."""

    source = metadata if isinstance(metadata, Mapping) else {}
    scale = _finite_float(
        _metadata_value(
            source,
            "Scan3dCoordinateScale",
            "coordinateScale",
            "scale",
        ),
        1.0,
    )
    offset = _finite_float(
        _metadata_value(
            source,
            "Scan3dCoordinateOffset",
            "coordinateOffset",
            "offset",
        ),
        0.0,
    )
    invalid_value = _finite_float(
        _metadata_value(
            source,
            "Scan3dInvalidDataValue",
            "invalidDataValue",
            "invalidValue",
            "invalid",
        ),
        None,
    )
    return float(scale if scale is not None else 1.0), float(
        offset if offset is not None else 0.0
    ), invalid_value


def horizontal_calibration_from_metadata(
    metadata: Mapping[str, Any] | None,
) -> tuple[bool, float | None, float]:
    """Derive horizontal pixel millimetres from SICK ``CoordinateA``.

    CoordinateA is accepted only when the device supplied an explicit,
    positive scale.  This is deliberately a local pixel calibration; it does
    not claim a longitudinal encoder scale or physical area.
    """

    source = metadata if isinstance(metadata, Mapping) else {}
    scale_raw = _metadata_value(
        source,
        "Scan3dCoordinateScale",
        "coordinateScale",
        "scale",
        coordinate_name="CoordinateA",
    )
    offset_raw = _metadata_value(
        source,
        "Scan3dCoordinateOffset",
        "coordinateOffset",
        "offset",
        coordinate_name="CoordinateA",
    )
    scale = _finite_float(scale_raw)
    offset = _finite_float(offset_raw, 0.0)
    if scale is None or scale <= 0:
        return False, None, 0.0
    return True, scale, float(offset or 0.0)


def convert_raw_depth(
    raw: np.ndarray,
    metadata: Mapping[str, Any] | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Convert a raw SICK plane and return ``(millimetres, valid_mask)``.

    Non-finite values, the device invalid sentinel, and zero codes are marked
    invalid.  Zero is included because SICK exports commonly omit the
    ``Scan3dInvalidDataValue`` field while still using zero for invalid data.
    """

    source = np.asarray(raw)
    if source.ndim != 2:
        raise ValueError(f"depth plane must be 2D: {source.shape}")
    scale, offset, invalid_value = depth_scale_offset_invalid(metadata)
    numeric = source.astype(np.float64, copy=False)
    valid = np.isfinite(numeric)
    if invalid_value is not None:
        valid &= numeric != invalid_value
    valid &= numeric != 0
    millimeters = numeric * scale + offset
    millimeters = np.asarray(millimeters, dtype=np.float32)
    millimeters[~valid] = np.nan
    return millimeters, np.asarray(valid, dtype=bool)


# Friendly aliases used by callers/tests that describe the same operation.
decode_raw_depth = convert_raw_depth
raw_depth_to_mm = convert_raw_depth
depth_to_millimeters = convert_raw_depth


def _nanmedian(values: np.ndarray, axis: int) -> np.ndarray:
    """Like nanmedian but without warnings for all-invalid columns."""

    finite = np.isfinite(values)
    empty = ~np.any(finite, axis=axis)
    working = np.asarray(values, dtype=np.float64).copy()
    # nanmedian's all-NaN result is NaN; replacing those slices avoids the
    # warning on large production flows and is equivalent for our use.
    if axis == 0:
        working[:, empty] = 0.0
    elif axis == 1:
        working[empty, :] = 0.0
    result = np.nanmedian(working, axis=axis)
    result[empty] = np.nan
    return result


def _sample_indices(count: int, maximum: int) -> tuple[int, ...]:
    if count <= 0:
        return ()
    amount = min(count, max(1, int(maximum)))
    return tuple(int(value) for value in np.unique(np.linspace(0, count - 1, amount).round()))


def estimate_flow_baseline(
    frames_mm: Sequence[np.ndarray],
    valid_masks: Sequence[np.ndarray] | None = None,
    *,
    max_frames: int = 32,
    row_step: int = 4,
) -> BaselineEstimate:
    """Estimate a robust per-column baseline and noise from a whole flow.

    At most 32 evenly spaced frames are used, and only every ``row_step`` row
    contributes to the estimator.  Noise is ``1.4826 * MAD`` around the
    per-column median, with a finite fallback for otherwise constant columns.
    """

    if not frames_mm:
        raise ValueError("at least one depth frame is required")
    arrays = [np.asarray(value, dtype=np.float32) for value in frames_mm]
    shape = arrays[0].shape
    if len(shape) != 2 or any(value.shape != shape for value in arrays):
        raise ValueError("all depth frames must share one 2D shape")
    if valid_masks is None:
        masks = [np.isfinite(value) for value in arrays]
    else:
        masks = [np.asarray(value, dtype=bool) for value in valid_masks]
        if len(masks) != len(arrays) or any(value.shape != shape for value in masks):
            raise ValueError("valid masks must match depth frames")
    indices = _sample_indices(len(arrays), min(32, max(1, int(max_frames))))
    step = max(1, int(row_step))
    # Work column by column.  A stacked 32 x 256 x 2560 float64 array plus a
    # second deviation copy is several hundred MiB on a production frame;
    # per-column medians keep the same robust statistic with bounded memory.
    baseline = np.full(shape[1], np.nan, dtype=np.float32)
    noise = np.zeros(shape[1], dtype=np.float32)
    for column in range(shape[1]):
        column_values: list[np.ndarray] = []
        for index in indices:
            sampled = arrays[index][::step, column]
            sampled_valid = masks[index][::step, column]
            if np.any(sampled_valid):
                column_values.append(
                    np.asarray(sampled[sampled_valid], dtype=np.float64)
                )
        if not column_values:
            continue
        values = np.concatenate(column_values)
        median = float(np.median(values))
        baseline[column] = median
        noise[column] = float(1.4826 * np.median(np.abs(values - median)))
    return BaselineEstimate(
        baseline_mm=np.asarray(baseline, dtype=np.float32),
        column_noise_mm=np.asarray(noise, dtype=np.float32),
        sampled_frame_indices=indices,
        row_step=step,
    )


estimate_baseline = estimate_flow_baseline


def apply_depth_residual(
    millimeters: np.ndarray,
    valid: np.ndarray,
    baseline_mm: np.ndarray,
) -> np.ndarray:
    """Subtract the flow baseline and per-row median drift."""

    values = np.asarray(millimeters, dtype=np.float64)
    mask = np.asarray(valid, dtype=bool)
    baseline = np.asarray(baseline_mm, dtype=np.float64)
    if values.ndim != 2 or mask.shape != values.shape:
        raise ValueError("depth and valid mask must be matching 2D arrays")
    if baseline.ndim != 1 or baseline.shape[0] != values.shape[1]:
        raise ValueError("baseline must have one value per depth column")
    residual = values - baseline[None, :]
    residual[~mask] = np.nan
    row_drift = _nanmedian(residual, axis=1)
    row_drift[~np.isfinite(row_drift)] = 0.0
    residual -= row_drift[:, None]
    residual[~mask] = np.nan
    return np.asarray(residual, dtype=np.float32)


compute_depth_residual = apply_depth_residual


def _neighborhood_count(mask: np.ndarray) -> np.ndarray:
    value = np.asarray(mask, dtype=np.uint8)
    result = np.zeros_like(value, dtype=np.uint8)
    # Explicit slices avoid np.roll's wraparound at image boundaries.
    for row_delta in (-1, 0, 1):
        source_top = max(0, -row_delta)
        source_bottom = value.shape[0] - max(0, row_delta)
        target_top = max(0, row_delta)
        target_bottom = value.shape[0] - max(0, -row_delta)
        for column_delta in (-1, 0, 1):
            source_left = max(0, -column_delta)
            source_right = value.shape[1] - max(0, column_delta)
            target_left = max(0, column_delta)
            target_right = value.shape[1] - max(0, -column_delta)
            if source_bottom > source_top and source_right > source_left:
                result[target_top:target_bottom, target_left:target_right] += value[
                    source_top:source_bottom, source_left:source_right
                ]
    return result


def threshold_depth_residual(
    residual: np.ndarray,
    valid: np.ndarray,
    column_noise_mm: np.ndarray,
    *,
    minimum_depth_mm: float = 0.35,
    noise_multiplier: float = 6.0,
    minimum_support: int = 3,
) -> tuple[np.ndarray, np.ndarray]:
    """Apply adaptive threshold and 3x3 support gate.

    Returns ``(supported_mask, threshold_by_column)``.  The center pixel is
    counted in the support, matching the rule's 3x3-neighbourhood wording.
    """

    value = np.asarray(residual, dtype=np.float64)
    mask = np.asarray(valid, dtype=bool)
    noise = np.asarray(column_noise_mm, dtype=np.float64)
    if value.ndim != 2 or mask.shape != value.shape:
        raise ValueError("residual and valid mask must be matching 2D arrays")
    if noise.ndim != 1 or noise.shape[0] != value.shape[1]:
        raise ValueError("column noise must have one value per depth column")
    threshold = np.maximum(
        max(0.0, float(minimum_depth_mm)),
        max(0.0, float(noise_multiplier)) * np.nan_to_num(noise, nan=0.0),
    )
    active = mask & np.isfinite(value) & (np.abs(value) >= threshold[None, :])
    support = _neighborhood_count(active)
    return active & (support >= max(1, int(minimum_support))), threshold.astype(np.float32)


def connected_components_8(mask: np.ndarray, minimum_points: int = 1) -> list[np.ndarray]:
    """Return 8-connected components as ``N x 2`` row/column arrays."""

    value = np.asarray(mask, dtype=bool)
    if value.ndim != 2:
        raise ValueError("component mask must be 2D")
    visited = np.zeros(value.shape, dtype=bool)
    components: list[np.ndarray] = []
    rows, columns = value.shape
    for row, column in np.argwhere(value):
        row = int(row)
        column = int(column)
        if visited[row, column]:
            continue
        stack = [(row, column)]
        visited[row, column] = True
        points: list[tuple[int, int]] = []
        while stack:
            current_row, current_column = stack.pop()
            points.append((current_row, current_column))
            for row_delta in (-1, 0, 1):
                for column_delta in (-1, 0, 1):
                    if not row_delta and not column_delta:
                        continue
                    next_row = current_row + row_delta
                    next_column = current_column + column_delta
                    if (
                        0 <= next_row < rows
                        and 0 <= next_column < columns
                        and value[next_row, next_column]
                        and not visited[next_row, next_column]
                    ):
                        visited[next_row, next_column] = True
                        stack.append((next_row, next_column))
        if len(points) >= max(1, int(minimum_points)):
            components.append(np.asarray(points, dtype=np.int32))
    return components


def _interval_iou(
    first_min: int, first_max: int, second_min: int, second_max: int
) -> float:
    """Return inclusive one-dimensional interval IoU."""

    first_min = int(first_min)
    first_max = int(first_max)
    second_min = int(second_min)
    second_max = int(second_max)
    if first_max < first_min or second_max < second_min:
        return 0.0
    intersection = max(0, min(first_max, second_max) - max(first_min, second_min) + 1)
    union = max(first_max, second_max) - min(first_min, second_min) + 1
    return float(intersection) / float(union) if union > 0 else 0.0


def _components_overlap(
    first: Mapping[str, Any],
    second: Mapping[str, Any],
    padding: int,
    minimum_iou: float = 0.20,
) -> bool:
    """Test whether two components touch across a real frame boundary.

    A Ranger3 frame is a height block in a line-scan image.  Its last local
    row is followed by row zero of the next frame; equal local row numbers in
    two frames are therefore *not* spatially adjacent.  The component rows
    carry their cropped frame height so this predicate can enforce that
    boundary explicitly.  Horizontal overlap is measured as an inclusive
    interval IoU, rather than by bbox proximity, so ``minimumIoU`` is a real
    acceptance criterion.
    """

    if first["polarity"] != second["polarity"]:
        return False
    frame_gap = int(second["firstFrameNumber"]) - int(first["lastFrameNumber"])
    # Only physically consecutive storage frames can share a boundary.  In
    # particular, sampled frames (e.g. 0 and 8) must never be joined merely
    # because their local rows happen to match.  ``cross_frame_max_gap`` is
    # still applied by the grouping caller as a defensive upper bound.
    if frame_gap != 1:
        return False
    first_height = int(first.get("frameHeight", 0) or 0)
    second_height = int(second.get("frameHeight", 0) or 0)
    if first_height <= 0 or second_height <= 0 or first_height != second_height:
        return False
    tolerance = max(0, int(padding))
    # The only valid longitudinal contact is the previous block's bottom to
    # the next block's top.  This rejects same-local-row false merges.
    if first_height - 1 - int(first["maxRow"]) > tolerance:
        return False
    if int(second["minRow"]) > tolerance:
        return False
    overlap = _interval_iou(
        int(first["minColumn"]),
        int(first["maxColumn"]),
        int(second["minColumn"]),
        int(second["maxColumn"]),
    )
    return overlap >= max(0.0, min(1.0, float(minimum_iou)))


def _union_find(count: int) -> tuple[list[int], Callable[[int], int], Callable[[int, int], None]]:
    parents = list(range(count))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root != right_root:
            parents[right_root] = left_root

    return parents, find, union


def _pca_shape(
    points: np.ndarray,
    threshold: float,
    global_rows: np.ndarray | None = None,
) -> tuple[str, float, float, float]:
    # Shape is measured in the source pixel row/column plane.  For a
    # multi-frame line-scan candidate, use the global *pixel* row so a
    # bottom-of-frame to top-of-next-frame candidate has a continuous shape.
    # This is deliberately not converted to millimetres.
    value = np.asarray(points, dtype=np.float64)
    if global_rows is None:
        longitudinal = value[:, 1]
    else:
        longitudinal = np.asarray(global_rows, dtype=np.float64)
        if longitudinal.ndim != 1 or longitudinal.shape[0] != value.shape[0]:
            raise ValueError("global_rows must match component points")
    coordinates = np.column_stack((longitudinal, value[:, 2]))
    if coordinates.shape[0] < 2:
        return "compact", 1.0, 1.0, 1.0
    centered = coordinates - np.mean(coordinates, axis=0)
    covariance = np.atleast_2d(np.cov(centered, rowvar=False, bias=True))
    eigenvalues = np.linalg.eigvalsh(covariance)
    eigenvalues = np.maximum(eigenvalues, 0.0)
    major = math.sqrt(float(eigenvalues[-1])) * 2.0
    minor = math.sqrt(float(eigenvalues[0])) * 2.0
    if minor <= 1e-6:
        ratio = math.inf if major > 0 else 1.0
    else:
        ratio = major / minor
    return (
        "elongated" if ratio >= threshold else "compact",
        float(ratio if math.isfinite(ratio) else 999999.0),
        float(major),
        float(minor),
    )


def _class_for(polarity: str, shape: str) -> tuple[str, str]:
    if polarity == "depression":
        return ("groove" if shape == "elongated" else "pit", f"{'groove' if shape == 'elongated' else 'pit'}-{shape}")
    return ("ridge" if shape == "elongated" else "bulge", f"{'ridge' if shape == 'elongated' else 'bulge'}-{shape}")


def _stable_id(
    material_id: str,
    camera_id: str,
    frame_number: int,
    source_row: int,
    source_column: int,
    polarity: str,
) -> str:
    seed = "|".join(
        (
            str(material_id),
            str(camera_id),
            str(int(frame_number)),
            str(int(source_row)),
            str(int(source_column)),
            str(polarity),
        )
    ).encode("utf-8")
    return f"dg-{hashlib.sha256(seed).hexdigest()[:24]}"


def _camera_index(camera_id: str) -> int | None:
    match = re.search(r"(\d+)$", str(camera_id).strip())
    return int(match.group(1)) if match else None


def _calibration_from(
    config: DepthGeometryConfig,
    calibration: Mapping[str, Any] | None,
) -> tuple[bool, float | None, float]:
    source = calibration if isinstance(calibration, Mapping) else {}
    explicit_valid = _first(
        source,
        "calibration_valid",
        "metric_valid",
        "valid",
        "metricValid",
        default=None,
    )
    pitch = _finite_float(
        _first(
            source,
            "horizontal_pixel_pitch_mm",
            "pixel_pitch_mm",
            "pixelPitchMm",
            "pixelPitchXmm",
            "horizontalPitchMm",
            default=config.horizontal_pixel_pitch_mm,
        ),
        config.horizontal_pixel_pitch_mm,
    )
    origin = _finite_float(
        _first(
            source,
            "horizontal_origin_mm",
            "origin_mm",
            "originMm",
            default=config.horizontal_origin_mm,
        ),
        config.horizontal_origin_mm,
    )
    valid = bool(config.calibration_valid)
    if explicit_valid is not None:
        valid = bool(explicit_valid)
    return bool(valid and pitch is not None and pitch > 0), pitch, float(origin or 0.0)


def _horizontal_mm(
    column: float,
    source_left: int,
    calibration: tuple[bool, float | None, float],
) -> float | None:
    valid, pitch, origin = calibration
    if not valid or pitch is None:
        return None
    return float(origin + (source_left + float(column) + 0.5) * pitch)


def extract_roi(
    image: np.ndarray | Image.Image,
    bbox: Sequence[int | float] | Mapping[str, Any],
    *,
    padding: int = 0,
) -> np.ndarray:
    """Extract a clipped HWC/2D ROI from an intensity or residual array."""

    value = np.asarray(image)
    if value.ndim not in (2, 3):
        raise ValueError("ROI source must be a 2D or 3D image")
    if isinstance(bbox, Mapping):
        values = (
            bbox.get("left"),
            bbox.get("top"),
            bbox.get("right"),
            bbox.get("bottom"),
        )
    else:
        values = tuple(bbox)
    if len(values) != 4:
        raise ValueError("bbox must contain left, top, right, bottom")
    try:
        left, top, right, bottom = (
            int(math.floor(float(item))) for item in values
        )
    except (TypeError, ValueError) as error:
        raise ValueError("bbox must contain numeric left, top, right, bottom") from error
    pad = max(0, int(padding))
    left = max(0, left - pad)
    top = max(0, top - pad)
    right = min(value.shape[1], right + pad)
    bottom = min(value.shape[0], bottom + pad)
    return np.asarray(value[top:bottom, left:right]).copy()


def intensity_roi(
    intensity: np.ndarray | Image.Image,
    bbox: Sequence[int | float] | Mapping[str, Any],
    *,
    padding: int = 8,
    as_image: bool = False,
) -> np.ndarray | Image.Image:
    """Build a review-ready RGB intensity ROI."""

    value = extract_roi(intensity, bbox, padding=padding)
    if value.ndim == 2:
        finite = np.isfinite(value)
        source = np.nan_to_num(value, nan=0.0).astype(np.float64)
        if np.any(finite):
            low, high = np.percentile(source[finite], [1.0, 99.0])
            if high <= low:
                high = low + 1.0
            source = np.clip((source - low) * 255.0 / (high - low), 0, 255)
        rgb = np.repeat(source.astype(np.uint8)[..., None], 3, axis=2)
    else:
        source = np.nan_to_num(value, nan=0.0)
        if source.dtype != np.uint8:
            source = np.clip(source, 0, 255).astype(np.uint8)
        rgb = source if source.shape[2] == 3 else np.repeat(source[..., :1], 3, axis=2)
    if as_image:
        return Image.fromarray(np.asarray(rgb, dtype=np.uint8), mode="RGB")
    return np.asarray(rgb, dtype=np.uint8)


def _jet_color(normalized: np.ndarray) -> np.ndarray:
    """Small dependency-free JET palette implementation."""

    value = np.clip(np.asarray(normalized, dtype=np.float64), 0.0, 1.0)
    red = np.clip(1.5 - np.abs(4.0 * value - 3.0), 0.0, 1.0)
    green = np.clip(1.5 - np.abs(4.0 * value - 2.0), 0.0, 1.0)
    blue = np.clip(1.5 - np.abs(4.0 * value - 1.0), 0.0, 1.0)
    return np.stack((red, green, blue), axis=-1)


def residual_jet_roi(
    residual: np.ndarray,
    bbox: Sequence[int | float] | Mapping[str, Any],
    *,
    padding: int = 8,
    display_range_mm: float = 2.0,
    as_image: bool = False,
) -> np.ndarray | Image.Image:
    """Render a residual ROI as a JET RGB image, invalid pixels black."""

    value = extract_roi(residual, bbox, padding=padding).astype(np.float64, copy=False)
    finite = np.isfinite(value)
    normalized = 0.5 + np.nan_to_num(value, nan=0.0) / (
        2.0 * max(0.01, float(display_range_mm))
    )
    rgb = np.clip(_jet_color(normalized) * 255.0, 0, 255).astype(np.uint8)
    rgb[~finite] = 0
    if as_image:
        return Image.fromarray(rgb, mode="RGB")
    return rgb


build_intensity_roi = intensity_roi
build_residual_jet_roi = residual_jet_roi


def _prepare_frame(
    frame: Any,
    frame_number: int,
    metadata: Mapping[str, Any] | None = None,
    intensity: np.ndarray | Image.Image | None = None,
    *,
    load_intensity: bool = True,
    execution_gate: Callable[[str], None] | None = None,
) -> DepthFrame:
    if isinstance(frame, DepthFrame):
        return frame
    path: Path | None = None
    source_metadata: Mapping[str, Any] = metadata or {}
    source_intensity: np.ndarray | None = (
        np.asarray(intensity) if intensity is not None else None
    )
    if isinstance(frame, (str, Path)):
        path = Path(frame)
        if execution_gate is not None:
            execution_gate("depth-geometry-depth-read")
        with np.load(path, allow_pickle=False) as archive:
            if not archive.files:
                raise ValueError(f"depth NPZ has no arrays: {path}")
            raw = np.asarray(archive[archive.files[0]])
        if metadata is None:
            metadata_path = path.parent.parent / "json" / f"{path.stem}.json"
            if execution_gate is not None:
                execution_gate("depth-geometry-metadata-stat")
            if metadata_path.is_file():
                if execution_gate is not None:
                    execution_gate("depth-geometry-metadata-read")
                with metadata_path.open("r", encoding="utf-8") as stream:
                    loaded = json.load(stream)
                source_metadata = loaded if isinstance(loaded, Mapping) else {}
        if load_intensity and intensity is None:
            intensity_path = path.parent.parent / "2d" / f"{path.stem}.png"
            if execution_gate is not None:
                execution_gate("depth-geometry-intensity-stat")
            if intensity_path.is_file():
                if execution_gate is not None:
                    execution_gate("depth-geometry-intensity-read")
                with Image.open(intensity_path) as image:
                    source_intensity = np.asarray(image.convert("L"))
    else:
        raw = np.asarray(frame)
    millimeters, valid = convert_raw_depth(raw, source_metadata)
    return DepthFrame(
        millimeters=millimeters,
        valid=valid,
        frame_number=int(frame_number),
        metadata=source_metadata,
        intensity=source_intensity,
        source_path=str(path) if path else None,
    )


def load_depth_frame(
    path: str | Path,
    *,
    frame_number: int = 0,
    metadata: Mapping[str, Any] | None = None,
    intensity: np.ndarray | Image.Image | None = None,
    execution_gate: Callable[[str], None] | None = None,
) -> DepthFrame:
    """Load one NPZ depth frame plus its sibling metadata/intensity files."""

    return _prepare_frame(
        path,
        frame_number,
        metadata,
        intensity,
        execution_gate=execution_gate,
    )


def _common_roi(
    shape: tuple[int, int], config_roi: Sequence[int] | None
) -> tuple[int, int, int, int]:
    rows, columns = shape
    if config_roi is None:
        return (0, 0, columns, rows)
    if len(config_roi) != 4:
        raise ValueError("ROI must be [left, top, right, bottom]")
    left, top, right, bottom = (int(value) for value in config_roi)
    left = max(0, min(columns, left))
    top = max(0, min(rows, top))
    right = max(left, min(columns, right))
    bottom = max(top, min(rows, bottom))
    if right <= left or bottom <= top:
        raise ValueError("ROI must have a non-empty extent")
    return left, top, right, bottom


def _as_json_number(value: float | int | None) -> float | int | None:
    if value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def detect_depth_geometry(
    frames: Sequence[Any],
    *,
    metadata: Sequence[Mapping[str, Any]] | Mapping[str, Any] | None = None,
    intensity_frames: Sequence[np.ndarray | Image.Image | None] | None = None,
    frame_numbers: Sequence[int] | None = None,
    material_id: str = "",
    camera_id: str = "",
    config: DepthGeometryConfig | Mapping[str, Any] | None = None,
    calibration: Mapping[str, Any] | None = None,
    execution_gate: Callable[[str], None] | None = None,
    include_roi_pixels: bool = True,
) -> dict[str, Any]:
    """Detect provisional local depth geometry candidates in one camera flow."""

    if isinstance(frames, np.ndarray):
        if frames.ndim == 2:
            frame_values: list[Any] = [frames]
        elif frames.ndim == 3:
            frame_values = [frames[index] for index in range(frames.shape[0])]
        else:
            raise ValueError("frames array must be 2D or 3D")
    else:
        frame_values = list(frames)
    settings = (
        config.bounded()
        if isinstance(config, DepthGeometryConfig)
        else DepthGeometryConfig.from_mapping(config)
    )
    if not settings.enabled:
        return {
            "schema": DEPTH_GEOMETRY_SCHEMA,
            "algorithm": DEPTH_GEOMETRY_SOURCE,
            "state": "disabled",
            "materialId": str(material_id),
            "cameraId": str(camera_id),
            "config": settings.to_dict(),
            "configHash": config_hash(settings),
            "quality": {
                "reviewRequired": True,
                "candidateOnly": True,
                "longitudinalScaleAvailable": False,
                "areaAvailable": False,
            },
            "metricValid": False,
            "defects": [],
            "statistics": {"frameCount": 0, "processedFrames": 0, "candidateCount": 0, "defectCount": 0},
        }
    if not frame_values:
        return {
            "schema": DEPTH_GEOMETRY_SCHEMA,
            "algorithm": DEPTH_GEOMETRY_SOURCE,
            "state": "empty",
            "materialId": str(material_id),
            "cameraId": str(camera_id),
            "configHash": config_hash(settings),
            "defects": [],
            "statistics": {"frameCount": 0, "candidateCount": 0},
        }
    if frame_numbers is not None and len(frame_numbers) != len(frame_values):
        raise ValueError("frame_numbers must match frames")
    if intensity_frames is not None and len(intensity_frames) != len(frame_values):
        raise ValueError("intensity_frames must match frames")
    if isinstance(metadata, Mapping):
        metadata_values: list[Mapping[str, Any] | None] = [metadata] * len(frame_values)
    elif metadata is None:
        metadata_values = [None] * len(frame_values)
    else:
        if len(metadata) != len(frame_values):
            raise ValueError("metadata must match frames")
        metadata_values = list(metadata)
    numbers = (
        list(frame_numbers)
        if frame_numbers is not None
        else list(range(len(frame_values)))
    )
    decoded: list[DepthFrame] = []
    for index, frame in enumerate(frame_values):
        if execution_gate is not None:
            execution_gate(f"depth-geometry-decode:{index}")
        decoded.append(
            _prepare_frame(
                frame,
                numbers[index],
                metadata_values[index],
                intensity_frames[index] if intensity_frames is not None else None,
                load_intensity=include_roi_pixels,
                execution_gate=execution_gate,
            )
        )
    # All camera frames are expected to share dimensions; use the common crop
    # to make stable source coordinates and baseline columns.
    shape = decoded[0].millimeters.shape
    if any(value.millimeters.shape != shape for value in decoded):
        raise ValueError("all depth frames must share one 2D shape")
    left, top, right, bottom = _common_roi(shape, settings.roi)
    cropped_values = [value.millimeters[top:bottom, left:right] for value in decoded]
    cropped_masks = [value.valid[top:bottom, left:right] for value in decoded]
    baseline = estimate_flow_baseline(
        cropped_values,
        cropped_masks,
        max_frames=settings.baseline_max_frames,
        row_step=settings.baseline_row_step,
    )
    baseline = replace(
        baseline,
        sampled_frame_indices=tuple(numbers[index] for index in baseline.sampled_frame_indices),
    )
    calibration_info = _calibration_from(settings, calibration)
    if calibration is None and not settings.calibration_valid and not calibration_info[0]:
        for frame in decoded:
            derived = horizontal_calibration_from_metadata(frame.metadata)
            if derived[0]:
                calibration_info = derived
                break
    component_rows: list[dict[str, Any]] = []
    frame_residuals: list[np.ndarray] = []
    for index, (value, valid) in enumerate(zip(cropped_values, cropped_masks)):
        if execution_gate is not None:
            execution_gate(f"depth-geometry-frame:{numbers[index]}")
        residual = apply_depth_residual(value, valid, baseline.baseline_mm)
        frame_residuals.append(residual)
        supported, threshold = threshold_depth_residual(
            residual,
            valid,
            baseline.column_noise_mm,
            minimum_depth_mm=settings.minimum_depth_mm,
            noise_multiplier=settings.noise_multiplier,
            minimum_support=settings.minimum_support,
        )
        for polarity, polarity_mask in (
            ("protrusion", supported & (residual > 0)),
            ("depression", supported & (residual < 0)),
        ):
            for points in connected_components_8(
                polarity_mask, settings.minimum_component_points
            ):
                values = residual[points[:, 0], points[:, 1]]
                finite_values = values[np.isfinite(values)]
                if finite_values.size == 0:
                    continue
                component_rows.append(
                    {
                        "frameIndex": int(index),
                        "frameNumber": int(numbers[index]),
                        "frameHeight": int(value.shape[0]),
                        "polarity": polarity,
                        "points": points,
                        "values": finite_values,
                        "minRow": int(np.min(points[:, 0])),
                        "maxRow": int(np.max(points[:, 0])),
                        "minColumn": int(np.min(points[:, 1])),
                        "maxColumn": int(np.max(points[:, 1])),
                        "firstFrameIndex": int(index),
                        "lastFrameIndex": int(index),
                        "firstFrameNumber": int(numbers[index]),
                        "lastFrameNumber": int(numbers[index]),
                        "thresholdMedianMm": float(
                            np.median(threshold[points[:, 1]])
                        ),
                    }
                )

    raw_groups = _group_component_rows(component_rows, settings)
    groups, candidate_overflow = _limit_candidate_groups(raw_groups, settings)
    raw_candidate_count = len(raw_groups)

    defects: list[dict[str, Any]] = []
    roi_height = max(1, int(bottom - top))
    for members in groups:
        all_points: list[np.ndarray] = []
        all_values: list[np.ndarray] = []
        all_global_rows: list[np.ndarray] = []
        polarity = members[0]["polarity"]
        for member in members:
            points = member["points"]
            frame_column = np.full((points.shape[0], 1), member["frameNumber"], dtype=np.int32)
            all_points.append(np.column_stack((frame_column, points)))
            all_values.append(np.asarray(member["values"], dtype=np.float64))
            frame_index = int(member.get("frameIndex", 0))
            all_global_rows.append(
                frame_index * roi_height + np.asarray(points[:, 0], dtype=np.int32)
            )
        points = np.concatenate(all_points, axis=0)
        values = np.concatenate(all_values, axis=0)
        global_rows = np.concatenate(all_global_rows, axis=0)
        peak_offset = int(np.argmax(np.abs(values)))
        peak_value = float(values[peak_offset])
        peak_row = int(points[peak_offset, 1])
        peak_column = int(points[peak_offset, 2])
        peak_frame = int(points[peak_offset, 0])
        source_row = top + peak_row
        source_column = left + peak_column
        shape_name, aspect_ratio, major_span, minor_span = _pca_shape(
            points, settings.elongated_aspect_ratio, global_rows
        )
        provisional, class_name = _class_for(polarity, shape_name)
        p05, p95 = np.percentile(values, [5.0, 95.0])
        abs_values = np.abs(values)
        global_min_row, global_max_row = (
            int(np.min(global_rows)),
            int(np.max(global_rows)),
        )
        min_column, max_column = int(np.min(points[:, 2])), int(np.max(points[:, 2]))
        peak_frame_mask = points[:, 0] == peak_frame
        if not np.any(peak_frame_mask):
            peak_frame_mask = np.zeros(points.shape[0], dtype=bool)
            peak_frame_mask[peak_offset] = True
        source_rows = points[peak_frame_mask, 1]
        source_columns = points[peak_frame_mask, 2]
        source_min_row, source_max_row = (
            int(np.min(source_rows)),
            int(np.max(source_rows)),
        )
        source_min_column, source_max_column = (
            int(np.min(source_columns)),
            int(np.max(source_columns)),
        )
        # Rule score is deliberately explainable and bounded.  It is not a
        # model confidence and every item remains review-only.
        support_score = min(1.0, len(values) / max(1.0, settings.minimum_component_points * 4.0))
        depth_score = min(1.0, float(np.percentile(abs_values, 95.0)) / max(settings.minimum_depth_mm * 4.0, 1e-6))
        rule_score = round(float(0.5 * support_score + 0.5 * depth_score), 6)
        horizontal_start = _horizontal_mm(min_column, left, calibration_info)
        horizontal_end = _horizontal_mm(max_column, left, calibration_info)
        horizontal_center = _horizontal_mm(float(np.mean(points[:, 2])), left, calibration_info)
        frame_numbers_member = [int(value["frameNumber"]) for value in members]
        # The source image and review crop are always local to the peak frame.
        # Cross-frame geometry is represented separately by global pixel span.
        bbox = [
            left + source_min_column,
            top + source_min_row,
            left + source_max_column + 1,
            top + source_max_row + 1,
        ]
        peak_index = next(
            (index for index, number in enumerate(numbers) if number == peak_frame),
            None,
        )
        stable_id = _stable_id(
            material_id,
            camera_id,
            peak_frame,
            source_row,
            source_column,
            polarity,
        )
        defect = {
            "id": stable_id,
            "stableId": stable_id,
            "source": DEPTH_GEOMETRY_SOURCE,
            "algorithm": DEPTH_GEOMETRY_SOURCE,
            "cameraId": str(camera_id),
            "cameraIndex": _camera_index(camera_id),
            "storageIndex": peak_frame,
            "cameraFrameSequence": peak_frame,
            "scoreKind": "geometry-rule",
            "ruleScore": rule_score,
            "ruleScores": {
                "support": round(float(support_score), 6),
                "depth": round(float(depth_score), 6),
                "thresholdMedianMm": round(
                    float(np.median([member["thresholdMedianMm"] for member in members])),
                    6,
                ),
            },
            "confidence": rule_score,
            "severity": "review",
            "reviewOnly": True,
            # Keep the polarity/shape combination as the four-way provisional
            # class.  ``provisionalType`` retains the polarity-only family for
            # consumers that group pits/grooves or bulges/ridges together.
            "provisionalClass": class_name,
            "provisionalType": provisional,
            "class": class_name,
            "type": class_name,
            "classId": f"geometry-{class_name}",
            "className": class_name,
            "polarity": polarity,
            "shape": shape_name,
            "aspectRatio": round(aspect_ratio, 6),
            "signedDepthMm": round(peak_value, 6),
            "absoluteDepthMm": round(float(np.max(abs_values)), 6),
            "depthMm": round(float(np.max(abs_values)), 6),
            "p05DepthMm": round(float(p05), 6),
            "p95DepthMm": round(float(p95), 6),
            "p05": round(float(p05), 6),
            "p95": round(float(p95), 6),
            "p05AbsoluteDepthMm": round(float(np.percentile(abs_values, 5.0)), 6),
            "p95AbsoluteDepthMm": round(float(np.percentile(abs_values, 95.0)), 6),
            "pointCount": int(points.shape[0]),
            "pixelSpan": {
                "width": int(max_column - min_column + 1),
                "height": int(global_max_row - global_min_row + 1),
                "major": round(major_span, 6),
                "minor": round(minor_span, 6),
            },
            "pixelWidth": int(source_max_column - source_min_column + 1),
            "pixelHeight": int(source_max_row - source_min_row + 1),
            "pixelSpanWidth": int(max_column - min_column + 1),
            "pixelSpanHeight": int(global_max_row - global_min_row + 1),
            "bbox": bbox,
            "imageRect2d": {
                "left": bbox[0],
                "top": bbox[1],
                "right": bbox[2],
                "bottom": bbox[3],
            },
            "reviewCropRect": {
                "left": bbox[0],
                "top": bbox[1],
                "right": bbox[2],
                "bottom": bbox[3],
                "width": bbox[2] - bbox[0],
                "height": bbox[3] - bbox[1],
            },
            "frameStart": min(frame_numbers_member),
            "frameEnd": max(frame_numbers_member),
            "frameSpan": int(max(frame_numbers_member) - min(frame_numbers_member) + 1),
            "peakFrame": peak_frame,
            "peakFrameIndex": peak_index,
            "peakPixel": {"row": source_row, "column": source_column},
            "horizontalStartMm": _as_json_number(horizontal_start),
            "horizontalEndMm": _as_json_number(horizontal_end),
            "horizontalCenterMm": _as_json_number(horizontal_center),
            "horizontalMm": _as_json_number(horizontal_center),
            "horizontalSpanMm": _as_json_number(
                abs(horizontal_end - horizontal_start)
                if horizontal_start is not None and horizontal_end is not None
                else None
            ),
            # No encoder-derived longitudinal scale is available in this
            # pipeline.  Keep explicit nulls so consumers cannot mistake pixel
            # spans for physical measurements.
            "longitudinalMm": None,
            "longitudinalSpanMm": None,
            "areaMm2": None,
            "depthDeviation": {
                "available": True,
                "signedMm": round(peak_value, 6),
                "absoluteMm": round(float(np.max(abs_values)), 6),
                "p05Mm": round(float(p05), 6),
                "p95Mm": round(float(p95), 6),
                "unit": "mm",
            },
            "source3d": decoded[peak_index].source_path
            if peak_index is not None
            else None,
            "reviewImage": None,
            "intensityRoi": None,
            "residualJetRoi": None,
            "roiArtifacts": {
                "intensity": {
                    "available": bool(
                        peak_index is not None
                        and decoded[peak_index].intensity is not None
                    ),
                    "bbox": bbox,
                    "padding": settings.roi_padding,
                },
                "residualJet": {
                    "available": True,
                    "bbox": [
                        source_min_column,
                        source_min_row,
                        source_max_column + 1,
                        source_max_row + 1,
                    ],
                    "padding": settings.roi_padding,
                    "displayRangeMm": settings.jet_range_mm,
                },
            },
        }
        # Keep ROI artifacts as arrays only when a corresponding source frame
        # exists.  The artifact itself remains JSON-safe; callers can use the
        # helper functions directly or encode these arrays for persistence.
        if (
            include_roi_pixels
            and peak_index is not None
            and decoded[peak_index].intensity is not None
        ):
            defect["intensityRoi"] = intensity_roi(
                decoded[peak_index].intensity,
                bbox,
                padding=settings.roi_padding,
            ).tolist()
        if include_roi_pixels and peak_index is not None:
            defect["residualJetRoi"] = residual_jet_roi(
                frame_residuals[peak_index],
                [
                    source_min_column,
                    source_min_row,
                    source_max_column + 1,
                    source_max_row + 1,
                ],
                padding=settings.roi_padding,
                display_range_mm=settings.jet_range_mm,
            ).tolist()
        defects.append(defect)

    defects.sort(
        key=lambda item: (
            int(item.get("peakFrame", 0)),
            int(item.get("peakPixel", {}).get("row", 0)),
            int(item.get("peakPixel", {}).get("column", 0)),
            str(item.get("id", "")),
        )
    )
    return {
        "schema": DEPTH_GEOMETRY_SCHEMA,
        "algorithm": DEPTH_GEOMETRY_SOURCE,
        "state": "ready",
        "generatedAt": None,
        "materialId": str(material_id),
        "cameraId": str(camera_id),
        "config": settings.to_dict(),
        "configHash": config_hash(settings),
        "roi": [left, top, right, bottom],
        "metric": {
            "horizontalValid": bool(calibration_info[0]),
            "horizontalPixelPitchMm": _as_json_number(calibration_info[1])
            if calibration_info[0]
            else None,
            "longitudinalValid": False,
            "areaValid": False,
        },
        "metricValid": bool(calibration_info[0]),
        "baseline": baseline.to_dict(),
        "quality": {
            "reviewRequired": True,
            "candidateOnly": True,
            "longitudinalScaleAvailable": False,
            "areaAvailable": False,
        },
        "statistics": {
            "cameraCount": 1,
            "frameCount": len(decoded),
            "processedFrames": len(decoded),
            "rawCandidateCount": raw_candidate_count,
            "candidateCount": len(defects),
            "candidateOverflowCount": candidate_overflow,
            "defectCount": len(defects),
        },
        "defects": defects,
    }


run_depth_geometry = detect_depth_geometry
detect_flow_depth_geometry = detect_depth_geometry


def _numeric_files(
    directory: Path,
    suffix: str,
    *,
    execution_gate: Callable[[str], None] | None = None,
    phase: str = "depth-geometry-directory-scan",
) -> dict[int, Path]:
    result: dict[int, Path] = {}
    if execution_gate is not None:
        execution_gate(phase)
    if not directory.is_dir():
        return result
    for path in directory.iterdir():
        if execution_gate is not None:
            execution_gate(f"{phase}-entry")
        if path.suffix.lower() != suffix.lower() or not path.stem.isdecimal():
            continue
        result[int(path.stem)] = path
    return result


def _metadata_for(
    path: Path,
    *,
    execution_gate: Callable[[str], None] | None = None,
) -> Mapping[str, Any]:
    try:
        if execution_gate is not None:
            execution_gate("depth-geometry-metadata-read")
        with path.open("r", encoding="utf-8") as stream:
            value = json.load(stream)
        return value if isinstance(value, Mapping) else {}
    except (OSError, ValueError, json.JSONDecodeError):
        return {}


def _component_rows_for_frame(
    residual: np.ndarray,
    valid: np.ndarray,
    threshold: np.ndarray,
    *,
    frame_index: int,
    frame_number: int,
    settings: DepthGeometryConfig,
) -> list[dict[str, Any]]:
    """Extract bounded per-frame components for the streaming file path."""

    rows: list[dict[str, Any]] = []
    # ``threshold`` is already max(floor, multiplier * noise); derive the
    # supported mask directly so this path performs exactly one gate.
    active = np.asarray(valid, dtype=bool) & np.isfinite(residual) & (
        np.abs(residual) >= threshold[None, :]
    )
    support = _neighborhood_count(active)
    supported = active & (support >= settings.minimum_support)
    for polarity, polarity_mask in (
        ("protrusion", supported & (residual > 0)),
        ("depression", supported & (residual < 0)),
    ):
        for points in connected_components_8(
            polarity_mask, settings.minimum_component_points
        ):
            values = residual[points[:, 0], points[:, 1]]
            finite_values = values[np.isfinite(values)]
            if finite_values.size == 0:
                continue
            rows.append(
                {
                    "frameIndex": int(frame_index),
                    "frameNumber": int(frame_number),
                    "frameHeight": int(residual.shape[0]),
                    "polarity": polarity,
                    "points": points,
                    "values": finite_values,
                    "minRow": int(np.min(points[:, 0])),
                    "maxRow": int(np.max(points[:, 0])),
                    "minColumn": int(np.min(points[:, 1])),
                    "maxColumn": int(np.max(points[:, 1])),
                    "firstFrameIndex": int(frame_index),
                    "lastFrameIndex": int(frame_index),
                    "firstFrameNumber": int(frame_number),
                    "lastFrameNumber": int(frame_number),
                    "thresholdMedianMm": float(
                        np.median(threshold[points[:, 1]])
                    ),
                }
            )
    return rows


def _group_component_rows(
    component_rows: Sequence[dict[str, Any]],
    settings: DepthGeometryConfig,
) -> list[list[dict[str, Any]]]:
    """Merge same-polarity components across adjacent source frames."""

    if not component_rows:
        return []
    _parents, find, union = _union_find(len(component_rows))
    # A component can only touch the immediately preceding physical frame;
    # index by frame number instead of comparing every pair in the flow.
    # This preserves _components_overlap semantics while avoiding O(N^2)
    # behavior on noisy historical material.
    indices_by_frame: dict[int, list[int]] = {}
    for right_index, right_component in enumerate(component_rows):
        right_frame = int(right_component["firstFrameNumber"])
        left_indices = (
            indices_by_frame.get(right_frame - 1, [])
            if settings.cross_frame_max_gap >= 1
            else []
        )
        for left_index in left_indices:
            left_component = component_rows[left_index]
            if _components_overlap(
                left_component,
                right_component,
                settings.cross_frame_merge_pixels,
                settings.minimum_merge_iou,
            ):
                union(left_index, right_index)
        indices_by_frame.setdefault(right_frame, []).append(right_index)
    grouped: dict[int, list[dict[str, Any]]] = {}
    for index, component in enumerate(component_rows):
        grouped.setdefault(find(index), []).append(component)
    return list(grouped.values())


def _group_candidate_priority(
    members: Sequence[dict[str, Any]],
    settings: DepthGeometryConfig,
) -> tuple[Any, ...]:
    """Sort strongest review candidates first with deterministic tie-breaks."""

    arrays = [
        np.abs(np.asarray(member.get("values", []), dtype=np.float64))
        for member in members
    ]
    arrays = [value[np.isfinite(value)] for value in arrays if value.size]
    values = np.concatenate(arrays) if arrays else np.asarray([], dtype=np.float64)
    point_count = int(values.size)
    peak = float(np.max(values)) if point_count else 0.0
    p95 = float(np.percentile(values, 95.0)) if point_count else 0.0
    support_score = min(
        1.0,
        point_count / max(1.0, settings.minimum_component_points * 4.0),
    )
    depth_score = min(
        1.0,
        p95 / max(settings.minimum_depth_mm * 4.0, 1e-6),
    )
    first = members[0] if members else {}
    return (
        -(0.5 * support_score + 0.5 * depth_score),
        -p95,
        -point_count,
        -peak,
        int(first.get("frameNumber", 0)),
        int(first.get("minRow", 0)),
        int(first.get("minColumn", 0)),
        str(first.get("polarity", "")),
    )


def _limit_candidate_groups(
    groups: Sequence[Sequence[dict[str, Any]]],
    settings: DepthGeometryConfig,
) -> tuple[list[Sequence[dict[str, Any]]], int]:
    raw_count = len(groups)
    limit = settings.maximum_candidates_per_flow
    selected = sorted(
        groups,
        key=lambda members: _group_candidate_priority(members, settings),
    )[:limit]
    return selected, max(0, raw_count - len(selected))


def _group_peak_source_bbox(
    members: Sequence[dict[str, Any]],
    roi: tuple[int, int, int, int],
) -> list[int]:
    """Return the source-image bbox on the group's strongest frame.

    Region ownership depends only on source columns.  Computing this small
    descriptor before ranking lets overlap/boundary artifacts be discarded
    without decoding or retaining their review ROIs, so they cannot consume
    the final review budget ahead of an interior defect.
    """

    left, top, _right, _bottom = roi
    peak_member: dict[str, Any] | None = None
    peak_absolute = -1.0
    for member in members:
        values = np.asarray(member.get("values", []), dtype=np.float64)
        if not values.size:
            continue
        finite = np.isfinite(values)
        if not np.any(finite):
            continue
        absolute = np.where(finite, np.abs(values), -np.inf)
        member_offset = int(np.argmax(absolute))
        member_peak = float(absolute[member_offset])
        if member_peak > peak_absolute:
            peak_absolute = member_peak
            peak_member = member
    if peak_member is None:
        return [left, top, left, top]
    peak_frame = int(peak_member.get("frameNumber", 0))
    peak_frame_points = [
        np.asarray(member.get("points", []), dtype=np.int32)
        for member in members
        if int(member.get("frameNumber", 0)) == peak_frame
    ]
    peak_frame_points = [
        points
        for points in peak_frame_points
        if points.ndim == 2 and points.shape[0] and points.shape[1] >= 2
    ]
    points = (
        np.concatenate(peak_frame_points, axis=0)
        if peak_frame_points
        else np.empty((0, 2), dtype=np.int32)
    )
    if points.ndim != 2 or points.shape[0] == 0 or points.shape[1] < 2:
        return [left, top, left, top]
    # Include every group member on the peak frame, matching the bbox emitted
    # by _geometry_defects_from_groups for transitive cross-frame merges.
    return [
        left + int(np.min(points[:, 1])),
        top + int(np.min(points[:, 0])),
        left + int(np.max(points[:, 1])) + 1,
        top + int(np.max(points[:, 0])) + 1,
    ]


def _filter_candidate_groups_by_disposition(
    groups: Sequence[Sequence[dict[str, Any]]],
    *,
    camera_id: str,
    roi: tuple[int, int, int, int],
    candidate_disposition: Callable[[str, Sequence[int]], str] | None,
) -> tuple[list[Sequence[dict[str, Any]]], int, int, int]:
    if candidate_disposition is None:
        return list(groups), 0, 0, 0
    eligible: list[Sequence[dict[str, Any]]] = []
    overlap_filtered = 0
    boundary_filtered = 0
    quality_gate_filtered = 0
    for members in groups:
        disposition = str(
            candidate_disposition(
                str(camera_id),
                _group_peak_source_bbox(members, roi),
            )
        )
        if disposition == "overlap-duplicate":
            overlap_filtered += 1
        elif disposition == "boundary":
            boundary_filtered += 1
        elif disposition == "quality-gate":
            quality_gate_filtered += 1
        else:
            eligible.append(members)
    return eligible, overlap_filtered, boundary_filtered, quality_gate_filtered


def _defect_candidate_priority(defect: Mapping[str, Any]) -> tuple[Any, ...]:
    peak = defect.get("peakPixel", {})
    peak = peak if isinstance(peak, Mapping) else {}
    return (
        -float(defect.get("ruleScore", 0.0) or 0.0),
        -float(defect.get("p95AbsoluteDepthMm", 0.0) or 0.0),
        -int(defect.get("pointCount", 0) or 0),
        -float(defect.get("absoluteDepthMm", 0.0) or 0.0),
        str(defect.get("cameraId", "")),
        int(defect.get("peakFrame", 0) or 0),
        int(peak.get("row", 0) or 0),
        int(peak.get("column", 0) or 0),
        str(defect.get("id", "")),
    )


def _limit_flow_defects(
    defects: Sequence[dict[str, Any]],
    limit: int,
) -> list[dict[str, Any]]:
    selected = sorted(defects, key=_defect_candidate_priority)[: max(1, int(limit))]
    selected.sort(
        key=lambda item: (
            str(item.get("cameraId", "")),
            int(item.get("peakFrame", 0) or 0),
            int(item.get("peakPixel", {}).get("row", 0) or 0),
            int(item.get("peakPixel", {}).get("column", 0) or 0),
            str(item.get("id", "")),
        )
    )
    return selected


def _geometry_defects_from_groups(
    groups: Sequence[Sequence[dict[str, Any]]],
    *,
    numbers: Sequence[int],
    roi: tuple[int, int, int, int],
    baseline: BaselineEstimate,
    settings: DepthGeometryConfig,
    material_id: str,
    camera_id: str,
    calibration_info: tuple[bool, float | None, float],
    roi_loader: Callable[
        [int, Sequence[int]], tuple[np.ndarray | None, np.ndarray | None]
    ] | None = None,
) -> list[dict[str, Any]]:
    """Serialize grouped components without retaining source full frames.

    ``roi_loader`` is called only after grouping and only for peak frames.  A
    file-backed builder can therefore re-read a bounded number of frames one
    at a time to persist review crops while keeping full depth planes out of
    the candidate list.
    """

    left, top, _right, bottom = roi
    roi_height = max(1, int(bottom - top))
    defects: list[dict[str, Any]] = []
    for raw_members in groups:
        members = list(raw_members)
        if not members:
            continue
        all_points: list[np.ndarray] = []
        all_values: list[np.ndarray] = []
        all_global_rows: list[np.ndarray] = []
        polarity = members[0]["polarity"]
        for member in members:
            member_points = np.asarray(member["points"], dtype=np.int32)
            frame_column = np.full(
                (member_points.shape[0], 1),
                int(member["frameNumber"]),
                dtype=np.int32,
            )
            all_points.append(np.column_stack((frame_column, member_points)))
            all_values.append(np.asarray(member["values"], dtype=np.float64))
            frame_index = int(member.get("frameIndex", 0))
            all_global_rows.append(
                frame_index * roi_height + member_points[:, 0].astype(np.int32)
            )
        points = np.concatenate(all_points, axis=0)
        values = np.concatenate(all_values, axis=0)
        global_rows = np.concatenate(all_global_rows, axis=0)
        if values.size == 0:
            continue
        peak_offset = int(np.argmax(np.abs(values)))
        peak_value = float(values[peak_offset])
        peak_row = int(points[peak_offset, 1])
        peak_column = int(points[peak_offset, 2])
        peak_frame = int(points[peak_offset, 0])
        source_row = top + peak_row
        source_column = left + peak_column
        shape_name, aspect_ratio, major_span, minor_span = _pca_shape(
            points, settings.elongated_aspect_ratio, global_rows
        )
        provisional, class_name = _class_for(polarity, shape_name)
        p05, p95 = np.percentile(values, [5.0, 95.0])
        abs_values = np.abs(values)
        global_min_row, global_max_row = (
            int(np.min(global_rows)),
            int(np.max(global_rows)),
        )
        min_column, max_column = int(np.min(points[:, 2])), int(np.max(points[:, 2]))
        peak_frame_mask = points[:, 0] == peak_frame
        if not np.any(peak_frame_mask):
            peak_frame_mask = np.zeros(points.shape[0], dtype=bool)
            peak_frame_mask[peak_offset] = True
        source_rows = points[peak_frame_mask, 1]
        source_columns = points[peak_frame_mask, 2]
        source_min_row, source_max_row = (
            int(np.min(source_rows)),
            int(np.max(source_rows)),
        )
        source_min_column, source_max_column = (
            int(np.min(source_columns)),
            int(np.max(source_columns)),
        )
        support_score = min(
            1.0,
            len(values) / max(1.0, settings.minimum_component_points * 4.0),
        )
        depth_score = min(
            1.0,
            float(np.percentile(abs_values, 95.0))
            / max(settings.minimum_depth_mm * 4.0, 1e-6),
        )
        rule_score = round(float(0.5 * support_score + 0.5 * depth_score), 6)
        horizontal_start = _horizontal_mm(min_column, left, calibration_info)
        horizontal_end = _horizontal_mm(max_column, left, calibration_info)
        horizontal_center = _horizontal_mm(
            float(np.mean(points[:, 2])), left, calibration_info
        )
        frame_numbers_member = [int(value["frameNumber"]) for value in members]
        # Keep source image coordinates local to the peak frame.  The
        # cross-frame global pixel span is exposed separately below.
        bbox = [
            left + source_min_column,
            top + source_min_row,
            left + source_max_column + 1,
            top + source_max_row + 1,
        ]
        peak_index = next(
            (index for index, number in enumerate(numbers) if number == peak_frame),
            None,
        )
        source_path = next(
            (
                str(member.get("sourcePath"))
                for member in members
                if int(member.get("frameNumber", -1)) == peak_frame
                and member.get("sourcePath")
            ),
            None,
        )
        stable_id = _stable_id(
            material_id,
            camera_id,
            peak_frame,
            source_row,
            source_column,
            polarity,
        )
        defect: dict[str, Any] = {
            "id": stable_id,
            "stableId": stable_id,
            "source": DEPTH_GEOMETRY_SOURCE,
            "algorithm": DEPTH_GEOMETRY_SOURCE,
            "cameraId": str(camera_id),
            "cameraIndex": _camera_index(camera_id),
            "storageIndex": peak_frame,
            "cameraFrameSequence": peak_frame,
            "scoreKind": "geometry-rule",
            "ruleScore": rule_score,
            "ruleScores": {
                "support": round(float(support_score), 6),
                "depth": round(float(depth_score), 6),
                "thresholdMedianMm": round(
                    float(np.median([member["thresholdMedianMm"] for member in members])),
                    6,
                ),
            },
            "confidence": rule_score,
            "severity": "review",
            "reviewOnly": True,
            "provisionalClass": class_name,
            "provisionalType": provisional,
            "class": class_name,
            "type": class_name,
            "classId": f"geometry-{class_name}",
            "className": class_name,
            "polarity": polarity,
            "shape": shape_name,
            "aspectRatio": round(aspect_ratio, 6),
            "signedDepthMm": round(peak_value, 6),
            "absoluteDepthMm": round(float(np.max(abs_values)), 6),
            "depthMm": round(float(np.max(abs_values)), 6),
            "p05DepthMm": round(float(p05), 6),
            "p95DepthMm": round(float(p95), 6),
            "p05": round(float(p05), 6),
            "p95": round(float(p95), 6),
            "p05AbsoluteDepthMm": round(float(np.percentile(abs_values, 5.0)), 6),
            "p95AbsoluteDepthMm": round(float(np.percentile(abs_values, 95.0)), 6),
            "pointCount": int(points.shape[0]),
            "pixelSpan": {
                "width": int(max_column - min_column + 1),
                "height": int(global_max_row - global_min_row + 1),
                "major": round(major_span, 6),
                "minor": round(minor_span, 6),
            },
            "pixelWidth": int(source_max_column - source_min_column + 1),
            "pixelHeight": int(source_max_row - source_min_row + 1),
            "pixelSpanWidth": int(max_column - min_column + 1),
            "pixelSpanHeight": int(global_max_row - global_min_row + 1),
            "bbox": bbox,
            "imageRect2d": {
                "left": bbox[0],
                "top": bbox[1],
                "right": bbox[2],
                "bottom": bbox[3],
            },
            "reviewCropRect": {
                "left": bbox[0],
                "top": bbox[1],
                "right": bbox[2],
                "bottom": bbox[3],
                "width": bbox[2] - bbox[0],
                "height": bbox[3] - bbox[1],
            },
            "frameStart": min(frame_numbers_member),
            "frameEnd": max(frame_numbers_member),
            "frameSpan": int(max(frame_numbers_member) - min(frame_numbers_member) + 1),
            "peakFrame": peak_frame,
            "peakFrameIndex": peak_index,
            "peakPixel": {"row": source_row, "column": source_column},
            "horizontalStartMm": _as_json_number(horizontal_start),
            "horizontalEndMm": _as_json_number(horizontal_end),
            "horizontalCenterMm": _as_json_number(horizontal_center),
            "horizontalMm": _as_json_number(horizontal_center),
            "horizontalSpanMm": _as_json_number(
                abs(horizontal_end - horizontal_start)
                if horizontal_start is not None and horizontal_end is not None
                else None
            ),
            "longitudinalMm": None,
            "longitudinalSpanMm": None,
            "areaMm2": None,
            "depthDeviation": {
                "available": True,
                "signedMm": round(peak_value, 6),
                "absoluteMm": round(float(np.max(abs_values)), 6),
                "p05Mm": round(float(p05), 6),
                "p95Mm": round(float(p95), 6),
                "unit": "mm",
            },
            "source3d": source_path,
            "reviewImage": None,
            "intensityRoi": None,
            "residualJetRoi": None,
            "roiArtifacts": {
                "intensity": {
                    "available": False,
                    "bbox": bbox,
                    "padding": settings.roi_padding,
                },
                "residualJet": {
                    "available": True,
                    "bbox": [
                        source_min_column,
                        source_min_row,
                        source_max_column + 1,
                        source_max_row + 1,
                    ],
                    "padding": settings.roi_padding,
                    "displayRangeMm": settings.jet_range_mm,
                },
            },
        }
        if roi_loader is not None:
            intensity_value, residual_value = roi_loader(
                peak_frame,
                [
                    source_min_column,
                    source_min_row,
                    source_max_column + 1,
                    source_max_row + 1,
                ],
            )
            if intensity_value is not None:
                defect["intensityRoi"] = np.asarray(intensity_value).tolist()
                defect["roiArtifacts"]["intensity"]["available"] = True
            if residual_value is not None:
                defect["residualJetRoi"] = np.asarray(residual_value).tolist()
        defects.append(defect)
    defects.sort(
        key=lambda item: (
            int(item.get("peakFrame", 0)),
            int(item.get("peakPixel", {}).get("row", 0)),
            int(item.get("peakPixel", {}).get("column", 0)),
            str(item.get("id", "")),
        )
    )
    return defects


def _stream_camera_depth_geometry(
    *,
    camera_id: str,
    material_id: str,
    flow_root: Path,
    depth_files: Mapping[int, Path],
    metadata_files: Mapping[int, Path],
    indices: Sequence[int],
    settings: DepthGeometryConfig,
    calibration: Mapping[str, Any] | None = None,
    execution_gate: Callable[[str], None] | None = None,
    candidate_disposition: Callable[[str, Sequence[int]], str] | None = None,
) -> dict[str, Any]:
    """Process a file-backed camera in two bounded passes.

    The first pass decodes only the evenly-spaced baseline sample (maximum 32
    frames).  The second pass decodes one frame at a time and stores only
    component coordinates/values.  Review ROIs are re-read from peak frames
    after grouping, with at most one full frame resident during that bounded
    operation.
    """

    frame_numbers = [int(value) for value in indices]
    if not frame_numbers:
        return {
            "schema": DEPTH_GEOMETRY_SCHEMA,
            "algorithm": DEPTH_GEOMETRY_SOURCE,
            "state": "empty",
            "materialId": str(material_id),
            "cameraId": str(camera_id),
            "config": settings.to_dict(),
            "configHash": config_hash(settings),
            "defects": [],
            "statistics": {
                "cameraCount": 1,
                "frameCount": 0,
                "processedFrames": 0,
                "candidateCount": 0,
                "defectCount": 0,
            },
        }

    # Pass one: only sample frames are decoded and retained until their
    # per-column baseline/noise has been estimated.
    sample_positions = _sample_indices(
        len(frame_numbers), settings.baseline_max_frames
    )
    sampled_values: list[np.ndarray] = []
    sampled_masks: list[np.ndarray] = []
    shape: tuple[int, int] | None = None
    calibration_metadata: Mapping[str, Any] | None = None
    for position in sample_positions:
        frame_number = frame_numbers[position]
        metadata_path = metadata_files[frame_number]
        frame_metadata = _metadata_for(
            metadata_path, execution_gate=execution_gate
        )
        if calibration_metadata is None and horizontal_calibration_from_metadata(
            frame_metadata
        )[0]:
            calibration_metadata = frame_metadata
        decoded = _prepare_frame(
            depth_files[frame_number],
            frame_number,
            frame_metadata,
            load_intensity=False,
            execution_gate=execution_gate,
        )
        if shape is None:
            shape = decoded.millimeters.shape
            left, top, right, bottom = _common_roi(shape, settings.roi)
        elif decoded.millimeters.shape != shape:
            raise ValueError("all depth frames must share one 2D shape")
        sampled_values.append(decoded.millimeters[top:bottom, left:right])
        sampled_masks.append(decoded.valid[top:bottom, left:right])
        del decoded
    if shape is None:
        raise ValueError("depth baseline sample could not be decoded")
    baseline = estimate_flow_baseline(
        sampled_values,
        sampled_masks,
        max_frames=settings.baseline_max_frames,
        row_step=settings.baseline_row_step,
    )
    baseline = replace(
        baseline,
        sampled_frame_indices=tuple(
            frame_numbers[position] for position in sample_positions
        ),
    )
    # Release the sample planes before the second pass.  Baseline/noise are
    # only one-dimensional arrays and remain resident for the camera.
    del sampled_values, sampled_masks

    component_rows: list[dict[str, Any]] = []
    for ordinal, frame_number in enumerate(frame_numbers):
        frame_metadata = _metadata_for(
            metadata_files[frame_number], execution_gate=execution_gate
        )
        decoded = _prepare_frame(
            depth_files[frame_number],
            frame_number,
            frame_metadata,
            load_intensity=False,
            execution_gate=execution_gate,
        )
        if decoded.millimeters.shape != shape:
            raise ValueError("all depth frames must share one 2D shape")
        value = decoded.millimeters[top:bottom, left:right]
        valid = decoded.valid[top:bottom, left:right]
        residual = apply_depth_residual(value, valid, baseline.baseline_mm)
        threshold = np.maximum(
            settings.minimum_depth_mm,
            settings.noise_multiplier
            * np.nan_to_num(baseline.column_noise_mm, nan=0.0),
        ).astype(np.float32)
        rows = _component_rows_for_frame(
            residual,
            valid,
            threshold,
            frame_index=ordinal,
            frame_number=frame_number,
            settings=settings,
        )
        for row in rows:
            row["sourcePath"] = str(depth_files[frame_number])
        component_rows.extend(rows)
        # Do not retain full-frame values, validity, residual, or decoded
        # metadata across iterations.
        del decoded, value, valid, residual, threshold, rows

    raw_groups = _group_component_rows(component_rows, settings)
    raw_candidate_count = len(raw_groups)
    (
        eligible_groups,
        overlap_filtered,
        boundary_filtered,
        quality_gate_filtered,
    ) = (
        _filter_candidate_groups_by_disposition(
            raw_groups,
            camera_id=camera_id,
            roi=(left, top, right, bottom),
            candidate_disposition=candidate_disposition,
        )
    )
    eligible_candidate_count = len(eligible_groups)
    groups, _eligible_overflow = _limit_candidate_groups(eligible_groups, settings)
    del raw_groups, component_rows
    calibration_info = _calibration_from(settings, calibration)
    if calibration is None and not settings.calibration_valid and not calibration_info[0]:
        if calibration_metadata is not None:
            calibration_info = horizontal_calibration_from_metadata(
                calibration_metadata
            )

    # Keep one re-read frame as an LRU of size one.  Grouping can produce many
    # candidates on a single peak frame, and this avoids reopening it for each
    # crop without making full-frame memory proportional to candidate count.
    roi_cache_number: int | None = None
    roi_cache_residual: np.ndarray | None = None
    roi_cache_intensity: np.ndarray | None = None

    def load_review_rois(
        peak_frame: int,
        local_bbox: Sequence[int],
    ) -> tuple[np.ndarray | None, np.ndarray | None]:
        nonlocal roi_cache_number, roi_cache_residual, roi_cache_intensity
        if roi_cache_number != int(peak_frame):
            frame_metadata = _metadata_for(
                metadata_files[int(peak_frame)], execution_gate=execution_gate
            )
            decoded = _prepare_frame(
                depth_files[int(peak_frame)],
                int(peak_frame),
                frame_metadata,
                load_intensity=False,
                execution_gate=execution_gate,
            )
            value = decoded.millimeters[top:bottom, left:right]
            valid = decoded.valid[top:bottom, left:right]
            roi_cache_residual = apply_depth_residual(value, valid, baseline.baseline_mm)
            roi_cache_intensity = None
            intensity_path = flow_root / "2d" / f"{int(peak_frame)}.png"
            if execution_gate is not None:
                execution_gate(f"depth-geometry-roi-intensity-stat:{peak_frame}")
            if intensity_path.is_file():
                if execution_gate is not None:
                    execution_gate(f"depth-geometry-roi-intensity-read:{peak_frame}")
                try:
                    with Image.open(intensity_path) as image:
                        roi_cache_intensity = np.asarray(image.convert("L"))
                except (OSError, ValueError):
                    roi_cache_intensity = None
            roi_cache_number = int(peak_frame)
            del decoded, value, valid
        if roi_cache_residual is None:
            return None, None
        local_left, local_top, local_right, local_bottom = (
            int(value) for value in local_bbox
        )
        width = max(1, local_right - local_left)
        height = max(1, local_bottom - local_top)
        crop_padding = max(
            settings.roi_padding,
            int(
                math.ceil(
                    max(settings.review_crop_minimum_size - width,
                        settings.review_crop_minimum_size - height, 0)
                    / 2.0
                )
            ),
        )
        residual_crop = residual_jet_roi(
            roi_cache_residual,
            [local_left, local_top, local_right, local_bottom],
            padding=crop_padding,
            display_range_mm=settings.jet_range_mm,
        )
        intensity_crop: np.ndarray | None = None
        if roi_cache_intensity is not None:
            intensity_crop = np.asarray(
                intensity_roi(
                    roi_cache_intensity,
                    {
                        "left": left + local_left,
                        "top": top + local_top,
                        "right": left + local_right,
                        "bottom": top + local_bottom,
                    },
                    padding=crop_padding,
                )
            )
        return intensity_crop, np.asarray(residual_crop)

    defects = _geometry_defects_from_groups(
        groups,
        numbers=frame_numbers,
        roi=(left, top, right, bottom),
        baseline=baseline,
        settings=settings,
        material_id=material_id,
        camera_id=camera_id,
        calibration_info=calibration_info,
        roi_loader=load_review_rois,
    )
    # The last cached full frame is no longer needed once every crop has been
    # converted into a bounded RGB list.
    del roi_cache_residual, roi_cache_intensity
    return {
        "schema": DEPTH_GEOMETRY_SCHEMA,
        "algorithm": DEPTH_GEOMETRY_SOURCE,
        "state": "ready",
        "generatedAt": None,
        "materialId": str(material_id),
        "cameraId": str(camera_id),
        "config": settings.to_dict(),
        "configHash": config_hash(settings),
        "roi": [left, top, right, bottom],
        "metric": {
            "horizontalValid": bool(calibration_info[0]),
            "horizontalPixelPitchMm": _as_json_number(calibration_info[1])
            if calibration_info[0]
            else None,
            "longitudinalValid": False,
            "areaValid": False,
        },
        "metricValid": bool(calibration_info[0]),
        "baseline": baseline.to_dict(),
        "quality": {
            "reviewRequired": True,
            "candidateOnly": True,
            "longitudinalScaleAvailable": False,
            "areaAvailable": False,
        },
        "statistics": {
            "cameraCount": 1,
            "frameCount": len(frame_numbers),
            "processedFrames": len(frame_numbers),
            "rawCandidateCount": raw_candidate_count,
            "eligibleCandidateCount": eligible_candidate_count,
            "candidateCount": len(defects),
            "candidateOverflowCount": max(0, raw_candidate_count - len(defects)),
            "defectCount": len(defects),
            "overlapDuplicateFilteredCount": overlap_filtered,
            "boundaryArtifactFilteredCount": boundary_filtered,
            "qualityGateFilteredCount": quality_gate_filtered,
        },
        "defects": defects,
    }


def _aligned_frame_indices(
    indices: Sequence[int],
    camera_alignment: Mapping[str, Any] | None,
    edge_guard_frames: int,
) -> list[int]:
    """Apply alignment boundaries and reliable head/tail transition guards.

    Alignment frame indexes describe the first/last frame that may contain
    steel.  Those boundary blocks can still be partial, so a detected and
    non-clipped boundary gets a bounded guard on the steel-facing side.  A
    clipped boundary keeps the historical frame-index filter but deliberately
    receives no additional guard: the capture itself does not provide enough
    evidence to know which side of the boundary is safe to discard.
    """

    result = [int(value) for value in indices]
    if not isinstance(camera_alignment, Mapping):
        return result
    guard = max(0, int(edge_guard_frames))
    for name, is_head in (("head", True), ("tail", False)):
        boundary = camera_alignment.get(name)
        if not isinstance(boundary, Mapping) or not bool(boundary.get("detected")):
            continue
        try:
            frame_index = int(boundary.get("frameIndex"))
        except (TypeError, ValueError):
            # Preserve the valid portion of the other boundary when a stale
            # alignment record is malformed rather than failing the flow.
            continue
        if is_head:
            result = [value for value in result if value >= frame_index]
            if not bool(boundary.get("clipped")) and guard:
                result = [value for value in result if value >= frame_index + guard]
        else:
            result = [value for value in result if value <= frame_index]
            if not bool(boundary.get("clipped")) and guard:
                result = [value for value in result if value <= frame_index - guard]
    return result


def build_flow_depth_geometry(
    camera_roots: Mapping[str, str | Path],
    storage_root: str | Path,
    material_id: str,
    alignment: Mapping[str, Any] | None,
    config: DepthGeometryConfig | Mapping[str, Any],
    execution_gate: Callable[[str], None] | None = None,
    candidate_disposition: Callable[[str, Sequence[int]], str] | None = None,
) -> dict[str, Any]:
    """Build the per-camera geometry artifact from immutable flow files.

    ``storage_root`` is accepted for parity with the legacy builder and future
    artifact writers; raw input remains isolated to each camera root.  The
    returned ``cameras`` map is intentionally unmerged so the database/UI can
    preserve camera provenance.
    """

    del storage_root
    settings = (
        config.bounded()
        if isinstance(config, DepthGeometryConfig)
        else DepthGeometryConfig.from_mapping(config)
    )
    base: dict[str, Any] = {
        "schema": DEPTH_GEOMETRY_SCHEMA,
        "algorithm": DEPTH_GEOMETRY_SOURCE,
        "state": "disabled" if not settings.enabled else "ready",
        "materialId": str(material_id),
        "config": settings.to_dict(),
        "configHash": config_hash(settings),
        "quality": {
            "reviewRequired": True,
            "candidateOnly": True,
            "longitudinalScaleAvailable": False,
            "areaAvailable": False,
        },
        "cameras": {},
        "defects": [],
        "statistics": {
            "cameraCount": len(camera_roots),
            "frameCount": 0,
            "processedFrames": 0,
            "rawCandidateCount": 0,
            "eligibleCandidateCount": 0,
            "preFlowCapCandidateCount": 0,
            "candidateCount": 0,
            "candidateOverflowCount": 0,
            "defectCount": 0,
            "overlapDuplicateFilteredCount": 0,
            "boundaryArtifactFilteredCount": 0,
            "qualityGateFilteredCount": 0,
        },
    }
    if not settings.enabled:
        return base
    alignment_map = alignment if isinstance(alignment, Mapping) else {}
    alignment_cameras = alignment_map.get("cameras", {})
    if not isinstance(alignment_cameras, Mapping):
        alignment_cameras = {}
    camera_items = sorted(
        ((str(camera_id), root_value) for camera_id, root_value in camera_roots.items()),
        key=lambda item: item[0],
    )

    def build_camera(item: tuple[str, str | Path]) -> tuple[str, dict[str, Any]]:
        camera, root_value = item
        if execution_gate is not None:
            execution_gate(f"depth-geometry-camera:{camera}")
        flow = capture_root(Path(root_value), material_id, camera)
        depth_files = _numeric_files(
            flow / "3d",
            ".npz",
            execution_gate=execution_gate,
            phase="depth-geometry-depth-directory-scan",
        )
        metadata_files = _numeric_files(
            flow / "json",
            ".json",
            execution_gate=execution_gate,
            phase="depth-geometry-metadata-directory-scan",
        )
        indices = sorted(set(depth_files) & set(metadata_files))
        camera_alignment = alignment_cameras.get(camera, {})
        indices = _aligned_frame_indices(
            indices,
            camera_alignment,
            settings.longitudinal_edge_guard_frames,
        )
        if settings.max_frames > 0 and len(indices) > settings.max_frames:
            eligible_indices = list(indices)
            positions = _sample_indices(len(eligible_indices), settings.max_frames)
            # _sample_indices returns ordinal positions for this already
            # head/tail-filtered list.
            indices = [eligible_indices[position] for position in positions]
        camera_artifact = _stream_camera_depth_geometry(
            camera_id=camera,
            material_id=str(material_id),
            flow_root=flow,
            depth_files=depth_files,
            metadata_files=metadata_files,
            indices=indices,
            settings=settings,
            execution_gate=execution_gate,
            candidate_disposition=candidate_disposition,
        )
        return camera, camera_artifact

    # Submit in camera order and consume futures in that same order.  The
    # filesystem/decode work is parallel, while artifact insertion and defect
    # concatenation remain deterministic for callers and JSON hashes.
    if camera_items:
        with ThreadPoolExecutor(
            max_workers=settings.camera_workers,
            thread_name_prefix="depth-geometry-camera",
        ) as executor:
            futures = [executor.submit(build_camera, item) for item in camera_items]
            camera_results = [future.result() for future in futures]
    else:
        camera_results = []

    for camera, camera_artifact in camera_results:
        base["cameras"][camera] = camera_artifact
        base["defects"].extend(camera_artifact.get("defects", []))
        statistics = camera_artifact.get("statistics", {})
        base["statistics"]["frameCount"] += int(statistics.get("frameCount", 0) or 0)
        base["statistics"]["processedFrames"] += int(
            statistics.get("processedFrames", 0) or 0
        )
        base["statistics"]["rawCandidateCount"] += int(
            statistics.get(
                "rawCandidateCount", statistics.get("candidateCount", 0)
            )
            or 0
        )
        base["statistics"]["eligibleCandidateCount"] += int(
            statistics.get(
                "eligibleCandidateCount",
                statistics.get("rawCandidateCount", statistics.get("candidateCount", 0)),
            )
            or 0
        )
        base["statistics"]["preFlowCapCandidateCount"] += int(
            statistics.get("candidateCount", 0) or 0
        )
        base["statistics"]["overlapDuplicateFilteredCount"] += int(
            statistics.get("overlapDuplicateFilteredCount", 0) or 0
        )
        base["statistics"]["boundaryArtifactFilteredCount"] += int(
            statistics.get("boundaryArtifactFilteredCount", 0) or 0
        )
        base["statistics"]["qualityGateFilteredCount"] += int(
            statistics.get("qualityGateFilteredCount", 0) or 0
        )
    base["defects"] = _limit_flow_defects(
        base["defects"], settings.maximum_candidates_per_flow
    )
    selected_ids = {str(item.get("id", "")) for item in base["defects"]}
    for camera_artifact in base["cameras"].values():
        camera_defects = [
            item
            for item in camera_artifact.get("defects", [])
            if str(item.get("id", "")) in selected_ids
        ]
        camera_artifact["defects"] = camera_defects
        camera_statistics = camera_artifact.setdefault("statistics", {})
        camera_statistics["candidateCount"] = len(camera_defects)
        camera_statistics["defectCount"] = len(camera_defects)
        camera_statistics["candidateOverflowCount"] = max(
            0,
            int(camera_statistics.get("rawCandidateCount", 0) or 0)
            - len(camera_defects),
        )
    final_count = len(base["defects"])
    base["statistics"]["candidateCount"] = final_count
    base["statistics"]["defectCount"] = final_count
    base["statistics"]["candidateOverflowCount"] = max(
        0,
        int(base["statistics"]["rawCandidateCount"]) - final_count,
    )
    return base


build_depth_geometry = build_flow_depth_geometry


__all__ = [
    "DEPTH_GEOMETRY_SCHEMA",
    "DEPTH_GEOMETRY_CONFIG_SCHEMA",
    "DEPTH_GEOMETRY_SOURCE",
    "DepthGeometryConfig",
    "DepthFrame",
    "BaselineEstimate",
    "load_depth_geometry_config",
    "parse_depth_geometry_config",
    "config_hash",
    "depth_scale_offset_invalid",
    "horizontal_calibration_from_metadata",
    "convert_raw_depth",
    "decode_raw_depth",
    "raw_depth_to_mm",
    "depth_to_millimeters",
    "estimate_flow_baseline",
    "estimate_baseline",
    "apply_depth_residual",
    "compute_depth_residual",
    "threshold_depth_residual",
    "connected_components_8",
    "extract_roi",
    "intensity_roi",
    "build_intensity_roi",
    "residual_jet_roi",
    "build_residual_jet_roi",
    "load_depth_frame",
    "detect_depth_geometry",
    "run_depth_geometry",
    "detect_flow_depth_geometry",
    "build_flow_depth_geometry",
    "build_depth_geometry",
]
