#![recursion_limit = "256"]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::runtime::Runtime;

mod db;

#[derive(Clone)]
struct DefectType {
    id: &'static str,
    label: &'static str,
    color: &'static str,
    shape: &'static str,
}

#[derive(Clone)]
struct Record {
    id: &'static str,
    time: &'static str,
    plate_no: &'static str,
    status: &'static str,
    defect_count: usize,
}

#[derive(Clone)]
struct Plate {
    plate_no: String,
    width_mm: i32,
    length_mm: i32,
    thickness_mm: i32,
    steel_grade: String,
    detected_at: String,
}

#[derive(Clone)]
struct Defect {
    id: String,
    plate_no: String,
    type_id: String,
    type_label: String,
    surface: &'static str,
    severity: String,
    distance_head_mm: i32,
    operator_side_mm: i32,
    drive_side_mm: i32,
    width_mm: f64,
    height_mm: f64,
    depth_mm: f64,
    x_ratio: f64,
    y_offset_mm: f64,
    preview_x: i32,
    preview_y: i32,
}

const CAPTURE_SERVICE_PORT: u16 = 4317;
const CAPTURE_CAMERA_IP: &str = "192.168.105.13";
const CAPTURE_CAMERA_IPS: [&str; 6] = [
    "192.168.105.13",
    "192.168.102.100",
    "192.168.101.100",
    "192.168.103.100",
    "192.168.104.100",
    "192.168.106.100",
];
const CAPTURE_CAMERA_MODELS: [&str; 6] = [
    "LVM3450CA",
    "LVM3450CA",
    "LVM3450BE",
    "LVM3450RE",
    "LVM3450BE",
    "LVM3450RE",
];
const CAPTURE_CAMERA_SERIALS: [&str; 6] = [
    "YF-0263",
    "3G506501CA09165",
    "3G506401BE08818",
    "3G506401RE08993",
    "3G506401BE08819",
    "3G506401RE08991",
];
const LOGIN_MAX_FAILURES: u32 = 5;
const LOGIN_MAX_FAILURES_MIN: u32 = 1;
const LOGIN_MAX_FAILURES_MAX: u32 = 20;
const LOGIN_FAILURE_WINDOW_MS: u128 = 10 * 60 * 1000;
const LOGIN_FAILURE_WINDOW_MIN_MINUTES: u64 = 1;
const LOGIN_FAILURE_WINDOW_MAX_MINUTES: u64 = 24 * 60;
const LOGIN_LOCKOUT_MS: u128 = 5 * 60 * 1000;
const LOGIN_LOCKOUT_MIN_MINUTES: u64 = 1;
const LOGIN_LOCKOUT_MAX_MINUTES: u64 = 24 * 60;
const ADMIN_PASSWORD_MIN_LEN: usize = 8;
const ADMIN_PASSWORD_MAX_LEN: usize = 128;
const ADMIN_EXPORT_MAX_ROWS: u64 = 5000;
const ADMIN_AUDIT_RETENTION_MIN_DAYS: u64 = 1;
const ADMIN_AUDIT_RETENTION_DEFAULT_DAYS: u64 = 180;
const ADMIN_AUDIT_RETENTION_MAX_DAYS: u64 = 3650;
const ADMIN_RECORD_RETENTION_MIN_DAYS: u64 = 1;
const ADMIN_RECORD_RETENTION_MAX_DAYS: u64 = 3650;
const ADMIN_SESSION_TTL_HOURS: u64 = 8;
const ADMIN_SESSION_TTL_MIN_HOURS: u64 = 1;
const ADMIN_SESSION_TTL_MAX_HOURS: u64 = 24 * 7;
const SECURITY_POLICY_CONFIG_KEY: &str = "security_policy";
const INSPECTION_SETTINGS_CONFIG_KEY: &str = "inspection_settings";
const ALARM_RULES_CONFIG_KEY: &str = "alarm_rules";
const EXTERNAL_INTEGRATIONS_CONFIG_KEY: &str = "external_integrations";
const CONFIG_JSON_MAX_BYTES: usize = 128 * 1024;
const CAPTURE_CAMERA_MAX_COUNT: usize = 16;
const ADMIN_ID_MAX_LEN: usize = 64;
const ADMIN_LABEL_MAX_LEN: usize = 128;
const ADMIN_DESCRIPTION_MAX_LEN: usize = 256;
const DAY_MILLIS: u128 = 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureProvider {
    HeadlessCpp,
    QtTerminal,
    ExternalApi,
    Simulated,
}

impl CaptureProvider {
    fn from_env_value(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "qt" | "qt-terminal" | "capture-qt" => Self::QtTerminal,
            "external" | "external-api" | "api" => Self::ExternalApi,
            "sim" | "simulated" | "simulation" => Self::Simulated,
            _ => Self::HeadlessCpp,
        }
    }

    fn from_env() -> Self {
        env::var("STEEL_CAPTURE_PROVIDER")
            .map(|value| Self::from_env_value(&value))
            .unwrap_or(Self::HeadlessCpp)
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::HeadlessCpp => "headless-cpp",
            Self::QtTerminal => "qt-terminal",
            Self::ExternalApi => "external-api",
            Self::Simulated => "simulated",
        }
    }

    fn is_managed(&self) -> bool {
        matches!(self, Self::HeadlessCpp)
    }

    fn uses_local_api(&self) -> bool {
        !matches!(self, Self::Simulated)
    }
}

struct ServiceState {
    fallback_snapshot_json: Arc<String>,
    config_json: Mutex<String>,
    capture: Arc<CaptureServiceManager>,
    database: db::AppDatabase,
    runtime: Runtime,
    sessions: Mutex<HashMap<String, AdminSession>>,
    login_failures: Mutex<HashMap<String, LoginFailureState>>,
    started_at: u128,
}

#[derive(Clone)]
struct LoginFailureState {
    count: u32,
    first_failed_at: u128,
    locked_until: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SecurityPolicy {
    audit_retention_days: u64,
    login_max_failures: u32,
    login_failure_window_minutes: u64,
    login_lockout_minutes: u64,
    session_ttl_hours: u64,
}

impl SecurityPolicy {
    fn login_failure_window_ms(&self) -> u128 {
        u128::from(self.login_failure_window_minutes) * 60 * 1000
    }

    fn login_lockout_ms(&self) -> u128 {
        u128::from(self.login_lockout_minutes) * 60 * 1000
    }

    fn session_ttl_ms(&self) -> u128 {
        u128::from(self.session_ttl_hours) * 60 * 60 * 1000
    }
}

enum PasswordPolicyError {
    Missing,
    Length,
    Complexity,
}

#[derive(Clone)]
struct AdminSession {
    session_id: String,
    token: String,
    user_id: String,
    display_name: String,
    role: String,
    permissions: Vec<String>,
    user_agent: String,
    created_at: u128,
    expires_at: u128,
}

struct CaptureServiceManager {
    host: String,
    port: u16,
    origin: String,
    provider: CaptureProvider,
    process: Mutex<Option<Child>>,
}

impl Drop for CaptureServiceManager {
    fn drop(&mut self) {
        if let Ok(mut process) = self.process.lock() {
            if let Some(child) = process.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

const DEFECT_TYPES: &[DefectType] = &[
    DefectType {
        id: "pit",
        label: "凹坑",
        color: "#2f6bff",
        shape: "circle",
    },
    DefectType {
        id: "roll",
        label: "辊印",
        color: "#ff7f1f",
        shape: "square",
    },
    DefectType {
        id: "scratch",
        label: "划伤",
        color: "#24a647",
        shape: "rect",
    },
    DefectType {
        id: "foreign",
        label: "异物压入",
        color: "#f0141e",
        shape: "diamond",
    },
    DefectType {
        id: "burnt",
        label: "烂钢",
        color: "#8b5cf6",
        shape: "square",
    },
    DefectType {
        id: "edge",
        label: "边裂",
        color: "#f6b800",
        shape: "diamond",
    },
    DefectType {
        id: "longitudinal",
        label: "纵裂",
        color: "#17bce1",
        shape: "rect",
    },
    DefectType {
        id: "bubble",
        label: "气泡",
        color: "#ec4899",
        shape: "circle",
    },
    DefectType {
        id: "inclusion",
        label: "夹杂",
        color: "#a63a1f",
        shape: "circle",
    },
    DefectType {
        id: "review",
        label: "待复核",
        color: "#737373",
        shape: "star",
    },
];

const RECORDS: &[Record] = &[
    Record {
        id: "R-001",
        time: "19:00",
        plate_no: "202606131900",
        status: "detecting",
        defect_count: 12,
    },
    Record {
        id: "R-002",
        time: "18:42",
        plate_no: "202606131858",
        status: "completed",
        defect_count: 8,
    },
    Record {
        id: "R-003",
        time: "18:20",
        plate_no: "202606131820",
        status: "completed",
        defect_count: 0,
    },
    Record {
        id: "R-004",
        time: "17:55",
        plate_no: "202606131755",
        status: "completed",
        defect_count: 24,
    },
    Record {
        id: "R-005",
        time: "17:30",
        plate_no: "202606131730",
        status: "completed",
        defect_count: 5,
    },
    Record {
        id: "R-006",
        time: "17:05",
        plate_no: "202606131705",
        status: "completed",
        defect_count: 16,
    },
    Record {
        id: "R-007",
        time: "16:40",
        plate_no: "202606131640",
        status: "completed",
        defect_count: 2,
    },
    Record {
        id: "R-008",
        time: "16:15",
        plate_no: "202606131615",
        status: "completed",
        defect_count: 7,
    },
    Record {
        id: "R-009",
        time: "15:50",
        plate_no: "202606131550",
        status: "completed",
        defect_count: 10,
    },
    Record {
        id: "R-010",
        time: "15:25",
        plate_no: "202606131525",
        status: "completed",
        defect_count: 3,
    },
];

fn current_defects() -> Vec<Defect> {
    vec![
        defect(
            "D-001",
            "202606131900",
            "pit",
            "凹坑",
            "top",
            "severe",
            8342,
            1260,
            2240,
            0.42,
            0.36,
            -0.12,
            0.18,
            0.92,
            54,
            48,
        ),
        defect(
            "D-002",
            "202606131900",
            "scratch",
            "划伤",
            "bottom",
            "minor",
            5260,
            580,
            2920,
            0.64,
            0.18,
            -0.05,
            0.12,
            0.52,
            38,
            40,
        ),
        defect(
            "D-003",
            "202606131900",
            "roll",
            "辊印",
            "top",
            "review",
            4100,
            2050,
            1450,
            0.28,
            0.28,
            -0.08,
            0.42,
            -0.40,
            50,
            54,
        ),
        defect(
            "D-004",
            "202606131900",
            "foreign",
            "异物压入",
            "bottom",
            "severe",
            3880,
            960,
            2540,
            0.48,
            0.42,
            -0.14,
            0.04,
            0.82,
            43,
            48,
        ),
        defect(
            "D-005",
            "202606131900",
            "pit",
            "凹坑",
            "top",
            "severe",
            3200,
            1780,
            1720,
            0.38,
            0.31,
            -0.10,
            0.61,
            0.84,
            56,
            45,
        ),
        defect(
            "D-006",
            "202606131900",
            "scratch",
            "划伤",
            "top",
            "minor",
            2910,
            1560,
            1940,
            0.71,
            0.16,
            -0.04,
            0.62,
            -0.48,
            48,
            53,
        ),
        defect(
            "D-007",
            "202606131900",
            "roll",
            "辊印",
            "bottom",
            "review",
            2600,
            1440,
            2060,
            0.36,
            0.33,
            -0.07,
            0.24,
            -0.52,
            46,
            57,
        ),
        defect(
            "D-008",
            "202606131900",
            "pit",
            "凹坑",
            "bottom",
            "minor",
            1980,
            1840,
            1660,
            0.40,
            0.33,
            -0.09,
            0.72,
            -0.45,
            59,
            50,
        ),
        defect(
            "D-009",
            "202606131900",
            "bubble",
            "气泡",
            "bottom",
            "minor",
            1460,
            1740,
            1760,
            0.26,
            0.24,
            -0.03,
            0.71,
            0.52,
            52,
            49,
        ),
        defect(
            "D-010",
            "202606131900",
            "foreign",
            "异物压入",
            "top",
            "severe",
            920,
            2680,
            820,
            0.50,
            0.42,
            -0.16,
            0.78,
            0.90,
            61,
            45,
        ),
        defect(
            "D-011",
            "202606131900",
            "burnt",
            "烂钢",
            "bottom",
            "review",
            640,
            2240,
            1260,
            0.34,
            0.34,
            -0.08,
            0.82,
            -0.52,
            63,
            55,
        ),
        defect(
            "D-012",
            "202606131900",
            "edge",
            "边裂",
            "bottom",
            "minor",
            540,
            2480,
            1020,
            0.55,
            0.26,
            -0.05,
            0.84,
            -0.95,
            65,
            58,
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
fn defect(
    id: &str,
    plate_no: &str,
    type_id: &str,
    type_label: &str,
    surface: &'static str,
    severity: &str,
    distance_head_mm: i32,
    operator_side_mm: i32,
    drive_side_mm: i32,
    width_mm: f64,
    height_mm: f64,
    depth_mm: f64,
    x_ratio: f64,
    y_offset_mm: f64,
    preview_x: i32,
    preview_y: i32,
) -> Defect {
    Defect {
        id: id.to_string(),
        plate_no: plate_no.to_string(),
        type_id: type_id.to_string(),
        type_label: type_label.to_string(),
        surface,
        severity: severity.to_string(),
        distance_head_mm,
        operator_side_mm,
        drive_side_mm,
        width_mm,
        height_mm,
        depth_mm,
        x_ratio,
        y_offset_mm,
        preview_x,
        preview_y,
    }
}

fn plate_from_record(record: &Record, index: usize) -> Plate {
    let (width_mm, length_mm, thickness_mm, steel_grade) = match record.plate_no {
        "202606131900" => (3500, 12000, 12, "Q355B"),
        "202606131858" => (3600, 11800, 14, "Q355B"),
        "202606131820" => (3200, 10000, 10, "Q235B"),
        "202606131755" => (3800, 12500, 16, "Q420B"),
        _ => (
            3300 + (index % 4) as i32 * 120,
            10800 + (index % 5) as i32 * 350,
            10 + (index % 4) as i32 * 2,
            if index % 3 == 0 { "Q355B" } else { "Q235B" },
        ),
    };
    Plate {
        plate_no: record.plate_no.to_string(),
        width_mm,
        length_mm,
        thickness_mm,
        steel_grade: steel_grade.to_string(),
        detected_at: format!("2026-06-13 {}", record.time),
    }
}

fn severity_plan(record: &Record) -> Vec<&'static str> {
    match record.plate_no {
        "202606131858" => vec![
            "severe", "review", "minor", "review", "severe", "minor", "review", "minor",
        ],
        "202606131755" => vec![
            "severe", "review", "minor", "minor", "severe", "review", "minor", "severe", "review",
            "minor", "minor", "review", "severe", "minor", "review", "minor", "severe", "review",
            "minor", "minor", "review", "severe", "minor", "minor",
        ],
        _ => {
            let cycle = ["minor", "review", "minor", "severe", "review"];
            (0..record.defect_count)
                .map(|index| cycle[index % cycle.len()])
                .collect()
        }
    }
}

fn defects_for_record(record: &Record, plate: &Plate, record_index: usize) -> Vec<Defect> {
    if record.plate_no == "202606131900" {
        return current_defects();
    }
    let severities = severity_plan(record);
    severities
        .iter()
        .enumerate()
        .map(|(index, severity)| {
            let defect_type = &DEFECT_TYPES[(record_index + index) % (DEFECT_TYPES.len() - 1)];
            let distance_head_mm = (((index + 1) as f64 * plate.length_mm as f64)
                / (severities.len() + 1) as f64)
                .round() as i32;
            let side_position =
                ((index * 431 + record_index * 277) % plate.width_mm as usize + 1) as i32;
            let operator_side_mm = side_position.min(plate.width_mm - 80);
            let drive_side_mm = 80.max(plate.width_mm - operator_side_mm);
            let depth_mm = match *severity {
                "severe" => -0.13 - (index % 3) as f64 * 0.015,
                "review" => -0.08 - (index % 2) as f64 * 0.01,
                _ => -0.035 - (index % 3) as f64 * 0.008,
            };
            Defect {
                id: format!("D-{}{:02}", record_index + 1, index + 1),
                plate_no: record.plate_no.to_string(),
                type_id: defect_type.id.to_string(),
                type_label: defect_type.label.to_string(),
                surface: if index % 2 == 0 { "top" } else { "bottom" },
                severity: (*severity).to_string(),
                distance_head_mm,
                operator_side_mm,
                drive_side_mm,
                width_mm: 0.24 + (index % 5) as f64 * 0.09,
                height_mm: 0.16 + (index % 4) as f64 * 0.07,
                depth_mm,
                x_ratio: distance_head_mm as f64 / plate.length_mm as f64,
                y_offset_mm: ((operator_side_mm as f64 / plate.width_mm as f64) - 0.5) * 2.0,
                preview_x: 34 + ((index * 7 + record_index * 5) % 32) as i32,
                preview_y: 38 + ((index * 5 + record_index * 3) % 22) as i32,
            }
        })
        .collect()
}

fn height_profile(depth: f64, center: i32) -> Vec<f64> {
    (0..81)
        .map(|index| {
            let offset = (index - center) as f64;
            let dip = (-(offset * offset) / 16.0).exp() * depth;
            let ripple = (index as f64 / 6.0).sin() * 0.012;
            dip + ripple
        })
        .collect()
}

fn json_escape(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| match ch {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect(),
            '\n' => "\\n".chars().collect(),
            '\r' => "\\r".chars().collect(),
            '\t' => "\\t".chars().collect(),
            _ => vec![ch],
        })
        .collect()
}

fn config_dir() -> PathBuf {
    if let Ok(explicit_path) = env::var("STEEL_SERVICE_CONFIG_DIR") {
        return PathBuf::from(explicit_path);
    }
    if let Ok(current_dir) = env::current_dir() {
        for ancestor in current_dir.ancestors().take(8) {
            if ancestor
                .join("app")
                .join("service")
                .join("Cargo.toml")
                .is_file()
            {
                return ancestor.join("config");
            }
        }
        return current_dir.join("config");
    }
    PathBuf::from("config")
}

fn current_time_string() -> String {
    current_time_millis().to_string()
}

fn current_time_millis() -> u128 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis(),
        Err(_) => 0,
    }
}

fn format_duration_ms(value: u128) -> String {
    let total_seconds = value / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m {seconds}s")
    } else {
        format!("{seconds}s")
    }
}

fn create_session_token(user_id: &str) -> String {
    let now = current_time_millis();
    let seed = format!("{}:{}:{}", user_id, now, current_time_string());
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in seed.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("adm-{}-{:016x}", now, hash)
}

fn create_session_id(user_id: &str, token: &str, created_at: u128) -> String {
    let seed = format!("{user_id}:{token}:{created_at}");
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in seed.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("ses-{created_at}-{hash:016x}")
}

fn capture_port() -> u16 {
    if let Ok(origin) = env::var("CAPTURE_SERVICE_ORIGIN") {
        if let Some(port) = capture_port_from_origin(&origin) {
            return port;
        }
    }
    env::var("CAPTURE_SERVICE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(CAPTURE_SERVICE_PORT)
}

fn capture_origin(port: u16) -> String {
    env::var("CAPTURE_SERVICE_ORIGIN").unwrap_or_else(|_| format!("http://127.0.0.1:{port}"))
}

fn capture_endpoint_from_origin(origin: &str) -> Option<(String, u16)> {
    let without_scheme = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .unwrap_or(origin);
    let authority = without_scheme.split('/').next().unwrap_or(without_scheme);
    let (host, port) = authority.rsplit_once(':')?;
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port.parse::<u16>().ok()?))
}

fn capture_host_from_origin(origin: &str) -> Option<String> {
    capture_endpoint_from_origin(origin).map(|(host, _)| host)
}

fn capture_port_from_origin(origin: &str) -> Option<u16> {
    capture_endpoint_from_origin(origin).map(|(_, port)| port)
}

fn capture_service_listening_at(host: &str, port: u16) -> bool {
    let Ok(addresses) = (host, port).to_socket_addrs() else {
        return false;
    };
    addresses
        .into_iter()
        .any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok())
}

fn push_capture_target_candidates(candidates: &mut Vec<PathBuf>, base: &Path) {
    for ancestor in base.ancestors().take(8) {
        candidates.push(
            ancestor
                .join("target")
                .join("capture")
                .join("Release")
                .join("steel_capture_service.exe"),
        );
        candidates.push(
            ancestor
                .join("capture")
                .join("Release")
                .join("steel_capture_service.exe"),
        );
    }
}

fn find_capture_service_exe() -> Option<PathBuf> {
    if let Ok(explicit_path) = env::var("STEEL_CAPTURE_SERVICE_EXE") {
        let path = PathBuf::from(explicit_path);
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();
    if let Ok(current_exe) = env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(exe_dir.join("steel_capture_service.exe"));
            candidates.push(exe_dir.join("capture").join("steel_capture_service.exe"));
            push_capture_target_candidates(&mut candidates, exe_dir);
        }
    }
    if let Ok(current_dir) = env::current_dir() {
        push_capture_target_candidates(&mut candidates, &current_dir);
    }

    candidates.into_iter().find(|path| path.is_file())
}

fn default_capture_camera_value(index: usize) -> Value {
    let camera_no = index + 1;
    let camera_id = format!("CAM-{camera_no:02}");
    let roles = [
        "上表面入口相机",
        "上表面中部相机",
        "上表面出口相机",
        "下表面入口相机",
        "下表面中部相机",
        "下表面出口相机",
    ];
    json!({
        "id": camera_id,
        "name": format!("{camera_no} 号采集相机"),
        "ip": CAPTURE_CAMERA_IPS[index],
        "driverId": "lvm-nvt",
        "modelHint": CAPTURE_CAMERA_MODELS[index],
        "role": roles[index],
        "enabled": true,
        "triggerMode": "软件触发",
        "exposureUs": 850,
        "gain": 1,
        "depthLines": 1280,
        "outputPath": format!("captures/{camera_id}")
    })
}

fn default_capture_cameras_value() -> Value {
    Value::Array((0..CAPTURE_CAMERA_IPS.len()).map(default_capture_camera_value).collect())
}

fn build_config_json(capture_port: u16) -> String {
    let provider = CaptureProvider::from_env();
    let origin = capture_origin(capture_port);
    json!({
        "service": {
            "name": "steel-inspection-service",
            "role": "api-config-capture-orchestrator",
            "capturePort": capture_port,
            "captureOrigin": origin,
            "captureProvider": provider.as_str(),
            "captureManaged": provider.is_managed(),
            "updatedAt": current_time_string()
        },
        "capture": {
            "mode": "six-camera",
            "driver": "lvm-nvt",
            "provider": provider.as_str(),
            "fallback": "simulated",
            "cameras": default_capture_cameras_value()
        }
    })
    .to_string()
}

impl CaptureServiceManager {
    fn new(port: u16) -> Self {
        let provider = CaptureProvider::from_env();
        let origin = capture_origin(port);
        let host = capture_host_from_origin(&origin).unwrap_or_else(|| "127.0.0.1".to_string());
        let port = capture_port_from_origin(&origin).unwrap_or(port);
        let manager = Self {
            host,
            port,
            origin,
            provider,
            process: Mutex::new(None),
        };
        manager.ensure_started();
        manager
    }

    fn ensure_started(&self) {
        if !self.provider.is_managed() {
            return;
        }
        if self.endpoint_listening() {
            return;
        }
        if env::var("STEEL_CAPTURE_SERVICE_AUTOSTART").as_deref() == Ok("0") {
            return;
        }
        let _ = self.spawn_process();
    }

    fn spawn_process(&self) -> bool {
        if !self.provider.is_managed() {
            return false;
        }
        let Some(exe) = find_capture_service_exe() else {
            return false;
        };
        let mut command = Command::new(&exe);
        command
            .arg("--port")
            .arg(self.port.to_string())
            .current_dir(exe.parent().unwrap_or_else(|| Path::new(".")))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        if let Ok(child) = command.spawn() {
            if let Ok(mut process) = self.process.lock() {
                *process = Some(child);
            }
            std::thread::sleep(Duration::from_millis(250));
            self.endpoint_listening()
        } else {
            false
        }
    }

    fn start(&self) -> bool {
        if self.provider == CaptureProvider::Simulated {
            return true;
        }
        if !self.provider.is_managed() {
            return self.endpoint_listening();
        }
        if self.endpoint_listening() {
            return true;
        }
        self.spawn_process()
    }

    fn stop(&self) -> bool {
        if self.provider == CaptureProvider::Simulated {
            return true;
        }
        if !self.provider.is_managed() {
            return !self.endpoint_listening();
        }
        if let Ok(mut process) = self.process.lock() {
            if let Some(mut child) = process.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        std::thread::sleep(Duration::from_millis(200));
        !self.endpoint_listening()
    }

    fn restart(&self) -> bool {
        if self.provider == CaptureProvider::Simulated {
            return true;
        }
        if !self.provider.is_managed() {
            return self.endpoint_listening();
        }
        let mut killed_managed_process = false;
        if let Ok(mut process) = self.process.lock() {
            if let Some(mut child) = process.take() {
                let _ = child.kill();
                let _ = child.wait();
                killed_managed_process = true;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
        self.ensure_started();
        killed_managed_process || self.endpoint_listening()
    }

    fn endpoint_listening(&self) -> bool {
        capture_service_listening_at(&self.host, self.port)
    }

    fn is_running(&self) -> bool {
        self.provider == CaptureProvider::Simulated
            || (self.provider.uses_local_api() && self.endpoint_listening())
    }

    fn status_json(&self) -> String {
        let exe = find_capture_service_exe()
            .map(|path| path.display().to_string())
            .unwrap_or_default();
        let running = self.is_running();
        let process_available = match self.provider {
            CaptureProvider::HeadlessCpp => !exe.is_empty(),
            CaptureProvider::QtTerminal | CaptureProvider::ExternalApi => true,
            CaptureProvider::Simulated => false,
        };
        format!(
            "{{\"name\":\"capture-service\",\"provider\":\"{}\",\"managed\":{},\"running\":{},\"port\":{},\"origin\":\"{}\",\"processAvailable\":{},\"executable\":\"{}\",\"fallback\":\"simulated-six-camera\"}}",
            self.provider.as_str(),
            if self.provider.is_managed() { "true" } else { "false" },
            if running { "true" } else { "false" },
            self.port,
            json_escape(&self.origin),
            if process_available { "true" } else { "false" },
            json_escape(&exe)
        )
    }

    fn proxy(&self, method: &str, path_with_query: &str, body: &str) -> Option<Vec<u8>> {
        if !self.provider.uses_local_api() {
            return None;
        }
        self.ensure_started();
        if !self.endpoint_listening() {
            return None;
        }
        let address = (self.host.as_str(), self.port)
            .to_socket_addrs()
            .ok()?
            .find(|addr| TcpStream::connect_timeout(addr, Duration::from_millis(200)).is_ok())?;
        let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(1500)).ok()?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(8)));
        let request = format!(
            "{method} {path_with_query} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            self.host,
            self.port,
            body.as_bytes().len(),
            body
        );
        stream.write_all(request.as_bytes()).ok()?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).ok()?;
        let header_text = String::from_utf8_lossy(&response);
        let status_code = header_text
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse::<u16>().ok())?;
        if !(200..300).contains(&status_code) {
            return None;
        }
        let marker = b"\r\n\r\n";
        let body_start = response
            .windows(marker.len())
            .position(|window| window == marker)
            .map(|index| index + marker.len())?;
        Some(response[body_start..].to_vec())
    }
}

fn plate_json(plate: &Plate) -> String {
    format!(
        "{{\"plateNo\":\"{}\",\"widthMm\":{},\"lengthMm\":{},\"thicknessMm\":{},\"steelGrade\":\"{}\",\"detectedAt\":\"{}\"}}",
        json_escape(&plate.plate_no),
        plate.width_mm,
        plate.length_mm,
        plate.thickness_mm,
        json_escape(&plate.steel_grade),
        json_escape(&plate.detected_at)
    )
}

fn defect_json(defect: &Defect) -> String {
    format!(
        "{{\"id\":\"{}\",\"plateNo\":\"{}\",\"typeId\":\"{}\",\"typeLabel\":\"{}\",\"surface\":\"{}\",\"severity\":\"{}\",\"distanceHeadMm\":{},\"operatorSideMm\":{},\"driveSideMm\":{},\"widthMm\":{:.3},\"heightMm\":{:.3},\"depthMm\":{:.3},\"xRatio\":{:.5},\"yOffsetMm\":{:.5},\"previewX\":{},\"previewY\":{},\"previewImageUrl\":\"\"}}",
        json_escape(&defect.id),
        json_escape(&defect.plate_no),
        json_escape(&defect.type_id),
        json_escape(&defect.type_label),
        defect.surface,
        json_escape(&defect.severity),
        defect.distance_head_mm,
        defect.operator_side_mm,
        defect.drive_side_mm,
        defect.width_mm,
        defect.height_mm,
        defect.depth_mm,
        defect.x_ratio,
        defect.y_offset_mm,
        defect.preview_x,
        defect.preview_y
    )
}

