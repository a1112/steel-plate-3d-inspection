#!/usr/bin/env python3
"""Flow-scoped algorithm loop driven by durable committed-frame events."""

from __future__ import annotations

import argparse
import json
import os
import queue
import signal
import threading
import time
import hashlib
from pathlib import Path
from urllib import request

from sick_capture.alignment import AlignmentConfig, build_and_write_flow_alignment
from sick_capture.defect_detection import (
    DefectDetectionConfig,
    build_and_write_flow_defect_detection,
    defect_detection_manifest_path,
)
from sick_capture.measurement import MeasurementConfig, build_and_write_flow_measurement
from sick_capture.material_lock import exclusive_material_job
from sick_capture.paths import (
    LAYOUT_SCHEMA,
    alignment_path as canonical_alignment_path,
    algorithm_state_path,
    frame_event_root,
    frame_event_path,
    flow_manifest_path,
    measurement_path as canonical_measurement_path,
    playback_index_path as canonical_playback_index_path,
    region_path as canonical_region_path,
    surface_path as canonical_surface_path,
)
from sick_capture.playback import build_and_write_playback_index
from sick_capture.profile import load_profile
from sick_capture.regions import build_and_write_flow_region_map
from sick_capture.storage import atomic_summary
from sick_capture.surface import (
    apply_surface_quality_gate,
    build_and_write_flow_surface,
)


def lower_process_priority() -> str:
    """Keep all derived work below the AboveNormal GenTL capture process."""
    try:
        if os.name == "nt":
            import ctypes

            below_normal_priority_class = 0x00004000
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            kernel32.SetPriorityClass.restype = ctypes.c_int
            if not kernel32.SetPriorityClass(
                kernel32.GetCurrentProcess(), below_normal_priority_class
            ):
                raise OSError(ctypes.get_last_error(), "SetPriorityClass failed")
            return "below-normal"
        os.nice(10)
        return "nice+10"
    except (AttributeError, OSError, ValueError):
        return "unchanged"


