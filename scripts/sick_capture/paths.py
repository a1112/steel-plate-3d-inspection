"""Canonical camera-root storage paths shared by capture and algorithms.

Each camera owns one explicit root such as ``H:\\C5``. Raw data lives directly
under ``<camera-root>/<flow>/<2d|3d|json>``; the camera id and ``capture`` are
not repeated below a root that already identifies the camera.
"""

from __future__ import annotations

from pathlib import Path


LAYOUT_SCHEMA = "steel.camera-storage.v3"
CAPTURE_KINDS = frozenset({"2d", "3d", "json"})


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
    return flow_root(camera_storage_root, value)


def capture_artifact_ref(
    camera_id: str,
    value: str | int,
    kind: str,
    filename: str,
) -> str:
    camera = camera_id.strip()
    directory = kind.strip().lower()
    name = Path(filename).name
    if not camera or any(character in camera for character in "\\/:"):
        raise ValueError(f"invalid camera id: {camera_id!r}")
    if directory not in CAPTURE_KINDS:
        raise ValueError(f"invalid capture kind: {kind!r}")
    if not name or name != filename:
        raise ValueError(f"invalid capture filename: {filename!r}")
    # Keep the public/API reference stable even though the physical directory
    # no longer repeats ``capture/<camera>`` below a camera-specific root.
    return f"{flow_id(value)}/capture/{camera}/{directory}/{name}"


def resolve_capture_artifact(
    camera_storage_root: Path,
    camera_id: str,
    artifact_ref: str,
) -> Path:
    supplied = Path(artifact_ref)
    if supplied.is_absolute():
        return supplied.resolve()
    parts = supplied.parts
    if (
        len(parts) != 5
        or not parts[0].isdecimal()
        or parts[1].lower() != "capture"
        or parts[2].lower() != camera_id.strip().lower()
        or parts[3].lower() not in CAPTURE_KINDS
        or Path(parts[4]).name != parts[4]
    ):
        raise ValueError(f"invalid capture artifact reference: {artifact_ref!r}")
    return (Path(camera_storage_root) / flow_id(parts[0]) / parts[3].lower() / parts[4]).resolve()


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


def surface_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "geometry" / "surface.json"


def surface_jet_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "geometry" / "surface-jet.png"


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