fn defects_json(defects: &[Defect]) -> String {
    format!(
        "[{}]",
        defects
            .iter()
            .map(defect_json)
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn height_profile_json(values: &[f64]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .enumerate()
            .map(|(index, z)| format!("{{\"x\":{},\"z\":{:.5}}}", index, z))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn build_snapshot_json() -> String {
    let current_plate = plate_from_record(&RECORDS[0], 0);
    let current_defects = current_defects();
    let current_height = height_profile(-0.18, 36);
    let defect_types = DEFECT_TYPES
        .iter()
        .map(|item| {
            format!(
                "{{\"id\":\"{}\",\"label\":\"{}\",\"color\":\"{}\",\"shape\":\"{}\"}}",
                item.id,
                json_escape(item.label),
                item.color,
                item.shape
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let records = RECORDS
        .iter()
        .map(|record| {
            format!(
                "{{\"id\":\"{}\",\"time\":\"{}\",\"plateNo\":\"{}\",\"status\":\"{}\",\"defectCount\":{}}}",
                record.id, record.time, record.plate_no, record.status, record.defect_count
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let inspections = RECORDS
        .iter()
        .enumerate()
        .map(|(index, record)| {
            let plate = plate_from_record(record, index);
            let defects = defects_for_record(record, &plate, index);
            let profile = if index == 0 {
                current_height.clone()
            } else {
                height_profile(
                    defects.first().map(|item| item.depth_mm).unwrap_or(-0.02),
                    28 + ((index * 7) % 22) as i32,
                )
            };
            format!(
                "{{\"plate\":{},\"defects\":{},\"heightProfile\":{}}}",
                plate_json(&plate),
                defects_json(&defects),
                height_profile_json(&profile)
            )
        })
        .collect::<Vec<_>>()
        .join(",");

    format!(
        "{{\"currentPlate\":{},\"defectTypes\":[{}],\"defects\":{},\"records\":[{}],\"status\":{},\"summary\":{},\"heightProfile\":{},\"inspections\":[{}]}}",
        plate_json(&current_plate),
        defect_types,
        defects_json(&current_defects),
        records,
        "{\"receiverPorts\":[{\"index\":1,\"ok\":true},{\"index\":2,\"ok\":true},{\"index\":3,\"ok\":false},{\"index\":4,\"ok\":true},{\"index\":5,\"ok\":true},{\"index\":6,\"ok\":true},{\"index\":7,\"ok\":true},{\"index\":8,\"ok\":true}],\"cameraPorts\":[{\"index\":1,\"ok\":true},{\"index\":2,\"ok\":true},{\"index\":3,\"ok\":false},{\"index\":4,\"ok\":true},{\"index\":5,\"ok\":true},{\"index\":6,\"ok\":true},{\"index\":7,\"ok\":true},{\"index\":8,\"ok\":true}],\"encoder\":\"sync\",\"plc\":\"normal\",\"l2\":\"normal\",\"alarmCount\":1}",
        "{\"total\":12,\"bySeverity\":{\"severe\":4,\"review\":3,\"minor\":5},\"bySurface\":{\"top\":5,\"bottom\":7}}",
        height_profile_json(&current_height),
        inspections
    )
}

fn database_plate_json(plate: &db::entities::steel_plate::Model) -> String {
    format!(
        "{{\"plateNo\":\"{}\",\"widthMm\":{},\"lengthMm\":{},\"thicknessMm\":{},\"steelGrade\":\"{}\",\"detectedAt\":\"{}\"}}",
        json_escape(&plate.plate_no),
        plate.width_mm,
        plate.length_mm,
        plate.thickness_mm,
        json_escape(&plate.steel_grade),
        json_escape(&plate.detected_at)
    )
}

fn database_defect_json(defect: &db::entities::defect::Model) -> String {
    format!(
        "{{\"id\":\"{}\",\"plateNo\":\"{}\",\"typeId\":\"{}\",\"typeLabel\":\"{}\",\"surface\":\"{}\",\"severity\":\"{}\",\"distanceHeadMm\":{},\"operatorSideMm\":{},\"driveSideMm\":{},\"widthMm\":{:.3},\"heightMm\":{:.3},\"depthMm\":{:.3},\"xRatio\":{:.5},\"yOffsetMm\":{:.5},\"previewX\":{},\"previewY\":{},\"previewImageUrl\":\"\"}}",
        json_escape(&defect.id),
        json_escape(&defect.plate_no),
        json_escape(&defect.type_id),
        json_escape(&defect.type_label),
        json_escape(&defect.surface),
        json_escape(&defect.severity),
        defect.distance_head_mm,
        defect.operator_side_mm,
        defect.drive_side_mm,
        defect.width_mm,
        defect.height_mm,
        defect.depth_mm,
        defect.x_ratio,
        defect.y_offset_mm,
        defect.preview_x,
        defect.preview_y
    )
}

fn database_defects_json(defects: &[db::entities::defect::Model]) -> String {
    format!(
        "[{}]",
        defects
            .iter()
            .map(database_defect_json)
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn build_database_snapshot_json(snapshot: db::DatabaseSnapshot) -> String {
    let current_plate =
        snapshot
            .plates
            .first()
            .cloned()
            .unwrap_or(db::entities::steel_plate::Model {
                plate_no: "202606131900".to_string(),
                width_mm: 3500,
                length_mm: 12000,
                thickness_mm: 12,
                steel_grade: "Q355B".to_string(),
                detected_at: "2026-06-13 19:00".to_string(),
            });
    let current_defects = snapshot
        .defects
        .iter()
        .filter(|defect| defect.plate_no == current_plate.plate_no)
        .cloned()
        .collect::<Vec<_>>();
    let current_height = height_profile(-0.18, 36);
    let defect_types = snapshot
        .defect_types
        .iter()
        .map(|item| {
            format!(
                "{{\"id\":\"{}\",\"label\":\"{}\",\"color\":\"{}\",\"shape\":\"{}\"}}",
                json_escape(&item.id),
                json_escape(&item.label),
                json_escape(&item.color),
                json_escape(&item.shape)
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let records = snapshot
        .records
        .iter()
        .map(|record| {
            format!(
                "{{\"id\":\"{}\",\"time\":\"{}\",\"plateNo\":\"{}\",\"status\":\"{}\",\"defectCount\":{}}}",
                json_escape(&record.id),
                json_escape(&record.time),
                json_escape(&record.plate_no),
                json_escape(&record.status),
                record.defect_count
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let inspections = snapshot
        .records
        .iter()
        .filter_map(|record| {
            let plate = snapshot
                .plates
                .iter()
                .find(|plate| plate.plate_no == record.plate_no)?;
            let defects = snapshot
                .defects
                .iter()
                .filter(|defect| defect.plate_no == record.plate_no)
                .cloned()
                .collect::<Vec<_>>();
            let profile = height_profile(
                defects.first().map(|item| item.depth_mm).unwrap_or(-0.02),
                28,
            );
            Some(format!(
                "{{\"plate\":{},\"defects\":{},\"heightProfile\":{}}}",
                database_plate_json(plate),
                database_defects_json(&defects),
                height_profile_json(&profile)
            ))
        })
        .collect::<Vec<_>>()
        .join(",");

    format!(
        "{{\"currentPlate\":{},\"defectTypes\":[{}],\"defects\":{},\"records\":[{}],\"status\":{},\"summary\":{},\"heightProfile\":{},\"inspections\":[{}],\"source\":\"sqlite-seaorm\"}}",
        database_plate_json(&current_plate),
        defect_types,
        database_defects_json(&current_defects),
        records,
        "{\"receiverPorts\":[{\"index\":1,\"ok\":true},{\"index\":2,\"ok\":true},{\"index\":3,\"ok\":false},{\"index\":4,\"ok\":true},{\"index\":5,\"ok\":true},{\"index\":6,\"ok\":true},{\"index\":7,\"ok\":true},{\"index\":8,\"ok\":true}],\"cameraPorts\":[{\"index\":1,\"ok\":true},{\"index\":2,\"ok\":true},{\"index\":3,\"ok\":false},{\"index\":4,\"ok\":true},{\"index\":5,\"ok\":true},{\"index\":6,\"ok\":true},{\"index\":7,\"ok\":true},{\"index\":8,\"ok\":true}],\"encoder\":\"sync\",\"plc\":\"normal\",\"l2\":\"normal\",\"alarmCount\":1}",
        "{\"total\":12,\"bySeverity\":{\"severe\":4,\"review\":3,\"minor\":5},\"bySurface\":{\"top\":5,\"bottom\":7}}",
        height_profile_json(&current_height),
        inspections
    )
}

fn http_response_with_headers(
    status: &str,
    content_type: &str,
    body: &str,
    extra_headers: &[(&str, &str)],
) -> Vec<u8> {
    let extra_header_lines = extra_headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Accept, Authorization\r\n{extra_header_lines}Connection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    )
    .into_bytes()
}

fn http_bytes_response_with_headers(
    status: &str,
    content_type: &str,
    body: &[u8],
    extra_headers: &[(&str, &str)],
) -> Vec<u8> {
    let extra_header_lines = extra_headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Accept, Authorization\r\n{extra_header_lines}Connection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

fn http_response(status: &str, content_type: &str, body: &str) -> Vec<u8> {
    http_response_with_headers(status, content_type, body, &[])
}

fn capture_health_json() -> String {
    format!(
        "{{\"service\":\"steel-capture-simulated\",\"time\":\"{}\",\"sdkReady\":false,\"sdkCode\":0,\"sdkVersion\":\"sim-6.7.0\",\"connected\":false,\"ip\":\"{}\",\"driverId\":\"simulated\",\"driverName\":\"Simulated 3D Camera Driver\",\"cameraCount\":{},\"mode\":\"simulation\"}}",
        current_time_string(),
        CAPTURE_CAMERA_IP,
        CAPTURE_CAMERA_IPS.len()
    )
}

fn capture_cameras_json() -> String {
    let cameras = CAPTURE_CAMERA_IPS
        .iter()
        .enumerate()
        .map(|(index, ip)| {
            format!(
                "{{\"ip\":\"{}\",\"model\":\"{}\",\"sn\":\"{}\",\"driverId\":\"simulated\",\"source\":\"service-fallback\",\"configured\":true}}",
                ip,
                CAPTURE_CAMERA_MODELS[index],
                CAPTURE_CAMERA_SERIALS[index]
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("{{\"cameras\":[{}]}}", cameras)
}

fn capture_status_json(ip: &str, index: usize) -> String {
    format!(
        "{{\"connected\":true,\"deviceId\":{},\"ip\":\"{}\",\"driverId\":\"simulated\",\"model\":\"{}\",\"sn\":\"{}\",\"source\":\"service-fallback\",\"acquisitionState\":\"connected\",\"sdkStatus\":\"simulation\",\"fps\":{:.1},\"bufferPercent\":{},\"lastFrameTime\":\"2026-06-14T15:58:{:02}Z\",\"task\":1,\"status\":0,\"linkHealth\":100,\"temperatureJ28\":{:.1},\"temperatureJ29\":{:.1},\"temperatureJ30\":{:.1},\"lostPulseCounter\":{},\"bufferOverflowCounter\":0}}",
        index + 1,
        ip,
        CAPTURE_CAMERA_MODELS[index],
        CAPTURE_CAMERA_SERIALS[index],
        21.5 + index as f64 * 0.7,
        18 + index * 3,
        12 + index,
        38.2 + index as f64 * 0.4,
        39.1 + index as f64 * 0.3,
        37.6 + index as f64 * 0.5,
        if index == 2 { 3 } else { 0 }
    )
}

fn capture_statuses_json() -> String {
    let statuses = CAPTURE_CAMERA_IPS
        .iter()
        .enumerate()
        .map(|(index, ip)| capture_status_json(ip, index))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{\"statuses\":[{}]}}", statuses)
}

fn split_path_and_query(raw_path: &str) -> (&str, &str) {
    if let Some(index) = raw_path.find('?') {
        (&raw_path[..index], &raw_path[index + 1..])
    } else {
        (raw_path, "")
    }
}

fn fallback_capture_response(path: &str) -> Vec<u8> {
    match path {
        "/health" | "/api/capture/health" => {
            http_response("200 OK", "application/json; charset=utf-8", &capture_health_json())
        }
        "/api/cameras" => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &capture_cameras_json(),
        ),
        "/api/camera/status" => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &capture_status_json(CAPTURE_CAMERA_IP, 0),
        ),
        "/api/camera/statuses" => {
            http_response("200 OK", "application/json; charset=utf-8", &capture_statuses_json())
        }
        "/api/camera/connect" => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            "{\"code\":0,\"connected\":true,\"output\":\"SIMULATION ONLY: camera connected by service fallback\"}",
        ),
        "/api/camera/disconnect" => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            "{\"code\":0,\"connected\":false,\"output\":\"SIMULATION ONLY: camera disconnected by service fallback\"}",
        ),
        "/api/param" => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            "{\"code\":0,\"output\":\"SIMULATION ONLY: parameter accepted by service fallback\"}",
        ),
        "/api/capture/depth-map" => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            "{\"code\":0,\"width\":2048,\"lines\":1280,\"output\":\"SIMULATION ONLY: depth map captured by service fallback\"}",
        ),
        _ => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"error\":\"not_found\"}",
        ),
    }
}

fn request_header(request: &str, name: &str) -> Option<String> {
    request
        .lines()
        .skip(1)
        .take_while(|line| !line.trim().is_empty())
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            if key.trim().eq_ignore_ascii_case(name) {
                Some(value.trim().to_string())
            } else {
                None
            }
        })
}

fn content_length_from_headers(request: &str) -> usize {
    request_header(request, "Content-Length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0)
}

fn header_end_index(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

fn read_http_request(stream: &mut TcpStream) -> Option<String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        let Some(header_end) = header_end_index(&bytes) else {
            if bytes.len() > 1024 * 1024 {
                return None;
            }
            continue;
        };
        let header_text = String::from_utf8_lossy(&bytes[..header_end]);
        let total_length = header_end + content_length_from_headers(&header_text);
        if bytes.len() >= total_length {
            bytes.truncate(total_length);
            break;
        }
        if total_length > 1024 * 1024 {
            return None;
        }
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn bearer_token(request: &str) -> Option<String> {
    request_header(request, "Authorization")
        .and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .map(str::trim)
                .map(ToOwned::to_owned)
        })
        .filter(|value| !value.is_empty())
}

fn session_from_request(state: &ServiceState, request: &str) -> Option<AdminSession> {
    let token = bearer_token(request)?;
    let now = current_time_millis();
    let mut sessions = state.sessions.lock().ok()?;
    if let Some(session) = sessions.get(&token) {
        if session.expires_at > now {
            return Some(session.clone());
        }
    }
    sessions.remove(&token);
    None
}

fn invalidate_user_sessions_except(state: &ServiceState, user_id: &str, keep_token: &str) {
    let now = current_time_millis();
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.retain(|token, session| {
            session.expires_at > now && (session.user_id != user_id || token == keep_token)
        });
    }
}

fn invalidate_user_sessions(state: &ServiceState, user_id: &str) {
    let now = current_time_millis();
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.retain(|_, session| session.expires_at > now && session.user_id != user_id);
    }
}

fn invalidate_role_sessions(state: &ServiceState, role: &str) {
    let now = current_time_millis();
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.retain(|_, session| session.expires_at > now && session.role != role);
    }
}

fn permission_for_route(method: &str, path: &str) -> Option<&'static str> {
    match (method, path) {
        ("GET", "/api/database")
        | ("GET", "/api/admin/database/backup")
        | ("GET", "/api/admin/database/integrity")
        | ("GET", "/api/admin/diagnostics") => Some("admin.overview"),
        ("POST", "/api/admin/database/maintenance") => Some("admin.services"),
        ("GET", "/api/config")
        | ("GET", "/api/config/capture")
        | ("POST", "/api/config/capture")
        | ("POST", "/api/config/connection")
        | ("GET", "/api/admin/inspection-settings")
        | ("POST", "/api/admin/inspection-settings")
        | ("GET", "/api/admin/alarm-rules")
        | ("POST", "/api/admin/alarm-rules")
        | ("GET", "/api/admin/external-integrations")
        | ("POST", "/api/admin/external-integrations") => Some("admin.config"),
        ("GET", "/api/admin/config/revisions")
        | ("GET", "/api/admin/config/revisions/detail")
        | ("POST", "/api/admin/config/revisions/restore") => Some("admin.config"),
        ("GET", "/api/admin/services")
        | ("POST", "/api/admin/services/capture/start")
        | ("POST", "/api/admin/services/capture/stop")
        | ("POST", "/api/admin/services/capture/restart") => Some("admin.services"),
        ("GET", "/api/admin/overview") => Some("admin.overview"),
        ("GET", "/api/admin/users")
        | ("POST", "/api/admin/users")
        | ("DELETE", "/api/admin/users") => Some("admin.users"),
        ("GET", "/api/admin/roles")
        | ("GET", "/api/admin/permissions")
        | ("POST", "/api/admin/roles")
        | ("DELETE", "/api/admin/roles") => Some("admin.roles"),
        ("GET", "/api/admin/cameras")
        | ("POST", "/api/admin/cameras")
        | ("DELETE", "/api/admin/cameras") => Some("admin.cameras"),
        ("GET", "/api/admin/defect-types") => Some("admin.records"),
        ("POST", "/api/admin/defect-types") | ("DELETE", "/api/admin/defect-types") => {
            Some("admin.config")
        }
        ("GET", "/api/admin/audit")
        | ("GET", "/api/admin/audit/export")
        | ("POST", "/api/admin/audit/retention") => Some("admin.audit"),
        ("GET", "/api/admin/security/policy") | ("POST", "/api/admin/security/policy") => {
            Some("admin.audit")
        }
        ("GET", "/api/admin/records")
        | ("GET", "/api/admin/records/detail")
        | ("GET", "/api/admin/records/export")
        | ("POST", "/api/admin/records/retention")
        | ("DELETE", "/api/admin/records") => Some("admin.records"),
        ("POST", "/api/admin/auth/password")
        | ("GET", "/api/admin/auth/sessions")
        | ("DELETE", "/api/admin/auth/sessions") => Some("admin.self"),
        _ => None,
    }
}

const ADMIN_PERMISSION_CATALOG: [(&str, &str, &str, &str); 8] = [
    (
        "admin.overview",
        "总览",
        "基础",
        "查看后台总览、数据库概览和接口清单",
    ),
    (
        "admin.services",
        "服务管理",
        "运维",
        "查看服务状态、运行诊断并重启采集服务",
    ),
    (
        "admin.users",
        "账号管理",
        "安全",
        "创建、编辑和删除后台账号",
    ),
    ("admin.roles", "角色权限", "安全", "维护角色和权限授权目录"),
    (
        "admin.config",
        "系统配置",
        "配置",
        "保存连接、采集配置并恢复配置版本",
    ),
    (
        "admin.cameras",
        "相机配置",
        "配置",
        "维护采集相机、驱动和触发参数",
    ),
    ("admin.records", "检测记录", "数据", "查询和导出检测记录"),
    ("admin.audit", "审计日志", "审计", "查询和导出后台审计日志"),
];

fn is_known_admin_permission(permission: &str) -> bool {
    ADMIN_PERMISSION_CATALOG
        .iter()
        .any(|(id, _, _, _)| *id == permission)
}

fn auth_failure(status: &str, code: u16, error: &str) -> Vec<u8> {
    http_response(
        status,
        "application/json; charset=utf-8",
        &json!({ "code": code, "error": error }).to_string(),
    )
}

fn login_failure_key(user_id: &str) -> String {
    let key = user_id.trim().to_ascii_lowercase();
    if key.is_empty() {
        "<empty>".to_string()
    } else {
        key
    }
}

fn prune_login_failures(
    failures: &mut HashMap<String, LoginFailureState>,
    now: u128,
    policy: &SecurityPolicy,
) {
    failures.retain(|_, failure| {
        failure.locked_until > now
            || now.saturating_sub(failure.first_failed_at) <= policy.login_failure_window_ms()
    });
}

fn login_locked_until(
    state: &ServiceState,
    user_id: &str,
    now: u128,
    policy: &SecurityPolicy,
) -> Option<u128> {
    let key = login_failure_key(user_id);
    let mut failures = state.login_failures.lock().ok()?;
    prune_login_failures(&mut failures, now, policy);
    failures
        .get(&key)
        .and_then(|failure| (failure.locked_until > now).then_some(failure.locked_until))
}

fn clear_login_failures(state: &ServiceState, user_id: &str) {
    if let Ok(mut failures) = state.login_failures.lock() {
        failures.remove(&login_failure_key(user_id));
    }
}

fn record_login_failure(
    state: &ServiceState,
    user_id: &str,
    now: u128,
    policy: &SecurityPolicy,
) -> LoginFailureState {
    let key = login_failure_key(user_id);
    let mut failures = match state.login_failures.lock() {
        Ok(failures) => failures,
        Err(_) => {
            return LoginFailureState {
                count: 1,
                first_failed_at: now,
                locked_until: 0,
            };
        }
    };
    prune_login_failures(&mut failures, now, policy);
    let failure = failures.entry(key).or_insert(LoginFailureState {
        count: 0,
        first_failed_at: now,
        locked_until: 0,
    });
    if now.saturating_sub(failure.first_failed_at) > policy.login_failure_window_ms() {
        failure.count = 0;
        failure.first_failed_at = now;
        failure.locked_until = 0;
    }
    if failure.locked_until <= now {
        failure.count = failure.count.saturating_add(1);
        if failure.count >= policy.login_max_failures {
            failure.locked_until = now + policy.login_lockout_ms();
        }
    }
    failure.clone()
}

fn login_lockout_response(locked_until: u128, now: u128) -> Vec<u8> {
    http_response(
        "423 Locked",
        "application/json; charset=utf-8",
        &json!({
            "code": 423,
            "error": "login_locked",
            "message": "登录失败次数过多，请稍后再试",
            "lockedUntil": locked_until.to_string(),
            "retryAfterMs": locked_until.saturating_sub(now)
        })
        .to_string(),
    )
}

fn login_failure_response(
    state: &ServiceState,
    user_id: &str,
    now: u128,
    policy: &SecurityPolicy,
) -> Vec<u8> {
    let failure = record_login_failure(state, user_id, now, policy);
    if failure.locked_until > now {
        let _ = state.runtime.block_on(db::append_audit_log(
            &state.database.connection,
            "anonymous",
            "auth.login.locked",
            user_id,
            "后台登录被临时锁定：失败次数过多",
            "warning",
        ));
        login_lockout_response(failure.locked_until, now)
    } else {
        auth_failure("401 Unauthorized", 401, "invalid_credentials")
    }
}

fn validate_admin_password(password: Option<&str>) -> Result<(), PasswordPolicyError> {
    let Some(password) = password else {
        return Err(PasswordPolicyError::Missing);
    };
    if password.is_empty() {
        return Err(PasswordPolicyError::Missing);
    }
    if password.len() < ADMIN_PASSWORD_MIN_LEN || password.len() > ADMIN_PASSWORD_MAX_LEN {
        return Err(PasswordPolicyError::Length);
    }
    let has_letter = password.chars().any(|ch| ch.is_ascii_alphabetic());
    let has_number = password.chars().any(|ch| ch.is_ascii_digit());
    if !has_letter || !has_number {
        return Err(PasswordPolicyError::Complexity);
    }
    Ok(())
}

fn password_policy_response(error: PasswordPolicyError) -> Vec<u8> {
    let error_code = match error {
        PasswordPolicyError::Missing => "password required",
        PasswordPolicyError::Length => "invalid password length",
        PasswordPolicyError::Complexity => "password complexity required",
    };
    http_response(
        "400 Bad Request",
        "application/json; charset=utf-8",
        &json!({ "code": 400, "error": error_code }).to_string(),
    )
}

fn origin_host(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.eq_ignore_ascii_case("null") || trimmed.is_empty() {
        return None;
    }
    let (_, rest) = trimmed.split_once("://")?;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .split('@')
        .last()
        .unwrap_or_default();
    if authority.starts_with('[') {
        let end = authority.find(']')?;
        return Some(authority[1..end].to_ascii_lowercase());
    }
    authority
        .split(':')
        .next()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .map(|host| host.to_ascii_lowercase())
}

fn is_trusted_local_origin(value: &str) -> bool {
    let Some(host) = origin_host(value) else {
        return false;
    };
    matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") || host.ends_with(".localhost")
}

fn request_state_changing_method(request: &str, method: &str) -> bool {
    if method.eq_ignore_ascii_case("OPTIONS") {
        return request_header(request, "Access-Control-Request-Method")
            .as_deref()
            .is_some_and(|requested| request_state_changing_method("", requested));
    }
    ["POST", "PUT", "PATCH", "DELETE"]
        .iter()
        .any(|item| method.eq_ignore_ascii_case(item))
}

fn request_origin_allowed(request: &str, method: &str) -> bool {
    if !request_state_changing_method(request, method) {
        return true;
    }
    if let Some(origin) = request_header(request, "Origin") {
        return is_trusted_local_origin(&origin);
    }
    if let Some(referer) = request_header(request, "Referer") {
        return is_trusted_local_origin(&referer);
    }
    true
}

fn append_origin_audit(state: &ServiceState, request: &str, method: &str, path: &str) {
    let actor = session_from_request(state, request)
        .map(|session| session.user_id)
        .unwrap_or_else(|| "anonymous".to_string());
    let origin = request_header(request, "Origin")
        .or_else(|| request_header(request, "Referer"))
        .unwrap_or_else(|| "unknown".to_string());
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        &actor,
        "auth.origin.denied",
        &format!("{method} {path}"),
        &format!("拒绝非本机来源请求：{origin}"),
        "warning",
    ));
}

fn append_authorization_audit(
    state: &ServiceState,
    actor: &str,
    action: &str,
    method: &str,
    path: &str,
    required_permission: &str,
) {
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        action,
        &format!("{method} {path}"),
        &format!("拒绝访问：需要权限 {required_permission}"),
        "warning",
    ));
}

fn authorize_request(
    state: &ServiceState,
    request: &str,
    method: &str,
    path: &str,
) -> Result<Option<AdminSession>, Vec<u8>> {
    let Some(required_permission) = permission_for_route(method, path) else {
        return Ok(session_from_request(state, request));
    };
    let Some(session) = session_from_request(state, request) else {
        append_authorization_audit(
            state,
            "anonymous",
            "auth.access.denied",
            method,
            path,
            required_permission,
        );
        return Err(auth_failure("401 Unauthorized", 401, "auth_required"));
    };
    if required_permission == "admin.self"
        || session
            .permissions
            .iter()
            .any(|permission| permission == required_permission)
    {
        Ok(Some(session))
    } else {
        append_authorization_audit(
            state,
            &session.user_id,
            "auth.permission.denied",
            method,
            path,
            required_permission,
        );
        Err(auth_failure("403 Forbidden", 403, "permission_denied"))
    }
}

fn read_auth_me_response(state: &ServiceState, request: &str) -> Vec<u8> {
    if let Some(session) = session_from_request(state, request) {
        http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &auth_session_json(&session),
        )
    } else {
        http_response(
            "200 OK",
            "application/json; charset=utf-8",
            "{\"authenticated\":false}",
        )
    }
}

fn write_auth_login_response(state: &ServiceState, request: &str, body: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(payload) => payload,
        Err(_) => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                "{\"code\":400,\"error\":\"invalid login json\"}",
            );
        }
    };
    let Some(user_id) = json_text_field(&payload, "userId", "user_id")
        .or_else(|| json_text_field(&payload, "id", "id"))
    else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"user id required\"}",
        );
    };
    let Some(password) = payload
        .get("password")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"password required\"}",
        );
    };
    let now = current_time_millis();
    let security_policy = load_security_policy(state);
    if let Some(locked_until) = login_locked_until(state, &user_id, now, &security_policy) {
        let _ = state.runtime.block_on(db::append_audit_log(
            &state.database.connection,
            "anonymous",
            "auth.login.locked",
            &user_id,
            "后台登录被临时锁定：失败次数过多",
            "warning",
        ));
        return login_lockout_response(locked_until, now);
    }

    let user = match state
        .runtime
        .block_on(db::find_admin_user(&state.database.connection, &user_id))
    {
        Ok(Some(user)) => user,
        Ok(None) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                "anonymous",
                "auth.login.failed",
                &user_id,
                "后台登录失败：账号不存在",
                "warning",
            ));
            return login_failure_response(state, &user_id, now, &security_policy);
        }
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };

    if user.status != "active" || !db::verify_admin_password(&user, &password) {
        let _ = state.runtime.block_on(db::append_audit_log(
            &state.database.connection,
            &user.id,
            "auth.login.failed",
            &user.id,
            "后台登录失败：账号停用或密码错误",
            "warning",
        ));
        return login_failure_response(state, &user.id, now, &security_policy);
    }
    if db::admin_password_hash_needs_upgrade(&user.password_hash) {
        let upgraded_hash = db::hash_admin_password(&user.id, &password);
        if state
            .runtime
            .block_on(db::update_admin_user_password(
                &state.database.connection,
                &user.id,
                &upgraded_hash,
            ))
            .is_ok()
        {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                &user.id,
                "auth.password.upgrade",
                &user.id,
                "后台账号密码哈希已升级为 Argon2id",
                "info",
            ));
        }
    }

    let role = match state
        .runtime
        .block_on(db::find_admin_role(&state.database.connection, &user.role))
    {
        Ok(Some(role)) if role.status == "active" => role,
        _ => {
            return auth_failure("403 Forbidden", 403, "role_disabled");
        }
    };

    clear_login_failures(state, &user.id);
    let token = create_session_token(&user.id);
    let session_id = create_session_id(&user.id, &token, now);
    let session = AdminSession {
        session_id,
        token: token.clone(),
        user_id: user.id.clone(),
        display_name: user.display_name.clone(),
        role: user.role.clone(),
        permissions: role_permissions_vec(&role.permissions),
        user_agent: request_header(request, "User-Agent").unwrap_or_else(|| "unknown".to_string()),
        created_at: now,
        expires_at: now + security_policy.session_ttl_ms(),
    };
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.insert(token, session.clone());
    }

    let login_at = now.to_string();
    let _ = state.runtime.block_on(db::update_admin_user_last_login(
        &state.database.connection,
        &user.id,
        &login_at,
    ));
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        &user.id,
        "auth.login",
        &user.id,
        "后台账号登录成功",
        "info",
    ));

    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &auth_session_json(&session),
    )
}

