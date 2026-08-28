"""Bounded post-flow surface-defect detection using temporary legacy models.

The detector intentionally runs only after a flow is closed and its storage
queue is empty.  It consumes the immutable ``2d/*.png``, ``3d/*.npz`` and
``json/*.json`` artifacts, writes review crops plus a traceable manifest, and
never mutates the acquisition files.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import os
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib import request

import numpy as np
from PIL import Image

from .paths import (
    capture_root,
    defect_image_root,
    defect_manifest_path,
    surface_path,
)

from .alignment import _atomic_json, _read_json, _numeric_files
from .defect_comparison import compose_dual_manifest
from .depth_geometry import (
    DEPTH_GEOMETRY_SOURCE,
    DepthGeometryConfig,
    build_flow_depth_geometry,
)
from .depth_geometry_runtime import (
    DepthGeometryConfigChanged,
    config_checkpoint,
    load_depth_geometry_config_snapshot,
)
from .playback import detect_valid_grayscale_roi
from .regions import read_region_manifest, region_manifest_path
from .storage import replace_file


DEFECT_DETECTION_SCHEMA = "steel.sick-flow-defect-detection.v1"
MODEL_MANIFEST_SCHEMA = "steel.temporary-defect-model-set.v1"
_DLL_DIRECTORY_HANDLES: dict[str, Any] = {}
_DETECTOR_CACHE: dict[tuple[Any, ...], "OnnxYoloDetector"] = {}
_CLASSIFIER_CACHE: dict[tuple[Any, ...], "OnnxDefectClassifier"] = {}
_LEGACY_MODEL_HASH_CACHE: dict[tuple[Any, ...], str] = {}


def _ensure_cuda_dll_directory() -> None:
    cuda_path = os.environ.get("CUDA_PATH", "").strip()
    if os.name != "nt" or not cuda_path or not hasattr(os, "add_dll_directory"):
        return
    cuda_bin = (Path(cuda_path) / "bin").resolve()
    key = os.path.normcase(str(cuda_bin))
    if key in _DLL_DIRECTORY_HANDLES or not cuda_bin.is_dir():
        return
    _DLL_DIRECTORY_HANDLES[key] = os.add_dll_directory(str(cuda_bin))


class ExecutionGateInterrupted(RuntimeError):
    """Control-flow signal raised when opportunistic work must stop."""


@dataclass(frozen=True)
class DefectDetectionConfig:
    enabled: bool = False
    model_2d_path: Path | None = None
    model_3d_path: Path | None = None
    classifier_2d_path: Path | None = None
    classifier_3d_path: Path | None = None
    model_manifest_path: Path | None = None
    image_size: int = 640
    confidence_threshold: float = 0.25
    iou_threshold: float = 0.25
    merge_iou_threshold: float = 0.20
    maximum_detections_per_frame: int = 100
    inference_batch_size: int = 8
    preprocess_workers: int = 2
    classification_confidence_threshold: float = 0.55
    frame_stride: int = 1
    cpu_frame_stride: int = 8
    gpu_device_id: int = 1
    depth_exposure: float = 300.0
    depth_baseline_sample_step: int = 4
    minimum_crop_size: int = 32
    review_crop_minimum_size: int = 64
    capture_origin: str = ""
    database_origin: str = ""
    maximum_idle_wait_seconds: float = 300.0
    maximum_pending_storage_rounds: int = 0
    require_approved_region_map: bool = False
    realtime_priority_status_path: Path | None = None
    depth_geometry_profile_path: Path | None = None
    history_rebuild: bool = False

    def bounded(self) -> "DefectDetectionConfig":
        return DefectDetectionConfig(
            enabled=bool(self.enabled),
            model_2d_path=self.model_2d_path,
            model_3d_path=self.model_3d_path,
            classifier_2d_path=self.classifier_2d_path,
            classifier_3d_path=self.classifier_3d_path,
            model_manifest_path=self.model_manifest_path,
            image_size=max(320, min(1280, int(self.image_size))),
            confidence_threshold=max(
                0.01, min(0.99, float(self.confidence_threshold))
            ),
            iou_threshold=max(0.01, min(0.99, float(self.iou_threshold))),
            merge_iou_threshold=max(
                0.01, min(0.99, float(self.merge_iou_threshold))
            ),
            maximum_detections_per_frame=max(
                1, min(1000, int(self.maximum_detections_per_frame))
            ),
            inference_batch_size=max(1, min(32, int(self.inference_batch_size))),
            preprocess_workers=max(1, min(4, int(self.preprocess_workers))),
            classification_confidence_threshold=max(
                0.01, min(0.99, float(self.classification_confidence_threshold))
            ),
            frame_stride=max(1, min(128, int(self.frame_stride))),
            cpu_frame_stride=max(1, min(128, int(self.cpu_frame_stride))),
            gpu_device_id=max(0, min(31, int(self.gpu_device_id))),
            depth_exposure=max(1.0, min(5000.0, float(self.depth_exposure))),
            depth_baseline_sample_step=max(
                1, min(16, int(self.depth_baseline_sample_step))
            ),
            minimum_crop_size=max(8, min(256, int(self.minimum_crop_size))),
            review_crop_minimum_size=max(
                64, min(1024, int(self.review_crop_minimum_size))
            ),
            capture_origin=str(self.capture_origin).strip().rstrip("/"),
            database_origin=str(self.database_origin).strip().rstrip("/"),
            maximum_idle_wait_seconds=max(
                1.0, min(3600.0, float(self.maximum_idle_wait_seconds))
            ),
            maximum_pending_storage_rounds=max(
                0, min(128, int(self.maximum_pending_storage_rounds))
            ),
            require_approved_region_map=bool(self.require_approved_region_map),
            realtime_priority_status_path=self.realtime_priority_status_path,
            depth_geometry_profile_path=self.depth_geometry_profile_path,
            history_rebuild=bool(self.history_rebuild),
        )


def _utc_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _sha256_file(
    path: Path, *, execution_gate: Callable[[str], None] | None = None
) -> str:
    digest = hashlib.sha256()
    if execution_gate is not None:
        execution_gate("defect-model-hash-open")
    with path.open("rb") as stream:
        while True:
            if execution_gate is not None:
                execution_gate("defect-model-hash-block")
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def defect_detection_manifest_path(storage_root: Path, material_id: str) -> Path:
    return defect_manifest_path(storage_root, material_id)


def _letterbox_rgb(
    image: np.ndarray,
    size: int,
) -> tuple[np.ndarray, float, tuple[float, float]]:
    value = np.asarray(image, dtype=np.uint8)
    if value.ndim != 3 or value.shape[2] != 3:
        raise ValueError(f"detector image must be RGB HWC: {value.shape}")
    height, width = value.shape[:2]
    if height <= 0 or width <= 0:
        raise ValueError("detector image is empty")
    scale = min(size / width, size / height)
    resized_width = max(1, min(size, int(round(width * scale))))
    resized_height = max(1, min(size, int(round(height * scale))))
    left = (size - resized_width) // 2
    top = (size - resized_height) // 2
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    resized = Image.fromarray(value, mode="RGB").resize(
        (resized_width, resized_height),
        Image.Resampling.BILINEAR,
    )
    canvas.paste(resized, (left, top))
    tensor = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None]
    tensor = np.ascontiguousarray(tensor / 255.0)
    return tensor, scale, (float(left), float(top))


def _xywh_to_xyxy(boxes: np.ndarray) -> np.ndarray:
    result = np.empty_like(boxes, dtype=np.float32)
    result[:, 0] = boxes[:, 0] - boxes[:, 2] / 2.0
    result[:, 1] = boxes[:, 1] - boxes[:, 3] / 2.0
    result[:, 2] = boxes[:, 0] + boxes[:, 2] / 2.0
    result[:, 3] = boxes[:, 1] + boxes[:, 3] / 2.0
    return result


def _box_iou_one(box: np.ndarray, others: np.ndarray) -> np.ndarray:
    if others.size == 0:
        return np.empty(0, dtype=np.float32)
    left = np.maximum(box[0], others[:, 0])
    top = np.maximum(box[1], others[:, 1])
    right = np.minimum(box[2], others[:, 2])
    bottom = np.minimum(box[3], others[:, 3])
    intersection = np.maximum(0.0, right - left) * np.maximum(0.0, bottom - top)
    box_area = max(0.0, float(box[2] - box[0])) * max(
        0.0, float(box[3] - box[1])
    )
    other_area = np.maximum(0.0, others[:, 2] - others[:, 0]) * np.maximum(
        0.0, others[:, 3] - others[:, 1]
    )
    return intersection / np.maximum(box_area + other_area - intersection, 1e-9)


def _nms(boxes: np.ndarray, scores: np.ndarray, threshold: float, limit: int) -> list[int]:
    order = np.argsort(scores)[::-1]
    retained: list[int] = []
    while order.size and len(retained) < limit:
        winner = int(order[0])
        retained.append(winner)
        if order.size == 1:
            break
        remaining = order[1:]
        order = remaining[_box_iou_one(boxes[winner], boxes[remaining]) <= threshold]
    return retained


def decode_yolov5_predictions(
    predictions: np.ndarray,
    *,
    original_shape: tuple[int, int],
    scale: float,
    padding: tuple[float, float],
    confidence_threshold: float,
    iou_threshold: float,
    maximum_detections: int,
    class_id: int = 1,
) -> list[dict[str, Any]]:
    value = np.asarray(predictions)
    if value.ndim == 3:
        if value.shape[0] != 1:
            raise ValueError(f"single-image prediction expected: {value.shape}")
        value = value[0]
    if value.ndim != 2 or value.shape[1] < 7:
        raise ValueError(f"unexpected YOLOv5 output: {value.shape}")
    if class_id < 0 or 5 + class_id >= value.shape[1]:
        raise ValueError(f"class {class_id} unavailable in output {value.shape}")
    scores = value[:, 4] * value[:, 5 + class_id]
    selected = np.flatnonzero(scores >= confidence_threshold)
    if selected.size == 0:
        return []
    boxes = _xywh_to_xyxy(value[selected, :4].astype(np.float32, copy=False))
    selected_scores = scores[selected].astype(np.float32, copy=False)
    left, top = padding
    boxes[:, [0, 2]] = (boxes[:, [0, 2]] - left) / max(scale, 1e-9)
    boxes[:, [1, 3]] = (boxes[:, [1, 3]] - top) / max(scale, 1e-9)
    height, width = original_shape
    boxes[:, [0, 2]] = np.clip(boxes[:, [0, 2]], 0, width)
    boxes[:, [1, 3]] = np.clip(boxes[:, [1, 3]], 0, height)
    valid = (boxes[:, 2] - boxes[:, 0] >= 2) & (boxes[:, 3] - boxes[:, 1] >= 2)
    boxes = boxes[valid]
    selected_scores = selected_scores[valid]
    if boxes.size == 0:
        return []
    keep = _nms(boxes, selected_scores, iou_threshold, maximum_detections)
    return [
        {
            "rect": [int(round(coordinate)) for coordinate in boxes[index]],
            "confidence": round(float(selected_scores[index]), 6),
            "modelClassId": class_id,
            "modelClassName": "defect",
        }
        for index in keep
    ]


def _jet_rgb(gray: np.ndarray) -> np.ndarray:
    value = np.asarray(gray, dtype=np.float32) / 255.0
    red = np.clip(1.5 - np.abs(4.0 * value - 3.0), 0.0, 1.0)
    green = np.clip(1.5 - np.abs(4.0 * value - 2.0), 0.0, 1.0)
    blue = np.clip(1.5 - np.abs(4.0 * value - 1.0), 0.0, 1.0)
    return np.rint(np.stack((red, green, blue), axis=-1) * 255.0).astype(np.uint8)


def _nanmedian_without_empty_warning(values: np.ndarray, axis: int) -> np.ndarray:
    """Compute a NaN median without mutating process-global warning filters."""
    finite = np.isfinite(values)
    empty = ~np.any(finite, axis=axis)
    if not np.any(empty):
        return np.nanmedian(values, axis=axis)
    working = values.copy()
    if axis == 0:
        working[0, empty] = 0.0
    elif axis == 1:
        working[empty, 0] = 0.0
    else:
        raise ValueError(f"unsupported median axis: {axis}")
    result = np.nanmedian(working, axis=axis)
    result[empty] = np.nan
    return result


def flatten_depth_for_detection(
    depth: np.ndarray,
    metadata: dict[str, Any],
    crop_box: list[int],
    exposure: float,
    baseline_sample_step: int = 1,
) -> tuple[np.ndarray, np.ndarray]:
    raw = np.asarray(depth)
    if raw.ndim != 2:
        raise ValueError(f"depth plane must be 2D: {raw.shape}")
    left, top, right, bottom = crop_box
    cropped = raw[top:bottom, left:right].astype(np.float32)
    coordinate = metadata.get("bdConfig", {}).get("CoordinateC", {})
    scale = float(coordinate.get("Scan3dCoordinateScale", 1.0) or 1.0)
    offset = float(coordinate.get("Scan3dCoordinateOffset", 0.0) or 0.0)
    invalid = float(coordinate.get("Scan3dInvalidDataValue", 0.0) or 0.0)
    valid = np.isfinite(cropped) & (cropped != invalid) & (cropped != 0)
    millimeters = cropped * scale + offset
    millimeters[~valid] = np.nan
    sample_step = max(1, min(16, int(baseline_sample_step)))
    # A full median over every 2560x1024 depth frame dominates end-to-end
    # latency while adding little robustness: the line-scan baseline varies
    # slowly and still has hundreds of samples after bounded decimation.  Only
    # the baseline estimator is sampled; residuals and the validity mask remain
    # at original resolution so small defects are not discarded.
    baseline_source = millimeters[::sample_step, :]
    baseline = _nanmedian_without_empty_warning(baseline_source, axis=0)
    normalized = millimeters - baseline[None, :]
    row_shift_source = normalized[:, ::sample_step]
    row_shift = _nanmedian_without_empty_warning(row_shift_source, axis=1)
    row_shift[~np.isfinite(row_shift)] = 0.0
    normalized = normalized - row_shift[:, None]
    normalized[~valid] = np.nan
    gray = np.clip(np.nan_to_num(normalized, nan=0.0) * exposure + 127.0, 0, 255)
    return _jet_rgb(gray.astype(np.uint8)), normalized


def _load_depth(path: Path) -> np.ndarray:
    with np.load(path, allow_pickle=False) as payload:
        if not payload.files:
            raise ValueError(f"depth NPZ has no arrays: {path}")
        value = np.asarray(payload[payload.files[0]])
    if value.ndim != 2:
        raise ValueError(f"depth plane must be 2D: {path}")
    return value


class OnnxYoloDetector:
    def __init__(self, path: Path, config: DefectDetectionConfig) -> None:
        try:
            import onnxruntime as ort
        except ImportError as error:
            raise RuntimeError("onnxruntime-gpu is required for defect detection") from error
        if not path.is_file():
            raise FileNotFoundError(path)
        _ensure_cuda_dll_directory()
        if hasattr(ort, "preload_dlls"):
            try:
                ort.preload_dlls()
            except Exception:
                pass
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        available = ort.get_available_providers()
        providers: list[Any] = []
        if "CUDAExecutionProvider" in available:
            providers.append(
                (
                    "CUDAExecutionProvider",
                    {
                        "device_id": str(config.gpu_device_id),
                        "do_copy_in_default_stream": "1",
                    },
                )
            )
        providers.append("CPUExecutionProvider")
        self.session = ort.InferenceSession(
            str(path),
            sess_options=options,
            providers=providers,
        )
        self.path = path
        self.provider = self.session.get_providers()[0]
        model_input = self.session.get_inputs()[0]
        self.input_name = model_input.name
        self.dynamic_batch = not isinstance(model_input.shape[0], int)
        self.config = config

    def detect(self, rgb: np.ndarray) -> list[dict[str, Any]]:
        return self.detect_many([rgb])[0]

    def detect_many(self, images: list[np.ndarray]) -> list[list[dict[str, Any]]]:
        if not images:
            return []
        if len(images) > 1 and not self.dynamic_batch:
            return [self.detect_many([image])[0] for image in images]
        prepared = [
            _letterbox_rgb(image, self.config.image_size) for image in images
        ]
        tensor = np.concatenate([item[0] for item in prepared], axis=0)
        predictions = np.asarray(
            self.session.run(None, {self.input_name: tensor})[0]
        )
        if predictions.ndim != 3 or predictions.shape[0] != len(images):
            raise ValueError(
                f"batched YOLOv5 output does not match input: {predictions.shape}"
            )
        return [
            decode_yolov5_predictions(
                predictions[index],
                original_shape=image.shape[:2],
                scale=prepared[index][1],
                padding=prepared[index][2],
                confidence_threshold=self.config.confidence_threshold,
                iou_threshold=self.config.iou_threshold,
                maximum_detections=self.config.maximum_detections_per_frame,
            )
            for index, image in enumerate(images)
        ]


class OnnxDefectClassifier:
    """NHWC EfficientNet classifier migrated from the legacy H5 weights."""

    def __init__(self, path: Path, config: DefectDetectionConfig) -> None:
        try:
            import onnxruntime as ort
        except ImportError as error:
            raise RuntimeError("onnxruntime-gpu is required for defect recognition") from error
        if not path.is_file():
            raise FileNotFoundError(path)
        _ensure_cuda_dll_directory()
        if hasattr(ort, "preload_dlls"):
            try:
                ort.preload_dlls()
            except Exception:
                pass
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        providers: list[Any] = []
        if "CUDAExecutionProvider" in ort.get_available_providers():
            providers.append(
                (
                    "CUDAExecutionProvider",
                    {
                        "device_id": str(config.gpu_device_id),
                        "do_copy_in_default_stream": "1",
                    },
                )
            )
        providers.append("CPUExecutionProvider")
        self.session = ort.InferenceSession(
            str(path), sess_options=options, providers=providers
        )
        self.path = path
        self.provider = self.session.get_providers()[0]
        self.input_name = self.session.get_inputs()[0].name

    def classify(self, images: list[np.ndarray]) -> list[tuple[int, float]]:
        if not images:
            return []
        tensor = np.stack(images, axis=0).astype(np.float32, copy=False) / 255.0
        scores = np.asarray(
            self.session.run(None, {self.input_name: tensor})[0],
            dtype=np.float32,
        )
        indices = np.argmax(scores, axis=1)
        return [
            (int(index), float(scores[row, index]))
            for row, index in enumerate(indices)
        ]


def _legacy_classifier_crop(image: np.ndarray, rect: list[int]) -> np.ndarray | None:
    """Reproduce the prior line's square-ish, minimum-64-pixel ROI policy."""
    height, width = image.shape[:2]
    left, top, right, bottom = [int(value) for value in rect]
    left, right = max(0, left), min(width, right)
    top, bottom = max(0, top), min(height, bottom)
    box_width = right - left
    box_height = bottom - top
    if box_width <= 0 or box_height <= 0:
        return None
    if box_width / box_height > 3.0:
        difference = box_width - box_height
        left += int(difference * 0.4)
        right -= int(difference * 0.4)
    if box_height / max(right - left, 1) > 3.0:
        difference = box_height - (right - left)
        top += int(difference * 0.4)
        bottom -= int(difference * 0.4)
    if right - left < 64:
        offset = (64 - (right - left)) / 2.0
        left = int(max(0, left - offset))
        right = int(min(width, right + offset))
    if bottom - top < 64:
        offset = (64 - (bottom - top)) / 2.0
        top = int(max(0, top - offset))
        bottom = int(min(height, bottom + offset))
    crop = image[top:bottom, left:right]
    if crop.size == 0:
        return None
    return np.asarray(
        Image.fromarray(crop).resize((224, 224), Image.Resampling.BILINEAR),
        dtype=np.uint8,
    )


