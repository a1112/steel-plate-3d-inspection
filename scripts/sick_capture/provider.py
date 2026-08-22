"""Steel-compatible HTTP sidecar for real SICK GenTL cameras."""

from __future__ import annotations

import ipaddress
import datetime as dt
import io
import json
import mimetypes
import os
import shutil
import tempfile
import threading
import time
from collections import OrderedDict, deque
from concurrent.futures import Future, ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from multiprocessing import shared_memory
from pathlib import Path
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import parse_qs, unquote, urlsplit

import numpy as np
from PIL import Image

from .alignment import (
    AlignmentConfig,
    _atomic_json,
    alignment_manifest_path,
    build_and_write_flow_alignment,
)
from .defect_detection import (
    DefectDetectionConfig,
    build_and_write_flow_defect_detection,
    defect_detection_manifest_path,
)
from .gentl import SickGenTLBackend
from .measurement import (
    MeasurementConfig,
    build_and_write_flow_measurement,
    measurement_manifest_path,
)
from .playback import (
    build_and_write_playback_index,
    build_image_pyramid,
    flow_pyramid_cache_status_path,
    playback_catalog_path,
    playback_index_path,
    read_image_pyramid,
    read_indexed_history,
    select_pyramid_image,
    source_fingerprint,
    write_flow_pyramid_cache_status,
)
from .profile import CameraProfile, SickCaptureProfile, load_profile, sha256_file
from .storage import DualFormatWriter, atomic_summary


CAPTURE_DISCARDED_NOT_ARMED = 49000
BLACK_FRAME_DISCARDED = 49001
NO_STEEL_FRAME_DISCARDED = 49002
SICK_CAPTURE_FAILED = 49100
SICK_COMPONENT_SCHEMA_MISMATCH = 49101
SICK_STORAGE_FAILED = 49102
LIVE_PREVIEW_BLACK_MAX = 8.0
LIVE_PREVIEW_MAX_FPS = 2.0


_STORAGE_PROCESS_WRITER: DualFormatWriter | None = None
_STORAGE_PROCESS_SHARED_MEMORY: dict[str, shared_memory.SharedMemory] = {}
_STORAGE_PROCESS_THREAD_POOL: ThreadPoolExecutor | None = None


def _initialize_storage_process_writer(
    jpeg_quality: int,
    fsync: bool,
    artifact_context: dict[str, Any],
    thread_count: int,
) -> None:
    global _STORAGE_PROCESS_WRITER, _STORAGE_PROCESS_SHARED_MEMORY
    global _STORAGE_PROCESS_THREAD_POOL
    _STORAGE_PROCESS_WRITER = DualFormatWriter(
        jpeg_quality=jpeg_quality,
        fsync=fsync,
        artifact_context=artifact_context,
    )
    _STORAGE_PROCESS_SHARED_MEMORY = {}
    _STORAGE_PROCESS_THREAD_POOL = ThreadPoolExecutor(
        max_workers=max(1, thread_count),
        thread_name_prefix="sick-storage-disk",
    )


def _initialize_flow_analysis_process() -> None:
    """Keep offline PNG/NPZ analysis from pre-empting the GenTL fetch loop."""
    try:
        if os.name == "nt":
            import ctypes

            below_normal_priority_class = 0x00004000
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            kernel32.SetPriorityClass.restype = ctypes.c_int
            process = kernel32.GetCurrentProcess()
            if not kernel32.SetPriorityClass(
                process, below_normal_priority_class
            ):
                raise OSError(ctypes.get_last_error(), "SetPriorityClass failed")
        else:
            os.nice(10)
    except (AttributeError, OSError, ValueError):
        # Priority lowering is a protective optimization. Analysis remains
        # correct on platforms that do not expose either mechanism.
        pass


def _build_flow_artifacts(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment_config: AlignmentConfig,
    calibration_path: Path | None,
    measurement_config: MeasurementConfig,
) -> tuple[Path, dict[str, Any], Path, dict[str, Any]]:
    alignment_path, alignment = build_and_write_flow_alignment(
        camera_roots,
        storage_root,
        material_id,
        config=alignment_config,
    )
    measurement_path, measurement = build_and_write_flow_measurement(
        camera_roots,
        storage_root,
        material_id,
        alignment,
        calibration_path=calibration_path,
        config=measurement_config,
    )
    build_and_write_playback_index(camera_roots, storage_root, material_id)
    return alignment_path, alignment, measurement_path, measurement


def _build_flow_defect_artifact(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment: dict[str, Any],
    defect_detection_config: DefectDetectionConfig,
) -> tuple[Path, dict[str, Any]]:
    try:
        return build_and_write_flow_defect_detection(
            camera_roots,
            storage_root,
            material_id,
            alignment,
            config=defect_detection_config,
        )
    except Exception as error:
        # A temporary learned model must never invalidate already completed
        # alignment, measurement, playback or immutable capture artifacts.
        defect_path = defect_detection_manifest_path(storage_root, material_id)
        defects = {
            "schema": "steel.sick-flow-defect-detection.v1",
            "generatedAt": _utc_text(),
            "materialId": material_id,
            "state": "failed",
            "temporaryModel": True,
            "error": str(error),
            "quality": {
                "reviewRequired": True,
                "fineGrainedClassification": False,
                "gpuAcceleration": False,
            },
            "statistics": {"defectCount": 0},
            "defects": [],
        }
        _atomic_json(defect_path, defects)
        return defect_path, defects


def _write_storage_shared_frame(
    camera_root: Path,
    material_id: str,
    frame_stub: Any,
    depth_descriptor: tuple[str, tuple[int, ...], str],
    intensity_descriptor: tuple[str, tuple[int, ...], str],
    options: dict[str, Any],
) -> Any:
    if _STORAGE_PROCESS_WRITER is None:
        raise RuntimeError("storage process writer is not initialized")
    depth_memory = _STORAGE_PROCESS_SHARED_MEMORY.get(depth_descriptor[0])
    if depth_memory is None:
        depth_memory = shared_memory.SharedMemory(name=depth_descriptor[0])
        _STORAGE_PROCESS_SHARED_MEMORY[depth_descriptor[0]] = depth_memory
    intensity_memory = _STORAGE_PROCESS_SHARED_MEMORY.get(intensity_descriptor[0])
    if intensity_memory is None:
        intensity_memory = shared_memory.SharedMemory(name=intensity_descriptor[0])
        _STORAGE_PROCESS_SHARED_MEMORY[intensity_descriptor[0]] = intensity_memory
    depth = np.ndarray(
        depth_descriptor[1],
        dtype=np.dtype(depth_descriptor[2]),
        buffer=depth_memory.buf,
    )
    intensity = np.ndarray(
        intensity_descriptor[1],
        dtype=np.dtype(intensity_descriptor[2]),
        buffer=intensity_memory.buf,
    )
    frame = replace(frame_stub, depth_raw=depth, intensity=intensity)
    return _STORAGE_PROCESS_WRITER.write(
        camera_root,
        material_id,
        frame,
        **options,
    )


def _write_storage_shared_round(
    tasks: list[
        tuple[
            Path,
            str,
            Any,
            tuple[str, tuple[int, ...], str],
            tuple[str, tuple[int, ...], str],
            dict[str, Any],
        ]
    ],
) -> list[tuple[bool, Any, str]]:
    if _STORAGE_PROCESS_THREAD_POOL is None:
        raise RuntimeError("storage process thread pool is not initialized")
    futures = [
        _STORAGE_PROCESS_THREAD_POOL.submit(
            _write_storage_shared_frame,
            *task,
        )
        for task in tasks
    ]
    outcomes: list[tuple[bool, Any, str]] = []
    for future in futures:
        try:
            outcomes.append((True, future.result(), ""))
        except Exception as error:
            outcomes.append((False, None, f"{type(error).__name__}: {error}"))
    return outcomes


def _truthy(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _steel_tail_metrics(
    intensity: np.ndarray,
    *,
    edge: str,
    rows: int,
    bright_threshold: float,
) -> tuple[float, float, int]:
    """Return max, bright ratio and actual row count at the latest scan edge."""

    if intensity.ndim < 2 or intensity.size == 0:
        return 0.0, 0.0, 0
    row_count = min(max(1, int(rows)), int(intensity.shape[0]))
    region = intensity[:row_count] if edge == "top" else intensity[-row_count:]
    maximum = float(np.max(region)) if region.size else 0.0
    bright_ratio = (
        float(np.count_nonzero(region > bright_threshold)) / float(region.size)
        if region.size
        else 0.0
    )
    return maximum, bright_ratio, row_count


def _safe_segment(value: str) -> str:
    result = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in value.strip())
    result = result.strip("._")[:96].rstrip(" .") or "unknown"
    reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
    if result.split(".", 1)[0].upper() in reserved:
        result = f"_{result}"
    return result


def _utc_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _frame_artifact_context(profile: SickCaptureProfile) -> dict[str, Any]:
    """Build immutable provenance attached to every persisted physical frame."""

    calibration = profile.raw.get("calibration", {})
    if not isinstance(calibration, dict):
        calibration = {}
    calibration_value = str(
        calibration.get("artifactPath", profile.raw.get("arrayCalibrationFile", "")) or ""
    ).strip()
    calibration_path: Path | None = None
    if calibration_value:
        candidate = Path(os.path.expandvars(calibration_value))
        candidates = [candidate] if candidate.is_absolute() else [
            (profile.source_path.parent / candidate).resolve(),
            (Path.cwd() / candidate).resolve(),
        ]
        calibration_path = next((item for item in candidates if item.is_file()), candidates[0])
    calibration_exists = bool(calibration_path and calibration_path.is_file())
    return {
        "captureProfile": {
            "name": profile.name,
            "path": str(profile.source_path),
            "sha256": sha256_file(profile.source_path),
        },
        "calibration": {
            "path": str(calibration_path) if calibration_path else "",
            "sha256": sha256_file(calibration_path) if calibration_exists else "",
            "present": calibration_exists,
            "metricProjectionVerified": bool(
                calibration.get("metricProjectionVerified", False)
            ),
        },
    }