fn write_auth_logout_response(state: &ServiceState, request: &str) -> Vec<u8> {
    let token = bearer_token(request);
    let removed = token.and_then(|value| state.sessions.lock().ok()?.remove(&value));
    if let Some(session) = removed {
        let _ = state.runtime.block_on(db::append_audit_log(
            &state.database.connection,
            &session.user_id,
            "auth.logout",
            &session.user_id,
            "后台账号退出登录",
            "info",
        ));
    }
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        "{\"code\":0,\"message\":\"logged out\"}",
    )
}

fn auth_sessions_json(state: &ServiceState, user_id: &str, current_token: &str) -> String {
    let now = current_time_millis();
    let sessions = state
        .sessions
        .lock()
        .map(|mut sessions| {
            sessions.retain(|_, session| session.expires_at > now);
            sessions
                .values()
                .filter(|session| session.user_id == user_id)
                .map(|session| {
                    json!({
                        "id": &session.session_id,
                        "userId": &session.user_id,
                        "displayName": &session.display_name,
                        "role": &session.role,
                        "current": session.token == current_token,
                        "userAgent": &session.user_agent,
                        "createdAt": session.created_at.to_string(),
                        "expiresAt": session.expires_at.to_string()
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({ "sessions": sessions }).to_string()
}

fn read_auth_sessions_response(state: &ServiceState, request: &str) -> Vec<u8> {
    let Some(session) = session_from_request(state, request) else {
        return auth_failure("401 Unauthorized", 401, "auth_required");
    };
    let Some(token) = bearer_token(request) else {
        return auth_failure("401 Unauthorized", 401, "auth_required");
    };
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &auth_sessions_json(state, &session.user_id, &token),
    )
}

fn delete_auth_session_response(state: &ServiceState, request: &str, query: &str) -> Vec<u8> {
    let Some(current_session) = session_from_request(state, request) else {
        return auth_failure("401 Unauthorized", 401, "auth_required");
    };
    let Some(session_id) = query_value(query, "id").filter(|value| !value.trim().is_empty()) else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"session id required\"}",
        );
    };
    if session_id == current_session.session_id {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"cannot revoke current session\"}",
        );
    }

    let removed = state.sessions.lock().ok().and_then(|mut sessions| {
        let token = sessions.iter().find_map(|(token, session)| {
            if session.user_id == current_session.user_id && session.session_id == session_id {
                Some(token.clone())
            } else {
                None
            }
        })?;
        sessions.remove(&token)
    });

    let Some(removed) = removed else {
        return http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"code\":404,\"error\":\"session not found\"}",
        );
    };

    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        &current_session.user_id,
        "auth.session.revoke",
        &removed.session_id,
        &format!("撤销后台登录会话 {}", removed.user_agent),
        "warning",
    ));
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({ "code": 0, "revoked": true, "id": session_id }).to_string(),
    )
}

fn write_auth_password_response(state: &ServiceState, request: &str, body: &str) -> Vec<u8> {
    let Some(session) = session_from_request(state, request) else {
        return auth_failure("401 Unauthorized", 401, "auth_required");
    };
    let Some(token) = bearer_token(request) else {
        return auth_failure("401 Unauthorized", 401, "auth_required");
    };
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(payload) => payload,
        Err(_) => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                "{\"code\":400,\"error\":\"invalid password json\"}",
            );
        }
    };
    let current_password = payload
        .get("currentPassword")
        .or_else(|| payload.get("current_password"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let new_password = payload
        .get("newPassword")
        .or_else(|| payload.get("new_password"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let confirm_password = payload
        .get("confirmPassword")
        .or_else(|| payload.get("confirm_password"))
        .and_then(Value::as_str)
        .unwrap_or(new_password);

    if let Err(error) = validate_admin_password(Some(new_password)) {
        return password_policy_response(error);
    }
    if new_password != confirm_password {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"password confirmation mismatch\"}",
        );
    }
    if current_password == new_password {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"new password must be different\"}",
        );
    }

    let user = match state.runtime.block_on(db::find_admin_user(
        &state.database.connection,
        &session.user_id,
    )) {
        Ok(Some(user)) if user.status == "active" => user,
        Ok(_) => return auth_failure("401 Unauthorized", 401, "invalid_credentials"),
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };

    if !db::verify_admin_password(&user, current_password) {
        let _ = state.runtime.block_on(db::append_audit_log(
            &state.database.connection,
            &session.user_id,
            "auth.password.failed",
            &session.user_id,
            "当前用户修改密码失败：旧密码错误",
            "warning",
        ));
        return auth_failure("401 Unauthorized", 401, "invalid_credentials");
    }

    let password_hash = db::hash_admin_password(&session.user_id, new_password);
    if let Err(error) = state.runtime.block_on(db::update_admin_user_password(
        &state.database.connection,
        &session.user_id,
        &password_hash,
    )) {
        return http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        );
    }
    invalidate_user_sessions_except(state, &session.user_id, &token);
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        &session.user_id,
        "auth.password.change",
        &session.user_id,
        "当前用户修改登录密码",
        "warning",
    ));
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        "{\"code\":0,\"message\":\"password changed\"}",
    )
}

fn admin_services_json(state: &ServiceState) -> String {
    let service_port = env::var("INSPECTION_SERVICE_PORT").unwrap_or_else(|_| "4873".to_string());
    let capture_status = serde_json::from_str::<Value>(&state.capture.status_json())
        .unwrap_or_else(|_| json!({ "running": false, "fallback": "simulated-six-camera" }));
    let now = current_time_millis();
    let active_sessions = state
        .sessions
        .lock()
        .map(|sessions| {
            sessions
                .values()
                .filter(|session| session.expires_at > now)
                .count()
        })
        .unwrap_or(0);
    let database_bytes = state
        .database
        .file_path
        .as_ref()
        .and_then(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let config_dir = state
        .database
        .file_path
        .as_ref()
        .and_then(|path| path.parent())
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let capture_running = capture_status
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let capture_origin = capture_status
        .get("origin")
        .and_then(Value::as_str)
        .unwrap_or("http://127.0.0.1:4317")
        .to_string();
    let config_dir_status = if state
        .database
        .file_path
        .as_ref()
        .and_then(|path| path.parent())
        .map(|path| path.is_dir())
        .unwrap_or_else(|| state.database.engine != "sqlite")
    {
        "normal"
    } else {
        "warning"
    };
    json!({
        "updatedAt": current_time_string(),
        "api": {
            "name": "steel-inspection-service",
            "role": "api-config-capture-orchestrator",
            "language": "rust",
            "running": true,
            "port": service_port,
            "uptimeMs": now.saturating_sub(state.started_at),
            "activeSessions": active_sessions,
            "database": {
                "engine": state.database.engine,
                "path": state.database.display_path(),
                "bytes": database_bytes,
                "configDir": config_dir
            }
        },
        "capture": capture_status,
        "diagnostics": [
            {
                "id": "api",
                "label": "API 服务",
                "status": "normal",
                "detail": format!("运行 {}ms，在线会话 {} 个", now.saturating_sub(state.started_at), active_sessions)
            },
            {
                "id": "database",
                "label": "SQLite 数据库",
                "status": if state.database.engine != "sqlite" || database_bytes > 0 { "normal" } else { "warning" },
                "detail": format!("{} / {}", state.database.engine, state.database.display_path())
            },
            {
                "id": "config",
                "label": "配置目录",
                "status": config_dir_status,
                "detail": config_dir
            },
            {
                "id": "capture",
                "label": "采集服务连通性",
                "status": if capture_running { "normal" } else { "warning" },
                "detail": capture_origin
            }
        ]
    })
    .to_string()
}

fn read_admin_services_response(state: &ServiceState) -> Vec<u8> {
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &admin_services_json(state),
    )
}

#[derive(Default)]
struct AdminDiagnosticsSummary {
    normal: u64,
    warning: u64,
    error: u64,
}

fn push_admin_diagnostic_check(
    checks: &mut Vec<Value>,
    summary: &mut AdminDiagnosticsSummary,
    id: &str,
    group: &str,
    label: &str,
    status: &str,
    detail: String,
    recommendation: &str,
) {
    match status {
        "error" => summary.error += 1,
        "warning" => summary.warning += 1,
        _ => summary.normal += 1,
    }
    checks.push(json!({
        "id": id,
        "group": group,
        "label": label,
        "status": status,
        "detail": detail,
        "recommendation": recommendation
    }));
}

fn admin_diagnostics_json(state: &ServiceState) -> String {
    let mut checks = Vec::new();
    let mut summary = AdminDiagnosticsSummary::default();
    let now = current_time_millis();
    let service_port = env::var("INSPECTION_SERVICE_PORT").unwrap_or_else(|_| "4873".to_string());
    let active_sessions = state
        .sessions
        .lock()
        .map(|sessions| {
            sessions
                .values()
                .filter(|session| session.expires_at > now)
                .count()
        })
        .unwrap_or(0);

    push_admin_diagnostic_check(
        &mut checks,
        &mut summary,
        "api",
        "service",
        "API 服务",
        "normal",
        format!(
            "端口 {}，运行 {}，在线会话 {} 个",
            service_port,
            format_duration_ms(now.saturating_sub(state.started_at)),
            active_sessions
        ),
        "保持本机服务常驻运行",
    );

    match fs::metadata(&state.database.path) {
        Ok(metadata) => push_admin_diagnostic_check(
            &mut checks,
            &mut summary,
            "database-file",
            "database",
            "SQLite 文件",
            if metadata.len() > 0 {
                "normal"
            } else {
                "warning"
            },
            format!(
                "{} bytes / {}",
                metadata.len(),
                state.database.path.display()
            ),
            if metadata.len() > 0 {
                "定期备份数据库文件"
            } else {
                "确认数据库初始化和写入流程"
            },
        ),
        Err(error) => push_admin_diagnostic_check(
            &mut checks,
            &mut summary,
            "database-file",
            "database",
            "SQLite 文件",
            "error",
            format!("无法读取 {}：{}", state.database.path.display(), error),
            "检查配置目录权限并重启服务",
        ),
    }

    match state
        .runtime
        .block_on(db::database_maintenance_stats(&state.database.connection))
    {
        Ok(stats) => push_admin_diagnostic_check(
            &mut checks,
            &mut summary,
            "database-pages",
            "database",
            "数据库页状态",
            if stats.freelist_count > 256 {
                "warning"
            } else {
                "normal"
            },
            format!(
                "page={} size={} freelist={}",
                stats.page_count, stats.page_size, stats.freelist_count
            ),
            if stats.freelist_count > 256 {
                "建议执行数据库压缩整理"
            } else {
                "无需立即维护"
            },
        ),
        Err(error) => push_admin_diagnostic_check(
            &mut checks,
            &mut summary,
            "database-pages",
            "database",
            "数据库页状态",
            "error",
            format!("读取 SQLite 页信息失败：{}", error),
            "检查数据库连接和 SeaORM 初始化",
        ),
    }

    match state
        .runtime
        .block_on(db::database_integrity_messages(&state.database.connection))
    {
        Ok(messages) => {
            let status = if database_integrity_status(&messages) == "ok" {
                "normal"
            } else {
                "error"
            };
            push_admin_diagnostic_check(
                &mut checks,
                &mut summary,
                "database-integrity",
                "database",
                "数据库完整性",
                status,
                messages.join("；"),
                if status == "normal" {
                    "完整性检查通过"
                } else {
                    "立即备份数据库并检查异常记录"
                },
            );
        }
        Err(error) => push_admin_diagnostic_check(
            &mut checks,
            &mut summary,
            "database-integrity",
            "database",
            "数据库完整性",
            "error",
            format!("完整性检查失败：{}", error),
            "检查数据库文件是否可读写",
        ),
    }

    let config_dir = state.database.path.parent();
    push_admin_diagnostic_check(
        &mut checks,
        &mut summary,
        "config-dir",
        "config",
        "配置目录",
        if config_dir.map(Path::is_dir).unwrap_or(false) {
            "normal"
        } else {
            "warning"
        },
        config_dir
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "未解析到配置目录".to_string()),
        "确认配置目录随服务部署并可写入",
    );

    let overview = state
        .runtime
        .block_on(db::load_admin_overview(&state.database.connection));
    match &overview {
        Ok(overview) => {
            let required_configs = [
                "capture",
                "connection",
                INSPECTION_SETTINGS_CONFIG_KEY,
                ALARM_RULES_CONFIG_KEY,
                EXTERNAL_INTEGRATIONS_CONFIG_KEY,
                SECURITY_POLICY_CONFIG_KEY,
            ];
            let missing_configs = required_configs
                .iter()
                .copied()
                .filter(|key| !overview.configs.iter().any(|config| config.key == *key))
                .collect::<Vec<_>>();
            push_admin_diagnostic_check(
                &mut checks,
                &mut summary,
                "required-configs",
                "config",
                "关键配置",
                if missing_configs.is_empty() {
                    "normal"
                } else {
                    "warning"
                },
                if missing_configs.is_empty() {
                    format!("{} 项关键配置已入库", required_configs.len())
                } else {
                    format!("缺少配置：{}", missing_configs.join("、"))
                },
                "在配置页保存缺失配置或恢复默认配置",
            );

            let recent_errors = overview
                .audit_logs
                .iter()
                .filter(|entry| entry.level == "error")
                .count();
            push_admin_diagnostic_check(
                &mut checks,
                &mut summary,
                "recent-audit-errors",
                "audit",
                "最近审计异常",
                if recent_errors == 0 {
                    "normal"
                } else {
                    "warning"
                },
                format!(
                    "最近 {} 条审计日志中 error={} 条",
                    overview.audit_logs.len(),
                    recent_errors
                ),
                if recent_errors == 0 {
                    "持续关注审计日志"
                } else {
                    "打开审计页筛选 error 级别排查"
                },
            );

            push_admin_diagnostic_check(
                &mut checks,
                &mut summary,
                "records",
                "data",
                "检测数据",
                if overview.metrics.record_count > 0 && overview.metrics.defect_count > 0 {
                    "normal"
                } else {
                    "warning"
                },
                format!(
                    "检测记录 {} 条，缺陷 {} 条，钢板 {} 条",
                    overview.metrics.record_count,
                    overview.metrics.defect_count,
                    overview.metrics.plate_count
                ),
                "确认采集和算法结果已持续写入",
            );
        }
        Err(error) => push_admin_diagnostic_check(
            &mut checks,
            &mut summary,
            "admin-overview",
            "database",
            "后台数据概览",
            "error",
            format!("后台概览加载失败：{}", error),
            "检查数据库表结构和初始化迁移",
        ),
    }

    match state
        .runtime
        .block_on(db::list_camera_configs(&state.database.connection))
    {
        Ok(cameras) => {
            let enabled = cameras.iter().filter(|camera| camera.enabled).count();
            push_admin_diagnostic_check(
                &mut checks,
                &mut summary,
                "camera-configs",
                "capture",
                "相机配置",
                if enabled > 0 { "normal" } else { "warning" },
                format!("已配置 {} 台，启用 {} 台", cameras.len(), enabled),
                "在相机配置页维护真实相机或模拟相机参数",
            );
        }
        Err(error) => push_admin_diagnostic_check(
            &mut checks,
            &mut summary,
            "camera-configs",
            "capture",
            "相机配置",
            "error",
            format!("读取相机配置失败：{}", error),
            "检查 camera_config 表和配置保存流程",
        ),
    }

    let capture_status = serde_json::from_str::<Value>(&state.capture.status_json())
        .unwrap_or_else(|_| json!({ "running": false, "processAvailable": false }));
    let capture_running = capture_status
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let process_available = capture_status
        .get("processAvailable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let capture_origin = capture_status
        .get("origin")
        .and_then(Value::as_str)
        .unwrap_or("http://127.0.0.1:4317");
    push_admin_diagnostic_check(
        &mut checks,
        &mut summary,
        "capture-service",
        "capture",
        "采集服务",
        if capture_running {
            "normal"
        } else if process_available {
            "warning"
        } else {
            "warning"
        },
        if capture_running {
            format!("采集服务正在监听 {}", capture_origin)
        } else if process_available {
            format!("可执行文件存在，但端口未监听：{}", capture_origin)
        } else {
            format!(
                "未找到采集服务可执行文件，当前使用模拟回退：{}",
                capture_origin
            )
        },
        if capture_running {
            "保持采集服务随后台托管"
        } else if process_available {
            "可在服务页启动采集服务"
        } else {
            "构建 C++ 采集服务或配置 STEEL_CAPTURE_SERVICE_EXE"
        },
    );

    let status = if summary.error > 0 {
        "error"
    } else if summary.warning > 0 {
        "warning"
    } else {
        "normal"
    };

    json!({
        "code": 0,
        "checkedAt": current_time_millis().to_string(),
        "status": status,
        "summary": {
            "normal": summary.normal,
            "warning": summary.warning,
            "error": summary.error
        },
        "checks": checks
    })
    .to_string()
}

fn read_admin_diagnostics_response(state: &ServiceState) -> Vec<u8> {
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &admin_diagnostics_json(state),
    )
}

fn capture_service_action_response(
    state: &ServiceState,
    actor: &str,
    action: &str,
    success: bool,
    success_detail: &str,
    failure_detail: &str,
) -> Vec<u8> {
    let audit_action = format!("service.capture.{action}");
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        &audit_action,
        "capture-service",
        if success {
            success_detail
        } else {
            failure_detail
        },
        if success { "info" } else { "warning" },
    ));
    http_response(
        if success {
            "200 OK"
        } else {
            "503 Service Unavailable"
        },
        "application/json; charset=utf-8",
        &json!({
            "code": if success { 0 } else { 503 },
            "action": action,
            "success": success,
            "started": action == "start" && success,
            "stopped": action == "stop" && success,
            "restarted": action == "restart" && success,
            "running": state.capture.is_running(),
            "services": serde_json::from_str::<Value>(&admin_services_json(state)).unwrap_or_else(|_| json!({}))
        })
        .to_string(),
    )
}

fn start_capture_service_response(state: &ServiceState, actor: &str) -> Vec<u8> {
    let started = state.capture.start();
    capture_service_action_response(
        state,
        actor,
        "start",
        started,
        "启动采集服务完成",
        "启动采集服务失败，未找到可执行文件或端口未监听",
    )
}

fn stop_capture_service_response(state: &ServiceState, actor: &str) -> Vec<u8> {
    let stopped = state.capture.stop();
    capture_service_action_response(
        state,
        actor,
        "stop",
        stopped,
        "停止采集服务完成",
        "停止采集服务失败，端口仍在监听或进程不受后台托管",
    )
}

fn restart_capture_service_response(state: &ServiceState, actor: &str) -> Vec<u8> {
    let restarted = state.capture.restart();
    capture_service_action_response(
        state,
        actor,
        "restart",
        restarted,
        "重启采集服务完成",
        "重启采集服务失败，未找到可用进程或可执行文件",
    )
}

fn read_config_response(state: &ServiceState) -> Vec<u8> {
    match state
        .runtime
        .block_on(db::get_config(&state.database.connection, "capture"))
    {
        Ok(Some(config)) => {
            http_response("200 OK", "application/json; charset=utf-8", &config.value)
        }
        Ok(None) => match state.config_json.lock() {
            Ok(config) => http_response("200 OK", "application/json; charset=utf-8", &config),
            Err(_) => http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                "{\"error\":\"config_lock_poisoned\"}",
            ),
        },
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn validation_error_response(error: &str, detail: &str) -> Vec<u8> {
    http_response(
        "400 Bad Request",
        "application/json; charset=utf-8",
        &json!({
            "code": 400,
            "error": error,
            "message": detail
        })
        .to_string(),
    )
}

fn reject_invalid_config(
    state: &ServiceState,
    actor: &str,
    key: &str,
    error: &str,
    detail: &str,
) -> Vec<u8> {
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        "config.validation.failed",
        key,
        detail,
        "warning",
    ));
    validation_error_response(error, detail)
}

fn reject_admin_validation(
    state: &ServiceState,
    actor: &str,
    action: &str,
    target: &str,
    error: &str,
    detail: &str,
) -> Vec<u8> {
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        action,
        target,
        detail,
        "warning",
    ));
    validation_error_response(error, detail)
}

fn reject_admin_role_validation(
    state: &ServiceState,
    actor: &str,
    target: &str,
    error: &str,
    detail: &str,
) -> Vec<u8> {
    reject_admin_validation(
        state,
        actor,
        "admin_role.validation.failed",
        target,
        error,
        detail,
    )
}

fn reject_admin_user_validation(
    state: &ServiceState,
    actor: &str,
    target: &str,
    error: &str,
    detail: &str,
) -> Vec<u8> {
    reject_admin_validation(
        state,
        actor,
        "admin_user.validation.failed",
        target,
        error,
        detail,
    )
}

fn admin_operation_error_response(status: &str, code: u16, error: &str) -> Vec<u8> {
    http_response(
        status,
        "application/json; charset=utf-8",
        &json!({ "code": code, "error": error }).to_string(),
    )
}

fn reject_admin_operation(
    state: &ServiceState,
    actor: &str,
    action: &str,
    target: &str,
    detail: &str,
    status: &str,
    code: u16,
    error: &str,
) -> Vec<u8> {
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        action,
        target,
        detail,
        "warning",
    ));
    admin_operation_error_response(status, code, error)
}

fn object_value<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{path} 必须是 JSON 对象"))
}

fn required_object_field<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    object
        .get(key)
        .ok_or_else(|| format!("{path}.{key} 不能为空"))
        .and_then(|value| object_value(value, &format!("{path}.{key}")))
}

fn field_value<'a>(
    object: &'a serde_json::Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
) -> Option<&'a Value> {
    object.get(camel_key).or_else(|| object.get(snake_key))
}

fn validate_text_field(
    object: &serde_json::Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
    path: &str,
    max_len: usize,
) -> Result<String, String> {
    let value = field_value(object, camel_key, snake_key)
        .ok_or_else(|| format!("{path}.{camel_key} 不能为空"))?
        .as_str()
        .map(str::trim)
        .ok_or_else(|| format!("{path}.{camel_key} 必须是字符串"))?;
    if value.is_empty() {
        return Err(format!("{path}.{camel_key} 不能为空"));
    }
    if value.len() > max_len {
        return Err(format!("{path}.{camel_key} 长度不能超过 {max_len}"));
    }
    Ok(value.to_string())
}

fn validate_optional_text_field(
    object: &serde_json::Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
    path: &str,
    max_len: usize,
) -> Result<(), String> {
    let Some(value) = field_value(object, camel_key, snake_key) else {
        return Ok(());
    };
    let Some(text) = value.as_str().map(str::trim) else {
        return Err(format!("{path}.{camel_key} 必须是字符串"));
    };
    if text.len() > max_len {
        return Err(format!("{path}.{camel_key} 长度不能超过 {max_len}"));
    }
    Ok(())
}

fn validate_i64_field(
    object: &serde_json::Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
    path: &str,
    min: i64,
    max: i64,
) -> Result<i64, String> {
    let value = field_value(object, camel_key, snake_key)
        .ok_or_else(|| format!("{path}.{camel_key} 不能为空"))?
        .as_i64()
        .ok_or_else(|| format!("{path}.{camel_key} 必须是整数"))?;
    if !(min..=max).contains(&value) {
        return Err(format!("{path}.{camel_key} 必须在 {min}..{max} 范围内"));
    }
    Ok(value)
}

fn validate_optional_i64_field(
    object: &serde_json::Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
    path: &str,
    min: i64,
    max: i64,
) -> Result<(), String> {
    let Some(value) = field_value(object, camel_key, snake_key) else {
        return Ok(());
    };
    let Some(number) = value.as_i64() else {
        return Err(format!("{path}.{camel_key} 必须是整数"));
    };
    if !(min..=max).contains(&number) {
        return Err(format!("{path}.{camel_key} 必须在 {min}..{max} 范围内"));
    }
    Ok(())
}

fn validate_f64_field(
    object: &serde_json::Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
    path: &str,
    min: f64,
    max: f64,
) -> Result<f64, String> {
    let value = field_value(object, camel_key, snake_key)
        .ok_or_else(|| format!("{path}.{camel_key} 不能为空"))?
        .as_f64()
        .ok_or_else(|| format!("{path}.{camel_key} 必须是数字"))?;
    if !value.is_finite() || value < min || value > max {
        return Err(format!("{path}.{camel_key} 必须在 {min}..{max} 范围内"));
    }
    Ok(value)
}

fn validate_bool_field(
    object: &serde_json::Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
    path: &str,
) -> Result<bool, String> {
    field_value(object, camel_key, snake_key)
        .ok_or_else(|| format!("{path}.{camel_key} 不能为空"))?
        .as_bool()
        .ok_or_else(|| format!("{path}.{camel_key} 必须是布尔值"))
}

fn validate_optional_bool_field(
    object: &serde_json::Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
    path: &str,
) -> Result<(), String> {
    let Some(value) = field_value(object, camel_key, snake_key) else {
        return Ok(());
    };
    if value.as_bool().is_none() {
        return Err(format!("{path}.{camel_key} must be a boolean"));
    }
    Ok(())
}

fn optional_text_field_or_default(
    object: &serde_json::Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
    path: &str,
    max_len: usize,
    default: String,
) -> Result<String, String> {
    let Some(value) = field_value(object, camel_key, snake_key) else {
        return Ok(default);
    };
    let text = value
        .as_str()
        .map(str::trim)
        .ok_or_else(|| format!("{path}.{camel_key} 必须是字符串"))?;
    if text.is_empty() {
        return Err(format!("{path}.{camel_key} 不能为空"));
    }
    if text.len() > max_len {
        return Err(format!("{path}.{camel_key} 长度不能超过 {max_len}"));
    }
    Ok(text.to_string())
}

fn optional_bool_field_or_default(
    object: &serde_json::Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
    path: &str,
    default: bool,
) -> Result<bool, String> {
    let Some(value) = field_value(object, camel_key, snake_key) else {
        return Ok(default);
    };
    value
        .as_bool()
        .ok_or_else(|| format!("{path}.{camel_key} 必须是布尔值"))
}

fn optional_i64_field_or_default(
    object: &serde_json::Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
    path: &str,
    min: i64,
    max: i64,
    default: i64,
) -> Result<i64, String> {
    let Some(value) = field_value(object, camel_key, snake_key) else {
        return Ok(default);
    };
    let Some(number) = value.as_i64() else {
        return Err(format!("{path}.{camel_key} 必须是整数"));
    };
    if !(min..=max).contains(&number) {
        return Err(format!("{path}.{camel_key} 必须在 {min}..{max} 范围内"));
    }
    Ok(number)
}

fn optional_f64_field_or_default(
    object: &serde_json::Map<String, Value>,
    camel_key: &str,
    snake_key: &str,
    path: &str,
    min: f64,
    max: f64,
    default: f64,
) -> Result<f64, String> {
    let Some(value) = field_value(object, camel_key, snake_key) else {
        return Ok(default);
    };
    let Some(number) = value.as_f64() else {
        return Err(format!("{path}.{camel_key} 必须是数字"));
    };
    if !number.is_finite() || number < min || number > max {
        return Err(format!("{path}.{camel_key} 必须在 {min}..{max} 范围内"));
    }
    Ok(number)
}

fn validate_connection_config_value(value: &Value) -> Result<(), String> {
    let object = object_value(value, "connection")?;
    let mode = validate_text_field(object, "mode", "mode", "connection", 16)?;
    if !matches!(mode.as_str(), "online" | "demo") {
        return Err("connection.mode 只能是 online 或 demo".to_string());
    }
    validate_text_field(object, "host", "host", "connection", 255)?;
    validate_i64_field(object, "port", "port", "connection", 1, 65_535)?;
    Ok(())
}