def _classify_candidates(
    candidates: list[dict[str, Any]],
    image: np.ndarray,
    classifier: OnnxDefectClassifier | None,
    class_rows: dict[int, dict[str, Any]],
    modality: str,
) -> int:
    if classifier is None or not candidates:
        return 0
    crops: list[np.ndarray] = []
    crop_candidates: list[dict[str, Any]] = []
    for candidate in candidates:
        crop = _legacy_classifier_crop(image, candidate["rect"])
        if crop is not None:
            crops.append(crop)
            crop_candidates.append(candidate)
    for candidate, (class_index, confidence) in zip(
        crop_candidates, classifier.classify(crops)
    ):
        row = class_rows.get(class_index, {})
        candidate["classifications"] = {
            modality: {
                "outputIndex": class_index,
                "internalId": row.get("internalId"),
                "externalId": row.get("externalId"),
                "name": row.get("name", f"class-{class_index}"),
                "acceptedDefect": bool(row.get("acceptedDefect", False)),
                "confidence": round(confidence, 6),
            }
        }
    return len(crops)


def _offset_candidates(
    candidates: Iterable[dict[str, Any]],
    left: int,
    top: int,
    modality: str,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for candidate in candidates:
        x1, y1, x2, y2 = candidate["rect"]
        result.append(
            {
                **candidate,
                "rect": [x1 + left, y1 + top, x2 + left, y2 + top],
                "modalities": [modality],
                "modelConfidence": {modality: candidate["confidence"]},
                "classifications": candidate.get("classifications", {}),
            }
        )
    return result


def _iou_rect(first: list[int], second: list[int]) -> float:
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    first_area = max(0, first[2] - first[0]) * max(0, first[3] - first[1])
    second_area = max(0, second[2] - second[0]) * max(0, second[3] - second[1])
    return intersection / max(first_area + second_area - intersection, 1)


def merge_modal_candidates(
    two_d: list[dict[str, Any]],
    three_d: list[dict[str, Any]],
    threshold: float,
) -> list[dict[str, Any]]:
    result = [dict(candidate) for candidate in two_d]
    used: set[int] = set()
    for candidate in result:
        matches = [
            (_iou_rect(candidate["rect"], other["rect"]), index)
            for index, other in enumerate(three_d)
            if index not in used
        ]
        if not matches:
            continue
        overlap, index = max(matches)
        if overlap < threshold:
            continue
        other = three_d[index]
        used.add(index)
        candidate["modalities"] = ["2d", "3d"]
        candidate["modelConfidence"] = {
            **candidate.get("modelConfidence", {}),
            **other.get("modelConfidence", {}),
        }
        candidate["classifications"] = {
            **candidate.get("classifications", {}),
            **other.get("classifications", {}),
        }
        first = float(candidate["confidence"])
        second = float(other["confidence"])
        candidate["confidence"] = round(1.0 - (1.0 - first) * (1.0 - second), 6)
        candidate["modalityIoU"] = round(overlap, 6)
    result.extend(dict(candidate) for index, candidate in enumerate(three_d) if index not in used)
    return result


def resolve_candidate_classification(
    candidate: dict[str, Any], confidence_threshold: float
) -> tuple[bool, dict[str, Any] | None, str]:
    """Resolve modality predictions without allowing weak pseudo labels to hide defects."""
    classifications = list(candidate.get("classifications", {}).values())
    confident = [
        row
        for row in classifications
        if float(row.get("confidence", 0.0)) >= confidence_threshold
    ]
    accepted = [row for row in confident if row.get("acceptedDefect") is True]
    if accepted:
        selected = max(accepted, key=lambda row: float(row.get("confidence", 0.0)))
        return True, selected, "fine-grained-temporary-model"
    if classifications and len(confident) == len(classifications):
        # A candidate is discarded only when every available modality emits a
        # confident pseudo-defect class.  Any uncertainty remains reviewable.
        return False, max(
            confident, key=lambda row: float(row.get("confidence", 0.0))
        ), "pseudo-defect-filtered"
    return True, None, "binary-candidate-review"


def candidate_spans_crop_boundary(
    candidate: dict[str, Any], crop_box: list[int]
) -> bool:
    """Reject detector boxes that describe the steel/black crop boundary itself."""
    left, top, right, bottom = crop_box
    x1, y1, x2, y2 = candidate["rect"]
    # YOLO boxes commonly stop a few pixels short of the exact crop boundary
    # after letterbox scaling.  A two-percent, bounded tolerance still only
    # rejects boxes spanning essentially the entire valid steel ROI.
    margin_x = max(16, min(32, (right - left) // 50))
    margin_y = max(16, min(32, (bottom - top) // 50))
    spans_horizontal = x1 <= left + margin_x and x2 >= right - margin_x
    spans_vertical = y1 <= top + margin_y and y2 >= bottom - margin_y
    return spans_horizontal or spans_vertical


def candidate_region_disposition(
    center_x: float,
    owned_intervals: Any,
    overlap_intervals: Any,
) -> str:
    """Classify a candidate center against calibrated single-camera ownership."""

    def contains(intervals: Any) -> bool:
        return isinstance(intervals, list) and any(
            isinstance(interval, list)
            and len(interval) == 2
            and float(interval[0]) <= center_x < float(interval[1])
            for interval in intervals
        )

    # Legacy or diagnostic manifests without ownership retain the historical
    # behavior and leave candidates reviewable.
    if not owned_intervals or contains(owned_intervals):
        return "owned"
    return "overlap-duplicate" if contains(overlap_intervals) else "boundary"


def _depth_deviation(normalized: np.ndarray, rect: list[int], crop_box: list[int]) -> dict[str, Any]:
    left, top, right, bottom = crop_box
    x1 = max(0, rect[0] - left)
    y1 = max(0, rect[1] - top)
    x2 = min(normalized.shape[1], rect[2] - left)
    y2 = min(normalized.shape[0], rect[3] - top)
    roi = normalized[y1:y2, x1:x2]
    values = roi[np.isfinite(roi)]
    if values.size == 0:
        return {"available": False, "reason": "no-valid-depth"}
    negative = float(np.percentile(values, 5.0))
    positive = float(np.percentile(values, 95.0))
    signed = negative if abs(negative) >= abs(positive) else positive
    return {
        "available": True,
        "signedMm": round(signed, 6),
        "absoluteMm": round(abs(signed), 6),
        "p05Mm": round(negative, 6),
        "p95Mm": round(positive, 6),
        "validPoints": int(values.size),
    }


def _save_review_crop(
    intensity: np.ndarray,
    rect: list[int],
    path: Path,
    minimum_size: int = 64,
) -> dict[str, Any]:
    height, width = intensity.shape
    x1, y1, x2, y2 = rect
    padding_x = max(8, (x2 - x1) // 4)
    padding_y = max(8, (y2 - y1) // 4)

    def bounded_span(start: int, end: int, limit: int) -> tuple[int, int]:
        requested = max(end - start, min(max(64, int(minimum_size)), limit))
        requested = min(requested, limit)
        center = (start + end) / 2.0
        lower = max(0, min(limit - requested, int(round(center - requested / 2.0))))
        return lower, lower + requested

    left, right = bounded_span(x1 - padding_x, x2 + padding_x, width)
    top, bottom = bounded_span(y1 - padding_y, y2 + padding_y, height)
    box = (left, top, right, bottom)
    if box[2] <= box[0] or box[3] <= box[1]:
        raise ValueError("defect review crop is empty")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        output_format = "PNG" if path.suffix.lower() == ".png" else "JPEG"
        save_options = (
            {"format": "PNG", "optimize": False}
            if output_format == "PNG"
            else {"format": "JPEG", "quality": 88, "optimize": False}
        )
        Image.fromarray(
            intensity[box[1] : box[3], box[0] : box[2]],
            mode="L",
        ).save(temporary, **save_options)
        replace_file(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return {
        "left": box[0],
        "top": box[1],
        "right": box[2],
        "bottom": box[3],
        "width": box[2] - box[0],
        "height": box[3] - box[1],
    }


def _prepare_review_output(defect_directory: Path) -> None:
    if defect_directory.is_symlink():
        raise ValueError(
            f"defect image output must not be a symbolic link: {defect_directory}"
        )
    if not defect_directory.is_dir():
        return
    # Camera-local defect crops are derived artifacts. A rebuild replaces only
    # image files inside this exact <camera-root>/<flow>/defect directory;
    # immutable 2D/3D/JSON acquisition files are never touched.
    for pattern in ("*.jpg", "*.jpeg", "*.png"):
        for path in defect_directory.glob(pattern):
            if path.is_file() and not path.is_symlink():
                path.unlink()


def _camera_number(camera_id: str) -> int | None:
    digits = "".join(character for character in camera_id if character.isdigit())
    if not digits:
        return None
    value = int(digits)
    return value if value > 0 else None


def _defect_position_ratios(
    *,
    camera_id: str,
    camera_count: int,
    storage_index: int,
    rect: list[int],
    source_width: int,
    source_height: int,
    camera_alignment: dict[str, Any],
    camera_surface_tile: dict[str, Any] | None = None,
) -> tuple[float, float, int | None, dict[str, Any]]:
    camera_number = _camera_number(camera_id)
    center_x = (rect[0] + rect[2]) / 2.0
    center_y = (rect[1] + rect[3]) / 2.0
    local_x_ratio = max(0.0, min(1.0, center_x / max(source_width, 1)))
    surface_mapping: dict[str, Any] = {
        "available": False,
        "coordinateSpace": "source-image-pixels",
    }
    calibrated_angle: float | None = None
    tile = camera_surface_tile if isinstance(camera_surface_tile, dict) else {}
    crop = tile.get("cropBox")
    angles = tile.get("angleDegByColumn")
    if isinstance(crop, list) and len(crop) == 4 and isinstance(angles, list) and angles:
        tile_x = int(round(center_x - float(crop[0])))
        if 0 <= tile_x < len(angles):
            candidate_indices = sorted(
                range(len(angles)), key=lambda index: abs(index - tile_x)
            )
            selected_index = next(
                (index for index in candidate_indices if angles[index] is not None),
                None,
            )
            if selected_index is not None:
                try:
                    candidate_angle = float(angles[selected_index]) % 360.0
                except (TypeError, ValueError):
                    candidate_angle = math.nan
                if math.isfinite(candidate_angle):
                    calibrated_angle = candidate_angle
                    source_global_row = storage_index * source_height + center_y
                    row_anchors = [
                        row
                        for row in tile.get("rowAnchors", [])
                        if isinstance(row, dict)
                        and isinstance(row.get("sourceGlobalRow"), (int, float))
                    ]
                    nearest_row = (
                        min(
                            row_anchors,
                            key=lambda row: abs(
                                float(row["sourceGlobalRow"]) - source_global_row
                            ),
                        )
                        if row_anchors
                        else None
                    )
                    surface_mapping = {
                        "available": True,
                        "schema": "steel.surface-defect-mapping.v1",
                        "coordinateSpace": "source-image-pixels-to-surface-tile",
                        "cameraId": camera_id,
                        "sourceX": round(center_x, 3),
                        "sourceY": round(center_y, 3),
                        "tileX": selected_index,
                        "tileXRatio": round(
                            selected_index / max(1, len(angles) - 1), 8
                        ),
                        "arrayAngleDeg": round(candidate_angle, 6),
                        "tileRow": nearest_row.get("row") if nearest_row else None,
                        "tilePositionRatio": (
                            nearest_row.get("positionRatio") if nearest_row else None
                        ),
                        "anchorOrdinal": (
                            nearest_row.get("anchorOrdinal") if nearest_row else None
                        ),
                    }
    if calibrated_angle is not None:
        circumference_ratio = calibrated_angle / 360.0
    elif camera_number is None:
        circumference_ratio = local_x_ratio
    else:
        circumference_ratio = (
            max(0, min(camera_count - 1, camera_number - 1)) + local_x_ratio
        ) / max(camera_count, 1)

    head = camera_alignment.get("head", {})
    tail = camera_alignment.get("tail", {})
    first_frame = int(head.get("frameIndex", storage_index))
    last_frame = int(tail.get("frameIndex", storage_index))
    frame_span = max(1.0, float(last_frame - first_frame + 1))
    local_row_ratio = max(0.0, min(1.0, center_y / max(source_height, 1)))
    length_ratio = (
        float(storage_index - first_frame) + local_row_ratio
    ) / frame_span
    return (
        max(0.0, min(1.0, length_ratio)),
        max(0.0, min(1.0, circumference_ratio)),
        camera_number,
        surface_mapping,
    )


def _database_import_payload(
    manifest: dict[str, Any],
    *,
    source: str | None = None,
    defects: Iterable[dict[str, Any]] | None = None,
    execution_gate: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    model_set = manifest.get("modelSet", {})
    model_id = str(model_set.get("id", "temporary-defect-model"))
    resolved_source = str(
        source or manifest.get("source") or "sick-temporary-defect-model"
    )
    rows: list[dict[str, Any]] = []
    candidate_rows = defects if defects is not None else manifest.get("defects", [])
    for defect in candidate_rows:
        if execution_gate is not None:
            execution_gate("defect-database-payload-row")
        if not isinstance(defect, dict):
            continue
        rect = defect.get("imageRect2d", {})
        review_crop = defect.get("reviewCropRect", {})
        depth = defect.get("depthDeviation", {})
        classification_state = (
            "classified"
            if defect.get("fineGrainedClass")
            else "candidate-only"
        )
        geometry = {
            "schema": "steel.capture-defect.geometry.v1",
            "coordinateSpace": defect.get("coordinateSpace", "source-image-pixels"),
            "className": defect.get("className"),
            "classificationState": classification_state,
            "classificationVersion": (
                manifest.get("configHash")
                if resolved_source == "sick-depth-geometry"
                else model_id
            ),
            "classificationConfidence": defect.get("recognitionConfidence"),
            "detectionConfidence": defect.get("confidence"),
            "cameraIndex": defect.get("cameraIndex"),
            "lengthRatio": defect.get("lengthRatio"),
            "circumferenceRatio": defect.get("circumferenceRatio"),
            "arrayAngleDeg": defect.get("arrayAngleDeg"),
            "surfaceMapping": defect.get("surfaceMapping"),
            "globalPositionAvailable": manifest.get("globalPositionAvailable"),
            "riskTags": manifest.get("riskTags", []),
            "imageRect2d": rect,
            "reviewCropRect": review_crop,
            "modalities": defect.get("modalities", []),
            "modelConfidence": defect.get("modelConfidence", {}),
            "depthDeviation": depth,
            "scoreKind": defect.get(
                "scoreKind",
                "geometry-rule" if resolved_source == "sick-depth-geometry" else "model-confidence",
            ),
            "candidatePolarity": defect.get("candidatePolarity"),
            "pixelSpan": defect.get("pixelSpan"),
            "horizontalSpanMm": defect.get("horizontalSpanMm"),
            # No encoder is available. These fields intentionally remain null
            # instead of turning frame/row pixels into invented millimetres.
            "longitudinalSpanMm": defect.get("longitudinalSpanMm"),
            "areaMm2": defect.get("areaMm2"),
            "artifacts": {
                "schema": "steel.surface.defect.artifacts.v1",
                "cameraId": defect.get("cameraId", ""),
                "frameId": str(defect.get("storageIndex", "")),
                "sequenceNo": defect.get("storageIndex", 0),
                "roi": {
                    "x": rect.get("left", 0),
                    "y": rect.get("top", 0),
                    "width": max(0, int(rect.get("right", 0)) - int(rect.get("left", 0))),
                    "height": max(0, int(rect.get("bottom", 0)) - int(rect.get("top", 0))),
                },
                "roiImage": defect.get("reviewImage", ""),
                "depthRoiImage": defect.get("residualReviewImage", ""),
            },
        }
        signed_depth = (
            float(depth.get("signedMm", 0.0))
            if isinstance(depth, dict) and depth.get("available")
            else 0.0
        )
        horizontal_span = defect.get("horizontalSpanMm")
        try:
            horizontal_span_mm = float(horizontal_span)
            if not np.isfinite(horizontal_span_mm) or horizontal_span_mm < 0:
                horizontal_span_mm = 0.0
        except (TypeError, ValueError):
            horizontal_span_mm = 0.0
        rows.append(
            {
                "id": defect.get("id"),
                "sourceDefectId": defect.get("id"),
                "cameraId": defect.get("cameraId", ""),
                "defectType": defect.get("classId", "surface-defect-candidate"),
                "severity": defect.get("severity", "review"),
                # No encoder-derived longitudinal metric is available yet.
                # Ratios and pixel geometry remain explicit in geometry.
                "xMm": 0.0,
                "yMm": 0.0,
                "zMm": signed_depth,
                "widthMm": (
                    horizontal_span_mm
                    if resolved_source == "sick-depth-geometry"
                    else 0.0
                ),
                "heightMm": 0.0,
                "depthMm": signed_depth,
                "confidence": defect.get("confidence", 0.0),
                "previewImagePath": defect.get("reviewImage", ""),
                "geometry": geometry,
            }
        )
    return {
        "schema": "steel.capture-defect-import.v1",
        "source": resolved_source,
        "materialId": manifest.get("materialId", ""),
        "manifestPath": manifest.get("manifestPath", ""),
        "generatedAt": manifest.get("generatedAt", ""),
        "modelId": (
            str(manifest.get("configHash", ""))
            if resolved_source == "sick-depth-geometry"
            else model_id
        ),
        "algorithmRevision": str(
            manifest.get("algorithmRevision")
            or manifest.get("configHash")
            or ""
        ),
        "replacePending": True,
        "defects": rows,
    }


def _post_database_import_payload(
    payload: dict[str, Any],
    origin: str,
    *,
    timeout_seconds: float,
    execution_gate: Callable[[str], None] | None,
) -> dict[str, Any]:
    body = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    call = request.Request(
        f"{origin}/internal/v1/defect-batch",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    if execution_gate is not None:
        execution_gate("defect-database-post")
    with request.urlopen(call, timeout=timeout_seconds) as response:
        result = _read_response_json(response.read())
        if response.status != 200 or int(result.get("code", -1)) != 0:
            raise RuntimeError(
                f"defect database import failed: HTTP {response.status}: {result}"
            )
    return {"state": "complete", **result}


def import_defect_manifest(
    manifest: dict[str, Any],
    database_origin: str,
    *,
    timeout_seconds: float = 30.0,
    execution_gate: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    origin = database_origin.strip().rstrip("/")
    if not origin:
        return {"state": "disabled", "imported": 0, "updated": 0, "deleted": 0}
    if execution_gate is not None:
        execution_gate("defect-database-payload")
    groups = manifest.get("defectGroups")
    if isinstance(groups, dict):
        results: dict[str, Any] = {}
        imported = updated = deleted = 0
        for group_name, default_source in (
            ("geometry", "sick-depth-geometry"),
            ("legacy", "sick-temporary-defect-model"),
        ):
            group = groups.get(group_name)
            if not isinstance(group, dict):
                continue
            if str(group.get("state", "")).lower() in {
                "failed",
                "unavailable",
                "database-write-failed",
            }:
                results[group_name] = {
                    "state": "skipped",
                    "reason": "algorithm-group-not-complete",
                }
                continue
            rows = group.get("defects", [])
            group_manifest = {
                **manifest,
                "source": str(group.get("source") or default_source),
                "algorithmRevision": group.get(
                    "algorithmRevision", manifest.get("algorithmRevision")
                ),
                "configHash": group.get("configHash", manifest.get("configHash")),
                "globalPositionAvailable": group.get(
                    "globalPositionAvailable",
                    manifest.get("globalPositionAvailable"),
                ),
                "riskTags": group.get("riskTags", manifest.get("riskTags", [])),
                "defects": rows if isinstance(rows, list) else [],
            }
            payload = _database_import_payload(
                group_manifest,
                source=group_manifest["source"],
                execution_gate=execution_gate,
            )
            try:
                result = _post_database_import_payload(
                    payload,
                    origin,
                    timeout_seconds=timeout_seconds,
                    execution_gate=execution_gate,
                )
            except (ExecutionGateInterrupted, DepthGeometryConfigChanged):
                raise
            except Exception as error:
                # A geometry database failure must not suppress the independent
                # legacy import (and vice versa). The partial state remains
                # retryable by the flow worker.
                results[group_name] = {
                    "state": "failed",
                    "error": f"{type(error).__name__}: {error}",
                }
                continue
            results[group_name] = result
            imported += int(result.get("imported", 0) or 0)
            updated += int(result.get("updated", 0) or 0)
            deleted += int(result.get("deleted", 0) or 0)
        result_states = {
            str(result.get("state", "")) for result in results.values()
        }
        return {
            "state": (
                "failed"
                if result_states and result_states <= {"failed"}
                else "partial"
                if result_states & {"failed", "skipped"}
                else "complete"
            ),
            "imported": imported,
            "updated": updated,
            "deleted": deleted,
            "groups": results,
        }
    payload = _database_import_payload(manifest, execution_gate=execution_gate)
    return _post_database_import_payload(
        payload,
        origin,
        timeout_seconds=timeout_seconds,
        execution_gate=execution_gate,
    )


def _selected_indices(indices: list[int], stride: int) -> list[int]:
    if not indices:
        return []
    selected = indices[:: max(1, stride)]
    if selected[-1] != indices[-1]:
        selected.append(indices[-1])
    return selected


def _realtime_analysis_has_priority(path: Path | None) -> bool:
    if path is None or not path.is_file():
        return False
    try:
        payload = _read_json(path)
    except (OSError, ValueError, json.JSONDecodeError):
        return False
    try:
        updated_at_ms = int(payload.get("updatedAtUnixMs", 0) or 0)
    except (TypeError, ValueError):
        return False
    heartbeat_age_ms = int(time.time() * 1000) - updated_at_ms
    if updated_at_ms <= 0 or heartbeat_age_ms < -5_000 or heartbeat_age_ms > 20_000:
        # A killed/restarting realtime worker leaves its last atomic status on
        # disk.  That stale heartbeat must not pause history work forever.
        return False
    return bool(
        payload.get("state") == "running"
        and (
            payload.get("currentFastFlow")
            or payload.get("currentDefectFlow")
            or int(payload.get("pendingDefectFlows", 0) or 0) > 0
        )
    )


def _capture_is_idle(
    origin: str,
    maximum_pending_storage_rounds: int,
    realtime_priority_status_path: Path | None = None,
) -> bool:
    if _realtime_analysis_has_priority(realtime_priority_status_path):
        return False
    try:
        with request.urlopen(f"{origin}/api/steel/status", timeout=1.0) as response:
            steel = _read_response_json(response.read())
        with request.urlopen(f"{origin}/api/capture/health", timeout=1.0) as response:
            health = _read_response_json(response.read())
    except Exception:
        return False
    queue = health.get("storageQueue", {})
    return bool(
        not steel.get("present")
        and int(queue.get("pendingRounds", 0) or 0)
        <= maximum_pending_storage_rounds
        and int(queue.get("activeRounds", 0) or 0)
        <= (1 if maximum_pending_storage_rounds > 0 else 0)
    )


def _read_response_json(body: bytes) -> dict[str, Any]:
    import json

    payload = json.loads(body.decode("utf-8"))
    return payload if isinstance(payload, dict) else {}


def _wait_for_capture_idle(
    config: DefectDetectionConfig, idle_state: dict[str, float | None]
) -> float:
    started = time.perf_counter()
    if not config.capture_origin:
        return 0.0
    deadline = time.monotonic() + config.maximum_idle_wait_seconds
    while time.monotonic() < deadline:
        if _capture_is_idle(
            config.capture_origin,
            config.maximum_pending_storage_rounds,
            config.realtime_priority_status_path,
        ):
            idle_state["since"] = idle_state.get("since") or time.monotonic()
            if time.monotonic() - float(idle_state["since"]) >= 0.5:
                return time.perf_counter() - started
        else:
            idle_state["since"] = None
        time.sleep(0.2)
    raise TimeoutError("capture did not become idle before defect inference")


def _model_manifest(config: DefectDetectionConfig) -> dict[str, Any]:
    if config.model_manifest_path and config.model_manifest_path.is_file():
        payload = _read_json(config.model_manifest_path)
        if payload.get("schema") != MODEL_MANIFEST_SCHEMA:
            raise ValueError(
                f"model manifest schema must be {MODEL_MANIFEST_SCHEMA}"
            )
        return payload
    return {"schema": MODEL_MANIFEST_SCHEMA, "temporary": True, "models": {}}


def _prepare_detection_frame(
    storage_index: int,
    intensity_path: Path,
    depth_path: Path | None,
    metadata_path: Path,
    head: dict[str, Any],
    tail: dict[str, Any],
    need_2d: bool,
    need_3d: bool,
    settings: DefectDetectionConfig,
    stable_crop: list[int] | None = None,
) -> tuple[dict[str, Any] | None, dict[str, float]]:
    timing = {"sourceDecodeSeconds": 0.0, "preprocessSeconds": 0.0}
    phase_started = time.perf_counter()
    with Image.open(intensity_path) as image:
        intensity = np.asarray(image.convert("L"))
    timing["sourceDecodeSeconds"] += time.perf_counter() - phase_started
    if intensity.size == 0 or float(np.mean(intensity > 8)) < 0.005:
        return None, timing

    phase_started = time.perf_counter()
    crop_box = detect_valid_grayscale_roi(intensity)
    if crop_box is None:
        timing["preprocessSeconds"] += time.perf_counter() - phase_started
        return None, timing
    if stable_crop is not None and len(stable_crop) == 4:
        crop_box[0] = max(0, int(stable_crop[0]))
        crop_box[2] = min(intensity.shape[1], int(stable_crop[2]))
    if head.get("detected") and storage_index == int(head["frameIndex"]):
        crop_box[1] = max(crop_box[1], int(head.get("row", 0)))
    if tail.get("detected") and storage_index == int(tail["frameIndex"]):
        crop_box[3] = min(crop_box[3], int(tail.get("row", intensity.shape[0])))
    left, top, right, bottom = crop_box
    if (
        right - left < settings.minimum_crop_size
        or bottom - top < settings.minimum_crop_size
    ):
        timing["preprocessSeconds"] += time.perf_counter() - phase_started
        return None, timing
    metadata = _read_json(metadata_path)
    record: dict[str, Any] = {
        "storageIndex": storage_index,
        "intensity": intensity,
        "cropBox": crop_box,
        "metadata": metadata,
        "normalizedDepth": None,
    }
    if need_2d:
        record["rgb2d"] = np.repeat(
            intensity[top:bottom, left:right, None], 3, axis=2
        )
    timing["preprocessSeconds"] += time.perf_counter() - phase_started
    if need_3d and depth_path is not None:
        phase_started = time.perf_counter()
        depth = _load_depth(depth_path)
        timing["sourceDecodeSeconds"] += time.perf_counter() - phase_started
        phase_started = time.perf_counter()
        rgb_3d, normalized_depth = flatten_depth_for_detection(
            depth,
            metadata,
            crop_box,
            settings.depth_exposure,
            settings.depth_baseline_sample_step,
        )
        record["rgb3d"] = rgb_3d
        record["normalizedDepth"] = normalized_depth
        timing["preprocessSeconds"] += time.perf_counter() - phase_started
    return record, timing


def _build_legacy_flow_defect_detection(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment: dict[str, Any],
    *,
    config: DefectDetectionConfig,
    execution_gate: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    settings = config.bounded()
    started = time.perf_counter()
    base = {
        "schema": DEFECT_DETECTION_SCHEMA,
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "temporaryModel": True,
    }
    if not settings.enabled:
        return {
            **base,
            "state": "disabled",
            "quality": {"reviewRequired": True, "fineGrainedClassification": False},
            "statistics": {
                "cameraCount": len(camera_roots),
                "processedFrames": 0,
                "overlapDuplicateFilteredCount": 0,
                "defectCount": 0,
            },
            "defects": [],
        }
    if execution_gate is not None:
        execution_gate("defect-region-manifest-read")
    region_map = read_region_manifest(storage_root, material_id)
    try:
        surface_manifest = _read_json(surface_path(storage_root, material_id))
    except (OSError, ValueError, json.JSONDecodeError):
        surface_manifest = {}
    surface_tiles = {
        str(row.get("cameraId")): row
        for row in surface_manifest.get("cameraTiles", {}).get("cameras", [])
        if isinstance(row, dict) and row.get("cameraId")
    }
    region_gate_passed = bool(region_map and region_map.get("defectDetectionAllowed"))
    region_gate_reasons = (
        region_map.get("qualityGate", {}).get("reasons", [])
        if region_map
        else ["region-manifest-missing"]
    )
    # The global gate controls positioning and cross-camera ownership. Local
    # camera inference is still emitted for review when synchronization fails.
    use_global_region_map = region_gate_passed or not settings.require_approved_region_map
    if settings.depth_geometry_profile_path is None and settings.require_approved_region_map and not bool(
        region_map and region_map.get("defectDetectionAllowed")
    ):
        reasons = (
            region_map.get("qualityGate", {}).get("reasons", [])
            if region_map
            else ["region-manifest-missing"]
        )
        return {
            **base,
            "state": "blocked",
            "blockedReason": "approved-ranger3-region-map-required",
            "regionManifestPath": str(region_manifest_path(storage_root, material_id)),
            "qualityGate": {"passed": False, "reasons": reasons},
            "quality": {
                "reviewRequired": True,
                "fineGrainedClassification": False,
                "reason": "缺少通过质量门的当前 Ranger3 阵列区域标定",
            },
            "statistics": {
                "cameraCount": len(camera_roots),
                "defectCount": 0,
                "processedFrames": 0,
                "overlapDuplicateFilteredCount": 0,
            },
            "defects": [],
        }
    configured_models = {
        "2d": settings.model_2d_path,
        "3d": settings.model_3d_path,
    }
    configured_classifiers = {
        "2d": settings.classifier_2d_path,
        "3d": settings.classifier_3d_path,
    }
    available_models: dict[str, Path] = {}
    for modality, path in configured_models.items():
        if execution_gate is not None:
            execution_gate(f"defect-model-path-check:{modality}")
        if path is not None and path.is_file():
            available_models[modality] = path
    if not available_models:
        raise FileNotFoundError("no configured defect ONNX model is available")
    if execution_gate is not None:
        execution_gate("defect-model-load")
    model_manifest = _model_manifest(settings)
    detectors: dict[str, OnnxYoloDetector] = {}
    for modality, path in available_models.items():
        if execution_gate is not None:
            execution_gate(f"defect-model-open:{modality}")
        stat = path.stat()
        detector_key = (
            str(path.resolve()),
            stat.st_size,
            stat.st_mtime_ns,
            settings.gpu_device_id,
            settings.image_size,
            settings.confidence_threshold,
            settings.iou_threshold,
            settings.maximum_detections_per_frame,
        )
        detector = _DETECTOR_CACHE.get(detector_key)
        if detector is None:
            detector = OnnxYoloDetector(path, settings)
            _DETECTOR_CACHE[detector_key] = detector
            while len(_DETECTOR_CACHE) > 8:
                _DETECTOR_CACHE.pop(next(iter(_DETECTOR_CACHE)))
        detectors[modality] = detector
    classifiers: dict[str, OnnxDefectClassifier] = {}
    for modality, path in configured_classifiers.items():
        if execution_gate is not None:
            execution_gate(f"defect-classifier-path-check:{modality}")
        if modality not in detectors or path is None or not path.is_file():
            continue
        if execution_gate is not None:
            execution_gate(f"defect-classifier-open:{modality}")
        stat = path.stat()
        classifier_key = (
            str(path.resolve()),
            stat.st_size,
            stat.st_mtime_ns,
            settings.gpu_device_id,
        )
        classifier = _CLASSIFIER_CACHE.get(classifier_key)
        if classifier is None:
            classifier = OnnxDefectClassifier(path, settings)
            _CLASSIFIER_CACHE[classifier_key] = classifier
            while len(_CLASSIFIER_CACHE) > 8:
                _CLASSIFIER_CACHE.pop(next(iter(_CLASSIFIER_CACHE)))
        classifiers[modality] = classifier
    classifier_rows = {
        modality: {
            int(row["outputIndex"]): row
            for row in model_manifest.get("classifiers", {})
            .get(modality, {})
            .get("classes", [])
            if isinstance(row, dict) and "outputIndex" in row
        }
        for modality in classifiers
    }
    providers = {modality: detector.provider for modality, detector in detectors.items()}
    classifier_providers = {
        modality: classifier.provider for modality, classifier in classifiers.items()
    }
    all_providers = [*providers.values(), *classifier_providers.values()]
    gpu = bool(all_providers) and all(
        provider == "CUDAExecutionProvider" for provider in all_providers
    )
    stride = settings.frame_stride if gpu else max(
        settings.frame_stride, settings.cpu_frame_stride
    )
    if execution_gate is not None:
        execution_gate("defect-review-output-prepare")
    defects: list[dict[str, Any]] = []
    processed_frames = 0
    skipped_frames = 0
    inference_count = 0
    recognition_inference_count = 0
    raw_candidate_count = 0
    pseudo_defect_count = 0
    boundary_artifact_count = 0
    overlap_duplicate_count = 0
    capture_idle_state: dict[str, float | None] = {"since": None}
    timings = {
        "captureWaitSeconds": 0.0,
        "sourceDecodeSeconds": 0.0,
        "preprocessSeconds": 0.0,
        "detectorInferenceSeconds": 0.0,
        "classificationSeconds": 0.0,
        "postprocessSeconds": 0.0,
    }

    for camera_id, camera_root in sorted(camera_roots.items()):
        if execution_gate is not None:
            execution_gate(f"defect-camera:{camera_id}")
        flow_root = capture_root(camera_root, material_id, camera_id)
        review_root = defect_image_root(camera_root, material_id)
        _prepare_review_output(review_root)
        intensity_files = _numeric_files(
            flow_root / "2d",
            ".png",
            execution_gate=execution_gate,
            gate_phase="defect-2d-file-scan",
        )
        depth_files = _numeric_files(
            flow_root / "3d",
            ".npz",
            execution_gate=execution_gate,
            gate_phase="defect-3d-file-scan",
        )
        metadata_files = _numeric_files(
            flow_root / "json",
            ".json",
            execution_gate=execution_gate,
            gate_phase="defect-metadata-file-scan",
        )
        indices = sorted(set(intensity_files) & set(metadata_files))
        camera_alignment = alignment.get("cameras", {}).get(camera_id, {})
        head = camera_alignment.get("head", {})
        tail = camera_alignment.get("tail", {})
        region_row = (
            (region_map or {}).get("cameras", {}).get(camera_id, {})
            if use_global_region_map
            else {}
        )
        camera_surface_tile = surface_tiles.get(camera_id)
        stable_crop = region_row.get("stableCrop")
        # Ownership intervals are a global cross-camera result. Once that gate
        # fails they are untrusted, so retain every camera-local candidate and
        # expose the deduplication risk instead of filtering from stale ranges.
        owned_intervals = (
            region_row.get("ownedColumnIntervals", [])
            if use_global_region_map
            else []
        )
        overlap_intervals = (
            region_row.get("overlapColumnIntervals", [])
            if use_global_region_map
            else []
        )
        if head.get("detected"):
            indices = [index for index in indices if index >= int(head["frameIndex"])]
        if tail.get("detected"):
            indices = [index for index in indices if index <= int(tail["frameIndex"])]
        selected_indices = _selected_indices(indices, stride)
        for batch_start in range(0, len(selected_indices), settings.inference_batch_size):
            if execution_gate is not None:
                execution_gate("defect-batch-preprocess")
            batch: list[dict[str, Any]] = []
            batch_indices = selected_indices[
                batch_start : batch_start + settings.inference_batch_size
            ]
            # Probe once per bounded inference batch.  This still yields to live
            # acquisition within at most one batch while avoiding two HTTP
            # health calls for every individual historical frame.
            if execution_gate is None:
                timings["captureWaitSeconds"] += _wait_for_capture_idle(
                    settings, capture_idle_state
                )
            with ThreadPoolExecutor(
                max_workers=min(settings.preprocess_workers, len(batch_indices)),
                thread_name_prefix="defect-preprocess",
            ) as preprocess_pool:
                prepared = preprocess_pool.map(
                    lambda storage_index: _prepare_detection_frame(
                        storage_index,
                        intensity_files[storage_index],
                        depth_files.get(storage_index),
                        metadata_files[storage_index],
                        head,
                        tail,
                        "2d" in detectors,
                        "3d" in detectors,
                        settings,
                        stable_crop,
                    ),
                    batch_indices,
                )
                for record, frame_timing in prepared:
                    timings["sourceDecodeSeconds"] += frame_timing[
                        "sourceDecodeSeconds"
                    ]
                    timings["preprocessSeconds"] += frame_timing["preprocessSeconds"]
                    if record is None:
                        skipped_frames += 1
                    else:
                        batch.append(record)

            if execution_gate is not None:
                execution_gate("defect-batch-inference")

            detection_jobs: list[
                tuple[str, str, str, OnnxYoloDetector, list[dict[str, Any]]]
            ] = []
            for modality, image_key, result_key in (
                ("2d", "rgb2d", "local2d"),
                ("3d", "rgb3d", "local3d"),
            ):
                detector = detectors.get(modality)
                if detector is None:
                    continue
                modality_records = [record for record in batch if image_key in record]
                if not modality_records:
                    continue
                detection_jobs.append(
                    (modality, image_key, result_key, detector, modality_records)
                )
            phase_started = time.perf_counter()
            with ThreadPoolExecutor(
                max_workers=max(1, len(detection_jobs)),
                thread_name_prefix="defect-inference",
            ) as inference_pool:
                detection_results = list(
                    inference_pool.map(
                        lambda job: job[3].detect_many(
                            [record[job[1]] for record in job[4]]
                        ),
                        detection_jobs,
                    )
                )
            timings["detectorInferenceSeconds"] += time.perf_counter() - phase_started
            if execution_gate is not None:
                execution_gate("defect-batch-postprocess")
            if len(detection_results) != len(detection_jobs):
                raise RuntimeError("detector batch result count does not match jobs")
            for job, results in zip(detection_jobs, detection_results):
                _modality, _image_key, result_key, _detector, modality_records = job
                inference_count += len(modality_records)
                if len(results) != len(modality_records):
                    raise RuntimeError(
                        "detector result count does not match modality records"
                    )
                for record, result in zip(modality_records, results):
                    record[result_key] = result

            for record in batch:
                if execution_gate is not None:
                    execution_gate("defect-frame-postprocess")
                storage_index = int(record["storageIndex"])
                intensity = record["intensity"]
                crop_box = record["cropBox"]
                metadata = record["metadata"]
                normalized_depth = record["normalizedDepth"]
                left, top, _right, _bottom = crop_box
                local_2d = record.get("local2d", [])
                local_3d = record.get("local3d", [])
                phase_started = time.perf_counter()
                recognition_inference_count += _classify_candidates(
                    local_2d,
                    record.get("rgb2d"),
                    classifiers.get("2d"),
                    classifier_rows.get("2d", {}),
                    "2d",
                )
                rgb_3d = record.get("rgb3d")
                recognition_inference_count += _classify_candidates(
                    local_3d,
                    np.ascontiguousarray(rgb_3d[..., ::-1])
                    if rgb_3d is not None
                    else rgb_3d,
                    classifiers.get("3d"),
                    classifier_rows.get("3d", {}),
                    "3d",
                )
                timings["classificationSeconds"] += time.perf_counter() - phase_started
                frame_2d = _offset_candidates(local_2d, left, top, "2d")
                frame_3d = _offset_candidates(local_3d, left, top, "3d")
                phase_started = time.perf_counter()
                candidates = merge_modal_candidates(
                    frame_2d, frame_3d, settings.merge_iou_threshold
                )
                for candidate in candidates:
                    if execution_gate is not None:
                        execution_gate("defect-candidate-postprocess")
                    raw_candidate_count += 1
                    center_x = (candidate["rect"][0] + candidate["rect"][2]) / 2.0
                    region_disposition = candidate_region_disposition(
                        center_x, owned_intervals, overlap_intervals
                    )
                    if region_disposition == "overlap-duplicate":
                        overlap_duplicate_count += 1
                        continue
                    if region_disposition == "boundary":
                        boundary_artifact_count += 1
                        continue
                    if candidate_spans_crop_boundary(candidate, crop_box):
                        boundary_artifact_count += 1
                        continue
                    keep, classification, classification_stage = (
                        resolve_candidate_classification(
                            candidate, settings.classification_confidence_threshold
                        )
                    )
                    if not keep:
                        pseudo_defect_count += 1
                        continue
                    defect_number = len(defects) + 1
                    defect_id = f"{material_id}-{camera_id}-{defect_number:06d}"
                    review_path = review_root / f"{defect_id}.jpg"
                    if execution_gate is not None:
                        execution_gate("defect-review-crop-write")
                    review_crop = _save_review_crop(
                        intensity,
                        candidate["rect"],
                        review_path,
                        settings.review_crop_minimum_size,
                    )
                    (
                        length_ratio,
                        circumference_ratio,
                        camera_number,
                        surface_mapping,
                    ) = (
                        _defect_position_ratios(
                            camera_id=camera_id,
                            camera_count=len(camera_roots),
                            storage_index=storage_index,
                            rect=candidate["rect"],
                            source_width=int(intensity.shape[1]),
                            source_height=int(intensity.shape[0]),
                            camera_alignment=camera_alignment,
                            camera_surface_tile=camera_surface_tile,
                        )
                    )
                    if not use_global_region_map:
                        surface_mapping = {
                            "available": False,
                            "reason": "global-sync-or-overlap-quality-gate-failed",
                        }
                    depth_result = (
                        _depth_deviation(normalized_depth, candidate["rect"], crop_box)
                        if normalized_depth is not None
                        else {"available": False, "reason": "3d-model-not-run"}
                    )
                    defects.append(
                        {
                            "id": defect_id,
                            "source": "sick-temporary-defect-model",
                            "cameraId": camera_id,
                            "cameraIndex": camera_number,
                            "storageIndex": storage_index,
                            "cameraFrameSequence": metadata.get("cameraFrameSequence"),
                            "capturedAt": metadata.get("capTime")
                            or metadata.get("timestamp"),
                            "imageRect2d": {
                                "left": candidate["rect"][0],
                                "top": candidate["rect"][1],
                                "right": candidate["rect"][2],
                                "bottom": candidate["rect"][3],
                            },
                            "classId": (
                                f"legacy-{classification['externalId']}"
                                if classification is not None
                                else "surface-defect-candidate"
                            ),
                            "className": (
                                str(classification["name"])
                                if classification is not None
                                else "表面缺陷候选"
                            ),
                            "classificationStage": classification_stage,
                            "fineGrainedClass": (
                                str(classification["name"])
                                if classification is not None
                                else None
                            ),
                            "externalClassId": (
                                classification.get("externalId")
                                if classification is not None
                                else None
                            ),
                            "recognitionConfidence": (
                                classification.get("confidence")
                                if classification is not None
                                else None
                            ),
                            "classifications": candidate.get("classifications", {}),
                            "confidence": candidate["confidence"],
                            "severity": "review",
                            "modalities": candidate["modalities"],
                            "modelConfidence": candidate["modelConfidence"],
                            "modalityIoU": candidate.get("modalityIoU"),
                            "depthDeviation": depth_result,
                            "source2d": str(intensity_files[storage_index]),
                            "source3d": str(depth_files.get(storage_index, "")),
                            "metadataPath": str(metadata_files[storage_index]),
                            "reviewImage": str(review_path),
                            "reviewCropRect": review_crop,
                            "reviewImageWidth": review_crop["width"],
                            "reviewImageHeight": review_crop["height"],
                            "sourceImageWidth": int(intensity.shape[1]),
                            "sourceImageHeight": int(intensity.shape[0]),
                            "lengthRatio": (
                                round(length_ratio, 8) if use_global_region_map else None
                            ),
                            "circumferenceRatio": (
                                round(circumference_ratio, 8)
                                if use_global_region_map
                                else None
                            ),
                            "arrayAngleDeg": surface_mapping.get("arrayAngleDeg"),
                            "surfaceMapping": surface_mapping,
                            "coordinateSpace": "source-image-pixels",
                        }
                    )
                processed_frames += 1
                timings["postprocessSeconds"] += time.perf_counter() - phase_started

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    capture_wait_ms = timings["captureWaitSeconds"] * 1000.0
    compute_elapsed_ms = max(0.0, elapsed_ms - capture_wait_ms)
    state = (
        "complete"
        if gpu and stride == settings.frame_stride and use_global_region_map
        else "degraded"
    )
    return {
        **base,
        "state": state,
        "modelSet": {
            "schema": model_manifest.get("schema"),
            "id": model_manifest.get("id", "beiman-legacy-yolov5-temporary"),
            "temporary": True,
            "fineGrainedClassification": bool(classifiers),
            "models": {
                modality: {
                    "path": str(path),
                    "sha256": _sha256_file(
                        path, execution_gate=execution_gate
                    ),
                    "provider": providers[modality],
                }
                for modality, path in available_models.items()
            },
            "classifiers": {
                modality: {
                    "path": str(classifier.path),
                    "sha256": _sha256_file(
                        classifier.path, execution_gate=execution_gate
                    ),
                    "provider": classifier_providers[modality],
                }
                for modality, classifier in classifiers.items()
            },
        },
        "settings": {
            "geometryProfile": "cylinder",
            "coordinateSpace": "source-image-pixels",
            "imageSize": settings.image_size,
            "confidenceThreshold": settings.confidence_threshold,
            "iouThreshold": settings.iou_threshold,
            "mergeIouThreshold": settings.merge_iou_threshold,
            "classificationConfidenceThreshold": (
                settings.classification_confidence_threshold
            ),
            "configuredFrameStride": settings.frame_stride,
            "effectiveFrameStride": stride,
            "gpuDeviceId": settings.gpu_device_id,
            "depthExposure": settings.depth_exposure,
            "depthBaselineSampleStep": settings.depth_baseline_sample_step,
            "inferenceBatchSize": settings.inference_batch_size,
            "preprocessWorkers": settings.preprocess_workers,
            "reviewCropMinimumSize": settings.review_crop_minimum_size,
            "captureIdleProbe": settings.capture_origin or None,
            "maximumPendingStorageRounds": settings.maximum_pending_storage_rounds,
            "requireApprovedRegionMap": settings.require_approved_region_map,
        },
        "regionManifestPath": str(region_manifest_path(storage_root, material_id)),
        "regionQualityGate": (region_map or {}).get("qualityGate"),
        "globalPositionAvailable": use_global_region_map,
        "riskTags": (
            []
            if use_global_region_map
            else [
                "global-position-unavailable",
                "cross-camera-deduplication-unavailable",
                *[str(reason) for reason in region_gate_reasons],
            ]
        ),
        "quality": {
            "reviewRequired": True,
            "fineGrainedClassification": bool(classifiers),
            "binaryDetectionOnly": not bool(classifiers),
            "gpuAcceleration": gpu,
            "sampled": stride > 1,
            "pausedForAcquisition": bool(settings.capture_origin),
            "validityPolicy": "invalid-depth-preserved-never-zero-filled",
            "reason": (
                "global quality gate failed; camera-local candidates require review"
                if not use_global_region_map
                else "temporary migrated models require operator review"
                if gpu
                else "CUDA unavailable; CPU fallback uses bounded frame sampling"
            ),
        },
        "statistics": {
            "cameraCount": len(camera_roots),
            "processedFrames": processed_frames,
            "skippedFrames": skipped_frames,
            "inferenceCount": inference_count,
            "recognitionInferenceCount": recognition_inference_count,
            "rawCandidateCount": raw_candidate_count,
            "overlapDuplicateFilteredCount": overlap_duplicate_count,
            "boundaryArtifactFilteredCount": boundary_artifact_count,
            "pseudoDefectFilteredCount": pseudo_defect_count,
            "defectCount": len(defects),
            "elapsedMs": round(elapsed_ms, 3),
            "computeElapsedMs": round(compute_elapsed_ms, 3),
            "averageFrameMs": round(elapsed_ms / max(processed_frames, 1), 3),
            "throughputFramesPerSecond": round(
                processed_frames / max(elapsed_ms / 1000.0, 1e-9), 3
            ),
            "computeThroughputFramesPerSecond": round(
                processed_frames / max(compute_elapsed_ms / 1000.0, 1e-9), 3
            ),
            "timingsMs": {
                f"{key.removesuffix('Seconds')}Ms": round(value * 1000.0, 3)
                for key, value in timings.items()
            },
        },
        "defects": defects,
    }


def configured_legacy_model_hash(
    settings: DefectDetectionConfig,
    execution_gate: Callable[[str], None] | None,
) -> str:
    files = (
        ("detector2d", settings.model_2d_path),
        ("detector3d", settings.model_3d_path),
        ("classifier2d", settings.classifier_2d_path),
        ("classifier3d", settings.classifier_3d_path),
        ("manifest", settings.model_manifest_path),
    )
    file_signatures: list[tuple[Any, ...]] = []
    for name, path in files:
        if execution_gate is not None:
            execution_gate(f"legacy-model-fingerprint-stat:{name}")
        if path is None or not path.is_file():
            file_signatures.append((name, None))
            continue
        stat = path.stat()
        file_signatures.append(
            (name, str(path.resolve()), int(stat.st_size), int(stat.st_mtime_ns))
        )
    setting_fingerprint = {
        "imageSize": settings.image_size,
        "confidenceThreshold": settings.confidence_threshold,
        "iouThreshold": settings.iou_threshold,
        "mergeIouThreshold": settings.merge_iou_threshold,
        "maximumDetectionsPerFrame": settings.maximum_detections_per_frame,
        "classificationConfidenceThreshold": (
            settings.classification_confidence_threshold
        ),
        "frameStride": settings.frame_stride,
        "cpuFrameStride": settings.cpu_frame_stride,
        "depthExposure": settings.depth_exposure,
        "depthBaselineSampleStep": settings.depth_baseline_sample_step,
    }
    cache_key: tuple[Any, ...] = (
        json.dumps(setting_fingerprint, sort_keys=True, separators=(",", ":")),
        *file_signatures,
    )
    cached = _LEGACY_MODEL_HASH_CACHE.get(cache_key)
    if cached is not None:
        return cached
    inputs: dict[str, Any] = {
        "settings": setting_fingerprint,
        "files": {},
    }
    for name, path in files:
        if execution_gate is not None:
            execution_gate(f"legacy-model-fingerprint:{name}")
        inputs["files"][name] = (
            _sha256_file(path, execution_gate=execution_gate)
            if path is not None and path.is_file()
            else None
        )
    encoded = json.dumps(
        inputs, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    result = hashlib.sha256(encoded).hexdigest()
    _LEGACY_MODEL_HASH_CACHE[cache_key] = result
    while len(_LEGACY_MODEL_HASH_CACHE) > 8:
        _LEGACY_MODEL_HASH_CACHE.pop(next(iter(_LEGACY_MODEL_HASH_CACHE)))
    return result


def _save_geometry_roi(path: Path, value: Any) -> None:
    array = np.asarray(value, dtype=np.uint8)
    if array.ndim not in {2, 3} or array.size == 0:
        raise ValueError("geometry review ROI must be a non-empty image")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        Image.fromarray(array).save(temporary, format="PNG", optimize=False)
        replace_file(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _prepare_geometry_defects(
    manifest: dict[str, Any],
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment: dict[str, Any],
    *,
    algorithm_revision: int,
    config_sha256: str,
    execution_gate: Callable[[str], None] | None,
) -> dict[str, Any]:
    provisional_labels = {
        "pit": "凹坑候选",
        "pit-compact": "凹坑候选",
        "groove": "沟槽候选",
        "groove-elongated": "沟槽候选",
        "bulge": "凸起候选",
        "bulge-compact": "凸起候选",
        "ridge": "脊状凸起候选",
        "ridge-elongated": "脊状凸起候选",
    }
    region_map = read_region_manifest(storage_root, material_id)
    global_position_available = bool(
        region_map and region_map.get("defectDetectionAllowed")
    )
    region_reasons = (
        region_map.get("qualityGate", {}).get("reasons", [])
        if region_map
        else ["region-manifest-missing"]
    )
    if execution_gate is not None:
        execution_gate("depth-geometry-surface-manifest-read")
    try:
        surface_manifest = _read_json(surface_path(storage_root, material_id))
    except (OSError, ValueError, json.JSONDecodeError):
        surface_manifest = {}
    surface_tiles = {
        str(row.get("cameraId")): row
        for row in surface_manifest.get("cameraTiles", {}).get("cameras", [])
        if isinstance(row, dict) and row.get("cameraId")
    }
    prepared: list[dict[str, Any]] = []
    overlap_filtered = 0
    boundary_filtered = 0
    for source_row in manifest.get("defects", []):
        if execution_gate is not None:
            execution_gate("depth-geometry-artifact")
        if not isinstance(source_row, dict):
            continue
        defect = dict(source_row)
        camera_id = str(defect.get("cameraId", ""))
        frame_index = int(defect.get("storageIndex", defect.get("peakFrame", 0)) or 0)
        bbox = defect.get("bbox", [0, 0, 0, 0])
        if not isinstance(bbox, list) or len(bbox) != 4:
            bbox = [0, 0, 0, 0]
        rect = [int(value) for value in bbox]
        provisional_class = str(
            defect.get("provisionalClass", "depth-geometry-candidate")
        )
        region_row = (region_map or {}).get("cameras", {}).get(camera_id, {})
        if global_position_available:
            center_x = (rect[0] + rect[2]) / 2.0
            disposition = candidate_region_disposition(
                center_x,
                region_row.get("ownedColumnIntervals", []),
                region_row.get("overlapColumnIntervals", []),
            )
            if disposition == "overlap-duplicate":
                overlap_filtered += 1
                continue
            if disposition == "boundary":
                boundary_filtered += 1
                continue
        defect.update(
            {
                "source": DEPTH_GEOMETRY_SOURCE,
                "algorithmRevision": algorithm_revision,
                "configHash": config_sha256,
                "storageIndex": frame_index,
                "classId": provisional_class,
                "className": provisional_labels.get(
                    provisional_class,
                    str(defect.get("class", defect.get("type", "几何异常候选"))),
                ),
                "classificationStage": "geometry-rule",
                "fineGrainedClass": None,
                "candidatePolarity": defect.get("polarity"),
                "imageRect2d": {
                    "left": rect[0],
                    "top": rect[1],
                    "right": rect[2],
                    "bottom": rect[3],
                },
                "depthDeviation": {
                    "available": True,
                    "signedMm": defect.get("signedDepthMm"),
                    "absoluteMm": defect.get("absoluteDepthMm"),
                    "p05Mm": defect.get("p05DepthMm"),
                    "p95Mm": defect.get("p95DepthMm"),
                },
                "lengthRatio": None,
                "circumferenceRatio": None,
                "arrayAngleDeg": None,
                "surfaceMapping": {
                    "available": False,
                    "reason": (
                        "camera-local-geometry-coordinate"
                        if global_position_available
                        else "global-sync-or-overlap-quality-gate-failed"
                    ),
                },
                "globalPositionAvailable": False,
                "coordinateSpace": "source-image-pixels",
                "longitudinalSpanMm": None,
                "areaMm2": None,
            }
        )
        camera_root = camera_roots.get(camera_id)
        if camera_root is not None:
            flow_root = capture_root(camera_root, material_id, camera_id)
            intensity_path = flow_root / "2d" / f"{frame_index}.png"
            defect["source2d"] = str(intensity_path)
            defect["source3d"] = str(flow_root / "3d" / f"{frame_index}.npz")
            defect["metadataPath"] = str(flow_root / "json" / f"{frame_index}.json")
            review_root = (
                defect_image_root(camera_root, material_id)
                / "geometry"
                / config_sha256[:16]
            )
            intensity_value = defect.pop("intensityRoi", None)
            residual_value = defect.pop("residualJetRoi", None)
            if intensity_value is not None:
                review_path = review_root / f"{defect['id']}-intensity.png"
                _save_geometry_roi(review_path, intensity_value)
                defect["reviewImage"] = str(review_path)
                intensity_array = np.asarray(intensity_value, dtype=np.uint8)
                defect["reviewImageWidth"] = int(intensity_array.shape[1])
                defect["reviewImageHeight"] = int(intensity_array.shape[0])
            if residual_value is not None:
                residual_path = review_root / f"{defect['id']}-residual.png"
                _save_geometry_roi(residual_path, residual_value)
                defect["residualReviewImage"] = str(residual_path)
                if not defect.get("reviewImage"):
                    defect["reviewImage"] = str(residual_path)
            source_shape: tuple[int, int] | None = None
            if intensity_path.is_file():
                if execution_gate is not None:
                    execution_gate("depth-geometry-review-intensity-read")
                try:
                    with Image.open(intensity_path) as image:
                        intensity = np.asarray(image.convert("L"))
                    source_shape = (int(intensity.shape[0]), int(intensity.shape[1]))
                    if not defect.get("reviewImage"):
                        review_path = review_root / f"{defect['id']}-intensity.png"
                        review_crop = _save_review_crop(
                            intensity,
                            rect,
                            review_path,
                        )
                        defect["reviewImage"] = str(review_path)
                        defect["reviewCropRect"] = review_crop
                        defect["reviewImageWidth"] = review_crop["width"]
                        defect["reviewImageHeight"] = review_crop["height"]
                    defect["sourceImageWidth"] = source_shape[1]
                    defect["sourceImageHeight"] = source_shape[0]
                except (OSError, ValueError):
                    source_shape = None
            if global_position_available and source_shape is not None:
                length_ratio, circumference_ratio, camera_number, mapping = (
                    _defect_position_ratios(
                        camera_id=camera_id,
                        camera_count=len(camera_roots),
                        storage_index=frame_index,
                        rect=rect,
                        source_width=source_shape[1],
                        source_height=source_shape[0],
                        camera_alignment=alignment.get("cameras", {}).get(
                            camera_id, {}
                        ),
                        camera_surface_tile=surface_tiles.get(camera_id),
                    )
                )
                defect["cameraIndex"] = camera_number
                defect["lengthRatio"] = round(length_ratio, 8)
                defect["circumferenceRatio"] = round(circumference_ratio, 8)
                defect["arrayAngleDeg"] = mapping.get("arrayAngleDeg")
                defect["surfaceMapping"] = mapping
                defect["globalPositionAvailable"] = True
        prepared.append(defect)
    manifest["defects"] = prepared
    manifest["algorithmRevision"] = algorithm_revision
    manifest["configHash"] = config_sha256
    manifest["source"] = DEPTH_GEOMETRY_SOURCE
    manifest["globalPositionAvailable"] = global_position_available
    manifest["riskTags"] = (
        []
        if global_position_available
        else [
            "global-position-unavailable",
            "cross-camera-deduplication-unavailable",
            *[str(reason) for reason in region_reasons],
        ]
    )
    statistics = manifest.setdefault("statistics", {})
    statistics["defectCount"] = len(prepared)
    statistics["overlapDuplicateFilteredCount"] = overlap_filtered
    statistics["boundaryArtifactFilteredCount"] = boundary_filtered
    return manifest


def build_flow_defect_detection(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment: dict[str, Any],
    *,
    config: DefectDetectionConfig,
    execution_gate: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Run local depth geometry and the legacy model as independent groups."""
    settings = config.bounded()
    profile_path = settings.depth_geometry_profile_path
    # Compatibility for unit tests and sites that have not opted into the
    # SICK depth configuration yet.
    if profile_path is None:
        return _build_legacy_flow_defect_detection(
            camera_roots,
            storage_root,
            material_id,
            alignment,
            config=settings,
            execution_gate=execution_gate,
        )

    snapshot = load_depth_geometry_config_snapshot(profile_path)
    guarded = config_checkpoint(profile_path, snapshot, execution_gate)
    geometry_settings = DepthGeometryConfig.from_mapping(snapshot.value)
    existing: dict[str, Any] = {}
    path = defect_detection_manifest_path(storage_root, material_id)
    if settings.history_rebuild and path.is_file():
        guarded("defect-existing-manifest-read")
        try:
            existing = _read_json(path)
        except (OSError, ValueError, json.JSONDecodeError):
            existing = {}

    existing_legacy = (
        existing.get("defectGroups", {}).get("legacy", {})
        if isinstance(existing.get("defectGroups"), dict)
        else {}
    )
    legacy_manifest: dict[str, Any]
    reuse_legacy = False
    expected_model_hash = ""
    if settings.history_rebuild and isinstance(existing_legacy, dict) and existing_legacy:
        expected_model_hash = configured_legacy_model_hash(settings, guarded)
        reuse_legacy = existing_legacy.get("modelHash") == expected_model_hash
    if reuse_legacy:
        legacy_manifest = {
            "schema": DEFECT_DETECTION_SCHEMA,
            "materialId": material_id,
            **existing_legacy,
            "defects": existing_legacy.get("defects", []),
        }
    else:
        try:
            legacy_manifest = _build_legacy_flow_defect_detection(
                camera_roots,
                storage_root,
                material_id,
                alignment,
                config=settings,
                execution_gate=guarded,
            )
            legacy_manifest["modelHash"] = (
                expected_model_hash
                or configured_legacy_model_hash(settings, guarded)
            )
        except DepthGeometryConfigChanged:
            raise
        except Exception as error:
            legacy_manifest = {
                "schema": DEFECT_DETECTION_SCHEMA,
                "materialId": material_id,
                "state": "failed",
                "source": "sick-temporary-defect-model",
                "error": f"{type(error).__name__}: {error}",
                "statistics": {"defectCount": 0},
                "defects": [],
            }

    try:
        geometry_manifest = build_flow_depth_geometry(
            camera_roots,
            storage_root,
            material_id,
            alignment,
            geometry_settings,
            guarded,
        )
        geometry_manifest = _prepare_geometry_defects(
            geometry_manifest,
            camera_roots,
            storage_root,
            material_id,
            alignment,
            algorithm_revision=snapshot.revision,
            config_sha256=snapshot.sha256,
            execution_gate=guarded,
        )
    except DepthGeometryConfigChanged:
        raise
    except Exception as error:
        geometry_manifest = {
            "schema": "steel.sick-depth-geometry.v1",
            "materialId": material_id,
            "source": DEPTH_GEOMETRY_SOURCE,
            "state": "failed",
            "algorithmRevision": snapshot.revision,
            "configHash": snapshot.sha256,
            "error": f"{type(error).__name__}: {error}",
            "statistics": {"defectCount": 0},
            "defects": [],
        }
    manifest = compose_dual_manifest(
        legacy_manifest,
        geometry_manifest,
        minimum_iou=settings.merge_iou_threshold,
    )
    manifest["generatedAt"] = _utc_text()
    manifest["materialId"] = material_id
    return manifest


def build_and_write_flow_defect_detection(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment: dict[str, Any],
    *,
    config: DefectDetectionConfig,
    execution_gate: Callable[[str], None] | None = None,
) -> tuple[Path, dict[str, Any]]:
    settings = config.bounded()
    job_gate = execution_gate
    if settings.depth_geometry_profile_path is not None:
        if execution_gate is not None:
            execution_gate("depth-geometry-config-snapshot-read")
        job_snapshot = load_depth_geometry_config_snapshot(
            settings.depth_geometry_profile_path
        )
        job_gate = config_checkpoint(
            settings.depth_geometry_profile_path,
            job_snapshot,
            execution_gate,
        )
    manifest = build_flow_defect_detection(
        camera_roots,
        storage_root,
        material_id,
        alignment,
        config=settings,
        execution_gate=job_gate,
    )
    path = defect_detection_manifest_path(storage_root, material_id)
    manifest["manifestPath"] = str(path)
    if job_gate is not None:
        job_gate("defect-manifest-initial-write")
    _atomic_json(path, manifest)
    if manifest.get("state") == "blocked":
        # A newly failed region quality gate must also withdraw stale pending
        # model rows from an earlier run.  The database's replacePending
        # contract preserves confirmed/false-positive operator decisions while
        # an empty defect batch removes only unreviewed machine candidates.
        try:
            if job_gate is not None:
                job_gate("defect-blocked-database-import")
            manifest["databaseImport"] = import_defect_manifest(
                manifest,
                settings.database_origin,
                execution_gate=job_gate,
            )
        except (ExecutionGateInterrupted, DepthGeometryConfigChanged):
            raise
        except Exception as error:
            manifest["databaseImport"] = {
                "state": "failed",
                "error": f"{type(error).__name__}: {error}",
            }
        manifest["databaseImport"]["blockedReason"] = manifest.get(
            "blockedReason", "region-quality-gate-failed"
        )
        if job_gate is not None:
            job_gate("defect-blocked-manifest-final-write")
        _atomic_json(path, manifest)
        return path, manifest
    try:
        if job_gate is not None:
            job_gate("defect-database-import")
        manifest["databaseImport"] = import_defect_manifest(
            manifest,
            settings.database_origin,
            execution_gate=job_gate,
        )
        if settings.database_origin and manifest["databaseImport"].get("state") == "failed":
            manifest["state"] = "database-write-failed"
        elif (
            settings.database_origin
            and manifest["databaseImport"].get("state") == "partial"
            and manifest.get("state") == "complete"
        ):
            manifest["state"] = "degraded"
    except (ExecutionGateInterrupted, DepthGeometryConfigChanged):
        raise
    except Exception as error:
        manifest["databaseImport"] = {
            "state": "failed",
            "error": f"{type(error).__name__}: {error}",
        }
        if settings.database_origin:
            manifest["state"] = "database-write-failed"
    if job_gate is not None:
        job_gate("defect-manifest-final-write")
    _atomic_json(path, manifest)
    return path, manifest
