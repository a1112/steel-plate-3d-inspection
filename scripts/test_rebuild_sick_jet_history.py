from __future__ import annotations

import argparse
import concurrent.futures
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

import rebuild_sick_jet_history as history
from sick_capture.alignment import AlignmentConfig
from sick_capture.material_lock import material_job_lock_path
from sick_capture.measurement import MeasurementConfig


class InlineExecutor:
    def __init__(self, *args: object, **kwargs: object) -> None:
        pass

    def __enter__(self) -> "InlineExecutor":
        return self

    def __exit__(self, *args: object) -> None:
        pass

    def submit(self, function: object, *args: object) -> concurrent.futures.Future:
        future: concurrent.futures.Future = concurrent.futures.Future()
        try:
            future.set_result(function(*args))  # type: ignore[operator]
        except BaseException as error:
            future.set_exception(error)
        return future


class RebuildSickJetHistoryTests(unittest.TestCase):
    def test_skip_ready_treats_concurrently_finalized_renditions_as_complete(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = root / "profile.json"
            profile.write_text("{}", encoding="utf-8")
            status_path = root / "status.json"
            args = argparse.Namespace(
                profile=profile,
                workers=1,
                minimum_material=0,
                maximum_material=0,
                limit=0,
                oldest_first=True,
                skip_ready=True,
            )
            with (
                patch.object(history, "_material_ids", return_value=(["41"], [])),
                patch.object(
                    history,
                    "_upgrade_existing_surface",
                    side_effect=history.MaterialJobLockedError("owned"),
                ),
                patch.object(history, "_rebuild_one") as rebuild,
                patch.object(
                    history.concurrent.futures,
                    "ProcessPoolExecutor",
                    InlineExecutor,
                ),
            ):
                exit_code = history._run(
                    args,
                    {"C1": root / "C1"},
                    root,
                    None,
                    AlignmentConfig(),
                    MeasurementConfig(),
                    status_path,
                    {"ownerPid": 123},
                )

            self.assertEqual(exit_code, 0)
            rebuild.assert_not_called()
            status = json.loads(status_path.read_text(encoding="utf-8"))
            self.assertEqual(status["state"], "complete")
            self.assertEqual(status["existingReady"], 1)
            self.assertEqual(status["total"], 0)

    def test_run_submits_the_current_rebuild_signature_and_publishes_owner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = root / "profile.json"
            profile.write_text("{}", encoding="utf-8")
            status_path = root / "status.json"
            args = argparse.Namespace(
                profile=profile,
                workers=1,
                minimum_material=0,
                maximum_material=0,
                limit=0,
                oldest_first=True,
                skip_ready=False,
            )
            owner = {"ownerPid": 123, "ownerStartToken": "owner-token"}
            result = {
                "materialId": "41",
                "state": "ready",
                "reason": "",
                "elapsedSeconds": 0.1,
            }
            with (
                patch.object(history, "_material_ids", return_value=(["41"], [])),
                patch.object(history, "_rebuild_one", return_value=result) as rebuild,
                patch.object(
                    history.concurrent.futures,
                    "ProcessPoolExecutor",
                    InlineExecutor,
                ),
            ):
                exit_code = history._run(
                    args,
                    {"C1": root / "C1"},
                    root,
                    None,
                    AlignmentConfig(),
                    MeasurementConfig(),
                    status_path,
                    owner,
                )

            self.assertEqual(exit_code, 0)
            self.assertEqual(len(rebuild.call_args.args), 6)
            self.assertEqual(rebuild.call_args.args[-1], "41")
            status = json.loads(status_path.read_text(encoding="utf-8"))
            self.assertEqual(status["state"], "complete")
            self.assertEqual(status["owner"], owner)

    def test_history_job_lock_rejects_a_second_live_owner_and_cleans_up(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = root / "profile.json"
            profile.write_text("{}", encoding="utf-8")
            status_path = root / "jobs" / "status.json"
            lock_path = status_path.with_suffix(".lock")

            with history._job_lock(status_path, profile):
                self.assertTrue(lock_path.is_file())
                with self.assertRaises(history.JetHistoryLockError):
                    with history._job_lock(status_path, profile):
                        pass

            self.assertFalse(lock_path.exists())

    def test_existing_surface_upgrade_uses_material_lock_and_commit_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            surface = {"materialId": "41", "mesh": {}, "sections": []}
            writes: list[dict[str, object]] = []

            def record_summary(_path: Path, payload: dict[str, object]) -> None:
                writes.append(dict(payload))

            with (
                patch.object(history, "_jet_ready", return_value=True),
                patch.object(history, "_read_json", return_value=surface),
                patch.object(history, "_flow_region_map", return_value=({}, "")),
                patch.object(
                    history,
                    "_surface_uses_local_region_manifest",
                    return_value=True,
                ),
                patch.object(
                    history,
                    "upgrade_surface_display_contract",
                    return_value=(True, True),
                ),
                patch.object(history, "_write_surface_measurement"),
                patch.object(history, "atomic_summary", side_effect=record_summary),
            ):
                result = history._upgrade_existing_surface(
                    {"C1": root / "C1"}, root, "41"
                )

            self.assertTrue(result["ready"])
            self.assertTrue(result["upgraded"])
            self.assertFalse(material_job_lock_path(root, "41").exists())
            states = [row.get("state") for row in writes if row.get("state")]
            self.assertEqual(states, ["processing", "derived-ready"])


if __name__ == "__main__":
    unittest.main()