fn validate_capture_camera(value: &Value, index: usize) -> Result<(), String> {
    let path = format!("capture.cameras[{index}]");
    let object = object_value(value, &path)?;
    validate_text_field(object, "id", "id", &path, 64)?;
    validate_text_field(object, "name", "name", &path, 128)?;
    validate_text_field(object, "ip", "ip", &path, 255)?;
    validate_text_field(object, "driverId", "driver_id", &path, 64)?;
    validate_optional_text_field(object, "modelHint", "model_hint", &path, 128)?;
    validate_text_field(object, "role", "role", &path, 64)?;
    validate_bool_field(object, "enabled", "enabled", &path)?;
    validate_text_field(object, "triggerMode", "trigger_mode", &path, 64)?;
    validate_i64_field(object, "exposureUs", "exposure_us", &path, 1, 1_000_000)?;
    validate_f64_field(object, "gain", "gain", &path, 0.0, 100.0)?;
    validate_i64_field(object, "depthLines", "depth_lines", &path, 1, 100_000)?;
    validate_text_field(object, "outputPath", "output_path", &path, 260)?;
    Ok(())
}

fn validate_capture_config_value(value: &Value) -> Result<(), String> {
    let object = object_value(value, "config")?;
    if let Some(service) = object.get("service") {
        let service_object = object_value(service, "service")?;
        validate_optional_text_field(service_object, "name", "name", "service", 128)?;
        validate_optional_text_field(service_object, "role", "role", "service", 128)?;
        validate_optional_text_field(
            service_object,
            "captureOrigin",
            "capture_origin",
            "service",
            255,
        )?;
        validate_optional_text_field(
            service_object,
            "captureProvider",
            "capture_provider",
            "service",
            64,
        )?;
        validate_optional_bool_field(service_object, "captureManaged", "capture_managed", "service")?;
        validate_optional_text_field(service_object, "updatedAt", "updated_at", "service", 64)?;
        validate_optional_i64_field(
            service_object,
            "capturePort",
            "capture_port",
            "service",
            1,
            65_535,
        )?;
    }

    let capture = required_object_field(object, "capture", "config")?;
    validate_text_field(capture, "mode", "mode", "capture", 64)?;
    validate_text_field(capture, "driver", "driver", "capture", 64)?;
    validate_optional_text_field(capture, "provider", "provider", "capture", 64)?;
    validate_text_field(capture, "fallback", "fallback", "capture", 64)?;
    let cameras = capture
        .get("cameras")
        .and_then(Value::as_array)
        .ok_or_else(|| "capture.cameras 必须是数组".to_string())?;
    if cameras.is_empty() {
        return Err("capture.cameras 至少需要 1 个相机".to_string());
    }
    if cameras.len() > CAPTURE_CAMERA_MAX_COUNT {
        return Err(format!(
            "capture.cameras 最多支持 {} 个相机",
            CAPTURE_CAMERA_MAX_COUNT
        ));
    }
    for (index, camera) in cameras.iter().enumerate() {
        validate_capture_camera(camera, index)?;
    }
    Ok(())
}

fn default_inspection_settings_value() -> Value {
    json!({
        "severeDepthMm": 0.12,
        "reviewDepthMm": 0.08,
        "minDefectWidthMm": 0.2,
        "cameraExposureUs": 850,
        "encoderPulsePerMeter": 2048,
        "autoReview": true,
        "alarmVolume": 86,
        "saveRawImages": true
    })
}

fn normalize_inspection_settings_value(value: &Value) -> Result<Value, String> {
    let object = object_value(value, "inspectionSettings")?;
    let severe_depth_mm = optional_f64_field_or_default(
        object,
        "severeDepthMm",
        "severe_depth_mm",
        "inspectionSettings",
        0.01,
        1.0,
        0.12,
    )?;
    let review_depth_mm = optional_f64_field_or_default(
        object,
        "reviewDepthMm",
        "review_depth_mm",
        "inspectionSettings",
        0.01,
        1.0,
        0.08,
    )?;
    if severe_depth_mm <= review_depth_mm {
        return Err("inspectionSettings.severeDepthMm 必须大于 reviewDepthMm".to_string());
    }
    let min_defect_width_mm = optional_f64_field_or_default(
        object,
        "minDefectWidthMm",
        "min_defect_width_mm",
        "inspectionSettings",
        0.01,
        5.0,
        0.2,
    )?;
    let camera_exposure_us = optional_i64_field_or_default(
        object,
        "cameraExposureUs",
        "camera_exposure_us",
        "inspectionSettings",
        100,
        5000,
        850,
    )?;
    let encoder_pulse_per_meter = optional_i64_field_or_default(
        object,
        "encoderPulsePerMeter",
        "encoder_pulse_per_meter",
        "inspectionSettings",
        500,
        10000,
        2048,
    )?;
    let alarm_volume = optional_i64_field_or_default(
        object,
        "alarmVolume",
        "alarm_volume",
        "inspectionSettings",
        0,
        100,
        86,
    )?;
    Ok(json!({
        "severeDepthMm": severe_depth_mm,
        "reviewDepthMm": review_depth_mm,
        "minDefectWidthMm": min_defect_width_mm,
        "cameraExposureUs": camera_exposure_us,
        "encoderPulsePerMeter": encoder_pulse_per_meter,
        "autoReview": optional_bool_field_or_default(object, "autoReview", "auto_review", "inspectionSettings", true)?,
        "alarmVolume": alarm_volume,
        "saveRawImages": optional_bool_field_or_default(object, "saveRawImages", "save_raw_images", "inspectionSettings", true)?
    }))
}

fn validate_inspection_settings_value(value: &Value) -> Result<(), String> {
    normalize_inspection_settings_value(value).map(|_| ())
}

fn default_alarm_rules_value() -> Value {
    json!({
        "enabled": true,
        "severeDefectThreshold": 1,
        "reviewDefectThreshold": 3,
        "cameraOffline": true,
        "receiverPortFailure": true,
        "plcOffline": true,
        "l2Offline": true,
        "notifySound": true,
        "notifyBanner": true,
        "retainMinutes": 60
    })
}

fn normalize_alarm_rules_value(value: &Value) -> Result<Value, String> {
    let object = object_value(value, "alarmRules")?;
    let severe_defect_threshold = optional_i64_field_or_default(
        object,
        "severeDefectThreshold",
        "severe_defect_threshold",
        "alarmRules",
        1,
        100,
        1,
    )?;
    let review_defect_threshold = optional_i64_field_or_default(
        object,
        "reviewDefectThreshold",
        "review_defect_threshold",
        "alarmRules",
        1,
        200,
        3,
    )?;
    let retain_minutes = optional_i64_field_or_default(
        object,
        "retainMinutes",
        "retain_minutes",
        "alarmRules",
        1,
        1440,
        60,
    )?;
    Ok(json!({
        "enabled": optional_bool_field_or_default(object, "enabled", "enabled", "alarmRules", true)?,
        "severeDefectThreshold": severe_defect_threshold,
        "reviewDefectThreshold": review_defect_threshold,
        "cameraOffline": optional_bool_field_or_default(object, "cameraOffline", "camera_offline", "alarmRules", true)?,
        "receiverPortFailure": optional_bool_field_or_default(object, "receiverPortFailure", "receiver_port_failure", "alarmRules", true)?,
        "plcOffline": optional_bool_field_or_default(object, "plcOffline", "plc_offline", "alarmRules", true)?,
        "l2Offline": optional_bool_field_or_default(object, "l2Offline", "l2_offline", "alarmRules", true)?,
        "notifySound": optional_bool_field_or_default(object, "notifySound", "notify_sound", "alarmRules", true)?,
        "notifyBanner": optional_bool_field_or_default(object, "notifyBanner", "notify_banner", "alarmRules", true)?,
        "retainMinutes": retain_minutes
    }))
}

fn validate_alarm_rules_value(value: &Value) -> Result<(), String> {
    normalize_alarm_rules_value(value).map(|_| ())
}

fn default_external_integrations_value() -> Value {
    json!({
        "plc": {
            "enabled": true,
            "protocol": "modbus-tcp",
            "host": "127.0.0.1",
            "port": 1502,
            "path": "/plc/status",
            "timeoutMs": 1000,
            "retryIntervalMs": 3000
        },
        "l2": {
            "enabled": true,
            "protocol": "http-json",
            "host": "127.0.0.1",
            "port": 8082,
            "path": "/api/l2/status",
            "timeoutMs": 1500,
            "retryIntervalMs": 5000
        },
        "mes": {
            "enabled": false,
            "protocol": "http-json",
            "host": "127.0.0.1",
            "port": 8088,
            "path": "/api/mes/report",
            "timeoutMs": 2000,
            "retryIntervalMs": 10000
        }
    })
}

fn normalize_external_integration_endpoint(
    object: &serde_json::Map<String, Value>,
    key: &str,
    defaults: &Value,
) -> Result<Value, String> {
    let path = format!("externalIntegrations.{key}");
    let default_object = defaults
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{path} 默认配置缺失"))?;
    let endpoint = match object.get(key) {
        Some(value) => object_value(value, &path)?,
        None => default_object,
    };
    let default_enabled = default_object
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let default_protocol = default_object
        .get("protocol")
        .and_then(Value::as_str)
        .unwrap_or("http-json")
        .to_string();
    let default_host = default_object
        .get("host")
        .and_then(Value::as_str)
        .unwrap_or("127.0.0.1")
        .to_string();
    let default_port = default_object
        .get("port")
        .and_then(Value::as_i64)
        .unwrap_or(80);
    let default_path = default_object
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("/")
        .to_string();
    let default_timeout_ms = default_object
        .get("timeoutMs")
        .and_then(Value::as_i64)
        .unwrap_or(1500);
    let default_retry_interval_ms = default_object
        .get("retryIntervalMs")
        .and_then(Value::as_i64)
        .unwrap_or(5000);

    let protocol = optional_text_field_or_default(
        endpoint,
        "protocol",
        "protocol",
        &path,
        32,
        default_protocol,
    )?;
    if !matches!(
        protocol.as_str(),
        "tcp" | "modbus-tcp" | "http" | "http-json"
    ) {
        return Err(format!(
            "{path}.protocol 只能是 tcp、modbus-tcp、http 或 http-json"
        ));
    }

    Ok(json!({
        "enabled": optional_bool_field_or_default(endpoint, "enabled", "enabled", &path, default_enabled)?,
        "protocol": protocol,
        "host": optional_text_field_or_default(endpoint, "host", "host", &path, 255, default_host)?,
        "port": optional_i64_field_or_default(endpoint, "port", "port", &path, 1, 65_535, default_port)?,
        "path": optional_text_field_or_default(endpoint, "path", "path", &path, 128, default_path)?,
        "timeoutMs": optional_i64_field_or_default(endpoint, "timeoutMs", "timeout_ms", &path, 100, 60_000, default_timeout_ms)?,
        "retryIntervalMs": optional_i64_field_or_default(endpoint, "retryIntervalMs", "retry_interval_ms", &path, 100, 300_000, default_retry_interval_ms)?
    }))
}

fn normalize_external_integrations_value(value: &Value) -> Result<Value, String> {
    let object = object_value(value, "externalIntegrations")?;
    let defaults = default_external_integrations_value();
    Ok(json!({
        "plc": normalize_external_integration_endpoint(object, "plc", &defaults)?,
        "l2": normalize_external_integration_endpoint(object, "l2", &defaults)?,
        "mes": normalize_external_integration_endpoint(object, "mes", &defaults)?
    }))
}

fn validate_external_integrations_value(value: &Value) -> Result<(), String> {
    normalize_external_integrations_value(value).map(|_| ())
}

fn validate_config_value(key: &str, value: &Value) -> Result<(), String> {
    match key {
        "capture" => validate_capture_config_value(value),
        "connection" => validate_connection_config_value(value),
        INSPECTION_SETTINGS_CONFIG_KEY => validate_inspection_settings_value(value),
        ALARM_RULES_CONFIG_KEY => validate_alarm_rules_value(value),
        EXTERNAL_INTEGRATIONS_CONFIG_KEY => validate_external_integrations_value(value),
        SECURITY_POLICY_CONFIG_KEY => validate_security_policy_value(value).map(|_| ()),
        _ => Err(format!("不支持的配置类型 {key}")),
    }
}

fn write_config_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let trimmed = body.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') || trimmed.len() > CONFIG_JSON_MAX_BYTES {
        return reject_invalid_config(
            state,
            actor,
            "capture",
            "invalid config json",
            "采集配置必须是非空 JSON 对象，且大小不能超过 128KB",
        );
    }
    let parsed = match serde_json::from_str::<Value>(trimmed) {
        Ok(parsed) => parsed,
        Err(_) => {
            return reject_invalid_config(
                state,
                actor,
                "capture",
                "invalid config json",
                "采集配置不是合法 JSON",
            );
        }
    };
    if let Err(detail) = validate_config_value("capture", &parsed) {
        return reject_invalid_config(state, actor, "capture", "invalid capture config", &detail);
    }

    match state.config_json.lock() {
        Ok(mut config) => {
            *config = trimmed.to_string();
            match state.runtime.block_on(db::set_config(
                &state.database.connection,
                "capture",
                trimmed,
            )) {
                Ok(()) => {
                    if let Err(error) = state.runtime.block_on(db::append_config_revision(
                        &state.database.connection,
                        "capture",
                        trimmed,
                        actor,
                        "save",
                    )) {
                        return http_response(
                            "500 Internal Server Error",
                            "application/json; charset=utf-8",
                            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
                        );
                    }
                    let _ = state.runtime.block_on(db::append_audit_log(
                        &state.database.connection,
                        actor,
                        "config.update",
                        "capture",
                        "保存采集配置 JSON",
                        "info",
                    ));
                    http_response(
                        "200 OK",
                        "application/json; charset=utf-8",
                        "{\"code\":0,\"message\":\"capture config saved\"}",
                    )
                }
                Err(error) => http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
                ),
            }
        }
        Err(_) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            "{\"error\":\"config_lock_poisoned\"}",
        ),
    }
}

fn read_connection_response(state: &ServiceState) -> Vec<u8> {
    match state
        .runtime
        .block_on(db::get_config(&state.database.connection, "connection"))
    {
        Ok(Some(config)) => {
            http_response("200 OK", "application/json; charset=utf-8", &config.value)
        }
        Ok(None) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            "{\"mode\":\"demo\",\"host\":\"127.0.0.1\",\"port\":4873}",
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn write_connection_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let trimmed = body.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') || trimmed.len() > CONFIG_JSON_MAX_BYTES {
        return reject_invalid_config(
            state,
            actor,
            "connection",
            "invalid connection json",
            "连接配置必须是非空 JSON 对象，且大小不能超过 128KB",
        );
    }
    let parsed = match serde_json::from_str::<Value>(trimmed) {
        Ok(parsed) => parsed,
        Err(_) => {
            return reject_invalid_config(
                state,
                actor,
                "connection",
                "invalid connection json",
                "连接配置不是合法 JSON",
            );
        }
    };
    if let Err(detail) = validate_config_value("connection", &parsed) {
        return reject_invalid_config(
            state,
            actor,
            "connection",
            "invalid connection config",
            &detail,
        );
    }
    match state.runtime.block_on(db::set_config(
        &state.database.connection,
        "connection",
        trimmed,
    )) {
        Ok(()) => {
            if let Err(error) = state.runtime.block_on(db::append_config_revision(
                &state.database.connection,
                "connection",
                trimmed,
                actor,
                "save",
            )) {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
                );
            }
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "config.update",
                "connection",
                "保存服务连接配置 JSON",
                "info",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                "{\"code\":0,\"message\":\"connection config saved\"}",
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn load_inspection_settings_value(state: &ServiceState) -> Result<(Value, &'static str), String> {
    match state.runtime.block_on(db::get_config(
        &state.database.connection,
        INSPECTION_SETTINGS_CONFIG_KEY,
    )) {
        Ok(Some(config)) => {
            let value = serde_json::from_str::<Value>(&config.value)
                .map_err(|_| "inspection settings config is not valid json".to_string())?;
            normalize_inspection_settings_value(&value).map(|settings| (settings, "database"))
        }
        Ok(None) => normalize_inspection_settings_value(&default_inspection_settings_value())
            .map(|settings| (settings, "default")),
        Err(error) => Err(error.to_string()),
    }
}

fn read_inspection_settings_response(state: &ServiceState) -> Vec<u8> {
    match load_inspection_settings_value(state) {
        Ok((settings, source)) => {
            let mut settings = settings;
            if let Some(object) = settings.as_object_mut() {
                object.insert("source".to_string(), json!(source));
            }
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &settings.to_string(),
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error)),
        ),
    }
}

fn write_inspection_settings_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let trimmed = body.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') || trimmed.len() > CONFIG_JSON_MAX_BYTES {
        return reject_invalid_config(
            state,
            actor,
            INSPECTION_SETTINGS_CONFIG_KEY,
            "invalid inspection settings json",
            "检测规则必须是非空 JSON 对象，且大小不能超过 128KB",
        );
    }
    let parsed = match serde_json::from_str::<Value>(trimmed) {
        Ok(parsed) => parsed,
        Err(_) => {
            return reject_invalid_config(
                state,
                actor,
                INSPECTION_SETTINGS_CONFIG_KEY,
                "invalid inspection settings json",
                "检测规则不是合法 JSON",
            );
        }
    };
    let settings = match normalize_inspection_settings_value(&parsed) {
        Ok(settings) => settings,
        Err(detail) => {
            return reject_invalid_config(
                state,
                actor,
                INSPECTION_SETTINGS_CONFIG_KEY,
                "invalid inspection settings",
                &detail,
            );
        }
    };
    let settings_text = settings.to_string();
    match state.runtime.block_on(db::set_config(
        &state.database.connection,
        INSPECTION_SETTINGS_CONFIG_KEY,
        &settings_text,
    )) {
        Ok(()) => {
            if let Err(error) = state.runtime.block_on(db::append_config_revision(
                &state.database.connection,
                INSPECTION_SETTINGS_CONFIG_KEY,
                &settings_text,
                actor,
                "save",
            )) {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
                );
            }
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "inspection_settings.update",
                INSPECTION_SETTINGS_CONFIG_KEY,
                "保存检测阈值与判级规则",
                "info",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "message": "inspection settings saved",
                    "settings": settings
                })
                .to_string(),
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn load_alarm_rules_value(state: &ServiceState) -> Result<(Value, &'static str), String> {
    match state.runtime.block_on(db::get_config(
        &state.database.connection,
        ALARM_RULES_CONFIG_KEY,
    )) {
        Ok(Some(config)) => {
            let value = serde_json::from_str::<Value>(&config.value)
                .map_err(|_| "alarm rules config is not valid json".to_string())?;
            normalize_alarm_rules_value(&value).map(|rules| (rules, "database"))
        }
        Ok(None) => normalize_alarm_rules_value(&default_alarm_rules_value())
            .map(|rules| (rules, "default")),
        Err(error) => Err(error.to_string()),
    }
}

fn read_alarm_rules_response(state: &ServiceState) -> Vec<u8> {
    match load_alarm_rules_value(state) {
        Ok((rules, source)) => {
            let mut rules = rules;
            if let Some(object) = rules.as_object_mut() {
                object.insert("source".to_string(), json!(source));
            }
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &rules.to_string(),
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error)),
        ),
    }
}

fn write_alarm_rules_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let trimmed = body.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') || trimmed.len() > CONFIG_JSON_MAX_BYTES {
        return reject_invalid_config(
            state,
            actor,
            ALARM_RULES_CONFIG_KEY,
            "invalid alarm rules json",
            "告警规则必须是非空 JSON 对象，且大小不能超过 128KB",
        );
    }
    let parsed = match serde_json::from_str::<Value>(trimmed) {
        Ok(parsed) => parsed,
        Err(_) => {
            return reject_invalid_config(
                state,
                actor,
                ALARM_RULES_CONFIG_KEY,
                "invalid alarm rules json",
                "告警规则不是合法 JSON",
            );
        }
    };
    let rules = match normalize_alarm_rules_value(&parsed) {
        Ok(rules) => rules,
        Err(detail) => {
            return reject_invalid_config(
                state,
                actor,
                ALARM_RULES_CONFIG_KEY,
                "invalid alarm rules",
                &detail,
            );
        }
    };
    let rules_text = rules.to_string();
    match state.runtime.block_on(db::set_config(
        &state.database.connection,
        ALARM_RULES_CONFIG_KEY,
        &rules_text,
    )) {
        Ok(()) => {
            if let Err(error) = state.runtime.block_on(db::append_config_revision(
                &state.database.connection,
                ALARM_RULES_CONFIG_KEY,
                &rules_text,
                actor,
                "save",
            )) {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
                );
            }
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "alarm_rules.update",
                ALARM_RULES_CONFIG_KEY,
                "保存告警触发、设备异常和提醒规则",
                "info",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "message": "alarm rules saved",
                    "rules": rules
                })
                .to_string(),
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn load_external_integrations_value(state: &ServiceState) -> Result<(Value, &'static str), String> {
    match state.runtime.block_on(db::get_config(
        &state.database.connection,
        EXTERNAL_INTEGRATIONS_CONFIG_KEY,
    )) {
        Ok(Some(config)) => {
            let value = serde_json::from_str::<Value>(&config.value)
                .map_err(|_| "external integrations config is not valid json".to_string())?;
            normalize_external_integrations_value(&value)
                .map(|integrations| (integrations, "database"))
        }
        Ok(None) => normalize_external_integrations_value(&default_external_integrations_value())
            .map(|integrations| (integrations, "default")),
        Err(error) => Err(error.to_string()),
    }
}

fn read_external_integrations_response(state: &ServiceState) -> Vec<u8> {
    match load_external_integrations_value(state) {
        Ok((integrations, source)) => {
            let mut integrations = integrations;
            if let Some(object) = integrations.as_object_mut() {
                object.insert("source".to_string(), json!(source));
            }
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &integrations.to_string(),
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error)),
        ),
    }
}

fn write_external_integrations_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let trimmed = body.trim();
    if trimmed.is_empty() || !trimmed.starts_with('{') || trimmed.len() > CONFIG_JSON_MAX_BYTES {
        return reject_invalid_config(
            state,
            actor,
            EXTERNAL_INTEGRATIONS_CONFIG_KEY,
            "invalid external integrations json",
            "外部系统接口配置必须是非空 JSON 对象，且大小不能超过 128KB",
        );
    }
    let parsed = match serde_json::from_str::<Value>(trimmed) {
        Ok(parsed) => parsed,
        Err(_) => {
            return reject_invalid_config(
                state,
                actor,
                EXTERNAL_INTEGRATIONS_CONFIG_KEY,
                "invalid external integrations json",
                "外部系统接口配置不是合法 JSON",
            );
        }
    };
    let integrations = match normalize_external_integrations_value(&parsed) {
        Ok(integrations) => integrations,
        Err(detail) => {
            return reject_invalid_config(
                state,
                actor,
                EXTERNAL_INTEGRATIONS_CONFIG_KEY,
                "invalid external integrations",
                &detail,
            );
        }
    };
    let integrations_text = integrations.to_string();
    match state.runtime.block_on(db::set_config(
        &state.database.connection,
        EXTERNAL_INTEGRATIONS_CONFIG_KEY,
        &integrations_text,
    )) {
        Ok(()) => {
            if let Err(error) = state.runtime.block_on(db::append_config_revision(
                &state.database.connection,
                EXTERNAL_INTEGRATIONS_CONFIG_KEY,
                &integrations_text,
                actor,
                "save",
            )) {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
                );
            }
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "external_integrations.update",
                EXTERNAL_INTEGRATIONS_CONFIG_KEY,
                "保存 PLC、L2、MES 外部系统接口配置",
                "info",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "message": "external integrations saved",
                    "integrations": integrations
                })
                .to_string(),
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn read_config_revisions_response(state: &ServiceState, query: &str) -> Vec<u8> {
    let key = query_value(query, "key");
    let limit = query_value(query, "limit")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30)
        .clamp(1, 100);
    match state.runtime.block_on(db::list_config_revisions(
        &state.database.connection,
        key,
        limit,
    )) {
        Ok(revisions) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &config_revisions_json(revisions),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn config_value_json(value: &str) -> Value {
    serde_json::from_str::<Value>(value).unwrap_or_else(|_| Value::String(value.to_string()))
}

fn read_config_revision_detail_response(state: &ServiceState, query: &str) -> Vec<u8> {
    let Some(revision_id) = query_value(query, "id")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"missing config revision id\"}",
        );
    };

    match state.runtime.block_on(db::find_config_revision(
        &state.database.connection,
        &revision_id,
    )) {
        Ok(Some(revision)) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({
                "revision": {
                    "id": &revision.id,
                    "key": &revision.config_key,
                    "actor": &revision.actor,
                    "action": &revision.action,
                    "bytes": revision.bytes,
                    "createdAt": &revision.created_at,
                    "value": config_value_json(&revision.value)
                }
            })
            .to_string(),
        ),
        Ok(None) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"code\":404,\"error\":\"config revision not found\"}",
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn restore_config_revision_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(payload) => payload,
        Err(_) => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                "{\"code\":400,\"error\":\"invalid config revision json\"}",
            );
        }
    };
    let revision_id = payload
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(revision_id) = revision_id else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"missing config revision id\"}",
        );
    };

    let revision = match state.runtime.block_on(db::find_config_revision(
        &state.database.connection,
        revision_id,
    )) {
        Ok(Some(revision)) => revision,
        Ok(None) => {
            return http_response(
                "404 Not Found",
                "application/json; charset=utf-8",
                "{\"code\":404,\"error\":\"config revision not found\"}",
            );
        }
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };

    let parsed_revision = match serde_json::from_str::<Value>(&revision.value) {
        Ok(value) => value,
        Err(_) => {
            return reject_invalid_config(
                state,
                actor,
                &revision.config_key,
                "invalid config json",
                "配置版本不是合法 JSON，已拒绝恢复",
            );
        }
    };
    if let Err(detail) = validate_config_value(&revision.config_key, &parsed_revision) {
        return reject_invalid_config(
            state,
            actor,
            &revision.config_key,
            "invalid config schema",
            &format!("配置版本 {} 校验失败：{}", revision.id, detail),
        );
    }

    if let Err(error) = state.runtime.block_on(db::set_config(
        &state.database.connection,
        &revision.config_key,
        &revision.value,
    )) {
        return http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        );
    }

    if revision.config_key == "capture" {
        match state.config_json.lock() {
            Ok(mut config) => {
                *config = revision.value.clone();
            }
            Err(_) => {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    "{\"error\":\"config_lock_poisoned\"}",
                );
            }
        }
    }

    let restored = match state.runtime.block_on(db::append_config_revision(
        &state.database.connection,
        &revision.config_key,
        &revision.value,
        actor,
        "restore",
    )) {
        Ok(restored) => restored,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };

    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        "config.restore",
        &revision.config_key,
        &format!("恢复配置版本 {}", revision.id),
        "warning",
    ));
    let value = config_value_json(&revision.value);
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({
            "code": 0,
            "message": "config revision restored",
            "sourceRevision": {
                "id": &revision.id,
                "key": &revision.config_key,
                "actor": &revision.actor,
                "action": &revision.action,
                "bytes": revision.bytes,
                "createdAt": &revision.created_at
            },
            "revision": {
                "id": &restored.id,
                "key": &restored.config_key,
                "actor": &restored.actor,
                "action": &restored.action,
                "bytes": restored.bytes,
                "createdAt": &restored.created_at
            },
            "config": {
                "key": &revision.config_key,
                "value": value
            }
        })
        .to_string(),
    )
}

fn database_info_response(state: &ServiceState) -> Vec<u8> {
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({
            "engine": state.database.engine,
            "orm": "sea-orm",
            "path": state.database.display_path(),
            "configDir": state.database.file_path.as_ref()
                .and_then(|path| path.parent())
                .map(|path| path.display().to_string())
                .unwrap_or_default()
        })
        .to_string(),
    )
}

fn database_backup_response(state: &ServiceState, actor: &str) -> Vec<u8> {
    let Some(path) = state.database.file_path.clone() else {
        return http_response(
            "501 Not Implemented",
            "application/json; charset=utf-8",
            &json!({
                "code": 501,
                "error": "database_backup_requires_server_tool",
                "engine": state.database.engine
            })
            .to_string(),
        );
    };
    match fs::read(&path) {
        Ok(bytes) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "database.backup",
                "steel-inspection.sqlite",
                &format!("下载数据库备份 {}（{} bytes）", path.display(), bytes.len()),
                "info",
            ));
            http_bytes_response_with_headers(
                "200 OK",
                "application/x-sqlite3",
                &bytes,
                &[(
                    "Content-Disposition",
                    "attachment; filename=\"steel-inspection-backup.sqlite\"",
                )],
            )
        }
        Err(error) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "database.backup.failed",
                "steel-inspection.sqlite",
                &format!("数据库备份读取失败 {}：{}", path.display(), error),
                "error",
            ));
            http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            )
        }
    }
}

