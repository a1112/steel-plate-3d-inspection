from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.rebuild_sick_flow_storage import (
    _camera_roots,
    _database_sql,
    _rewrite_database,
    build_plan,
    rebuild,
)


class SickFlowStorageRebuildTests(unittest.TestCase):
    def test_plan_removes_repeated_capture_and_camera_directories(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            disk = root / "disk"
            legacy = disk / "steel-sick-data"
            for flow_id in ("63", "FLOW-0000000064"):
                flow = legacy / flow_id / "capture" / "C1"
                (flow / "2d").mkdir(parents=True)
                (flow / "camera_config.json").write_text("{}", encoding="utf-8")
            roots = {"C1": disk / "C1"}
            plan = build_plan(roots, legacy)
            self.assertEqual(len(plan), 1)
            self.assertEqual(plan[0].target, disk / "C1" / "63")
            self.assertTrue(all(row.flow_id == "63" for row in plan))

    def test_dry_run_accepts_shared_camera_disk(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            disk = root / "disk"
            legacy = disk / "steel-sick-data"
            for camera_id in ("C1", "C6"):
                (legacy / "9" / "capture" / camera_id / "json").mkdir(parents=True)
            profile = {
                "schema": "steel.capture.profile.v2",
                "storageRoot": str(legacy),
                "cameras": [
                    {"id": "C1", "storageRoot": str(disk / "C1"), "enabled": True},
                    {"id": "C6", "storageRoot": str(disk / "C6"), "enabled": True},
                ],
            }
            path = root / "capture.json"
            path.write_text(json.dumps(profile), encoding="utf-8")
            result = rebuild(path, None, execute=False)
            self.assertEqual(result["moveCount"], 2)
            self.assertEqual(_camera_roots(profile)["C1"], (disk / "C1").resolve())

    def test_database_rewrite_uses_direct_camera_flow_subdirectories(self) -> None:
        sql = _database_sql(Path(r"D:\steel-sick-data"), {"C1": Path(r"D:\C1")})
        self.assertIn("flow_no::text", sql)
        self.assertIn("('C1','D:\\C1\\')", sql)
        self.assertNotIn("'\\capture\\'", sql)
        self.assertIn("'3d\\'", sql)
        self.assertIn("FROM steel_flow AS flow", sql)
        self.assertIn("ELSE 'json\\'", sql)
        self.assertIn("ELSE '.json'", sql)
        self.assertIn("DELETE FROM steel_flow_region", sql)

    def test_execute_moves_raw_flow_on_volume_and_removes_empty_wrappers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / "steel-sick-data"
            source = legacy / "63" / "capture" / "C1"
            for name in ("2d", "3d", "json"):
                (source / name).mkdir(parents=True)
            (source / "2d" / "0.png").write_bytes(b"raw")
            target_root = root / "C1"
            profile = {
                "schema": "steel.capture.profile.v2",
                "storageRoot": str(legacy),
                "cameras": [
                    {"id": "C1", "storageRoot": str(target_root), "enabled": True}
                ],
            }
            profile_path = root / "capture.json"
            profile_path.write_text(json.dumps(profile), encoding="utf-8")

            with (
                patch("scripts.rebuild_sick_flow_storage._port_open", return_value=False),
                patch("scripts.rebuild_sick_flow_storage._rebuild_events", return_value=(1, 1)),
                patch(
                    "scripts.rebuild_sick_flow_storage.rebuild_playback_history",
                    return_value={"materialCount": 1, "frameCount": 1},
                ),
            ):
                result = rebuild(profile_path, None, execute=True)

            self.assertEqual(result["schema"], "steel.camera-storage-rebuild.v3")
            self.assertTrue((target_root / "63" / "2d" / "0.png").is_file())
            self.assertFalse(source.exists())
            self.assertFalse((legacy / "63" / "capture").exists())

    def test_database_rewrite_accepts_split_postgres_environment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / "postgres.env"
            env_path.write_text(
                "\n".join(
                    (
                        "STEEL_POSTGRES_HOST=127.0.0.1",
                        "STEEL_POSTGRES_PORT=5432",
                        "STEEL_POSTGRES_USER=steel",
                        "STEEL_POSTGRES_PASSWORD=secret",
                        "STEEL_POSTGRES_DATABASE=inspection",
                        "STEEL_POSTGRES_SSL_MODE=disable",
                    )
                ),
                encoding="utf-8",
            )
            with patch("scripts.rebuild_sick_flow_storage.subprocess.run") as run:
                _rewrite_database(env_path, "SELECT 1;")

            command = run.call_args.args[0]
            self.assertIn("127.0.0.1", command)
            self.assertIn("inspection", command)
            self.assertNotIn("secret", command)
            self.assertEqual(run.call_args.kwargs["env"]["PGPASSWORD"], "secret")


if __name__ == "__main__":
    unittest.main()
