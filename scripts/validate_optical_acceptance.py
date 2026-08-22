"""Validate the versioned optical FAT baseline and optional live SICK health."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import request


DEFAULT_BASELINE = (
    Path(__file__).resolve().parents[1]
    / "config"
    / "acceptance"
    / "jianslong-beiman-optical-fat.v1.json"
)


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return value


def validate_baseline(baseline: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if baseline.get("schema") != "steel.optical-acceptance-baseline.v1":
        failures.append("unsupported optical baseline schema")

    three_d = baseline.get("threeDimensional", {})
    two_d = baseline.get("twoDimensional", {})
    synchronization = baseline.get("synchronization", {})
    if int(three_d.get("cameraCount", 0)) != 6:
        failures.append("3D FAT baseline must contain exactly six cameras")
    if int(two_d.get("cameraCount", 0)) != 4:
        failures.append("2D FAT baseline must contain exactly four cameras")

    exposures = three_d.get("exposureUs", [])
    if not isinstance(exposures, list) or len(exposures) != 6 or any(float(v) <= 0 for v in exposures):
        failures.append("3D exposure baseline must contain six positive values")

    tolerance = float(three_d.get("heightBlockToleranceMm", 0))
    measurements = three_d.get("heightBlockMeasurements", [])
    if not isinstance(measurements, list) or len(measurements) != 6:
        failures.append("height-block baseline must contain six camera measurements")
    else:
        for row in measurements:
            error_mm = abs(float(row["measuredMm"]) - float(row["nominalMm"]))
            if error_mm > tolerance:
                failures.append(
                    f"camera {row['camera']} height error {error_mm:.4f} mm exceeds ±{tolerance:.4f} mm"
                )

    stitching = three_d.get("stitching", {}).get("cameras", [])
    if not isinstance(stitching, list) or [int(row.get("camera", 0)) for row in stitching] != list(range(1, 7)):
        failures.append("stitching baseline must map cameras 1 through 6 exactly once")

    for label, expected_count in (("twoDimensional", 4), ("threeDimensional", 6)):
        item = synchronization.get(label, {})
        trigger_count = int(item.get("triggerPulseCount", -1))
        camera_counts = item.get("cameraCounts", [])
        if (
            not isinstance(camera_counts, list)
            or len(camera_counts) != expected_count
            or any(int(value) != trigger_count for value in camera_counts)
        ):
            failures.append(f"{label} trigger/camera counts are not synchronized")

    cross = synchronization.get("crossSystem", {})
    if int(cross.get("twoDimensionalPulseCount", -1)) != int(
        cross.get("threeDimensionalPulseCount", -2)
    ):
        failures.append("2D and 3D manual-travel pulse counts differ")
    return failures


def validate_live_health(
    health: dict[str, Any], baseline: dict[str, Any]
) -> list[str]:
    failures: list[str] = []
    gate = baseline["productionGate"]
    expected = int(baseline["threeDimensional"]["cameraCount"])
    provider = str(health.get("provider", ""))
    driver = str(health.get("driverId", ""))
    if gate["requirePhysicalProvider"] and (
        provider == "simulated" or "simulat" in driver.lower()
    ):
        failures.append("live provider is simulated")
    if not bool(health.get("ready")) or not bool(health.get("sdkReady")):
        failures.append("live SICK provider is not ready")
    if int(health.get("cameraCount", 0)) != expected:
        failures.append(
            f"connected camera count is {health.get('cameraCount')}, expected {expected}"
        )
    if gate.get("requireNoCaptureFrameFailures", False) and int(
        health.get("framesFailed", 0)
    ) != 0:
        failures.append(f"camera acquisition failed {health.get('framesFailed')} frames")

    sync = health.get("acquisitionSynchronization")
    if gate["requireSynchronizationTelemetry"] and not isinstance(sync, dict):
        failures.append("live provider has no acquisition synchronization telemetry")
    elif isinstance(sync, dict):
        max_skew = int(baseline["synchronization"]["maxLiveFrameCountSkew"])
        if not bool(sync.get("synchronized")):
            failures.append(f"live acquisition status is {sync.get('status', 'unknown')}")
        if int(sync.get("frameCountSkew", max_skew + 1)) > max_skew:
            failures.append(
                f"live camera frame-count skew is {sync.get('frameCountSkew')}, allowed {max_skew}"
            )
        if gate.get("requireNoTransportFrameGaps", False) and int(
            sync.get("transportFrameGaps", 0)
        ) != 0:
            failures.append(
                f"GenTL transport frame IDs contain {sync.get('transportFrameGaps')} skipped frames"
            )

    queue = health.get("storageQueue", {})
    if gate["requireNoDroppedStorageRounds"] and int(queue.get("droppedRounds", 0)) != 0:
        failures.append(f"storage queue dropped {queue.get('droppedRounds')} rounds")
    if gate["requireNoFailedStorageRounds"] and int(queue.get("failedRounds", 0)) != 0:
        failures.append(f"storage queue failed {queue.get('failedRounds')} rounds")
    database_commit = health.get("databaseCommit", {})
    if gate.get("requireNoDatabaseCommitFailures", False):
        if not isinstance(database_commit, dict) or not database_commit:
            failures.append("live provider has no database commit telemetry")
        elif int(database_commit.get("failedBatches", 0)) != 0:
            failures.append(
                f"database callback failed {database_commit.get('failedBatches')} batches"
            )
    return failures


def build_report(
    baseline_path: Path,
    baseline: dict[str, Any],
    health: dict[str, Any] | None = None,
) -> dict[str, Any]:
    baseline_failures = validate_baseline(baseline)
    runtime_failures = validate_live_health(health, baseline) if health is not None else []
    return {
        "schema": "steel.optical-acceptance-result.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "baselineId": baseline.get("id"),
        "baselinePath": str(baseline_path.resolve()),
        "passed": not baseline_failures and not runtime_failures,
        "baseline": {
            "passed": not baseline_failures,
            "failures": baseline_failures,
        },
        "runtime": {
            "checked": health is not None,
            "passed": health is not None and not runtime_failures,
            "failures": runtime_failures,
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--capture-origin", help="optional SICK sidecar origin, for example http://127.0.0.1:4317")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)

    baseline = _load_json(args.baseline)
    health = None
    if args.capture_origin:
        with request.urlopen(f"{args.capture_origin.rstrip('/')}/health", timeout=5) as response:
            health = json.loads(response.read())
        if not isinstance(health, dict):
            raise ValueError("capture health response must be a JSON object")
    report = build_report(args.baseline, baseline, health)
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    sys.stdout.write(rendered)
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
