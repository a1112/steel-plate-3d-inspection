import importlib.util
from pathlib import Path

import numpy as np


SCRIPT_PATH = Path(__file__).resolve().parents[3] / "scripts" / "fit_array_calibration_cross_section.py"
SPEC = importlib.util.spec_from_file_location("fit_array_calibration_cross_section", SCRIPT_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load calibration fitter: {SCRIPT_PATH}")
FITTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FITTER)


def synthetic_round_target(camera_count=8, points_per_camera=160):
    rng = np.random.default_rng(273)
    chunks = []
    for index in range(camera_count):
        start = index * (2.0 * np.pi / 8.0)
        angles = np.linspace(start + 0.01, start + (2.0 * np.pi / 8.0) - 0.01, points_per_camera)
        radius = 100.0 + rng.normal(0.0, 0.08, points_per_camera)
        points = np.column_stack([
            12.0 + radius * np.cos(angles),
            -7.0 + radius * np.sin(angles),
        ])
        chunks.append({
            "ip": f"192.168.{101 + index}.100",
            "sn": f"SYNTHETIC-{index + 1}",
            "points": points,
        })
    return chunks


def evaluate(chunks):
    points = np.vstack([chunk["points"] for chunk in chunks])
    fit = FITTER.robust_fit_circle(points)
    return FITTER.evaluate_target_detection(
        chunks,
        points,
        fit,
        expected_cameras=8,
        min_points_per_camera=100,
        min_diameter_mm=20.0,
        max_diameter_mm=1000.0,
        min_angular_coverage_deg=220.0,
        max_fit_residual_mm=8.0,
        max_relative_residual=0.08,
    )


def main():
    target = evaluate(synthetic_round_target())
    assert target["detected"], target
    assert target["cameraCount"] == 8
    assert target["angularCoverageDeg"] > 350.0
    assert target["meanAbsResidualMm"] < 0.2

    missing_camera = evaluate(synthetic_round_target(camera_count=7))
    assert not missing_camera["detected"], missing_camera
    assert "camera_count_mismatch" in missing_camera["reasons"]

    limited_arc = synthetic_round_target()
    for index, chunk in enumerate(limited_arc):
        angles = np.linspace(0.02 + index * 0.002, 0.9 + index * 0.002, 160)
        chunk["points"] = np.column_stack([100.0 * np.cos(angles), 100.0 * np.sin(angles)])
    no_target = evaluate(limited_arc)
    assert not no_target["detected"], no_target
    assert "insufficient_angular_coverage" in no_target["reasons"]

    print("calibration target detection tests passed")


if __name__ == "__main__":
    main()
