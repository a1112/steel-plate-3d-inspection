from __future__ import annotations

import copy
import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("validate_optical_acceptance.py")
SPEC = importlib.util.spec_from_file_location("validate_optical_acceptance", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class OpticalAcceptanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.baseline = MODULE._load_json(MODULE.DEFAULT_BASELINE)

    def test_checked_in_fat_baseline_is_internally_consistent(self) -> None:
        report = MODULE.build_report(MODULE.DEFAULT_BASELINE, self.baseline)
        self.assertTrue(report["baseline"]["passed"])
        self.assertFalse(report["runtime"]["checked"])

    def test_height_error_outside_tolerance_fails_closed(self) -> None:
        changed = copy.deepcopy(self.baseline)
        changed["threeDimensional"]["heightBlockMeasurements"][0]["measuredMm"] = 50.1001
        failures = MODULE.validate_baseline(changed)
        self.assertTrue(any("height error" in failure for failure in failures))

    def test_live_gate_requires_six_synchronized_physical_cameras_and_clean_queue(self) -> None:
        health = {
            "provider": "external-api",
            "driverId": "sick-gentl-harvesters",
            "ready": True,
            "sdkReady": True,
            "cameraCount": 6,
            "framesFailed": 0,
            "acquisitionSynchronization": {
                "status": "synchronized",
                "synchronized": True,
                "frameCountSkew": 0,
                "transportFrameGaps": 0,
            },
            "storageQueue": {"droppedRounds": 0, "failedRounds": 0},
            "databaseCommit": {"failedBatches": 0},
        }
        self.assertEqual(MODULE.validate_live_health(health, self.baseline), [])
        health["acquisitionSynchronization"]["frameCountSkew"] = 1
        self.assertTrue(
            any("frame-count skew" in failure for failure in MODULE.validate_live_health(health, self.baseline))
        )
        health["acquisitionSynchronization"]["frameCountSkew"] = 0
        health["acquisitionSynchronization"]["transportFrameGaps"] = 1
        self.assertTrue(
            any("transport frame IDs" in failure for failure in MODULE.validate_live_health(health, self.baseline))
        )
        health["acquisitionSynchronization"]["transportFrameGaps"] = 0
        health["framesFailed"] = 1
        self.assertTrue(
            any("camera acquisition failed" in failure for failure in MODULE.validate_live_health(health, self.baseline))
        )
        health["framesFailed"] = 0
        health["databaseCommit"]["failedBatches"] = 1
        self.assertTrue(
            any("database callback" in failure for failure in MODULE.validate_live_health(health, self.baseline))
        )


if __name__ == "__main__":
    unittest.main()
