"""Contract tests for the SICK GenTL sidecar without physical hardware."""

from __future__ import annotations

from dataclasses import replace
import hashlib
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Callable
from urllib import request

import numpy as np
from PIL import Image

from scripts.sick_capture.gentl import _text, component_array, node_snapshot, select_components
from scripts.sick_capture.models import RawFrame
from scripts.sick_capture.profile import CameraProfile, load_profile
from scripts.sick_capture.provider import (
    CAPTURE_DISCARDED_NOT_ARMED,
    NO_STEEL_FRAME_DISCARDED,
    ProviderRuntime,
    SickCaptureHTTPServer,
)
from scripts.sick_capture.replay import LG3DReplaySource, validate_lg3d_dataset
from scripts.sick_capture.storage import DualFormatWriter


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
        "captureDefaults": {"timeoutMs": 1000, "blackFrameThreshold": 1.0},
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

    def start(self) -> None:
        self.started = True

    def close(self) -> None:
        self.started = False

    def fetch_frame(self, _timeout_ms: int) -> RawFrame:
        frame = sample_frame(self.sequence)
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


class SickProfileTests(unittest.TestCase):
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
        self.assertFalse(runtime["algorithm"]["enabled"])
        self.assertFalse(runtime["capabilities"]["reconstruction"])


class SickStorageTests(unittest.TestCase):
    def test_dual_writer_preserves_exact_lg3d_contract_and_raw_depth(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            camera_root = Path(directory) / "C1"
            result = DualFormatWriter().write(camera_root, "COIL-001", sample_frame())
            base = camera_root / "COIL-001"

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
                DualFormatWriter().write(camera_root, "COIL-001", sample_frame(), index=0)
            with self.assertRaisesRegex(ValueError, "serial mismatch"):
                DualFormatWriter().write(
                    camera_root,
                    "COIL-001",
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
                    camera_root, "COIL-002", sample_frame()
                )
            base = camera_root / "COIL-002"
            self.assertFalse((base / "json" / "0.json").exists())
            self.assertFalse((base / "metadata" / "000001.json").exists())
            with self.assertRaisesRegex(ValueError, "no complete LG_3D frames"):
                validate_lg3d_dataset(base)

            recovered = DualFormatWriter().write(camera_root, "COIL-002", sample_frame(1))
            self.assertEqual(recovered.lg_index, 1)
            self.assertTrue(recovered.steel_metadata.is_file())


class SickProviderTests(unittest.TestCase):
    def test_http_server_accept_queue_supports_six_camera_preview_bursts(self) -> None:
        self.assertGreaterEqual(SickCaptureHTTPServer.request_queue_size, 16)

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
                        "materialId": "COIL-003",
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
                self.assertFalse(
                    (profile.enabled_cameras[0].storage_root / "COIL-003" / "intensity").exists()
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
                        "materialId": "SPARSE-STEEL",
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
                        "materialId": "EXIT-CANDIDATE",
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
            ) -> None:
                database_commits.extend(results)

            try:
                runtime._commit_capture_results = commit  # type: ignore[method-assign]
                runtime.steel_event(
                    {
                        "cmd": "steelIn",
                        "value": 1,
                        "materialId": "BOUNDARY-CACHE",
                        "sessionId": "BOUNDARY-SESSION",
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
                    material_id="BOUNDARY-CACHE",
                    session_id="BOUNDARY-SESSION",
                    boundary_phase="pre-roll",
                )
                post = runtime._persist_cached_round(
                    [cached_row(post_frame, False)],
                    material_id="BOUNDARY-CACHE",
                    session_id="BOUNDARY-SESSION",
                    boundary_phase="post-roll",
                )

                self.assertEqual([pre[0]["sequenceNo"], post[0]["sequenceNo"]], [1, 2])
                self.assertEqual(
                    [row["boundaryPhase"] for row in database_commits],
                    ["pre-roll", "post-roll"],
                )
                self.assertTrue(all(row["completeFrame"] for row in database_commits))
                status = runtime.steel_status_json()
                self.assertEqual(status["steelPreRollFrames"], 1)
                self.assertEqual(status["steelPostRollFrames"], 1)
                self.assertEqual(status["blackFrameCacheRounds"], 8)
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
                        "materialId": "COIL-CONTINUOUS",
                        "sessionId": "SESSION-CONTINUOUS",
                        "captureMode": "continuous",
                        "discardBlackFrames": True,
                    }
                )
                self.assertTrue(event["automaticCaptureEnabled"])
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    if runtime.frames_committed > 0 and runtime.black_frame_count > 0:
                        break
                    time.sleep(0.02)
                self.assertGreater(runtime.frames_committed, 0)
                self.assertGreater(runtime.black_frame_count, 0)
                self.assertIsNotNone(runtime.stream_latest_bytes("192.0.2.10", "intensity"))
                self.assertIsNotNone(runtime.stream_latest_bytes("192.0.2.10", "intensity-grid"))
                self.assertTrue(runtime.stream_status("192.0.2.10")["sharedWithContinuousCapture"])

                committed = runtime.frames_committed
                runtime.steel_event({"cmd": "steelIn", "value": 0})
                time.sleep(0.08)
                self.assertLessEqual(runtime.frames_committed, committed + 1)
                self.assertGreater(runtime.continuous_discarded_frame_count, 0)
                queue = runtime.health_json()["storageQueue"]
                self.assertEqual(
                    queue["implementation"],
                    "bounded-round-cache+ordered-round-writer+per-camera-disks",
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

    def test_continuous_preview_cache_exposes_every_camera_intensity_frame(self) -> None:
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
            finally:
                runtime.close()

    def test_live_preview_keeps_the_last_valid_frame_when_black_frames_arrive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            profile = load_profile(write_profile(Path(directory)))
            runtime = ProviderRuntime(profile, backend=FakeBackend(FakeSession))
            camera = profile.enabled_cameras[0]
            try:
                with runtime.stream_lock:
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
                        "materialId": "COIL-BOUNDARY",
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
                self.assertFalse(
                    (profile.enabled_cameras[0].storage_root / "COIL-BOUNDARY").exists()
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
                with request.urlopen(
                    request.Request(
                        f"{origin}/api/steel/event",
                        method="POST",
                        data=json.dumps(
                            {
                                "cmd": "steelIn",
                                "value": 1,
                                "materialId": "HTTP-COIL",
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
