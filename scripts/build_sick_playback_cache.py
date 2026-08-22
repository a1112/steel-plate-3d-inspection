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
    measurement_root = storage_root / "measurements"
    for measurement in measurement_root.glob("*.json"):
        material_id = measurement.stem
        if not any((root / material_id / "json").is_dir() for root in camera_roots.values()):
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
                    "elapsedMs": round((time.perf_counter() - started) * 1000.0, 3),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
