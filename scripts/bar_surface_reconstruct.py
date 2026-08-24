#!/usr/bin/env python3
"""Build an eight-camera bar-surface stitching prototype from captured frames.

The prototype reads the production capture layout:
  H:/camera1/<material>/depth/*.png
  H:/camera1/<material>/intensity/*.png
  H:/camera1/<material>/metadata/*.json

It writes an algorithm package under G:/bar-surface-algorithm with:
  - cropped 2D latest images for each camera
  - per-camera stitched 2D strips
  - a closed 360-degree cylindrical mesh JSON for the Tauri frontend
  - OBJ/MTL/texture files for offline inspection
  - artifact and acceptance reports for folder-level verification
  - manifest.json and latest.json
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image


DEFAULT_CAPTURE_ROOT = Path(r"H:\\")
DEFAULT_OUTPUT_ROOT = Path(r"G:\\bar-surface-algorithm")
DEFAULT_CALIBRATION_ROOT = Path(r"E:\\steel-capture-data\\config\\calibrations\\current-8-time-trigger")
DEFAULT_CAMERA_PARAM_CALIBRATION = Path(r"E:\\steel-capture-data\\config\\camera-params\\current-8-time-trigger\\ArrayCalibration.xml")
DEFAULT_ALGORITHM_CONFIG = Path(__file__).resolve().parent.parent / "config" / "algorithm" / "bar-surface-production.json"
DEFAULT_CAMERA_ROOTS = [
    ("camera1", "192.168.101.100", "3G506601BE09220"),
    ("camera2", "192.168.102.100", "3G506501CA09164"),
    ("camera3", "192.168.103.100", "3G506401RE08999"),
    ("camera4", "192.168.104.100", "YF-0270"),
    ("camera5", "192.168.105.100", "3G506601BE09221"),
    ("camera6", "192.168.106.100", "3G506501CA09163"),
    ("camera7", "192.168.107.100", "3G506401RE08995"),
    ("camera8", "192.168.108.100", "YF-0269"),
]

ALGORITHM_THRESHOLD_BINDINGS = (
    ("contourEnabled", "contour_crop", True, bool),
    ("maxFrames", "max_frames", 24, int),
    ("meshRows", "mesh_rows", 144, int),
    ("meshColsPerCamera", "mesh_cols_per_camera", 72, int),
    ("radiusMm", "radius_mm", 75.0, float),
    ("radialScaleMm", "radial_scale_mm", 8.0, float),
    ("maxFaceEdgeMm", "max_face_edge_mm", 8.0, float),
    ("contourRadiusToleranceMm", "contour_radius_tolerance_mm", 0.0, float),
    ("contourMinKeepRatio", "contour_min_keep_ratio", 0.55, float),
    ("contourMinRowCoverage", "contour_min_row_coverage", 0.25, float),
    ("contourAutoPercentile", "contour_auto_percentile", 96.0, float),
    ("contourMinimumToleranceMm", "contour_minimum_tolerance_mm", 0.25, float),
    ("contourMadMultiplier", "contour_mad_multiplier", 6.0, float),
    ("contourFallbackPercentile", "contour_fallback_percentile", 99.0, float),
    ("meshLongitudinalStepMm", "mesh_longitudinal_step_mm", 0.25, float),
    ("defectMinDepthMm", "defect_min_depth_mm", 0.35, float),
    ("defectMinAreaPoints", "defect_min_area_points", 6, int),
    ("defectMadMultiplier", "defect_mad_multiplier", 6.0, float),
    ("defectLongitudinalSpanFloorMm", "defect_longitudinal_span_floor_mm", 0.25, float),
    ("severitySevereAbsoluteMm", "severity_severe_absolute_mm", 1.0, float),
    ("severitySevereThresholdMultiplier", "severity_severe_threshold_multiplier", 2.5, float),
    ("severityReviewAbsoluteMm", "severity_review_absolute_mm", 0.5, float),
    ("severityReviewThresholdMultiplier", "severity_review_threshold_multiplier", 1.35, float),
    ("confidenceBase", "confidence_base", 0.55, float),
    ("confidenceMagnitudeWeight", "confidence_magnitude_weight", 0.2, float),
    ("confidenceAreaWeight", "confidence_area_weight", 0.25, float),
    ("confidenceAreaNormalizationPoints", "confidence_area_normalization_points", 32.0, float),
    ("confidenceMaximum", "confidence_maximum", 0.999, float),
)


@dataclass(frozen=True)
class CameraInput:
    name: str
    ip: str
    sn: str
    root: Path


@dataclass
class CameraFrame:
    stem: str
    depth_path: Path
    intensity_path: Path
    metadata_path: Path | None
    metadata: dict[str, Any]


@dataclass
class CameraPrepared:
    camera: CameraInput
    frames: list[CameraFrame]
    latest_depth_preview: Path
    latest_intensity_preview: Path
    intensity_strip: Path
    depth_strip: Path
    latest_metadata_copy: Path | None
    crop_box: tuple[int, int, int, int]
    crop_source: str
    width: int
    height: int
    median_depth: float
    depth_spread: float


@dataclass
class CameraCalibration:
    sn: str
    matrix: np.ndarray
    sx: float
    sy: float
    sz: float
    ox: float
    oy: float
    oz: float
    rotate_y: float


def utc_now_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def local_stamp() -> str:
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def safe_segment(value: str) -> str:
    value = value.strip() or "unknown"
    value = re.sub(r"[^A-Za-z0-9_.-]+", "-", value)
    return value.strip(".-") or "unknown"


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_sha256(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def load_algorithm_config(path: Path, production: bool) -> dict[str, Any]:
    if not path.is_file():
        if production:
            raise ValueError(f"production algorithm config is required: {path}")
        return {}
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict) or payload.get("schema") != "steel.algorithm-config.v1":
        raise ValueError("algorithm config schema must be steel.algorithm-config.v1")
    for key in ("algorithmName", "algorithmVersion", "configRevision"):
        if not str(payload.get(key, "")).strip():
            raise ValueError(f"algorithm config requires {key}")
    thresholds = payload.get("thresholds")
    if not isinstance(thresholds, dict):
        raise ValueError("algorithm config requires thresholds")
    missing = [key for key, _, _, _ in ALGORITHM_THRESHOLD_BINDINGS if key not in thresholds]
    if missing:
        raise ValueError(f"algorithm config is missing thresholds: {','.join(missing)}")
    if not isinstance(thresholds.get("contourEnabled"), bool):
        raise ValueError("algorithm threshold contourEnabled must be boolean")
    numeric_bounds: dict[str, tuple[float, float]] = {
        "maxFrames": (1, 240),
        "meshRows": (24, 512),
        "meshColsPerCamera": (24, 256),
        "radiusMm": (0.001, 1_000_000),
        "radialScaleMm": (0.0, 1_000_000),
        "maxFaceEdgeMm": (0.0, 1_000_000),
        "contourRadiusToleranceMm": (0.0, 1_000_000),
        "contourMinKeepRatio": (0.0, 1.0),
        "contourMinRowCoverage": (0.0, 1.0),
        "contourAutoPercentile": (50.0, 99.9),
        "contourMinimumToleranceMm": (0.0, 1_000_000),
        "contourMadMultiplier": (0.001, 1_000_000),
        "contourFallbackPercentile": (50.0, 100.0),
        "meshLongitudinalStepMm": (0.000001, 1_000_000),
        "defectMinDepthMm": (0.000001, 1_000_000),
        "defectMinAreaPoints": (1, 1_000_000),
        "defectMadMultiplier": (0.001, 1_000_000),
        "defectLongitudinalSpanFloorMm": (0.0, 1_000_000),
        "severitySevereAbsoluteMm": (0.0, 1_000_000),
        "severitySevereThresholdMultiplier": (0.0, 1_000_000),
        "severityReviewAbsoluteMm": (0.0, 1_000_000),
        "severityReviewThresholdMultiplier": (0.0, 1_000_000),
        "confidenceBase": (0.0, 1.0),
        "confidenceMagnitudeWeight": (0.0, 1.0),
        "confidenceAreaWeight": (0.0, 1.0),
        "confidenceAreaNormalizationPoints": (0.000001, 1_000_000),
        "confidenceMaximum": (0.0, 1.0),
    }
    for key, (minimum, maximum) in numeric_bounds.items():
        value = thresholds.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ValueError(f"algorithm threshold {key} must be a finite number")
        if not minimum <= float(value) <= maximum:
            raise ValueError(f"algorithm threshold {key} is outside [{minimum}, {maximum}]")
    quality_gate = payload.get("qualityGate")
    if not isinstance(quality_gate, dict) or int(quality_gate.get("requiredCameraCount", 0)) != 8:
        raise ValueError("algorithm config qualityGate must require exactly eight cameras")
    if quality_gate.get("requireCalibrationForEveryCamera") is not True:
        raise ValueError("algorithm config qualityGate must require calibration for every camera")
    if quality_gate.get("requireReconstructionAcceptance") is not True:
        raise ValueError("algorithm config qualityGate must require reconstruction acceptance")
    if quality_gate.get("maximumSyntheticDefectCount") != 0:
        raise ValueError("algorithm config qualityGate must forbid synthetic defects")
    payload["configSha256"] = sha256_file(path)
    payload["path"] = str(path)
    return payload


def apply_algorithm_config(args: argparse.Namespace, production: bool) -> dict[str, Any]:
    config_path = Path(args.algorithm_config) if args.algorithm_config else DEFAULT_ALGORITHM_CONFIG
    config = load_algorithm_config(config_path, production)
    configured_thresholds = config.get("thresholds", {})
    effective_thresholds: dict[str, Any] = {}
    for config_key, argument_name, fallback, cast in ALGORITHM_THRESHOLD_BINDINGS:
        requested = getattr(args, argument_name)
        configured = configured_thresholds.get(config_key)
        if production and requested is not None and cast(requested) != cast(configured):
            raise ValueError(f"production threshold override is forbidden: {config_key}")
        effective = requested if requested is not None and not production else configured
        if effective is None:
            effective = fallback
        effective = cast(effective)
        setattr(args, argument_name, effective)
        effective_thresholds[config_key] = effective
    if not config:
        config = {
            "schema": "steel.algorithm-config.development.v1",
            "algorithmName": "bar-surface-defect-detector",
            "algorithmVersion": "development-unversioned",
            "configRevision": "development-defaults",
            "configSha256": canonical_sha256(effective_thresholds),
            "path": "",
            "thresholds": effective_thresholds,
            "qualityGate": {
                "requiredCameraCount": 8,
                "requireCalibrationForEveryCamera": False,
                "requireReconstructionAcceptance": True,
                "maximumSyntheticDefectCount": 64,
            },
        }
    config["effectiveThresholds"] = effective_thresholds
    return config


def calibration_identity(calibration_path: Path | None) -> tuple[str, str]:
    calibration_sha256 = sha256_file(calibration_path) if calibration_path and calibration_path.is_file() else ""
    calibration_revision = os.environ.get("STEEL_CALIBRATION_REVISION", "").strip()
    if not calibration_revision and calibration_sha256:
        calibration_revision = f"sha256:{calibration_sha256[:16]}"
    return calibration_revision, calibration_sha256


def load_algorithm_qualification(
    algorithm_config: dict[str, Any],
    calibration_path: Path | None,
    production: bool,
) -> dict[str, Any]:
    if not production:
        return {}
    report_text = os.environ.get("STEEL_ALGORITHM_ACCEPTANCE_REPORT", "").strip()
    if not report_text:
        raise ValueError("production algorithm acceptance report is required")
    report_path = Path(report_text)
    if not report_path.is_file():
        raise ValueError(f"production algorithm acceptance report does not exist: {report_path}")
    report = json.loads(report_path.read_text(encoding="utf-8-sig"))
    if not isinstance(report, dict) or report.get("schema") != "steel.algorithm-acceptance.v1":
        raise ValueError("algorithm acceptance report schema must be steel.algorithm-acceptance.v1")
    if report.get("status") != "pass":
        raise ValueError("algorithm acceptance report status must be pass")
    exact_config_fields = ("algorithmName", "algorithmVersion", "configRevision", "configSha256")
    for key in exact_config_fields:
        if str(report.get(key, "")) != str(algorithm_config.get(key, "")):
            raise ValueError(f"algorithm acceptance report {key} does not match current config")

    calibration_revision, calibration_sha256 = calibration_identity(calibration_path)
    if not calibration_sha256:
        raise ValueError("production algorithm calibration file is required")
    if str(report.get("calibrationRevision", "")) != calibration_revision:
        raise ValueError("algorithm acceptance report calibrationRevision does not match current calibration")
    if str(report.get("calibrationSha256", "")).lower() != calibration_sha256:
        raise ValueError("algorithm acceptance report calibrationSha256 does not match current calibration")

    script_sha256 = sha256_file(Path(__file__).resolve())
    core_text = os.environ.get("STEEL_BAR_SURFACE_CORE_EXE", "").strip()
    core_path = Path(core_text) if core_text else None
    if core_path is None or not core_path.is_file():
        raise ValueError("production algorithm C++ core executable is required")
    core_sha256 = sha256_file(core_path)
    release_commit = os.environ.get("STEEL_RELEASE_COMMIT", "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40,64}", release_commit):
        raise ValueError("STEEL_RELEASE_COMMIT must be an exact 40-64 character hexadecimal commit")
    implementation = {
        "scriptSha256": script_sha256,
        "coreSha256": core_sha256,
        "releaseCommit": release_commit,
    }
    for key, actual in implementation.items():
        if str(report.get(key, "")).lower() != actual:
            raise ValueError(f"algorithm acceptance report {key} does not match packaged implementation")
    for revision_key, hash_key in (
        ("datasetRevision", "datasetSha256"),
        ("evaluatorRevision", "evaluatorSha256"),
    ):
        if not str(report.get(revision_key, "")).strip():
            raise ValueError(f"algorithm acceptance report requires {revision_key}")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", str(report.get(hash_key, ""))):
            raise ValueError(f"algorithm acceptance report requires valid {hash_key}")
    approvals = report.get("approvals")
    if not isinstance(approvals, dict) or any(
        not str(approvals.get(key, "")).strip()
        for key in ("algorithmOwner", "qualityOwner", "approvedAt")
    ):
        raise ValueError("algorithm acceptance report requires algorithm and quality approvals")
    metrics = report.get("metrics")
    criteria = report.get("acceptanceCriteria")
    if not isinstance(metrics, dict) or not isinstance(criteria, dict):
        raise ValueError("algorithm acceptance report requires metrics and acceptanceCriteria")
    metric_checks = (
        ("detectionRecall", "minimumDetectionRecall", True),
        ("falsePositiveRate", "maximumFalsePositiveRate", False),
        ("missRate", "maximumMissRate", False),
        ("localizationErrorMmP95", "maximumLocalizationErrorMmP95", False),
        ("sizeErrorMmP95", "maximumSizeErrorMmP95", False),
        ("endToEndLatencyMsP95", "maximumEndToEndLatencyMsP95", False),
    )
    for metric_key, criterion_key, minimum in metric_checks:
        try:
            actual = float(metrics[metric_key])
            limit = float(criteria[criterion_key])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"algorithm acceptance report metric is invalid: {metric_key}") from error
        if (minimum and actual < limit) or (not minimum and actual > limit):
            raise ValueError(f"algorithm acceptance report metric failed: {metric_key}")
    return {
        "acceptanceReport": str(report_path.resolve()),
        "acceptanceReportSha256": sha256_file(report_path),
        "datasetRevision": str(report["datasetRevision"]),
        "datasetSha256": str(report["datasetSha256"]).lower(),
        "evaluatorRevision": str(report["evaluatorRevision"]),
        "evaluatorSha256": str(report["evaluatorSha256"]).lower(),
        "approvedCalibrationRevision": calibration_revision,
        "approvedCalibrationSha256": calibration_sha256,
        **implementation,
    }


def build_input_traceability(
    sources: list[CameraPrepared] | list[tuple[CameraInput, list[CameraFrame]]],
    frame_ids: list[str],
) -> dict[str, Any]:
    artifacts: list[dict[str, Any]] = []
    selected = set(frame_ids)
    normalized_sources: list[tuple[CameraInput, list[CameraFrame]]] = []
    for source in sources:
        if isinstance(source, CameraPrepared):
            normalized_sources.append((source.camera, source.frames))
        else:
            normalized_sources.append(source)
    for camera, frames in sorted(normalized_sources, key=lambda value: value[0].name):
        for frame in sorted((value for value in frames if value.stem in selected), key=lambda value: value.stem):
            for kind, path in (
                ("depth", frame.depth_path),
                ("intensity", frame.intensity_path),
                ("metadata", frame.metadata_path),
            ):
                if path is None or not path.is_file():
                    continue
                artifacts.append({
                    "camera": camera.name,
                    "frameId": frame.stem,
                    "kind": kind,
                    "path": str(path.resolve()),
                    "bytes": path.stat().st_size,
                    "sha256": sha256_file(path),
                })
    return {
        "inputFrameIds": list(frame_ids),
        "inputArtifactCount": len(artifacts),
        "inputArtifacts": artifacts,
        "inputSummarySha256": canonical_sha256(artifacts),
    }


def assert_input_traceability_unchanged(
    frozen: dict[str, Any],
    sources: list[CameraPrepared] | list[tuple[CameraInput, list[CameraFrame]]],
    frame_ids: list[str],
) -> None:
    current = build_input_traceability(sources, frame_ids)
    if current != frozen:
        raise ValueError("algorithm input artifacts changed while the run was in progress")


def latest_default_calibration() -> Path | None:
    configured = os.environ.get("STEEL_ALGORITHM_CALIBRATION_PATH", "").strip()
    if configured:
        configured_path = Path(configured)
        if configured_path.is_file():
            return configured_path
    candidates: list[Path] = []
    if DEFAULT_CALIBRATION_ROOT.exists():
        candidates.extend(DEFAULT_CALIBRATION_ROOT.rglob("ArrayCalibration.corrected.xml"))
        candidates.extend(DEFAULT_CALIBRATION_ROOT.rglob("ArrayCalibration.xml"))
    if DEFAULT_CAMERA_PARAM_CALIBRATION.is_file():
        candidates.append(DEFAULT_CAMERA_PARAM_CALIBRATION)
    candidates = [path for path in candidates if path.is_file()]
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)


def load_array_calibration(path: Path | None) -> dict[str, CameraCalibration]:
    if path is None or not path.is_file():
        return {}
    tree = ET.parse(path)
    calibration: dict[str, CameraCalibration] = {}
    for node in tree.getroot():
        sn = node.tag.replace("SN_", "")
        params = node.find("CalibParam")
        if params is None:
            continue

        def number(name: str, default: float = 0.0) -> float:
            text = params.findtext(name)
            return default if text is None else float(text.strip())

        rows: list[list[float]] = []
        for index in range(4):
            text = params.findtext(f"Matrix{index}", "0,0,0,0")
            values = [float(item.strip()) for item in text.split(",")]
            if len(values) != 4:
                values = (values + [0.0, 0.0, 0.0, 0.0])[:4]
            rows.append(values)
        matrix = np.array(rows, dtype=np.float64)
        calibration[sn] = CameraCalibration(
            sn=sn,
            matrix=matrix,
            sx=number("BlendScaleX", 1.0),
            sy=number("BlendScaleY", 1.0),
            sz=number("BlendScaleZ", 1.0),
            ox=number("BlendOffsetX", 0.0),
            oy=number("BlendOffsetY", 0.0),
            oz=number("BlendOffsetZ", 0.0),
            rotate_y=number("Rotate_Y", 0.0),
        )
    return calibration


def parse_camera_roots(args: argparse.Namespace) -> list[CameraInput]:
    if args.camera_roots:
        cameras: list[CameraInput] = []
        for index, raw in enumerate(args.camera_roots, start=1):
            parts = [part.strip() for part in raw.split(",")]
            if len(parts) < 2:
                raise ValueError("--camera-root entries must be name,path[,ip[,sn]]")
            name = parts[0] or f"camera{index}"
            root = Path(parts[1])
            ip = parts[2] if len(parts) >= 3 and parts[2] else ""
            sn = parts[3] if len(parts) >= 4 and parts[3] else ""
            cameras.append(CameraInput(name=name, ip=ip, sn=sn, root=root))
        return cameras

    capture_root = Path(args.capture_root)
    return [
        CameraInput(name=name, ip=ip, sn=sn, root=capture_root / name)
        for name, ip, sn in DEFAULT_CAMERA_ROOTS
    ]


def list_materials(camera: CameraInput) -> list[Path]:
    if not camera.root.exists():
        return []
    return [
        path
        for path in camera.root.iterdir()
        if path.is_dir() and (path / "depth").is_dir() and (path / "intensity").is_dir()
    ]


def latest_material_id(cameras: list[CameraInput]) -> str:
    first = cameras[0]
    candidates = sorted(list_materials(first), key=lambda path: path.stat().st_mtime, reverse=True)
    for candidate in candidates:
        material_id = candidate.name
        if all((camera.root / material_id / "depth").is_dir() for camera in cameras):
            return material_id
    raise FileNotFoundError(f"No common material directory found under {first.root}")


def read_json_file(path: Path | None) -> dict[str, Any]:
    if path is None or not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}


def metadata_text(metadata: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = metadata.get(key)
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def frame_camera_ip(camera: CameraInput, frame: CameraFrame) -> str:
    return metadata_text(frame.metadata, "ip", "cameraIp") or camera.ip


def frame_camera_sn(camera: CameraInput, frame: CameraFrame) -> str:
    return metadata_text(frame.metadata, "sn", "serial", "cameraSn") or camera.sn


def discover_camera_frames(camera: CameraInput, material_id: str, max_frames: int) -> list[CameraFrame]:
    material_dir = camera.root / material_id
    depth_dir = material_dir / "depth"
    intensity_dir = material_dir / "intensity"
    metadata_dir = material_dir / "metadata"
    if not depth_dir.is_dir():
        raise FileNotFoundError(f"Missing depth directory: {depth_dir}")
    if not intensity_dir.is_dir():
        raise FileNotFoundError(f"Missing intensity directory: {intensity_dir}")

    depth_by_stem = {path.stem: path for path in depth_dir.glob("*.png")}
    intensity_by_stem = {path.stem: path for path in intensity_dir.glob("*.png")}
    metadata_by_stem = {path.stem: path for path in metadata_dir.glob("*.json")} if metadata_dir.is_dir() else {}
    stems = sorted(set(depth_by_stem).intersection(intensity_by_stem))
    if not stems:
        raise FileNotFoundError(f"No matched depth/intensity frames for {camera.name} at {material_dir}")
    if max_frames > 0:
        stems = stems[-max_frames:]
    return [
        CameraFrame(
            stem=stem,
            depth_path=depth_by_stem[stem],
            intensity_path=intensity_by_stem[stem],
            metadata_path=metadata_by_stem.get(stem),
            metadata=read_json_file(metadata_by_stem.get(stem)),
        )
        for stem in stems
    ]


def read_u16_image(path: Path) -> np.ndarray:
    image = Image.open(path)
    array = np.asarray(image)
    if array.ndim == 3:
        array = array[..., 0]
    return array.astype(np.float32, copy=False)


def normalize_to_u8(array: np.ndarray, mask: np.ndarray | None = None) -> np.ndarray:
    values = array[np.isfinite(array)]
    if mask is not None:
        masked = array[mask & np.isfinite(array)]
        if masked.size > 16:
            values = masked
    values = values[values > 0]
    if values.size == 0:
        return np.zeros(array.shape, dtype=np.uint8)
    lo = float(np.percentile(values, 1.0))
    hi = float(np.percentile(values, 99.5))
    if hi <= lo:
        hi = lo + 1.0
    normalized = (np.clip(array, lo, hi) - lo) * (255.0 / (hi - lo))
    return normalized.astype(np.uint8)


def crop_box_from_arrays(depth: np.ndarray, intensity: np.ndarray, padding: int = 12) -> tuple[int, int, int, int]:
    height, width = intensity.shape[:2]
    depth_values = depth[depth > 0]
    intensity_values = intensity[intensity > 0]
    if depth_values.size < 100 or intensity_values.size < 100:
        return (0, 0, width, height)
    depth_threshold = float(np.percentile(depth_values, 2.0))
    intensity_threshold = float(np.percentile(intensity_values, 2.0))
    mask = (depth > depth_threshold) | (intensity > intensity_threshold)
    row_counts = mask.sum(axis=1)
    col_counts = mask.sum(axis=0)
    rows = np.where(row_counts > max(8, width * 0.01))[0]
    cols = np.where(col_counts > max(8, height * 0.01))[0]
    if rows.size == 0 or cols.size == 0:
        return (0, 0, width, height)
    left = max(0, int(cols[0]) - padding)
    right = min(width, int(cols[-1]) + padding + 1)
    top = max(0, int(rows[0]) - padding)
    bottom = min(height, int(rows[-1]) + padding + 1)
    if right - left < width * 0.2 or bottom - top < height * 0.2:
        return (0, 0, width, height)
    return (left, top, right, bottom)


def save_preview_png(array: np.ndarray, crop_box: tuple[int, int, int, int], path: Path, max_width: int) -> tuple[int, int]:
    left, top, right, bottom = crop_box
    cropped = array[top:bottom, left:right]
    output = Image.fromarray(normalize_to_u8(cropped), mode="L")
    if max_width > 0 and output.width > max_width:
        height = max(1, round(output.height * (max_width / output.width)))
        output = output.resize((max_width, height), Image.Resampling.BILINEAR)
    path.parent.mkdir(parents=True, exist_ok=True)
    output.save(path)
    return output.size


def make_strip(
    frames: list[CameraFrame],
    kind: str,
    crop_box: tuple[int, int, int, int],
    path: Path,
    width: int,
    frame_height: int,
) -> tuple[int, int]:
    tiles: list[Image.Image] = []
    for frame in frames:
        source = frame.intensity_path if kind == "intensity" else frame.depth_path
        array = read_u16_image(source)
        left, top, right, bottom = crop_box
        cropped = normalize_to_u8(array[top:bottom, left:right])
        image = Image.fromarray(cropped, mode="L").resize((width, frame_height), Image.Resampling.BILINEAR)
        tiles.append(image)
    if not tiles:
        raise ValueError("No frames available for strip")
    strip = Image.new("L", (width, frame_height * len(tiles)))
    for index, tile in enumerate(tiles):
        strip.paste(tile, (0, index * frame_height))
    path.parent.mkdir(parents=True, exist_ok=True)
    strip.save(path)
    return strip.size


def write_profile(output_root: Path) -> None:
    profile_path = output_root / "CONFIG_3D" / "bar_surface_profile.json"
    if profile_path.exists():
        return
    atomic_write_json(
        profile_path,
        {
            "schema": "steel.bar_surface.profile.v1",
            "name": "eight-camera-bar-surface-prototype",
            "captureLayout": "H:/camera1..camera8/<material>/{depth,intensity,metadata}",
            "algorithmRoot": str(output_root),
            "outputs": [
                "cropped-2d",
                "stitched-strips",
                "surface-mesh-json",
                "obj-mesh",
                "texture-atlas",
                "artifact-index",
                "acceptance-report",
            ],
        },
    )


def prepare_camera(
    camera: CameraInput,
    material_id: str,
    frames: list[CameraFrame],
    run_dir: Path,
    preview_max_width: int,
    texture_tile_width: int,
    texture_frame_height: int,
    crop_box_override: tuple[int, int, int, int] | None = None,
    crop_source: str = "image-threshold",
) -> CameraPrepared:
    latest = frames[-1]
    latest_depth = read_u16_image(latest.depth_path)
    latest_intensity = read_u16_image(latest.intensity_path)
    image_crop_box = crop_box_from_arrays(latest_depth, latest_intensity)
    crop_box = crop_box_override or image_crop_box
    median_values = latest_depth[latest_depth > 0]
    if median_values.size:
        median_depth = float(np.median(median_values))
        p10 = float(np.percentile(median_values, 10.0))
        p90 = float(np.percentile(median_values, 90.0))
        depth_spread = max(1.0, p90 - p10)
    else:
        median_depth = 0.0
        depth_spread = 1.0

    preview_dir = run_dir / "cropped-2d" / camera.name
    strip_dir = run_dir / "strips" / camera.name
    latest_intensity_preview = preview_dir / "latest_intensity.png"
    latest_depth_preview = preview_dir / "latest_depth.png"
    save_preview_png(latest_intensity, crop_box, latest_intensity_preview, preview_max_width)
    save_preview_png(latest_depth, crop_box, latest_depth_preview, preview_max_width)
    intensity_strip = strip_dir / "intensity_strip.png"
    depth_strip = strip_dir / "depth_strip.png"
    make_strip(frames, "intensity", crop_box, intensity_strip, texture_tile_width, texture_frame_height)
    make_strip(frames, "depth", crop_box, depth_strip, texture_tile_width, texture_frame_height)

    metadata_copy = None
    if latest.metadata_path and latest.metadata_path.is_file():
        metadata_copy = preview_dir / "latest_metadata.json"
        metadata_copy.write_text(json.dumps(latest.metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    return CameraPrepared(
        camera=camera,
        frames=frames,
        latest_depth_preview=latest_depth_preview,
        latest_intensity_preview=latest_intensity_preview,
        intensity_strip=intensity_strip,
        depth_strip=depth_strip,
        latest_metadata_copy=metadata_copy,
        crop_box=crop_box,
        crop_source=crop_source,
        width=int(latest_intensity.shape[1]),
        height=int(latest_intensity.shape[0]),
        median_depth=median_depth,
        depth_spread=depth_spread,
    )


def common_frame_stems(prepared: list[CameraPrepared]) -> list[str]:
    common: set[str] | None = None
    for item in prepared:
        stems = {frame.stem for frame in item.frames}
        common = stems if common is None else common.intersection(stems)
    return sorted(common or [])


def frame_by_stem(frames: list[CameraFrame]) -> dict[str, CameraFrame]:
    return {frame.stem: frame for frame in frames}


def build_texture_atlas(prepared: list[CameraPrepared], path: Path) -> tuple[int, int]:
    strips = [Image.open(item.intensity_strip).convert("RGB") for item in prepared]
    width = sum(strip.width for strip in strips)
    height = max(strip.height for strip in strips)
    atlas = Image.new("RGB", (width, height), (0, 0, 0))
    x = 0
    for strip in strips:
        atlas.paste(strip, (x, 0))
        x += strip.width
    path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(path)
    return atlas.size


def sample_frame_rows(
    depth: np.ndarray,
    intensity: np.ndarray,
    crop_box: tuple[int, int, int, int],
    row_count: int,
    cols: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    left, top, right, bottom = crop_box
    top = max(0, min(top, depth.shape[0] - 1))
    bottom = max(top + 1, min(bottom, depth.shape[0]))
    left = max(0, min(left, depth.shape[1] - 1))
    right = max(left + 1, min(right, depth.shape[1]))
    row_indices = np.linspace(top, bottom - 1, row_count).round().astype(np.int32)
    col_indices = np.linspace(left, right - 1, cols).round().astype(np.int32)
    return (
        depth[np.ix_(row_indices, col_indices)],
        intensity[np.ix_(row_indices, col_indices)],
        row_indices,
        col_indices,
    )


def camera_calibration_for(item: CameraPrepared, calibration: dict[str, CameraCalibration]) -> CameraCalibration | None:
    return camera_calibration_for_input(item.camera, item.frames[-1], calibration)


def camera_calibration_for_input(
    camera: CameraInput,
    frame: CameraFrame,
    calibration: dict[str, CameraCalibration],
) -> CameraCalibration | None:
    candidates = [
        metadata_text(frame.metadata, "sn", "serial", "cameraSn"),
        camera.sn,
    ]
    for sn in candidates:
        if sn and sn in calibration:
            return calibration[sn]
    return None


def estimate_3d_contour_crop_boxes(
    cameras: list[CameraInput],
    per_camera_frames: list[list[CameraFrame]],
    calibration: dict[str, CameraCalibration],
    radius_tolerance_mm: float,
    auto_percentile: float,
    minimum_tolerance_mm: float,
    mad_multiplier: float,
    padding: int = 12,
    max_points_per_camera: int = 18000,
) -> tuple[dict[str, tuple[int, int, int, int]], dict[str, Any]]:
    per_camera: dict[str, dict[str, Any]] = {}
    point_chunks: list[np.ndarray] = []
    sample_records: list[dict[str, Any]] = []

    for camera_index, (camera, frames) in enumerate(zip(cameras, per_camera_frames)):
        latest = frames[-1]
        calibration_item = camera_calibration_for_input(camera, latest, calibration)
        depth = read_u16_image(latest.depth_path)
        intensity = read_u16_image(latest.intensity_path)
        image_crop = crop_box_from_arrays(depth, intensity)
        record: dict[str, Any] = {
            "camera": camera.name,
            "ip": frame_camera_ip(camera, latest),
            "sn": frame_camera_sn(camera, latest),
            "imageCropBox": list(image_crop),
            "source": "image-threshold",
            "pointCount": 0,
        }
        if calibration_item is None:
            record["reason"] = "calibration_missing"
            per_camera[camera.name] = record
            continue

        left, top, right, bottom = image_crop
        area = max(1, (right - left) * (bottom - top))
        stride = max(1, int(math.sqrt(area / max(1, max_points_per_camera))))
        row_indices = np.arange(top, bottom, stride, dtype=np.int32)
        col_indices = np.arange(left, right, stride, dtype=np.int32)
        if row_indices.size == 0 or col_indices.size == 0:
            record["reason"] = "empty_crop"
            per_camera[camera.name] = record
            continue
        depth_sample = depth[np.ix_(row_indices, col_indices)]
        valid = depth_sample > 0
        if int(np.sum(valid)) < 64:
            record["reason"] = "not_enough_depth_points"
            per_camera[camera.name] = record
            continue
        row_grid, col_grid = np.meshgrid(row_indices.astype(np.float64), col_indices.astype(np.float64), indexing="ij")
        local_x = col_grid * calibration_item.sx + calibration_item.ox
        local_y = row_grid * calibration_item.sy + calibration_item.oy
        local_z = depth_sample.astype(np.float64) * calibration_item.sz + calibration_item.oz
        homogeneous = np.stack([local_x[valid], local_y[valid], local_z[valid], np.ones(int(np.sum(valid)))], axis=0)
        world = (calibration_item.matrix @ homogeneous).T[:, :3]
        if world.shape[0] < 64:
            record["reason"] = "not_enough_world_points"
            per_camera[camera.name] = record
            continue
        point_chunks.append(world)
        sample_records.append(
            {
                "camera": camera,
                "cameraIndex": camera_index,
                "frame": latest,
                "depthShape": depth.shape,
                "rows": row_grid[valid].astype(np.int32),
                "cols": col_grid[valid].astype(np.int32),
                "points": world,
                "imageCrop": image_crop,
            }
        )
        record["source"] = "calibrated-3d-sample"
        record["pointCount"] = int(world.shape[0])
        per_camera[camera.name] = record

    if not point_chunks:
        return {}, {
            "schema": "steel.bar_surface.input_crop.v1",
            "source": "image-threshold",
            "applied": False,
            "reason": "no_calibrated_samples",
            "perCamera": per_camera,
        }

    all_points = np.vstack(point_chunks)
    circle = robust_circle_quality(all_points)
    if not circle.get("available"):
        return {}, {
            "schema": "steel.bar_surface.input_crop.v1",
            "source": "image-threshold",
            "applied": False,
            "reason": "circle_fit_unavailable",
            "circleFit": circle,
            "perCamera": per_camera,
        }

    center = np.array([float(circle["centerX"]), float(circle["centerZ"])], dtype=np.float64)
    radius = float(circle["radius"])
    residual = np.abs(np.linalg.norm(all_points[:, [0, 2]] - center, axis=1) - radius)
    if radius_tolerance_mm > 0:
        tolerance = float(radius_tolerance_mm)
        tolerance_mode = "fixed"
    else:
        percentile = max(50.0, min(99.9, float(auto_percentile)))
        p_value = float(np.percentile(residual, percentile))
        median = float(np.median(residual))
        mad = float(np.median(np.abs(residual - median)))
        tolerance = max(
            float(minimum_tolerance_mm),
            min(p_value, median + float(mad_multiplier) * max(mad, 1e-6)),
        )
        tolerance_mode = "auto"

    angular_targets: dict[int, float] = {}
    angular_summary: dict[str, Any] = {
        "applied": False,
        "cameraCount": len(cameras),
        "sectorWidthDeg": round(360.0 / max(1, len(cameras)), 6),
    }
    if len(sample_records) == len(cameras) and len(cameras) > 1:
        sector = 2.0 * math.pi / len(cameras)
        observed = []
        for sample in sample_records:
            sample_points = sample["points"]
            sample_angles = np.arctan2(
                sample_points[:, 2] - center[1],
                sample_points[:, 0] - center[0],
            )
            observed.append(float(np.angle(np.mean(np.exp(1j * sample_angles)))))
        candidates: list[tuple[float, int, float, list[float]]] = []
        for direction in (-1, 1):
            offsets = np.asarray(
                [direction * index * sector for index in range(len(cameras))],
                dtype=np.float64,
            )
            phase = float(np.angle(np.mean(np.exp(1j * (np.asarray(observed) - offsets)))))
            targets = [phase + direction * index * sector for index in range(len(cameras))]
            errors = [
                float((observed[index] - targets[index] + math.pi) % (2.0 * math.pi) - math.pi)
                for index in range(len(cameras))
            ]
            candidates.append((float(np.mean(np.square(errors))), direction, phase, targets))
        score, direction, phase, targets = min(candidates, key=lambda item: item[0])
        angular_targets = {index: target for index, target in enumerate(targets)}
        angular_summary = {
            "applied": True,
            "method": "calibrated-circle-equal-camera-sector-crop",
            "cameraCount": len(cameras),
            "direction": "clockwise" if direction < 0 else "counter-clockwise",
            "phaseDeg": round(math.degrees(phase) % 360.0, 6),
            "sectorWidthDeg": round(math.degrees(sector), 6),
            "fitScoreDegRms": round(math.degrees(math.sqrt(score)), 6),
        }

    crop_boxes: dict[str, tuple[int, int, int, int]] = {}
    for sample in sample_records:
        camera = sample["camera"]
        record = per_camera[camera.name]
        points = sample["points"]
        sample_residual = np.abs(np.linalg.norm(points[:, [0, 2]] - center, axis=1) - radius)
        keep = sample_residual <= tolerance
        target_angle = angular_targets.get(int(sample["cameraIndex"]))
        if target_angle is not None:
            point_angles = np.arctan2(
                points[:, 2] - center[1],
                points[:, 0] - center[0],
            )
            angle_delta = (point_angles - target_angle + math.pi) % (2.0 * math.pi) - math.pi
            sector_half_width = math.pi / len(cameras)
            sector_keep = np.abs(angle_delta) <= sector_half_width * 1.02
            combined_keep = keep & sector_keep
            if int(np.sum(combined_keep)) >= 64:
                keep = combined_keep
                record["source"] = "calibrated-3d-angular-sector"
                record["targetCenterDeg"] = round(math.degrees(target_angle) % 360.0, 6)
                record["sectorWidthDeg"] = round(360.0 / len(cameras), 6)
            else:
                record["angularSectorFallback"] = "not_enough_sector_points"
        kept_count = int(np.sum(keep))
        record["keptPointCount"] = kept_count
        record["radiusToleranceMm"] = round(float(tolerance), 6)
        if kept_count < 64:
            record["source"] = "image-threshold"
            record["reason"] = "not_enough_contour_points"
            continue
        rows = sample["rows"][keep]
        cols = sample["cols"][keep]
        height, width = sample["depthShape"][:2]
        left = max(0, int(np.min(cols)) - padding)
        right = min(width, int(np.max(cols)) + padding + 1)
        top = max(0, int(np.min(rows)) - padding)
        bottom = min(height, int(np.max(rows)) + padding + 1)
        if right - left < width * 0.08 or bottom - top < height * 0.08:
            record["source"] = "image-threshold"
            record["reason"] = "contour_crop_too_small"
            continue
        crop_boxes[camera.name] = (left, top, right, bottom)
        if record.get("source") != "calibrated-3d-angular-sector":
            record["source"] = "calibrated-3d-contour"
        record["cropBox"] = [left, top, right, bottom]
        record["keptPointRatio"] = round(kept_count / max(1, int(record["pointCount"])), 6)
        record["reason"] = "ok"

    return crop_boxes, {
        "schema": "steel.bar_surface.input_crop.v1",
        "source": "calibrated-3d-contour",
        "applied": bool(crop_boxes),
        "circleFit": circle,
        "radiusToleranceMm": round(float(tolerance), 6),
        "toleranceMode": tolerance_mode,
        "matchedCameras": len(crop_boxes),
        "totalCameras": len(cameras),
        "angularSectorCrop": angular_summary,
        "perCamera": per_camera,
    }


def contour_crop_valid_mask(
    position_array: np.ndarray,
    valid_array: np.ndarray,
    calibrated_array: np.ndarray,
    enabled: bool,
    radius_tolerance_mm: float,
    min_keep_ratio: float,
    min_row_coverage: float,
    auto_percentile: float,
    minimum_tolerance_mm: float,
    mad_multiplier: float,
    fallback_percentile: float,
) -> tuple[np.ndarray, dict[str, Any]]:
    finite_array = np.isfinite(position_array).all(axis=2)
    base_valid = valid_array & finite_array
    base_valid_count = int(np.sum(base_valid))
    summary: dict[str, Any] = {
        "enabled": bool(enabled),
        "applied": False,
        "source": "none",
        "baseValidPointCount": base_valid_count,
        "keptPointCount": base_valid_count,
        "removedPointCount": 0,
        "keptPointRatio": 1.0,
        "radiusToleranceMm": 0.0,
        "minKeepRatio": round(float(min_keep_ratio), 6),
        "minRowCoverage": round(float(min_row_coverage), 6),
        "autoPercentile": round(float(auto_percentile), 6),
        "minimumToleranceMm": round(float(minimum_tolerance_mm), 6),
        "madMultiplier": round(float(mad_multiplier), 6),
        "fallbackPercentile": round(float(fallback_percentile), 6),
    }
    if not enabled:
        summary["reason"] = "disabled"
        return base_valid, summary
    if base_valid_count < 64:
        summary["reason"] = "not_enough_valid_points"
        return base_valid, summary

    calibrated_valid = base_valid & calibrated_array
    fit_mask = calibrated_valid if int(np.sum(calibrated_valid)) >= 64 else base_valid
    fit_points = position_array[fit_mask]
    fit_source = "calibrated-3d" if fit_mask is calibrated_valid else "hybrid-3d"
    circle = robust_circle_quality(fit_points)
    summary["circleFit"] = circle
    summary["source"] = fit_source
    if not circle.get("available"):
        summary["reason"] = "circle_fit_unavailable"
        return base_valid, summary

    center = np.array([float(circle["centerX"]), float(circle["centerZ"])], dtype=np.float64)
    radius = float(circle["radius"])
    xz = position_array[:, :, [0, 2]]
    distances = np.linalg.norm(xz - center, axis=2)
    residual = np.abs(distances - radius)
    valid_residual = residual[base_valid]
    if valid_residual.size < 64:
        summary["reason"] = "not_enough_residual_points"
        return base_valid, summary

    if radius_tolerance_mm > 0:
        tolerance = float(radius_tolerance_mm)
        tolerance_mode = "fixed"
    else:
        percentile = max(50.0, min(99.9, float(auto_percentile)))
        p_value = float(np.percentile(valid_residual, percentile))
        median = float(np.median(valid_residual))
        mad = float(np.median(np.abs(valid_residual - median)))
        tolerance = max(
            float(minimum_tolerance_mm),
            min(p_value, median + float(mad_multiplier) * max(mad, 1e-6)),
        )
        tolerance_mode = "auto"

    keep = base_valid & (residual <= tolerance)
    row_coverages = keep.sum(axis=1) / max(1, keep.shape[1])
    if min_row_coverage > 0:
        low_coverage_rows = row_coverages < min_row_coverage
        keep[low_coverage_rows, :] = False
    kept_count = int(np.sum(keep))
    min_keep_count = max(64, int(round(base_valid_count * max(0.0, min(1.0, min_keep_ratio)))))
    if kept_count < min_keep_count:
        fallback_tolerance = float(
            np.percentile(valid_residual, max(50.0, min(100.0, float(fallback_percentile))))
        )
        keep = base_valid & (residual <= fallback_tolerance)
        row_coverages = keep.sum(axis=1) / max(1, keep.shape[1])
        kept_count = int(np.sum(keep))
        summary["fallbackToleranceMm"] = round(fallback_tolerance, 6)
        if kept_count < min_keep_count:
            summary["reason"] = "would_remove_too_many_points"
            summary["attemptedKeptPointCount"] = kept_count
            summary["attemptedKeptPointRatio"] = round(kept_count / max(1, base_valid_count), 6)
            return base_valid, summary
        tolerance = fallback_tolerance
        tolerance_mode = "auto-fallback-p99"

    summary.update(
        {
            "applied": True,
            "reason": "ok",
            "toleranceMode": tolerance_mode,
            "radiusToleranceMm": round(float(tolerance), 6),
            "keptPointCount": kept_count,
            "removedPointCount": base_valid_count - kept_count,
            "keptPointRatio": round(kept_count / max(1, base_valid_count), 6),
            "rowCoverage": {
                "min": round(float(np.min(row_coverages)), 6) if row_coverages.size else 0.0,
                "mean": round(float(np.mean(row_coverages)), 6) if row_coverages.size else 0.0,
                "max": round(float(np.max(row_coverages)), 6) if row_coverages.size else 0.0,
            },
            "residualMm": {
                "median": round(float(np.median(valid_residual)), 6),
                "p90": round(float(np.percentile(valid_residual, 90.0)), 6),
                "p95": round(float(np.percentile(valid_residual, 95.0)), 6),
                "p99": round(float(np.percentile(valid_residual, 99.0)), 6),
                "max": round(float(np.max(valid_residual)), 6),
            },
        }
    )
    return keep, summary


def center_mesh_cross_section_origin(
    position_array: np.ndarray,
    valid_array: np.ndarray,
    calibrated_array: np.ndarray,
) -> dict[str, Any]:
    """Move the fitted X/Z circular center to the mesh coordinate origin.

    The axial Y coordinate remains referenced to the first sampled row.  This
    keeps longitudinal measurements stable while making every exported mesh,
    point cloud and downstream core artifact share the physical cross-section
    origin at (0, 0) in X/Z.
    """
    finite_array = np.isfinite(position_array).all(axis=2)
    valid = valid_array & finite_array
    calibrated_valid = valid & calibrated_array
    fit_mask = calibrated_valid if int(np.sum(calibrated_valid)) >= 12 else valid
    source = "calibrated-3d" if fit_mask is calibrated_valid else "hybrid-3d"
    source_circle = robust_circle_quality(position_array[fit_mask]) if int(np.sum(fit_mask)) >= 12 else {"available": False}
    translation = {"x": 0.0, "y": 0.0, "z": 0.0}

    if not source_circle.get("available"):
        return {
            "schema": "steel.bar_surface.coordinate_transform.v1",
            "applied": False,
            "origin": "source-array-coordinate",
            "targetOrigin": "cross-section-circle-center",
            "axis": "XZ",
            "fitSource": source,
            "translationMm": translation,
            "sourceCircleFit": source_circle,
            "reason": "circle_fit_unavailable",
        }

    translation["x"] = -float(source_circle["centerX"])
    translation["z"] = -float(source_circle["centerZ"])
    position_array[:, :, 0] += translation["x"]
    position_array[:, :, 2] += translation["z"]
    centered_circle = robust_circle_quality(position_array[fit_mask])
    return {
        "schema": "steel.bar_surface.coordinate_transform.v1",
        "applied": True,
        "origin": "cross-section-circle-center",
        "targetOrigin": "cross-section-circle-center",
        "axis": "XZ",
        "fitSource": source,
        "translationMm": {key: round(value, 6) for key, value in translation.items()},
        "sourceCircleFit": source_circle,
        "centeredCircleFit": centered_circle,
    }


def circular_delta(values: np.ndarray | float, center: float) -> np.ndarray:
    return (np.asarray(values, dtype=np.float64) - center + math.pi) % (2.0 * math.pi) - math.pi


def resample_calibrated_camera_sectors(
    position_array: np.ndarray,
    color_array: np.ndarray,
    valid_array: np.ndarray,
    calibrated_array: np.ndarray,
    camera_count: int,
    cols_per_camera: int,
) -> dict[str, Any]:
    """Fit and apply one non-overlapping angular sector per calibrated camera.

    Array cameras observe considerably more than 1/8 of the circumference.  A
    direct crop-to-grid mapping therefore creates overlapping sheets.  This
    routine fits the camera sequence direction and global phase around the
    calibrated circle, then resamples each camera onto its Voronoi 45° sector.
    """
    calibrated_valid = valid_array & calibrated_array & np.isfinite(position_array).all(axis=2)
    if int(np.sum(calibrated_valid)) < max(24, camera_count * 3):
        return {"applied": False, "reason": "insufficient_calibrated_points"}
    fit = robust_circle_quality(position_array[calibrated_valid])
    if not fit.get("available"):
        return {"applied": False, "reason": "circle_fit_unavailable", "circleFit": fit}
    center_x = float(fit["centerX"])
    center_z = float(fit["centerZ"])
    sector = 2.0 * math.pi / camera_count
    observed: list[float] = []
    for camera_index in range(camera_count):
        start = camera_index * cols_per_camera
        end = start + cols_per_camera
        mask = calibrated_valid[:, start:end]
        points = position_array[:, start:end, :][mask]
        if points.shape[0] < 3:
            return {"applied": False, "reason": "camera_sector_points_missing", "cameraIndex": camera_index + 1}
        angles = np.arctan2(points[:, 2] - center_z, points[:, 0] - center_x)
        observed.append(float(np.angle(np.mean(np.exp(1j * angles)))))

    candidates: list[tuple[float, int, float, list[float]]] = []
    for direction in (-1, 1):
        offsets = np.asarray([direction * camera_index * sector for camera_index in range(camera_count)])
        phase = float(np.angle(np.mean(np.exp(1j * (np.asarray(observed) - offsets)))))
        targets = [phase + direction * camera_index * sector for camera_index in range(camera_count)]
        errors = [float(circular_delta(observed[index], targets[index])) for index in range(camera_count)]
        score = float(np.mean(np.square(errors)))
        candidates.append((score, direction, phase, targets))
    score, direction, phase, targets = min(candidates, key=lambda item: item[0])

    source_positions = position_array.copy()
    source_colors = color_array.copy()
    source_valid = valid_array.copy()
    output_valid = np.zeros_like(valid_array, dtype=bool)
    output_calibrated = np.zeros_like(calibrated_array, dtype=bool)
    half_sector = sector / 2.0
    target_deltas = np.linspace(-direction * half_sector, direction * half_sector, cols_per_camera)
    per_camera: list[dict[str, Any]] = []

    for camera_index, target_center in enumerate(targets):
        start = camera_index * cols_per_camera
        end = start + cols_per_camera
        valid_rows = 0
        input_count = int(np.sum(source_valid[:, start:end]))
        for row in range(position_array.shape[0]):
            mask = source_valid[row, start:end] & np.isfinite(source_positions[row, start:end]).all(axis=1)
            if int(np.sum(mask)) < 3:
                continue
            points = source_positions[row, start:end][mask]
            colors = source_colors[row, start:end][mask]
            angles = np.arctan2(points[:, 2] - center_z, points[:, 0] - center_x)
            deltas = circular_delta(angles, target_center)
            order = np.argsort(deltas)
            deltas = deltas[order]
            points = points[order]
            colors = colors[order]
            unique, unique_indices = np.unique(np.round(deltas, 10), return_index=True)
            points = points[unique_indices]
            colors = colors[unique_indices]
            if unique.size < 3 or unique[0] > -half_sector or unique[-1] < half_sector:
                continue
            for axis in range(3):
                position_array[row, start:end, axis] = np.interp(target_deltas, unique, points[:, axis])
                color_array[row, start:end, axis] = np.interp(target_deltas, unique, colors[:, axis])
            output_valid[row, start:end] = True
            output_calibrated[row, start:end] = True
            valid_rows += 1
        per_camera.append({
            "cameraIndex": camera_index + 1,
            "observedCenterDeg": round(math.degrees(observed[camera_index]) % 360.0, 6),
            "targetCenterDeg": round(math.degrees(target_center) % 360.0, 6),
            "angularCorrectionDeg": round(math.degrees(float(circular_delta(observed[camera_index], target_center))), 6),
            "sectorWidthDeg": round(math.degrees(sector), 6),
            "inputPointCount": input_count,
            "resampledRows": valid_rows,
        })
    valid_array[:, :] = output_valid
    calibrated_array[:, :] = output_calibrated
    return {
        "schema": "steel.bar_surface.angular_sector_fit.v1",
        "applied": True,
        "method": "calibrated-circle-equal-sector-resample",
        "direction": "clockwise" if direction < 0 else "counter-clockwise",
        "phaseDeg": round(math.degrees(phase) % 360.0, 6),
        "sectorWidthDeg": round(math.degrees(sector), 6),
        "fitScoreDegRms": round(math.degrees(math.sqrt(score)), 6),
        "circleFit": fit,
        "cameras": per_camera,
    }


def build_mesh(
    prepared: list[CameraPrepared],
    stems: list[str],
    mesh_rows: int,
    cols_per_camera: int,
    radius_mm: float,
    radial_scale_mm: float,
    calibration: dict[str, CameraCalibration],
    max_face_edge_mm: float,
    contour_crop: bool,
    contour_radius_tolerance_mm: float,
    contour_min_keep_ratio: float,
    contour_min_row_coverage: float,
    contour_auto_percentile: float,
    contour_minimum_tolerance_mm: float,
    contour_mad_multiplier: float,
    contour_fallback_percentile: float,
    mesh_longitudinal_step_mm: float,
) -> dict[str, Any]:
    if not stems:
        raise ValueError("No common frame stems for mesh stitching")
    camera_count = len(prepared)
    rows_per_frame = max(2, math.ceil(mesh_rows / len(stems)))
    total_rows = rows_per_frame * len(stems)
    full_cols = cols_per_camera * camera_count
    sector = (math.pi * 2.0) / camera_count
    positions: list[float] = []
    colors: list[float] = []
    uvs: list[float] = []
    valid_mask: list[int] = []
    calibrated_mask: list[int] = []
    depth_grids: list[np.ndarray] = []
    intensity_grids: list[np.ndarray] = []
    row_grids: list[np.ndarray] = []
    col_grids: list[np.ndarray] = []
    camera_calibrations: list[CameraCalibration | None] = []
    calibrated_camera_count = 0

    for item in prepared:
        by_stem = frame_by_stem(item.frames)
        camera_depth_rows: list[np.ndarray] = []
        camera_intensity_rows: list[np.ndarray] = []
        camera_row_rows: list[np.ndarray] = []
        camera_col_rows: list[np.ndarray] = []
        item_calibration = camera_calibration_for(item, calibration)
        camera_calibrations.append(item_calibration)
        if item_calibration is not None:
            calibrated_camera_count += 1
        for frame_index, stem in enumerate(stems):
            frame = by_stem[stem]
            depth = read_u16_image(frame.depth_path)
            intensity = read_u16_image(frame.intensity_path)
            depth_sample, intensity_sample, row_indices, col_indices = sample_frame_rows(
                depth,
                intensity,
                item.crop_box,
                rows_per_frame,
                cols_per_camera,
            )
            camera_depth_rows.append(depth_sample)
            camera_intensity_rows.append(intensity_sample)
            global_rows = row_indices.astype(np.float64) + frame_index * depth.shape[0]
            camera_row_rows.append(np.repeat(global_rows[:, None], cols_per_camera, axis=1))
            camera_col_rows.append(np.repeat(col_indices.astype(np.float64)[None, :], rows_per_frame, axis=0))
        depth_grid = np.vstack(camera_depth_rows)
        intensity_grid = np.vstack(camera_intensity_rows)
        depth_grids.append(depth_grid)
        intensity_grids.append(intensity_grid)
        row_grids.append(np.vstack(camera_row_rows))
        col_grids.append(np.vstack(camera_col_rows))

    all_intensity = np.concatenate([grid.reshape(-1) for grid in intensity_grids])
    all_intensity = all_intensity[all_intensity > 0]
    if all_intensity.size:
        intensity_lo = float(np.percentile(all_intensity, 1.0))
        intensity_hi = float(np.percentile(all_intensity, 99.0))
    else:
        intensity_lo, intensity_hi = 0.0, 1.0
    if intensity_hi <= intensity_lo:
        intensity_hi = intensity_lo + 1.0

    for row in range(total_rows):
        y_mm = row * float(mesh_longitudinal_step_mm)
        v = 1.0 - (row / max(1, total_rows - 1))
        for camera_index, item in enumerate(prepared):
            depth_grid = depth_grids[camera_index]
            intensity_grid = intensity_grids[camera_index]
            row_grid = row_grids[camera_index]
            col_grid = col_grids[camera_index]
            item_calibration = camera_calibrations[camera_index]
            for col in range(cols_per_camera):
                x_fraction = col / max(1, cols_per_camera - 1)
                value = float(depth_grid[row, col])
                if item_calibration is not None and value > 0:
                    local_x = float(col_grid[row, col]) * item_calibration.sx + item_calibration.ox
                    local_y = float(row_grid[row, col]) * item_calibration.sy + item_calibration.oy
                    local_z = value * item_calibration.sz + item_calibration.oz
                    world = item_calibration.matrix @ np.array([local_x, local_y, local_z, 1.0], dtype=np.float64)
                    positions.extend([float(world[0]), float(world[1]), float(world[2])])
                    valid_mask.append(1)
                    calibrated_mask.append(1)
                else:
                    theta = (camera_index - 0.5) * sector + x_fraction * sector
                    radial = 0.0 if value <= 0 else ((value - item.median_depth) / item.depth_spread)
                    radial = max(-1.0, min(1.0, radial)) * radial_scale_mm
                    radius = radius_mm + radial
                    positions.extend([radius * math.cos(theta), y_mm, radius * math.sin(theta)])
                    valid_mask.append(1 if value > 0 else 0)
                    calibrated_mask.append(0)
                gray = (float(intensity_grid[row, col]) - intensity_lo) / (intensity_hi - intensity_lo)
                gray = max(0.0, min(1.0, gray))
                colors.extend([gray, gray, gray])
                u = (camera_index + x_fraction) / camera_count
                uvs.extend([u, v])

    position_array = np.array(positions, dtype=np.float64).reshape((total_rows, full_cols, 3))
    color_array = np.array(colors, dtype=np.float64).reshape((total_rows, full_cols, 3))
    valid_array = np.array(valid_mask, dtype=bool).reshape((total_rows, full_cols))
    calibrated_array = np.array(calibrated_mask, dtype=bool).reshape((total_rows, full_cols))
    angular_sector_fit = resample_calibrated_camera_sectors(
        position_array,
        color_array,
        valid_array,
        calibrated_array,
        camera_count,
        cols_per_camera,
    )
    structural_valid_array = valid_array.copy()
    contour_valid_array, contour_summary = contour_crop_valid_mask(
        position_array,
        valid_array,
        calibrated_array,
        contour_crop,
        contour_radius_tolerance_mm,
        contour_min_keep_ratio,
        contour_min_row_coverage,
        contour_auto_percentile,
        contour_minimum_tolerance_mm,
        contour_mad_multiplier,
        contour_fallback_percentile,
    )
    analysis_valid_array = contour_valid_array.copy()
    valid_array = contour_valid_array.copy()
    restored_seam_anchor_pairs = 0
    if angular_sector_fit.get("applied"):
        for camera_index in range(camera_count):
            left_col = (camera_index + 1) * cols_per_camera - 1
            right_col = ((camera_index + 1) % camera_count) * cols_per_camera
            paired = structural_valid_array[:, left_col] & structural_valid_array[:, right_col]
            restored_seam_anchor_pairs += int(np.sum(paired & ~(valid_array[:, left_col] & valid_array[:, right_col])))
            valid_array[paired, left_col] = True
            valid_array[paired, right_col] = True
    valid_mask = [1 if value else 0 for value in valid_array.reshape(-1)]
    analysis_valid_mask = [1 if value else 0 for value in analysis_valid_array.reshape(-1)]
    coordinate_transform = center_mesh_cross_section_origin(position_array, analysis_valid_array, calibrated_array)
    positions = position_array.reshape(-1).tolist()
    colors = color_array.reshape(-1).tolist()
    indices: list[int] = []
    skipped_invalid_quads = 0
    skipped_gap_quads = 0
    candidate_quads = 0
    max_edge = max(0.0, float(max_face_edge_mm))

    def can_connect_quad(a: int, b: int, c: int, d: int) -> bool:
        nonlocal skipped_invalid_quads, skipped_gap_quads, candidate_quads
        candidate_quads += 1
        coords = [(a // full_cols, a % full_cols), (b // full_cols, b % full_cols), (c // full_cols, c % full_cols), (d // full_cols, d % full_cols)]
        if not all(valid_array[row_index, col_index] for row_index, col_index in coords):
            skipped_invalid_quads += 1
            return False
        if max_edge <= 0:
            return True
        pa = position_array[coords[0]]
        pb = position_array[coords[1]]
        pc = position_array[coords[2]]
        pd = position_array[coords[3]]
        edge_lengths = [
            float(np.linalg.norm(pa - pb)),
            float(np.linalg.norm(pa - pc)),
            float(np.linalg.norm(pb - pd)),
            float(np.linalg.norm(pc - pd)),
            float(np.linalg.norm(pb - pc)),
        ]
        if any(length > max_edge for length in edge_lengths):
            skipped_gap_quads += 1
            return False
        return True

    for row in range(total_rows - 1):
        base = row * full_cols
        next_base = (row + 1) * full_cols
        for col in range(full_cols):
            right = (col + 1) % full_cols
            a = base + col
            b = base + right
            c = next_base + col
            d = next_base + right
            if can_connect_quad(a, b, c, d):
                indices.extend([a, c, b, b, c, d])

    return {
        "schema": "steel.bar_surface.mesh.v1",
        "coordinateUnit": "mm",
        "coordinateFrame": coordinate_transform,
        "stitchMode": "calibrated-hybrid" if calibrated_camera_count else "cylindrical-preview",
        "calibratedCameraCount": calibrated_camera_count,
        "cameraCount": camera_count,
        "frameStems": stems,
        "rows": total_rows,
        "colsPerCamera": cols_per_camera,
        "positions": [round(value, 4) for value in positions],
        "uvs": [round(value, 6) for value in uvs],
        "colors": [round(value, 4) for value in colors],
        "validMask": valid_mask,
        "analysisValidMask": analysis_valid_mask,
        "calibratedMask": calibrated_mask,
        "contourCrop": contour_summary,
        "angularSectorFit": angular_sector_fit,
        "topology": {
            "maxFaceEdgeMm": max_edge,
            "candidateQuads": candidate_quads,
            "keptQuads": len(indices) // 6,
            "skippedInvalidQuads": skipped_invalid_quads,
            "skippedGapQuads": skipped_gap_quads,
            "restoredSeamAnchorPairs": restored_seam_anchor_pairs,
        },
        "indices": indices,
    }


def fit_circle_xz(points: np.ndarray) -> dict[str, float]:
    x = points[:, 0]
    z = points[:, 1]
    a = np.column_stack([2 * x, 2 * z, np.ones_like(x)])
    b = x * x + z * z
    cx, cz, c = np.linalg.lstsq(a, b, rcond=None)[0]
    radius = math.sqrt(max(float(c + cx * cx + cz * cz), 0.0))
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
    }


def robust_circle_quality(points: np.ndarray) -> dict[str, Any]:
    if points.shape[0] < 12:
        return {"available": False, "reason": "not_enough_points", "pointCount": int(points.shape[0])}
    xz = points[:, [0, 2]]
    finite = np.isfinite(xz).all(axis=1)
    xz = xz[finite]
    if xz.shape[0] < 12:
        return {"available": False, "reason": "not_enough_finite_points", "pointCount": int(xz.shape[0])}
    if xz.shape[0] > 60000:
        keep = np.linspace(0, xz.shape[0] - 1, 60000).astype(np.int64)
        xz = xz[keep]
    active = xz
    fit = fit_circle_xz(active)
    for _ in range(4):
        center = np.array([fit["centerX"], fit["centerZ"]])
        residual = np.abs(np.linalg.norm(active - center, axis=1) - fit["radius"])
        median = float(np.median(residual))
        mad = float(np.median(np.abs(residual - median)))
        threshold = max(0.5, median + 3.0 * max(mad, 1e-6))
        kept = active[residual <= threshold]
        if kept.shape[0] < max(12, active.shape[0] // 3):
            break
        active = kept
        fit = fit_circle_xz(active)
    fit["available"] = True
    fit["pointCount"] = int(xz.shape[0])
    fit["robustPointCount"] = int(active.shape[0])
    return {key: (round(value, 6) if isinstance(value, float) else value) for key, value in fit.items()}


def mesh_quality_metrics(mesh: dict[str, Any]) -> dict[str, Any]:
    positions = np.array(mesh["positions"], dtype=np.float64).reshape((-1, 3))
    valid_mask = np.array(mesh.get("validMask", [1] * len(positions)), dtype=bool)
    calibrated_mask = np.array(mesh.get("calibratedMask", [0] * len(positions)), dtype=bool)
    quality_mask = valid_mask & calibrated_mask
    if int(np.sum(quality_mask)) < 12:
        quality_mask = valid_mask
    if int(np.sum(quality_mask)) == 0:
        quality_mask = np.ones_like(valid_mask, dtype=bool)
    rows = int(mesh["rows"])
    cols_per_camera = int(mesh["colsPerCamera"])
    camera_count = int(mesh["cameraCount"])
    full_cols = cols_per_camera * camera_count
    grid = positions.reshape((rows, full_cols, 3))
    valid_grid = valid_mask.reshape((rows, full_cols))
    bounds = {
        "x": [round(float(np.min(positions[quality_mask, 0])), 4), round(float(np.max(positions[quality_mask, 0])), 4)],
        "y": [round(float(np.min(positions[quality_mask, 1])), 4), round(float(np.max(positions[quality_mask, 1])), 4)],
        "z": [round(float(np.min(positions[quality_mask, 2])), 4), round(float(np.max(positions[quality_mask, 2])), 4)],
    }
    seam_gaps: list[float] = []
    for camera_index in range(camera_count):
        left_start = camera_index * cols_per_camera
        left_end = left_start + cols_per_camera
        right_start = ((camera_index + 1) % camera_count) * cols_per_camera
        right_end = right_start + cols_per_camera
        for row in range(rows):
            left_valid = np.where(valid_grid[row, left_start:left_end])[0]
            right_valid = np.where(valid_grid[row, right_start:right_end])[0]
            if left_valid.size == 0 or right_valid.size == 0:
                continue
            left_col = left_start + int(left_valid[-1])
            right_col = right_start + int(right_valid[0])
            gap = float(np.linalg.norm(grid[row, left_col, :] - grid[row, right_col, :]))
            if math.isfinite(gap):
                seam_gaps.append(gap)
    if seam_gaps:
        seam_mean = float(np.mean(seam_gaps))
        seam_max = float(np.max(seam_gaps))
        seam_p95 = float(np.percentile(seam_gaps, 95.0))
    else:
        seam_mean = seam_max = seam_p95 = 0.0
    return {
        "schema": "steel.bar_surface.quality.v1",
        "stitchMode": mesh.get("stitchMode", "unknown"),
        "coordinateFrame": mesh.get("coordinateFrame", {}),
        "angularSectorFit": mesh.get("angularSectorFit", {}),
        "calibratedCameraCount": mesh.get("calibratedCameraCount", 0),
        "validPointCount": int(np.sum(valid_mask)),
        "calibratedPointCount": int(np.sum(calibrated_mask)),
        "contourCrop": mesh.get("contourCrop", {}),
        "topology": mesh.get("topology", {}),
        "surfaceCompleteness": {
            "keptQuadRatio": round(
                float(mesh.get("topology", {}).get("keptQuads", 0))
                / max(1.0, float(mesh.get("topology", {}).get("candidateQuads", 0))),
                6,
            ),
            "triangleCount": len(mesh.get("indices", [])) // 3,
        },
        "boundsMm": bounds,
        "circleFit": robust_circle_quality(positions[quality_mask]),
        "seamGapMm": {
            "available": bool(seam_gaps),
            "mean": round(seam_mean, 6),
            "p95": round(seam_p95, 6),
            "max": round(seam_max, 6),
            "sampleCount": len(seam_gaps),
        },
    }


def detect_surface_defects(
    mesh: dict[str, Any],
    min_depth_mm: float,
    min_area_points: int,
    mad_multiplier: float,
    longitudinal_span_floor_mm: float,
    severe_absolute_mm: float,
    severe_threshold_multiplier: float,
    review_absolute_mm: float,
    review_threshold_multiplier: float,
    confidence_base: float,
    confidence_magnitude_weight: float,
    confidence_area_weight: float,
    confidence_area_normalization_points: float,
    confidence_maximum: float,
) -> dict[str, Any]:
    """Detect coherent radial deviations on the closed, centered surface mesh.

    The per-row median removes slow diameter/oval-shape drift. A MAD-derived
    threshold then isolates local deviations, and an 8-neighbour component
    pass (with circumferential wrap) turns pixels into production candidates.
    """
    positions = np.asarray(mesh["positions"], dtype=np.float64).reshape((-1, 3))
    rows = int(mesh["rows"])
    camera_count = int(mesh["cameraCount"])
    cols_per_camera = int(mesh["colsPerCamera"])
    cols = camera_count * cols_per_camera
    valid = np.asarray(
        mesh.get("analysisValidMask", mesh.get("validMask", [1] * positions.shape[0])),
        dtype=bool,
    ).reshape((rows, cols))
    grid = positions.reshape((rows, cols, 3))
    radii = np.hypot(grid[:, :, 0], grid[:, :, 2])
    residual = np.zeros_like(radii)
    for row in range(rows):
        samples = radii[row, valid[row] & np.isfinite(radii[row])]
        if samples.size:
            residual[row] = radii[row] - float(np.median(samples))
    samples = np.abs(residual[valid & np.isfinite(residual)])
    if samples.size == 0:
        return {"schema": "steel.surface.defects.v1", "status": "complete", "defectCount": 0, "defects": [], "reason": "no_valid_points"}
    median = float(np.median(samples))
    mad = float(np.median(np.abs(samples - median)))
    robust_threshold = median + float(mad_multiplier) * max(mad, 1e-6)
    threshold = max(float(min_depth_mm), robust_threshold)
    candidate = valid & np.isfinite(residual) & (np.abs(residual) >= threshold)
    visited = np.zeros_like(candidate, dtype=bool)
    defects: list[dict[str, Any]] = []
    nominal_radius = float(np.median(radii[valid])) if np.any(valid) else 0.0
    circumference = max(1.0, 2.0 * math.pi * nominal_radius)
    longitudinal_samples = grid[:, :, 1][valid & np.isfinite(grid[:, :, 1])]
    longitudinal_min = float(np.min(longitudinal_samples)) if longitudinal_samples.size else 0.0
    longitudinal_max = float(np.max(longitudinal_samples)) if longitudinal_samples.size else 1.0
    longitudinal_span = max(1e-6, longitudinal_max - longitudinal_min)

    for seed_row in range(rows):
        for seed_col in range(cols):
            if not candidate[seed_row, seed_col] or visited[seed_row, seed_col]:
                continue
            stack = [(seed_row, seed_col)]
            visited[seed_row, seed_col] = True
            component: list[tuple[int, int]] = []
            while stack:
                row, col = stack.pop()
                component.append((row, col))
                for dr in (-1, 0, 1):
                    for dc in (-1, 0, 1):
                        if dr == 0 and dc == 0:
                            continue
                        next_row = row + dr
                        next_col = (col + dc) % cols
                        if 0 <= next_row < rows and candidate[next_row, next_col] and not visited[next_row, next_col]:
                            visited[next_row, next_col] = True
                            stack.append((next_row, next_col))
            if len(component) < max(1, int(min_area_points)):
                continue
            rr = np.asarray([item[0] for item in component], dtype=np.int32)
            cc = np.asarray([item[1] for item in component], dtype=np.int32)
            values = residual[rr, cc]
            sign = -1.0 if float(np.median(values)) < 0 else 1.0
            peak_index = int(np.argmax(np.abs(values)))
            peak = float(values[peak_index])
            point_rows = grid[rr, cc]
            camera_index = int(np.bincount(cc // cols_per_camera, minlength=camera_count).argmax())
            angular_span = max(1, len(set(int(value) for value in cc))) / cols * circumference
            longitudinal_span = max(
                float(longitudinal_span_floor_mm),
                float(np.max(point_rows[:, 1]) - np.min(point_rows[:, 1])),
            )
            magnitude = abs(peak)
            severity = (
                "severe"
                if magnitude >= max(float(severe_absolute_mm), threshold * float(severe_threshold_multiplier))
                else "review"
                if magnitude >= max(float(review_absolute_mm), threshold * float(review_threshold_multiplier))
                else "minor"
            )
            confidence = min(
                float(confidence_maximum),
                float(confidence_base)
                + float(confidence_magnitude_weight) * min(1.0, magnitude / max(threshold, 1e-6))
                + float(confidence_area_weight)
                * min(1.0, len(component) / max(1.0, float(confidence_area_normalization_points))),
            )
            angle = math.atan2(float(point_rows[peak_index, 2]), float(point_rows[peak_index, 0]))
            circumference_ratio = ((angle + math.pi) / (2.0 * math.pi)) % 1.0
            circumference_mm = circumference_ratio * circumference
            length_ratio = float(np.clip((float(np.mean(point_rows[:, 1])) - longitudinal_min) / longitudinal_span, 0.0, 1.0))
            defects.append({
                "id": f"ALG-{len(defects) + 1:04d}",
                "cameraId": f"camera{camera_index + 1}",
                # Keep the two legacy IDs for database/UI compatibility. They
                # describe radial polarity only and are not a material-defect
                # classification result.
                "defectType": "pit" if sign < 0 else "foreign",
                "severity": severity,
                "xMm": round(float(np.mean(point_rows[:, 1])), 4),
                "yMm": round(circumference_mm, 4),
                "zMm": round(peak, 4),
                "widthMm": round(angular_span, 4),
                "heightMm": round(longitudinal_span, 4),
                "depthMm": round(magnitude, 4),
                "confidence": round(confidence, 6),
                "detectionConfidence": round(confidence, 6),
                "geometry": {
                    "schema": "steel.surface.defect.geometry.v1",
                    "classificationState": "candidate-only",
                    "classificationVersion": "radial-polarity-candidate-v1",
                    "candidatePolarity": "depression" if sign < 0 else "protrusion",
                    "classificationConfidence": None,
                    "pointCount": len(component),
                    "rowRange": [int(np.min(rr)), int(np.max(rr))],
                    "columnRange": [int(np.min(cc)), int(np.max(cc))],
                    "signedRadialDeviationMm": round(peak, 4),
                    "cameraIndex": camera_index + 1,
                    "lengthRatio": round(length_ratio, 6),
                    "circumferenceRatio": round(circumference_ratio, 6),
                    "synthetic": False,
                },
            })
    return {
        "schema": "steel.surface.defects.v1",
        "status": "complete",
        "method": "row-median-radial-residual-mad-components",
        "classification": {
            "state": "candidate-only",
            "version": "radial-polarity-candidate-v1",
            "legacyTypeIdsDescribePolarityOnly": True,
            "requiresOperatorReview": True,
        },
        "thresholdMm": round(threshold, 6),
        "robustThresholdMm": round(robust_threshold, 6),
        "minimumDepthMm": round(float(min_depth_mm), 6),
        "minimumAreaPoints": int(min_area_points),
        "candidatePointCount": int(np.sum(candidate)),
        "defectCount": len(defects),
        "defects": defects,
    }


def generate_mock_defects(mesh: dict[str, Any], count: int) -> list[dict[str, Any]]:
    """Generate deterministic temporary defects for UI and database integration.

    These records are deliberately marked as synthetic in their geometry so
    they can be distinguished from radial-residual detections and disabled by
    setting --mock-defect-count 0 once the production detector is ready.
    """
    count = max(0, min(int(count), 64))
    if count == 0:
        return []
    try:
        camera_count = int(mesh["cameraCount"])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError("mesh cameraCount must be a positive integer") from error
    if camera_count <= 0:
        raise ValueError("mesh cameraCount must be a positive integer")
    positions = np.asarray(mesh["positions"], dtype=np.float64).reshape((-1, 3))
    valid = np.asarray(mesh.get("validMask", [1] * positions.shape[0]), dtype=bool)
    valid_positions = positions[valid & np.all(np.isfinite(positions), axis=1)]
    if valid_positions.size:
        longitudinal_min = float(np.min(valid_positions[:, 1]))
        longitudinal_max = float(np.max(valid_positions[:, 1]))
        nominal_radius = float(np.median(np.hypot(valid_positions[:, 0], valid_positions[:, 2])))
    else:
        longitudinal_min, longitudinal_max, nominal_radius = 0.0, 12000.0, 75.0
    longitudinal_span = max(1.0, longitudinal_max - longitudinal_min)
    circumference = max(1.0, 2.0 * math.pi * nominal_radius)
    defect_types = ("pit", "scratch", "roll", "foreign", "burnt", "edge", "bubble", "inclusion")
    severities = ("minor", "review", "severe")
    defects: list[dict[str, Any]] = []
    for index in range(count):
        length_ratio = (index + 1.0) / (count + 1.0)
        camera_index = index % camera_count
        local_ratio = 0.28 + 0.44 * ((index * 37) % 100) / 100.0
        circumference_ratio = (camera_index + local_ratio) / camera_count
        depth = 0.32 + 0.11 * (index % 5)
        signed_depth = -depth if index % 2 == 0 else depth
        defects.append({
            "id": f"MOCK-{index + 1:04d}",
            "cameraId": f"camera{camera_index + 1}",
            "defectType": defect_types[index % len(defect_types)],
            "severity": severities[index % len(severities)],
            "xMm": round(longitudinal_min + length_ratio * longitudinal_span, 4),
            "yMm": round(circumference_ratio * circumference, 4),
            "zMm": round(signed_depth, 4),
            "widthMm": round(2.4 + 0.65 * (index % 4), 4),
            "heightMm": round(5.0 + 1.4 * (index % 5), 4),
            "depthMm": round(depth, 4),
            "confidence": round(0.82 + 0.015 * (index % 8), 6),
            "geometry": {
                "schema": "steel.surface.defect.geometry.v1",
                "generator": "temporary-deterministic-mock-v1",
                "synthetic": True,
                "cameraIndex": camera_index + 1,
                "lengthRatio": round(length_ratio, 6),
                "circumferenceRatio": round(circumference_ratio, 6),
                "signedRadialDeviationMm": round(signed_depth, 4),
            },
        })
    return defects


def _atomic_save_image(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.stem}.tmp{path.suffix}")
    image.save(temporary)
    temporary.replace(path)


def _frame_sequence_no(stem: str, fallback: int) -> int:
    matches = re.findall(r"\d+", stem)
    return int(matches[-1]) if matches else fallback


def _profile_point(distance_mm: float, deviation_mm: float) -> dict[str, float]:
    return {"x": round(float(distance_mm), 6), "z": round(float(deviation_mm), 6)}


def materialize_defect_artifacts(
    mesh: dict[str, Any],
    detection: dict[str, Any],
    prepared: list[CameraPrepared],
    stems: list[str],
    run_dir: Path,
    output_root: Path,
) -> None:
    """Bind every detected component to a source frame and local review artifacts.

    Artifact references are stored inside the versioned geometry JSON so older
    databases remain readable without a destructive schema migration.
    """
    defects = detection.get("defects", [])
    if not isinstance(defects, list) or not defects or not stems:
        return
    rows = int(mesh["rows"])
    camera_count = int(mesh["cameraCount"])
    cols_per_camera = int(mesh["colsPerCamera"])
    full_cols = camera_count * cols_per_camera
    rows_per_frame = max(1, rows // len(stems))
    positions = np.asarray(mesh["positions"], dtype=np.float64).reshape((rows, full_cols, 3))
    colors = np.asarray(mesh.get("colors", [0.5] * (rows * full_cols * 3)), dtype=np.float64).reshape((rows, full_cols, 3))
    valid = np.asarray(
        mesh.get("analysisValidMask", mesh.get("validMask", [1] * (rows * full_cols))),
        dtype=bool,
    ).reshape((rows, full_cols))

    for index, defect in enumerate(defects):
        if not isinstance(defect, dict):
            continue
        geometry = defect.get("geometry")
        if not isinstance(geometry, dict):
            geometry = {}
            defect["geometry"] = geometry
        row_range = geometry.get("rowRange", [0, 0])
        column_range = geometry.get("columnRange", [0, 0])
        if not isinstance(row_range, list) or len(row_range) != 2:
            row_range = [0, 0]
        if not isinstance(column_range, list) or len(column_range) != 2:
            column_range = [0, 0]
        camera_index = int(geometry.get("cameraIndex", index % max(1, camera_count))) - 1
        camera_index = max(0, min(camera_count - 1, camera_index))
        camera = prepared[camera_index]
        center_row = max(0, min(rows - 1, int(round((int(row_range[0]) + int(row_range[1])) / 2))))
        frame_index = max(0, min(len(stems) - 1, center_row // rows_per_frame))
        frame_stem = stems[frame_index]
        frames_by_stem = frame_by_stem(camera.frames)
        frame = frames_by_stem.get(frame_stem)
        if frame is None:
            continue

        source_intensity = Image.open(frame.intensity_path)
        source_depth = Image.open(frame.depth_path)
        source_width, source_height = source_intensity.size
        crop_left, crop_top, crop_right, crop_bottom = camera.crop_box
        crop_width = max(1, crop_right - crop_left)
        crop_height = max(1, crop_bottom - crop_top)
        local_columns = [int(value) % cols_per_camera for value in column_range]
        local_min_col, local_max_col = min(local_columns), max(local_columns)
        frame_row_min = max(0, int(row_range[0]) - frame_index * rows_per_frame)
        frame_row_max = min(rows_per_frame - 1, int(row_range[1]) - frame_index * rows_per_frame)
        x0 = crop_left + int(math.floor(local_min_col / max(1, cols_per_camera - 1) * (crop_width - 1)))
        x1 = crop_left + int(math.ceil(local_max_col / max(1, cols_per_camera - 1) * (crop_width - 1)))
        y0 = crop_top + int(math.floor(frame_row_min / max(1, rows_per_frame - 1) * (crop_height - 1)))
        y1 = crop_top + int(math.ceil(frame_row_max / max(1, rows_per_frame - 1) * (crop_height - 1)))
        padding_x = max(8, int(round(crop_width / max(8, cols_per_camera))))
        padding_y = max(8, int(round(crop_height / max(8, rows_per_frame))))
        left = max(0, x0 - padding_x)
        top = max(0, y0 - padding_y)
        right = min(source_width, max(x1 + padding_x + 1, left + 1))
        bottom = min(source_height, max(y1 + padding_y + 1, top + 1))

        defect_id = safe_segment(str(defect.get("id", f"ALG-{index + 1:04d}")))
        artifact_dir = run_dir / "defects" / defect_id
        intensity_roi = artifact_dir / "intensity-roi.png"
        depth_roi = artifact_dir / "depth-roi.png"
        point_cloud_path = artifact_dir / "local-point-cloud.json"
        length_profile_path = artifact_dir / "length-profile.json"
        width_profile_path = artifact_dir / "width-profile.json"
        _atomic_save_image(source_intensity.crop((left, top, right, bottom)), intensity_roi)
        _atomic_save_image(source_depth.crop((left, top, right, bottom)), depth_roi)

        row_start = max(0, int(row_range[0]) - 2)
        row_end = min(rows - 1, int(row_range[1]) + 2)
        camera_col_start = camera_index * cols_per_camera
        col_start = max(camera_col_start, int(column_range[0]) - 2)
        col_end = min(camera_col_start + cols_per_camera - 1, int(column_range[1]) + 2)
        local_valid = valid[row_start : row_end + 1, col_start : col_end + 1]
        local_positions = positions[row_start : row_end + 1, col_start : col_end + 1][local_valid]
        local_colors = colors[row_start : row_end + 1, col_start : col_end + 1][local_valid]
        atomic_write_json(point_cloud_path, {
            "schema": "steel.surface.defect.point-cloud.v1",
            "defectId": defect_id,
            "coordinateFrame": mesh.get("coordinateFrame", {}),
            "pointCount": int(local_positions.shape[0]),
            "positions": local_positions.reshape(-1).round(6).tolist(),
            "colors": local_colors.reshape(-1).round(6).tolist(),
        })

        center_col = max(camera_col_start, min(camera_col_start + cols_per_camera - 1, int(round((col_start + col_end) / 2))))
        length_points: list[dict[str, float]] = []
        center_y = float(positions[center_row, center_col, 1])
        for row in range(row_start, row_end + 1):
            if not valid[row, center_col]:
                continue
            row_radii = np.hypot(positions[row, :, 0], positions[row, :, 2])
            baseline = float(np.median(row_radii[valid[row]])) if np.any(valid[row]) else 0.0
            radius = float(np.hypot(positions[row, center_col, 0], positions[row, center_col, 2]))
            length_points.append(_profile_point(float(positions[row, center_col, 1]) - center_y, radius - baseline))
        width_points: list[dict[str, float]] = []
        row_radii = np.hypot(positions[center_row, :, 0], positions[center_row, :, 2])
        baseline = float(np.median(row_radii[valid[center_row]])) if np.any(valid[center_row]) else 0.0
        nominal_radius = max(1e-6, baseline)
        for col in range(col_start, col_end + 1):
            if not valid[center_row, col]:
                continue
            radius = float(row_radii[col])
            distance = (col - center_col) / max(1, full_cols) * (2.0 * math.pi * nominal_radius)
            width_points.append(_profile_point(distance, radius - baseline))
        atomic_write_json(length_profile_path, {
            "schema": "steel.surface.defect.profile.v1", "axis": "length", "unit": "mm", "points": length_points,
        })
        atomic_write_json(width_profile_path, {
            "schema": "steel.surface.defect.profile.v1", "axis": "width", "unit": "mm", "points": width_points,
        })

        geometry["artifacts"] = {
            "schema": "steel.surface.defect.artifacts.v1",
            "cameraId": camera.camera.name,
            "frameId": frame_stem,
            "sequenceNo": _frame_sequence_no(frame_stem, frame_index + 1),
            "roi": {"x": left, "y": top, "width": right - left, "height": bottom - top},
            "sourceFrame": {
                "intensity": str(frame.intensity_path.resolve()),
                "intensitySha256": sha256_file(frame.intensity_path),
                "depth": str(frame.depth_path.resolve()),
                "depthSha256": sha256_file(frame.depth_path),
            },
            "roiImage": relative_to_root(intensity_roi, output_root),
            "depthRoiImage": relative_to_root(depth_roi, output_root),
            "localPointCloud": relative_to_root(point_cloud_path, output_root),
            "lengthProfile": relative_to_root(length_profile_path, output_root),
            "widthProfile": relative_to_root(width_profile_path, output_root),
        }


def write_obj(mesh: dict[str, Any], texture_name: str, obj_path: Path) -> Path:
    obj_path.parent.mkdir(parents=True, exist_ok=True)
    mtl_path = obj_path.with_suffix(".mtl")
    positions = mesh["positions"]
    uvs = mesh["uvs"]
    colors = mesh["colors"]
    indices = mesh["indices"]
    with obj_path.open("w", encoding="utf-8") as handle:
        handle.write(f"mtllib {mtl_path.name}\n")
        handle.write("o bar_surface_eight_camera\n")
        for index in range(0, len(positions), 3):
            c_index = index
            handle.write(
                "v {:.4f} {:.4f} {:.4f} {:.4f} {:.4f} {:.4f}\n".format(
                    positions[index],
                    positions[index + 1],
                    positions[index + 2],
                    colors[c_index],
                    colors[c_index + 1],
                    colors[c_index + 2],
                )
            )
        for index in range(0, len(uvs), 2):
            handle.write("vt {:.6f} {:.6f}\n".format(uvs[index], uvs[index + 1]))
        handle.write("usemtl bar_surface_texture\n")
        for index in range(0, len(indices), 3):
            a, b, c = indices[index] + 1, indices[index + 1] + 1, indices[index + 2] + 1
            handle.write(f"f {a}/{a} {b}/{b} {c}/{c}\n")
    mtl_path.write_text(
        "\n".join(
            [
                "newmtl bar_surface_texture",
                "Ka 1.000 1.000 1.000",
                "Kd 1.000 1.000 1.000",
                "Ks 0.000 0.000 0.000",
                "d 1.0",
                f"map_Kd {texture_name}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return mtl_path


def relative_to_root(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def file_artifact(path: Path, output_root: Path, role: str) -> dict[str, Any]:
    exists = path.is_file()
    return {
        "role": role,
        "path": str(path),
        "relative": relative_to_root(path, output_root),
        "exists": exists,
        "bytes": path.stat().st_size if exists else 0,
        "updatedAtMillis": int(path.stat().st_mtime * 1000) if exists else 0,
    }


def folder_file_count(path: Path, pattern: str) -> int:
    if not path.is_dir():
        return 0
    return sum(1 for item in path.glob(pattern) if item.is_file())


def capture_folder_summary(item: CameraPrepared, material_id: str) -> dict[str, Any]:
    material_root = item.camera.root / material_id
    latest = item.frames[-1]
    return {
        "camera": item.camera.name,
        "ip": frame_camera_ip(item.camera, latest),
        "sn": frame_camera_sn(item.camera, latest),
        "root": str(material_root),
        "exists": material_root.is_dir(),
        "depthFrames": folder_file_count(material_root / "depth", "*.png"),
        "intensityFrames": folder_file_count(material_root / "intensity", "*.png"),
        "metadataFrames": folder_file_count(material_root / "metadata", "*.json"),
        "sdkDerivedFolderExists": (material_root / "sdk-derived").is_dir(),
    }


def build_artifact_index(
    material_id: str,
    output_root: Path,
    run_dir: Path,
    prepared: list[CameraPrepared],
    manifest_path: Path,
    mesh_json_path: Path,
    quality_path: Path,
    obj_path: Path,
    mtl_path: Path,
    texture_path: Path,
    artifact_index_path: Path,
    acceptance_report_path: Path,
) -> dict[str, Any]:
    camera_outputs = []
    for item in prepared:
        latest = item.frames[-1]
        camera_outputs.append(
            {
                "camera": item.camera.name,
                "ip": frame_camera_ip(item.camera, latest),
                "sn": frame_camera_sn(item.camera, latest),
                "capture": capture_folder_summary(item, material_id),
                "sourceLatest": {
                    "depth": file_artifact(latest.depth_path, output_root, "source-depth"),
                    "intensity": file_artifact(latest.intensity_path, output_root, "source-intensity"),
                    "metadata": file_artifact(latest.metadata_path, output_root, "source-metadata")
                    if latest.metadata_path
                    else None,
                },
                "previews": [
                    file_artifact(item.latest_intensity_preview, output_root, "latest-intensity-preview"),
                    file_artifact(item.latest_depth_preview, output_root, "latest-depth-preview"),
                ],
                "strips": [
                    file_artifact(item.intensity_strip, output_root, "intensity-strip"),
                    file_artifact(item.depth_strip, output_root, "depth-strip"),
                ],
                "metadataCopy": file_artifact(item.latest_metadata_copy, output_root, "latest-metadata-copy")
                if item.latest_metadata_copy
                else None,
            }
        )
    mesh_outputs = [
        file_artifact(mesh_json_path, output_root, "surface-mesh-json"),
        file_artifact(quality_path, output_root, "mesh-quality"),
        file_artifact(obj_path, output_root, "obj-mesh"),
        file_artifact(mtl_path, output_root, "obj-material"),
        file_artifact(texture_path, output_root, "texture-atlas"),
    ]
    defect_outputs = []
    defects_root = run_dir / "defects"
    if defects_root.is_dir():
        for path in sorted(item for item in defects_root.rglob("*") if item.is_file()):
            defect_outputs.append(file_artifact(path, output_root, "defect-review-artifact"))
    report_outputs = [
        file_artifact(artifact_index_path, output_root, "artifact-index"),
        file_artifact(acceptance_report_path, output_root, "acceptance-report"),
    ]
    return {
        "schema": "steel.bar_surface.artifact_index.v1",
        "materialId": material_id,
        "runId": run_dir.name,
        "generatedAt": utc_now_text(),
        "algorithmRoot": str(output_root),
        "runDir": str(run_dir),
        "manifest": file_artifact(manifest_path, output_root, "manifest"),
        "cameras": camera_outputs,
        "mesh": mesh_outputs,
        "defects": defect_outputs,
        "reports": report_outputs,
        "totals": {
            "cameraCount": len(prepared),
            "previewFiles": sum(1 for item in camera_outputs for file in item["previews"] if file["exists"]),
            "stripFiles": sum(1 for item in camera_outputs for file in item["strips"] if file["exists"]),
            "meshFiles": sum(1 for file in mesh_outputs if file["exists"]),
            "defectFiles": sum(1 for file in defect_outputs if file["exists"]),
        },
    }


def build_acceptance_report(
    args: argparse.Namespace,
    material_id: str,
    output_root: Path,
    run_dir: Path,
    prepared: list[CameraPrepared],
    mesh: dict[str, Any],
    quality: dict[str, Any],
    input_crop: dict[str, Any],
    manifest_path: Path,
    mesh_json_path: Path,
    quality_path: Path,
    obj_path: Path,
    mtl_path: Path,
    texture_path: Path,
    artifact_index_path: Path,
    acceptance_report_path: Path,
) -> dict[str, Any]:
    camera_captures = [capture_folder_summary(item, material_id) for item in prepared]
    preview_count = sum(
        1
        for item in prepared
        for path in (item.latest_intensity_preview, item.latest_depth_preview)
        if path.is_file()
    )
    strip_count = sum(
        1
        for item in prepared
        for path in (item.intensity_strip, item.depth_strip)
        if path.is_file()
    )
    angular_sector_fit = mesh.get("angularSectorFit", {})
    seam_gap = quality.get("seamGapMm", {})
    checks = {
        "eightCameras": len(prepared) == 8,
        "sourceDepthComplete": all(item["depthFrames"] >= 1 for item in camera_captures),
        "sourceIntensityComplete": all(item["intensityFrames"] >= 1 for item in camera_captures),
        "sourceMetadataComplete": all(item["metadataFrames"] >= 1 for item in camera_captures),
        "sdkDerivedDisabled": not any(item["sdkDerivedFolderExists"] for item in camera_captures),
        "cameraCropUses3d": bool(input_crop.get("applied")) and int(input_crop.get("matchedCameras", 0)) >= len(prepared),
        "preview2dComplete": preview_count >= len(prepared) * 2,
        "strip2dComplete": strip_count >= len(prepared) * 2,
        "meshJsonExists": mesh_json_path.is_file(),
        "qualityReportExists": quality_path.is_file(),
        "textureExists": texture_path.is_file(),
        "objExists": obj_path.is_file() and mtl_path.is_file(),
        "contourCropApplied": bool(mesh.get("contourCrop", {}).get("applied")),
        "contourCropUses3d": mesh.get("contourCrop", {}).get("source") in {"calibrated-3d", "hybrid-3d"},
        "angularSectorFitApplied": bool(angular_sector_fit.get("applied"))
        and sum(1 for item in angular_sector_fit.get("cameras", []) if int(item.get("resampledRows", 0)) > 0) >= len(prepared),
        "closedSurfaceSeam": bool(seam_gap.get("available")) and float(seam_gap.get("max", math.inf)) <= 1.0,
        "manifestExists": manifest_path.is_file(),
        "artifactIndexExists": artifact_index_path.is_file(),
        "algorithmRootOnGDrive": str(output_root).replace("/", "\\").upper().startswith("G:\\"),
        "defectDetectionComplete": mesh.get("detection", {}).get("status") == "complete",
    }
    status = "pass" if all(checks.values()) else "attention"
    return {
        "schema": "steel.bar_surface.acceptance_report.v1",
        "status": status,
        "materialId": material_id,
        "runId": run_dir.name,
        "generatedAt": utc_now_text(),
        "algorithmRoot": str(output_root),
        "captureRoot": str(args.capture_root),
        "runDir": str(run_dir),
        "checks": checks,
        "capture": {
            "layout": "H:/camera1..camera8/<material>/{depth,intensity,metadata}",
            "cameraCount": len(prepared),
            "cameras": camera_captures,
        },
        "outputs": {
            "cropped2dPreviewFiles": preview_count,
            "strip2dFiles": strip_count,
            "manifest": str(manifest_path),
            "meshJson": str(mesh_json_path),
            "quality": str(quality_path),
            "obj": str(obj_path),
            "mtl": str(mtl_path),
            "texture": str(texture_path),
            "artifactIndex": str(artifact_index_path),
            "acceptanceReport": str(acceptance_report_path),
            "expectedCoreBinary": str(run_dir / "mesh" / "bar_surface.bsmesh"),
            "expectedCoreSummary": str(run_dir / "mesh" / "bar_surface_core_summary.json"),
        },
        "frontendReadiness": {
            "cameraTiles": len(prepared),
            "imagePreviews": preview_count,
            "hasTexture": texture_path.is_file(),
            "hasMeshJson": mesh_json_path.is_file(),
            "canUseCoreAfterServiceRun": True,
        },
        "algorithmParameters": {
            "maxFrames": args.max_frames,
            "meshRows": args.mesh_rows,
            "meshColsPerCamera": args.mesh_cols_per_camera,
            "radiusMm": args.radius_mm,
            "radialScaleMm": args.radial_scale_mm,
            "maxFaceEdgeMm": args.max_face_edge_mm,
            "contourCrop": args.contour_crop,
            "contourRadiusToleranceMm": args.contour_radius_tolerance_mm,
            "contourMinKeepRatio": args.contour_min_keep_ratio,
            "contourMinRowCoverage": args.contour_min_row_coverage,
            "contourAutoPercentile": args.contour_auto_percentile,
        },
        "inputCrop": input_crop,
        "qualitySummary": {
            "stitchMode": quality.get("stitchMode"),
            "calibratedCameraCount": quality.get("calibratedCameraCount"),
            "validPointCount": quality.get("validPointCount"),
            "calibratedPointCount": quality.get("calibratedPointCount"),
            "circleFit": quality.get("circleFit", {}),
            "seamGapMm": quality.get("seamGapMm", {}),
            "angularSectorFit": quality.get("angularSectorFit", {}),
            "surfaceCompleteness": quality.get("surfaceCompleteness", {}),
            "contourCrop": quality.get("contourCrop", {}),
            "topology": mesh.get("topology", {}),
            "vertexCount": len(mesh["positions"]) // 3,
            "triangleCount": len(mesh["indices"]) // 3,
        },
        "notes": [
            "Radial-residual defect detection is executed after calibrated closed-surface reconstruction.",
            "C++ core output is expected after the Rust service invokes the core converter for this manifest.",
        ],
    }


def acceptance_manifest_summary(report: dict[str, Any], output_root: Path, acceptance_report_path: Path) -> dict[str, Any]:
    checks = report.get("checks", {})
    failed_checks = [name for name, value in checks.items() if value is not True]
    return {
        "status": report.get("status", "unknown"),
        "generatedAt": report.get("generatedAt", ""),
        "report": str(acceptance_report_path),
        "reportRelative": relative_to_root(acceptance_report_path, output_root),
        "passedChecks": sum(1 for value in checks.values() if value is True),
        "totalChecks": len(checks),
        "failedChecks": failed_checks,
        "sdkDerivedDisabled": bool(checks.get("sdkDerivedDisabled")),
        "frontendReady": bool(report.get("frontendReadiness", {}).get("hasTexture"))
        and bool(report.get("frontendReadiness", {}).get("hasMeshJson"))
        and int(report.get("frontendReadiness", {}).get("cameraTiles", 0)) >= 8,
    }


def finalize_quality_gate(
    manifest: dict[str, Any],
    reconstruction_acceptance: dict[str, Any],
    algorithm_config: dict[str, Any],
) -> dict[str, Any]:
    policy = algorithm_config.get("qualityGate", {})
    reasons: list[str] = []
    required_cameras = int(policy.get("requiredCameraCount", 8))
    if int(manifest.get("cameraCount", 0)) != required_cameras:
        reasons.append("required_camera_count_not_met")
    if bool(policy.get("requireCalibrationForEveryCamera", True)) and int(
        manifest.get("calibration", {}).get("matchedCameras", 0)
    ) != required_cameras:
        reasons.append("calibration_not_matched_for_every_camera")
    if bool(policy.get("requireReconstructionAcceptance", True)) and reconstruction_acceptance.get("status") != "pass":
        reasons.append("reconstruction_acceptance_failed")
    maximum_synthetic = int(policy.get("maximumSyntheticDefectCount", 0))
    if int(manifest.get("syntheticDefectCount", 0)) > maximum_synthetic:
        reasons.append("synthetic_defect_limit_exceeded")
    if not re.fullmatch(r"[0-9a-f]{64}", str(manifest.get("inputSummarySha256", ""))):
        reasons.append("input_summary_sha256_missing")
    if not str(manifest.get("algorithmVersion", "")).strip():
        reasons.append("algorithm_version_missing")
    if not re.fullmatch(r"[0-9a-f]{64}", str(manifest.get("configSha256", ""))):
        reasons.append("config_sha256_missing")
    input_artifacts = manifest.get("inputArtifacts")
    if not isinstance(input_artifacts, list) or not input_artifacts:
        reasons.append("input_artifacts_missing")
    elif canonical_sha256(input_artifacts) != manifest.get("inputSummarySha256"):
        reasons.append("input_summary_sha256_mismatch")
    for key in (
        "scriptSha256",
        "coreSha256",
        "acceptanceReportSha256",
        "datasetSha256",
        "evaluatorSha256",
        "calibrationSha256",
    ):
        if not re.fullmatch(r"[0-9a-f]{64}", str(manifest.get(key, ""))):
            reasons.append(f"{key}_missing")
    if not re.fullmatch(r"[0-9a-f]{40,64}", str(manifest.get("releaseCommit", ""))):
        reasons.append("release_commit_missing")
    for key in ("datasetRevision", "evaluatorRevision", "calibrationRevision"):
        if not str(manifest.get(key, "")).strip():
            reasons.append(f"{key}_missing")
    return {"passed": not reasons, "reasons": reasons}


def build_manifest(
    args: argparse.Namespace,
    material_id: str,
    output_root: Path,
    run_dir: Path,
    prepared: list[CameraPrepared],
    mesh_json_path: Path,
    obj_path: Path,
    mtl_path: Path,
    texture_path: Path,
    texture_size: tuple[int, int],
    mesh: dict[str, Any],
    quality: dict[str, Any],
    calibration_path: Path | None,
    calibration: dict[str, CameraCalibration],
    algorithm_config: dict[str, Any],
    algorithm_qualification: dict[str, Any],
    input_traceability: dict[str, Any],
    input_crop: dict[str, Any],
    quality_path: Path,
    artifact_index_path: Path,
    acceptance_report_path: Path,
) -> dict[str, Any]:
    cameras = []
    for item in prepared:
        latest = item.frames[-1]
        config = latest.metadata.get("captureConfig") or {}
        item_calibration = camera_calibration_for(item, calibration)
        cameras.append(
            {
                "name": item.camera.name,
                "ip": frame_camera_ip(item.camera, latest),
                "sn": frame_camera_sn(item.camera, latest),
                "root": str(item.camera.root),
                "frameCount": len(item.frames),
                "latestFrame": latest.stem,
                "size": {"width": item.width, "height": item.height},
                "cropBox": list(item.crop_box),
                "cropSource": item.crop_source,
                "medianDepth": round(item.median_depth, 4),
                "depthSpread": round(item.depth_spread, 4),
                "calibrationApplied": item_calibration is not None,
                "calibrationSn": item_calibration.sn if item_calibration else "",
                "calibrationRotateY": round(item_calibration.rotate_y, 8) if item_calibration else None,
                "captureConfig": config,
                "latest": {
                    "depthPreview": str(item.latest_depth_preview),
                    "intensityPreview": str(item.latest_intensity_preview),
                    "metadata": str(item.latest_metadata_copy) if item.latest_metadata_copy else "",
                    "sourceDepth": str(latest.depth_path),
                    "sourceIntensity": str(latest.intensity_path),
                },
                "relative": {
                    "depthPreview": relative_to_root(item.latest_depth_preview, output_root),
                    "intensityPreview": relative_to_root(item.latest_intensity_preview, output_root),
                    "intensityStrip": relative_to_root(item.intensity_strip, output_root),
                    "depthStrip": relative_to_root(item.depth_strip, output_root),
                },
            }
        )
    calibration_revision, calibration_sha256 = calibration_identity(calibration_path)
    detection = mesh.get("detection", {})
    return {
        "schema": "steel.bar_surface.manifest.v1",
        "algorithmName": algorithm_config.get("algorithmName", "bar-surface-defect-detector"),
        "algorithmVersion": algorithm_config.get("algorithmVersion", "development-unversioned"),
        "configRevision": algorithm_config.get("configRevision", "development-defaults"),
        "configSha256": algorithm_config.get("configSha256", ""),
        "scriptSha256": algorithm_qualification.get("scriptSha256", sha256_file(Path(__file__).resolve())),
        "coreSha256": algorithm_qualification.get("coreSha256", ""),
        "releaseCommit": algorithm_qualification.get("releaseCommit", ""),
        "acceptanceReportSha256": algorithm_qualification.get("acceptanceReportSha256", ""),
        "datasetRevision": algorithm_qualification.get("datasetRevision", ""),
        "datasetSha256": algorithm_qualification.get("datasetSha256", ""),
        "evaluatorRevision": algorithm_qualification.get("evaluatorRevision", ""),
        "evaluatorSha256": algorithm_qualification.get("evaluatorSha256", ""),
        "calibrationRevision": calibration_revision,
        "calibrationSha256": calibration_sha256,
        "inputSummarySha256": input_traceability.get("inputSummarySha256", ""),
        "inputFrameIds": input_traceability.get("inputFrameIds", []),
        "inputArtifactCount": input_traceability.get("inputArtifactCount", 0),
        "inputArtifacts": input_traceability.get("inputArtifacts", []),
        "qualification": algorithm_qualification,
        "thresholds": algorithm_config.get("effectiveThresholds", {}),
        "qualityGate": {"passed": False, "reasons": ["acceptance_pending"]},
        "realDefectCount": int(detection.get("realDefectCount", 0)),
        "syntheticDefectCount": int(detection.get("syntheticDefectCount", 0)),
        "materialId": material_id,
        "runId": run_dir.name,
        "createdAt": utc_now_text(),
        "captureRoot": str(args.capture_root),
        "algorithmRoot": str(output_root),
        "runDir": str(run_dir),
        "cameraCount": len(prepared),
        "calibration": {
            "mode": mesh.get("stitchMode", "unknown"),
            "path": str(calibration_path) if calibration_path else "",
            "available": bool(calibration),
            "matchedCameras": mesh.get("calibratedCameraCount", 0),
            "totalCameras": len(prepared),
            "revision": calibration_revision,
            "sha256": calibration_sha256,
        },
        "inputCrop": input_crop,
        "mesh": {
            "json": str(mesh_json_path),
            "obj": str(obj_path),
            "mtl": str(mtl_path),
            "texture": str(texture_path),
            "textureSize": {"width": texture_size[0], "height": texture_size[1]},
            "vertexCount": len(mesh["positions"]) // 3,
            "triangleCount": len(mesh["indices"]) // 3,
            "frameCount": len(mesh["frameStems"]),
            "rows": mesh["rows"],
            "colsPerCamera": mesh["colsPerCamera"],
            "topology": mesh.get("topology", {}),
            "contourCrop": mesh.get("contourCrop", {}),
            "coordinateFrame": mesh.get("coordinateFrame", {}),
            "angularSectorFit": mesh.get("angularSectorFit", {}),
        },
        "quality": quality,
        "detection": detection,
        "reports": {
            "artifactIndex": str(artifact_index_path),
            "acceptanceReport": str(acceptance_report_path),
        },
        "relative": {
            "meshJson": relative_to_root(mesh_json_path, output_root),
            "quality": relative_to_root(quality_path, output_root),
            "obj": relative_to_root(obj_path, output_root),
            "mtl": relative_to_root(mtl_path, output_root),
            "texture": relative_to_root(texture_path, output_root),
            "artifactIndex": relative_to_root(artifact_index_path, output_root),
            "acceptanceReport": relative_to_root(acceptance_report_path, output_root),
        },
        "cameras": cameras,
        "notes": [
            "Prototype uses ArrayCalibration XML when available and falls back per camera to cylindrical preview.",
            "Depth values are transformed with BlendScale/Offset and Matrix fields for calibrated cameras.",
            "Defects use robust per-row radial residuals and connected components; operator review remains required.",
        ],
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    runtime_profile = os.environ.get("STEEL_RUNTIME_PROFILE", "production").strip().lower()
    algorithm_mode = os.environ.get("STEEL_ALGORITHM_MODE", "production").strip().lower()
    synthetic_fixtures_allowed = (
        runtime_profile in {"development", "dev", "test"}
        and algorithm_mode == "demo"
    )
    production_policy = not synthetic_fixtures_allowed
    algorithm_config = apply_algorithm_config(args, production_policy)
    if not synthetic_fixtures_allowed and args.mock_defect_count != 0:
        raise ValueError(
            "synthetic defects require STEEL_RUNTIME_PROFILE=development "
            "and STEEL_ALGORITHM_MODE=demo"
        )
    output_root = Path(args.output_root)
    cameras = parse_camera_roots(args)
    material_id = args.material_id.strip() if args.material_id else ""
    if not material_id or material_id.lower() == "latest":
        material_id = latest_material_id(cameras)
    run_id = f"{safe_segment(material_id)}-{local_stamp()}"
    run_dir = output_root / "runs" / safe_segment(material_id) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    write_profile(output_root)
    calibration_path = Path(args.calibration) if args.calibration else latest_default_calibration()
    calibration = load_array_calibration(calibration_path)
    algorithm_qualification = load_algorithm_qualification(
        algorithm_config,
        calibration_path,
        production_policy,
    )

    per_camera_frames: list[list[CameraFrame]] = [
        discover_camera_frames(camera, material_id, args.max_frames) for camera in cameras
    ]
    common_stems = sorted(set.intersection(*[set(frame.stem for frame in frames) for frames in per_camera_frames]))
    if args.max_frames > 0:
        common_stems = common_stems[-args.max_frames :]
    if not common_stems:
        raise ValueError("No common frame stems across the eight cameras")
    per_camera_frames = [
        [frame for frame in frames if frame.stem in set(common_stems)] for frames in per_camera_frames
    ]
    input_sources = list(zip(cameras, per_camera_frames))
    input_traceability = build_input_traceability(input_sources, common_stems)

    crop_boxes, input_crop = estimate_3d_contour_crop_boxes(
        cameras,
        per_camera_frames,
        calibration,
        args.contour_radius_tolerance_mm,
        args.contour_auto_percentile,
        args.contour_minimum_tolerance_mm,
        args.contour_mad_multiplier,
    )
    prepared = []
    for camera, frames in zip(cameras, per_camera_frames):
        crop_box = crop_boxes.get(camera.name)
        crop_record = input_crop.get("perCamera", {}).get(camera.name, {})
        prepared.append(
            prepare_camera(
                camera,
                material_id,
                frames,
                run_dir,
                args.preview_max_width,
                args.texture_tile_width,
                args.texture_frame_height,
                crop_box,
                str(crop_record.get("source", "image-threshold")),
            )
        )
    stems = common_frame_stems(prepared)
    if args.max_frames > 0:
        stems = stems[-args.max_frames :]
    if stems != common_stems:
        input_traceability = build_input_traceability(input_sources, stems)

    texture_path = run_dir / "mesh" / "bar_surface_texture.png"
    texture_size = build_texture_atlas(prepared, texture_path)
    mesh = build_mesh(
        prepared,
        stems,
        args.mesh_rows,
        args.mesh_cols_per_camera,
        args.radius_mm,
        args.radial_scale_mm,
        calibration,
        args.max_face_edge_mm,
        args.contour_crop,
        args.contour_radius_tolerance_mm,
        args.contour_min_keep_ratio,
        args.contour_min_row_coverage,
        args.contour_auto_percentile,
        args.contour_minimum_tolerance_mm,
        args.contour_mad_multiplier,
        args.contour_fallback_percentile,
        args.mesh_longitudinal_step_mm,
    )
    quality = mesh_quality_metrics(mesh)
    detection = detect_surface_defects(
        mesh,
        args.defect_min_depth_mm,
        args.defect_min_area_points,
        args.defect_mad_multiplier,
        args.defect_longitudinal_span_floor_mm,
        args.severity_severe_absolute_mm,
        args.severity_severe_threshold_multiplier,
        args.severity_review_absolute_mm,
        args.severity_review_threshold_multiplier,
        args.confidence_base,
        args.confidence_magnitude_weight,
        args.confidence_area_weight,
        args.confidence_area_normalization_points,
        args.confidence_maximum,
    )
    real_defect_count = int(detection.get("defectCount", 0))
    mock_defects = generate_mock_defects(mesh, args.mock_defect_count)
    detection["defects"] = list(detection.get("defects", [])) + mock_defects
    detection["realDefectCount"] = real_defect_count
    detection["syntheticDefectCount"] = len(mock_defects)
    detection["defectCount"] = len(detection["defects"])
    detection["syntheticEnabled"] = bool(mock_defects)
    materialize_defect_artifacts(mesh, detection, prepared, stems, run_dir, output_root)
    mesh["detection"] = detection
    assert_input_traceability_unchanged(input_traceability, input_sources, stems)
    mesh_json_path = run_dir / "mesh" / "bar_surface_mesh.json"
    quality_path = run_dir / "mesh" / "bar_surface_quality.json"
    reports_dir = run_dir / "reports"
    artifact_index_path = reports_dir / "artifact_index.json"
    acceptance_report_path = reports_dir / "acceptance_report.json"
    atomic_write_json(mesh_json_path, mesh)
    atomic_write_json(quality_path, quality)
    obj_path = run_dir / "mesh" / "bar_surface.obj"
    mtl_path = write_obj(mesh, texture_path.name, obj_path)
    manifest_path = run_dir / "manifest.json"

    manifest = build_manifest(
        args,
        material_id,
        output_root,
        run_dir,
        prepared,
        mesh_json_path,
        obj_path,
        mtl_path,
        texture_path,
        texture_size,
        mesh,
        quality,
        calibration_path,
        calibration,
        algorithm_config,
        algorithm_qualification,
        input_traceability,
        input_crop,
        quality_path,
        artifact_index_path,
        acceptance_report_path,
    )
    atomic_write_json(manifest_path, manifest)

    artifact_index = build_artifact_index(
        material_id,
        output_root,
        run_dir,
        prepared,
        manifest_path,
        mesh_json_path,
        quality_path,
        obj_path,
        mtl_path,
        texture_path,
        artifact_index_path,
        acceptance_report_path,
    )
    atomic_write_json(artifact_index_path, artifact_index)
    acceptance_report = build_acceptance_report(
        args,
        material_id,
        output_root,
        run_dir,
        prepared,
        mesh,
        quality,
        input_crop,
        manifest_path,
        mesh_json_path,
        quality_path,
        obj_path,
        mtl_path,
        texture_path,
        artifact_index_path,
        acceptance_report_path,
    )
    atomic_write_json(acceptance_report_path, acceptance_report)
    manifest["acceptance"] = acceptance_manifest_summary(acceptance_report, output_root, acceptance_report_path)
    manifest["qualityGate"] = finalize_quality_gate(manifest, acceptance_report, algorithm_config)
    atomic_write_json(manifest_path, manifest)
    artifact_index = build_artifact_index(
        material_id,
        output_root,
        run_dir,
        prepared,
        manifest_path,
        mesh_json_path,
        quality_path,
        obj_path,
        mtl_path,
        texture_path,
        artifact_index_path,
        acceptance_report_path,
    )
    atomic_write_json(artifact_index_path, artifact_index)
    assert_input_traceability_unchanged(input_traceability, input_sources, stems)
    if production_policy and not bool(manifest["qualityGate"].get("passed")):
        raise ValueError(
            "production algorithm quality gate failed: "
            + ",".join(str(reason) for reason in manifest["qualityGate"].get("reasons", []))
        )
    latest = {
        "schema": "steel.bar_surface.latest.v1",
        "updatedAt": utc_now_text(),
        "algorithmRoot": str(output_root),
        "materialId": material_id,
        "runId": run_id,
        "runDir": str(run_dir),
        "manifestPath": str(manifest_path),
    }
    atomic_write_json(output_root / "latest.json", latest)
    print(json.dumps({"code": 0, "manifestPath": str(manifest_path), "latestPath": str(output_root / "latest.json")}, ensure_ascii=False))
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build bar-surface stitching prototype outputs.")
    parser.add_argument("--capture-root", default=str(DEFAULT_CAPTURE_ROOT), help="Root that contains camera1..camera8")
    parser.add_argument("--output-root", default=str(DEFAULT_OUTPUT_ROOT), help="Algorithm output root")
    parser.add_argument("--material-id", default="latest", help="Material/coil directory name, or latest")
    parser.add_argument("--calibration", default="", help="ArrayCalibration.xml path; defaults to latest corrected calibration")
    parser.add_argument("--algorithm-config", default=os.environ.get("STEEL_ALGORITHM_CONFIG", str(DEFAULT_ALGORITHM_CONFIG)), help="Versioned algorithm threshold configuration")
    parser.add_argument("--camera-root", dest="camera_roots", action="append", default=[], help="name,path[,ip[,sn]]")
    parser.add_argument("--max-frames", type=int, default=None, help="Latest common frame count to use")
    parser.add_argument("--preview-max-width", type=int, default=1200)
    parser.add_argument("--texture-tile-width", type=int, default=512)
    parser.add_argument("--texture-frame-height", type=int, default=96)
    parser.add_argument("--mesh-cols-per-camera", type=int, default=None)
    parser.add_argument("--mesh-rows", type=int, default=None)
    parser.add_argument("--radius-mm", type=float, default=None)
    parser.add_argument("--radial-scale-mm", type=float, default=None)
    parser.add_argument("--max-face-edge-mm", type=float, default=None, help="Skip triangles across larger gaps; 0 disables")
    parser.add_argument("--no-contour-crop", dest="contour_crop", action="store_false", help="Disable 3D contour clipping")
    parser.add_argument("--contour-radius-tolerance-mm", type=float, default=None, help="Fixed X/Z circle residual tolerance; 0 uses robust auto tolerance")
    parser.add_argument("--contour-min-keep-ratio", type=float, default=None, help="Fallback instead of over-cropping if too many points would be removed")
    parser.add_argument("--contour-min-row-coverage", type=float, default=None, help="Drop scan rows whose contour coverage is below this ratio")
    parser.add_argument("--contour-auto-percentile", type=float, default=None, help="Auto contour tolerance residual percentile")
    parser.add_argument("--contour-minimum-tolerance-mm", type=float, default=None, help="Minimum automatic contour tolerance")
    parser.add_argument("--contour-mad-multiplier", type=float, default=None, help="MAD multiplier for automatic contour tolerance")
    parser.add_argument("--contour-fallback-percentile", type=float, default=None, help="Fallback contour residual percentile")
    parser.add_argument("--mesh-longitudinal-step-mm", type=float, default=None, help="Fallback uncalibrated mesh row spacing")
    parser.add_argument("--defect-min-depth-mm", type=float, default=None, help="Minimum local radial deviation for defect candidates")
    parser.add_argument("--defect-min-area-points", type=int, default=None, help="Minimum connected mesh samples for a defect")
    parser.add_argument("--defect-mad-multiplier", type=float, default=None, help="MAD multiplier for defect candidates")
    parser.add_argument("--defect-longitudinal-span-floor-mm", type=float, default=None)
    parser.add_argument("--severity-severe-absolute-mm", type=float, default=None)
    parser.add_argument("--severity-severe-threshold-multiplier", type=float, default=None)
    parser.add_argument("--severity-review-absolute-mm", type=float, default=None)
    parser.add_argument("--severity-review-threshold-multiplier", type=float, default=None)
    parser.add_argument("--confidence-base", type=float, default=None)
    parser.add_argument("--confidence-magnitude-weight", type=float, default=None)
    parser.add_argument("--confidence-area-weight", type=float, default=None)
    parser.add_argument("--confidence-area-normalization-points", type=float, default=None)
    parser.add_argument("--confidence-maximum", type=float, default=None)
    parser.add_argument(
        "--mock-defect-count",
        type=int,
        default=int(os.environ.get("BAR_SURFACE_MOCK_DEFECT_COUNT", "0")),
        help="Explicit demo-only deterministic defects appended for UI/database verification; defaults to 0",
    )
    parser.set_defaults(contour_crop=None)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        run(args)
        return 0
    except Exception as exc:
        print(json.dumps({"code": 1, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
