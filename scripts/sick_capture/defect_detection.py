"""Bounded post-flow surface-defect detection using temporary legacy models.

The detector intentionally runs only after a flow is closed and its storage
queue is empty.  It consumes the immutable ``2d/*.png``, ``3d/*.npz`` and
``json/*.json`` artifacts, writes review crops plus a traceable manifest, and
never mutates the acquisition files.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import math
import os
import tempfile
import time
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib import request

import numpy as np
from PIL import Image

from .alignment import _atomic_json, _read_json, _numeric_files
from .playback import detect_valid_grayscale_roi


DEFECT_DETECTION_SCHEMA = "steel.sick-flow-defect-detection.v1"
MODEL_MANIFEST_SCHEMA = "steel.temporary-defect-model-set.v1"
_DLL_DIRECTORY_HANDLES: list[Any] = []


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
    classification_confidence_threshold: float = 0.55
    frame_stride: int = 1
    cpu_frame_stride: int = 8
    gpu_device_id: int = 1
    depth_exposure: float = 300.0
    minimum_crop_size: int = 32
    capture_origin: str = ""
    maximum_idle_wait_seconds: float = 300.0
    maximum_pending_storage_rounds: int = 0

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
            classification_confidence_threshold=max(
                0.01, min(0.99, float(self.classification_confidence_threshold))
            ),
            frame_stride=max(1, min(128, int(self.frame_stride))),
            cpu_frame_stride=max(1, min(128, int(self.cpu_frame_stride))),
            gpu_device_id=max(0, min(31, int(self.gpu_device_id))),
            depth_exposure=max(1.0, min(5000.0, float(self.depth_exposure))),
            minimum_crop_size=max(8, min(256, int(self.minimum_crop_size))),
            capture_origin=str(self.capture_origin).strip().rstrip("/"),
            maximum_idle_wait_seconds=max(
                1.0, min(3600.0, float(self.maximum_idle_wait_seconds))
            ),
            maximum_pending_storage_rounds=max(
                0, min(128, int(self.maximum_pending_storage_rounds))
            ),
        )


def _utc_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def defect_detection_manifest_path(storage_root: Path, material_id: str) -> Path:
    return storage_root / "defects" / material_id / "manifest.json"


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


def flatten_depth_for_detection(
    depth: np.ndarray,
    metadata: dict[str, Any],
    crop_box: list[int],
    exposure: float,
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
    # ``nanmedian`` emits RuntimeWarning (rather than a floating-point error)
    # for columns/rows containing only invalid depth samples.  Those regions
    # are expected at the optical black border and are restored to NaN below.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        baseline = np.nanmedian(millimeters, axis=0)
    normalized = millimeters - baseline[None, :]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        row_shift = np.nanmedian(normalized, axis=1)
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
        cuda_path = os.environ.get("CUDA_PATH", "").strip()
        if os.name == "nt" and cuda_path:
            cuda_bin = Path(cuda_path) / "bin"
            if cuda_bin.is_dir():
                _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(cuda_bin)))
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
        self.input_name = self.session.get_inputs()[0].name
        self.config = config

    def detect(self, rgb: np.ndarray) -> list[dict[str, Any]]:
        tensor, scale, padding = _letterbox_rgb(rgb, self.config.image_size)
        predictions = self.session.run(None, {self.input_name: tensor})[0]
        return decode_yolov5_predictions(
            predictions,
            original_shape=rgb.shape[:2],
            scale=scale,
            padding=padding,
            confidence_threshold=self.config.confidence_threshold,
            iou_threshold=self.config.iou_threshold,
            maximum_detections=self.config.maximum_detections_per_frame,
        )


class OnnxDefectClassifier:
    """NHWC EfficientNet classifier migrated from the legacy H5 weights."""

    def __init__(self, path: Path, config: DefectDetectionConfig) -> None:
        try:
            import onnxruntime as ort
        except ImportError as error:
            raise RuntimeError("onnxruntime-gpu is required for defect recognition") from error
        if not path.is_file():
            raise FileNotFoundError(path)
        cuda_path = os.environ.get("CUDA_PATH", "").strip()
        if os.name == "nt" and cuda_path:
            cuda_bin = Path(cuda_path) / "bin"
            if cuda_bin.is_dir():
                _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(cuda_bin)))
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
) -> None:
    height, width = intensity.shape
    x1, y1, x2, y2 = rect
    padding_x = max(8, (x2 - x1) // 4)
    padding_y = max(8, (y2 - y1) // 4)
    box = (
        max(0, x1 - padding_x),
        max(0, y1 - padding_y),
        min(width, x2 + padding_x),
        min(height, y2 + padding_y),
    )
    if box[2] <= box[0] or box[3] <= box[1]:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        Image.fromarray(intensity[box[1] : box[3], box[0] : box[2]], mode="L").save(
            temporary, format="PNG", optimize=False
        )
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _prepare_review_output(output_root: Path) -> None:
    review_root = output_root / "review"
    if review_root.is_symlink():
        raise ValueError(f"review output must not be a symbolic link: {review_root}")
    if not review_root.is_dir():
        return
    # Review crops are derived artifacts.  A rebuild replaces only PNG files
    # inside this exact material directory; immutable source frames are never
    # touched and every retained crop will be regenerated from the manifest.
    for path in review_root.glob("*.png"):
        if path.is_file() and not path.is_symlink():
            path.unlink()


def _selected_indices(indices: list[int], stride: int) -> list[int]:
    if not indices:
        return []
    selected = indices[:: max(1, stride)]
    if selected[-1] != indices[-1]:
        selected.append(indices[-1])
    return selected


def _capture_is_idle(origin: str, maximum_pending_storage_rounds: int) -> bool:
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
) -> None:
    if not config.capture_origin:
        return
    deadline = time.monotonic() + config.maximum_idle_wait_seconds
    while time.monotonic() < deadline:
        if _capture_is_idle(
            config.capture_origin, config.maximum_pending_storage_rounds
        ):
            idle_state["since"] = idle_state.get("since") or time.monotonic()
            if time.monotonic() - float(idle_state["since"]) >= 0.5:
                return
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


def build_flow_defect_detection(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment: dict[str, Any],
    *,
    config: DefectDetectionConfig,
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
    available_models = {
        modality: path
        for modality, path in configured_models.items()
        if path is not None and path.is_file()
    }
    if not available_models:
        raise FileNotFoundError("no configured defect ONNX model is available")
    model_manifest = _model_manifest(settings)
    detectors = {
        modality: OnnxYoloDetector(path, settings)
        for modality, path in available_models.items()
    }
    classifiers = {
        modality: OnnxDefectClassifier(path, settings)
        for modality, path in configured_classifiers.items()
        if modality in detectors and path is not None and path.is_file()
    }
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
    output_root = storage_root / "defects" / material_id
    _prepare_review_output(output_root)
    defects: list[dict[str, Any]] = []
    processed_frames = 0
    skipped_frames = 0
    inference_count = 0
    recognition_inference_count = 0
    raw_candidate_count = 0
    pseudo_defect_count = 0
    boundary_artifact_count = 0
    capture_idle_state: dict[str, float | None] = {"since": None}

    for camera_id, camera_root in sorted(camera_roots.items()):
        flow_root = camera_root / material_id
        intensity_files = _numeric_files(flow_root / "2d", ".png")
        depth_files = _numeric_files(flow_root / "3d", ".npz")
        metadata_files = _numeric_files(flow_root / "json", ".json")
        indices = sorted(set(intensity_files) & set(metadata_files))
        camera_alignment = alignment.get("cameras", {}).get(camera_id, {})
        head = camera_alignment.get("head", {})
        tail = camera_alignment.get("tail", {})
        if head.get("detected"):
            indices = [index for index in indices if index >= int(head["frameIndex"])]
        if tail.get("detected"):
            indices = [index for index in indices if index <= int(tail["frameIndex"])]
        for storage_index in _selected_indices(indices, stride):
            _wait_for_capture_idle(settings, capture_idle_state)
            with Image.open(intensity_files[storage_index]) as image:
                intensity = np.asarray(image.convert("L"))
            if intensity.size == 0 or float(np.mean(intensity > 8)) < 0.005:
                skipped_frames += 1
                continue
            crop_box = detect_valid_grayscale_roi(intensity)
            if head.get("detected") and storage_index == int(head["frameIndex"]):
                crop_box[1] = max(crop_box[1], int(head.get("row", 0)))
            if tail.get("detected") and storage_index == int(tail["frameIndex"]):
                crop_box[3] = min(crop_box[3], int(tail.get("row", intensity.shape[0])))
            left, top, right, bottom = crop_box
            if (
                right - left < settings.minimum_crop_size
                or bottom - top < settings.minimum_crop_size
            ):
                skipped_frames += 1
                continue
            metadata = _read_json(metadata_files[storage_index])
            frame_2d: list[dict[str, Any]] = []
            frame_3d: list[dict[str, Any]] = []
            normalized_depth: np.ndarray | None = None
            if "2d" in detectors:
                rgb_2d = np.repeat(intensity[top:bottom, left:right, None], 3, axis=2)
                local_2d = detectors["2d"].detect(rgb_2d)
                recognition_inference_count += _classify_candidates(
                    local_2d,
                    rgb_2d,
                    classifiers.get("2d"),
                    classifier_rows.get("2d", {}),
                    "2d",
                )
                frame_2d = _offset_candidates(local_2d, left, top, "2d")
                inference_count += 1
            if "3d" in detectors and storage_index in depth_files:
                depth = _load_depth(depth_files[storage_index])
                rgb_3d, normalized_depth = flatten_depth_for_detection(
                    depth, metadata, crop_box, settings.depth_exposure
                )
                local_3d = detectors["3d"].detect(rgb_3d)
                # The old 3D classifier explicitly converted RGB to BGR.
                recognition_inference_count += _classify_candidates(
                    local_3d,
                    np.ascontiguousarray(rgb_3d[..., ::-1]),
                    classifiers.get("3d"),
                    classifier_rows.get("3d", {}),
                    "3d",
                )
                frame_3d = _offset_candidates(local_3d, left, top, "3d")
                inference_count += 1
            candidates = merge_modal_candidates(
                frame_2d, frame_3d, settings.merge_iou_threshold
            )
            for candidate in candidates:
                raw_candidate_count += 1
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
                review_path = output_root / "review" / f"{defect_id}.png"
                _save_review_crop(intensity, candidate["rect"], review_path)
                depth_result = (
                    _depth_deviation(normalized_depth, candidate["rect"], crop_box)
                    if normalized_depth is not None
                    else {"available": False, "reason": "3d-model-not-run"}
                )
                defects.append(
                    {
                        "id": defect_id,
                        "cameraId": camera_id,
                        "storageIndex": storage_index,
                        "cameraFrameSequence": metadata.get("cameraFrameSequence"),
                        "capturedAt": metadata.get("capTime") or metadata.get("timestamp"),
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
                        "coordinateSpace": "source-image-pixels",
                    }
                )
            processed_frames += 1

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    state = "complete" if gpu and stride == settings.frame_stride else "degraded"
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
                    "sha256": _sha256_file(path),
                    "provider": providers[modality],
                }
                for modality, path in available_models.items()
            },
            "classifiers": {
                modality: {
                    "path": str(classifier.path),
                    "sha256": _sha256_file(classifier.path),
                    "provider": classifier_providers[modality],
                }
                for modality, classifier in classifiers.items()
            },
        },
        "settings": {
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
            "captureIdleProbe": settings.capture_origin or None,
            "maximumPendingStorageRounds": settings.maximum_pending_storage_rounds,
        },
        "quality": {
            "reviewRequired": True,
            "fineGrainedClassification": bool(classifiers),
            "binaryDetectionOnly": not bool(classifiers),
            "gpuAcceleration": gpu,
            "sampled": stride > 1,
            "pausedForAcquisition": bool(settings.capture_origin),
            "reason": (
                "temporary migrated models require operator review"
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
            "boundaryArtifactFilteredCount": boundary_artifact_count,
            "pseudoDefectFilteredCount": pseudo_defect_count,
            "defectCount": len(defects),
            "elapsedMs": round(elapsed_ms, 3),
            "averageFrameMs": round(elapsed_ms / max(processed_frames, 1), 3),
        },
        "defects": defects,
    }


def build_and_write_flow_defect_detection(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment: dict[str, Any],
    *,
    config: DefectDetectionConfig,
) -> tuple[Path, dict[str, Any]]:
    manifest = build_flow_defect_detection(
        camera_roots,
        storage_root,
        material_id,
        alignment,
        config=config,
    )
    path = defect_detection_manifest_path(storage_root, material_id)
    _atomic_json(path, manifest)
    return path, manifest
