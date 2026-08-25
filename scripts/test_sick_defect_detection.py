from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

from scripts.sick_defect_history_backfill import (
    capture_gate_heartbeat_loop,
    ensure_minimum_review_crops,
    final_outcome,
    wait_for_strict_capture_idle,
)
from scripts.sick_capture.alignment import _frame_records
from scripts.sick_capture.defect_detection import (
    DEFECT_DETECTION_SCHEMA,
    DefectDetectionConfig,
    ExecutionGateInterrupted,
    _defect_position_ratios,
    _legacy_classifier_crop,
    _prepare_review_output,
    _realtime_analysis_has_priority,
    _save_review_crop,
    build_and_write_flow_defect_detection,
    build_flow_defect_detection,
    candidate_spans_crop_boundary,
    decode_yolov5_predictions,
    flatten_depth_for_detection,
    import_defect_manifest,
    merge_modal_candidates,
    resolve_candidate_classification,
)


class SickDefectDetectionTests(unittest.TestCase):
    def test_defect_position_uses_calibrated_surface_column_angle(self) -> None:
        angles: list[float | None] = [None] * 20
        angles[7] = 270.0
        length, circumference, camera_number, mapping = _defect_position_ratios(
            camera_id="C2",
            camera_count=6,
            storage_index=12,
            rect=[106, 10, 108, 14],
            source_width=2560,
            source_height=100,
            camera_alignment={
                "head": {"frameIndex": 10},
                "tail": {"frameIndex": 20},
            },
            camera_surface_tile={
                "cameraId": "C2",
                "cropBox": [100, 0, 120, 100],
                "angleDegByColumn": angles,
                "rowAnchors": [
                    {
                        "row": 3,
                        "sourceGlobalRow": 1212,
                        "positionRatio": 0.25,
                        "anchorOrdinal": 8,
                    }
                ],
            },
        )
        self.assertEqual(camera_number, 2)
        self.assertAlmostEqual(circumference, 0.75)
        self.assertGreater(length, 0.0)
        self.assertTrue(mapping["available"])
        self.assertEqual(mapping["arrayAngleDeg"], 270.0)
        self.assertEqual(mapping["tileRow"], 3)

    def test_crop_backfill_yields_before_each_defect(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            targets = [root / "first.png", root / "second.png"]
            for target in targets:
                Image.fromarray(np.full((64, 64), 32, dtype=np.uint8)).save(target)
            manifest = {
                "defects": [
                    {
                        "id": str(index),
                        "source2d": str(root / "unused.png"),
                        "reviewImage": str(target),
                        "imageRect2d": {
                            "left": 0,
                            "top": 0,
                            "right": 1,
                            "bottom": 1,
                        },
                    }
                    for index, target in enumerate(targets, 1)
                ]
            }
            calls = 0

            def gate(phase: str) -> None:
                nonlocal calls
                if phase != "review-crop-defect":
                    return
                calls += 1
                if calls == 2:
                    raise ExecutionGateInterrupted("capture became busy")

            with self.assertRaises(ExecutionGateInterrupted):
                ensure_minimum_review_crops(
                    manifest, 64, execution_gate=gate
                )
            self.assertEqual(manifest["defects"][0]["reviewImageWidth"], 64)
            self.assertNotIn("reviewImageWidth", manifest["defects"][1])

    def test_alignment_metadata_loop_yields_between_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            flow_root = Path(directory)
            metadata_root = flow_root / "json"
            metadata_root.mkdir()
            for index in range(2):
                (metadata_root / f"{index}.json").write_text(
                    json.dumps({"timestamp": index + 1, "timestampFrequency": 1}),
                    encoding="utf-8",
                )
            second_read = threading.Event()
            release = threading.Event()
            completed = threading.Event()
            read_count = 0

            def gate(phase: str) -> None:
                nonlocal read_count
                if phase != "alignment-metadata-read":
                    return
                read_count += 1
                if read_count == 2:
                    second_read.set()
                    release.wait(timeout=1.0)

            def run() -> None:
                _frame_records(flow_root, execution_gate=gate)
                completed.set()

            thread = threading.Thread(target=run)
            thread.start()
            self.assertTrue(second_read.wait(timeout=1.0))
            self.assertFalse(completed.is_set())
            release.set()
            thread.join(timeout=1.0)
            self.assertFalse(thread.is_alive())
            self.assertTrue(completed.is_set())

    def test_blocked_region_path_yields_before_database_and_final_commit(self) -> None:
        database_gate = threading.Event()
        release = threading.Event()
        completed = threading.Event()
        phases: list[str] = []

        def gate(phase: str) -> None:
            phases.append(phase)
            if phase == "defect-blocked-database-import":
                database_gate.set()
                release.wait(timeout=1.0)

        with tempfile.TemporaryDirectory() as directory, patch(
            "scripts.sick_capture.defect_detection._atomic_json"
        ) as writer, patch(
            "scripts.sick_capture.defect_detection.import_defect_manifest",
            return_value={"state": "complete", "deleted": 2, "imported": 0},
        ) as importer:

            def run() -> None:
                build_and_write_flow_defect_detection(
                    {},
                    Path(directory),
                    "64",
                    {"cameras": {}},
                    config=DefectDetectionConfig(
                        enabled=True,
                        require_approved_region_map=True,
                        database_origin="http://127.0.0.1:4873",
                    ),
                    execution_gate=gate,
                )
                completed.set()

            thread = threading.Thread(target=run)
            thread.start()
            self.assertTrue(database_gate.wait(timeout=1.0))
            self.assertEqual(writer.call_count, 1)
            importer.assert_not_called()
            self.assertFalse(completed.is_set())
            release.set()
            thread.join(timeout=1.0)
            self.assertFalse(thread.is_alive())
            self.assertTrue(completed.is_set())
            importer.assert_called_once()
            self.assertEqual(writer.call_count, 2)
        self.assertIn("defect-blocked-manifest-final-write", phases)

    def test_database_post_does_not_start_until_execution_gate_releases(self) -> None:
        post_gate = threading.Event()
        release = threading.Event()
        completed = threading.Event()
        phases: list[str] = []
        manifest = {
            "materialId": "64",
            "defects": [{"id": "a"}, {"id": "b"}],
        }

        def gate(phase: str) -> None:
            phases.append(phase)
            if phase == "defect-database-post":
                post_gate.set()
                release.wait(timeout=1.0)

        class Response:
            status = 200

            def __enter__(self) -> "Response":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return b'{"code":0,"data":{}}'

        with patch(
            "scripts.sick_capture.defect_detection.request.urlopen",
            return_value=Response(),
        ) as urlopen:

            def run() -> None:
                import_defect_manifest(
                    manifest,
                    "http://database.test",
                    execution_gate=gate,
                )
                completed.set()

            thread = threading.Thread(target=run)
            thread.start()
            self.assertTrue(post_gate.wait(timeout=1.0))
            urlopen.assert_not_called()
            self.assertFalse(completed.is_set())
            release.set()
            thread.join(timeout=1.0)
            self.assertFalse(thread.is_alive())
            self.assertTrue(completed.is_set())
            urlopen.assert_called_once()
        self.assertEqual(phases.count("defect-database-payload-row"), 2)

    def test_strict_backfill_gate_heartbeats_until_queue_is_stably_idle(self) -> None:
        snapshots = [
            {
                "idle": False,
                "reason": "steel-present",
                "capturePhase": "steel-in-saving",
                "steelPresent": True,
                "materialId": "2844",
                "queue": {"pendingRounds": 11, "activeRounds": 1},
            },
            {
                "idle": False,
                "reason": "storage-queue-pending",
                "capturePhase": "steel-out",
                "steelPresent": False,
                "materialId": "",
                "queue": {"pendingRounds": 2, "activeRounds": 1},
            },
            {
                "idle": True,
                "reason": "idle",
                "capturePhase": "idle",
                "steelPresent": False,
                "materialId": "",
                "queue": {"pendingRounds": 0, "activeRounds": 0},
            },
        ]
        published: list[dict[str, object]] = []

        def snapshot_reader(_origin: str) -> dict[str, object]:
            if len(snapshots) > 1:
                return snapshots.pop(0)
            return snapshots[0]

        def publish(_path: Path, status: dict[str, object], **patch: object) -> None:
            status.update(patch)
            published.append(dict(status))

        self.assertTrue(
            wait_for_strict_capture_idle(
                "http://capture.test",
                Path("status.json"),
                {},
                phase="rebuild",
                next_material_id="2474",
                should_stop=lambda: False,
                stable_seconds=0.02,
                poll_seconds=0.005,
                heartbeat_seconds=0.005,
                snapshot_reader=snapshot_reader,
                status_publisher=publish,
            )
        )
        paused_reasons = {
            row.get("pauseReason")
            for row in published
            if row.get("state") == "paused"
        }
        self.assertIn("steel-present", paused_reasons)
        self.assertIn("storage-queue-pending", paused_reasons)
        self.assertEqual(published[-1]["state"], "running")
        self.assertEqual(published[-1]["pauseReason"], None)
        self.assertEqual(published[-1]["captureQueue"], {"pendingRounds": 0, "activeRounds": 0})

    def test_region_blocked_rebuild_cannot_start_while_steel_is_present(self) -> None:
        idle = threading.Event()
        builder_called = threading.Event()
        published: list[dict[str, object]] = []

        def snapshot_reader(_origin: str) -> dict[str, object]:
            return {
                "idle": idle.is_set(),
                "reason": "idle" if idle.is_set() else "steel-present",
                "capturePhase": "idle" if idle.is_set() else "steel-in-saving",
                "steelPresent": not idle.is_set(),
                "materialId": "" if idle.is_set() else "2844",
                "queue": {
                    "pendingRounds": 0 if idle.is_set() else 8,
                    "activeRounds": 0 if idle.is_set() else 1,
                },
            }

        def publish(_path: Path, status: dict[str, object], **patch: object) -> None:
            status.update(patch)
            published.append(dict(status))

        def gated_blocked_builder() -> None:
            ready = wait_for_strict_capture_idle(
                "http://capture.test",
                Path("status.json"),
                {},
                phase="rebuild",
                next_material_id="64",
                should_stop=lambda: False,
                stable_seconds=0.02,
                poll_seconds=0.005,
                heartbeat_seconds=0.005,
                snapshot_reader=snapshot_reader,
                status_publisher=publish,
            )
            if ready:
                builder_called.set()

        thread = threading.Thread(target=gated_blocked_builder)
        thread.start()
        time.sleep(0.04)
        self.assertFalse(builder_called.is_set())
        self.assertTrue(
            any(
                row.get("state") == "paused"
                and row.get("pauseReason") == "steel-present"
                for row in published
            )
        )
        idle.set()
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive())
        self.assertTrue(builder_called.is_set())

    def test_capture_gate_background_heartbeat_keeps_paused_status_fresh(self) -> None:
        stop = threading.Event()
        published: list[dict[str, object]] = []
        status: dict[str, object] = {
            "state": "running",
            "phase": "rebuild",
            "currentMaterialId": "64",
        }

        def publish(_path: Path, target: dict[str, object], **patch: object) -> None:
            patch.pop("emit_log", None)
            target.update(patch)
            published.append(dict(target))
            if len(published) >= 3:
                stop.set()

        snapshot = {
            "idle": False,
            "reason": "steel-present",
            "capturePhase": "steel-in-saving",
            "steelPresent": True,
            "materialId": "2844",
            "queue": {"pendingRounds": 9, "activeRounds": 1},
        }
        with (
            patch(
                "scripts.sick_defect_history_backfill.capture_gate_snapshot",
                return_value=snapshot,
            ),
            patch(
                "scripts.sick_defect_history_backfill.update_status",
                side_effect=publish,
            ),
        ):
            capture_gate_heartbeat_loop(
                "http://capture.test",
                Path("status.json"),
                status,
                stop,
                poll_seconds=0.002,
                heartbeat_seconds=0.005,
            )
        self.assertGreaterEqual(len(published), 3)
        self.assertTrue(all(row["state"] == "paused" for row in published))
        self.assertTrue(all(row["pauseReason"] == "steel-present" for row in published))
        self.assertTrue(all(row["currentMaterialId"] == "64" for row in published))

    def test_history_backfill_exit_status_reports_partial_failure(self) -> None:
        self.assertEqual(final_outcome(False, []), ("complete", 0))
        self.assertEqual(
            final_outcome(False, [{"materialId": "42", "error": "broken"}]),
            ("complete-with-errors", 1),
        )
        self.assertEqual(final_outcome(True, []), ("interrupted", 130))

    def test_realtime_priority_ignores_a_stale_worker_heartbeat(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            status_path = Path(directory) / "status.json"
            status_path.write_text(
                json.dumps(
                    {
                        "state": "running",
                        "updatedAtUnixMs": 980_000,
                        "currentDefectFlow": "42",
                    }
                ),
                encoding="utf-8",
            )
            with patch(
                "scripts.sick_capture.defect_detection.time.time",
                return_value=1_000.0,
            ):
                self.assertTrue(_realtime_analysis_has_priority(status_path))

            status_path.write_text(
                json.dumps(
                    {
                        "state": "running",
                        "updatedAtUnixMs": 900_000,
                        "currentDefectFlow": "42",
                    }
                ),
                encoding="utf-8",
            )
            with patch(
                "scripts.sick_capture.defect_detection.time.time",
                return_value=1_000.0,
            ):
                self.assertFalse(_realtime_analysis_has_priority(status_path))

    def test_review_crop_expands_tiny_defect_to_at_least_64_pixels(self) -> None:
        from PIL import Image

        image = np.zeros((96, 120), dtype=np.uint8)
        image[44:48, 58:61] = 255
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tiny.png"
            crop = _save_review_crop(image, [58, 44, 61, 48], path, 64)
            with Image.open(path) as saved:
                self.assertGreaterEqual(saved.width, 64)
                self.assertGreaterEqual(saved.height, 64)
                self.assertEqual(saved.size, (crop["width"], crop["height"]))

    def test_defect_configuration_bounds_batch_and_baseline_sampling(self) -> None:
        bounded = DefectDetectionConfig(
            inference_batch_size=999,
            preprocess_workers=0,
            depth_baseline_sample_step=0,
        ).bounded()
        self.assertEqual(bounded.inference_batch_size, 32)
        self.assertEqual(bounded.preprocess_workers, 1)
        self.assertEqual(bounded.depth_baseline_sample_step, 1)

    def test_decodes_defect_class_and_suppresses_overlap(self) -> None:
        predictions = np.zeros((1, 4, 7), dtype=np.float32)
        predictions[0, 0] = [320, 320, 200, 100, 0.9, 0.01, 0.9]
        predictions[0, 1] = [322, 320, 200, 100, 0.8, 0.01, 0.9]
        predictions[0, 2] = [100, 100, 30, 30, 0.9, 0.9, 0.01]
        predictions[0, 3] = [50, 50, 20, 20, 0.1, 0.01, 0.9]
        result = decode_yolov5_predictions(
            predictions,
            original_shape=(640, 640),
            scale=1.0,
            padding=(0.0, 0.0),
            confidence_threshold=0.25,
            iou_threshold=0.25,
            maximum_detections=10,
        )
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["rect"], [220, 270, 420, 370])
        self.assertAlmostEqual(result[0]["confidence"], 0.81, places=5)

    def test_maps_letterbox_coordinates_back_to_source(self) -> None:
        predictions = np.zeros((1, 1, 7), dtype=np.float32)
        # A 320x160 image uses scale=2 and 160 px vertical padding.
        predictions[0, 0] = [320, 320, 320, 160, 1.0, 0.0, 1.0]
        result = decode_yolov5_predictions(
            predictions,
            original_shape=(160, 320),
            scale=2.0,
            padding=(0.0, 160.0),
            confidence_threshold=0.25,
            iou_threshold=0.25,
            maximum_detections=10,
        )
        self.assertEqual(result[0]["rect"], [80, 40, 240, 120])

    def test_merges_matching_2d_and_3d_candidates(self) -> None:
        two_d = [{
            "rect": [10, 20, 50, 60],
            "confidence": 0.7,
            "modalities": ["2d"],
            "modelConfidence": {"2d": 0.7},
        }]
        three_d = [{
            "rect": [12, 22, 52, 62],
            "confidence": 0.8,
            "modalities": ["3d"],
            "modelConfidence": {"3d": 0.8},
        }]
        result = merge_modal_candidates(two_d, three_d, 0.2)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["modalities"], ["2d", "3d"])
        self.assertAlmostEqual(result[0]["confidence"], 0.94)

    def test_flattens_depth_profile_and_preserves_local_anomaly(self) -> None:
        columns = np.linspace(-5, 5, 80, dtype=np.float32)
        depth = np.repeat((1000 + columns)[None, :], 40, axis=0)
        depth[15:22, 30:38] += 3.0
        metadata = {
            "bdConfig": {
                "CoordinateC": {
                    "Scan3dCoordinateScale": 0.1,
                    "Scan3dCoordinateOffset": -100.0,
                    "Scan3dInvalidDataValue": 0,
                }
            }
        }
        rgb, normalized = flatten_depth_for_detection(
            depth.astype(np.uint16), metadata, [0, 0, 80, 40], 300.0
        )
        self.assertEqual(rgb.shape, (40, 80, 3))
        self.assertGreater(float(np.nanpercentile(normalized[15:22, 30:38], 95)), 0.1)
        self.assertLess(abs(float(np.nanmedian(normalized[:, :20]))), 0.05)

        sampled_rgb, sampled = flatten_depth_for_detection(
            depth.astype(np.uint16),
            metadata,
            [0, 0, 80, 40],
            300.0,
            baseline_sample_step=4,
        )
        self.assertEqual(sampled_rgb.shape, rgb.shape)
        self.assertGreater(
            float(np.nanpercentile(sampled[15:22, 30:38], 95)), 0.1
        )
        self.assertLess(abs(float(np.nanmedian(sampled[:, :20]))), 0.05)

    def test_classifier_crop_matches_legacy_minimum_roi_policy(self) -> None:
        image = np.zeros((100, 200, 3), dtype=np.uint8)
        image[45:55, 90:110] = 255
        crop = _legacy_classifier_crop(image, [95, 47, 105, 53])
        self.assertIsNotNone(crop)
        assert crop is not None
        self.assertEqual(crop.shape, (224, 224, 3))
        self.assertGreater(int(crop.max()), 0)

    def test_confident_pseudo_class_is_filtered_but_uncertain_result_is_kept(self) -> None:
        pseudo = {
            "classifications": {
                "2d": {
                    "name": "伪缺陷",
                    "acceptedDefect": False,
                    "confidence": 0.92,
                }
            }
        }
        keep, row, stage = resolve_candidate_classification(pseudo, 0.55)
        self.assertFalse(keep)
        self.assertEqual(row["name"], "伪缺陷")
        self.assertEqual(stage, "pseudo-defect-filtered")

        uncertain = {
            "classifications": {
                "2d": {
                    "name": "伪缺陷",
                    "acceptedDefect": False,
                    "confidence": 0.40,
                }
            }
        }
        keep, row, stage = resolve_candidate_classification(uncertain, 0.55)
        self.assertTrue(keep)
        self.assertIsNone(row)
        self.assertEqual(stage, "binary-candidate-review")

    def test_rebuild_replaces_only_generated_review_pngs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "defects" / "FLOW-1"
            review = output / "review"
            review.mkdir(parents=True)
            (review / "stale.png").write_bytes(b"stale")
            (review / "operator-note.txt").write_text("keep", encoding="utf-8")
            _prepare_review_output(output)
            self.assertFalse((review / "stale.png").exists())
            self.assertTrue((review / "operator-note.txt").is_file())

    def test_crop_spanning_boxes_are_boundary_artifacts(self) -> None:
        crop_box = [100, 20, 2100, 1020]
        self.assertTrue(
            candidate_spans_crop_boundary(
                {"rect": [200, 22, 280, 1009]}, crop_box
            )
        )
        self.assertTrue(
            candidate_spans_crop_boundary(
                {"rect": [102, 100, 2098, 200]}, crop_box
            )
        )
        self.assertFalse(
            candidate_spans_crop_boundary(
                {"rect": [500, 300, 700, 500]}, crop_box
            )
        )
        self.assertTrue(
            candidate_spans_crop_boundary(
                {"rect": [1724, 0, 1930, 513]}, [1450, 0, 1950, 524]
            )
        )

    def test_disabled_manifest_is_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = build_flow_defect_detection(
                {},
                Path(directory),
                "1",
                {"cameras": {}},
                config=DefectDetectionConfig(enabled=False),
            )
        self.assertEqual(result["schema"], DEFECT_DETECTION_SCHEMA)
        self.assertEqual(result["state"], "disabled")
        self.assertTrue(result["quality"]["reviewRequired"])

    def test_production_region_gate_blocks_before_model_loading(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            result = build_flow_defect_detection(
                {},
                Path(directory),
                "63",
                {"cameras": {}},
                config=DefectDetectionConfig(
                    enabled=True,
                    require_approved_region_map=True,
                ),
            )
        self.assertEqual(result["state"], "blocked")
        self.assertEqual(result["statistics"]["processedFrames"], 0)
        self.assertIn("region-manifest-missing", result["qualityGate"]["reasons"])

    def test_blocked_sick_array_reports_six_actual_cameras(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            camera_roots = {
                f"C{camera}": Path(directory) / f"camera-{camera}"
                for camera in range(1, 7)
            }
            result = build_flow_defect_detection(
                camera_roots,
                Path(directory),
                "63",
                {"cameras": {}},
                config=DefectDetectionConfig(
                    enabled=True,
                    require_approved_region_map=True,
                ),
            )
        self.assertEqual(result["state"], "blocked")
        self.assertEqual(result["statistics"]["cameraCount"], 6)
        self.assertNotEqual(result["statistics"]["cameraCount"], 8)

    def test_blocked_rebuild_withdraws_only_stale_pending_database_rows(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch(
            "scripts.sick_capture.defect_detection.import_defect_manifest",
            return_value={"state": "complete", "deleted": 3, "imported": 0},
        ) as importer:
            _path, manifest = build_and_write_flow_defect_detection(
                {},
                Path(directory),
                "64",
                {"cameras": {}},
                config=DefectDetectionConfig(
                    enabled=True,
                    require_approved_region_map=True,
                    database_origin="http://127.0.0.1:4873",
                ),
            )
        self.assertEqual(manifest["state"], "blocked")
        self.assertEqual(manifest["databaseImport"]["state"], "complete")
        self.assertEqual(manifest["databaseImport"]["deleted"], 3)
        imported_manifest = importer.call_args.args[0]
        self.assertEqual(imported_manifest["defects"], [])


if __name__ == "__main__":
    unittest.main()
