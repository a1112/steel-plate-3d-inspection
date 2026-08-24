from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.rebuild_sick_flow_storage import (
    _camera_roots,
    _database_sql,
    build_plan,
    rebuild,
)


class SickFlowStorageRebuildTests(unittest.TestCase):
    def test_plan_is_numeric_flow_first_and_has_no_flow_compatibility(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            disk = root / "disk"
            legacy = disk / "C1"
            for flow_id in ("63", "FLOW-0000000064"):
                flow = legacy / flow_id
                (flow / "2d").mkdir(parents=True)
                (flow / "camera_config.json").write_text("{}", encoding="utf-8")
            roots = {"C1": disk}
            plan = build_plan(roots)
            self.assertEqual(len(plan), 4)
            self.assertTrue(
                all("63\\capture\\C1" in str(row.target) for row in plan)
            )
            self.assertTrue(all(row.flow_id == "63" for row in plan))

    def test_dry_run_accepts_shared_camera_disk(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            disk = root / "disk"
            for camera_id in ("C1", "C6"):
                (disk / camera_id / "9" / "json").mkdir(parents=True)
            profile = {
                "schema": "steel.capture.profile.v2",
                "storageRoot": str(disk),
                "cameras": [
                    {"id": "C1", "storageRoot": str(disk), "enabled": True},
                    {"id": "C6", "storageRoot": str(disk), "enabled": True},
                ],
            }
            path = root / "capture.json"
            path.write_text(json.dumps(profile), encoding="utf-8")
            result = rebuild(path, None, execute=False)
            self.assertEqual(result["moveCount"], 8)
            self.assertEqual(_camera_roots(profile)["C1"], disk.resolve())

    def test_database_rewrite_uses_flow_and_camera_subdirectories(self) -> None:
        sql = _database_sql(Path(r"D:\steel-sick-data"), {"C1": Path(r"D:\steel-sick-data")})
        self.assertIn("flow_no::text", sql)
        self.assertIn("('C1','D:\\steel-sick-data\\')", sql)
        self.assertIn("'\\capture\\' || image.camera_id", sql)
        self.assertIn("'3d\\'", sql)
        self.assertIn("FROM steel_flow AS flow", sql)
        self.assertIn("ELSE 'json\\'", sql)
        self.assertIn("ELSE '.json'", sql)
        self.assertIn("DELETE FROM steel_flow_region", sql)


if __name__ == "__main__":
    unittest.main()
