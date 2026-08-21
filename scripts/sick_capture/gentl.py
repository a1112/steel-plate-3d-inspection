"""SICK GigE Vision/GenTL implementation backed by Harvesters."""

from __future__ import annotations

import ipaddress
import threading
import time
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .models import RawFrame
from .profile import CameraProfile, SickCaptureProfile, sha256_file
from .storage import atomic_json


def _json_scalar(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if hasattr(value, "item"):
        try:
            return value.item()
        except (TypeError, ValueError):
            pass
    return str(value)


def _text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").strip()
    return str(value or "").strip()


def _node_value(node_map: Any, name: str, fallback: Any = None) -> Any:
    try:
        return _json_scalar(getattr(node_map, name).value)
    except (AttributeError, RuntimeError, ValueError, TypeError):
        return fallback


def _set_node(node_map: Any, name: str, value: Any) -> None:
    try:
        node = getattr(node_map, name)
        node.value = value
        readback = _json_scalar(node.value)
    except (AttributeError, RuntimeError, ValueError, TypeError) as error:
        raise RuntimeError(f"cannot set required GenICam node {name}={value!r}: {error}") from error
    if readback != value:
        raise RuntimeError(f"GenICam node {name} readback mismatch: requested={value!r} actual={readback!r}")


def node_snapshot(node_map: Any) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name in dir(node_map):
        try:
            value = _json_scalar(getattr(node_map, name).value)
        # GenTL producers may expose implemented nodes that are not readable in
        # the camera's current feature state.  Vendor AccessException classes
        # are not consistently derived from RuntimeError, so an optional
        # diagnostic snapshot must skip any ordinary node-read exception.
        except Exception:
            continue
        if isinstance(value, (str, int, float, bool)) or value is None:
            result[name] = value
    return result


def coordinate_snapshot(node_map: Any) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    selector = getattr(node_map, "Scan3dCoordinateSelector", None)
    if selector is None:
        raise RuntimeError("required GenICam node Scan3dCoordinateSelector is unavailable")
    original = _json_scalar(selector.value)
    try:
        for axis in ("CoordinateA", "CoordinateB", "CoordinateC"):
            selector.value = axis
            result[axis] = {
                "Scan3dCoordinateOffset": _node_value(node_map, "Scan3dCoordinateOffset"),
                "Scan3dCoordinateScale": _node_value(node_map, "Scan3dCoordinateScale"),
                "Scan3dAxisMax": _node_value(node_map, "Scan3dAxisMax"),
                "Scan3dAxisMin": _node_value(node_map, "Scan3dAxisMin"),
                "Scan3dInvalidDataValue": _node_value(node_map, "Scan3dInvalidDataValue"),
            }
    finally:
        if original is not None:
            try:
                selector.value = original
            except (RuntimeError, ValueError, TypeError):
                pass
    return result


def _format_text(component: Any) -> str:
    value = getattr(component, "data_format", "")
    if isinstance(value, bytes):
        value = value.decode("ascii", errors="replace")
    return str(value)


def select_components(
    components: list[Any] | tuple[Any, ...],
    depth_formats: tuple[str, ...],
    intensity_formats: tuple[str, ...],
) -> tuple[Any, Any]:
    depth_matches = [component for component in components if _format_text(component) in depth_formats]
    intensity_matches = [
        component for component in components if _format_text(component) in intensity_formats
    ]
    formats = [_format_text(component) for component in components]
    if len(depth_matches) != 1 or len(intensity_matches) != 1:
        raise RuntimeError(
            "SICK component schema mismatch: "
            f"formats={formats} expectedDepth={list(depth_formats)} "
            f"expectedIntensity={list(intensity_formats)}"
        )
    return depth_matches[0], intensity_matches[0]


def component_array(component: Any, dtype: np.dtype[Any]) -> np.ndarray:
    height = int(getattr(component, "height"))
    width = int(getattr(component, "width"))
    if height <= 0 or width <= 0:
        raise RuntimeError(f"invalid SICK component size: {width}x{height}")
    array = np.asarray(getattr(component, "data"))
    expected_dtype = np.dtype(dtype)
    if array.dtype.kind != expected_dtype.kind or array.dtype.itemsize != expected_dtype.itemsize:
        raise RuntimeError(
            f"SICK component dtype mismatch: actual={array.dtype} expected={expected_dtype}"
        )
    if array.size != height * width:
        raise RuntimeError(
            f"SICK component payload size mismatch: values={array.size} expected={height * width}"
        )
    return np.asarray(array, dtype=dtype).reshape((height, width)).copy()


def _ipv4_from_node(value: Any) -> str:
    try:
        return str(ipaddress.IPv4Address(int(value)))
    except (AddressValueError, TypeError, ValueError):
        return ""


class SickCameraSession:
    def __init__(
        self,
        image_acquirer: Any,
        camera: CameraProfile,
        profile: SickCaptureProfile,
    ) -> None:
        self.image_acquirer = image_acquirer
        self.camera = camera
        self.profile = profile
        self.node_map = image_acquirer.remote_device.node_map
        self.lock = threading.Lock()
        self.started = False
        self.sequence = 0
        _set_node(self.node_map, "DeviceScanType", profile.device_scan_type)
        for name, value in camera.node_overrides.items():
            _set_node(self.node_map, name, value)
        self.coordinate_config = coordinate_snapshot(self.node_map)
        self.camera_config = node_snapshot(self.node_map)
        actual_ip = _ipv4_from_node(_node_value(self.node_map, "GevCurrentIPAddress"))
        self.identity = {
            "serialNumber": _text(_node_value(self.node_map, "DeviceSerialNumber", "")),
            "model": _text(_node_value(self.node_map, "DeviceModelName", "")),
            "firmware": _text(
                _node_value(
                    self.node_map,
                    "DeviceFirmwareVersion",
                    _node_value(self.node_map, "DeviceVersion", ""),
                )
            ),
            "userDefinedName": _text(_node_value(self.node_map, "DeviceUserID", "")),
            "ip": actual_ip or camera.ip,
        }
        if self.identity["serialNumber"] != camera.serial_number:
            raise RuntimeError(
                f"SICK serial readback mismatch: expected={camera.serial_number} "
                f"actual={self.identity['serialNumber']}"
            )
        if self.identity["model"] != camera.model:
            raise RuntimeError(
                f"SICK model readback mismatch: expected={camera.model} actual={self.identity['model']}"
            )
        if self.identity["firmware"] != camera.firmware:
            raise RuntimeError(
                f"SICK firmware readback mismatch: expected={camera.firmware} "
                f"actual={self.identity['firmware']}"
            )
        if actual_ip and actual_ip != camera.ip:
            raise RuntimeError(
                f"SICK IP readback mismatch: expected={camera.ip} actual={actual_ip}"
            )
        if not actual_ip:
            raise RuntimeError("SICK GevCurrentIPAddress readback is unavailable or invalid")

    def start(self) -> None:
        if not self.started:
            self.image_acquirer.start()
            self.started = True

    def stop(self) -> None:
        if self.started:
            try:
                self.image_acquirer.stop()
            finally:
                self.started = False

    def close(self) -> None:
        try:
            self.stop()
        finally:
            destroy = getattr(self.image_acquirer, "destroy", None)
            if callable(destroy):
                destroy()

    def fetch_frame(self, timeout_ms: int | None = None) -> RawFrame:
        timeout_seconds = (timeout_ms or self.profile.timeout_ms) / 1000.0
        with self.lock:
            self.start()
            with self.image_acquirer.fetch(timeout=timeout_seconds) as buffer:
                components = tuple(buffer.payload.components)
                depth_component, intensity_component = select_components(
                    components,
                    self.profile.expected_depth_formats,
                    self.profile.expected_intensity_formats,
                )
                depth = component_array(depth_component, np.uint16)
                intensity = component_array(intensity_component, np.uint8)
                timestamp = int(getattr(buffer, "timestamp", 0) or 0)
                timestamp_frequency = int(getattr(buffer, "timestamp_frequency", 0) or 0)
                depth_data_format = _format_text(depth_component)
                intensity_data_format = _format_text(intensity_component)
            utc_ns = time.time_ns()
            monotonic_ns = time.monotonic_ns()
            sequence = self.sequence
            self.sequence += 1
            return RawFrame(
                camera_key=self.camera.key,
                camera_id=self.camera.camera_id,
                serial_number=self.camera.serial_number,
                model=self.camera.model,
                firmware=self.identity["firmware"],
                ip=self.identity["ip"],
                sequence=sequence,
                timestamp=timestamp,
                timestamp_frequency=timestamp_frequency,
                host_utc_ns=utc_ns,
                host_monotonic_ns=monotonic_ns,
                depth_raw=depth,
                intensity=intensity,
                depth_data_format=depth_data_format,
                intensity_data_format=intensity_data_format,
                coordinate_config=self.coordinate_config,
                camera_config=self.camera_config,
            )


class SickGenTLBackend:
    def __init__(
        self,
        profile: SickCaptureProfile,
        harvester_factory: Callable[[], Any] | None = None,
    ) -> None:
        self.profile = profile
        self._harvester_factory = harvester_factory
        self.harvester: Any = None
        self.started = False

    def start(self) -> None:
        if self.started:
            return
        if self._harvester_factory is None:
            try:
                from harvesters.core import Harvester
            except ImportError as error:
                raise RuntimeError(
                    "Harvesters is not installed; run pip install -r scripts/sick_capture_requirements.txt"
                ) from error
            self.harvester = Harvester()
        else:
            self.harvester = self._harvester_factory()
        try:
            self.harvester.add_file(
                str(self.profile.cti_path), check_existence=True, check_validity=True
            )
            self.harvester.update()
        except Exception:
            reset = getattr(self.harvester, "reset", None)
            if callable(reset):
                reset()
            self.harvester = None
            raise
        self.started = True

    def enumerate_devices(self) -> list[dict[str, Any]]:
        self.start()
        result = []
        for item in self.harvester.device_info_list:
            result.append(
                {
                    "displayName": _text(getattr(item, "display_name", "")),
                    "serialNumber": _text(getattr(item, "serial_number", "")),
                    "model": _text(getattr(item, "model", "")),
                    "tlType": _text(getattr(item, "tl_type", "")),
                    "userDefinedName": _text(getattr(item, "user_defined_name", "")),
                }
            )
        return result

    def connect(self, camera: CameraProfile) -> SickCameraSession:
        self.start()
        matches = [
            item
            for item in self.enumerate_devices()
            if item.get("serialNumber") == camera.serial_number
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"SICK camera {camera.serial_number} must match exactly one device; matches={len(matches)}"
            )
        create = getattr(self.harvester, "create", None)
        if callable(create):
            image_acquirer = create({"serial_number": camera.serial_number})
        else:
            image_acquirer = self.harvester.create_image_acquirer(
                serial_number=camera.serial_number
            )
        try:
            return SickCameraSession(image_acquirer, camera, self.profile)
        except Exception:
            destroy = getattr(image_acquirer, "destroy", None)
            if callable(destroy):
                destroy()
            raise

    def close(self) -> None:
        if self.harvester is not None:
            reset = getattr(self.harvester, "reset", None)
            if callable(reset):
                reset()
        self.harvester = None
        self.started = False


def probe_cti(cti_path: Path, expected_sha256: str = "") -> dict[str, Any]:
    path = cti_path.resolve()
    if not path.is_file():
        raise FileNotFoundError(path)
    actual_hash = sha256_file(path)
    if expected_sha256 and actual_hash != expected_sha256.lower():
        raise ValueError(
            f"SICK GenTL producer hash mismatch: expected={expected_sha256.lower()} actual={actual_hash}"
        )
    try:
        from harvesters.core import Harvester
    except ImportError as error:
        raise RuntimeError(
            "Harvesters is not installed; run pip install -r scripts/sick_capture_requirements.txt"
        ) from error
    harvester = Harvester()
    try:
        harvester.add_file(str(path), check_existence=True, check_validity=True)
        harvester.update()
        devices = [
            {
                "displayName": _text(getattr(item, "display_name", "")),
                "serialNumber": _text(getattr(item, "serial_number", "")),
                "model": _text(getattr(item, "model", "")),
                "tlType": _text(getattr(item, "tl_type", "")),
                "userDefinedName": _text(getattr(item, "user_defined_name", "")),
            }
            for item in harvester.device_info_list
        ]
        return {
            "schema": "steel.sick-probe.v1",
            "ctiPath": str(path),
            "ctiSha256": actual_hash,
            "deviceCount": len(devices),
            "devices": devices,
        }
    finally:
        harvester.reset()


def write_probe_result(path: Path, payload: dict[str, Any]) -> None:
    atomic_json(path, payload, fsync=False, overwrite=True)
