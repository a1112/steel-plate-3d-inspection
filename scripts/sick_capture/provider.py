"""Steel-compatible HTTP sidecar for real SICK GenTL cameras."""

from __future__ import annotations

import ipaddress
import io
import json
import mimetypes
import os
import shutil
import tempfile
import threading
import time
from collections import OrderedDict, deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import parse_qs, unquote, urlsplit

import numpy as np
from PIL import Image

from .gentl import SickGenTLBackend
from .profile import CameraProfile, SickCaptureProfile, load_profile
from .storage import DualFormatWriter, atomic_summary


CAPTURE_DISCARDED_NOT_ARMED = 49000
BLACK_FRAME_DISCARDED = 49001
NO_STEEL_FRAME_DISCARDED = 49002
SICK_CAPTURE_FAILED = 49100
SICK_COMPONENT_SCHEMA_MISMATCH = 49101
SICK_STORAGE_FAILED = 49102
LIVE_PREVIEW_BLACK_MAX = 8.0


def _truthy(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _safe_segment(value: str) -> str:
    result = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in value.strip())
    result = result.strip("._")[:96].rstrip(" .") or "unknown"
    reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
    if result.split(".", 1)[0].upper() in reserved:
        result = f"_{result}"
    return result


def _utc_text() -> str:
    import datetime as dt

    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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
    ) -> None:
        self.profile = profile
        self.backend = backend or SickGenTLBackend(profile)
        self.writer = writer or DualFormatWriter(
            jpeg_quality=profile.jpeg_quality,
            fsync=profile.fsync,
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
                10,
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
                10,
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
        self.storage_writer_pool = ThreadPoolExecutor(
            max_workers=max(1, profile.expected_cameras),
            thread_name_prefix="sick-storage-camera",
        )
        self.storage_round_pool = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="sick-storage-round",
        )
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
        self.storage_queue_accepting = True
        self.storage_queue_pending_rounds = 0
        self.storage_queue_active_rounds = 0
        self.storage_queue_completed_rounds = 0
        self.storage_queue_dropped_rounds = 0
        self.storage_queue_dropped_frames = 0
        self.storage_queue_failed_rounds = 0
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
        self.preview_seed_lock = threading.Lock()
        self.history_lock = threading.RLock()
        self.history_cache: list[dict[str, Any]] = []
        self.history_cache_at = 0.0
        self.history_cache_limit = 0
        self.history_cache_material_id = ""
        self.history_cache_has_more = False
        self.playback_image_cache: OrderedDict[
            tuple[str, int, int], tuple[str, bytes]
        ] = OrderedDict()
        self.events: deque[dict[str, Any]] = deque(maxlen=200)
        self.frames_received = 0
        self.frames_committed = 0
        self.frames_failed = 0
        self.last_error = ""
        self.started_at = time.time()
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
        thread = self.acquisition_thread
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=max(2.0, self.profile.timeout_ms / 1000.0 + 1.0))
        with self.storage_queue_lock:
            self.storage_queue_accepting = False
        self.capture_pool.shutdown(wait=True, cancel_futures=True)
        self.storage_round_pool.shutdown(wait=True, cancel_futures=False)
        self.storage_writer_pool.shutdown(wait=True, cancel_futures=False)
        with self.stream_lock:
            self.stream_camera_key = ""
            self.stream_latest.clear()
            self.stream_frame_counts.clear()
            self.stream_last_frame_at_by_camera.clear()
            self.stream_frame_ticks_by_camera.clear()
            self.stream_dimensions.clear()
        with self.history_lock:
            self.playback_image_cache.clear()
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
    ) -> None:
        committed = [
            {key: value for key, value in row.items() if not key.startswith("_")}
            for row in results
            if int(row.get("code", SICK_CAPTURE_FAILED)) == 0
            and bool(row.get("completeFrame"))
            and not bool(row.get("discarded"))
        ]
        if not committed or not session_id:
            return
        try:
            response = self._post_service_json(
                "/internal/v1/capture-commit",
                {
                    "schema": "steel.capture.commit.v1",
                    "materialId": material_id,
                    "sessionId": session_id,
                    "inspectionId": f"INSP-{session_id}",
                    "results": committed,
                },
            )
            if int(response.get("code", 500)) != 0:
                raise RuntimeError(str(response.get("error", "capture commit rejected")))
            with self.state_lock:
                self.active_flow_no = int(response.get("flowNo", 0) or 0) or self.active_flow_no
                self.active_flow_code = str(
                    response.get("flowCode", self.active_flow_code)
                )
        except Exception as error:
            self.last_error = str(error)
            self._log("warning", "capture database commit failed", error=str(error))

    def _persist_cached_round(
        self,
        rows: list[dict[str, Any]],
        *,
        material_id: str,
        session_id: str,
        boundary_phase: str,
        require_steel_signal: bool = False,
    ) -> list[dict[str, Any]]:
        if not material_id or not session_id:
            return []

        futures: list[tuple[Any, CameraProfile, Any, dict[str, Any]]] = []
        for row in rows:
            frame = row.get("_rawFrame")
            camera = self.camera_for_identity(str(row.get("cameraKey", "")))
            if frame is None or camera is None:
                continue
            if float(row.get("maxIntensity", 0.0)) <= self.profile.black_frame_threshold:
                continue
            if require_steel_signal and not bool(row.get("steelSignal")):
                continue
            future = self.storage_writer_pool.submit(
                self.writer.write,
                camera.storage_root,
                material_id,
                frame,
                session_id=session_id,
                production_event_id=self.active_flow_code,
            )
            futures.append((future, camera, frame, row))

        committed: list[dict[str, Any]] = []
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
                        "boundaryPhase": boundary_phase,
                    }
                )
                committed.append(persisted)
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
            self._commit_capture_results(material_id, session_id, committed)
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
    ) -> bool:
        received_count = sum(bool(row.get("frameReceived")) for row in rows)
        if not received_count or not material_id or not session_id:
            return False
        with self.storage_queue_lock:
            if not self.storage_queue_accepting:
                return False
            queue_limit = self.storage_queue_capacity_rounds
            if not force:
                queue_limit = max(
                    1,
                    self.storage_queue_capacity_rounds
                    - self.storage_queue_boundary_reserve_rounds,
                )
            if self.storage_queue_pending_rounds >= queue_limit:
                self.storage_queue_dropped_rounds += 1
                self.storage_queue_dropped_frames += received_count
                with self.state_lock:
                    self.continuous_discarded_frame_count += received_count
                return False
            self.storage_queue_pending_rounds += 1

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
            with self.storage_queue_lock:
                self.storage_queue_pending_rounds = max(
                    0, self.storage_queue_pending_rounds - 1
                )
                self.storage_queue_completed_rounds += 0 if failed else 1
                self.storage_queue_failed_rounds += 1 if failed else 0

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
        stats = self.continuous_stats[camera.key]
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
            "connected": session is not None,
            "acquiring": bool(session is not None and getattr(session, "started", False)),
            "acquisitionState": "acquiring" if continuous_running else "connected" if session else "offline",
            "continuousAcquiring": continuous_running,
            "continuousFps": self._rolling_fps(stats["ticks"]),
            "continuousFrameCount": stats["frameCount"],
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
            "blackFramesDiscarded": self.black_frame_count,
            "continuousAcquisitionFrameCount": self.continuous_acquisition_frame_count,
            "continuousDiscardedFrameCount": self.continuous_discarded_frame_count,
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
            return {
                "accepting": self.storage_queue_accepting,
                "workerCount": self.profile.expected_cameras,
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
                "recentWriteBytesPerSecond": 0.0,
                "implementation": "bounded-round-cache+ordered-round-writer+per-camera-disks",
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
            "steelMinCameras": self.steel_min_cameras,
            "steelEntryRounds": self.steel_entry_rounds,
            "steelExitRounds": self.steel_exit_rounds,
            "steelPreRollFrames": self.steel_pre_roll_frames,
            "steelPostRollFrames": self.steel_post_roll_frames,
            "blackFrameCacheRounds": self.black_frame_cache_rounds,
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
            return {
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

    def _ensure_acquisition_worker(self) -> None:
        with self.state_lock:
            self.acquisition_stop.clear()
            if self._acquisition_running():
                return
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
                    preview.save(output, format="PNG", optimize=False)
            else:
                if (
                    minimum_visible_max is not None
                    and source.getextrema()[1] <= minimum_visible_max
                ):
                    return None
                source.save(output, format="PNG", optimize=False)
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
            # The 2x3 overview uses an 800-pixel preview based on its actual
            # card size. Full-resolution intensity/depth conversion is kept
            # only for the focused camera.
            if active_key == camera.key:
                intensity_preview = self._preview_png(intensity, depth=False)
                depth_preview = self._preview_png(frame.depth_raw, depth=True)
                if intensity_preview is not None:
                    latest["intensity"] = intensity_preview
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

    def _seed_stream_cache_from_storage(self) -> None:
        if not self.preview_seed_lock.acquire(blocking=False):
            return
        try:
            for camera in self.profile.enabled_cameras:
                with self.stream_lock:
                    if self.stream_latest.get(camera.key, {}).get("intensity-grid"):
                        continue
                candidates = [
                    path
                    for root in self._camera_read_roots(camera)
                    for pattern in ("*/2d/*.png", "*/2d/*.jpg", "*/intensity/*.png")
                    for path in root.glob(pattern)
                    if path.is_file()
                ]
                try:
                    candidates.sort(key=lambda path: path.stat().st_mtime_ns, reverse=True)
                except OSError:
                    continue
                for path in candidates[:128]:
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
                        intensity_preview = self._preview_png(
                            intensity,
                            depth=False,
                        )
                        if grid_preview is None or intensity_preview is None:
                            continue
                    except (OSError, ValueError):
                        continue
                    with self.stream_lock:
                        camera_latest = self.stream_latest.setdefault(camera.key, {})
                        camera_latest.setdefault("intensity-grid", grid_preview)
                        camera_latest.setdefault("intensity", intensity_preview)
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
                    "retries": 0,
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
                                require_steel_signal=True,
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
                mean_intensity = float(np.mean(frame.intensity))
                max_intensity = float(np.max(frame.intensity)) if frame.intensity.size else 0.0
                bright_pixel_ratio = (
                    float(np.count_nonzero(frame.intensity > self.steel_bright_threshold))
                    / float(frame.intensity.size)
                    if frame.intensity.size
                    else 0.0
                )
                steel_signal = (
                    max_intensity > self.steel_bright_threshold
                    and bright_pixel_ratio >= self.steel_bright_ratio
                )
                retained_frame = (
                    {"_rawFrame": frame}
                    if bool(payload.get("_retainRawFrame", False))
                    else {}
                )
                self._publish_stream_frame(camera, frame)
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

    def latest_file(self, query: dict[str, list[str]]) -> Path | None:
        identity = (query.get("ip") or query.get("cameraId") or [""])[0]
        kind = (query.get("kind") or ["intensity"])[0]
        camera = self.camera_for_identity(identity) if identity else self.profile.enabled_cameras[0]
        if camera is None or kind not in {"depth", "intensity", "metadata", "3d", "2d", "json"}:
            return None
        candidates = [
            path
            for root in self._camera_read_roots(camera)
            for path in root.glob(f"*/{kind}/*")
            if path.is_file()
        ]
        if not candidates and kind == "intensity":
            candidates = [
                path
                for root in self._camera_read_roots(camera)
                for path in root.glob("*/2d/*.png")
                if path.is_file()
            ]
        return max(candidates, key=lambda path: path.stat().st_mtime_ns) if candidates else None

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
                paths = [
                    path
                    for path in image_root.iterdir()
                    if path.is_file()
                    and not path.is_symlink()
                    and path.suffix.lower() == ".png"
                ]
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

    def capture_history_json(self, query: dict[str, list[str]]) -> dict[str, Any]:
        try:
            limit = max(1, min(500, int((query.get("limit") or ["240"])[0])))
        except (TypeError, ValueError):
            limit = 240
        material_id = (query.get("materialId") or [""])[0].strip()
        with self.history_lock:
            cache_stale = (
                self.history_cache_at <= 0
                or time.monotonic() - self.history_cache_at >= 5.0
                or self.history_cache_material_id != material_id
                or self.history_cache_limit < limit
            )
            if cache_stale:
                self.history_cache, self.history_cache_has_more = self._scan_capture_history(
                    limit,
                    material_id,
                )
                self.history_cache_at = time.monotonic()
                self.history_cache_limit = limit
                self.history_cache_material_id = material_id
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
        key = (str(path), stat.st_mtime_ns, max_width)
        with self.history_lock:
            cached = self.playback_image_cache.get(key)
            if cached is not None:
                self.playback_image_cache.move_to_end(key)
                return cached
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
                        (max_width, target_height),
                        Image.Resampling.BILINEAR,
                    ) as preview:
                        preview.save(output, format="JPEG", quality=84, optimize=False)
                else:
                    converted.save(output, format="JPEG", quality=84, optimize=False)
            finally:
                converted.close()
        result = ("image/jpeg", output.getvalue())
        with self.history_lock:
            self.playback_image_cache[key] = result
            self.playback_image_cache.move_to_end(key)
            while len(self.playback_image_cache) > 96:
                self.playback_image_cache.popitem(last=False)
        return result

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

    @property
    def runtime(self) -> ProviderRuntime:
        return getattr(self.server, "runtime")

    def log_message(self, format: str, *args: Any) -> None:
        self.runtime._log("debug", format % args)

    def _send_json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

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
                self.wfile.write(block)

    def _send_png(self, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def _send_immutable_image(self, content_type: str, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(body)

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
