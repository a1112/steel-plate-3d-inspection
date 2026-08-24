"""Canonical flow-first storage paths shared by capture and algorithms.

The physical root may differ per camera, but everything below that root starts
with the immutable numeric database flow number.  Consumers must use these
helpers instead of reconstructing paths from UI or business identifiers.
"""

from __future__ import annotations

from pathlib import Path


LAYOUT_SCHEMA = "steel.flow-storage.v2"


def flow_id(value: str | int) -> str:
    text = str(value).strip()
    if not text.isdecimal() or int(text) <= 0:
        raise ValueError(f"flow id must be a positive numeric value: {value!r}")
    return str(int(text))


def flow_root(storage_root: Path, value: str | int) -> Path:
    return Path(storage_root) / flow_id(value)


def capture_root(
    camera_storage_root: Path,
    value: str | int,
    camera_id: str,
) -> Path:
    camera = camera_id.strip()
    if not camera or any(character in camera for character in "\\/:"):
        raise ValueError(f"invalid camera id: {camera_id!r}")
    return flow_root(camera_storage_root, value) / "capture" / camera


def flow_manifest_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "flow.json"


def frame_event_root(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "events" / "frame-committed"


def frame_event_path(storage_root: Path, value: str | int, capture_round: int) -> Path:
    if capture_round < 0:
        raise ValueError("capture round cannot be negative")
    return frame_event_root(storage_root, value) / f"{capture_round:012d}.json"


def algorithm_state_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "algorithm-state.json"


def alignment_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "sync" / "alignment.json"


def measurement_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "geometry" / "measurement.json"


def region_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "roi" / "manifest.json"


def playback_index_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "playback" / "index.json"


def playback_roi_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "playback" / "roi.json"


def defect_root(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "defects"


def defect_manifest_path(storage_root: Path, value: str | int) -> Path:
    return defect_root(storage_root, value) / "manifest.json"


def cache_root(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "cache"


def pyramid_status_path(storage_root: Path, value: str | int) -> Path:
    return cache_root(storage_root, value) / "playback-pyramid" / "status.json"
