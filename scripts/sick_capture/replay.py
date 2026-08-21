"""LG_3D dataset validation and replay."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

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
