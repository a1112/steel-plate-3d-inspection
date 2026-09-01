"""LG_3D dataset validation and replay."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import threading
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, Sequence
import uuid

import numpy as np
from PIL import Image

from .models import RawFrame


REQUIRED_LEGACY_KEYS = {
    "timestamp",
    "timestamp_frequency",
    "width",
    "height",
    "save_index",
    "coilId",
    "data2D_mean",
    "data3D_mean",
    "capTime",
}


@dataclass(frozen=True)
class ValidationResult:
    base: Path
    frame_count: int
    first_index: int
    last_index: int
    camera_config_present: bool

    def as_dict(self) -> dict[str, object]:
        return {
            "schema": "steel.lg3d-validation.v1",
            "ok": True,
            "base": str(self.base),
            "frameCount": self.frame_count,
            "firstIndex": self.first_index,
            "lastIndex": self.last_index,
            "cameraConfigPresent": self.camera_config_present,
        }


def _load_frame(base: Path, index: int) -> tuple[np.ndarray, np.ndarray, dict[str, object]]:
    depth_path = base / "3d" / f"{index}.npz"
    intensity_path = base / "2d" / f"{index}.png"
    if not intensity_path.is_file():
        intensity_path = base / "2d" / f"{index}.jpg"
    metadata_path = base / "json" / f"{index}.json"
    for path in (depth_path, intensity_path, metadata_path):
        if not path.is_file():
            raise FileNotFoundError(path)
    with np.load(depth_path, allow_pickle=False) as package:
        if package.files != ["array"]:
            raise ValueError(f"{depth_path}: NPZ keys must be exactly ['array']")
        depth = package["array"]
    with Image.open(intensity_path) as image:
        intensity = np.asarray(image.convert("L")).copy()
    metadata = json.loads(metadata_path.read_text(encoding="utf-8-sig"))
    if not isinstance(metadata, dict):
        raise ValueError(f"{metadata_path}: metadata must be a JSON object")
    missing = REQUIRED_LEGACY_KEYS - metadata.keys()
    if missing:
        raise ValueError(f"{metadata_path}: missing fields {sorted(missing)}")
    expected = (int(metadata["height"]), int(metadata["width"]))
    if depth.shape != expected:
        raise ValueError(f"{depth_path}: depth shape {depth.shape} != {expected}")
    if intensity.shape != expected:
        raise ValueError(f"{intensity_path}: intensity shape {intensity.shape} != {expected}")
    if int(metadata["save_index"]) != index:
        raise ValueError(f"{metadata_path}: save_index does not match filename")
    return depth, intensity, metadata


def validate_lg3d_dataset(base: Path | str) -> ValidationResult:
    root = Path(base).resolve()
    metadata_root = root / "json"
    indices = sorted(
        int(path.stem)
        for path in metadata_root.glob("*.json")
        if path.stem.isdigit()
    )
    if not indices:
        raise ValueError(f"no complete LG_3D frames found below {root}")
    if len(indices) != len(set(indices)):
        raise ValueError("duplicate LG_3D frame index")
    for index in indices:
        _load_frame(root, index)
    return ValidationResult(
        base=root,
        frame_count=len(indices),
        first_index=indices[0],
        last_index=indices[-1],
        camera_config_present=(root / "camera_config.json").is_file(),
    )


class LG3DReplaySource:
    def __init__(
        self,
        base: Path | str,
        *,
        camera_key: str,
        camera_id: str,
        serial_number: str,
        model: str = "SICK",
        firmware: str = "replay",
        ip: str = "",
    ) -> None:
        self.base = Path(base).resolve()
        self.camera_key = camera_key
        self.camera_id = camera_id
        self.serial_number = serial_number
        self.model = model
        self.firmware = firmware
        self.ip = ip

    def __iter__(self) -> Iterator[RawFrame]:
        validation = validate_lg3d_dataset(self.base)
        camera_config_path = self.base / "camera_config.json"
        camera_config = (
            json.loads(camera_config_path.read_text(encoding="utf-8-sig"))
            if camera_config_path.is_file()
            else {}
        )
        for sequence in range(validation.first_index, validation.last_index + 1):
            metadata_path = self.base / "json" / f"{sequence}.json"
            if not metadata_path.is_file():
                continue
            depth, intensity, metadata = _load_frame(self.base, sequence)
            yield RawFrame(
                camera_key=self.camera_key,
                camera_id=self.camera_id,
                serial_number=self.serial_number,
                model=self.model,
                firmware=self.firmware,
                ip=self.ip,
                sequence=sequence,
                timestamp=int(metadata["timestamp"]),
                timestamp_frequency=int(metadata["timestamp_frequency"]),
                host_utc_ns=int(metadata.get("hostUtcNs", 0) or 0),
                host_monotonic_ns=int(metadata.get("hostMonotonicNs", 0) or 0),
                depth_raw=np.asarray(depth, dtype=np.uint16),
                intensity=np.asarray(intensity, dtype=np.uint8),
                depth_data_format=str(metadata.get("depthDataFormat", "Coord3D_C16")),
                intensity_data_format=str(metadata.get("intensityDataFormat", "Mono8")),
                coordinate_config=dict(metadata.get("bdConfig", {}) or {}),
                camera_config=dict(camera_config or {}),
            )


class ReplayCompleted(RuntimeError):
    """Raised once one camera has consumed all of its non-looping events."""


@dataclass(frozen=True)
class ReplayFrameReference:
    """An immutable reference to the exact three source artifacts for one frame."""

    intensity_path: Path
    depth_path: Path
    metadata_path: Path
    index: int
    time_ns: int
    session_id: str
    coil_id: str
    source_flow: str
    intensity_sha256: str
    depth_sha256: str
    metadata_sha256: str
    source_content_hash: str

    @property
    def base(self) -> Path:
        return self.metadata_path.parent.parent


@dataclass(frozen=True)
class ReplayCameraTrack:
    camera_key: str
    camera_id: str
    source_flow: str
    camera_config: dict[str, Any]
    frames: tuple[ReplayFrameReference, ...]

    @property
    def base(self) -> Path:
        return self.frames[0].base


@dataclass(frozen=True)
class ReplayCatalogSession:
    session_id: str
    coil_id: str
    tracks: dict[str, ReplayCameraTrack]
    first_time_ns: int
    source_content_hash: str


@dataclass(frozen=True)
class ScheduledReplayEvent:
    channel_index: int
    scheduled_ns: int
    session_index: int
    session_frame_index: int
    reference: ReplayFrameReference


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _stable_hash(payload: Any) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _read_source_arrays(
    depth_path: Path,
    intensity_path: Path,
    expected_shape: tuple[int, int],
) -> tuple[np.ndarray, np.ndarray]:
    try:
        with np.load(depth_path, allow_pickle=False) as package:
            if package.files != ["array"]:
                raise ValueError(
                    f"{depth_path}: NPZ keys must be exactly ['array']"
                )
            depth = package["array"]
    except (EOFError, zipfile.BadZipFile) as error:
        raise zipfile.BadZipFile(f"{depth_path}: {error}") from error
    except ValueError as error:
        if str(error).startswith(str(depth_path)):
            raise
        raise ValueError(f"{depth_path}: {error}") from error
    if depth.dtype != np.uint16:
        raise ValueError(f"{depth_path}: depth dtype {depth.dtype} must be uint16")
    if depth.shape != expected_shape:
        raise ValueError(
            f"{depth_path}: depth shape {depth.shape} != {expected_shape}"
        )
    with Image.open(intensity_path) as image:
        intensity = np.asarray(image).copy()
    if intensity.dtype != np.uint8:
        raise ValueError(
            f"{intensity_path}: intensity dtype {intensity.dtype} must be uint8"
        )
    if intensity.shape != expected_shape:
        raise ValueError(
            f"{intensity_path}: intensity shape {intensity.shape} != {expected_shape}"
        )
    return depth, intensity


def _is_reparse_point(path: Path) -> bool:
    try:
        attributes = getattr(path.stat(follow_symlinks=False), "st_file_attributes", 0)
    except OSError:
        return False
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def _absolute_unresolved(path: Path | str) -> Path:
    supplied = Path(path)
    return supplied if supplied.is_absolute() else Path(os.path.abspath(supplied))


def _assert_no_link_chain(path: Path | str) -> Path:
    """Reject symlinks/junctions before resolve() can erase their identity."""

    absolute = _absolute_unresolved(path)
    parts = absolute.parts
    current = Path(parts[0]) if parts else absolute
    for part in parts[1:]:
        current /= part
        if current.is_symlink() or _is_reparse_point(current):
            raise ValueError(
                f"replay source cannot contain links or reparse points: {current}"
            )
    return absolute


def _assert_read_path(path: Path, root: Path, *, directory: bool = False) -> Path:
    _assert_no_link_chain(path)
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ValueError(f"replay source path escapes configured root: {path}") from error
    if directory and not resolved.is_dir():
        raise ValueError(f"replay source directory is missing: {path}")
    if not directory and not resolved.is_file():
        raise ValueError(f"replay source file is missing: {path}")
    return resolved


def _numeric_files(
    directory: Path,
    suffixes: set[str],
    root: Path,
) -> dict[int, Path]:
    _assert_read_path(directory, root, directory=True)
    result: dict[int, Path] = {}
    for path in directory.iterdir():
        if not path.is_file() or path.suffix.lower() not in suffixes:
            continue
        if not path.stem.isdecimal():
            continue
        index = int(path.stem)
        if index in result:
            raise ValueError(f"duplicate replay frame index {index} below {directory}")
        result[index] = _assert_read_path(path, root)
    return result


def _source_time_ns(metadata: dict[str, Any], index: int) -> int:
    host_utc_ns = int(metadata.get("hostUtcNs", 0) or 0)
    if host_utc_ns > 0:
        return host_utc_ns
    timestamp = int(metadata.get("timestamp", 0) or 0)
    frequency = int(metadata.get("timestamp_frequency", 0) or 0)
    if timestamp > 0 and frequency > 0:
        return int(timestamp * 1_000_000_000 // frequency)
    # Old archives can lack both clock domains. Keep a deterministic 5 Hz
    # fallback; pacing must never depend on USB transfer latency.
    return index * 200_000_000


def _declared_or_actual_hash(
    metadata: dict[str, Any],
    key: str,
    path: Path,
) -> str:
    checksums = metadata.get("checksums", {})
    declared = str(checksums.get(key, "") if isinstance(checksums, dict) else "").lower()
    actual = _sha256_file(path)
    if declared:
        if len(declared) != 64 or any(ch not in "0123456789abcdef" for ch in declared):
            raise ValueError(f"invalid declared {key} SHA-256")
        if declared != actual:
            raise ValueError(
                f"declared {key} SHA-256 does not match source content: {path}"
            )
    return actual


def _catalog_flow_segments(
    source_root: Path,
    camera: Any,
    flow_dir: Path,
) -> tuple[list[ReplayCameraTrack], list[dict[str, str]]]:
    """Split one physical flow directory into contiguous logical sessions."""

    base = _assert_read_path(flow_dir, source_root, directory=True)
    intensity = _numeric_files(base / "2d", {".png", ".jpg", ".jpeg"}, source_root)
    depth = _numeric_files(base / "3d", {".npz"}, source_root)
    metadata_files = _numeric_files(base / "json", {".json"}, source_root)
    config_path = _assert_read_path(base / "camera_config.json", source_root)
    camera_config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    if not isinstance(camera_config, dict):
        raise ValueError(f"camera config must be an object: {config_path}")

    expected_camera_key = str(camera.key).strip()
    expected_camera_id = str(camera.camera_id).strip()
    expected_serial = str(camera.serial_number).strip()

    steel_config_value = camera_config.get("_steel")
    if steel_config_value is not None and not isinstance(steel_config_value, dict):
        raise ValueError(f"camera config _steel must be an object: {config_path}")
    steel_config = (
        steel_config_value if isinstance(steel_config_value, dict) else {}
    )

    def validate_identity_field(
        payload: dict[str, Any],
        field: str,
        expected: str,
        *,
        location: str,
    ) -> bool:
        value = str(payload.get(field, "") or "").strip()
        if not value:
            return False
        if value.casefold() != expected.casefold():
            raise ValueError(
                f"{location} {field} {value!r} does not match profile {expected!r}"
            )
        return True

    config_has_identity = any(
        (
            validate_identity_field(
                steel_config,
                "cameraKey",
                expected_camera_key,
                location="camera config",
            ),
            validate_identity_field(
                steel_config,
                "cameraId",
                expected_camera_id,
                location="camera config",
            ),
            validate_identity_field(
                steel_config,
                "serialNumber",
                expected_serial,
                location="camera config",
            ),
            validate_identity_field(
                camera_config,
                "DeviceSerialNumber",
                expected_serial,
                location="camera config",
            ),
        )
    )

    tracks: list[ReplayCameraTrack] = []
    rejected: list[dict[str, str]] = []
    current: list[ReplayFrameReference] = []
    current_identity: tuple[str, str] | None = None
    previous_index: int | None = None

    def flush() -> None:
        nonlocal current, current_identity, previous_index
        if current:
            tracks.append(
                ReplayCameraTrack(
                    camera_key=str(camera.key),
                    camera_id=str(camera.camera_id),
                    source_flow=flow_dir.name,
                    camera_config=dict(camera_config),
                    frames=tuple(current),
                )
            )
        current = []
        current_identity = None
        previous_index = None

    all_indices = sorted(set(intensity) | set(depth) | set(metadata_files))
    for index in all_indices:
        missing_parts = [
            name
            for name, files in (("2d", intensity), ("3d", depth), ("json", metadata_files))
            if index not in files
        ]
        if missing_parts:
            flush()
            # A recorder may be interrupted after creating only part of its
            # final frame.  That one incomplete trailing index is safe to
            # ignore.  Missing components anywhere else are source loss, not
            # a new valid starting point: retain the logical identity when
            # metadata exists so the whole session is rejected during
            # cross-camera aggregation.  Without an identity, fail the whole
            # physical flow rather than silently accepting a truncated suffix.
            if index == all_indices[-1]:
                continue
            metadata_path = metadata_files.get(index)
            if metadata_path is None:
                raise ValueError(
                    "non-trailing incomplete frame has no metadata identity: "
                    f"{base} index={index} missing={','.join(missing_parts)}"
                )
            try:
                incomplete_metadata = json.loads(
                    metadata_path.read_text(encoding="utf-8-sig")
                )
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError(
                    "non-trailing incomplete frame metadata is unreadable: "
                    f"{metadata_path}: {error}"
                ) from error
            if not isinstance(incomplete_metadata, dict):
                raise ValueError(
                    "non-trailing incomplete frame metadata has no identity: "
                    f"{metadata_path}"
                )
            session_id = str(incomplete_metadata.get("sessionId", "")).strip()
            coil_id = str(incomplete_metadata.get("coilId", "")).strip()
            if not session_id or not coil_id:
                raise ValueError(
                    "non-trailing incomplete frame metadata has no identity: "
                    f"{metadata_path}"
                )
            rejected.append(
                {
                    "cameraKey": str(camera.key),
                    "sourceFlow": flow_dir.name,
                    "frameIndex": str(index),
                    "sessionId": session_id,
                    "coilId": coil_id,
                    "error": f"incomplete 2d/3d/json triplet: missing {','.join(missing_parts)}",
                }
            )
            continue
        metadata_path = metadata_files[index]
        session_id = ""
        coil_id = ""
        try:
            metadata_bytes = metadata_path.read_bytes()
            metadata = json.loads(metadata_bytes.decode("utf-8-sig"))
            if not isinstance(metadata, dict):
                raise ValueError("frame metadata must be an object")
            missing = REQUIRED_LEGACY_KEYS - metadata.keys()
            if missing:
                raise ValueError(f"missing fields {sorted(missing)}")
            if int(metadata.get("save_index", -1)) != index:
                raise ValueError("save_index does not match filename")
            width = int(metadata.get("width", 0) or 0)
            height = int(metadata.get("height", 0) or 0)
            if width <= 0 or height <= 0:
                raise ValueError(f"invalid frame shape {width}x{height}")
            session_id = str(metadata.get("sessionId", "")).strip()
            coil_id = str(metadata.get("coilId", "")).strip()
            if not session_id or not coil_id:
                raise ValueError("sessionId and coilId are required")
            _read_source_arrays(depth[index], intensity[index], (height, width))
            metadata_has_identity = any(
                (
                    validate_identity_field(
                        metadata,
                        "cameraKey",
                        expected_camera_key,
                        location=f"frame metadata {metadata_path}",
                    ),
                    validate_identity_field(
                        metadata,
                        "cameraId",
                        expected_camera_id,
                        location=f"frame metadata {metadata_path}",
                    ),
                    validate_identity_field(
                        metadata,
                        "cameraSerialNumber",
                        expected_serial,
                        location=f"frame metadata {metadata_path}",
                    ),
                )
            )
            if not config_has_identity and not metadata_has_identity:
                raise ValueError(
                    "camera identity is missing from both camera config and "
                    f"frame metadata: {metadata_path}"
                )
            intensity_hash = _declared_or_actual_hash(
                metadata, "lg3d2d", intensity[index]
            )
            depth_hash = _declared_or_actual_hash(metadata, "lg3d3d", depth[index])
            metadata_hash = hashlib.sha256(metadata_bytes).hexdigest()
            relative_paths = {
                "intensity": intensity[index].relative_to(source_root).as_posix(),
                "depth": depth[index].relative_to(source_root).as_posix(),
                "metadata": metadata_path.relative_to(source_root).as_posix(),
            }
            frame_hash = _stable_hash(
                {
                    "paths": relative_paths,
                    "index": index,
                    "sessionId": session_id,
                    "coilId": coil_id,
                    "sha256": {
                        "intensity": intensity_hash,
                        "depth": depth_hash,
                        "metadata": metadata_hash,
                    },
                }
            )
            reference = ReplayFrameReference(
                intensity_path=intensity[index],
                depth_path=depth[index],
                metadata_path=metadata_path,
                index=index,
                time_ns=_source_time_ns(metadata, index),
                session_id=session_id,
                coil_id=coil_id,
                source_flow=flow_dir.name,
                intensity_sha256=intensity_hash,
                depth_sha256=depth_hash,
                metadata_sha256=metadata_hash,
                source_content_hash=frame_hash,
            )
        except (
            OSError,
            EOFError,
            UnicodeDecodeError,
            ValueError,
            zipfile.BadZipFile,
            json.JSONDecodeError,
        ) as error:
            flush()
            rejection = {
                "cameraKey": str(camera.key),
                "sourceFlow": flow_dir.name,
                "frameIndex": str(index),
                "error": f"{metadata_path}: {error}",
            }
            if session_id and coil_id:
                rejection.update(
                    {"sessionId": session_id, "coilId": coil_id}
                )
            rejected.append(rejection)
            continue

        identity = (reference.session_id, reference.coil_id)
        if current and (identity != current_identity or index != (previous_index or 0) + 1):
            if identity == current_identity and previous_index is not None:
                rejected.append(
                    {
                        "cameraKey": str(camera.key),
                        "sourceFlow": flow_dir.name,
                        "frameIndex": str(index),
                        "error": (
                            "logical session frame indices are not contiguous: "
                            f"{previous_index} -> {index}"
                        ),
                    }
                )
            flush()
        if not current:
            current_identity = identity
        current.append(reference)
        previous_index = index
    flush()
    return tracks, rejected


def _merge_track_segments(
    camera_key: str,
    segments: Sequence[ReplayCameraTrack],
) -> ReplayCameraTrack:
    ordered = sorted(
        segments,
        key=lambda item: (
            item.frames[0].time_ns,
            int(item.source_flow) if item.source_flow.isdecimal() else item.source_flow,
            item.frames[0].index,
        ),
    )
    frames: list[ReplayFrameReference] = []
    source_flows: list[str] = []
    for segment in ordered:
        if frames and segment.frames[0].index != frames[-1].index + 1:
            raise ValueError(
                f"{camera_key}: duplicate/discontinuous session segments "
                f"{frames[-1].index} -> {segment.frames[0].index}"
            )
        frames.extend(segment.frames)
        if segment.source_flow not in source_flows:
            source_flows.append(segment.source_flow)
    if not frames:
        raise ValueError(f"{camera_key}: replay track is empty")
    return ReplayCameraTrack(
        camera_key=ordered[0].camera_key,
        camera_id=ordered[0].camera_id,
        source_flow=",".join(source_flows),
        camera_config=dict(ordered[0].camera_config),
        frames=tuple(frames),
    )


@dataclass(frozen=True)
class ReplayCatalog:
    source_root: Path
    sessions: tuple[ReplayCatalogSession, ...]
    rejected_tracks: tuple[dict[str, str], ...]
    candidate_session_count: int
    source_dataset_id: str
    source_content_hash: str

    @classmethod
    def build(cls, source_root: Path | str, cameras: Sequence[Any]) -> "ReplayCatalog":
        unresolved_root = _assert_no_link_chain(source_root)
        root = unresolved_root.resolve(strict=True)
        _assert_read_path(root, root, directory=True)
        grouped: dict[tuple[str, str], dict[str, list[ReplayCameraTrack]]] = {}
        rejected: list[dict[str, str]] = []
        invalid_identities: set[tuple[str, str]] = set()
        camera_keys = tuple(str(camera.key) for camera in cameras)
        if not camera_keys:
            raise ValueError("simulation requires at least one configured camera")
        for camera in cameras:
            try:
                camera_dir = _assert_read_path(root / str(camera.key), root, directory=True)
            except (OSError, ValueError) as error:
                rejected.append({"cameraKey": str(camera.key), "error": str(error)})
                continue
            for flow_dir in sorted(
                (
                    path
                    for path in camera_dir.iterdir()
                    if path.is_dir() and path.name.isdecimal()
                ),
                key=lambda path: int(path.name),
            ):
                try:
                    segments, segment_errors = _catalog_flow_segments(
                        root, camera, flow_dir
                    )
                    rejected.extend(segment_errors)
                    invalid_identities.update(
                        (
                            str(error.get("sessionId", "")),
                            str(error.get("coilId", "")),
                        )
                        for error in segment_errors
                        if error.get("sessionId") and error.get("coilId")
                    )
                except (OSError, ValueError, json.JSONDecodeError) as error:
                    rejected.append(
                        {
                            "cameraKey": str(camera.key),
                            "sourceFlow": flow_dir.name,
                            "error": str(error),
                        }
                    )
                    continue
                for track in segments:
                    identity = (track.frames[0].session_id, track.frames[0].coil_id)
                    grouped.setdefault(identity, {}).setdefault(
                        str(camera.key), []
                    ).append(track)

        sessions: list[ReplayCatalogSession] = []
        for (session_id, coil_id), tracks_by_camera in grouped.items():
            if (session_id, coil_id) in invalid_identities:
                rejected.append(
                    {
                        "sessionId": session_id,
                        "coilId": coil_id,
                        "error": "logical session contains one or more rejected source frames",
                    }
                )
                continue
            missing_cameras = sorted(set(camera_keys) - set(tracks_by_camera))
            if missing_cameras:
                rejected.append(
                    {
                        "sessionId": session_id,
                        "coilId": coil_id,
                        "error": f"missing cameras: {','.join(missing_cameras)}",
                    }
                )
                continue
            try:
                tracks = {
                    key: _merge_track_segments(key, tracks_by_camera[key])
                    for key in camera_keys
                }
            except ValueError as error:
                rejected.append(
                    {"sessionId": session_id, "coilId": coil_id, "error": str(error)}
                )
                continue
            first_time_ns = min(track.frames[0].time_ns for track in tracks.values())
            session_hash = _stable_hash(
                {
                    "sessionId": session_id,
                    "coilId": coil_id,
                    "cameras": {
                        key: [frame.source_content_hash for frame in tracks[key].frames]
                        for key in camera_keys
                    },
                }
            )
            sessions.append(
                ReplayCatalogSession(
                    session_id=session_id,
                    coil_id=coil_id,
                    tracks=tracks,
                    first_time_ns=first_time_ns,
                    source_content_hash=session_hash,
                )
            )
        sessions.sort(key=lambda item: (item.first_time_ns, item.session_id, item.coil_id))
        if not sessions:
            raise ValueError(f"no complete multi-camera replay sessions found below {root}")
        dataset_hash = _stable_hash(
            {
                "schema": "steel.simulation-dataset.v1",
                "cameraKeys": camera_keys,
                "sessions": [
                    {
                        "sessionId": session.session_id,
                        "coilId": session.coil_id,
                        "sourceContentHash": session.source_content_hash,
                    }
                    for session in sessions
                ],
            }
        )
        return cls(
            source_root=root,
            sessions=tuple(sessions),
            rejected_tracks=tuple(rejected),
            candidate_session_count=len(set(grouped) | invalid_identities),
            source_dataset_id=f"lg3d-{dataset_hash[:24]}",
            source_content_hash=dataset_hash,
        )


class ReplayCoordinator:
    """Pace independent camera event streams on one virtual monotonic clock."""

    def __init__(
        self,
        catalog: ReplayCatalog,
        camera_keys: Sequence[str],
        *,
        speed: float = 1.0,
        loop: bool = False,
        session_gap_ms: int = 1_500,
        clock_ns: Callable[[], int] = time.monotonic_ns,
    ) -> None:
        self.catalog = catalog
        self.camera_keys = tuple(str(key) for key in camera_keys)
        self.speed = self._validated_speed(speed)
        self.loop = bool(loop)
        self.session_gap_ms = self._validated_gap(session_gap_ms)
        self.clock_ns = clock_ns
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.state = "idle"
        self.last_error = ""
        self.base_position_ns = 0
        self.started_monotonic_ns = 0
        self.source_run_id = uuid.uuid4().hex
        self.wait_generation = 0
        self.last_event_by_camera = {key: -1 for key in self.camera_keys}
        self.completed_cameras: set[str] = set()
        self.active_absolute_session_index = -1
        self.announced_session_boundaries: set[int] = set()
        self.outstanding_batch: dict[str, Any] | None = None
        self.events_by_camera: dict[str, tuple[ScheduledReplayEvent, ...]] = {}
        self.session_starts_ns: tuple[int, ...] = ()
        self.session_ends_ns: tuple[int, ...] = ()
        self.duration_ns = 1
        self._build_timeline()

    @staticmethod
    def _validated_speed(value: float) -> float:
        result = float(value)
        if not 0.25 <= result <= 4.0:
            raise ValueError("simulation speed must be between 0.25 and 4.0")
        return result

    @staticmethod
    def _validated_gap(value: int) -> int:
        result = int(value)
        if not 1_001 <= result <= 3_600_000:
            raise ValueError(
                "simulation sessionGapMs must be between 1001 and 3600000"
            )
        return result

    def _build_timeline(self) -> None:
        event_lists: dict[str, list[ScheduledReplayEvent]] = {
            key: [] for key in self.camera_keys
        }
        session_starts: list[int] = []
        session_ends: list[int] = []
        offset_ns = 0
        gap_ns = self.session_gap_ms * 1_000_000
        for session_index, session in enumerate(self.catalog.sessions):
            session_starts.append(offset_ns)
            source_origin = min(
                track.frames[0].time_ns for track in session.tracks.values()
            )
            session_end = offset_ns
            for camera_key in self.camera_keys:
                track = session.tracks[camera_key]
                previous_scheduled = offset_ns - 1
                for session_frame_index, reference in enumerate(track.frames):
                    scheduled = offset_ns + max(0, reference.time_ns - source_origin)
                    if scheduled <= previous_scheduled:
                        scheduled = previous_scheduled + 1
                    previous_scheduled = scheduled
                    session_end = max(session_end, scheduled)
                    event_lists[camera_key].append(
                        ScheduledReplayEvent(
                            channel_index=len(event_lists[camera_key]),
                            scheduled_ns=scheduled,
                            session_index=session_index,
                            session_frame_index=session_frame_index,
                            reference=reference,
                        )
                    )
            session_ends.append(session_end)
            offset_ns = session_end + gap_ns + 1
        if any(not events for events in event_lists.values()):
            raise ValueError("simulation catalog contains an empty camera event stream")
        self.events_by_camera = {
            key: tuple(events) for key, events in event_lists.items()
        }
        self.session_starts_ns = tuple(session_starts)
        self.session_ends_ns = tuple(session_ends)
        self.duration_ns = max(offset_ns, max(session_ends, default=0) + 1, 1)

    def _position_locked(self, now_ns: int | None = None) -> int:
        position = self.base_position_ns
        if self.state == "running" and self.outstanding_batch is None:
            now = self.clock_ns() if now_ns is None else now_ns
            position += int(max(0, now - self.started_monotonic_ns) * self.speed)
        return max(0, position)

    def _refresh_source_health_locked(self) -> None:
        if self.state not in {"running", "paused"}:
            return
        if self.catalog.source_root.is_dir():
            return
        self.state = "error"
        self.last_error = (
            "simulation source is unavailable: "
            f"{self.catalog.source_root}"
        )
        self.changed.notify_all()

    def _require_reference_available_locked(
        self,
        reference: ReplayFrameReference,
    ) -> None:
        missing = [
            str(path)
            for path in (
                reference.intensity_path,
                reference.depth_path,
                reference.metadata_path,
            )
            if not path.is_file()
        ]
        if not missing:
            return
        self.state = "error"
        self.last_error = "simulation source frame is unavailable: " + ", ".join(missing)
        self.changed.notify_all()
        raise RuntimeError(self.last_error)

    def _ack_outstanding_locked(self) -> None:
        """Rebase pacing after the consumer finishes one real event batch.

        Processing, persistence backpressure, and session-close work happen
        while the virtual clock is frozen at the delivered source timestamp.
        The next source interval therefore starts only when the consumer asks
        for another batch; slow processing can slow replay but can never cause
        catch-up bursts or consume the configured inter-session gap.
        """

        batch = self.outstanding_batch
        if batch is None:
            return
        expected = dict(batch.get("expectedEvents", {}))
        missing = [
            key
            for key, event_index in expected.items()
            if self.last_event_by_camera.get(key, -1) < int(event_index)
        ]
        if missing:
            raise RuntimeError(
                "simulation event batch was not fully consumed: "
                + ",".join(sorted(missing))
            )
        self.base_position_ns = int(batch["scheduledNs"])
        self.started_monotonic_ns = self.clock_ns()
        self.outstanding_batch = None

    def _issue_batch_locked(
        self,
        payload: dict[str, Any],
        *,
        scheduled_ns: int,
        expected_events: dict[str, int] | None = None,
    ) -> dict[str, Any]:
        self.base_position_ns = int(scheduled_ns)
        self.started_monotonic_ns = self.clock_ns()
        self.outstanding_batch = {
            "kind": str(payload.get("kind", "")),
            "scheduledNs": int(scheduled_ns),
            "expectedEvents": dict(expected_events or {}),
        }
        return payload

    def _session_at_position_locked(self, position_ns: int) -> tuple[int, int]:
        cycle = position_ns // self.duration_ns if self.loop else 0
        within = position_ns % self.duration_ns if self.loop else min(
            position_ns, self.duration_ns - 1
        )
        session_index = 0
        for index, start_ns in enumerate(self.session_starts_ns):
            if start_ns > within:
                break
            session_index = index
        return int(cycle), session_index

    def start(
        self,
        *,
        speed: float | None = None,
        loop: bool | None = None,
        session_gap_ms: int | None = None,
    ) -> dict[str, Any]:
        with self.changed:
            if self.state == "error":
                return self.status(code=409, error="simulation_error_requires_reset")
            if self.state == "running":
                return self.status(code=409, error="simulation_already_running")
            if self.state == "paused":
                return self.status(code=409, error="simulation_paused_use_resume")
            if speed is not None:
                self.speed = self._validated_speed(speed)
            if loop is not None:
                self.loop = bool(loop)
            if session_gap_ms is not None:
                next_gap = self._validated_gap(session_gap_ms)
                if next_gap != self.session_gap_ms:
                    self.session_gap_ms = next_gap
                    self._build_timeline()
            self.base_position_ns = 0
            self.last_event_by_camera = {key: -1 for key in self.camera_keys}
            self.completed_cameras.clear()
            self.active_absolute_session_index = -1
            self.announced_session_boundaries.clear()
            self.outstanding_batch = None
            self.source_run_id = uuid.uuid4().hex
            self.started_monotonic_ns = self.clock_ns()
            self.state = "running"
            self.last_error = ""
            self.changed.notify_all()
            return self.status()

    def pause(self) -> dict[str, Any]:
        with self.changed:
            if self.state != "running":
                return self.status(code=409, error="simulation_not_running")
            self.base_position_ns = self._position_locked()
            self.state = "paused"
            self.changed.notify_all()
            return self.status()

    def resume(self) -> dict[str, Any]:
        with self.changed:
            self._refresh_source_health_locked()
            if self.state != "paused":
                return self.status(code=409, error="simulation_not_paused")
            self.started_monotonic_ns = self.clock_ns()
            self.state = "running"
            self.changed.notify_all()
            return self.status()

    def reset(self) -> dict[str, Any]:
        with self.changed:
            if not self.catalog.source_root.is_dir():
                self.state = "error"
                self.last_error = "simulation source is unavailable"
                return self.status(code=503, error="simulation_source_unavailable")
            self.state = "idle"
            self.last_error = ""
            self.base_position_ns = 0
            self.started_monotonic_ns = 0
            self.last_event_by_camera = {key: -1 for key in self.camera_keys}
            self.completed_cameras.clear()
            self.active_absolute_session_index = -1
            self.announced_session_boundaries.clear()
            self.outstanding_batch = None
            self.source_run_id = uuid.uuid4().hex
            self.changed.notify_all()
            return self.status()

    def fail(self, error: BaseException | str) -> None:
        with self.changed:
            self.base_position_ns = self._position_locked()
            self.state = "error"
            self.last_error = str(error)
            self.changed.notify_all()

    def cancel_waiters(self) -> None:
        """Wake provider workers without changing replay position or provenance."""

        with self.changed:
            self.wait_generation += 1
            self.changed.notify_all()

    def next_event_batch(
        self,
        camera_keys: Sequence[str],
        timeout_ms: int,
    ) -> dict[str, Any]:
        """Return the earliest real frame batch or an explicit session boundary."""

        selected = tuple(dict.fromkeys(str(key) for key in camera_keys))
        if not selected or any(key not in self.events_by_camera for key in selected):
            raise ValueError("simulation event request contains an unknown camera")
        deadline_ns = self.clock_ns() + int(timeout_ms) * 1_000_000
        with self.changed:
            self._ack_outstanding_locked()
            observed_run_id = self.source_run_id
            observed_wait_generation = self.wait_generation
            while True:
                self._refresh_source_health_locked()
                if observed_wait_generation != self.wait_generation:
                    raise ReplayCompleted("simulation provider wait was cancelled")
                if self.state == "error":
                    raise RuntimeError(self.last_error or "simulation replay failed")
                if self.state == "completed":
                    raise ReplayCompleted("simulation replay completed")
                if self.state in {"idle", "paused"}:
                    if self.source_run_id != observed_run_id:
                        raise ReplayCompleted("simulation replay was reset")
                    remaining_ns = deadline_ns - self.clock_ns()
                    if remaining_ns <= 0:
                        raise TimeoutError(f"simulation is {self.state}")
                    self.changed.wait(
                        min(remaining_ns, 250_000_000) / 1_000_000_000
                    )
                    continue

                candidates: list[
                    tuple[int, str, ScheduledReplayEvent, int]
                ] = []
                for camera_key in selected:
                    events = self.events_by_camera[camera_key]
                    target_absolute = self.last_event_by_camera[camera_key] + 1
                    if not self.loop and target_absolute >= len(events):
                        self.completed_cameras.add(camera_key)
                        continue
                    target_cycle, target_index = divmod(target_absolute, len(events))
                    event = events[target_index]
                    candidates.append(
                        (
                            target_cycle * self.duration_ns + event.scheduled_ns,
                            camera_key,
                            event,
                            target_cycle * len(self.catalog.sessions)
                            + event.session_index,
                        )
                    )
                for _, _, event, _ in candidates:
                    self._require_reference_available_locked(event.reference)
                if not candidates:
                    active = self.active_absolute_session_index
                    if (
                        active >= 0
                        and active not in self.announced_session_boundaries
                    ):
                        self.announced_session_boundaries.add(active)
                        completed_index = active % len(self.catalog.sessions)
                        completed = self.catalog.sessions[completed_index]
                        completed_cycle = active // len(self.catalog.sessions)
                        boundary_ns = (
                            completed_cycle * self.duration_ns
                            + self.session_ends_ns[completed_index]
                        )
                        return self._issue_batch_locked({
                            "kind": "session-boundary",
                            "completedAbsoluteSessionIndex": active,
                            "completedSessionIndex": completed_index,
                            "completedSessionId": completed.session_id,
                            "completedCoilId": completed.coil_id,
                            "nextSessionIndex": None,
                            "cameraKeys": (),
                            "scheduledNs": boundary_ns,
                        }, scheduled_ns=boundary_ns)
                if len(self.completed_cameras) == len(self.camera_keys):
                    self.base_position_ns = self.duration_ns
                    self.state = "completed"
                    self.changed.notify_all()
                    raise ReplayCompleted("simulation replay completed")
                if not candidates:
                    raise ReplayCompleted("selected simulation channels completed")
                target_time_ns = min(item[0] for item in candidates)
                target_absolute_session = min(
                    item[3] for item in candidates if item[0] == target_time_ns
                )
                active = self.active_absolute_session_index
                if active >= 0 and target_absolute_session != active:
                    if active not in self.announced_session_boundaries:
                        self.announced_session_boundaries.add(active)
                        completed_index = active % len(self.catalog.sessions)
                        next_index = target_absolute_session % len(self.catalog.sessions)
                        completed = self.catalog.sessions[completed_index]
                        upcoming = self.catalog.sessions[next_index]
                        completed_cycle = active // len(self.catalog.sessions)
                        boundary_ns = (
                            completed_cycle * self.duration_ns
                            + self.session_ends_ns[completed_index]
                        )
                        return self._issue_batch_locked({
                            "kind": "session-boundary",
                            "completedAbsoluteSessionIndex": active,
                            "completedSessionIndex": completed_index,
                            "completedSessionId": completed.session_id,
                            "completedCoilId": completed.coil_id,
                            "nextSessionIndex": next_index,
                            "nextSessionId": upcoming.session_id,
                            "nextCoilId": upcoming.coil_id,
                            "cameraKeys": (),
                            "scheduledNs": boundary_ns,
                        }, scheduled_ns=boundary_ns)
                    self.active_absolute_session_index = target_absolute_session
                due_camera_keys = tuple(
                    item[1] for item in candidates if item[0] == target_time_ns
                )
                position_ns = self._position_locked()
                if position_ns >= target_time_ns:
                    if self.active_absolute_session_index < 0:
                        self.active_absolute_session_index = target_absolute_session
                    event = next(
                        item[2]
                        for item in candidates
                        if item[0] == target_time_ns
                    )
                    session = self.catalog.sessions[event.session_index]
                    expected_events = {
                        item[1]: self.last_event_by_camera[item[1]] + 1
                        for item in candidates
                        if item[0] == target_time_ns
                    }
                    return self._issue_batch_locked({
                        "kind": "frames",
                        "cameraKeys": due_camera_keys,
                        "absoluteSessionIndex": target_absolute_session,
                        "sessionIndex": event.session_index,
                        "sessionId": session.session_id,
                        "coilId": session.coil_id,
                        "scheduledNs": target_time_ns,
                    }, scheduled_ns=target_time_ns, expected_events=expected_events)
                wait_virtual_ns = target_time_ns - position_ns
                wait_real_ns = max(1, int(wait_virtual_ns / self.speed))
                remaining_ns = deadline_ns - self.clock_ns()
                if remaining_ns <= 0:
                    raise TimeoutError("simulation event deadline expired")
                self.changed.wait(
                    min(wait_real_ns, remaining_ns, 250_000_000)
                    / 1_000_000_000
                )

    def next_event_camera_keys(
        self,
        camera_keys: Sequence[str],
        timeout_ms: int,
    ) -> tuple[str, ...]:
        """Compatibility wrapper that consumes boundary notifications."""

        while True:
            batch = self.next_event_batch(camera_keys, timeout_ms)
            if batch.get("kind") == "frames":
                return tuple(batch["cameraKeys"])

    def next_frame(
        self,
        camera_key: str,
        timeout_ms: int,
    ) -> tuple[ReplayFrameReference, ScheduledReplayEvent, int]:
        if camera_key not in self.events_by_camera:
            raise KeyError(f"camera is not in the replay catalog: {camera_key}")
        deadline_ns = self.clock_ns() + int(timeout_ms) * 1_000_000
        with self.changed:
            observed_run_id = self.source_run_id
            observed_wait_generation = self.wait_generation
            while True:
                self._refresh_source_health_locked()
                if observed_wait_generation != self.wait_generation:
                    raise ReplayCompleted("simulation provider wait was cancelled")
                if self.state == "error":
                    raise RuntimeError(self.last_error or "simulation replay failed")
                if self.state == "completed" or camera_key in self.completed_cameras:
                    raise ReplayCompleted("simulation replay completed")
                if self.state in {"idle", "paused"}:
                    if self.source_run_id != observed_run_id:
                        raise ReplayCompleted("simulation replay was reset")
                    remaining_ns = deadline_ns - self.clock_ns()
                    if remaining_ns <= 0:
                        raise TimeoutError(f"simulation is {self.state}")
                    self.changed.wait(
                        min(remaining_ns, 250_000_000) / 1_000_000_000
                    )
                    continue

                events = self.events_by_camera[camera_key]
                target_absolute = self.last_event_by_camera[camera_key] + 1
                if not self.loop and target_absolute >= len(events):
                    self.completed_cameras.add(camera_key)
                    if len(self.completed_cameras) == len(self.camera_keys):
                        self.base_position_ns = self.duration_ns
                        self.state = "completed"
                        self.changed.notify_all()
                    raise ReplayCompleted("simulation replay completed")
                target_cycle, target_index = divmod(target_absolute, len(events))
                event = events[target_index]
                self._require_reference_available_locked(event.reference)
                target_time_ns = target_cycle * self.duration_ns + event.scheduled_ns
                position_ns = self._position_locked()
                if position_ns >= target_time_ns:
                    self.last_event_by_camera[camera_key] = target_absolute
                    return event.reference, event, target_absolute
                wait_virtual_ns = target_time_ns - position_ns
                wait_real_ns = max(1, int(wait_virtual_ns / self.speed))
                remaining_ns = deadline_ns - self.clock_ns()
                if remaining_ns <= 0:
                    raise TimeoutError("simulation frame deadline expired")
                self.changed.wait(
                    min(wait_real_ns, remaining_ns, 250_000_000)
                    / 1_000_000_000
                )

    def status(self, *, code: int = 0, error: str = "") -> dict[str, Any]:
        with self.lock:
            self._refresh_source_health_locked()
            position_ns = self._position_locked()
            cycle, session_index = self._session_at_position_locked(position_ns)
            session = self.catalog.sessions[session_index]
            progress_position = position_ns % self.duration_ns if self.loop else min(
                position_ns, self.duration_ns
            )
            channels: list[dict[str, Any]] = []
            for camera_key in self.camera_keys:
                track = session.tracks[camera_key]
                last_absolute = self.last_event_by_camera[camera_key]
                delivered_event: ScheduledReplayEvent | None = None
                if last_absolute >= 0:
                    events = self.events_by_camera[camera_key]
                    delivered_event = events[last_absolute % len(events)]
                frame_position = (
                    delivered_event.session_frame_index
                    if delivered_event is not None
                    and delivered_event.session_index == session_index
                    else -1
                )
                channels.append(
                    {
                        "cameraId": track.camera_id,
                        "cameraKey": camera_key,
                        "sourceFlow": track.source_flow,
                        "frameIndex": frame_position,
                        "sourceFrameIndex": (
                            delivered_event.reference.index
                            if delivered_event is not None
                            and delivered_event.session_index == session_index
                            else None
                        ),
                        "frameCount": len(track.frames),
                        "completed": camera_key in self.completed_cameras,
                    }
                )
            return {
                "code": code,
                **({"error": error} if error else {}),
                "runtimeMode": "simulation",
                "state": self.state,
                "sourceRoot": str(self.catalog.source_root),
                "sourceAvailable": self.catalog.source_root.is_dir(),
                "sourceDatasetId": self.catalog.source_dataset_id,
                "sourceContentHash": self.catalog.source_content_hash,
                "sourceRunId": self.source_run_id,
                "speed": self.speed,
                "loop": self.loop,
                "loopIteration": cycle,
                "sessionGapMs": self.session_gap_ms,
                "sessionCount": len(self.catalog.sessions),
                "usableSessionCount": len(self.catalog.sessions),
                "candidateSessionCount": self.catalog.candidate_session_count,
                "rejectedSessionCount": max(
                    0,
                    self.catalog.candidate_session_count
                    - len(self.catalog.sessions),
                ),
                "rejectedTrackCount": len(self.catalog.rejected_tracks),
                "currentSessionIndex": session_index,
                "currentSessionId": session.session_id,
                "currentCoilId": session.coil_id,
                "positionMs": round(progress_position / 1_000_000, 3),
                "durationMs": round(self.duration_ns / 1_000_000, 3),
                "progress": round(progress_position / self.duration_ns, 6),
                "channels": channels,
                "lastError": self.last_error,
            }


def _paths_overlap(left: Path, right: Path) -> bool:
    left_resolved = left.resolve()
    right_resolved = right.resolve()
    try:
        left_resolved.relative_to(right_resolved)
        return True
    except ValueError:
        pass
    try:
        right_resolved.relative_to(left_resolved)
        return True
    except ValueError:
        return False


def _load_reference(
    reference: ReplayFrameReference,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    for path in (
        reference.intensity_path,
        reference.depth_path,
        reference.metadata_path,
    ):
        _assert_read_path(path, reference.base.parents[1])
    actual_hashes = {
        "intensity": _sha256_file(reference.intensity_path),
        "depth": _sha256_file(reference.depth_path),
        "metadata": _sha256_file(reference.metadata_path),
    }
    expected_hashes = {
        "intensity": reference.intensity_sha256,
        "depth": reference.depth_sha256,
        "metadata": reference.metadata_sha256,
    }
    changed = [key for key in actual_hashes if actual_hashes[key] != expected_hashes[key]]
    if changed:
        raise ValueError(
            "simulation source content hash mismatch for " + ", ".join(changed)
        )
    metadata = json.loads(reference.metadata_path.read_text(encoding="utf-8-sig"))
    if not isinstance(metadata, dict):
        raise ValueError(f"{reference.metadata_path}: metadata must be a JSON object")
    expected_shape = (int(metadata.get("height", 0)), int(metadata.get("width", 0)))
    depth, intensity = _read_source_arrays(
        reference.depth_path, reference.intensity_path, expected_shape
    )
    return depth, intensity, metadata


class LG3DReplaySession:
    def __init__(self, camera: Any, coordinator: ReplayCoordinator) -> None:
        self.camera = camera
        self.coordinator = coordinator
        self.started = False
        self.buffer_count = 0
        self.minimum_buffer_count = 0
        self.background_acquisition = False
        first_track = coordinator.catalog.sessions[0].tracks[str(camera.key)]
        self.camera_config = dict(first_track.camera_config)
        self.coordinate_config = dict(
            self.camera_config.get("_steel", {}).get("coordinateConfig", {})
            if isinstance(self.camera_config.get("_steel"), dict)
            else {}
        )
        self.identity = {
            "serialNumber": str(camera.serial_number),
            "model": str(camera.model),
            "firmware": str(camera.firmware),
            "userDefinedName": "simulation-replay",
            "ip": str(camera.ip),
        }

    def start(self) -> None:
        self.started = True

    def stop(self) -> None:
        self.started = False

    def close(self) -> None:
        self.stop()

    def trigger_status(self) -> dict[str, Any]:
        return {
            "configuredMode": "replay",
            "active": False,
            "softwareTriggerCapable": False,
            "simulation": True,
        }

    def telemetry_snapshot(self) -> dict[str, Any]:
        return {
            "updatedAtNs": time.time_ns(),
            "simulation": True,
            "sourceAvailable": self.coordinator.catalog.source_root.is_dir(),
        }

    def fetch_frame(self, timeout_ms: int | None = None) -> RawFrame:
        self.start()
        timeout = int(timeout_ms or 8_000)
        try:
            reference, event, replay_sequence = self.coordinator.next_frame(
                str(self.camera.key), timeout
            )
            depth, intensity, metadata = _load_reference(reference)
        except ReplayCompleted:
            raise
        except (
            OSError,
            EOFError,
            ValueError,
            zipfile.BadZipFile,
            json.JSONDecodeError,
        ) as error:
            self.coordinator.fail(error)
            raise RuntimeError(f"simulation source frame failed: {error}") from error
        if (
            str(metadata.get("sessionId", "")).strip() != reference.session_id
            or str(metadata.get("coilId", "")).strip() != reference.coil_id
            or int(metadata.get("save_index", -1)) != reference.index
        ):
            error = RuntimeError("simulation source metadata changed after catalog validation")
            self.coordinator.fail(error)
            raise error
        track = self.coordinator.catalog.sessions[event.session_index].tracks[
            str(self.camera.key)
        ]
        catalog = self.coordinator.catalog
        catalog_session = catalog.sessions[event.session_index]
        return RawFrame(
            camera_key=str(self.camera.key),
            camera_id=str(self.camera.camera_id),
            serial_number=str(self.camera.serial_number),
            model=str(self.camera.model),
            firmware=str(self.camera.firmware),
            ip=str(self.camera.ip),
            sequence=replay_sequence,
            timestamp=int(metadata.get("timestamp", 0) or 0),
            timestamp_frequency=int(metadata.get("timestamp_frequency", 0) or 0),
            host_utc_ns=int(metadata.get("hostUtcNs", 0) or 0),
            host_monotonic_ns=int(metadata.get("hostMonotonicNs", 0) or 0),
            depth_raw=np.asarray(depth, dtype=np.uint16),
            intensity=np.asarray(intensity, dtype=np.uint8),
            depth_data_format=str(metadata.get("depthDataFormat", "Coord3D_C16")),
            intensity_data_format=str(metadata.get("intensityDataFormat", "Mono8")),
            coordinate_config=dict(metadata.get("bdConfig", {}) or {}),
            camera_config=dict(track.camera_config),
            transport_frame_id=int(metadata.get("transportFrameId", 0) or 0),
            transport_frame_gap=int(metadata.get("transportFrameGap", 0) or 0),
            frame_trigger_mode="replay",
            provenance={
                "runtimeMode": "simulation",
                "sourceMode": "simulation",
                "sourceDatasetId": catalog.source_dataset_id,
                "sourceDatasetContentHash": catalog.source_content_hash,
                "sourceRunId": self.coordinator.source_run_id,
                "sourceSessionId": reference.session_id,
                "sourceContentHash": catalog_session.source_content_hash,
                "sourceFrameContentHash": reference.source_content_hash,
                "sourceCoilId": reference.coil_id,
                "sourceFlow": reference.source_flow,
                "sourceCameraKey": str(self.camera.key),
                "sourceFrameIndex": reference.index,
                "source2d": str(reference.intensity_path),
                "source3d": str(reference.depth_path),
                "sourceMetadata": str(reference.metadata_path),
                "sourceHashes": {
                    "2d": reference.intensity_sha256,
                    "3d": reference.depth_sha256,
                    "json": reference.metadata_sha256,
                },
                "replayed": True,
                "physicalCapture": False,
                "synthetic": False,
            },
        )


class LG3DReplayBackend:
    """ProviderRuntime-compatible backend backed by immutable LG_3D evidence."""

    def __init__(
        self,
        profile: Any,
        source_root: Path | str,
        *,
        speed: float = 1.0,
        loop: bool = False,
        session_gap_ms: int = 1_500,
        clock_ns: Callable[[], int] = time.monotonic_ns,
    ) -> None:
        self.profile = profile
        unresolved_source_root = _assert_no_link_chain(source_root)
        self.source_root = unresolved_source_root.resolve()
        output_roots = {
            Path(profile.storage_root),
            *(Path(camera.storage_root) for camera in profile.enabled_cameras),
        }
        for output_root in output_roots:
            unresolved_output_root = _assert_no_link_chain(output_root)
            if _paths_overlap(self.source_root, unresolved_output_root):
                raise ValueError(
                    "simulation source root and capture output roots must be separate: "
                    f"source={self.source_root} "
                    f"output={unresolved_output_root.resolve()}"
                )
        self.speed = speed
        self.loop = loop
        self.session_gap_ms = session_gap_ms
        self.clock_ns = clock_ns
        self.catalog: ReplayCatalog | None = None
        self.coordinator: ReplayCoordinator | None = None
        self.started = False

    def start(self) -> None:
        if self.started:
            return
        self.catalog = ReplayCatalog.build(
            self.source_root, self.profile.enabled_cameras
        )
        self.coordinator = ReplayCoordinator(
            self.catalog,
            [camera.key for camera in self.profile.enabled_cameras],
            speed=self.speed,
            loop=self.loop,
            session_gap_ms=self.session_gap_ms,
            clock_ns=self.clock_ns,
        )
        self.started = True

    def connect(self, camera: Any) -> LG3DReplaySession:
        self.start()
        assert self.coordinator is not None
        return LG3DReplaySession(camera, self.coordinator)

    def status(self) -> dict[str, Any]:
        if self.coordinator is None:
            return {
                "code": 503,
                "runtimeMode": "simulation",
                "state": "error",
                "sourceRoot": str(self.source_root),
                "sourceAvailable": self.source_root.is_dir(),
                "sessionCount": 0,
                "channels": [],
                "lastError": "simulation backend is not initialized",
            }
        return self.coordinator.status()

    def close(self) -> None:
        self.started = False
        if self.coordinator is not None:
            with self.coordinator.changed:
                if self.coordinator.state == "running":
                    self.coordinator.base_position_ns = (
                        self.coordinator._position_locked()
                    )
                    self.coordinator.state = "paused"
                self.coordinator.changed.notify_all()
