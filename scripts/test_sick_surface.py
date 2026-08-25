from __future__ import annotations

import math
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from scripts.sick_capture.measurement import MeasurementConfig, _profile
from scripts.sick_capture.surface import (
    _anchor_mapping_quality,
    _binned_section,
    _calibration_fixed_angle_deg,
    _camera_overlap_consistency,
    _camera_tile_payload,
    jet_rgb,
)


class SickSurfaceTests(unittest.TestCase):
    def test_jet_palette_has_expected_cold_mid_hot_order(self) -> None:
        self.assertEqual(jet_rgb(0.0), (0, 0, 128))
        self.assertEqual(jet_rgb(0.5), (128, 255, 128))
        self.assertEqual(jet_rgb(1.0), (128, 0, 0))

    def test_circle_points_are_binned_as_metric_radial_residuals(self) -> None:
        angles = (np.arange(72, dtype=np.float64) + 0.5) * 2.0 * math.pi / 72
        radial_error = np.where(np.arange(72) == 9, 0.75, 0.0)
        radii = 50.0 + radial_error
        points = np.column_stack((
            3.0 + radii * np.cos(angles),
            -4.0 + radii * np.sin(angles),
        ))
        grid, counts = _binned_section(
            points,
            {"available": True, "centerX": 3.0, "centerZ": -4.0, "radiusMm": 50.0},
            72,
        )
        self.assertGreaterEqual(int(np.count_nonzero(np.isfinite(grid))), 70)
        self.assertAlmostEqual(float(np.nanmax(grid)), 0.75, places=6)
        self.assertEqual(int(np.sum(counts)), 72)

    def test_anchor_quality_uses_interpolated_scan_row_residual(self) -> None:
        passed, residual, reasons = _anchor_mapping_quality(
            {
                "available": True,
                "rowClipped": False,
                "timeResidualMs": -240.0,
                "interpolationResidualMs": 0.025,
            },
            40.0,
        )
        self.assertTrue(passed)
        self.assertEqual(residual, 0.025)
        self.assertEqual(reasons, [])

        passed, _, reasons = _anchor_mapping_quality(
            {
                "available": True,
                "rowClipped": False,
                "interpolationResidualMs": 41.0,
            },
            40.0,
        )
        self.assertFalse(passed)
        self.assertIn("sync-row-residual-out-of-tolerance", reasons)

    def test_camera_tile_is_row_major_and_aligned_to_stable_2d_crop(self) -> None:
        samples = [
            {
                "available": True,
                "anchorOrdinal": 2,
                "elapsedFromHeadMs": 10.0,
                "storageIndex": 4,
                "sourceRow": 7,
                "sourceShape": [100, 50],
                "frameCropBox": [8, 0, 22, 50],
                "mappingMetricValid": True,
                "acceptedForSurface": True,
                "residualByColumn": {12: -0.1, 13: 0.2},
                "angleByColumn": {12: 35.0, 13: 36.0},
                "sampleCountByColumn": {12: 2, 13: 1},
            },
            {
                "available": True,
                "anchorOrdinal": 3,
                "elapsedFromHeadMs": 20.0,
                "storageIndex": 5,
                "sourceRow": 8,
                "sourceShape": [100, 50],
                "frameCropBox": [9, 0, 21, 50],
                "mappingMetricValid": True,
                "acceptedForSurface": True,
                "residualByColumn": {12: 0.3},
                "angleByColumn": {12: 37.0},
                "sampleCountByColumn": {12: 1},
            },
        ]
        region_map = {
            "manifestPath": "regions.json",
            "cameras": {
                "C1": {
                    "sourceSize": [100, 50],
                    "stableCrop": [10, 0, 20, 50],
                    "ownedColumnIntervals": [[10.0, 18.0]],
                    "overlapColumnIntervals": [[18.0, 20.0]],
                }
            },
        }
        tile, grid = _camera_tile_payload(
            "C1",
            samples,
            region_map=region_map,
            fixed_angle_deg=120.0,
            display_range_mm=0.5,
        )
        self.assertEqual(tile["cropBox"], [10, 0, 20, 50])
        self.assertEqual((tile["rows"], tile["columns"]), (2, 10))
        self.assertAlmostEqual(float(grid[0, 2]), -0.1)
        self.assertAlmostEqual(float(grid[1, 2]), 0.3)
        self.assertEqual(tile["rowAnchors"][0]["sourceGlobalRow"], 207)
        self.assertEqual(tile["defectMapping"]["coordinateSpace"], "source-image-pixels")
        self.assertEqual(tile["coverage"]["overlapColumnIntervals"], [[18.0, 20.0]])

    def test_overlap_consistency_reports_calibration_stitching_error(self) -> None:
        left_angles = np.radians(np.arange(0.5, 101.0, 1.0))
        right_angles = np.radians(np.arange(80.5, 181.0, 1.0))
        left = np.column_stack((50.0 * np.cos(left_angles), 50.0 * np.sin(left_angles)))
        right_radius = np.where(np.degrees(right_angles) < 101.0, 50.2, 50.0)
        right = np.column_stack(
            (right_radius * np.cos(right_angles), right_radius * np.sin(right_angles))
        )
        fit = {"available": True, "centerX": 0.0, "centerZ": 0.0, "radiusMm": 50.0}
        failed = _camera_overlap_consistency({"C1": left, "C2": right}, fit, 360, 0.1)
        self.assertFalse(failed["metricValid"])
        self.assertGreaterEqual(failed["sampleCount"], 20)
        self.assertAlmostEqual(failed["p95AbsRadialDifferenceMm"], 0.2, places=6)
        passed = _camera_overlap_consistency({"C1": left, "C2": right}, fit, 360, 0.3)
        self.assertTrue(passed["metricValid"])

    def test_profile_uses_grayscale_crop_before_metric_projection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("2d", "3d", "json"):
                (root / name).mkdir()
            intensity = np.zeros((16, 100), dtype=np.uint8)
            intensity[:, 30:70] = 60
            # Valid static depth deliberately fills the full sensor. It must
            # not leak into the surface profile outside the grayscale bar ROI.
            depth = np.full((16, 100), 1000, dtype=np.uint16)
            Image.fromarray(intensity, mode="L").save(root / "2d" / "0.png")
            np.savez_compressed(root / "3d" / "0.npz", array=depth)
            (root / "json" / "0.json").write_text(
                json.dumps(
                    {
                        "cameraSerialNumber": "S1",
                        "bdConfig": {
                            "CoordinateA": {
                                "Scan3dCoordinateScale": 0.1,
                                "Scan3dCoordinateOffset": -5.0,
                            },
                            "CoordinateC": {
                                "Scan3dCoordinateScale": 0.01,
                                "Scan3dCoordinateOffset": -10.0,
                                "Scan3dInvalidDataValue": 0,
                            },
                        },
                    }
                ),
                encoding="utf-8",
            )
            _points, details = _profile(
                root, 0, 8, MeasurementConfig(maximum_profile_points=100)
            )
            left, _top, right, _bottom = details["cropBox"]
            self.assertGreater(left, 0)
            self.assertLess(right, 100)
            self.assertTrue(
                all(left <= column < right for column in details["validProfileColumns"])
            )

    def test_calibration_fixed_angle_comes_from_extrinsic_not_camera_number(self) -> None:
        angle = math.radians(60.0)
        matrix = np.eye(4, dtype=np.float64)
        matrix[0, 2] = math.cos(angle)
        matrix[2, 2] = math.sin(angle)
        self.assertAlmostEqual(_calibration_fixed_angle_deg(matrix), 60.0, places=6)


if __name__ == "__main__":
    unittest.main()