def _integer(payload: dict[str, Any], key: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(payload.get(key, default))
    except (TypeError, ValueError) as error:
        raise ValueError(f"{key} must be an integer") from error
    if not minimum <= value <= maximum:
        raise ValueError(f"{key} must be between {minimum} and {maximum}")
    return value


def _profile_relative_path(profile: SickCaptureProfile, value: Any) -> Path | None:
    text = os.path.expandvars(str(value or "").strip())
    if not text:
        return None
    candidate = Path(text)
    return candidate if candidate.is_absolute() else profile.source_path.parent / candidate


class ProviderRuntime:
    def __init__(
        self,
        profile: SickCaptureProfile,
        *,
        backend: Any | None = None,
        writer: DualFormatWriter | None = None,
    ) -> None:
        self.profile = profile
        self.backend = backend or SickGenTLBackend(profile)
        artifact_context = _frame_artifact_context(profile)
        self.writer = writer or DualFormatWriter(
            jpeg_quality=profile.jpeg_quality,
            fsync=profile.fsync,
            artifact_context=artifact_context,
        )
        self.sessions: dict[str, Any] = {}
        self.session_errors: dict[str, str] = {}
        self.active_material_id = ""
        self.active_session_id = ""
        self.active_flow_no: int | None = None
        self.active_flow_code = ""
        self.steel_present = False
        self.save_enabled = False
        self.save_generation = 0
        capture_defaults = profile.raw.get("captureDefaults", {})
        self.frame_trigger_mode = str(
            capture_defaults.get("frameTriggerMode", "free-run")
        ).strip().lower()
        self.service_origin = os.environ.get(
            "STEEL_INSPECTION_SERVICE_ORIGIN", "http://127.0.0.1:4873"
        ).rstrip("/")
        self.grayscale_steel_detection = _truthy(
            os.environ.get(
                "SICK_GRAYSCALE_STEEL_DETECTION",
                capture_defaults.get("grayscaleSteelDetection"),
            ),
            False,
        )
        self.steel_bright_threshold = float(
            os.environ.get(
                "SICK_STEEL_BRIGHT_PIXEL_THRESHOLD",
                capture_defaults.get("steelBrightPixelThreshold", 8.0),
            )
        )
        self.steel_bright_ratio = float(
            os.environ.get(
                "SICK_STEEL_BRIGHT_PIXEL_RATIO",
                capture_defaults.get("steelBrightPixelRatio", 0.02),
            )
        )
        self.steel_entry_rounds = max(
            1,
            int(
                os.environ.get(
                    "SICK_STEEL_ENTRY_ROUNDS",
                    capture_defaults.get("steelEntryRounds", 2),
                )
            ),
        )
        self.steel_exit_rounds = max(
            1,
            int(
                os.environ.get(
                    "SICK_STEEL_EXIT_ROUNDS",
                    capture_defaults.get("steelExitRounds", 5),
                )
            ),
        )
        self.steel_pre_roll_frames = max(
            0,
            min(
                8,
                int(
                    os.environ.get(
                        "SICK_STEEL_PRE_ROLL_FRAMES",
                        capture_defaults.get("steelPreRollFrames", 1),
                    )
                ),
            ),
        )
        self.steel_post_roll_frames = max(
            0,
            min(
                8,
                int(
                    os.environ.get(
                        "SICK_STEEL_POST_ROLL_FRAMES",
                        capture_defaults.get("steelPostRollFrames", 1),
                    )
                ),
            ),
        )
        self.black_frame_cache_rounds = max(
            1,
            min(
                8,
                int(
                    os.environ.get(
                        "SICK_BLACK_FRAME_CACHE_ROUNDS",
                        capture_defaults.get("blackFrameCacheRounds", 8),
                    )
                ),
            ),
        )
        configured_min_cameras = int(
            os.environ.get(
                "SICK_STEEL_MIN_CAMERAS",
                capture_defaults.get(
                    "steelMinCameras", max(1, profile.expected_cameras // 2 + 1)
                ),
            )
        )
        self.steel_min_cameras = max(
            1, min(profile.expected_cameras, configured_min_cameras)
        )
        self.steel_entry_streak = 0
        self.steel_exit_streak = 0
        self.last_steel_signal_cameras = 0
        self.last_steel_transition_attempt = 0.0
        configured_capture_mode = str(capture_defaults.get("captureMode", "on-demand")).strip().lower()
        self.capture_mode = (
            configured_capture_mode
            if configured_capture_mode in {"continuous", "on-demand", "disabled"}
            else "on-demand"
        )
        self.capture_lock = threading.Lock()
        self.capture_pool = ThreadPoolExecutor(
            max_workers=max(1, profile.expected_cameras),
            thread_name_prefix="sick-capture",
        )
        configured_storage_process_workers = int(
            capture_defaults.get(
                "storageWriterThreads",
                capture_defaults.get(
                    # Compatibility alias: this now controls disk threads
                    # inside one isolated storage process.
                    "storageProcessWorkers",
                    min(4, profile.expected_cameras)
                    if profile.expected_cameras >= 4
                    else 0,
                ),
            )
        )
        self.steel_detection_edge = str(
            os.environ.get(
                "SICK_STEEL_DETECTION_EDGE",
                capture_defaults.get("steelDetectionEdge", "bottom"),
            )
        ).strip().lower()
        if self.steel_detection_edge not in {"top", "bottom"}:
            raise ValueError("steelDetectionEdge must be top or bottom")
        self.steel_detection_tail_rows = max(
            1,
            min(
                4096,
                int(
                    os.environ.get(
                        "SICK_STEEL_DETECTION_TAIL_ROWS",
                        capture_defaults.get("steelDetectionTailRows", 32),
                    )
                ),
            ),
        )
        self.alignment_config = AlignmentConfig(
            search_frames=int(
                capture_defaults.get(
                    "alignmentSearchFrames",
                    max(self.steel_pre_roll_frames + self.steel_entry_rounds, 8),
                )
            ),
            stable_rows=int(capture_defaults.get("alignmentStableRows", 8)),
            sample_step=int(capture_defaults.get("alignmentSampleStep", 4)),
            depth_valid_ratio=float(
                capture_defaults.get("alignmentDepthValidRatio", 0.005)
            ),
            intensity_threshold=self.steel_bright_threshold,
            intensity_ratio=self.steel_bright_ratio,
            anchor_interval_frames=int(
                capture_defaults.get("softSyncAnchorIntervalFrames", 16)
            ),
            maximum_anchor_residual_ms=float(
                capture_defaults.get("softSyncMaximumResidualMs", 40.0)
            ),
        ).bounded()
        calibration_value = os.path.expandvars(
            str(capture_defaults.get("arrayCalibrationPath", "")).strip()
        )
        self.array_calibration_path = (
            (
                Path(calibration_value)
                if Path(calibration_value).is_absolute()
                else profile.source_path.parent / calibration_value
            )
            if calibration_value
            else None
        )
        self.measurement_config = MeasurementConfig(
            row_window=int(capture_defaults.get("measurementRowWindow", 16)),
            maximum_profile_points=int(
                capture_defaults.get("measurementMaximumProfilePoints", 320)
            ),
            maximum_sections=int(capture_defaults.get("measurementMaximumSections", 12)),
            minimum_circle_points=int(
                capture_defaults.get("measurementMinimumCirclePoints", 48)
            ),
            maximum_circle_residual_mm=float(
                capture_defaults.get("measurementMaximumCircleResidualMm", 0.5)
            ),
        ).bounded()
        self.defect_detection_config = DefectDetectionConfig(
            enabled=_truthy(
                os.environ.get(
                    "SICK_DEFECT_DETECTION_ENABLED",
                    capture_defaults.get("defectDetectionEnabled"),
                ),
                False,
            ),
            model_2d_path=_profile_relative_path(
                profile,
                os.environ.get(
                    "SICK_DEFECT_MODEL_2D",
                    capture_defaults.get("defectModel2dPath", ""),
                ),
            ),
            model_3d_path=_profile_relative_path(
                profile,
                os.environ.get(
                    "SICK_DEFECT_MODEL_3D",
                    capture_defaults.get("defectModel3dPath", ""),
                ),
            ),
            classifier_2d_path=_profile_relative_path(
                profile,
                os.environ.get(
                    "SICK_DEFECT_CLASSIFIER_2D",
                    capture_defaults.get("defectClassifier2dPath", ""),
                ),
            ),
            classifier_3d_path=_profile_relative_path(
                profile,
                os.environ.get(
                    "SICK_DEFECT_CLASSIFIER_3D",
                    capture_defaults.get("defectClassifier3dPath", ""),
                ),
            ),
            model_manifest_path=_profile_relative_path(
                profile,
                capture_defaults.get("defectModelManifestPath", ""),
            ),
            image_size=int(capture_defaults.get("defectImageSize", 640)),
            confidence_threshold=float(
                capture_defaults.get("defectConfidenceThreshold", 0.25)
            ),
            iou_threshold=float(capture_defaults.get("defectIouThreshold", 0.25)),
            merge_iou_threshold=float(
                capture_defaults.get("defectMergeIouThreshold", 0.20)
            ),
            maximum_detections_per_frame=int(
                capture_defaults.get("defectMaximumPerFrame", 100)
            ),
            classification_confidence_threshold=float(
                capture_defaults.get(
                    "defectClassificationConfidenceThreshold", 0.55
                )
            ),
            frame_stride=int(capture_defaults.get("defectFrameStride", 1)),
            cpu_frame_stride=int(capture_defaults.get("defectCpuFrameStride", 8)),
            gpu_device_id=int(
                os.environ.get(
                    "SICK_DEFECT_GPU_DEVICE",
                    capture_defaults.get("defectGpuDevice", 1),
                )
            ),
            depth_exposure=float(capture_defaults.get("defectDepthExposure", 300.0)),
            capture_origin=os.environ.get(
                "SICK_CAPTURE_ORIGIN", "http://127.0.0.1:4317"
            ),
            maximum_idle_wait_seconds=float(
                capture_defaults.get("defectMaximumIdleWaitSeconds", 300.0)
            ),
            maximum_pending_storage_rounds=int(
                capture_defaults.get("defectMaximumPendingStorageRounds", 0)
            ),
        ).bounded()
        self.storage_process_threads = max(
            0,
            min(profile.expected_cameras, configured_storage_process_workers),
        )
        self.storage_process_workers = 1 if self.storage_process_threads else 0
        if self.storage_process_workers:
            self.storage_writer_pool = ProcessPoolExecutor(
                max_workers=1,
                initializer=_initialize_storage_process_writer,
                initargs=(
                    profile.jpeg_quality,
                    profile.fsync,
                    artifact_context,
                    self.storage_process_threads,
                ),
            )
        else:
            self.storage_writer_pool = ThreadPoolExecutor(
                max_workers=max(1, profile.expected_cameras),
                thread_name_prefix="sick-storage-camera",
            )
        self.storage_shared_buffers: dict[
            str,
            tuple[
                shared_memory.SharedMemory,
                shared_memory.SharedMemory,
                tuple[int, ...],
                str,
                str,
            ],
        ] = {}
        self.storage_round_pool = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="sick-storage-round",
        )
        # Preview conversion must never occupy a camera fetch worker.  A
        # bounded latest-frame pool lets the UI drop stale previews while the
        # acquisition path continues consuming every GenTL frame.
        self.preview_worker_threads = max(
            1,
            min(2, int(capture_defaults.get("previewWorkerThreads", 1))),
        )
        self.preview_pool = ThreadPoolExecutor(
            max_workers=self.preview_worker_threads,
            thread_name_prefix="sick-preview",
        )
        self.preview_work_lock = threading.Lock()
        self.preview_pending_cameras: set[str] = set()
        self.preview_scheduled_at: dict[str, float] = {}
        self.storage_queue_capacity_rounds = max(
            1,
            min(
                128,
                int(
                    os.environ.get(
                        "SICK_STORAGE_WRITE_CACHE_ROUNDS",
                        capture_defaults.get("storageWriteCacheRounds", 8),
                    )
                ),
            ),
        )
        self.storage_queue_boundary_reserve_rounds = min(
            self.storage_queue_capacity_rounds,
            self.steel_pre_roll_frames
            + self.steel_entry_rounds
            + self.steel_post_roll_frames,
        )
        self.storage_queue_lock = threading.RLock()
        self.storage_queue_space = threading.Condition(self.storage_queue_lock)
        self.storage_queue_accepting = True
        self.storage_queue_pending_rounds = 0
        self.storage_queue_pending_by_material: dict[str, int] = {}
        self.storage_queue_active_rounds = 0
        self.storage_queue_completed_rounds = 0
        self.storage_queue_dropped_rounds = 0
        self.storage_queue_dropped_frames = 0
        self.storage_queue_failed_rounds = 0
        self.storage_queue_high_water_rounds = 0
        self.storage_queue_backpressure_waits = 0
        self.storage_queue_backpressure_seconds = 0.0
        self.storage_write_samples: deque[tuple[float, int, float]] = deque(maxlen=120)
        self.storage_camera_write_ms: dict[str, deque[float]] = {
            camera.key: deque(maxlen=120) for camera in profile.enabled_cameras
        }
        self.state_lock = threading.RLock()
        self.acquisition_stop = threading.Event()
        self.acquisition_thread: threading.Thread | None = None
        self.continuous_round = 0
        self.continuous_acquisition_frame_count = 0
        self.continuous_discarded_frame_count = 0
        self.black_frame_count = 0
        self.continuous_stats: dict[str, dict[str, Any]] = {
            camera.key: {
                "frameCount": 0,
                "finalizedCount": 0,
                "successfulFrameCount": 0,
                "lastResultCode": None,
                "lastFrameAt": None,
                "ticks": deque(maxlen=20),
            }
            for camera in profile.enabled_cameras
        }
        self.synchronization_window: deque[dict[str, Any]] = deque(maxlen=120)
        self.synchronization_warmup_rounds = max(
            0,
            int(
                capture_defaults.get(
                    "synchronizationWarmupRounds",
                    profile.expected_cameras,
                )
            ),
        )
        self.synchronization_warmup_remaining = self.synchronization_warmup_rounds
        self.startup_capture_retries = max(
            0,
            min(3, int(capture_defaults.get("startupCaptureRetries", 1))),
        )
        self.last_transport_frame_ids: dict[str, int] = {}
        self.transport_frame_gap_counts: dict[str, int] = {
            camera.key: 0 for camera in profile.enabled_cameras
        }
        self.stream_lock = threading.RLock()
        self.stream_camera_key = ""
        self.stream_options: dict[str, Any] = {}
        self.stream_started_at = ""
        self.stream_frame_count = 0
        self.stream_last_frame_at = ""
        self.stream_frame_ticks: deque[float] = deque(maxlen=20)
        self.stream_frame_counts: dict[str, int] = {}
        self.stream_last_frame_at_by_camera: dict[str, str] = {}
        self.stream_frame_ticks_by_camera: dict[str, deque[float]] = {}
        self.stream_dimensions: dict[str, tuple[int, int]] = {}
        self.stream_latest: dict[str, dict[str, bytes]] = {}
        self.stream_requested_kinds: dict[str, dict[str, float]] = {}
        self.preview_seed_lock = threading.Lock()
        self.history_lock = threading.RLock()
        self.history_cache: list[dict[str, Any]] = []
        self.history_cache_at = 0.0
        self.history_cache_limit = 0
        self.history_cache_material_id = ""
        self.history_cache_has_more = False
        self.indexed_history_cache: OrderedDict[
            tuple[int, str, int], dict[str, Any]
        ] = OrderedDict()
        self.history_refresh_pool = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="sick-history-index",
        )
        self.history_refresh_future: Future[tuple[list[dict[str, Any]], bool]] | None = None
        self.alignment_pool = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="sick-flow-alignment",
        )
        # CPU- and I/O-heavy reconstruction must not share the interpreter GIL
        # with the real-time GenTL acquisition loop. Recycle the low-priority
        # child after every flow so decoded image arrays cannot accumulate.
        self.alignment_compute_pool = ProcessPoolExecutor(
            max_workers=1,
            max_tasks_per_child=1,
            initializer=_initialize_flow_analysis_process,
        )
        # Learned inference has its own recycled, below-normal-priority
        # process.  A slow model can therefore never delay alignment,
        # measurement or publication of the playback index.
        self.defect_detection_compute_pool = ProcessPoolExecutor(
            max_workers=1,
            max_tasks_per_child=1,
            initializer=_initialize_flow_analysis_process,
        )
        self.alignment_lock = threading.RLock()
        self.alignment_futures: dict[str, Future[Any]] = {}
        self.defect_detection_futures: dict[str, Future[Any]] = {}
        self.alignment_status: dict[str, Any] = {
            "state": "idle",
            "materialId": "",
            "path": "",
            "quality": None,
            "error": "",
            "updatedAt": _utc_text(),
        }
        self.measurement_status: dict[str, Any] = {
            "state": "idle",
            "materialId": "",
            "path": "",
            "metricValid": False,
            "qualityGate": None,
            "error": "",
            "updatedAt": _utc_text(),
        }
        self.defect_detection_status: dict[str, Any] = {
            "state": "idle" if self.defect_detection_config.enabled else "disabled",
            "materialId": "",
            "path": "",
            "defectCount": 0,
            "temporaryModel": True,
            "gpuAcceleration": False,
            "error": "",
            "updatedAt": _utc_text(),
        }
        self.playback_image_cache: OrderedDict[
            tuple[str, int, int, str], tuple[str, bytes]
        ] = OrderedDict()
        self.playback_cache_root = self.profile.storage_root / "cache"
        self.playback_cache_build_locks = [threading.Lock() for _ in range(16)]
        self.playback_cache_memory_hits = 0
        self.playback_cache_disk_hits = 0
        self.playback_cache_builds = 0
        self.playback_cache_build_failures = 0
        self.playback_cache_build_ms: deque[float] = deque(maxlen=120)
        self.playback_compute_pool = ProcessPoolExecutor(
            max_workers=2,
            max_tasks_per_child=32,
            initializer=_initialize_flow_analysis_process,
        )
        self.playback_warm_stop = threading.Event()
        self.playback_warm_pool = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="sick-playback-warm",
        )
        self.playback_warm_compute_pool = ProcessPoolExecutor(
            max_workers=1,
            max_tasks_per_child=128,
            initializer=_initialize_flow_analysis_process,
        )
        self.playback_warm_futures: dict[str, Future[Any]] = {}
        self.playback_warm_status: dict[str, Any] = {
            "state": "idle",
            "materialId": "",
            "cachedImageCount": 0,
            "sourceImageCount": 0,
            "failureCount": 0,
            "updatedAt": _utc_text(),
        }
        self.events: deque[dict[str, Any]] = deque(maxlen=200)
        self.frames_received = 0
        self.frames_committed = 0
        self.frames_failed = 0
        self.database_commit_batches = 0
        self.database_commit_failures = 0
        self.database_commit_retries = 0
        self.database_commit_last_success_at = ""
        self.database_commit_last_error = ""
        self.database_commit_capacity_rounds = 128
        self.database_commit_max_batch_rounds = 16
        self.database_commit_coalesce_seconds = 0.2
        self.database_commit_queue: deque[
            tuple[str, str, list[dict[str, Any]]]
        ] = deque()
        self.database_commit_condition = threading.Condition()
        self.database_commit_accepting = True
        self.database_commit_active_rounds = 0
        self.database_commit_high_water_rounds = 0
        self.database_commit_succeeded_rounds = 0
        self.database_commit_failed_rounds = 0
        self.last_error = ""
        self.started_at = time.time()
        self.database_commit_thread = threading.Thread(
            target=self._database_commit_loop,
            name="sick-database-commit",
            daemon=True,
        )
        self.database_commit_thread.start()
        for root in {profile.storage_root, *(camera.storage_root for camera in profile.enabled_cameras)}:
            root.mkdir(parents=True, exist_ok=True)
        try:
            self.backend.start()
        except Exception as error:
            self.last_error = str(error)
            self._log("error", "SICK GenTL initialization failed", error=str(error))
        if profile.auto_connect and not self.last_error:
            self.connect_all()
        if self.capture_mode == "continuous" and self.sessions:
            self._ensure_acquisition_worker()

    def _log(self, level: str, message: str, **fields: Any) -> None:
        with self.state_lock:
            self.events.appendleft(
                {
                    "time": _utc_text(),
                    "level": level,
                    "message": message,
                    **fields,
                }
            )

    def _count_frames(self, *, received: int = 0, committed: int = 0, failed: int = 0) -> None:
        with self.state_lock:
            self.frames_received += received
            self.frames_committed += committed
            self.frames_failed += failed

    @staticmethod
    def _rolling_fps(ticks: deque[float]) -> float | None:
        if len(ticks) < 2:
            return None
        elapsed = ticks[-1] - ticks[0]
        return round((len(ticks) - 1) / elapsed, 3) if elapsed > 0 else None

    def _acquisition_running(self) -> bool:
        thread = self.acquisition_thread
        return bool(thread is not None and thread.is_alive())

    def camera_for_identity(self, value: str) -> CameraProfile | None:
        needle = value.strip().lower()
        for camera in self.profile.enabled_cameras:
            if needle in {
                camera.camera_id.lower(),
                camera.key.lower(),
                camera.serial_number.lower(),
                camera.ip.lower(),
            }:
                return camera
        return None

    def connect_all(self) -> dict[str, Any]:
        results = []
        with self.state_lock:
            for camera in self.profile.enabled_cameras:
                if camera.key in self.sessions:
                    results.append(self._camera_row(camera))
                    continue
                session = None
                try:
                    session = self.backend.connect(camera)
                    session.start()
                    self.sessions[camera.key] = session
                    self.session_errors.pop(camera.key, None)
                    self._log(
                        "info",
                        "SICK camera connected",
                        cameraKey=camera.key,
                        serialNumber=camera.serial_number,
                    )
                except Exception as error:
                    if session is not None:
                        try:
                            session.close()
                        except Exception:
                            pass
                    self.session_errors[camera.key] = str(error)
                    self.last_error = str(error)
                    self._log(
                        "error",
                        "SICK camera connection failed",
                        cameraKey=camera.key,
                        serialNumber=camera.serial_number,
                        error=str(error),
                    )
                results.append(self._camera_row(camera))
        connected = len(self.sessions)
        return {
            "code": 0 if connected == self.profile.expected_cameras else 49110,
            "expectedCameras": self.profile.expected_cameras,
            "connectedCameras": connected,
            "cameras": results,
        }

    def disconnect(self, identity: str = "", *, force: bool = False) -> dict[str, Any]:
        if self.capture_lock.locked() and not force:
            return {
                "code": 409,
                "error": "capture_in_progress",
                "connectedCameras": len(self.sessions),
            }
        with self.state_lock:
            cameras = (
                [self.camera_for_identity(identity)]
                if identity
                else list(self.profile.enabled_cameras)
            )
            for camera in cameras:
                if camera is None:
                    continue
                session = self.sessions.pop(camera.key, None)
                if session is not None:
                    try:
                        session.close()
                    except Exception as error:
                        self._log(
                            "warning", "SICK camera close failed", cameraKey=camera.key, error=str(error)
                        )
            return {
                "code": 0,
                "connectedCameras": len(self.sessions),
                "cameras": [self._camera_row(camera) for camera in self.profile.enabled_cameras],
            }

    def close(self) -> None:
        self.acquisition_stop.set()
        self.playback_warm_stop.set()
        thread = self.acquisition_thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=max(2.0, self.profile.timeout_ms / 1000.0 + 1.0))
        with self.storage_queue_space:
            self.storage_queue_accepting = False
            self.storage_queue_space.notify_all()
        self.capture_pool.shutdown(wait=True, cancel_futures=True)
        self.preview_pool.shutdown(wait=True, cancel_futures=True)
        self.storage_round_pool.shutdown(wait=True, cancel_futures=False)
        self.storage_writer_pool.shutdown(wait=True, cancel_futures=False)
        for depth_memory, intensity_memory, *_ in self.storage_shared_buffers.values():
            for memory in (depth_memory, intensity_memory):
                memory.close()
                try:
                    memory.unlink()
                except FileNotFoundError:
                    pass
        self.storage_shared_buffers.clear()
        with self.database_commit_condition:
            self.database_commit_accepting = False
            self.database_commit_condition.notify_all()
        self.database_commit_thread.join(timeout=60.0)
        with self.stream_lock:
            self.stream_camera_key = ""
            self.stream_latest.clear()
            self.stream_frame_counts.clear()
            self.stream_last_frame_at_by_camera.clear()
            self.stream_frame_ticks_by_camera.clear()
            self.stream_dimensions.clear()
        with self.history_lock:
            self.playback_image_cache.clear()
            self.indexed_history_cache.clear()
        self.history_refresh_pool.shutdown(wait=True, cancel_futures=True)
        self.playback_warm_pool.shutdown(wait=True, cancel_futures=True)
        self.playback_warm_compute_pool.shutdown(wait=True, cancel_futures=False)
        self.playback_compute_pool.shutdown(wait=True, cancel_futures=False)
        self.alignment_pool.shutdown(wait=True, cancel_futures=False)
        self.alignment_compute_pool.shutdown(wait=True, cancel_futures=False)
        self.defect_detection_compute_pool.shutdown(wait=False, cancel_futures=True)
        self.disconnect(force=True)
        self.backend.close()

    def _post_service_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request = urlrequest.Request(
            f"{self.service_origin}{path}",
            method="POST",
            data=body,
            headers={"Content-Type": "application/json", "Connection": "close"},
        )
        try:
            with urlrequest.urlopen(request, timeout=2.0) as response:
                result = json.loads(response.read())
        except (OSError, ValueError, urlerror.URLError) as error:
            raise RuntimeError(f"inspection service callback failed: {error}") from error
        if not isinstance(result, dict):
            raise RuntimeError("inspection service callback returned a non-object response")
        return result

    def _commit_capture_results(
        self,
        material_id: str,
        session_id: str,
        results: list[dict[str, Any]],
    ) -> bool:
        committed = [
            {key: value for key, value in row.items() if not key.startswith("_")}
            for row in results
            if int(row.get("code", SICK_CAPTURE_FAILED)) == 0
            and bool(row.get("completeFrame"))
            and not bool(row.get("discarded"))
        ]
        if not committed or not session_id:
            return True
        payload = {
            "schema": "steel.capture.commit.v1",
            "materialId": material_id,
            "sessionId": session_id,
            "inspectionId": f"INSP-{session_id}",
            "results": committed,
        }
        last_error: Exception | None = None
        for attempt in range(1, 4):
            try:
                response = self._post_service_json(
                    "/internal/v1/capture-commit",
                    payload,
                )
                if int(response.get("code", 500)) != 0:
                    raise RuntimeError(
                        str(response.get("error", "capture commit rejected"))
                    )
                with self.state_lock:
                    # Database writes are asynchronous and can finish after the
                    # next steel-in transition. Never let a delayed commit for
                    # the previous material overwrite the new active flow.
                    if (
                        not self.active_session_id
                        or self.active_session_id == session_id
                    ):
                        self.active_flow_no = (
                            int(response.get("flowNo", 0) or 0) or self.active_flow_no
                        )
                        self.active_flow_code = str(
                            response.get("flowCode", self.active_flow_code)
                        )
                    self.database_commit_batches += 1
                    self.database_commit_last_success_at = _utc_text()
                    self.database_commit_last_error = ""
                    if self.last_error.startswith("inspection service callback failed"):
                        self.last_error = ""
                return True
            except Exception as error:
                last_error = error
                if attempt < 3:
                    with self.state_lock:
                        self.database_commit_retries += 1
                    time.sleep(0.25 * attempt)
        message = str(last_error or "capture database commit failed")
        with self.state_lock:
            self.database_commit_last_error = message
            self.last_error = message
        self._log(
            "warning",
            "capture database commit deferred",
            attempts=3,
            error=message,
        )
        return False

    def _enqueue_database_commit(
        self,
        material_id: str,
        session_id: str,
        results: list[dict[str, Any]],
    ) -> bool:
        if not results or not material_id or not session_id:
            return False
        item = (material_id, session_id, results)
        with self.database_commit_condition:
            while (
                len(self.database_commit_queue) >= self.database_commit_capacity_rounds
                and self.database_commit_accepting
            ):
                self.database_commit_condition.wait(timeout=0.25)
            if not self.database_commit_accepting:
                return False
            self.database_commit_queue.append(item)
            self.database_commit_high_water_rounds = max(
                self.database_commit_high_water_rounds,
                len(self.database_commit_queue),
            )
            self.database_commit_condition.notify_all()
        return True

    def _alignment_worker(
        self, material_id: str
    ) -> tuple[Path, dict[str, Any], Path, dict[str, Any]]:
        # steel-out is observed before the capture loop enqueues its final
        # post-roll round.  Require a short quiet period after the bounded
        # storage queue drains so the manifest never races that last write.
        deadline = time.monotonic() + 120.0
        quiet_since: float | None = None
        while time.monotonic() < deadline:
            with self.storage_queue_lock:
                # Back-to-back bars may keep the global queue permanently
                # non-empty.  Only this flow's writes must settle before its
                # immutable alignment/measurement manifests are generated.
                idle = self.storage_queue_pending_by_material.get(material_id, 0) == 0
            if idle:
                quiet_since = quiet_since or time.monotonic()
                if time.monotonic() - quiet_since >= 0.75:
                    break
            else:
                quiet_since = None
            time.sleep(0.1)
        else:
            raise TimeoutError(
                f"storage queue did not settle before alignment: {material_id}"
            )
        with self.alignment_lock:
            if self.alignment_status.get("materialId") == material_id:
                self.alignment_status = {
                    **self.alignment_status,
                    "state": "building",
                    "updatedAt": _utc_text(),
                }
        camera_roots = {
            camera.camera_id: camera.storage_root
            for camera in self.profile.enabled_cameras
        }
        with self.alignment_lock:
            self.measurement_status = {
                "state": "building",
                "materialId": material_id,
                "path": str(
                    measurement_manifest_path(self.profile.storage_root, material_id)
                ),
                "metricValid": False,
                "qualityGate": None,
                "error": "",
                "updatedAt": _utc_text(),
            }
        alignment_path, alignment, measurement_path, measurement = (
            self.alignment_compute_pool.submit(
                _build_flow_artifacts,
                camera_roots,
                self.profile.storage_root,
                material_id,
                self.alignment_config,
                self.array_calibration_path,
                self.measurement_config,
            ).result()
        )
        return alignment_path, alignment, measurement_path, measurement

    def _set_playback_warm_status(self, **values: Any) -> None:
        with self.history_lock:
            self.playback_warm_status = {
                **self.playback_warm_status,
                **values,
                "updatedAt": _utc_text(),
            }

    def _playback_warm_worker(self, material_id: str) -> dict[str, Any]:
        started = time.perf_counter()
        index_path = playback_index_path(self.profile.storage_root, material_id)
        index = json.loads(index_path.read_text(encoding="utf-8-sig"))
        camera_roots = {
            camera.camera_id: camera.storage_root
            for camera in self.profile.enabled_cameras
        }
        sources: list[Path] = []
        for frame in index.get("frames", []):
            for camera in frame.get("cameras", []):
                camera_id = str(camera.get("cameraId", ""))
                parts = Path(str(camera.get("artifactRef", ""))).parts
                root = camera_roots.get(camera_id)
                if root is not None and len(parts) >= 2:
                    sources.append(root.joinpath(*parts[1:]))

        cached = 0
        failures: list[dict[str, str]] = []
        idle_since: float | None = None
        state = "waiting-for-idle"
        self._set_playback_warm_status(
            state=state,
            materialId=material_id,
            cachedImageCount=0,
            sourceImageCount=len(sources),
            failureCount=0,
        )
        for source in sources:
            while not self.playback_warm_stop.is_set():
                with self.state_lock:
                    steel_present = self.steel_present
                with self.storage_queue_lock:
                    storage_idle = (
                        self.storage_queue_pending_rounds == 0
                        and self.storage_queue_active_rounds == 0
                    )
                if not steel_present and storage_idle:
                    idle_since = idle_since or time.monotonic()
                    if time.monotonic() - idle_since >= 0.75:
                        break
                else:
                    idle_since = None
                if state != "paused-for-acquisition":
                    state = "paused-for-acquisition"
                    self._set_playback_warm_status(state=state)
                self.playback_warm_stop.wait(0.2)
            if self.playback_warm_stop.is_set():
                self._set_playback_warm_status(state="stopped")
                return {"state": "stopped", "materialId": material_id}
            if state != "building":
                state = "building"
                self._set_playback_warm_status(state=state)
            try:
                if source.is_file() and not source.is_symlink():
                    self.playback_warm_compute_pool.submit(
                        build_image_pyramid,
                        source,
                        self.playback_cache_root,
                    ).result()
                    cached += 1
            except Exception as error:
                failures.append({"source": str(source), "error": str(error)})
            self._set_playback_warm_status(
                cachedImageCount=cached,
                failureCount=len(failures),
            )

        result = {
            "schema": "steel.capture-flow-pyramid-cache.v1",
            "generatedAt": _utc_text(),
            "materialId": material_id,
            "frameCount": int(index.get("frameCount", 0)),
            "sourceImageCount": len(sources),
            "cachedImageCount": cached,
            "failureCount": len(failures),
            "failures": failures[:20],
            "elapsedMs": round((time.perf_counter() - started) * 1000.0, 3),
            "throttledForAcquisition": True,
        }
        write_flow_pyramid_cache_status(self.profile.storage_root, result)
        self._set_playback_warm_status(state="ready", **result)
        return result

    def _schedule_playback_warm(self, material_id: str) -> bool:
        status_path = flow_pyramid_cache_status_path(
            self.profile.storage_root, material_id
        )
        if status_path.is_file():
            try:
                status = json.loads(status_path.read_text(encoding="utf-8-sig"))
                if (
                    int(status.get("failureCount", 0)) == 0
                    and int(status.get("cachedImageCount", 0))
                    >= int(status.get("sourceImageCount", 1))
                ):
                    return False
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                pass
        with self.history_lock:
            existing = self.playback_warm_futures.get(material_id)
            if existing is not None and not existing.done():
                return False
            future = self.playback_warm_pool.submit(
                self._playback_warm_worker, material_id
            )
            self.playback_warm_futures[material_id] = future
        return True

    def _schedule_flow_defect_detection(
        self, material_id: str, alignment: dict[str, Any]
    ) -> bool:
        normalized = material_id.strip()
        if not normalized or _safe_segment(normalized) != normalized:
            return False
        if not self.defect_detection_config.enabled:
            with self.alignment_lock:
                self.defect_detection_status = {
                    **self.defect_detection_status,
                    "state": "disabled",
                    "materialId": normalized,
                    "updatedAt": _utc_text(),
                }
            return False
        with self.alignment_lock:
            existing = self.defect_detection_futures.get(normalized)
            if existing is not None and not existing.done():
                return False
            self.defect_detection_status = {
                "state": "waiting-for-capture-idle",
                "materialId": normalized,
                "path": str(
                    defect_detection_manifest_path(
                        self.profile.storage_root, normalized
                    )
                ),
                "defectCount": 0,
                "temporaryModel": True,
                "gpuAcceleration": False,
                "error": "",
                "updatedAt": _utc_text(),
            }
            camera_roots = {
                camera.camera_id: camera.storage_root
                for camera in self.profile.enabled_cameras
            }
            future = self.defect_detection_compute_pool.submit(
                _build_flow_defect_artifact,
                camera_roots,
                self.profile.storage_root,
                normalized,
                alignment,
                self.defect_detection_config,
            )
            self.defect_detection_futures[normalized] = future

        def completed(done: Future[Any]) -> None:
            try:
                defect_path, defects = done.result()
                quality = defects.get("quality", {})
                with self.alignment_lock:
                    if self.defect_detection_status.get("materialId") == normalized:
                        self.defect_detection_status = {
                            "state": defects.get("state", "complete"),
                            "materialId": normalized,
                            "path": str(defect_path),
                            "defectCount": int(
                                defects.get("statistics", {}).get("defectCount", 0)
                            ),
                            "temporaryModel": True,
                            "gpuAcceleration": bool(
                                quality.get("gpuAcceleration", False)
                            ),
                            "error": str(defects.get("error", "")),
                            "updatedAt": _utc_text(),
                        }
                self._log(
                    "info",
                    "flow defect detection completed",
                    materialId=normalized,
                    path=str(defect_path),
                    state=defects.get("state"),
                    defectCount=int(
                        defects.get("statistics", {}).get("defectCount", 0)
                    ),
                )
            except Exception as error:
                with self.alignment_lock:
                    if self.defect_detection_status.get("materialId") == normalized:
                        self.defect_detection_status = {
                            **self.defect_detection_status,
                            "state": "failed",
                            "error": str(error),
                            "updatedAt": _utc_text(),
                        }
                self._log(
                    "warning",
                    "flow defect detection failed",
                    materialId=normalized,
                    error=str(error),
                )

        future.add_done_callback(completed)
        return True

    def _schedule_defect_rebuild(self, material_id: str) -> bool:
        normalized = material_id.strip()
        if not normalized or _safe_segment(normalized) != normalized:
            return False
        path = alignment_manifest_path(self.profile.storage_root, normalized)
        if path.is_file():
            try:
                alignment = json.loads(path.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError, json.JSONDecodeError):
                return False
            return self._schedule_flow_defect_detection(normalized, alignment)
        return self._schedule_flow_alignment(normalized)

    def _schedule_flow_alignment(self, material_id: str) -> bool:
        normalized = material_id.strip()
        if not normalized or _safe_segment(normalized) != normalized:
            return False
        with self.alignment_lock:
            existing = self.alignment_futures.get(normalized)
            if existing is not None and not existing.done():
                return False
            self.alignment_status = {
                "state": "waiting-for-storage",
                "materialId": normalized,
                "path": str(alignment_manifest_path(self.profile.storage_root, normalized)),
                "quality": None,
                "error": "",
                "updatedAt": _utc_text(),
            }
            self.measurement_status = {
                "state": "waiting-for-alignment",
                "materialId": normalized,
                "path": str(
                    measurement_manifest_path(self.profile.storage_root, normalized)
                ),
                "metricValid": False,
                "qualityGate": None,
                "error": "",
                "updatedAt": _utc_text(),
            }
            self.defect_detection_status = {
                "state": (
                    "waiting-for-alignment"
                    if self.defect_detection_config.enabled
                    else "disabled"
                ),
                "materialId": normalized,
                "path": str(
                    defect_detection_manifest_path(
                        self.profile.storage_root, normalized
                    )
                ),
                "defectCount": 0,
                "temporaryModel": True,
                "gpuAcceleration": False,
                "error": "",
                "updatedAt": _utc_text(),
            }
            future = self.alignment_pool.submit(self._alignment_worker, normalized)
            self.alignment_futures[normalized] = future

        def completed(done: Future[Any]) -> None:
            try:
                path, manifest, measurement_path, measurement = done.result()
                quality = manifest.get("quality")
                with self.alignment_lock:
                    self.alignment_status = {
                        "state": "ready",
                        "materialId": normalized,
                        "path": str(path),
                        "quality": quality,
                        "error": "",
                        "updatedAt": _utc_text(),
                    }
                    self.measurement_status = {
                        "state": "ready",
                        "materialId": normalized,
                        "path": str(measurement_path),
                        "metricValid": bool(measurement.get("metricValid")),
                        "qualityGate": measurement.get("qualityGate"),
                        "error": "",
                        "updatedAt": _utc_text(),
                    }
                self._log(
                    "info",
                    "flow soft alignment completed",
                    materialId=normalized,
                    path=str(path),
                    synchronized=bool(
                        isinstance(quality, dict) and quality.get("synchronized")
                    ),
                )
                self._schedule_playback_warm(normalized)
                self._schedule_flow_defect_detection(normalized, manifest)
            except Exception as error:
                with self.alignment_lock:
                    self.alignment_status = {
                        "state": "failed",
                        "materialId": normalized,
                        "path": str(
                            alignment_manifest_path(self.profile.storage_root, normalized)
                        ),
                        "quality": None,
                        "error": str(error),
                        "updatedAt": _utc_text(),
                    }
                    self.measurement_status = {
                        "state": "failed",
                        "materialId": normalized,
                        "path": str(
                            measurement_manifest_path(self.profile.storage_root, normalized)
                        ),
                        "metricValid": False,
                        "qualityGate": None,
                        "error": str(error),
                        "updatedAt": _utc_text(),
                    }
                    self.defect_detection_status = {
                        "state": "failed",
                        "materialId": normalized,
                        "path": str(
                            defect_detection_manifest_path(
                                self.profile.storage_root, normalized
                            )
                        ),
                        "defectCount": 0,
                        "temporaryModel": True,
                        "gpuAcceleration": False,
                        "error": str(error),
                        "updatedAt": _utc_text(),
                    }
                self._log(
                    "warning",
                    "flow soft alignment failed",
                    materialId=normalized,
                    error=str(error),
                )

        future.add_done_callback(completed)
        return True

    def alignment_json(self, material_id: str = "") -> tuple[int, dict[str, Any]]:
        normalized = material_id.strip()
        if normalized and _safe_segment(normalized) != normalized:
            return 400, {"code": 400, "error": "invalid_material_id"}
        if not normalized:
            with self.alignment_lock:
                return 200, {"code": 0, **self.alignment_status}
        path = alignment_manifest_path(self.profile.storage_root, normalized)
        if not path.is_file():
            with self.alignment_lock:
                status = dict(self.alignment_status)
            if status.get("materialId") == normalized and status.get("state") in {
                "waiting-for-storage",
                "building",
            }:
                return 202, {"code": 0, **status}
            return 404, {
                "code": 404,
                "error": "alignment_not_found",
                "materialId": normalized,
            }
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as error:
            return 500, {
                "code": 500,
                "error": "alignment_invalid",
                "detail": str(error),
            }
        return 200, {"code": 0, "path": str(path), "alignment": payload}

    def measurement_json(self, material_id: str = "") -> tuple[int, dict[str, Any]]:
        normalized = material_id.strip()
        if normalized and _safe_segment(normalized) != normalized:
            return 400, {"code": 400, "error": "invalid_material_id"}
        if not normalized:
            with self.alignment_lock:
                return 200, {"code": 0, **self.measurement_status}
        path = measurement_manifest_path(self.profile.storage_root, normalized)
        if not path.is_file():
            with self.alignment_lock:
                status = dict(self.measurement_status)
            if status.get("materialId") == normalized and status.get("state") in {
                "waiting-for-alignment",
                "waiting-for-capture-idle",
                "building",
            }:
                return 202, {"code": 0, **status}
            return 404, {
                "code": 404,
                "error": "measurement_not_found",
                "materialId": normalized,
            }
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as error:
            return 500, {
                "code": 500,
                "error": "measurement_invalid",
                "detail": str(error),
            }
        return 200, {"code": 0, "path": str(path), "measurement": payload}

    def defect_detection_json(
        self, material_id: str = ""
    ) -> tuple[int, dict[str, Any]]:
        normalized = material_id.strip()
        if normalized and _safe_segment(normalized) != normalized:
            return 400, {"code": 400, "error": "invalid_material_id"}
        if not normalized:
            with self.alignment_lock:
                return 200, {"code": 0, **self.defect_detection_status}
        path = defect_detection_manifest_path(self.profile.storage_root, normalized)
        if not path.is_file():
            with self.alignment_lock:
                status = dict(self.defect_detection_status)
            if status.get("materialId") == normalized and status.get("state") in {
                "waiting-for-alignment",
                "building",
            }:
                return 202, {"code": 0, **status}
            return 404, {
                "code": 404,
                "error": "defect_detection_not_found",
                "materialId": normalized,
            }
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as error:
            return 500, {
                "code": 500,
                "error": "defect_detection_invalid",
                "detail": str(error),
            }
        return 200, {"code": 0, "path": str(path), "detection": payload}

    def _database_commit_loop(self) -> None:
        while True:
            with self.database_commit_condition:
                while (
                    not self.database_commit_queue
                    and self.database_commit_accepting
                ):
                    self.database_commit_condition.wait(timeout=0.5)
                if not self.database_commit_queue and not self.database_commit_accepting:
                    return
                material_id, session_id, first_results = self.database_commit_queue.popleft()
                batch = [(material_id, session_id, first_results)]
                coalesce_deadline = (
                    time.monotonic() + self.database_commit_coalesce_seconds
                )
                while len(batch) < self.database_commit_max_batch_rounds:
                    while (
                        not self.database_commit_queue
                        and self.database_commit_accepting
                        and time.monotonic() < coalesce_deadline
                    ):
                        self.database_commit_condition.wait(
                            timeout=max(0.0, coalesce_deadline - time.monotonic())
                        )
                    if not self.database_commit_queue:
                        break
                    next_material, next_session, next_results = self.database_commit_queue[0]
                    if next_material != material_id or next_session != session_id:
                        break
                    batch.append(self.database_commit_queue.popleft())
                self.database_commit_active_rounds += len(batch)
                self.database_commit_condition.notify_all()

            combined = [row for _, _, rows in batch for row in rows]
            succeeded = self._commit_capture_results(material_id, session_id, combined)
            with self.database_commit_condition:
                self.database_commit_active_rounds = max(
                    0,
                    self.database_commit_active_rounds - len(batch),
                )
                if succeeded:
                    self.database_commit_succeeded_rounds += len(batch)
                else:
                    if self.database_commit_accepting:
                        # The image artifacts are already durable.  Preserve
                        # their metadata commit at the head of the bounded
                        # queue so a brief Rust/PostgreSQL restart cannot make
                        # the database permanently diverge from disk.
                        for item in reversed(batch):
                            self.database_commit_queue.appendleft(item)
                        self.database_commit_high_water_rounds = max(
                            self.database_commit_high_water_rounds,
                            len(self.database_commit_queue),
                        )
                        self.database_commit_retries += 1
                    else:
                        self.database_commit_failures += 1
                        self.database_commit_failed_rounds += len(batch)
                self.database_commit_condition.notify_all()
            if not succeeded and self.database_commit_accepting:
                time.sleep(1.0)

    def _share_storage_frame(
        self,
        camera_key: str,
        frame: Any,
    ) -> tuple[
        tuple[str, tuple[int, ...], str],
        tuple[str, tuple[int, ...], str],
    ]:
        shape = tuple(frame.depth_raw.shape)
        depth_dtype = frame.depth_raw.dtype.str
        intensity_dtype = frame.intensity.dtype.str
        existing = self.storage_shared_buffers.get(camera_key)
        if existing is not None and (
            existing[2] != shape
            or existing[3] != depth_dtype
            or existing[4] != intensity_dtype
        ):
            for memory in existing[:2]:
                memory.close()
                try:
                    memory.unlink()
                except FileNotFoundError:
                    pass
            existing = None
        if existing is None:
            depth_memory = shared_memory.SharedMemory(
                create=True,
                size=frame.depth_raw.nbytes,
            )
            intensity_memory = shared_memory.SharedMemory(
                create=True,
                size=frame.intensity.nbytes,
            )
            existing = (
                depth_memory,
                intensity_memory,
                shape,
                depth_dtype,
                intensity_dtype,
            )
            self.storage_shared_buffers[camera_key] = existing
        depth_memory, intensity_memory, *_ = existing
        depth_target = np.ndarray(shape, dtype=frame.depth_raw.dtype, buffer=depth_memory.buf)
        intensity_target = np.ndarray(
            shape,
            dtype=frame.intensity.dtype,
            buffer=intensity_memory.buf,
        )
        np.copyto(depth_target, frame.depth_raw)
        np.copyto(intensity_target, frame.intensity)
        del depth_target, intensity_target
        return (
            (depth_memory.name, shape, depth_dtype),
            (intensity_memory.name, shape, intensity_dtype),
        )

    def _persist_cached_round(
        self,
        rows: list[dict[str, Any]],
        *,
        material_id: str,
        session_id: str,
        boundary_phase: str,
        require_steel_signal: bool = False,
        production_event_id: str | None = None,
    ) -> list[dict[str, Any]]:
        if not material_id or not session_id:
            return []

        if production_event_id is None:
            with self.state_lock:
                production_event_id = self.active_flow_code
        # Automatic grayscale capture uses the database flow code as its
        # material directory. Prefer that immutable value over mutable global
        # state, which may already refer to an adjacent steel while an async
        # storage task is running.
        if material_id.startswith("FLOW-"):
            production_event_id = material_id
        resolved_event_id = production_event_id or ""

        storage_started = time.monotonic()
        futures: list[tuple[Any, CameraProfile, Any, dict[str, Any]]] = []
        process_tasks: list[
            tuple[
                Path,
                str,
                Any,
                tuple[str, tuple[int, ...], str],
                tuple[str, tuple[int, ...], str],
                dict[str, Any],
            ]
        ] = []
        process_contexts: list[tuple[CameraProfile, Any, dict[str, Any]]] = []
        for row in rows:
            frame = row.get("_rawFrame")
            camera = self.camera_for_identity(str(row.get("cameraKey", "")))
            if frame is None or camera is None:
                continue
            if float(row.get("maxIntensity", 0.0)) <= self.profile.black_frame_threshold:
                continue
            if require_steel_signal and not bool(row.get("steelSignal")):
                continue
            options = {
                "session_id": session_id,
                "production_event_id": resolved_event_id,
                "inspection_id": f"INSP-{session_id}",
                "capture_round": int(row.get("round", 0)),
                "sync_group_id": (
                    f"{resolved_event_id or session_id}:"
                    f"round-{int(row.get('round', 0)):012d}"
                ),
                # Level 1 is the measured optimum on the target host: it
                # encodes faster than level 0 and cuts roughly 10 MiB/round.
                "intensity_compress_level": 1,
            }
            if self.storage_process_workers:
                options["index"] = self.writer.sequences.reserve(
                    camera.storage_root,
                    material_id,
                )
                depth_descriptor, intensity_descriptor = self._share_storage_frame(
                    camera.key,
                    frame,
                )
                frame_stub = replace(
                    frame,
                    depth_raw=np.empty((0, 0), dtype=np.uint16),
                    intensity=np.empty((0, 0), dtype=np.uint8),
                )
                process_tasks.append(
                    (
                        camera.storage_root,
                        material_id,
                        frame_stub,
                        depth_descriptor,
                        intensity_descriptor,
                        options,
                    )
                )
                process_contexts.append((camera, frame, row))
            else:
                future = self.storage_writer_pool.submit(
                    self.writer.write,
                    camera.storage_root,
                    material_id,
                    frame,
                    **options,
                )
                futures.append((future, camera, frame, row))

        if process_tasks:
            round_future = self.storage_writer_pool.submit(
                _write_storage_shared_round,
                process_tasks,
            )
            try:
                outcomes = round_future.result()
            except Exception as error:
                outcomes = [
                    (False, None, f"{type(error).__name__}: {error}")
                    for _ in process_tasks
                ]
            for outcome, context in zip(outcomes, process_contexts, strict=True):
                succeeded, result, message = outcome
                completed_future: Future[Any] = Future()
                if succeeded:
                    completed_future.set_result(result)
                else:
                    completed_future.set_exception(RuntimeError(message))
                camera, frame, row = context
                futures.append((completed_future, camera, frame, row))

        committed: list[dict[str, Any]] = []
        committed_bytes = 0
        for future, camera, frame, source_row in futures:
            try:
                result = future.result()
                persisted = result.provider_row(frame, int(source_row.get("round", 0)))
                persisted.update(
                    {
                        "parallelIndex": int(source_row.get("parallelIndex", 0)),
                        "frameReceived": True,
                        "discarded": False,
                        "meanIntensity": float(source_row.get("meanIntensity", 0.0)),
                        "maxIntensity": float(source_row.get("maxIntensity", 0.0)),
                        "brightPixelRatio": float(source_row.get("brightPixelRatio", 0.0)),
                        "steelSignal": bool(source_row.get("steelSignal")),
                        "capturedAt": str(source_row.get("capturedAt", _utc_text())),
                        "cameraFrameSequence": source_row.get("cameraFrameSequence"),
                        "transportFrameId": source_row.get("transportFrameId"),
                        "transportFrameGap": source_row.get("transportFrameGap", 0),
                        "deviceTimestamp": source_row.get("deviceTimestamp"),
                        "timestampFrequency": source_row.get("timestampFrequency"),
                        "hostUtcNs": source_row.get("hostUtcNs"),
                        "hostMonotonicNs": source_row.get("hostMonotonicNs"),
                        "frameTriggerMode": source_row.get("frameTriggerMode"),
                        "triggerIssuedNs": source_row.get("triggerIssuedNs"),
                        "triggerCompletedNs": source_row.get("triggerCompletedNs"),
                        "triggerCommandLatencyUs": source_row.get(
                            "triggerCommandLatencyUs"
                        ),
                        "boundaryPhase": boundary_phase,
                    }
                )
                committed.append(persisted)
                committed_bytes += result.steel_depth.stat().st_size
                committed_bytes += result.steel_intensity.stat().st_size
                committed_bytes += result.steel_metadata.stat().st_size
                with self.storage_queue_lock:
                    self.storage_camera_write_ms[camera.key].append(
                        float(result.write_elapsed_ms)
                    )
                self._count_frames(committed=1)
                with self.state_lock:
                    if bool(source_row.get("discarded")):
                        self.continuous_discarded_frame_count = max(
                            0, self.continuous_discarded_frame_count - 1
                        )
                    stats = self.continuous_stats.get(camera.key)
                    if stats is not None:
                        stats["successfulFrameCount"] += 1
            except Exception as error:
                self._count_frames(failed=1)
                self.last_error = str(error)
                self._log(
                    "error",
                    "cached boundary frame persistence failed",
                    cameraKey=camera.key,
                    boundaryPhase=boundary_phase,
                    error=str(error),
                )

        if committed:
            storage_elapsed = max(time.monotonic() - storage_started, 0.000_001)
            with self.storage_queue_lock:
                self.storage_write_samples.append(
                    (time.monotonic(), committed_bytes, storage_elapsed)
                )
            self._enqueue_database_commit(material_id, session_id, committed)
            self._log(
                "info",
                "cached boundary frames persisted",
                boundaryPhase=boundary_phase,
                frameCount=len(committed),
                materialId=material_id,
                sessionId=session_id,
            )
        return committed

    def _enqueue_storage_round(
        self,
        rows: list[dict[str, Any]],
        *,
        material_id: str,
        session_id: str,
        boundary_phase: str,
        require_steel_signal: bool = False,
        force: bool = False,
        production_event_id: str | None = None,
    ) -> bool:
        received_count = sum(bool(row.get("frameReceived")) for row in rows)
        if not received_count or not material_id or not session_id:
            return False
        with self.storage_queue_space:
            if not self.storage_queue_accepting:
                return False
            queue_limit = self.storage_queue_capacity_rounds
            if not force:
                queue_limit = max(
                    1,
                    self.storage_queue_capacity_rounds
                    - self.storage_queue_boundary_reserve_rounds,
                )
            wait_started = 0.0
            while (
                self.storage_queue_pending_rounds >= queue_limit
                and self.storage_queue_accepting
                and not self.acquisition_stop.is_set()
            ):
                if wait_started == 0.0:
                    wait_started = time.monotonic()
                    self.storage_queue_backpressure_waits += 1
                self.storage_queue_space.wait(timeout=0.25)
            if wait_started:
                self.storage_queue_backpressure_seconds += time.monotonic() - wait_started
            if not self.storage_queue_accepting or self.acquisition_stop.is_set():
                return False
            self.storage_queue_pending_rounds += 1
            self.storage_queue_pending_by_material[material_id] = (
                self.storage_queue_pending_by_material.get(material_id, 0) + 1
            )
            self.storage_queue_high_water_rounds = max(
                self.storage_queue_high_water_rounds,
                self.storage_queue_pending_rounds,
            )

        def persist() -> list[dict[str, Any]]:
            with self.storage_queue_lock:
                self.storage_queue_active_rounds += 1
            try:
                return self._persist_cached_round(
                    rows,
                    material_id=material_id,
                    session_id=session_id,
                    boundary_phase=boundary_phase,
                    require_steel_signal=require_steel_signal,
                    production_event_id=production_event_id,
                )
            finally:
                with self.storage_queue_lock:
                    self.storage_queue_active_rounds = max(
                        0, self.storage_queue_active_rounds - 1
                    )

        future = self.storage_round_pool.submit(persist)

        def completed(done: Any) -> None:
            failed = False
            try:
                done.result()
            except Exception as error:
                failed = True
                self.last_error = str(error)
                self._log(
                    "error",
                    "storage cache round failed",
                    boundaryPhase=boundary_phase,
                    error=str(error),
                )
            with self.storage_queue_space:
                self.storage_queue_pending_rounds = max(
                    0, self.storage_queue_pending_rounds - 1
                )
                material_pending = max(
                    0,
                    self.storage_queue_pending_by_material.get(material_id, 0) - 1,
                )
                if material_pending:
                    self.storage_queue_pending_by_material[material_id] = material_pending
                else:
                    self.storage_queue_pending_by_material.pop(material_id, None)
                self.storage_queue_completed_rounds += 0 if failed else 1
                self.storage_queue_failed_rounds += 1 if failed else 0
                self.storage_queue_space.notify_all()

        future.add_done_callback(completed)
        return True

    def _apply_grayscale_transition(self, event: str) -> bool:
        now = time.monotonic()
        if now - self.last_steel_transition_attempt < 1.0:
            return False
        self.last_steel_transition_attempt = now
        try:
            response = self._post_service_json(
                f"/api/production/{event}",
                {
                    "source": "grayscale",
                    "mode": "grayscale",
                    "triggerMode": "grayscale",
                    "acquisitionMode": "continuous",
                    "captureMode": "continuous",
                    "discardBlackFrames": True,
                    "storageRoot": str(self.profile.storage_root),
                },
            )
        except Exception as error:
            self.last_error = str(error)
            self._log("warning", "grayscale steel transition failed", event=event, error=str(error))
            return False
        if int(response.get("code", 500)) != 0:
            self._log(
                "warning",
                "grayscale steel transition rejected",
                event=event,
                code=response.get("code"),
                error=response.get("error"),
            )
            return False
        with self.state_lock:
            if event == "steel-in":
                self.active_flow_no = int(response.get("flowNo", 0) or 0) or None
                self.active_flow_code = str(response.get("flowCode", ""))
            else:
                self.active_flow_no = None
                self.active_flow_code = ""
        self._log(
            "info",
            "grayscale steel transition applied",
            event=event,
            flowNo=response.get("flowNo"),
            flowCode=response.get("flowCode"),
        )
        return True

    def _evaluate_grayscale_steel(self, results: list[dict[str, Any]]) -> None:
        if not self.grayscale_steel_detection:
            return
        received = [row for row in results if bool(row.get("frameReceived"))]
        if not received:
            return
        signal_cameras = sum(bool(row.get("steelSignal")) for row in received)
        required = min(self.steel_min_cameras, len(received))
        with self.state_lock:
            present = self.steel_present
            self.last_steel_signal_cameras = signal_cameras
            if present:
                self.steel_entry_streak = 0
                self.steel_exit_streak = self.steel_exit_streak + 1 if signal_cameras == 0 else 0
                transition = self.steel_exit_streak >= self.steel_exit_rounds
                event = "steel-out"
            else:
                self.steel_exit_streak = 0
                self.steel_entry_streak = (
                    self.steel_entry_streak + 1 if signal_cameras >= required else 0
                )
                transition = self.steel_entry_streak >= self.steel_entry_rounds
                event = "steel-in"
        if transition and self._apply_grayscale_transition(event):
            with self.state_lock:
                self.steel_entry_streak = 0
                self.steel_exit_streak = 0

    def _camera_row(self, camera: CameraProfile) -> dict[str, Any]:
        session = self.sessions.get(camera.key)
        identity = getattr(session, "identity", {}) if session else {}
        with self.state_lock:
            stats_source = self.continuous_stats[camera.key]
            stats = {
                **stats_source,
                "ticks": tuple(stats_source["ticks"]),
            }
            frame_counts = [
                int(item["frameCount"]) for item in self.continuous_stats.values()
            ]
            recent_transport_gap_count = sum(
                int(row.get("transportFrameGaps", {}).get(camera.key, 0))
                for row in self.synchronization_window
            )
            synchronization_window_rounds = len(self.synchronization_window)
            lifetime_transport_gap_count = int(
                self.transport_frame_gap_counts.get(camera.key, 0)
            )
            last_transport_frame_id = self.last_transport_frame_ids.get(camera.key)
        telemetry: dict[str, Any] = {}
        telemetry_reader = getattr(session, "telemetry_snapshot", None)
        if callable(telemetry_reader):
            try:
                telemetry = telemetry_reader()
            except Exception:
                telemetry = {}
        trigger_status: dict[str, Any] = {
            "configuredMode": self.frame_trigger_mode,
            "active": self.frame_trigger_mode == "software",
            "softwareTriggerCapable": False,
        }
        trigger_reader = getattr(session, "trigger_status", None)
        if callable(trigger_reader):
            try:
                trigger_status = trigger_reader()
            except Exception:
                pass
        camera_config = getattr(session, "camera_config", {}) if session else {}
        device_temperature = telemetry.get(
            "deviceTemperature", camera_config.get("DeviceTemperature")
        )
        device_temperature_min = telemetry.get(
            "deviceTemperatureMin", camera_config.get("DeviceTemperatureMin")
        )
        device_temperature_max = telemetry.get(
            "deviceTemperatureMax", camera_config.get("DeviceTemperatureMax")
        )
        telemetry_updated_at_ns = int(telemetry.get("updatedAtNs", 0) or 0)
        telemetry_updated_at = (
            dt.datetime.fromtimestamp(
                telemetry_updated_at_ns / 1_000_000_000,
                tz=dt.timezone.utc,
            ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            if telemetry_updated_at_ns > 0
            else None
        )
        with self.stream_lock:
            stream_running = bool(
                self.stream_camera_key
                and self._acquisition_running()
                and (
                    self.capture_mode == "continuous"
                    or self.stream_camera_key == camera.key
                )
            )
            stream_frames = self.stream_frame_counts.get(camera.key, 0) if stream_running else 0
            stream_fps = self._rolling_fps(
                self.stream_frame_ticks_by_camera.get(camera.key, deque())
            ) if stream_running else None
            stream_last_frame_at = self.stream_last_frame_at_by_camera.get(camera.key) if stream_running else None
        continuous_running = (
            self.capture_mode == "continuous"
            and self._acquisition_running()
            and session is not None
        )
        minimum_frame_count = min(frame_counts, default=0)
        continuous_fps = self._rolling_fps(stats["ticks"])
        recent_observed_frames = synchronization_window_rounds
        recent_transport_drop_percent = (
            round(
                100.0
                * recent_transport_gap_count
                / (recent_observed_frames + recent_transport_gap_count),
                4,
            )
            if recent_observed_frames + recent_transport_gap_count > 0
            else 0.0
        )
        return {
            "cameraIndex": camera.camera_index,
            "deviceId": camera.camera_index,
            "cameraId": camera.camera_id,
            "cameraKey": camera.key,
            "ip": identity.get("ip", camera.ip),
            "sn": camera.serial_number,
            "serialNumber": camera.serial_number,
            "model": identity.get("model", camera.model),
            "firmware": identity.get("firmware", ""),
            "role": camera.role,
            "driverMode": "sick-gentl",
            "driverId": "sick-gentl-harvesters",
            "gentlBufferCount": (
                int(getattr(session, "buffer_count", 0)) if session is not None else 0
            ),
            "gentlMinimumBufferCount": (
                int(getattr(session, "minimum_buffer_count", 0))
                if session is not None
                else 0
            ),
            "gentlBackgroundAcquisition": (
                bool(getattr(session, "background_acquisition", False))
                if session is not None
                else False
            ),
            "frameTrigger": trigger_status,
            "frameTriggerMode": trigger_status.get(
                "configuredMode", self.frame_trigger_mode
            ),
            "softwareTriggerCapable": bool(
                trigger_status.get("softwareTriggerCapable", False)
            ),
            "connected": session is not None,
            "acquiring": bool(session is not None and getattr(session, "started", False)),
            "acquisitionState": "acquiring" if continuous_running else "connected" if session else "offline",
            "continuousAcquiring": continuous_running,
            "continuousFps": continuous_fps,
            "fps": continuous_fps,
            "continuousFrameCount": stats["frameCount"],
            "continuousFrameDelta": int(stats["frameCount"]) - minimum_frame_count,
            "continuousFinalizedCount": stats["finalizedCount"],
            "continuousSuccessfulFrameCount": stats["successfulFrameCount"],
            "continuousLastResultCode": stats["lastResultCode"],
            "lastContinuousFrameAt": stats["lastFrameAt"],
            "lastFrameTime": stats["lastFrameAt"],
            "streamRunning": stream_running,
            "streamFrames": stream_frames,
            "streamFps": stream_fps,
            "streamLastFrameAt": stream_last_frame_at,
            "streamWidth": self.stream_dimensions.get(camera.key, (0, 0))[0],
            "streamHeight": self.stream_dimensions.get(camera.key, (0, 0))[1],
            "deviceTemperature": device_temperature,
            "deviceTemperatureMin": device_temperature_min,
            "deviceTemperatureMax": device_temperature_max,
            # Compatibility for the existing camera status UI. SICK exposes a
            # single selected device-temperature sensor rather than J28-J30.
            "temperatureJ28": device_temperature,
            "temperatureUpdatedAt": telemetry_updated_at,
            "deviceLinkThroughputCurrent": telemetry.get(
                "deviceLinkThroughputCurrent",
                camera_config.get("DeviceLinkThroughputCurrent"),
            ),
            "deviceLinkThroughputLimit": telemetry.get(
                "deviceLinkThroughputLimit",
                camera_config.get("DeviceLinkThroughputLimit"),
            ),
            "acquisitionFrameRate": telemetry.get(
                "acquisitionFrameRate", camera_config.get("AcquisitionFrameRate")
            ),
            "transportFrameId": last_transport_frame_id,
            "transportFrameGapCount": recent_transport_gap_count,
            "lifetimeTransportFrameGapCount": lifetime_transport_gap_count,
            "transportFrameDropPercent": recent_transport_drop_percent,
            "synchronizationWindowRounds": synchronization_window_rounds,
            "hasRecentFrameDrops": recent_transport_gap_count > 0,
            "lostPulseCounter": lifetime_transport_gap_count,
            "storageRoot": str(camera.storage_root),
            "lastError": self.session_errors.get(camera.key, ""),
        }

    def cameras_json(self) -> dict[str, Any]:
        return {
            "code": 0,
            "count": self.profile.expected_cameras,
            "connectedCameras": len(self.sessions),
            "driverMode": "sick-gentl",
            "driverId": "sick-gentl-harvesters",
            "cameras": [self._camera_row(camera) for camera in self.profile.enabled_cameras],
        }

    def health_json(self) -> dict[str, Any]:
        backend_ready = bool(getattr(self.backend, "started", False))
        connected = len(self.sessions)
        provider_ready = backend_ready and connected == self.profile.expected_cameras
        with self.alignment_lock:
            alignment = dict(self.alignment_status)
            measurement = dict(self.measurement_status)
            defect_detection = dict(self.defect_detection_status)
        return {
            "code": 0 if backend_ready else 49110,
            "service": "steel_sick_capture_sidecar",
            "time": _utc_text(),
            # These fields are part of the physical capture-health contract
            # consumed by the Tauri client.  Without them the client treats an
            # otherwise healthy external provider as malformed and falls back
            # to the legacy eight-camera defaults.
            "provider": "external-api",
            "connected": connected > 0,
            "ip": self.profile.enabled_cameras[0].ip if self.profile.enabled_cameras else "",
            "ready": provider_ready,
            "providerReady": provider_ready,
            "sdkReady": backend_ready,
            "sdkCode": 0 if backend_ready else 49110,
            "driverMode": "sick-gentl",
            "driverId": "sick-gentl-harvesters",
            "driverName": "SICK GenTL Producer via Harvesters",
            "ctiPath": str(self.profile.cti_path),
            "ctiSha256": self.profile.cti_sha256,
            "storageRoot": str(self.profile.storage_root),
            "configRoot": str(self.profile.source_path.parent),
            "cameraCount": connected,
            "expectedCameras": self.profile.expected_cameras,
            "restartRequired": False,
            "recoveryRequired": False,
            "invalidManifest": False,
            "pendingRecoveryCount": 0,
            "sdkCaptureState": {
                "poisoned": False,
                "restartRequired": False,
                "reason": None,
            },
            "framesReceived": self.frames_received,
            "framesCommitted": self.frames_committed,
            "framesFailed": self.frames_failed,
            "databaseCommit": {
                "schema": "steel.capture-database-commit.v1",
                "capacityRounds": self.database_commit_capacity_rounds,
                "maxBatchRounds": self.database_commit_max_batch_rounds,
                "pendingRounds": len(self.database_commit_queue),
                "activeRounds": self.database_commit_active_rounds,
                "highWaterRounds": self.database_commit_high_water_rounds,
                "succeededBatches": self.database_commit_batches,
                "succeededRounds": self.database_commit_succeeded_rounds,
                "failedBatches": self.database_commit_failures,
                "failedRounds": self.database_commit_failed_rounds,
                "retryCount": self.database_commit_retries,
                "lastSuccessAt": self.database_commit_last_success_at or None,
                "lastError": self.database_commit_last_error or None,
            },
            "blackFramesDiscarded": self.black_frame_count,
            "continuousAcquisitionFrameCount": self.continuous_acquisition_frame_count,
            "continuousDiscardedFrameCount": self.continuous_discarded_frame_count,
            "acquisitionSynchronization": self._synchronization_json(),
            "flowAlignment": alignment,
            "flowMeasurement": measurement,
            "flowDefectDetection": defect_detection,
            "lastError": self.last_error or None,
            "uptimeSeconds": round(time.time() - self.started_at, 3),
            "cameras": [self._camera_row(camera) for camera in self.profile.enabled_cameras],
            "storageQueue": self._queue_json(),
        }

    @staticmethod
    def _path_capacity(root: Path) -> dict[str, Any]:
        root.mkdir(parents=True, exist_ok=True)
        exists = root.is_dir()
        writable = False
        if exists:
            try:
                with tempfile.NamedTemporaryFile(prefix=".steel-sick-write-probe-", dir=root, delete=True):
                    writable = True
            except OSError:
                writable = False
        try:
            usage = shutil.disk_usage(root)
            total = int(usage.total)
            free = int(usage.free)
            free_percent = (free * 100.0 / total) if total else 0.0
            capacity_available = True
        except OSError:
            total = 0
            free = 0
            free_percent = 0.0
            capacity_available = False
        return {
            "root": str(root),
            "exists": exists,
            "writable": writable,
            "capacityAvailable": capacity_available,
            "capacityBytes": total,
            "freeBytes": free,
            "freePercent": free_percent,
        }

    def _queue_json(self) -> dict[str, Any]:
        with self.storage_queue_lock:
            now = time.monotonic()
            recent = [sample for sample in self.storage_write_samples if now - sample[0] <= 10.0]
            recent_bytes = sum(sample[1] for sample in recent)
            recent_seconds = sum(sample[2] for sample in recent)
            camera_write_latency = {}
            for camera_key, samples in self.storage_camera_write_ms.items():
                values = list(samples)
                ordered = sorted(values)
                p95_index = max(
                    0,
                    min(
                        len(ordered) - 1,
                        (len(ordered) * 95 + 99) // 100 - 1,
                    ),
                )
                camera_write_latency[camera_key] = {
                    "samples": len(values),
                    "average": round(sum(values) / len(values), 3) if values else None,
                    "p95": round(ordered[p95_index], 3) if ordered else None,
                    "maximum": round(max(values), 3) if values else None,
                }
            return {
                "accepting": self.storage_queue_accepting,
                "workerCount": self.profile.expected_cameras,
                "writerMode": (
                    "process-shared-memory"
                    if self.storage_process_workers
                    else "thread"
                ),
                "writerProcessCount": self.storage_process_workers,
                "writerThreadCount": self.storage_process_threads,
                "previewWorkerCount": self.preview_worker_threads,
                "sharedMemorySlots": len(self.storage_shared_buffers),
                "capacityRounds": self.storage_queue_capacity_rounds,
                "reservedBoundaryRounds": self.storage_queue_boundary_reserve_rounds,
                "capacityItems": (
                    self.storage_queue_capacity_rounds * self.profile.expected_cameras
                ),
                "pendingRounds": self.storage_queue_pending_rounds,
                "pendingItems": (
                    self.storage_queue_pending_rounds * self.profile.expected_cameras
                ),
                "activeRounds": self.storage_queue_active_rounds,
                "activeItems": (
                    self.storage_queue_active_rounds * self.profile.expected_cameras
                ),
                "completedRounds": self.storage_queue_completed_rounds,
                "completed": self.frames_committed,
                "droppedRounds": self.storage_queue_dropped_rounds,
                "droppedFrames": self.storage_queue_dropped_frames,
                "failedRounds": self.storage_queue_failed_rounds,
                "failed": self.frames_failed,
                "highWaterRounds": self.storage_queue_high_water_rounds,
                "backpressureWaits": self.storage_queue_backpressure_waits,
                "backpressureSeconds": round(self.storage_queue_backpressure_seconds, 3),
                "recentWriteBytesPerSecond": (
                    round(recent_bytes / recent_seconds, 3) if recent_seconds > 0 else 0.0
                ),
                "cameraWriteLatencyMs": camera_write_latency,
                "implementation": "bounded-round-cache+lossless-backpressure+ordered-round-writer+per-camera-disks",
            }

    def storage_json(self) -> dict[str, Any]:
        root = self._path_capacity(self.profile.storage_root)
        camera_roots = [
            {**self._path_capacity(camera.storage_root), "cameraKey": camera.key, "ip": camera.ip}
            for camera in self.profile.enabled_cameras
        ]
        ok = (
            root["exists"]
            and root["writable"]
            and root["capacityAvailable"]
            and all(
                item["exists"] and item["writable"] and item["capacityAvailable"]
                for item in camera_roots
            )
        )
        return {
            "code": 0 if ok else 49102,
            "status": "up" if ok else "unavailable",
            "root": str(self.profile.storage_root),
            "exists": root["exists"],
            "writable": root["writable"],
            "capacityAvailable": root["capacityAvailable"],
            "capacityBytes": root["capacityBytes"],
            "freeBytes": root["freeBytes"],
            "freePercent": root["freePercent"],
            "cameraRoots": camera_roots,
            "queue": self._queue_json(),
        }

    def steel_status_json(self) -> dict[str, Any]:
        with self.alignment_lock:
            alignment = dict(self.alignment_status)
        with self.state_lock:
            return {
                "code": 0,
                "provider": "sick-gentl-harvesters",
                "phase": (
                    "steel-in-saving"
                    if self.steel_present and self.save_enabled
                    else "steel-in-waiting-images"
                    if self.steel_present
                    else "idle"
                ),
                "present": self.steel_present,
                "saveEnabled": self.save_enabled,
                "materialId": self.active_material_id,
                "sessionId": self.active_session_id,
                "flowNo": self.active_flow_no,
                "flowCode": self.active_flow_code,
                "captureMode": self.capture_mode,
                "automaticCaptureEnabled": self.capture_mode == "continuous",
                "productionCaptureRunning": (
                    self.capture_mode == "continuous" and self._acquisition_running()
                ),
                "discardBlackFrames": True,
                "blackFrameThreshold": self.profile.black_frame_threshold,
                "blackFrameCount": self.black_frame_count,
                "grayscaleSteelDetection": self.grayscale_steel_detection,
                "steelBrightPixelThreshold": self.steel_bright_threshold,
                "steelBrightPixelRatio": self.steel_bright_ratio,
                "steelDetectionRegion": "tail-rows",
                "steelDetectionEdge": self.steel_detection_edge,
                "steelDetectionTailRows": self.steel_detection_tail_rows,
                "steelMinCameras": self.steel_min_cameras,
                "steelEntryRounds": self.steel_entry_rounds,
                "steelExitRounds": self.steel_exit_rounds,
                "steelPreRollFrames": self.steel_pre_roll_frames,
                "steelPostRollFrames": self.steel_post_roll_frames,
                "blackFrameCacheRounds": self.black_frame_cache_rounds,
                "steelSignalCameras": self.last_steel_signal_cameras,
                "steelEntryStreak": self.steel_entry_streak,
                "steelExitStreak": self.steel_exit_streak,
                "continuousAcquisitionFrameCount": self.continuous_acquisition_frame_count,
                "continuousDiscardedFrameCount": self.continuous_discarded_frame_count,
                "acquisitionSynchronization": self._synchronization_json(),
                "flowAlignment": alignment,
                "connectedCameras": len(self.sessions),
                "storageRoot": str(self.profile.storage_root),
                "updatedAt": _utc_text(),
            }

    def continuous_settings_json(self) -> dict[str, Any]:
        return {
            "code": 0,
            "provider": "sick-gentl-harvesters",
            "supported": True,
            "captureMode": self.capture_mode,
            "automaticCaptureEnabled": self.capture_mode == "continuous",
            "productionCaptureRunning": (
                self.capture_mode == "continuous" and self._acquisition_running()
            ),
            "discardBlackFrames": True,
            "blackFrameThreshold": self.profile.black_frame_threshold,
            "grayscaleSteelDetection": self.grayscale_steel_detection,
            "steelBrightPixelThreshold": self.steel_bright_threshold,
            "steelBrightPixelRatio": self.steel_bright_ratio,
            "steelDetectionRegion": "tail-rows",
            "steelDetectionEdge": self.steel_detection_edge,
            "steelDetectionTailRows": self.steel_detection_tail_rows,
            "steelMinCameras": self.steel_min_cameras,
            "steelEntryRounds": self.steel_entry_rounds,
            "steelExitRounds": self.steel_exit_rounds,
            "steelPreRollFrames": self.steel_pre_roll_frames,
            "steelPostRollFrames": self.steel_post_roll_frames,
            "blackFrameCacheRounds": self.black_frame_cache_rounds,
            "alignmentSearchFrames": self.alignment_config.search_frames,
            "alignmentStableRows": self.alignment_config.stable_rows,
            "softSyncAnchorIntervalFrames": self.alignment_config.anchor_interval_frames,
            "softSyncMaximumResidualMs": self.alignment_config.maximum_anchor_residual_ms,
            "frameTriggerMode": self.frame_trigger_mode,
            "frameTriggerRequiresRestart": True,
            "arrayCalibrationPath": str(self.array_calibration_path or ""),
            "arrayCalibrationAvailable": bool(
                self.array_calibration_path and self.array_calibration_path.is_file()
            ),
            "storageWriteCacheRounds": self.storage_queue_capacity_rounds,
            "requiresProfileRestart": False,
            "runtimeOnly": True,
            "devicePersistent": False,
            "readbackSource": "sick-profile",
            "connectedCameras": len(self.sessions),
            "configuredCameras": self.profile.expected_cameras,
        }

    def set_capture_mode(self, payload: dict[str, Any]) -> dict[str, Any]:
        requested = str(payload.get("captureMode", payload.get("capture_mode", ""))).strip().lower()
        aliases = {
            "auto": "continuous",
            "automatic": "continuous",
            "manual": "on-demand",
            "on_demand": "on-demand",
            "ondemand": "on-demand",
            "off": "disabled",
            "stop": "disabled",
        }
        requested = aliases.get(requested, requested)
        if requested not in {"continuous", "on-demand", "disabled"}:
            return {
                "code": 400,
                "error": "invalid_capture_mode",
                "message": "captureMode must be continuous, on-demand, or disabled",
            }
        with self.state_lock:
            changed = self.capture_mode != requested
            self.capture_mode = requested
        if requested == "continuous":
            self._ensure_acquisition_worker()
        else:
            self._stop_acquisition_if_idle()
        return {
            "code": 0,
            "provider": "sick-gentl-harvesters",
            "captureMode": requested,
            "automaticCaptureEnabled": requested == "continuous",
            "productionCaptureRunning": (
                requested == "continuous" and self._acquisition_running()
            ),
            "captureModeChanged": changed,
            "discardBlackFrames": True,
            "updatedAt": _utc_text(),
        }

    def steel_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        command = str(payload.get("cmd", payload.get("command", ""))).strip()
        normalized = command.replace("_", "").lower()
        if not command:
            return {"code": 400, "error": "missing steel event cmd"}
        if normalized not in {"steelin", "in", "rcvsteelinfo", "steelinfo", "reset", "clear"}:
            return {"code": 400, "error": "unknown steel event cmd", "cmd": command}
        try:
            value = int(payload.get("value", 0) or 0)
        except (TypeError, ValueError):
            return {"code": 400, "error": "steel event value must be an integer"}
        material_id = str(
            payload.get("steelId", payload.get("materialId", payload.get("id", "")))
        ).strip()
        session_id = str(payload.get("sessionId", "")).strip()
        requested_mode = payload.get("captureMode", payload.get("capture_mode"))
        if requested_mode is not None:
            mode_result = self.set_capture_mode({"captureMode": requested_mode})
            if mode_result["code"] != 0:
                return mode_result
        completed_material_id = ""
        with self.state_lock:
            if normalized in {"steelin", "in"}:
                self.save_generation += 1
                if value:
                    if not material_id or not session_id:
                        return {"code": 400, "error": "steel-in requires materialId and sessionId"}
                    self.active_material_id = material_id
                    self.active_session_id = session_id
                    self.active_flow_no = int(payload.get("flowNo", 0) or 0) or None
                    self.active_flow_code = str(payload.get("flowCode", ""))
                    self.steel_present = True
                    self.save_enabled = bool(payload.get("saveEnabled", True))
                else:
                    completed_material_id = self.active_material_id or material_id
                    self.steel_present = False
                    self.save_enabled = False
                    self.active_material_id = ""
                    self.active_session_id = ""
                    self.active_flow_no = None
                    self.active_flow_code = ""
            elif normalized in {"reset", "clear"}:
                self.save_generation += 1
                self.steel_present = False
                self.save_enabled = False
                self.active_material_id = ""
                self.active_session_id = ""
                self.active_flow_no = None
                self.active_flow_code = ""
            phase = (
                "steel-in-saving"
                if self.steel_present and self.save_enabled
                else "steel-in-waiting-images"
                if self.steel_present
                else "info-ready"
                if normalized in {"rcvsteelinfo", "steelinfo"}
                else "steel-out"
                if normalized in {"steelin", "in"} and value == 0
                else "idle"
            )
            self._log(
                "info",
                "production event applied",
                command=command,
                value=value,
                materialId=material_id,
                sessionId=session_id,
                saveEnabled=self.save_enabled,
            )
            response = {
                "code": 0,
                "cmd": command,
                "value": value,
                "materialId": material_id,
                "sessionId": session_id,
                "flowNo": self.active_flow_no,
                "flowCode": self.active_flow_code,
                "phase": phase,
                "present": self.steel_present,
                "captureSaveState": "save" if self.save_enabled else "discard",
                "saveEnabled": self.save_enabled,
                "captureMode": self.capture_mode,
                "automaticCaptureEnabled": self.capture_mode == "continuous",
                "productionCaptureRunning": (
                    self.capture_mode == "continuous" and self._acquisition_running()
                ),
                "discardBlackFrames": True,
                "grayscaleSteelDetection": self.grayscale_steel_detection,
                "driverMode": "sick-gentl",
            }
        if completed_material_id:
            self._schedule_flow_alignment(completed_material_id)
        return response

    def _ensure_acquisition_worker(self) -> None:
        with self.state_lock:
            self.acquisition_stop.clear()
            if self._acquisition_running():
                return
            # A camera's transport frame counter continues advancing while
            # acquisition is intentionally paused. Comparing the first frame
            # after resume with the old frame id would falsely report every
            # paused device frame as a transport drop. Start a fresh rolling
            # window and warm-up baseline for each acquisition-worker run;
            # verified lifetime gaps from earlier active runs remain intact.
            self.last_transport_frame_ids.clear()
            self.synchronization_window.clear()
            self.synchronization_warmup_remaining = self.synchronization_warmup_rounds
            thread = threading.Thread(
                target=self._acquisition_loop,
                name="sick-live-acquisition",
                daemon=True,
            )
            self.acquisition_thread = thread
            thread.start()

    def _stop_acquisition_if_idle(self) -> None:
        with self.state_lock:
            continuous = self.capture_mode == "continuous"
        with self.stream_lock:
            streaming = bool(self.stream_camera_key)
        if not continuous and not streaming:
            self.acquisition_stop.set()

    @staticmethod
    def _preview_plane(array: np.ndarray, *, depth: bool) -> np.ndarray:
        values = np.asarray(array)
        if values.ndim != 2:
            values = np.squeeze(values)
        if values.ndim != 2:
            raise ValueError("preview frame must be a 2D image")
        if values.dtype == np.uint8 and not depth:
            return np.ascontiguousarray(values)
        finite = np.isfinite(values)
        if depth:
            finite &= values != 0
        samples = values[finite]
        if samples.size == 0:
            return np.zeros(values.shape, dtype=np.uint8)
        low, high = np.percentile(samples.astype(np.float64), (2.0, 98.0))
        if high <= low:
            low = float(samples.min())
            high = float(samples.max())
        if high <= low:
            return np.zeros(values.shape, dtype=np.uint8)
        scaled = np.clip((values.astype(np.float64) - low) * 255.0 / (high - low), 0, 255)
        scaled[~finite] = 0
        return np.ascontiguousarray(scaled.astype(np.uint8))

    @classmethod
    def _preview_png(
        cls,
        array: np.ndarray,
        *,
        depth: bool,
        max_width: int | None = None,
        minimum_visible_max: float | None = None,
    ) -> bytes | None:
        output = io.BytesIO()
        with Image.fromarray(cls._preview_plane(array, depth=depth), mode="L") as source:
            if max_width and source.width > max_width:
                target_height = max(1, round(source.height * max_width / source.width))
                with source.resize(
                    (max_width, target_height),
                    Image.Resampling.BILINEAR,
                ) as preview:
                    if (
                        minimum_visible_max is not None
                        and preview.getextrema()[1] <= minimum_visible_max
                    ):
                        return None
                    preview.save(
                        output,
                        format="PNG",
                        optimize=False,
                        compress_level=1,
                    )
            else:
                if (
                    minimum_visible_max is not None
                    and source.getextrema()[1] <= minimum_visible_max
                ):
                    return None
                source.save(
                    output,
                    format="PNG",
                    optimize=False,
                    compress_level=1,
                )
        return output.getvalue()

    def _publish_stream_frame(
        self,
        camera: CameraProfile,
        frame: Any,
    ) -> None:
        intensity = np.asarray(frame.intensity)
        preview_black_max = max(
            LIVE_PREVIEW_BLACK_MAX,
            self.profile.black_frame_threshold,
        )
        if intensity.size == 0 or float(np.max(intensity)) <= preview_black_max:
            return
        visible_ratio = float(
            np.count_nonzero(intensity > self.steel_bright_threshold)
        ) / float(intensity.size)
        # Isolated dust/sensor specks in an otherwise black image previously
        # replaced the last good preview and looked like a black flicker.
        if visible_ratio < self.steel_bright_ratio:
            return
        now = time.monotonic()
        with self.stream_lock:
            active_key = self.stream_camera_key
            if not active_key or (
                self.capture_mode != "continuous" and active_key != camera.key
            ):
                return
            fps_limit = int(self.stream_options.get("fpsLimit", 5) or 5)
            ticks = self.stream_frame_ticks_by_camera.setdefault(
                camera.key, deque(maxlen=20)
            )
            if ticks and now - ticks[-1] < 1.0 / fps_limit:
                return
            requested_kinds = {
                kind
                for kind, requested_at in self.stream_requested_kinds.get(
                    camera.key, {}
                ).items()
                if now - requested_at <= 2.0
            }
        try:
            grid_preview = self._preview_png(
                intensity,
                depth=False,
                max_width=800,
                minimum_visible_max=LIVE_PREVIEW_BLACK_MAX,
            )
            if grid_preview is None:
                return
            latest = {"intensity-grid": grid_preview}
            # The 2x3 overview uses only the 800-pixel preview.  Full-width
            # intensity and the considerably more expensive depth percentile
            # conversion are generated only while the UI is actively asking
            # for that kind on the focused camera.
            if active_key == camera.key:
                if "intensity" in requested_kinds:
                    intensity_preview = self._preview_png(intensity, depth=False)
                    if intensity_preview is not None:
                        latest["intensity"] = intensity_preview
                if "depth" in requested_kinds:
                    depth_preview = self._preview_png(frame.depth_raw, depth=True)
                    if depth_preview is not None:
                        latest["depth"] = depth_preview
        except Exception as error:
            self._log("warning", "SICK live preview conversion failed", cameraKey=camera.key, error=str(error))
            return
        with self.stream_lock:
            if not self.stream_camera_key or (
                self.capture_mode != "continuous"
                and self.stream_camera_key != camera.key
            ):
                return
            camera_latest = self.stream_latest.setdefault(camera.key, {})
            camera_latest.update(latest)
            frame_count = self.stream_frame_counts.get(camera.key, 0) + 1
            frame_at = _utc_text()
            self.stream_frame_counts[camera.key] = frame_count
            self.stream_last_frame_at_by_camera[camera.key] = frame_at
            self.stream_dimensions[camera.key] = (
                int(intensity.shape[1]),
                int(intensity.shape[0]),
            )
            self.stream_frame_ticks_by_camera.setdefault(
                camera.key, deque(maxlen=20)
            ).append(now)
            if self.stream_camera_key == camera.key:
                self.stream_frame_count = frame_count
                self.stream_last_frame_at = frame_at
                self.stream_frame_ticks = self.stream_frame_ticks_by_camera[camera.key]

    def _schedule_stream_frame(self, camera: CameraProfile, frame: Any) -> None:
        with self.stream_lock:
            active_key = self.stream_camera_key
            if not active_key or (
                self.capture_mode != "continuous" and active_key != camera.key
            ):
                return
        with self.preview_work_lock:
            now = time.monotonic()
            previous = self.preview_scheduled_at.get(camera.key, 0.0)
            if now - previous < 1.0 / LIVE_PREVIEW_MAX_FPS:
                return
            if camera.key in self.preview_pending_cameras:
                return
            self.preview_pending_cameras.add(camera.key)
            self.preview_scheduled_at[camera.key] = now

        future = self.preview_pool.submit(self._publish_stream_frame, camera, frame)

        def completed(done: Any) -> None:
            try:
                done.result()
            except Exception as error:
                self.last_error = str(error)
                self._log(
                    "warning",
                    "live preview encoding failed",
                    cameraKey=camera.key,
                    error=str(error),
                )
            finally:
                with self.preview_work_lock:
                    self.preview_pending_cameras.discard(camera.key)

        future.add_done_callback(completed)

    def _seed_stream_cache_from_storage(self) -> None:
        if not self.preview_seed_lock.acquire(blocking=False):
            return
        try:
            for camera in self.profile.enabled_cameras:
                with self.stream_lock:
                    if self.stream_latest.get(camera.key, {}).get("intensity-grid"):
                        continue
                candidates = self._recent_camera_files(
                    camera,
                    directories=("2d", "intensity"),
                    suffixes=(".png", ".jpg", ".jpeg"),
                    limit=128,
                )
                for path in candidates:
                    try:
                        with Image.open(path) as source:
                            intensity = np.asarray(source.convert("L")).copy()
                        if intensity.size == 0:
                            continue
                        visible_ratio = float(
                            np.count_nonzero(intensity > self.steel_bright_threshold)
                        ) / float(intensity.size)
                        if visible_ratio < self.steel_bright_ratio:
                            continue
                        grid_preview = self._preview_png(
                            intensity,
                            depth=False,
                            max_width=800,
                        )
                        if grid_preview is None:
                            continue
                    except (OSError, ValueError):
                        continue
                    with self.stream_lock:
                        camera_latest = self.stream_latest.setdefault(camera.key, {})
                        camera_latest.setdefault("intensity-grid", grid_preview)
                        # Use the already encoded grid image as the immediate
                        # focused fallback too.  The next live steel frame
                        # replaces it with a full-width preview for the active
                        # camera, while cold-starting six cards avoids six
                        # redundant full-resolution PNG encodes.
                        camera_latest.setdefault("intensity", grid_preview)
                        self.stream_dimensions.setdefault(
                            camera.key,
                            (int(intensity.shape[1]), int(intensity.shape[0])),
                        )
                    break
        finally:
            self.preview_seed_lock.release()

    def stream_status(self, identity: str = "") -> dict[str, Any]:
        camera = self.camera_for_identity(identity) if identity else None
        with self.stream_lock:
            active = self.camera_for_identity(self.stream_camera_key) if self.stream_camera_key else None
            reported = camera or active
            running = bool(
                active is not None
                and self._acquisition_running()
                and (
                    camera is None
                    or camera.key == active.key
                    or self.capture_mode == "continuous"
                )
            )
            options = dict(self.stream_options)
            reported_key = reported.key if reported is not None else ""
            return {
                "code": 0,
                "running": running,
                "ip": (reported.ip if reported is not None else identity),
                "cameraId": reported.camera_id if reported is not None else "",
                "lines": options.get("lines", 1280),
                "width": options.get("width", 0),
                "dataMode": options.get("dataMode", 3),
                "fpsLimit": options.get("fpsLimit", 5),
                "hs": options.get("hs", False),
                "frameCount": self.stream_frame_counts.get(reported_key, 0) if running else 0,
                "fps": self._rolling_fps(
                    self.stream_frame_ticks_by_camera.get(reported_key, deque())
                ) if running else None,
                "lastFrameAt": self.stream_last_frame_at_by_camera.get(reported_key) if running else None,
                "latestDepthUrl": "/api/stream/latest?kind=depth",
                "latestIntensityUrl": "/api/stream/latest?kind=intensity",
                "sharedWithContinuousCapture": self.capture_mode == "continuous",
            }

    def start_stream(self, payload: dict[str, Any]) -> dict[str, Any]:
        identity = str(payload.get("ip", payload.get("cameraId", ""))).strip()
        camera = self.camera_for_identity(identity)
        if camera is None:
            return {"code": 404, "error": "camera_not_found", "ip": identity, "running": False}
        if camera.key not in self.sessions:
            return {"code": 409, "error": "camera_not_connected", "ip": camera.ip, "running": False}
        try:
            options = {
                "lines": _integer(payload, "lines", 1280, 1, 100_000),
                "width": _integer(payload, "width", 0, 0, 32_768),
                "dataMode": _integer(payload, "dataMode", 3, 1, 3),
                "fpsLimit": _integer(payload, "fpsLimit", 5, 1, 30),
                "hs": bool(payload.get("hs", False)),
            }
        except ValueError as error:
            return {"code": 400, "error": str(error), "ip": camera.ip, "running": False}
        with self.stream_lock:
            self.stream_camera_key = camera.key
            self.stream_options = options
            self.stream_started_at = _utc_text()
            self.stream_frame_count = 0
            self.stream_last_frame_at = ""
            self.stream_frame_ticks.clear()
            self.stream_requested_kinds.clear()
            if self.capture_mode != "continuous":
                self.stream_latest.pop(camera.key, None)
            self.stream_frame_counts[camera.key] = 0
            self.stream_last_frame_at_by_camera.pop(camera.key, None)
            self.stream_frame_ticks_by_camera[camera.key] = deque(maxlen=20)
        threading.Thread(
            target=self._seed_stream_cache_from_storage,
            name="sick-preview-seed",
            daemon=True,
        ).start()
        self._ensure_acquisition_worker()
        return self.stream_status(camera.ip)

    def stop_stream(self, payload: dict[str, Any]) -> dict[str, Any]:
        identity = str(payload.get("ip", payload.get("cameraId", ""))).strip()
        requested = self.camera_for_identity(identity) if identity else None
        with self.stream_lock:
            if requested is None or requested.key == self.stream_camera_key:
                self.stream_camera_key = ""
                self.stream_options = {}
                self.stream_latest.clear()
                self.stream_frame_counts.clear()
                self.stream_last_frame_at_by_camera.clear()
                self.stream_frame_ticks_by_camera.clear()
                self.stream_frame_ticks.clear()
                self.stream_requested_kinds.clear()
        self._stop_acquisition_if_idle()
        return {"code": 0, "running": False, "ip": identity, "frameCount": 0}

    def stream_latest_bytes(self, identity: str, kind: str) -> bytes | None:
        camera = self.camera_for_identity(identity) if identity else None
        with self.stream_lock:
            if kind not in {"depth", "intensity", "intensity-grid"}:
                return None
            if not self.stream_camera_key:
                return None
            target = camera or self.camera_for_identity(self.stream_camera_key)
            if target is None:
                return None
            if (
                self.capture_mode != "continuous"
                and target.key != self.stream_camera_key
            ):
                return None
            if kind in {"intensity", "depth"}:
                self.stream_requested_kinds.setdefault(target.key, {})[
                    kind
                ] = time.monotonic()
            return self.stream_latest.get(target.key, {}).get(kind)

    def _record_continuous_round(self, results: list[dict[str, Any]], persist_frame: bool) -> None:
        now = time.monotonic()
        with self.state_lock:
            for row in results:
                stats = self.continuous_stats.get(str(row.get("cameraKey", "")))
                if stats is None:
                    continue
                stats["finalizedCount"] += 1
                stats["lastResultCode"] = int(row.get("code", SICK_CAPTURE_FAILED))
                if not row.get("frameReceived"):
                    continue
                stats["frameCount"] += 1
                stats["lastFrameAt"] = str(row.get("capturedAt", _utc_text()))
                stats["ticks"].append(now)
                self.continuous_acquisition_frame_count += 1
                if bool(row.get("completeFrame")):
                    stats["successfulFrameCount"] += 1
                if not persist_frame or int(row.get("code", 0)) in {
                    CAPTURE_DISCARDED_NOT_ARMED,
                    BLACK_FRAME_DISCARDED,
                    NO_STEEL_FRAME_DISCARDED,
                }:
                    self.continuous_discarded_frame_count += 1

    def _record_synchronization_round(self, results: list[dict[str, Any]]) -> None:
        received = [row for row in results if bool(row.get("frameReceived"))]
        received_keys = {str(row.get("cameraKey", "")) for row in received}
        expected_keys = {camera.key for camera in self.profile.enabled_cameras}
        host_times = [
            int(row["hostUtcNs"])
            for row in received
            if int(row.get("hostUtcNs", 0) or 0) > 0
        ]
        sequences = [
            int(row["cameraFrameSequence"])
            for row in received
            if row.get("cameraFrameSequence") is not None
        ]
        transport_ids = {
            str(row.get("cameraKey", "")): int(row.get("transportFrameId", 0) or 0)
            for row in received
            if int(row.get("transportFrameId", 0) or 0) > 0
        }
        trigger_times = [
            int(row.get("triggerIssuedNs", 0) or 0)
            for row in received
            if int(row.get("triggerIssuedNs", 0) or 0) > 0
        ]
        with self.state_lock:
            warming_up = self.synchronization_warmup_remaining > 0
            transport_gaps: dict[str, int] = {}
            for camera_key, current_frame_id in transport_ids.items():
                previous_frame_id = self.last_transport_frame_ids.get(camera_key)
                gap = (
                    max(0, current_frame_id - previous_frame_id - 1)
                    if previous_frame_id is not None and current_frame_id > previous_frame_id
                    else 0
                )
                if gap and not warming_up:
                    self.transport_frame_gap_counts[camera_key] += gap
                    transport_gaps[camera_key] = gap
                self.last_transport_frame_ids[camera_key] = current_frame_id
            if warming_up:
                self.synchronization_warmup_remaining -= 1
                return
            self.synchronization_window.append(
                {
                    "round": max((int(row.get("round", 0)) for row in results), default=0),
                    "receivedCameras": len(received_keys),
                    "complete": received_keys == expected_keys,
                    "missingCameras": sorted(expected_keys - received_keys),
                    "hostCaptureSkewMs": (
                        round((max(host_times) - min(host_times)) / 1_000_000, 3)
                        if len(host_times) == len(expected_keys) and host_times
                        else None
                    ),
                    "cameraSequenceSkew": (
                        max(sequences) - min(sequences)
                        if len(sequences) == len(expected_keys) and sequences
                        else None
                    ),
                    "transportFrameIdsAvailable": len(transport_ids),
                    "transportFrameGaps": transport_gaps,
                    "frameTriggerMode": self.frame_trigger_mode,
                    "softwareTriggeredCameras": len(trigger_times),
                    "triggerIssueSkewMs": (
                        round((max(trigger_times) - min(trigger_times)) / 1_000_000, 3)
                        if len(trigger_times) == len(expected_keys) and trigger_times
                        else None
                    ),
                }
            )

    def _synchronization_json(self) -> dict[str, Any]:
        with self.state_lock:
            window = list(self.synchronization_window)
            counts = {
                camera.key: int(self.continuous_stats[camera.key]["frameCount"])
                for camera in self.profile.enabled_cameras
            }
            lifetime_transport_gap_counts = dict(self.transport_frame_gap_counts)
            warmup_remaining = self.synchronization_warmup_remaining
        transport_gap_counts = {
            camera.key: sum(
                int(row.get("transportFrameGaps", {}).get(camera.key, 0))
                for row in window
            )
            for camera in self.profile.enabled_cameras
        }
        values = list(counts.values())
        frame_count_skew = max(values, default=0) - min(values, default=0)
        complete_rounds = sum(bool(row["complete"]) for row in window)
        last = window[-1] if window else None
        synchronized = bool(
            last
            and last["complete"]
            and complete_rounds == len(window)
            and frame_count_skew <= 1
            and sum(transport_gap_counts.values()) == 0
            and len(self.sessions) == self.profile.expected_cameras
            and (
                self.frame_trigger_mode != "software"
                or (
                    last.get("triggerIssueSkewMs") is not None
                    and float(last["triggerIssueSkewMs"])
                    <= self.alignment_config.maximum_anchor_residual_ms
                )
            )
        )
        return {
            "schema": "steel.capture-synchronization.v1",
            "status": "synchronized" if synchronized else "degraded" if window else "waiting",
            "synchronized": synchronized,
            "expectedCameras": self.profile.expected_cameras,
            "connectedCameras": len(self.sessions),
            "frameTriggerMode": self.frame_trigger_mode,
            "hardwareEncoderConnected": False,
            "absoluteLongitudinalScaleVerified": False,
            "warmupRounds": self.synchronization_warmup_rounds,
            "warmupRemaining": warmup_remaining,
            "windowRounds": len(window),
            "completeRounds": complete_rounds,
            "incompleteRounds": len(window) - complete_rounds,
            "completenessPercent": round(100.0 * complete_rounds / len(window), 3) if window else 0.0,
            "frameCounts": counts,
            "frameCountSkew": frame_count_skew,
            "transportFrameGapCounts": transport_gap_counts,
            "transportFrameGaps": sum(transport_gap_counts.values()),
            "lifetimeTransportFrameGapCounts": lifetime_transport_gap_counts,
            "lifetimeTransportFrameGaps": sum(lifetime_transport_gap_counts.values()),
            "lastRound": last,
        }

    def _acquisition_loop(self) -> None:
        self.capture_lock.acquire()
        self._log("info", "SICK shared continuous acquisition started")
        pre_entry_cache: deque[list[dict[str, Any]]] = deque(
            maxlen=max(1, self.steel_pre_roll_frames)
        )
        frozen_pre_entry: list[list[dict[str, Any]]] = []
        entry_candidate_cache: list[list[dict[str, Any]]] = []
        # Retain only a small, fixed number of no-signal rounds for steel-out
        # debounce and tail recovery. Raw 3D rounds are large, so this cache
        # must never grow with the main write backlog.
        exit_cache: deque[list[dict[str, Any]]] = deque(
            maxlen=self.black_frame_cache_rounds
        )
        try:
            while not self.acquisition_stop.is_set():
                with self.state_lock:
                    continuous = self.capture_mode == "continuous"
                    persist_frame = continuous and self.steel_present and self.save_enabled
                    material_id = self.active_material_id
                    session_id = self.active_session_id
                    save_generation = self.save_generation if persist_frame else None
                with self.stream_lock:
                    stream_key = self.stream_camera_key
                if not continuous and not stream_key:
                    break
                selected = (
                    list(self.profile.enabled_cameras)
                    if continuous
                    else [camera for camera in self.profile.enabled_cameras if camera.key == stream_key]
                )
                selected = [camera for camera in selected if camera.key in self.sessions]
                if not selected:
                    self.acquisition_stop.wait(0.25)
                    continue
                with self.state_lock:
                    self.continuous_round += 1
                    round_index = self.continuous_round
                payload = {
                    "productionLayout": persist_frame,
                    "requireSteelPresent": persist_frame,
                    "materialId": material_id,
                    "sessionId": session_id,
                    "timeoutMs": self.profile.timeout_ms,
                    "retries": (
                        self.startup_capture_retries
                        if round_index <= self.synchronization_warmup_rounds
                        else 0
                    ),
                    "discardBlackFrames": True,
                    "blackFrameThreshold": self.profile.black_frame_threshold,
                    "_persistFrame": persist_frame,
                    "_retainRawFrame": continuous,
                    "_deferPersistence": continuous and persist_frame,
                }
                results = self._run_capture_round(
                    selected,
                    payload,
                    round_index,
                    save_generation,
                )
                if continuous:
                    self._record_continuous_round(results, persist_frame)
                    self._record_synchronization_round(results)
                    received = [row for row in results if bool(row.get("frameReceived"))]
                    signal_cameras = sum(bool(row.get("steelSignal")) for row in received)
                    required = min(self.steel_min_cameras, len(received)) if received else 1
                    was_present = persist_frame
                    if not was_present:
                        if signal_cameras >= required:
                            if not entry_candidate_cache:
                                frozen_pre_entry = (
                                    list(pre_entry_cache)[-self.steel_pre_roll_frames :]
                                    if self.steel_pre_roll_frames
                                    else []
                                )
                            entry_candidate_cache.append(results)
                            entry_candidate_cache = entry_candidate_cache[
                                -self.steel_entry_rounds :
                            ]
                        elif received:
                            if self.steel_pre_roll_frames:
                                for cached_rows in entry_candidate_cache:
                                    pre_entry_cache.append(cached_rows)
                                pre_entry_cache.append(results)
                            entry_candidate_cache.clear()
                            frozen_pre_entry.clear()
                    elif received and signal_cameras == 0:
                        if len(exit_cache) < self.steel_post_roll_frames:
                            exit_cache.append(results)
                    else:
                        exit_cache.clear()
                        if received and signal_cameras > 0:
                            self._enqueue_storage_round(
                                results,
                                material_id=material_id,
                                session_id=session_id,
                                boundary_phase="normal",
                                # Steel presence is decided once for the whole
                                # synchronized camera round.  Filtering again
                                # per camera created unequal six-camera frame
                                # sets whenever one valid view was darker.
                                require_steel_signal=False,
                            )
                    self._evaluate_grayscale_steel(results)
                    with self.state_lock:
                        now_present = self.steel_present
                        active_material_id = self.active_material_id
                        active_session_id = self.active_session_id
                    if not was_present and now_present:
                        cached_rounds = [*frozen_pre_entry, *entry_candidate_cache]
                        for cache_index, cached_rows in enumerate(cached_rounds):
                            pre_count = len(frozen_pre_entry)
                            phase = "pre-roll"
                            if cache_index >= pre_count:
                                phase = (
                                    "entry-trigger"
                                    if cache_index == len(cached_rounds) - 1
                                    else "entry-candidate"
                                )
                            self._enqueue_storage_round(
                                cached_rows,
                                material_id=active_material_id,
                                session_id=active_session_id,
                                boundary_phase=phase,
                                force=True,
                            )
                        pre_entry_cache.clear()
                        frozen_pre_entry.clear()
                        entry_candidate_cache.clear()
                        exit_cache.clear()
                    elif was_present and not now_present:
                        post_roll_candidates = [
                            cached_rows
                            for cached_rows in exit_cache
                            if any(
                                float(row.get("maxIntensity", 0.0))
                                > self.profile.black_frame_threshold
                                for row in cached_rows
                            )
                        ][: self.steel_post_roll_frames]
                        for cached_rows in post_roll_candidates:
                            self._enqueue_storage_round(
                                cached_rows,
                                material_id=material_id,
                                session_id=session_id,
                                boundary_phase="post-roll",
                                force=True,
                            )
                        exit_cache.clear()
                if results and all(not row.get("frameReceived") for row in results):
                    self.acquisition_stop.wait(0.05)
        finally:
            self.capture_lock.release()
            self._log("info", "SICK shared continuous acquisition stopped")

    def _selected_cameras(self, payload: dict[str, Any]) -> list[CameraProfile]:
        requested = payload.get("ips", payload.get("cameras"))
        if requested is None:
            return list(self.profile.enabled_cameras)
        if not isinstance(requested, list) or not requested:
            raise ValueError("ips/cameras must be a non-empty array")
        selected: list[CameraProfile] = []
        for value in requested:
            identity = value
            if isinstance(value, dict):
                identity = value.get("ip", value.get("cameraId", value.get("serialNumber", "")))
            camera = self.camera_for_identity(str(identity))
            if camera is None:
                raise ValueError(f"unknown SICK camera identity: {identity}")
            if camera not in selected:
                selected.append(camera)
        return selected

    def _capture_one(
        self,
        camera: CameraProfile,
        payload: dict[str, Any],
        round_index: int,
        parallel_index: int,
        barrier: threading.Barrier,
        save_generation: int | None,
    ) -> dict[str, Any]:
        timeout_ms = _integer(payload, "timeoutMs", self.profile.timeout_ms, 100, 600_000)
        retries = _integer(payload, "retries", 0, 0, 10)
        production_layout = bool(payload.get("productionLayout", False))
        material_id = str(payload.get("materialId", self.active_material_id or "diagnostic")).strip()
        session_id = str(payload.get("sessionId", self.active_session_id)).strip()
        output_dir = str(payload.get("outputDir", "continuous-test")).strip() or "continuous-test"
        persist_frame = bool(payload.get("_persistFrame", True))
        camera_root = (
            camera.storage_root
            if production_layout
            else self.profile.storage_root / _safe_segment(output_dir) / camera.key
        )
        barrier.wait(timeout=max(10.0, timeout_ms / 1000.0 + 2.0))
        started_ns = time.time_ns()
        last_error: Exception | None = None
        for capture_attempt in range(1, retries + 2):
            try:
                session = self.sessions.get(camera.key)
                if session is None:
                    raise RuntimeError(f"SICK camera is not connected: {camera.key}")
                frame = session.fetch_frame(timeout_ms)
                self._count_frames(received=1)
                captured_at = _utc_text()
                frame_telemetry = {
                    "cameraFrameSequence": frame.sequence,
                    "transportFrameId": frame.transport_frame_id,
                    "transportFrameGap": frame.transport_frame_gap,
                    "deviceTimestamp": frame.timestamp,
                    "timestampFrequency": frame.timestamp_frequency,
                    "hostUtcNs": frame.host_utc_ns,
                    "hostMonotonicNs": frame.host_monotonic_ns,
                    "frameTriggerMode": frame.frame_trigger_mode,
                    "triggerIssuedNs": frame.trigger_issued_ns,
                    "triggerCompletedNs": frame.trigger_completed_ns,
                    "triggerCommandLatencyUs": round(
                        max(0, frame.trigger_completed_ns - frame.trigger_issued_ns)
                        / 1000.0,
                        3,
                    )
                    if frame.trigger_issued_ns > 0
                    else None,
                }
                mean_intensity = float(np.mean(frame.intensity))
                max_intensity = float(np.max(frame.intensity)) if frame.intensity.size else 0.0
                (
                    steel_detection_max_intensity,
                    bright_pixel_ratio,
                    steel_detection_rows,
                ) = _steel_tail_metrics(
                    frame.intensity,
                    edge=self.steel_detection_edge,
                    rows=self.steel_detection_tail_rows,
                    bright_threshold=self.steel_bright_threshold,
                )
                steel_signal = (
                    steel_detection_max_intensity > self.steel_bright_threshold
                    and bright_pixel_ratio >= self.steel_bright_ratio
                )
                frame_telemetry.update(
                    {
                        "steelDetectionRegion": "tail-rows",
                        "steelDetectionEdge": self.steel_detection_edge,
                        "steelDetectionRows": steel_detection_rows,
                        "steelDetectionMaxIntensity": steel_detection_max_intensity,
                    }
                )
                retained_frame = (
                    {"_rawFrame": frame}
                    if bool(payload.get("_retainRawFrame", False))
                    else {}
                )
                if steel_signal:
                    self._schedule_stream_frame(camera, frame)
                if save_generation is not None:
                    with self.state_lock:
                        still_armed = (
                            self.save_enabled and self.save_generation == save_generation
                        )
                    if not still_armed:
                        self._count_frames(failed=1)
                        return {
                            "code": CAPTURE_DISCARDED_NOT_ARMED,
                            "errorName": "CAPTURE_DISCARDED_NOT_ARMED",
                            "operatorHint": "steel-out or a new steel-in arrived during capture",
                            "cameraId": camera.camera_id,
                            "cameraKey": camera.key,
                            "ip": camera.ip,
                            "sn": camera.serial_number,
                            "round": round_index,
                            "parallelIndex": parallel_index,
                            "captureAttempts": capture_attempt,
                            "completeFrame": False,
                            "depthExists": False,
                            "intensityExists": False,
                            "metadataExists": False,
                            "frameReceived": True,
                            "discarded": True,
                            "discardReason": "save-disabled-before-storage",
                            "meanIntensity": mean_intensity,
                            "maxIntensity": max_intensity,
                            "brightPixelRatio": bright_pixel_ratio,
                            "steelSignal": steel_signal,
                            "capturedAt": captured_at,
                            **frame_telemetry,
                            **retained_frame,
                        }
                if not persist_frame:
                    return {
                        "code": 0,
                        "errorName": "CORRECT",
                        "operatorHint": "live frame acquired without persistence",
                        "cameraId": camera.camera_id,
                        "cameraKey": camera.key,
                        "ip": camera.ip,
                        "sn": camera.serial_number,
                        "round": round_index,
                        "parallelIndex": parallel_index,
                        "captureAttempts": capture_attempt,
                        "completeFrame": False,
                        "depthExists": False,
                        "intensityExists": False,
                        "metadataExists": False,
                        "frameReceived": True,
                        "discarded": True,
                        "discardReason": "save-disabled",
                        "meanIntensity": mean_intensity,
                        "maxIntensity": max_intensity,
                        "brightPixelRatio": bright_pixel_ratio,
                        "steelSignal": steel_signal,
                        "capturedAt": captured_at,
                        "workerStartedNs": started_ns,
                        "workerCompletedNs": time.time_ns(),
                        **frame_telemetry,
                        **retained_frame,
                    }
                if bool(payload.get("discardBlackFrames", False)):
                    threshold = float(
                        payload.get("blackFrameThreshold", self.profile.black_frame_threshold)
                    )
                    if max_intensity <= threshold:
                        with self.state_lock:
                            self.black_frame_count += 1
                        return {
                            "code": BLACK_FRAME_DISCARDED,
                            "errorName": "BLACK_FRAME_DISCARDED",
                            "operatorHint": "intensity maximum is below blackFrameThreshold",
                            "cameraId": camera.camera_id,
                            "cameraKey": camera.key,
                            "ip": camera.ip,
                            "sn": camera.serial_number,
                            "round": round_index,
                            "parallelIndex": parallel_index,
                            "captureAttempts": capture_attempt,
                            "completeFrame": False,
                            "depthExists": False,
                            "intensityExists": False,
                            "metadataExists": False,
                            "frameReceived": True,
                            "discarded": True,
                            "discardReason": "black-frame",
                            "meanIntensity": mean_intensity,
                            "maxIntensity": max_intensity,
                            "brightPixelRatio": bright_pixel_ratio,
                            "steelSignal": steel_signal,
                            "blackFrameThreshold": threshold,
                            "capturedAt": captured_at,
                            "workerStartedNs": started_ns,
                            "workerCompletedNs": time.time_ns(),
                            **frame_telemetry,
                            **retained_frame,
                        }
                if bool(payload.get("_deferPersistence", False)):
                    return {
                        "code": 0,
                        "errorName": "CORRECT",
                        "operatorHint": "frame accepted by the ordered storage cache",
                        "cameraId": camera.camera_id,
                        "cameraKey": camera.key,
                        "ip": camera.ip,
                        "sn": camera.serial_number,
                        "round": round_index,
                        "parallelIndex": parallel_index,
                        "captureAttempts": capture_attempt,
                        "completeFrame": False,
                        "depthExists": False,
                        "intensityExists": False,
                        "metadataExists": False,
                        "frameReceived": True,
                        "discarded": False,
                        "storageQueued": True,
                        "meanIntensity": mean_intensity,
                        "maxIntensity": max_intensity,
                        "brightPixelRatio": bright_pixel_ratio,
                        "steelSignal": steel_signal,
                        "capturedAt": captured_at,
                        "workerStartedNs": started_ns,
                        "workerCompletedNs": time.time_ns(),
                        **frame_telemetry,
                        **retained_frame,
                    }
                if (
                    bool(payload.get("requireSteelPresent", False))
                    and self.grayscale_steel_detection
                    and not steel_signal
                ):
                    return {
                        "code": NO_STEEL_FRAME_DISCARDED,
                        "errorName": "NO_STEEL_FRAME_DISCARDED",
                        "operatorHint": "grayscale frame does not contain the configured steel area",
                        "cameraId": camera.camera_id,
                        "cameraKey": camera.key,
                        "ip": camera.ip,
                        "sn": camera.serial_number,
                        "round": round_index,
                        "parallelIndex": parallel_index,
                        "captureAttempts": capture_attempt,
                        "completeFrame": False,
                        "depthExists": False,
                        "intensityExists": False,
                        "metadataExists": False,
                        "frameReceived": True,
                        "discarded": True,
                        "discardReason": "no-steel-frame",
                        "meanIntensity": mean_intensity,
                        "maxIntensity": max_intensity,
                        "brightPixelRatio": bright_pixel_ratio,
                        "steelSignal": False,
                        "capturedAt": captured_at,
                        "workerStartedNs": started_ns,
                        "workerCompletedNs": time.time_ns(),
                        **frame_telemetry,
                        **retained_frame,
                    }
                result = self.writer.write(
                    camera_root,
                    material_id,
                    frame,
                    session_id=session_id,
                    production_event_id=str(
                        payload.get("productionEventId", payload.get("inspectionId", ""))
                    ),
                    inspection_id=str(
                        payload.get("inspectionId", f"INSP-{session_id}" if session_id else "")
                    ),
                    capture_round=round_index,
                    sync_group_id=str(
                        payload.get(
                            "syncGroupId",
                            f"{session_id or material_id}:round-{round_index:012d}",
                        )
                    ),
                )
                row = result.provider_row(frame, round_index)
                row.update(
                    {
                        "parallelIndex": parallel_index,
                        "captureAttempts": capture_attempt,
                        "workerStartedNs": started_ns,
                        "workerCompletedNs": time.time_ns(),
                        "frameReceived": True,
                        "discarded": False,
                        "meanIntensity": mean_intensity,
                        "maxIntensity": max_intensity,
                        "brightPixelRatio": bright_pixel_ratio,
                        "steelSignal": steel_signal,
                        "capturedAt": captured_at,
                        **frame_telemetry,
                        **retained_frame,
                    }
                )
                self._count_frames(committed=1)
                return row
            except FileExistsError as error:
                last_error = error
                break
            except Exception as error:
                last_error = error
                if capture_attempt <= retries:
                    continue
        self._count_frames(failed=1)
        message = str(last_error or "unknown SICK capture error")
        self.last_error = message
        code = (
            SICK_COMPONENT_SCHEMA_MISMATCH
            if "component schema mismatch" in message
            else SICK_STORAGE_FAILED
            if isinstance(last_error, (FileExistsError, OSError))
            else SICK_CAPTURE_FAILED
        )
        self._log(
            "error",
            "SICK frame capture failed",
            cameraKey=camera.key,
            round=round_index,
            error=message,
        )
        return {
            "code": code,
            "errorName": "SICK_CAPTURE_FAILED",
            "operatorHint": message,
            "cameraId": camera.camera_id,
            "cameraKey": camera.key,
            "ip": camera.ip,
            "sn": camera.serial_number,
            "round": round_index,
            "parallelIndex": parallel_index,
            "captureAttempts": retries + 1,
            "completeFrame": False,
            "depthExists": False,
            "intensityExists": False,
            "metadataExists": False,
            "frameReceived": False,
            "workerStartedNs": started_ns,
            "workerCompletedNs": time.time_ns(),
        }

    def _run_capture_round(
        self,
        selected: list[CameraProfile],
        payload: dict[str, Any],
        round_index: int,
        save_generation: int | None,
    ) -> list[dict[str, Any]]:
        barrier = threading.Barrier(len(selected))
        results: list[dict[str, Any]] = []
        futures = [
            self.capture_pool.submit(
                self._capture_one,
                camera,
                payload,
                round_index,
                parallel_index,
                barrier,
                save_generation,
            )
            for parallel_index, camera in enumerate(selected)
        ]
        for future in as_completed(futures):
            results.append(future.result())
        results.sort(key=lambda row: int(row.get("parallelIndex", 0)))
        return results

    def continuous_capture(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if not self.capture_lock.acquire(blocking=False):
            return 409, {"code": 409, "error": "capture_already_running"}
        try:
            selected = self._selected_cameras(payload)
            expected = _integer(
                payload,
                "expectedCameras",
                self.profile.expected_cameras,
                1,
                24,
            )
            if len(selected) != expected:
                return 409, {
                    "code": 409,
                    "error": "expected_camera_count_mismatch",
                    "expectedCameras": expected,
                    "selectedCameras": len(selected),
                }
            if bool(payload.get("connectFirst", False)) or any(
                camera.key not in self.sessions for camera in selected
            ):
                self.connect_all()
            if any(camera.key not in self.sessions for camera in selected):
                return 503, {
                    "code": 503,
                    "error": "sick_cameras_not_connected",
                    "cameras": [self._camera_row(camera) for camera in selected],
                }
            require_steel = bool(payload.get("requireSteelPresent", False))
            with self.state_lock:
                save_generation = self.save_generation if require_steel else None
                save_enabled = self.save_enabled
            if require_steel and not save_enabled:
                return 409, {
                    "code": CAPTURE_DISCARDED_NOT_ARMED,
                    "error": "capture_discarded_not_armed",
                    "message": "send steel-in before production capture",
                }
            if bool(payload.get("productionLayout", False)) and self.capture_mode == "disabled":
                return 409, {
                    "code": 409,
                    "error": "capture_mode_disabled",
                }

            rounds = _integer(payload, "rounds", 1, 1, 10_000)
            interval_ms = _integer(payload, "intervalMs", 0, 0, 600_000)
            results: list[dict[str, Any]] = []
            started_at = _utc_text()
            started_monotonic_ns = time.monotonic_ns()
            for round_index in range(1, rounds + 1):
                results.extend(
                    self._run_capture_round(
                        selected,
                        payload,
                        round_index,
                        save_generation,
                    )
                )
                if interval_ms and round_index < rounds:
                    time.sleep(interval_ms / 1000.0)
            results.sort(key=lambda row: (int(row.get("round", 0)), int(row.get("parallelIndex", 0))))
            complete_frames = sum(bool(row.get("completeFrame")) for row in results)
            metadata_frames = sum(bool(row.get("metadataExists")) for row in results)
            failures = len(results) - complete_frames
            black_frames = sum(
                int(row.get("code", 0)) == BLACK_FRAME_DISCARDED for row in results
            )
            discarded_frames = sum(
                int(row.get("code", 0))
                in {
                    CAPTURE_DISCARDED_NOT_ARMED,
                    BLACK_FRAME_DISCARDED,
                    NO_STEEL_FRAME_DISCARDED,
                }
                for row in results
            )
            material_id = str(payload.get("materialId", self.active_material_id or "diagnostic"))
            session_id = str(payload.get("sessionId", self.active_session_id or "diagnostic"))
            production_layout = bool(payload.get("productionLayout", False))
            if production_layout:
                summary_path = (
                    self.profile.storage_root
                    / "production"
                    / _safe_segment(material_id)
                    / _safe_segment(session_id)
                    / "summary.json"
                )
            else:
                summary_path = (
                    self.profile.storage_root
                    / _safe_segment(str(payload.get("outputDir", "continuous-test")))
                    / "summary.json"
                )
            failed_code = next(
                (
                    int(row.get("code", SICK_CAPTURE_FAILED))
                    for row in results
                    if not bool(row.get("completeFrame"))
                ),
                0,
            )
            summary: dict[str, Any] = {
                "schema": "steel.sick-capture.summary.v1",
                "code": failed_code,
                "errorName": "CORRECT" if failures == 0 else "SICK_CAPTURE_FAILED",
                "operatorHint": "ok" if failures == 0 else "one or more SICK frames failed",
                "provider": "sick-gentl",
                "driverMode": "sick-gentl",
                "driverId": "sick-gentl-harvesters",
                "storageRoot": str(self.profile.storage_root),
                "materialId": material_id,
                "sessionId": session_id,
                "startedAt": started_at,
                "finishedAt": _utc_text(),
                "attempts": len(results),
                "successes": complete_frames,
                "failures": failures,
                "completeFrames": complete_frames,
                "metadataFrames": metadata_frames,
                "storageAsyncFrames": 0,
                "discardedFrames": discarded_frames,
                "blackFrames": black_frames,
                "rounds": rounds,
                "retries": int(payload.get("retries", 0) or 0),
                "cameraCount": len(selected),
                "expectedCameras": expected,
                "expectedMet": failures == 0 and complete_frames == rounds * expected,
                "connectFirst": bool(payload.get("connectFirst", False)),
                "saveSdkDerived": False,
                "roundIntervalMs": interval_ms,
                "elapsedMs": round((time.monotonic_ns() - started_monotonic_ns) / 1_000_000, 3),
                "workerCount": len(selected),
                "parallel": True,
                "syncMode": "round-start-barrier+sick-gentl+atomic-dual-writer",
                "frameTransaction": True,
                "metadataCommitLast": True,
                "lg3dCompatible": True,
                "results": results,
                "summaryOutput": str(summary_path),
                "summaryExists": False,
            }
            atomic_summary(summary_path, summary, fsync=self.profile.fsync)
            summary["summaryExists"] = summary_path.is_file()
            atomic_summary(summary_path, summary, fsync=self.profile.fsync)
            return 200, summary
        except ValueError as error:
            return 400, {"code": 400, "error": str(error)}
        finally:
            self.capture_lock.release()

    def capture_once(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        request = dict(payload)
        identity = str(
            request.get("ip", request.get("cameraId", request.get("serialNumber", "")))
        ).strip()
        if identity:
            request["ips"] = [identity]
        elif self.profile.expected_cameras > 1:
            request["ips"] = [self.profile.enabled_cameras[0].camera_id]
        request["expectedCameras"] = 1
        request["rounds"] = 1
        request.setdefault("outputDir", "preview")
        status, summary = self.continuous_capture(request)
        results = summary.get("results") if isinstance(summary, dict) else None
        if status == 200 and isinstance(results, list) and results:
            return status, {**results[0], "summaryOutput": summary.get("summaryOutput", "")}
        return status, summary

    def profile_status(self) -> dict[str, Any]:
        return {
            "code": 0,
            "driverMode": "sick-gentl",
            "driverId": "sick-gentl-harvesters",
            "activeProfile": self.profile.name,
            "profilePath": str(self.profile.source_path),
            "profiles": [self.profile.name],
            "expectedCameras": self.profile.expected_cameras,
        }

    def _camera_read_roots(self, camera: CameraProfile) -> list[Path]:
        """Return the active disk first and the former shared-D root second."""
        roots = [camera.storage_root]
        legacy_root = self.profile.storage_root / camera.key
        if legacy_root.resolve() != camera.storage_root.resolve():
            roots.append(legacy_root)
        return roots

    def _recent_camera_files(
        self,
        camera: CameraProfile,
        *,
        directories: tuple[str, ...],
        suffixes: tuple[str, ...],
        limit: int,
        material_limit: int = 32,
    ) -> list[Path]:
        """Return recent artifacts without walking every historical frame.

        A camera disk can contain hundreds of flows and tens of thousands of
        PNG/NPZ files.  Expanding ``*/2d/*.png`` before sorting made the first
        live preview wait behind a full archive scan.  Material directories
        are cheap to enumerate, so inspect only the newest bounded set and
        then rank the contained artifacts.
        """
        material_dirs: list[tuple[int, Path]] = []
        for root in self._camera_read_roots(camera):
            try:
                for candidate in root.iterdir():
                    if candidate.is_dir():
                        material_dirs.append((candidate.stat().st_mtime_ns, candidate))
            except OSError:
                continue
        material_dirs.sort(key=lambda item: item[0], reverse=True)

        normalized_suffixes = {suffix.lower() for suffix in suffixes}
        candidates: list[tuple[int, Path]] = []
        for _, material_dir in material_dirs[: max(1, material_limit)]:
            for directory in directories:
                artifact_dir = material_dir / directory
                try:
                    for path in artifact_dir.iterdir():
                        if path.suffix.lower() not in normalized_suffixes or not path.is_file():
                            continue
                        candidates.append((path.stat().st_mtime_ns, path))
                except OSError:
                    continue
            # One or two recent flows normally contain more than enough
            # candidates.  Bound directory I/O while retaining head/tail
            # frames that may be dark and skipped by the preview filter.
            if len(candidates) >= max(limit * 2, limit + 32):
                break
        candidates.sort(key=lambda item: item[0], reverse=True)
        return [path for _, path in candidates[:limit]]

    def latest_file(self, query: dict[str, list[str]]) -> Path | None:
        identity = (query.get("ip") or query.get("cameraId") or [""])[0]
        kind = (query.get("kind") or ["intensity"])[0]
        camera = self.camera_for_identity(identity) if identity else self.profile.enabled_cameras[0]
        if camera is None or kind not in {"depth", "intensity", "metadata", "3d", "2d", "json"}:
            return None
        directory = {"3d": "3d", "2d": "2d", "json": "json"}.get(kind, kind)
        suffixes = {
            "depth": (".png", ".npz"),
            "intensity": (".png", ".jpg", ".jpeg"),
            "metadata": (".json",),
            "3d": (".npz",),
            "2d": (".png", ".jpg", ".jpeg"),
            "json": (".json",),
        }[kind]
        directories = (directory, "2d") if kind == "intensity" else (directory,)
        candidates = self._recent_camera_files(
            camera,
            directories=directories,
            suffixes=suffixes,
            limit=1,
        )
        return candidates[0] if candidates else None

    @staticmethod
    def _file_time_text(timestamp: float) -> str:
        import datetime as dt

        return (
            dt.datetime.fromtimestamp(timestamp, tz=dt.timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )

    @staticmethod
    def _png_dimensions(path: Path) -> tuple[int, int] | None:
        with path.open("rb") as stream:
            header = stream.read(24)
        if (
            len(header) != 24
            or header[:8] != b"\x89PNG\r\n\x1a\n"
            or header[12:16] != b"IHDR"
        ):
            return None
        width = int.from_bytes(header[16:20], "big")
        height = int.from_bytes(header[20:24], "big")
        return (width, height) if width > 0 and height > 0 else None

    def _scan_capture_history(
        self,
        max_frames: int,
        material_id: str = "",
    ) -> tuple[list[dict[str, Any]], bool]:
        grouped: dict[tuple[str, int], dict[str, Any]] = {}
        materials: dict[str, list[tuple[CameraProfile, Path, Path, bool]]] = {}
        material_modified: dict[str, int] = {}
        for camera in self.profile.enabled_cameras:
            for read_root in self._camera_read_roots(camera):
                active_root = read_root.resolve() == camera.storage_root.resolve()
                try:
                    material_roots = (
                        [read_root / material_id]
                        if material_id
                        else [path for path in read_root.iterdir() if path.is_dir()]
                    )
                except OSError:
                    continue
                for material_root in material_roots:
                    if not material_root.is_dir():
                        continue
                    try:
                        modified = material_root.stat().st_mtime_ns
                    except OSError:
                        continue
                    materials.setdefault(material_root.name, []).append(
                        (camera, read_root, material_root, active_root)
                    )
                    material_modified[material_root.name] = max(
                        material_modified.get(material_root.name, 0),
                        modified,
                    )
        ordered_materials = sorted(
            materials,
            key=lambda name: material_modified.get(name, 0),
            reverse=True,
        )
        has_more = False
        for material_index, material_name in enumerate(ordered_materials):
            for camera, read_root, material_root, active_root in materials[material_name]:
                self._append_history_material(
                    grouped,
                    camera,
                    read_root,
                    material_root,
                    active_root,
                    max_frames,
                )
            if len(grouped) >= max_frames:
                has_more = material_index + 1 < len(ordered_materials)
                break
        frames = sorted(grouped.values(), key=lambda frame: int(frame["sortNs"]))
        for frame in frames:
            frame["cameras"].sort(key=lambda item: int(item["cameraIndex"]))
            frame.pop("sortNs", None)
        return frames, has_more

    def _append_history_material(
        self,
        grouped: dict[tuple[str, int], dict[str, Any]],
        camera: CameraProfile,
        read_root: Path,
        material_root: Path,
        active_root: bool,
        max_frames: int,
    ) -> None:
        image_roots = [
            (root, zero_based)
            for root, zero_based in (
                (material_root / "intensity", False),
                (material_root / "2d", True),
            )
            if root.is_dir()
        ]
        for image_root, zero_based_2d in image_roots:
            try:
                numbered_paths: list[tuple[int, Path]] = []
                for path in image_root.iterdir():
                    if path.is_symlink() or path.suffix.lower() != ".png":
                        continue
                    try:
                        sequence = int(path.stem) + (1 if zero_based_2d else 0)
                    except ValueError:
                        continue
                    numbered_paths.append((sequence, path))
                # Only the newest requested frames can appear in the response.
                # Avoid stat/open work for every historical image in a long run.
                numbered_paths.sort(key=lambda item: item[0], reverse=True)
                paths = [path for _, path in numbered_paths[:max_frames]]
            except OSError:
                continue
            dimensions = None
            for path in paths:
                try:
                    dimensions = self._png_dimensions(path)
                except OSError:
                    continue
                if dimensions is not None:
                    break
            if dimensions is None:
                continue
            self._append_history_images(
                grouped,
                camera,
                read_root,
                material_root,
                paths,
                zero_based_2d,
                dimensions,
                active_root,
            )

    def _append_history_images(
        self,
        grouped: dict[tuple[str, int], dict[str, Any]],
        camera: CameraProfile,
        read_root: Path,
        material_root: Path,
        paths: list[Path],
        zero_based_2d: bool,
        dimensions: tuple[int, int],
        active_root: bool,
    ) -> None:
        width, height = dimensions
        for path in paths:
            try:
                sequence = int(path.stem) + (1 if zero_based_2d else 0)
                stat = path.stat()
            except (OSError, ValueError):
                continue
            key = (material_root.name, sequence)
            frame = grouped.setdefault(
                key,
                {
                    "frameId": f"{material_root.name}:{sequence:06d}",
                    "materialId": material_root.name,
                    "sequence": sequence,
                    "capturedAt": self._file_time_text(stat.st_mtime),
                    "sortNs": stat.st_mtime_ns,
                    "cameras": [],
                },
            )
            if stat.st_mtime_ns > int(frame["sortNs"]):
                frame["sortNs"] = stat.st_mtime_ns
                frame["capturedAt"] = self._file_time_text(stat.st_mtime)
            frame["cameras"].append(
                {
                    "cameraId": camera.camera_id,
                    "cameraIndex": camera.camera_index,
                    "ip": camera.ip,
                    "artifactRef": (
                        f"{camera.key}/{path.relative_to(read_root).as_posix()}"
                        if active_root
                        else str(path)
                    ),
                    "width": width,
                    "height": height,
                    "bytes": stat.st_size,
                    "storedAt": self._file_time_text(stat.st_mtime),
                }
            )

    def _refresh_history_cache(self, limit: int, material_id: str) -> None:
        try:
            frames, has_more = self._scan_capture_history(limit, material_id)
        except Exception as error:
            self._log("warning", "capture history refresh failed", error=str(error))
            return
        with self.history_lock:
            if self.history_cache_material_id != material_id:
                return
            self.history_cache = frames
            self.history_cache_has_more = has_more
            self.history_cache_at = time.monotonic()
            self.history_cache_limit = limit

    def _schedule_history_refresh(self, limit: int, material_id: str) -> None:
        with self.history_lock:
            if self.history_refresh_future is not None and not self.history_refresh_future.done():
                return
            self.history_refresh_future = self.history_refresh_pool.submit(
                self._refresh_history_cache,
                limit,
                material_id,
            )

    def capture_history_json(self, query: dict[str, list[str]]) -> dict[str, Any]:
        try:
            limit = max(1, min(500, int((query.get("limit") or ["240"])[0])))
        except (TypeError, ValueError):
            limit = 240
        material_id = (query.get("materialId") or [""])[0].strip()
        catalog_path = playback_catalog_path(self.profile.storage_root)
        try:
            catalog_mtime_ns = catalog_path.stat().st_mtime_ns
        except OSError:
            catalog_mtime_ns = 0
        indexed_key = (limit, material_id, catalog_mtime_ns)
        with self.history_lock:
            cached_indexed = self.indexed_history_cache.get(indexed_key)
            if cached_indexed is not None:
                self.indexed_history_cache.move_to_end(indexed_key)
                return cached_indexed
        indexed = read_indexed_history(self.profile.storage_root, limit, material_id)
        if indexed is not None:
            frames, has_more, total = indexed
            result = {
                "code": 0,
                "storageRoot": str(self.profile.storage_root),
                "total": total,
                "count": len(frames),
                "hasMore": has_more,
                "refreshing": False,
                "indexed": True,
                "catalogPath": str(playback_catalog_path(self.profile.storage_root)),
                "frames": frames,
            }
            with self.history_lock:
                self.indexed_history_cache[indexed_key] = result
                self.indexed_history_cache.move_to_end(indexed_key)
                while len(self.indexed_history_cache) > 16:
                    self.indexed_history_cache.popitem(last=False)
            return result
        scan_now = False
        refreshing = False
        with self.history_lock:
            cache_stale = (
                self.history_cache_at <= 0
                or time.monotonic() - self.history_cache_at >= 5.0
                or self.history_cache_material_id != material_id
                or self.history_cache_limit < limit
            )
            if cache_stale:
                cache_usable = (
                    self.history_cache_at > 0
                    and self.history_cache_material_id == material_id
                    and self.history_cache_limit >= limit
                )
                scan_now = not cache_usable
                refreshing = cache_usable
        if scan_now:
            frames, has_unscanned = self._scan_capture_history(limit, material_id)
            with self.history_lock:
                self.history_cache = frames
                self.history_cache_has_more = has_unscanned
                self.history_cache_at = time.monotonic()
                self.history_cache_limit = limit
                self.history_cache_material_id = material_id
        elif refreshing:
            self._schedule_history_refresh(limit, material_id)
        with self.history_lock:
            frames = list(self.history_cache)
            has_unscanned = self.history_cache_has_more
        total = len(frames) + (1 if has_unscanned else 0)
        selected = frames[-limit:]
        return {
            "code": 0,
            "storageRoot": str(self.profile.storage_root),
            "total": total,
            "count": len(selected),
            "hasMore": has_unscanned or total > len(selected),
            "refreshing": refreshing,
            "indexed": False,
            "frames": selected,
        }

    def optimized_playback_image(
        self,
        path: Path,
        max_width: int,
    ) -> tuple[str, bytes] | None:
        if path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            return None
        stat = path.stat()
        fingerprint = source_fingerprint(path, self.playback_cache_root)
        key = (str(path), stat.st_mtime_ns, max_width, fingerprint)
        with self.history_lock:
            cached = self.playback_image_cache.get(key)
            if cached is not None:
                self.playback_image_cache.move_to_end(key)
                self.playback_cache_memory_hits += 1
                return cached
        build_lock = self.playback_cache_build_locks[
            int(fingerprint[:2], 16) % len(self.playback_cache_build_locks)
        ]
        with build_lock:
            existing = read_image_pyramid(self.playback_cache_root, fingerprint)
            disk_hit = existing is not None
            cache_succeeded = False
            started = time.monotonic()
            try:
                if existing is None:
                    manifest_path, manifest = self.playback_compute_pool.submit(
                        build_image_pyramid,
                        path,
                        self.playback_cache_root,
                    ).result()
                else:
                    manifest_path, manifest = existing
                selected_path, _ = select_pyramid_image(manifest_path, manifest, max_width)
                result = ("image/jpeg", selected_path.read_bytes())
                cache_succeeded = True
            except Exception as error:
                with self.history_lock:
                    self.playback_cache_build_failures += 1
                self._log(
                    "warning",
                    "playback pyramid build failed; serving transient preview",
                    path=str(path),
                    error=str(error),
                )
                output = io.BytesIO()
                with Image.open(path) as source:
                    converted = source.convert("L")
                    try:
                        if converted.width > max_width:
                            target_height = max(
                                1,
                                round(converted.height * max_width / converted.width),
                            )
                            with converted.resize(
                                (max_width, target_height), Image.Resampling.BILINEAR
                            ) as preview:
                                preview.save(output, format="JPEG", quality=84, optimize=False)
                        else:
                            converted.save(output, format="JPEG", quality=84, optimize=False)
                    finally:
                        converted.close()
                result = ("image/jpeg", output.getvalue())
            elapsed_ms = (time.monotonic() - started) * 1000.0
            if cache_succeeded:
                with self.history_lock:
                    if disk_hit:
                        self.playback_cache_disk_hits += 1
                    else:
                        self.playback_cache_builds += 1
                        self.playback_cache_build_ms.append(elapsed_ms)
        with self.history_lock:
            self.playback_image_cache[key] = result
            self.playback_image_cache.move_to_end(key)
            while len(self.playback_image_cache) > 384:
                self.playback_image_cache.popitem(last=False)
        return result

    def playback_cache_status_json(self) -> dict[str, Any]:
        with self.history_lock:
            build_samples = list(self.playback_cache_build_ms)
            return {
                "code": 0,
                "schema": "steel.capture-playback-cache-status.v1",
                "cacheRoot": str(self.playback_cache_root / "playback-pyramid" / "v1"),
                "catalogPath": str(playback_catalog_path(self.profile.storage_root)),
                "catalogAvailable": playback_catalog_path(self.profile.storage_root).is_file(),
                "memoryEntries": len(self.playback_image_cache),
                "memoryHits": self.playback_cache_memory_hits,
                "diskHits": self.playback_cache_disk_hits,
                "pyramidsBuilt": self.playback_cache_builds,
                "buildFailures": self.playback_cache_build_failures,
                "averageBuildMs": round(sum(build_samples) / len(build_samples), 3)
                if build_samples
                else None,
                "fullPyramidWarm": dict(self.playback_warm_status),
            }

    def allowed_file(self, value: str) -> Path | None:
        if not value:
            return None
        decoded = unquote(value)
        supplied = Path(decoded)
        if supplied.is_absolute():
            candidate = supplied.resolve()
        else:
            parts = supplied.parts
            camera = self.camera_for_identity(parts[0]) if parts else None
            if camera is None or len(parts) < 2:
                return None
            candidate = camera.storage_root.joinpath(*parts[1:]).resolve()
        if not candidate.is_file() or candidate.is_symlink():
            return None
        allowed = [self.profile.storage_root, *(camera.storage_root for camera in self.profile.enabled_cameras)]
        for root in allowed:
            resolved_root = root.resolve()
            try:
                candidate.relative_to(resolved_root)
                return candidate
            except ValueError:
                continue
        return None


class SickCaptureRequestHandler(BaseHTTPRequestHandler):
    server_version = "SteelSickCapture/1.0"
    protocol_version = "HTTP/1.1"

    @property
    def runtime(self) -> ProviderRuntime:
        return getattr(self.server, "runtime")

    def log_message(self, format: str, *args: Any) -> None:
        # UI polling can generate hundreds of successful requests per minute.
        # Keep the bounded operational event ring for capture, storage and
        # transition diagnostics instead of evicting them with access logs.
        return

    def _write_response_body(self, body: bytes) -> bool:
        """Write a response without turning cancelled UI polls into errors."""
        try:
            self.wfile.write(body)
            return True
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            return False

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self._write_response_body(body)

    def _payload(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length < 0 or length > 1024 * 1024:
            raise ValueError("request body length must be between 0 and 1 MiB")
        raw = self.rfile.read(length) if length else b"{}"
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("request body must be a JSON object")
        return payload

    def _send_file(self, path: Path) -> None:
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                if not self._write_response_body(block):
                    break

    def _send_png(self, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        self._write_response_body(body)

    def _send_immutable_image(self, content_type: str, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        self._write_response_body(body)

    def do_GET(self) -> None:  # noqa: N802
        split = urlsplit(self.path)
        path = split.path
        query = parse_qs(split.query)
        if path in {"/health", "/api/capture/health"}:
            self._send_json(200, self.runtime.health_json())
        elif path == "/api/storage/status":
            payload = self.runtime.storage_json()
            self._send_json(200 if payload["code"] == 0 else 503, payload)
        elif path == "/api/cameras":
            self._send_json(200, self.runtime.cameras_json())
        elif path == "/api/steel/status":
            self._send_json(200, self.runtime.steel_status_json())
        elif path == "/api/capture/continuous-settings":
            self._send_json(200, self.runtime.continuous_settings_json())
        elif path == "/api/capture/alignment":
            material_id = (query.get("materialId") or [""])[0]
            status, payload = self.runtime.alignment_json(material_id)
            self._send_json(status, payload)
        elif path == "/api/capture/measurement":
            material_id = (query.get("materialId") or [""])[0]
            status, payload = self.runtime.measurement_json(material_id)
            self._send_json(status, payload)
        elif path == "/api/capture/defects":
            material_id = (query.get("materialId") or [""])[0]
            status, payload = self.runtime.defect_detection_json(material_id)
            self._send_json(status, payload)
        elif path == "/api/stream/status":
            identity = (query.get("ip") or query.get("cameraId") or [""])[0]
            self._send_json(200, self.runtime.stream_status(identity))
        elif path == "/api/stream/latest":
            identity = (query.get("ip") or query.get("cameraId") or [""])[0]
            kind = (query.get("kind") or ["depth"])[0]
            body = self.runtime.stream_latest_bytes(identity, kind)
            if body is None:
                self._send_json(404, {"code": 404, "error": "stream_frame_not_ready"})
            else:
                self._send_png(body)
        elif path in {"/api/camera/status", "/api/camera/statuses"}:
            self._send_json(200, {"code": 0, "statuses": self.runtime.cameras_json()["cameras"]})
        elif path == "/api/capture/logs":
            self._send_json(200, {"code": 0, "events": list(self.runtime.events)})
        elif path in {"/api/config/status", "/api/config/profiles"}:
            self._send_json(200, self.runtime.profile_status())
        elif path == "/api/config/profile":
            self._send_json(200, self.runtime.profile.raw)
        elif path == "/api/capture/latest":
            latest = self.runtime.latest_file(query)
            if latest is None:
                self._send_json(404, {"code": 404, "error": "capture_file_not_found"})
            elif (query.get("meta") or ["0"])[0] == "1":
                self._send_json(200, {"code": 0, "path": str(latest)})
            else:
                self._send_file(latest)
        elif path == "/api/capture/history":
            self._send_json(200, self.runtime.capture_history_json(query))
        elif path == "/api/capture/cache/status":
            self._send_json(200, self.runtime.playback_cache_status_json())
        elif path == "/api/capture/file":
            allowed = self.runtime.allowed_file((query.get("path") or [""])[0])
            if allowed is None:
                self._send_json(404, {"code": 404, "error": "capture_file_not_found"})
            else:
                try:
                    max_width = int((query.get("maxWidth") or ["0"])[0])
                except (TypeError, ValueError):
                    max_width = 0
                if 160 <= max_width <= 4096:
                    optimized = self.runtime.optimized_playback_image(allowed, max_width)
                else:
                    optimized = None
                if optimized is None:
                    self._send_file(allowed)
                else:
                    self._send_immutable_image(*optimized)
        else:
            self._send_json(404, {"code": 404, "error": "route_not_found", "path": path})

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        try:
            payload = self._payload()
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self._send_json(400, {"code": 400, "error": str(error)})
            return
        if path in {"/api/cameras/connect-all", "/api/camera/connect-all"}:
            result = self.runtime.connect_all()
            self._send_json(200 if result["code"] == 0 else 503, result)
        elif path == "/api/camera/connect":
            result = self.runtime.connect_all()
            self._send_json(200 if result["code"] == 0 else 503, result)
        elif path in {"/api/camera/disconnect", "/api/cameras/disconnect-all"}:
            identity = str(payload.get("ip", payload.get("cameraId", "")))
            self._send_json(200, self.runtime.disconnect(identity))
        elif path == "/api/steel/event":
            result = self.runtime.steel_event(payload)
            self._send_json(200 if result["code"] == 0 else 400, result)
        elif path == "/api/steel/capture-mode":
            result = self.runtime.set_capture_mode(payload)
            self._send_json(200, result)
        elif path == "/api/capture/continuous-settings":
            self._send_json(200, self.runtime.continuous_settings_json())
        elif path in {
            "/api/capture/alignment/rebuild",
            "/api/capture/measurement/rebuild",
            "/api/capture/defects/rebuild",
        }:
            material_id = str(payload.get("materialId", "")).strip()
            if not material_id:
                self._send_json(400, {"code": 400, "error": "materialId is required"})
            elif (
                self.runtime._schedule_defect_rebuild(material_id)
                if path == "/api/capture/defects/rebuild"
                else self.runtime._schedule_flow_alignment(material_id)
            ):
                self._send_json(
                    202,
                    {
                        "code": 0,
                        "state": (
                            "waiting-for-capture-idle"
                            if path == "/api/capture/defects/rebuild"
                            else "waiting-for-storage"
                        ),
                        "materialId": material_id,
                    },
                )
            else:
                self._send_json(
                    409,
                    {"code": 409, "error": "alignment_already_running_or_invalid"},
                )
        elif path == "/api/stream/start":
            result = self.runtime.start_stream(payload)
            self._send_json(200 if result["code"] == 0 else 400, result)
        elif path == "/api/stream/stop":
            self._send_json(200, self.runtime.stop_stream(payload))
        elif path == "/api/capture/continuous-test":
            status, result = self.runtime.continuous_capture(payload)
            self._send_json(status, result)
        elif path in {"/api/capture/depth-map", "/api/capture/preview", "/api/preview/capture"}:
            status, result = self.runtime.capture_once(payload)
            self._send_json(status, result)
        elif path == "/api/config/profile/apply":
            requested = str(payload.get("name", payload.get("profile", self.runtime.profile.name)))
            if requested != self.runtime.profile.name:
                self._send_json(404, {"code": 404, "error": "profile_not_found"})
            else:
                if bool(payload.get("autoConnect", self.runtime.profile.auto_connect)):
                    self.runtime.connect_all()
                self._send_json(200, {"code": 0, **self.runtime.profile_status()})
        elif path in {"/api/storage/config", "/api/storage/camera-roots"}:
            self._send_json(
                409,
                {
                    "code": 409,
                    "error": "sick_sidecar_storage_is_profile_owned",
                    "profilePath": str(self.runtime.profile.source_path),
                },
            )
        else:
            self._send_json(501, {"code": 501, "error": "route_not_implemented", "path": path})


class SickCaptureHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, address: tuple[str, int], runtime: ProviderRuntime) -> None:
        self.runtime = runtime
        super().__init__(address, SickCaptureRequestHandler)

    def server_close(self) -> None:
        try:
            self.runtime.close()
        finally:
            super().server_close()


def serve(profile_path: Path | str, host: str = "127.0.0.1", port: int = 4317) -> None:
    if host.lower() != "localhost":
        try:
            address = ipaddress.ip_address(host)
        except ValueError as error:
            raise ValueError("SICK sidecar host must be a loopback address") from error
        if not address.is_loopback:
            raise ValueError("SICK sidecar host must be a loopback address")
    profile = load_profile(profile_path)
    runtime = ProviderRuntime(profile)
    server = SickCaptureHTTPServer((host, port), runtime)
    print(
        json.dumps(
            {
                "service": "steel_sick_capture_sidecar",
                "origin": f"http://{host}:{port}",
                "profile": str(profile.source_path),
                "expectedCameras": profile.expected_cameras,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