fn database_file_bytes(state: &ServiceState) -> u64 {
    state
        .database
        .file_path
        .as_ref()
        .and_then(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn database_stats_json(stats: &db::DatabaseMaintenanceStats, bytes: u64) -> Value {
    json!({
        "pageCount": stats.page_count,
        "pageSize": stats.page_size,
        "freelistCount": stats.freelist_count,
        "bytes": bytes
    })
}

fn database_integrity_status(messages: &[String]) -> &'static str {
    if messages.len() == 1 && messages[0].eq_ignore_ascii_case("ok") {
        "ok"
    } else {
        "warning"
    }
}

fn database_integrity_response(state: &ServiceState, actor: &str) -> Vec<u8> {
    let stats = state
        .runtime
        .block_on(db::database_maintenance_stats(&state.database.connection));
    let messages = state
        .runtime
        .block_on(db::database_integrity_messages(&state.database.connection));
    match (stats, messages) {
        (Ok(stats), Ok(messages)) => {
            let status = database_integrity_status(&messages);
            let level = if status == "ok" { "info" } else { "warning" };
            let detail = if status == "ok" {
                "数据库完整性检查通过".to_string()
            } else {
                format!("数据库完整性检查发现异常：{}", messages.join("；"))
            };
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "database.integrity_check",
                "steel-inspection.sqlite",
                &detail,
                level,
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "status": status,
                    "messages": messages,
                    "stats": database_stats_json(&stats, database_file_bytes(state)),
                    "checkedAt": current_time_millis().to_string()
                })
                .to_string(),
            )
        }
        (stats_result, messages_result) => {
            let error = stats_result
                .err()
                .or_else(|| messages_result.err())
                .map(|error| error.to_string())
                .unwrap_or_else(|| "unknown database integrity error".to_string());
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "database.integrity_check.failed",
                "steel-inspection.sqlite",
                &format!("数据库完整性检查失败：{}", error),
                "error",
            ));
            http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error)),
            )
        }
    }
}

fn database_maintenance_response(state: &ServiceState, actor: &str) -> Vec<u8> {
    let before_stats = state
        .runtime
        .block_on(db::database_maintenance_stats(&state.database.connection));
    let before_bytes = database_file_bytes(state);
    let maintenance = state
        .runtime
        .block_on(db::run_database_maintenance(&state.database.connection));
    let after_stats = state
        .runtime
        .block_on(db::database_maintenance_stats(&state.database.connection));
    let integrity_messages = state
        .runtime
        .block_on(db::database_integrity_messages(&state.database.connection));
    let after_bytes = database_file_bytes(state);

    match (before_stats, maintenance, after_stats, integrity_messages) {
        (Ok(before_stats), Ok(()), Ok(after_stats), Ok(messages)) => {
            let status = database_integrity_status(&messages);
            let reclaimed_bytes = before_bytes.saturating_sub(after_bytes);
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "database.maintenance",
                "steel-inspection.sqlite",
                &format!(
                    "执行数据库压缩整理，{} -> {} bytes，释放 {} bytes，完整性 {}",
                    before_bytes, after_bytes, reclaimed_bytes, status
                ),
                if status == "ok" { "info" } else { "warning" },
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "action": "vacuum-analyze",
                    "integrity": {
                        "status": status,
                        "messages": messages
                    },
                    "before": database_stats_json(&before_stats, before_bytes),
                    "after": database_stats_json(&after_stats, after_bytes),
                    "reclaimedBytes": reclaimed_bytes,
                    "checkedAt": current_time_millis().to_string()
                })
                .to_string(),
            )
        }
        (before_result, maintenance_result, after_result, integrity_result) => {
            let error = before_result
                .err()
                .or_else(|| maintenance_result.err())
                .or_else(|| after_result.err())
                .or_else(|| integrity_result.err())
                .map(|error| error.to_string())
                .unwrap_or_else(|| "unknown database maintenance error".to_string());
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "database.maintenance.failed",
                "steel-inspection.sqlite",
                &format!("数据库压缩整理失败：{}", error),
                "error",
            ));
            http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error)),
            )
        }
    }
}

fn value_string(payload: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .or_else(|| value.as_i64().map(|item| item.to_string()))
                .or_else(|| value.as_u64().map(|item| item.to_string()))
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
}

fn value_f64(payload: &Value, keys: &[&str]) -> f64 {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.trim().parse::<f64>().ok()))
        })
        .unwrap_or(0.0)
}

fn value_i32(payload: &Value, keys: &[&str], fallback: i32) -> i32 {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_bool().map(|flag| if flag { 1 } else { 0 }))
                .or_else(|| value.as_str().and_then(|text| text.trim().parse::<i64>().ok()))
        })
        .and_then(|value| i32::try_from(value).ok())
        .unwrap_or(fallback)
}

fn material_id_from_payload(payload: &Value, fallback: &str) -> String {
    let id = value_string(
        payload,
        &["materialId", "material_id", "steelId", "steel_id", "steelNo", "steel_no", "id"],
    );
    if id.is_empty() {
        fallback.to_string()
    } else {
        id
    }
}

fn session_id_from_payload(payload: &Value, material_id: &str) -> String {
    let explicit = value_string(payload, &["sessionId", "session_id"]);
    if explicit.is_empty() {
        format!("{}-{}", material_id, current_time_millis())
    } else {
        explicit
    }
}

fn provider_code_from_response(provider: &Value, fallback: i32) -> i32 {
    provider
        .get("code")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .unwrap_or(fallback)
}

fn production_status_response(state: &ServiceState) -> Vec<u8> {
    let latest = state
        .runtime
        .block_on(db::latest_material_session(&state.database.connection));
    let latest_open = state
        .runtime
        .block_on(db::latest_open_material_session(&state.database.connection));
    let capture_status = state
        .capture
        .proxy("GET", "/api/steel/status", "")
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .unwrap_or_else(|| json!({ "code": 503, "error": "capture_provider_offline" }));
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({
            "code": 0,
            "database": {
                "engine": state.database.engine.clone(),
                "path": state.database.display_path()
            },
            "latestSession": latest.ok().flatten().map(|session| {
                json!({
                    "id": session.id,
                    "materialId": session.material_id,
                    "status": session.status,
                    "controlMode": session.control_mode,
                    "triggerMode": session.trigger_mode,
                    "updatedAt": session.updated_at
                })
            }),
            "activeSession": latest_open.ok().flatten().map(|session| {
                json!({
                    "id": session.id,
                    "materialId": session.material_id,
                    "status": session.status,
                    "controlMode": session.control_mode,
                    "triggerMode": session.trigger_mode,
                    "updatedAt": session.updated_at
                })
            }),
            "capture": capture_status
        })
        .to_string(),
    )
}

fn write_secondary_data_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(value) => value,
        Err(error) => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({ "code": 400, "error": error.to_string() }).to_string(),
            );
        }
    };
    let latest_open = state
        .runtime
        .block_on(db::latest_open_material_session(&state.database.connection))
        .ok()
        .flatten();
    let material_id = material_id_from_payload(
        &payload,
        latest_open
            .as_ref()
            .map(|session| session.material_id.as_str())
            .unwrap_or("unknown-material"),
    );
    let session_id = value_string(&payload, &["sessionId", "session_id"]);
    let session_id = if session_id.is_empty() {
        latest_open
            .as_ref()
            .filter(|session| session.material_id == material_id)
            .map(|session| session.id.clone())
            .unwrap_or_else(|| session_id_from_payload(&payload, &material_id))
    } else {
        session_id
    };
    let source = value_string(&payload, &["source"]).if_empty("l2");
    let payload_type = value_string(&payload, &["payloadType", "payload_type", "type"])
        .if_empty("secondary");
    let raw_payload = payload.to_string();
    let result = state.runtime.block_on(db::append_secondary_data(
        &state.database.connection,
        db::SecondaryDataInput {
            material_id: material_id.clone(),
            session_id: session_id.clone(),
            source: source.clone(),
            payload_type: payload_type.clone(),
            payload: raw_payload,
        },
    ));
    match result {
        Ok(row) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "production.secondary_data",
                &material_id,
                &format!("secondary data from {source} for {material_id}"),
                "info",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "materialId": material_id,
                    "sessionId": session_id,
                    "secondaryDataId": row.id
                })
                .to_string(),
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        ),
    }
}

trait EmptyStringDefault {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyStringDefault for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn write_production_event_response(
    state: &ServiceState,
    body: &str,
    default_event: &str,
    actor: &str,
) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(value) => value,
        Err(error) => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({ "code": 400, "error": error.to_string() }).to_string(),
            );
        }
    };
    let latest_open = state
        .runtime
        .block_on(db::latest_open_material_session(&state.database.connection))
        .ok()
        .flatten();
    let material_id = material_id_from_payload(
        &payload,
        latest_open
            .as_ref()
            .map(|session| session.material_id.as_str())
            .unwrap_or("unknown-material"),
    );
    let session_id = value_string(&payload, &["sessionId", "session_id"]);
    let session_id = if session_id.is_empty() {
        latest_open
            .as_ref()
            .filter(|session| default_event == "steel-out" || session.material_id == material_id)
            .map(|session| session.id.clone())
            .unwrap_or_else(|| session_id_from_payload(&payload, &material_id))
    } else {
        session_id
    };
    let source = value_string(&payload, &["source"]).if_empty("api");
    let mode = value_string(&payload, &["mode", "controlMode", "control_mode"]).if_empty("api");
    let trigger_mode = value_string(&payload, &["triggerMode", "trigger_mode"]).if_empty(&mode);
    let command = value_string(&payload, &["cmd", "command", "event", "type"]).if_empty(match default_event {
        "steel-info" => "rcvSteelInfo",
        "steel-out" => "steelIn",
        _ => "steelIn",
    });
    let value = match default_event {
        "steel-out" => 0,
        "steel-info" => value_i32(&payload, &["value"], 0),
        _ => value_i32(&payload, &["value", "present"], 1),
    };
    let status = match default_event {
        "steel-out" => "finished",
        "steel-info" => "info-ready",
        _ => "active",
    };
    let now = current_time_string();
    let session_input = db::MaterialSessionInput {
        id: session_id.clone(),
        material_id: material_id.clone(),
        source: source.clone(),
        status: status.to_string(),
        control_mode: mode.clone(),
        trigger_mode: trigger_mode.clone(),
        steel_type: value_string(&payload, &["steelType", "steel_type", "type"]),
        width_mm: value_f64(&payload, &["width", "widthMm", "width_mm"]),
        length_mm: value_f64(&payload, &["length", "len", "lengthMm", "length_mm"]),
        thickness_mm: value_f64(&payload, &["thick", "thickness", "thicknessMm", "thickness_mm"]),
        client: value_string(&payload, &["client"]),
        hard: value_string(&payload, &["hard"]),
        storage_root: value_string(&payload, &["storageRoot", "storage_root"]),
        started_at: now.clone(),
        finished_at: if default_event == "steel-out" {
            now.clone()
        } else {
            String::new()
        },
        raw_payload: payload.to_string(),
    };
    let session_result = state
        .runtime
        .block_on(db::upsert_material_session(&state.database.connection, session_input));
    if let Err(error) = session_result {
        return http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        );
    }
    if default_event == "steel-out" {
        let _ = state.runtime.block_on(db::finish_material_session(
            &state.database.connection,
            &session_id,
            &now,
        ));
    }

    let inspection_id = format!("INSP-{session_id}");
    let _ = state.runtime.block_on(db::upsert_production_inspection(
        &state.database.connection,
        db::ProductionInspectionInput {
            id: inspection_id.clone(),
            material_id: material_id.clone(),
            session_id: session_id.clone(),
            status: if default_event == "steel-out" {
                "finished".to_string()
            } else {
                "running".to_string()
            },
            storage_root: value_string(&payload, &["storageRoot", "storage_root"]),
            summary_path: value_string(&payload, &["summaryPath", "summary_path"]),
            started_at: now.clone(),
            finished_at: if default_event == "steel-out" {
                now.clone()
            } else {
                String::new()
            },
            capture_count: value_i32(&payload, &["captureCount", "capture_count"], 0),
            defect_count: value_i32(&payload, &["defectCount", "defect_count"], 0),
            raw_payload: payload.to_string(),
        },
    ));

    let provider_body = json!({
        "cmd": command.clone(),
        "value": value,
        "id": material_id,
        "steelId": material_id,
        "steelNo": material_id,
        "steelType": value_string(&payload, &["steelType", "steel_type", "type"]),
        "length": value_f64(&payload, &["length", "len", "lengthMm", "length_mm"]),
        "width": value_f64(&payload, &["width", "widthMm", "width_mm"]),
        "thick": value_f64(&payload, &["thick", "thickness", "thicknessMm", "thickness_mm"]),
        "client": value_string(&payload, &["client"]),
        "hard": value_string(&payload, &["hard"])
    })
    .to_string();
    let provider_response = state
        .capture
        .proxy("POST", "/api/steel/event", &provider_body)
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .unwrap_or_else(|| json!({ "code": 503, "error": "capture_provider_offline" }));
    let provider_code = provider_code_from_response(&provider_response, 503);
    let trigger_result = state.runtime.block_on(db::append_trigger_event(
        &state.database.connection,
        db::TriggerEventInput {
            material_id: material_id.clone(),
            session_id: session_id.clone(),
            source: source.clone(),
            mode: mode.clone(),
            event_type: default_event.to_string(),
            command: command.clone(),
            value,
            payload: payload.to_string(),
            provider_code,
            provider_response: provider_response.to_string(),
        },
    ));
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        "production.trigger_event",
        &material_id,
        &format!("{default_event} from {source} mode={mode} providerCode={provider_code}"),
        if provider_code == 0 { "info" } else { "warning" },
    ));
    match trigger_result {
        Ok(row) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({
                "code": provider_code,
                "materialId": material_id,
                "sessionId": session_id,
                "inspectionId": inspection_id,
                "triggerEventId": row.id,
                "mode": mode,
                "triggerMode": trigger_mode,
                "provider": provider_response
            })
            .to_string(),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string(), "provider": provider_response })
                .to_string(),
        ),
    }
}

fn active_session_for_payload(state: &ServiceState, payload: &Value) -> (String, String) {
    let latest_open = state
        .runtime
        .block_on(db::latest_open_material_session(&state.database.connection))
        .ok()
        .flatten();
    let material_id = material_id_from_payload(
        payload,
        latest_open
            .as_ref()
            .map(|session| session.material_id.as_str())
            .unwrap_or("unknown-material"),
    );
    let session_id = value_string(payload, &["sessionId", "session_id"]);
    let session_id = if session_id.is_empty() {
        latest_open
            .as_ref()
            .filter(|session| session.material_id == material_id)
            .map(|session| session.id.clone())
            .unwrap_or_else(|| session_id_from_payload(payload, &material_id))
    } else {
        session_id
    };
    (material_id, session_id)
}

fn capture_file_rows_from_result(
    state: &ServiceState,
    inspection_id: &str,
    session_id: &str,
    material_id: &str,
    result: &Value,
) -> Result<usize, String> {
    let camera_ip = value_string(result, &["ip", "cameraIp", "camera_ip"]);
    let camera_id = value_string(result, &["cameraId", "camera_id"]).if_empty(&camera_ip);
    let sequence_no = value_i32(result, &["attempt", "sequenceNo", "sequence_no"], 0);
    let metadata_path = value_string(result, &["metadataOutput", "metadata_path", "metadataPath"]);
    let outputs = [
        ("depth", "png", value_string(result, &["depthOutput", "output"])),
        ("intensity", "png", value_string(result, &["intensityOutput"])),
        ("metadata", "json", metadata_path.clone()),
        ("sdk-derived", "png", value_string(result, &["sdkOutput"])),
        ("sdk-derived-depth", "png", value_string(result, &["sdkDepthOutput"])),
        (
            "sdk-derived-intensity",
            "png",
            value_string(result, &["sdkIntensityOutput"]),
        ),
    ];
    let mut inserted = 0;
    for (data_name, file_type, path) in outputs {
        if path.trim().is_empty() {
            continue;
        }
        state
            .runtime
            .block_on(db::append_capture_file(
                &state.database.connection,
                db::CaptureFileInput {
                    inspection_id: inspection_id.to_string(),
                    session_id: session_id.to_string(),
                    material_id: material_id.to_string(),
                    camera_id: camera_id.clone(),
                    camera_ip: camera_ip.clone(),
                    data_name: data_name.to_string(),
                    sequence_no,
                    file_type: file_type.to_string(),
                    path,
                    metadata_path: metadata_path.clone(),
                },
            ))
            .map_err(|error| error.to_string())?;
        inserted += 1;
    }
    Ok(inserted)
}

fn write_capture_summary_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(value) => value,
        Err(error) => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({ "code": 400, "error": error.to_string() }).to_string(),
            );
        }
    };
    let (material_id, session_id) = active_session_for_payload(state, &payload);
    let inspection_id =
        value_string(&payload, &["inspectionId", "inspection_id"]).if_empty(&format!("INSP-{session_id}"));
    let capture_count = value_i32(&payload, &["attempts", "captureCount", "capture_count"], 0);
    let defect_count = value_i32(&payload, &["defectCount", "defect_count"], 0);
    let status = if value_i32(&payload, &["failures"], 0) == 0 {
        "captured"
    } else {
        "capture-warning"
    };
    let summary_path = value_string(&payload, &["summaryOutput", "summary_path", "summaryPath"]);
    let storage_root = value_string(&payload, &["storageRoot", "storage_root"]);
    let now = current_time_string();
    let inspection = state.runtime.block_on(db::upsert_production_inspection(
        &state.database.connection,
        db::ProductionInspectionInput {
            id: inspection_id.clone(),
            material_id: material_id.clone(),
            session_id: session_id.clone(),
            status: status.to_string(),
            storage_root,
            summary_path,
            started_at: value_string(&payload, &["startedAt", "started_at"]).if_empty(&now),
            finished_at: value_string(&payload, &["finishedAt", "finished_at"]),
            capture_count,
            defect_count,
            raw_payload: payload.to_string(),
        },
    ));
    if let Err(error) = inspection {
        return http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        );
    }
    let mut file_rows = 0;
    if let Some(results) = payload.get("results").and_then(Value::as_array) {
        for result in results {
            match capture_file_rows_from_result(
                state,
                &inspection_id,
                &session_id,
                &material_id,
                result,
            ) {
                Ok(count) => file_rows += count,
                Err(error) => {
                    return http_response(
                        "500 Internal Server Error",
                        "application/json; charset=utf-8",
                        &json!({ "code": 500, "error": error }).to_string(),
                    );
                }
            }
        }
    }
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        "production.capture_summary",
        &material_id,
        &format!("capture summary files={file_rows} inspection={inspection_id}"),
        "info",
    ));
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({
            "code": 0,
            "materialId": material_id,
            "sessionId": session_id,
            "inspectionId": inspection_id,
            "captureFileRows": file_rows
        })
        .to_string(),
    )
}

fn write_production_capture_once_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(value) => value,
        Err(error) => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({ "code": 400, "error": error.to_string() }).to_string(),
            );
        }
    };
    let (material_id, session_id) = active_session_for_payload(state, &payload);
    let mut capture_body = payload.as_object().cloned().unwrap_or_default();
    capture_body
        .entry("expectedCameras".to_string())
        .or_insert_with(|| json!(6));
    capture_body
        .entry("rounds".to_string())
        .or_insert_with(|| json!(1));
    capture_body
        .entry("lines".to_string())
        .or_insert_with(|| json!(1000));
    capture_body
        .entry("width".to_string())
        .or_insert_with(|| json!(0));
    capture_body
        .entry("timeoutMs".to_string())
        .or_insert_with(|| json!(8000));
    capture_body
        .entry("intervalMs".to_string())
        .or_insert_with(|| json!(500));
    capture_body
        .entry("retries".to_string())
        .or_insert_with(|| json!(0));
    capture_body
        .entry("controlMode".to_string())
        .or_insert_with(|| json!(0));
    capture_body
        .entry("dataMode".to_string())
        .or_insert_with(|| json!(3));
    capture_body
        .entry("connectFirst".to_string())
        .or_insert_with(|| json!(false));
    capture_body
        .entry("stopStreams".to_string())
        .or_insert_with(|| json!(true));
    capture_body.insert("materialId".to_string(), json!(material_id.clone()));
    capture_body.insert("sessionId".to_string(), json!(session_id.clone()));
    capture_body.insert("productionLayout".to_string(), json!(true));
    let provider_body = Value::Object(capture_body).to_string();
    let provider = state
        .capture
        .proxy("POST", "/api/capture/continuous-test", &provider_body)
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok())
        .unwrap_or_else(|| json!({ "code": 503, "error": "capture_provider_offline" }));
    if provider.get("code").and_then(Value::as_i64).unwrap_or(503) == 503 {
        return http_response(
            "503 Service Unavailable",
            "application/json; charset=utf-8",
            &json!({ "code": 503, "error": "capture_provider_offline", "provider": provider })
                .to_string(),
        );
    }
    let mut summary = provider.as_object().cloned().unwrap_or_default();
    summary.insert("materialId".to_string(), json!(material_id.clone()));
    summary.insert("sessionId".to_string(), json!(session_id.clone()));
    let summary_json = Value::Object(summary).to_string();
    let record_response = write_capture_summary_response(state, &summary_json, actor);
    let record_body = String::from_utf8_lossy(
        record_response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| &record_response[index + 4..])
            .unwrap_or(&record_response),
    )
    .to_string();
    let record = serde_json::from_str::<Value>(&record_body)
        .unwrap_or_else(|_| json!({ "code": 500, "error": "capture_summary_record_failed" }));
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({
            "code": provider.get("code").and_then(Value::as_i64).unwrap_or(0),
            "materialId": material_id,
            "sessionId": session_id,
            "provider": provider,
            "record": record
        })
        .to_string(),
    )
}

fn write_production_defect_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(value) => value,
        Err(error) => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({ "code": 400, "error": error.to_string() }).to_string(),
            );
        }
    };
    let (material_id, session_id) = active_session_for_payload(state, &payload);
    let inspection_id =
        value_string(&payload, &["inspectionId", "inspection_id"]).if_empty(&format!("INSP-{session_id}"));
    let result = state.runtime.block_on(db::append_production_defect(
        &state.database.connection,
        db::ProductionDefectInput {
            inspection_id: inspection_id.clone(),
            material_id: material_id.clone(),
            camera_id: value_string(&payload, &["cameraId", "camera_id", "cameraIp", "ip"]),
            defect_type: value_string(&payload, &["defectType", "defect_type", "type"])
                .if_empty("unknown"),
            severity: value_string(&payload, &["severity"]).if_empty("review"),
            x_mm: value_f64(&payload, &["xMm", "x_mm", "x"]),
            y_mm: value_f64(&payload, &["yMm", "y_mm", "y"]),
            z_mm: value_f64(&payload, &["zMm", "z_mm", "z"]),
            width_mm: value_f64(&payload, &["widthMm", "width_mm", "width"]),
            height_mm: value_f64(&payload, &["heightMm", "height_mm", "height"]),
            depth_mm: value_f64(&payload, &["depthMm", "depth_mm", "depth"]),
            confidence: value_f64(&payload, &["confidence", "score"]),
            geometry_json: payload
                .get("geometry")
                .cloned()
                .unwrap_or_else(|| json!({}))
                .to_string(),
        },
    ));
    match result {
        Ok(row) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "production.defect",
                &material_id,
                &format!("defect {} inspection={inspection_id}", row.id),
                "info",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "materialId": material_id,
                    "sessionId": session_id,
                    "inspectionId": inspection_id,
                    "defectId": row.id
                })
                .to_string(),
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        ),
    }
}

fn json_text_field(payload: &Value, camel_key: &str, snake_key: &str) -> Option<String> {
    payload
        .get(camel_key)
        .or_else(|| payload.get(snake_key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn decode_query_value(value: &str) -> String {
    let mut decoded = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    decoded.push(byte);
                    index += 3;
                } else {
                    decoded.push(b'%');
                    index += 1;
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (item_key, item_value) = pair.split_once('=')?;
        if item_key == key {
            Some(decode_query_value(item_value))
        } else {
            None
        }
    })
}

fn export_filter_value(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "all")
        .unwrap_or("全部")
        .to_string()
}

fn export_audit_detail(
    rows: usize,
    max_rows: u64,
    keyword: Option<&str>,
    level: Option<&str>,
) -> String {
    format!(
        "导出审计日志 {rows} 条（上限 {max_rows}，关键字={}，等级={}）",
        export_filter_value(keyword),
        export_filter_value(level)
    )
}

fn export_records_detail(
    rows: usize,
    max_rows: u64,
    keyword: Option<&str>,
    status: Option<&str>,
) -> String {
    format!(
        "导出检测记录 {rows} 条（上限 {max_rows}，关键字={}，状态={}）",
        export_filter_value(keyword),
        export_filter_value(status)
    )
}

fn validate_admin_identifier(value: &str, path: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{path} 不能为空"));
    }
    if value.len() > ADMIN_ID_MAX_LEN {
        return Err(format!("{path} 长度不能超过 {ADMIN_ID_MAX_LEN}"));
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(format!("{path} 不能为空"));
    };
    if !first.is_ascii_alphanumeric() {
        return Err(format!("{path} 必须以字母或数字开头"));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
    {
        return Err(format!("{path} 只能包含字母、数字、下划线、中划线或点"));
    }
    Ok(())
}

fn validate_admin_text(value: &str, path: &str, max_len: usize) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{path} 不能为空"));
    }
    if value.len() > max_len {
        return Err(format!("{path} 长度不能超过 {max_len}"));
    }
    Ok(())
}

fn audit_retention_cutoff(now: u128, retention_days: u64) -> String {
    now.saturating_sub(u128::from(retention_days) * DAY_MILLIS)
        .to_string()
}

fn audit_retention_detail(
    retention_days: u64,
    cutoff_at: &str,
    matched: u64,
    deleted: u64,
    dry_run: bool,
) -> String {
    if dry_run {
        format!(
            "预览审计日志保留策略：保留 {retention_days} 天，截止 {cutoff_at}，可清理 {matched} 条"
        )
    } else {
        format!("执行审计日志保留策略：保留 {retention_days} 天，截止 {cutoff_at}，清理 {deleted} / {matched} 条")
    }
}

fn record_retention_detail(
    retention_days: u64,
    cutoff_at: &str,
    matched: u64,
    deleted_records: u64,
    deleted_defects: u64,
    deleted_plates: u64,
    dry_run: bool,
) -> String {
    if dry_run {
        format!(
            "预览检测记录保留策略：保留 {retention_days} 天，截止 {cutoff_at}，可清理 {matched} 条记录"
        )
    } else {
        format!(
            "执行检测记录保留策略：保留 {retention_days} 天，截止 {cutoff_at}，清理记录 {deleted_records} / {matched} 条，缺陷 {deleted_defects} 条，钢板档案 {deleted_plates} 条"
        )
    }
}

fn default_security_policy() -> SecurityPolicy {
    SecurityPolicy {
        audit_retention_days: ADMIN_AUDIT_RETENTION_DEFAULT_DAYS,
        login_max_failures: LOGIN_MAX_FAILURES,
        login_failure_window_minutes: (LOGIN_FAILURE_WINDOW_MS / 60_000) as u64,
        login_lockout_minutes: (LOGIN_LOCKOUT_MS / 60_000) as u64,
        session_ttl_hours: ADMIN_SESSION_TTL_HOURS,
    }
}

fn optional_bounded_u64_field(
    container: Option<&Value>,
    primary: &str,
    secondary: &str,
    default_value: u64,
    min_value: u64,
    max_value: u64,
    label: &str,
) -> Result<u64, String> {
    let Some(value) = container.and_then(|item| item.get(primary).or_else(|| item.get(secondary)))
    else {
        return Ok(default_value);
    };
    let Some(number) = value.as_u64() else {
        return Err(format!("{label} 必须是数字"));
    };
    if !(min_value..=max_value).contains(&number) {
        return Err(format!("{label} 必须在 {min_value}..{max_value} 范围内"));
    }
    Ok(number)
}

fn optional_object_field<'a>(
    value: &'a Value,
    primary: &str,
    secondary: &str,
    label: &str,
) -> Result<Option<&'a Value>, String> {
    let Some(field) = value.get(primary).or_else(|| value.get(secondary)) else {
        return Ok(None);
    };
    if !field.is_object() {
        return Err(format!("{label} 必须是对象"));
    }
    Ok(Some(field))
}

fn security_policy_value(policy: &SecurityPolicy) -> Value {
    json!({
        "auditRetentionDays": policy.audit_retention_days,
        "limits": {
            "minAuditRetentionDays": ADMIN_AUDIT_RETENTION_MIN_DAYS,
            "maxAuditRetentionDays": ADMIN_AUDIT_RETENTION_MAX_DAYS,
            "minLoginMaxFailures": LOGIN_MAX_FAILURES_MIN,
            "maxLoginMaxFailures": LOGIN_MAX_FAILURES_MAX,
            "minLoginWindowMinutes": LOGIN_FAILURE_WINDOW_MIN_MINUTES,
            "maxLoginWindowMinutes": LOGIN_FAILURE_WINDOW_MAX_MINUTES,
            "minLoginLockoutMinutes": LOGIN_LOCKOUT_MIN_MINUTES,
            "maxLoginLockoutMinutes": LOGIN_LOCKOUT_MAX_MINUTES,
            "minSessionTtlHours": ADMIN_SESSION_TTL_MIN_HOURS,
            "maxSessionTtlHours": ADMIN_SESSION_TTL_MAX_HOURS
        },
        "login": {
            "maxFailures": policy.login_max_failures,
            "failureWindowMinutes": policy.login_failure_window_minutes,
            "lockoutMinutes": policy.login_lockout_minutes
        },
        "session": {
            "ttlHours": policy.session_ttl_hours
        }
    })
}

