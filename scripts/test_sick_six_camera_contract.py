from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.sick_capture.alignment import build_flow_alignment
from scripts.sick_capture.measurement import build_flow_measurement


class SickSixCameraContractTests(unittest.TestCase):
    def test_alignment_and_measurement_derive_expected_count_from_six_roots(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            camera_roots = {
                f"C{camera}": root / f"camera-{camera}"
                for camera in range(1, 7)
            }

            alignment = build_flow_alignment(camera_roots, "63")
            measurement = build_flow_measurement(
                camera_roots,
                "63",
                alignment,
            )

        self.assertEqual(alignment["quality"]["expectedCameras"], 6)
        self.assertEqual(set(alignment["cameras"]), set(camera_roots))
        self.assertEqual(measurement["calibration"]["expectedCameras"], 6)
        self.assertNotEqual(measurement["calibration"]["expectedCameras"], 8)


if __name__ == "__main__":
    unittest.main()
