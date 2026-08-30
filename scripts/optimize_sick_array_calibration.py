#!/usr/bin/env python3
"""Bounded six-camera extrinsic refinement with gated pointer activation.

PJ1/PJ2 are treated as two positions of one rod and PJ3 as a second rod.
No certified nominal diameter is available, so this tool reports only relative
stitching/position consistency and never claims absolute metrology accuracy.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from scipy.optimize import minimize

from sick_capture.calibration_pointer import (
    resolve_active_array_calibration,
    write_calibration_pointer,
)
from sick_capture.measurement import MeasurementConfig, build_flow_measurement, robust_circle_fit
from sick_capture.profile import load_profile


GROUPS = ("pj1", "pj2", "pj3")
RY_BOUND_DEG = 0.25
TRANSLATION_BOUND_MM = 2.0
DIAMETER_DRIFT_GATE_MM = 0.01
POSITION_DIFFERENCE_GATE_MM = 0.01283
P95_GATE_MM = 1.0


def _utc_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON payload must be an object: {path}")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _matrix(ry_deg: float, tx_mm: float, tz_mm: float) -> np.ndarray:
    angle = math.radians(ry_deg)
    cosine, sine = math.cos(angle), math.sin(angle)
    return np.asarray(
        [
            [cosine, 0.0, -sine, tx_mm],
            [0.0, 1.0, 0.0, 0.0],
            [sine, 0.0, cosine, tz_mm],
            [0.0, 0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )


def _verify_sources(report: dict[str, Any]) -> tuple[Path, list[dict[str, Any]]]:
    source_root = Path(str(report.get("sourceRoot", ""))).resolve()
    sources = report.get("sources")
    if not isinstance(sources, list) or len(sources) != 18:
        raise ValueError("import report must contain all 18 PJ DAT/XML source pairs")
    verified: list[dict[str, Any]] = []
    for row in sources:
        if not isinstance(row, dict):
            raise ValueError("invalid source audit row")
        for key, sha_key in (("dat", "datSha256"), ("xml", "xmlSha256")):
            path = Path(str(row.get(key, ""))).resolve()
            if not path.is_file() or _sha256(path) != str(row.get(sha_key, "")):
                raise ValueError(f"PJ source hash mismatch: {path}")
        verified.append(row)
    return source_root, verified


def _local_row(
    source_root: Path,
    group: str,
    camera_index: int,
    row_index: int,
    camera: dict[str, Any],
) -> np.ndarray:
    layout = camera["frameLayout"]
    payload = np.memmap(
        source_root / group / f"{camera_index}.dat",
        dtype=np.uint8,
        mode="r",
        shape=(int(layout["height"]), int(layout["lineBytes"])),
    )
    raw = payload[row_index, : int(layout["rangeBytes"])].view("<u2")
    coordinate_a = camera["coordinateA"]
    coordinate_c = camera["coordinateC"]
    valid = raw != int(coordinate_c["missingValue"])
    columns = np.flatnonzero(valid)
    if columns.size > 320:
        columns = columns[:: max(1, math.ceil(columns.size / 320))]
    return np.column_stack(
        (
            columns.astype(np.float64) * float(coordinate_a["scale"])
            + float(coordinate_a["offset"]),
            raw[columns].astype(np.float64) * float(coordinate_c["scale"])
            + float(coordinate_c["offset"]),
        )
    )


def _transform(points: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    local = np.column_stack(
        (points[:, 0], np.zeros(points.shape[0]), points[:, 1], np.ones(points.shape[0]))
    )
    return (local @ matrix.T)[:, [0, 2]]


def _parameters(cameras: list[dict[str, Any]], delta: np.ndarray | None = None) -> list[tuple[float, float, float]]:
    values: list[tuple[float, float, float]] = []
    offset = 0
    for camera_index, camera in enumerate(cameras):
        base = (
            float(camera["rotateYDegrees"]),
            float(camera["translateXmm"]),
            float(camera["translateZmm"]),
        )
        if camera_index == 0 or delta is None:
            values.append(base)
        else:
            values.append(tuple(base[index] + float(delta[offset + index]) for index in range(3)))
            offset += 3
    return values


def _fit_row(
    local_rows: list[np.ndarray],
    parameters: list[tuple[float, float, float]],
) -> dict[str, Any]:
    transformed = [
        _transform(points, _matrix(*parameter))
        for points, parameter in zip(local_rows, parameters)
    ]
    return robust_circle_fit(np.vstack(transformed), 48)


def _detect_target_rows(
    source_root: Path,
    cameras: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    height = int(cameras[0]["frameLayout"]["height"])
    detected: dict[str, list[dict[str, Any]]] = {}
    base_parameters = _parameters(cameras)
    for group in GROUPS:
        candidates: list[dict[str, Any]] = []
        for row_index in range(0, height, 4):
            local_rows = [
                _local_row(source_root, group, index, row_index, camera)
                for index, camera in enumerate(cameras, start=1)
            ]
            if any(points.shape[0] < 32 for points in local_rows):
                continue
            fit = _fit_row(local_rows, base_parameters)
            radius = float(fit.get("radiusMm", math.inf))
            p95 = float(fit.get("p95AbsResidualMm", math.inf))
            if fit.get("available") and 20.0 <= radius <= 200.0 and p95 <= 10.0:
                candidates.append(
                    {"row": row_index, "baseFit": fit, "localRows": local_rows}
                )
        candidates.sort(key=lambda row: float(row["baseFit"]["p95AbsResidualMm"]))
        separated: list[dict[str, Any]] = []
        for row in candidates:
            if all(abs(int(row["row"]) - int(current["row"])) >= 128 for current in separated):
                separated.append(row)
            if len(separated) >= 8:
                break
        detected[group] = sorted(separated, key=lambda row: int(row["row"]))
        if len(detected[group]) < 3:
            raise ValueError(f"{group} target-line detection found fewer than three repeated sections")
    return detected


def _algebraic_residual(points: np.ndarray) -> tuple[np.ndarray, float]:
    x, z = points[:, 0], points[:, 1]
    design = np.column_stack((2.0 * x, 2.0 * z, np.ones(x.size)))
    solution, *_ = np.linalg.lstsq(design, x * x + z * z, rcond=None)
    center = solution[:2]
    radius = float(math.sqrt(max(0.0, solution[2] + np.dot(center, center))))
    return np.linalg.norm(points - center, axis=1) - radius, radius


def _objective(
    delta: np.ndarray,
    cameras: list[dict[str, Any]],
    training: dict[str, list[dict[str, Any]]],
) -> float:
    parameters = _parameters(cameras, delta)
    loss = 0.0
    group_diameters: dict[str, list[float]] = {group: [] for group in GROUPS}
    for group, rows in training.items():
        for row in rows:
            points = np.vstack(
                [
                    _transform(local, _matrix(*parameter))
                    for local, parameter in zip(row["localRows"], parameters)
                ]
            )
            residual, radius = _algebraic_residual(points)
            scale = 0.5
            loss += float(np.mean(2.0 * scale * scale * (np.sqrt(1.0 + (residual / scale) ** 2) - 1.0)))
            group_diameters[group].append(2.0 * radius)
    means = {group: float(np.mean(values)) for group, values in group_diameters.items()}
    loss += 4.0 * abs(means["pj1"] - means["pj2"])
    return loss


def _evaluate(
    detected: dict[str, list[dict[str, Any]]],
    parameters: list[tuple[float, float, float]],
    parity: int,
) -> dict[str, Any]:
    groups: list[dict[str, Any]] = []
    for group, rows in detected.items():
        fits = [
            _fit_row(row["localRows"], parameters)
            for index, row in enumerate(rows)
            if index % 2 == parity
        ]
        diameters = [float(fit["diameterMm"]) for fit in fits]
        groups.append(
            {
                "group": group,
                "rowCount": len(fits),
                "meanDiameterMm": round(float(np.mean(diameters)), 6),
                "maximumP95ResidualMm": round(
                    max(float(fit["p95AbsResidualMm"]) for fit in fits), 6
                ),
                "fits": fits,
            }
        )
    return {"groups": groups}


def _runtime_gate(
    profile_path: Path,
    base_path: Path,
    candidate_path: Path,
    flow_ids: list[str],
) -> dict[str, Any]:
    profile = load_profile(profile_path, strict_hardware=False, verify_cti=False)
    camera_roots = {
        camera.camera_id: camera.storage_root for camera in profile.enabled_cameras
    }
    defaults = profile.raw.get("captureDefaults", {})
    config = MeasurementConfig(
        row_window=16,
        maximum_profile_points=320,
        maximum_sections=int(defaults.get("measurementMaximumSections", 32)),
        minimum_circle_points=48,
        minimum_camera_profile_points=int(
            defaults.get("measurementMinimumCameraProfilePoints", 8)
        ),
        maximum_circle_residual_mm=1.0,
    )
    rows: list[dict[str, Any]] = []
    for flow_id in flow_ids:
        alignment_path = profile.storage_root / flow_id / "sync" / "alignment.json"
        if not alignment_path.is_file():
            rows.append({"flowId": flow_id, "passed": False, "reason": "alignment-unavailable"})
            continue
        alignment = _read_json(alignment_path)
        base = build_flow_measurement(
            camera_roots, flow_id, alignment, calibration_path=base_path, config=config
        )
        candidate = build_flow_measurement(
            camera_roots, flow_id, alignment, calibration_path=candidate_path, config=config
        )
        base_fit = base.get("selectedSection", {}).get("circleFit", {})
        candidate_fit = candidate.get("selectedSection", {}).get("circleFit", {})
        diameter_drift = abs(
            float(candidate_fit.get("diameterMm", math.inf))
            - float(base_fit.get("diameterMm", -math.inf))
        )
        passed = bool(
            candidate.get("metricValid")
            and (base.get("metricValid") or candidate.get("metricValid"))
            and diameter_drift <= DIAMETER_DRIFT_GATE_MM
            and float(candidate_fit.get("p95AbsResidualMm", math.inf))
            <= float(base_fit.get("p95AbsResidualMm", math.inf)) + 1e-9
        )
        rows.append(
            {
                "flowId": flow_id,
                "passed": passed,
                "diameterDriftMm": round(diameter_drift, 6),
                "baseMetricValid": bool(base.get("metricValid")),
                "candidateMetricValid": bool(candidate.get("metricValid")),
                "baseCircleFit": base_fit,
                "candidateCircleFit": candidate_fit,
            }
        )
    return {"passed": bool(rows) and all(row["passed"] for row in rows), "flows": rows}


def optimize(args: argparse.Namespace) -> dict[str, Any]:
    base_path = args.base.resolve()
    report = _read_json(args.import_report.resolve())
    source_root, verified_sources = _verify_sources(report)
    cameras = [row for row in report.get("cameras", []) if isinstance(row, dict)]
    if len(cameras) != 6:
        raise ValueError("import report camera contract must contain six cameras")
    detected = _detect_target_rows(source_root, cameras)
    training = {
        group: [row for index, row in enumerate(rows) if index % 2 == 0]
        for group, rows in detected.items()
    }
    bounds = [
        bound
        for _camera in range(5)
        for bound in (
            (-RY_BOUND_DEG, RY_BOUND_DEG),
            (-TRANSLATION_BOUND_MM, TRANSLATION_BOUND_MM),
            (-TRANSLATION_BOUND_MM, TRANSLATION_BOUND_MM),
        )
    ]
    result = minimize(
        _objective,
        np.zeros(15, dtype=np.float64),
        args=(cameras, training),
        method="L-BFGS-B",
        bounds=bounds,
        options={"maxiter": int(args.max_iterations), "ftol": 1e-10, "maxls": 30},
    )
    delta = np.asarray(result.x, dtype=np.float64)
    candidate_parameters = _parameters(cameras, delta)
    base_parameters = _parameters(cameras)
    base_holdout = _evaluate(detected, base_parameters, 1)
    candidate_holdout = _evaluate(detected, candidate_parameters, 1)
    base_groups = {row["group"]: row for row in base_holdout["groups"]}
    candidate_groups = {row["group"]: row for row in candidate_holdout["groups"]}
    diameter_drifts = {
        group: abs(
            float(candidate_groups[group]["meanDiameterMm"])
            - float(base_groups[group]["meanDiameterMm"])
        )
        for group in GROUPS
    }
    position_difference = abs(
        float(candidate_groups["pj1"]["meanDiameterMm"])
        - float(candidate_groups["pj2"]["meanDiameterMm"])
    )
    worst_base = max(float(row["maximumP95ResidualMm"]) for row in base_holdout["groups"])
    worst_candidate = max(
        float(row["maximumP95ResidualMm"]) for row in candidate_holdout["groups"]
    )
    bound_hit = any(
        abs(float(value)) >= abs(float(bounds[index][1])) - 1e-4
        for index, value in enumerate(delta)
    )

    base = _read_json(base_path)
    candidate = json.loads(json.dumps(base))
    candidate["revision"] = args.revision
    candidate["approved"] = True
    candidate["approvedAt"] = _utc_text()
    candidate["approvedBy"] = "automatic-strict-relative-gate"
    candidate["accuracyClaim"] = "relative-stitching-only-no-certified-nominal-diameter"
    for camera_index, (camera_id, row) in enumerate(sorted(candidate["cameras"].items())):
        ry, tx, tz = candidate_parameters[camera_index]
        row["localToArray"] = _matrix(ry, tx, tz).tolist()
        row["optimizationDelta"] = {
            "rotateYDegrees": round(ry - base_parameters[camera_index][0], 9),
            "translateXmm": round(tx - base_parameters[camera_index][1], 9),
            "translateZmm": round(tz - base_parameters[camera_index][2], 9),
        }
    output_root = args.output.resolve() / args.revision
    output_root.mkdir(parents=True, exist_ok=True)
    candidate_path = output_root / "array-calibration.json"
    candidate_path.write_text(
        json.dumps(candidate, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    runtime = _runtime_gate(
        args.profile.resolve(), base_path, candidate_path, list(args.runtime_flow)
    )
    gates = {
        "sourceHashesAndSerials": len(verified_sources) == 18,
        "optimizerConverged": bool(result.success),
        "boundsNotHit": not bound_hit,
        "heldOutP95AtMost1mm": worst_candidate <= P95_GATE_MM,
        "heldOutWorstResidualImproved": worst_candidate < worst_base,
        "diameterDriftAtMost0_01mm": all(
            value <= DIAMETER_DRIFT_GATE_MM for value in diameter_drifts.values()
        ),
        "pj1Pj2PositionDifferenceNotWorse": position_difference
        <= POSITION_DIFFERENCE_GATE_MM,
        "runtime4033And4034Regression": bool(runtime["passed"]),
    }
    passed = all(gates.values())
    gate_report = {
        "schema": "steel.sick-array-calibration-optimization.v1",
        "generatedAt": _utc_text(),
        "revision": args.revision,
        "passed": passed,
        "accuracyClaim": "relative-only; certified nominal diameters unavailable",
        "objectGrouping": {"sameRod": ["pj1", "pj2"], "differentRod": ["pj3"]},
        "bounds": {"rotateYDegrees": RY_BOUND_DEG, "translateXmm": TRANSLATION_BOUND_MM, "translateZmm": TRANSLATION_BOUND_MM},
        "gaugeCamera": "C1",
        "optimizer": {"success": bool(result.success), "message": str(result.message), "iterations": int(result.nit), "objective": float(result.fun)},
        "detectedTargetRows": {group: [int(row["row"]) for row in rows] for group, rows in detected.items()},
        "baseHeldOut": base_holdout,
        "candidateHeldOut": candidate_holdout,
        "diameterDriftMm": {key: round(value, 6) for key, value in diameter_drifts.items()},
        "pj1Pj2PositionDifferenceMm": round(position_difference, 6),
        "runtimeRegression": runtime,
        "gates": gates,
        "candidatePath": str(candidate_path),
    }
    report_path = output_root / "gate-report.json"
    if not passed:
        candidate["approved"] = False
        candidate["approvedAt"] = None
        candidate["approvedBy"] = None
        candidate["rejectionReason"] = "strict-relative-and-runtime-gates-not-all-passed"
        candidate_path.write_text(
            json.dumps(candidate, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    report_path.write_text(
        json.dumps(gate_report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    pointer_path = None
    if passed and not args.no_activate:
        pointer_path = write_calibration_pointer(
            args.storage_root.resolve(),
            candidate_path,
            previous_path=base_path,
            gate_report_path=report_path,
        )
        try:
            active = resolve_active_array_calibration(args.storage_root.resolve(), base_path)
            if Path(active["path"]).resolve() != candidate_path.resolve():
                raise ValueError("candidate pointer reload did not select the candidate")
        except Exception:
            write_calibration_pointer(
                args.storage_root.resolve(),
                base_path,
                previous_path=candidate_path,
                gate_report_path=report_path,
            )
            raise
    return {
        "passed": passed,
        "candidatePath": str(candidate_path),
        "gateReportPath": str(report_path),
        "activePointerPath": str(pointer_path or ""),
        "gates": gates,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, default=Path("config/capture/calibrations/beiman-sick-6-20260612/array-calibration.json"))
    parser.add_argument("--import-report", type=Path, default=Path("config/capture/calibrations/beiman-sick-6-20260612/import-report.json"))
    parser.add_argument("--profile", type=Path, default=Path("config/sites/sick-array-6/capture.json"))
    parser.add_argument("--storage-root", type=Path, default=Path(r"D:\steel-sick-data"))
    parser.add_argument("--output", type=Path, default=Path("config/capture/calibrations/candidates"))
    parser.add_argument("--revision", default="BEIMAN-SICK6-PJ-20260612-R2")
    parser.add_argument("--runtime-flow", action="append", default=["4033", "4034"])
    parser.add_argument("--max-iterations", type=int, default=80)
    parser.add_argument("--no-activate", action="store_true")
    args = parser.parse_args()
    print(json.dumps(optimize(args), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
