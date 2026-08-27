"""Steel-compatible HTTP sidecar for real SICK GenTL cameras."""

from __future__ import annotations

import ipaddress
import datetime as dt
import hashlib
import io
import json
import mimetypes
import os
import shutil
import sys
import tempfile
import threading
import time
from collections import OrderedDict, deque
from concurrent.futures import Future, ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from multiprocessing import shared_memory
from pathlib import Path
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import parse_qs, unquote, urlsplit

import numpy as np
from PIL import Image

from .gentl import SickGenTLBackend
from .calibration_pointer import resolve_active_array_calibration
from .playback import (
    _capture_image_identity,
    build_image_pyramid,
    capture_image_cache_root,
    flow_pyramid_cache_status_path,
    playback_catalog_path,
    playback_index_path,
    read_image_pyramid,
    read_indexed_playback_crop,
    read_indexed_history,
    select_pyramid_image,
    source_fingerprint,
    validate_playback_crop_box,
    write_flow_pyramid_cache_status,
)
from .profile import CameraProfile, SickCaptureProfile, load_profile, sha256_file
from .renditions import (
    RenditionNotReady,
    committed_rendition_file,
    rendition_file,
    rendition_measurement_config,
    verify_and_cleanup_legacy_renditions,
)
from .events import publish_committed_round, write_flow_manifest
from .paths import (
    algorithm_state_path,
    alignment_path as alignment_manifest_path,
    cache_root as flow_cache_root,
    capture_artifact_ref,
    capture_root,
    defect_manifest_path as defect_detection_manifest_path,
    flow_id,
    flow_manifest_path,
    frame_event_root,
    resolve_capture_artifact,
    measurement_path as measurement_manifest_path,
    surface_path as surface_manifest_path,
)
from .regions import (
    detect_valid_sensor_roi,
    read_region_manifest,
    region_manifest_path,
    stable_horizontal_roi,
)
from .storage import DualFormatWriter, atomic_summary


CAPTURE_DISCARDED_NOT_ARMED = 49000
BLACK_FRAME_DISCARDED = 49001
NO_STEEL_FRAME_DISCARDED = 49002
SICK_CAPTURE_FAILED = 49100
SICK_COMPONENT_SCHEMA_MISMATCH = 49101
SICK_STORAGE_FAILED = 49102
LIVE_PREVIEW_BLACK_MAX = 8.0
LIVE_PREVIEW_MAX_FPS = 2.0
# Historical rendition rebuilding deliberately keeps the flow queue small.
# A flow itself is processed with the bounded two-frame process pool below;
# this queue only holds flow ids waiting for that worker, never one Future per
# catalog entry.
FULL_HISTORY_FLOW_QUEUE_CAPACITY = 4
FULL_HISTORY_FLOW_RETRY_LIMIT = 3
# Rechecking every permanently unaligned catalog row every 15 seconds creates
# avoidable metadata I/O on a multi-thousand-flow archive.  Rotate through a
# bounded batch; newly closed flows are still scheduled directly when their
# alignment finishes.
FULL_HISTORY_UNREADY_RECHECK_BATCH = 64


@dataclass(frozen=True, slots=True)
class CaptureSyncPolicy:
    """Acquisition-only timing policy; contains no geometry or defect logic."""

    search_frames: int
    stable_rows: int
    anchor_interval_frames: int
    maximum_anchor_residual_ms: float


_STORAGE_PROCESS_WRITER: DualFormatWriter | None = None
_STORAGE_PROCESS_SHARED_MEMORY: dict[str, shared_memory.SharedMemory] = {}


def _process_is_running(process_id: int) -> bool:
    """Check a job-lock PID without signalling it on Windows."""
    if process_id <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(process_id, 0)
            return True
        except PermissionError:
            return True
        except ProcessLookupError:
            return False
    try:
        import ctypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.GetExitCodeProcess.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_uint32),
        ]
        kernel32.GetExitCodeProcess.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel32.OpenProcess(
            process_query_limited_information, False, process_id
        )
        if not handle:
            return ctypes.get_last_error() == 5
        try:
            exit_code = ctypes.c_uint32()
            return bool(
                kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
            ) and exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    except (AttributeError, OSError, ValueError):
        return False


def _derived_artifact_read_gate(
    storage_root: Path,
    material_id: str,
) -> tuple[int, dict[str, Any]] | None:
    """Hide canonical derived artifacts while a replacement is incomplete."""
    path = algorithm_state_path(storage_root, material_id)
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        return 500, {
            "code": 500,
            "error": "algorithm_state_invalid",
            "materialId": material_id,
            "detail": str(error),
        }
    if not isinstance(value, dict):
        return 500, {
            "code": 500,
            "error": "algorithm_state_invalid",
            "materialId": material_id,
        }
    state = str(value.get("state", "")).strip().lower()
    mode = str(value.get("mode", "")).strip().lower()
    if state == "processing":
        return 503, {
            "code": 503,
            "error": "derived_artifacts_processing",
            "state": state,
            "mode": mode,
            "materialId": material_id,
            "retryAfterMs": 2000,
            "algorithmStatePath": str(path),
        }
    if state == "failed" and mode != "final-defects":
        return 409, {
            "code": 409,
            "error": "derived_artifacts_failed",
            "state": state,
            "mode": mode,
            "materialId": material_id,
            "detail": str(value.get("error", "flow artifact generation failed")),
            "algorithmStatePath": str(path),
        }
    return None


def _initialize_storage_process_writer(
    jpeg_quality: int,
    fsync: bool,
    artifact_context: dict[str, Any],
) -> None:
    global _STORAGE_PROCESS_WRITER, _STORAGE_PROCESS_SHARED_MEMORY
    _STORAGE_PROCESS_WRITER = DualFormatWriter(
        jpeg_quality=jpeg_quality,
        fsync=fsync,
        artifact_context=artifact_context,
    )
    _STORAGE_PROCESS_SHARED_MEMORY = {}


def _storage_process_ready() -> int:
    """Force the lazy Windows process pool to initialize before steel-in."""

    return os.getpid()


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


def _build_complete_rendition_pair(
    source_path: Path,
    camera_id: str,
    camera_roots: dict[str, Path],
    storage_root: Path,
    calibration_path: Path,
    config: Any,
) -> dict[str, str]:
    """Commit gray and JET thumbnail/original files for one raw frame."""
    gray_path = rendition_file(
        source_path,
        "gray",
        "thumbnail",
        camera_id=camera_id,
        camera_roots=camera_roots,
        storage_root=storage_root,
        calibration_path=calibration_path,
        config=config,
    )
    jet_path = rendition_file(
        source_path,
        "jet",
        "thumbnail",
        camera_id=camera_id,
        camera_roots=camera_roots,
        storage_root=storage_root,
        calibration_path=calibration_path,
        config=config,
    )
    return {"gray": str(gray_path), "jet": str(jet_path)}


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


