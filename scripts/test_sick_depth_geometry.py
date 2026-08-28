from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
import weakref
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

from scripts.sick_capture import depth_geometry as depth_geometry_module
from scripts.sick_capture.depth_geometry import (
    DEPTH_GEOMETRY_CONFIG_SCHEMA,
    DEPTH_GEOMETRY_SCHEMA,
    DepthGeometryConfig,
    apply_depth_residual,
    build_flow_depth_geometry,
    config_hash,
    connected_components_8,
    convert_raw_depth,
    detect_depth_geometry,
    estimate_flow_baseline,
    intensity_roi,
    load_depth_geometry_config,
    residual_jet_roi,
    threshold_depth_residual,
)


class SickDepthGeometryTests(unittest.TestCase):
    @staticmethod
    def metadata() -> dict[str, object]:
        return {
            "bdConfig": {
                "CoordinateC": {
                    "Scan3dCoordinateScale": 0.01,
                    "Scan3dCoordinateOffset": -10.0,
                    "Scan3dInvalidDataValue": 0,
                }
            }
        }

    def test_config_json_and_hash_are_stable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "algorithm.json"
            path.write_text(
                json.dumps(
                    {
                        "schema": "steel.source-processing-config.v1",
                        "depthGeometry": {
                            "schema": DEPTH_GEOMETRY_CONFIG_SCHEMA,
                            "minimumDepthMm": 0.4,
                            "baselineMaxFrames": 99,
                            "roi": [2, 3, 20, 30],
                        },
                    }
                ),
                encoding="utf-8",
            )
            config = load_depth_geometry_config(path)
        self.assertEqual(config.schema, DEPTH_GEOMETRY_CONFIG_SCHEMA)
        self.assertEqual(config.minimum_depth_mm, 0.4)
        self.assertEqual(config.baseline_max_frames, 32)
        self.assertEqual(config.roi, (2, 3, 20, 30))
        self.assertEqual(config_hash(config), config_hash(config.to_dict()))

    def test_config_loader_rejects_unknown_schema(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"
            path.write_text(json.dumps({"schema": "wrong"}), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_depth_geometry_config(path)

    def test_seed_nested_threshold_groups_map_to_runtime_fields(self) -> None:
        config = DepthGeometryConfig.from_mapping(
            {
                "depthGeometry": {
                    "baseline": {"maximumFrames": 8, "rowSampleStep": 2},
                    "thresholds": {
                        "minimumAbsoluteDeviationMm": 0.5,
                        "columnNoiseMultiplier": 5,
                        "minimumNeighborhoodSupport": 4,
                        "minimumComponentPoints": 9,
                        "elongatedAspectRatio": 4,
                    },
                    "merge": {"maximumFrameGap": 3, "minimumIoU": 0.35},
                    "reviewCropMinimumSize": 96,
                }
            }
        )
        self.assertEqual(config.baseline_max_frames, 8)
        self.assertEqual(config.baseline_row_step, 2)
        self.assertEqual(config.minimum_depth_mm, 0.5)
        self.assertEqual(config.noise_multiplier, 5.0)
        self.assertEqual(config.minimum_support, 4)
        self.assertEqual(config.minimum_component_points, 9)
        self.assertEqual(config.elongated_aspect_ratio, 4.0)
        self.assertEqual(config.cross_frame_max_gap, 3)
        self.assertEqual(config.minimum_merge_iou, 0.35)
        self.assertEqual(config.review_crop_minimum_size, 96)

    def test_edge_guard_workers_and_candidate_cap_parse_and_bound(self) -> None:
        config = DepthGeometryConfig.from_mapping(
            {
                "longitudinalEdgeGuardFrames": 12,
                "cameraWorkers": 5,
                "maximumCandidatesPerFlow": 12,
            }
        )
        self.assertEqual(config.longitudinal_edge_guard_frames, 12)
        self.assertEqual(config.camera_workers, 5)
        self.assertEqual(config.maximum_candidates_per_flow, 12)
        self.assertEqual(
            DepthGeometryConfig(
                longitudinal_edge_guard_frames=-4,
                camera_workers=0,
            ).bounded().longitudinal_edge_guard_frames,
            0,
        )
        self.assertEqual(
            DepthGeometryConfig(
                longitudinal_edge_guard_frames=999,
                camera_workers=999,
            ).bounded().longitudinal_edge_guard_frames,
            64,
        )
        self.assertEqual(
            DepthGeometryConfig(
                longitudinal_edge_guard_frames=999,
                camera_workers=999,
            ).bounded().camera_workers,
            6,
        )
        self.assertEqual(
            DepthGeometryConfig(camera_workers=0).bounded().camera_workers,
            1,
        )
        self.assertEqual(
            DepthGeometryConfig(
                maximum_candidates_per_flow=999
            ).bounded().maximum_candidates_per_flow,
            100,
        )
        self.assertEqual(
            DepthGeometryConfig(
                maximum_candidates_per_flow=0
            ).bounded().maximum_candidates_per_flow,
            1,
        )
        defaults = DepthGeometryConfig()
        self.assertEqual(defaults.minimum_depth_mm, 1.2)
        self.assertEqual(defaults.minimum_component_points, 16)
        self.assertEqual(defaults.maximum_candidates_per_flow, 100)

    def test_candidate_groups_are_capped_before_roi_generation(self) -> None:
        settings = DepthGeometryConfig(maximum_candidates_per_flow=20)
        groups = [
            [
                {
                    "values": np.full(16, float(index + 1)),
                    "frameNumber": index,
                    "minRow": 0,
                    "minColumn": 0,
                    "polarity": "protrusion",
                }
            ]
            for index in range(25)
        ]
        selected, overflow = depth_geometry_module._limit_candidate_groups(
            groups, settings
        )
        self.assertEqual(len(selected), 20)
        self.assertEqual(overflow, 5)
        self.assertEqual(
            {int(group[0]["frameNumber"]) for group in selected},
            set(range(5, 25)),
        )

    def test_region_artifacts_are_filtered_before_candidate_cap(self) -> None:
        settings = DepthGeometryConfig(maximum_candidates_per_flow=100)
        groups = [
            [
                {
                    # Make the artifacts the strongest rows so a cap-first
                    # implementation would consume 70 review slots with them.
                    "values": np.full(16, float(1000 - index)),
                    "points": np.asarray([[0, index], [0, index + 1]]),
                    "frameNumber": index,
                    "polarity": "protrusion",
                }
            ]
            for index in range(150)
        ]

        def disposition(_camera_id: str, bbox: list[int]) -> str:
            if bbox[0] < 50:
                return "boundary"
            if bbox[0] < 70:
                return "overlap-duplicate"
            if bbox[0] < 80:
                return "quality-gate"
            return "owned"

        eligible, overlap_filtered, boundary_filtered, quality_gate_filtered = (
            depth_geometry_module._filter_candidate_groups_by_disposition(
                groups,
                camera_id="C1",
                roi=(0, 0, 256, 32),
                candidate_disposition=disposition,
            )
        )
        selected, overflow = depth_geometry_module._limit_candidate_groups(
            eligible, settings
        )

        self.assertEqual(boundary_filtered, 50)
        self.assertEqual(overlap_filtered, 20)
        self.assertEqual(quality_gate_filtered, 10)
        self.assertEqual(len(selected), 70)
        self.assertEqual(overflow, 0)
        self.assertEqual(
            {int(group[0]["frameNumber"]) for group in selected},
            set(range(80, 150)),
        )

    def test_raw_conversion_applies_scale_offset_and_invalid(self) -> None:
        raw = np.asarray([[0, 100, 200], [np.nan, 300, 400]], dtype=np.float32)
        values, valid = convert_raw_depth(raw, self.metadata())
        self.assertFalse(bool(valid[0, 0]))
        self.assertFalse(bool(valid[1, 0]))
        self.assertAlmostEqual(float(values[0, 1]), -9.0)
        self.assertAlmostEqual(float(values[1, 2]), -6.0)
        self.assertTrue(np.isnan(values[0, 0]))

    def test_baseline_uses_at_most_32_even_frames_and_mad_noise(self) -> None:
        frames = [np.full((12, 4), 10.0 + index * 0.1) for index in range(100)]
        baseline = estimate_flow_baseline(frames, max_frames=32, row_step=4)
        self.assertEqual(len(baseline.sampled_frame_indices), 32)
        self.assertEqual(baseline.sampled_frame_indices[0], 0)
        self.assertEqual(baseline.sampled_frame_indices[-1], 99)
        self.assertTrue(np.all(baseline.column_noise_mm > 0))
        self.assertAlmostEqual(float(np.median(baseline.baseline_mm)), 14.95, places=2)

    def test_row_median_drift_is_removed(self) -> None:
        values = np.full((5, 6), 10.0)
        values += np.arange(5, dtype=float)[:, None] * 0.5
        values[2, 2] += 1.0
        valid = np.ones_like(values, dtype=bool)
        residual = apply_depth_residual(values, valid, np.full(6, 10.0))
        self.assertAlmostEqual(float(np.median(residual[0])), 0.0)
        self.assertAlmostEqual(float(residual[2, 2]), 1.0)
        self.assertAlmostEqual(float(np.median(residual[4])), 0.0)

    def test_adaptive_threshold_and_support_gate(self) -> None:
        residual = np.zeros((5, 5), dtype=np.float32)
        residual[1:4, 1:4] = 0.4
        residual[0, 0] = 0.5  # isolated point must fail the 3x3 support rule
        valid = np.ones_like(residual, dtype=bool)
        mask, threshold = threshold_depth_residual(
            residual, valid, np.full(5, 0.1), minimum_depth_mm=0.35
        )
        self.assertTrue(np.all(threshold == 0.6))
        self.assertFalse(bool(mask[2, 2]))
        # With low noise the absolute floor is the active threshold.
        mask, threshold = threshold_depth_residual(
            residual, valid, np.full(5, 0.01), minimum_depth_mm=0.35
        )
        self.assertTrue(np.all(threshold == 0.35))
        self.assertTrue(bool(mask[2, 2]))
        self.assertFalse(bool(mask[0, 0]))

    def test_connected_components_are_8_neighbour(self) -> None:
        mask = np.zeros((4, 4), dtype=bool)
        mask[0, 0] = True
        mask[1, 1] = True
        mask[3, 3] = True
        components = connected_components_8(mask, minimum_points=1)
        self.assertEqual(sorted(len(value) for value in components), [1, 2])

    def _synthetic_frames(self) -> list[np.ndarray]:
        frames = [np.full((40, 60), 1000, dtype=np.float32) for _ in range(4)]
        # compact protrusion
        frames[1][8:12, 8:12] = 1050
        # elongated depression/groove
        frames[2][25:28, 35:49] = 940
        # One candidate crosses the real frame boundary: the last rows of
        # frame 0 continue at the first rows of frame 1.  Equal local rows in
        # separate blocks are not spatially adjacent.
        frames[0][36:40, 50:54] = 1050
        frames[1][0:4, 50:54] = 1050
        return frames

    def test_four_class_polarity_and_shape_with_stable_ids(self) -> None:
        frames = self._synthetic_frames()
        config = DepthGeometryConfig(
            minimum_depth_mm=0.35,
            minimum_component_points=6,
            calibration_valid=True,
            horizontal_pixel_pitch_mm=0.2,
        )
        first = detect_depth_geometry(
            frames,
            metadata=self.metadata(),
            frame_numbers=[10, 11, 12, 13],
            material_id="42",
            camera_id="C1",
            config=config,
        )
        second = detect_depth_geometry(
            frames,
            metadata=self.metadata(),
            frame_numbers=[10, 11, 12, 13],
            material_id="42",
            camera_id="C1",
            config=config,
        )
        self.assertEqual(first["schema"], DEPTH_GEOMETRY_SCHEMA)
        self.assertEqual(
            [item["id"] for item in first["defects"]],
            [item["id"] for item in second["defects"]],
        )
        classes = {item["class"] for item in first["defects"]}
        self.assertIn("bulge-compact", classes)
        self.assertIn("groove-elongated", classes)
        for item in first["defects"]:
            self.assertEqual(item["classId"], f"geometry-{item['class']}")
            self.assertEqual(item["className"], item["class"])
        crossing = next(
            item
            for item in first["defects"]
            if item["peakPixel"]["column"] >= 50
        )
        self.assertEqual(crossing["pointCount"], 32)
        self.assertEqual(crossing["frameStart"], 10)
        self.assertEqual(crossing["frameEnd"], 11)
        self.assertIsNone(crossing["longitudinalMm"])
        self.assertIsNone(crossing["areaMm2"])
        self.assertIsNotNone(crossing["horizontalCenterMm"])
        self.assertEqual(crossing["severity"], "review")
        self.assertTrue(crossing["reviewOnly"])

    @staticmethod
    def _boundary_frames(
        first_columns: tuple[int, int] = (8, 12),
        second_columns: tuple[int, int] | None = None,
        *,
        same_local_row: bool = False,
    ) -> list[np.ndarray]:
        frames = [np.full((12, 24), 1000.0, dtype=np.float32) for _ in range(2)]
        if second_columns is None:
            second_columns = first_columns
        if same_local_row:
            frames[0][4:6, first_columns[0] : first_columns[1]] = 1050.0
            frames[1][4:6, second_columns[0] : second_columns[1]] = 1050.0
        else:
            frames[0][-2:, first_columns[0] : first_columns[1]] = 1050.0
            frames[1][:2, second_columns[0] : second_columns[1]] = 1050.0
        return frames

    @staticmethod
    def _defect_summary(artifact: dict[str, object]) -> list[tuple[object, ...]]:
        return sorted(
            (
                int(item["pointCount"]),
                int(item["frameStart"]),
                int(item["frameEnd"]),
                int(item["pixelSpan"]["height"]),
                list(item["bbox"]),
                dict(item["peakPixel"]),
            )
            for item in artifact["defects"]
        )

    def test_cross_frame_same_local_row_is_not_merged(self) -> None:
        artifact = detect_depth_geometry(
            self._boundary_frames(same_local_row=True),
            metadata=self.metadata(),
            frame_numbers=[0, 1],
            config=DepthGeometryConfig(
                minimum_depth_mm=0.35,
                minimum_component_points=6,
                minimum_merge_iou=0.2,
                cross_frame_merge_pixels=1,
            ),
            include_roi_pixels=False,
        )
        self.assertEqual(len(artifact["defects"]), 2)
        self.assertTrue(all(item["frameStart"] == item["frameEnd"] for item in artifact["defects"]))

    def test_cross_frame_bottom_to_top_merges_in_both_entries(self) -> None:
        frames = self._boundary_frames()
        config = DepthGeometryConfig(
            minimum_depth_mm=0.35,
            minimum_component_points=6,
            minimum_merge_iou=0.2,
            cross_frame_merge_pixels=1,
        )
        memory_artifact = detect_depth_geometry(
            frames,
            metadata=self.metadata(),
            frame_numbers=[0, 1],
            config=config,
            include_roi_pixels=False,
        )
        self.assertEqual(len(memory_artifact["defects"]), 1)
        merged = memory_artifact["defects"][0]
        self.assertEqual(merged["pointCount"], 16)
        self.assertEqual(merged["frameStart"], 0)
        self.assertEqual(merged["frameEnd"], 1)
        self.assertEqual(merged["pixelSpan"]["height"], 4)
        # The source crop remains local to the peak frame (frame 0).
        self.assertEqual(merged["bbox"], [8, 10, 12, 12])
        self.assertEqual(merged["peakPixel"]["row"], 10)

        with tempfile.TemporaryDirectory() as directory:
            camera_root = Path(directory) / "camera"
            flow = camera_root / "9"
            (flow / "3d").mkdir(parents=True)
            (flow / "json").mkdir(parents=True)
            (flow / "2d").mkdir(parents=True)
            for index, frame in enumerate(frames):
                np.savez_compressed(flow / "3d" / f"{index}.npz", frame)
                (flow / "json" / f"{index}.json").write_text(
                    json.dumps(self.metadata()), encoding="utf-8"
                )
                Image.fromarray(np.zeros(frame.shape, dtype=np.uint8)).save(
                    flow / "2d" / f"{index}.png"
                )
            file_artifact = build_flow_depth_geometry(
                {"C1": camera_root},
                Path(directory) / "derived",
                "9",
                {},
                config,
            )
        self.assertEqual(
            self._defect_summary(memory_artifact),
            self._defect_summary(file_artifact["cameras"]["C1"]),
        )

    def test_cross_frame_horizontal_iou_threshold_blocks_merge(self) -> None:
        artifact = detect_depth_geometry(
            self._boundary_frames((2, 10), (8, 16)),
            metadata=self.metadata(),
            frame_numbers=[0, 1],
            config=DepthGeometryConfig(
                minimum_depth_mm=0.35,
                minimum_component_points=6,
                cross_frame_merge_pixels=1,
                minimum_merge_iou=0.3,
            ),
            include_roi_pixels=False,
        )
        # The intervals overlap by only 2/14 pixels, below the configured IoU.
        self.assertEqual(len(artifact["defects"]), 2)

    def test_unverified_calibration_keeps_horizontal_metric_null(self) -> None:
        frames = self._synthetic_frames()[:2]
        artifact = detect_depth_geometry(
            frames,
            metadata=self.metadata(),
            material_id="42",
            camera_id="C1",
            config=DepthGeometryConfig(horizontal_pixel_pitch_mm=0.2),
        )
        self.assertFalse(artifact["metric"]["horizontalValid"])
        for item in artifact["defects"]:
            self.assertIsNone(item["horizontalCenterMm"])

    def test_coordinate_a_metadata_provides_only_verified_horizontal_metric(self) -> None:
        metadata = self.metadata()
        metadata["bdConfig"]["CoordinateA"] = {
            "Scan3dCoordinateScale": 0.2,
            "Scan3dCoordinateOffset": -3.0,
        }
        artifact = detect_depth_geometry(
            self._synthetic_frames()[:2],
            metadata=metadata,
            material_id="42",
            camera_id="C1",
            config=DepthGeometryConfig(minimum_depth_mm=0.35),
        )
        self.assertTrue(artifact["metric"]["horizontalValid"])
        compact = next(
            item for item in artifact["defects"] if item["peakPixel"]["column"] == 8
        )
        self.assertAlmostEqual(
            float(compact["horizontalCenterMm"]), -1.0, places=4
        )

        metadata["bdConfig"]["CoordinateA"]["Scan3dCoordinateScale"] = 0
        artifact = detect_depth_geometry(
            self._synthetic_frames()[:2],
            metadata=metadata,
            material_id="42",
            camera_id="C1",
            config=DepthGeometryConfig(minimum_depth_mm=0.35),
        )
        self.assertFalse(artifact["metric"]["horizontalValid"])

    def test_roi_helpers_return_rgb_images_and_clip_edges(self) -> None:
        intensity = np.arange(25, dtype=np.uint8).reshape(5, 5)
        residual = np.linspace(-1.0, 1.0, 25).reshape(5, 5)
        intensity_image = intensity_roi(intensity, [0, 0, 2, 2], padding=4)
        jet_image = residual_jet_roi(residual, [0, 0, 2, 2], padding=4)
        self.assertEqual(intensity_image.shape, (5, 5, 3))
        self.assertEqual(jet_image.shape, (5, 5, 3))
        self.assertIsInstance(
            intensity_roi(intensity, [0, 0, 2, 2], as_image=True), Image.Image
        )
        self.assertIsInstance(
            residual_jet_roi(residual, [0, 0, 2, 2], as_image=True), Image.Image
        )

    def test_build_flow_loads_immutable_camera_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            camera_root = Path(directory) / "camera"
            flow = camera_root / "42"
            for name in ("2d", "3d", "json"):
                (flow / name).mkdir(parents=True)
            frames = self._synthetic_frames()[:2]
            for index, frame in enumerate(frames):
                np.savez_compressed(flow / "3d" / f"{index}.npz", frame)
                (flow / "json" / f"{index}.json").write_text(
                    json.dumps(self.metadata()), encoding="utf-8"
                )
                Image.fromarray(np.zeros(frame.shape, dtype=np.uint8)).save(
                    flow / "2d" / f"{index}.png"
                )
            artifact = build_flow_depth_geometry(
                {"C1": camera_root},
                Path(directory) / "derived",
                "42",
                {"cameras": {"C1": {}}},
                DepthGeometryConfig(
                    minimum_depth_mm=0.35,
                    minimum_component_points=6,
                ),
            )
        self.assertIn("C1", artifact["cameras"])
        self.assertEqual(artifact["statistics"]["frameCount"], 2)
        self.assertEqual(artifact["cameras"]["C1"]["cameraId"], "C1")
        for defect in artifact["defects"]:
            self.assertIsNotNone(defect["residualJetRoi"])

    def test_reliable_alignment_adds_temporal_edge_guard_but_clipped_keeps_bounds(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            camera_root = Path(directory) / "camera"
            flow = camera_root / "8"
            (flow / "3d").mkdir(parents=True)
            (flow / "json").mkdir(parents=True)
            # Frames 4 and 19 are transition candidates; frame 12 is the same
            # small defect in the stable interior.  The alignment boundaries
            # leave frames 2..21 eligible before the default eight-frame guard.
            for index in range(24):
                frame = np.full((24, 32), 1000, dtype=np.uint16)
                if index in (4, 12, 19):
                    frame[8:12, 12:16] = 1050
                np.savez_compressed(flow / "3d" / f"{index}.npz", frame)
                (flow / "json" / f"{index}.json").write_text(
                    json.dumps(self.metadata()), encoding="utf-8"
                )
            alignment = {
                "cameras": {
                    "C1": {
                        "head": {"detected": True, "frameIndex": 2, "clipped": False},
                        "tail": {"detected": True, "frameIndex": 21, "clipped": False},
                    }
                }
            }
            guarded = build_flow_depth_geometry(
                {"C1": camera_root},
                Path(directory) / "derived",
                "8",
                alignment,
                DepthGeometryConfig(
                    minimum_depth_mm=0.35,
                    minimum_component_points=6,
                ),
            )
            clipped_alignment = {
                "cameras": {
                    "C1": {
                        "head": {"detected": True, "frameIndex": 2, "clipped": True},
                        "tail": {"detected": True, "frameIndex": 21, "clipped": True},
                    }
                }
            }
            clipped = build_flow_depth_geometry(
                {"C1": camera_root},
                Path(directory) / "derived",
                "8",
                clipped_alignment,
                DepthGeometryConfig(
                    minimum_depth_mm=0.35,
                    minimum_component_points=6,
                ),
            )
        self.assertEqual(guarded["cameras"]["C1"]["statistics"]["frameCount"], 4)
        self.assertEqual([item["peakFrame"] for item in guarded["defects"]], [12])
        self.assertEqual(clipped["cameras"]["C1"]["statistics"]["frameCount"], 20)
        self.assertEqual(
            [item["peakFrame"] for item in clipped["defects"]],
            [4, 12, 19],
        )

    def test_clipped_alignment_still_applies_original_boundary_filter(self) -> None:
        indices = depth_geometry_module._aligned_frame_indices(
            list(range(10)),
            {
                "head": {"detected": True, "frameIndex": 2, "clipped": True},
                "tail": {"detected": True, "frameIndex": 7, "clipped": True},
            },
            8,
        )
        self.assertEqual(indices, [2, 3, 4, 5, 6, 7])

    def test_camera_workers_run_in_parallel_and_insert_sorted_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            material = "10"
            camera_roots: dict[str, Path] = {}
            for camera in ("C3", "C1", "C2"):
                flow = root / camera / material
                (flow / "3d").mkdir(parents=True)
                (flow / "json").mkdir(parents=True)
                camera_roots[camera] = root / camera

            lock = threading.Lock()
            active = 0
            peak_active = 0

            def fake_stream(**kwargs: object) -> dict[str, object]:
                nonlocal active, peak_active
                with lock:
                    active += 1
                    peak_active = max(peak_active, active)
                time.sleep(0.03)
                with lock:
                    active -= 1
                camera = str(kwargs["camera_id"])
                return {
                    "cameraId": camera,
                    "defects": [{"cameraId": camera}],
                    "statistics": {
                        "frameCount": 0,
                        "processedFrames": 0,
                        "candidateCount": 1,
                        "defectCount": 1,
                    },
                }

            with patch.object(
                depth_geometry_module,
                "_stream_camera_depth_geometry",
                side_effect=fake_stream,
            ):
                artifact = build_flow_depth_geometry(
                    camera_roots,
                    root / "derived",
                    material,
                    {},
                    DepthGeometryConfig(camera_workers=3),
                )
        self.assertGreaterEqual(peak_active, 2)
        self.assertEqual(list(artifact["cameras"]), ["C1", "C2", "C3"])
        self.assertEqual(
            [item["cameraId"] for item in artifact["defects"]],
            ["C1", "C2", "C3"],
        )
        self.assertEqual(artifact["statistics"]["candidateCount"], 3)

    def test_candidate_cap_is_global_across_cameras(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            camera_roots: dict[str, Path] = {}
            for camera in ("C1", "C2", "C3"):
                flow = root / camera / "11"
                (flow / "3d").mkdir(parents=True)
                (flow / "json").mkdir(parents=True)
                camera_roots[camera] = root / camera

            def fake_stream(**kwargs: object) -> dict[str, object]:
                camera = str(kwargs["camera_id"])
                defects = [
                    {
                        "id": f"{camera}-{index}",
                        "cameraId": camera,
                        "peakFrame": index,
                        "peakPixel": {"row": 0, "column": index},
                        "ruleScore": index / 10.0,
                        "p95AbsoluteDepthMm": float(index),
                        "absoluteDepthMm": float(index),
                        "pointCount": 16 + index,
                    }
                    for index in range(10)
                ]
                return {
                    "cameraId": camera,
                    "defects": defects,
                    "statistics": {
                        "frameCount": 0,
                        "processedFrames": 0,
                        "rawCandidateCount": 10,
                        "candidateCount": 10,
                        "candidateOverflowCount": 0,
                        "defectCount": 10,
                    },
                }

            with patch.object(
                depth_geometry_module,
                "_stream_camera_depth_geometry",
                side_effect=fake_stream,
            ):
                artifact = build_flow_depth_geometry(
                    camera_roots,
                    root / "derived",
                    "11",
                    {},
                    DepthGeometryConfig(maximum_candidates_per_flow=20),
                )
        self.assertEqual(artifact["statistics"]["rawCandidateCount"], 30)
        self.assertEqual(artifact["statistics"]["candidateCount"], 20)
        self.assertEqual(artifact["statistics"]["candidateOverflowCount"], 10)
        self.assertEqual(len(artifact["defects"]), 20)
        self.assertEqual(
            sum(len(value["defects"]) for value in artifact["cameras"].values()),
            20,
        )

    def test_file_builder_keeps_only_baseline_sample_and_current_depth_plane(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            camera_root = Path(directory) / "camera"
            flow = camera_root / "7"
            (flow / "3d").mkdir(parents=True)
            (flow / "json").mkdir(parents=True)
            frame_count = 96
            for index in range(frame_count):
                frame = np.full((24, 32), 1000, dtype=np.uint16)
                if index == 47:
                    frame[8:12, 12:16] = 1050
                np.savez_compressed(flow / "3d" / f"{index}.npz", frame)
                (flow / "json" / f"{index}.json").write_text(
                    json.dumps(self.metadata()), encoding="utf-8"
                )

            original = depth_geometry_module._prepare_frame
            live_arrays: list[weakref.ReferenceType[np.ndarray]] = []
            peak_live = 0

            def tracked_prepare(*args: object, **kwargs: object):
                nonlocal peak_live
                decoded = original(*args, **kwargs)
                live_arrays.append(weakref.ref(decoded.millimeters))
                peak_live = max(
                    peak_live,
                    sum(reference() is not None for reference in live_arrays),
                )
                return decoded

            with patch.object(
                depth_geometry_module,
                "_prepare_frame",
                side_effect=tracked_prepare,
            ):
                artifact = build_flow_depth_geometry(
                    {"C1": camera_root},
                    Path(directory) / "derived",
                    "7",
                    {"cameras": {"C1": {}}},
                    DepthGeometryConfig(
                        minimum_depth_mm=0.35,
                        minimum_component_points=6,
                    ),
                )
            self.assertEqual(artifact["statistics"]["frameCount"], frame_count)
            self.assertEqual(len(artifact["cameras"]["C1"]["baseline"]["sampledFrameIndices"]), 32)
            self.assertEqual(artifact["cameras"]["C1"]["baseline"]["sampledFrameIndices"][0], 0)
            self.assertEqual(artifact["cameras"]["C1"]["baseline"]["sampledFrameIndices"][-1], frame_count - 1)
            # The baseline pass may retain at most the configured 32 samples;
            # the second pass and ROI re-read use one current plane at a time.
            self.assertLessEqual(peak_live, 33)


if __name__ == "__main__":
    unittest.main()