fn security_policy_response_json(policy: &SecurityPolicy, source: &str) -> String {
    json!({
        "code": 0,
        "policy": security_policy_value(policy),
        "source": source
    })
    .to_string()
}

fn validate_security_policy_value(value: &Value) -> Result<SecurityPolicy, String> {
    let default_policy = default_security_policy();
    let Some(retention_days) = value
        .get("auditRetentionDays")
        .or_else(|| value.get("audit_retention_days"))
        .and_then(Value::as_u64)
    else {
        return Err("securityPolicy.auditRetentionDays 不能为空".to_string());
    };
    if !(ADMIN_AUDIT_RETENTION_MIN_DAYS..=ADMIN_AUDIT_RETENTION_MAX_DAYS).contains(&retention_days)
    {
        return Err(format!(
            "securityPolicy.auditRetentionDays 必须在 {}..{} 范围内",
            ADMIN_AUDIT_RETENTION_MIN_DAYS, ADMIN_AUDIT_RETENTION_MAX_DAYS
        ));
    }
    let login = optional_object_field(value, "login", "login_policy", "securityPolicy.login")?;
    let session =
        optional_object_field(value, "session", "session_policy", "securityPolicy.session")?;
    let login_max_failures = optional_bounded_u64_field(
        login,
        "maxFailures",
        "max_failures",
        u64::from(default_policy.login_max_failures),
        u64::from(LOGIN_MAX_FAILURES_MIN),
        u64::from(LOGIN_MAX_FAILURES_MAX),
        "securityPolicy.login.maxFailures",
    )? as u32;
    let login_failure_window_minutes = optional_bounded_u64_field(
        login,
        "failureWindowMinutes",
        "failure_window_minutes",
        default_policy.login_failure_window_minutes,
        LOGIN_FAILURE_WINDOW_MIN_MINUTES,
        LOGIN_FAILURE_WINDOW_MAX_MINUTES,
        "securityPolicy.login.failureWindowMinutes",
    )?;
    let login_lockout_minutes = optional_bounded_u64_field(
        login,
        "lockoutMinutes",
        "lockout_minutes",
        default_policy.login_lockout_minutes,
        LOGIN_LOCKOUT_MIN_MINUTES,
        LOGIN_LOCKOUT_MAX_MINUTES,
        "securityPolicy.login.lockoutMinutes",
    )?;
    let session_ttl_hours = optional_bounded_u64_field(
        session,
        "ttlHours",
        "ttl_hours",
        default_policy.session_ttl_hours,
        ADMIN_SESSION_TTL_MIN_HOURS,
        ADMIN_SESSION_TTL_MAX_HOURS,
        "securityPolicy.session.ttlHours",
    )?;
    Ok(SecurityPolicy {
        audit_retention_days: retention_days,
        login_max_failures,
        login_failure_window_minutes,
        login_lockout_minutes,
        session_ttl_hours,
    })
}

fn parse_security_policy(raw: &str) -> Option<SecurityPolicy> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| validate_security_policy_value(&value).ok())
}

fn load_security_policy(state: &ServiceState) -> SecurityPolicy {
    state
        .runtime
        .block_on(db::get_config(
            &state.database.connection,
            SECURITY_POLICY_CONFIG_KEY,
        ))
        .ok()
        .flatten()
        .and_then(|config| parse_security_policy(&config.value))
        .unwrap_or_else(default_security_policy)
}

fn admin_users_json(users: Vec<db::entities::admin_user::Model>) -> String {
    json!({
        "users": users.iter().map(|user| {
            json!({
                "id": &user.id,
                "displayName": &user.display_name,
                "role": &user.role,
                "status": &user.status,
                "lastLoginAt": &user.last_login_at,
                "createdAt": &user.created_at
            })
        }).collect::<Vec<_>>()
    })
    .to_string()
}

fn role_permissions_value(permissions: &str) -> Value {
    serde_json::from_str::<Value>(permissions).unwrap_or_else(|_| json!([]))
}

fn role_permissions_vec(permissions: &str) -> Vec<String> {
    role_permissions_value(permissions)
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn role_permissions_from_value(payload: &Value) -> Result<Vec<String>, String> {
    let Some(permission_values) = payload.get("permissions") else {
        return Err("role.permissions 必须是数组".to_string());
    };
    let Some(permission_values) = permission_values.as_array() else {
        return Err("role.permissions 必须是数组".to_string());
    };
    let mut permissions = Vec::<String>::new();
    for permission in permission_values {
        let Some(permission) = permission
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Err("role.permissions 只能包含非空字符串".to_string());
        };
        if !is_known_admin_permission(permission) {
            return Err(format!("未知角色权限 {permission}"));
        }
        if !permissions.iter().any(|current| current == permission) {
            permissions.push(permission.to_string());
        }
    }
    Ok(permissions)
}

fn session_user_json(session: &AdminSession) -> Value {
    json!({
        "id": &session.user_id,
        "displayName": &session.display_name,
        "role": &session.role,
        "permissions": &session.permissions
    })
}

fn auth_session_json(session: &AdminSession) -> String {
    json!({
        "authenticated": true,
        "token": &session.token,
        "createdAt": session.created_at.to_string(),
        "expiresAt": session.expires_at.to_string(),
        "user": session_user_json(session)
    })
    .to_string()
}

fn admin_roles_json(roles: Vec<db::entities::admin_role::Model>) -> String {
    json!({
        "roles": roles.iter().map(|role| {
            json!({
                "id": &role.id,
                "label": &role.label,
                "description": &role.description,
                "permissions": role_permissions_value(&role.permissions),
                "status": &role.status,
                "updatedAt": &role.updated_at
            })
        }).collect::<Vec<_>>()
    })
    .to_string()
}

fn admin_permissions_json() -> String {
    json!({
        "permissions": ADMIN_PERMISSION_CATALOG.iter().map(|(id, label, group, description)| {
            json!({
                "id": id,
                "label": label,
                "group": group,
                "description": description
            })
        }).collect::<Vec<_>>()
    })
    .to_string()
}

fn camera_configs_json(cameras: Vec<db::entities::camera_config::Model>) -> String {
    json!({
        "cameras": cameras.iter().map(|camera| {
            json!({
                "id": &camera.id,
                "name": &camera.name,
                "ip": &camera.ip,
                "driverId": &camera.driver_id,
                "modelHint": &camera.model_hint,
                "role": &camera.role,
                "enabled": camera.enabled,
                "triggerMode": &camera.trigger_mode,
                "exposureUs": camera.exposure_us,
                "gain": camera.gain,
                "depthLines": camera.depth_lines,
                "outputPath": &camera.output_path
            })
        }).collect::<Vec<_>>()
    })
    .to_string()
}

fn defect_types_json(defect_types: Vec<db::entities::defect_type::Model>) -> String {
    json!({
        "defectTypes": defect_types.iter().map(|defect_type| {
            json!({
                "id": &defect_type.id,
                "label": &defect_type.label,
                "color": &defect_type.color,
                "shape": &defect_type.shape
            })
        }).collect::<Vec<_>>()
    })
    .to_string()
}

fn audit_log_page_json(page: db::AdminAuditLogPage) -> String {
    json!({
        "total": page.total,
        "limit": page.limit,
        "offset": page.offset,
        "auditLogs": page.logs.iter().map(|entry| {
            json!({
                "id": &entry.id,
                "actor": &entry.actor,
                "action": &entry.action,
                "target": &entry.target,
                "detail": &entry.detail,
                "level": &entry.level,
                "createdAt": &entry.created_at
            })
        }).collect::<Vec<_>>()
    })
    .to_string()
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn audit_logs_csv(logs: &[db::entities::audit_log::Model]) -> String {
    let mut csv = String::from("时间,级别,账号,动作,对象,内容\n");
    for entry in logs {
        let row = [
            csv_escape(&entry.created_at),
            csv_escape(&entry.level),
            csv_escape(&entry.actor),
            csv_escape(&entry.action),
            csv_escape(&entry.target),
            csv_escape(&entry.detail),
        ]
        .join(",");
        csv.push_str(&row);
        csv.push('\n');
    }
    csv
}

fn inspection_record_status_label(status: &str) -> &str {
    match status {
        "detecting" => "检测中",
        "completed" => "已完成",
        _ => status,
    }
}

fn inspection_record_spec(row: &db::AdminInspectionRecord) -> String {
    row.plate
        .as_ref()
        .map(|plate| {
            format!(
                "{} x {} x {}mm",
                plate.width_mm, plate.length_mm, plate.thickness_mm
            )
        })
        .unwrap_or_else(|| "-".to_string())
}

fn inspection_records_csv(rows: &[db::AdminInspectionRecord]) -> String {
    let mut csv = String::from("记录号,检测时间,板号,钢种,规格,状态,缺陷总数,严重,待复核,轻微\n");
    for row in rows {
        let steel_grade = row
            .plate
            .as_ref()
            .map(|plate| plate.steel_grade.as_str())
            .unwrap_or("-");
        let fields = [
            csv_escape(&row.record.id),
            csv_escape(&row.record.time),
            csv_escape(&row.record.plate_no),
            csv_escape(steel_grade),
            csv_escape(&inspection_record_spec(row)),
            csv_escape(inspection_record_status_label(&row.record.status)),
            row.record.defect_count.to_string(),
            row.severe_count.to_string(),
            row.review_count.to_string(),
            row.minor_count.to_string(),
        ];
        csv.push_str(&fields.join(","));
        csv.push('\n');
    }
    csv
}

fn config_revisions_json(revisions: Vec<db::entities::config_revision::Model>) -> String {
    json!({
        "revisions": revisions.iter().map(|revision| {
            json!({
                "id": &revision.id,
                "key": &revision.config_key,
                "actor": &revision.actor,
                "action": &revision.action,
                "bytes": revision.bytes,
                "createdAt": &revision.created_at
            })
        }).collect::<Vec<_>>()
    })
    .to_string()
}

fn inspection_record_json(row: &db::AdminInspectionRecord) -> Value {
    let plate = row.plate.as_ref();
    json!({
        "id": &row.record.id,
        "time": &row.record.time,
        "plateNo": &row.record.plate_no,
        "status": &row.record.status,
        "defectCount": row.record.defect_count,
        "plate": plate.map(|item| {
            json!({
                "plateNo": &item.plate_no,
                "widthMm": item.width_mm,
                "lengthMm": item.length_mm,
                "thicknessMm": item.thickness_mm,
                "steelGrade": &item.steel_grade,
                "detectedAt": &item.detected_at
            })
        }),
        "severity": {
            "severe": row.severe_count,
            "review": row.review_count,
            "minor": row.minor_count
        }
    })
}

fn inspection_record_detail_json(detail: db::AdminInspectionRecordDetail) -> String {
    let mut record = inspection_record_json(&detail.record);
    if let Some(object) = record.as_object_mut() {
        object.insert(
            "defects".to_string(),
            Value::Array(
                detail
                    .defects
                    .iter()
                    .map(|defect| config_value_json(&database_defect_json(defect)))
                    .collect::<Vec<_>>(),
            ),
        );
    }
    json!({ "record": record }).to_string()
}

fn inspection_records_json(page: db::AdminInspectionRecordPage) -> String {
    json!({
        "total": page.total,
        "limit": page.limit,
        "offset": page.offset,
        "records": page.records.iter().map(inspection_record_json).collect::<Vec<_>>()
    })
    .to_string()
}

fn read_admin_cameras_response(state: &ServiceState) -> Vec<u8> {
    match state
        .runtime
        .block_on(db::list_camera_configs(&state.database.connection))
    {
        Ok(cameras) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &camera_configs_json(cameras),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn reject_invalid_camera_config(
    state: &ServiceState,
    actor: &str,
    target: &str,
    detail: &str,
) -> Vec<u8> {
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        "camera_config.validation.failed",
        target,
        detail,
        "warning",
    ));
    http_response(
        "400 Bad Request",
        "application/json; charset=utf-8",
        &json!({
            "code": 400,
            "error": "invalid camera config",
            "message": detail
        })
        .to_string(),
    )
}

fn camera_config_input_from_value(payload: &Value) -> Result<db::CameraConfigInput, String> {
    let object = object_value(payload, "camera")?;
    let id = validate_text_field(object, "id", "id", "camera", 64)?;
    let name = validate_text_field(object, "name", "name", "camera", 128)?;
    let ip = validate_text_field(object, "ip", "ip", "camera", 255)?;
    let driver_id = optional_text_field_or_default(
        object,
        "driverId",
        "driver_id",
        "camera",
        64,
        "lvm-nvt".to_string(),
    )?;
    let model_hint = optional_text_field_or_default(
        object,
        "modelHint",
        "model_hint",
        "camera",
        128,
        "LVM3450CA".to_string(),
    )?;
    let role = optional_text_field_or_default(
        object,
        "role",
        "role",
        "camera",
        64,
        "采集相机".to_string(),
    )?;
    let enabled = optional_bool_field_or_default(object, "enabled", "enabled", "camera", true)?;
    let trigger_mode = optional_text_field_or_default(
        object,
        "triggerMode",
        "trigger_mode",
        "camera",
        64,
        "软件触发".to_string(),
    )?;
    let exposure_us = optional_i64_field_or_default(
        object,
        "exposureUs",
        "exposure_us",
        "camera",
        1,
        1_000_000,
        850,
    )? as i32;
    let gain = optional_f64_field_or_default(object, "gain", "gain", "camera", 0.0, 100.0, 1.0)?;
    let depth_lines = optional_i64_field_or_default(
        object,
        "depthLines",
        "depth_lines",
        "camera",
        1,
        100_000,
        1280,
    )? as i32;
    let output_path = optional_text_field_or_default(
        object,
        "outputPath",
        "output_path",
        "camera",
        260,
        format!("captures/{id}"),
    )?;

    Ok(db::CameraConfigInput {
        id,
        name,
        ip,
        driver_id,
        model_hint,
        role,
        enabled,
        trigger_mode,
        exposure_us,
        gain,
        depth_lines,
        output_path,
    })
}

fn write_admin_camera_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(payload) => payload,
        Err(_) => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                "{\"code\":400,\"error\":\"invalid camera config json\"}",
            );
        }
    };
    let input = match camera_config_input_from_value(&payload) {
        Ok(input) => input,
        Err(detail) => {
            let target =
                json_text_field(&payload, "id", "id").unwrap_or_else(|| "camera".to_string());
            return reject_invalid_camera_config(state, actor, &target, &detail);
        }
    };
    let id = input.id.clone();
    let name = input.name.clone();
    let ip = input.ip.clone();

    match state
        .runtime
        .block_on(db::save_camera_config(&state.database.connection, input))
    {
        Ok(camera) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "camera_config.save",
                &id,
                &format!("保存相机配置 {} / {}", name, ip),
                "info",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "camera": {
                        "id": camera.id,
                        "name": camera.name,
                        "ip": camera.ip,
                        "driverId": camera.driver_id,
                        "modelHint": camera.model_hint,
                        "role": camera.role,
                        "enabled": camera.enabled,
                        "triggerMode": camera.trigger_mode,
                        "exposureUs": camera.exposure_us,
                        "gain": camera.gain,
                        "depthLines": camera.depth_lines,
                        "outputPath": camera.output_path
                    }
                })
                .to_string(),
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn delete_admin_camera_response(state: &ServiceState, query: &str, actor: &str) -> Vec<u8> {
    let Some(id) = query_value(query, "id").filter(|value| !value.trim().is_empty()) else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"camera id required\"}",
        );
    };

    let camera = match state
        .runtime
        .block_on(db::find_camera_config(&state.database.connection, &id))
    {
        Ok(Some(camera)) => camera,
        Ok(None) => {
            return http_response(
                "404 Not Found",
                "application/json; charset=utf-8",
                "{\"code\":404,\"error\":\"camera config not found\"}",
            );
        }
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };

    match state
        .runtime
        .block_on(db::delete_camera_config(&state.database.connection, &id))
    {
        Ok(true) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "camera_config.delete",
                &id,
                &format!("删除相机配置 {} / {}", camera.name, camera.ip),
                "warning",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({ "code": 0, "deleted": true, "id": id }).to_string(),
            )
        }
        Ok(false) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"code\":404,\"error\":\"camera config not found\"}",
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn read_admin_defect_types_response(state: &ServiceState) -> Vec<u8> {
    match state
        .runtime
        .block_on(db::list_defect_types(&state.database.connection))
    {
        Ok(defect_types) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &defect_types_json(defect_types),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn is_valid_defect_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.chars().skip(1).all(|ch| ch.is_ascii_hexdigit())
}

fn is_valid_defect_shape(value: &str) -> bool {
    matches!(value, "circle" | "square" | "rect" | "diamond" | "star")
}

fn defect_type_input_from_value(payload: &Value) -> Result<db::DefectTypeInput, String> {
    let object = object_value(payload, "defectType")?;
    let id = validate_text_field(object, "id", "id", "defectType", 64)?;
    validate_admin_identifier(&id, "defectType.id")?;
    let label = validate_text_field(object, "label", "label", "defectType", 64)?;
    let color = optional_text_field_or_default(
        object,
        "color",
        "color",
        "defectType",
        16,
        "#2f6bff".to_string(),
    )?;
    if !is_valid_defect_color(&color) {
        return Err("defectType.color 必须是 #RRGGBB 十六进制颜色".to_string());
    }
    let shape = optional_text_field_or_default(
        object,
        "shape",
        "shape",
        "defectType",
        32,
        "circle".to_string(),
    )?;
    if !is_valid_defect_shape(&shape) {
        return Err("defectType.shape 必须是 circle/square/rect/diamond/star".to_string());
    }
    Ok(db::DefectTypeInput {
        id,
        label,
        color,
        shape,
    })
}

fn write_admin_defect_type_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(payload) => payload,
        Err(_) => {
            return reject_admin_validation(
                state,
                actor,
                "defect_type.validation.failed",
                "defect_type",
                "invalid defect type json",
                "defectType 请求体不是合法 JSON",
            );
        }
    };
    let input = match defect_type_input_from_value(&payload) {
        Ok(input) => input,
        Err(detail) => {
            let target =
                json_text_field(&payload, "id", "id").unwrap_or_else(|| "defect_type".to_string());
            return reject_admin_validation(
                state,
                actor,
                "defect_type.validation.failed",
                &target,
                "invalid defect type",
                &detail,
            );
        }
    };
    let id = input.id.clone();
    let label = input.label.clone();

    match state
        .runtime
        .block_on(db::save_defect_type(&state.database.connection, input))
    {
        Ok(defect_type) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "defect_type.save",
                &id,
                &format!("保存缺陷类型 {} / {}", label, defect_type.shape),
                "info",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "defectType": {
                        "id": defect_type.id,
                        "label": defect_type.label,
                        "color": defect_type.color,
                        "shape": defect_type.shape
                    }
                })
                .to_string(),
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn delete_admin_defect_type_response(state: &ServiceState, query: &str, actor: &str) -> Vec<u8> {
    let Some(id) = query_value(query, "id").filter(|value| !value.trim().is_empty()) else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"defect type id required\"}",
        );
    };

    let defect_type = match state
        .runtime
        .block_on(db::find_defect_type(&state.database.connection, &id))
    {
        Ok(Some(defect_type)) => defect_type,
        Ok(None) => {
            return http_response(
                "404 Not Found",
                "application/json; charset=utf-8",
                "{\"code\":404,\"error\":\"defect type not found\"}",
            );
        }
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };

    match state
        .runtime
        .block_on(db::count_defects_by_type(&state.database.connection, &id))
    {
        Ok(count) if count > 0 => {
            return reject_admin_operation(
                state,
                actor,
                "defect_type.delete.rejected",
                &id,
                &format!("拒绝删除仍被 {count} 条缺陷引用的缺陷类型"),
                "409 Conflict",
                409,
                "defect type is still assigned to defects",
            );
        }
        Ok(_) => {}
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    }

    match state
        .runtime
        .block_on(db::delete_defect_type(&state.database.connection, &id))
    {
        Ok(true) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "defect_type.delete",
                &id,
                &format!("删除缺陷类型 {} / {}", defect_type.label, defect_type.shape),
                "warning",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({ "code": 0, "deleted": true, "id": id }).to_string(),
            )
        }
        Ok(false) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"code\":404,\"error\":\"defect type not found\"}",
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn read_admin_users_response(state: &ServiceState) -> Vec<u8> {
    match state
        .runtime
        .block_on(db::list_admin_users(&state.database.connection))
    {
        Ok(users) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &admin_users_json(users),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn read_admin_roles_response(state: &ServiceState) -> Vec<u8> {
    match state
        .runtime
        .block_on(db::list_admin_roles(&state.database.connection))
    {
        Ok(roles) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &admin_roles_json(roles),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn read_admin_permissions_response() -> Vec<u8> {
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &admin_permissions_json(),
    )
}

fn delete_admin_user_response(state: &ServiceState, query: &str, actor: &str) -> Vec<u8> {
    let Some(id) = query_value(query, "id").filter(|value| !value.trim().is_empty()) else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"admin user id required\"}",
        );
    };

    let user = match state
        .runtime
        .block_on(db::find_admin_user(&state.database.connection, &id))
    {
        Ok(Some(user)) => user,
        Ok(None) => {
            return http_response(
                "404 Not Found",
                "application/json; charset=utf-8",
                "{\"code\":404,\"error\":\"admin user not found\"}",
            );
        }
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };

    if user.id == actor {
        return reject_admin_operation(
            state,
            actor,
            "admin_user.delete.rejected",
            &id,
            "拒绝删除当前登录账号",
            "400 Bad Request",
            400,
            "cannot delete current user",
        );
    }
    if user.role == "administrator" && user.status == "active" {
        match state.runtime.block_on(db::count_admin_users_by_role(
            &state.database.connection,
            "administrator",
            Some("active"),
        )) {
            Ok(count) if count <= 1 => {
                return reject_admin_operation(
                    state,
                    actor,
                    "admin_user.delete.rejected",
                    &id,
                    "拒绝删除最后一个启用管理员",
                    "409 Conflict",
                    409,
                    "cannot delete last active administrator",
                );
            }
            Ok(_) => {}
            Err(error) => {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
                );
            }
        }
    }

    match state
        .runtime
        .block_on(db::delete_admin_user(&state.database.connection, &id))
    {
        Ok(true) => {
            invalidate_user_sessions(state, &id);
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "admin_user.delete",
                &id,
                &format!("删除后台账号 {} / {}", user.display_name, user.role),
                "warning",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({ "code": 0, "deleted": true, "id": id }).to_string(),
            )
        }
        Ok(false) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"code\":404,\"error\":\"admin user not found\"}",
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn delete_admin_role_response(state: &ServiceState, query: &str, actor: &str) -> Vec<u8> {
    let Some(id) = query_value(query, "id").filter(|value| !value.trim().is_empty()) else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"role id required\"}",
        );
    };

    let role = match state
        .runtime
        .block_on(db::find_admin_role(&state.database.connection, &id))
    {
        Ok(Some(role)) => role,
        Ok(None) => {
            return http_response(
                "404 Not Found",
                "application/json; charset=utf-8",
                "{\"code\":404,\"error\":\"role not found\"}",
            );
        }
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };

    match state.runtime.block_on(db::count_admin_users_by_role(
        &state.database.connection,
        &id,
        None,
    )) {
        Ok(count) if count > 0 => {
            return reject_admin_operation(
                state,
                actor,
                "admin_role.delete.rejected",
                &id,
                "拒绝删除仍分配给账号的角色",
                "409 Conflict",
                409,
                "role is still assigned to users",
            );
        }
        Ok(_) => {}
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    }

    match state
        .runtime
        .block_on(db::delete_admin_role(&state.database.connection, &id))
    {
        Ok(true) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "admin_role.delete",
                &id,
                &format!("删除角色权限 {} / {}", role.label, role.status),
                "warning",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({ "code": 0, "deleted": true, "id": id }).to_string(),
            )
        }
        Ok(false) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"code\":404,\"error\":\"role not found\"}",
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn write_admin_role_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(payload) => payload,
        Err(_) => {
            return reject_admin_role_validation(
                state,
                actor,
                "role",
                "invalid role json",
                "role 请求体不是合法 JSON",
            );
        }
    };
    let Some(id) = json_text_field(&payload, "id", "id") else {
        return reject_admin_role_validation(
            state,
            actor,
            "role",
            "role id required",
            "role.id 不能为空",
        );
    };
    if let Err(detail) = validate_admin_identifier(&id, "role.id") {
        return reject_admin_role_validation(state, actor, &id, "invalid role id", &detail);
    }
    let Some(label) = json_text_field(&payload, "label", "label") else {
        return reject_admin_role_validation(
            state,
            actor,
            &id,
            "role label required",
            "role.label 不能为空",
        );
    };
    if let Err(detail) = validate_admin_text(&label, "role.label", ADMIN_LABEL_MAX_LEN) {
        return reject_admin_role_validation(state, actor, &id, "invalid role label", &detail);
    }
    let description = json_text_field(&payload, "description", "description").unwrap_or_default();
    if !description.is_empty() {
        if let Err(detail) =
            validate_admin_text(&description, "role.description", ADMIN_DESCRIPTION_MAX_LEN)
        {
            return reject_admin_role_validation(
                state,
                actor,
                &id,
                "invalid role description",
                &detail,
            );
        }
    }
    let status =
        json_text_field(&payload, "status", "status").unwrap_or_else(|| "active".to_string());
    if !matches!(status.as_str(), "active" | "disabled") {
        return reject_admin_role_validation(
            state,
            actor,
            &id,
            "invalid role status",
            "role.status 必须是 active 或 disabled",
        );
    }
    let permissions = match role_permissions_from_value(&payload) {
        Ok(permissions) => permissions,
        Err(detail) => {
            return reject_admin_role_validation(
                state,
                actor,
                &id,
                "invalid role permission",
                &detail,
            );
        }
    };
    let permissions_json = match serde_json::to_string(&permissions) {
        Ok(value) => value,
        Err(_) => "[]".to_string(),
    };

    let existing_role = match state
        .runtime
        .block_on(db::find_admin_role(&state.database.connection, &id))
    {
        Ok(role) => role,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };
    if status != "active" {
        match state.runtime.block_on(db::count_admin_users_by_role(
            &state.database.connection,
            &id,
            Some("active"),
        )) {
            Ok(count) if count > 0 => {
                return reject_admin_operation(
                    state,
                    actor,
                    "admin_role.save.rejected",
                    &id,
                    "拒绝停用仍分配给启用账号的角色",
                    "409 Conflict",
                    409,
                    "role is assigned to active users",
                );
            }
            Ok(_) => {}
            Err(error) => {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
                );
            }
        }
    }
    let actor_role = state
        .runtime
        .block_on(db::find_admin_user(&state.database.connection, actor))
        .ok()
        .flatten()
        .map(|user| user.role);
    if actor_role.as_deref() == Some(id.as_str())
        && (status != "active"
            || !permissions
                .iter()
                .any(|permission| permission == "admin.roles"))
    {
        return reject_admin_operation(
            state,
            actor,
            "admin_role.save.rejected",
            &id,
            "拒绝移除当前角色的角色权限管理权限",
            "400 Bad Request",
            400,
            "cannot remove current role management permission",
        );
    }
    let should_invalidate_role_sessions = existing_role
        .as_ref()
        .map(|role| role.status != status || role.permissions != permissions_json)
        .unwrap_or(false);

    match state.runtime.block_on(db::save_admin_role(
        &state.database.connection,
        db::AdminRoleInput {
            id: id.clone(),
            label: label.clone(),
            description,
            permissions: permissions_json,
            status: status.clone(),
        },
    )) {
        Ok(role) => {
            if should_invalidate_role_sessions {
                invalidate_role_sessions(state, &id);
            }
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "admin_role.save",
                &id,
                &format!("保存角色权限 {} / {}", label, status),
                "info",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "role": {
                        "id": role.id,
                        "label": role.label,
                        "description": role.description,
                        "permissions": role_permissions_value(&role.permissions),
                        "status": role.status,
                        "updatedAt": role.updated_at
                    }
                })
                .to_string(),
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn write_admin_user_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(payload) => payload,
        Err(_) => {
            return reject_admin_user_validation(
                state,
                actor,
                "admin-user",
                "invalid admin user json",
                "adminUser 请求体不是合法 JSON",
            );
        }
    };
    let Some(id) = json_text_field(&payload, "id", "id") else {
        return reject_admin_user_validation(
            state,
            actor,
            "admin-user",
            "admin user id required",
            "adminUser.id 不能为空",
        );
    };
    if let Err(detail) = validate_admin_identifier(&id, "adminUser.id") {
        return reject_admin_user_validation(state, actor, &id, "invalid admin user id", &detail);
    }
    let Some(display_name) = json_text_field(&payload, "displayName", "display_name") else {
        return reject_admin_user_validation(
            state,
            actor,
            &id,
            "admin user display name required",
            "adminUser.displayName 不能为空",
        );
    };
    if let Err(detail) =
        validate_admin_text(&display_name, "adminUser.displayName", ADMIN_LABEL_MAX_LEN)
    {
        return reject_admin_user_validation(
            state,
            actor,
            &id,
            "invalid admin user display name",
            &detail,
        );
    }
    let role = json_text_field(&payload, "role", "role").unwrap_or_else(|| "operator".to_string());
    let status =
        json_text_field(&payload, "status", "status").unwrap_or_else(|| "active".to_string());
    let last_login_at = json_text_field(&payload, "lastLoginAt", "last_login_at")
        .unwrap_or_else(|| "未登录".to_string());

    let role_exists = state
        .runtime
        .block_on(db::find_admin_role(&state.database.connection, &role))
        .ok()
        .flatten()
        .map(|item| item.status == "active")
        .unwrap_or(false);
    if !role_exists {
        return reject_admin_user_validation(
            state,
            actor,
            &id,
            "invalid admin user role",
            "adminUser.role 必须引用启用角色",
        );
    }
    if !matches!(status.as_str(), "active" | "disabled") {
        return reject_admin_user_validation(
            state,
            actor,
            &id,
            "invalid admin user status",
            "adminUser.status 必须是 active 或 disabled",
        );
    }

    let existing_user = match state
        .runtime
        .block_on(db::find_admin_user(&state.database.connection, &id))
    {
        Ok(user) => user,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };
    if let Some(existing) = existing_user.as_ref() {
        if existing.id == actor && status != "active" {
            return reject_admin_operation(
                state,
                actor,
                "admin_user.save.rejected",
                &id,
                "拒绝停用当前登录账号",
                "400 Bad Request",
                400,
                "cannot disable current user",
            );
        }
        if existing.id == actor && existing.role != role {
            return reject_admin_operation(
                state,
                actor,
                "admin_user.save.rejected",
                &id,
                "拒绝修改当前登录账号角色",
                "400 Bad Request",
                400,
                "cannot change current user role",
            );
        }
        if existing.role == "administrator"
            && existing.status == "active"
            && (role != "administrator" || status != "active")
        {
            match state.runtime.block_on(db::count_admin_users_by_role(
                &state.database.connection,
                "administrator",
                Some("active"),
            )) {
                Ok(count) if count <= 1 => {
                    return reject_admin_operation(
                        state,
                        actor,
                        "admin_user.save.rejected",
                        &id,
                        "拒绝降级或停用最后一个启用管理员",
                        "409 Conflict",
                        409,
                        "cannot demote last active administrator",
                    );
                }
                Ok(_) => {}
                Err(error) => {
                    return http_response(
                        "500 Internal Server Error",
                        "application/json; charset=utf-8",
                        &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
                    );
                }
            }
        }
    }

    let password = payload
        .get("password")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if existing_user.is_none() && password.is_none() {
        return reject_admin_user_validation(
            state,
            actor,
            &id,
            "password required",
            "adminUser.password 不能为空",
        );
    }
    if let Some(password) = password {
        if let Err(error) = validate_admin_password(Some(password)) {
            let (error_code, detail) = match error {
                PasswordPolicyError::Missing => {
                    ("password required", "adminUser.password 不能为空")
                }
                PasswordPolicyError::Length => (
                    "invalid password length",
                    "adminUser.password 长度需为 8-128 位",
                ),
                PasswordPolicyError::Complexity => (
                    "password complexity required",
                    "adminUser.password 需同时包含字母和数字",
                ),
            };
            return reject_admin_user_validation(state, actor, &id, error_code, detail);
        }
    }
    let password_hash = password.map(|password| db::hash_admin_password(&id, password));
    let password_changed = password_hash.is_some();
    let should_invalidate_sessions = id != actor
        && existing_user
            .as_ref()
            .map(|existing| existing.role != role || existing.status != status || password_changed)
            .unwrap_or(false);

    match state.runtime.block_on(db::save_admin_user(
        &state.database.connection,
        db::AdminUserInput {
            id: id.clone(),
            display_name: display_name.clone(),
            role: role.clone(),
            status: status.clone(),
            password_hash,
            last_login_at,
        },
    )) {
        Ok(user) => {
            if should_invalidate_sessions {
                invalidate_user_sessions(state, &id);
            }
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "admin_user.save",
                &id,
                &format!("保存后台账号 {} / {}", display_name, role),
                "info",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "user": {
                        "id": user.id,
                        "displayName": user.display_name,
                        "role": user.role,
                        "status": user.status,
                        "lastLoginAt": user.last_login_at,
                        "createdAt": user.created_at
                    }
                })
                .to_string(),
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn read_audit_logs_response(state: &ServiceState, query: &str) -> Vec<u8> {
    let limit = query_value(query, "limit")
        .and_then(|value| value.parse::<u64>().ok())
        .map(|value| value.clamp(1, 200));
    let offset = query_value(query, "offset")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let filter = db::AuditLogFilter {
        keyword: query_value(query, "keyword"),
        level: query_value(query, "level"),
        limit,
        offset: Some(offset),
    };
    match state
        .runtime
        .block_on(db::list_audit_logs_page(&state.database.connection, filter))
    {
        Ok(page) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &audit_log_page_json(page),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn read_audit_export_response(state: &ServiceState, query: &str, actor: &str) -> Vec<u8> {
    let keyword = query_value(query, "keyword");
    let level = query_value(query, "level");
    let filter = db::AuditLogFilter {
        keyword: keyword.clone(),
        level: level.clone(),
        limit: None,
        offset: None,
    };
    match state.runtime.block_on(db::export_audit_logs(
        &state.database.connection,
        filter,
        ADMIN_EXPORT_MAX_ROWS,
    )) {
        Ok(logs) => {
            let csv = audit_logs_csv(&logs);
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "audit.export",
                "audit_log",
                &export_audit_detail(
                    logs.len(),
                    ADMIN_EXPORT_MAX_ROWS,
                    keyword.as_deref(),
                    level.as_deref(),
                ),
                "info",
            ));
            http_response_with_headers(
                "200 OK",
                "text/csv; charset=utf-8",
                &csv,
                &[(
                    "Content-Disposition",
                    "attachment; filename=\"steel-inspection-audit.csv\"",
                )],
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn apply_audit_retention_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(payload) => payload,
        Err(_) => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                "{\"code\":400,\"error\":\"invalid audit retention json\"}",
            );
        }
    };
    let Some(retention_days) = payload
        .get("retentionDays")
        .or_else(|| payload.get("retention_days"))
        .and_then(Value::as_u64)
    else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"audit retention days required\"}",
        );
    };
    if !(ADMIN_AUDIT_RETENTION_MIN_DAYS..=ADMIN_AUDIT_RETENTION_MAX_DAYS).contains(&retention_days)
    {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"invalid audit retention days\"}",
        );
    }

    let dry_run = payload
        .get("dryRun")
        .or_else(|| payload.get("dry_run"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let cutoff_at = audit_retention_cutoff(current_time_millis(), retention_days);
    let matched = match state.runtime.block_on(db::count_audit_logs_before(
        &state.database.connection,
        &cutoff_at,
    )) {
        Ok(count) => count,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };
    let deleted = if dry_run {
        0
    } else {
        match state.runtime.block_on(db::delete_audit_logs_before(
            &state.database.connection,
            &cutoff_at,
        )) {
            Ok(count) => count,
            Err(error) => {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
                );
            }
        }
    };

    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        if dry_run {
            "audit.retention.preview"
        } else {
            "audit.retention.purge"
        },
        "audit_log",
        &audit_retention_detail(retention_days, &cutoff_at, matched, deleted, dry_run),
        if dry_run { "info" } else { "warning" },
    ));

    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({
            "code": 0,
            "retentionDays": retention_days,
            "cutoffAt": cutoff_at,
            "matched": matched,
            "deleted": deleted,
            "dryRun": dry_run
        })
        .to_string(),
    )
}

