#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("bar_surface_reconstruct.py")
SPEC = importlib.util.spec_from_file_location("bar_surface_reconstruct", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def threshold_args(config_path: Path) -> argparse.Namespace:
    values = {argument_name: None for _, argument_name, _, _ in MODULE.ALGORITHM_THRESHOLD_BINDINGS}
    values["algorithm_config"] = str(config_path)
    return argparse.Namespace(**values)


def main() -> int:
    config_path = SCRIPT.parent.parent / "config" / "algorithm" / "bar-surface-production.json"
    args = threshold_args(config_path)
    config = MODULE.apply_algorithm_config(args, True)
    assert config["schema"] == "steel.algorithm-config.v1"
    assert config["algorithmVersion"] == "bar-surface-radial-residual-candidate-1.1.0"
    assert config["configRevision"] == "ALGCFG-2026-07-16-002"
    assert len(config["configSha256"]) == 64
    assert args.defect_min_depth_mm == 0.35

    override = threshold_args(config_path)
    override.defect_min_depth_mm = 99.0
    try:
        MODULE.apply_algorithm_config(override, True)
        raise AssertionError("production threshold override was accepted")
    except ValueError as error:
        assert "production threshold override is forbidden" in str(error)

    with tempfile.TemporaryDirectory(prefix="steel-algorithm-trace-") as temporary:
        root = Path(temporary)
        depth = root / "frame_depth.png"
        intensity = root / "frame_intensity.png"
        metadata = root / "frame_metadata.json"
        depth.write_bytes(b"depth-v1")
        intensity.write_bytes(b"intensity-v1")
        metadata.write_text('{"fid":1}', encoding="utf-8")
        frame = MODULE.CameraFrame("frame-001", depth, intensity, metadata, {"fid": 1})
        camera = MODULE.CameraInput("camera1", "127.0.0.1", "SN-1", root)
        prepared = MODULE.CameraPrepared(
            camera, [frame], depth, intensity, intensity, depth, metadata,
            (0, 0, 1, 1), "test", 1, 1, 1.0, 0.0,
        )
        first = MODULE.build_input_traceability([prepared], ["frame-001"])
        second = MODULE.build_input_traceability([prepared], ["frame-001"])
        assert first == second
        assert first["inputArtifactCount"] == 3
        assert len(first["inputArtifacts"]) == 3
        assert all(item["path"] and len(item["sha256"]) == 64 for item in first["inputArtifacts"])
        assert len(first["inputSummarySha256"]) == 64
        MODULE.assert_input_traceability_unchanged(first, [prepared], ["frame-001"])
        depth.write_bytes(b"depth-v2")
        changed = MODULE.build_input_traceability([prepared], ["frame-001"])
        assert changed["inputSummarySha256"] != first["inputSummarySha256"]
        try:
            MODULE.assert_input_traceability_unchanged(first, [prepared], ["frame-001"])
            raise AssertionError("input mutation was accepted")
        except ValueError as error:
            assert "changed while the run was in progress" in str(error)

    with tempfile.TemporaryDirectory(prefix="steel-algorithm-qualification-") as temporary:
        root = Path(temporary)
        calibration = root / "ArrayCalibration.xml"
        core = root / "steel_bar_surface_core.exe"
        report_path = root / "algorithm-acceptance.json"
        calibration.write_bytes(b"frozen-calibration")
        core.write_bytes(b"approved-core")
        calibration_sha = MODULE.sha256_file(calibration)
        report = {
            "schema": "steel.algorithm-acceptance.v1",
            "status": "pass",
            "algorithmName": config["algorithmName"],
            "algorithmVersion": config["algorithmVersion"],
            "configRevision": config["configRevision"],
            "configSha256": config["configSha256"],
            "scriptSha256": MODULE.sha256_file(SCRIPT),
            "coreSha256": MODULE.sha256_file(core),
            "releaseCommit": "a" * 40,
            "datasetRevision": "DATASET-TEST-1",
            "datasetSha256": "b" * 64,
            "evaluatorRevision": "EVALUATOR-TEST-1",
            "evaluatorSha256": "c" * 64,
            "calibrationRevision": f"sha256:{calibration_sha[:16]}",
            "calibrationSha256": calibration_sha,
            "metrics": {
                "detectionRecall": 0.99,
                "falsePositiveRate": 0.01,
                "missRate": 0.01,
                "localizationErrorMmP95": 0.1,
                "sizeErrorMmP95": 0.1,
                "endToEndLatencyMsP95": 100.0,
            },
            "acceptanceCriteria": {
                "minimumDetectionRecall": 0.98,
                "maximumFalsePositiveRate": 0.02,
                "maximumMissRate": 0.02,
                "maximumLocalizationErrorMmP95": 0.2,
                "maximumSizeErrorMmP95": 0.2,
                "maximumEndToEndLatencyMsP95": 200.0,
            },
            "approvals": {
                "algorithmOwner": "test-algorithm-owner",
                "qualityOwner": "test-quality-owner",
                "approvedAt": "2026-07-15T00:00:00Z",
            },
        }
        report_path.write_text(json.dumps(report), encoding="utf-8")
        environment = {
            "STEEL_ALGORITHM_ACCEPTANCE_REPORT": str(report_path),
            "STEEL_BAR_SURFACE_CORE_EXE": str(core),
            "STEEL_RELEASE_COMMIT": "a" * 40,
        }
        with patch.dict(os.environ, environment, clear=False):
            qualification = MODULE.load_algorithm_qualification(config, calibration, True)
            assert qualification["datasetRevision"] == "DATASET-TEST-1"
            assert qualification["acceptanceReportSha256"] == MODULE.sha256_file(report_path)
            core.write_bytes(b"tampered-core")
            try:
                MODULE.load_algorithm_qualification(config, calibration, True)
                raise AssertionError("tampered algorithm core was accepted")
            except ValueError as error:
                assert "coreSha256" in str(error)

    with tempfile.TemporaryDirectory(prefix="steel-defect-artifacts-") as temporary:
        root = Path(temporary)
        output_root = root / "algorithm"
        run_dir = output_root / "runs" / "MAT-1" / "RUN-1"
        camera_root = root / "camera1"
        frames = []
        for sequence in (1, 2):
            depth_path = camera_root / f"frame-{sequence:03d}-depth.png"
            intensity_path = camera_root / f"frame-{sequence:03d}-intensity.png"
            metadata_path = camera_root / f"frame-{sequence:03d}.json"
            depth_path.parent.mkdir(parents=True, exist_ok=True)
            MODULE.Image.fromarray(
                MODULE.np.full((16, 16), 1000 + sequence, dtype=MODULE.np.uint16)
            ).save(depth_path)
            MODULE.Image.fromarray(
                MODULE.np.arange(256, dtype=MODULE.np.uint8).reshape((16, 16))
            ).save(intensity_path)
            metadata_path.write_text(json.dumps({"sequenceNo": sequence}), encoding="utf-8")
            frames.append(MODULE.CameraFrame(
                f"frame-{sequence:03d}", depth_path, intensity_path, metadata_path, {"sequenceNo": sequence}
            ))
        camera = MODULE.CameraInput("camera1", "127.0.0.1", "SN-1", camera_root)
        prepared = MODULE.CameraPrepared(
            camera, frames, frames[-1].depth_path, frames[-1].intensity_path,
            frames[-1].intensity_path, frames[-1].depth_path, frames[-1].metadata_path,
            (0, 0, 16, 16), "test", 16, 16, 1000.0, 1.0,
        )
        positions = []
        for row in range(4):
            for col in range(4):
                radius = 75.0 + (0.8 if row >= 2 and col in (1, 2) else 0.0)
                angle = 2.0 * MODULE.math.pi * col / 4
                positions.extend([radius * MODULE.math.cos(angle), row * 0.25, radius * MODULE.math.sin(angle)])
        mesh = {
            "rows": 4, "cameraCount": 1, "colsPerCamera": 4,
            "positions": positions, "colors": [0.5] * (4 * 4 * 3), "validMask": [1] * 16,
            "coordinateFrame": {"unit": "mm"},
        }
        detection = {"defects": [{
            "id": "ALG-0001", "cameraId": "camera1", "geometry": {
                "cameraIndex": 1, "rowRange": [2, 3], "columnRange": [1, 2], "synthetic": False,
            },
        }]}
        MODULE.materialize_defect_artifacts(
            mesh, detection, [prepared], ["frame-001", "frame-002"], run_dir, output_root
        )
        artifacts = detection["defects"][0]["geometry"]["artifacts"]
        assert artifacts["schema"] == "steel.surface.defect.artifacts.v1"
        assert artifacts["cameraId"] == "camera1"
        assert artifacts["frameId"] == "frame-002"
        assert artifacts["sequenceNo"] == 2
        assert artifacts["roi"]["width"] > 0 and artifacts["roi"]["height"] > 0
        for key in ("roiImage", "depthRoiImage", "localPointCloud", "lengthProfile", "widthProfile"):
            assert (output_root / artifacts[key]).is_file(), key
        point_cloud = json.loads((output_root / artifacts["localPointCloud"]).read_text(encoding="utf-8"))
        assert point_cloud["schema"] == "steel.surface.defect.point-cloud.v1"
        assert point_cloud["pointCount"] > 0
        length_profile = json.loads((output_root / artifacts["lengthProfile"]).read_text(encoding="utf-8"))
        width_profile = json.loads((output_root / artifacts["widthProfile"]).read_text(encoding="utf-8"))
        assert len(length_profile["points"]) >= 2
        assert len(width_profile["points"]) >= 2

    # Mesh closure may retain paired calibrated sector anchors that contour
    # analysis excludes. Those anchors must close topology without becoming
    # false defect candidates.
    positions = []
    for row in range(2):
        for radius, angle in ((75.0, -MODULE.math.pi / 2), (80.0, 0.0), (80.0, 0.0), (75.0, -MODULE.math.pi / 2)):
            positions.extend([radius * MODULE.math.cos(angle), float(row), radius * MODULE.math.sin(angle)])
    seam_mesh = {
        "rows": 2,
        "cameraCount": 2,
        "colsPerCamera": 2,
        "positions": positions,
        "validMask": [1] * 8,
        "analysisValidMask": [1, 0, 0, 1] * 2,
        "calibratedMask": [1] * 8,
        "indices": [],
        "topology": {},
    }
    seam_quality = MODULE.mesh_quality_metrics(seam_mesh)
    assert seam_quality["seamGapMm"]["available"] is True
    assert seam_quality["seamGapMm"]["max"] == 0.0
    seam_detection = MODULE.detect_surface_defects(
        seam_mesh,
        min_depth_mm=0.1,
        min_area_points=1,
        mad_multiplier=1.0,
        longitudinal_span_floor_mm=0.1,
        severe_absolute_mm=1.0,
        severe_threshold_multiplier=2.0,
        review_absolute_mm=0.5,
        review_threshold_multiplier=1.5,
        confidence_base=0.5,
        confidence_magnitude_weight=0.2,
        confidence_area_weight=0.1,
        confidence_area_normalization_points=10.0,
        confidence_maximum=0.99,
    )
    assert seam_detection["candidatePointCount"] == 0
    assert seam_detection["defectCount"] == 0

    candidate_positions = []
    for row in range(2):
        for col in range(8):
            radius = 77.0 if col == 3 else 75.0
            angle = 2.0 * MODULE.math.pi * col / 8
            candidate_positions.extend([
                radius * MODULE.math.cos(angle),
                float(row),
                radius * MODULE.math.sin(angle),
            ])
    candidate_detection = MODULE.detect_surface_defects(
        {
            "rows": 2,
            "cameraCount": 1,
            "colsPerCamera": 8,
            "positions": candidate_positions,
            "validMask": [1] * 16,
        },
        min_depth_mm=0.35,
        min_area_points=2,
        mad_multiplier=6.0,
        longitudinal_span_floor_mm=0.1,
        severe_absolute_mm=1.0,
        severe_threshold_multiplier=2.0,
        review_absolute_mm=0.5,
        review_threshold_multiplier=1.5,
        confidence_base=0.5,
        confidence_magnitude_weight=0.2,
        confidence_area_weight=0.1,
        confidence_area_normalization_points=10.0,
        confidence_maximum=0.99,
    )
    assert candidate_detection["defectCount"] == 1
    assert candidate_detection["classification"]["state"] == "candidate-only"
    candidate_defect = candidate_detection["defects"][0]
    assert candidate_defect["defectType"] == "foreign"
    assert candidate_defect["geometry"]["candidatePolarity"] == "protrusion"
    assert candidate_defect["geometry"]["classificationState"] == "candidate-only"
    assert candidate_defect["geometry"]["classificationConfidence"] is None
    assert candidate_defect["detectionConfidence"] == candidate_defect["confidence"]

    print("algorithm traceability tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
