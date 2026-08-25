#!/usr/bin/env python3
"""Import a six-camera SICK PJ calibration bundle into runtime artifacts.

The site bundle contains three captured frame sets (pj1..pj3), one XML sidecar
per camera and the corresponding SICK binary payload.  The sidecars provide
the metric A/C coordinate conversion while ``拼接参数.txt`` provides the
cross-section Y rotation and X/Z translation for cameras C1..C6.

Raw frame payloads remain immutable at the source location.  This importer
stores their hashes and verified layout in an audit report, and emits both the
JSON contract consumed by ``sick_capture.measurement`` and an
``ArrayCalibration.xml`` compatible with ``bar_surface_reconstruct.py``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import tempfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np


CALIBRATION_SCHEMA = "steel.sick-array-calibration.v1"
IMPORT_SCHEMA = "steel.sick-pj-calibration-import.v1"
EXPECTED_CAMERA_COUNT = 6
EXPECTED_CAPTURE_GROUPS = ("pj1", "pj2", "pj3")


@dataclass(frozen=True)
class CameraMetadata:
    camera_id: str
    serial_number: str
    width: int
    height: int
    delivered_height: int
    line_size: int
    range_size: int
    intensity_size: int
    mark_size: int
    scale_x: float
    offset_x: float
    scale_z: float
    offset_z: float
    missing_value: int


def _utc_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _read_site_text(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"unsupported site text encoding: {path}")


def _atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_json(path: Path, payload: Any) -> None:
    _atomic_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def _parameter(parent: ET.Element, name: str, *, required: bool = True) -> str:
    for node in parent.findall("parameter"):
        if node.get("name") == name:
            return str(node.text or "").strip()
    if required:
        raise ValueError(f"missing XML parameter: {name}")
    return ""


def _read_camera_metadata(path: Path, camera_index: int) -> CameraMetadata:
    root = ET.parse(path).getroot()
    component = root.find("component")
    if component is None:
        raise ValueError(f"missing Ranger3Range component: {path}")
    traits = component.find("genistreamtraits")
    additional = root.find("additionalinfo")
    stream = root.find("genistream")
    if traits is None or additional is None or stream is None:
        raise ValueError(f"incomplete SICK XML sidecar: {path}")
    subcomponents = {node.get("name", ""): node for node in component.findall("subcomponent")}
    range_node = subcomponents.get("Range")
    intensity_node = subcomponents.get("Intensity")
    mark_node = subcomponents.get("Mark")
    if range_node is None or intensity_node is None or mark_node is None:
        raise ValueError(f"Range/Intensity/Mark layout missing: {path}")
    return CameraMetadata(
        camera_id=f"C{camera_index}",
        serial_number=_parameter(additional, "device serial number"),
        width=int(_parameter(traits, "width")),
        height=int(_parameter(traits, "height")),
        delivered_height=int(_parameter(stream, "delivered frame height")),
        line_size=int(_parameter(component, "size")),
        range_size=int(_parameter(range_node, "size")),
        intensity_size=int(_parameter(intensity_node, "size")),
        mark_size=int(_parameter(mark_node, "size")),
        scale_x=float(_parameter(traits, "a axis range scale")),
        offset_x=float(_parameter(traits, "a axis range offset")),
        scale_z=float(_parameter(traits, "c axis range scale")),
        offset_z=float(_parameter(traits, "c axis range offset")),
        missing_value=int(float(_parameter(traits, "c axis range missing value"))),
    )


def _parse_list(text: str, name: str) -> list[float]:
    match = re.search(rf"{re.escape(name)}\s*:=\s*\[([^\]]+)\]", text, re.IGNORECASE)
    if not match:
        raise ValueError(f"missing {name} in stitching parameter file")
    values = [float(value.strip()) for value in match.group(1).split(",")]
    if len(values) != EXPECTED_CAMERA_COUNT or not all(math.isfinite(value) for value in values):
        raise ValueError(f"{name} must contain six finite numbers")
    return values


def _matrix(rotate_y_degrees: float, translate_x: float, translate_z: float) -> list[list[float]]:
    radians = math.radians(rotate_y_degrees)
    cosine = math.cos(radians)
    sine = math.sin(radians)
    return [
        [cosine, 0.0, -sine, translate_x],
        [0.0, 1.0, 0.0, 0.0],
        [sine, 0.0, cosine, translate_z],
        [0.0, 0.0, 0.0, 1.0],
    ]


def _close(left: float, right: float, tolerance: float = 1e-10) -> bool:
    return math.isclose(left, right, rel_tol=tolerance, abs_tol=tolerance)


def _circle_fit(points: np.ndarray) -> dict[str, Any]:
    active = np.asarray(points, dtype=np.float64)
    active = active[np.all(np.isfinite(active), axis=1)]
    if active.shape[0] < 48:
        raise ValueError("stitch validation has fewer than 48 usable points")
    for _ in range(4):
        x, z = active[:, 0], active[:, 1]
        design = np.column_stack((2.0 * x, 2.0 * z, np.ones(x.size)))
        solution, *_ = np.linalg.lstsq(design, x * x + z * z, rcond=None)
        center = solution[:2]
        radius = float(math.sqrt(max(0.0, solution[2] + np.dot(center, center))))
        residual = np.abs(np.linalg.norm(active - center, axis=1) - radius)
        median = float(np.median(residual))
        mad = float(np.median(np.abs(residual - median)))
        keep = residual <= max(0.01, median + 6.0 * 1.4826 * mad)
        if int(np.sum(keep)) < 48 or bool(np.all(keep)):
            break
        active = active[keep]
    residual = np.abs(np.linalg.norm(active - center, axis=1) - radius)
    return {
        "available": True,
        "centerXmm": round(float(center[0]), 6),
        "centerZmm": round(float(center[1]), 6),
        "radiusMm": round(radius, 6),
        "diameterMm": round(2.0 * radius, 6),
        "meanAbsResidualMm": round(float(np.mean(residual)), 6),
        "p95AbsResidualMm": round(float(np.percentile(residual, 95)), 6),
        "maximumAbsResidualMm": round(float(np.max(residual)), 6),
        "pointCount": int(points.shape[0]),
        "robustPointCount": int(active.shape[0]),
    }


def _validate_stitching(source_root: Path, cameras: list[dict[str, Any]]) -> dict[str, Any]:
    groups: list[dict[str, Any]] = []
    for group in EXPECTED_CAPTURE_GROUPS:
        points: list[np.ndarray] = []
        for camera_index, row in enumerate(cameras, start=1):
            layout = row["frameLayout"]
            payload = np.memmap(
                source_root / group / f"{camera_index}.dat",
                dtype=np.uint8,
                mode="r",
                shape=(layout["height"], layout["lineBytes"]),
            )
            range_values = payload[layout["height"] // 2, : layout["rangeBytes"]].view("<u2")
            columns = np.arange(range_values.size, dtype=np.float64)
            coordinate_a = row["coordinateA"]
            coordinate_c = row["coordinateC"]
            valid = range_values != int(coordinate_c["missingValue"])
            local = np.column_stack(
                (
                    columns[valid] * float(coordinate_a["scale"]) + float(coordinate_a["offset"]),
                    np.zeros(int(np.sum(valid)), dtype=np.float64),
                    range_values[valid] * float(coordinate_c["scale"]) + float(coordinate_c["offset"]),
                    np.ones(int(np.sum(valid)), dtype=np.float64),
                )
            )
            transformed = local @ np.asarray(row["localToArray"], dtype=np.float64).T
            points.append(transformed[:, [0, 2]])
        fit = _circle_fit(np.vstack(points))
        center_offset = math.hypot(float(fit["centerXmm"]), float(fit["centerZmm"]))
        passed = bool(
            1.0 <= float(fit["radiusMm"]) <= 1_000.0
            # Calibration captures may use different bar positions.  The
            # transformed section must remain a coherent circle; it does not
            # have to be centred at the array origin before runtime fitting.
            and center_offset <= 20.0
            and float(fit["p95AbsResidualMm"]) <= 10.0
        )
        groups.append({"group": group, "passed": passed, "centerOffsetMm": round(center_offset, 6), "circleFit": fit})
    if not all(row["passed"] for row in groups):
        raise ValueError("PJ stitching parameters failed the cross-section circle quality gate")
    maximum_p95 = max(float(row["circleFit"]["p95AbsResidualMm"]) for row in groups)
    return {
        "passed": True,
        "method": "middle-row-six-camera-transformed-robust-circle",
        "groups": groups,
        "maximumP95ResidualMm": round(maximum_p95, 6),
        "recommendedMaximumCircleResidualMm": round(max(0.5, maximum_p95 * 1.25), 3),
    }


def _validate_group_consistency(rows: list[CameraMetadata]) -> CameraMetadata:
    reference = rows[0]
    for row in rows[1:]:
        if row.serial_number != reference.serial_number:
            raise ValueError(f"{reference.camera_id} serial changed between pj groups")
        for name in (
            "width",
            "height",
            "delivered_height",
            "line_size",
            "range_size",
            "intensity_size",
            "mark_size",
            "missing_value",
        ):
            if getattr(row, name) != getattr(reference, name):
                raise ValueError(f"{reference.camera_id} {name} changed between pj groups")
        for name in ("scale_x", "offset_x", "scale_z", "offset_z"):
            if not _close(getattr(row, name), getattr(reference, name)):
                raise ValueError(f"{reference.camera_id} {name} changed between pj groups")
    return reference


def _xml_text(cameras: list[dict[str, Any]]) -> str:
    root = ET.Element("ArrayCalib-parameter")
    for row in cameras:
        camera = ET.SubElement(root, f"SN_{row['serialNumber']}")
        params = ET.SubElement(camera, "CalibParam")
        matrix = row["localToArray"]
        values: list[tuple[str, Any]] = [
            ("Dir_X", 0), ("Dir_Y", 0), ("Dir_Z", 0),
            ("Rotate_X", 0), ("Rotate_Y", row["rotateYDegrees"]), ("Rotate_Z", 0),
            ("Translate_X", row["translateXmm"]), ("Translate_Y", 0),
            ("Translate_Z", row["translateZmm"]), ("CameraType", 4),
            ("BlendScaleX", row["coordinateA"]["scale"]),
            ("BlendScaleY", 1.0),
            ("BlendScaleZ", row["coordinateC"]["scale"]),
            ("BlendOffsetX", row["coordinateA"]["offset"]),
            ("BlendOffsetY", 0.0),
            ("BlendOffsetZ", row["coordinateC"]["offset"]),
        ]
        for name, value in values:
            ET.SubElement(params, name).text = format(value, ".15g") if isinstance(value, float) else str(value)
        for index, matrix_row in enumerate(matrix):
            ET.SubElement(params, f"Matrix{index}").text = ",".join(
                format(float(value), ".15g") for value in matrix_row
            )
    ET.indent(root, space="  ")
    return "<?xml version='1.0' encoding='UTF-8'?>\n" + ET.tostring(root, encoding="unicode") + "\n"


def import_bundle(
    source_root: Path,
    output_root: Path,
    *,
    revision: str,
    approved: bool,
    approved_by: str,
) -> dict[str, Any]:
    source_root = source_root.resolve()
    parameter_path = source_root / "拼接参数.txt"
    if not parameter_path.is_file():
        raise FileNotFoundError(f"stitching parameter file not found: {parameter_path}")
    parameter_text = _read_site_text(parameter_path)
    rotations = _parse_list(parameter_text, "RyList")
    translations_x = _parse_list(parameter_text, "TxList")
    translations_z = _parse_list(parameter_text, "TzList")

    grouped: dict[int, list[CameraMetadata]] = {index: [] for index in range(1, 7)}
    sources: list[dict[str, Any]] = []
    for group in EXPECTED_CAPTURE_GROUPS:
        for camera_index in range(1, EXPECTED_CAMERA_COUNT + 1):
            xml_path = source_root / group / f"{camera_index}.xml"
            dat_path = source_root / group / f"{camera_index}.dat"
            if not xml_path.is_file() or not dat_path.is_file():
                raise FileNotFoundError(f"missing PJ frame pair: {xml_path} / {dat_path}")
            metadata = _read_camera_metadata(xml_path, camera_index)
            expected_bytes = metadata.line_size * metadata.delivered_height
            actual_bytes = dat_path.stat().st_size
            if actual_bytes != expected_bytes:
                raise ValueError(
                    f"unexpected payload size for {dat_path}: expected={expected_bytes} actual={actual_bytes}"
                )
            grouped[camera_index].append(metadata)
            sources.append(
                {
                    "group": group,
                    "cameraId": metadata.camera_id,
                    "serialNumber": metadata.serial_number,
                    "xml": str(xml_path),
                    "xmlSha256": _sha256(xml_path),
                    "dat": str(dat_path),
                    "datSha256": _sha256(dat_path),
                    "datBytes": actual_bytes,
                }
            )

    cameras: list[dict[str, Any]] = []
    camera_contract: dict[str, Any] = {}
    seen_serials: set[str] = set()
    for camera_index in range(1, EXPECTED_CAMERA_COUNT + 1):
        metadata = _validate_group_consistency(grouped[camera_index])
        if metadata.serial_number in seen_serials:
            raise ValueError(f"duplicate serial number: {metadata.serial_number}")
        seen_serials.add(metadata.serial_number)
        matrix = _matrix(
            rotations[camera_index - 1],
            translations_x[camera_index - 1],
            translations_z[camera_index - 1],
        )
        row = {
            "cameraId": metadata.camera_id,
            "serialNumber": metadata.serial_number,
            "localToArray": matrix,
            "rotateYDegrees": rotations[camera_index - 1],
            "translateXmm": translations_x[camera_index - 1],
            "translateZmm": translations_z[camera_index - 1],
            "coordinateA": {"scale": metadata.scale_x, "offset": metadata.offset_x},
            "coordinateC": {
                "scale": metadata.scale_z,
                "offset": metadata.offset_z,
                "missingValue": metadata.missing_value,
            },
            "frameLayout": {
                "width": metadata.width,
                "height": metadata.delivered_height,
                "lineBytes": metadata.line_size,
                "rangeBytes": metadata.range_size,
                "intensityBytes": metadata.intensity_size,
                "markBytes": metadata.mark_size,
            },
        }
        cameras.append(row)
        camera_contract[metadata.camera_id] = {
            "serialNumber": metadata.serial_number,
            "localToArray": matrix,
            "coordinateA": row["coordinateA"],
            "coordinateC": row["coordinateC"],
        }

    stitch_validation = _validate_stitching(source_root, cameras)

    output_root.mkdir(parents=True, exist_ok=True)
    calibration_path = output_root / "array-calibration.json"
    xml_path = output_root / "ArrayCalibration.xml"
    report_path = output_root / "import-report.json"
    calibration = {
        "schema": CALIBRATION_SCHEMA,
        "revision": revision,
        "approved": approved,
        "approvedAt": _utc_text() if approved else None,
        "approvedBy": approved_by if approved else None,
        "approvalScope": "six-camera-cross-section-stitching-and-diameter",
        "rotationConvention": "right-handed-y-column-vector",
        "metricProjectionVerified": True,
        "longitudinalScaleVerified": False,
        "coordinateFrame": {
            "x": "cross-section-horizontal-mm",
            "y": "bar-motion-unscaled",
            "z": "cross-section-vertical-mm",
        },
        "source": {
            "kind": "site-provided-sick-pj-bundle",
            "root": str(source_root),
            "parameterFile": str(parameter_path),
            "parameterSha256": _sha256(parameter_path),
            "captureGroups": list(EXPECTED_CAPTURE_GROUPS),
        },
        "target": {
            "type": "site-calibration-object",
            "nominalDiameterMm": None,
            "certificate": None,
        },
        "cameras": camera_contract,
    }
    _atomic_json(calibration_path, calibration)
    _atomic_text(xml_path, _xml_text(cameras))
    report = {
        "schema": IMPORT_SCHEMA,
        "generatedAt": _utc_text(),
        "sourceRoot": str(source_root),
        "revision": revision,
        "approved": approved,
        "cameraCount": len(cameras),
        "captureGroupCount": len(EXPECTED_CAPTURE_GROUPS),
        "verifiedFramePairCount": len(sources),
        "rawPayloadCopied": False,
        "outputs": {
            "measurementCalibration": str(calibration_path),
            "measurementCalibrationSha256": _sha256(calibration_path),
            "reconstructionCalibration": str(xml_path),
            "reconstructionCalibrationSha256": _sha256(xml_path),
        },
        "cameras": cameras,
        "sources": sources,
        "stitchValidation": stitch_validation,
        "qualityGate": {"passed": True, "reasons": []},
    }
    _atomic_json(report_path, report)
    report["reportPath"] = str(report_path)
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, help="PJ-bm directory containing pj1..pj3")
    parser.add_argument("--output", required=True, help="versioned calibration output directory")
    parser.add_argument("--revision", required=True)
    parser.add_argument("--approve", action="store_true")
    parser.add_argument("--approved-by", default="")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.approve and not str(args.approved_by).strip():
        raise SystemExit("--approved-by is required with --approve")
    result = import_bundle(
        Path(args.source),
        Path(args.output),
        revision=str(args.revision).strip(),
        approved=bool(args.approve),
        approved_by=str(args.approved_by).strip(),
    )
    print(json.dumps({"code": 0, **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
