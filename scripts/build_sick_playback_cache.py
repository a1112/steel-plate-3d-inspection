"""Backfill persistent playback indexes and optional cropped pyramids."""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

from sick_capture.playback import (
    build_and_write_playback_index,
    warm_flow_image_pyramids,
)
from sick_capture.profile import load_profile
from sick_capture.regions import build_and_write_flow_region_map
from sick_capture.measurement import measurement_manifest_path
from sick_capture.paths import capture_root


def _lower_priority() -> None:
    try:
        if os.name == "nt":
            import ctypes

            below_normal_priority_class = 0x00004000
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            kernel32.SetPriorityClass.restype = ctypes.c_int
            process = kernel32.GetCurrentProcess()
            if not kernel32.SetPriorityClass(
                process, below_normal_priority_class
            ):
                raise OSError(ctypes.get_last_error(), "SetPriorityClass failed")
        else:
            os.nice(10)
    except (AttributeError, OSError, ValueError):
        pass


def _recent_materials(
    camera_roots: dict[str, Path], storage_root: Path, limit: int
) -> list[str]:
    modified: dict[str, int] = {}
    for flow in storage_root.iterdir() if storage_root.is_dir() else []:
        if not flow.is_dir() or not flow.name.isdecimal():
            continue
        material_id = flow.name
        measurement = measurement_manifest_path(storage_root, material_id)
        if not any(
            (capture_root(root, material_id, camera_id) / "json").is_dir()
            for camera_id, root in camera_roots.items()
        ):
            continue
        try:
            modified[material_id] = measurement.stat().st_mtime_ns
        except OSError:
            continue
    return [name for name, _ in sorted(modified.items(), key=lambda row: row[1], reverse=True)[:limit]]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Build captureRound-aligned history indexes and image pyramids."
    )
    parser.add_argument("--profile", required=True)
    parser.add_argument("--recent", type=int, default=8)
    parser.add_argument("--material", action="append", default=[])
    parser.add_argument("--warm", action="store_true")
    args = parser.parse_args()

    profile = load_profile(Path(args.profile))
    _lower_priority()
    camera_roots = {
        camera.camera_id: camera.storage_root for camera in profile.enabled_cameras
    }
    materials = args.material or _recent_materials(
        camera_roots, profile.storage_root, max(1, min(10_000, args.recent))
    )
    for material_id in reversed(materials):
        started = time.perf_counter()
        measurement_path = measurement_manifest_path(profile.storage_root, material_id)
        region_path = None
        region_state = "measurement-missing"
        if measurement_path.is_file():
            measurement = json.loads(measurement_path.read_text(encoding="utf-8-sig"))
            region_path, regions = build_and_write_flow_region_map(
                camera_roots, profile.storage_root, material_id, measurement
            )
            region_state = str(regions.get("state", "unknown"))
        path, index = build_and_write_playback_index(
            camera_roots, profile.storage_root, material_id
        )
        warmed = 0
        if args.warm:
            warmed = int(
                warm_flow_image_pyramids(
                    camera_roots, profile.storage_root, index
                ).get("cachedImageCount", 0)
            )
        print(
            json.dumps(
                {
                    "event": "playback-cache-ready",
                    "materialId": material_id,
                    "frames": index.get("frameCount", 0),
                    "pyramids": warmed,
                    "index": str(path),
                    "regionManifest": str(region_path) if region_path else "",
                    "regionState": region_state,
                    "elapsedMs": round((time.perf_counter() - started) * 1000.0, 3),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