fn read_security_policy_response(state: &ServiceState) -> Vec<u8> {
    match state.runtime.block_on(db::get_config(
        &state.database.connection,
        SECURITY_POLICY_CONFIG_KEY,
    )) {
        Ok(Some(config)) => {
            let policy =
                parse_security_policy(&config.value).unwrap_or_else(default_security_policy);
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &security_policy_response_json(&policy, "database"),
            )
        }
        Ok(None) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &security_policy_response_json(&default_security_policy(), "default"),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn write_security_policy_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(payload) => payload,
        Err(_) => {
            return reject_admin_validation(
                state,
                actor,
                "security_policy.validation.failed",
                SECURITY_POLICY_CONFIG_KEY,
                "invalid security policy json",
                "securityPolicy 请求体不是合法 JSON",
            );
        }
    };
    let policy = match validate_security_policy_value(&payload) {
        Ok(policy) => policy,
        Err(detail) => {
            return reject_admin_validation(
                state,
                actor,
                "security_policy.validation.failed",
                SECURITY_POLICY_CONFIG_KEY,
                "invalid security policy",
                &detail,
            );
        }
    };
    let value = security_policy_value(&policy).to_string();
    if let Err(error) = state.runtime.block_on(db::set_config(
        &state.database.connection,
        SECURITY_POLICY_CONFIG_KEY,
        &value,
    )) {
        return http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        );
    }
    let revision = state
        .runtime
        .block_on(db::append_config_revision(
            &state.database.connection,
            SECURITY_POLICY_CONFIG_KEY,
            &value,
            actor,
            "save",
        ))
        .ok();
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        "security.policy.save",
        SECURITY_POLICY_CONFIG_KEY,
        &format!(
            "保存安全策略：审计日志保留 {} 天，登录失败 {} 次锁定 {} 分钟，会话 {} 小时",
            policy.audit_retention_days,
            policy.login_max_failures,
            policy.login_lockout_minutes,
            policy.session_ttl_hours
        ),
        "info",
    ));

    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({
            "code": 0,
            "policy": security_policy_value(&policy),
            "source": "database",
            "revisionId": revision.map(|item| item.id)
        })
        .to_string(),
    )
}

fn read_admin_records_response(state: &ServiceState, query: &str) -> Vec<u8> {
    let limit = query_value(query, "limit")
        .and_then(|value| value.parse::<u64>().ok())
        .map(|value| value.clamp(1, 100));
    let offset = query_value(query, "offset")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let filter = db::InspectionRecordFilter {
        keyword: query_value(query, "keyword"),
        status: query_value(query, "status"),
        limit,
        offset: Some(offset),
    };
    match state.runtime.block_on(db::list_inspection_records(
        &state.database.connection,
        filter,
    )) {
        Ok(page) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &inspection_records_json(page),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn read_admin_record_detail_response(state: &ServiceState, query: &str) -> Vec<u8> {
    let Some(id) = query_value(query, "id").map(|value| value.trim().to_string()) else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"record id required\"}",
        );
    };
    if id.is_empty() {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"record id required\"}",
        );
    }
    match state.runtime.block_on(db::find_inspection_record_detail(
        &state.database.connection,
        &id,
    )) {
        Ok(Some(detail)) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &inspection_record_detail_json(detail),
        ),
        Ok(None) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"code\":404,\"error\":\"record not found\"}",
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn read_admin_records_export_response(state: &ServiceState, query: &str, actor: &str) -> Vec<u8> {
    let keyword = query_value(query, "keyword");
    let status = query_value(query, "status");
    let filter = db::InspectionRecordFilter {
        keyword: keyword.clone(),
        status: status.clone(),
        limit: None,
        offset: None,
    };
    match state.runtime.block_on(db::export_inspection_records(
        &state.database.connection,
        filter,
        ADMIN_EXPORT_MAX_ROWS,
    )) {
        Ok(records) => {
            let csv = inspection_records_csv(&records);
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "record.export",
                "inspection_record",
                &export_records_detail(
                    records.len(),
                    ADMIN_EXPORT_MAX_ROWS,
                    keyword.as_deref(),
                    status.as_deref(),
                ),
                "info",
            ));
            http_response_with_headers(
                "200 OK",
                "text/csv; charset=utf-8",
                &csv,
                &[(
                    "Content-Disposition",
                    "attachment; filename=\"steel-inspection-records.csv\"",
                )],
            )
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn apply_record_retention_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(payload) => payload,
        Err(_) => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                "{\"code\":400,\"error\":\"invalid record retention json\"}",
            );
        }
    };
    let Some(retention_days) = payload
        .get("retentionDays")
        .or_else(|| payload.get("retention_days"))
        .and_then(Value::as_u64)
    else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"record retention days required\"}",
        );
    };
    if !(ADMIN_RECORD_RETENTION_MIN_DAYS..=ADMIN_RECORD_RETENTION_MAX_DAYS)
        .contains(&retention_days)
    {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"invalid record retention days\"}",
        );
    }
    let dry_run = payload
        .get("dryRun")
        .or_else(|| payload.get("dry_run"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let cutoff_at = match state
        .runtime
        .block_on(db::inspection_record_retention_cutoff(
            &state.database.connection,
            retention_days,
        )) {
        Ok(cutoff_at) => cutoff_at,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };

    let result = if dry_run {
        match state.runtime.block_on(db::count_inspection_records_before(
            &state.database.connection,
            retention_days,
        )) {
            Ok(matched) => db::InspectionRecordRetentionResult {
                matched,
                deleted_records: 0,
                deleted_defects: 0,
                deleted_plates: 0,
            },
            Err(error) => {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
                );
            }
        }
    } else {
        match state.runtime.block_on(db::delete_inspection_records_before(
            &state.database.connection,
            retention_days,
        )) {
            Ok(result) => result,
            Err(error) => {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
                );
            }
        }
    };

    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        if dry_run {
            "record.retention.preview"
        } else {
            "record.retention.purge"
        },
        "inspection_record",
        &record_retention_detail(
            retention_days,
            &cutoff_at,
            result.matched,
            result.deleted_records,
            result.deleted_defects,
            result.deleted_plates,
            dry_run,
        ),
        if dry_run { "info" } else { "warning" },
    ));

    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({
            "code": 0,
            "retentionDays": retention_days,
            "cutoffAt": cutoff_at,
            "matched": result.matched,
            "deletedRecords": result.deleted_records,
            "deletedDefects": result.deleted_defects,
            "deletedPlates": result.deleted_plates,
            "dryRun": dry_run
        })
        .to_string(),
    )
}

fn delete_admin_record_response(state: &ServiceState, query: &str, actor: &str) -> Vec<u8> {
    let Some(id) = query_value(query, "id").map(|value| value.trim().to_string()) else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"record id required\"}",
        );
    };
    if id.is_empty() {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"record id required\"}",
        );
    }
    match state.runtime.block_on(db::delete_inspection_record(
        &state.database.connection,
        &id,
    )) {
        Ok(Some(result)) => {
            let detail = format!(
                "删除检测记录 {}，板号 {}，同步删除缺陷 {} 条，钢板档案{}",
                result.id,
                result.plate_no,
                result.defects_deleted,
                if result.plate_deleted {
                    "已删除"
                } else {
                    "保留"
                }
            );
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "record.delete",
                &result.id,
                &detail,
                "warning",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "deleted": true,
                    "recordId": result.id,
                    "plateNo": result.plate_no,
                    "defectsDeleted": result.defects_deleted,
                    "plateDeleted": result.plate_deleted
                })
                .to_string(),
            )
        }
        Ok(None) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"code\":404,\"error\":\"record not found\"}",
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn admin_overview_response(state: &ServiceState) -> Vec<u8> {
    let overview = match state
        .runtime
        .block_on(db::load_admin_overview(&state.database.connection))
    {
        Ok(overview) => overview,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
            );
        }
    };

    let capture_status = serde_json::from_str::<Value>(&state.capture.status_json())
        .unwrap_or_else(|_| {
            json!({
                "name": "capture-service",
                "managed": true,
                "running": false,
                "fallback": "simulated-six-camera"
            })
        });
    let service_port = env::var("INSPECTION_SERVICE_PORT").unwrap_or_else(|_| "4873".to_string());
    let database_path = state.database.display_path();
    let config_dir = state
        .database
        .file_path
        .as_ref()
        .and_then(|path| path.parent())
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let metrics = overview.metrics;
    let body = json!({
        "updatedAt": current_time_string(),
        "service": {
            "name": "steel-inspection-service",
            "role": "api-config-capture-orchestrator",
            "language": "rust",
            "running": true,
            "port": service_port,
            "capture": capture_status
        },
        "database": {
            "engine": state.database.engine.clone(),
            "orm": "sea-orm",
            "path": database_path,
            "configDir": config_dir,
            "tables": [
                { "name": "steel_plate", "label": "钢板档案", "rows": metrics.plate_count },
                { "name": "defect", "label": "缺陷明细", "rows": metrics.defect_count },
                { "name": "defect_type", "label": "缺陷类型", "rows": metrics.defect_type_count },
                { "name": "inspection_record", "label": "检测记录", "rows": metrics.record_count },
                { "name": "camera_config", "label": "相机配置", "rows": metrics.camera_count },
                { "name": "app_config", "label": "系统配置", "rows": metrics.config_count },
                { "name": "config_revision", "label": "配置版本", "rows": metrics.config_revision_count },
                { "name": "admin_user", "label": "后台账号", "rows": metrics.user_count },
                { "name": "admin_role", "label": "角色权限", "rows": metrics.role_count },
                { "name": "audit_log", "label": "审计日志", "rows": metrics.audit_log_count }
                ,
                { "name": "material_session", "label": "material session", "rows": metrics.material_session_count },
                { "name": "secondary_data", "label": "secondary data", "rows": metrics.secondary_data_count },
                { "name": "trigger_event", "label": "trigger event", "rows": metrics.trigger_event_count },
                { "name": "production_inspection", "label": "production inspection", "rows": metrics.production_inspection_count },
                { "name": "capture_file", "label": "capture file", "rows": metrics.capture_file_count },
                { "name": "production_defect", "label": "production defect", "rows": metrics.production_defect_count }
            ]
        },
        "configs": overview.configs.iter().map(|config| {
            json!({
                "key": &config.key,
                "updatedAt": &config.updated_at,
                "bytes": config.value.len()
            })
        }).collect::<Vec<_>>(),
        "users": overview.users.iter().map(|user| {
            json!({
                "id": &user.id,
                "displayName": &user.display_name,
                "role": &user.role,
                "status": &user.status,
                "lastLoginAt": &user.last_login_at
            })
        }).collect::<Vec<_>>(),
        "roles": overview.roles.iter().map(|role| {
            json!({
                "id": &role.id,
                "label": &role.label,
                "description": &role.description,
                "permissions": role_permissions_value(&role.permissions),
                "status": &role.status,
                "updatedAt": &role.updated_at
            })
        }).collect::<Vec<_>>(),
        "auditLogs": overview.audit_logs.iter().map(|entry| {
            json!({
                "id": &entry.id,
                "actor": &entry.actor,
                "action": &entry.action,
                "target": &entry.target,
                "detail": &entry.detail,
                "level": &entry.level,
                "createdAt": &entry.created_at
            })
        }).collect::<Vec<_>>(),
        "apiRoutes": [
            { "method": "GET", "path": "/api/health", "scope": "service" },
            { "method": "GET", "path": "/api/services", "scope": "service" },
            { "method": "POST", "path": "/api/admin/auth/login", "scope": "auth" },
            { "method": "GET", "path": "/api/admin/auth/me", "scope": "auth" },
            { "method": "POST", "path": "/api/admin/auth/logout", "scope": "auth" },
            { "method": "POST", "path": "/api/admin/auth/password", "scope": "auth" },
            { "method": "GET", "path": "/api/admin/auth/sessions", "scope": "auth" },
            { "method": "DELETE", "path": "/api/admin/auth/sessions", "scope": "auth" },
            { "method": "GET", "path": "/api/admin/services", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/diagnostics", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/services/capture/start", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/services/capture/stop", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/services/capture/restart", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/overview", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/users", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/users", "scope": "admin" },
            { "method": "DELETE", "path": "/api/admin/users", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/roles", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/permissions", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/roles", "scope": "admin" },
            { "method": "DELETE", "path": "/api/admin/roles", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/cameras", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/cameras", "scope": "admin" },
            { "method": "DELETE", "path": "/api/admin/cameras", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/defect-types", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/defect-types", "scope": "admin" },
            { "method": "DELETE", "path": "/api/admin/defect-types", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/config/revisions", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/config/revisions/detail", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/config/revisions/restore", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/inspection-settings", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/inspection-settings", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/alarm-rules", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/alarm-rules", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/external-integrations", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/external-integrations", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/audit", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/audit/export", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/audit/retention", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/security/policy", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/security/policy", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/records", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/records/detail", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/records/export", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/records/retention", "scope": "admin" },
            { "method": "DELETE", "path": "/api/admin/records", "scope": "admin" },
            { "method": "GET", "path": "/api/database", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/database/backup", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/database/integrity", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/database/maintenance", "scope": "admin" },
            { "method": "GET", "path": "/api/config", "scope": "config" },
            { "method": "GET", "path": "/api/config/connection", "scope": "config" },
            { "method": "POST", "path": "/api/config/connection", "scope": "config" },
            { "method": "GET", "path": "/api/config/capture", "scope": "config" },
            { "method": "POST", "path": "/api/config/capture", "scope": "config" },
            { "method": "GET", "path": "/api/inspection/settings", "scope": "inspection" },
            { "method": "GET", "path": "/api/inspection/snapshot", "scope": "inspection" },
            { "method": "GET", "path": "/api/production/status", "scope": "production" },
            { "method": "POST", "path": "/api/production/steel-info", "scope": "production" },
            { "method": "POST", "path": "/api/production/steel-in", "scope": "production" },
            { "method": "POST", "path": "/api/production/steel-out", "scope": "production" },
            { "method": "POST", "path": "/api/production/trigger-event", "scope": "production" },
            { "method": "POST", "path": "/api/production/secondary-data", "scope": "production" },
            { "method": "POST", "path": "/api/production/capture-summary", "scope": "production" },
            { "method": "POST", "path": "/api/production/capture-once", "scope": "production" },
            { "method": "POST", "path": "/api/production/defect", "scope": "production" },
            { "method": "GET", "path": "/api/steel/status", "scope": "capture" },
            { "method": "POST", "path": "/api/steel/event", "scope": "capture" },
            { "method": "GET", "path": "/api/camera/statuses", "scope": "capture" }
        ]
    });

    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &body.to_string(),
    )
}

fn handle_client(mut stream: TcpStream, state: Arc<ServiceState>) {
    let request = match read_http_request(&mut stream) {
        Some(request) => request,
        None => return,
    };
    let mut parts = request
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    let method = parts.next().unwrap_or_default();
    let raw_path = parts.next().unwrap_or_default();
    let (path, query) = split_path_and_query(raw_path);
    let body = request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or_default();
    if !request_origin_allowed(&request, method) {
        append_origin_audit(&state, &request, method, path);
        let _ = stream.write_all(&auth_failure("403 Forbidden", 403, "origin_not_allowed"));
        return;
    }
    let authorized_session = match authorize_request(&state, &request, method, path) {
        Ok(session) => session,
        Err(response) => {
            let _ = stream.write_all(&response);
            return;
        }
    };
    let actor = authorized_session
        .as_ref()
        .map(|session| session.user_id.as_str())
        .unwrap_or("admin");
    let response = match (method, path) {
        ("OPTIONS", _) => http_response("204 No Content", "application/json; charset=utf-8", ""),
        ("GET", "/api/health") => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            "{\"ok\":true,\"service\":\"steel-inspection-service\",\"language\":\"rust\"}",
        ),
        ("GET", "/api/services") => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &format!(
                "{{\"api\":{{\"name\":\"steel-inspection-service\",\"running\":true,\"port\":{}}},\"capture\":{}}}",
                env::var("INSPECTION_SERVICE_PORT").unwrap_or_else(|_| "4873".to_string()),
                state.capture.status_json()
            ),
        ),
        ("POST", "/api/admin/auth/login") => write_auth_login_response(&state, &request, body),
        ("GET", "/api/admin/auth/me") => read_auth_me_response(&state, &request),
        ("POST", "/api/admin/auth/logout") => write_auth_logout_response(&state, &request),
        ("POST", "/api/admin/auth/password") => {
            write_auth_password_response(&state, &request, body)
        }
        ("GET", "/api/admin/auth/sessions") => read_auth_sessions_response(&state, &request),
        ("DELETE", "/api/admin/auth/sessions") => {
            delete_auth_session_response(&state, &request, query)
        }
        ("GET", "/api/admin/services") => read_admin_services_response(&state),
        ("GET", "/api/admin/diagnostics") => read_admin_diagnostics_response(&state),
        ("POST", "/api/admin/services/capture/start") => start_capture_service_response(&state, actor),
        ("POST", "/api/admin/services/capture/stop") => stop_capture_service_response(&state, actor),
        ("POST", "/api/admin/services/capture/restart") => {
            restart_capture_service_response(&state, actor)
        }
        ("GET", "/api/config") | ("GET", "/api/config/capture") => read_config_response(&state),
        ("POST", "/api/config/capture") => write_config_response(&state, body, actor),
        ("GET", "/api/config/connection") => read_connection_response(&state),
        ("POST", "/api/config/connection") => write_connection_response(&state, body, actor),
        ("GET", "/api/inspection/settings") | ("GET", "/api/admin/inspection-settings") => {
            read_inspection_settings_response(&state)
        }
        ("POST", "/api/admin/inspection-settings") => {
            write_inspection_settings_response(&state, body, actor)
        }
        ("GET", "/api/admin/alarm-rules") => read_alarm_rules_response(&state),
        ("POST", "/api/admin/alarm-rules") => write_alarm_rules_response(&state, body, actor),
        ("GET", "/api/admin/external-integrations") => read_external_integrations_response(&state),
        ("POST", "/api/admin/external-integrations") => {
            write_external_integrations_response(&state, body, actor)
        }
        ("GET", "/api/admin/config/revisions") => read_config_revisions_response(&state, query),
        ("GET", "/api/admin/config/revisions/detail") => {
            read_config_revision_detail_response(&state, query)
        }
        ("POST", "/api/admin/config/revisions/restore") => {
            restore_config_revision_response(&state, body, actor)
        }
        ("GET", "/api/admin/database/backup") => database_backup_response(&state, actor),
        ("GET", "/api/admin/database/integrity") => database_integrity_response(&state, actor),
        ("POST", "/api/admin/database/maintenance") => {
            database_maintenance_response(&state, actor)
        }
        ("GET", "/api/database") => database_info_response(&state),
        ("GET", "/api/admin/overview") => admin_overview_response(&state),
        ("GET", "/api/admin/users") => read_admin_users_response(&state),
        ("POST", "/api/admin/users") => write_admin_user_response(&state, body, actor),
        ("DELETE", "/api/admin/users") => delete_admin_user_response(&state, query, actor),
        ("GET", "/api/admin/roles") => read_admin_roles_response(&state),
        ("GET", "/api/admin/permissions") => read_admin_permissions_response(),
        ("POST", "/api/admin/roles") => write_admin_role_response(&state, body, actor),
        ("DELETE", "/api/admin/roles") => delete_admin_role_response(&state, query, actor),
        ("GET", "/api/admin/cameras") => read_admin_cameras_response(&state),
        ("POST", "/api/admin/cameras") => write_admin_camera_response(&state, body, actor),
        ("DELETE", "/api/admin/cameras") => delete_admin_camera_response(&state, query, actor),
        ("GET", "/api/admin/defect-types") => read_admin_defect_types_response(&state),
        ("POST", "/api/admin/defect-types") => {
            write_admin_defect_type_response(&state, body, actor)
        }
        ("DELETE", "/api/admin/defect-types") => {
            delete_admin_defect_type_response(&state, query, actor)
        }
        ("POST", "/api/admin/audit/retention") => {
            apply_audit_retention_response(&state, body, actor)
        }
        ("GET", "/api/admin/audit/export") => read_audit_export_response(&state, query, actor),
        ("GET", "/api/admin/audit") => read_audit_logs_response(&state, query),
        ("GET", "/api/admin/security/policy") => read_security_policy_response(&state),
        ("POST", "/api/admin/security/policy") => {
            write_security_policy_response(&state, body, actor)
        }
        ("GET", "/api/admin/records/export") => {
            read_admin_records_export_response(&state, query, actor)
        }
        ("GET", "/api/admin/records/detail") => read_admin_record_detail_response(&state, query),
        ("POST", "/api/admin/records/retention") => {
            apply_record_retention_response(&state, body, actor)
        }
        ("DELETE", "/api/admin/records") => delete_admin_record_response(&state, query, actor),
        ("GET", "/api/admin/records") => read_admin_records_response(&state, query),
        ("GET", "/api/production/status") => production_status_response(&state),
        ("POST", "/api/production/steel-info") => {
            write_production_event_response(&state, body, "steel-info", actor)
        }
        ("POST", "/api/production/steel-in") => {
            write_production_event_response(&state, body, "steel-in", actor)
        }
        ("POST", "/api/production/steel-out") => {
            write_production_event_response(&state, body, "steel-out", actor)
        }
        ("POST", "/api/production/trigger-event") => {
            write_production_event_response(&state, body, "trigger-event", actor)
        }
        ("POST", "/api/production/secondary-data") => {
            write_secondary_data_response(&state, body, actor)
        }
        ("POST", "/api/production/capture-summary") => {
            write_capture_summary_response(&state, body, actor)
        }
        ("POST", "/api/production/capture-once") => {
            write_production_capture_once_response(&state, body, actor)
        }
        ("POST", "/api/production/defect") => {
            write_production_defect_response(&state, body, actor)
        }
        ("GET", "/api/inspection/snapshot") => {
            match state
                .runtime
                .block_on(db::load_snapshot(&state.database.connection))
            {
                Ok(snapshot) => http_response(
                    "200 OK",
                    "application/json; charset=utf-8",
                    &build_database_snapshot_json(snapshot),
                ),
                Err(error) => http_response(
                    "200 OK",
                    "application/json; charset=utf-8",
                    &format!(
                        "{}",
                        if state.fallback_snapshot_json.is_empty() {
                            format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string()))
                        } else {
                            (*state.fallback_snapshot_json).clone()
                        }
                    ),
                ),
            }
        }
        ("GET", "/health")
        | ("GET", "/api/capture/health")
        | ("GET", "/api/cameras")
        | ("GET", "/api/camera/status")
        | ("GET", "/api/camera/statuses")
        | ("GET", "/api/steel/status")
        | ("GET", "/api/param")
        | ("POST", "/api/camera/connect")
        | ("POST", "/api/camera/disconnect")
        | ("POST", "/api/steel/event")
        | ("POST", "/api/param")
        | ("POST", "/api/capture/depth-map") => {
            if let Some(body) = state.capture.proxy(method, raw_path, body) {
                http_response(
                    "200 OK",
                    "application/json; charset=utf-8",
                    &String::from_utf8_lossy(&body),
                )
            } else {
                fallback_capture_response(path)
            }
        }
        ("GET", "/api/capture/file") => {
            if let Some(body) = state.capture.proxy(method, raw_path, body) {
                http_bytes_response_with_headers("200 OK", "image/png", &body, &[])
            } else {
                http_response(
                    "404 Not Found",
                    "application/json; charset=utf-8",
                    "{\"error\":\"capture_file_not_found\"}",
                )
            }
        }
        _ => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"error\":\"not_found\"}",
        ),
    };
    let _ = stream.write_all(&response);
}

