from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.import_sick_pj_calibration import _matrix, import_bundle
from scripts.sick_capture.measurement import _load_calibration, _matrix_for


class SickPjCalibrationImportTests(unittest.TestCase):
    def test_rotation_matrix_matches_array_coordinate_convention(self) -> None:
        matrix = _matrix(90.0, -24.0, -95.0)
        self.assertAlmostEqual(matrix[0][0], 0.0, places=8)
        self.assertAlmostEqual(matrix[0][2], -1.0, places=8)
        self.assertAlmostEqual(matrix[2][0], 1.0, places=8)
        self.assertEqual(matrix[0][3], -24.0)
        self.assertEqual(matrix[2][3], -95.0)

    def test_real_bundle_import_is_measurement_compatible_when_available(self) -> None:
        source = Path(r"K:\PJ-bm(2)\PJ-bm")
        if not source.is_dir():
            self.skipTest("site PJ calibration bundle is not mounted")
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "calibration"
            report = import_bundle(
                source,
                output,
                revision="TEST-PJ-IMPORT",
                approved=True,
                approved_by="unit-test",
            )
            self.assertTrue(report["qualityGate"]["passed"])
            self.assertEqual(report["cameraCount"], 6)
            self.assertEqual(report["verifiedFramePairCount"], 18)
            calibration = _load_calibration(output / "array-calibration.json")
            matrix = _matrix_for(calibration, "C1", "25440062")
            self.assertIsNotNone(matrix)
            self.assertAlmostEqual(float(matrix[0, 3]), -24.6337, places=4)
            self.assertTrue((output / "ArrayCalibration.xml").is_file())


if __name__ == "__main__":
    unittest.main()
