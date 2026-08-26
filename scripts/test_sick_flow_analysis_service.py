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
                "frames": [{"cameraId": "C1"}, {"cameraId": "C2"}],
            }
            partial = {
                **complete,
                "captureRound": 11,
                "complete": False,
                "committedCameraCount": 1,
                "missingCameraIds": ["C2"],
                "frames": [{"cameraId": "C1"}],
            }
            (events / "000000000010.json").write_text(json.dumps(complete))
            (events / "000000000011.json").write_text(json.dumps(partial))
            signature = service.committed_signature(root, "63")
            self.assertIsNotNone(signature)
            self.assertEqual(signature[:2], (1, 10))

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
            with (
                patch.object(
                    service,
                    "build_and_write_flow_alignment",
                    return_value=(paths["alignment"], {"quality": {"synchronized": True}}),
                ),
                patch.object(
                    service,
                    "build_and_write_flow_measurement",
                    return_value=(paths["measurement"], {"metricValid": True}),
                ),
                patch.object(
                    service,
                    "build_and_write_flow_region_map",
                    return_value=(paths["region"], {"state": "ready"}),
                ),
                patch.object(
                    service,
                    "build_and_write_playback_index",
                    return_value=(paths["playback"], {"frameCount": 20}),
                ),
                patch.object(
                    service, "build_and_write_flow_defect_detection"
                ) as defect_builder,
            ):
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


if __name__ == "__main__":
    unittest.main()