def committed_signature(
    storage_root: Path, material_id: str
) -> tuple[int, int, int] | None:
    """Read only the durable capture-to-algorithm hand-off contract."""
    root = frame_event_root(storage_root, material_id)
    if not root.is_dir():
        return None

    # Capture publishes the latest committed round in flow.json.  Resolve that
    # event directly before falling back to a directory scan: a production
    # flow contains thousands of event files, and enumerating 128 completed
    # flows on every poll can delay a newly closed bar by several minutes.
    try:
        manifest = json.loads(
            flow_manifest_path(storage_root, material_id).read_text(
                encoding="utf-8-sig"
            )
        )
        latest_round = int(manifest.get("latestCommittedRound", -1))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        latest_round = -1
    if latest_round >= 0:
        latest = frame_event_path(storage_root, material_id, latest_round)
        try:
            payload = json.loads(latest.read_text(encoding="utf-8-sig"))
            frames = payload.get("frames")
            expected_count = int(payload.get("expectedCameraCount", 0) or 0)
            committed_count = int(payload.get("committedCameraCount", 0) or 0)
            if (
                payload.get("schema") == "steel.capture-frame-committed.v1"
                and int(payload.get("captureRound", -1)) == latest_round
                and payload.get("complete") is True
                and isinstance(frames, list)
                and frames
                and expected_count > 0
                and committed_count == expected_count
                and len(frames) == expected_count
                and not payload.get("missingCameraIds")
            ):
                latest_mtime_ns = latest.stat().st_mtime_ns
                # A completed algorithm checkpoint carries the exact event
                # count. Reuse it when it names this immutable latest event.
                try:
                    state = json.loads(
                        algorithm_state_path(storage_root, material_id).read_text(
                            encoding="utf-8-sig"
                        )
                    )
                    recorded = (
                        int(state.get("committedEventCount", -1)),
                        int(state.get("latestCommittedRound", -1)),
                        int(state.get("latestCommittedEventMtimeNs", -1)),
                    )
                    if (
                        recorded[0] > 0
                        and recorded[1] == latest_round
                        and recorded[2] == latest_mtime_ns
                    ):
                        return recorded
                except (OSError, ValueError, TypeError, json.JSONDecodeError):
                    pass

                # Per-camera sequence numbers are flow-local and start at one;
                # their maximum is therefore the committed event count.  This
                # lets a brand-new flow take the same constant-time path.
                sequence_counts = []
                for frame in frames:
                    if not isinstance(frame, dict):
                        continue
                    try:
                        sequence = int(frame.get("sequenceNo", 0) or 0)
                        storage_count = int(frame.get("storageIndex", -1)) + 1
                    except (ValueError, TypeError):
                        continue
                    sequence_counts.extend(
                        value for value in (sequence, storage_count) if value > 0
                    )
                if sequence_counts:
                    return max(sequence_counts), latest_round, latest_mtime_ns
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass

    # Compatibility/recovery path for incomplete manifests and partial tail
    # events.  It deliberately finds the newest complete event, so an
    # auditable partial write can never advance the algorithm checkpoint.
    events = sorted(
        (path for path in root.glob("*.json") if path.stem.isdecimal()),
        key=lambda path: int(path.stem),
    )
    if not events:
        return None
    # A storage round can be published as partial so its failure is auditable,
    # but it must not advance a six-camera algorithm pass. Find the newest
    # complete event; later partial events therefore leave the signature
    # unchanged and cannot make derived data look synchronized when it is not.
    for event_index in range(len(events) - 1, -1, -1):
        latest = events[event_index]
        try:
            payload = json.loads(latest.read_text(encoding="utf-8-sig"))
            if payload.get("schema") != "steel.capture-frame-committed.v1":
                continue
            capture_round = int(payload.get("captureRound", latest.stem))
            if capture_round != int(latest.stem) or payload.get("complete") is not True:
                continue
            frames = payload.get("frames")
            expected_count = int(payload.get("expectedCameraCount", 0) or 0)
            committed_count = int(payload.get("committedCameraCount", 0) or 0)
            if (
                not isinstance(frames, list)
                or not frames
                or expected_count <= 0
                or committed_count != expected_count
                or len(frames) != expected_count
                or payload.get("missingCameraIds")
            ):
                continue
            return event_index + 1, capture_round, latest.stat().st_mtime_ns
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    return None


def _signature_fields(signature: tuple[int, int, int] | None) -> dict[str, int]:
    if signature is None:
        return {}
    return {
        "committedEventCount": int(signature[0]),
        "latestCommittedRound": int(signature[1]),
        "latestCommittedEventMtimeNs": int(signature[2]),
    }


