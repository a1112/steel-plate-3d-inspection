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
    _camera_radial_quality,
    _camera_tile_payload,
    _head_aligned_longitudinal_axis,
    _write_jet_image,
    apply_surface_quality_gate,
    jet_rgb,
    measurement_artifact_from_surface,
    upgrade_surface_display_contract,
)
from scripts.sick_capture.paths import camera_surface_jet_path, surface_jet_path


class SickSurfaceTests(unittest.TestCase):
    def test_historical_surface_upgrade_builds_cross_sections_and_diameter_curves(self) -> None:
        rows = 3
        columns = 12
        positions: list[float] = []
        sections: list[dict[str, object]] = []
        for row in range(rows):
            for column in range(columns):
                angle = (column + 0.5) * 2.0 * math.pi / columns
                radius = 50.0 + (0.2 if column == 1 else 0.0)
                positions.extend([radius * math.cos(angle), row * 10.0, radius * math.sin(angle)])
            sections.append({
                "anchorOrdinal": row + 4,
                "elapsedFromHeadMs": row * 100.0,
                "acceptedForSurface": True,
                "mappingComplete": True,
                "mappingMetricValid": True,
                "qualityGate": {"passed": True, "reasons": []},
                "circleFit": {
                    "available": True,
                    "centerX": 0.0,
                    "centerZ": 0.0,
                    "radiusMm": 50.0,
                    "diameterMm": 100.0,
                },
            })
        surface = {
            "schema": "steel.ranger3-flow-surface.v1",
            "materialId": "4034",
            "quality": {"crossSectionMetricValid": True},
            "sections": sections,
            "mesh": {
                "rows": rows,
                "columns": columns,
                "positions": positions,
                "colors": [0.0] * rows * columns * 3,
                "validMask": [1] * rows * columns,
                "indices": [],
                "longitudinal": {"displayUnit": "preview", "absoluteScaleVerified": False},
            },
            "jet": {"palette": "JET"},
        }

        usable, changed = upgrade_surface_display_contract(surface)

        self.assertTrue(usable)
        self.assertTrue(changed)
        self.assertEqual(surface["mesh"]["pointUnit"], "mm")
        self.assertGreater(len(surface["mesh"]["indices"]), 0)
        self.assertEqual(len(surface["crossSections"]["sections"]), rows)
        self.assertAlmostEqual(
            surface["crossSections"]["sections"][1]["longitudinalDisplayPosition"],
            10.0,
        )
        self.assertEqual(surface["diameterCurves"]["displayMode"], "metric")

    def test_measurement_artifact_reuses_authoritative_surface_diameter_curves(self) -> None:
        curves = {
            "metricValid": True,
            "sections": [
                {"anchorOrdinal": 4, "positionRatio": 0.0},
                {"anchorOrdinal": 5, "positionRatio": 1.0},
            ],
            "series": [{"id": "average", "valuesMm": [45.0, 45.2]}],
            "summary": {"averageMm": 45.1},
        }
        surface = {
            "schema": "steel.ranger3-flow-surface.v1",
            "materialId": "88",
            "state": "ready",
            "quality": {
                "crossSectionMetricValid": True,
                "metricProjectionVerified": True,
                "reasons": [],
            },
            "summary": {
                "diameterMeanMm": 45.1,
                "diameterMinimumMm": 45.0,
                "diameterMaximumMm": 45.2,
                "diameterStdDevMm": 0.1,
            },
            "diameterCurves": curves,
            "sections": [
                {
                    "anchorOrdinal": 4,
                    "elapsedFromHeadMs": 10.0,
                    "mappingComplete": True,
                    "mappingMetricValid": True,
                    "acceptedForSurface": True,
                    "qualityGate": {"passed": True, "reasons": []},
                    "circleFit": {"available": True, "diameterMm": 45.0},
                },
                {
                    "anchorOrdinal": 5,
                    "elapsedFromHeadMs": 20.0,
                    "mappingComplete": True,
                    "mappingMetricValid": True,
                    "acceptedForSurface": True,
                    "qualityGate": {"passed": True, "reasons": []},
                    "circleFit": {"available": True, "diameterMm": 45.2},
                },
            ],
        }
        measurement = measurement_artifact_from_surface(surface)
        self.assertEqual(measurement["materialId"], "88")
        self.assertTrue(measurement["metricValid"])
        self.assertIs(measurement["surfaceFit"]["diameterCurves"], curves)
        self.assertEqual(measurement["surfaceFit"]["sectionsAccepted"], 2)
        self.assertEqual(measurement["surfaceFit"]["sections"][1]["positionRatio"], 1.0)

    def test_measurement_artifact_fails_closed_without_metric_projection_proof(self) -> None:
        surface = {
            "schema": "steel.ranger3-flow-surface.v1",
            "materialId": "88",
            "quality": {"crossSectionMetricValid": True, "reasons": []},
            "sections": [],
        }

        measurement = measurement_artifact_from_surface(surface)

        self.assertFalse(measurement["metricValid"])
        self.assertEqual(measurement["mode"], "preview")
        self.assertIn(
            "metric-projection-unverified",
            measurement["qualityGate"]["reasons"],
        )

    def test_surface_quality_failure_downgrades_aggregate_measurement(self) -> None:
        measurement = {
            "mode": "metric",
            "metricValid": True,
            "qualityGate": {"passed": True, "reasons": []},
        }

        apply_surface_quality_gate(
            measurement,
            {"quality": {"crossSectionMetricValid": False}},
        )

        self.assertFalse(measurement["metricValid"])
        self.assertEqual(measurement["mode"], "preview")
        self.assertFalse(measurement["qualityGate"]["passed"])
        self.assertEqual(
            measurement["qualityGate"]["reasons"],
            ["surface-quality-gate-failed"],
        )

    def test_camera_radial_quality_separates_depth_precision_from_calibration_bias(self) -> None:
        angles = np.linspace(0.0, 2.0 * math.pi, 120, endpoint=False)
        radii = 10.2 + 0.05 * np.sin(angles * 7.0)
        points = np.column_stack((radii * np.cos(angles), radii * np.sin(angles)))
        fit = {"available": True, "centerX": 0.0, "centerZ": 0.0, "radiusMm": 10.0}

        relaxed = _camera_radial_quality(points, fit, 0.3)
        self.assertTrue(relaxed["depthPrecisionMetricValid"])
        self.assertTrue(relaxed["calibrationBiasMetricValid"])
        self.assertAlmostEqual(relaxed["radialBiasMedianMm"], 0.2, places=5)
        self.assertLess(relaxed["depthPrecisionP95Mm"], 0.06)

        strict = _camera_radial_quality(points, fit, 0.1)
        self.assertTrue(strict["depthPrecisionMetricValid"])
        self.assertFalse(strict["calibrationBiasMetricValid"])
        self.assertFalse(strict["metricValid"])

    def test_jet_images_use_camera_local_jpeg_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "C3"
            camera_path = camera_surface_jet_path(root, "4018")
            combined_path = surface_jet_path(root, "4018")
            self.assertEqual(camera_path, root / "4018" / "jet" / "surface.jpg")
            self.assertEqual(combined_path, root / "4018" / "jet" / "surface-all.jpg")
            _write_jet_image(
                camera_path,
                np.asarray([[-0.2, 0.0, 0.2]], dtype=np.float64),
                0.2,
            )
            with Image.open(camera_path) as image:
                self.assertEqual(image.format, "JPEG")

    def test_longitudinal_axis_starts_at_first_complete_head_section(self) -> None:
        positions, metadata = _head_aligned_longitudinal_axis(
            [
                {"elapsedFromHeadMs": 0.0, "acceptedForSurface": False},
                {"elapsedFromHeadMs": 125.0, "acceptedForSurface": True},
                {"elapsedFromHeadMs": 625.0, "acceptedForSurface": True},
                {"elapsedFromHeadMs": 1000.0, "acceptedForSurface": False},
            ],
            200.0,
        )
        self.assertEqual(positions, [0.0, 0.0, 200.0, 200.0])
        self.assertEqual(metadata["originElapsedFromHeadMs"], 125.0)
        self.assertEqual(metadata["headTransitionTrimMs"], 125.0)
        self.assertFalse(metadata["absoluteScaleVerified"])

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

    def test_camera_tile_can_render_rejected_samples_as_diagnostic_jet(self) -> None:
        samples = [
            {
                "available": True,
                "elapsedFromHeadMs": 0.0,
                "sourceShape": [20, 10],
                "frameCropBox": [2, 0, 8, 10],
                "acceptedForSurface": False,
                "residualByColumn": {3: 0.25},
                "angleByColumn": {3: 90.0},
                "sampleCountByColumn": {3: 1},
            }
        ]
        region_map = {
            "cameras": {
                "C1": {"sourceSize": [20, 10], "stableCrop": [2, 0, 8, 10]}
            }
        }
        tile, grid = _camera_tile_payload(
            "C1",
            samples,
            region_map=region_map,
            fixed_angle_deg=90.0,
            display_range_mm=0.5,
            diagnostic_fallback=True,
        )
        self.assertAlmostEqual(float(grid[0, 1]), 0.25)
        self.assertEqual(tile["state"], "ready")
        self.assertEqual(tile["jet"]["source"], "diagnostic-unqualified")
        self.assertFalse(tile["jet"]["metricValid"])
        self.assertFalse(tile["rowAnchors"][0]["acceptedForSurface"])

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
        self.assertFalse(failed["pairs"][0]["metricValid"])
        self.assertIn(
            "calibrated-camera-pair-overlap-out-of-tolerance",
            failed["qualityGate"]["reasons"],
        )
        self.assertGreaterEqual(failed["sampleCount"], 20)
        self.assertAlmostEqual(failed["p95AbsRadialDifferenceMm"], 0.2, places=6)
        passed = _camera_overlap_consistency({"C1": left, "C2": right}, fit, 360, 0.3)
        self.assertTrue(passed["metricValid"])
        self.assertTrue(passed["pairs"][0]["metricValid"])

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
