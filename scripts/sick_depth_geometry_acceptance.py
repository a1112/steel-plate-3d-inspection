"""Bounded acceptance runner for the SICK six-camera depth geometry path.

This module is intentionally a small, finite command-line tool.  It discovers
the material directories shared by all six camera roots in a SICK capture
profile, processes the newest requested flows with the pure depth geometry
builder, and writes a compact JSON summary.  It does not start a capture
service, open a listening socket, or retain the per-flow geometry artifacts.

The tool is useful for a controlled historical backfill check.  It is not a
replacement for the capture service and therefore has no background workers or
unbounded retry loop.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from collections import Counter
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

# ``python scripts/sick_depth_geometry_acceptance.py`` puts ``scripts`` on
# sys.path rather than the repository root on some Python installations.
# Keep the direct command-line form as reliable as the module import form.
if __package__ in {None, ""}:  # pragma: no cover - exercised by the CLI
    _repository_root = Path(__file__).resolve().parents[1]
    if str(_repository_root) not in sys.path:
        sys.path.insert(0, str(_repository_root))

from scripts.sick_capture.depth_geometry import (  # noqa: E402
    DEPTH_GEOMETRY_SOURCE,
    DepthGeometryConfig,
    build_flow_depth_geometry,
    config_hash,
    load_depth_geometry_config,
)
from scripts.sick_capture.profile import (  # noqa: E402
    SickCaptureProfile,
    load_profile,
)


ACCEPTANCE_SCHEMA = "steel.sick-depth-geometry-acceptance.v1"
DEFAULT_LIMIT = 30
MINIMUM_LIMIT = 30
MAXIMUM_LIMIT = 10_000
DEFAULT_MAX_FRAMES = 8
MAXIMUM_MAX_FRAMES = 10_000
EXPECTED_CAMERA_COUNT = 6

# These names are emitted by the pure geometry detector.  Keeping the set in
# one place also makes a no-candidate report explicit instead of omitting a
# class key.
PROVISIONAL_CLASSES = (
    "pit-compact",
    "groove-elongated",
    "bulge-compact",
    "ridge-elongated",
)

ExecutionGate = Callable[[str], None]


def _gate(execution_gate: ExecutionGate | None, phase: str) -> None:
    if execution_gate is not None:
        execution_gate(str(phase))


def _validated_limit(value: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("limit must be an integer") from error
    if parsed < MINIMUM_LIMIT:
        raise ValueError(f"limit must be at least {MINIMUM_LIMIT}")
    if parsed > MAXIMUM_LIMIT:
        raise ValueError(f"limit must not exceed {MAXIMUM_LIMIT}")
    return parsed


def _validated_max_frames(value: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("max_frames must be an integer") from error
    if parsed < 1:
        raise ValueError("max_frames must be at least 1")
    if parsed > MAXIMUM_MAX_FRAMES:
        raise ValueError(f"max_frames must not exceed {MAXIMUM_MAX_FRAMES}")
    return parsed


def _as_profile(
    profile: SickCaptureProfile | str | Path,
    *,
    execution_gate: ExecutionGate | None = None,
) -> SickCaptureProfile:
    if isinstance(profile, SickCaptureProfile):
        return profile
    profile_path = Path(profile).resolve()
    _gate(execution_gate, f"acceptance-profile-read:{profile_path}")
    # Historical acceptance only needs the profile's storage topology.  CTI
    # verification would make a read-only disk report depend on live hardware
    # installation state, so it is deliberately disabled here.
    return load_profile(profile_path, strict_hardware=False, verify_cti=False)


def _numeric_material_directories(
    root: Path,
    *,
    execution_gate: ExecutionGate | None = None,
) -> dict[str, Path]:
    """Return canonical positive numeric child directories for one camera.

    The capture layout canonicalizes flow IDs (``001`` and ``1`` refer to the
    same logical ID), while the builder resolves the canonical path.  To avoid
    discovering a directory that the builder cannot open, only canonical
    decimal names are accepted here.
    """

    _gate(execution_gate, f"acceptance-material-root-stat:{root}")
    if not root.is_dir():
        return {}
    result: dict[str, Path] = {}
    _gate(execution_gate, f"acceptance-material-directory-scan:{root}")
    for child in root.iterdir():
        _gate(execution_gate, f"acceptance-material-directory-stat:{child}")
        if not child.is_dir() or not child.name or not child.name.isascii():
            continue
        if not child.name.isdigit() or int(child.name) <= 0:
            continue
        if child.name != str(int(child.name)):
            # ``capture_root`` normalizes IDs before opening them.  A leading
            # zero directory would therefore be a false positive here.
            continue
        result[child.name] = child
    return result


def _discover_common_material_ids(
    capture_profile: SickCaptureProfile,
    *,
    execution_gate: ExecutionGate | None = None,
) -> list[str]:
    """Discover a bounded newest-first common-ID list for one loaded profile."""

    cameras = capture_profile.enabled_cameras
    if len(cameras) != EXPECTED_CAMERA_COUNT:
        raise ValueError(
            "SICK depth geometry acceptance requires exactly six enabled cameras "
            f"(found {len(cameras)})"
        )

    camera_materials: list[set[str]] = []
    for camera in cameras:
        directories = _numeric_material_directories(
            Path(camera.storage_root), execution_gate=execution_gate
        )
        camera_materials.append(set(directories))
    if not camera_materials:
        return []
    common = set.intersection(*camera_materials)
    ordered = sorted(common, key=lambda value: int(value), reverse=True)
    # Discovery itself is bounded too.  The acceptance contract only needs to
    # know whether at least ``limit`` IDs exist and never needs an unbounded
    # list merely to prove that fact.
    return ordered[:MAXIMUM_LIMIT]


def discover_common_material_ids(
    profile: SickCaptureProfile | str | Path,
    *,
    limit: int = DEFAULT_LIMIT,
    execution_gate: ExecutionGate | None = None,
) -> list[str]:
    """Find common positive numeric material IDs in newest-first order.

    ``limit`` is validated even when the caller only wants discovery.  This
    keeps the public API aligned with the bounded acceptance contract and
    prevents accidental unbounded real-data scans.
    """

    requested = _validated_limit(limit)
    capture_profile = _as_profile(profile, execution_gate=execution_gate)
    return _discover_common_material_ids(
        capture_profile, execution_gate=execution_gate
    )[:requested]


def _load_acceptance_config(
    profile: SickCaptureProfile,
    *,
    max_frames: int,
    algorithm_config_path: str | Path | None,
    execution_gate: ExecutionGate | None = None,
) -> DepthGeometryConfig:
    frame_limit = _validated_max_frames(max_frames)
    if algorithm_config_path is None:
        candidate = profile.source_path.parent / "algorithm.json"
        _gate(execution_gate, f"acceptance-algorithm-config-stat:{candidate}")
        if candidate.is_file():
            _gate(execution_gate, f"acceptance-algorithm-config-read:{candidate}")
            base = load_depth_geometry_config(candidate)
        else:
            base = DepthGeometryConfig()
    else:
        candidate = Path(algorithm_config_path).resolve()
        _gate(execution_gate, f"acceptance-algorithm-config-read:{candidate}")
        base = load_depth_geometry_config(candidate)
    # The acceptance CLI's frame bound is authoritative.  ``replace`` retains
    # every threshold from the selected algorithm seed while making the amount
    # of source data processed by this command explicit.
    return replace(base, max_frames=frame_limit).bounded()


def _artifact_defects(artifact: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    direct = artifact.get("defects")
    if isinstance(direct, list):
        return [item for item in direct if isinstance(item, Mapping)]
    cameras = artifact.get("cameras")
    if not isinstance(cameras, Mapping):
        return []
    defects: list[Mapping[str, Any]] = []
    for camera_artifact in cameras.values():
        if not isinstance(camera_artifact, Mapping):
            continue
        camera_defects = camera_artifact.get("defects")
        if isinstance(camera_defects, list):
            defects.extend(
                item for item in camera_defects if isinstance(item, Mapping)
            )
    return defects


def _artifact_horizontal_metrics(
    artifact: Mapping[str, Any],
) -> tuple[int, int, bool, bool]:
    """Return valid/observed camera counts and any/all flow availability."""

    cameras = artifact.get("cameras")
    values: list[bool] = []
    if isinstance(cameras, Mapping):
        for camera_artifact in cameras.values():
            if not isinstance(camera_artifact, Mapping):
                continue
            metric = camera_artifact.get("metric")
            if isinstance(metric, Mapping) and "horizontalValid" in metric:
                values.append(bool(metric.get("horizontalValid")))
            elif "metricValid" in camera_artifact:
                values.append(bool(camera_artifact.get("metricValid")))
    if not values:
        metric = artifact.get("metric")
        if isinstance(metric, Mapping) and "horizontalValid" in metric:
            values.append(bool(metric.get("horizontalValid")))
        elif "metricValid" in artifact:
            values.append(bool(artifact.get("metricValid")))
    valid = sum(1 for value in values if value)
    observed = len(values)
    return valid, observed, bool(valid), bool(values) and valid == observed


def _summarize_flow(
    material_id: str,
    artifact: Mapping[str, Any],
    *,
    expected_camera_count: int,
) -> tuple[dict[str, Any], Counter[str], int, int, int, int, int, bool, bool]:
    defects = _artifact_defects(artifact)
    class_counts: Counter[str] = Counter()
    unknown_count = 0
    longitudinal_mm_non_null = 0
    longitudinal_non_null = 0
    area_non_null = 0
    for defect in defects:
        class_name = str(
            defect.get("className", defect.get("class", defect.get("provisionalClass", "")))
            or "unknown"
        )
        if class_name in PROVISIONAL_CLASSES:
            class_counts[class_name] += 1
        else:
            unknown_count += 1
        if defect.get("longitudinalMm") is not None:
            longitudinal_mm_non_null += 1
        if defect.get("longitudinalSpanMm") is not None:
            longitudinal_non_null += 1
        if defect.get("areaMm2") is not None:
            area_non_null += 1

    valid_cameras, observed_cameras, any_horizontal, all_horizontal = (
        _artifact_horizontal_metrics(artifact)
    )
    # A builder artifact can omit empty camera entries.  The report retains
    # the configured six-camera denominator separately from the observed
    # metrics so that a partial artifact cannot look like six calibrated heads.
    row = {
        "materialId": str(material_id),
        "state": str(artifact.get("state", "ready")),
        "success": True,
        "defectCount": len(defects),
        "classCounts": {
            name: int(class_counts.get(name, 0))
            for name in PROVISIONAL_CLASSES
        },
        "unknownClassCount": int(unknown_count),
        "horizontalCalibrationAvailable": any_horizontal,
        "horizontalCalibrationAllCameras": all_horizontal,
        "horizontalCalibrationValidCameraCount": valid_cameras,
        "horizontalCalibrationObservedCameraCount": observed_cameras,
        "expectedCameraCount": expected_camera_count,
        "longitudinalMmNonNullCount": longitudinal_mm_non_null,
        "longitudinalSpanMmNonNullCount": longitudinal_non_null,
        "areaMm2NonNullCount": area_non_null,
    }
    return (
        row,
        class_counts,
        unknown_count,
        len(defects),
        longitudinal_mm_non_null,
        longitudinal_non_null,
        area_non_null,
        any_horizontal,
        all_horizontal,
    )


def atomic_write_json(path: str | Path, payload: Mapping[str, Any]) -> Path:
    """Atomically replace a JSON report and return its resolved path."""

    destination = Path(path).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".tmp",
        dir=str(destination.parent),
        text=True,
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True)
            + "\n",
            encoding="utf-8",
        )
        os.replace(str(temporary), str(destination))
    finally:
        if temporary.exists():
            temporary.unlink()
    return destination


def run_acceptance(
    profile: SickCaptureProfile | str | Path,
    *,
    limit: int = DEFAULT_LIMIT,
    max_frames: int = DEFAULT_MAX_FRAMES,
    algorithm_config_path: str | Path | None = None,
    report_path: str | Path | None = None,
    execution_gate: ExecutionGate | None = None,
) -> dict[str, Any]:
    """Run the finite newest-first depth geometry acceptance batch.

    Fewer than ``limit`` common flows is a reportable acceptance failure, not
    a reason to scan beyond the requested bound.  A failed individual flow is
    recorded and processing continues with the next already-selected ID.
    """

    requested = _validated_limit(limit)
    frame_limit = _validated_max_frames(max_frames)
    capture_profile = _as_profile(profile, execution_gate=execution_gate)
    cameras = capture_profile.enabled_cameras
    if len(cameras) != EXPECTED_CAMERA_COUNT:
        raise ValueError(
            "SICK depth geometry acceptance requires exactly six enabled cameras "
            f"(found {len(cameras)})"
        )
    settings = _load_acceptance_config(
        capture_profile,
        max_frames=frame_limit,
        algorithm_config_path=algorithm_config_path,
        execution_gate=execution_gate,
    )
    all_material_ids = _discover_common_material_ids(
        capture_profile, execution_gate=execution_gate
    )
    material_ids = all_material_ids[:requested]
    camera_roots = {
        str(camera.camera_id): str(camera.storage_root) for camera in cameras
    }

    flow_rows: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    aggregate_classes: Counter[str] = Counter()
    aggregate_unknown = 0
    aggregate_defects = 0
    aggregate_longitudinal_mm_non_null = 0
    aggregate_longitudinal_non_null = 0
    aggregate_area_non_null = 0
    horizontal_flows = 0
    all_horizontal_flows = 0
    horizontal_valid_cameras = 0
    horizontal_observed_cameras = 0
    successful = 0

    # This is intentionally a ``for`` over a bounded, materialized selection:
    # there is no retry or service loop hidden in the acceptance command.
    for material_id in material_ids:
        artifact: Mapping[str, Any] | None = None
        try:
            artifact = build_flow_depth_geometry(
                camera_roots=camera_roots,
                storage_root=str(capture_profile.storage_root),
                material_id=str(material_id),
                alignment={},
                config=settings,
                execution_gate=execution_gate,
            )
            if not isinstance(artifact, Mapping):
                raise ValueError("depth geometry builder returned a non-object artifact")
            state = str(artifact.get("state", "ready"))
            if state not in {"ready", "empty"}:
                raise ValueError(f"depth geometry artifact state is {state!r}")
            (
                row,
                class_counts,
                unknown_count,
                defect_count,
                longitudinal_mm_non_null,
                longitudinal_non_null,
                area_non_null,
                any_horizontal,
                all_horizontal,
            ) = _summarize_flow(
                str(material_id), artifact, expected_camera_count=EXPECTED_CAMERA_COUNT
            )
            valid_cameras, observed_cameras, _any, _all = _artifact_horizontal_metrics(
                artifact
            )
            flow_rows.append(row)
            successful += 1
            aggregate_classes.update(class_counts)
            aggregate_unknown += unknown_count
            aggregate_defects += defect_count
            aggregate_longitudinal_mm_non_null += longitudinal_mm_non_null
            aggregate_longitudinal_non_null += longitudinal_non_null
            aggregate_area_non_null += area_non_null
            horizontal_flows += int(any_horizontal)
            all_horizontal_flows += int(all_horizontal)
            horizontal_valid_cameras += valid_cameras
            horizontal_observed_cameras += observed_cameras
        except Exception as error:  # one bad historical flow must be visible, not fatal
            row = {
                "materialId": str(material_id),
                "state": "failed",
                "success": False,
                "defectCount": 0,
                "classCounts": {name: 0 for name in PROVISIONAL_CLASSES},
                "unknownClassCount": 0,
                "horizontalCalibrationAvailable": False,
                "horizontalCalibrationAllCameras": False,
                "horizontalCalibrationValidCameraCount": 0,
                "horizontalCalibrationObservedCameraCount": 0,
                "expectedCameraCount": EXPECTED_CAMERA_COUNT,
                "longitudinalMmNonNullCount": 0,
                "longitudinalSpanMmNonNullCount": 0,
                "areaMm2NonNullCount": 0,
                "error": {
                    "type": type(error).__name__,
                    "message": str(error),
                },
            }
            flow_rows.append(row)
            failures.append(row)
        finally:
            # The builder may attach bounded ROI lists to each candidate.  An
            # acceptance report only needs the aggregates, so do not retain
            # even the last completed flow artifact across iterations.
            artifact = None

    selected_count = len(material_ids)
    flow_availability_rate = (
        float(horizontal_flows) / float(successful) if successful else 0.0
    )
    all_flow_availability_rate = (
        float(all_horizontal_flows) / float(successful) if successful else 0.0
    )
    camera_denominator = successful * EXPECTED_CAMERA_COUNT
    camera_availability_rate = (
        float(horizontal_valid_cameras) / float(camera_denominator)
        if camera_denominator
        else 0.0
    )
    null_measurements_passed = (
        aggregate_longitudinal_mm_non_null == 0
        and aggregate_longitudinal_non_null == 0
        and aggregate_area_non_null == 0
    )
    criteria = {
        "limitAtLeastThirty": {
            "required": MINIMUM_LIMIT,
            "actual": requested,
            "passed": requested >= MINIMUM_LIMIT,
        },
        "sixCameraProfile": {
            "required": EXPECTED_CAMERA_COUNT,
            "actual": len(cameras),
            "passed": len(cameras) == EXPECTED_CAMERA_COUNT,
        },
        "minimumCommonFlowCount": {
            "required": requested,
            "actual": selected_count,
            "passed": selected_count >= requested,
        },
        "allSelectedFlowsSucceeded": {
            "required": selected_count,
            "actual": successful,
            "passed": len(failures) == 0,
        },
        "physicalLongitudinalAndAreaRemainNull": {
            "required": 0,
            "longitudinalMmNonNullCount": aggregate_longitudinal_mm_non_null,
            "longitudinalSpanMmNonNullCount": aggregate_longitudinal_non_null,
            "areaMm2NonNullCount": aggregate_area_non_null,
            "passed": null_measurements_passed,
        },
    }
    status = "pass" if all(bool(item["passed"]) for item in criteria.values()) else "fail"
    candidate_counts = {
        name: int(aggregate_classes.get(name, 0))
        for name in PROVISIONAL_CLASSES
    }
    report: dict[str, Any] = {
        "schema": ACCEPTANCE_SCHEMA,
        "algorithm": DEPTH_GEOMETRY_SOURCE,
        "status": status,
        "profilePath": str(capture_profile.source_path),
        "cameraRoots": camera_roots,
        "cameraCount": len(cameras),
        "requestedLimit": requested,
        "maxFrames": frame_limit,
        "config": settings.to_dict(),
        "configHash": config_hash(settings),
        "flowCountRequested": requested,
        "flowCountDiscovered": len(all_material_ids),
        "flowCountSelected": selected_count,
        "successfulFlowCount": successful,
        "failedFlowCount": len(failures),
        "materialIds": material_ids,
        "flows": flow_rows,
        "failures": failures,
        "candidateCounts": candidate_counts,
        "provisionalClassCounts": dict(candidate_counts),
        "unknownCandidateCount": int(aggregate_unknown),
        "candidateCount": int(aggregate_defects),
        "horizontalCalibration": {
            "availableFlowCount": horizontal_flows,
            "allCamerasAvailableFlowCount": all_horizontal_flows,
            "eligibleFlowCount": successful,
            "availabilityRate": flow_availability_rate,
            "flowAvailabilityRate": flow_availability_rate,
            "allCamerasAvailabilityRate": all_flow_availability_rate,
            "validCameraCount": horizontal_valid_cameras,
            "observedCameraCount": horizontal_observed_cameras,
            "cameraAvailabilityRate": camera_availability_rate,
        },
        "longitudinalMmNonNullCount": aggregate_longitudinal_mm_non_null,
        "longitudinalSpanMmNonNullCount": aggregate_longitudinal_non_null,
        "areaMm2NonNullCount": aggregate_area_non_null,
        "allLongitudinalMmNull": aggregate_longitudinal_mm_non_null == 0,
        "allLongitudinalSpanMmNull": aggregate_longitudinal_non_null == 0,
        "allAreaMm2Null": aggregate_area_non_null == 0,
        "acceptanceCriteria": criteria,
    }
    if report_path is not None:
        atomic_write_json(report_path, report)
    return report


# Descriptive aliases make the entry point easy to find for callers that use
# ``acceptance`` terminology rather than the shorter function name.
run_real_flow_acceptance = run_acceptance
build_acceptance_report = run_acceptance


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a bounded newest-first SICK depth geometry acceptance batch."
    )
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument(
        "--limit",
        type=int,
        default=DEFAULT_LIMIT,
        help=f"number of newest common flows (minimum {MINIMUM_LIMIT})",
    )
    parser.add_argument(
        "--max-frames",
        type=int,
        default=DEFAULT_MAX_FRAMES,
        help="per-flow geometry frame bound (default: 8)",
    )
    parser.add_argument(
        "--algorithm-config",
        type=Path,
        default=None,
        help="optional algorithm JSON containing depthGeometry",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="optional output JSON path (written atomically)",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    arguments = parser.parse_args(argv)
    try:
        report = run_acceptance(
            arguments.profile,
            limit=arguments.limit,
            max_frames=arguments.max_frames,
            algorithm_config_path=arguments.algorithm_config,
            report_path=arguments.report,
        )
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
        return 2  # pragma: no cover - argparse.error raises SystemExit
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":  # pragma: no cover - direct CLI path
    raise SystemExit(main())


__all__ = [
    "ACCEPTANCE_SCHEMA",
    "DEFAULT_LIMIT",
    "DEFAULT_MAX_FRAMES",
    "EXPECTED_CAMERA_COUNT",
    "MAXIMUM_LIMIT",
    "MINIMUM_LIMIT",
    "PROVISIONAL_CLASSES",
    "atomic_write_json",
    "build_acceptance_report",
    "discover_common_material_ids",
    "main",
    "run_acceptance",
    "run_real_flow_acceptance",
]