fn main() -> std::io::Result<()> {
    let port = env::var("INSPECTION_SERVICE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(4873);
    let config_dir = config_dir();
    std::fs::create_dir_all(&config_dir)?;
    let database_path = config_dir.join("steel-inspection.sqlite");
    let runtime = Runtime::new()?;
    let database = runtime
        .block_on(db::open_database(database_path))
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error.to_string()))?;
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(false)?;
    let capture_port = capture_port();
    let capture_manager = Arc::new(CaptureServiceManager::new(capture_port));
    let config_json = runtime
        .block_on(db::get_config(&database.connection, "capture"))
        .ok()
        .flatten()
        .map(|config| config.value)
        .unwrap_or_else(|| build_config_json(capture_port));
    let state = Arc::new(ServiceState {
        fallback_snapshot_json: Arc::new(build_snapshot_json()),
        config_json: Mutex::new(config_json),
        capture: Arc::clone(&capture_manager),
        database,
        runtime,
        sessions: Mutex::new(HashMap::new()),
        login_failures: Mutex::new(HashMap::new()),
        started_at: current_time_millis(),
    });
    println!("steel inspection service listening on http://127.0.0.1:{port}");
    println!(
        "capture provider {} at {}",
        capture_manager.provider.as_str(),
        capture_manager.origin.as_str()
    );
    println!("sqlite config directory {}", config_dir.display());
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let state = Arc::clone(&state);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                handle_client(stream, state);
            }
            Err(error) => eprintln!("failed to accept connection: {error}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_config_reads_require_admin_config_permission() {
        assert_eq!(
            permission_for_route("GET", "/api/config"),
            Some("admin.config")
        );
        assert_eq!(
            permission_for_route("GET", "/api/config/capture"),
            Some("admin.config")
        );
        assert_eq!(
            permission_for_route("POST", "/api/config/capture"),
            Some("admin.config")
        );
    }

    #[test]
    fn audit_retention_route_requires_audit_permission() {
        assert_eq!(
            permission_for_route("POST", "/api/admin/audit/retention"),
            Some("admin.audit")
        );
        assert_eq!(
            permission_for_route("GET", "/api/admin/security/policy"),
            Some("admin.audit")
        );
        assert_eq!(
            permission_for_route("POST", "/api/admin/security/policy"),
            Some("admin.audit")
        );
    }

    #[test]
    fn connection_config_read_remains_public_for_client_bootstrap() {
        assert_eq!(permission_for_route("GET", "/api/config/connection"), None);
        assert_eq!(
            permission_for_route("POST", "/api/config/connection"),
            Some("admin.config")
        );
    }

    #[test]
    fn inspection_settings_routes_split_public_read_and_admin_write() {
        assert_eq!(
            permission_for_route("GET", "/api/inspection/settings"),
            None
        );
        assert_eq!(
            permission_for_route("GET", "/api/admin/inspection-settings"),
            Some("admin.config")
        );
        assert_eq!(
            permission_for_route("POST", "/api/admin/inspection-settings"),
            Some("admin.config")
        );
    }

    #[test]
    fn alarm_rules_routes_require_admin_config_permission() {
        assert_eq!(
            permission_for_route("GET", "/api/admin/alarm-rules"),
            Some("admin.config")
        );
        assert_eq!(
            permission_for_route("POST", "/api/admin/alarm-rules"),
            Some("admin.config")
        );
    }

    #[test]
    fn external_integrations_routes_require_admin_config_permission() {
        assert_eq!(
            permission_for_route("GET", "/api/admin/external-integrations"),
            Some("admin.config")
        );
        assert_eq!(
            permission_for_route("POST", "/api/admin/external-integrations"),
            Some("admin.config")
        );
    }

    #[test]
    fn inspection_settings_validation_matches_operator_rule_bounds() {
        let settings = normalize_inspection_settings_value(&json!({
            "severeDepthMm": 0.15,
            "reviewDepthMm": 0.09,
            "minDefectWidthMm": 0.25,
            "cameraExposureUs": 900,
            "encoderPulsePerMeter": 2048,
            "autoReview": false,
            "alarmVolume": 72,
            "saveRawImages": true
        }))
        .expect("valid inspection settings should normalize");
        assert_eq!(settings["severeDepthMm"], json!(0.15));
        assert_eq!(settings["autoReview"], json!(false));

        let inverted = normalize_inspection_settings_value(&json!({
            "severeDepthMm": 0.08,
            "reviewDepthMm": 0.09
        }))
        .unwrap_err();
        assert!(inverted.contains("severeDepthMm"));

        let bad_exposure = normalize_inspection_settings_value(&json!({
            "cameraExposureUs": 50
        }))
        .unwrap_err();
        assert!(bad_exposure.contains("cameraExposureUs"));
    }

    #[test]
    fn alarm_rules_validation_matches_backend_rule_bounds() {
        let rules = normalize_alarm_rules_value(&json!({
            "enabled": true,
            "severeDefectThreshold": 2,
            "reviewDefectThreshold": 5,
            "cameraOffline": true,
            "receiverPortFailure": false,
            "plcOffline": true,
            "l2Offline": true,
            "notifySound": false,
            "notifyBanner": true,
            "retainMinutes": 120
        }))
        .expect("valid alarm rules should normalize");
        assert_eq!(rules["severeDefectThreshold"], json!(2));
        assert_eq!(rules["receiverPortFailure"], json!(false));
        assert_eq!(rules["retainMinutes"], json!(120));

        let defaults = normalize_alarm_rules_value(&json!({}))
            .expect("empty alarm rules should normalize with defaults");
        assert_eq!(defaults["enabled"], json!(true));
        assert_eq!(defaults["reviewDefectThreshold"], json!(3));

        let bad_threshold = normalize_alarm_rules_value(&json!({
            "severeDefectThreshold": 0
        }))
        .unwrap_err();
        assert!(bad_threshold.contains("severeDefectThreshold"));

        let bad_retain = normalize_alarm_rules_value(&json!({
            "retainMinutes": 1441
        }))
        .unwrap_err();
        assert!(bad_retain.contains("retainMinutes"));
    }

    #[test]
    fn external_integrations_validation_matches_interface_bounds() {
        let integrations = normalize_external_integrations_value(&json!({
            "plc": {
                "enabled": true,
                "protocol": "modbus-tcp",
                "host": "192.168.20.10",
                "port": 1502,
                "path": "/plc/status",
                "timeoutMs": 1200,
                "retryIntervalMs": 3000
            },
            "l2": {
                "enabled": true,
                "protocol": "http-json",
                "host": "192.168.20.20",
                "port": 8082,
                "path": "/api/l2/status",
                "timeoutMs": 1500,
                "retryIntervalMs": 5000
            }
        }))
        .expect("valid external integrations should normalize with MES defaults");
        assert_eq!(integrations["plc"]["host"], json!("192.168.20.10"));
        assert_eq!(integrations["plc"]["timeoutMs"], json!(1200));
        assert_eq!(integrations["mes"]["enabled"], json!(false));

        let bad_protocol = normalize_external_integrations_value(&json!({
            "plc": { "protocol": "serial" }
        }))
        .unwrap_err();
        assert!(bad_protocol.contains("externalIntegrations.plc.protocol"));

        let bad_port = normalize_external_integrations_value(&json!({
            "l2": { "port": 70000 }
        }))
        .unwrap_err();
        assert!(bad_port.contains("externalIntegrations.l2.port"));
    }

    #[test]
    fn database_maintenance_routes_split_read_and_operation_permissions() {
        assert_eq!(
            permission_for_route("GET", "/api/admin/database/integrity"),
            Some("admin.overview")
        );
        assert_eq!(
            permission_for_route("GET", "/api/admin/diagnostics"),
            Some("admin.overview")
        );
        assert_eq!(
            permission_for_route("GET", "/api/admin/database/backup"),
            Some("admin.overview")
        );
        assert_eq!(
            permission_for_route("POST", "/api/admin/database/maintenance"),
            Some("admin.services")
        );
    }

    #[test]
    fn capture_service_operation_routes_require_services_permission() {
        assert_eq!(
            permission_for_route("GET", "/api/admin/services"),
            Some("admin.services")
        );
        assert_eq!(
            permission_for_route("POST", "/api/admin/services/capture/start"),
            Some("admin.services")
        );
        assert_eq!(
            permission_for_route("POST", "/api/admin/services/capture/stop"),
            Some("admin.services")
        );
        assert_eq!(
            permission_for_route("POST", "/api/admin/services/capture/restart"),
            Some("admin.services")
        );
    }

    #[test]
    fn inspection_record_delete_requires_records_permission() {
        assert_eq!(
            permission_for_route("GET", "/api/admin/records"),
            Some("admin.records")
        );
        assert_eq!(
            permission_for_route("GET", "/api/admin/records/detail"),
            Some("admin.records")
        );
        assert_eq!(
            permission_for_route("GET", "/api/admin/records/export"),
            Some("admin.records")
        );
        assert_eq!(
            permission_for_route("POST", "/api/admin/records/retention"),
            Some("admin.records")
        );
        assert_eq!(
            permission_for_route("DELETE", "/api/admin/records"),
            Some("admin.records")
        );
    }

    #[test]
    fn database_integrity_status_flags_non_ok_messages() {
        assert_eq!(database_integrity_status(&["ok".to_string()]), "ok");
        assert_eq!(
            database_integrity_status(&["row 42 missing from index".to_string()]),
            "warning"
        );
        assert_eq!(
            database_integrity_status(&["ok".to_string(), "extra".to_string()]),
            "warning"
        );
    }

    #[test]
    fn defect_type_routes_split_read_and_write_permissions() {
        assert_eq!(
            permission_for_route("GET", "/api/admin/defect-types"),
            Some("admin.records")
        );
        assert_eq!(
            permission_for_route("POST", "/api/admin/defect-types"),
            Some("admin.config")
        );
        assert_eq!(
            permission_for_route("DELETE", "/api/admin/defect-types"),
            Some("admin.config")
        );
    }

    #[test]
    fn admin_password_policy_requires_length_and_mixed_classes() {
        assert!(matches!(
            validate_admin_password(None),
            Err(PasswordPolicyError::Missing)
        ));
        assert!(matches!(
            validate_admin_password(Some("abc123")),
            Err(PasswordPolicyError::Length)
        ));
        assert!(matches!(
            validate_admin_password(Some("12345678")),
            Err(PasswordPolicyError::Complexity)
        ));
        assert!(matches!(
            validate_admin_password(Some("abcdefgh")),
            Err(PasswordPolicyError::Complexity)
        ));
        assert!(validate_admin_password(Some("secure456")).is_ok());
    }

    fn admin_user_with_hash(id: &str, password_hash: String) -> db::entities::admin_user::Model {
        db::entities::admin_user::Model {
            id: id.to_string(),
            display_name: "测试账号".to_string(),
            role: "operator".to_string(),
            status: "active".to_string(),
            password_hash,
            last_login_at: "未登录".to_string(),
            created_at: "0".to_string(),
        }
    }

    #[test]
    fn admin_password_hash_uses_argon2_and_verifies() {
        let hash = db::hash_admin_password("admin", "secure456");
        let second_hash = db::hash_admin_password("admin", "secure456");
        assert!(hash.starts_with("$argon2"));
        assert_ne!(hash, second_hash);

        let user = admin_user_with_hash("admin", hash);
        assert!(db::verify_admin_password(&user, "secure456"));
        assert!(!db::verify_admin_password(&user, "wrong456"));
        assert!(!db::admin_password_hash_needs_upgrade(&user.password_hash));
    }

    #[test]
    fn legacy_admin_password_hash_still_verifies_but_needs_upgrade() {
        let legacy_hash = db::legacy_admin_password_hash("operator", "admin123");
        let user = admin_user_with_hash("operator", legacy_hash);
        assert!(db::verify_admin_password(&user, "admin123"));
        assert!(!db::verify_admin_password(&user, "secure456"));
        assert!(db::admin_password_hash_needs_upgrade(&user.password_hash));
    }

    #[test]
    fn state_changing_requests_require_trusted_local_origin_when_origin_is_present() {
        let trusted = "POST /api/admin/users HTTP/1.1\r\nOrigin: http://localhost:1432\r\n\r\n";
        assert!(request_origin_allowed(trusted, "POST"));

        let tauri = "POST /api/admin/users HTTP/1.1\r\nOrigin: tauri://localhost\r\n\r\n";
        assert!(request_origin_allowed(tauri, "POST"));

        let untrusted = "POST /api/admin/users HTTP/1.1\r\nOrigin: https://example.com\r\n\r\n";
        assert!(!request_origin_allowed(untrusted, "POST"));
    }

    #[test]
    fn origin_guard_allows_cli_requests_and_read_only_requests() {
        let cli = "POST /api/admin/users HTTP/1.1\r\nHost: 127.0.0.1:4873\r\n\r\n";
        assert!(request_origin_allowed(cli, "POST"));

        let external_read = "GET /api/admin/users HTTP/1.1\r\nOrigin: https://example.com\r\n\r\n";
        assert!(request_origin_allowed(external_read, "GET"));
    }

    #[test]
    fn preflight_for_state_changing_request_uses_requested_method() {
        let external_preflight = "OPTIONS /api/admin/users HTTP/1.1\r\nOrigin: https://example.com\r\nAccess-Control-Request-Method: POST\r\n\r\n";
        assert!(!request_origin_allowed(external_preflight, "OPTIONS"));

        let local_preflight = "OPTIONS /api/admin/users HTTP/1.1\r\nOrigin: http://127.0.0.1:1432\r\nAccess-Control-Request-Method: DELETE\r\n\r\n";
        assert!(request_origin_allowed(local_preflight, "OPTIONS"));
    }

    #[test]
    fn export_audit_detail_includes_filters_and_row_limit() {
        assert_eq!(
            export_audit_detail(12, ADMIN_EXPORT_MAX_ROWS, Some("config"), Some("warning")),
            "导出审计日志 12 条（上限 5000，关键字=config，等级=warning）"
        );
        assert_eq!(
            export_audit_detail(0, ADMIN_EXPORT_MAX_ROWS, Some(""), Some("all")),
            "导出审计日志 0 条（上限 5000，关键字=全部，等级=全部）"
        );
    }

    #[test]
    fn export_records_detail_includes_filters_and_row_limit() {
        assert_eq!(
            export_records_detail(
                3,
                ADMIN_EXPORT_MAX_ROWS,
                Some("202606131900"),
                Some("detecting")
            ),
            "导出检测记录 3 条（上限 5000，关键字=202606131900，状态=detecting）"
        );
    }

    #[test]
    fn record_retention_detail_reports_preview_and_purge_results() {
        assert_eq!(
            record_retention_detail(365, "2025-07-02 10:00:00", 4, 0, 0, 0, true),
            "预览检测记录保留策略：保留 365 天，截止 2025-07-02 10:00:00，可清理 4 条记录"
        );
        assert_eq!(
            record_retention_detail(365, "2025-07-02 10:00:00", 4, 4, 12, 4, false),
            "执行检测记录保留策略：保留 365 天，截止 2025-07-02 10:00:00，清理记录 4 / 4 条，缺陷 12 条，钢板档案 4 条"
        );
    }

    #[test]
    fn audit_retention_detail_reports_preview_and_purge_results() {
        let cutoff = audit_retention_cutoff(DAY_MILLIS * 10, 3);
        assert_eq!(cutoff, (DAY_MILLIS * 7).to_string());
        assert_eq!(
            audit_retention_detail(180, "1780000000000", 12, 0, true),
            "预览审计日志保留策略：保留 180 天，截止 1780000000000，可清理 12 条"
        );
        assert_eq!(
            audit_retention_detail(180, "1780000000000", 12, 10, false),
            "执行审计日志保留策略：保留 180 天，截止 1780000000000，清理 10 / 12 条"
        );
    }

    #[test]
    fn security_policy_validation_rejects_invalid_audit_retention_days() {
        let policy = validate_security_policy_value(&json!({
            "auditRetentionDays": 90,
            "login": {
                "maxFailures": 3,
                "failureWindowMinutes": 15,
                "lockoutMinutes": 30
            },
            "session": {
                "ttlHours": 12
            }
        }))
        .expect("valid policy should parse");
        assert_eq!(
            policy,
            SecurityPolicy {
                audit_retention_days: 90,
                login_max_failures: 3,
                login_failure_window_minutes: 15,
                login_lockout_minutes: 30,
                session_ttl_hours: 12,
            }
        );

        let missing = validate_security_policy_value(&json!({})).unwrap_err();
        assert!(missing.contains("auditRetentionDays"));

        let invalid_range =
            validate_security_policy_value(&json!({ "auditRetentionDays": 0 })).unwrap_err();
        assert!(invalid_range.contains("1..3650"));
    }

    #[test]
    fn security_policy_validation_defaults_and_bounds_runtime_limits() {
        let defaulted = validate_security_policy_value(&json!({
            "auditRetentionDays": 365
        }))
        .expect("policy should use login/session defaults");
        assert_eq!(defaulted.login_max_failures, LOGIN_MAX_FAILURES);
        assert_eq!(defaulted.login_failure_window_minutes, 10);
        assert_eq!(defaulted.login_lockout_minutes, 5);
        assert_eq!(defaulted.session_ttl_hours, ADMIN_SESSION_TTL_HOURS);

        let invalid_login = validate_security_policy_value(&json!({
            "auditRetentionDays": 365,
            "login": { "maxFailures": 0 }
        }))
        .unwrap_err();
        assert!(invalid_login.contains("securityPolicy.login.maxFailures"));

        let invalid_session = validate_security_policy_value(&json!({
            "auditRetentionDays": 365,
            "session": { "ttlHours": 999 }
        }))
        .unwrap_err();
        assert!(invalid_session.contains("securityPolicy.session.ttlHours"));
    }

    #[test]
    fn config_revision_validation_accepts_security_policy() {
        let policy = json!({
            "auditRetentionDays": 120,
            "login": {
                "maxFailures": 4,
                "failureWindowMinutes": 15,
                "lockoutMinutes": 6
            },
            "session": {
                "ttlHours": 10
            }
        });
        assert!(validate_config_value(SECURITY_POLICY_CONFIG_KEY, &policy).is_ok());

        let invalid_policy = json!({
            "auditRetentionDays": 0
        });
        assert!(validate_config_value(SECURITY_POLICY_CONFIG_KEY, &invalid_policy).is_err());
    }

    #[test]
    fn config_revision_validation_accepts_external_integrations() {
        let integrations = json!({
            "plc": {
                "enabled": true,
                "protocol": "modbus-tcp",
                "host": "192.168.20.10",
                "port": 1502,
                "path": "/plc/status",
                "timeoutMs": 1200,
                "retryIntervalMs": 3000
            },
            "l2": {
                "enabled": true,
                "protocol": "http-json",
                "host": "192.168.20.20",
                "port": 8082,
                "path": "/api/l2/status",
                "timeoutMs": 1500,
                "retryIntervalMs": 5000
            },
            "mes": {
                "enabled": false,
                "protocol": "http-json",
                "host": "192.168.20.30",
                "port": 8088,
                "path": "/api/mes/report",
                "timeoutMs": 2000,
                "retryIntervalMs": 10000
            }
        });
        assert!(validate_config_value(EXTERNAL_INTEGRATIONS_CONFIG_KEY, &integrations).is_ok());

        let invalid_integrations = json!({
            "plc": { "timeoutMs": 20 }
        });
        assert!(
            validate_config_value(EXTERNAL_INTEGRATIONS_CONFIG_KEY, &invalid_integrations).is_err()
        );
    }

    #[test]
    fn connection_config_validation_rejects_invalid_mode_and_port() {
        assert!(validate_connection_config_value(&json!({
            "mode": "online",
            "host": "127.0.0.1",
            "port": 4873
        }))
        .is_ok());

        let invalid_mode = validate_connection_config_value(&json!({
            "mode": "offline",
            "host": "127.0.0.1",
            "port": 4873
        }))
        .unwrap_err();
        assert!(invalid_mode.contains("connection.mode"));

        let invalid_port = validate_connection_config_value(&json!({
            "mode": "online",
            "host": "127.0.0.1",
            "port": 70000
        }))
        .unwrap_err();
        assert!(invalid_port.contains("connection.port"));
    }

    #[test]
    fn capture_config_validation_accepts_generated_config() {
        let config = serde_json::from_str::<Value>(&build_config_json(CAPTURE_SERVICE_PORT))
            .expect("generated config must be json");
        assert!(validate_capture_config_value(&config).is_ok());
    }

    #[test]
    fn capture_provider_parses_independent_runtime_modes() {
        assert_eq!(
            CaptureProvider::from_env_value("headless-cpp"),
            CaptureProvider::HeadlessCpp
        );
        assert_eq!(
            CaptureProvider::from_env_value("qt-terminal"),
            CaptureProvider::QtTerminal
        );
        assert_eq!(
            CaptureProvider::from_env_value("external-api"),
            CaptureProvider::ExternalApi
        );
        assert_eq!(
            CaptureProvider::from_env_value("simulated"),
            CaptureProvider::Simulated
        );
    }

    #[test]
    fn capture_origin_port_parser_accepts_local_capture_endpoints() {
        assert_eq!(
            capture_port_from_origin("http://127.0.0.1:4317"),
            Some(4317)
        );
        assert_eq!(
            capture_host_from_origin("http://192.168.1.20:5317/api"),
            Some("192.168.1.20".to_string())
        );
        assert_eq!(
            capture_port_from_origin("http://127.0.0.1:5317/api"),
            Some(5317)
        );
        assert_eq!(capture_port_from_origin("http://127.0.0.1"), None);
    }

    #[test]
    fn capture_config_validation_rejects_missing_cameras_and_bad_camera_fields() {
        let no_cameras = validate_capture_config_value(&json!({
            "capture": {
                "mode": "single-camera",
                "driver": "lvm-nvt",
                "fallback": "simulated",
                "cameras": []
            }
        }))
        .unwrap_err();
        assert!(no_cameras.contains("capture.cameras"));

        let bad_camera = validate_capture_config_value(&json!({
            "capture": {
                "mode": "single-camera",
                "driver": "lvm-nvt",
                "fallback": "simulated",
                "cameras": [{
                    "id": "CAM-01",
                    "name": "1 号采集相机",
                    "ip": "192.168.105.13",
                    "driverId": "lvm-nvt",
                    "role": "主采集相机",
                    "enabled": true,
                    "triggerMode": "软件触发",
                    "exposureUs": 0,
                    "gain": 1,
                    "depthLines": 1280,
                    "outputPath": "captures/CAM-01"
                }]
            }
        }))
        .unwrap_err();
        assert!(bad_camera.contains("exposureUs"));
    }

    #[test]
    fn camera_config_validation_rejects_out_of_range_values() {
        let valid_camera = camera_config_input_from_value(&json!({
            "id": "CAM-02",
            "name": "2 号采集相机",
            "ip": "192.168.102.100",
            "driverId": "lvm-nvt",
            "enabled": true,
            "triggerMode": "软件触发",
            "exposureUs": 850,
            "gain": 1.5,
            "depthLines": 1600,
            "outputPath": "captures/CAM-02"
        }))
        .expect("valid camera config should parse");
        assert_eq!(valid_camera.exposure_us, 850);
        assert_eq!(valid_camera.depth_lines, 1600);

        let invalid_exposure = match camera_config_input_from_value(&json!({
            "id": "CAM-02",
            "name": "2 号采集相机",
            "ip": "192.168.102.100",
            "exposureUs": 0,
            "gain": 1,
            "depthLines": 1600
        })) {
            Ok(_) => panic!("out-of-range exposure should be rejected"),
            Err(error) => error,
        };
        assert!(invalid_exposure.contains("camera.exposureUs"));

        let invalid_gain = match camera_config_input_from_value(&json!({
            "id": "CAM-02",
            "name": "2 号采集相机",
            "ip": "192.168.102.100",
            "exposureUs": 850,
            "gain": 101,
            "depthLines": 1600
        })) {
            Ok(_) => panic!("out-of-range gain should be rejected"),
            Err(error) => error,
        };
        assert!(invalid_gain.contains("camera.gain"));
    }

    #[test]
    fn defect_type_validation_accepts_catalog_values_and_rejects_bad_style() {
        let valid = defect_type_input_from_value(&json!({
            "id": "pit_heavy",
            "label": "深凹坑",
            "color": "#ff3355",
            "shape": "diamond"
        }))
        .expect("valid defect type should parse");
        assert_eq!(valid.id, "pit_heavy");
        assert_eq!(valid.shape, "diamond");

        let invalid_id = defect_type_input_from_value(&json!({
            "id": "-bad",
            "label": "异常类型",
            "color": "#ff3355",
            "shape": "circle"
        }))
        .unwrap_err();
        assert!(invalid_id.contains("defectType.id"));

        let invalid_color = defect_type_input_from_value(&json!({
            "id": "bad_color",
            "label": "异常颜色",
            "color": "red",
            "shape": "circle"
        }))
        .unwrap_err();
        assert!(invalid_color.contains("#RRGGBB"));

        let invalid_shape = defect_type_input_from_value(&json!({
            "id": "bad_shape",
            "label": "异常形状",
            "color": "#ff3355",
            "shape": "triangle"
        }))
        .unwrap_err();
        assert!(invalid_shape.contains("circle/square/rect/diamond/star"));
    }

    #[test]
    fn role_permissions_validation_requires_an_explicit_string_array() {
        let permissions = role_permissions_from_value(&json!({
            "permissions": ["admin.overview", "admin.audit", "admin.audit"]
        }))
        .expect("valid permissions should parse");
        assert_eq!(permissions, vec!["admin.overview", "admin.audit"]);

        let missing_permissions = role_permissions_from_value(&json!({})).unwrap_err();
        assert!(missing_permissions.contains("role.permissions"));

        let invalid_type = role_permissions_from_value(&json!({
            "permissions": "admin.overview"
        }))
        .unwrap_err();
        assert!(invalid_type.contains("role.permissions"));

        let invalid_item = role_permissions_from_value(&json!({
            "permissions": ["admin.overview", 123]
        }))
        .unwrap_err();
        assert!(invalid_item.contains("非空字符串"));
    }

    #[test]
    fn admin_identifier_validation_rejects_unstable_ids() {
        assert!(validate_admin_identifier("supervisor-01", "adminUser.id").is_ok());
        assert!(validate_admin_identifier("reviewer.main", "role.id").is_ok());

        let starts_with_dash = validate_admin_identifier("-reviewer", "role.id").unwrap_err();
        assert!(starts_with_dash.contains("必须以字母或数字开头"));

        let contains_space = validate_admin_identifier("bad role", "role.id").unwrap_err();
        assert!(contains_space.contains("只能包含字母"));

        let too_long =
            validate_admin_identifier(&"a".repeat(ADMIN_ID_MAX_LEN + 1), "role.id").unwrap_err();
        assert!(too_long.contains("长度不能超过"));
    }
}