class ProviderRuntime:
    def __init__(
        self,
        profile: SickCaptureProfile,
        *,
        backend: Any | None = None,
        writer: DualFormatWriter | None = None,
        history_only: bool = False,
    ) -> None:
        self.profile = profile
        self.history_only = history_only
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
                "storageProcessWorkers",
                capture_defaults.get(
                    # Compatibility alias retained for deployed profiles.
                    "storageWriterThreads",
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
        self.alignment_config = CaptureSyncPolicy(
            search_frames=max(1, int(
                capture_defaults.get(
                    "alignmentSearchFrames",
                    max(self.steel_pre_roll_frames + self.steel_entry_rounds, 8),
                )
            )),
            stable_rows=max(1, int(capture_defaults.get("alignmentStableRows", 8))),
            anchor_interval_frames=max(1, int(
                capture_defaults.get("softSyncAnchorIntervalFrames", 16)
            )),
            maximum_anchor_residual_ms=max(1.0, float(
                capture_defaults.get("softSyncMaximumResidualMs", 40.0)
            )),
        )
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
        self.rendition_config = rendition_measurement_config(capture_defaults)
        self.storage_process_workers = max(
            0,
            min(profile.expected_cameras, configured_storage_process_workers),
        )
        self.storage_writer_threads = (
            0 if self.storage_process_workers else max(1, profile.expected_cameras)
        )
        if self.storage_process_workers:
            self.storage_writer_pool = ProcessPoolExecutor(
                max_workers=self.storage_process_workers,
                initializer=_initialize_storage_process_writer,
                initargs=(
                    profile.jpeg_quality,
                    profile.fsync,
                    artifact_context,
                ),
            )
            # ProcessPoolExecutor is lazy.  Starting six Python workers on the
            # first steel frame previously consumed the beginning of that flow
            # and filled the 128-round cache.  Warm the pool during provider
            # startup, before cameras begin continuous acquisition.
            warm_futures = [
                self.storage_writer_pool.submit(_storage_process_ready)
                for _ in range(self.storage_process_workers)
            ]
            for future in warm_futures:
                future.result(timeout=60.0)
            self.storage_writer_processes_prewarmed = True
        else:
            self.storage_writer_pool = ThreadPoolExecutor(
                max_workers=self.storage_writer_threads,
                thread_name_prefix="sick-storage-camera",
            )
            self.storage_writer_processes_prewarmed = False
        self.storage_copy_workers = (
            profile.expected_cameras if self.storage_process_workers else 0
        )
        self.storage_copy_pool = (
            ThreadPoolExecutor(
                max_workers=self.storage_copy_workers,
                thread_name_prefix="sick-storage-copy",
            )
            if self.storage_copy_workers
            else None
        )
        self.storage_shared_buffers: dict[
            tuple[str, int],
            tuple[
                shared_memory.SharedMemory,
                shared_memory.SharedMemory,
                tuple[int, ...],
                str,
                str,
            ],
        ] = {}
        self.storage_shared_buffer_lock = threading.RLock()
        # A single round coordinator could only sustain about 2.8 rounds/s on
        # the six-camera production host while acquisition produces about
        # 3.9 rounds/s.  Two ordered coordinators let shared-memory copies and
        # per-camera writes overlap without allowing manifests or frame events
        # to overtake an earlier round.  Each in-flight round owns a distinct
        # shared-memory slot for every camera.
        self.storage_round_workers = (
            max(
                1,
                min(
                    4,
                    int(
                        os.environ.get(
                            "SICK_STORAGE_ROUND_WORKERS",
                            capture_defaults.get("storageRoundWorkers", 2),
                        )
                    ),
                ),
            )
            if self.storage_process_workers
            else 1
        )
        self.storage_round_order = 0
        self.storage_next_prepare_order = 0
        self.storage_next_finalize_order = 0
        self.storage_round_order_condition = threading.Condition(threading.RLock())
        self.storage_round_pool = ThreadPoolExecutor(
            max_workers=self.storage_round_workers,
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
        self.storage_queue_last_error = ""
        self.storage_queue_last_failed_at = ""
        self.storage_queue_last_failed_phase = ""
        self.storage_queue_last_failed_material_id = ""
        self.storage_queue_high_water_rounds = 0
        self.storage_queue_backpressure_waits = 0
        self.storage_queue_backpressure_seconds = 0.0
        self.storage_write_samples: deque[tuple[float, int, float]] = deque(maxlen=120)
        self.storage_round_stage_samples: deque[dict[str, float]] = deque(maxlen=120)
        self.storage_camera_write_ms: dict[str, deque[float]] = {
            camera.key: deque(maxlen=120) for camera in profile.enabled_cameras
        }
        self.state_lock = threading.RLock()
        self.connection_lock = threading.Lock()
        self.connection_in_progress = False
        self.connection_attempt_count = 0
        self.last_connection_attempt_at = ""
        self.last_connection_completed_at = ""
        self.last_connection_code: int | None = None
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
        # HTTP image requests may wait briefly for a real encoded frame.  The
        # condition uses the preview lock only; acquisition/GenTL workers
        # never wait on a browser request.
        self.stream_ready = threading.Condition(self.stream_lock)
        # Live previews are subscriptions, not a single global "active"
        # camera.  The 2x3 monitor starts all six cameras independently and a
        # focused card may request full-resolution intensity/depth without
        # replacing the other five subscriptions.
        self.stream_subscriptions: dict[str, dict[str, Any]] = {}
        self.stream_started_at_by_camera: dict[str, str] = {}
        # Retain these aggregate aliases for older status consumers.  Runtime
        # decisions below use stream_subscriptions exclusively.
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
        self.stream_valid_rois: dict[str, list[int]] = {}
        self.stream_roi_samples: dict[str, deque[list[int]]] = {
            camera.key: deque(maxlen=8) for camera in profile.enabled_cameras
        }
        self.stream_latest: dict[str, dict[str, bytes]] = {}
        self.stream_requested_kinds: dict[str, dict[str, float]] = {}
        self.preview_seed_lock = threading.Lock()
        self.preview_seed_pending_cameras: set[str] = set()
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
        # Capture publishes committed-frame events only.  Alignment,
        # measurement and defect work belongs to steel-image-worker and
        # steel-defect-worker;
        # keeping ProcessPoolExecutors here previously left orphan workers and
        # could drive the acquisition host to 100% CPU.
        self.alignment_lock = threading.RLock()
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
            "state": "worker-owned",
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
        self.playback_cache_root = self.profile.storage_root
        self.playback_cache_build_locks = [threading.Lock() for _ in range(16)]
        self.playback_cache_memory_hits = 0
        self.playback_cache_disk_hits = 0
        self.playback_cache_builds = 0
        self.playback_cache_build_failures = 0
        self.playback_cache_build_ms: deque[float] = deque(maxlen=120)
        self.playback_compute_pool = ProcessPoolExecutor(
            max_workers=2,
            initializer=_initialize_flow_analysis_process,
        )
        self.playback_warm_stop = threading.Event()
        self.playback_warm_pool = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="sick-playback-warm",
        )
        self.playback_warm_compute_pool = ProcessPoolExecutor(
            max_workers=2,
            # Full-history workers keep bounded, signature-invalidated input
            # caches.  Let each process serve enough frames to reuse those
            # caches across a flow instead of recycling it every 64 tasks.
            max_tasks_per_child=512,
            initializer=_initialize_flow_analysis_process,
        )
        self.playback_warm_futures: dict[str, Future[Any]] = {}
        self.playback_warm_status: dict[str, Any] = {
            "state": "idle",
            "materialId": "",
            "committedFrameCount": 0,
            "sourceFrameCount": 0,
            "failureCount": 0,
            "generationPolicy": "full-flow-after-alignment",
            "updatedAt": _utc_text(),
        }
        # Full-history discovery is intentionally separate from the per-flow
        # warm status.  Discovery may inspect thousands of catalog rows, but
        # only a few flow ids are retained in this bounded queue and only one
        # flow Future is submitted at a time by the discovery thread.
        self.playback_history_flow_queue: deque[str] = deque(
            maxlen=FULL_HISTORY_FLOW_QUEUE_CAPACITY
        )
        self.playback_history_retry_pending: deque[str] = deque()
        self.playback_history_queued: set[str] = set()
        self.playback_history_catalog_ids: list[str] = []
        self.playback_history_eligible_ids: list[str] = []
        self.playback_history_scan_cursor = 0
        self.playback_history_catalog_mtime_ns = 0
        self.playback_history_catalog_material_count = 0
        self.playback_history_discovered_count = 0
        self.playback_history_completed: set[str] = set()
        self.playback_history_skipped_complete: set[str] = set()
        self.playback_history_failed: set[str] = set()
        self.playback_history_retry_counts: dict[str, int] = {}
        self.playback_history_unready_ids: set[str] = set()
        self.playback_history_unready_queue: deque[str] = deque()
        self.playback_history_status: dict[str, Any] = {
            "state": "idle",
            "policy": "full-history-after-alignment",
            "catalogMaterialCount": 0,
            "catalogScannedCount": 0,
            "discoveredFlowCount": 0,
            "orphanFlowCount": 0,
            "rebuildableFlowCount": 0,
            "unreadyFlowCount": 0,
            "completedFlowCount": 0,
            "skippedCompleteFlowCount": 0,
            "failedFlowCount": 0,
            "retryCount": 0,
            "queueDepth": 0,
            "queueCapacity": FULL_HISTORY_FLOW_QUEUE_CAPACITY,
            "currentMaterialId": "",
            "currentQueuePosition": 0,
            "currentQueueTotal": 0,
            "currentSourceFrameCount": 0,
            "currentCommittedFrameCount": 0,
            "currentFailureCount": 0,
            "discoveryComplete": False,
            "lastError": "",
            "updatedAt": _utc_text(),
        }
        self.playback_discovery_thread = threading.Thread(
            target=self._full_rendition_discovery_loop,
            name="sick-full-rendition-discovery",
            daemon=True,
        )

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
        self._recover_interrupted_flow_manifests()
        try:
            self.backend.start()
        except Exception as error:
            self.last_error = str(error)
            self._log("error", "SICK GenTL initialization failed", error=str(error))
        if profile.auto_connect and not self.history_only and not self.last_error:
            self.connect_all()
        if self.capture_mode == "continuous" and self.sessions:
            self._ensure_acquisition_worker()
        # Full rendition audits can touch thousands of files across the camera
        # volumes.  Keep them off the constructor path so port 4317 becomes
        # available immediately; the discovery thread below owns both recent
        # and historical scheduling.
        self.playback_discovery_thread.start()

    def active_array_calibration(self) -> dict[str, Any]:
        """Resolve a gated candidate without requiring a capture restart."""
        return resolve_active_array_calibration(
            self.profile.storage_root,
            self.array_calibration_path,
        )

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

    def _connection_status_json(self) -> dict[str, Any]:
        with self.state_lock:
            unconnected_cameras = [
                {
                    "cameraKey": camera.key,
                    "ip": camera.ip,
                    "serialNumber": camera.serial_number,
                    "error": self.session_errors.get(camera.key, ""),
                }
                for camera in self.profile.enabled_cameras
                if camera.key not in self.sessions
            ]
            failed_cameras = [
                camera
                for camera in unconnected_cameras
                if camera["error"]
            ]
            return {
                "schema": "steel.sick-camera-connection.v1",
                "historyOnly": self.history_only,
                "inProgress": self.connection_in_progress,
                "attemptCount": self.connection_attempt_count,
                "lastAttemptAt": self.last_connection_attempt_at or None,
                "lastCompletedAt": self.last_connection_completed_at or None,
                "lastCode": self.last_connection_code,
                "expectedCameras": self.profile.expected_cameras,
                "connectedCameras": len(self.sessions),
                "unconnectedCameras": unconnected_cameras,
                "failedCameras": failed_cameras,
            }

    def connect_all(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        try:
            expected = _integer(
                payload,
                "expectedCameras",
                self.profile.expected_cameras,
                1,
                24,
            )
        except ValueError as error:
            return {
                "code": 422,
                "error": "invalid_expected_camera_count",
                "message": str(error),
                **self._connection_status_json(),
            }
        if expected != self.profile.expected_cameras:
            return {
                "code": 409,
                "error": "expected_camera_count_mismatch",
                "requestedCameras": expected,
                **self._connection_status_json(),
            }
        if self.history_only:
            return {
                "code": 409,
                "error": "history_only",
                "cameras": [self._camera_row(camera) for camera in self.profile.enabled_cameras],
                **self._connection_status_json(),
            }
        if not self.connection_lock.acquire(blocking=False):
            return {
                "code": 409,
                "error": "camera_connection_in_progress",
                **self._connection_status_json(),
            }

        with self.state_lock:
            self.connection_in_progress = True
            self.connection_attempt_count += 1
            self.last_connection_attempt_at = _utc_text()
        try:
            results = []
            for camera in self.profile.enabled_cameras:
                with self.state_lock:
                    connected_session = self.sessions.get(camera.key)
                if connected_session is not None:
                    results.append(self._camera_row(camera))
                    continue
                session = None
                try:
                    session = self.backend.connect(camera)
                    session.start()
                    with self.state_lock:
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
                    with self.state_lock:
                        self.session_errors[camera.key] = str(error)
                    self._log(
                        "error",
                        "SICK camera connection failed",
                        cameraKey=camera.key,
                        serialNumber=camera.serial_number,
                        error=str(error),
                    )
                results.append(self._camera_row(camera))
            with self.state_lock:
                connected = len(self.sessions)
                code = 0 if connected == self.profile.expected_cameras else 49110
                self.last_connection_code = code
                if code == 0:
                    self.last_error = ""
                else:
                    failures = [
                        f"{camera.key}: {self.session_errors.get(camera.key, 'not connected')}"
                        for camera in self.profile.enabled_cameras
                        if camera.key not in self.sessions
                    ]
                    self.last_error = "; ".join(failures)
                self.connection_in_progress = False
                self.last_connection_completed_at = _utc_text()
            return {
                "code": code,
                "cameras": results,
                **self._connection_status_json(),
            }
        except Exception as error:
            with self.state_lock:
                self.last_connection_code = 500
                self.last_error = f"camera connection attempt failed: {error}"
            raise
        finally:
            with self.state_lock:
                self.connection_in_progress = False
                self.last_connection_completed_at = _utc_text()
            self.connection_lock.release()

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
        if (
            self.playback_discovery_thread.is_alive()
            and self.playback_discovery_thread is not threading.current_thread()
        ):
            self.playback_discovery_thread.join(timeout=2.0)
        thread = self.acquisition_thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=max(2.0, self.profile.timeout_ms / 1000.0 + 1.0))
        with self.storage_queue_space:
            self.storage_queue_accepting = False
            self.storage_queue_space.notify_all()
        self.capture_pool.shutdown(wait=True, cancel_futures=True)
        self.preview_pool.shutdown(wait=True, cancel_futures=True)
        self.storage_round_pool.shutdown(wait=True, cancel_futures=False)
        if self.storage_copy_pool is not None:
            self.storage_copy_pool.shutdown(wait=True, cancel_futures=False)
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
            self.stream_subscriptions.clear()
            self.stream_started_at_by_camera.clear()
            self.stream_camera_key = ""
            self.stream_options = {}
            self.stream_latest.clear()
            self.stream_frame_counts.clear()
            self.stream_last_frame_at_by_camera.clear()
            self.stream_frame_ticks_by_camera.clear()
            self.stream_dimensions.clear()
            self.stream_requested_kinds.clear()
            self.stream_ready.notify_all()
        with self.history_lock:
            self.playback_image_cache.clear()
            self.indexed_history_cache.clear()
        self.history_refresh_pool.shutdown(wait=True, cancel_futures=True)
        self.playback_warm_pool.shutdown(wait=True, cancel_futures=True)
        self.playback_warm_compute_pool.shutdown(wait=True, cancel_futures=False)
        self.playback_compute_pool.shutdown(wait=True, cancel_futures=False)
        with self.state_lock:
            interrupted_material_id = self.active_material_id
            interrupted_session_id = self.active_session_id
        if interrupted_material_id:
            self._close_flow_manifest(
                interrupted_material_id,
                interrupted_session_id,
                reason="capture-process-graceful-shutdown",
            )
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

    def _flow_capture_roots(self, material_id: str) -> dict[str, Path]:
        return {
            camera.camera_id: capture_root(
                camera.storage_root, material_id, camera.camera_id
            )
            for camera in self.profile.enabled_cameras
        }

    def _close_flow_manifest(
        self,
        material_id: str,
        session_id: str,
        *,
        latest_round: int | None = None,
        reason: str,
    ) -> None:
        if not material_id or not material_id.isdecimal():
            return
        # Serialize steel-out closure with asynchronous post-roll commits.
        # Otherwise a writer can observe the old ``capturing`` manifest, then
        # overwrite the newly closed state after steel_event returns.
        with self.state_lock:
            if latest_round is None:
                try:
                    current = json.loads(
                        flow_manifest_path(self.profile.storage_root, material_id).read_text(
                            encoding="utf-8-sig"
                        )
                    )
                    current_latest = current.get("latestCommittedRound")
                    latest_round = (
                        int(current_latest) if current_latest is not None else None
                    )
                except (OSError, TypeError, ValueError, json.JSONDecodeError):
                    latest_round = None
            write_flow_manifest(
                self.profile.storage_root,
                material_id,
                session_id=session_id,
                state="closed",
                camera_roots=self._flow_capture_roots(material_id),
                latest_round=latest_round,
            )
        self._log(
            "info",
            "flow manifest closed",
            materialId=material_id,
            reason=reason,
        )

    def _recover_interrupted_flow_manifests(self) -> None:
        """Close flows left active by an interrupted capture process.

        A provider instance owns at most one active flow and no flow is active
        before its acquisition worker starts.  Therefore every pre-existing
        ``capturing`` manifest at startup is an interrupted predecessor and
        must be finalized so the algorithm service can run its final pass.
        """
        recovered = 0
        try:
            candidates = list(self.profile.storage_root.iterdir())
        except OSError:
            return
        for flow_dir in candidates:
            if not flow_dir.is_dir() or not flow_dir.name.isdecimal():
                continue
            manifest_path = flow_dir / "flow.json"
            try:
                payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if str(payload.get("state", "")).strip().lower() != "capturing":
                continue
            latest_round_value = payload.get("latestCommittedRound")
            try:
                latest_round = (
                    int(latest_round_value) if latest_round_value is not None else None
                )
            except (TypeError, ValueError):
                latest_round = None
            self._close_flow_manifest(
                flow_dir.name,
                str(payload.get("sessionId", "")),
                latest_round=latest_round,
                reason="capture-process-restart-recovery",
            )
            recovered += 1
        if recovered:
            self._log(
                "warning",
                "interrupted flow manifests recovered",
                recoveredFlowCount=recovered,
            )

    def _set_playback_warm_status(
        self, *, replace: bool = False, **values: Any
    ) -> None:
        with self.history_lock:
            self.playback_warm_status = {
                **({} if replace else self.playback_warm_status),
                **values,
                "updatedAt": _utc_text(),
            }

    def _set_playback_history_status(self, **values: Any) -> None:
        """Publish bounded full-history discovery/rebuild progress."""
        with self.history_lock:
            status = getattr(self, "playback_history_status", {})
            if not isinstance(status, dict):
                status = {}
            queue = getattr(self, "playback_history_flow_queue", ())
            status = {
                **status,
                **values,
                "queueDepth": len(queue),
                "queueCapacity": FULL_HISTORY_FLOW_QUEUE_CAPACITY,
                "updatedAt": _utc_text(),
            }
            self.playback_history_status = status

    def _full_history_active_future(self) -> tuple[str, Future[Any]] | None:
        """Return the one running/pending warm future, if any."""
        with self.history_lock:
            for material_id, future in self.playback_warm_futures.items():
                if not future.done():
                    return material_id, future
        return None

    def _discover_full_history_catalog(self, *, force: bool = False) -> bool:
        """Discover every catalog flow eligible for full rendition rebuilding.

        The catalog is scanned into compact flow-id lists, while the actual
        work queue remains bounded.  This makes a 4,000-flow catalog cheap to
        discover and, importantly, never creates one executor Future per row.
        """
        catalog_path = playback_catalog_path(self.profile.storage_root)
        try:
            catalog_mtime_ns = catalog_path.stat().st_mtime_ns
            catalog = json.loads(
                catalog_path.read_text(encoding="utf-8-sig")
            )
            if not isinstance(catalog, dict):
                raise ValueError("playback catalog must be a JSON object")
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
            self._set_playback_history_status(
                state="waiting-for-catalog",
                discoveryComplete=False,
                lastError=str(error),
            )
            return False

        rows = [
            row for row in catalog.get("materials", []) if isinstance(row, dict)
        ]
        catalog_ids: list[str] = []
        seen_ids: set[str] = set()
        for row in rows:
            raw_material_id = str(row.get("materialId", "")).strip()
            if not raw_material_id.isdecimal():
                continue
            material_id = str(int(raw_material_id))
            if material_id in seen_ids:
                continue
            seen_ids.add(material_id)
            catalog_ids.append(material_id)
        try:
            directory_ids = sorted(
                {
                    str(int(path.name))
                    for path in self.profile.storage_root.iterdir()
                    if path.is_dir() and path.name.isdecimal()
                },
                key=int,
                reverse=True,
            )
        except OSError:
            directory_ids = []
        orphan_ids = [
            material_id
            for material_id in directory_ids
            if material_id not in seen_ids
        ]
        catalog_ids.extend(orphan_ids)

        with self.history_lock:
            already_discovered = (
                not force
                and catalog_mtime_ns == self.playback_history_catalog_mtime_ns
                and self.playback_history_catalog_ids == catalog_ids
                and bool(self.playback_history_status.get("discoveryComplete"))
            )
        if already_discovered:
            # Alignment can finish after the catalog was published. Recheck
            # only those rows that were previously not ready; the full
            # catalog is not rescanned on every 15-second discovery tick.
            with self.history_lock:
                unready_set = self.playback_history_unready_ids
                unready_queue = self.playback_history_unready_queue
                if not unready_queue and unready_set:
                    unready_queue.extend(
                        material_id
                        for material_id in self.playback_history_catalog_ids
                        if material_id in unready_set
                    )
                unready_ids: list[str] = []
                checks = min(
                    FULL_HISTORY_UNREADY_RECHECK_BATCH,
                    len(unready_queue),
                )
                for _ in range(checks):
                    material_id = unready_queue.popleft()
                    if material_id not in unready_set:
                        continue
                    unready_ids.append(material_id)
                    unready_queue.append(material_id)
            newly_ready: list[str] = []
            for material_id in unready_ids:
                if self.playback_warm_stop.is_set():
                    return False
                try:
                    if self._flow_ready_for_full_renditions(material_id):
                        newly_ready.append(material_id)
                except (OSError, ValueError, TypeError, json.JSONDecodeError):
                    continue
            if newly_ready:
                with self.history_lock:
                    for material_id in newly_ready:
                        self.playback_history_unready_ids.discard(material_id)
                        if material_id not in self.playback_history_eligible_ids:
                            self.playback_history_eligible_ids.append(material_id)
                        elif (
                            material_id not in self.playback_history_completed
                            and material_id not in self.playback_history_failed
                            and material_id not in self.playback_history_queued
                        ):
                            self.playback_history_retry_pending.append(material_id)
                    self.playback_history_status = {
                        **self.playback_history_status,
                        "rebuildableFlowCount": len(
                            self.playback_history_eligible_ids
                        ),
                        "unreadyFlowCount": len(
                            self.playback_history_unready_ids
                        ),
                        "currentQueueTotal": len(
                            self.playback_history_eligible_ids
                        ),
                        "updatedAt": _utc_text(),
                    }
            return True

        # A persisted ready status is only a scheduling hint.  It may be stale
        # after a partial disk cleanup, an interrupted copy, or a calibration
        # change, so hinted flows still go through the full rendition audit
        # immediately before they can be marked complete.
        unhinted_eligible_ids: list[str] = []
        ready_hint_eligible_ids: list[str] = []
        eligible_ids: list[str] = []
        unready_ids: set[str] = set()
        completed_ids: set[str] = set()
        self._set_playback_history_status(
            state="discovering",
            catalogMaterialCount=len(rows),
            catalogScannedCount=0,
            discoveredFlowCount=len(catalog_ids),
            orphanFlowCount=len(orphan_ids),
            rebuildableFlowCount=0,
            unreadyFlowCount=0,
            completedFlowCount=0,
            discoveryComplete=False,
            lastError="",
        )
        for scanned_count, material_id in enumerate(catalog_ids, start=1):
            if self.playback_warm_stop.is_set():
                return False
            try:
                if not self._flow_ready_for_full_renditions(material_id):
                    unready_ids.add(material_id)
                else:
                    if self._flow_two_level_renditions_ready_hint(material_id):
                        ready_hint_eligible_ids.append(material_id)
                    else:
                        unhinted_eligible_ids.append(material_id)
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                unready_ids.add(material_id)
            eligible_count = len(unhinted_eligible_ids) + len(
                ready_hint_eligible_ids
            )
            if scanned_count % 32 == 0 or scanned_count == len(catalog_ids):
                self._set_playback_history_status(
                    state="discovering",
                    catalogScannedCount=scanned_count,
                    rebuildableFlowCount=eligible_count,
                    unreadyFlowCount=len(unready_ids),
                    completedFlowCount=len(completed_ids),
                    currentQueueTotal=eligible_count,
                )

        # Keep each group in catalog order, but put flows without a persisted
        # hint first so a restart reaches genuinely missing history quickly.
        eligible_ids = [*unhinted_eligible_ids, *ready_hint_eligible_ids]

        with self.history_lock:
            retained_completed = self.playback_history_completed.intersection(
                eligible_ids
            )
            retained_skipped = self.playback_history_skipped_complete.intersection(
                retained_completed
            )
            completed_ids.update(retained_completed)
            self.playback_history_catalog_mtime_ns = catalog_mtime_ns
            self.playback_history_catalog_ids = catalog_ids
            self.playback_history_eligible_ids = eligible_ids
            self.playback_history_scan_cursor = 0
            self.playback_history_catalog_material_count = len(rows)
            self.playback_history_discovered_count = len(catalog_ids)
            self.playback_history_completed = completed_ids
            self.playback_history_skipped_complete = retained_skipped
            self.playback_history_failed = set()
            self.playback_history_retry_counts = {}
            self.playback_history_unready_ids = unready_ids
            self.playback_history_unready_queue = deque(
                material_id
                for material_id in catalog_ids
                if material_id in unready_ids
            )
            self.playback_history_flow_queue.clear()
            self.playback_history_queued.clear()
            self.playback_history_retry_pending.clear()
            self.playback_history_status = {
                **self.playback_history_status,
                "state": "discovered",
                "catalogMaterialCount": len(rows),
                "catalogScannedCount": len(catalog_ids),
                "discoveredFlowCount": len(catalog_ids),
                "orphanFlowCount": len(orphan_ids),
                "rebuildableFlowCount": len(eligible_ids),
                "unreadyFlowCount": len(unready_ids),
                "completedFlowCount": len(completed_ids),
                "skippedCompleteFlowCount": len(retained_skipped),
                "failedFlowCount": 0,
                "retryCount": 0,
                "currentMaterialId": "",
                "currentQueuePosition": 0,
                "currentQueueTotal": len(eligible_ids),
                "currentSourceFrameCount": 0,
                "currentCommittedFrameCount": 0,
                "currentFailureCount": 0,
                "discoveryComplete": True,
                "lastError": "",
                "updatedAt": _utc_text(),
            }
        return True

    def _refill_full_history_queue(self) -> None:
        """Fill only the bounded flow-id queue from the discovery cursor."""
        with self.history_lock:
            queue = self.playback_history_flow_queue
            eligible_ids = self.playback_history_eligible_ids
            retry_queue = getattr(self, "playback_history_retry_pending", deque())
            active_ids = {
                material_id
                for material_id, future in self.playback_warm_futures.items()
                if not future.done()
            }
            while len(queue) < FULL_HISTORY_FLOW_QUEUE_CAPACITY:
                if self.playback_warm_stop.is_set():
                    break
                material_id = ""
                while retry_queue:
                    candidate = retry_queue.popleft()
                    if (
                        candidate not in self.playback_history_queued
                        and candidate not in active_ids
                        and candidate not in self.playback_history_completed
                        and candidate not in self.playback_history_failed
                    ):
                        material_id = candidate
                        break
                if not material_id:
                    while self.playback_history_scan_cursor < len(eligible_ids):
                        candidate = eligible_ids[self.playback_history_scan_cursor]
                        self.playback_history_scan_cursor += 1
                        if (
                            candidate not in self.playback_history_queued
                            and candidate not in active_ids
                            and candidate not in self.playback_history_completed
                            and candidate not in self.playback_history_failed
                        ):
                            material_id = candidate
                            break
                if not material_id:
                    break
                queue.append(material_id)
                self.playback_history_queued.add(material_id)
            self.playback_history_retry_pending = retry_queue
            self.playback_history_status = {
                **self.playback_history_status,
                "queueDepth": len(queue),
                "queueCapacity": FULL_HISTORY_FLOW_QUEUE_CAPACITY,
                "updatedAt": _utc_text(),
            }

    def _finish_full_history_future(self, material_id: str, future: Future[Any]) -> None:
        """Account for one flow and retry boundedly when a frame failed."""
        try:
            result = future.result()
        except Exception as error:
            result = {
                "state": "incomplete",
                "materialId": material_id,
                "failureCount": 1,
                "failures": [{"error": str(error)}],
            }
        state = str(result.get("state", "incomplete"))
        with self.history_lock:
            if self.playback_warm_futures.get(material_id) is not future:
                return
            self.playback_warm_futures.pop(material_id, None)
            eligible = material_id in self.playback_history_eligible_ids
            retry_pending = getattr(self, "playback_history_retry_pending", deque())
            if eligible and state == "ready":
                self.playback_history_completed.add(material_id)
                self.playback_history_failed.discard(material_id)
            elif eligible:
                self.playback_history_completed.discard(material_id)
                self.playback_history_skipped_complete.discard(material_id)
                attempts = self.playback_history_retry_counts.get(material_id, 0)
                if attempts < FULL_HISTORY_FLOW_RETRY_LIMIT:
                    self.playback_history_retry_counts[material_id] = attempts + 1
                    retry_pending.append(material_id)
                else:
                    self.playback_history_failed.add(material_id)
            self.playback_history_retry_pending = retry_pending
            retry_count = sum(self.playback_history_retry_counts.values())
            completed_count = len(self.playback_history_completed)
            failed_count = len(self.playback_history_failed)
            queue_depth = len(self.playback_history_flow_queue)
            current_queue_total = len(self.playback_history_eligible_ids)
            self.playback_history_status = {
                **self.playback_history_status,
                "completedFlowCount": completed_count,
                "skippedCompleteFlowCount": len(
                    self.playback_history_skipped_complete
                ),
                "failedFlowCount": failed_count,
                "retryCount": retry_count,
                "currentMaterialId": "",
                "currentQueuePosition": 0,
                "currentQueueTotal": current_queue_total,
                "currentSourceFrameCount": 0,
                "currentCommittedFrameCount": 0,
                "currentFailureCount": 0,
                "queueDepth": queue_depth,
                "lastError": "" if state == "ready" else str(result.get("failures", "")),
                "updatedAt": _utc_text(),
            }

    def _advance_full_history_rebuild(self) -> None:
        """Discover catalog rows, consume completed flows, and schedule one."""
        if not self._discover_full_history_catalog():
            return
        # A direct history request or the legacy startup warm may have put a
        # flow in the map.  Consume finished Futures before selecting another.
        with self.history_lock:
            finished = [
                (material_id, future)
                for material_id, future in self.playback_warm_futures.items()
                if future.done()
            ]
        for material_id, future in finished:
            self._finish_full_history_future(material_id, future)

        self._refill_full_history_queue()
        if self._full_history_active_future() is not None:
            active = self._full_history_active_future()
            if active is not None:
                material_id, _ = active
                with self.history_lock:
                    warm = dict(self.playback_warm_status)
                    total = len(self.playback_history_eligible_ids)
                    position = (
                        len(self.playback_history_completed)
                        + len(self.playback_history_failed)
                        + 1
                    )
                    self.playback_history_status = {
                        **self.playback_history_status,
                        "state": "building",
                        "currentMaterialId": material_id,
                        "currentQueuePosition": min(position, total),
                        "currentQueueTotal": total,
                        "currentSourceFrameCount": int(
                            warm.get("sourceFrameCount", 0)
                        ),
                        "currentCommittedFrameCount": int(
                            warm.get("committedFrameCount", 0)
                        ),
                        "currentFailureCount": int(
                            warm.get("failureCount", 0)
                        ),
                        "queueDepth": len(self.playback_history_flow_queue),
                        "updatedAt": _utc_text(),
                    }
            return

        while True:
            if self.playback_warm_stop.is_set():
                return
            with self.history_lock:
                if not self.playback_history_flow_queue:
                    total = len(self.playback_history_eligible_ids)
                    completed = len(self.playback_history_completed)
                    failed = len(self.playback_history_failed)
                    unready = len(self.playback_history_unready_ids)
                    handled = completed + failed
                    state = (
                        "waiting-for-alignment"
                        if unready > 0 and handled >= total
                        else "complete-with-failures"
                        if failed > 0 and handled >= total
                        else "complete"
                        if total > 0 and handled >= total
                        else "queued"
                        if total > 0
                        else "waiting-for-alignment"
                        if unready > 0
                        else "ready"
                    )
                    self.playback_history_status = {
                        **self.playback_history_status,
                        "state": state,
                        "completedFlowCount": completed,
                        "skippedCompleteFlowCount": len(
                            self.playback_history_skipped_complete
                        ),
                        "failedFlowCount": failed,
                        "unreadyFlowCount": unready,
                        "currentMaterialId": "",
                        "currentQueuePosition": 0,
                        "currentQueueTotal": total,
                        "queueDepth": 0,
                        "updatedAt": _utc_text(),
                    }
                    return
                material_id = self.playback_history_flow_queue.popleft()
                self.playback_history_queued.discard(material_id)
            if not self._flow_ready_for_full_renditions(material_id):
                with self.history_lock:
                    if material_id not in self.playback_history_unready_ids:
                        self.playback_history_unready_ids.add(material_id)
                        self.playback_history_unready_queue.append(material_id)
                # A skipped flow frees one queue slot. Refill immediately so
                # complete/unready runs do not wait for the next 15-second
                # discovery tick after every batch of four.
                self._refill_full_history_queue()
                continue
            if self._flow_two_level_renditions_complete(material_id):
                with self.history_lock:
                    self.playback_history_completed.add(material_id)
                    self.playback_history_skipped_complete.add(material_id)
                    self.playback_history_status = {
                        **self.playback_history_status,
                        "completedFlowCount": len(
                            self.playback_history_completed
                        ),
                        "skippedCompleteFlowCount": len(
                            self.playback_history_skipped_complete
                        ),
                        "updatedAt": _utc_text(),
                    }
                # Keep the bounded queue full while consuming already-ready
                # flows, but never submit another active Future here.
                self._refill_full_history_queue()
                continue
            if self._schedule_playback_warm(material_id):
                with self.history_lock:
                    total = len(self.playback_history_eligible_ids)
                    position = (
                        len(self.playback_history_completed)
                        + len(self.playback_history_failed)
                        + 1
                    )
                    self.playback_history_status = {
                        **self.playback_history_status,
                        "state": "building",
                        "currentMaterialId": material_id,
                        "currentQueuePosition": min(position, total),
                        "currentQueueTotal": total,
                        "queueDepth": len(self.playback_history_flow_queue),
                        "updatedAt": _utc_text(),
                    }
                return
            # Another caller won the single warm slot.  Keep this id for the
            # next discovery tick without growing the queue.
            with self.history_lock:
                retry_queue = getattr(self, "playback_history_retry_pending", deque())
                retry_queue.appendleft(material_id)
                self.playback_history_retry_pending = retry_queue
            return

    def _playback_warm_worker(self, material_id: str) -> dict[str, Any]:
        started = time.perf_counter()
        index_path = playback_index_path(self.profile.storage_root, material_id)
        index = json.loads(index_path.read_text(encoding="utf-8-sig"))
        camera_roots = {
            camera.camera_id: camera.storage_root
            for camera in self.profile.enabled_cameras
        }
        cache_roots = {
            camera.camera_id: flow_pyramid_cache_status_path(
                camera.storage_root,
                material_id,
            ).parent
            for camera in self.profile.enabled_cameras
        }
        # Full-flow generation is based on immutable raw files, not on which
        # frames happen to be visible or requested by the UI. Round-robin the
        # cameras by storage index so every disk starts receiving readable JET
        # files immediately instead of finishing one camera before the next.
        camera_order = {
            camera.camera_id: index
            for index, camera in enumerate(self.profile.enabled_cameras)
        }
        sources: list[tuple[Path, str]] = []
        source_counts: dict[str, int] = {}
        for camera in self.profile.enabled_cameras:
            raw_directory = capture_root(
                camera.storage_root,
                material_id,
                camera.camera_id,
            ) / "2d"
            if not raw_directory.is_dir():
                source_counts[camera.camera_id] = 0
                continue
            camera_sources = [
                (source, camera.camera_id)
                for source in raw_directory.iterdir()
                if source.is_file()
                and not source.is_symlink()
                and source.stem.isdecimal()
                and source.suffix.lower() == ".png"
            ]
            source_counts[camera.camera_id] = len(camera_sources)
            sources.extend(camera_sources)
        sources.sort(
            key=lambda item: (
                int(item[0].stem),
                camera_order.get(item[1], len(camera_order)),
            )
        )

        cached = 0
        failures: list[dict[str, str]] = [
            {
                "source": "",
                "cameraId": camera.camera_id,
                "error": "numeric-2d-source-unavailable",
            }
            for camera in self.profile.enabled_cameras
            if source_counts.get(camera.camera_id, 0) <= 0
        ]
        idle_since: float | None = None
        state = "waiting-for-idle"
        self._set_playback_warm_status(
            replace=True,
            state=state,
            materialId=material_id,
            committedFrameCount=0,
            sourceFrameCount=len(sources),
            failureCount=0,
        )

        if failures:
            result: dict[str, Any] = {
                "schema": "steel.capture-two-level-flow-cache.v2",
                "state": "incomplete",
                "generatedAt": _utc_text(),
                "materialId": material_id,
                "frameCount": int(index.get("frameCount", 0)),
                "sourceFrameCount": len(sources),
                "cameraSourceCounts": source_counts,
                "committedFrameCount": 0,
                "failureCount": len(failures),
                "failures": failures,
                "levels": ["thumbnail", "original"],
                "modalities": ["gray", "jet"],
                "elapsedMs": round((time.perf_counter() - started) * 1000.0, 3),
                "generationPolicy": "full-flow-after-alignment",
                "maximumParallelFrames": 2,
            }
            for camera in self.profile.enabled_cameras:
                write_flow_pyramid_cache_status(camera.storage_root, result)
            self._set_playback_warm_status(**result)
            return result

        def wait_for_idle() -> bool:
            nonlocal idle_since, state
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
                        return True
                else:
                    idle_since = None
                if state != "paused-for-acquisition":
                    state = "paused-for-acquisition"
                    self._set_playback_warm_status(state=state)
                self.playback_warm_stop.wait(0.2)
            return False

        calibration_path = Path(self.active_array_calibration()["path"])
        pending: dict[Future[Any], tuple[Path, str]] = {}
        source_iterator = iter(sources)
        exhausted = False
        while pending or not exhausted:
            while len(pending) < 2 and not exhausted:
                try:
                    source, camera_id = next(source_iterator)
                except StopIteration:
                    exhausted = True
                    break
                if not wait_for_idle():
                    for future in pending:
                        future.cancel()
                    self._set_playback_warm_status(state="stopped")
                    return {"state": "stopped", "materialId": material_id}
                if state != "building":
                    state = "building"
                    self._set_playback_warm_status(state=state)
                future = self.playback_warm_compute_pool.submit(
                    _build_complete_rendition_pair,
                    source,
                    camera_id,
                    camera_roots,
                    self.profile.storage_root,
                    calibration_path,
                    self.rendition_config,
                )
                pending[future] = (source, camera_id)
            if not pending:
                continue
            completed = next(as_completed(tuple(pending)))
            source, camera_id = pending.pop(completed)
            try:
                completed.result()
                cached += 1
            except Exception as error:
                failures.append(
                    {
                        "source": str(source),
                        "cameraId": camera_id,
                        "error": str(error),
                    }
                )
            self._set_playback_warm_status(
                committedFrameCount=cached,
                failureCount=len(failures),
            )

        complete = (
            not failures
            and cached == len(sources)
            and bool(sources)
            and all(count > 0 for count in source_counts.values())
            and len(source_counts) == len(self.profile.enabled_cameras)
        )
        result: dict[str, Any] = {
            "schema": "steel.capture-two-level-flow-cache.v2",
            "state": "ready" if complete else "incomplete",
            "generatedAt": _utc_text(),
            "materialId": material_id,
            "frameCount": int(index.get("frameCount", 0)),
            "sourceFrameCount": len(sources),
            "cameraSourceCounts": source_counts,
            "committedFrameCount": cached,
            "failureCount": len(failures),
            "failures": failures[:20],
            "levels": ["thumbnail", "original"],
            "modalities": ["gray", "jet"],
            "cacheRoots": [
                str(path) for path in sorted(set(cache_roots.values()), key=str)
            ],
            "elapsedMs": round((time.perf_counter() - started) * 1000.0, 3),
            "throttledForAcquisition": True,
            "generationPolicy": "full-flow-after-alignment",
            "maximumParallelFrames": 2,
        }
        if complete:
            cleanup = verify_and_cleanup_legacy_renditions(
                {
                    camera.camera_id: camera.storage_root
                    for camera in self.profile.enabled_cameras
                },
                self.profile.storage_root,
                material_id,
            )
            result["legacyCleanup"] = {
                key: value
                for key, value in cleanup.items()
                if key != "deleted"
            }
            deleted = cleanup.get("deleted", [])
            if isinstance(deleted, list) and deleted:
                result["legacyCleanup"]["deletedSample"] = deleted[:20]
        for camera in self.profile.enabled_cameras:
            write_flow_pyramid_cache_status(camera.storage_root, result)
        self._set_playback_warm_status(**result)
        return result

    def _commit_region_manifest(self, material_id: str) -> None:
        path = region_manifest_path(self.profile.storage_root, material_id)
        regions = read_region_manifest(self.profile.storage_root, material_id)
        if regions is None or not path.is_file():
            return
        response = self._post_service_json(
            "/internal/v1/capture-regions",
            {
                "schema": "steel.capture-region-commit.v1",
                "materialId": material_id,
                "manifestPath": str(path),
                "manifestSha256": sha256_file(path),
                "regions": regions,
            },
        )
        if int(response.get("code", 500)) != 0:
            raise RuntimeError(str(response.get("error", "region commit rejected")))

    def _flow_ready_for_full_renditions(self, material_id: str) -> bool:
        normalized = material_id.strip()
        if not normalized.isdecimal():
            return False
        try:
            flow = json.loads(
                flow_manifest_path(self.profile.storage_root, normalized).read_text(
                    encoding="utf-8-sig"
                )
            )
            alignment = json.loads(
                alignment_manifest_path(self.profile.storage_root, normalized).read_text(
                    encoding="utf-8-sig"
                )
            )
            playback_index = json.loads(
                playback_index_path(self.profile.storage_root, normalized).read_text(
                    encoding="utf-8-sig"
                )
            )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return False
        if not all(
            isinstance(payload, dict)
            for payload in (flow, alignment, playback_index)
        ):
            return False
        quality = alignment.get("quality", {})
        if not isinstance(quality, dict):
            return False
        try:
            complete_cameras = int(quality.get("completeCameras", 0))
            frame_count = int(playback_index.get("frameCount", 0))
        except (TypeError, ValueError):
            return False
        return bool(
            flow.get("state") == "closed"
            and quality.get("geometrySynchronized")
            and complete_cameras == len(self.profile.enabled_cameras)
            and frame_count > 0
        )

    def _flow_two_level_renditions_ready_hint(self, material_id: str) -> bool:
        """Return whether every camera has a persisted ready *hint*.

        This deliberately does not inspect source/cache file completeness and
        must never add a flow to ``playback_history_completed``.  The hint only
        moves a flow behind unhinted work during discovery; the full audit in
        ``_advance_full_history_rebuild`` remains authoritative.
        """
        for camera in self.profile.enabled_cameras:
            try:
                payload = json.loads(
                    flow_pyramid_cache_status_path(
                        camera.storage_root,
                        material_id,
                    ).read_text(encoding="utf-8-sig")
                )
                if not isinstance(payload, dict):
                    return False
                warm = payload.get("warm", payload)
                if not isinstance(warm, dict):
                    return False
                if not (
                    warm.get("schema") == "steel.capture-two-level-flow-cache.v2"
                    and warm.get("state") == "ready"
                    and str(warm.get("materialId", "")) == material_id
                    and int(warm.get("sourceFrameCount", 0)) > 0
                    and int(warm.get("failureCount", 0)) == 0
                    and warm.get("levels") == ["thumbnail", "original"]
                    and warm.get("modalities") == ["gray", "jet"]
                ):
                    return False
            except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
                # A missing, malformed, or old status is simply an unhinted
                # flow; it remains eligible for the authoritative audit.
                return False
        return bool(self.profile.enabled_cameras)

    def _flow_two_level_renditions_complete(self, material_id: str) -> bool:
        try:
            calibration_path = Path(self.active_array_calibration()["path"])
        except (OSError, ValueError, TypeError, KeyError):
            return False
        total_sources = 0
        for camera in self.profile.enabled_cameras:
            flow = capture_root(camera.storage_root, material_id, camera.camera_id)
            sources = [
                path
                for path in (flow / "2d").glob("*.png")
                if path.is_file()
                and not path.is_symlink()
                and path.stem.isdecimal()
            ]
            if not sources:
                return False
            total_sources += len(sources)
            for source in sources:
                if committed_rendition_file(
                    source,
                    "gray",
                    "thumbnail",
                    calibration_path=calibration_path,
                ) is None or committed_rendition_file(
                    source,
                    "jet",
                    "thumbnail",
                    calibration_path=calibration_path,
                ) is None:
                    return False
        return total_sources > 0

    def _schedule_playback_warm(self, material_id: str) -> bool:
        normalized = material_id.strip()
        if not self._flow_ready_for_full_renditions(normalized):
            return False
        with self.history_lock:
            existing = self.playback_warm_futures.get(normalized)
            if existing is not None:
                return False
            # Keep the executor bounded even when several history requests
            # arrive while the all-history worker is running.  The discovery
            # queue owns the next flow id; callers cannot pile up Futures.
            if any(
                other != normalized and not future.done()
                for other, future in self.playback_warm_futures.items()
            ):
                return False
        if self._flow_two_level_renditions_complete(normalized):
            return False
        with self.history_lock:
            existing = self.playback_warm_futures.get(normalized)
            if existing is not None:
                return False
            if any(
                other != normalized and not future.done()
                for other, future in self.playback_warm_futures.items()
            ):
                return False
            future = self.playback_warm_pool.submit(
                self._playback_warm_worker, normalized
            )
            self.playback_warm_futures[normalized] = future
        return True

    def _schedule_recent_closed_flow_renditions(self, maximum: int = 2) -> int:
        try:
            catalog = json.loads(
                playback_catalog_path(self.profile.storage_root).read_text(
                    encoding="utf-8-sig"
                )
            )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return 0
        scheduled = 0
        recent = list(catalog.get("materials", []))[: max(0, int(maximum))]
        for row in recent:
            if not isinstance(row, dict):
                continue
            material_id = str(row.get("materialId", "")).strip()
            if self._schedule_playback_warm(material_id):
                scheduled += 1
        return scheduled

    def _full_rendition_discovery_loop(self) -> None:
        """Discover all eligible history and advance the bounded flow queue."""
        # A live acquisition runtime normally has no catalog to rebuild. Keep
        # its first discovery tick delayed so the background bookkeeping never
        # competes with camera startup; history-only sidecars can begin the
        # existing-history rebuild immediately.
        if not self.history_only and self.playback_warm_stop.wait(15.0):
            return
        while not self.playback_warm_stop.is_set():
            try:
                self._advance_full_history_rebuild()
            except Exception as error:
                self._set_playback_history_status(
                    state="error",
                    lastError=str(error),
                )
                self._log(
                    "warning",
                    "full rendition discovery failed",
                    error=str(error),
                )
            if self.playback_warm_stop.wait(15.0):
                break

    @staticmethod
    def _normalized_flow_id(material_id: str, *, optional: bool = False) -> str | None:
        value = material_id.strip()
        if not value and optional:
            return ""
        try:
            return flow_id(value)
        except ValueError:
            return None

    def alignment_json(self, material_id: str = "") -> tuple[int, dict[str, Any]]:
        normalized = self._normalized_flow_id(material_id, optional=True)
        if normalized is None:
            return 400, {"code": 400, "error": "invalid_material_id"}
        if not normalized:
            with self.alignment_lock:
                return 200, {"code": 0, **self.alignment_status}
        gated = _derived_artifact_read_gate(self.profile.storage_root, normalized)
        if gated is not None:
            return gated
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
        normalized = self._normalized_flow_id(material_id, optional=True)
        if normalized is None:
            return 400, {"code": 400, "error": "invalid_material_id"}
        if not normalized:
            with self.alignment_lock:
                return 200, {"code": 0, **self.measurement_status}
        gated = _derived_artifact_read_gate(self.profile.storage_root, normalized)
        if gated is not None:
            return gated
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

    def surface_json(self, material_id: str = "") -> tuple[int, dict[str, Any]]:
        normalized = self._normalized_flow_id(material_id)
        if normalized is None:
            return 400, {"code": 400, "error": "invalid_material_id"}
        gated = _derived_artifact_read_gate(self.profile.storage_root, normalized)
        if gated is not None:
            return gated
        path = surface_manifest_path(self.profile.storage_root, normalized)
        if not path.is_file():
            return 404, {
                "code": 404,
                "error": "surface_not_found",
                "materialId": normalized,
            }
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError) as error:
            return 500, {"code": 500, "error": "surface_invalid", "detail": str(error)}
        return 200, {"code": 0, "path": str(path), "surface": payload}

    def regions_json(self, material_id: str) -> tuple[int, dict[str, Any]]:
        normalized = self._normalized_flow_id(material_id)
        if normalized is None:
            return 400, {"code": 400, "error": "invalid_material_id"}
        gated = _derived_artifact_read_gate(self.profile.storage_root, normalized)
        if gated is not None:
            return gated
        payload = read_region_manifest(self.profile.storage_root, normalized)
        if payload is None:
            return 404, {
                "code": 404,
                "error": "region_manifest_not_found",
                "materialId": normalized,
            }
        return 200, {"code": 0, "regions": payload}

    def _flow_analysis_queue_status(self) -> dict[str, Any] | None:
        path = (
            self.profile.storage_root
            / "system"
            / "jobs"
            / "flow-analysis"
            / "status.json"
        )
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
            if (
                isinstance(value, dict)
                and value.get("schema") == "steel.flow-analysis-queue.v1"
            ):
                now_ms = int(time.time() * 1000)
                updated_ms = int(value.get("updatedAtUnixMs", 0) or 0)
                heartbeat_age_ms = now_ms - updated_ms if updated_ms else None
                heartbeat_fresh = bool(
                    heartbeat_age_ms is not None
                    and -5_000 <= heartbeat_age_ms <= 20_000
                )
                result = {
                    **value,
                    "path": str(path),
                    "heartbeatFresh": heartbeat_fresh,
                    "heartbeatAgeMs": heartbeat_age_ms,
                }
                if value.get("state") == "running" and not heartbeat_fresh:
                    result["state"] = "unavailable"
                    result["lastError"] = "flow analysis heartbeat is stale"
                return result
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        return None

    def _pending_defect_detection_json(
        self, material_id: str
    ) -> tuple[int, dict[str, Any]]:
        flow_path = flow_manifest_path(self.profile.storage_root, material_id)
        if not flow_path.is_file():
            return 404, {
                "code": 404,
                "error": "defect_detection_not_found",
                "materialId": material_id,
            }
        try:
            flow_manifest = json.loads(flow_path.read_text(encoding="utf-8-sig"))
            flow_state = str(flow_manifest.get("state", "")).strip().lower()
        except (OSError, ValueError, json.JSONDecodeError):
            return 500, {
                "code": 500,
                "error": "flow_manifest_invalid",
                "materialId": material_id,
            }

        state_path = algorithm_state_path(self.profile.storage_root, material_id)
        algorithm: dict[str, Any] = {}
        try:
            if state_path.is_file():
                value = json.loads(state_path.read_text(encoding="utf-8-sig"))
                if isinstance(value, dict):
                    algorithm = value
        except (OSError, ValueError, json.JSONDecodeError):
            algorithm = {}
        if str(algorithm.get("state", "")).lower() == "failed":
            return 500, {
                "code": 500,
                "error": "defect_detection_failed",
                "materialId": material_id,
                "state": "failed",
                "detail": str(algorithm.get("error", "algorithm failed")),
                "algorithmStatePath": str(state_path),
            }

        backfill_path = (
            self.profile.storage_root
            / "system"
            / "jobs"
            / "defect-history-backfill"
            / "status.json"
        )
        backfill: dict[str, Any] = {}
        try:
            if backfill_path.is_file():
                value = json.loads(backfill_path.read_text(encoding="utf-8-sig"))
                lock_path = backfill_path.with_name(".lock")
                process_id = int(lock_path.read_text(encoding="ascii").strip())
                if (
                    isinstance(value, dict)
                    and value.get("state") in {"running", "paused"}
                    and int(value.get("processId", process_id) or 0) == process_id
                    and _process_is_running(process_id)
                ):
                    backfill = {**value, "processId": process_id}
        except (OSError, ValueError, json.JSONDecodeError):
            backfill = {}

        if flow_state == "capturing":
            pending_state = "waiting-for-flow-close"
            phase = "capture"
        elif backfill:
            pending_state = (
                "paused-for-capture"
                if str(backfill.get("state", "")).lower() == "paused"
                else "building"
                if str(backfill.get("currentMaterialId", "")) == material_id
                else "queued"
            )
            phase = "history-backfill"
        elif algorithm:
            pending_state = str(algorithm.get("state", "processing"))
            phase = "flow-analysis"
        elif frame_event_root(self.profile.storage_root, material_id).is_dir():
            pending_state = "queued"
            phase = "flow-analysis"
        else:
            pending_state = "waiting-for-committed-frames"
            phase = "capture"
        return 202, {
            "code": 0,
            "schema": "steel.defect-processing-status.v1",
            "state": pending_state,
            "phase": phase,
            "materialId": material_id,
            "flowState": flow_state,
            "retryAfterMs": 2000,
            "algorithmStatePath": str(state_path),
            "historyBackfill": {
                "state": backfill.get("state"),
                "phase": backfill.get("phase"),
                "currentMaterialId": backfill.get("currentMaterialId"),
                "pauseReason": backfill.get("pauseReason"),
                "capturePhase": backfill.get("capturePhase"),
                "captureQueue": backfill.get("captureQueue"),
                "reprocessedMaterials": backfill.get("reprocessedMaterials"),
                "materialCount": backfill.get("materialCount"),
            }
            if backfill
            else None,
        }

    def defect_detection_json(
        self, material_id: str = ""
    ) -> tuple[int, dict[str, Any]]:
        normalized = self._normalized_flow_id(material_id, optional=True)
        if normalized is None:
            return 400, {"code": 400, "error": "invalid_material_id"}
        if not normalized:
            with self.alignment_lock:
                capture_status = dict(self.defect_detection_status)
            queue_status = self._flow_analysis_queue_status()
            if queue_status is not None:
                return 200, {
                    "code": 0,
                    **queue_status,
                    "captureStatus": capture_status,
                }
            return 200, {"code": 0, **capture_status}
        path = defect_detection_manifest_path(self.profile.storage_root, normalized)
        if not path.is_file():
            with self.alignment_lock:
                status = dict(self.defect_detection_status)
            if status.get("materialId") == normalized and status.get("state") in {
                "waiting-for-alignment",
                "waiting-for-flow-close",
                "waiting-for-capture-idle",
                "queued",
                "processing",
                "building",
            }:
                return 202, {"code": 0, **status}
            return self._pending_defect_detection_json(normalized)
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
        slot: int = 0,
    ) -> tuple[
        tuple[str, tuple[int, ...], str],
        tuple[str, tuple[int, ...], str],
    ]:
        shape = tuple(frame.depth_raw.shape)
        depth_dtype = frame.depth_raw.dtype.str
        intensity_dtype = frame.intensity.dtype.str
        buffer_key = (camera_key, max(0, int(slot)))
        with self.storage_shared_buffer_lock:
            existing = self.storage_shared_buffers.get(buffer_key)
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
                self.storage_shared_buffers[buffer_key] = existing
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

    def _wait_storage_round_order(self, phase: str, storage_order: int) -> None:
        attribute = (
            "storage_next_prepare_order"
            if phase == "prepare"
            else "storage_next_finalize_order"
        )
        with self.storage_round_order_condition:
            while int(getattr(self, attribute)) != int(storage_order):
                self.storage_round_order_condition.wait(timeout=0.25)

    def _advance_storage_round_order(self, phase: str, storage_order: int) -> None:
        attribute = (
            "storage_next_prepare_order"
            if phase == "prepare"
            else "storage_next_finalize_order"
        )
        with self.storage_round_order_condition:
            current = int(getattr(self, attribute))
            if current != int(storage_order):
                raise RuntimeError(
                    f"storage {phase} order mismatch: expected {current}, "
                    f"completed {storage_order}"
                )
            setattr(self, attribute, current + 1)
            self.storage_round_order_condition.notify_all()

    def _persist_cached_round(
        self,
        rows: list[dict[str, Any]],
        *,
        material_id: str,
        session_id: str,
        boundary_phase: str,
        require_steel_signal: bool = False,
        production_event_id: str | None = None,
        storage_order: int | None = None,
    ) -> list[dict[str, Any]]:
        if not material_id or not session_id:
            return []

        if production_event_id is None:
            with self.state_lock:
                production_event_id = self.active_flow_code
        resolved_event_id = production_event_id or ""
        storage_slot = (
            int(storage_order) % self.storage_round_workers
            if storage_order is not None
            else 0
        )
        storage_started = time.monotonic()
        futures: list[tuple[Any, CameraProfile, Any, dict[str, Any]]] = []
        copy_futures: dict[
            Any,
            tuple[CameraProfile, Any, dict[str, Any], dict[str, Any], Any],
        ] = {}
        ordered_round = storage_order is not None
        finalize_order_released = not ordered_round
        try:
            if ordered_round:
                self._wait_storage_round_order("prepare", int(storage_order))
            try:
                for row in rows:
                    frame = row.get("_rawFrame")
                    camera = self.camera_for_identity(str(row.get("cameraKey", "")))
                    if frame is None or camera is None:
                        continue
                    if (
                        float(row.get("maxIntensity", 0.0))
                        <= self.profile.black_frame_threshold
                    ):
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
                        # Level 1 is the measured optimum on the target host:
                        # it encodes faster than level 0 and cuts roughly
                        # 10 MiB/round.
                        "intensity_compress_level": 1,
                    }
                    if self.storage_process_workers:
                        if self.storage_copy_pool is None:
                            raise RuntimeError(
                                "storage shared-memory copy pool is unavailable"
                            )
                        options["index"] = self.writer.sequences.reserve(
                            camera.storage_root,
                            material_id,
                            camera.camera_id,
                        )
                        frame_stub = replace(
                            frame,
                            depth_raw=np.empty((0, 0), dtype=np.uint16),
                            intensity=np.empty((0, 0), dtype=np.uint8),
                        )
                        copy_future = self.storage_copy_pool.submit(
                            self._share_storage_frame,
                            camera.key,
                            frame,
                            storage_slot,
                        )
                        copy_futures[copy_future] = (
                            camera,
                            frame,
                            row,
                            options,
                            frame_stub,
                        )
                    else:
                        future = self.storage_writer_pool.submit(
                            self.writer.write,
                            camera.storage_root,
                            material_id,
                            frame,
                            **options,
                        )
                        futures.append((future, camera, frame, row))
            finally:
                if ordered_round:
                    self._advance_storage_round_order("prepare", int(storage_order))

            # Each camera and in-flight round owns a distinct shared-memory
            # block.  Submit its disk task as soon as the copy completes to
            # overlap remaining copies with PNG/NPZ persistence.
            for copy_future in as_completed(copy_futures):
                camera, frame, row, options, frame_stub = copy_futures[copy_future]
                depth_descriptor, intensity_descriptor = copy_future.result()
                future = self.storage_writer_pool.submit(
                    _write_storage_shared_frame,
                    camera.storage_root,
                    material_id,
                    frame_stub,
                    depth_descriptor,
                    intensity_descriptor,
                    options,
                )
                futures.append((future, camera, frame, row))

            submitted_at = time.monotonic()
            committed: list[dict[str, Any]] = []
            committed_bytes = 0
            for future, camera, frame, source_row in futures:
                try:
                    result = future.result()
                    persisted = result.provider_row(
                        frame,
                        int(source_row.get("round", 0)),
                    )
                    persisted.update(
                        {
                            "parallelIndex": int(source_row.get("parallelIndex", 0)),
                            "frameReceived": True,
                            "discarded": False,
                            "meanIntensity": float(
                                source_row.get("meanIntensity", 0.0)
                            ),
                            "maxIntensity": float(
                                source_row.get("maxIntensity", 0.0)
                            ),
                            "brightPixelRatio": float(
                                source_row.get("brightPixelRatio", 0.0)
                            ),
                            "steelSignal": bool(source_row.get("steelSignal")),
                            "capturedAt": str(
                                source_row.get("capturedAt", _utc_text())
                            ),
                            "cameraFrameSequence": source_row.get(
                                "cameraFrameSequence"
                            ),
                            "transportFrameId": source_row.get("transportFrameId"),
                            "transportFrameGap": source_row.get(
                                "transportFrameGap", 0
                            ),
                            "deviceTimestamp": source_row.get("deviceTimestamp"),
                            "timestampFrequency": source_row.get(
                                "timestampFrequency"
                            ),
                            "hostUtcNs": source_row.get("hostUtcNs"),
                            "hostMonotonicNs": source_row.get("hostMonotonicNs"),
                            "frameTriggerMode": source_row.get("frameTriggerMode"),
                            "triggerIssuedNs": source_row.get("triggerIssuedNs"),
                            "triggerCompletedNs": source_row.get(
                                "triggerCompletedNs"
                            ),
                            "triggerCommandLatencyUs": source_row.get(
                                "triggerCommandLatencyUs"
                            ),
                            "boundaryPhase": boundary_phase,
                        }
                    )
                    committed.append(persisted)
                    committed_bytes += int(getattr(result, "write_bytes", 0))
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

            writes_completed_at = time.monotonic()
            finalize_wait_started = time.monotonic()
            if ordered_round:
                self._wait_storage_round_order("finalize", int(storage_order))
            finalize_order_acquired_at = time.monotonic()
            try:
                if committed:
                    event_path = publish_committed_round(
                        self.profile.storage_root,
                        material_id,
                        session_id,
                        committed,
                        boundary_phase=boundary_phase,
                        expected_camera_ids={
                            camera.camera_id for camera in self.profile.enabled_cameras
                        },
                        artifacts_verified=True,
                    )
                    event_completed_at = time.monotonic()
                    latest_round = int(committed[0].get("round", 0))
                    # Serialize manifest updates with steel-in/out.  Post-roll
                    # storage is intentionally asynchronous and can finish
                    # after steel-out; those late commits may advance the
                    # latest round but must not reopen an already closed flow.
                    with self.state_lock:
                        active = (
                            self.steel_present
                            and self.active_material_id == material_id
                            and self.active_session_id == session_id
                        )
                        manifest_state = "capturing"
                        if not active:
                            try:
                                current_manifest = json.loads(
                                    (
                                        self.profile.storage_root
                                        / material_id
                                        / "flow.json"
                                    ).read_text(encoding="utf-8")
                                )
                                if (
                                    str(current_manifest.get("state", "")).lower()
                                    == "closed"
                                ):
                                    manifest_state = "closed"
                            except (OSError, ValueError):
                                pass
                        write_flow_manifest(
                            self.profile.storage_root,
                            material_id,
                            session_id=session_id,
                            state=manifest_state,
                            camera_roots=self._flow_capture_roots(material_id),
                            latest_round=latest_round,
                        )
                    for row in committed:
                        row["frameCommittedEvent"] = str(event_path)
                    self._enqueue_database_commit(material_id, session_id, committed)
                    finalized_at = time.monotonic()
                    storage_elapsed = max(finalized_at - storage_started, 0.000_001)
                    with self.storage_queue_lock:
                        self.storage_write_samples.append(
                            (finalized_at, committed_bytes, storage_elapsed)
                        )
                        self.storage_round_stage_samples.append(
                            {
                                "submit": max(
                                    0.0,
                                    submitted_at - storage_started,
                                ),
                                "writerWait": max(
                                    0.0,
                                    writes_completed_at - submitted_at,
                                ),
                                "finalizeOrderWait": max(
                                    0.0,
                                    finalize_order_acquired_at
                                    - finalize_wait_started,
                                ),
                                "event": max(
                                    0.0,
                                    event_completed_at
                                    - finalize_order_acquired_at,
                                ),
                                "finalize": max(
                                    0.0,
                                    finalized_at - event_completed_at,
                                ),
                                "total": storage_elapsed,
                            }
                        )
                    if boundary_phase != "normal":
                        self._log(
                            "info",
                            "boundary frames persisted",
                            boundaryPhase=boundary_phase,
                            frameCount=len(committed),
                            materialId=material_id,
                            sessionId=session_id,
                        )
                return committed
            finally:
                if ordered_round:
                    self._advance_storage_round_order("finalize", int(storage_order))
                    finalize_order_released = True
        except Exception:
            # An earlier round must always release the ordered finalization
            # gate, even if shared-memory preparation or a pool submission
            # fails, otherwise every later round would wait forever.
            if ordered_round and not finalize_order_released:
                self._wait_storage_round_order("finalize", int(storage_order))
                self._advance_storage_round_order("finalize", int(storage_order))
            raise

    def _enqueue_storage_round(
        self,
        rows: list[dict[str, Any]],
        *,
        material_id: str,
        session_id: str,
        boundary_phase: str,
        require_steel_signal: bool = False,
        force: bool = False,
        save_generation: int | None = None,
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
            if save_generation is not None:
                # Validate the production arm while the queue admission lock
                # is held. This closes the narrow race where steel-out lands
                # after a frame's post-fetch check but before this round is
                # counted as pending. If admission wins first, steel-out can
                # observe and drain the queued round; if steel-out wins, this
                # stale generation is rejected before any write is scheduled.
                with self.state_lock:
                    still_armed = (
                        self.save_enabled
                        and self.save_generation == save_generation
                        and self.active_material_id == material_id
                        and self.active_session_id == session_id
                    )
                if not still_armed:
                    return False
            self.storage_queue_pending_rounds += 1
            self.storage_queue_pending_by_material[material_id] = (
                self.storage_queue_pending_by_material.get(material_id, 0) + 1
            )
            self.storage_queue_high_water_rounds = max(
                self.storage_queue_high_water_rounds,
                self.storage_queue_pending_rounds,
            )
            storage_order = self.storage_round_order
            self.storage_round_order += 1

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
                    storage_order=storage_order,
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
                with self.storage_queue_lock:
                    self.storage_queue_last_error = f"{type(error).__name__}: {error}"
                    self.storage_queue_last_failed_at = _utc_text()
                    self.storage_queue_last_failed_phase = boundary_phase
                    self.storage_queue_last_failed_material_id = material_id
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
                camera.key in self.stream_subscriptions
                and self._acquisition_running()
                and camera.key in self.sessions
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
            "streamValidRoi": self.stream_valid_rois.get(camera.key),
            "streamDisplayWidth": (
                self.stream_valid_rois[camera.key][2] - self.stream_valid_rois[camera.key][0]
                if camera.key in self.stream_valid_rois
                else self.stream_dimensions.get(camera.key, (0, 0))[0]
            ),
            "streamDisplayHeight": self.stream_dimensions.get(camera.key, (0, 0))[1],
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
            "acquisitionLineRate": telemetry.get(
                "acquisitionLineRate", camera_config.get("AcquisitionLineRate")
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
        flow_analysis_queue = self._flow_analysis_queue_status()
        return {
            "code": 0 if backend_ready else 49110,
            "service": "steel_sick_capture_sidecar",
            "time": _utc_text(),
            # These fields are part of the physical capture-health contract
            # consumed by the Tauri client.  Without them the client treats an
            # otherwise healthy external provider as malformed and falls back
            # to the legacy eight-camera defaults.
            "provider": "external-api",
            "historyOnly": self.history_only,
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
            "cameraConnection": self._connection_status_json(),
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
            "flowAnalysisQueue": flow_analysis_queue,
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
            round_stage_latency: dict[str, dict[str, float | int | None]] = {}
            for stage in (
                "submit",
                "writerWait",
                "finalizeOrderWait",
                "event",
                "finalize",
                "total",
            ):
                values = [sample[stage] * 1000.0 for sample in self.storage_round_stage_samples]
                ordered = sorted(values)
                p95_index = max(
                    0,
                    min(
                        len(ordered) - 1,
                        (len(ordered) * 95 + 99) // 100 - 1,
                    ),
                )
                round_stage_latency[stage] = {
                    "samples": len(values),
                    "latest": round(values[-1], 3) if values else None,
                    "average": round(sum(values) / len(values), 3) if values else None,
                    "p95": round(ordered[p95_index], 3) if values else None,
                    "maximum": round(max(values), 3) if values else None,
                }
            return {
                "accepting": self.storage_queue_accepting,
                "workerCount": (
                    self.storage_process_workers or self.storage_writer_threads
                ),
                "writerMode": (
                    "process-shared-memory"
                    if self.storage_process_workers
                    else "thread"
                ),
                "writerProcessCount": self.storage_process_workers,
                "writerProcessesPrewarmed": self.storage_writer_processes_prewarmed,
                "writerThreadCount": self.storage_writer_threads,
                "copyWorkerCount": self.storage_copy_workers,
                "roundWorkerCount": self.storage_round_workers,
                "writerTopology": (
                    "ordered-pipelined-rounds+one-process-per-camera-task"
                    if self.storage_process_workers
                    else "one-thread-per-camera-task"
                ),
                "previewWorkerCount": self.preview_worker_threads,
                "sharedMemorySlots": len(self.storage_shared_buffers),
                "sharedMemoryBufferSets": self.storage_round_workers,
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
                "lastFailedAt": self.storage_queue_last_failed_at or None,
                "lastFailedPhase": self.storage_queue_last_failed_phase or None,
                "lastFailedMaterialId": (
                    self.storage_queue_last_failed_material_id or None
                ),
                "lastError": self.storage_queue_last_error or None,
                "highWaterRounds": self.storage_queue_high_water_rounds,
                "backpressureWaits": self.storage_queue_backpressure_waits,
                "backpressureSeconds": round(self.storage_queue_backpressure_seconds, 3),
                "recentWriteBytesPerSecond": (
                    round(recent_bytes / recent_seconds, 3) if recent_seconds > 0 else 0.0
                ),
                "cameraWriteLatencyMs": camera_write_latency,
                "roundStageLatencyMs": round_stage_latency,
                "implementation": "bounded-round-cache+lossless-backpressure+ordered-pipelined-round-writer+per-camera-disks",
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
        try:
            active_calibration = self.active_array_calibration()
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
            active_calibration = {
                "path": self.array_calibration_path or "",
                "revision": "",
                "source": "unavailable",
                "pointerError": str(error),
            }
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
            "arrayCalibrationPath": str(active_calibration.get("path", "")),
            "arrayCalibrationAvailable": bool(
                active_calibration.get("path")
                and Path(active_calibration["path"]).is_file()
            ),
            "arrayCalibrationRevision": active_calibration.get("revision", ""),
            "arrayCalibrationSource": active_calibration.get("source", ""),
            "arrayCalibrationPointerError": active_calibration.get("pointerError", ""),
            "storageWriteCacheRounds": self.storage_queue_capacity_rounds,
            "storageRoundWorkers": self.storage_round_workers,
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
        completed_session_id = ""
        if normalized in {"steelin", "in"} and value:
            try:
                flow_no = int(payload.get("flowNo", material_id))
            except (TypeError, ValueError):
                return {"code": 400, "error": "steel-in requires numeric flowNo"}
            if flow_no <= 0 or material_id != str(flow_no):
                return {
                    "code": 400,
                    "error": "capture storage identity must equal numeric flowNo",
                }
        with self.state_lock:
            if normalized in {"steelin", "in"}:
                self.save_generation += 1
                if value:
                    if not material_id or not session_id:
                        return {"code": 400, "error": "steel-in requires materialId and sessionId"}
                    if self.active_material_id and self.active_material_id != material_id:
                        completed_material_id = self.active_material_id
                        completed_session_id = self.active_session_id
                    self.active_material_id = material_id
                    self.active_session_id = session_id
                    self.active_flow_no = int(payload.get("flowNo", 0) or 0) or None
                    self.active_flow_code = str(payload.get("flowCode", ""))
                    self.steel_present = True
                    self.save_enabled = bool(payload.get("saveEnabled", True))
                    write_flow_manifest(
                        self.profile.storage_root,
                        material_id,
                        session_id=session_id,
                        state="capturing",
                        camera_roots=self._flow_capture_roots(material_id),
                    )
                else:
                    completed_material_id = self.active_material_id or material_id
                    completed_session_id = self.active_session_id or session_id
                    self.steel_present = False
                    self.save_enabled = False
                    self.active_material_id = ""
                    self.active_session_id = ""
                    self.active_flow_no = None
                    self.active_flow_code = ""
            elif normalized in {"reset", "clear"}:
                completed_material_id = self.active_material_id or material_id
                completed_session_id = self.active_session_id or session_id
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
            self._close_flow_manifest(
                completed_material_id,
                session_id=completed_session_id,
                reason=(
                    "superseded-by-new-flow"
                    if normalized in {"steelin", "in"} and value
                    else "steel-out-or-reset"
                ),
            )
            self._log(
                "info",
                "flow closed; algorithm service owns derived processing",
                materialId=completed_material_id,
                algorithmEventRoot=str(
                    self.profile.storage_root
                    / completed_material_id
                    / "events"
                    / "frame-committed"
                ),
            )
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
            streaming = bool(self.stream_subscriptions)
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
        if intensity.size == 0:
            return
        preview_black_max = max(
            LIVE_PREVIEW_BLACK_MAX,
            self.profile.black_frame_threshold,
        )
        visible_ratio = float(
            np.count_nonzero(intensity > self.steel_bright_threshold)
        ) / float(intensity.size)
        visible_frame = bool(
            float(np.max(intensity)) > preview_black_max
            and visible_ratio >= self.steel_bright_ratio
        )
        height, width = intensity.shape
        if visible_frame:
            detected_roi = detect_valid_sensor_roi(
                intensity,
                np.asarray(frame.depth_raw),
                threshold=self.steel_bright_threshold,
                minimum_occupancy=max(0.0005, self.steel_bright_ratio / 4.0),
                minimum_width=min(64, int(intensity.shape[1])),
            )
            if detected_roi is None:
                return
            with self.stream_lock:
                samples = self.stream_roi_samples.setdefault(camera.key, deque(maxlen=8))
                if (
                    camera.key not in self.stream_valid_rois
                    and detected_roi[3] - detected_roi[1] >= height * 0.8
                ):
                    samples.append(detected_roi)
                    if len(samples) >= 8:
                        stable = stable_horizontal_roi(list(samples), width, height)
                        if stable is not None:
                            self.stream_valid_rois[camera.key] = stable
                display_roi = self.stream_valid_rois.get(
                    camera.key,
                    [detected_roi[0], 0, detected_roi[2], height],
                )
        else:
            # A real but dark camera frame must still make a new subscription
            # ready. Once a useful frame exists, keep it instead of replacing
            # it with black or sparse noise between steel records.
            with self.stream_lock:
                if "intensity-grid" in self.stream_latest.get(camera.key, {}):
                    return
            display_roi = [0, 0, width, height]
        crop_left, _crop_top, crop_right, _crop_bottom = display_roi
        valid_intensity = intensity[:, crop_left:crop_right]
        valid_depth = np.asarray(frame.depth_raw)[:, crop_left:crop_right]
        now = time.monotonic()
        with self.stream_lock:
            options = self.stream_subscriptions.get(camera.key)
            if options is None:
                return
            fps_limit = int(options.get("fpsLimit", 5) or 5)
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
                valid_intensity,
                depth=False,
                max_width=800,
                minimum_visible_max=(LIVE_PREVIEW_BLACK_MAX if visible_frame else None),
            )
            if grid_preview is None:
                return
            latest = {"intensity-grid": grid_preview}
            # The 2x3 overview uses only the 800-pixel preview.  Full-width
            # intensity and the considerably more expensive depth percentile
            # conversion are generated only while the UI is actively asking
            # for that kind on the focused camera.
            if "intensity-valid" in requested_kinds:
                intensity_preview = self._preview_png(valid_intensity, depth=False)
                if intensity_preview is not None:
                    latest["intensity-valid"] = intensity_preview
            if "depth-valid" in requested_kinds:
                depth_preview = self._preview_png(valid_depth, depth=True)
                if depth_preview is not None:
                    latest["depth-valid"] = depth_preview
            if "intensity-raw" in requested_kinds:
                intensity_preview = self._preview_png(intensity, depth=False)
                if intensity_preview is not None:
                    latest["intensity-raw"] = intensity_preview
            if "depth-raw" in requested_kinds:
                depth_preview = self._preview_png(frame.depth_raw, depth=True)
                if depth_preview is not None:
                    latest["depth-raw"] = depth_preview
        except Exception as error:
            self._log("warning", "SICK live preview conversion failed", cameraKey=camera.key, error=str(error))
            return
        with self.stream_lock:
            if camera.key not in self.stream_subscriptions:
                return
            camera_latest = self.stream_latest.setdefault(camera.key, {})
            camera_latest.update(latest)
            requested = self.stream_requested_kinds.get(camera.key, {})
            for ready_kind in latest:
                requested.pop(ready_kind, None)
            if not requested:
                self.stream_requested_kinds.pop(camera.key, None)
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
            self.stream_ready.notify_all()

    def _schedule_stream_frame(self, camera: CameraProfile, frame: Any) -> None:
        with self.stream_lock:
            if camera.key not in self.stream_subscriptions:
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

    def _seed_stream_cache_from_storage(self, camera_key: str = "") -> None:
        # Starts are rare and bounded by the camera count.  Serialize archive
        # reads so six near-simultaneous UI subscriptions cannot create a disk
        # scan burst; later seed threads normally find a live frame already.
        with self.preview_seed_lock:
            def seed_camera(
                camera: CameraProfile,
            ) -> tuple[
                CameraProfile,
                dict[str, bytes],
                tuple[int, int],
                list[int],
            ] | None:
                with self.stream_lock:
                    if camera.key not in self.stream_subscriptions:
                        return None
                    existing_kinds = set(self.stream_latest.get(camera.key, {}))
                    requested_kinds = set(
                        self.stream_requested_kinds.get(camera.key, {})
                    )
                    if "intensity-grid" in existing_kinds and requested_kinds.issubset(
                        existing_kinds
                    ):
                        return None
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
                        detected_roi = detect_valid_sensor_roi(
                            intensity,
                            threshold=self.steel_bright_threshold,
                            minimum_occupancy=max(0.0005, self.steel_bright_ratio / 4.0),
                            minimum_width=min(64, int(intensity.shape[1])),
                        )
                        if detected_roi is None:
                            continue
                        height, width = intensity.shape
                        manifest_roi: list[int] | None = None
                        # v3 layout is <camera-root>/<flow>/2d/<frame>.png.
                        # Derive the flow from the path itself so cached ROI data
                        # belongs to the same acquisition rather than the camera.
                        material_id = path.parents[1].name
                        region_manifest = read_region_manifest(
                            self.profile.storage_root,
                            material_id,
                        )
                        if region_manifest is not None:
                            region_cameras = region_manifest.get("cameras", {})
                            if isinstance(region_cameras, dict):
                                candidate_cameras = [region_cameras.get(camera.key)]
                            elif isinstance(region_cameras, list):
                                candidate_cameras = region_cameras
                            else:
                                candidate_cameras = []
                            for region_camera in candidate_cameras:
                                if not isinstance(region_camera, dict):
                                    continue
                                if str(region_camera.get("cameraId", "")) != camera.key:
                                    continue
                                candidate_roi = region_camera.get("stableCrop")
                                if (
                                    isinstance(candidate_roi, list)
                                    and len(candidate_roi) == 4
                                    and int(candidate_roi[0]) >= 0
                                    and int(candidate_roi[1]) == 0
                                    and int(candidate_roi[2]) <= width
                                    and int(candidate_roi[3]) == height
                                    and int(candidate_roi[2]) > int(candidate_roi[0])
                                ):
                                    manifest_roi = [int(value) for value in candidate_roi]
                                break
                        with self.stream_lock:
                            display_roi = self.stream_valid_rois.get(
                                camera.key,
                                manifest_roi
                                or [detected_roi[0], 0, detected_roi[2], height],
                            )
                        valid_intensity = intensity[:, display_roi[0] : display_roi[2]]
                        grid_preview = self._preview_png(
                            valid_intensity,
                            depth=False,
                            max_width=800,
                        )
                        if grid_preview is None:
                            continue
                        previews = {
                            "intensity-grid": grid_preview,
                            "intensity-valid": grid_preview,
                        }
                        if "intensity-raw" in requested_kinds:
                            raw_intensity = self._preview_png(intensity, depth=False)
                            if raw_intensity is not None:
                                previews["intensity-raw"] = raw_intensity
                        depth_requested = bool(
                            {"depth-valid", "depth-raw"} & requested_kinds
                        )
                        depth_path = path.parent.parent / "3d" / f"{path.stem}.npz"
                        if depth_requested and depth_path.is_file():
                            try:
                                with np.load(depth_path, allow_pickle=False) as archive:
                                    if "array" not in archive.files:
                                        raise ValueError(
                                            f"depth archive has no array component: {depth_path}"
                                        )
                                    depth = np.asarray(archive["array"]).copy()
                                if depth.shape == intensity.shape:
                                    valid_depth = depth[
                                        :, display_roi[0] : display_roi[2]
                                    ]
                                    depth_preview = self._preview_png(
                                        valid_depth,
                                        depth=True,
                                    )
                                    if depth_preview is not None:
                                        previews["depth-valid"] = depth_preview
                                    if "depth-raw" in requested_kinds:
                                        raw_depth = self._preview_png(
                                            depth,
                                            depth=True,
                                        )
                                        if raw_depth is not None:
                                            previews["depth-raw"] = raw_depth
                            except (OSError, ValueError, KeyError):
                                pass
                    except (OSError, ValueError):
                        continue
                    return (
                        camera,
                        previews,
                        (width, height),
                        display_roi,
                    )
                return None

            with self.stream_lock:
                subscribed = set(self.stream_subscriptions)
            cameras = [
                camera
                for camera in self.profile.enabled_cameras
                if camera.key in subscribed
                and (not camera_key or camera.key == camera_key)
            ]
            if not cameras:
                return
            with ThreadPoolExecutor(
                max_workers=max(1, min(6, len(cameras))),
                thread_name_prefix="preview-seed-camera",
            ) as pool:
                seeded = pool.map(seed_camera, cameras)
                for result in seeded:
                    if result is None:
                        continue
                    (
                        camera,
                        previews,
                        dimensions,
                        display_roi,
                    ) = result
                    with self.stream_lock:
                        if camera.key not in self.stream_subscriptions:
                            continue
                        camera_latest = self.stream_latest.setdefault(camera.key, {})
                        for kind, preview in previews.items():
                            camera_latest.setdefault(kind, preview)
                        requested = self.stream_requested_kinds.get(camera.key, {})
                        for ready_kind in previews:
                            requested.pop(ready_kind, None)
                        if not requested:
                            self.stream_requested_kinds.pop(camera.key, None)
                        self.stream_dimensions.setdefault(camera.key, dimensions)
                        self.stream_valid_rois.setdefault(camera.key, display_roi)
                        self.stream_ready.notify_all()

    def _schedule_stream_seed(self, camera_key: str) -> None:
        """Deduplicate archive seed work without involving acquisition threads."""
        with self.preview_work_lock:
            if camera_key in self.preview_seed_pending_cameras:
                return
            self.preview_seed_pending_cameras.add(camera_key)

        def seed() -> None:
            try:
                self._seed_stream_cache_from_storage(camera_key)
            finally:
                with self.preview_work_lock:
                    self.preview_seed_pending_cameras.discard(camera_key)
                with self.stream_ready:
                    self.stream_ready.notify_all()

        threading.Thread(
            target=seed,
            name=f"sick-preview-seed-{camera_key}",
            daemon=True,
        ).start()

    def stream_status(self, identity: str = "") -> dict[str, Any]:
        camera = self.camera_for_identity(identity) if identity else None
        with self.stream_lock:
            active_key = (
                self.stream_camera_key
                if self.stream_camera_key in self.stream_subscriptions
                else next(iter(self.stream_subscriptions), "")
            )
            active = self.camera_for_identity(active_key) if active_key else None
            reported = camera if identity else active
            reported_key = reported.key if reported is not None else ""
            running = bool(
                reported_key in self.stream_subscriptions
                and self._acquisition_running()
                and reported_key in self.sessions
            )
            options = dict(self.stream_subscriptions.get(reported_key, {}))
            subscribed_keys = list(self.stream_subscriptions)
            ready_variants = sorted(self.stream_latest.get(reported_key, {}))
            primary_variant = (
                "depth-valid"
                if int(options.get("dataMode", 3) or 3) == 1
                else "intensity-grid"
            )
            primary_ready = primary_variant in ready_variants
            grid_ready = "intensity-grid" in ready_variants
            ready_kinds = sorted(
                {
                    "intensity-grid" if value == "intensity-grid" else value.split("-", 1)[0]
                    for value in ready_variants
                }
            )
            return {
                "code": 0,
                "running": running,
                "ready": primary_ready,
                "warmingUp": running and not primary_ready,
                "primaryVariant": primary_variant,
                "primaryReady": primary_ready,
                "gridReady": grid_ready,
                "readyKinds": ready_kinds,
                "readyVariants": ready_variants,
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
                "subscriptionCount": len(subscribed_keys),
                "subscribedCameraIds": subscribed_keys,
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
            already_subscribed = camera.key in self.stream_subscriptions
            self.stream_subscriptions[camera.key] = options
            self.stream_started_at_by_camera.setdefault(camera.key, _utc_text())
            # Aggregate aliases identify the most recently started stream for
            # clients that omit a camera identity.  They do not own the other
            # subscriptions.
            self.stream_camera_key = camera.key
            self.stream_options = options
            self.stream_started_at = _utc_text()
            if not already_subscribed:
                if self.capture_mode != "continuous":
                    self.stream_latest.pop(camera.key, None)
                self.stream_frame_counts[camera.key] = 0
                self.stream_last_frame_at_by_camera.pop(camera.key, None)
                self.stream_frame_ticks_by_camera[camera.key] = deque(maxlen=20)
                self.stream_requested_kinds.pop(camera.key, None)
            # Mode 1 is a depth-only focused preview. Modes 2/3 initially need
            # only the bounded overview image; full-width intensity and depth
            # are generated on their first focused request.
            initial_kind = (
                "depth-valid" if options["dataMode"] == 1 else "intensity-grid"
            )
            self.stream_requested_kinds.setdefault(camera.key, {})[
                initial_kind
            ] = time.monotonic()
            self.stream_frame_count = self.stream_frame_counts.get(camera.key, 0)
            self.stream_last_frame_at = self.stream_last_frame_at_by_camera.get(
                camera.key, ""
            )
            self.stream_frame_ticks = self.stream_frame_ticks_by_camera.setdefault(
                camera.key, deque(maxlen=20)
            )
        self._schedule_stream_seed(camera.key)
        self._ensure_acquisition_worker()
        return self.stream_status(camera.ip)

    def stop_stream(self, payload: dict[str, Any]) -> dict[str, Any]:
        identity = str(payload.get("ip", payload.get("cameraId", ""))).strip()
        requested = self.camera_for_identity(identity) if identity else None
        if identity and requested is None:
            return {
                "code": 404,
                "error": "camera_not_found",
                "ip": identity,
                "running": False,
            }
        with self.stream_lock:
            stopped_keys = (
                list(self.stream_subscriptions)
                if requested is None
                else [requested.key]
            )
            for camera_key in stopped_keys:
                self.stream_subscriptions.pop(camera_key, None)
                self.stream_started_at_by_camera.pop(camera_key, None)
                self.stream_latest.pop(camera_key, None)
                self.stream_frame_counts.pop(camera_key, None)
                self.stream_last_frame_at_by_camera.pop(camera_key, None)
                self.stream_frame_ticks_by_camera.pop(camera_key, None)
                self.stream_requested_kinds.pop(camera_key, None)
                self.stream_dimensions.pop(camera_key, None)
                self.stream_valid_rois.pop(camera_key, None)
                self.stream_roi_samples[camera_key] = deque(maxlen=8)
            if self.stream_subscriptions:
                remaining_key = next(reversed(self.stream_subscriptions))
                self.stream_camera_key = remaining_key
                self.stream_options = dict(self.stream_subscriptions[remaining_key])
                self.stream_frame_count = self.stream_frame_counts.get(remaining_key, 0)
                self.stream_last_frame_at = self.stream_last_frame_at_by_camera.get(
                    remaining_key, ""
                )
                self.stream_frame_ticks = self.stream_frame_ticks_by_camera.get(
                    remaining_key, deque(maxlen=20)
                )
            else:
                self.stream_camera_key = ""
                self.stream_options = {}
                self.stream_latest.clear()
                self.stream_frame_counts.clear()
                self.stream_last_frame_at_by_camera.clear()
                self.stream_frame_ticks_by_camera.clear()
                self.stream_frame_ticks.clear()
                self.stream_requested_kinds.clear()
                self.stream_dimensions.clear()
                self.stream_valid_rois.clear()
                self.stream_roi_samples = {
                    camera.key: deque(maxlen=8)
                    for camera in self.profile.enabled_cameras
                }
            remaining_subscriptions = len(self.stream_subscriptions)
            self.stream_ready.notify_all()
        with self.preview_work_lock:
            for camera_key in stopped_keys:
                self.preview_scheduled_at.pop(camera_key, None)
        self._stop_acquisition_if_idle()
        return {
            "code": 0,
            "running": False,
            "ip": identity,
            "frameCount": 0,
            "remainingSubscriptions": remaining_subscriptions,
        }

    def stream_latest_bytes(
        self,
        identity: str,
        kind: str,
        region: str = "raw",
        *,
        wait_seconds: float = 0.0,
    ) -> bytes | None:
        camera = self.camera_for_identity(identity) if identity else None
        target_key = ""
        storage_kind = ""
        with self.stream_ready:
            if kind not in {"depth", "intensity", "intensity-grid"}:
                return None
            if region not in {"raw", "valid"}:
                return None
            if not self.stream_subscriptions:
                return None
            target = camera or self.camera_for_identity(self.stream_camera_key)
            if target is None:
                return None
            if target.key not in self.stream_subscriptions:
                return None
            storage_kind = kind if kind == "intensity-grid" else f"{kind}-{region}"
            target_key = target.key
            if kind in {"intensity", "depth"}:
                self.stream_requested_kinds.setdefault(target.key, {})[
                    storage_kind
                ] = time.monotonic()
            ready = self.stream_latest.get(target.key, {}).get(storage_kind)
            if ready is not None:
                return ready

        # A later kind switch may happen after the start-time archive seed.
        # Schedule one deduplicated retry, then let only this HTTP worker wait
        # for either the seed or the next live preview publication.
        self._schedule_stream_seed(target_key)
        deadline = time.monotonic() + max(0.0, min(2.0, float(wait_seconds)))
        with self.stream_ready:
            while target_key in self.stream_subscriptions:
                ready = self.stream_latest.get(target_key, {}).get(storage_kind)
                if ready is not None:
                    return ready
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self.stream_ready.wait(timeout=remaining)
        return None

    def _record_continuous_round(self, results: list[dict[str, Any]], persist_frame: bool) -> None:
        now = time.monotonic()
        with self.state_lock:
            healthy_round = len(results) == len(self.profile.enabled_cameras) and all(
                bool(row.get("frameReceived"))
                and int(row.get("code", SICK_CAPTURE_FAILED))
                in {
                    0,
                    CAPTURE_DISCARDED_NOT_ARMED,
                    BLACK_FRAME_DISCARDED,
                    NO_STEEL_FRAME_DISCARDED,
                }
                for row in results
            )
            if healthy_round and self.last_error.startswith(
                "SICK component schema mismatch"
            ):
                # Empty/incomplete GenTL buffers can occur during startup.
                # Keep lifetime failure counters for audit, but do not leave a
                # stale alarm visible after complete camera rounds recover.
                self.last_error = ""
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
        maximum_live_skew_ms = self.alignment_config.maximum_anchor_residual_ms
        last_host_skew_ms = (
            float(last["hostCaptureSkewMs"])
            if last and last.get("hostCaptureSkewMs") is not None
            else None
        )
        host_skew_within_limit = bool(
            last_host_skew_ms is not None
            and last_host_skew_ms <= maximum_live_skew_ms
        )
        synchronized = bool(
            last
            and last["complete"]
            and complete_rounds == len(window)
            and frame_count_skew <= 1
            and sum(transport_gap_counts.values()) == 0
            and host_skew_within_limit
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
        quality_reasons: list[str] = []
        if window and complete_rounds != len(window):
            quality_reasons.append("incomplete-camera-rounds")
        if frame_count_skew > 1:
            quality_reasons.append("camera-frame-count-skew")
        if sum(transport_gap_counts.values()) > 0:
            quality_reasons.append("transport-frame-gaps")
        if window and not host_skew_within_limit:
            quality_reasons.append("host-capture-skew-out-of-tolerance")
        if len(self.sessions) != self.profile.expected_cameras:
            quality_reasons.append("camera-connection-count-mismatch")
        if (
            self.frame_trigger_mode == "software"
            and last
            and (
                last.get("triggerIssueSkewMs") is None
                or float(last["triggerIssueSkewMs"]) > maximum_live_skew_ms
            )
        ):
            quality_reasons.append("software-trigger-skew-out-of-tolerance")
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
            "maximumHostCaptureSkewMs": maximum_live_skew_ms,
            "lastHostCaptureSkewMs": last_host_skew_ms,
            "hostCaptureSkewWithinLimit": host_skew_within_limit,
            "transportFrameGapCounts": transport_gap_counts,
            "transportFrameGaps": sum(transport_gap_counts.values()),
            "hasRecentFrameDrops": sum(transport_gap_counts.values()) > 0,
            "lifetimeTransportFrameGapCounts": lifetime_transport_gap_counts,
            "lifetimeTransportFrameGaps": sum(lifetime_transport_gap_counts.values()),
            "qualityReasons": quality_reasons,
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
                    stream_keys = set(self.stream_subscriptions)
                if not continuous and not stream_keys:
                    break
                selected = (
                    list(self.profile.enabled_cameras)
                    if continuous
                    else [
                        camera
                        for camera in self.profile.enabled_cameras
                        if camera.key in stream_keys
                    ]
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
                                save_generation=save_generation,
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

    def _prepare_capture_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Resolve one positive numeric flow id before capture starts."""
        request = dict(payload)
        material_id = str(
            request.get("materialId", self.active_material_id)
        ).strip()
        if not material_id:
            if bool(request.get("productionLayout", False)):
                raise ValueError(
                    "production capture requires a positive numeric materialId"
                )
            material_id = str(time.time_ns())
        request["materialId"] = flow_id(material_id)
        return request

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
                # Preview eligibility is independent from the bottom-edge
                # steel-in/out signal.  A head/tail frame or a camera with a
                # different sensor orientation can contain a valid full-frame
                # ROI while its configured tail rows are dark.  The scheduler
                # already enforces a two-FPS, one-pending-frame bound and the
                # publisher rejects black/sparse frames before encoding.
                self._schedule_stream_frame(camera, frame)
                if save_generation is not None:
                    with self.state_lock:
                        still_armed = (
                            self.save_enabled and self.save_generation == save_generation
                        )
                    if not still_armed:
                        # A steel-out/new-session transition can legitimately
                        # overtake an in-flight fetch.  The round recorder
                        # classifies this result as discarded; reporting it as
                        # a capture/storage failure makes the health screen
                        # show a false dropped-frame alarm.
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
        if self.history_only:
            return 409, {"code": 409, "error": "history_only"}
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

            request = self._prepare_capture_request(payload)
            rounds = _integer(request, "rounds", 1, 1, 10_000)
            interval_ms = _integer(request, "intervalMs", 0, 0, 600_000)
            results: list[dict[str, Any]] = []
            started_at = _utc_text()
            started_monotonic_ns = time.monotonic_ns()
            for round_index in range(1, rounds + 1):
                results.extend(
                    self._run_capture_round(
                        selected,
                        request,
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
            material_id = str(request["materialId"])
            session_id = str(
                request.get("sessionId", self.active_session_id or "diagnostic")
            )
            production_layout = bool(request.get("productionLayout", False))
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
                    / _safe_segment(str(request.get("outputDir", "continuous-test")))
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
        """Return the one configured flow-first physical data root."""
        return [camera.storage_root]

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
        material_dirs: list[tuple[int, int, Path]] = []
        for root in self._camera_read_roots(camera):
            try:
                for candidate in root.iterdir():
                    if candidate.is_dir():
                        if candidate.name.isdecimal():
                            material_dirs.append((1, int(candidate.name), candidate))
                        else:
                            material_dirs.append((0, candidate.stat().st_mtime_ns, candidate))
            except OSError:
                continue
        # Prefer numeric flow folders and inspect the latest flow first.  Sorting
        # only by the first tuple item left filesystem enumeration order in
        # charge, which could make live-preview warm-up scan very old data.
        material_dirs.sort(key=lambda item: (item[0], item[1]), reverse=True)

        normalized_suffixes = {suffix.lower() for suffix in suffixes}
        candidates: list[tuple[int, Path]] = []
        for _, _, material_dir in material_dirs[: max(1, material_limit)]:
            for directory in directories:
                artifact_dir = material_dir / directory
                try:
                    for path in artifact_dir.iterdir():
                        if path.suffix.lower() not in normalized_suffixes or not path.is_file():
                            continue
                        order = int(path.stem) if path.stem.isdecimal() else path.stat().st_mtime_ns
                        candidates.append((order, path))
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
        directory = {
            "depth": "3d",
            "intensity": "2d",
            "metadata": "json",
            "3d": "3d",
            "2d": "2d",
            "json": "json",
        }[kind]
        suffixes = {
            "depth": (".png", ".npz"),
            "intensity": (".png", ".jpg", ".jpeg"),
            "metadata": (".json",),
            "3d": (".npz",),
            "2d": (".png", ".jpg", ".jpeg"),
            "json": (".json",),
        }[kind]
        directories = (directory,)
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
                    camera_capture_root = material_root
                    if not camera_capture_root.is_dir():
                        continue
                    materials.setdefault(material_root.name, []).append(
                        (camera, read_root, camera_capture_root, active_root)
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
            flow_name = material_root.name
            key = (flow_name, sequence)
            frame = grouped.setdefault(
                key,
                {
                    "frameId": f"{flow_name}:{sequence:06d}",
                    "materialId": flow_name,
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
                    "artifactRef": capture_artifact_ref(
                        camera.camera_id, flow_name, "2d", path.name
                    ) if active_root else str(path),
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
        if material_id:
            self._schedule_playback_warm(material_id)
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

    def _strict_transient_playback_image(
        self,
        path: Path,
        max_width: int,
        crop_box: list[int],
    ) -> tuple[str, bytes] | None:
        """Encode an exact ROI in memory without ever falling back to raw pixels."""
        try:
            with Image.open(path) as source:
                with source.convert("L") as converted:
                    validated = validate_playback_crop_box(
                        crop_box,
                        converted.width,
                        converted.height,
                    )
                    with converted.crop(tuple(validated)) as cropped:
                        output = io.BytesIO()
                        if cropped.width > max_width:
                            target_height = max(
                                1,
                                round(cropped.height * max_width / cropped.width),
                            )
                            with cropped.resize(
                                (max_width, target_height), Image.Resampling.BILINEAR
                            ) as preview:
                                preview.save(
                                    output,
                                    format="JPEG",
                                    quality=84,
                                    optimize=False,
                                )
                        else:
                            cropped.save(
                                output,
                                format="JPEG",
                                quality=84,
                                optimize=False,
                            )
            return "image/jpeg", output.getvalue()
        except Exception as error:
            self._log(
                "warning",
                "strict transient playback crop failed",
                path=str(path),
                cropBox=crop_box,
                error=str(error),
            )
            return None

    def optimized_playback_image(
        self,
        path: Path,
        max_width: int,
        crop_box: list[int] | None = None,
    ) -> tuple[str, bytes] | None:
        if path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            return None
        identity = _capture_image_identity(path)
        if identity is None:
            return None
        material_id, _inferred_camera_id = identity
        resolved_parent = path.parent.resolve()
        camera_id = next(
            (
                camera.camera_id
                for camera in self.profile.enabled_cameras
                if (
                    capture_root(
                        camera.storage_root,
                        material_id,
                        camera.camera_id,
                    )
                    / "2d"
                ).resolve()
                == resolved_parent
            ),
            "",
        )
        if not camera_id:
            return None
        try:
            stat = path.stat()
            cache_root = capture_image_cache_root(path)
            if crop_box is not None:
                # A query-supplied rectangle is only a coordinate echo.  The
                # algorithm's committed per-flow ROI remains authoritative so
                # callers cannot ask for the complete raw frame under the
                # `region=valid` cache/API contract.
                with Image.open(path) as source:
                    requested_crop = validate_playback_crop_box(
                        crop_box,
                        source.width,
                        source.height,
                    )
                    indexed_crop = read_indexed_playback_crop(
                        path,
                        self.profile.storage_root,
                        source.width,
                        source.height,
                        metadata_camera_id=camera_id,
                    )
                if indexed_crop is None or requested_crop != indexed_crop:
                    return None
                crop_box = indexed_crop
            fingerprint = source_fingerprint(
                path,
                cache_root,
                crop_box,
                metadata_storage_root=self.profile.storage_root,
                metadata_camera_id=camera_id,
            )
        except (OSError, ValueError, TypeError):
            return None
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
            disk_hit = False
            cache_succeeded = False
            started = time.monotonic()
            try:
                existing = read_image_pyramid(cache_root, fingerprint)
                disk_hit = existing is not None
                if existing is None:
                    manifest_path, manifest = self.playback_compute_pool.submit(
                        build_image_pyramid,
                        path,
                        cache_root,
                        crop_box,
                        metadata_storage_root=self.profile.storage_root,
                        metadata_camera_id=camera_id,
                    ).result()
                else:
                    manifest_path, manifest = existing
                if crop_box is not None and (
                    manifest.get("cropSource") != "explicit-algorithm-roi"
                    or manifest.get("requestedCrop") != crop_box
                    or manifest.get("validRoi") != crop_box
                ):
                    raise ValueError("playback pyramid crop contract mismatch")
                selected_path, _ = select_pyramid_image(
                    manifest_path,
                    manifest,
                    max_width,
                )
                result = ("image/jpeg", selected_path.read_bytes())
                cache_succeeded = True
            except Exception as error:
                with self.history_lock:
                    self.playback_cache_build_failures += 1
                self._log(
                    "warning",
                    "playback pyramid build failed; using strict transient crop",
                    path=str(path),
                    cropBox=crop_box,
                    error=str(error),
                )
                if crop_box is None:
                    return None
                result = self._strict_transient_playback_image(
                    path,
                    max_width,
                    crop_box,
                )
                if result is None:
                    return None
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

    def render_capture_image(
        self,
        path: Path,
        modality: str,
        level: str,
    ) -> tuple[int, tuple[str, bytes] | dict[str, Any]]:
        """Return only a committed two-level JPEG; raw image fallback is forbidden."""
        normalized_modality = modality.strip().lower()
        normalized_level = level.strip().lower()
        if normalized_modality not in {"gray", "jet"}:
            return 422, {"code": 422, "error": "invalid_render_modality"}
        if normalized_level not in {"thumbnail", "original"}:
            return 422, {"code": 422, "error": "invalid_render_level"}
        if path.parent.name != "2d" or not path.stem.isdecimal():
            return 422, {"code": 422, "error": "render_source_must_be_raw_2d"}
        identity = _capture_image_identity(path)
        if identity is None:
            return 422, {"code": 422, "error": "render_source_identity_invalid"}
        material_id, _ = identity
        resolved_parent = path.parent.resolve()
        camera = next(
            (
                value
                for value in self.profile.enabled_cameras
                if (capture_root(value.storage_root, material_id, value.camera_id) / "2d").resolve()
                == resolved_parent
            ),
            None,
        )
        if camera is None:
            return 404, {"code": 404, "error": "capture_camera_not_configured"}
        calibration_path = self.array_calibration_path
        if normalized_modality == "jet":
            try:
                calibration_path = Path(self.active_array_calibration()["path"])
            except Exception as error:
                return 422, {
                    "code": 422,
                    "error": "capture_render_not_ready",
                    "reason": str(error),
                }
        committed = committed_rendition_file(
            path,
            normalized_modality,
            normalized_level,
            calibration_path=calibration_path,
        )
        if committed is not None:
            return 200, ("image/jpeg", committed.read_bytes())
        key_digest = hashlib.sha256(
            f"{path.resolve()}|{normalized_modality}".encode("utf-8")
        ).digest()
        build_lock = self.playback_cache_build_locks[key_digest[0] % len(self.playback_cache_build_locks)]
        with build_lock:
            started = time.monotonic()
            try:
                rendered_path = committed_rendition_file(
                    path,
                    normalized_modality,
                    normalized_level,
                    calibration_path=calibration_path,
                )
                if rendered_path is None:
                    rendered_path = self.playback_compute_pool.submit(
                        rendition_file,
                        path,
                        normalized_modality,
                        normalized_level,
                        camera_id=camera.camera_id,
                        camera_roots={
                            value.camera_id: value.storage_root
                            for value in self.profile.enabled_cameras
                        },
                        storage_root=self.profile.storage_root,
                        calibration_path=calibration_path,
                        config=self.rendition_config,
                    ).result()
                body = rendered_path.read_bytes()
                if not body.startswith(b"\xff\xd8"):
                    raise ValueError("rendered file is not JPEG")
            except RenditionNotReady as error:
                status = 409 if error.processing else 422
                return status, {
                    "code": status,
                    "error": "capture_render_processing" if error.processing else "capture_render_not_ready",
                    "reason": error.reason,
                    "modality": normalized_modality,
                    "level": normalized_level,
                }
            except Exception as error:
                with self.history_lock:
                    self.playback_cache_build_failures += 1
                self._log(
                    "warning",
                    "two-level capture rendition failed",
                    path=str(path),
                    modality=normalized_modality,
                    level=normalized_level,
                    error=str(error),
                )
                return 422, {
                    "code": 422,
                    "error": "capture_render_not_ready",
                    "reason": str(error),
                    "modality": normalized_modality,
                    "level": normalized_level,
                }
            with self.history_lock:
                self.playback_cache_builds += 1
                self.playback_cache_build_ms.append(
                    (time.monotonic() - started) * 1000.0
                )
            return 200, ("image/jpeg", body)

    def playback_cache_status_json(self) -> dict[str, Any]:
        with self.history_lock:
            build_samples = list(self.playback_cache_build_ms)
            cache_roots = [
                str(camera.storage_root / "<flow-id>" / "cache")
                for camera in self.profile.enabled_cameras
            ]
            rendition_roots = [
                {
                    "cameraId": camera.camera_id,
                    "gray": str(camera.storage_root / "<flow-id>" / "cache"),
                    "jet": str(camera.storage_root / "<flow-id>" / "jet"),
                }
                for camera in self.profile.enabled_cameras
            ]
            warm_status = dict(getattr(self, "playback_warm_status", {}))
            full_history = dict(getattr(self, "playback_history_status", {}))
            queue = getattr(self, "playback_history_flow_queue", ())
            retry_pending = getattr(
                self, "playback_history_retry_pending", ()
            )
            if queue:
                full_history["queueDepth"] = len(queue)
            full_history.setdefault(
                "totalFlowCount",
                int(full_history.get("rebuildableFlowCount", 0)),
            )
            full_history.setdefault(
                "discoveredCount",
                int(full_history.get("discoveredFlowCount", 0)),
            )
            full_history.setdefault(
                "completedCount",
                int(full_history.get("completedFlowCount", 0)),
            )
            full_history["pendingRetryCount"] = len(retry_pending)
            current_material_id = str(
                full_history.get("currentMaterialId", "")
            )
            if current_material_id and current_material_id == str(
                warm_status.get("materialId", "")
            ):
                # Keep the aggregate status useful between discovery ticks;
                # the per-frame warm worker updates this object directly.
                full_history.update(
                    {
                        "currentSourceFrameCount": int(
                            warm_status.get("sourceFrameCount", 0)
                        ),
                        "currentCommittedFrameCount": int(
                            warm_status.get("committedFrameCount", 0)
                        ),
                        "currentFailureCount": int(
                            warm_status.get("failureCount", 0)
                        ),
                    }
                )
            full_history["queueProgress"] = {
                "position": int(full_history.get("currentQueuePosition", 0)),
                "total": int(
                    full_history.get(
                        "currentQueueTotal",
                        full_history.get("rebuildableFlowCount", 0),
                    )
                ),
                "depth": int(full_history.get("queueDepth", len(queue))),
                "capacity": FULL_HISTORY_FLOW_QUEUE_CAPACITY,
            }
            return {
                "code": 0,
                "schema": "steel.capture-two-level-cache-status.v2",
                "cacheRoot": "<camera-root>/<flow-id>/cache",
                "cacheRoots": cache_roots,
                "renditionRoots": rendition_roots,
                "levels": ["thumbnail", "original"],
                "modalities": ["gray", "jet"],
                "generationPolicy": "full-flow-after-alignment",
                "onDemandBuild": "recovery-only",
                "catalogPath": str(playback_catalog_path(self.profile.storage_root)),
                "catalogAvailable": playback_catalog_path(self.profile.storage_root).is_file(),
                "memoryEntries": len(self.playback_image_cache),
                "memoryHits": self.playback_cache_memory_hits,
                "diskHits": self.playback_cache_disk_hits,
                "renditionsBuilt": self.playback_cache_builds,
                "buildFailures": self.playback_cache_build_failures,
                "averageBuildMs": round(sum(build_samples) / len(build_samples), 3)
                if build_samples
                else None,
                "twoLevelWarm": warm_status,
                "fullHistory": full_history,
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
            if (
                len(parts) != 5
                or not parts[0].isdecimal()
                or parts[1].lower() != "capture"
                or parts[3].lower() not in {"2d", "3d", "json"}
            ):
                return None
            camera = self.camera_for_identity(parts[2])
            if camera is None:
                return None
            try:
                candidate = resolve_capture_artifact(
                    camera.storage_root, camera.camera_id, decoded
                )
            except ValueError:
                return None
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

    def _send_image_access_headers(self) -> None:
        # These headers apply only to read-only binary image responses.  They
        # let the Tauri/WebView UI render loopback previews without Chromium
        # ORB blocking; write APIs deliberately remain same-origin only.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("X-Content-Type-Options", "nosniff")

    def _send_file(self, path: Path) -> None:
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", "no-store")
        if content_type.startswith("image/"):
            self._send_image_access_headers()
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
        self._send_image_access_headers()
        self.end_headers()
        self._write_response_body(body)

    def _send_stream_warming_up(self) -> None:
        # An image element must never receive a JSON error body: Chromium's
        # opaque-response blocking reports that MIME mismatch as ORB.  A 204
        # is an explicit "no real frame yet" response and is not a synthetic
        # black image; the client keeps its last successfully decoded PNG.
        self.send_response(204)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Retry-After", "1")
        self.send_header("X-Stream-State", "warming-up")
        self._send_image_access_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_immutable_image(self, content_type: str, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self._send_image_access_headers()
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
        elif path == "/api/capture/surface":
            material_id = (query.get("materialId") or [""])[0]
            status, payload = self.runtime.surface_json(material_id)
            self._send_json(status, payload)
        elif path == "/api/capture/regions":
            material_id = (query.get("materialId") or [""])[0]
            status, payload = self.runtime.regions_json(material_id)
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
            region = (query.get("region") or ["raw"])[0]
            # Wait only in this ThreadingHTTPServer request worker. A typical
            # 2 FPS preview publishes within 500 ms; the bounded allowance
            # also covers one queued depth conversion without ever blocking
            # the GenTL acquisition or storage threads.
            body = self.runtime.stream_latest_bytes(
                identity,
                kind,
                region,
                wait_seconds=1.5,
            )
            if body is None:
                status = self.runtime.stream_status(identity)
                if status.get("running"):
                    self._send_stream_warming_up()
                else:
                    self._send_json(
                        404,
                        {"code": 404, "error": "stream_frame_not_ready"},
                    )
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
        elif path == "/api/capture/render":
            allowed = self.runtime.allowed_file((query.get("path") or [""])[0])
            if allowed is None:
                self._send_json(404, {"code": 404, "error": "capture_file_not_found"})
            else:
                status, rendered = self.runtime.render_capture_image(
                    allowed,
                    (query.get("modality") or [""])[0],
                    (query.get("level") or [""])[0],
                )
                if status == 200 and isinstance(rendered, tuple):
                    self._send_immutable_image(*rendered)
                else:
                    self._send_json(status, rendered)
        elif path == "/api/capture/file":
            allowed = self.runtime.allowed_file((query.get("path") or [""])[0])
            if allowed is None:
                self._send_json(404, {"code": 404, "error": "capture_file_not_found"})
            else:
                try:
                    max_width = int((query.get("maxWidth") or ["0"])[0])
                except (TypeError, ValueError):
                    max_width = 0
                region = (query.get("region") or ["raw"])[0]
                if region == "valid":
                    try:
                        crop_x = int((query.get("cropX") or [""])[0])
                        crop_y = int((query.get("cropY") or [""])[0])
                        crop_width = int((query.get("cropWidth") or [""])[0])
                        crop_height = int((query.get("cropHeight") or [""])[0])
                    except (TypeError, ValueError):
                        crop_box = None
                    else:
                        crop_box = [
                            crop_x,
                            crop_y,
                            crop_x + crop_width,
                            crop_y + crop_height,
                        ] if crop_width > 0 and crop_height > 0 else None
                    if crop_box is None or not 160 <= max_width <= 4096:
                        self._send_json(
                            422,
                            {"code": 422, "error": "capture_valid_region_not_ready"},
                        )
                    else:
                        optimized = self.runtime.optimized_playback_image(
                            allowed, max_width, crop_box
                        )
                        if optimized is None:
                            self._send_json(
                                422,
                                {"code": 422, "error": "capture_valid_region_not_ready"},
                            )
                        else:
                            self._send_immutable_image(*optimized)
                else:
                    self._send_file(allowed)
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
            result = self.runtime.connect_all(payload)
            status = (
                200
                if result["code"] == 0
                else result["code"]
                if result["code"] in {409, 422}
                else 503
            )
            self._send_json(status, result)
        elif path == "/api/camera/connect":
            result = self.runtime.connect_all(payload)
            status = (
                200
                if result["code"] == 0
                else result["code"]
                if result["code"] in {409, 422}
                else 503
            )
            self._send_json(status, result)
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
            self._send_json(
                409,
                {
                    "code": 409,
                    "error": "algorithm_service_owns_reprocessing",
                    "algorithmEndpoint": "/internal/v1/reprocess",
                },
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

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Browser polling and image refreshes can cancel a keep-alive socket
        # before BaseHTTPRequestHandler reads the next request line.  The
        # standard server prints a full traceback for that normal disconnect,
        # obscuring real capture/storage errors in the operator log.
        error = sys.exc_info()[1]
        if isinstance(error, (BrokenPipeError, ConnectionAbortedError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)

    def server_close(self) -> None:
        try:
            self.runtime.close()
        finally:
            super().server_close()


def serve(
    profile_path: Path | str,
    host: str = "127.0.0.1",
    port: int = 4317,
    *,
    history_only: bool = False,
) -> None:
    if host.lower() != "localhost":
        try:
            address = ipaddress.ip_address(host)
        except ValueError as error:
            raise ValueError("SICK sidecar host must be a loopback address") from error
        if not address.is_loopback:
            raise ValueError("SICK sidecar host must be a loopback address")
    profile = load_profile(profile_path)
    if history_only:
        profile = replace(profile, auto_connect=False)
    runtime = ProviderRuntime(profile, history_only=history_only)
    server = SickCaptureHTTPServer((host, port), runtime)
    print(
        json.dumps(
            {
                "service": "steel_sick_capture_sidecar",
                "origin": f"http://{host}:{port}",
                "profile": str(profile.source_path),
                "expectedCameras": profile.expected_cameras,
                "historyOnly": history_only,
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
