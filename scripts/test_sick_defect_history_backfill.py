from __future__ import annotations

import copy
import unittest

from scripts.sick_defect_history_backfill import (
    BACKFILL_VERSION,
    can_skip_history_backfill,
)


class SickDefectHistoryBackfillResumeTests(unittest.TestCase):
    @staticmethod
    def completed_manifest() -> dict[str, object]:
        return {
            "historyBackfill": {
                "version": BACKFILL_VERSION,
                "minimumCropSize": 64,
                "depthGeometryConfigHash": "geometry-hash-v2",
                "depthGeometryConfigRevision": 2,
            },
            "databaseImport": {"state": "complete"},
            "defectGroups": {
                "geometry": {
                    "configHash": "geometry-hash-v2",
                    "algorithmRevision": 2,
                }
            },
        }

    def test_completed_matching_geometry_snapshot_is_skipped(self) -> None:
        self.assertTrue(
            can_skip_history_backfill(
                self.completed_manifest(), 64, "geometry-hash-v2", 2
            )
        )

    def test_legacy_marker_without_geometry_identity_is_rebuilt(self) -> None:
        manifest = self.completed_manifest()
        marker = manifest["historyBackfill"]
        assert isinstance(marker, dict)
        marker.pop("depthGeometryConfigHash")
        marker.pop("depthGeometryConfigRevision")
        self.assertFalse(
            can_skip_history_backfill(
                manifest, 64, "geometry-hash-v2", 2
            )
        )

    def test_mismatched_marker_or_embedded_geometry_is_rebuilt(self) -> None:
        cases: list[dict[str, object]] = []
        wrong_marker_hash = copy.deepcopy(self.completed_manifest())
        wrong_marker_hash["historyBackfill"]["depthGeometryConfigHash"] = "old"
        cases.append(wrong_marker_hash)
        wrong_marker_revision = copy.deepcopy(self.completed_manifest())
        wrong_marker_revision["historyBackfill"]["depthGeometryConfigRevision"] = 1
        cases.append(wrong_marker_revision)
        wrong_group_hash = copy.deepcopy(self.completed_manifest())
        wrong_group_hash["defectGroups"]["geometry"]["configHash"] = "old"
        cases.append(wrong_group_hash)
        wrong_group_revision = copy.deepcopy(self.completed_manifest())
        wrong_group_revision["defectGroups"]["geometry"]["algorithmRevision"] = 1
        cases.append(wrong_group_revision)
        for manifest in cases:
            with self.subTest(manifest=manifest):
                self.assertFalse(
                    can_skip_history_backfill(
                        manifest, 64, "geometry-hash-v2", 2
                    )
                )

    def test_incomplete_database_or_crop_backfill_is_rebuilt(self) -> None:
        database_failed = copy.deepcopy(self.completed_manifest())
        database_failed["databaseImport"]["state"] = "failed"
        crop_too_small = copy.deepcopy(self.completed_manifest())
        crop_too_small["historyBackfill"]["minimumCropSize"] = 32
        for manifest in (database_failed, crop_too_small):
            with self.subTest(manifest=manifest):
                self.assertFalse(
                    can_skip_history_backfill(
                        manifest, 64, "geometry-hash-v2", 2
                    )
                )


if __name__ == "__main__":
    unittest.main()
