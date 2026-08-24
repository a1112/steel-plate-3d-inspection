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


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) else None


def _set_node(node_map: Any, name: str, value: Any) -> None:
    try:
        node = getattr(node_map, name)
        node.value = value
        readback = _json_scalar(node.value)
    except (AttributeError, RuntimeError, ValueError, TypeError) as error:
        raise RuntimeError(f"cannot set required GenICam node {name}={value!r}: {error}") from error
    if readback != value:
        raise RuntimeError(f"GenICam node {name} readback mismatch: requested={value!r} actual={readback!r}")


def _node_symbolics(node_map: Any, name: str) -> list[str]:
    try:
        node = getattr(node_map, name)
    except (AttributeError, RuntimeError, ValueError, TypeError):
        return []
    for attribute in ("symbolics", "symbols"):
        try:
            values = getattr(node, attribute)
            if callable(values):
                values = values()
            return [str(value) for value in values]
        except (AttributeError, RuntimeError, ValueError, TypeError):
            continue
    return []


def frame_trigger_capability_snapshot(
    node_map: Any, *, probe_frame_start: bool = False
) -> dict[str, Any]:
    """Read FrameStart capability, restoring the original selector after a probe."""

    selector_node = getattr(node_map, "TriggerSelector", None)
    original_selector = _node_value(node_map, "TriggerSelector")
    if probe_frame_start and selector_node is not None:
        try:
            selector_node.value = "FrameStart"
        except (AttributeError, RuntimeError, ValueError, TypeError):
            pass
    try:
        command = getattr(node_map, "TriggerSoftware")
    except (AttributeError, RuntimeError, ValueError, TypeError):
        command = None
    executable = bool(
        command is not None
        and (
            callable(getattr(command, "execute", None))
            or callable(getattr(command, "run", None))
        )
    )
    command_implemented = "TriggerSoftware" in dir(node_map)
    selectors = _node_symbolics(node_map, "TriggerSelector")
    sources = _node_symbolics(node_map, "TriggerSource")
    current_selector = _node_value(node_map, "TriggerSelector")
    current_source = _node_value(node_map, "TriggerSource")
    current_mode = _node_value(node_map, "TriggerMode")
    selector_supported = not selectors or "FrameStart" in selectors
    source_supported = not sources or "Software" in sources
    result = {
        "frameStartSupported": bool(selector_supported),
        "softwareSourceSupported": bool(source_supported),
        "softwareCommandImplemented": command_implemented,
        "softwareCommandAvailable": executable,
        "softwareTriggerCapable": bool(
            selector_supported and source_supported and command_implemented
        ),
        "frameSynchronizationCapable": bool(
            _node_value(node_map, "FrameSynchronizationCapable", False)
        ),
        "currentSelector": current_selector,
        "currentMode": current_mode,
        "currentSource": current_source,
        "selectorOptions": selectors,
        "sourceOptions": sources,
    }
    if probe_frame_start and selector_node is not None and original_selector is not None:
        try:
            selector_node.value = original_selector
        except (AttributeError, RuntimeError, ValueError, TypeError):
            result["selectorRestoreFailed"] = True
    result["probedSelector"] = current_selector
    result["currentSelector"] = _node_value(
        node_map, "TriggerSelector", current_selector
    )
    return result


def configure_frame_software_trigger(node_map: Any) -> dict[str, Any]:
    capability = frame_trigger_capability_snapshot(node_map)
    if not capability["softwareTriggerCapable"]:
        raise RuntimeError(
            "camera does not expose a complete FrameStart/Software trigger contract"
        )
    _set_node(node_map, "TriggerSelector", "FrameStart")
    _set_node(node_map, "TriggerMode", "On")
    _set_node(node_map, "TriggerSource", "Software")
    readback = frame_trigger_capability_snapshot(node_map)
    if readback["currentMode"] != "On" or readback["currentSource"] != "Software":
        raise RuntimeError(f"software trigger readback mismatch: {readback}")
    return readback


