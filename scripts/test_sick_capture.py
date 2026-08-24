"""Contract tests for the SICK GenTL sidecar without physical hardware."""

from __future__ import annotations

from dataclasses import replace
import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Callable
from urllib import request
from urllib.parse import quote
from unittest.mock import patch

import numpy as np
from PIL import Image

from scripts.sick_capture.alignment import (
    AlignmentConfig,
    build_and_write_flow_alignment,
    build_flow_alignment,
)
from scripts.sick_capture.gentl import (
    _text,
    component_array,
    configure_frame_software_trigger,
    execute_software_trigger,
    frame_trigger_capability_snapshot,
    node_snapshot,
    select_components,
)
from scripts.sick_capture.models import RawFrame
from scripts.sick_capture.events import publish_committed_round, write_flow_manifest
from scripts.sick_capture.measurement import (
    MeasurementConfig,
    build_flow_measurement,
    robust_circle_fit,
    summarize_cylinder_sections,
)
from scripts.sick_capture.playback import (
    build_and_write_playback_index,
    build_image_pyramid,
    detect_valid_grayscale_roi,
    read_indexed_history,
    rebuild_playback_history,
    select_pyramid_image,
)
from scripts.sick_capture.profile import CameraProfile, load_profile
from scripts.sick_capture.regions import (
    build_flow_region_map,
    detect_valid_sensor_roi,
    stable_horizontal_roi,
)
from scripts.sick_capture.provider import (
    CAPTURE_DISCARDED_NOT_ARMED,
    NO_STEEL_FRAME_DISCARDED,
    ProviderRuntime,
    SickCaptureHTTPServer,
    _steel_tail_metrics,
)
from scripts.sick_capture.replay import LG3DReplaySource, validate_lg3d_dataset
from scripts.sick_capture.storage import DualFormatWriter, atomic_summary
from scripts.sick_capture.paths import (
    alignment_path,
    capture_root as camera_capture_root,
    measurement_path,
    playback_roi_path,
)


def sample_frame(sequence: int = 0) -> RawFrame:
    return RawFrame(
        camera_key="C1",
        camera_id="C1",
        serial_number="SICK-SN-001",
        model="RULER-X",
        firmware="1.2.3",
        ip="192.0.2.10",
        sequence=sequence,
        timestamp=1000 + sequence,
        timestamp_frequency=1_000_000_000,
        host_utc_ns=1_700_000_000_123_456_000 + sequence,
        host_monotonic_ns=2_000_000_000 + sequence,
        depth_raw=np.array([[101, 102, 103], [201, 202, 203]], dtype=np.uint16),
        intensity=np.array([[10, 20, 30], [40, 50, 60]], dtype=np.uint8),
        depth_data_format="Coord3D_C16",
        intensity_data_format="Mono8",
        coordinate_config={
            "CoordinateC": {
                "Scan3dCoordinateOffset": -12.5,
                "Scan3dCoordinateScale": 0.01,
                "Scan3dInvalidDataValue": 0,
            }
        },
        camera_config={"DeviceScanType": "Linescan3D"},
    )


def write_profile(root: Path) -> Path:
    cti = root / "SICKGigEVisionTL.cti"
    cti.write_bytes(b"fake-cti-for-contract-tests")
    cti_hash = hashlib.sha256(cti.read_bytes()).hexdigest()
    profile = {
        "schema": "steel.capture.profile.v1",
        "name": "sick-test",
        "driverMode": "sick-gentl",
        "storageRoot": str(root / "storage"),
        "autoConnect": True,
        "expectedCameras": 1,
        "sick": {
            "ctiPath": str(cti),
            "ctiSha256": cti_hash,
            "deviceScanType": "Linescan3D",
            "expectedDepthFormats": ["Coord3D_C16"],
            "expectedIntensityFormats": ["Mono8"],
        },
        "captureDefaults": {
            "timeoutMs": 1000,
            "blackFrameThreshold": 1.0,
            "synchronizationWarmupRounds": 0,
            "steelDetectionEdge": "bottom",
            "steelDetectionTailRows": 32,
        },
        "compatibility": {"lg3d": True, "jpegQuality": 95, "fsync": False},
        "cameras": [
            {
                "cameraIndex": 1,
                "id": "C1",
                "key": "C1",
                "serialNumber": "SICK-SN-001",
                "model": "RULER-X",
                "firmware": "1.2.3",
                "ip": "192.0.2.10",
                "role": "test",
                "storageRoot": str(root / "storage" / "C1"),
                "enabled": True,
                "nodeOverrides": {},
            }
        ],
    }
    path = root / "capture.json"
    path.write_text(json.dumps(profile, indent=2), encoding="utf-8")
    return path


class FakeComponent:
    def __init__(self, data_format: str, data: np.ndarray) -> None:
        self.data_format = data_format
        self.height, self.width = data.shape
        self.data = data.reshape(-1)


class FakeGenICamValue:
    def __init__(self, value: object, symbolics: list[str] | None = None) -> None:
        self.value = value
        self.symbolics = symbolics or []


class FakeGenICamCommand:
    def __init__(self) -> None:
        self.count = 0

    def execute(self) -> None:
        self.count += 1


class FakeTriggerNodeMap:
    def __init__(self) -> None:
        self.TriggerSelector = FakeGenICamValue("LineStart", ["FrameStart", "LineStart"])
        self.TriggerMode = FakeGenICamValue("Off", ["Off", "On"])
        self.TriggerSource = FakeGenICamValue("Encoder", ["Software", "Encoder"])
        self.TriggerSoftware = FakeGenICamCommand()
        self.FrameSynchronizationCapable = FakeGenICamValue(True)


class FakeSession:
    def __init__(self, camera: CameraProfile) -> None:
        self.camera = camera
        self.started = False
        self.sequence = 0
        self.identity = {
            "ip": camera.ip,
            "model": camera.model,
            "firmware": "test-firmware",
        }
        self.camera_config = {
            "DeviceTemperature": 42.5,
            "DeviceTemperatureMin": 20.0,
            "DeviceTemperatureMax": 55.0,
            "DeviceLinkThroughputCurrent": 125_000_000,
            "DeviceLinkThroughputLimit": 1_000_000_000,
            "AcquisitionFrameRate": 20.0,
        }

    def telemetry_snapshot(self) -> dict[str, object]:
        return {
            "deviceTemperature": 43.25,
            "deviceTemperatureMin": 20.0,
            "deviceTemperatureMax": 55.0,
            "deviceLinkThroughputCurrent": 125_000_000.0,
            "deviceLinkThroughputLimit": 1_000_000_000.0,
            "acquisitionFrameRate": 20.0,
            "updatedAtNs": 1_700_000_000_000_000_000,
        }

    def start(self) -> None:
        self.started = True

    def close(self) -> None:
        self.started = False

    def fetch_frame(self, _timeout_ms: int) -> RawFrame:
        frame = replace(
            sample_frame(self.sequence),
            camera_key=self.camera.key,
            camera_id=self.camera.camera_id,
            serial_number=self.camera.serial_number,
            model=self.camera.model,
            firmware=self.camera.firmware,
            ip=self.camera.ip,
            transport_frame_id=10_000 + self.sequence,
        )
        self.sequence += 1
        return frame


class BlockingSession(FakeSession):
    def __init__(
        self,
        camera: CameraProfile,
        fetch_started: threading.Event,
        release_fetch: threading.Event,
    ) -> None:
        super().__init__(camera)
        self.fetch_started = fetch_started
        self.release_fetch = release_fetch

    def fetch_frame(self, timeout_ms: int) -> RawFrame:
        self.fetch_started.set()
        if not self.release_fetch.wait(timeout_ms / 1000.0):
            raise TimeoutError("test fetch release timed out")
        return super().fetch_frame(timeout_ms)


class AlternatingSession(FakeSession):
    def fetch_frame(self, _timeout_ms: int) -> RawFrame:
        time.sleep(0.01)
        frame = super().fetch_frame(_timeout_ms)
        if frame.sequence % 2 == 0:
            return replace(frame, intensity=np.zeros_like(frame.intensity))
        return frame


class SparseSteelSession(FakeSession):
    def fetch_frame(self, _timeout_ms: int) -> RawFrame:
        frame = super().fetch_frame(_timeout_ms)
        intensity = np.zeros((100, 100), dtype=np.uint8)
        intensity[:, 49:52] = 30
        return replace(
            frame,
            depth_raw=np.zeros((100, 100), dtype=np.uint16),
            intensity=intensity,
        )


class NearBlackNoSteelSession(FakeSession):
    def fetch_frame(self, _timeout_ms: int) -> RawFrame:
        frame = super().fetch_frame(_timeout_ms)
        intensity = np.zeros((100, 100), dtype=np.uint8)
        intensity[0, 0] = 30
        return replace(
            frame,
            depth_raw=np.zeros((100, 100), dtype=np.uint16),
            intensity=intensity,
        )


class FakeBackend:
    def __init__(
        self,
        session_factory: Callable[[CameraProfile], FakeSession] | None = None,
    ) -> None:
        self.started = False
        self.closed = False
        self.session_factory = session_factory or FakeSession

    def start(self) -> None:
        self.started = True

    def connect(self, camera: CameraProfile) -> FakeSession:
        return self.session_factory(camera)

    def close(self) -> None:
        self.started = False
        self.closed = True


class SickComponentTests(unittest.TestCase):
    def test_software_trigger_configuration_and_command_are_auditable(self) -> None:
        node_map = FakeTriggerNodeMap()
        capability = frame_trigger_capability_snapshot(node_map, probe_frame_start=True)
        self.assertTrue(capability["softwareTriggerCapable"])
        self.assertEqual(capability["currentSelector"], "LineStart")
        self.assertEqual(capability["probedSelector"], "FrameStart")

        configured = configure_frame_software_trigger(node_map)
        self.assertEqual(configured["currentSelector"], "FrameStart")
        self.assertEqual(configured["currentMode"], "On")
        self.assertEqual(configured["currentSource"], "Software")
        issued, completed = execute_software_trigger(node_map)
        self.assertGreaterEqual(completed, issued)
        self.assertEqual(node_map.TriggerSoftware.count, 1)

    def test_fixed_motion_steel_detection_uses_only_the_latest_scan_edge(self) -> None:
        tail_has_steel = np.zeros((96, 128), dtype=np.uint8)
        tail_has_steel[-32:, 40:88] = 30
        maximum, ratio, rows = _steel_tail_metrics(
            tail_has_steel,
            edge="bottom",
            rows=32,
            bright_threshold=8,
        )
        self.assertEqual(rows, 32)
        self.assertEqual(maximum, 30)
        self.assertAlmostEqual(ratio, 0.375)

        stale_steel_at_old_edge = np.flipud(tail_has_steel)
        maximum, ratio, rows = _steel_tail_metrics(
            stale_steel_at_old_edge,
            edge="bottom",
            rows=32,
            bright_threshold=8,
        )
        self.assertEqual(rows, 32)
        self.assertEqual(maximum, 0)
        self.assertEqual(ratio, 0)

    def test_genicam_identity_text_is_normalized(self) -> None:
        self.assertEqual(_text("Ranger3-60\r\n"), "Ranger3-60")
        self.assertEqual(_text(b"25440062\x00"), "25440062\x00")

    def test_node_snapshot_skips_vendor_access_errors(self) -> None:
        class VendorAccessException(Exception):
            pass

        class ReadableNode:
            value = "Linescan3D"

        class UnreadableNode:
            @property
            def value(self):
                raise VendorAccessException("node is not readable")

        class NodeMap:
            DeviceScanType = ReadableNode()
            AvailableTest_ArrayFeature = UnreadableNode()

        self.assertEqual(node_snapshot(NodeMap()), {"DeviceScanType": "Linescan3D"})

    def test_components_are_selected_by_genicam_format_not_position(self) -> None:
        intensity = FakeComponent("Mono8", np.arange(6, dtype=np.uint8).reshape(2, 3))
        depth = FakeComponent("Coord3D_C16", np.arange(6, dtype=np.uint16).reshape(2, 3))

        selected_depth, selected_intensity = select_components(
            [intensity, depth],
            ("Coord3D_C16",),
            ("Mono8",),
        )

        self.assertIs(selected_depth, depth)
        self.assertIs(selected_intensity, intensity)
        np.testing.assert_array_equal(
            component_array(selected_depth, np.uint16),
            depth.data.reshape(2, 3),
        )

    def test_unknown_component_schema_fails_closed(self) -> None:
        mono = FakeComponent("Mono8", np.zeros((2, 3), dtype=np.uint8))
        with self.assertRaisesRegex(RuntimeError, "component schema mismatch"):
            select_components([mono], ("Coord3D_C16",), ("Mono8",))


