#!/usr/bin/env python3
"""Continuously materialize alignment and measurement manifests for closed flows."""

from __future__ import annotations

import argparse
import json
import signal
import threading
import time
from pathlib import Path
from urllib import request

from sick_capture.alignment import AlignmentConfig, build_and_write_flow_alignment
from sick_capture.measurement import MeasurementConfig, build_and_write_flow_measurement
from sick_capture.profile import load_profile


def flow_signature(camera_roots: dict[str, Path], material_id: str) -> tuple[tuple[str, int, int], ...] | None:
    result: list[tuple[str, int, int]] = []
    for camera_id, root in sorted(camera_roots.items()):
        metadata = root / material_id / "json"
        if not metadata.is_dir():
            return None
        files = list(metadata.glob("*.json"))
        if not files:
            return None
        result.append((camera_id, len(files), max(path.stat().st_mtime_ns for path in files)))
    return tuple(result)


def capture_state(origin: str) -> tuple[str, int] | None:
    try:
        with request.urlopen(f"{origin.rstrip('/')}/api/steel/status", timeout=2.0) as response:
            payload = json.loads(response.read().decode("utf-8"))
        with request.urlopen(f"{origin.rstrip('/')}/api/capture/health", timeout=2.0) as response:
            health = json.loads(response.read().decode("utf-8"))
        active = str(payload.get("materialId", "")) if payload.get("present") else ""
        pending = int(health.get("storageQueue", {}).get("pendingRounds", 0) or 0)
        return active, pending
    except Exception:
        # Fail closed while capture state cannot be verified.
        return None


def recent_materials(first_root: Path, limit: int) -> list[str]:
    rows = [path for path in first_root.glob("FLOW-*") if path.is_dir()]
    rows.sort(key=lambda path: path.stat().st_mtime_ns, reverse=True)
    return [path.name for path in rows[:limit]]


def analyze(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment_config: AlignmentConfig,
    measurement_config: MeasurementConfig,
    calibration_path: Path | None,
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
    print(
        json.dumps(
            {
                "event": "flow-analysis-ready",
                "materialId": material_id,
                "alignment": str(alignment_path),
                "measurement": str(measurement_path),
                "synchronized": alignment.get("quality", {}).get("synchronized"),
                "metricValid": measurement.get("metricValid"),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--capture-origin", default="http://127.0.0.1:4317")
    parser.add_argument("--poll-seconds", type=float, default=2.0)
    parser.add_argument("--settle-seconds", type=float, default=20.0)
    parser.add_argument("--recent-flows", type=int, default=12)
    parser.add_argument("--maximum-storage-backlog", type=int, default=16)
    parser.add_argument("--once", default="")
    args = parser.parse_args()

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

    if args.once:
        analyze(
            camera_roots,
            profile.storage_root,
            args.once,
            alignment_config,
            measurement_config,
            calibration_path,
        )
        return 0

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
    observed: dict[str, tuple[tuple[tuple[str, int, int], ...], float]] = {}
    processed: dict[str, tuple[tuple[str, int, int], ...]] = {}
    first_root = next(iter(camera_roots.values()))
    while not stop.is_set():
        state = capture_state(args.capture_origin)
        if state is not None and state[1] <= max(0, args.maximum_storage_backlog):
            active, _pending = state
            now = time.monotonic()
            for material_id in recent_materials(first_root, max(1, args.recent_flows)):
                if material_id == active:
                    continue
                signature = flow_signature(camera_roots, material_id)
                if signature is None or processed.get(material_id) == signature:
                    continue
                previous = observed.get(material_id)
                if previous is None or previous[0] != signature:
                    observed[material_id] = (signature, now)
                    continue
                if now - previous[1] < max(1.0, args.settle_seconds):
                    continue
                try:
                    analyze(
                        camera_roots,
                        profile.storage_root,
                        material_id,
                        alignment_config,
                        measurement_config,
                        calibration_path,
                    )
                    after = flow_signature(camera_roots, material_id)
                    if after == signature:
                        processed[material_id] = signature
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
                    observed[material_id] = (signature, time.monotonic())
        stop.wait(max(0.25, args.poll_seconds))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
