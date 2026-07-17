#!/usr/bin/env python3
"""Fit cross-section stitching corrections for the 8-camera array calibration.

This tool is intentionally conservative:
- It reads ArrayCalibration.xml and one continuous-test capture directory.
- It fits a global circle in X/Z from selected scan lines.
- It estimates per-camera X/Z translation corrections only.
- It writes a corrected XML copy and a JSON report; it never overwrites the source XML.

The correction is diagnostic/offline. A stationary round bar constrains the cross-section,
but it does not constrain true line-scan Y motion.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image, ImageDraw


DEFAULT_CALIBRATION = Path(__file__).resolve().parents[1] / "config" / "capture" / "calibrations" / "current-8-time-trigger" / "ArrayCalibration.xml"
DEFAULT_STORAGE = Path("H:/")
DEFAULT_CAPTURE_ROOT = Path(r"H:\\")
DEFAULT_CAMERA_NAMES = [
    "camera1", "camera2", "camera3", "camera4",
    "camera5", "camera6", "camera7", "camera8",
]


def parse_rows(value: str) -> list[int]:
    rows: list[int] = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        rows.append(int(part))
    return rows or [500]


def latest_capture_dir(storage_root: Path) -> Path:
    candidates: list[Path] = []
    for root in [storage_root / "continuous-test", storage_root / "production"]:
        if root.exists():
            candidates.extend(path for path in root.rglob("summary.json") if path.is_file())
    if not candidates:
        raise FileNotFoundError(f"No summary.json found under {storage_root}")
    return max(candidates, key=lambda path: path.stat().st_mtime).parent


def latest_production_material_id(capture_root: Path) -> str:
    first_camera = capture_root / DEFAULT_CAMERA_NAMES[0]
    if not first_camera.is_dir():
        raise FileNotFoundError(f"No production camera folder found: {first_camera}")
    candidates = sorted(
        (path for path in first_camera.iterdir() if path.is_dir()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for candidate in candidates:
        material_id = candidate.name
        if all((capture_root / camera / material_id / "metadata").is_dir() for camera in DEFAULT_CAMERA_NAMES):
            return material_id
    raise FileNotFoundError(f"No eight-camera production material found under {capture_root}")


def load_calibration(path: Path) -> tuple[ET.ElementTree, dict[str, dict]]:
    tree = ET.parse(path)
    root = tree.getroot()
    calibration: dict[str, dict] = {}
    for node in root:
        sn = node.tag.replace("SN_", "")
        params = node.find("CalibParam")
        if params is None:
            continue

        def number(name: str, default: float = 0.0) -> float:
            text = params.findtext(name)
            return default if text is None else float(text.strip())

        matrix = np.array(
            [[float(item) for item in params.findtext(f"Matrix{i}", "0,0,0,0").split(",")] for i in range(4)],
            dtype=np.float64,
        )
        calibration[sn] = {
            "node": node,
            "params": params,
            "matrix": matrix,
            "sx": number("BlendScaleX"),
            "sy": number("BlendScaleY"),
            "sz": number("BlendScaleZ"),
            "ox": number("BlendOffsetX"),
            "oz": number("BlendOffsetZ"),
            "rotateY": number("Rotate_Y"),
        }
    return tree, calibration


def load_metadata(data_dir: Path, material_id: str = "") -> list[dict]:
    paths: list[Path] = []
    if material_id:
        for camera_name in DEFAULT_CAMERA_NAMES:
            metadata_dir = data_dir / camera_name / material_id / "metadata"
            if metadata_dir.is_dir():
                metadata_files = sorted(metadata_dir.glob("*.json"))
                if metadata_files:
                    paths.append(metadata_files[-1])
    if not paths:
        paths = sorted(data_dir.glob("*\\metadata\\*_metadata.json"))
    if not paths:
        paths = sorted(data_dir.glob("*\\metadata\\*.json"))
    if not paths:
        paths = sorted(data_dir.glob("*\\*_metadata.json"))
    metadata = []
    for path in paths:
        with path.open("r", encoding="utf-8") as file:
            item = json.load(file)
        item["_metadataPath"] = str(path)
        metadata.append(item)
    if not metadata:
        raise FileNotFoundError(f"No metadata files found under {data_dir}")
    return metadata


def points_for_camera(meta: dict, calib: dict, rows: list[int], max_points: int) -> np.ndarray:
    depth_path = Path(meta["depthPath"])
    depth = np.array(Image.open(depth_path), dtype=np.float64)
    all_rows: list[np.ndarray] = []
    for requested_row in rows:
        row = min(max(requested_row, 0), depth.shape[0] - 1)
        xs = np.arange(depth.shape[1])
        zraw = depth[row, xs]
        mask = zraw > 0
        xs = xs[mask]
        zraw = zraw[mask]
        if xs.size == 0:
            continue
        per_row_limit = max(100, max_points // max(1, len(rows)))
        if xs.size > per_row_limit:
            keep = np.linspace(0, xs.size - 1, per_row_limit).astype(int)
            xs = xs[keep]
            zraw = zraw[keep]
        local_x = xs * calib["sx"] + calib["ox"]
        local_y = np.full_like(local_x, row * calib["sy"], dtype=np.float64)
        local_z = zraw * calib["sz"] + calib["oz"]
        world = (calib["matrix"] @ np.vstack([local_x, local_y, local_z, np.ones_like(local_x)])).T[:, :3]
        all_rows.append(world[:, [0, 2]])
    if not all_rows:
        return np.zeros((0, 2), dtype=np.float64)
    return np.vstack(all_rows)


def fit_circle(points: np.ndarray) -> dict:
    x = points[:, 0]
    z = points[:, 1]
    a = np.column_stack([2 * x, 2 * z, np.ones_like(x)])
    b = x * x + z * z
    cx, cz, c = np.linalg.lstsq(a, b, rcond=None)[0]
    radius = math.sqrt(max(c + cx * cx + cz * cz, 0.0))
    dist = np.sqrt((x - cx) ** 2 + (z - cz) ** 2)
    residual = dist - radius
    return {
        "centerX": float(cx),
        "centerZ": float(cz),
        "radius": float(radius),
        "diameter": float(radius * 2.0),
        "meanAbsResidual": float(np.mean(np.abs(residual))),
        "stdResidual": float(np.std(residual)),
        "maxAbsResidual": float(np.max(np.abs(residual))),
        "pointCount": int(len(points)),
    }


def robust_fit_circle(points: np.ndarray, iterations: int = 4) -> dict:
    input_count = len(points)
    active = points
    fit = fit_circle(active)
    for _ in range(iterations):
        center = np.array([fit["centerX"], fit["centerZ"]])
        dist = np.linalg.norm(active - center, axis=1)
        residual = np.abs(dist - fit["radius"])
        median = float(np.median(residual))
        mad = float(np.median(np.abs(residual - median)))
        threshold = max(0.5, median + 3.0 * max(mad, 1e-6))
        kept = active[residual <= threshold]
        if len(kept) < max(20, len(active) // 3):
            break
        active = kept
        fit = fit_circle(active)
    fit["fitPointCount"] = int(len(active))
    fit["pointCount"] = int(input_count)
    fit["robustPointCount"] = int(len(active))
    return fit


def residual_stats(points: np.ndarray, fit: dict) -> dict:
    center = np.array([fit["centerX"], fit["centerZ"]])
    dist = np.linalg.norm(points - center, axis=1)
    residual = dist - fit["radius"]
    return {
        "meanAbsResidual": float(np.mean(np.abs(residual))),
        "medianResidual": float(np.median(residual)),
        "stdResidual": float(np.std(residual)),
        "maxAbsResidual": float(np.max(np.abs(residual))),
    }


def angular_coverage_deg(points: np.ndarray, fit: dict) -> float:
    if len(points) < 3:
        return 0.0
    center = np.array([fit["centerX"], fit["centerZ"]])
    angles = np.sort(np.mod(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]), 2.0 * math.pi))
    gaps = np.diff(np.concatenate([angles, angles[:1] + 2.0 * math.pi]))
    return float(math.degrees(2.0 * math.pi - float(np.max(gaps))))


def evaluate_target_detection(
    chunks: list[dict],
    points: np.ndarray,
    fit: dict,
    expected_cameras: int,
    min_points_per_camera: int,
    min_diameter_mm: float,
    max_diameter_mm: float,
    min_angular_coverage_deg: float,
    max_fit_residual_mm: float,
    max_relative_residual: float,
) -> dict:
    reasons: list[str] = []
    camera_count = len(chunks)
    unique_ips = {str(chunk.get("ip", "")).strip() for chunk in chunks if str(chunk.get("ip", "")).strip()}
    unique_serials = {str(chunk.get("sn", "")).strip() for chunk in chunks if str(chunk.get("sn", "")).strip()}
    camera_points = {str(chunk.get("sn", "")): int(len(chunk["points"])) for chunk in chunks}
    coverage = angular_coverage_deg(points, fit)
    robust_ratio = float(fit.get("robustPointCount", 0)) / max(1, int(fit.get("pointCount", len(points))))
    residual_limit = max(max_fit_residual_mm, float(fit["radius"]) * max_relative_residual)

    if camera_count != expected_cameras:
        reasons.append("camera_count_mismatch")
    if len(unique_ips) != expected_cameras:
        reasons.append("camera_ip_identity_mismatch")
    if len(unique_serials) != expected_cameras:
        reasons.append("camera_serial_identity_mismatch")
    if any(count < min_points_per_camera for count in camera_points.values()) or len(camera_points) != expected_cameras:
        reasons.append("insufficient_points_per_camera")
    if not math.isfinite(float(fit["diameter"])) or not (min_diameter_mm <= float(fit["diameter"]) <= max_diameter_mm):
        reasons.append("diameter_out_of_range")
    if coverage < min_angular_coverage_deg:
        reasons.append("insufficient_angular_coverage")
    if float(fit["meanAbsResidual"]) > residual_limit:
        reasons.append("circle_fit_residual_too_large")
    if robust_ratio < 0.5:
        reasons.append("insufficient_robust_inliers")

    return {
        "detected": not reasons,
        "reasons": reasons,
        "expectedCameras": expected_cameras,
        "cameraCount": camera_count,
        "uniqueIpCount": len(unique_ips),
        "uniqueSerialCount": len(unique_serials),
        "pointCount": int(len(points)),
        "cameraPointCounts": camera_points,
        "diameterMm": float(fit["diameter"]),
        "angularCoverageDeg": coverage,
        "meanAbsResidualMm": float(fit["meanAbsResidual"]),
        "residualLimitMm": residual_limit,
        "robustInlierRatio": robust_ratio,
        "thresholds": {
            "minPointsPerCamera": min_points_per_camera,
            "minDiameterMm": min_diameter_mm,
            "maxDiameterMm": max_diameter_mm,
            "minAngularCoverageDeg": min_angular_coverage_deg,
            "maxFitResidualMm": max_fit_residual_mm,
            "maxRelativeResidual": max_relative_residual,
        },
    }


def objective(points: np.ndarray, fit: dict, dx: float, dz: float) -> float:
    shifted = points + np.array([dx, dz])
    return residual_stats(shifted, fit)["meanAbsResidual"]


def optimize_translation(points: np.ndarray, fit: dict, max_shift: float) -> tuple[float, float, dict]:
    dx = 0.0
    dz = 0.0
    best = objective(points, fit, dx, dz)
    step = min(2.0, max_shift / 2.0 if max_shift > 0 else 2.0)
    while step >= 0.01:
        improved = True
        while improved:
            improved = False
            for sx, sz in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]:
                ndx = dx + sx * step
                ndz = dz + sz * step
                if math.hypot(ndx, ndz) > max_shift:
                    continue
                score = objective(points, fit, ndx, ndz)
                if score + 1e-9 < best:
                    dx, dz, best = ndx, ndz, score
                    improved = True
        step *= 0.5
    return dx, dz, residual_stats(points + np.array([dx, dz]), fit)


def set_text(params: ET.Element, name: str, value: float) -> None:
    node = params.find(name)
    if node is not None:
        node.text = f"{value:.12g}"


def apply_xml_corrections(tree: ET.ElementTree, calibration: dict[str, dict], corrections: dict[str, dict]) -> None:
    for sn, correction in corrections.items():
        if sn not in calibration:
            continue
        params = calibration[sn]["params"]
        matrix = calibration[sn]["matrix"].copy()
        dx = correction["dx"]
        dz = correction["dz"]
        matrix[0, 3] += dx
        matrix[2, 3] += dz
        for index in range(4):
            node = params.find(f"Matrix{index}")
            if node is not None:
                node.text = ",".join(f"{value:.12g}" for value in matrix[index])
        for name in ["Translate_X", "PreciTransX2"]:
            set_text(params, name, float(params.findtext(name, "0")) + dx)
        for name in ["Translate_Z", "PreciTransZ2"]:
            set_text(params, name, float(params.findtext(name, "0")) + dz)


def draw_preview(path: Path, chunks: list[dict], fit: dict, corrected: bool) -> None:
    palette = [(230, 57, 70), (29, 117, 209), (30, 155, 80), (247, 149, 30), (130, 70, 200), (0, 160, 170)]
    points = np.vstack([chunk["correctedPoints" if corrected else "points"] for chunk in chunks if len(chunk["points"])])
    width, height, margin = 1600, 1400, 110
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    xmin, xmax = np.percentile(points[:, 0], [0.5, 99.5])
    zmin, zmax = np.percentile(points[:, 1], [0.5, 99.5])
    span = max(xmax - xmin, zmax - zmin, 1.0)
    cx = (xmax + xmin) / 2.0
    cz = (zmax + zmin) / 2.0
    x0 = cx - span / 2.0
    z0 = cz - span / 2.0
    scale = min((width - 2 * margin) / span, (height - 2 * margin) / span)

    def to_px(xv: float, zv: float) -> tuple[int, int]:
        return int(margin + (xv - x0) * scale), int(height - margin - (zv - z0) * scale)

    for grid in np.arange(math.floor(x0 / 10) * 10, x0 + span + 1, 10):
        px, _ = to_px(float(grid), z0)
        draw.line([(px, margin), (px, height - margin)], fill=(235, 235, 235))
    for grid in np.arange(math.floor(z0 / 10) * 10, z0 + span + 1, 10):
        _, py = to_px(x0, float(grid))
        draw.line([(margin, py), (width - margin, py)], fill=(235, 235, 235))

    cpx, cpy = to_px(fit["centerX"], fit["centerZ"])
    rr = fit["radius"] * scale
    draw.ellipse([cpx - rr, cpy - rr, cpx + rr, cpy + rr], outline=(40, 40, 40), width=2)
    draw.ellipse([cpx - 4, cpy - 4, cpx + 4, cpy + 4], fill=(0, 0, 0))

    for index, chunk in enumerate(chunks):
        color = palette[index % len(palette)]
        pts = chunk["correctedPoints" if corrected else "points"]
        for xv, zv in pts:
            px, py = to_px(float(xv), float(zv))
            if margin <= px < width - margin and margin <= py < height - margin:
                draw.ellipse([px - 1, py - 1, px + 1, py + 1], fill=color)

    label = "corrected" if corrected else "before"
    draw.text((30, 20), f"Array calibration cross-section fit ({label})", fill=(0, 0, 0))
    draw.text(
        (30, 48),
        f"diameter={fit['diameter']:.2f} mm, mean residual={fit['meanAbsResidual']:.3f} mm",
        fill=(0, 0, 0),
    )
    y = 82
    for index, chunk in enumerate(chunks):
        color = palette[index % len(palette)]
        draw.rectangle([30, y + 4, 48, y + 22], fill=color)
        before = chunk.get("before", residual_stats(chunk["points"], fit))["meanAbsResidual"]
        after = chunk.get("after", {"meanAbsResidual": before})["meanAbsResidual"]
        draw.text(
            (58, y),
            f"{chunk['ip']} SN {chunk['sn']} before {before:.3f}mm after {after:.3f}mm shift {chunk.get('dx', 0.0):.3f},{chunk.get('dz', 0.0):.3f}",
            fill=(0, 0, 0),
        )
        y += 26
    image.save(path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fit X/Z translation corrections for ArrayCalibration.xml")
    parser.add_argument("--calibration", type=Path, default=DEFAULT_CALIBRATION)
    parser.add_argument("--data-dir", type=Path, default=None)
    parser.add_argument("--storage-root", type=Path, default=DEFAULT_STORAGE)
    parser.add_argument("--capture-root", type=Path, default=DEFAULT_CAPTURE_ROOT)
    parser.add_argument("--material-id", default="", help="Production material folder under camera1..camera8, or latest")
    parser.add_argument("--rows", default="500", help="Comma-separated source rows, for example 250,500,750")
    parser.add_argument("--output-root", type=Path, default=DEFAULT_STORAGE / "analysis")
    parser.add_argument("--max-points-per-camera", type=int, default=2400)
    parser.add_argument("--max-shift-mm", type=float, default=5.0)
    parser.add_argument("--expected-cameras", type=int, default=8)
    parser.add_argument("--min-points-per-camera", type=int, default=100)
    parser.add_argument("--min-diameter-mm", type=float, default=20.0)
    parser.add_argument("--max-diameter-mm", type=float, default=1000.0)
    parser.add_argument("--min-angular-coverage-deg", type=float, default=220.0)
    parser.add_argument("--max-fit-residual-mm", type=float, default=8.0)
    parser.add_argument("--max-relative-residual", type=float, default=0.08)
    parser.add_argument("--min-improvement-ratio", type=float, default=0.03)
    args = parser.parse_args()

    material_id = args.material_id.strip()
    if material_id.lower() == "latest":
        material_id = latest_production_material_id(args.capture_root)
    if args.data_dir is not None:
        data_dir = args.data_dir
    elif material_id:
        data_dir = args.capture_root
    else:
        data_dir = latest_capture_dir(args.storage_root)
    rows = parse_rows(args.rows)
    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir = args.output_root / f"array-calibration-fit-{timestamp}"
    output_dir.mkdir(parents=True, exist_ok=True)

    tree, calibration = load_calibration(args.calibration)
    metadata = load_metadata(data_dir, material_id)

    chunks: list[dict] = []
    all_points: list[np.ndarray] = []
    for meta in metadata:
        sn = meta.get("sn", "")
        if sn not in calibration:
            continue
        points = points_for_camera(meta, calibration[sn], rows, args.max_points_per_camera)
        if len(points) == 0:
            continue
        chunk = {
            "ip": meta.get("ip", ""),
            "sn": sn,
            "metadata": meta.get("_metadataPath", ""),
            "depthPath": meta.get("depthPath", ""),
            "points": points,
        }
        chunks.append(chunk)
        all_points.append(points)

    report_path = output_dir / "fit_report.json"
    if not chunks or sum(len(chunk["points"]) for chunk in chunks) < 20:
        report = {
            "schema": "steel.array-calibration-fit.v2",
            "status": "skipped-no-target",
            "calibration": str(args.calibration),
            "dataDir": str(data_dir),
            "captureRoot": str(args.capture_root),
            "materialId": material_id,
            "rows": rows,
            "outputDir": str(output_dir),
            "fitReport": str(report_path),
            "cameraCount": len(chunks),
            "expectedCameras": args.expected_cameras,
            "targetDetection": {
                "detected": False,
                "reasons": ["no_valid_depth_points"],
                "expectedCameras": args.expected_cameras,
                "cameraCount": len(chunks),
                "pointCount": int(sum(len(chunk["points"]) for chunk in chunks)),
            },
            "correctionAccepted": False,
            "note": "No valid round calibration target was detected; no calibration XML was generated or activated.",
        }
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0

    points = np.vstack(all_points)
    fit_before = robust_fit_circle(points)
    target_detection = evaluate_target_detection(
        chunks,
        points,
        fit_before,
        args.expected_cameras,
        args.min_points_per_camera,
        args.min_diameter_mm,
        args.max_diameter_mm,
        args.min_angular_coverage_deg,
        args.max_fit_residual_mm,
        args.max_relative_residual,
    )
    for chunk in chunks:
        chunk["before"] = residual_stats(chunk["points"], fit_before)
        chunk["dx"] = 0.0
        chunk["dz"] = 0.0

    before_png = output_dir / "cross_section_before.png"
    draw_preview(before_png, chunks, fit_before, corrected=False)
    if not target_detection["detected"]:
        report = {
            "schema": "steel.array-calibration-fit.v2",
            "status": "skipped-no-target",
            "calibration": str(args.calibration),
            "dataDir": str(data_dir),
            "captureRoot": str(args.capture_root),
            "materialId": material_id,
            "rows": rows,
            "outputDir": str(output_dir),
            "fitReport": str(report_path),
            "beforePreview": str(before_png),
            "fitBefore": fit_before,
            "cameraCount": len(chunks),
            "expectedCameras": args.expected_cameras,
            "targetDetection": target_detection,
            "correctionAccepted": False,
            "note": "Round calibration target quality gates did not pass; no calibration XML was generated or activated.",
        }
        report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return 0

    corrections: dict[str, dict] = {}

    corrected_all: list[np.ndarray] = []
    for chunk in chunks:
        before = residual_stats(chunk["points"], fit_before)
        dx, dz, after = optimize_translation(chunk["points"], fit_before, args.max_shift_mm)
        corrected = chunk["points"] + np.array([dx, dz])
        chunk["dx"] = float(dx)
        chunk["dz"] = float(dz)
        chunk["before"] = before
        chunk["after"] = after
        chunk["correctedPoints"] = corrected
        corrected_all.append(corrected)
        corrections[chunk["sn"]] = {
            "ip": chunk["ip"],
            "sn": chunk["sn"],
            "dx": float(dx),
            "dz": float(dz),
            "shiftMagnitude": float(math.hypot(dx, dz)),
            "before": before,
            "after": after,
            "depthPath": chunk["depthPath"],
        }

    fit_after = robust_fit_circle(np.vstack(corrected_all))
    before_residual = float(fit_before["meanAbsResidual"])
    after_residual = float(fit_after["meanAbsResidual"])
    improvement_ratio = (before_residual - after_residual) / max(before_residual, 1e-9)
    saturated_cameras = [
        item["sn"] for item in corrections.values()
        if item["shiftMagnitude"] >= args.max_shift_mm * 0.98
    ]
    correction_reasons: list[str] = []
    if after_residual > before_residual + 1e-6:
        correction_reasons.append("residual_regressed")
    if improvement_ratio < args.min_improvement_ratio and before_residual > 0.5:
        correction_reasons.append("insufficient_residual_improvement")
    if saturated_cameras:
        correction_reasons.append("correction_reached_shift_limit")
    correction_accepted = not correction_reasons

    after_png = output_dir / "cross_section_corrected.png"
    draw_preview(after_png, chunks, fit_after, corrected=True)

    corrected_xml = output_dir / "ArrayCalibration.corrected.xml"
    if correction_accepted:
        apply_xml_corrections(tree, calibration, corrections)
        tree.write(corrected_xml, encoding="UTF-8", xml_declaration=True)

    csv_path = output_dir / "camera_corrections.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(
            file,
            fieldnames=[
                "ip",
                "sn",
                "dx",
                "dz",
                "shiftMagnitude",
                "beforeMeanAbsResidual",
                "afterMeanAbsResidual",
                "depthPath",
            ],
        )
        writer.writeheader()
        for item in corrections.values():
            writer.writerow(
                {
                    "ip": item["ip"],
                    "sn": item["sn"],
                    "dx": item["dx"],
                    "dz": item["dz"],
                    "shiftMagnitude": item["shiftMagnitude"],
                    "beforeMeanAbsResidual": item["before"]["meanAbsResidual"],
                    "afterMeanAbsResidual": item["after"]["meanAbsResidual"],
                    "depthPath": item["depthPath"],
                }
            )

    points_csv_path = output_dir / "cross_section_points.csv"
    with points_csv_path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(
            file,
            fieldnames=["ip", "sn", "index", "x", "z", "correctedX", "correctedZ"],
        )
        writer.writeheader()
        for chunk in chunks:
            for index, (point, corrected_point) in enumerate(zip(chunk["points"], chunk["correctedPoints"])):
                writer.writerow(
                    {
                        "ip": chunk["ip"],
                        "sn": chunk["sn"],
                        "index": index,
                        "x": float(point[0]),
                        "z": float(point[1]),
                        "correctedX": float(corrected_point[0]),
                        "correctedZ": float(corrected_point[1]),
                    }
                )

    report = {
        "schema": "steel.array-calibration-fit.v2",
        "status": "corrected" if correction_accepted else "rejected-quality",
        "calibration": str(args.calibration),
        "dataDir": str(data_dir),
        "captureRoot": str(args.capture_root),
        "materialId": material_id,
        "rows": rows,
        "outputDir": str(output_dir),
        "fitReport": str(report_path),
        "correctedXml": str(corrected_xml) if correction_accepted else "",
        "beforePreview": str(before_png),
        "afterPreview": str(after_png),
        "correctionsCsv": str(csv_path),
        "pointsCsv": str(points_csv_path),
        "fitBefore": fit_before,
        "fitAfter": fit_after,
        "cameraCount": len(chunks),
        "expectedCameras": args.expected_cameras,
        "maxShiftMm": args.max_shift_mm,
        "targetDetection": target_detection,
        "correctionAccepted": correction_accepted,
        "correctionQuality": {
            "accepted": correction_accepted,
            "reasons": correction_reasons,
            "beforeMeanAbsResidualMm": before_residual,
            "afterMeanAbsResidualMm": after_residual,
            "improvementRatio": improvement_ratio,
            "minimumImprovementRatio": args.min_improvement_ratio,
            "saturatedCameras": saturated_cameras,
        },
        "corrections": list(corrections.values()),
        "note": (
            "Round target detected and correction quality gates passed. Corrections are X/Z translations only; camera devices were not written."
            if correction_accepted
            else "Round target detected, but correction quality gates failed; no calibration XML was generated or activated."
        ),
    }
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
