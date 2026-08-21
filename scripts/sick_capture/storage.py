"""Atomic LG_3D-compatible and steel-native frame persistence."""

from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np
from PIL import Image

from .models import RawFrame


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _safe_segment(value: str) -> str:
    result = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in value.strip())
    result = result.strip("._")[:96].rstrip(" .") or "unknown"
    reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
    if result.split(".", 1)[0].upper() in reserved:
        result = f"_{result}"
    return result


def _temporary_path(path: Path) -> Path:
    return path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")


def _flush(stream: Any, fsync: bool) -> None:
    stream.flush()
    if fsync:
        os.fsync(stream.fileno())


def atomic_json(path: Path, payload: Any, *, fsync: bool, overwrite: bool = True) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not overwrite and path.exists():
        raise FileExistsError(path)
    temporary = _temporary_path(path)
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            _flush(stream, fsync)
        if not overwrite and path.exists():
            raise FileExistsError(path)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_npz(path: Path, array: np.ndarray, *, fsync: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FileExistsError(path)
    temporary = _temporary_path(path)
    try:
        with temporary.open("wb") as stream:
            # ZIP_STORED keeps the established .npz contract while avoiding
            # the multi-second DEFLATE cost observed on full steel frames.
            # The dedicated RAID volumes provide enough sequential bandwidth.
            np.savez(stream, array=array)
            _flush(stream, fsync)
        if path.exists():
            raise FileExistsError(path)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_image(
    path: Path,
    array: np.ndarray,
    *,
    image_format: str,
    fsync: bool,
    **save_options: Any,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FileExistsError(path)
    temporary = _temporary_path(path)
    image = Image.fromarray(array)
    try:
        with temporary.open("wb") as stream:
            image.save(stream, format=image_format, **save_options)
            _flush(stream, fsync)
        if path.exists():
            raise FileExistsError(path)
        os.replace(temporary, path)
    finally:
        image.close()
        temporary.unlink(missing_ok=True)


@dataclass(frozen=True)
class FrameWriteResult:
    camera_root: Path
    material_id: str
    lg_index: int
    steel_sequence: int
    lg3d_depth: Path
    lg3d_intensity: Path
    lg3d_metadata: Path
    steel_depth: Path
    steel_intensity: Path
    steel_metadata: Path
    camera_config: Path
    checksums: dict[str, str]

    def provider_row(self, frame: RawFrame, round_index: int) -> dict[str, Any]:
        return {
            "code": 0,
            "errorName": "CORRECT",
            "operatorHint": "ok",
            "cameraId": frame.camera_id,
            "cameraKey": frame.camera_key,
            "ip": frame.ip,
            "sn": frame.serial_number,
            "model": frame.model,
            "firmware": frame.firmware,
            "round": round_index,
            "attempt": self.steel_sequence,
            "sequenceNo": self.steel_sequence,
            "width": frame.width,
            "lines": frame.height,
            "depthDataFormat": frame.depth_data_format,
            "intensityDataFormat": frame.intensity_data_format,
            "depthPersistenceMode": "single-lg3d-npz-store",
            "output": str(self.steel_depth),
            "depthOutput": str(self.steel_depth),
            "intensityOutput": str(self.steel_intensity),
            "metadataOutput": str(self.steel_metadata),
            "lg3dDepthOutput": str(self.lg3d_depth),
            "lg3dIntensityOutput": str(self.lg3d_intensity),
            "lg3dMetadataOutput": str(self.lg3d_metadata),
            "depthExists": self.steel_depth.is_file(),
            "intensityExists": self.steel_intensity.is_file(),
            "metadataExists": self.steel_metadata.is_file(),
            "completeFrame": all(
                path.is_file()
                for path in (
                    self.lg3d_depth,
                    self.lg3d_intensity,
                    self.lg3d_metadata,
                    self.steel_depth,
                    self.steel_intensity,
                    self.steel_metadata,
                )
            ),
            "frameTransaction": True,
            "metadataCommitLast": True,
            "checksums": self.checksums,
        }


class SequenceAllocator:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._next: dict[tuple[str, str], int] = {}

    def reserve(self, camera_root: Path, material_id: str) -> int:
        key = (str(camera_root.resolve()), material_id)
        with self._lock:
            if key not in self._next:
                material_root = camera_root / _safe_segment(material_id)
                existing: list[int] = []
                for directory, suffixes, steel_numbering in (
                    ("3d", (".npz",), False),
                    ("2d", (".png", ".jpg", ".jpeg"), False),
                    ("json", (".json",), False),
                    ("depth", (".png",), True),
                    ("intensity", (".png",), True),
                    ("metadata", (".json",), True),
                ):
                    for suffix in suffixes:
                        for path in (material_root / directory).glob(f"*{suffix}"):
                            if not path.stem.isdigit():
                                continue
                            index = int(path.stem) - 1 if steel_numbering else int(path.stem)
                            if index >= 0:
                                existing.append(index)
                self._next[key] = max(existing, default=-1) + 1
            index = self._next[key]
            self._next[key] += 1
            return index


class DualFormatWriter:
    def __init__(
        self,
        *,
        jpeg_quality: int = 95,
        fsync: bool = False,
        fault_hook: Callable[[str], None] | None = None,
    ) -> None:
        self.jpeg_quality = jpeg_quality
        self.fsync = fsync
        self.fault_hook = fault_hook
        self.sequences = SequenceAllocator()

    def _fault(self, stage: str) -> None:
        if self.fault_hook:
            self.fault_hook(stage)

    def write(
        self,
        camera_root: Path,
        material_id: str,
        frame: RawFrame,
        *,
        index: int | None = None,
        session_id: str = "",
        production_event_id: str = "",
    ) -> FrameWriteResult:
        safe_material = _safe_segment(material_id)
        base = camera_root / safe_material
        lg_index = self.sequences.reserve(camera_root, safe_material) if index is None else int(index)
        if lg_index < 0:
            raise ValueError("frame index cannot be negative")
        steel_sequence = lg_index + 1

        lg3d_depth = base / "3d" / f"{lg_index}.npz"
        lg3d_intensity = base / "2d" / f"{lg_index}.png"
        lg3d_metadata = base / "json" / f"{lg_index}.json"
        # Keep one canonical artifact per component. Database-facing paths
        # alias the LG_3D files instead of writing duplicate depth/metadata.
        steel_depth = lg3d_depth
        # Intensity has one canonical PNG only.  Keeping a second copy below
        # intensity/ doubled compression work on the acquisition hot path.
        steel_intensity = lg3d_intensity
        steel_metadata = lg3d_metadata
        camera_config = base / "camera_config.json"

        final_paths = (lg3d_depth, lg3d_intensity, lg3d_metadata)
        collisions = [str(path) for path in final_paths if path.exists()]
        if collisions:
            raise FileExistsError(f"frame outputs already exist: {collisions}")

        if not camera_config.exists():
            config_payload = {
                **frame.camera_config,
                "_steel": {
                    "schema": "steel.sick-camera-config.v1",
                    "cameraId": frame.camera_id,
                    "cameraKey": frame.camera_key,
                    "serialNumber": frame.serial_number,
                    "model": frame.model,
                    "firmware": frame.firmware,
                    "ip": frame.ip,
                    "coordinateConfig": frame.coordinate_config,
                },
            }
            try:
                atomic_json(
                    camera_config,
                    config_payload,
                    fsync=self.fsync,
                    overwrite=False,
                )
            except FileExistsError:
                pass
        else:
            existing_config = json.loads(camera_config.read_text(encoding="utf-8-sig"))
            if not isinstance(existing_config, dict):
                raise ValueError(f"camera config must be a JSON object: {camera_config}")
            steel_config = existing_config.get("_steel", {})
            if not isinstance(steel_config, dict):
                steel_config = {}
            configured_serial = str(
                steel_config.get(
                    "serialNumber",
                    existing_config.get("DeviceSerialNumber", ""),
                )
            ).strip()
            configured_model = str(
                steel_config.get("model", existing_config.get("DeviceModelName", ""))
            ).strip()
            configured_firmware = str(
                steel_config.get(
                    "firmware",
                    existing_config.get(
                        "DeviceFirmwareVersion",
                        existing_config.get("DeviceVersion", ""),
                    ),
                )
            ).strip()
            if not configured_serial or configured_serial != frame.serial_number:
                raise ValueError(
                    "camera config serial mismatch: "
                    f"configured={configured_serial!r} frame={frame.serial_number!r}"
                )
            if configured_model and configured_model != frame.model:
                raise ValueError(
                    "camera config model mismatch: "
                    f"configured={configured_model!r} frame={frame.model!r}"
                )
            if configured_firmware and configured_firmware != frame.firmware:
                raise ValueError(
                    "camera config firmware mismatch: "
                    f"configured={configured_firmware!r} frame={frame.firmware!r}"
                )

        atomic_image(
            lg3d_intensity,
            frame.intensity,
            image_format="PNG",
            compress_level=1,
            fsync=self.fsync,
        )
        atomic_npz(lg3d_depth, frame.depth_raw, fsync=self.fsync)
        self._fault("data-files-committed")

        intensity_checksum = sha256_file(lg3d_intensity)
        depth_checksum = sha256_file(lg3d_depth)
        checksums = {
            "lg3d3d": depth_checksum,
            "lg3d2d": intensity_checksum,
            "steelDepth": depth_checksum,
            "steelIntensity": intensity_checksum,
        }
        cap_time = datetime.fromtimestamp(
            frame.host_utc_ns / 1_000_000_000,
            tz=timezone.utc,
        ).strftime("%Y-%m-%d %H:%M:%S:%f")
        legacy_metadata = {
            "timestamp": frame.timestamp,
            "timestamp_frequency": frame.timestamp_frequency,
            "width": frame.width,
            "height": frame.height,
            "save_index": lg_index,
            "coilId": material_id,
            "data2D_mean": float(np.mean(frame.intensity)),
            "data3D_mean": float(np.mean(frame.depth_raw)),
            "capTime": cap_time,
            "bdConfig": frame.coordinate_config,
            "schema": "steel.sick-frame.v1",
            "cameraSerialNumber": frame.serial_number,
            "cameraFirmware": frame.firmware,
            "cameraId": frame.camera_id,
            "cameraKey": frame.camera_key,
            "cameraIp": frame.ip,
            "depthDataFormat": frame.depth_data_format,
            "intensityDataFormat": frame.intensity_data_format,
            "hostUtcNs": frame.host_utc_ns,
            "hostMonotonicNs": frame.host_monotonic_ns,
            "sessionId": session_id,
            "productionEventId": production_event_id,
            "cameraFrameSequence": frame.sequence,
            "checksums": checksums,
        }
        steel_metadata_payload = {
            **legacy_metadata,
            "schema": "steel.sick-frame.v1",
            "complete": True,
            "legacyCompatible": True,
            "intensityPersistenceMode": "single-2d-png",
            "sequenceNo": steel_sequence,
            "depthOutput": str(steel_depth),
            "intensityOutput": str(steel_intensity),
            "metadataOutput": str(steel_metadata),
            "lg3d": {
                "depthOutput": str(lg3d_depth),
                "intensityOutput": str(lg3d_intensity),
                "metadataOutput": str(lg3d_metadata),
            },
        }
        atomic_json(
            lg3d_metadata,
            steel_metadata_payload,
            fsync=self.fsync,
            overwrite=False,
        )
        self._fault("legacy-metadata-committed")
        self._fault("steel-metadata-committed")
        return FrameWriteResult(
            camera_root=camera_root,
            material_id=material_id,
            lg_index=lg_index,
            steel_sequence=steel_sequence,
            lg3d_depth=lg3d_depth,
            lg3d_intensity=lg3d_intensity,
            lg3d_metadata=lg3d_metadata,
            steel_depth=steel_depth,
            steel_intensity=steel_intensity,
            steel_metadata=steel_metadata,
            camera_config=camera_config,
            checksums=checksums,
        )


def atomic_summary(path: Path, payload: dict[str, Any], *, fsync: bool = False) -> None:
    atomic_json(path, payload, fsync=fsync, overwrite=True)