def fast_artifacts_ready(
    storage_root: Path,
    material_id: str,
    signature: tuple[int, int, int],
) -> bool:
    """Recognize a durable final-fast checkpoint after process restart."""
    state_path = algorithm_state_path(storage_root, material_id)
    try:
        state = json.loads(state_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False
    if not isinstance(state, dict):
        return False
    recorded = (
        int(state.get("committedEventCount", -1)),
        int(state.get("latestCommittedRound", -1)),
        int(state.get("latestCommittedEventMtimeNs", -1)),
    )
    if recorded != signature:
        return False
    if str(state.get("state", "")) not in {
        "queued-for-defect",
        "processing-defects",
        "ready",
        "failed",
    }:
        return False
    return all(
        path.is_file()
        for path in (
            canonical_alignment_path(storage_root, material_id),
            canonical_measurement_path(storage_root, material_id),
            canonical_region_path(storage_root, material_id),
            canonical_surface_path(storage_root, material_id),
            canonical_playback_index_path(storage_root, material_id),
        )
    )


def defect_artifact_complete(storage_root: Path, material_id: str) -> bool:
    """A failed database import is retryable and is not a completed defect job."""
    path = defect_detection_manifest_path(storage_root, material_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False
    if not isinstance(payload, dict) or payload.get("state") in {
        "blocked",
        "database-write-failed",
        "failed",
    }:
        return False
    return payload.get("databaseImport", {}).get("state") != "failed"


def flow_state(storage_root: Path, material_id: str) -> str | None:
    path = flow_manifest_path(storage_root, material_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        if payload.get("schema") != LAYOUT_SCHEMA:
            return None
        return str(payload.get("state", ""))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def recent_materials(first_root: Path, limit: int) -> list[str]:
    rows = [
        path
        for path in first_root.iterdir()
        if path.is_dir()
        and path.name.isdigit()
    ]
    # Numeric flow numbers are monotonic.  Derived/history writes can update
    # an old directory's mtime and must never displace a newly closed live
    # flow from the realtime analysis window.
    rows.sort(key=lambda path: int(path.name), reverse=True)
    return [path.name for path in rows[:limit]]


def notify_region_commit(
    database_origin: str,
    material_id: str,
    path: Path,
    regions: dict[str, object],
) -> None:
    origin = database_origin.strip().rstrip("/")
    if not origin:
        return
    payload = json.dumps(
        {
            "schema": "steel.capture-region-commit.v1",
            "materialId": material_id,
            "manifestPath": str(path),
            "manifestSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "regions": regions,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    message = request.Request(
        f"{origin}/internal/v1/capture-regions",
        method="POST",
        data=payload,
        headers={"Content-Type": "application/json", "Connection": "close"},
    )
    with request.urlopen(message, timeout=5.0) as response:
        result = json.loads(response.read().decode("utf-8"))
    if int(result.get("code", 500)) != 0:
        raise RuntimeError(str(result.get("error", "region commit rejected")))


def _analyze_impl(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment_config: AlignmentConfig,
    measurement_config: MeasurementConfig,
    defect_detection_config: DefectDetectionConfig,
    calibration_path: Path | None,
    database_origin: str,
    *,
    final: bool,
    include_defects: bool = True,
    committed_event_signature: tuple[int, int, int] | None = None,
) -> None:
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
    region_path, regions = build_and_write_flow_region_map(
        camera_roots,
        storage_root,
        material_id,
        measurement,
    )
    notify_region_commit(database_origin, material_id, region_path, regions)
    surface_path, surface, jet_path = build_and_write_flow_surface(
        camera_roots,
        storage_root,
        material_id,
        alignment,
        calibration_path=calibration_path,
        config=measurement_config,
        region_map=regions,
    )
    measurement["surface"] = {
        "path": str(surface_path),
        "jetPath": str(jet_path) if jet_path.is_file() else "",
        "state": surface.get("state"),
        "quality": surface.get("quality"),
        "depthPrecision": surface.get("depthPrecision"),
        "calibrationAccuracy": surface.get("calibrationAccuracy"),
        "summary": surface.get("summary"),
    }
    apply_surface_quality_gate(measurement, surface)
    diameter_curves = surface.get("diameterCurves")
    if isinstance(diameter_curves, dict):
        measurement.setdefault("surfaceFit", {})["diameterCurves"] = diameter_curves
    atomic_summary(measurement_path, measurement)
    playback_path, playback = build_and_write_playback_index(
        camera_roots,
        storage_root,
        material_id,
    )
    defect_path: Path | None = None
    defects: dict[str, object] = {"state": "waiting-for-flow-close", "statistics": {"defectCount": 0}}
    if final and include_defects:
        defect_path, defects = build_and_write_flow_defect_detection(
            camera_roots,
            storage_root,
            material_id,
            alignment,
            config=defect_detection_config,
        )
    state_path = algorithm_state_path(storage_root, material_id)
    atomic_summary(
        state_path,
        {
            "schema": "steel.flow-algorithm-state.v1",
            "flowNo": int(material_id),
            "flowId": material_id,
            "state": (
                "ready"
                if final and include_defects
                else "queued-for-defect"
                if final
                else "derived-ready"
            ),
            "mode": (
                "final" if final and include_defects else "final-fast" if final else "incremental"
            ),
            "frameCount": int(playback.get("frameCount", 0)),
            "alignmentPath": str(alignment_path),
            "measurementPath": str(measurement_path),
            "regionPath": str(region_path),
            "surfacePath": str(surface_path),
            "playbackPath": str(playback_path),
            "defectPath": str(defect_path) if defect_path else "",
            "synchronized": alignment.get("quality", {}).get("synchronized"),
            "metricValid": measurement.get("metricValid"),
            "regionState": regions.get("state"),
            "defectState": (
                defects.get("state")
                if include_defects
                else "queued-for-defect"
            ),
            **_signature_fields(committed_event_signature),
        },
    )
    print(
        json.dumps(
            {
                "event": "flow-analysis-ready",
                "materialId": material_id,
                "alignment": str(alignment_path),
                "measurement": str(measurement_path),
                "regions": str(region_path),
                "surface": str(surface_path),
                "playback": str(playback_path),
                "defects": str(defect_path) if defect_path else "",
                "mode": (
                    "final"
                    if final and include_defects
                    else "final-fast"
                    if final
                    else "incremental"
                ),
                "defectState": defects.get("state"),
                "defectCount": defects.get("statistics", {}).get("defectCount", 0),
                "synchronized": alignment.get("quality", {}).get("synchronized"),
                "metricValid": measurement.get("metricValid"),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def _analyze_under_lock(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment_config: AlignmentConfig,
    measurement_config: MeasurementConfig,
    defect_detection_config: DefectDetectionConfig,
    calibration_path: Path | None,
    database_origin: str,
    *,
    final: bool,
    include_defects: bool = True,
    committed_event_signature: tuple[int, int, int] | None = None,
) -> None:
    """Run one owned analysis pass while publishing durable progress/failure state."""
    state_path = algorithm_state_path(storage_root, material_id)
    atomic_summary(
        state_path,
        {
            "schema": "steel.flow-algorithm-state.v1",
            "flowNo": int(material_id),
            "flowId": material_id,
            "state": "processing",
            "mode": (
                "final"
                if final and include_defects
                else "final-fast"
                if final
                else "incremental"
            ),
            "startedAtUnixMs": int(time.time() * 1000),
            **_signature_fields(committed_event_signature),
        },
    )
    try:
        _analyze_impl(
            camera_roots,
            storage_root,
            material_id,
            alignment_config,
            measurement_config,
            defect_detection_config,
            calibration_path,
            database_origin,
            final=final,
            include_defects=include_defects,
            committed_event_signature=committed_event_signature,
        )
    except Exception as error:
        atomic_summary(
            state_path,
            {
                "schema": "steel.flow-algorithm-state.v1",
                "flowNo": int(material_id),
                "flowId": material_id,
                "state": "failed",
                "mode": (
                    "final"
                    if final and include_defects
                    else "final-fast"
                    if final
                    else "incremental"
                ),
                "failedAtUnixMs": int(time.time() * 1000),
                "error": f"{type(error).__name__}: {error}",
                **_signature_fields(committed_event_signature),
            },
        )
        raise


def analyze(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment_config: AlignmentConfig,
    measurement_config: MeasurementConfig,
    defect_detection_config: DefectDetectionConfig,
    calibration_path: Path | None,
    database_origin: str,
    *,
    final: bool,
    include_defects: bool = True,
    committed_event_signature: tuple[int, int, int] | None = None,
) -> None:
    """Run one analysis pass with exclusive ownership of derived artifacts."""

    with exclusive_material_job(
        storage_root,
        material_id,
        purpose="flow-analysis",
    ):
        _analyze_under_lock(
            camera_roots,
            storage_root,
            material_id,
            alignment_config,
            measurement_config,
            defect_detection_config,
            calibration_path,
            database_origin,
            final=final,
            include_defects=include_defects,
            committed_event_signature=committed_event_signature,
        )


def _analyze_defects_only_under_lock(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    defect_detection_config: DefectDetectionConfig,
) -> None:
    """Run the heavy model stage without blocking realtime derived artifacts."""
    state_path = algorithm_state_path(storage_root, material_id)
    alignment_path = canonical_alignment_path(storage_root, material_id)
    try:
        previous = json.loads(state_path.read_text(encoding="utf-8-sig"))
        if not isinstance(previous, dict):
            previous = {}
    except (OSError, ValueError, json.JSONDecodeError):
        previous = {}
    atomic_summary(
        state_path,
        {
            **previous,
            "schema": "steel.flow-algorithm-state.v1",
            "flowNo": int(material_id),
            "flowId": material_id,
            "state": "processing-defects",
            "mode": "final-defects",
            "defectStartedAtUnixMs": int(time.time() * 1000),
        },
    )
    try:
        alignment = json.loads(alignment_path.read_text(encoding="utf-8-sig"))
        if not isinstance(alignment, dict):
            raise ValueError("alignment manifest must be a JSON object")
        defect_path, defects = build_and_write_flow_defect_detection(
            camera_roots,
            storage_root,
            material_id,
            alignment,
            config=defect_detection_config,
        )
        atomic_summary(
            state_path,
            {
                **previous,
                "schema": "steel.flow-algorithm-state.v1",
                "flowNo": int(material_id),
                "flowId": material_id,
                "state": "ready",
                "mode": "final",
                "defectPath": str(defect_path),
                "defectState": defects.get("state"),
                "defectCount": int(
                    defects.get("statistics", {}).get("defectCount", 0)
                ),
                "defectCompletedAtUnixMs": int(time.time() * 1000),
            },
        )
        print(
            json.dumps(
                {
                    "event": "flow-defects-ready",
                    "materialId": material_id,
                    "path": str(defect_path),
                    "state": defects.get("state"),
                    "defectCount": defects.get("statistics", {}).get(
                        "defectCount", 0
                    ),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except Exception as error:
        atomic_summary(
            state_path,
            {
                **previous,
                "schema": "steel.flow-algorithm-state.v1",
                "flowNo": int(material_id),
                "flowId": material_id,
                "state": "failed",
                "mode": "final-defects",
                "failedAtUnixMs": int(time.time() * 1000),
                "error": f"{type(error).__name__}: {error}",
            },
        )
        raise


def analyze_defects_only(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    defect_detection_config: DefectDetectionConfig,
) -> None:
    """Run the defect stage without racing a fast artifact generation."""

    with exclusive_material_job(
        storage_root,
        material_id,
        purpose="flow-defect-analysis",
    ):
        _analyze_defects_only_under_lock(
            camera_roots,
            storage_root,
            material_id,
            defect_detection_config,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--capture-origin", default="http://127.0.0.1:4317")
    parser.add_argument("--database-origin", default="http://127.0.0.1:4873")
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    parser.add_argument("--settle-seconds", type=float, default=20.0)
    parser.add_argument("--recent-flows", type=int, default=128)
    parser.add_argument("--maximum-storage-backlog", type=int, default=16)
    parser.add_argument("--tile-frames", type=int, default=16)
    parser.add_argument("--once", default="")
    parser.add_argument("--final", action="store_true")
    args = parser.parse_args()
    process_priority = lower_process_priority()

    profile = load_profile(args.profile)
    defaults = profile.raw.get("captureDefaults", {})
    camera_roots = {
        camera.camera_id: camera.storage_root for camera in profile.enabled_cameras
    }
    alignment_config = AlignmentConfig(
        search_frames=int(defaults.get("alignmentSearchFrames", 12)),
        stable_rows=int(defaults.get("alignmentStableRows", 8)),
        sample_step=int(defaults.get("alignmentSampleStep", 4)),
        depth_valid_ratio=float(defaults.get("alignmentDepthValidRatio", 0.005)),
        intensity_threshold=float(defaults.get("steelBrightPixelThreshold", 8.0)),
        intensity_ratio=float(defaults.get("steelBrightPixelRatio", 0.02)),
        anchor_interval_frames=int(defaults.get("softSyncAnchorIntervalFrames", 16)),
        maximum_anchor_residual_ms=float(defaults.get("softSyncMaximumResidualMs", 40.0)),
    ).bounded()
    measurement_config = MeasurementConfig(
        row_window=int(defaults.get("measurementRowWindow", 16)),
        maximum_profile_points=int(defaults.get("measurementMaximumProfilePoints", 320)),
        maximum_sections=int(defaults.get("measurementMaximumSections", 12)),
        minimum_circle_points=int(defaults.get("measurementMinimumCirclePoints", 48)),
        maximum_circle_residual_mm=float(
            defaults.get("measurementMaximumCircleResidualMm", 0.5)
        ),
    ).bounded()
    calibration_text = str(defaults.get("arrayCalibrationPath", "")).strip()
    calibration_path = None
    if calibration_text:
        candidate = Path(calibration_text)
        calibration_path = candidate if candidate.is_absolute() else profile.source_path.parent / candidate

    def configured_path(key: str) -> Path | None:
        text = os.path.expandvars(str(defaults.get(key, "")).strip())
        if not text:
            return None
        candidate = Path(text)
        return candidate if candidate.is_absolute() else profile.source_path.parent / candidate

    defect_detection_config = DefectDetectionConfig(
        enabled=bool(defaults.get("defectDetectionEnabled", False)),
        model_2d_path=configured_path("defectModel2dPath"),
        model_3d_path=configured_path("defectModel3dPath"),
        classifier_2d_path=configured_path("defectClassifier2dPath"),
        classifier_3d_path=configured_path("defectClassifier3dPath"),
        model_manifest_path=configured_path("defectModelManifestPath"),
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
        gpu_device_id=int(defaults.get("defectGpuDevice", 1)),
        depth_exposure=float(defaults.get("defectDepthExposure", 300.0)),
        depth_baseline_sample_step=int(
            defaults.get("defectDepthBaselineSampleStep", 4)
        ),
        review_crop_minimum_size=int(
            defaults.get("defectReviewCropMinimumSize", 64)
        ),
        capture_origin=args.capture_origin,
        database_origin=args.database_origin,
        maximum_idle_wait_seconds=float(
            defaults.get("defectMaximumIdleWaitSeconds", 300.0)
        ),
        maximum_pending_storage_rounds=int(
            min(
                int(defaults.get("defectMaximumPendingStorageRounds", 0)),
                max(0, args.maximum_storage_backlog),
            )
        ),
        require_approved_region_map=bool(
            defaults.get("defectRequireApprovedRegionMap", True)
        ),
    ).bounded()

    if args.once:
        analyze(
            camera_roots,
            profile.storage_root,
            args.once,
            alignment_config,
            measurement_config,
            defect_detection_config,
            calibration_path,
            args.database_origin,
            final=args.final,
        )
        return 0

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
    observed: dict[str, tuple[tuple[int, int, int], str, float]] = {}
    processed: dict[str, tuple[tuple[int, int, int], str]] = {}
    defect_completed: dict[str, tuple[int, int, int]] = {}
    defect_retry_after: dict[str, float] = {}
    defect_queue: queue.PriorityQueue[
        tuple[int, int, str, tuple[int, int, int]]
    ] = queue.PriorityQueue()
    queue_state_lock = threading.RLock()
    queued_defects: dict[str, tuple[int, int, int]] = {}
    queue_serial = 0
    current_fast_flow = ""
    current_defect_flow = ""
    fast_processed_count = 0
    defect_processed_count = 0
    last_queue_error = ""
    status_write_error = ""
    realtime_status_path = (
        profile.storage_root / "system" / "jobs" / "flow-analysis" / "status.json"
    )

    def write_queue_status() -> None:
        nonlocal status_write_error
        # Keep payload construction and replacement under the same lock.
        # Releasing it before os.replace allowed the fast and defect threads
        # to race on Windows and terminate the supervised Python worker.
        with queue_state_lock:
            queued_ids = sorted(queued_defects, key=int, reverse=True)
            payload = {
                "schema": "steel.flow-analysis-queue.v1",
                "state": "stopping" if stop.is_set() else "running",
                "updatedAtUnixMs": int(time.time() * 1000),
                "currentFastFlow": current_fast_flow or None,
                "currentDefectFlow": current_defect_flow or None,
                "pendingDefectFlows": max(
                    0, len(queued_ids) - (1 if current_defect_flow else 0)
                ),
                "queuedDefectFlowIds": queued_ids[:32],
                "fastProcessedFlowCount": fast_processed_count,
                "defectProcessedFlowCount": defect_processed_count,
                "recentFlowWindow": max(1, args.recent_flows),
                "maximumStorageBacklog": max(0, args.maximum_storage_backlog),
                "processPriority": process_priority,
                "lastError": last_queue_error or status_write_error or None,
            }
            retry_delays = (0.0, 0.02, 0.05, 0.10, 0.20)
            for attempt, delay in enumerate(retry_delays):
                if delay:
                    time.sleep(delay)
                try:
                    atomic_summary(realtime_status_path, payload)
                    status_write_error = ""
                    return
                except OSError as error:
                    if attempt + 1 == len(retry_delays):
                        status_write_error = (
                            f"queue status write failed: {type(error).__name__}: {error}"
                        )
                        print(
                            json.dumps(
                                {
                                    "event": "flow-analysis-status-write-failed",
                                    "error": str(error),
                                },
                                ensure_ascii=False,
                            ),
                            flush=True,
                        )

    def enqueue_defect(
        material_id: str, signature: tuple[int, int, int]
    ) -> None:
        nonlocal queue_serial
        if defect_artifact_complete(profile.storage_root, material_id):
            defect_completed[material_id] = signature
            return
        with queue_state_lock:
            if defect_completed.get(material_id) == signature:
                return
            if time.monotonic() < defect_retry_after.get(material_id, 0.0):
                return
            if queued_defects.get(material_id) == signature:
                return
            queued_defects[material_id] = signature
            queue_serial += 1
            defect_queue.put((-int(material_id), queue_serial, material_id, signature))
        write_queue_status()

    def defect_worker() -> None:
        nonlocal current_defect_flow, defect_processed_count, last_queue_error
        while not stop.is_set():
            try:
                _priority, _serial, material_id, signature = defect_queue.get(
                    timeout=0.5
                )
            except queue.Empty:
                continue
            with queue_state_lock:
                if queued_defects.get(material_id) != signature:
                    defect_queue.task_done()
                    continue
                current_defect_flow = material_id
            write_queue_status()
            try:
                analyze_defects_only(
                    camera_roots,
                    profile.storage_root,
                    material_id,
                    defect_detection_config,
                )
                with queue_state_lock:
                    defect_completed[material_id] = signature
                    defect_processed_count += 1
                    last_queue_error = ""
            except Exception as error:
                with queue_state_lock:
                    defect_retry_after[material_id] = time.monotonic() + 10.0
                    last_queue_error = f"{material_id}: {type(error).__name__}: {error}"
                print(
                    json.dumps(
                        {
                            "event": "flow-defect-analysis-failed",
                            "materialId": material_id,
                            "error": str(error),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            finally:
                with queue_state_lock:
                    if queued_defects.get(material_id) == signature:
                        queued_defects.pop(material_id, None)
                    current_defect_flow = ""
                defect_queue.task_done()
                write_queue_status()

    defect_thread = threading.Thread(
        target=defect_worker,
        name="sick-realtime-defect-queue",
        daemon=True,
    )
    defect_thread.start()
    write_queue_status()

    def status_heartbeat() -> None:
        while not stop.wait(5.0):
            write_queue_status()

    heartbeat_thread = threading.Thread(
        target=status_heartbeat,
        name="sick-flow-analysis-status-heartbeat",
        daemon=True,
    )
    heartbeat_thread.start()
    first_root = profile.storage_root
    while not stop.is_set():
        now = time.monotonic()
        defect_candidates: dict[str, tuple[int, int, int]] = {}
        for material_id in recent_materials(first_root, max(1, args.recent_flows)):
            state = flow_state(profile.storage_root, material_id)
            if state not in {"capturing", "closed"}:
                continue
            final = state == "closed"
            processed_row = processed.get(material_id)
            # An incremental pass intentionally runs only once. Avoid reading
            # its growing event directory again until flow.json transitions to
            # closed, at which point the final signature is calculated.
            if not final and processed_row is not None:
                continue
            signature = committed_signature(profile.storage_root, material_id)
            if signature is None:
                continue
            if (
                final
                and processed_row is None
                and fast_artifacts_ready(
                    profile.storage_root, material_id, signature
                )
            ):
                processed[material_id] = (signature, state)
                defect_candidates[material_id] = signature
                continue
            if processed_row == (signature, state):
                if final:
                    defect_candidates[material_id] = signature
                continue
            # Existing algorithms are whole-flow calculations rather than
            # append-only reducers. One early pass is enough to publish live
            # ROI; repeat once after close instead of rereading the growing
            # flow every tile and competing with GenTL acquisition.
            if not final and processed_row is not None:
                continue
            previous_count = processed_row[0][0] if processed_row else 0
            if not final and signature[0] - previous_count < max(1, args.tile_frames):
                continue
            previous = observed.get(material_id)
            if previous is None or previous[:2] != (signature, state):
                observed[material_id] = (signature, state, now)
                if final:
                    continue
            if final and now - observed[material_id][2] < max(0.25, args.settle_seconds):
                continue
            try:
                with queue_state_lock:
                    current_fast_flow = material_id
                write_queue_status()
                analyze(
                    camera_roots,
                    profile.storage_root,
                    material_id,
                    alignment_config,
                    measurement_config,
                    defect_detection_config,
                    calibration_path,
                    args.database_origin,
                    final=final,
                    include_defects=False,
                    committed_event_signature=signature,
                )
                after = committed_signature(profile.storage_root, material_id)
                after_state = flow_state(profile.storage_root, material_id)
                if after == signature and after_state == state:
                    processed[material_id] = (signature, state)
                    with queue_state_lock:
                        fast_processed_count += 1
                    if final:
                        defect_candidates[material_id] = signature
                else:
                    observed.pop(material_id, None)
            except Exception as error:
                print(
                    json.dumps(
                        {
                            "event": "flow-analysis-failed",
                            "materialId": material_id,
                            "error": str(error),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                observed[material_id] = (signature, state, time.monotonic())
            finally:
                with queue_state_lock:
                    current_fast_flow = ""
                write_queue_status()
            # Re-read the numeric material list after every expensive fast
            # pass so a newly closed live flow can never sit behind the rest
            # of a startup/history backlog captured by this iteration.
            break
        for material_id in sorted(defect_candidates, key=int, reverse=True):
            enqueue_defect(material_id, defect_candidates[material_id])
        stop.wait(max(0.25, args.poll_seconds))
    write_queue_status()
    defect_thread.join(timeout=2.0)
    heartbeat_thread.join(timeout=2.0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
