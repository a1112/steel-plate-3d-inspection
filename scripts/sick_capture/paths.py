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


def acquisition_manifest_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "acquisition" / "manifest.json"


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


def jet_image_root(camera_storage_root: Path, value: str | int) -> Path:
    """Return the camera-local JET image directory for one flow."""
    return flow_root(camera_storage_root, value) / "jet"


def surface_jet_path(camera_storage_root: Path, value: str | int) -> Path:
    """Return the all-camera unfolded JET image on the reference camera disk."""
    return jet_image_root(camera_storage_root, value) / "surface-all.jpg"


def camera_surface_jet_path(camera_storage_root: Path, value: str | int) -> Path:
    """Return one camera's JET image beside its immutable acquisition data."""
    return jet_image_root(camera_storage_root, value) / "surface.jpg"


def region_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "roi" / "manifest.json"


def playback_index_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "playback" / "index.json"


def playback_roi_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "playback" / "roi.json"


def image_result_path(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "image" / "result.json"


def defect_root(storage_root: Path, value: str | int) -> Path:
    return flow_root(storage_root, value) / "derived" / "defects"


def defect_manifest_path(storage_root: Path, value: str | int) -> Path:
    return defect_root(storage_root, value) / "manifest.json"


def defect_report_path(storage_root: Path, value: str | int) -> Path:
    return defect_root(storage_root, value) / "report.json"


def cache_root(camera_storage_root: Path, value: str | int) -> Path:
    """Return the camera-local JPEG rendition directory for one flow."""
    return flow_root(camera_storage_root, value) / "cache"


def rendition_root(
    camera_storage_root: Path,
    value: str | int,
    modality: str,
) -> Path:
    """Return the readable two-level rendition root for gray or JET images."""
    normalized = modality.strip().lower()
    if normalized == "gray":
        return cache_root(camera_storage_root, value)
    if normalized == "jet":
        return jet_image_root(camera_storage_root, value)
    raise ValueError(f"unsupported rendition modality: {modality!r}")


def rendition_image_path(
    camera_storage_root: Path,
    value: str | int,
    modality: str,
    level: str,
    storage_index: int,
) -> Path:
    """Return ``thumbnail/0.jpg`` or ``original/0.jpg`` style paths."""
    normalized = level.strip().lower()
    if normalized not in {"thumbnail", "original"}:
        raise ValueError(f"unsupported rendition level: {level!r}")
    if storage_index < 0:
        raise ValueError("storage index cannot be negative")
    return rendition_root(camera_storage_root, value, modality) / normalized / f"{storage_index}.jpg"


def rendition_metadata_path(
    camera_storage_root: Path,
    value: str | int,
    modality: str,
    storage_index: int,
) -> Path:
    if storage_index < 0:
        raise ValueError("storage index cannot be negative")
    return rendition_root(camera_storage_root, value, modality) / "metadata" / f"{storage_index}.json"


def rendition_status_path(
    camera_storage_root: Path,
    value: str | int,
    modality: str,
) -> Path:
    return rendition_root(camera_storage_root, value, modality) / "status.json"


def defect_image_root(camera_storage_root: Path, value: str | int) -> Path:
    """Return the camera-local defect thumbnail directory for one flow."""
    return flow_root(camera_storage_root, value) / "defect"


def pyramid_status_path(storage_root: Path, value: str | int) -> Path:
    return cache_root(storage_root, value) / "status.json"
