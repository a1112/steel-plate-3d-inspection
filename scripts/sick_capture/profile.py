"""Fail-closed SICK capture profile loading."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


_PLACEHOLDER = re.compile(r"^\s*(?:<.*>|TODO|REQUIRED|UNKNOWN|TBD)\s*$", re.IGNORECASE)
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _expand_environment(value: str) -> str:
    expanded = os.path.expandvars(value)
    for name in re.findall(r"%([^%]+)%", expanded):
        expanded = expanded.replace(f"%{name}%", os.environ.get(name, f"%{name}%"))
    return expanded


def _required_text(value: Any, label: str, *, strict: bool) -> str:
    text = str(value or "").strip()
    if not text or (strict and _PLACEHOLDER.match(text)):
        raise ValueError(f"{label} is required and cannot be a placeholder")
    return text


@dataclass(frozen=True)
class CameraProfile:
    camera_index: int
    camera_id: str
    key: str
    serial_number: str
    model: str
    firmware: str
    ip: str
    role: str
    storage_root: Path
    enabled: bool = True
    node_overrides: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SickCaptureProfile:
    source_path: Path
    name: str
    cti_path: Path
    cti_sha256: str
    device_scan_type: str
    expected_depth_formats: tuple[str, ...]
    expected_intensity_formats: tuple[str, ...]
    expected_cameras: int
    storage_root: Path
    cameras: tuple[CameraProfile, ...]
    auto_connect: bool
    timeout_ms: int
    jpeg_quality: int
    fsync: bool
    black_frame_threshold: float
    raw: dict[str, Any]

    @property
    def enabled_cameras(self) -> tuple[CameraProfile, ...]:
        return tuple(camera for camera in self.cameras if camera.enabled)


def _path_from_value(value: Any, base: Path, label: str, *, strict: bool) -> Path:
    text = _required_text(value, label, strict=strict)
    path = Path(_expand_environment(text))
    return path if path.is_absolute() else (base / path).resolve()


def _validate_storage_path(path: Path, label: str) -> None:
    if path.parent == path:
        raise ValueError(f"{label} cannot be a filesystem volume root")


def load_profile(
    path: Path | str,
    *,
    strict_hardware: bool = True,
    verify_cti: bool = True,
) -> SickCaptureProfile:
    source_path = Path(path).resolve()
    payload = json.loads(source_path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError("capture profile must be a JSON object")
    if payload.get("schema") not in {"steel.capture.profile.v1", "steel.capture.profile.v2"}:
        raise ValueError("capture profile schema must be steel.capture.profile.v1 or v2")
    if str(payload.get("driverMode", "")).strip().lower() != "sick-gentl":
        raise ValueError("SICK sidecar requires driverMode=sick-gentl")

    sick = payload.get("sick")
    if not isinstance(sick, dict):
        raise ValueError("capture profile requires a sick object")
    base = source_path.parent
    cti_override = os.environ.get("SICK_GENTL_CTI", "").strip()
    cti_path = _path_from_value(
        cti_override or sick.get("ctiPath"),
        base,
        "sick.ctiPath",
        strict=strict_hardware,
    )
    cti_sha256 = str(sick.get("ctiSha256", "")).strip().lower()
    if strict_hardware and not _SHA256.fullmatch(cti_sha256):
        raise ValueError("sick.ctiSha256 must be the FAT-approved 64-character SHA-256")
    if verify_cti:
        if not cti_path.is_file():
            raise FileNotFoundError(f"SICK GenTL producer not found: {cti_path}")
        if cti_sha256 and _SHA256.fullmatch(cti_sha256):
            actual = sha256_file(cti_path)
            if actual != cti_sha256:
                raise ValueError(
                    f"SICK GenTL producer hash mismatch: expected={cti_sha256} actual={actual}"
                )

    expected_cameras = int(payload.get("expectedCameras", 0))
    if expected_cameras <= 0 or expected_cameras > 24:
        raise ValueError("expectedCameras must be between 1 and 24")
    storage_root = _path_from_value(
        payload.get("storageRoot"), base, "storageRoot", strict=strict_hardware
    )
    _validate_storage_path(storage_root, "storageRoot")

    camera_rows = payload.get("cameras")
    if not isinstance(camera_rows, list):
        raise ValueError("capture profile cameras must be an array")
    cameras: list[CameraProfile] = []
    identities: set[str] = set()
    for position, item in enumerate(camera_rows, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"camera {position} must be an object")
        enabled = bool(item.get("enabled", True))
        camera_index = int(item.get("cameraIndex", position))
        camera_id = _required_text(item.get("id", f"C{camera_index}"), f"camera {position} id", strict=False)
        key = _required_text(item.get("key", camera_id), f"camera {position} key", strict=False)
        serial = _required_text(
            item.get("serialNumber", item.get("sn")),
            f"camera {position} serialNumber",
            strict=strict_hardware and enabled,
        )
        model = _required_text(
            item.get("model"), f"camera {position} model", strict=strict_hardware and enabled
        )
        firmware = _required_text(
            item.get("firmware", item.get("firmwareVersion")),
            f"camera {position} firmware",
            strict=strict_hardware and enabled,
        )
        ip = _required_text(
            item.get("ip"), f"camera {position} ip", strict=strict_hardware and enabled
        )
        try:
            ip_address = ipaddress.IPv4Address(ip)
        except ipaddress.AddressValueError as error:
            raise ValueError(f"camera {position} ip must be a valid IPv4 address") from error
        if ip_address.is_multicast or ip_address.is_unspecified:
            raise ValueError(f"camera {position} ip must be a unicast IPv4 address")
        role = str(item.get("role", "")).strip()
        camera_root_value = item.get("storageRoot")
        if camera_root_value:
            camera_root = _path_from_value(
                camera_root_value,
                base,
                f"camera {position} storageRoot",
                strict=strict_hardware and enabled,
            )
        else:
            camera_root = storage_root / key
        _validate_storage_path(camera_root, f"camera {position} storageRoot")
        node_overrides = item.get("nodeOverrides", {})
        if not isinstance(node_overrides, dict):
            raise ValueError(f"camera {position} nodeOverrides must be an object")
        aliases = {camera_id.lower(), key.lower(), serial.lower(), ip.lower()}
        collisions = aliases & identities
        if enabled and collisions:
            raise ValueError(
                f"duplicate enabled camera identity: {sorted(collisions)[0]}"
            )
        if enabled:
            identities.update(aliases)
        cameras.append(
            CameraProfile(
                camera_index=camera_index,
                camera_id=camera_id,
                key=key,
                serial_number=serial,
                model=model,
                firmware=firmware,
                ip=ip,
                role=role,
                storage_root=camera_root,
                enabled=enabled,
                node_overrides=dict(node_overrides),
            )
        )

    enabled = [camera for camera in cameras if camera.enabled]
    if len(enabled) != expected_cameras:
        raise ValueError(
            f"expectedCameras={expected_cameras} but {len(enabled)} camera rows are enabled"
        )
    if [camera.camera_index for camera in enabled] != list(range(1, expected_cameras + 1)):
        raise ValueError("enabled cameraIndex values must be contiguous and start at 1")
    camera_roots = [str(camera.storage_root.resolve()).lower() for camera in enabled]
    if len(camera_roots) != len(set(camera_roots)):
        raise ValueError("enabled cameras must use unique storageRoot paths")

    capture_defaults = payload.get("captureDefaults", {})
    compatibility = payload.get("compatibility", {})
    timeout_ms = int(capture_defaults.get("timeoutMs", payload.get("timeoutMs", 8000)))
    if timeout_ms < 100 or timeout_ms > 600_000:
        raise ValueError("capture timeoutMs must be between 100 and 600000")
    steel_detection_edge = str(
        capture_defaults.get("steelDetectionEdge", "bottom")
    ).strip().lower()
    if steel_detection_edge not in {"top", "bottom"}:
        raise ValueError("captureDefaults.steelDetectionEdge must be top or bottom")
    steel_detection_tail_rows = int(
        capture_defaults.get("steelDetectionTailRows", 32)
    )
    if not 1 <= steel_detection_tail_rows <= 4096:
        raise ValueError(
            "captureDefaults.steelDetectionTailRows must be between 1 and 4096"
        )
    frame_trigger_mode = str(
        capture_defaults.get("frameTriggerMode", "free-run")
    ).strip().lower()
    if frame_trigger_mode not in {"free-run", "software"}:
        raise ValueError(
            "captureDefaults.frameTriggerMode must be free-run or software"
        )
    bounded_integer_settings = (
        ("steelPreRollFrames", 0, 8, 1),
        ("steelPostRollFrames", 0, 8, 1),
        ("blackFrameCacheRounds", 1, 8, 8),
        ("alignmentSearchFrames", 1, 32, 8),
        ("alignmentStableRows", 1, 128, 8),
        ("alignmentSampleStep", 1, 32, 4),
        ("softSyncAnchorIntervalFrames", 1, 512, 16),
        ("measurementRowWindow", 1, 128, 16),
        ("measurementMaximumProfilePoints", 32, 2048, 320),
        ("measurementMaximumSections", 1, 64, 12),
        ("measurementMinimumCirclePoints", 8, 4096, 48),
    )
    for name, minimum, maximum, default in bounded_integer_settings:
        value = int(capture_defaults.get(name, default))
        if value < minimum or value > maximum:
            raise ValueError(
                f"captureDefaults.{name} must be between {minimum} and {maximum}"
            )
    bounded_float_settings = (
        ("alignmentDepthValidRatio", 0.0001, 1.0, 0.005),
        ("softSyncMaximumResidualMs", 0.1, 10_000.0, 40.0),
        ("measurementMaximumCircleResidualMm", 0.001, 100.0, 0.5),
    )
    for name, minimum, maximum, default in bounded_float_settings:
        value = float(capture_defaults.get(name, default))
        if value < minimum or value > maximum:
            raise ValueError(
                f"captureDefaults.{name} must be between {minimum} and {maximum}"
            )
    jpeg_quality = int(compatibility.get("jpegQuality", 95))
    if not 1 <= jpeg_quality <= 100:
        raise ValueError("compatibility.jpegQuality must be between 1 and 100")

    depth_formats = tuple(str(value) for value in sick.get("expectedDepthFormats", ["Coord3D_C16"]))
    intensity_formats = tuple(str(value) for value in sick.get("expectedIntensityFormats", ["Mono8"]))
    if not depth_formats or not intensity_formats:
        raise ValueError("SICK expected component format lists cannot be empty")

    return SickCaptureProfile(
        source_path=source_path,
        name=_required_text(payload.get("name"), "profile name", strict=False),
        cti_path=cti_path,
        cti_sha256=cti_sha256,
        device_scan_type=str(sick.get("deviceScanType", "Linescan3D")),
        expected_depth_formats=depth_formats,
        expected_intensity_formats=intensity_formats,
        expected_cameras=expected_cameras,
        storage_root=storage_root,
        cameras=tuple(cameras),
        auto_connect=bool(payload.get("autoConnect", True)),
        timeout_ms=timeout_ms,
        jpeg_quality=jpeg_quality,
        fsync=bool(compatibility.get("fsync", False)),
        black_frame_threshold=float(capture_defaults.get("blackFrameThreshold", 1.0)),
        raw=payload,
    )
