"""Driver-neutral frame types used by live SICK capture and offline replay."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass(frozen=True)
class RawFrame:
    camera_key: str
    camera_id: str
    serial_number: str
    model: str
    firmware: str
    ip: str
    sequence: int
    timestamp: int
    timestamp_frequency: int
    host_utc_ns: int
    host_monotonic_ns: int
    depth_raw: np.ndarray
    intensity: np.ndarray
    depth_data_format: str
    intensity_data_format: str
    coordinate_config: dict[str, dict[str, Any]] = field(default_factory=dict)
    camera_config: dict[str, Any] = field(default_factory=dict)
    # GenTL frame ID reported by the transport layer.  ``sequence`` is the
    # sidecar-local monotonic counter, while this value preserves the device
    # transport identity needed for cross-camera synchronization audits.
    transport_frame_id: int = 0
    transport_frame_gap: int = 0
    # Host-side software-trigger telemetry.  These remain zero/free-run for
    # continuous acquisition and are persisted so synchronization quality can
    # be audited without relying on process logs.
    trigger_issued_ns: int = 0
    trigger_completed_ns: int = 0
    frame_trigger_mode: str = "free-run"
    # Immutable source evidence for non-physical acquisition modes. Physical
    # camera frames leave this empty; replay frames record their original
    # session/camera/index so downstream storage never presents them as live.
    provenance: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if (
            not self.camera_key.strip()
            or not self.serial_number.strip()
            or not self.model.strip()
            or not self.firmware.strip()
        ):
            raise ValueError("frame camera identity is incomplete")
        if self.depth_raw.ndim != 2 or self.intensity.ndim != 2:
            raise ValueError("SICK depth and intensity components must be two-dimensional")
        if self.depth_raw.shape != self.intensity.shape:
            raise ValueError(
                f"SICK component shape mismatch: depth={self.depth_raw.shape} "
                f"intensity={self.intensity.shape}"
            )
        if self.depth_raw.dtype != np.uint16:
            raise ValueError(f"Coord3D_C16 depth must be uint16, got {self.depth_raw.dtype}")
        if self.intensity.dtype != np.uint8:
            raise ValueError(f"Mono8 intensity must be uint8, got {self.intensity.dtype}")
        if self.timestamp_frequency < 0:
            raise ValueError("timestamp_frequency cannot be negative")

    @property
    def width(self) -> int:
        return int(self.depth_raw.shape[1])

    @property
    def height(self) -> int:
        return int(self.depth_raw.shape[0])

    @property
    def byte_size(self) -> int:
        return int(self.depth_raw.nbytes + self.intensity.nbytes)
