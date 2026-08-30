from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

import sick_flow_analysis_service as service
from sick_capture.events import publish_flow_handoff
from sick_capture.defect_detection import DefectDetectionConfig
from sick_capture.alignment import AlignmentConfig
from sick_capture.material_lock import (
    MaterialJobLockedError,
    exclusive_material_job,
    material_job_lock_path,
)
from sick_capture.measurement import MeasurementConfig
from sick_capture.paths import (
    algorithm_state_path,
    alignment_path,
    capture_flow_handoff_path,
    frame_event_root,
    flow_manifest_path,
    measurement_path,
    playback_index_path,
    region_path,
)
from sick_capture.provider import _derived_artifact_read_gate


class SickFlowAnalysisServiceTests(unittest.TestCase):
    def test_material_job_lock_excludes_live_owner_and_cleans_up(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock_path = material_job_lock_path(root, "63")
            with exclusive_material_job(root, "63", purpose="test"):
                self.assertTrue(lock_path.is_file())
                with self.assertRaises(MaterialJobLockedError):
                    with exclusive_material_job(root, "63", purpose="second"):
                        pass
            self.assertFalse(lock_path.exists())

    def test_material_job_lock_recovers_stale_owner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock_path = material_job_lock_path(root, "63")
            lock_path.parent.mkdir(parents=True)
            lock_path.write_text(
                json.dumps({"processId": 2_147_483_647, "token": "stale"}),
                encoding="utf-8",
            )
            with exclusive_material_job(root, "63", purpose="recovery") as owner:
                self.assertNotEqual(owner.token, "stale")
            self.assertFalse(lock_path.exists())

    def test_material_job_lock_does_not_steal_a_fresh_unpublished_owner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock_path = material_job_lock_path(root, "63")
            lock_path.parent.mkdir(parents=True)
            lock_path.write_text("", encoding="utf-8")

            with self.assertRaises(MaterialJobLockedError):
                with exclusive_material_job(root, "63", purpose="second"):
                    pass

            os.utime(lock_path, (1, 1))
            with exclusive_material_job(root, "63", purpose="stale-recovery"):
                pass
            self.assertFalse(lock_path.exists())

    def test_derived_artifact_gate_hides_partial_or_failed_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = algorithm_state_path(root, "63")
            state_path.parent.mkdir(parents=True)
            state_path.write_text(
                json.dumps({"state": "processing", "mode": "final-fast"}),
                encoding="utf-8",
            )
            processing = _derived_artifact_read_gate(root, "63")
            self.assertEqual(processing[0], 503)
            self.assertEqual(processing[1]["error"], "derived_artifacts_processing")

            state_path.write_text(
                json.dumps(
                    {
                        "state": "failed",
                        "mode": "final-fast",
                        "error": "surface failed",
                    }
                ),
                encoding="utf-8",
            )
            failed = _derived_artifact_read_gate(root, "63")
            self.assertEqual(failed[0], 409)
            self.assertEqual(failed[1]["error"], "derived_artifacts_failed")

            state_path.write_text(
                json.dumps({"state": "failed", "mode": "final-defects"}),
                encoding="utf-8",
            )
            self.assertIsNone(_derived_artifact_read_gate(root, "63"))

    def test_recent_materials_uses_numeric_order_not_directory_mtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("9", "100", "12", "FLOW-0000000200", "system"):
                (root / name).mkdir()
            self.assertEqual(service.recent_materials(root, 3), ["100", "12", "9"])

    def test_capture_handoff_prioritizes_a_low_realtime_flow(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("535", "3000", "4000"):
                (root / name).mkdir()
            with patch(
                "sick_capture.events.time.time_ns",
                side_effect=[100, 200, 300],
            ):
                publish_flow_handoff(
                    root,
                    "535",
                    session_id="old-active",
                    state="capturing",
                    latest_round=100,
                )
                publish_flow_handoff(
                    root,
                    "4000",
                    session_id="new-active",
                    state="capturing",
                )
                publish_flow_handoff(
                    root,
                    "535",
                    session_id="old-active",
                    state="closed",
                    latest_round=50,
                )

            self.assertEqual(service.capture_flow_hints(root), ["535", "4000"])
            self.assertEqual(
                service.recent_materials(
                    root,
                    3,
                    priority_material_ids=service.capture_flow_hints(root),
                ),
                ["535", "4000", "3000"],
            )
            payload = json.loads(
                capture_flow_handoff_path(root).read_text(encoding="utf-8")
            )
            self.assertEqual(payload["flows"][1]["state"], "closed")
            self.assertEqual(payload["flows"][1]["latestCommittedRound"], 100)

    def test_all_materials_and_history_cursor_are_numeric_and_restartable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("9", "100", "12", "FLOW-0000000200", "system"):
                (root / name).mkdir()
            self.assertEqual(service.all_materials(root), ["9", "12", "100"])
            self.assertEqual(service.load_history_cursor(root), "")
            service.save_history_cursor(
                root,
                "12",
                catalog_count=3,
                checked_count=4,
            )
            self.assertEqual(service.load_history_cursor(root), "12")
            payload = json.loads(
                service.history_cursor_path(root).read_text(encoding="utf-8-sig")
            )
            self.assertEqual(payload["schema"], service.HISTORY_CURSOR_SCHEMA)
            self.assertEqual(payload["catalogCount"], 3)
            self.assertEqual(payload["checkedCount"], 4)

    def test_history_cursor_round_robin_excludes_realtime_window(self) -> None:
        materials = ["1", "2", "3", "4"]
        self.assertEqual(
            service.next_history_material(materials, "2", {"4"}),
            "3",
        )
        self.assertEqual(
            service.next_history_material(materials, "4", {"1", "2"}),
            "3",
        )
        self.assertIsNone(
            service.next_history_material(materials, "2", set(materials))
        )

    def test_depth_history_cursor_is_hash_scoped_and_newest_first(self) -> None:
        materials = ["1", "2", "3", "4"]
        self.assertEqual(
            service.next_depth_history_material(materials, "", {"4"}),
            "3",
        )
        self.assertEqual(
            service.next_depth_history_material(materials, "3", {"4"}),
            "2",
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            service.save_depth_history_cursor(
                root,
                "3",
                "config-a",
                revision=2,
                catalog_count=4,
                checked_count=1,
                legacy_model_hash="legacy-a",
            )
            self.assertEqual(
                service.load_depth_history_cursor(root, "config-a", "legacy-a"), "3"
            )
            self.assertEqual(service.load_depth_history_cursor(root, "config-b"), "")
            self.assertEqual(
                service.load_depth_history_cursor(root, "config-a", "legacy-b"), ""
            )

    def test_defect_completion_requires_current_geometry_hash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = service.defect_detection_manifest_path(root, "63")
            path.parent.mkdir(parents=True)
            path.write_text(
                json.dumps(
                    {
                        "state": "complete",
                        "defectGroups": {
                            "geometry": {"configHash": "current"},
                            "legacy": {},
                        },
                        "databaseImport": {"state": "complete"},
                    }
                ),
                encoding="utf-8",
            )
            self.assertTrue(service.defect_artifact_complete(root, "63", "current"))
            self.assertFalse(service.defect_artifact_complete(root, "63", "changed"))
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["defectGroups"]["geometry"]["state"] = "queued"
            path.write_text(json.dumps(payload), encoding="utf-8")
            self.assertFalse(service.defect_artifact_complete(root, "63", "current"))
            # Realtime completion is model-bound and does not wait for the
            # separately scheduled geometry-history pass.
            self.assertTrue(service.defect_artifact_complete(root, "63", None))
            payload["defectGroups"]["geometry"]["state"] = "ready"
            payload["databaseImport"]["state"] = "partial"
            path.write_text(json.dumps(payload), encoding="utf-8")
            self.assertFalse(service.defect_artifact_complete(root, "63", "current"))

    def test_defect_completion_requires_current_capture_signature(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = service.defect_detection_manifest_path(root, "63")
            manifest.parent.mkdir(parents=True)
            manifest.write_text(
                json.dumps(
                    {
                        "state": "complete",
                        "defectGroups": {"geometry": {}, "legacy": {}},
                        "databaseImport": {"state": "complete"},
                    }
                ),
                encoding="utf-8",
            )
            signature = (27, 120, 10_000_000_000)
            state_path = algorithm_state_path(root, "63")
            state_path.write_text(
                json.dumps(
                    {
                        "state": "queued-for-defect",
                        "mode": "final-fast",
                        "committedEventCount": signature[0],
                        "latestCommittedRound": signature[1],
                        "latestCommittedEventMtimeNs": signature[2],
                    }
                ),
                encoding="utf-8",
            )
            self.assertFalse(
                service.defect_artifact_complete(
                    root,
                    "63",
                    expected_capture_signature=signature,
                )
            )
            state = json.loads(state_path.read_text(encoding="utf-8"))
            state.update({"state": "ready", "mode": "final"})
            state_path.write_text(json.dumps(state), encoding="utf-8")
            self.assertTrue(
                service.defect_artifact_complete(
                    root,
                    "63",
                    expected_capture_signature=signature,
                )
            )
            self.assertFalse(
                service.defect_artifact_complete(
                    root,
                    "63",
                    expected_capture_signature=(28, signature[1], signature[2]),
                )
            )

    def test_committed_signature_does_not_advance_on_partial_round(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = frame_event_root(root, "63")
            events.mkdir(parents=True)
            complete = {
                "schema": "steel.capture-frame-committed.v1",
                "captureRound": 10,
                "complete": True,
                "expectedCameraCount": 2,
                "committedCameraCount": 2,
                "missingCameraIds": [],
                "frames": [
                    {"cameraId": "C1", "sequenceNo": 1, "storageIndex": 0},
                    {"cameraId": "C2", "sequenceNo": 1, "storageIndex": 0},
                ],
            }
            partial = {
                **complete,
                "captureRound": 11,
                "complete": False,
                "committedCameraCount": 1,
                "missingCameraIds": ["C2"],
                "frames": [
                    {"cameraId": "C1", "sequenceNo": 2, "storageIndex": 1}
                ],
            }
            (events / "000000000010.json").write_text(json.dumps(complete))
            (events / "000000000011.json").write_text(json.dumps(partial))
            manifest = flow_manifest_path(root, "63")
            manifest.write_text(
                json.dumps(
                    {
                        "schema": "steel.camera-storage.v3",
                        "state": "closed",
                        "latestCommittedRound": 11,
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(Path, "glob", side_effect=AssertionError("slow scan")):
                signature = service.committed_signature(root, "63")
            self.assertIsNotNone(signature)
            self.assertEqual(signature[:2], (1, 10))

            partial["captureRound"] = 12
            (events / "000000000012.json").write_text(json.dumps(partial))
            manifest.write_text(
                json.dumps(
                    {
                        "schema": "steel.camera-storage.v3",
                        "state": "closed",
                        "latestCommittedRound": 12,
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(Path, "glob", side_effect=AssertionError("slow scan")):
                cached = service.committed_signature(root, "63")
            self.assertEqual(cached, signature)

    def test_committed_signature_accepts_audited_per_camera_routed_rounds(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = frame_event_root(root, "63")
            events.mkdir(parents=True)
            first = {
                "schema": "steel.capture-frame-committed.v1",
                "captureRound": 10,
                "boundaryPhase": "camera-leading-buffer",
                "complete": False,
                "expectedCameraCount": 6,
                "committedCameraCount": 1,
                "missingCameraIds": ["C1", "C2", "C3", "C4", "C5"],
                "frames": [
                    {
                        "cameraId": "C6",
                        "sequenceNo": 1,
                        "storageIndex": 0,
                        "materialSignal": True,
                    }
                ],
            }
            second = {
                **first,
                "captureRound": 12,
                "boundaryPhase": "camera-normal",
                "committedCameraCount": 2,
                "missingCameraIds": ["C1", "C2", "C3", "C4"],
                "frames": [
                    {
                        "cameraId": "C5",
                        "sequenceNo": 1,
                        "storageIndex": 0,
                        "materialSignal": True,
                    },
                    {
                        "cameraId": "C6",
                        "sequenceNo": 2,
                        "storageIndex": 1,
                        "materialSignal": True,
                    },
                ],
            }
            (events / "000000000010.json").write_text(
                json.dumps(first), encoding="utf-8"
            )
            latest = events / "000000000012.json"
            latest.write_text(json.dumps(second), encoding="utf-8")
            flow_manifest_path(root, "63").write_text(
                json.dumps(
                    {
                        "schema": "steel.camera-storage.v3",
                        "state": "closed",
                        "latestCommittedRound": 12,
                        "boundaryPolicy": (
                            "global-reference-id+per-camera-one-round-boundary"
                        ),
                    }
                ),
                encoding="utf-8",
            )

            signature = service.committed_signature(root, "63")

            self.assertEqual(signature, (2, 12, latest.stat().st_mtime_ns))

    def test_committed_signature_rejects_unaudited_routed_partial_round(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = frame_event_root(root, "63")
            events.mkdir(parents=True)
            (events / "000000000010.json").write_text(
                json.dumps(
                    {
                        "schema": "steel.capture-frame-committed.v1",
                        "captureRound": 10,
                        "boundaryPhase": "camera-normal",
                        "complete": False,
                        "expectedCameraCount": 6,
                        "committedCameraCount": 1,
                        "missingCameraIds": ["C2", "C3", "C4", "C5", "C6"],
                        "frames": [
                            {
                                "cameraId": "C1",
                                "sequenceNo": 1,
                                "storageIndex": 0,
                                "materialSignal": False,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            flow_manifest_path(root, "63").write_text(
                json.dumps(
                    {
                        "schema": "steel.camera-storage.v3",
                        "state": "closed",
                        "latestCommittedRound": 10,
                        "boundaryPolicy": (
                            "global-reference-id+per-camera-one-round-boundary"
                        ),
                    }
                ),
                encoding="utf-8",
            )

            self.assertIsNone(service.committed_signature(root, "63"))

    def test_cached_signature_reconciles_late_algorithm_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = frame_event_root(root, "63")
            events.mkdir(parents=True)
            complete = {
                "schema": "steel.capture-frame-committed.v1",
                "captureRound": 10,
                "complete": True,
                "expectedCameraCount": 1,
                "committedCameraCount": 1,
                "missingCameraIds": [],
                "frames": [{"cameraId": "C1", "cameraSequence": 1}],
            }
            complete_path = events / "000000000010.json"
            complete_path.write_text(json.dumps(complete), encoding="utf-8")
            partial = {
                **complete,
                "captureRound": 11,
                "complete": False,
                "committedCameraCount": 0,
                "missingCameraIds": ["C1"],
                "frames": [],
            }
            (events / "000000000011.json").write_text(
                json.dumps(partial), encoding="utf-8"
            )
            manifest = flow_manifest_path(root, "63")
            manifest.write_text(
                json.dumps(
                    {
                        "schema": "steel.camera-storage.v3",
                        "state": "capturing",
                        "latestCommittedRound": 11,
                    }
                ),
                encoding="utf-8",
            )
            first = service.committed_signature(root, "63")
            self.assertIsNotNone(first)
            self.assertEqual(first[:2], (1, 10))

            state_path = algorithm_state_path(root, "63")
            state_path.parent.mkdir(parents=True, exist_ok=True)
            state_path.write_text(
                json.dumps(
                    {
                        "committedEventCount": 7,
                        "latestCommittedRound": 10,
                        "latestCommittedEventMtimeNs": complete_path.stat().st_mtime_ns,
                    }
                ),
                encoding="utf-8",
            )
            partial["captureRound"] = 12
            (events / "000000000012.json").write_text(
                json.dumps(partial), encoding="utf-8"
            )
            manifest.write_text(
                json.dumps(
                    {
                        "schema": "steel.camera-storage.v3",
                        "state": "capturing",
                        "latestCommittedRound": 12,
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(Path, "glob", side_effect=AssertionError("slow scan")):
                reconciled = service.committed_signature(root, "63")
            self.assertEqual(reconciled, (7, 10, complete_path.stat().st_mtime_ns))

    def test_committed_signature_uses_manifest_latest_event_without_directory_scan(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = frame_event_root(root, "63")
            events.mkdir(parents=True)
            latest = events / "000000000120.json"
            latest.write_text(
                json.dumps(
                    {
                        "schema": "steel.capture-frame-committed.v1",
                        "captureRound": 120,
                        "complete": True,
                        "expectedCameraCount": 2,
                        "committedCameraCount": 2,
                        "missingCameraIds": [],
                        "frames": [
                            {"cameraId": "C1", "sequenceNo": 27, "storageIndex": 26},
                            {"cameraId": "C2", "sequenceNo": 26, "storageIndex": 25},
                        ],
                    }
                )
            )
            manifest = flow_manifest_path(root, "63")
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(
                json.dumps(
                    {
                        "schema": "steel.camera-storage.v3",
                        "flowNo": 63,
                        "state": "closed",
                        "latestCommittedRound": 120,
                    }
                )
            )
            with patch.object(Path, "glob", side_effect=AssertionError("slow scan")):
                signature = service.committed_signature(root, "63")
            self.assertIsNotNone(signature)
            self.assertEqual(signature[:2], (27, 120))

    def test_algorithm_lag_snapshot_reports_input_and_result_delay(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_path = algorithm_state_path(root, "535")
            state_path.parent.mkdir(parents=True)
            state_path.write_text(
                json.dumps(
                    {
                        "state": "queued-for-defect",
                        "mode": "final-fast",
                        "committedEventCount": 20,
                        "latestCommittedRound": 100,
                        "latestCommittedEventMtimeNs": 4_000_000_000,
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(
                service,
                "committed_signature",
                return_value=(27, 120, 10_000_000_000),
            ), patch.object(service, "flow_state", return_value="closed"):
                snapshot = service.algorithm_lag_snapshot(root, "535")
            self.assertEqual(snapshot["captureToAlgorithmLagEvents"], 7)
            self.assertEqual(snapshot["captureToAlgorithmLagRounds"], 20)
            self.assertEqual(snapshot["captureToAlgorithmLagMs"], 6000)
            self.assertFalse(snapshot["inputAccepted"])
            self.assertFalse(snapshot["resultCaughtUp"])

            payload = json.loads(state_path.read_text(encoding="utf-8"))
            payload.update(
                {
                    "state": "processing",
                    "committedEventCount": 27,
                    "latestCommittedRound": 120,
                    "latestCommittedEventMtimeNs": 10_000_000_000,
                }
            )
            state_path.write_text(json.dumps(payload), encoding="utf-8")
            with patch.object(
                service,
                "committed_signature",
                return_value=(27, 120, 10_000_000_000),
            ), patch.object(service, "flow_state", return_value="closed"):
                snapshot = service.algorithm_lag_snapshot(root, "535")
            self.assertTrue(snapshot["inputAccepted"])
            self.assertFalse(snapshot["resultCaughtUp"])

            payload["state"] = "processing-defects"
            state_path.write_text(json.dumps(payload), encoding="utf-8")
            with patch.object(
                service,
                "committed_signature",
                return_value=(27, 120, 10_000_000_000),
            ), patch.object(service, "flow_state", return_value="closed"):
                snapshot = service.algorithm_lag_snapshot(root, "535")
            self.assertFalse(snapshot["resultCaughtUp"])

    def test_live_snapshot_is_accepted_when_capture_advances_during_analysis(self) -> None:
        before = (100, 400, 1_000)
        after = (125, 425, 2_000)
        self.assertTrue(
            service.analysis_snapshot_accepted(before, "capturing", after, "capturing")
        )
        self.assertFalse(
            service.analysis_snapshot_accepted(before, "capturing", after, "closed")
        )
        self.assertFalse(
            service.analysis_snapshot_accepted(before, "closed", after, "closed")
        )
        self.assertTrue(
            service.analysis_snapshot_accepted(before, "closed", before, "closed")
        )

    def test_capture_handoff_defects_sort_ahead_of_numeric_and_history_work(self) -> None:
        self.assertEqual(
            service.defect_queue_tier(history=False, capture_priority=True), -1
        )
        self.assertEqual(
            service.defect_queue_tier(history=False, capture_priority=False), 0
        )
        self.assertEqual(
            service.defect_queue_tier(history=True, capture_priority=False), 1
        )

    def test_quarantined_flow_is_not_analyzable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = flow_manifest_path(root, "63")
            manifest.parent.mkdir(parents=True)
            manifest.write_text(
                json.dumps(
                    {
                        "schema": "steel.camera-storage.v3",
                        "state": "quarantined-storage-collision",
                    }
                ),
                encoding="utf-8",
            )
            self.assertNotIn(
                service.flow_state(root, "63"),
                {"capturing", "closed"},
            )

    def test_final_fast_pass_checkpoints_without_running_defect_model(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material_id = "64"
            signature = (20, 100, 123456)
            paths = {
                "alignment": alignment_path(root, material_id),
                "measurement": measurement_path(root, material_id),
                "region": region_path(root, material_id),
                "playback": playback_index_path(root, material_id),
            }
            flow_manifest = flow_manifest_path(root, material_id)
            flow_manifest.parent.mkdir(parents=True, exist_ok=True)
            flow_manifest.write_text(
                json.dumps({"schema": "steel.flow-storage.v2", "flowId": material_id}),
                encoding="utf-8",
            )
            for path in paths.values():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("{}", encoding="utf-8")
            with patch.object(
                service,
                "build_and_write_flow_alignment",
                return_value=(paths["alignment"], {"quality": {"synchronized": True}}),
            ), patch.object(
                service,
                "build_and_write_flow_measurement",
                return_value=(paths["measurement"], {"metricValid": True}),
            ), patch.object(
                service,
                "build_and_write_flow_region_map",
                return_value=(paths["region"], {"state": "ready"}),
            ), patch.object(
                service,
                "build_and_write_playback_index",
                return_value=(paths["playback"], {"frameCount": 20}),
            ), patch.object(
                service, "build_and_write_flow_defect_detection"
            ) as defect_builder:
                service.analyze(
                    {},
                    root,
                    material_id,
                    AlignmentConfig(),
                    MeasurementConfig(),
                    DefectDetectionConfig(),
                    None,
                    "",
                    final=True,
                    include_defects=False,
                    committed_event_signature=signature,
                )
            defect_builder.assert_not_called()
            state = json.loads(
                algorithm_state_path(root, material_id).read_text(encoding="utf-8")
            )
            self.assertEqual(state["state"], "queued-for-defect")
            self.assertEqual(
                (
                    state["committedEventCount"],
                    state["latestCommittedRound"],
                    state["latestCommittedEventMtimeNs"],
                ),
                signature,
            )
            self.assertTrue(
                service.fast_artifacts_ready(root, material_id, signature)
            )

    def test_closed_processed_snapshot_revalidates_shared_durable_state(self) -> None:
        signature = (42, 275625, 123456789)
        processed = (signature, "closed")
        with patch.object(service, "fast_artifacts_ready", return_value=True) as ready:
            self.assertTrue(
                service.processed_snapshot_is_current(
                    Path("storage"), "5022", processed, signature, "closed"
                )
            )
            ready.assert_called_once_with(Path("storage"), "5022", signature)

        with patch.object(service, "fast_artifacts_ready", return_value=False):
            self.assertFalse(
                service.processed_snapshot_is_current(
                    Path("storage"), "5022", processed, signature, "closed"
                )
            )

        # Capturing snapshots are transient and cannot be overwritten by the
        # final defect role, so their process-local shortcut remains cheap.
        with patch.object(
            service,
            "fast_artifacts_ready",
            side_effect=AssertionError("closed-flow check only"),
        ):
            self.assertTrue(
                service.processed_snapshot_is_current(
                    Path("storage"),
                    "5022",
                    (signature, "capturing"),
                    signature,
                    "capturing",
                )
            )


if __name__ == "__main__":
    unittest.main()