class SickAlignmentTests(unittest.TestCase):
    def test_robust_circle_fit_rejects_outliers_and_reports_diameter(self) -> None:
        angles = np.linspace(0.0, 2.0 * np.pi, 180, endpoint=False)
        circle = np.column_stack((12.0 + 50.0 * np.cos(angles), -7.0 + 50.0 * np.sin(angles)))
        points = np.vstack((circle, np.array([[400.0, 400.0], [-300.0, 250.0]])))
        fit = robust_circle_fit(points, minimum_points=48)
        self.assertTrue(fit["available"])
        self.assertAlmostEqual(fit["diameterMm"], 100.0, places=3)
        self.assertLess(fit["robustPointCount"], fit["pointCount"])

    def test_cylinder_summary_reports_diameter_and_center_straightness(self) -> None:
        sections = []
        for index, diameter in enumerate((99.8, 100.0, 100.2)):
            sections.append(
                {
                    "elapsedFromHeadMs": index * 10.0,
                    "circleFit": {
                        "available": True,
                        "diameterMm": diameter,
                        "centerX": index * 0.05,
                        "centerZ": 0.0,
                    },
                }
            )
        summary = summarize_cylinder_sections(sections)
        self.assertTrue(summary["available"])
        self.assertAlmostEqual(summary["diameterMeanMm"], 100.0)
        self.assertAlmostEqual(summary["headRelativeTimeSpanMs"], 20.0)
        self.assertAlmostEqual(summary["centerStraightnessMaximumMm"], 0.05)

    @staticmethod
    def _write_camera_flow(
        camera_root: Path,
        material_id: str,
        *,
        camera_id: str,
        clock_offset: int,
        head_global_row: int,
        frame_ids: list[int],
    ) -> None:
        flow_root = camera_capture_root(camera_root, material_id, camera_id)
        for directory in ("2d", "3d", "json"):
            (flow_root / directory).mkdir(parents=True, exist_ok=True)
        (flow_root / "camera_config.json").write_text(
            json.dumps({"AcquisitionLineRate": 1000.0}),
            encoding="utf-8",
        )
        height, width = 12, 40
        for index, frame_id in enumerate(frame_ids):
            intensity = np.zeros((height, width), dtype=np.uint8)
            depth = np.zeros((height, width), dtype=np.uint16)
            global_top = index * height
            first_row = max(0, head_global_row - global_top)
            if first_row < height:
                intensity[first_row:, 8:32] = 40
                depth[first_row:, 8:32] = 1000
            Image.fromarray(intensity, mode="L").save(flow_root / "2d" / f"{index}.png")
            np.savez_compressed(flow_root / "3d" / f"{index}.npz", array=depth)
            (flow_root / "json" / f"{index}.json").write_text(
                json.dumps(
                    {
                        "cameraId": camera_id,
                        "captureRound": 100 + index,
                        "timestamp": clock_offset + index * 12_000_000,
                        "timestamp_frequency": 1_000_000_000,
                        "hostUtcNs": 1_700_000_000_000_000_000 + index * 12_000_000,
                        "transportFrameId": frame_id,
                        "height": height,
                        "width": width,
                    }
                ),
                encoding="utf-8",
            )

    def test_flow_alignment_uses_head_relative_time_and_records_transport_gap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material_id = "1"
            c1 = root / "C1"
            c2 = root / "C2"
            self._write_camera_flow(
                c1,
                material_id,
                camera_id="C1",
                clock_offset=1_000_000_000,
                head_global_row=4,
                frame_ids=[10, 11, 12],
            )
            self._write_camera_flow(
                c2,
                material_id,
                camera_id="C2",
                clock_offset=9_000_000_000,
                head_global_row=14,
                frame_ids=[20, 22, 23],
            )
            config = AlignmentConfig(
                search_frames=3,
                stable_rows=3,
                sample_step=1,
                anchor_interval_frames=1,
                maximum_anchor_residual_ms=20,
            )
            manifest = build_flow_alignment(
                {"C1": c1, "C2": c2},
                material_id,
                config=config,
            )
            self.assertEqual(manifest["schema"], "steel.capture-alignment.v1")
            self.assertEqual(manifest["referenceCameraId"], "C1")
            self.assertEqual(manifest["cameras"]["C1"]["head"]["globalRow"], 4)
            self.assertEqual(manifest["cameras"]["C2"]["head"]["globalRow"], 14)
            self.assertFalse(manifest["cameras"]["C1"]["head"]["clipped"])
            self.assertEqual(manifest["cameras"]["C2"]["transportGapCount"], 1)
            self.assertEqual(manifest["quality"]["transportFrameGaps"], 1)
            self.assertGreaterEqual(len(manifest["softSyncAnchors"]), 2)

            path, written = build_and_write_flow_alignment(
                {"C1": c1, "C2": c2},
                root,
                material_id,
                config=config,
            )
            self.assertTrue(path.is_file())
            self.assertEqual(written["materialId"], material_id)
            self.assertEqual(path, alignment_path(root, material_id))
            self.assertFalse((camera_capture_root(c1, material_id, "C1") / "alignment.json").exists())

    def test_current_flow_measurement_emits_crop_preview_but_blocks_uncalibrated_metric(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material_id = "2"
            camera_root = root / "C1"
            self._write_camera_flow(
                camera_root,
                material_id,
                camera_id="C1",
                clock_offset=1_000_000_000,
                head_global_row=4,
                frame_ids=[10, 11, 12],
            )
            alignment = build_flow_alignment(
                {"C1": camera_root},
                material_id,
                config=AlignmentConfig(
                    search_frames=3,
                    stable_rows=3,
                    sample_step=1,
                    anchor_interval_frames=1,
                ),
            )
            result = build_flow_measurement(
                {"C1": camera_root},
                material_id,
                alignment,
                config=MeasurementConfig(row_window=3, maximum_profile_points=64),
            )
            self.assertEqual(result["schema"], "steel.ranger3-flow-measurement.v1")
            self.assertEqual(result["mode"], "preview")
            self.assertFalse(result["metricValid"])
            self.assertIn("C1", result["twoDimensionalCrop"])
            self.assertIn("approved-array-calibration-missing", result["qualityGate"]["reasons"])

    def test_approved_calibration_releases_diameter_and_cylinder_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material_id = "3"
            flow_root = camera_capture_root(root / "C1", material_id, "C1")
            for name in ("2d", "3d", "json"):
                (flow_root / name).mkdir(parents=True, exist_ok=True)

            width, height = 200, 12
            x = np.arange(width, dtype=np.float64) * 0.1 - 10.0
            z_mm = np.sqrt(np.maximum(0.0, 10.0**2 - x**2))
            depth_line = np.rint((z_mm + 20.0) / 0.01).astype(np.uint16)
            depth = np.repeat(depth_line[np.newaxis, :], height, axis=0)
            intensity = np.full((height, width), 64, dtype=np.uint8)
            metadata = {
                "cameraSerialNumber": "SICK-METRIC-001",
                "bdConfig": {
                    "CoordinateA": {
                        "Scan3dCoordinateScale": 0.1,
                        "Scan3dCoordinateOffset": -10.0,
                        "Scan3dInvalidDataValue": 0,
                    },
                    "CoordinateC": {
                        "Scan3dCoordinateScale": 0.01,
                        "Scan3dCoordinateOffset": -20.0,
                        "Scan3dInvalidDataValue": 0,
                    },
                },
            }
            Image.fromarray(intensity, mode="L").save(flow_root / "2d" / "0.png")
            np.savez_compressed(flow_root / "3d" / "0.npz", array=depth)
            (flow_root / "json" / "0.json").write_text(
                json.dumps(metadata), encoding="utf-8"
            )
            calibration_path = root / "calibration.json"
            calibration_path.write_text(
                json.dumps(
                    {
                        "schema": "steel.sick-array-calibration.v1",
                        "revision": "TEST-APPROVED",
                        "approved": True,
                        "cameras": {
                            "C1": {
                                "serialNumber": "SICK-METRIC-001",
                                "localToArray": np.eye(4).tolist(),
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            anchor = {
                "ordinal": 0,
                "elapsedFromHeadMs": 0.0,
                "cameras": {
                    "C1": {
                        "available": True,
                        "storageIndex": 0,
                        "rowIndex": 6,
                        "rowClipped": False,
                        "timeResidualMs": 0.0,
                    }
                },
            }
            alignment = {
                "quality": {"state": "synchronized", "synchronized": True},
                "softSyncAnchors": [anchor, {**anchor, "ordinal": 1, "elapsedFromHeadMs": 10.0}],
            }
            result = build_flow_measurement(
                {"C1": root / "C1"},
                material_id,
                alignment,
                calibration_path=calibration_path,
                config=MeasurementConfig(
                    row_window=3,
                    maximum_profile_points=200,
                    maximum_sections=2,
                    minimum_circle_points=48,
                    maximum_circle_residual_mm=0.05,
                ),
            )
            self.assertTrue(result["metricValid"])
            self.assertEqual(result["mode"], "metric")
            self.assertAlmostEqual(
                result["selectedSection"]["circleFit"]["diameterMm"], 20.0, delta=0.03
            )
            self.assertTrue(result["surfaceFit"]["metricValid"])
            self.assertEqual(result["surfaceFit"]["sectionsAccepted"], 2)

    def test_flow_alignment_fails_quality_gate_when_saved_head_is_clipped(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material_id = "4"
            c1 = root / "C1"
            self._write_camera_flow(
                c1,
                material_id,
                camera_id="C1",
                clock_offset=1_000_000_000,
                head_global_row=0,
                frame_ids=[1, 2, 3],
            )
            manifest = build_flow_alignment(
                {"C1": c1},
                material_id,
                config=AlignmentConfig(search_frames=3, stable_rows=3, sample_step=1),
            )
            self.assertTrue(manifest["cameras"]["C1"]["head"]["clipped"])
            self.assertFalse(manifest["quality"]["synchronized"])
            self.assertEqual(manifest["quality"]["clippedHeadCameras"], ["C1"])

    def test_flow_alignment_ignores_static_depth_background_for_grayscale_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material_id = "5"
            camera_root = root / "C1"
            self._write_camera_flow(
                camera_root,
                material_id,
                camera_id="C1",
                clock_offset=1_000_000_000,
                head_global_row=16,
                frame_ids=[1, 2, 3],
            )
            # Simulate a fixed object that yields valid 3D samples before the
            # bright steel arrives. It must not move the grayscale boundary to
            # the first saved row.
            for index in range(3):
                path = camera_capture_root(camera_root, material_id, "C1") / "3d" / f"{index}.npz"
                with np.load(path, allow_pickle=False) as payload:
                    depth = np.asarray(payload[payload.files[0]]).copy()
                depth[:, :4] = 500
                np.savez_compressed(path, array=depth)

            manifest = build_flow_alignment(
                {"C1": camera_root},
                material_id,
                config=AlignmentConfig(search_frames=3, stable_rows=3, sample_step=1),
            )
            head = manifest["cameras"]["C1"]["head"]
            self.assertEqual(head["globalRow"], 16)
            self.assertFalse(head["clipped"])
            self.assertEqual(head["source"], "grayscale-intensity")

    def test_saved_black_frame_omission_is_not_reported_as_transport_loss(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material_id = "6"
            camera_root = root / "C1"
            self._write_camera_flow(
                camera_root,
                material_id,
                camera_id="C1",
                clock_offset=1_000_000_000,
                head_global_row=4,
                frame_ids=[10, 12, 13],
            )
            flow_root = camera_capture_root(camera_root, material_id, "C1")
            middle = flow_root / "json" / "1.json"
            payload = json.loads(middle.read_text(encoding="utf-8"))
            payload["captureRound"] = 102
            middle.write_text(json.dumps(payload), encoding="utf-8")
            last = flow_root / "json" / "2.json"
            payload = json.loads(last.read_text(encoding="utf-8"))
            payload["captureRound"] = 103
            last.write_text(json.dumps(payload), encoding="utf-8")

            manifest = build_flow_alignment(
                {"C1": camera_root},
                material_id,
                config=AlignmentConfig(search_frames=3, stable_rows=3, sample_step=1),
            )
            self.assertEqual(manifest["cameras"]["C1"]["transportGapCount"], 0)
            self.assertEqual(manifest["cameras"]["C1"]["storageOmittedRounds"], 1)


class SickPlaybackTests(unittest.TestCase):
    def test_black_frame_has_no_valid_roi_and_cannot_expand_to_full_frame(self) -> None:
        black = np.zeros((128, 320), dtype=np.uint8)
        self.assertIsNone(detect_valid_grayscale_roi(black))
        full = [96, 0, 224, 128]
        partial = [70, 112, 250, 128]
        self.assertEqual(
            stable_horizontal_roi([full, full, partial], 320, 128),
            full,
        )

    def test_region_map_keeps_full_height_and_blocks_uncalibrated_detection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "C1"
            flow = camera_capture_root(root, "7", "C1")
            (flow / "2d").mkdir(parents=True)
            (flow / "3d").mkdir()
            for index in range(3):
                image = np.zeros((96, 320), dtype=np.uint8)
                image[:, 180:260] = 40
                Image.fromarray(image, mode="L").save(flow / "2d" / f"{index}.png")
                np.savez_compressed(flow / "3d" / f"{index}.npz", image.astype(np.uint16))
            regions = build_flow_region_map(
                {"C1": root},
                "7",
                {
                    "metricValid": False,
                    "qualityGate": {"reasons": ["approved-array-calibration-missing"]},
                    "calibration": {"approved": False, "calibratedCameras": 0},
                    "selectedSection": {"circleFit": {"available": False}},
                },
            )
            self.assertTrue(regions["backgroundReady"])
            self.assertFalse(regions["defectDetectionAllowed"])
            self.assertEqual(regions["cameras"]["C1"]["stableCrop"][1:], [0, 276, 96])

    def test_grayscale_roi_crops_black_border_and_ignores_isolated_noise(self) -> None:
        image = np.zeros((100, 240), dtype=np.uint8)
        image[10:90, 80:160] = 64
        image[3, 225] = 255
        roi = detect_valid_grayscale_roi(
            image, horizontal_padding=0, vertical_padding=0
        )
        self.assertEqual(roi, [80, 10, 160, 90])

    def test_pyramid_is_persistent_and_records_original_coordinate_roi(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            image = np.zeros((120, 400), dtype=np.uint8)
            image[:, 120:280] = 80
            Image.fromarray(image, mode="L").save(source)

            manifest_path, manifest = build_image_pyramid(source, root / "cache")
            selected_path, level = select_pyramid_image(manifest_path, manifest, 320)
            self.assertTrue(selected_path.is_file())
            self.assertEqual(manifest["validRoi"], [104, 0, 296, 120])
            self.assertTrue(manifest["blackBorderCropped"])
            self.assertGreaterEqual(level["width"], 160)
            original_time = manifest_path.stat().st_mtime_ns
            second_path, second = build_image_pyramid(source, root / "cache")
            self.assertEqual(second_path, manifest_path)
            self.assertEqual(second["sourceFingerprint"], manifest["sourceFingerprint"])
            self.assertEqual(manifest_path.stat().st_mtime_ns, original_time)

    def test_pyramid_uses_stable_flow_horizontal_roi(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = camera_capture_root(root / "C1", "8", "C1") / "2d" / "0.png"
            source.parent.mkdir(parents=True)
            image = np.zeros((120, 400), dtype=np.uint8)
            image[30:80, 180:230] = 80
            Image.fromarray(image, mode="L").save(source)
            cache_root = root / "8" / "cache"
            roi_path = playback_roi_path(root, "8")
            roi_path.parent.mkdir(parents=True)
            roi_path.write_text(
                json.dumps({"cameras": {"C1": [100, 0, 300, 120]}}),
                encoding="utf-8",
            )

            _, manifest = build_image_pyramid(source, cache_root)
            self.assertEqual(manifest["validRoi"], [100, 0, 300, 120])
            self.assertEqual(manifest["frameDetectedRoi"], [164, 26, 246, 84])
            self.assertEqual(manifest["flowHorizontalRoi"], [100, 0, 300, 0])

    def test_defect_review_pyramid_preserves_the_complete_minimum_crop(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "9" / "derived" / "defects" / "review" / "9-C1-1.png"
            source.parent.mkdir(parents=True)
            image = np.zeros((64, 64), dtype=np.uint8)
            image[24:40, 26:38] = 100
            Image.fromarray(image, mode="L").save(source)

            _, manifest = build_image_pyramid(source, root / "9" / "cache")
            self.assertEqual(manifest["validRoi"], [0, 0, 64, 64])
            self.assertEqual(manifest["cropSize"], [64, 64])
            self.assertFalse(manifest["blackBorderCropped"])

    def test_playback_index_groups_cameras_by_capture_round_not_storage_index(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material_id = "9"
            camera_roots = {"C1": root / "C1", "C2": root / "C2"}
            rows = {
                "C1": [(0, 100), (1, 101)],
                # C2 omitted round 100 as an invalid black frame.
                "C2": [(0, 101)],
            }
            for camera_id, values in rows.items():
                flow = camera_capture_root(camera_roots[camera_id], material_id, camera_id)
                (flow / "2d").mkdir(parents=True)
                (flow / "json").mkdir()
                for storage_index, capture_round in values:
                    Image.fromarray(np.full((12, 60), 50, dtype=np.uint8), mode="L").save(
                        flow / "2d" / f"{storage_index}.png"
                    )
                    (flow / "json" / f"{storage_index}.json").write_text(
                        json.dumps(
                            {
                                "cameraId": camera_id,
                                "cameraKey": camera_id,
                                "cameraIp": f"192.0.2.{1 if camera_id == 'C1' else 2}",
                                "captureRound": capture_round,
                                "hostUtcNs": 1_700_000_000_000_000_000
                                + capture_round,
                                "width": 60,
                                "height": 12,
                            }
                        ),
                        encoding="utf-8",
                    )

            target_measurement = measurement_path(root, material_id)
            target_measurement.parent.mkdir(parents=True)
            target_measurement.write_text(
                json.dumps(
                    {
                        "twoDimensionalCrop": {
                            "C1": [10, 0, 50, 12],
                            "C2": [8, 0, 52, 12],
                        }
                    }
                ),
                encoding="utf-8",
            )
            _, index = build_and_write_playback_index(
                camera_roots, root, material_id
            )
            self.assertEqual(index["frameCount"], 2)
            self.assertEqual(
                [len(frame["cameras"]) for frame in index["frames"]], [1, 2]
            )
            indexed = read_indexed_history(root, 10)
            self.assertIsNotNone(indexed)
            history, has_more, total = indexed  # type: ignore[misc]
            self.assertFalse(has_more)
            self.assertEqual(total, 2)
            self.assertEqual(history[-1]["sequence"], 101)
            self.assertEqual(len(history[-1]["cameras"]), 2)
            self.assertEqual(history[-1]["cameras"][0]["playbackWidth"], 40)

    def test_history_rebuild_uses_only_flow_first_camera_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active = root / "external"
            storage = root / "storage"
            for material_id, capture_round in (("1", 10), ("57", 20)):
                flow = camera_capture_root(active, material_id, "C2")
                (flow / "2d").mkdir(parents=True)
                (flow / "json").mkdir()
                Image.fromarray(
                    np.full((8, 40), 60, dtype=np.uint8), mode="L"
                ).save(
                    flow / "2d" / ("0.jpg" if material_id == "1" else "0.png")
                )
                (flow / "json" / "0.json").write_text(
                    json.dumps(
                        {
                            "cameraId": "C2",
                            "cameraKey": "C2",
                            "captureRound": capture_round,
                            "hostUtcNs": 1_700_000_000_000_000_000 + capture_round,
                            "width": 40,
                            "height": 8,
                        }
                    ),
                    encoding="utf-8",
                )

            rebuilt = rebuild_playback_history(
                {"C2": active}, storage
            )
            self.assertEqual(rebuilt["materialCount"], 2)
            self.assertEqual(rebuilt["frameCount"], 2)
            catalog = json.loads(
                (storage / "catalog.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                {row["materialId"] for row in catalog["materials"]}, {"1", "57"}
            )
            rebuilt_index = json.loads(
                (storage / "1" / "derived" / "playback" / "index.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertTrue(
                not Path(rebuilt_index["frames"][0]["cameras"][0]["artifactRef"])
                .is_absolute()
            )
            self.assertTrue(
                rebuilt_index["frames"][0]["cameras"][0]["artifactRef"].endswith(
                    ".jpg"
                )
            )

    def test_history_rebuild_does_not_read_old_history_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            active = root / "external"
            storage = root / "storage"
            flow = camera_capture_root(active, "1", "C2")
            (flow / "2d").mkdir(parents=True)
            Image.fromarray(np.full((8, 40), 60, dtype=np.uint8), mode="L").save(
                flow / "2d" / "0.jpg"
            )
            history = storage / "history"
            history.mkdir(parents=True)
            (history / "1.json").write_text(
                json.dumps(
                    {
                        "schema": "steel.capture-playback-index.v1",
                        "materialId": "FLOW-0000000001",
                        "frameCount": 1,
                        "firstHostUtcNs": 100,
                        "lastHostUtcNs": 100,
                        "frames": [
                            {
                                "frameId": "FLOW-0000000001:000000000010",
                                "materialId": "FLOW-0000000001",
                                "sequence": 10,
                                "sortNs": 100,
                                "cameras": [
                                    {
                                        "cameraId": "C2",
                                        "storageIndex": 0,
                                        "artifactRef": "C2/FLOW-0000000001/2d/0.jpg",
                                    }
                                ],
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            rebuilt = rebuild_playback_history(
                {"C2": active}, storage
            )
            self.assertEqual(rebuilt["reusedIndexCount"], 0)
            self.assertEqual(rebuilt["rebuiltIndexCount"], 0)
            self.assertFalse((storage / "1" / "derived" / "playback" / "index.json").exists())


class SickProfileTests(unittest.TestCase):
    def test_rejects_unknown_frame_trigger_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = write_profile(Path(directory))
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["captureDefaults"]["frameTriggerMode"] = "timer"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "frameTriggerMode"):
                load_profile(path)

    def test_tail_row_detection_profile_is_validated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = write_profile(Path(directory))
            profile = load_profile(path)
            self.assertEqual(
                profile.raw["captureDefaults"]["steelDetectionEdge"], "bottom"
            )
            self.assertEqual(
                profile.raw["captureDefaults"]["steelDetectionTailRows"], 32
            )

            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["captureDefaults"]["steelDetectionEdge"] = "sideways"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "must be top or bottom"):
                load_profile(path)

    def test_cti_hash_and_hardware_identity_are_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = write_profile(root)
            profile = load_profile(path)
            self.assertEqual(profile.expected_cameras, 1)
            self.assertEqual(profile.enabled_cameras[0].serial_number, "SICK-SN-001")

            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["sick"]["ctiSha256"] = "0" * 64
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                load_profile(path)

    def test_placeholder_serial_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = write_profile(Path(directory))
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["cameras"][0]["serialNumber"] = "<REQUIRED_SERIAL>"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "cannot be a placeholder"):
                load_profile(path)


class SickSitePackageTests(unittest.TestCase):
    def test_single_camera_site_topology_matches_capture_and_mapping(self) -> None:
        site_root = (
            Path(__file__).resolve().parents[1]
            / "config"
            / "sites"
            / "sick-single-lab"
        )
        site = json.loads((site_root / "site.json").read_text(encoding="utf-8"))
        referenced = {
            name: json.loads((site_root / name).read_text(encoding="utf-8"))
            for name in (
                site["runtimeProfile"],
                site["connectionConfig"],
                site["captureConfig"],
                site["algorithmConfig"],
                site["mappingConfig"],
            )
        }
        runtime = referenced["runtime.json"]
        capture = referenced["capture.json"]
        mapping = referenced["mapping.json"]

        self.assertEqual(site["mode"], "direct-camera")
        self.assertEqual(runtime["provider"], "external-api")
        self.assertEqual(runtime["cameraConnection"], "headless-cpp")
        self.assertEqual(runtime["captureProfile"], "capture.json")
        self.assertEqual(runtime["cameraCount"], 1)
        self.assertEqual(capture["expectedCameras"], 1)
        self.assertEqual(len(runtime["cameras"]), 1)
        self.assertEqual(len(capture["cameras"]), 1)
        self.assertEqual(len(mapping["cameras"]), 1)
        self.assertTrue(runtime["algorithm"]["enabled"])
        self.assertEqual(runtime["algorithm"]["processor"], "sick-flow-event-v2")
        self.assertFalse(runtime["capabilities"]["reconstruction"])


class SickEventTests(unittest.TestCase):
    def test_committed_event_validates_artifacts_and_reports_partial_camera_round(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result = DualFormatWriter().write(root / "C1", "10", sample_frame())
            row = result.provider_row(sample_frame(), 7)
            event_path = publish_committed_round(
                root,
                "10",
                "SESSION-10",
                [row],
                boundary_phase="normal",
                expected_camera_ids={"C1", "C2"},
            )
            event = json.loads(event_path.read_text(encoding="utf-8"))
            self.assertFalse(event["complete"])
            self.assertEqual(event["expectedCameraCount"], 2)
            self.assertEqual(event["committedCameraCount"], 1)
            self.assertEqual(event["missingCameraIds"], ["C2"])

            result.steel_depth.unlink()
            with self.assertRaises(FileNotFoundError):
                publish_committed_round(
                    root,
                    "10",
                    "SESSION-10",
                    [{**row, "round": 8}],
                    boundary_phase="normal",
                    expected_camera_ids={"C1"},
                )


class SickStorageTests(unittest.TestCase):
    def test_atomic_summary_retries_transient_windows_sharing_violation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "status.json"
            real_replace = os.replace
            attempts = 0

            def replace_after_two_failures(source: object, destination: object) -> None:
                nonlocal attempts
                attempts += 1
                if attempts < 3:
                    raise PermissionError(5, "simulated sharing violation")
                real_replace(source, destination)

            with patch(
                "scripts.sick_capture.storage.os.replace",
                side_effect=replace_after_two_failures,
            ):
                atomic_summary(target, {"state": "ready"})

            self.assertEqual(attempts, 3)
            self.assertEqual(
                json.loads(target.read_text(encoding="utf-8")),
                {"state": "ready"},
            )

    def test_dual_writer_preserves_exact_lg3d_contract_and_raw_depth(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            camera_root = Path(directory) / "C1"
            result = DualFormatWriter(
                artifact_context={
                    "captureProfile": {
                        "name": "sick-test",
                        "path": "capture.json",
                        "sha256": "a" * 64,
                    },
                    "calibration": {
                        "path": "calibration.xml",
                        "sha256": "b" * 64,
                        "present": True,
                        "metricProjectionVerified": True,
                    },
                }
            ).write(
                camera_root,
                "10",
                replace(sample_frame(), transport_frame_id=77),
                session_id="SESSION-001",
                production_event_id="FLOW-0000000001",
                inspection_id="INSP-SESSION-001",
                capture_round=9,
                sync_group_id="FLOW-0000000001:round-000000000009",
            )
            base = camera_capture_root(camera_root, "10", "C1")

            validation = validate_lg3d_dataset(base)
            self.assertEqual(validation.frame_count, 1)
            with np.load(result.lg3d_depth, allow_pickle=False) as package:
                self.assertEqual(package.files, ["array"])
                np.testing.assert_array_equal(package["array"], sample_frame().depth_raw)
            self.assertEqual(result.steel_depth, result.lg3d_depth)
            self.assertEqual(result.steel_intensity, result.lg3d_intensity)
            self.assertEqual(result.steel_metadata, result.lg3d_metadata)
            self.assertFalse((base / "depth").exists())
            self.assertFalse((base / "intensity").exists())
            self.assertFalse((base / "metadata").exists())
            metadata = json.loads(result.steel_metadata.read_text(encoding="utf-8"))
            self.assertTrue(metadata["complete"])
            self.assertEqual(metadata["depthDataFormat"], "Coord3D_C16")
            self.assertEqual(metadata["captureRound"], 9)
            self.assertEqual(metadata["syncGroupId"], "FLOW-0000000001:round-000000000009")
            artifact = metadata["frameArtifact"]
            self.assertEqual(artifact["schema"], "steel.frame-artifact.v1")
            self.assertFalse(artifact["synthetic"])
            self.assertEqual(artifact["sequence"]["transportFrameId"], 77)
            self.assertTrue(artifact["units"]["metricProjectionVerified"])
            self.assertEqual(artifact["captureProfile"]["sha256"], "a" * 64)
            self.assertEqual(artifact["calibration"]["sha256"], "b" * 64)
            camera_config = json.loads(result.camera_config.read_text(encoding="utf-8"))
            self.assertEqual(camera_config["DeviceScanType"], "Linescan3D")
            self.assertEqual(camera_config["_steel"]["serialNumber"], "SICK-SN-001")
            self.assertRegex(
                metadata["capTime"],
                r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}:\d{6}$",
            )
            replayed = next(
                iter(
                    LG3DReplaySource(
                        base,
                        camera_key="C1",
                        camera_id="C1",
                        serial_number="SICK-SN-001",
                    )
                )
            )
            np.testing.assert_array_equal(replayed.depth_raw, sample_frame().depth_raw)

            with self.assertRaises(FileExistsError):
                DualFormatWriter().write(camera_root, "10", sample_frame(), index=0)
            with self.assertRaisesRegex(ValueError, "serial mismatch"):
                DualFormatWriter().write(
                    camera_root,
                    "10",
                    replace(sample_frame(2), serial_number="WRONG-SERIAL"),
                    index=2,
                )

    def test_metadata_commit_marker_is_absent_on_interrupted_write_and_index_recovers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            camera_root = Path(directory) / "C1"

            def fail_after_data(stage: str) -> None:
                if stage == "data-files-committed":
                    raise OSError("simulated power loss")

            with self.assertRaisesRegex(OSError, "simulated power loss"):
                DualFormatWriter(fault_hook=fail_after_data).write(
                    camera_root, "11", sample_frame()
                )
            base = camera_capture_root(camera_root, "11", "C1")
            self.assertFalse((base / "json" / "0.json").exists())
            self.assertFalse((base / "metadata" / "000001.json").exists())
            with self.assertRaisesRegex(ValueError, "no complete LG_3D frames"):
                validate_lg3d_dataset(base)

            recovered = DualFormatWriter().write(camera_root, "11", sample_frame(1))
            self.assertEqual(recovered.lg_index, 1)
            self.assertTrue(recovered.steel_metadata.is_file())


class SickProviderTests(unittest.TestCase):
    def test_http_server_suppresses_only_cancelled_client_connection_errors(self) -> None:
        server = object.__new__(SickCaptureHTTPServer)
        with patch("http.server.ThreadingHTTPServer.handle_error") as parent:
            try:
                raise ConnectionResetError("client cancelled polling request")
            except ConnectionResetError:
                server.handle_error(None, ("127.0.0.1", 12345))
            parent.assert_not_called()

            try:
                raise RuntimeError("real server failure")
            except RuntimeError:
                server.handle_error(None, ("127.0.0.1", 12345))
            parent.assert_called_once()

    def test_missing_defect_manifest_reports_processing_for_existing_flow(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            camera = profile.enabled_cameras[0]
            try:
                write_flow_manifest(
                    profile.storage_root,
                    2598,
                    session_id="SESSION-2598",
                    state="closed",
                    camera_roots={
                        camera.camera_id: camera_capture_root(
                            camera.storage_root, "2598", camera.camera_id
                        )
                    },
                )
                status_root = (
                    profile.storage_root
                    / "system"
                    / "jobs"
                    / "defect-history-backfill"
                )
                status_root.mkdir(parents=True)
                (status_root / "status.json").write_text(
                    json.dumps(
                        {
                            "state": "running",
                            "processId": os.getpid(),
                            "phase": "rebuild",
                            "currentMaterialId": "2593",
                            "reprocessedMaterials": 10,
                            "materialCount": 100,
                        }
                    ),
                    encoding="utf-8",
                )
                (status_root / ".lock").write_text(
                    str(os.getpid()), encoding="ascii"
                )

                status, pending = runtime.defect_detection_json("2598")
                self.assertEqual(status, 202)
                self.assertEqual(pending["code"], 0)
                self.assertEqual(pending["state"], "queued")
                self.assertEqual(pending["phase"], "history-backfill")
                self.assertEqual(pending["retryAfterMs"], 2000)
                paused_payload = json.loads(
                    (status_root / "status.json").read_text(encoding="utf-8")
                )
                paused_payload.update(
                    {
                        "state": "paused",
                        "pauseReason": "steel-present",
                        "capturePhase": "steel-in-saving",
                        "captureQueue": {"pendingRounds": 12, "activeRounds": 1},
                    }
                )
                (status_root / "status.json").write_text(
                    json.dumps(paused_payload), encoding="utf-8"
                )
                paused_status, paused = runtime.defect_detection_json("2598")
                self.assertEqual(paused_status, 202)
                self.assertEqual(paused["phase"], "history-backfill")
                self.assertEqual(paused["historyBackfill"]["state"], "paused")
                self.assertEqual(
                    paused["historyBackfill"]["pauseReason"], "steel-present"
                )
                self.assertEqual(
                    paused["historyBackfill"]["captureQueue"]["pendingRounds"], 12
                )
                self.assertEqual(
                    runtime.defect_detection_json("FLOW-0000002598")[0], 400
                )
                self.assertEqual(runtime.defect_detection_json("9999")[0], 404)
            finally:
                runtime.close()

    def test_stale_history_backfill_status_is_not_reported_as_running(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            camera = profile.enabled_cameras[0]
            try:
                write_flow_manifest(
                    profile.storage_root,
                    2598,
                    session_id="SESSION-2598",
                    state="closed",
                    camera_roots={
                        camera.camera_id: camera_capture_root(
                            camera.storage_root, "2598", camera.camera_id
                        )
                    },
                )
                status_root = (
                    profile.storage_root
                    / "system"
                    / "jobs"
                    / "defect-history-backfill"
                )
                status_root.mkdir(parents=True)
                (status_root / "status.json").write_text(
                    json.dumps(
                        {
                            "state": "running",
                            "processId": 999_999_999,
                            "phase": "rebuild",
                            "currentMaterialId": "2598",
                        }
                    ),
                    encoding="utf-8",
                )
                (status_root / ".lock").write_text(
                    "999999999", encoding="ascii"
                )

                with patch(
                    "scripts.sick_capture.provider._process_is_running",
                    return_value=False,
                ):
                    status, pending = runtime.defect_detection_json("2598")
                self.assertEqual(status, 202)
                self.assertNotEqual(pending["phase"], "history-backfill")
                self.assertIsNone(pending["historyBackfill"])
            finally:
                runtime.close()

    def test_flow_analysis_status_marks_a_stale_heartbeat_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            try:
                status_path = (
                    profile.storage_root
                    / "system"
                    / "jobs"
                    / "flow-analysis"
                    / "status.json"
                )
                status_path.parent.mkdir(parents=True)
                status_path.write_text(
                    json.dumps(
                        {
                            "schema": "steel.flow-analysis-queue.v1",
                            "state": "running",
                            "updatedAtUnixMs": int(time.time() * 1000) - 60_000,
                        }
                    ),
                    encoding="utf-8",
                )

                status = runtime._flow_analysis_queue_status()
                self.assertIsNotNone(status)
                self.assertEqual(status["state"], "unavailable")
                self.assertFalse(status["heartbeatFresh"])
                self.assertGreaterEqual(status["heartbeatAgeMs"], 60_000)
            finally:
                runtime.close()

    def test_storage_queue_failure_exposes_last_round_reason(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            try:
                def fail_round(*_args: object, **_kwargs: object) -> list[dict[str, object]]:
                    raise RuntimeError("simulated event publication failure")

                runtime._persist_cached_round = fail_round  # type: ignore[method-assign]
                self.assertTrue(
                    runtime._enqueue_storage_round(
                        [{"frameReceived": True}],
                        material_id="2599",
                        session_id="SESSION-2599",
                        boundary_phase="normal",
                    )
                )
                deadline = time.monotonic() + 2.0
                while (
                    runtime.health_json()["storageQueue"]["failedRounds"] == 0
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.01)
                queue_status = runtime.health_json()["storageQueue"]
                self.assertEqual(queue_status["failedRounds"], 1)
                self.assertEqual(queue_status["lastFailedMaterialId"], "2599")
                self.assertEqual(queue_status["lastFailedPhase"], "normal")
                self.assertIn("simulated event publication failure", queue_status["lastError"])
            finally:
                runtime.close()

    def test_startup_recovers_interrupted_flow_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            camera = profile.enabled_cameras[0]
            write_flow_manifest(
                profile.storage_root,
                12,
                session_id="SESSION-12",
                state="capturing",
                camera_roots={
                    camera.camera_id: camera.storage_root
                    / "12"
                    / "capture"
                    / camera.camera_id
                },
                latest_round=41,
            )
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            try:
                manifest = json.loads(
                    (profile.storage_root / "12" / "flow.json").read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(manifest["state"], "closed")
                self.assertEqual(manifest["latestCommittedRound"], 41)
                recovery = next(
                    row
                    for row in runtime.events
                    if row.get("message") == "interrupted flow manifests recovered"
                )
                self.assertEqual(recovery["recoveredFlowCount"], 1)
            finally:
                runtime.close()

    def test_new_flow_closes_an_unfinished_active_flow(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            try:
                runtime.steel_event(
                    {
                        "cmd": "steelIn",
                        "value": 1,
                        "materialId": "21",
                        "flowNo": 21,
                        "sessionId": "SESSION-21",
                    }
                )
                runtime.steel_event(
                    {
                        "cmd": "steelIn",
                        "value": 1,
                        "materialId": "22",
                        "flowNo": 22,
                        "sessionId": "SESSION-22",
                    }
                )
                first = json.loads(
                    (profile.storage_root / "21" / "flow.json").read_text(
                        encoding="utf-8"
                    )
                )
                second = json.loads(
                    (profile.storage_root / "22" / "flow.json").read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(first["state"], "closed")
                self.assertEqual(second["state"], "capturing")
            finally:
                runtime.close()

    def test_healthy_round_clears_transient_startup_schema_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            try:
                runtime.last_error = (
                    "SICK component schema mismatch: formats=[] expectedDepth=[]"
                )
                runtime._record_continuous_round(
                    [
                        {
                            "cameraKey": "C1",
                            "code": 0,
                            "frameReceived": True,
                            "completeFrame": True,
                            "capturedAt": "2026-08-23T00:00:00.000Z",
                        }
                    ],
                    persist_frame=False,
                )
                self.assertEqual(runtime.last_error, "")
                self.assertEqual(runtime.continuous_stats["C1"]["frameCount"], 1)
            finally:
                runtime.close()

    def test_http_server_accept_queue_supports_six_camera_preview_bursts(self) -> None:
        self.assertGreaterEqual(SickCaptureHTTPServer.request_queue_size, 16)

    def test_full_storage_cache_backpressures_instead_of_dropping_a_round(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = ProviderRuntime(
                load_profile(write_profile(Path(directory))),
                backend=FakeBackend(),
            )
            first_started = threading.Event()
            release = threading.Event()

            def slow_persist(*_args, **_kwargs):
                first_started.set()
                self.assertTrue(release.wait(timeout=2))
                return []

            runtime._persist_cached_round = slow_persist  # type: ignore[method-assign]
            runtime.storage_queue_capacity_rounds = 1
            runtime.storage_queue_boundary_reserve_rounds = 0
            row = {
                "frameReceived": True,
                "cameraKey": "C1",
                "round": 1,
                "_rawFrame": sample_frame(),
            }
            try:
                self.assertTrue(
                    runtime._enqueue_storage_round(
                        [row], material_id="12", session_id="SESSION", boundary_phase="normal"
                    )
                )
                self.assertTrue(first_started.wait(timeout=1))
                result: dict[str, bool] = {}

                def enqueue_second() -> None:
                    result["accepted"] = runtime._enqueue_storage_round(
                        [{**row, "round": 2}],
                        material_id="12",
                        session_id="SESSION",
                        boundary_phase="normal",
                    )

                thread = threading.Thread(target=enqueue_second)
                thread.start()
                time.sleep(0.05)
                self.assertTrue(thread.is_alive())
                release.set()
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())
                self.assertTrue(result["accepted"])
                queue = runtime.health_json()["storageQueue"]
                self.assertEqual(queue["droppedRounds"], 0)
                self.assertGreaterEqual(queue["backpressureWaits"], 1)
                self.assertEqual(queue["highWaterRounds"], 1)
            finally:
                release.set()
                runtime.close()

    def test_synchronization_health_reports_complete_equal_camera_rounds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile_path = write_profile(Path(directory))
            payload = json.loads(profile_path.read_text(encoding="utf-8"))
            second = dict(payload["cameras"][0])
            second.update(
                {
                    "cameraIndex": 2,
                    "id": "C2",
                    "key": "C2",
                    "serialNumber": "SICK-SN-002",
                    "ip": "192.0.2.11",
                    "storageRoot": str(Path(directory) / "storage" / "C2"),
                }
            )
            payload["cameras"].append(second)
            payload["expectedCameras"] = 2
            profile_path.write_text(json.dumps(payload), encoding="utf-8")
            runtime = ProviderRuntime(load_profile(profile_path), backend=FakeBackend())
            try:
                for round_index in range(1, 4):
                    results = runtime._run_capture_round(
                        list(runtime.profile.enabled_cameras),
                        {
                            "_persistFrame": False,
                            "_retainRawFrame": True,
                            "timeoutMs": 1000,
                        },
                        round_index,
                        None,
                    )
                    runtime._record_continuous_round(results, False)
                    runtime._record_synchronization_round(results)
                synchronization = runtime.health_json()["acquisitionSynchronization"]
                self.assertEqual(synchronization["status"], "synchronized")
                self.assertEqual(synchronization["completeRounds"], 3)
                self.assertEqual(synchronization["frameCountSkew"], 0)
                self.assertEqual(synchronization["lastRound"]["receivedCameras"], 2)
                self.assertEqual(synchronization["lastRound"]["cameraSequenceSkew"], 0)
                self.assertEqual(
                    [row["continuousFrameDelta"] for row in runtime.cameras_json()["cameras"]],
                    [0, 0],
                )
                runtime._record_synchronization_round(
                    [
                        {
                            "cameraKey": "C1",
                            "round": 4,
                            "frameReceived": True,
                            "hostUtcNs": 2_000_000_000,
                            "cameraFrameSequence": 4,
                            "transportFrameId": 10_003,
                        },
                        {
                            "cameraKey": "C2",
                            "round": 4,
                            "frameReceived": True,
                            "hostUtcNs": 2_100_000_000,
                            "cameraFrameSequence": 4,
                            "transportFrameId": 10_003,
                        },
                    ]
                )
                degraded = runtime.health_json()["acquisitionSynchronization"]
                self.assertFalse(degraded["synchronized"])
                self.assertEqual(degraded["lastHostCaptureSkewMs"], 100.0)
                self.assertFalse(degraded["hostCaptureSkewWithinLimit"])
                self.assertIn(
                    "host-capture-skew-out-of-tolerance",
                    degraded["qualityReasons"],
                )
            finally:
                runtime.close()

    def test_synchronization_ignores_startup_and_uses_a_rolling_gap_window(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile_path = write_profile(Path(directory))
            payload = json.loads(profile_path.read_text(encoding="utf-8"))
            payload["captureDefaults"]["synchronizationWarmupRounds"] = 2
            profile_path.write_text(json.dumps(payload), encoding="utf-8")
            runtime = ProviderRuntime(load_profile(profile_path), backend=FakeBackend())

            def record(round_index: int, transport_frame_id: int) -> None:
                runtime._record_synchronization_round(
                    [
                        {
                            "cameraKey": "C1",
                            "round": round_index,
                            "frameReceived": True,
                            "hostUtcNs": 1_000_000_000 + round_index,
                            "cameraFrameSequence": round_index,
                            "transportFrameId": transport_frame_id,
                        }
                    ]
                )

            try:
                record(1, 10)
                record(2, 50)
                record(3, 51)
                warmed = runtime.health_json()["acquisitionSynchronization"]
                self.assertEqual(warmed["warmupRemaining"], 0)
                self.assertEqual(warmed["transportFrameGaps"], 0)
                self.assertTrue(warmed["synchronized"])

                record(4, 55)
                degraded = runtime.health_json()["acquisitionSynchronization"]
                self.assertEqual(degraded["transportFrameGaps"], 3)
                self.assertEqual(degraded["lifetimeTransportFrameGaps"], 3)
                self.assertFalse(degraded["synchronized"])
                camera_status = runtime.cameras_json()["cameras"][0]
                self.assertEqual(camera_status["deviceTemperature"], 43.25)
                self.assertEqual(camera_status["temperatureJ28"], 43.25)
                self.assertEqual(camera_status["transportFrameId"], 55)
                self.assertEqual(camera_status["transportFrameGapCount"], 3)
                self.assertEqual(camera_status["lifetimeTransportFrameGapCount"], 3)
                self.assertTrue(camera_status["hasRecentFrameDrops"])
                self.assertGreater(camera_status["transportFrameDropPercent"], 0)

                for round_index, frame_id in enumerate(range(56, 177), start=5):
                    record(round_index, frame_id)
                recovered = runtime.health_json()["acquisitionSynchronization"]
                self.assertEqual(recovered["windowRounds"], 120)
                self.assertEqual(recovered["transportFrameGaps"], 0)
                self.assertEqual(recovered["lifetimeTransportFrameGaps"], 3)
                self.assertTrue(recovered["synchronized"])
                recovered_camera_status = runtime.cameras_json()["cameras"][0]
                self.assertEqual(recovered_camera_status["transportFrameGapCount"], 0)
                self.assertEqual(recovered_camera_status["lifetimeTransportFrameGapCount"], 3)
                self.assertFalse(recovered_camera_status["hasRecentFrameDrops"])
            finally:
                runtime.close()

    def test_acquisition_restart_rebuilds_transport_frame_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend())
            try:
                runtime.acquisition_stop.set()
                if runtime.acquisition_thread is not None:
                    runtime.acquisition_thread.join(timeout=2)
                with runtime.state_lock:
                    runtime.last_transport_frame_ids["C1"] = 1_000
                    runtime.transport_frame_gap_counts["C1"] = 7
                    runtime.synchronization_window.append(
                        {
                            "round": 1,
                            "receivedCameras": 1,
                            "complete": True,
                            "missingCameras": [],
                            "hostCaptureSkewMs": 0.0,
                            "cameraSequenceSkew": 0,
                            "transportFrameIdsAvailable": 1,
                            "transportFrameGaps": {"C1": 2},
                        }
                    )
                    runtime.synchronization_warmup_remaining = 0
                runtime.capture_mode = "continuous"
                runtime._ensure_acquisition_worker()
                with runtime.state_lock:
                    self.assertEqual(runtime.transport_frame_gap_counts["C1"], 7)
                    self.assertEqual(runtime.synchronization_warmup_remaining, 0)
                    # The fast fake backend can consume the configured warmup
                    # immediately, but an intentional pause must never compare
                    # against the pre-pause transport frame id or window.
                    self.assertNotEqual(runtime.last_transport_frame_ids.get("C1"), 1_000)
                    self.assertFalse(any(
                        row.get("round") == 1
                        and row.get("transportFrameGaps", {}).get("C1") == 2
                        for row in runtime.synchronization_window
                    ))
            finally:
                runtime.close()

    def test_global_steel_round_keeps_dim_non_black_camera_in_sync(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile_path = write_profile(Path(directory))
            payload = json.loads(profile_path.read_text(encoding="utf-8"))
            second = dict(payload["cameras"][0])
            second.update(
                {
                    "cameraIndex": 2,
                    "id": "C2",
                    "key": "C2",
                    "serialNumber": "SICK-SN-002",
                    "ip": "192.0.2.11",
                    "storageRoot": str(Path(directory) / "storage" / "C2"),
                }
            )
            payload["cameras"].append(second)
            payload["expectedCameras"] = 2
            payload["captureDefaults"].update(
                {
                    "captureMode": "continuous",
                    "grayscaleSteelDetection": True,
                    "steelMinCameras": 1,
                    "steelBrightPixelThreshold": 8,
                    "steelBrightPixelRatio": 0.02,
                }
            )
            profile_path.write_text(json.dumps(payload), encoding="utf-8")

            def session(camera: CameraProfile) -> FakeSession:
                return SparseSteelSession(camera) if camera.key == "C1" else NearBlackNoSteelSession(camera)

            profile = load_profile(profile_path)
            runtime = ProviderRuntime(profile, backend=FakeBackend(session))
            runtime._commit_capture_results = lambda *_args: True  # type: ignore[method-assign]
            try:
                runtime.steel_event(
                    {
                        "cmd": "steelIn",
                        "value": 1,
                        "materialId": "41",
                        "sessionId": "SYNC-SESSION",
                    }
                )
                # Simulate a delayed database callback from the preceding
                # steel overwriting mutable flow state while pre-roll is being
                # drained. The material directory remains authoritative.
                runtime.active_flow_code = "FLOW-0000000041"
                deadline = time.monotonic() + 3
                camera_dirs = [
                    camera_capture_root(camera.storage_root, "41", camera.camera_id) / "json"
                    for camera in profile.enabled_cameras
                ]
                while time.monotonic() < deadline:
                    counts = [len(list(path.glob("*.json"))) for path in camera_dirs]
                    if min(counts, default=0) >= 2:
                        break
                    time.sleep(0.02)
                runtime.steel_event({"cmd": "steelIn", "value": 0})
                runtime.set_capture_mode({"captureMode": "on-demand"})
            finally:
                runtime.close()

            counts = [len(list(path.glob("*.json"))) for path in camera_dirs]
            self.assertGreaterEqual(min(counts), 2)
            self.assertEqual(counts[0], counts[1])
            first = [json.loads((path / "0.json").read_text(encoding="utf-8")) for path in camera_dirs]
            self.assertEqual(first[0]["syncGroupId"], first[1]["syncGroupId"])
            self.assertEqual(first[0]["captureRound"], first[1]["captureRound"])

    def test_profile_can_autostart_continuous_discard_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile_path = write_profile(Path(directory))
            payload = json.loads(profile_path.read_text(encoding="utf-8"))
            payload["captureDefaults"]["captureMode"] = "continuous"
            profile_path.write_text(json.dumps(payload), encoding="utf-8")
            runtime = ProviderRuntime(
                load_profile(profile_path),
                backend=FakeBackend(AlternatingSession),
            )
            try:
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline and not runtime._acquisition_running():
                    time.sleep(0.01)
                status = runtime.steel_status_json()
                self.assertEqual(status["captureMode"], "continuous")
                self.assertTrue(status["automaticCaptureEnabled"])
                self.assertFalse(status["saveEnabled"])
            finally:
                runtime.close()

    def test_production_capture_requires_steel_in_and_writes_provider_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            backend = FakeBackend()
            runtime = ProviderRuntime(profile, backend=backend)
            try:
                status, rejected = runtime.continuous_capture(
                    {
                        "productionLayout": True,
                        "requireSteelPresent": True,
                        "expectedCameras": 1,
                    }
                )
                self.assertEqual(status, 409)
                self.assertEqual(rejected["code"], CAPTURE_DISCARDED_NOT_ARMED)

                event = runtime.steel_event(
                    {
                        "cmd": "steelIn",
                        "value": 1,
                        "materialId": "43",
                        "sessionId": "SESSION-003",
                        "saveEnabled": True,
                    }
                )
                self.assertEqual(event["code"], 0)
                self.assertTrue(event["present"])
                self.assertEqual(
                    runtime.steel_event({"cmd": "not-a-steel-event"})["code"],
                    400,
                )
                self.assertEqual(runtime.steel_status_json()["captureMode"], "on-demand")
                self.assertTrue(runtime.continuous_settings_json()["supported"])
                status, summary = runtime.continuous_capture(
                    {
                        "productionLayout": True,
                        "requireSteelPresent": True,
                        "expectedCameras": 1,
                        "rounds": 2,
                        "discardBlackFrames": True,
                    }
                )
                self.assertEqual(status, 200)
                self.assertEqual(summary["code"], 0)
                self.assertEqual(summary["completeFrames"], 2)
                self.assertTrue(all(row["metadataExists"] for row in summary["results"]))
                for row in summary["results"]:
                    intensity_path = Path(row["intensityOutput"])
                    self.assertEqual(intensity_path.parent.name, "2d")
                    self.assertEqual(intensity_path.suffix.lower(), ".png")
                    self.assertEqual(row["lg3dIntensityOutput"], row["intensityOutput"])
                self.assertTrue(
                    (camera_capture_root(profile.enabled_cameras[0].storage_root, "43", "C1") / "2d").exists()
                )
                self.assertTrue(summary["summaryExists"])
                health = runtime.health_json()
                self.assertEqual(health["provider"], "external-api")
                self.assertTrue(health["connected"])
                self.assertEqual(health["ip"], "192.0.2.10")
                self.assertEqual(health["framesCommitted"], 2)
                self.assertEqual(runtime.storage_json()["code"], 0)
                history = runtime.capture_history_json({"limit": ["10"]})
                self.assertEqual(history["total"], 2)
                playback = history["frames"][-1]["cameras"][0]
                self.assertEqual((playback["width"], playback["height"]), (3, 2))
                playback_path = runtime.allowed_file(playback["artifactRef"])
                self.assertIsNotNone(playback_path)
                optimized = runtime.optimized_playback_image(playback_path, 160)
                self.assertEqual(optimized[0], "image/jpeg")
                self.assertGreater(len(optimized[1]), 0)
            finally:
                runtime.close()
            self.assertTrue(backend.closed)

    def test_sparse_bright_steel_is_saved_even_when_whole_frame_mean_is_below_black_threshold(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(SparseSteelSession))
            try:
                runtime.steel_event(
                    {
                        "cmd": "steelIn",
                        "value": 1,
                        "materialId": "44",
                        "sessionId": "SPARSE-SESSION",
                    }
                )
                status, summary = runtime.continuous_capture(
                    {
                        "productionLayout": True,
                        "requireSteelPresent": True,
                        "expectedCameras": 1,
                        "rounds": 1,
                        "discardBlackFrames": True,
                    }
                )
                self.assertEqual(status, 200)
                self.assertEqual(summary["completeFrames"], 1)
                row = summary["results"][0]
                self.assertLess(row["meanIntensity"], profile.black_frame_threshold)
                self.assertGreater(row["maxIntensity"], profile.black_frame_threshold)
                self.assertTrue(row["steelSignal"])
            finally:
                runtime.close()

    def test_near_black_exit_candidate_is_not_saved_as_steel_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(
                profile, backend=FakeBackend(NearBlackNoSteelSession)
            )
            try:
                runtime.grayscale_steel_detection = True
                runtime.steel_event(
                    {
                        "cmd": "steelIn",
                        "value": 1,
                        "materialId": "45",
                        "sessionId": "EXIT-SESSION",
                    }
                )
                status, summary = runtime.continuous_capture(
                    {
                        "productionLayout": True,
                        "requireSteelPresent": True,
                        "expectedCameras": 1,
                        "rounds": 1,
                        "discardBlackFrames": True,
                    }
                )
                self.assertEqual(status, 200)
                self.assertEqual(summary["code"], NO_STEEL_FRAME_DISCARDED)
                self.assertEqual(summary["completeFrames"], 0)
                self.assertEqual(summary["discardedFrames"], 1)
                row = summary["results"][0]
                self.assertGreater(row["maxIntensity"], profile.black_frame_threshold)
                self.assertFalse(row["steelSignal"])
                self.assertFalse(
                    (profile.enabled_cameras[0].storage_root / "EXIT-CANDIDATE").exists()
                )
            finally:
                runtime.close()

    def test_cached_pre_and_post_roll_frames_are_written_in_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend())
            database_commits: list[dict[str, object]] = []

            def commit(
                _material_id: str,
                _session_id: str,
                results: list[dict[str, object]],
            ) -> bool:
                database_commits.extend(results)
                return True

            try:
                runtime._commit_capture_results = commit  # type: ignore[method-assign]
                runtime.steel_event(
                    {
                        "cmd": "steelIn",
                        "value": 1,
                        "materialId": "42",
                        "sessionId": "BOUNDARY-SESSION",
                        "flowCode": "FLOW-0000000042",
                    }
                )
                entry_frame = sample_frame(1)
                post_frame = replace(
                    sample_frame(2),
                    intensity=np.array([[0, 0, 0], [0, 0, 30]], dtype=np.uint8),
                )

                def cached_row(frame: RawFrame, steel_signal: bool) -> dict[str, object]:
                    return {
                        "cameraKey": "C1",
                        "parallelIndex": 0,
                        "round": frame.sequence,
                        "capturedAt": "2026-08-21T00:00:00.000Z",
                        "meanIntensity": float(np.mean(frame.intensity)),
                        "maxIntensity": float(np.max(frame.intensity)),
                        "brightPixelRatio": float(np.count_nonzero(frame.intensity > 8))
                        / float(frame.intensity.size),
                        "steelSignal": steel_signal,
                        "_rawFrame": frame,
                    }

                pre = runtime._persist_cached_round(
                    [cached_row(entry_frame, True)],
                    material_id="42",
                    session_id="BOUNDARY-SESSION",
                    boundary_phase="pre-roll",
                )
                post = runtime._persist_cached_round(
                    [cached_row(post_frame, False)],
                    material_id="42",
                    session_id="BOUNDARY-SESSION",
                    boundary_phase="post-roll",
                )

                deadline = time.monotonic() + 2.0
                while len(database_commits) < 2 and time.monotonic() < deadline:
                    time.sleep(0.01)

                self.assertEqual([pre[0]["sequenceNo"], post[0]["sequenceNo"]], [1, 2])
                self.assertEqual(
                    [row["boundaryPhase"] for row in database_commits],
                    ["pre-roll", "post-roll"],
                )
                self.assertTrue(all(row["completeFrame"] for row in database_commits))
                pre_metadata = json.loads(Path(pre[0]["metadataOutput"]).read_text(encoding="utf-8"))
                self.assertEqual(pre_metadata["productionEventId"], "FLOW-0000000042")
                self.assertTrue(
                    pre_metadata["syncGroupId"].startswith("FLOW-0000000042:round-")
                )
                status = runtime.steel_status_json()
                self.assertEqual(status["steelPreRollFrames"], 1)
                self.assertEqual(status["steelPostRollFrames"], 1)
                self.assertEqual(status["blackFrameCacheRounds"], 8)
            finally:
                runtime.close()

    def test_database_commit_is_requeued_after_transient_service_outage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend())
            attempts = 0

            def commit(
                _material_id: str,
                _session_id: str,
                _results: list[dict[str, object]],
            ) -> bool:
                nonlocal attempts
                attempts += 1
                return attempts >= 2

            try:
                runtime._commit_capture_results = commit  # type: ignore[method-assign]
                self.assertTrue(
                    runtime._enqueue_database_commit(
                        "46",
                        "SESSION-RETRY",
                        [{"code": 0, "completeFrame": True}],
                    )
                )
                deadline = time.monotonic() + 3.0
                while (
                    runtime.database_commit_succeeded_rounds < 1
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.02)
                self.assertGreaterEqual(attempts, 2)
                self.assertEqual(runtime.database_commit_succeeded_rounds, 1)
                self.assertEqual(runtime.database_commit_failed_rounds, 0)
                self.assertEqual(runtime.database_commit_failures, 0)
                self.assertGreaterEqual(runtime.database_commit_retries, 1)
            finally:
                runtime.close()

    def test_delayed_database_commit_cannot_overwrite_new_active_flow(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend())
            runtime.active_material_id = "42"
            runtime.active_session_id = "SESSION-42"
            runtime.active_flow_no = 42
            runtime.active_flow_code = "FLOW-0000000042"
            runtime._post_service_json = lambda *_args: {  # type: ignore[method-assign]
                "code": 0,
                "flowNo": 41,
                "flowCode": "FLOW-0000000041",
            }
            try:
                self.assertTrue(
                    runtime._commit_capture_results(
                        "FLOW-0000000041",
                        "SESSION-41",
                        [{"code": 0, "completeFrame": True}],
                    )
                )
                self.assertEqual(runtime.active_flow_no, 42)
                self.assertEqual(runtime.active_flow_code, "FLOW-0000000042")
            finally:
                runtime.close()

    def test_multi_camera_process_writers_use_shared_memory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile_path = write_profile(Path(directory))
            payload = json.loads(profile_path.read_text(encoding="utf-8"))
            cameras = []
            for index in range(1, 5):
                camera = dict(payload["cameras"][0])
                camera.update(
                    {
                        "cameraIndex": index,
                        "id": f"C{index}",
                        "key": f"C{index}",
                        "serialNumber": f"SICK-SN-{index:03d}",
                        "ip": f"192.0.2.{index}",
                        "storageRoot": str(
                            Path(directory) / "storage" / f"C{index}"
                        ),
                    }
                )
                cameras.append(camera)
            payload["cameras"] = cameras
            payload["expectedCameras"] = 4
            payload["captureDefaults"]["storageProcessWorkers"] = 2
            payload["captureDefaults"]["storageRoundWorkers"] = 2
            profile_path.write_text(json.dumps(payload), encoding="utf-8")
            profile = load_profile(profile_path)
            runtime = ProviderRuntime(profile, backend=FakeBackend())
            runtime._commit_capture_results = lambda *_args: True  # type: ignore[method-assign]
            rows = []
            for index, camera in enumerate(profile.enabled_cameras, start=1):
                frame = replace(
                    sample_frame(index),
                    camera_key=camera.key,
                    camera_id=camera.camera_id,
                    serial_number=camera.serial_number,
                    model=camera.model,
                    firmware=camera.firmware,
                    ip=camera.ip,
                )
                rows.append(
                    {
                        "cameraKey": camera.key,
                        "round": 1,
                        "frameReceived": True,
                        "maxIntensity": 60.0,
                        "meanIntensity": 35.0,
                        "brightPixelRatio": 1.0,
                        "steelSignal": True,
                        "_rawFrame": frame,
                    }
                )
            try:
                committed = runtime._persist_cached_round(
                    rows,
                    material_id="47",
                    session_id="PROCESS-SESSION",
                    boundary_phase="normal",
                )
                self.assertEqual(len(committed), 4)
                queue = runtime.health_json()["storageQueue"]
                self.assertEqual(queue["writerMode"], "process-shared-memory")
                self.assertEqual(queue["writerProcessCount"], 2)
                self.assertEqual(queue["writerThreadCount"], 0)
                self.assertEqual(queue["roundWorkerCount"], 2)
                self.assertEqual(
                    queue["writerTopology"],
                    "ordered-pipelined-rounds+one-process-per-camera-task",
                )
                for camera in profile.enabled_cameras:
                    root = camera_capture_root(camera.storage_root, "47", camera.camera_id)
                    self.assertTrue((root / "3d" / "0.npz").is_file())
                    self.assertTrue((root / "2d" / "0.png").is_file())
                    self.assertTrue((root / "json" / "0.json").is_file())

                second_rows = [
                    {
                        **row,
                        "round": 2,
                        "_rawFrame": replace(row["_rawFrame"], sequence=20),
                    }
                    for row in rows
                ]
                third_rows = [
                    {
                        **row,
                        "round": 3,
                        "_rawFrame": replace(row["_rawFrame"], sequence=30),
                    }
                    for row in rows
                ]
                self.assertTrue(
                    runtime._enqueue_storage_round(
                        second_rows,
                        material_id="47",
                        session_id="PROCESS-SESSION",
                        boundary_phase="normal",
                    )
                )
                self.assertTrue(
                    runtime._enqueue_storage_round(
                        third_rows,
                        material_id="47",
                        session_id="PROCESS-SESSION",
                        boundary_phase="normal",
                    )
                )
                deadline = time.monotonic() + 5.0
                while time.monotonic() < deadline:
                    queue = runtime.health_json()["storageQueue"]
                    if queue["pendingRounds"] == 0:
                        break
                    time.sleep(0.01)
                self.assertEqual(queue["pendingRounds"], 0)
                self.assertEqual(queue["completedRounds"], 2)
                self.assertEqual(queue["failedRounds"], 0)
                self.assertEqual(queue["sharedMemorySlots"], 8)
                for camera in profile.enabled_cameras:
                    root = camera_capture_root(
                        camera.storage_root,
                        "47",
                        camera.camera_id,
                    )
                    self.assertTrue((root / "2d" / "1.png").is_file())
                    self.assertTrue((root / "2d" / "2.png").is_file())
                manifest = json.loads(
                    (profile.storage_root / "47" / "flow.json").read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(manifest["latestCommittedRound"], 3)
            finally:
                runtime.close()

    def test_pipelined_round_failure_releases_ordered_finalize_gate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile_path = write_profile(Path(directory))
            payload = json.loads(profile_path.read_text(encoding="utf-8"))
            payload["captureDefaults"]["storageProcessWorkers"] = 1
            payload["captureDefaults"]["storageRoundWorkers"] = 2
            profile_path.write_text(json.dumps(payload), encoding="utf-8")
            profile = load_profile(profile_path)
            runtime = ProviderRuntime(profile, backend=FakeBackend())
            runtime._commit_capture_results = lambda *_args: True  # type: ignore[method-assign]
            original_share = runtime._share_storage_frame
            share_calls = 0

            def fail_first_share(camera_key, frame, slot=0):
                nonlocal share_calls
                share_calls += 1
                if share_calls == 1:
                    raise RuntimeError("simulated shared-memory copy failure")
                return original_share(camera_key, frame, slot)

            runtime._share_storage_frame = fail_first_share  # type: ignore[method-assign]
            row = {
                "cameraKey": "C1",
                "frameReceived": True,
                "round": 1,
                "maxIntensity": 60.0,
                "meanIntensity": 35.0,
                "brightPixelRatio": 1.0,
                "steelSignal": True,
                "_rawFrame": sample_frame(1),
            }
            try:
                self.assertTrue(
                    runtime._enqueue_storage_round(
                        [row],
                        material_id="48",
                        session_id="PROCESS-FAILURE",
                        boundary_phase="normal",
                    )
                )
                self.assertTrue(
                    runtime._enqueue_storage_round(
                        [
                            {
                                **row,
                                "round": 2,
                                "_rawFrame": sample_frame(2),
                            }
                        ],
                        material_id="48",
                        session_id="PROCESS-FAILURE",
                        boundary_phase="normal",
                    )
                )
                deadline = time.monotonic() + 5.0
                while time.monotonic() < deadline:
                    queue = runtime.health_json()["storageQueue"]
                    if queue["pendingRounds"] == 0:
                        break
                    time.sleep(0.01)
                self.assertEqual(queue["pendingRounds"], 0)
                self.assertEqual(queue["failedRounds"], 1)
                self.assertEqual(queue["completedRounds"], 1)
                root = camera_capture_root(
                    profile.enabled_cameras[0].storage_root,
                    "48",
                    "C1",
                )
                self.assertTrue((root / "2d" / "1.png").is_file())
                manifest = json.loads(
                    (profile.storage_root / "48" / "flow.json").read_text(
                        encoding="utf-8"
                    )
                )
                self.assertEqual(manifest["latestCommittedRound"], 2)
            finally:
                runtime.close()

    def test_grayscale_presence_requires_debounced_entry_and_exit_rounds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend())
            transitions: list[str] = []

            def apply(event: str) -> bool:
                transitions.append(event)
                runtime.steel_present = event == "steel-in"
                return True

            try:
                runtime.grayscale_steel_detection = True
                runtime.steel_entry_rounds = 2
                runtime.steel_exit_rounds = 3
                runtime.steel_min_cameras = 1
                runtime._apply_grayscale_transition = apply  # type: ignore[method-assign]
                steel = [{"frameReceived": True, "steelSignal": True}]
                black = [{"frameReceived": True, "steelSignal": False}]
                runtime._evaluate_grayscale_steel(steel)
                self.assertEqual(transitions, [])
                runtime._evaluate_grayscale_steel(steel)
                self.assertEqual(transitions, ["steel-in"])
                runtime._evaluate_grayscale_steel(black)
                runtime._evaluate_grayscale_steel(black)
                self.assertEqual(transitions, ["steel-in"])
                runtime._evaluate_grayscale_steel(black)
                self.assertEqual(transitions, ["steel-in", "steel-out"])
            finally:
                runtime.close()

    def test_continuous_mode_discards_black_frames_and_shares_live_preview(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            backend = FakeBackend(AlternatingSession)
            runtime = ProviderRuntime(profile, backend=backend)
            try:
                stream = runtime.start_stream({"ip": "192.0.2.10", "fpsLimit": 30})
                self.assertEqual(stream["code"], 0)
                event = runtime.steel_event(
                    {
                        "cmd": "steelIn",
                        "value": 1,
                        "materialId": "48",
                        "sessionId": "SESSION-CONTINUOUS",
                        "captureMode": "continuous",
                        "discardBlackFrames": True,
                    }
                )
                self.assertTrue(event["automaticCaptureEnabled"])
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    if (
                        runtime.frames_committed > 0
                        and runtime.black_frame_count > 0
                        and runtime.stream_latest_bytes("192.0.2.10", "intensity") is not None
                    ):
                        break
                    time.sleep(0.02)
                self.assertGreater(runtime.frames_committed, 0)
                self.assertGreater(runtime.black_frame_count, 0)
                self.assertIsNotNone(runtime.stream_latest_bytes("192.0.2.10", "intensity"))
                self.assertIsNotNone(runtime.stream_latest_bytes("192.0.2.10", "intensity-grid"))
                self.assertTrue(runtime.stream_status("192.0.2.10")["sharedWithContinuousCapture"])

                runtime.steel_event({"cmd": "steelIn", "value": 0})
                deadline = time.monotonic() + 3
                manifest: dict[str, object] = {}
                while time.monotonic() < deadline:
                    queue = runtime.health_json()["storageQueue"]
                    try:
                        manifest = json.loads(
                            (profile.storage_root / "48" / "flow.json").read_text(
                                encoding="utf-8"
                            )
                        )
                    except (OSError, json.JSONDecodeError):
                        manifest = {}
                    if (
                        queue["pendingRounds"] == 0
                        and queue["activeRounds"] == 0
                        and manifest.get("state") == "closed"
                    ):
                        break
                    time.sleep(0.02)
                # Persistence is deliberately asynchronous. Rounds already in
                # the bounded writer queue may commit after steel-out, so an
                # arbitrary ``+1`` allowance is not a valid stop contract.
                # Once that queue has drained, however, capture must remain
                # disarmed and no further production frame may be committed.
                committed_after_drain = runtime.frames_committed
                time.sleep(0.08)
                self.assertEqual(runtime.frames_committed, committed_after_drain)
                self.assertGreater(runtime.continuous_discarded_frame_count, 0)
                self.assertEqual(manifest["state"], "closed")
                queue = runtime.health_json()["storageQueue"]
                self.assertEqual(
                    queue["implementation"],
                    "bounded-round-cache+lossless-backpressure+ordered-pipelined-round-writer+per-camera-disks",
                )
                self.assertGreaterEqual(queue["capacityRounds"], 1)
                self.assertLessEqual(queue["capacityRounds"], 128)
                self.assertLessEqual(
                    queue["reservedBoundaryRounds"], queue["capacityRounds"]
                )
                runtime.stop_stream({"ip": "192.0.2.10"})
                stopped = runtime.set_capture_mode({"captureMode": "on-demand"})
                self.assertFalse(stopped["automaticCaptureEnabled"])
            finally:
                runtime.close()

    def test_continuous_preview_subscriptions_are_independent_per_camera(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile_path = write_profile(Path(directory))
            payload = json.loads(profile_path.read_text(encoding="utf-8"))
            second = dict(payload["cameras"][0])
            second.update(
                {
                    "cameraIndex": 2,
                    "id": "C2",
                    "key": "C2",
                    "serialNumber": "SICK-SN-002",
                    "ip": "192.0.2.11",
                    "storageRoot": str(Path(directory) / "storage" / "C2"),
                }
            )
            payload["cameras"].append(second)
            payload["expectedCameras"] = 2
            profile_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            runtime = ProviderRuntime(load_profile(profile_path), backend=FakeBackend(FakeSession))
            try:
                runtime.set_capture_mode({"captureMode": "continuous"})
                self.assertEqual(
                    runtime.start_stream({"ip": "192.0.2.10", "fpsLimit": 30})["code"],
                    0,
                )
                self.assertEqual(
                    runtime.start_stream({"ip": "192.0.2.11", "fpsLimit": 30})["code"],
                    0,
                )
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    if all(
                        runtime.stream_latest_bytes(ip, "intensity-grid") is not None
                        for ip in ("192.0.2.10", "192.0.2.11")
                    ):
                        break
                    time.sleep(0.02)
                self.assertIsNotNone(runtime.stream_latest_bytes("192.0.2.10", "intensity-grid"))
                self.assertIsNotNone(runtime.stream_latest_bytes("192.0.2.11", "intensity-grid"))
                self.assertIsNone(runtime.stream_latest_bytes("192.0.2.11", "intensity"))
                self.assertTrue(runtime.stream_status("192.0.2.11")["running"])
                self.assertGreater(runtime.stream_status("192.0.2.11")["frameCount"], 0)
                self.assertIsNone(runtime.stream_latest_bytes("192.0.2.11", "depth"))
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    if runtime.stream_latest_bytes("192.0.2.11", "depth") is not None:
                        break
                    time.sleep(0.02)
                self.assertIsNotNone(runtime.stream_latest_bytes("192.0.2.11", "depth"))

                first_stop = runtime.stop_stream({"ip": "192.0.2.10"})
                self.assertEqual(first_stop["remainingSubscriptions"], 1)
                self.assertFalse(runtime.stream_status("192.0.2.10")["running"])
                self.assertTrue(runtime.stream_status("192.0.2.11")["running"])
                self.assertIsNotNone(
                    runtime.stream_latest_bytes("192.0.2.11", "intensity-grid")
                )
                self.assertIsNone(
                    runtime.stream_latest_bytes("192.0.2.10", "intensity-grid")
                )

                final_stop = runtime.stop_stream({"ip": "192.0.2.11"})
                self.assertEqual(final_stop["remainingSubscriptions"], 0)
                self.assertEqual(runtime.stream_subscriptions, {})
                self.assertEqual(runtime.stream_latest, {})
            finally:
                runtime.close()

    def test_recent_camera_files_prefers_latest_numeric_flow(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            camera = profile.enabled_cameras[0]
            try:
                for flow_id in (2, 10):
                    image_dir = (
                        camera.storage_root
                        / str(flow_id)
                        / "capture"
                        / camera.camera_id
                        / "2d"
                    )
                    image_dir.mkdir(parents=True)
                    Image.fromarray(np.full((8, 8), 200, dtype=np.uint8)).save(
                        image_dir / "0.png"
                    )
                recent = runtime._recent_camera_files(
                    camera,
                    directories=("2d",),
                    suffixes=(".png",),
                    limit=1,
                )
                self.assertEqual(recent[0].parents[3].name, "10")
            finally:
                runtime.close()

    def test_latest_file_maps_public_kinds_to_v2_capture_directories(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            camera = profile.enabled_cameras[0]
            capture_root = (
                camera.storage_root / "31" / "capture" / camera.camera_id
            )
            try:
                for name in ("3d", "2d", "json"):
                    (capture_root / name).mkdir(parents=True)
                np.savez_compressed(
                    capture_root / "3d" / "7.npz",
                    depth=np.ones((2, 2), dtype=np.uint16),
                )
                Image.fromarray(np.full((2, 2), 128, dtype=np.uint8)).save(
                    capture_root / "2d" / "7.png"
                )
                (capture_root / "json" / "7.json").write_text(
                    json.dumps({"frameId": 7}), encoding="utf-8"
                )

                identity = {"cameraId": [camera.camera_id]}
                self.assertEqual(
                    runtime.latest_file({**identity, "kind": ["depth"]}),
                    capture_root / "3d" / "7.npz",
                )
                self.assertEqual(
                    runtime.latest_file({**identity, "kind": ["intensity"]}),
                    capture_root / "2d" / "7.png",
                )
                self.assertEqual(
                    runtime.latest_file({**identity, "kind": ["metadata"]}),
                    capture_root / "json" / "7.json",
                )
            finally:
                runtime.close()

    def test_idle_stream_seed_includes_historical_valid_depth_preview(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            camera = profile.enabled_cameras[0]
            capture_root = (
                camera.storage_root / "32" / "capture" / camera.camera_id
            )
            try:
                (capture_root / "2d").mkdir(parents=True)
                (capture_root / "3d").mkdir(parents=True)
                intensity = np.zeros((32, 128), dtype=np.uint8)
                intensity[:, 40:88] = 180
                depth = np.zeros((32, 128), dtype=np.uint16)
                depth[:, 40:88] = np.arange(48, dtype=np.uint16) + 1_000
                Image.fromarray(intensity).save(capture_root / "2d" / "3.png")
                np.savez(capture_root / "3d" / "3.npz", array=depth)
                with runtime.stream_lock:
                    runtime.stream_subscriptions[camera.key] = {"fpsLimit": 5}
                    runtime.stream_camera_key = camera.key

                runtime._seed_stream_cache_from_storage(camera.key)

                self.assertIsNotNone(
                    runtime.stream_latest_bytes(
                        camera.ip, "intensity-grid", "valid"
                    )
                )
                self.assertIsNotNone(
                    runtime.stream_latest_bytes(camera.ip, "depth", "valid")
                )
                self.assertIsNotNone(
                    runtime.stream_latest_bytes(
                        camera.ip,
                        "depth",
                        wait_seconds=1.0,
                    )
                )
                self.assertIn(
                    "depth-raw",
                    runtime.stream_status(camera.ip)["readyVariants"],
                )
            finally:
                runtime.close()

    def test_http_kind_switch_waits_for_a_real_png_and_reports_ready_kinds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            server = SickCaptureHTTPServer(("127.0.0.1", 0), runtime)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            origin = f"http://127.0.0.1:{server.server_port}"
            camera = profile.enabled_cameras[0]
            try:
                started = runtime.start_stream(
                    {"ip": camera.ip, "dataMode": 3, "fpsLimit": 2}
                )
                self.assertEqual(started["code"], 0)
                self.assertIn("readyKinds", started)

                # Depth was not made a continuous six-camera cost by start;
                # its first image request registers the kind and waits in the
                # HTTP worker for the next genuine camera frame.
                with request.urlopen(
                    f"{origin}/api/stream/latest?ip={camera.ip}&kind=depth",
                    timeout=3,
                ) as response:
                    body = response.read()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers["Content-Type"], "image/png")
                    self.assertEqual(
                        response.headers["Cross-Origin-Resource-Policy"],
                        "cross-origin",
                    )
                self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))
                status = runtime.stream_status(camera.ip)
                self.assertTrue(status["ready"])
                self.assertFalse(status["warmingUp"])
                self.assertIn("depth", status["readyKinds"])
                self.assertIn("depth-raw", status["readyVariants"])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_live_preview_keeps_the_last_valid_frame_when_black_frames_arrive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            camera = profile.enabled_cameras[0]
            try:
                with runtime.stream_lock:
                    runtime.stream_subscriptions[camera.key] = {"fpsLimit": 30}
                    runtime.stream_camera_key = camera.key
                    runtime.stream_options = {"fpsLimit": 30}
                runtime.steel_bright_ratio = 0.5
                valid = sample_frame(1)
                runtime._publish_stream_frame(camera, valid)
                expected = runtime.stream_latest_bytes(camera.ip, "intensity-grid")
                self.assertIsNotNone(expected)
                self.assertEqual(runtime.stream_frame_counts[camera.key], 1)

                black = replace(valid, sequence=2, intensity=np.zeros_like(valid.intensity))
                runtime._publish_stream_frame(camera, black)

                near_black = replace(
                    valid,
                    sequence=3,
                    intensity=np.full_like(valid.intensity, 8),
                )
                runtime._publish_stream_frame(camera, near_black)

                sparse_noise = np.zeros_like(valid.intensity)
                sparse_noise[0, 0] = 255
                runtime._publish_stream_frame(
                    camera,
                    replace(valid, sequence=4, intensity=sparse_noise),
                )

                sparse_after_resize = np.zeros((32, 32), dtype=np.uint8)
                sparse_after_resize[0, 0] = 9
                self.assertIsNone(
                    runtime._preview_png(
                        sparse_after_resize,
                        depth=False,
                        max_width=16,
                        minimum_visible_max=8,
                    )
                )

                self.assertEqual(
                    runtime.stream_latest_bytes(camera.ip, "intensity-grid"),
                    expected,
                )
                self.assertEqual(runtime.stream_frame_counts[camera.key], 1)
            finally:
                runtime.close()

    def test_steel_out_during_fetch_discards_frame_before_storage_commit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            fetch_started = threading.Event()
            release_fetch = threading.Event()
            backend = FakeBackend(
                lambda camera: BlockingSession(camera, fetch_started, release_fetch)
            )
            runtime = ProviderRuntime(profile, backend=backend)
            capture_result: dict[str, tuple[int, dict[str, object]]] = {}

            def capture() -> None:
                capture_result["value"] = runtime.continuous_capture(
                    {
                        "productionLayout": True,
                        "requireSteelPresent": True,
                        "expectedCameras": 1,
                        "rounds": 1,
                    }
                )

            try:
                runtime.steel_event(
                    {
                        "cmd": "steelIn",
                        "value": 1,
                        "materialId": "49",
                        "sessionId": "SESSION-BOUNDARY",
                    }
                )
                thread = threading.Thread(target=capture)
                thread.start()
                self.assertTrue(fetch_started.wait(timeout=2))
                runtime.steel_event({"cmd": "steelIn", "value": 0})
                release_fetch.set()
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())
                status, summary = capture_result["value"]
                self.assertEqual(status, 200)
                self.assertEqual(summary["code"], CAPTURE_DISCARDED_NOT_ARMED)
                self.assertEqual(summary["completeFrames"], 0)
                self.assertEqual(runtime.frames_failed, 0)
                self.assertFalse(
                    camera_capture_root(profile.enabled_cameras[0].storage_root, "49", "C1").exists()
                )
            finally:
                release_fetch.set()
                runtime.close()

    def test_loopback_http_contract_exposes_health_storage_and_steel_status(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            backend = FakeBackend()
            runtime = ProviderRuntime(profile, backend=backend)
            server = SickCaptureHTTPServer(("127.0.0.1", 0), runtime)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            origin = f"http://127.0.0.1:{server.server_port}"
            try:
                for path in ("/health", "/api/storage/status", "/api/steel/status"):
                    with request.urlopen(f"{origin}{path}", timeout=2) as response:
                        payload = json.loads(response.read())
                    self.assertEqual(response.status, 200)
                    self.assertEqual(payload["code"], 0)
                image_path = (
                    camera_capture_root(
                        profile.enabled_cameras[0].storage_root, "51", "C1"
                    )
                    / "2d"
                    / "0.png"
                )
                image_path.parent.mkdir(parents=True)
                Image.fromarray(
                    np.full((64, 64), 40, dtype=np.uint8), mode="L"
                ).save(image_path)
                with request.urlopen(
                    f"{origin}/api/capture/file?path={quote('51/capture/C1/2d/0.png')}",
                    timeout=2,
                ) as image_response:
                    image_body = image_response.read()
                    self.assertEqual(image_response.headers["Content-Type"], "image/png")
                    self.assertEqual(
                        image_response.headers["Access-Control-Allow-Origin"], "*"
                    )
                    self.assertEqual(
                        image_response.headers["Cross-Origin-Resource-Policy"],
                        "cross-origin",
                    )
                    self.assertEqual(
                        image_response.headers["X-Content-Type-Options"], "nosniff"
                    )
                    self.assertTrue(image_body.startswith(b"\x89PNG\r\n\x1a\n"))
                with request.urlopen(
                    request.Request(
                        f"{origin}/api/steel/event",
                        method="POST",
                        data=json.dumps(
                            {
                                "cmd": "steelIn",
                                "value": 1,
                                "materialId": "50",
                                "sessionId": "HTTP-SESSION",
                            }
                        ).encode("utf-8"),
                        headers={"Content-Type": "application/json"},
                    ),
                    timeout=2,
                ) as response:
                    event = json.loads(response.read())
                self.assertTrue(event["present"])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
            self.assertTrue(backend.closed)


if __name__ == "__main__":
    unittest.main()
