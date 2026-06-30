use std::{
    collections::{HashMap, HashSet},
    ffi::{c_char, c_float, c_int, c_void, CStr, CString},
    ptr,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

const CORRECT: c_int = 0;
const SDK_REPEATED_INIT: c_int = 40024;
const DEV_NOT_LINK_ERROR: c_int = 40001;
const DEV_INIT_FAILED: c_int = 40005;
const DEV_LOAD_DATA_ERROR: c_int = 40030;
const MALLOC_FAILED: c_int = 40009;

const DEVICE_NET_INFO_LEN: usize = 16;
const LVM_DRIVER_ID: &str = "lvm-nvt";
const LVM_DRIVER_NAME: &str = "LVM/NVT 3D Camera SDK";

#[repr(C)]
#[derive(Clone, Copy)]
struct LvmCamInfoRaw {
    ip: *const c_char,
    model: *const c_char,
    sn: *const c_char,
}

type LvmDev = c_void;
type LvmBuf = c_void;

#[repr(C)]
struct LvmDevPrefix {
    connect_ip: [c_char; DEVICE_NET_INFO_LEN],
    connect_dev_type: c_int,
    dev_info: *mut c_void,
    status: *mut LvmDevStateRaw,
}

#[repr(C)]
struct LvmDevStateRaw {
    version: [c_char; 64],
    link_health: c_int,
    linkspeed_user_expected: u32,
    linkspeed_hw_working: u32,
    red_led: c_int,
    red_led_reason: c_int,
    task: c_int,
    status: c_int,
    para_privilege: c_int,
    encoder_loc: c_int,
    encoder_pulse_counter: u32,
    trigger_pulse_counter: u32,
    trigger_div_counter: u32,
    array_pulse_counter: u32,
    array_div_counter: u32,
    effective_pulse_counter: u32,
    data_frame_counter: u32,
    lost_pulse_counter: u32,
    buffer_overflow_counter: u32,
    dio1_level: u32,
    dio2_level: u32,
    trigger_en_level: u32,
    in_level: u32,
    a_level: u32,
    b_level: u32,
    z_level: u32,
    temperature_j28: c_float,
    temperature_j29: c_float,
    temperature_j30: c_float,
    hw_report_gap: u32,
    expired_time: u32,
    expired_datetime: [c_char; 24],
}

type DeviceChangeCb = extern "C" fn(c_int, LvmCamInfoRaw) -> c_int;

#[cfg(capture_sdk)]
#[link(name = "nvt_lvm_sdk")]
extern "C" {
    fn lvm_init_sdk(cb: Option<DeviceChangeCb>, log_path: *const c_char) -> c_int;
    fn lvm_deinit_sdk() -> c_int;
    fn lvm_get_sdk_version() -> *const c_char;
    fn lvm_get_cam_info(cam_info: *mut *mut LvmCamInfoRaw, cam_num: *mut c_int) -> c_int;
    fn lvm_create_dev(ip: *mut c_char, dev_type: c_int) -> *mut LvmDev;
    fn lvm_connect_dev(dev: *mut LvmDev) -> c_int;
    fn lvm_disconnect_dev(dev: *mut LvmDev) -> c_int;
    fn lvm_destroy_dev(dev: *mut LvmDev);
    fn lvm_get_dev_connect_status(dev: *mut LvmDev) -> c_int;
    fn lvm_get_dev_id(dev: *mut LvmDev) -> c_int;
    fn lvm_set_param_int_value(dev: *mut LvmDev, key: *const c_char, value: c_int) -> c_int;
    fn lvm_set_param_float_value(dev: *mut LvmDev, key: *const c_char, value: c_float) -> c_int;
    fn lvm_get_depth_map_width(dev: *mut LvmDev, height: c_int) -> c_int;
    fn lvm_alloc_depth_map_buf(
        dev: *mut LvmDev,
        data_mode: c_int,
        width: c_int,
        height: c_int,
        frame_num: c_int,
    ) -> *mut LvmBuf;
    fn lvm_bind_buf(dev: *mut LvmDev, buf: *mut LvmBuf) -> c_int;
    fn lvm_trigger_en_ctrl(dev: *mut LvmDev, enable: bool) -> c_int;
    fn lvm_grab_frame(dev: *mut LvmDev, timeout_ms: c_int) -> *mut c_void;
    fn lvm_save_depth_map(
        dev: *mut LvmDev,
        file_path: *const c_char,
        depth_map: *mut c_void,
    ) -> c_int;
    fn lvm_grab_stop(dev: *mut LvmDev) -> c_int;
    fn lvm_free_buf(buf: *mut LvmBuf) -> c_int;
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_init_sdk(_cb: Option<DeviceChangeCb>, _log_path: *const c_char) -> c_int {
    DEV_NOT_LINK_ERROR
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_deinit_sdk() -> c_int {
    CORRECT
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_get_sdk_version() -> *const c_char {
    static VERSION: &[u8] = b"nvt_lvm_sdk unavailable\0";
    VERSION.as_ptr().cast::<c_char>()
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_get_cam_info(cam_info: *mut *mut LvmCamInfoRaw, cam_num: *mut c_int) -> c_int {
    if !cam_info.is_null() {
        *cam_info = ptr::null_mut();
    }
    if !cam_num.is_null() {
        *cam_num = 0;
    }
    DEV_NOT_LINK_ERROR
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_create_dev(_ip: *mut c_char, _dev_type: c_int) -> *mut LvmDev {
    ptr::null_mut()
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_connect_dev(_dev: *mut LvmDev) -> c_int {
    DEV_NOT_LINK_ERROR
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_disconnect_dev(_dev: *mut LvmDev) -> c_int {
    CORRECT
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_destroy_dev(_dev: *mut LvmDev) {}

#[cfg(not(capture_sdk))]
unsafe fn lvm_get_dev_connect_status(_dev: *mut LvmDev) -> c_int {
    0
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_get_dev_id(_dev: *mut LvmDev) -> c_int {
    -1
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_set_param_int_value(_dev: *mut LvmDev, _key: *const c_char, _value: c_int) -> c_int {
    DEV_NOT_LINK_ERROR
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_set_param_float_value(
    _dev: *mut LvmDev,
    _key: *const c_char,
    _value: c_float,
) -> c_int {
    DEV_NOT_LINK_ERROR
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_get_depth_map_width(_dev: *mut LvmDev, _height: c_int) -> c_int {
    0
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_alloc_depth_map_buf(
    _dev: *mut LvmDev,
    _data_mode: c_int,
    _width: c_int,
    _height: c_int,
    _frame_num: c_int,
) -> *mut LvmBuf {
    ptr::null_mut()
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_bind_buf(_dev: *mut LvmDev, _buf: *mut LvmBuf) -> c_int {
    DEV_NOT_LINK_ERROR
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_trigger_en_ctrl(_dev: *mut LvmDev, _enable: bool) -> c_int {
    DEV_NOT_LINK_ERROR
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_grab_frame(_dev: *mut LvmDev, _timeout_ms: c_int) -> *mut c_void {
    ptr::null_mut()
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_save_depth_map(
    _dev: *mut LvmDev,
    _file_path: *const c_char,
    _depth_map: *mut c_void,
) -> c_int {
    DEV_NOT_LINK_ERROR
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_grab_stop(_dev: *mut LvmDev) -> c_int {
    CORRECT
}

#[cfg(not(capture_sdk))]
unsafe fn lvm_free_buf(_buf: *mut LvmBuf) -> c_int {
    CORRECT
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDriverInfo {
    id: String,
    name: String,
    vendor: String,
    transport: String,
    sdk_version: String,
    supported_models: Vec<String>,
    features: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureHealth {
    service: String,
    time: String,
    sdk_ready: bool,
    sdk_code: i32,
    sdk_version: String,
    connected: bool,
    ip: String,
    driver_id: String,
    driver_name: String,
    camera_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCamera {
    ip: String,
    model: String,
    sn: String,
    driver_id: String,
    source: String,
    configured: bool,
}

#[derive(Clone, Serialize)]
pub struct CaptureCameraList {
    code: i32,
    count: usize,
    cameras: Vec<CaptureCamera>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCameraStatus {
    connected: bool,
    device_id: i32,
    ip: String,
    driver_id: String,
    model: String,
    sn: String,
    config_id: Option<String>,
    name: Option<String>,
    role: Option<String>,
    enabled: bool,
    acquisition_state: String,
    sdk_status: String,
    fps: Option<f32>,
    buffer_percent: Option<f32>,
    last_frame_time: Option<String>,
    task: Option<i32>,
    status: Option<i32>,
    link_health: Option<i32>,
    temperature_j28: Option<f32>,
    temperature_j29: Option<f32>,
    temperature_j30: Option<f32>,
    lost_pulse_counter: Option<u32>,
    buffer_overflow_counter: Option<u32>,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct CaptureStatusList {
    code: i32,
    count: usize,
    statuses: Vec<CaptureCameraStatus>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCommandResult {
    code: i32,
    connected: Option<bool>,
    ip: Option<String>,
    key: Option<String>,
    output: Option<String>,
    width: Option<i32>,
    lines: Option<i32>,
    error: Option<String>,
    message: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCameraConfig {
    id: String,
    name: String,
    ip: String,
    driver_id: String,
    model_hint: String,
    role: String,
    enabled: bool,
    trigger_mode: String,
    exposure_us: i32,
    gain: f32,
    depth_lines: i32,
    output_path: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureAppliedConfig {
    id: String,
    name: String,
    applied: bool,
    updated_at: String,
    cameras: Vec<CaptureCameraConfig>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureControlCapability {
    id: String,
    label: String,
    scope: String,
    requires_connection: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureParameterCapability {
    key: String,
    label: String,
    value_type: String,
    unit: String,
    min: Option<f64>,
    max: Option<f64>,
    writable: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureApiCapability {
    method: String,
    path: String,
    label: String,
    scope: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCapabilitySet {
    driver: CaptureDriverInfo,
    controls: Vec<CaptureControlCapability>,
    parameters: Vec<CaptureParameterCapability>,
    api: Vec<CaptureApiCapability>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureLogEvent {
    id: String,
    time: String,
    level: String,
    camera_ip: Option<String>,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSnapshot {
    health: CaptureHealth,
    driver: CaptureDriverInfo,
    config: CaptureAppliedConfig,
    cameras: Vec<CaptureCamera>,
    status: CaptureCameraStatus,
    statuses: Vec<CaptureCameraStatus>,
    capabilities: CaptureCapabilitySet,
    logs: Vec<CaptureLogEvent>,
}

struct CameraHandle {
    dev: *mut LvmDev,
    ip: String,
    model: String,
    sn: String,
    config_id: Option<String>,
}

unsafe impl Send for CameraHandle {}

trait CameraDriverBackend {
    fn health(&mut self) -> CaptureHealth;
    fn cameras(&mut self) -> CaptureCameraList;
    fn statuses(&mut self) -> CaptureStatusList;
    fn status(&mut self, ip: Option<String>) -> CaptureCameraStatus;
    fn connect(&mut self, ip: String, dev_type: Option<i32>) -> CaptureCommandResult;
    fn disconnect(&mut self, ip: Option<String>) -> CaptureCommandResult;
    fn set_param(
        &mut self,
        ip: Option<String>,
        key: String,
        type_name: String,
        value: f64,
    ) -> CaptureCommandResult;
    fn capture_depth_map(
        &mut self,
        ip: Option<String>,
        lines: Option<i32>,
        output: Option<String>,
        timeout_ms: Option<i32>,
    ) -> CaptureCommandResult;
    fn apply_config(&mut self, config: CaptureAppliedConfig) -> CaptureCommandResult;
    fn capabilities(&self) -> CaptureCapabilitySet;
    fn logs(&self) -> Vec<CaptureLogEvent>;
    fn snapshot(&mut self) -> CaptureSnapshot;
}

struct LvmNvtDriver {
    sdk_ready: bool,
    last_sdk_code: i32,
    devices: HashMap<String, CameraHandle>,
    applied_config: CaptureAppliedConfig,
    logs: Vec<CaptureLogEvent>,
    next_log_index: u32,
}

impl LvmNvtDriver {
    fn new() -> Self {
        Self {
            sdk_ready: false,
            last_sdk_code: 0,
            devices: HashMap::new(),
            applied_config: default_capture_config(),
            logs: Vec::new(),
            next_log_index: 1,
        }
    }

    fn ensure_sdk(&mut self) -> i32 {
        if self.sdk_ready {
            return CORRECT;
        }
        let log_path = CString::new("logs/").expect("static log path has no nul");
        let code = unsafe { lvm_init_sdk(Some(device_change_cb), log_path.as_ptr()) };
        self.last_sdk_code = code;
        self.sdk_ready = code == CORRECT || code == SDK_REPEATED_INIT;
        if self.sdk_ready {
            self.push_log("info", None, "SDK initialized");
        } else {
            self.push_log("error", None, format!("SDK init failed: {code}"));
        }
        code
    }

    fn push_log(
        &mut self,
        level: impl Into<String>,
        camera_ip: Option<String>,
        message: impl Into<String>,
    ) {
        let event = CaptureLogEvent {
            id: format!("CAP-{index:04}", index = self.next_log_index),
            time: now_millis_string(),
            level: level.into(),
            camera_ip,
            message: message.into(),
        };
        self.next_log_index += 1;
        self.logs.insert(0, event);
        self.logs.truncate(80);
    }

    fn driver_info(&self) -> CaptureDriverInfo {
        CaptureDriverInfo {
            id: LVM_DRIVER_ID.to_string(),
            name: LVM_DRIVER_NAME.to_string(),
            vendor: "Capture 6.7 SDK".to_string(),
            transport: "GigE/Network".to_string(),
            sdk_version: unsafe { c_string(lvm_get_sdk_version()) },
            supported_models: vec![
                "LVM3450CA".to_string(),
                "LVM compatible 3D line camera".to_string(),
            ],
            features: vec![
                "discover".to_string(),
                "multi-connect".to_string(),
                "parameters".to_string(),
                "depth-map".to_string(),
                "status-readback".to_string(),
            ],
        }
    }

    fn discover_cameras(&mut self) -> CaptureCameraList {
        let sdk_code = self.ensure_sdk();
        if !(sdk_code == CORRECT || sdk_code == SDK_REPEATED_INIT) {
            return CaptureCameraList {
                code: sdk_code,
                count: 0,
                cameras: Vec::new(),
            };
        }

        let mut raw_info: *mut LvmCamInfoRaw = ptr::null_mut();
        let mut raw_count: c_int = 0;
        let code = unsafe { lvm_get_cam_info(&mut raw_info, &mut raw_count) };
        let cameras = if code == CORRECT && !raw_info.is_null() && raw_count > 0 {
            unsafe { std::slice::from_raw_parts(raw_info, raw_count as usize) }
                .iter()
                .map(|camera| {
                    let ip = c_string(camera.ip);
                    CaptureCamera {
                        configured: self.config_for_ip(&ip).is_some(),
                        ip,
                        model: c_string(camera.model),
                        sn: c_string(camera.sn),
                        driver_id: LVM_DRIVER_ID.to_string(),
                        source: "discovery".to_string(),
                    }
                })
                .collect()
        } else {
            Vec::new()
        };

        CaptureCameraList {
            code,
            count: cameras.len(),
            cameras,
        }
    }

    fn config_for_ip(&self, ip: &str) -> Option<&CaptureCameraConfig> {
        self.applied_config
            .cameras
            .iter()
            .find(|camera| camera.ip == ip)
    }

    fn select_handle(&self, ip: Option<&str>) -> Option<&CameraHandle> {
        if let Some(ip) = ip {
            return self.devices.get(ip);
        }
        self.devices
            .values()
            .find(|handle| {
                self.config_for_ip(&handle.ip)
                    .map(|config| config.enabled)
                    .unwrap_or(true)
            })
            .or_else(|| self.devices.values().next())
    }

    fn status_from_handle(&self, handle: &CameraHandle) -> CaptureCameraStatus {
        let connected = unsafe { lvm_get_dev_connect_status(handle.dev) == 1 };
        let device_id = unsafe { lvm_get_dev_id(handle.dev) };
        let state = unsafe {
            let prefix = handle.dev.cast::<LvmDevPrefix>();
            prefix.as_ref().and_then(|dev| dev.status.as_ref())
        };
        let config = self.config_for_ip(&handle.ip);
        let fps = state.and_then(|state| {
            if state.hw_report_gap > 0 {
                Some((1000.0 / state.hw_report_gap as f32).min(999.0))
            } else {
                None
            }
        });
        let buffer_percent = state.map(|state| {
            if state.buffer_overflow_counter > 0 {
                100.0
            } else {
                0.0
            }
        });

        CaptureCameraStatus {
            connected,
            device_id,
            ip: handle.ip.clone(),
            driver_id: LVM_DRIVER_ID.to_string(),
            model: if handle.model.is_empty() {
                config
                    .map(|config| config.model_hint.clone())
                    .unwrap_or_default()
            } else {
                handle.model.clone()
            },
            sn: handle.sn.clone(),
            config_id: handle.config_id.clone(),
            name: config.map(|config| config.name.clone()),
            role: config.map(|config| config.role.clone()),
            enabled: config.map(|config| config.enabled).unwrap_or(true),
            acquisition_state: if connected { "connected" } else { "offline" }.to_string(),
            sdk_status: if self.sdk_ready { "ready" } else { "error" }.to_string(),
            fps,
            buffer_percent,
            last_frame_time: state
                .filter(|state| state.data_frame_counter > 0)
                .map(|_| now_millis_string()),
            task: state.map(|state| state.task),
            status: state.map(|state| state.status),
            link_health: state.map(|state| state.link_health),
            temperature_j28: state.map(|state| state.temperature_j28),
            temperature_j29: state.map(|state| state.temperature_j29),
            temperature_j30: state.map(|state| state.temperature_j30),
            lost_pulse_counter: state.map(|state| state.lost_pulse_counter),
            buffer_overflow_counter: state.map(|state| state.buffer_overflow_counter),
            error: if connected {
                None
            } else {
                Some("device disconnected".to_string())
            },
        }
    }

    fn status_from_config(
        &self,
        config: &CaptureCameraConfig,
        discovered: Option<&CaptureCamera>,
    ) -> CaptureCameraStatus {
        CaptureCameraStatus {
            connected: false,
            device_id: -1,
            ip: config.ip.clone(),
            driver_id: config.driver_id.clone(),
            model: discovered
                .map(|camera| camera.model.clone())
                .filter(|model| !model.is_empty())
                .unwrap_or_else(|| config.model_hint.clone()),
            sn: discovered
                .map(|camera| camera.sn.clone())
                .unwrap_or_default(),
            config_id: Some(config.id.clone()),
            name: Some(config.name.clone()),
            role: Some(config.role.clone()),
            enabled: config.enabled,
            acquisition_state: if !config.enabled {
                "disabled"
            } else if discovered.is_some() {
                "discovered"
            } else {
                "offline"
            }
            .to_string(),
            sdk_status: if self.sdk_ready { "ready" } else { "pending" }.to_string(),
            fps: None,
            buffer_percent: Some(0.0),
            last_frame_time: None,
            task: None,
            status: None,
            link_health: None,
            temperature_j28: None,
            temperature_j29: None,
            temperature_j30: None,
            lost_pulse_counter: None,
            buffer_overflow_counter: None,
            error: if config.enabled {
                Some("not connected".to_string())
            } else {
                None
            },
        }
    }

    fn empty_status(&self, ip: Option<String>) -> CaptureCameraStatus {
        CaptureCameraStatus {
            connected: false,
            device_id: -1,
            ip: ip.unwrap_or_default(),
            driver_id: LVM_DRIVER_ID.to_string(),
            model: String::new(),
            sn: String::new(),
            config_id: None,
            name: None,
            role: None,
            enabled: false,
            acquisition_state: "offline".to_string(),
            sdk_status: if self.sdk_ready { "ready" } else { "pending" }.to_string(),
            fps: None,
            buffer_percent: None,
            last_frame_time: None,
            task: None,
            status: None,
            link_health: None,
            temperature_j28: None,
            temperature_j29: None,
            temperature_j30: None,
            lost_pulse_counter: None,
            buffer_overflow_counter: None,
            error: Some("no camera selected".to_string()),
        }
    }

    fn set_param_for_handle(handle: &CameraHandle, key: &str, type_name: &str, value: f64) -> i32 {
        let Ok(key_c) = CString::new(key) else {
            return 400;
        };
        unsafe {
            if type_name == "float" {
                lvm_set_param_float_value(handle.dev, key_c.as_ptr(), value as c_float)
            } else {
                lvm_set_param_int_value(handle.dev, key_c.as_ptr(), value as c_int)
            }
        }
    }
}

impl Drop for LvmNvtDriver {
    fn drop(&mut self) {
        for (_, handle) in self.devices.drain() {
            unsafe {
                let _ = lvm_disconnect_dev(handle.dev);
                lvm_destroy_dev(handle.dev);
            }
        }
        if self.sdk_ready {
            unsafe {
                let _ = lvm_deinit_sdk();
            }
        }
    }
}

impl CameraDriverBackend for LvmNvtDriver {
    fn health(&mut self) -> CaptureHealth {
        let code = self.ensure_sdk();
        let connected = self
            .devices
            .values()
            .any(|handle| unsafe { lvm_get_dev_connect_status(handle.dev) == 1 });
        let ip = self
            .devices
            .values()
            .find(|handle| unsafe { lvm_get_dev_connect_status(handle.dev) == 1 })
            .map(|handle| handle.ip.clone())
            .unwrap_or_default();
        let sdk_version = unsafe { c_string(lvm_get_sdk_version()) };

        CaptureHealth {
            service: "tauri_capture_driver".to_string(),
            time: now_millis_string(),
            sdk_ready: self.sdk_ready,
            sdk_code: code,
            sdk_version,
            connected,
            ip,
            driver_id: LVM_DRIVER_ID.to_string(),
            driver_name: LVM_DRIVER_NAME.to_string(),
            camera_count: self.devices.len(),
        }
    }

    fn cameras(&mut self) -> CaptureCameraList {
        self.discover_cameras()
    }

    fn statuses(&mut self) -> CaptureStatusList {
        let discovered_result = self.discover_cameras();
        let discovered_by_ip: HashMap<String, CaptureCamera> = discovered_result
            .cameras
            .iter()
            .cloned()
            .map(|camera| (camera.ip.clone(), camera))
            .collect();
        let mut seen = HashSet::new();
        let mut statuses = Vec::new();

        for config in &self.applied_config.cameras {
            seen.insert(config.ip.clone());
            if let Some(handle) = self.devices.get(&config.ip) {
                statuses.push(self.status_from_handle(handle));
            } else {
                statuses.push(self.status_from_config(config, discovered_by_ip.get(&config.ip)));
            }
        }

        for handle in self.devices.values() {
            if seen.insert(handle.ip.clone()) {
                statuses.push(self.status_from_handle(handle));
            }
        }

        for camera in discovered_by_ip.values() {
            if seen.insert(camera.ip.clone()) {
                statuses.push(CaptureCameraStatus {
                    connected: false,
                    device_id: -1,
                    ip: camera.ip.clone(),
                    driver_id: camera.driver_id.clone(),
                    model: camera.model.clone(),
                    sn: camera.sn.clone(),
                    config_id: None,
                    name: None,
                    role: None,
                    enabled: true,
                    acquisition_state: "discovered".to_string(),
                    sdk_status: if self.sdk_ready { "ready" } else { "pending" }.to_string(),
                    fps: None,
                    buffer_percent: Some(0.0),
                    last_frame_time: None,
                    task: None,
                    status: None,
                    link_health: None,
                    temperature_j28: None,
                    temperature_j29: None,
                    temperature_j30: None,
                    lost_pulse_counter: None,
                    buffer_overflow_counter: None,
                    error: Some("not configured".to_string()),
                });
            }
        }

        CaptureStatusList {
            code: discovered_result.code,
            count: statuses.len(),
            statuses,
        }
    }

    fn status(&mut self, ip: Option<String>) -> CaptureCameraStatus {
        if let Some(ip) = ip {
            return self
                .statuses()
                .statuses
                .into_iter()
                .find(|status| status.ip == ip)
                .unwrap_or_else(|| self.empty_status(Some(ip)));
        }
        self.statuses()
            .statuses
            .into_iter()
            .find(|status| status.connected)
            .or_else(|| self.statuses().statuses.into_iter().next())
            .unwrap_or_else(|| self.empty_status(None))
    }

    fn connect(&mut self, ip: String, dev_type: Option<i32>) -> CaptureCommandResult {
        let sdk_code = self.ensure_sdk();
        if !(sdk_code == CORRECT || sdk_code == SDK_REPEATED_INIT) {
            return command_error(sdk_code, "sdk init failed");
        }
        if let Some(handle) = self.devices.get(&ip) {
            return CaptureCommandResult {
                code: CORRECT,
                connected: Some(true),
                ip: Some(handle.ip.clone()),
                key: None,
                output: None,
                width: None,
                lines: None,
                error: None,
                message: Some("already connected".to_string()),
            };
        }

        let config = self.config_for_ip(&ip).cloned();
        let discovered = self
            .discover_cameras()
            .cameras
            .into_iter()
            .find(|camera| camera.ip == ip);
        let mut ip_bytes = [0_u8; DEVICE_NET_INFO_LEN];
        let source = ip.as_bytes();
        let len = source.len().min(DEVICE_NET_INFO_LEN - 1);
        ip_bytes[..len].copy_from_slice(&source[..len]);
        let dev = unsafe {
            lvm_create_dev(
                ip_bytes.as_mut_ptr().cast::<c_char>(),
                dev_type.unwrap_or(-1),
            )
        };
        if dev.is_null() {
            return command_error(DEV_INIT_FAILED, "create device failed");
        }

        let code = unsafe { lvm_connect_dev(dev) };
        if code == CORRECT {
            let handle = CameraHandle {
                dev,
                ip: ip.clone(),
                model: discovered
                    .as_ref()
                    .map(|camera| camera.model.clone())
                    .or_else(|| config.as_ref().map(|config| config.model_hint.clone()))
                    .unwrap_or_default(),
                sn: discovered
                    .as_ref()
                    .map(|camera| camera.sn.clone())
                    .unwrap_or_default(),
                config_id: config.as_ref().map(|config| config.id.clone()),
            };
            if let Some(config) = config.as_ref() {
                let _ = LvmNvtDriver::set_param_for_handle(
                    &handle,
                    "ExposureTime",
                    "int",
                    f64::from(config.exposure_us),
                );
                let _ = LvmNvtDriver::set_param_for_handle(
                    &handle,
                    "GainK",
                    "float",
                    f64::from(config.gain),
                );
            }
            self.devices.insert(ip.clone(), handle);
            self.push_log("info", Some(ip.clone()), "camera connected");
        } else {
            unsafe {
                lvm_destroy_dev(dev);
            }
            self.push_log(
                "error",
                Some(ip.clone()),
                format!("camera connect failed: {code}"),
            );
        }

        CaptureCommandResult {
            code,
            connected: Some(code == CORRECT),
            ip: Some(ip),
            key: None,
            output: None,
            width: None,
            lines: None,
            error: None,
            message: None,
        }
    }

    fn disconnect(&mut self, ip: Option<String>) -> CaptureCommandResult {
        let targets: Vec<String> = if let Some(ip) = ip.clone() {
            vec![ip]
        } else {
            self.devices.keys().cloned().collect()
        };
        let mut final_code = CORRECT;
        for target_ip in targets {
            if let Some(handle) = self.devices.remove(&target_ip) {
                let code = unsafe {
                    let code = lvm_disconnect_dev(handle.dev);
                    lvm_destroy_dev(handle.dev);
                    code
                };
                if code != CORRECT {
                    final_code = code;
                }
                self.push_log("info", Some(target_ip), "camera disconnected");
            }
        }

        CaptureCommandResult {
            code: final_code,
            connected: Some(false),
            ip,
            key: None,
            output: None,
            width: None,
            lines: None,
            error: None,
            message: None,
        }
    }

    fn set_param(
        &mut self,
        ip: Option<String>,
        key: String,
        type_name: String,
        value: f64,
    ) -> CaptureCommandResult {
        let Some(handle) = self.select_handle(ip.as_deref()) else {
            return command_error(DEV_NOT_LINK_ERROR, "camera not connected");
        };
        let target_ip = handle.ip.clone();
        let code = LvmNvtDriver::set_param_for_handle(handle, &key, &type_name, value);
        if code == CORRECT {
            self.push_log(
                "info",
                Some(target_ip.clone()),
                format!("parameter {key} applied"),
            );
        } else {
            self.push_log(
                "warning",
                Some(target_ip.clone()),
                format!("parameter {key} failed: {code}"),
            );
        }

        CaptureCommandResult {
            code,
            connected: None,
            ip: Some(target_ip),
            key: Some(key),
            output: None,
            width: None,
            lines: None,
            error: None,
            message: None,
        }
    }

    fn capture_depth_map(
        &mut self,
        ip: Option<String>,
        lines: Option<i32>,
        output: Option<String>,
        timeout_ms: Option<i32>,
    ) -> CaptureCommandResult {
        let lines = lines.unwrap_or(1280);
        let timeout_ms = timeout_ms.unwrap_or(5000);
        let Some(handle) = self.select_handle(ip.as_deref()) else {
            return command_error(DEV_NOT_LINK_ERROR, "camera not connected");
        };
        let target_ip = handle.ip.clone();
        let output =
            output.unwrap_or_else(|| format!("capture-depth-{}.png", target_ip.replace('.', "-")));

        let mut width = unsafe { lvm_get_depth_map_width(handle.dev, lines) };
        if width <= 0 {
            width = 4096;
        }

        let buf = unsafe { lvm_alloc_depth_map_buf(handle.dev, 1, width, lines, 1) };
        if buf.is_null() {
            return command_error(MALLOC_FAILED, "depth buffer allocation failed");
        }

        let mut code = unsafe { lvm_bind_buf(handle.dev, buf) };
        let mut frame: *mut c_void = ptr::null_mut();
        if code == CORRECT {
            code = unsafe { lvm_trigger_en_ctrl(handle.dev, true) };
        }
        if code == CORRECT {
            frame = unsafe { lvm_grab_frame(handle.dev, timeout_ms) };
            if frame.is_null() {
                code = DEV_LOAD_DATA_ERROR;
            }
        }
        if code == CORRECT {
            let Ok(output_c) = CString::new(output.as_str()) else {
                unsafe {
                    let _ = lvm_grab_stop(handle.dev);
                    let _ = lvm_free_buf(buf);
                }
                return command_error(400, "invalid output path");
            };
            code = unsafe { lvm_save_depth_map(handle.dev, output_c.as_ptr(), frame) };
        }
        unsafe {
            let _ = lvm_grab_stop(handle.dev);
            let _ = lvm_free_buf(buf);
        }

        if code == CORRECT {
            self.push_log(
                "info",
                Some(target_ip.clone()),
                format!("depth map captured: {output}"),
            );
        } else {
            self.push_log(
                "error",
                Some(target_ip.clone()),
                format!("depth map failed: {code}"),
            );
        }

        CaptureCommandResult {
            code,
            connected: None,
            ip: Some(target_ip),
            key: None,
            output: Some(output),
            width: Some(width),
            lines: Some(lines),
            error: None,
            message: None,
        }
    }

    fn apply_config(&mut self, mut config: CaptureAppliedConfig) -> CaptureCommandResult {
        if config.cameras.is_empty() {
            return command_error(400, "config has no cameras");
        }
        config.applied = true;
        config.updated_at = now_millis_string();
        let name = config.name.clone();
        self.applied_config = config;

        let connected_ips: Vec<String> = self.devices.keys().cloned().collect();
        for ip in connected_ips {
            if let (Some(handle), Some(config)) = (self.devices.get(&ip), self.config_for_ip(&ip)) {
                let _ = LvmNvtDriver::set_param_for_handle(
                    handle,
                    "ExposureTime",
                    "int",
                    f64::from(config.exposure_us),
                );
                let _ = LvmNvtDriver::set_param_for_handle(
                    handle,
                    "GainK",
                    "float",
                    f64::from(config.gain),
                );
            }
        }
        self.push_log("info", None, format!("config applied: {name}"));

        CaptureCommandResult {
            code: CORRECT,
            connected: None,
            ip: None,
            key: None,
            output: None,
            width: None,
            lines: None,
            error: None,
            message: Some("config applied".to_string()),
        }
    }

    fn capabilities(&self) -> CaptureCapabilitySet {
        CaptureCapabilitySet {
            driver: self.driver_info(),
            controls: vec![
                CaptureControlCapability {
                    id: "connect".to_string(),
                    label: "Connect camera".to_string(),
                    scope: "camera".to_string(),
                    requires_connection: false,
                },
                CaptureControlCapability {
                    id: "disconnect".to_string(),
                    label: "Disconnect camera".to_string(),
                    scope: "camera".to_string(),
                    requires_connection: true,
                },
                CaptureControlCapability {
                    id: "capture_depth_map".to_string(),
                    label: "Capture depth map".to_string(),
                    scope: "camera".to_string(),
                    requires_connection: true,
                },
                CaptureControlCapability {
                    id: "apply_config".to_string(),
                    label: "Apply configuration".to_string(),
                    scope: "system".to_string(),
                    requires_connection: false,
                },
            ],
            parameters: vec![
                CaptureParameterCapability {
                    key: "ExposureTime".to_string(),
                    label: "Exposure".to_string(),
                    value_type: "int".to_string(),
                    unit: "us".to_string(),
                    min: Some(1.0),
                    max: Some(20000.0),
                    writable: true,
                },
                CaptureParameterCapability {
                    key: "GainK".to_string(),
                    label: "Gain".to_string(),
                    value_type: "float".to_string(),
                    unit: "x".to_string(),
                    min: Some(0.0),
                    max: Some(16.0),
                    writable: true,
                },
                CaptureParameterCapability {
                    key: "DepthLines".to_string(),
                    label: "Depth lines".to_string(),
                    value_type: "int".to_string(),
                    unit: "line".to_string(),
                    min: Some(64.0),
                    max: Some(8192.0),
                    writable: false,
                },
            ],
            api: vec![
                CaptureApiCapability {
                    method: "GET".to_string(),
                    path: "capture_driver_snapshot".to_string(),
                    label: "Snapshot".to_string(),
                    scope: "system".to_string(),
                },
                CaptureApiCapability {
                    method: "GET".to_string(),
                    path: "capture_driver_statuses".to_string(),
                    label: "Camera statuses".to_string(),
                    scope: "camera".to_string(),
                },
                CaptureApiCapability {
                    method: "POST".to_string(),
                    path: "capture_driver_connect".to_string(),
                    label: "Connect".to_string(),
                    scope: "camera".to_string(),
                },
                CaptureApiCapability {
                    method: "POST".to_string(),
                    path: "capture_driver_set_param".to_string(),
                    label: "Set parameter".to_string(),
                    scope: "camera".to_string(),
                },
                CaptureApiCapability {
                    method: "POST".to_string(),
                    path: "capture_driver_capture_depth_map".to_string(),
                    label: "Capture depth map".to_string(),
                    scope: "camera".to_string(),
                },
            ],
        }
    }

    fn logs(&self) -> Vec<CaptureLogEvent> {
        self.logs.clone()
    }

    fn snapshot(&mut self) -> CaptureSnapshot {
        let health = self.health();
        let camera_list = self.cameras();
        let status_list = self.statuses();
        let status = status_list
            .statuses
            .iter()
            .find(|status| status.connected)
            .cloned()
            .or_else(|| status_list.statuses.first().cloned())
            .unwrap_or_else(|| self.empty_status(None));
        CaptureSnapshot {
            health,
            driver: self.driver_info(),
            config: self.applied_config.clone(),
            cameras: camera_list.cameras,
            status,
            statuses: status_list.statuses,
            capabilities: self.capabilities(),
            logs: self.logs(),
        }
    }
}

pub struct CaptureDriver {
    backend: Mutex<Box<dyn CameraDriverBackend + Send>>,
}

impl CaptureDriver {
    pub fn new() -> Self {
        Self {
            backend: Mutex::new(Box::new(LvmNvtDriver::new())),
        }
    }

    fn with_backend<T>(&self, operation: impl FnOnce(&mut dyn CameraDriverBackend) -> T) -> T {
        let mut backend = self.backend.lock().expect("capture driver mutex poisoned");
        operation(backend.as_mut())
    }
}

extern "C" fn device_change_cb(_change: c_int, _info: LvmCamInfoRaw) -> c_int {
    0
}

fn c_string(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
}

fn now_millis_string() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    millis.to_string()
}

fn command_error(code: i32, error: impl Into<String>) -> CaptureCommandResult {
    CaptureCommandResult {
        code,
        connected: None,
        ip: None,
        key: None,
        output: None,
        width: None,
        lines: None,
        error: Some(error.into()),
        message: None,
    }
}

fn default_capture_config() -> CaptureAppliedConfig {
    let camera_roles = [
        ("CAM-01", "Camera 01", "192.168.10.13", "Entry left"),
        ("CAM-02", "Camera 02", "192.168.10.14", "Entry right"),
        ("CAM-03", "Camera 03", "192.168.10.15", "Middle left"),
        ("CAM-04", "Camera 04", "192.168.10.16", "Middle right"),
        ("CAM-05", "Camera 05", "192.168.10.17", "Exit left"),
        ("CAM-06", "Camera 06", "192.168.10.18", "Exit right"),
        ("CAM-07", "Camera 07", "192.168.10.19", "Backup upper"),
        ("CAM-08", "Camera 08", "192.168.10.20", "Backup lower"),
    ];

    CaptureAppliedConfig {
        id: "plate-a-online".to_string(),
        name: "Plate-A-Online".to_string(),
        applied: true,
        updated_at: now_millis_string(),
        cameras: camera_roles
            .iter()
            .enumerate()
            .map(|(index, (id, name, ip, role))| CaptureCameraConfig {
                id: (*id).to_string(),
                name: (*name).to_string(),
                ip: (*ip).to_string(),
                driver_id: LVM_DRIVER_ID.to_string(),
                model_hint: "LVM compatible 3D camera".to_string(),
                role: (*role).to_string(),
                enabled: index < 8,
                trigger_mode: "Encoder".to_string(),
                exposure_us: 850,
                gain: 1.0,
                depth_lines: 1280,
                output_path: format!("captures/{id}"),
            })
            .collect(),
    }
}

#[tauri::command]
pub fn capture_driver_snapshot(driver: tauri::State<'_, CaptureDriver>) -> CaptureSnapshot {
    driver.with_backend(|backend| backend.snapshot())
}

#[tauri::command]
pub fn capture_driver_health(driver: tauri::State<'_, CaptureDriver>) -> CaptureHealth {
    driver.with_backend(|backend| backend.health())
}

#[tauri::command]
pub fn capture_driver_cameras(driver: tauri::State<'_, CaptureDriver>) -> CaptureCameraList {
    driver.with_backend(|backend| backend.cameras())
}

#[tauri::command]
pub fn capture_driver_statuses(driver: tauri::State<'_, CaptureDriver>) -> CaptureStatusList {
    driver.with_backend(|backend| backend.statuses())
}

#[tauri::command]
pub fn capture_driver_status(
    driver: tauri::State<'_, CaptureDriver>,
    ip: Option<String>,
) -> CaptureCameraStatus {
    driver.with_backend(|backend| backend.status(ip))
}

#[tauri::command]
pub fn capture_driver_connect(
    driver: tauri::State<'_, CaptureDriver>,
    ip: String,
    dev_type: Option<i32>,
) -> CaptureCommandResult {
    driver.with_backend(|backend| backend.connect(ip, dev_type))
}

#[tauri::command]
pub fn capture_driver_disconnect(
    driver: tauri::State<'_, CaptureDriver>,
    ip: Option<String>,
) -> CaptureCommandResult {
    driver.with_backend(|backend| backend.disconnect(ip))
}

#[tauri::command]
pub fn capture_driver_set_param(
    driver: tauri::State<'_, CaptureDriver>,
    ip: Option<String>,
    key: String,
    type_name: String,
    value: f64,
) -> CaptureCommandResult {
    driver.with_backend(|backend| backend.set_param(ip, key, type_name, value))
}

#[tauri::command]
pub fn capture_driver_capture_depth_map(
    driver: tauri::State<'_, CaptureDriver>,
    ip: Option<String>,
    lines: Option<i32>,
    output: Option<String>,
    timeout_ms: Option<i32>,
) -> CaptureCommandResult {
    driver.with_backend(|backend| backend.capture_depth_map(ip, lines, output, timeout_ms))
}

#[tauri::command]
pub fn capture_driver_apply_config(
    driver: tauri::State<'_, CaptureDriver>,
    config: CaptureAppliedConfig,
) -> CaptureCommandResult {
    driver.with_backend(|backend| backend.apply_config(config))
}

#[tauri::command]
pub fn capture_driver_capabilities(
    driver: tauri::State<'_, CaptureDriver>,
) -> CaptureCapabilitySet {
    driver.with_backend(|backend| backend.capabilities())
}

#[tauri::command]
pub fn capture_driver_logs(driver: tauri::State<'_, CaptureDriver>) -> Vec<CaptureLogEvent> {
    driver.with_backend(|backend| backend.logs())
}
