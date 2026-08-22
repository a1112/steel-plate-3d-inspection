from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np

from scripts.sick_capture.defect_detection import (
    DEFECT_DETECTION_SCHEMA,
    DefectDetectionConfig,
    _legacy_classifier_crop,
    _prepare_review_output,
    build_flow_defect_detection,
    candidate_spans_crop_boundary,
    decode_yolov5_predictions,
    flatten_depth_for_detection,
    merge_modal_candidates,
    resolve_candidate_classification,
)


class SickDefectDetectionTests(unittest.TestCase):
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
                "FLOW-0000000001",
                {"cameras": {}},
                config=DefectDetectionConfig(enabled=False),
            )
        self.assertEqual(result["schema"], DEFECT_DETECTION_SCHEMA)
        self.assertEqual(result["state"], "disabled")
        self.assertTrue(result["quality"]["reviewRequired"])


if __name__ == "__main__":
    unittest.main()
