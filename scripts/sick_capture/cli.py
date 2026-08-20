"""Command-line entry points for SICK bring-up and capture."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

from .gentl import probe_cti, write_probe_result
from .profile import load_profile
from .provider import ProviderRuntime, serve
from .replay import validate_lg3d_dataset


def _print(payload: object) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def probe_main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Enumerate SICK GenTL cameras")
    parser.add_argument("--cti", required=True, type=Path)
    parser.add_argument("--sha256", default="")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    result = probe_cti(args.cti, args.sha256)
    if args.output:
        write_probe_result(args.output, result)
    _print(result)
    return 0 if result["deviceCount"] else 2


def capture_main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Capture real SICK frames into LG_3D + steel layouts")
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--material-id", "--coil-id", dest="material_id", required=True)
    parser.add_argument("--session-id", default="manual-sick-capture")
    parser.add_argument("--rounds", type=int, default=20)
    parser.add_argument("--interval-ms", type=int, default=0)
    parser.add_argument("--timeout-ms", type=int)
    parser.add_argument("--discard-black-frames", action="store_true")
    args = parser.parse_args(argv)

    profile = load_profile(args.profile)
    runtime = ProviderRuntime(profile)
    try:
        event = runtime.steel_event(
            {
                "cmd": "steelIn",
                "value": 1,
                "materialId": args.material_id,
                "sessionId": args.session_id,
                "saveEnabled": True,
            }
        )
        if event.get("code") != 0:
            _print(event)
            return 2
        payload = {
            "materialId": args.material_id,
            "sessionId": args.session_id,
            "productionLayout": True,
            "requireSteelPresent": True,
            "expectedCameras": profile.expected_cameras,
            "rounds": args.rounds,
            "intervalMs": args.interval_ms,
            "discardBlackFrames": args.discard_black_frames,
        }
        if args.timeout_ms:
            payload["timeoutMs"] = args.timeout_ms
        status, result = runtime.continuous_capture(payload)
        _print(result)
        return 0 if status == 200 and result.get("failures") == 0 else 3
    finally:
        runtime.close()


def validate_main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate an LG_3D-compatible material directory")
    parser.add_argument("path", type=Path)
    args = parser.parse_args(argv)
    _print(validate_lg3d_dataset(args.path).as_dict())
    return 0


def service_main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the steel-compatible SICK GenTL sidecar")
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4317)
    args = parser.parse_args(argv)
    serve(args.profile, args.host, args.port)
    return 0
