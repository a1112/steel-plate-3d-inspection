#!/usr/bin/env python3
"""Backfill cached defect crops and database rows, then re-run historical detection.

The job is resumable.  Existing manifests are imported first after their review
crops have been expanded to at least 64x64 pixels.  Full ONNX inference then
rebuilds each historical material in newest-first order and replaces only
pending model rows, preserving operator-confirmed decisions.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
import time
from dataclasses import dataclass, field
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable
from urllib import request

import numpy as np
from PIL import Image

if __package__:
    from .sick_capture.alignment import (
        AlignmentConfig,
        _atomic_json,
        alignment_manifest_path,
        build_and_write_flow_alignment,
    )
    from .sick_capture.calibration_pointer import resolve_active_array_calibration
    from .sick_capture.defect_detection import (
        DefectDetectionConfig,
        ExecutionGateInterrupted,
        _save_review_crop,
        build_and_write_flow_defect_detection,
        defect_detection_manifest_path,
        import_defect_manifest,
    )
    from .sick_capture.material_lock import exclusive_material_job
    from .sick_capture.measurement import (
        MeasurementConfig,
        build_and_write_flow_measurement,
        measurement_manifest_path,
    )
    from .sick_capture.paths import capture_root
    from .sick_capture.profile import load_profile
    from .sick_capture.regions import (
        build_and_write_flow_region_map,
        region_manifest_path,
    )
else:
    from sick_capture.alignment import (
        AlignmentConfig,
        _atomic_json,
        alignment_manifest_path,
        build_and_write_flow_alignment,
    )
    from sick_capture.calibration_pointer import resolve_active_array_calibration
    from sick_capture.defect_detection import (
        DefectDetectionConfig,
        ExecutionGateInterrupted,
        _save_review_crop,
        build_and_write_flow_defect_detection,
        defect_detection_manifest_path,
        import_defect_manifest,
    )
    from sick_capture.material_lock import exclusive_material_job
    from sick_capture.measurement import (
        MeasurementConfig,
        build_and_write_flow_measurement,
        measurement_manifest_path,
    )
    from sick_capture.paths import capture_root
    from sick_capture.profile import load_profile
    from sick_capture.regions import (
        build_and_write_flow_region_map,
        region_manifest_path,
    )


BACKFILL_SCHEMA = "steel.sick-defect-history-backfill.v1"
BACKFILL_VERSION = 2
STATUS_UPDATE_LOCK = threading.RLock()


class BackfillInterrupted(ExecutionGateInterrupted):
    """Raised at an execution checkpoint after the job receives a stop signal."""


@dataclass
class CaptureGateTracker:
    """Continuously observed strict-idle state shared by heartbeat and checkpoints."""

    lock: threading.RLock = field(default_factory=threading.RLock)
    snapshot: dict[str, Any] | None = None
    stable_since: float | None = None
    observed_at: float = 0.0

    def observe(
        self,
        snapshot: dict[str, Any],
        now: float,
        *,
        maximum_observation_gap: float,
    ) -> tuple[dict[str, Any], float]:
        with self.lock:
            if (
                self.observed_at <= 0.0
                or now - self.observed_at > maximum_observation_gap
            ):
                self.stable_since = None
            if bool(snapshot.get("idle")):
                self.stable_since = self.stable_since or now
            else:
                self.stable_since = None
            self.snapshot = dict(snapshot)
            self.observed_at = now
            stable_for = (
                max(0.0, now - self.stable_since)
                if self.stable_since is not None
                else 0.0
            )
            return dict(self.snapshot), stable_for

    def current(
        self, now: float, *, maximum_age: float
    ) -> tuple[dict[str, Any] | None, float]:
        with self.lock:
            if (
                self.snapshot is None
                or self.observed_at <= 0.0
                or now - self.observed_at > maximum_age
            ):
                return None, 0.0
            stable_for = (
                max(0.0, now - self.stable_since)
                if self.stable_since is not None
                else 0.0
            )
            return dict(self.snapshot), stable_for


def utc_text() -> str:
    import datetime as dt

    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def material_number(value: str) -> int:
    return int(value) if value.isdigit() else -1


def historical_materials(
    camera_roots: dict[str, Path],
    *,
    execution_gate: Callable[[str], None] | None = None,
) -> list[str]:
    common: set[str] | None = None
    for camera_id, root in camera_roots.items():
        if execution_gate is not None:
            execution_gate(f"material-scan-camera:{camera_id}")
        rows: set[str] = set()
        entries = iter(root.iterdir())
        while True:
            if execution_gate is not None:
                execution_gate(f"material-scan-entry:{camera_id}")
            try:
                path = next(entries)
            except StopIteration:
                break
            if (
                path.is_dir()
                and path.name.isdigit()
                and (capture_root(root, path.name, camera_id) / "2d").is_dir()
                and (capture_root(root, path.name, camera_id) / "json").is_dir()
            ):
                rows.add(path.name)
        common = rows if common is None else common & rows
    return sorted(common or set(), key=material_number, reverse=True)


def configured_path(profile_path: Path, defaults: dict[str, Any], key: str) -> Path | None:
    text = os.path.expandvars(str(defaults.get(key, "")).strip())
    if not text:
        return None
    candidate = Path(text)
    return candidate if candidate.is_absolute() else profile_path.parent / candidate


def depth_geometry_config_available(profile_path: Path) -> bool:
    try:
        payload = json.loads(
            (profile_path.parent / "algorithm.json").read_text(encoding="utf-8-sig")
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False
    geometry = payload.get("depthGeometry") if isinstance(payload, dict) else None
    return isinstance(geometry, dict) and (
        geometry.get("schema") == "steel.sick-depth-geometry-config.v1"
    )


def create_configs(
    profile_path: Path,
    storage_root: Path,
    defaults: dict[str, Any],
    capture_origin: str,
    database_origin: str,
    gpu_device: int | None,
) -> tuple[AlignmentConfig, MeasurementConfig, DefectDetectionConfig, Path]:
    alignment = AlignmentConfig(
        search_frames=int(defaults.get("alignmentSearchFrames", 12)),
        stable_rows=int(defaults.get("alignmentStableRows", 8)),
        sample_step=int(defaults.get("alignmentSampleStep", 4)),
        depth_valid_ratio=float(defaults.get("alignmentDepthValidRatio", 0.005)),
        intensity_threshold=float(defaults.get("steelBrightPixelThreshold", 8.0)),
        intensity_ratio=float(defaults.get("steelBrightPixelRatio", 0.02)),
        anchor_interval_frames=int(defaults.get("softSyncAnchorIntervalFrames", 16)),
        maximum_anchor_residual_ms=float(defaults.get("softSyncMaximumResidualMs", 40.0)),
    ).bounded()
    measurement = MeasurementConfig(
        row_window=int(defaults.get("measurementRowWindow", 16)),
        maximum_profile_points=int(
            defaults.get("measurementMaximumProfilePoints", 320)
        ),
        maximum_sections=int(defaults.get("measurementMaximumSections", 12)),
        minimum_circle_points=int(defaults.get("measurementMinimumCirclePoints", 48)),
        maximum_circle_residual_mm=float(
            defaults.get("measurementMaximumCircleResidualMm", 0.5)
        ),
    ).bounded()
    defects = DefectDetectionConfig(
        enabled=bool(defaults.get("defectDetectionEnabled", False)),
        model_2d_path=configured_path(profile_path, defaults, "defectModel2dPath"),
        model_3d_path=configured_path(profile_path, defaults, "defectModel3dPath"),
        classifier_2d_path=configured_path(
            profile_path, defaults, "defectClassifier2dPath"
        ),
        classifier_3d_path=configured_path(
            profile_path, defaults, "defectClassifier3dPath"
        ),
        model_manifest_path=configured_path(
            profile_path, defaults, "defectModelManifestPath"
        ),
        image_size=int(defaults.get("defectImageSize", 640)),
        confidence_threshold=float(defaults.get("defectConfidenceThreshold", 0.25)),
        iou_threshold=float(defaults.get("defectIouThreshold", 0.25)),
        merge_iou_threshold=float(defaults.get("defectMergeIouThreshold", 0.20)),
        maximum_detections_per_frame=int(defaults.get("defectMaximumPerFrame", 100)),
        inference_batch_size=int(defaults.get("defectInferenceBatchSize", 8)),
        preprocess_workers=int(defaults.get("defectPreprocessWorkers", 2)),
        classification_confidence_threshold=float(
            defaults.get("defectClassificationConfidenceThreshold", 0.55)
        ),
        frame_stride=int(defaults.get("defectFrameStride", 1)),
        cpu_frame_stride=int(defaults.get("defectCpuFrameStride", 8)),
        gpu_device_id=(
            int(defaults.get("defectGpuDevice", 1))
            if gpu_device is None
            else gpu_device
        ),
        depth_exposure=float(defaults.get("defectDepthExposure", 300.0)),
        depth_baseline_sample_step=int(
            defaults.get("defectDepthBaselineSampleStep", 4)
        ),
        review_crop_minimum_size=max(
            64, int(defaults.get("defectReviewCropMinimumSize", 64))
        ),
        capture_origin=capture_origin,
        database_origin=database_origin,
        maximum_idle_wait_seconds=float(
            defaults.get("defectMaximumIdleWaitSeconds", 300.0)
        ),
        maximum_pending_storage_rounds=int(
            defaults.get("defectMaximumPendingStorageRounds", 128)
        ),
        require_approved_region_map=bool(
            defaults.get("defectRequireApprovedRegionMap", True)
        ),
        depth_geometry_profile_path=(
            profile_path if depth_geometry_config_available(profile_path) else None
        ),
        history_rebuild=True,
    ).bounded()
    base_calibration = configured_path(profile_path, defaults, "arrayCalibrationPath")
    active_calibration = Path(
        resolve_active_array_calibration(storage_root, base_calibration)["path"]
    )
    return alignment, measurement, defects, active_calibration


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON object expected: {path}")
    return value


def ensure_overlap_region_manifest(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment: dict[str, Any],
    measurement_config: MeasurementConfig,
    calibration_path: Path,
    *,
    execution_gate: Callable[[str], None] | None = None,
) -> tuple[dict[str, Any], bool]:
    """Ensure historical ownership exists and carries the additive pair count."""

    measurement_path = measurement_manifest_path(storage_root, material_id)
    if measurement_path.is_file():
        if execution_gate is not None:
            execution_gate("measurement-manifest-read")
        measurement = read_json(measurement_path)
    else:
        if execution_gate is not None:
            execution_gate("measurement-build")
        _, measurement = build_and_write_flow_measurement(
            camera_roots,
            storage_root,
            material_id,
            alignment,
            calibration_path=calibration_path,
            config=measurement_config,
        )

    manifest_path = region_manifest_path(storage_root, material_id)
    if manifest_path.is_file():
        if execution_gate is not None:
            execution_gate("region-manifest-read")
        regions = read_json(manifest_path)
        ownership = regions.get("ownership")
        pairs = ownership.get("pairs") if isinstance(ownership, dict) else None
        if isinstance(pairs, list):
            pair_count = len(pairs)
            changed = ownership.get("overlapPairCount") != pair_count
            if changed:
                ownership["overlapPairCount"] = pair_count
                if execution_gate is not None:
                    execution_gate("region-count-write")
                _atomic_json(manifest_path, regions)
            return regions, changed

    if execution_gate is not None:
        execution_gate("region-build")
    _, regions = build_and_write_flow_region_map(
        camera_roots,
        storage_root,
        material_id,
        measurement,
    )
    return regions, True


def ensure_minimum_review_crops(
    manifest: dict[str, Any],
    minimum_size: int,
    *,
    execution_gate: Callable[[str], None] | None = None,
) -> tuple[int, list[str]]:
    rebuilt = 0
    failures: list[str] = []
    for defect in manifest.get("defects", []):
        if execution_gate is not None:
            execution_gate("review-crop-defect")
        if not isinstance(defect, dict):
            continue
        source = Path(str(defect.get("source2d", "")))
        target = Path(str(defect.get("reviewImage", "")))
        rect_value = defect.get("imageRect2d", {})
        try:
            rect = [
                int(rect_value["left"]),
                int(rect_value["top"]),
                int(rect_value["right"]),
                int(rect_value["bottom"]),
            ]
            current_size = (0, 0)
            if target.is_file():
                with Image.open(target) as current:
                    current_size = current.size
            if min(current_size) >= minimum_size:
                defect["reviewImageWidth"], defect["reviewImageHeight"] = current_size
                continue
            if execution_gate is not None:
                execution_gate("review-crop-source-read")
            with Image.open(source) as image:
                intensity = np.asarray(image.convert("L"), dtype=np.uint8)
            if execution_gate is not None:
                execution_gate("review-crop-write")
            crop = _save_review_crop(intensity, rect, target, minimum_size)
            defect["reviewCropRect"] = crop
            defect["reviewImageWidth"] = crop["width"]
            defect["reviewImageHeight"] = crop["height"]
            defect["sourceImageWidth"] = int(intensity.shape[1])
            defect["sourceImageHeight"] = int(intensity.shape[0])
            rebuilt += 1
        except Exception as error:
            failures.append(f"{defect.get('id', 'unknown')}: {type(error).__name__}: {error}")
    settings = manifest.setdefault("settings", {})
    if isinstance(settings, dict):
        settings["reviewCropMinimumSize"] = minimum_size
    return rebuilt, failures


def update_status(
    path: Path,
    status: dict[str, Any],
    *,
    emit_log: bool = True,
    **patch: Any,
) -> None:
    with STATUS_UPDATE_LOCK:
        status.update(patch)
        status["updatedAt"] = utc_text()
        _atomic_json(path, status)
        if emit_log:
            print(
                json.dumps(status, ensure_ascii=False, separators=(",", ":")),
                flush=True,
            )


def capture_gate_disposition(
    steel: dict[str, Any], health: dict[str, Any]
) -> dict[str, Any]:
    """Classify whether historical work can safely use the capture disks."""

    queue = health.get("storageQueue", {})
    if not isinstance(queue, dict):
        queue = {}
    reported_steel_present = bool(steel.get("present"))
    history_only = bool(health.get("historyOnly"))
    # A history-only provider cannot acquire or persist a live frame. Its
    # durable steel state may still describe the last interrupted live flow,
    # so that stale flag must not pause a disk-safe historical rebuild.
    live_steel_present = reported_steel_present and not history_only
    pending_rounds = int(queue.get("pendingRounds", 0) or 0)
    active_rounds = int(queue.get("activeRounds", 0) or 0)
    if live_steel_present:
        reason = "steel-present"
    elif pending_rounds > 0:
        reason = "storage-queue-pending"
    elif active_rounds > 0:
        reason = "storage-writer-active"
    else:
        reason = "idle"
    return {
        "available": True,
        "idle": not live_steel_present and pending_rounds == 0 and active_rounds == 0,
        "reason": reason,
        "capturePhase": str(steel.get("phase", "unknown")),
        "historyOnly": history_only,
        "steelPresent": live_steel_present,
        "reportedSteelPresent": reported_steel_present,
        "materialId": str(steel.get("materialId", "")),
        "queue": {
            "pendingRounds": pending_rounds,
            "activeRounds": active_rounds,
            "highWaterRounds": int(queue.get("highWaterRounds", 0) or 0),
            "failedRounds": int(queue.get("failedRounds", 0) or 0),
            "backpressureWaits": int(queue.get("backpressureWaits", 0) or 0),
        },
        "observedAt": utc_text(),
    }


def capture_gate_snapshot(capture_origin: str) -> dict[str, Any]:
    """Read the strict live-capture gate without touching historical storage."""
    origin = capture_origin.strip().rstrip("/")
    try:
        with request.urlopen(f"{origin}/api/steel/status", timeout=1.0) as response:
            steel = json.loads(response.read().decode("utf-8"))
        with request.urlopen(f"{origin}/api/capture/health", timeout=1.0) as response:
            health = json.loads(response.read().decode("utf-8"))
        if not isinstance(steel, dict) or not isinstance(health, dict):
            raise ValueError("capture status response must be a JSON object")
        return capture_gate_disposition(steel, health)
    except Exception as error:
        return {
            "available": False,
            "idle": False,
            "reason": "capture-status-unavailable",
            "capturePhase": "unavailable",
            "steelPresent": None,
            "materialId": "",
            "queue": {
                "pendingRounds": None,
                "activeRounds": None,
                "highWaterRounds": None,
                "failedRounds": None,
                "backpressureWaits": None,
            },
            "error": f"{type(error).__name__}: {error}",
            "observedAt": utc_text(),
        }


def wait_for_strict_capture_idle(
    capture_origin: str,
    status_path: Path,
    status: dict[str, Any],
    *,
    phase: str,
    next_material_id: str,
    should_stop: Callable[[], bool],
    stable_seconds: float = 0.5,
    poll_seconds: float = 0.2,
    heartbeat_seconds: float = 1.0,
    snapshot_reader: Callable[[str], dict[str, Any]] = capture_gate_snapshot,
    status_publisher: Callable[..., None] = update_status,
    tracker: CaptureGateTracker | None = None,
    current_material_id: str = "",
    publish_immediate_ready: bool = True,
) -> bool:
    """Pause before any historical material work until capture is strictly idle."""
    stable_since: float | None = None
    last_heartbeat = 0.0
    previous_reason = ""
    reported_pause = False
    while not should_stop():
        now = time.monotonic()
        maximum_observation_gap = max(0.5, poll_seconds * 4.0)
        if tracker is not None:
            snapshot, stable_for = tracker.current(
                now, maximum_age=maximum_observation_gap
            )
            if snapshot is None:
                snapshot, stable_for = tracker.observe(
                    snapshot_reader(capture_origin),
                    now,
                    maximum_observation_gap=maximum_observation_gap,
                )
        else:
            snapshot = snapshot_reader(capture_origin)
            idle = bool(snapshot.get("idle"))
            if idle:
                stable_since = stable_since or now
                stable_for = now - stable_since
            else:
                stable_since = None
                stable_for = 0.0
        idle = bool(snapshot.get("idle"))
        if idle:
            ready = stable_for >= max(0.0, stable_seconds)
            reason = "idle" if ready else "idle-stabilizing"
        else:
            ready = False
            reason = str(snapshot.get("reason", "capture-not-idle"))

        if ready:
            if publish_immediate_ready or reported_pause:
                status_publisher(
                    status_path,
                    status,
                    state="running",
                    phase=phase,
                    currentMaterialId=current_material_id,
                    pauseReason=None,
                    capturePhase=snapshot.get("capturePhase"),
                    captureQueue=snapshot.get("queue"),
                    nextMaterialId=next_material_id,
                    heartbeatAt=utc_text(),
                    captureGate={
                        **snapshot,
                        "state": "ready",
                        "stableForMs": round(stable_for * 1000.0, 3),
                    },
                )
            return True

        heartbeat_due = (
            last_heartbeat == 0.0
            or now - last_heartbeat >= max(0.05, heartbeat_seconds)
            or reason != previous_reason
        )
        if heartbeat_due:
            status_publisher(
                status_path,
                status,
                state="paused",
                phase=phase,
                currentMaterialId=current_material_id,
                pauseReason=reason,
                capturePhase=snapshot.get("capturePhase"),
                captureQueue=snapshot.get("queue"),
                nextMaterialId=next_material_id,
                heartbeatAt=utc_text(),
                captureGate={
                    **snapshot,
                    "state": "paused",
                    "stableForMs": round(stable_for * 1000.0, 3),
                },
            )
            last_heartbeat = now
            previous_reason = reason
            reported_pause = True
        time.sleep(max(0.01, poll_seconds))
    return False


def capture_gate_heartbeat_loop(
    capture_origin: str,
    status_path: Path,
    status: dict[str, Any],
    stop_event: threading.Event,
    *,
    stable_seconds: float = 0.5,
    poll_seconds: float = 0.2,
    heartbeat_seconds: float = 1.0,
    tracker: CaptureGateTracker | None = None,
) -> None:
    """Keep pause telemetry live while a bounded material operation is active."""
    stable_since: float | None = None
    last_write = 0.0
    previous_reason = ""
    while not stop_event.is_set():
        snapshot = capture_gate_snapshot(capture_origin)
        now = time.monotonic()
        if tracker is not None:
            snapshot, stable_for = tracker.observe(
                snapshot,
                now,
                maximum_observation_gap=max(0.5, poll_seconds * 4.0),
            )
            idle = bool(snapshot.get("idle"))
        else:
            idle = bool(snapshot.get("idle"))
            if idle:
                stable_since = stable_since or now
                stable_for = now - stable_since
            else:
                stable_since = None
                stable_for = 0.0
        if idle:
            ready = stable_for >= max(0.0, stable_seconds)
            reason = "idle" if ready else "idle-stabilizing"
        else:
            ready = False
            reason = str(snapshot.get("reason", "capture-not-idle"))
        if (
            last_write == 0.0
            or now - last_write >= max(0.05, heartbeat_seconds)
            or reason != previous_reason
        ):
            update_status(
                status_path,
                status,
                emit_log=False,
                state="running" if ready else "paused",
                pauseReason=None if ready else reason,
                capturePhase=snapshot.get("capturePhase"),
                captureQueue=snapshot.get("queue"),
                heartbeatAt=utc_text(),
                captureGate={
                    **snapshot,
                    "state": "ready" if ready else "paused",
                    "stableForMs": round(stable_for * 1000.0, 3),
                },
            )
            last_write = now
            previous_reason = reason
        stop_event.wait(max(0.01, poll_seconds))


def material_execution_gate(
    capture_origin: str,
    status_path: Path,
    status: dict[str, Any],
    *,
    phase_prefix: str,
    material_id: str,
    should_stop: Callable[[], bool],
    tracker: CaptureGateTracker,
) -> Callable[[str], None]:
    """Build a real execution checkpoint used between bounded history steps."""

    def checkpoint(step: str) -> None:
        phase = f"{phase_prefix}:{step}" if step else phase_prefix
        if not wait_for_strict_capture_idle(
            capture_origin,
            status_path,
            status,
            phase=phase,
            next_material_id="",
            current_material_id=material_id,
            should_stop=should_stop,
            tracker=tracker,
            publish_immediate_ready=False,
        ):
            raise BackfillInterrupted("history backfill interrupted at capture gate")

    return checkpoint


def process_is_running(process_id: int) -> bool:
    """Probe a PID without signalling it (``os.kill(pid, 0)`` kills on Windows)."""
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
        kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
        kernel32.GetExitCodeProcess.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel32.OpenProcess(
            process_query_limited_information, False, process_id
        )
        if not handle:
            # Access denied means the process exists but cannot be queried.
            return ctypes.get_last_error() == 5
        try:
            exit_code = ctypes.c_uint32()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and (
                exit_code.value == still_active
            )
        finally:
            kernel32.CloseHandle(handle)
    except (AttributeError, OSError, ValueError):
        return False


def lower_process_priority() -> str:
    """Keep historical CPU work below the live acquisition process."""
    try:
        if os.name == "nt":
            import ctypes

            idle_priority_class = 0x00000040
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            kernel32.SetPriorityClass.restype = ctypes.c_int
            if not kernel32.SetPriorityClass(
                kernel32.GetCurrentProcess(), idle_priority_class
            ):
                raise OSError(ctypes.get_last_error(), "SetPriorityClass failed")
            return "idle"
        os.nice(10)
        return "nice+10"
    except (AttributeError, OSError, ValueError):
        return "unchanged"


def acquire_lock(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        try:
            process_id = int(path.read_text(encoding="ascii").strip())
        except (OSError, ValueError):
            path.unlink(missing_ok=True)
        else:
            if not process_is_running(process_id):
                path.unlink(missing_ok=True)
    try:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        raise RuntimeError(f"history backfill is already locked: {path}") from error
    os.write(descriptor, f"{os.getpid()}\n".encode("ascii"))
    return descriptor


def final_outcome(stopped: bool, failures: list[dict[str, Any]]) -> tuple[str, int]:
    if stopped:
        return "interrupted", 130
    if failures:
        return "complete-with-errors", 1
    return "complete", 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--capture-origin", default="http://127.0.0.1:4317")
    parser.add_argument("--database-origin", default="http://127.0.0.1:4873")
    parser.add_argument(
        "--mode", choices=("all", "import-existing", "rebuild"), default="all"
    )
    parser.add_argument("--gpu-device", type=int)
    parser.add_argument("--inference-batch-size", type=int, default=0)
    parser.add_argument("--preprocess-workers", type=int, default=0)
    parser.add_argument("--minimum-crop-size", type=int, default=64)
    parser.add_argument("--minimum-material", type=int, default=0)
    parser.add_argument("--maximum-material", type=int, default=2**63 - 1)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    process_priority = lower_process_priority()

    profile = load_profile(args.profile)
    defaults = profile.raw.get("captureDefaults", {})
    camera_roots = {
        camera.camera_id: camera.storage_root for camera in profile.enabled_cameras
    }
    alignment_config, measurement_config, defect_config, calibration_path = create_configs(
        profile.source_path,
        profile.storage_root,
        defaults,
        args.capture_origin,
        args.database_origin,
        args.gpu_device,
    )
    defect_config = replace(
        defect_config,
        inference_batch_size=(
            args.inference_batch_size
            if args.inference_batch_size > 0
            else defect_config.inference_batch_size
        ),
        preprocess_workers=(
            args.preprocess_workers
            if args.preprocess_workers > 0
            else defect_config.preprocess_workers
        ),
        realtime_priority_status_path=(
            profile.storage_root
            / "system"
            / "jobs"
            / "flow-analysis"
            / "status.json"
        ),
        # Historical inference is strictly opportunistic: do not start a new
        # flow while even one live storage round is queued or being written.
        maximum_pending_storage_rounds=0,
    ).bounded()
    minimum_crop = max(64, min(1024, args.minimum_crop_size))
    job_root = profile.storage_root / "system" / "jobs" / "defect-history-backfill"
    status_path = job_root / "status.json"
    lock_path = job_root / ".lock"
    lock_descriptor = acquire_lock(lock_path)
    stopped = False

    def stop(*_args: Any) -> None:
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGINT, stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop)

    status: dict[str, Any] = {
        "schema": BACKFILL_SCHEMA,
        "version": BACKFILL_VERSION,
        "state": "running",
        "processId": os.getpid(),
        "mode": args.mode,
        "startedAt": utc_text(),
        "updatedAt": utc_text(),
        "profile": str(profile.source_path),
        "databaseOrigin": args.database_origin,
        "gpuDevice": defect_config.gpu_device_id,
        "inferenceBatchSize": defect_config.inference_batch_size,
        "preprocessWorkers": defect_config.preprocess_workers,
        "processPriority": process_priority,
        "minimumCropSize": minimum_crop,
        "minimumMaterial": args.minimum_material,
        "maximumMaterial": args.maximum_material,
        "materialLimit": args.limit,
        "materialCount": 0,
        "currentMaterialId": "",
        "regionManifestsUpdated": 0,
        "regionOverlapPairCount": 0,
        "importedManifests": 0,
        "importedDefects": 0,
        "cropsRebuilt": 0,
        "reprocessedMaterials": 0,
        "reprocessedDefects": 0,
        "skippedMaterials": 0,
        "failures": [],
    }
    update_status(status_path, status)
    heartbeat_stop = threading.Event()
    capture_gate_tracker = CaptureGateTracker()
    heartbeat_thread = threading.Thread(
        target=capture_gate_heartbeat_loop,
        args=(args.capture_origin, status_path, status, heartbeat_stop),
        kwargs={"tracker": capture_gate_tracker},
        name="sick-defect-backfill-capture-gate",
        daemon=True,
    )
    heartbeat_thread.start()
    try:
        materials: list[str] = []
        if wait_for_strict_capture_idle(
            args.capture_origin,
            status_path,
            status,
            phase="material-scan",
            next_material_id="",
            should_stop=lambda: stopped,
            tracker=capture_gate_tracker,
        ):
            scan_gate = material_execution_gate(
                args.capture_origin,
                status_path,
                status,
                phase_prefix="material-scan",
                material_id="",
                should_stop=lambda: stopped,
                tracker=capture_gate_tracker,
            )
            try:
                materials = [
                    value
                    for value in historical_materials(
                        camera_roots, execution_gate=scan_gate
                    )
                    if args.minimum_material
                    <= material_number(value)
                    <= args.maximum_material
                ]
            except BackfillInterrupted:
                materials = []
            if args.limit > 0:
                materials = materials[: args.limit]
            update_status(
                status_path,
                status,
                state="running",
                materialCount=len(materials),
                materialScanCompletedAt=utc_text(),
            )

        if not stopped and args.mode in {"all", "import-existing"}:
            update_status(status_path, status, phase="import-existing")
            for material_id in materials:
                if stopped:
                    break
                if not wait_for_strict_capture_idle(
                    args.capture_origin,
                    status_path,
                    status,
                    phase="import-existing",
                    next_material_id=material_id,
                    should_stop=lambda: stopped,
                    tracker=capture_gate_tracker,
                ):
                    break
                execution_gate = material_execution_gate(
                    args.capture_origin,
                    status_path,
                    status,
                    phase_prefix="import-existing",
                    material_id=material_id,
                    should_stop=lambda: stopped,
                    tracker=capture_gate_tracker,
                )
                update_status(
                    status_path,
                    status,
                    state="running",
                    phase="import-existing",
                    currentMaterialId=material_id,
                    nextMaterialId="",
                )
                manifest_path = defect_detection_manifest_path(
                    profile.storage_root, material_id
                )
                try:
                    execution_gate("manifest-exists")
                    if not manifest_path.is_file():
                        continue
                    execution_gate("manifest-read")
                    manifest = read_json(manifest_path)
                    rebuilt, crop_failures = ensure_minimum_review_crops(
                        manifest,
                        minimum_crop,
                        execution_gate=execution_gate,
                    )
                    manifest["manifestPath"] = str(manifest_path)
                    if not wait_for_strict_capture_idle(
                        args.capture_origin,
                        status_path,
                        status,
                        phase="import-existing-database",
                        next_material_id=material_id,
                        should_stop=lambda: stopped,
                        tracker=capture_gate_tracker,
                        current_material_id=material_id,
                    ):
                        break
                    execution_gate("database-import")
                    manifest["databaseImport"] = import_defect_manifest(
                        manifest,
                        args.database_origin,
                        execution_gate=execution_gate,
                    )
                    manifest["cropBackfill"] = {
                        "version": BACKFILL_VERSION,
                        "minimumSize": minimum_crop,
                        "rebuilt": rebuilt,
                        "failures": crop_failures,
                        "completedAt": utc_text(),
                    }
                    execution_gate("manifest-write")
                    _atomic_json(manifest_path, manifest)
                    status["importedManifests"] += 1
                    status["importedDefects"] += int(
                        manifest.get("statistics", {}).get(
                            "defectCount", len(manifest.get("defects", []))
                        )
                    )
                    status["cropsRebuilt"] += rebuilt
                except BackfillInterrupted:
                    break
                except Exception as error:
                    status["failures"].append(
                        {
                            "phase": "import-existing",
                            "materialId": material_id,
                            "error": f"{type(error).__name__}: {error}",
                        }
                    )
                    status["failures"] = status["failures"][-100:]
                update_status(
                    status_path, status, currentMaterialId=material_id
                )

        if not stopped and args.mode in {"all", "rebuild"}:
            update_status(status_path, status, phase="rebuild")
            for material_id in materials:
                if stopped:
                    break
                if not wait_for_strict_capture_idle(
                    args.capture_origin,
                    status_path,
                    status,
                    phase="rebuild",
                    next_material_id=material_id,
                    should_stop=lambda: stopped,
                    tracker=capture_gate_tracker,
                ):
                    break
                execution_gate = material_execution_gate(
                    args.capture_origin,
                    status_path,
                    status,
                    phase_prefix="rebuild",
                    material_id=material_id,
                    should_stop=lambda: stopped,
                    tracker=capture_gate_tracker,
                )
                update_status(
                    status_path,
                    status,
                    state="running",
                    phase="rebuild",
                    currentMaterialId=material_id,
                    nextMaterialId="",
                )
                manifest_path = defect_detection_manifest_path(
                    profile.storage_root, material_id
                )
                try:
                    execution_gate("existing-manifest-check")
                    if manifest_path.is_file() and not args.force:
                        try:
                            execution_gate("existing-manifest-read")
                            existing = read_json(manifest_path)
                        except BackfillInterrupted:
                            raise
                        except Exception:
                            existing = {}
                        marker = existing.get("historyBackfill", {})
                        if (
                            marker.get("version") == BACKFILL_VERSION
                            and int(marker.get("minimumCropSize", 0)) >= minimum_crop
                            and existing.get("databaseImport", {}).get("state")
                            == "complete"
                        ):
                            status["skippedMaterials"] += 1
                            continue
                    with exclusive_material_job(
                        profile.storage_root,
                        material_id,
                        purpose="defect-history-backfill",
                    ):
                        alignment_path = alignment_manifest_path(
                            profile.storage_root, material_id
                        )
                        execution_gate("alignment-manifest-check")
                        if alignment_path.is_file():
                            execution_gate("alignment-manifest-read")
                            alignment = read_json(alignment_path)
                        else:
                            _, alignment = build_and_write_flow_alignment(
                                camera_roots,
                                profile.storage_root,
                                material_id,
                                config=alignment_config,
                                execution_gate=execution_gate,
                            )
                        regions, region_updated = ensure_overlap_region_manifest(
                            camera_roots,
                            profile.storage_root,
                            material_id,
                            alignment,
                            measurement_config,
                            calibration_path,
                            execution_gate=execution_gate,
                        )
                        _, manifest = build_and_write_flow_defect_detection(
                            camera_roots,
                            profile.storage_root,
                            material_id,
                            alignment,
                            config=defect_config,
                            execution_gate=execution_gate,
                        )
                        manifest["historyBackfill"] = {
                            "version": BACKFILL_VERSION,
                            "minimumCropSize": minimum_crop,
                            "overlapStatistics": True,
                            "completedAt": utc_text(),
                        }
                        execution_gate("history-marker-write")
                        _atomic_json(manifest_path, manifest)
                    if region_updated:
                        status["regionManifestsUpdated"] += 1
                    status["regionOverlapPairCount"] += int(
                        regions.get("ownership", {}).get("overlapPairCount", 0)
                    )
                    status["reprocessedMaterials"] += 1
                    status["reprocessedDefects"] += int(
                        manifest.get("statistics", {}).get("defectCount", 0)
                    )
                except BackfillInterrupted:
                    break
                except Exception as error:
                    status["failures"].append(
                        {
                            "phase": "rebuild",
                            "materialId": material_id,
                            "error": f"{type(error).__name__}: {error}",
                        }
                    )
                    status["failures"] = status["failures"][-100:]
                    update_status(status_path, status)

        heartbeat_stop.set()
        heartbeat_thread.join(timeout=2.0)
        final_state, exit_code = final_outcome(stopped, status["failures"])
        update_status(
            status_path,
            status,
            state=final_state,
            phase=final_state if not stopped else status.get("phase", ""),
            currentMaterialId="",
            completedAt=utc_text(),
        )
        return exit_code
    finally:
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=2.0)
        os.close(lock_descriptor)
        lock_path.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