def execute_software_trigger(node_map: Any) -> tuple[int, int]:
    try:
        command = getattr(node_map, "TriggerSoftware")
    except (AttributeError, RuntimeError, ValueError, TypeError) as error:
        raise RuntimeError("GenICam TriggerSoftware command is unavailable") from error
    execute = getattr(command, "execute", None)
    if not callable(execute):
        execute = getattr(command, "run", None)
    if not callable(execute):
        raise RuntimeError("GenICam TriggerSoftware command is not executable")
    issued_ns = time.time_ns()
    execute()
    return issued_ns, time.time_ns()


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
        self.last_transport_frame_id: int | None = None
        capture_defaults = profile.raw.get("captureDefaults", {})
        requested_buffers = max(
            3,
            min(64, int(capture_defaults.get("gentlBufferCount", 8))),
        )
        minimum_buffers = int(getattr(image_acquirer, "min_num_buffers", 1) or 1)
        if hasattr(image_acquirer, "num_buffers"):
            image_acquirer.num_buffers = max(minimum_buffers, requested_buffers)
        self.buffer_count = int(
            getattr(image_acquirer, "num_buffers", minimum_buffers) or minimum_buffers
        )
        self.minimum_buffer_count = minimum_buffers
        self.background_acquisition = bool(
            capture_defaults.get("gentlBackgroundAcquisition", False)
        )
        if self.background_acquisition and hasattr(
            image_acquirer, "num_filled_buffers_to_hold"
        ):
            image_acquirer.num_filled_buffers_to_hold = self.buffer_count
        _set_node(self.node_map, "DeviceScanType", profile.device_scan_type)
        for name, value in camera.node_overrides.items():
            _set_node(self.node_map, name, value)
        self.frame_trigger_mode = str(
            capture_defaults.get("frameTriggerMode", "free-run")
        ).strip().lower()
        self.trigger_capability = frame_trigger_capability_snapshot(
            self.node_map, probe_frame_start=True
        )
        if self.frame_trigger_mode == "software":
            self.trigger_capability = configure_frame_software_trigger(self.node_map)
        self.coordinate_config = coordinate_snapshot(self.node_map)
        self.camera_config = node_snapshot(self.node_map)
        self.telemetry_lock = threading.Lock()
        self.telemetry_poll_interval_seconds = 1.0
        self.telemetry_last_poll_monotonic = 0.0
        self.telemetry: dict[str, Any] = {
            "deviceTemperature": _finite_float(
                self.camera_config.get("DeviceTemperature")
            ),
            "deviceTemperatureMin": _finite_float(
                self.camera_config.get("DeviceTemperatureMin")
            ),
            "deviceTemperatureMax": _finite_float(
                self.camera_config.get("DeviceTemperatureMax")
            ),
            "deviceLinkThroughputCurrent": _finite_float(
                self.camera_config.get("DeviceLinkThroughputCurrent")
            ),
            "deviceLinkThroughputLimit": _finite_float(
                self.camera_config.get("DeviceLinkThroughputLimit")
            ),
            "acquisitionFrameRate": _finite_float(
                self.camera_config.get("AcquisitionFrameRate")
            ),
            "acquisitionLineRate": _finite_float(
                self.camera_config.get("AcquisitionLineRate")
            ),
            "updatedAtNs": time.time_ns(),
        }
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

    def trigger_status(self) -> dict[str, Any]:
        return {
            **self.trigger_capability,
            "configuredMode": self.frame_trigger_mode,
            "active": self.frame_trigger_mode == "software",
        }

    def _refresh_telemetry(self, now_monotonic: float | None = None) -> None:
        now = time.monotonic() if now_monotonic is None else now_monotonic
        if now - self.telemetry_last_poll_monotonic < self.telemetry_poll_interval_seconds:
            return
        self.telemetry_last_poll_monotonic = now
        node_names = {
            "deviceTemperature": "DeviceTemperature",
            "deviceTemperatureMin": "DeviceTemperatureMin",
            "deviceTemperatureMax": "DeviceTemperatureMax",
            "deviceLinkThroughputCurrent": "DeviceLinkThroughputCurrent",
            "deviceLinkThroughputLimit": "DeviceLinkThroughputLimit",
            "acquisitionFrameRate": "AcquisitionFrameRate",
            "acquisitionLineRate": "AcquisitionLineRate",
        }
        updates: dict[str, Any] = {}
        for output_name, node_name in node_names.items():
            value = _finite_float(_node_value(self.node_map, node_name))
            if value is not None:
                updates[output_name] = value
        updates["updatedAtNs"] = time.time_ns()
        with self.telemetry_lock:
            self.telemetry.update(updates)

    def telemetry_snapshot(self) -> dict[str, Any]:
        """Return cached device telemetry without blocking the capture/status threads."""

        with self.telemetry_lock:
            return dict(self.telemetry)

    def start(self) -> None:
        if not self.started:
            try:
                self.image_acquirer.start(
                    run_as_thread=self.background_acquisition,
                )
            except TypeError:
                # Compatibility with older GenTL consumers that do not expose
                # Harvesters' run_as_thread keyword.
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
            trigger_issued_ns = 0
            trigger_completed_ns = 0
            if self.frame_trigger_mode == "software":
                trigger_issued_ns, trigger_completed_ns = execute_software_trigger(
                    self.node_map
                )
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
                transport_frame_id = int(getattr(buffer, "frame_id", 0) or 0)
                transport_frame_gap = (
                    max(0, transport_frame_id - self.last_transport_frame_id - 1)
                    if self.last_transport_frame_id is not None
                    and transport_frame_id > self.last_transport_frame_id
                    else 0
                )
                if transport_frame_id > 0:
                    self.last_transport_frame_id = transport_frame_id
                depth_data_format = _format_text(depth_component)
                intensity_data_format = _format_text(intensity_component)
            self._refresh_telemetry()
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
                transport_frame_id=transport_frame_id,
                transport_frame_gap=transport_frame_gap,
                trigger_issued_ns=trigger_issued_ns,
                trigger_completed_ns=trigger_completed_ns,
                frame_trigger_mode=self.frame_trigger_mode,
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
