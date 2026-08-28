from __future__ import annotations

import unittest

from scripts.sick_capture.defect_comparison import (
    compare_candidate_groups,
    compose_dual_manifest,
    rectangle_iou,
)


def candidate(candidate_id: str, source: str, rect: list[int], frame: int = 4):
    return {
        "id": candidate_id,
        "source": source,
        "cameraId": "C1",
        "storageIndex": frame,
        "imageRect2d": dict(zip(("left", "top", "right", "bottom"), rect)),
    }


class SickDefectComparisonTests(unittest.TestCase):
    def test_iou_and_greedy_one_to_one_are_deterministic(self) -> None:
        geometry = [candidate("g1", "geometry", [0, 0, 10, 10])]
        legacy = [
            candidate("l1", "legacy", [0, 0, 10, 10]),
            candidate("l2", "legacy", [1, 1, 9, 9]),
        ]
        self.assertEqual(rectangle_iou(geometry[0], legacy[0]), 1.0)
        comparison = compare_candidate_groups(geometry, legacy)
        self.assertEqual(comparison["matchedCount"], 1)
        self.assertEqual(comparison["matches"][0]["legacyId"], "l1")
        self.assertEqual(comparison["legacyOnlyIds"], ["l2"])
        self.assertEqual(comparison["estimatedUniqueCount"], 2)

    def test_camera_and_frame_must_match(self) -> None:
        geometry = [candidate("g1", "geometry", [0, 0, 10, 10])]
        legacy = [candidate("l1", "legacy", [0, 0, 10, 10], frame=5)]
        comparison = compare_candidate_groups(geometry, legacy)
        self.assertEqual(comparison["matched"], 0)

    def test_composition_preserves_union_and_reports_unique_estimate(self) -> None:
        geometry = candidate("g1", "geometry", [0, 0, 10, 10])
        legacy = candidate("l1", "legacy", [0, 0, 10, 10])
        manifest = compose_dual_manifest(
            {"state": "complete", "defects": [legacy], "statistics": {}},
            {
                "state": "complete",
                "algorithmRevision": 7,
                "configHash": "abc",
                "globalPositionAvailable": False,
                "riskTags": ["global-position-unavailable"],
                "defects": [geometry],
            },
        )
        self.assertEqual(manifest["statistics"]["defectCount"], 2)
        self.assertEqual(manifest["statistics"]["estimatedUniqueCount"], 1)
        self.assertEqual(manifest["algorithmRevision"], 7)
        self.assertFalse(
            manifest["defectGroups"]["geometry"]["globalPositionAvailable"]
        )
        self.assertEqual(
            manifest["defectGroups"]["geometry"]["riskTags"],
            ["global-position-unavailable"],
        )
        self.assertEqual(
            manifest["comparison"]["riskTags"],
            ["global-position-unavailable"],
        )


if __name__ == "__main__":
    unittest.main()
