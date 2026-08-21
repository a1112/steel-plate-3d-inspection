"""Steel-compatible HTTP sidecar for real SICK GenTL cameras."""

from __future__ import annotations

import ipaddress
import json
import mimetypes
import os
import shutil
import tempfile
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

import numpy as np

from .gentl import SickGenTLBackend
from .profile import CameraProfile, SickCaptureProfile, load_profile
from .storage import DualFormatWriter, atomic_summary


CAPTURE_DISCARDED_NOT_ARMED = 49000
BLACK_FRAME_DISCARDED = 49001
SICK_CAPTURE_FAILED = 49100
SICK_COMPONENT_SCHEMA_MISMATCH = 49101
SICK_STORAGE_FAILED = 49102


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
        self.steel_present = False
        self.save_enabled = False
        self.save_generation = 0
        self.capture_mode = "on-demand"
        self.capture_lock = threading.Lock()
        self.state_lock = threading.RLock()
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
        self.disconnect(force=True)
        self.backend.close()

    def _camera_row(self, camera: CameraProfile) -> dict[str, Any]:
        session = self.sessions.get(camera.key)
        identity = getattr(session, "identity", {}) if session else {}
        return {
            "cameraIndex": camera.camera_index,
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
        return {
            "accepting": True,
            "workerCount": self.profile.expected_cameras,
            "capacityItems": self.profile.expected_cameras,
            "pendingItems": 0,
            "activeItems": 0,
            "completed": self.frames_committed,
            "failed": self.frames_failed,
            "recentWriteBytesPerSecond": 0.0,
            "implementation": "synchronous-per-camera-atomic-writer",
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
                "captureMode": self.capture_mode,
                "automaticCaptureEnabled": False,
                "productionCaptureRunning": self.capture_lock.locked(),
                "connectedCameras": len(self.sessions),
                "storageRoot": str(self.profile.storage_root),
                "updatedAt": _utc_text(),
            }

    def continuous_settings_json(self) -> dict[str, Any]:
        return {
            "code": 0,
            "provider": "sick-gentl-harvesters",
            "supported": False,
            "captureMode": self.capture_mode,
            "automaticCaptureEnabled": False,
            "requiresProfileRestart": True,
            "reason": "SICK trigger and encoder nodes are profile-owned",
            "connectedCameras": len(self.sessions),
            "configuredCameras": self.profile.expected_cameras,
        }

    def set_capture_mode(self, payload: dict[str, Any]) -> dict[str, Any]:
        requested = str(payload.get("captureMode", payload.get("capture_mode", ""))).strip()
        if requested not in {"on-demand", "disabled"}:
            return {
                "code": 409,
                "error": "sick_continuous_autocapture_not_supported",
                "message": "captureMode must be on-demand or disabled for the SICK sidecar",
            }
        with self.state_lock:
            self.capture_mode = requested
        return {
            "code": 0,
            "provider": "sick-gentl-harvesters",
            "captureMode": requested,
            "automaticCaptureEnabled": False,
            "productionCaptureRunning": self.capture_lock.locked(),
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
        with self.state_lock:
            if normalized in {"steelin", "in"}:
                self.save_generation += 1
                if value:
                    if not material_id or not session_id:
                        return {"code": 400, "error": "steel-in requires materialId and sessionId"}
                    self.active_material_id = material_id
                    self.active_session_id = session_id
                    self.steel_present = True
                    self.save_enabled = bool(payload.get("saveEnabled", True))
                else:
                    self.steel_present = False
                    self.save_enabled = False
                    self.active_material_id = ""
                    self.active_session_id = ""
            elif normalized in {"reset", "clear"}:
                self.save_generation += 1
                self.steel_present = False
                self.save_enabled = False
                self.active_material_id = ""
                self.active_session_id = ""
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
                "phase": phase,
                "present": self.steel_present,
                "captureSaveState": "save" if self.save_enabled else "discard",
                "saveEnabled": self.save_enabled,
                "driverMode": "sick-gentl",
            }

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
                        }
                if bool(payload.get("discardBlackFrames", False)):
                    threshold = float(
                        payload.get("blackFrameThreshold", self.profile.black_frame_threshold)
                    )
                    if float(np.mean(frame.intensity)) <= threshold:
                        self._count_frames(failed=1)
                        return {
                            "code": BLACK_FRAME_DISCARDED,
                            "errorName": "BLACK_FRAME_DISCARDED",
                            "operatorHint": "intensity mean is below blackFrameThreshold",
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
            "workerStartedNs": started_ns,
            "workerCompletedNs": time.time_ns(),
        }

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
                barrier = threading.Barrier(len(selected))
                with ThreadPoolExecutor(
                    max_workers=len(selected), thread_name_prefix="sick-capture"
                ) as pool:
                    futures = [
                        pool.submit(
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
                in {CAPTURE_DISCARDED_NOT_ARMED, BLACK_FRAME_DISCARDED}
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

    def latest_file(self, query: dict[str, list[str]]) -> Path | None:
        identity = (query.get("ip") or query.get("cameraId") or [""])[0]
        kind = (query.get("kind") or ["intensity"])[0]
        camera = self.camera_for_identity(identity) if identity else self.profile.enabled_cameras[0]
        if camera is None or kind not in {"depth", "intensity", "metadata", "3d", "2d", "json"}:
            return None
        candidates = [path for path in camera.storage_root.glob(f"*/{kind}/*") if path.is_file()]
        return max(candidates, key=lambda path: path.stat().st_mtime_ns) if candidates else None

    def allowed_file(self, value: str) -> Path | None:
        if not value:
            return None
        candidate = Path(unquote(value)).resolve()
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
        elif path == "/api/capture/file":
            allowed = self.runtime.allowed_file((query.get("path") or [""])[0])
            if allowed is None:
                self._send_json(404, {"code": 404, "error": "capture_file_not_found"})
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
            self._send_json(
                200,
                {
                    **self.runtime.continuous_settings_json(),
                    "code": 409,
                    "error": "sick_trigger_settings_are_profile_owned",
                },
            )
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
