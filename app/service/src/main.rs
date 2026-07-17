#![recursion_limit = "512"]

use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tokio::runtime::Runtime;

mod artifact_cleanup;
mod calibration_operations;
mod controlled_process;
mod db;
mod production_tasks;

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
const CAPTURE_CAMERA_IP: &str = "192.168.101.100";
const CAPTURE_CAMERA_IPS: [&str; 8] = [
    "192.168.101.100",
    "192.168.102.100",
    "192.168.103.100",
    "192.168.104.100",
    "192.168.105.100",
    "192.168.106.100",
    "192.168.107.100",
    "192.168.108.100",
];
const CAPTURE_CAMERA_MODELS: [&str; 8] = [
    "LVM3450BE",
    "LVM3450CA",
    "LVM3450RE",
    "LVM3450GE(520)",
    "LVM3450BE",
    "LVM3450CA",
    "LVM3450RE",
    "LVM3450GE(520)",
];
const CAPTURE_CAMERA_SERIALS: [&str; 8] = [
    "3G506601BE09220",
    "3G506501CA09164",
    "3G506401RE08999",
    "YF-0270",
    "3G506601BE09221",
    "3G506501CA09163",
    "3G506401RE08995",
    "YF-0269",
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
const TASK_WORKER_IDLE_HEARTBEAT_MAX_AGE_MS: u128 = 5_000;
const DEFAULT_TRIGGER_GATEWAY_ORIGIN: &str = "http://127.0.0.1:4881";
const TRIGGER_HEALTH_TIMEOUT_MS: u64 = 1_200;
const STORAGE_HEALTH_TIMEOUT_MS: u64 = 1_500;
const STORAGE_MIN_FREE_BYTES_DEFAULT: u64 = 20 * 1024 * 1024 * 1024;
const STORAGE_MIN_FREE_PERCENT_DEFAULT: f64 = 10.0;
const SYSTEM_HEALTH_ALARM_INITIAL_DELAY_SECS: u64 = 5;
const SYSTEM_HEALTH_ALARM_INTERVAL_SECS: u64 = 10;
const SYSTEM_HEALTH_ALARM_SOURCE: &str = "system-health";
const SYSTEM_HEALTH_ALARM_ACTOR: &str = "system-health-monitor";
const SYSTEM_HEALTH_ALARM_TYPES: [&str; 10] = [
    "supervisor-restart-budget-exhausted",
    "supervisor-status-invalid",
    "storage-capacity-warning",
    "storage-critical",
    "capture-unavailable",
    "task-worker-unavailable",
    "calibration-reconciliation-required",
    "trigger-unavailable",
    "algorithm-not-qualified",
    "production-policy-invalid",
];
const HEALTH_HTTP_MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const ADMIN_ID_MAX_LEN: usize = 64;
const ADMIN_LABEL_MAX_LEN: usize = 128;
const ADMIN_DESCRIPTION_MAX_LEN: usize = 256;
const DAY_MILLIS: u128 = 24 * 60 * 60 * 1000;
static SYSTEM_HEALTH_ALARM_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureProvider {
    HeadlessCpp,
    ExternalApi,
    Simulated,
}

impl CaptureProvider {
    fn from_env_value(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
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

fn normalize_capture_output_mode(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "continuous" | "auto" | "automatic" => Some("continuous"),
        "on-demand" | "on_demand" | "ondemand" | "manual" => Some("on-demand"),
        "disabled" | "off" | "stop" => Some("disabled"),
        _ => None,
    }
}

struct ServiceState {
    fallback_snapshot_json: Arc<String>,
    config_json: Mutex<String>,
    capture: Arc<CaptureServiceManager>,
    database: db::AppDatabase,
    runtime: Runtime,
    production_command_lock: Mutex<()>,
    calibration_operation_lock: Mutex<()>,
    production_task_admin_lock: Mutex<()>,
    production_task_wakeup: Condvar,
    production_task_wakeup_generation: Mutex<u64>,
    production_task_worker_status: Mutex<ProductionTaskWorkerStatus>,
    production_task_sequence: AtomicU64,
    runtime_admission: Mutex<RuntimeAdmissionState>,
    runtime_drain_token: Vec<u8>,
    trigger_gateway_origin: String,
    trigger_health_required: bool,
    runtime_profile: String,
    algorithm_mode: String,
    algorithm_mock_defect_count: String,
    sessions: Mutex<HashMap<String, AdminSession>>,
    login_failures: Mutex<HashMap<String, LoginFailureState>>,
    started_at: u128,
}

#[derive(Debug)]
struct RuntimeAdmissionState {
    accepting: bool,
    in_flight: u64,
}

impl Default for RuntimeAdmissionState {
    fn default() -> Self {
        Self {
            accepting: true,
            in_flight: 0,
        }
    }
}

struct RuntimeAdmissionGuard<'a> {
    state: &'a ServiceState,
}

impl Drop for RuntimeAdmissionGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut admission) = self.state.runtime_admission.lock() {
            admission.in_flight = admission.in_flight.saturating_sub(1);
        }
    }
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
    must_change_password: bool,
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
    simulated_capture_mode: Mutex<String>,
    simulated_continuous_line_rate: Mutex<f64>,
}

#[derive(Clone, Default)]
struct ProductionTaskWorkerStatus {
    running: bool,
    current_task_id: String,
    last_heartbeat_at: u128,
    last_error: String,
    recovered_tasks: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HealthEndpoint {
    Compatibility,
    Live,
    Ready,
    Details,
}

struct ServiceHealthSnapshot {
    ready: bool,
    body: Value,
}

#[derive(Debug, PartialEq, Eq)]
struct CaptureProxyResponse {
    status_code: u16,
    content_type: String,
    body: Vec<u8>,
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
                return ancestor.join("target").join("config").join("service");
            }
        }
        return current_dir.join("target").join("config").join("service");
    }
    PathBuf::from("target").join("config").join("service")
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

fn trigger_gateway_origin() -> String {
    env::var("TRIGGER_GATEWAY_ORIGIN")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_TRIGGER_GATEWAY_ORIGIN.to_string())
}

fn trigger_health_required_from_value(value: Option<&str>) -> bool {
    !matches!(
        value.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("0" | "false" | "no" | "off" | "disabled")
    )
}

fn trigger_health_required() -> bool {
    trigger_health_required_from_value(env::var("STEEL_TRIGGER_HEALTH_REQUIRED").ok().as_deref())
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
        "camera1 周向采集相机",
        "camera2 周向采集相机",
        "camera3 周向采集相机",
        "camera4 周向采集相机",
        "camera5 周向采集相机",
        "camera6 周向采集相机",
        "camera7 周向采集相机",
        "camera8 周向采集相机",
    ];
    json!({
        "id": camera_id,
        "name": format!("{camera_no} 号采集相机"),
        "ip": CAPTURE_CAMERA_IPS[index],
        "driverId": "lvm-nvt",
        "modelHint": CAPTURE_CAMERA_MODELS[index],
        "role": roles.get(index).copied().unwrap_or("array camera"),
        "enabled": true,
        "triggerMode": "软件触发",
        "exposureUs": 850,
        "gain": 1,
        "depthLines": 1280,
        "outputPath": format!("captures/{camera_id}")
    })
}

fn default_capture_cameras_value() -> Value {
    Value::Array(
        (0..CAPTURE_CAMERA_IPS.len())
            .map(default_capture_camera_value)
            .collect(),
    )
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
            "mode": "eight-camera",
            "driver": "lvm-nvt",
            "provider": provider.as_str(),
            "fallback": "simulated",
            "cameras": default_capture_cameras_value()
        }
    })
    .to_string()
}

fn simulated_provider_string_field(payload: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(|value| {
            value
                .as_str()
                .map(str::to_string)
                .or_else(|| value.as_i64().map(|item| item.to_string()))
        })
        .unwrap_or_default()
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
            simulated_capture_mode: Mutex::new("continuous".to_string()),
            simulated_continuous_line_rate: Mutex::new(300.0),
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
            CaptureProvider::ExternalApi => true,
            CaptureProvider::Simulated => false,
        };
        format!(
            "{{\"name\":\"capture-service\",\"provider\":\"{}\",\"managed\":{},\"running\":{},\"port\":{},\"origin\":\"{}\",\"processAvailable\":{},\"executable\":\"{}\",\"fallback\":\"simulated-eight-camera\"}}",
            self.provider.as_str(),
            if self.provider.is_managed() { "true" } else { "false" },
            if running { "true" } else { "false" },
            self.port,
            json_escape(&self.origin),
            if process_available { "true" } else { "false" },
            json_escape(&exe)
        )
    }

    fn simulated_proxy(&self, method: &str, path_with_query: &str, body: &str) -> Option<Vec<u8>> {
        let path = path_with_query.split('?').next().unwrap_or(path_with_query);
        match (method, path) {
            ("GET", "/api/steel/status") => {
                let capture_mode = self
                    .simulated_capture_mode
                    .lock()
                    .map(|mode| mode.clone())
                    .unwrap_or_else(|_| "continuous".to_string());
                let time_trigger_freq = self
                    .simulated_continuous_line_rate
                    .lock()
                    .map(|rate| *rate)
                    .unwrap_or(300.0);
                Some(
                    json!({
                        "code": 0,
                        "provider": "simulated",
                        "phase": "idle",
                        "present": false,
                        "saveEnabled": false,
                        "captureMode": capture_mode,
                        "automaticCaptureEnabled": capture_mode == "continuous",
                        "productionCaptureRunning": false,
                        "connectedCameras": CAPTURE_CAMERA_IPS.len(),
                        "continuousSettings": {
                            "timeTriggerFreq": time_trigger_freq,
                            "applyToDevice": false,
                            "runtimeOnly": true,
                            "restartContinuous": true
                        },
                        "storageRoot": "simulated",
                        "updatedAt": current_time_string()
                    })
                    .to_string()
                    .into_bytes(),
                )
            }
            ("GET", "/api/capture/continuous-settings") => {
                let capture_mode = self
                    .simulated_capture_mode
                    .lock()
                    .map(|mode| mode.clone())
                    .unwrap_or_else(|_| "continuous".to_string());
                let time_trigger_freq = self
                    .simulated_continuous_line_rate
                    .lock()
                    .map(|rate| *rate)
                    .unwrap_or(300.0);
                Some(
                    json!({
                        "code": 0,
                        "provider": "simulated",
                        "supported": true,
                        "timeTriggerFreq": time_trigger_freq,
                        "lineTriggerFrequency": time_trigger_freq,
                        "connectedCameras": CAPTURE_CAMERA_IPS.len(),
                        "configuredCameras": CAPTURE_CAMERA_IPS.len(),
                        "captureMode": capture_mode,
                        "requiresApplyToDevice": true,
                        "runtimeOnly": true
                    })
                    .to_string()
                    .into_bytes(),
                )
            }
            ("POST", "/api/steel/capture-mode") => {
                let payload =
                    serde_json::from_str::<Value>(body.trim()).unwrap_or_else(|_| json!({}));
                let requested =
                    simulated_provider_string_field(&payload, &["captureMode", "capture_mode"]);
                let Some(capture_mode) = normalize_capture_output_mode(&requested) else {
                    return Some(
                        json!({
                            "code": 400,
                            "error": "captureMode must be continuous, on-demand, or disabled"
                        })
                        .to_string()
                        .into_bytes(),
                    );
                };
                if let Ok(mut current) = self.simulated_capture_mode.lock() {
                    *current = capture_mode.to_string();
                }
                Some(
                    json!({
                        "code": 0,
                        "provider": "simulated",
                        "captureMode": capture_mode,
                        "automaticCaptureEnabled": capture_mode == "continuous",
                        "productionCaptureRunning": false,
                        "updatedAt": current_time_string()
                    })
                    .to_string()
                    .into_bytes(),
                )
            }
            ("POST", "/api/capture/continuous-settings") => {
                let payload =
                    serde_json::from_str::<Value>(body.trim()).unwrap_or_else(|_| json!({}));
                let Some(time_trigger_freq) = payload
                    .get("timeTriggerFreq")
                    .or_else(|| payload.get("time_trigger_freq"))
                    .and_then(Value::as_f64)
                    .filter(|value| value.is_finite() && *value >= 0.1 && *value <= 100_000.0)
                else {
                    return Some(
                        json!({
                            "code": 400,
                            "error": "timeTriggerFreq must be between 0.1 and 100000"
                        })
                        .to_string()
                        .into_bytes(),
                    );
                };
                let apply_to_device = payload
                    .get("applyToDevice")
                    .or_else(|| payload.get("apply_to_device"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let restart_continuous = payload
                    .get("restartContinuous")
                    .or_else(|| payload.get("restart_continuous"))
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                if apply_to_device {
                    if let Ok(mut current) = self.simulated_continuous_line_rate.lock() {
                        *current = time_trigger_freq;
                    }
                }
                let current_time_trigger_freq = self
                    .simulated_continuous_line_rate
                    .lock()
                    .map(|rate| *rate)
                    .unwrap_or(300.0);
                Some(
                    json!({
                        "code": 0,
                        "provider": "simulated",
                        "timeTriggerFreq": current_time_trigger_freq,
                        "requestedTimeTriggerFreq": time_trigger_freq,
                        "applyToDevice": apply_to_device,
                        "runtimeOnly": true,
                        "restartContinuous": restart_continuous,
                        "applied": if apply_to_device { CAPTURE_CAMERA_IPS.len() } else { 0 },
                        "failed": 0,
                        "updatedAt": current_time_string()
                    })
                    .to_string()
                    .into_bytes(),
                )
            }
            ("POST", "/api/steel/event") => {
                let payload =
                    serde_json::from_str::<Value>(body.trim()).unwrap_or_else(|_| json!({}));
                let requested_capture_mode =
                    simulated_provider_string_field(&payload, &["captureMode", "capture_mode"]);
                if !requested_capture_mode.is_empty() {
                    let Some(capture_mode) = normalize_capture_output_mode(&requested_capture_mode)
                    else {
                        return Some(
                            json!({
                                "code": 400,
                                "error": "captureMode must be continuous, on-demand, or disabled"
                            })
                            .to_string()
                            .into_bytes(),
                        );
                    };
                    if let Ok(mut current) = self.simulated_capture_mode.lock() {
                        *current = capture_mode.to_string();
                    }
                }
                let capture_mode = self
                    .simulated_capture_mode
                    .lock()
                    .map(|mode| mode.clone())
                    .unwrap_or_else(|_| "continuous".to_string());
                let material_id = {
                    let id = simulated_provider_string_field(
                        &payload,
                        &["id", "materialId", "steelId", "steelNo"],
                    );
                    if id.trim().is_empty() {
                        "simulated-material".to_string()
                    } else {
                        id
                    }
                };
                let session_id = simulated_provider_string_field(&payload, &["sessionId"]);
                let command = simulated_provider_string_field(&payload, &["cmd", "command"])
                    .if_empty("steelIn");
                let value = payload.get("value").and_then(Value::as_i64).unwrap_or(0);
                let save_enabled = payload
                    .get("saveEnabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(value != 0 && command != "rcvSteelInfo");
                let automatic_capture = capture_mode == "continuous"
                    && payload
                        .get("autoCapture")
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                let phase = if command == "rcvSteelInfo" {
                    "info-ready"
                } else if value == 0 {
                    "steel-out"
                } else if save_enabled && automatic_capture {
                    "steel-in-saving"
                } else {
                    "steel-in-waiting-images"
                };
                Some(
                    json!({
                        "code": 0,
                        "provider": "simulated",
                        "cmd": command,
                        "value": value,
                        "id": material_id,
                        "materialId": material_id,
                        "steelId": material_id,
                        "sessionId": session_id,
                        "inspectionId": simulated_provider_string_field(&payload, &["inspectionId"]),
                        "phase": phase,
                        "present": value != 0 && command != "rcvSteelInfo",
                        "saveEnabled": save_enabled,
                        "captureMode": capture_mode,
                        "automaticCaptureEnabled": capture_mode == "continuous",
                        "productionCaptureRunning": automatic_capture
                            && value != 0
                            && command != "rcvSteelInfo",
                        "saveSdkDerived": false,
                        "discardBlackFrames": payload
                            .get("discardBlackFrames")
                            .and_then(Value::as_bool)
                            .unwrap_or(true),
                        "connectedCameras": CAPTURE_CAMERA_IPS.len(),
                        "updatedAt": current_time_string()
                    })
                    .to_string()
                    .into_bytes(),
                )
            }
            ("POST", "/api/capture/continuous-test") => {
                let payload =
                    serde_json::from_str::<Value>(body.trim()).unwrap_or_else(|_| json!({}));
                let material_id =
                    simulated_provider_string_field(&payload, &["materialId", "steelId", "id"])
                        .if_empty("simulated-material");
                let session_id = simulated_provider_string_field(&payload, &["sessionId"]);
                let expected_cameras = value_i32(
                    &payload,
                    &["expectedCameras", "expected_cameras"],
                    CAPTURE_CAMERA_IPS.len() as i32,
                )
                .clamp(1, CAPTURE_CAMERA_IPS.len() as i32)
                    as usize;
                let rounds = value_i32(&payload, &["rounds"], 1).clamp(1, 100) as usize;
                let lines = value_i32(&payload, &["lines", "triggerLines"], 1000).max(1);
                let width = value_i32(&payload, &["width"], 3200).max(0);
                let save_sdk_derived = value_bool(&payload, &["saveSdkDerived"], false);
                let started_at = current_time_string();
                let output_dir = format!("simulated://{material_id}");
                let mut results = Vec::new();

                for round in 1..=rounds {
                    for (index, ip) in CAPTURE_CAMERA_IPS.iter().take(expected_cameras).enumerate()
                    {
                        let camera_id = format!("camera{}", index + 1);
                        let shot = ((round - 1) * expected_cameras) + index + 1;
                        let base = format!(
                            "{}/{}/round-{round:03}-shot-{shot:04}",
                            output_dir, camera_id
                        );
                        results.push(json!({
                            "code": 0,
                            "errorName": "CORRECT",
                            "operatorHint": "simulated",
                            "round": round,
                            "parallelIndex": index,
                            "attempt": shot,
                            "ip": ip,
                            "cameraId": camera_id,
                            "completeFrame": true,
                            "depthExists": true,
                            "intensityExists": true,
                            "metadataExists": true,
                            "sdkExists": false,
                            "sdkDepthExists": false,
                            "sdkIntensityExists": false,
                            "width": width,
                            "lines": lines,
                            "fid": shot,
                            "lostLines": 0,
                            "triggerMinInterval": 0,
                            "triggerMaxInterval": 0,
                            "depthOutput": format!("{base}_depthMap.png"),
                            "intensityOutput": format!("{base}_intensity.png"),
                            "metadataOutput": format!("{base}_metadata.json"),
                            "sdkOutput": if save_sdk_derived {
                                format!("{base}_sdk.png")
                            } else {
                                String::new()
                            },
                            "sdkDepthOutput": "",
                            "sdkIntensityOutput": "",
                        }));
                    }
                }

                let attempts = results.len();
                Some(
                    json!({
                        "schema": "steel.capture.continuous-test.summary.v1",
                        "generatedAt": current_time_string(),
                        "startedAt": started_at,
                        "finishedAt": current_time_string(),
                        "code": 0,
                        "errorName": "CORRECT",
                        "operatorHint": "simulated",
                        "provider": "simulated",
                        "materialId": material_id.clone(),
                        "sessionId": session_id.clone(),
                        "attempts": attempts,
                        "successes": attempts,
                        "failures": 0,
                        "completeFrames": attempts,
                        "metadataFrames": attempts,
                        "discardedFrames": 0,
                        "blackFrames": 0,
                        "rounds": rounds,
                        "retries": 0,
                        "cameraCount": expected_cameras,
                        "expectedCameras": expected_cameras,
                        "expectedMet": true,
                        "connectFirst": false,
                        "parallel": true,
                        "saveSdkDerived": save_sdk_derived,
                        "workerCount": expected_cameras,
                        "roundIntervalMs": value_i32(&payload, &["intervalMs"], 0),
                        "elapsedMs": 1,
                        "syncMode": "simulated-round-start-condition-variable",
                        "storageRoot": "simulated",
                        "outputDir": output_dir,
                        "summaryOutput": format!("simulated://{material_id}/summary.json"),
                        "summaryExists": true,
                        "results": results
                    })
                    .to_string()
                    .into_bytes(),
                )
            }
            _ => None,
        }
    }

    fn proxy(&self, method: &str, path_with_query: &str, body: &str) -> Option<Vec<u8>> {
        self.proxy_with_read_timeout(method, path_with_query, body, Duration::from_secs(8))
    }

    fn proxy_with_read_timeout(
        &self,
        method: &str,
        path_with_query: &str,
        body: &str,
        read_timeout: Duration,
    ) -> Option<Vec<u8>> {
        self.proxy_response_with_read_timeout(method, path_with_query, body, read_timeout)
            .filter(|response| (200..300).contains(&response.status_code))
            .map(|response| response.body)
    }

    fn proxy_response(
        &self,
        method: &str,
        path_with_query: &str,
        body: &str,
    ) -> Option<CaptureProxyResponse> {
        self.proxy_response_with_read_timeout(method, path_with_query, body, Duration::from_secs(8))
    }

    fn proxy_response_with_read_timeout(
        &self,
        method: &str,
        path_with_query: &str,
        body: &str,
        read_timeout: Duration,
    ) -> Option<CaptureProxyResponse> {
        if self.provider == CaptureProvider::Simulated {
            return self
                .simulated_proxy(method, path_with_query, body)
                .map(|body| CaptureProxyResponse {
                    status_code: 200,
                    content_type: "application/json; charset=utf-8".to_string(),
                    body,
                });
        }
        if !self.provider.uses_local_api() {
            return None;
        }
        self.ensure_started();
        if !self.endpoint_listening() {
            return None;
        }
        self.request_response_with_read_timeout(method, path_with_query, body, read_timeout)
    }

    fn probe_response(
        &self,
        path_with_query: &str,
        read_timeout: Duration,
    ) -> Option<CaptureProxyResponse> {
        if self.provider == CaptureProvider::Simulated || !self.provider.uses_local_api() {
            return None;
        }
        self.request_response_with_read_timeout("GET", path_with_query, "", read_timeout)
    }

    fn request_response_with_read_timeout(
        &self,
        method: &str,
        path_with_query: &str,
        body: &str,
        read_timeout: Duration,
    ) -> Option<CaptureProxyResponse> {
        let mut addresses = (self.host.as_str(), self.port).to_socket_addrs().ok()?;
        let mut stream = addresses.find_map(|address| {
            TcpStream::connect_timeout(&address, Duration::from_millis(1500)).ok()
        })?;
        let _ = stream.set_read_timeout(Some(read_timeout));
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
        parse_capture_http_response(response)
    }
}

fn parse_capture_http_response(response: Vec<u8>) -> Option<CaptureProxyResponse> {
    let marker = b"\r\n\r\n";
    let header_end = response
        .windows(marker.len())
        .position(|window| window == marker)?;
    let body_start = header_end + marker.len();
    let header_text = String::from_utf8_lossy(&response[..header_end]);
    let status_code = header_text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())?;
    let content_type = header_text
        .lines()
        .skip(1)
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-type")
                .then(|| value.trim().to_string())
        })
        .unwrap_or_else(|| "application/json; charset=utf-8".to_string());
    Some(CaptureProxyResponse {
        status_code,
        content_type,
        body: response[body_start..].to_vec(),
    })
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

fn url_encode_component(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (*byte as char).to_string()
            }
            _ => format!("%{:02X}", byte),
        })
        .collect()
}

fn production_file_url(path: &str) -> String {
    if path.trim().is_empty() {
        String::new()
    } else {
        format!("/api/production/file?path={}", url_encode_component(path))
    }
}

fn production_time_label(started_at: &str, material_id: &str) -> String {
    material_id
        .split('-')
        .find(|part| part.len() == 6 && part.chars().all(|ch| ch.is_ascii_digit()))
        .map(|part| format!("{}:{}", &part[0..2], &part[2..4]))
        .unwrap_or_else(|| {
            if started_at.len() >= 4 {
                let end = started_at.len();
                format!(
                    "{}:{}",
                    &started_at[end - 4..end - 2],
                    &started_at[end - 2..end]
                )
            } else {
                "--:--".to_string()
            }
        })
}

fn production_record_status(status: &str) -> &'static str {
    match status {
        "algorithm-complete" | "completed" | "finished" => "completed",
        _ => "detecting",
    }
}

fn production_plate_value(
    inspection: &db::entities::production_inspection::Model,
    session: Option<&db::entities::material_session::Model>,
) -> Value {
    json!({
        "plateNo": inspection.material_id,
        "widthMm": session.map(|item| item.width_mm).unwrap_or(0.0),
        "lengthMm": session.map(|item| item.length_mm).unwrap_or(0.0),
        "thicknessMm": session.map(|item| item.thickness_mm).unwrap_or(0.0),
        "steelGrade": session.map(|item| item.hard.clone()).filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "实际生产".to_string()),
        "detectedAt": session.map(|item| item.started_at.clone()).unwrap_or_else(|| inspection.started_at.clone())
    })
}

fn production_defect_label(type_id: &str, geometry: &Value) -> String {
    if geometry.get("classificationState").and_then(Value::as_str) == Some("candidate-only") {
        return match geometry.get("candidatePolarity").and_then(Value::as_str) {
            Some("depression") => "凹陷候选",
            Some("protrusion") => "凸起候选",
            _ => "几何异常候选",
        }
        .to_string();
    }
    match type_id {
        "pit" => "凹坑",
        "scratch" => "划伤",
        "roll" => "辊印",
        "foreign" => "异物压入",
        "burnt" => "烂钢",
        "edge" => "边裂",
        "bubble" => "气泡",
        "inclusion" => "夹杂",
        "longitudinal" => "纵裂",
        value if value.trim().is_empty() => "未知缺陷",
        value => value,
    }
    .to_string()
}

fn production_defect_severity(severity: &str) -> &'static str {
    match severity {
        "severe" => "severe",
        "minor" => "minor",
        "review" => "review",
        _ => "review",
    }
}

fn production_defect_surface(camera_id: &str) -> &'static str {
    if camera_id.contains("101") || camera_id.contains("102") || camera_id.contains("103") {
        "top"
    } else {
        "bottom"
    }
}

fn production_defect_value(
    defect: &db::entities::production_defect::Model,
    inspection: &db::entities::production_inspection::Model,
    plate: &Value,
) -> Value {
    let width = plate.get("widthMm").and_then(Value::as_f64).unwrap_or(0.0);
    let length = plate.get("lengthMm").and_then(Value::as_f64).unwrap_or(0.0);
    let geometry =
        serde_json::from_str::<Value>(&defect.geometry_json).unwrap_or_else(|_| json!({}));
    let geometry_length_ratio = geometry.get("lengthRatio").and_then(Value::as_f64);
    let geometry_circumference_ratio = geometry.get("circumferenceRatio").and_then(Value::as_f64);
    let geometry_camera_index = geometry.get("cameraIndex").and_then(Value::as_i64);
    let defect_artifacts = geometry
        .get("artifacts")
        .filter(|value| value.is_object())
        .cloned();
    let x_ratio = if let Some(ratio) = geometry_length_ratio {
        ratio.clamp(0.0, 1.0)
    } else if length > 0.0 {
        (defect.x_mm / length).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let y_offset = if width > 0.0 {
        ((defect.y_mm / width) - 0.5).clamp(-1.0, 1.0)
    } else {
        0.0
    };
    json!({
        "id": defect.id,
        "plateNo": inspection.material_id,
        "cameraId": defect.camera_id,
        "cameraIndex": geometry_camera_index,
        "typeId": defect.defect_type,
        "typeLabel": production_defect_label(&defect.defect_type, &geometry),
        "classificationState": geometry.get("classificationState").cloned().unwrap_or(Value::Null),
        "classificationVersion": geometry.get("classificationVersion").cloned().unwrap_or(Value::Null),
        "candidatePolarity": geometry.get("candidatePolarity").cloned().unwrap_or(Value::Null),
        "classificationConfidence": geometry.get("classificationConfidence").cloned().unwrap_or(Value::Null),
        "surface": production_defect_surface(&defect.camera_id),
        "severity": production_defect_severity(&defect.severity),
        "distanceHeadMm": defect.x_mm.round() as i64,
        "operatorSideMm": defect.y_mm.round() as i64,
        "driveSideMm": if width > 0.0 { (width - defect.y_mm).round() as i64 } else { 0 },
        "widthMm": defect.width_mm,
        "heightMm": defect.height_mm,
        "depthMm": defect.depth_mm,
        "xRatio": x_ratio,
        "yOffsetMm": y_offset,
        "circumferenceRatio": geometry_circumference_ratio,
        "confidence": defect.confidence,
        "detectionConfidence": defect.confidence,
        "synthetic": geometry.get("synthetic").and_then(Value::as_bool).unwrap_or(false),
        "artifacts": defect_artifacts,
        "previewX": (x_ratio * 100.0).round() as i64,
        "previewY": (geometry_circumference_ratio.unwrap_or(0.5 - y_offset / 2.0).clamp(0.0, 1.0) * 100.0).round() as i64,
        "previewImageUrl": ""
    })
}

fn production_capture_image_value(file: &db::entities::capture_file::Model) -> Value {
    json!({
        "id": file.id,
        "cameraId": file.camera_id,
        "cameraIp": file.camera_ip,
        "dataName": file.data_name,
        "sequenceNo": file.sequence_no,
        "fileType": file.file_type,
        "path": file.path,
        "metadataPath": file.metadata_path,
        "url": production_file_url(&file.path),
        "metadataUrl": production_file_url(&file.metadata_path),
        "createdAt": file.created_at
    })
}

fn summarize_defect_values(defects: &[Value]) -> Value {
    let mut severe = 0;
    let mut review = 0;
    let mut minor = 0;
    let mut top = 0;
    let mut bottom = 0;
    for defect in defects {
        match defect
            .get("severity")
            .and_then(Value::as_str)
            .unwrap_or("review")
        {
            "severe" => severe += 1,
            "minor" => minor += 1,
            _ => review += 1,
        }
        match defect
            .get("surface")
            .and_then(Value::as_str)
            .unwrap_or("top")
        {
            "bottom" => bottom += 1,
            _ => top += 1,
        }
    }
    json!({
        "total": defects.len(),
        "bySeverity": { "severe": severe, "review": review, "minor": minor },
        "bySurface": { "top": top, "bottom": bottom }
    })
}

fn production_defect_types_value() -> Value {
    json!([
        { "id": "pit", "label": "凹陷候选", "color": "#4f8cff", "shape": "circle" },
        { "id": "scratch", "label": "划伤", "color": "#46d36f", "shape": "rect" },
        { "id": "roll", "label": "辊印", "color": "#ff9d3b", "shape": "square" },
        { "id": "foreign", "label": "凸起候选", "color": "#ff4d6d", "shape": "diamond" },
        { "id": "burnt", "label": "烂钢", "color": "#9b6bff", "shape": "star" },
        { "id": "edge", "label": "边裂", "color": "#ffd166", "shape": "diamond" },
        { "id": "bubble", "label": "气泡", "color": "#ff69b4", "shape": "circle" },
        { "id": "inclusion", "label": "夹杂", "color": "#8a96a3", "shape": "rect" }
    ])
}

fn production_device_status_value(state: &ServiceState) -> Value {
    let statuses = state
        .capture
        .proxy("GET", "/api/camera/statuses", "")
        .and_then(|body| serde_json::from_slice::<Value>(&body).ok());
    let connected = statuses
        .as_ref()
        .and_then(|value| value.get("statuses"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    item.get("connected")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let camera_ports = (0..CAPTURE_CAMERA_IPS.len())
        .map(|index| json!({ "index": index + 1, "ok": connected.get(index).copied().unwrap_or(false) }))
        .collect::<Vec<_>>();
    let alarm_count = state
        .runtime
        .block_on(db::production_alarm_counts(&state.database.connection))
        .map(|counts| counts.active.saturating_add(counts.acknowledged))
        .unwrap_or(0);
    json!({
        "receiverPorts": (0..8).map(|index| json!({ "index": index + 1, "ok": true })).collect::<Vec<_>>(),
        "cameraPorts": camera_ports,
        "encoder": "sync",
        "plc": "normal",
        "l2": "normal",
        "alarmCount": alarm_count
    })
}

fn build_production_snapshot_json(state: &ServiceState) -> Result<Option<String>, String> {
    let inspections = state
        .runtime
        .block_on(db::list_recent_production_inspections(
            &state.database.connection,
            20,
        ))
        .map_err(|error| error.to_string())?;
    if inspections.is_empty() {
        return Ok(None);
    }

    let mut records = Vec::new();
    let mut plate_inspections = Vec::new();
    let mut current_plate = json!({
        "plateNo": "",
        "widthMm": 0,
        "lengthMm": 0,
        "thicknessMm": 0,
        "steelGrade": "实际生产",
        "detectedAt": ""
    });
    let mut current_defects = Vec::new();
    let mut current_capture_images = Vec::new();

    for (index, inspection) in inspections.iter().enumerate() {
        let session = state
            .runtime
            .block_on(db::find_material_session(
                &state.database.connection,
                &inspection.session_id,
            ))
            .map_err(|error| error.to_string())?;
        let files = state
            .runtime
            .block_on(db::capture_files_for_inspection(
                &state.database.connection,
                &inspection.id,
            ))
            .map_err(|error| error.to_string())?;
        let production_defects = state
            .runtime
            .block_on(db::production_defects_for_inspection(
                &state.database.connection,
                &inspection.id,
            ))
            .map_err(|error| error.to_string())?;
        let plate = production_plate_value(inspection, session.as_ref());
        let defects = production_defects
            .iter()
            .map(|defect| production_defect_value(defect, inspection, &plate))
            .collect::<Vec<_>>();
        let capture_images = files
            .iter()
            .map(production_capture_image_value)
            .collect::<Vec<_>>();
        let capture_summary_path = production_session_summary_path(
            &inspection.storage_root,
            &inspection.material_id,
            &inspection.session_id,
        )
        .map(|path| path.display().to_string())
        .unwrap_or_default();
        if index == 0 {
            current_plate = plate.clone();
            current_defects = defects.clone();
            current_capture_images = capture_images.clone();
        }
        records.push(json!({
            "id": inspection.session_id,
            "time": production_time_label(&inspection.started_at, &inspection.material_id),
            "plateNo": inspection.material_id,
            "status": production_record_status(&inspection.status),
            "defectCount": defects.len()
        }));
        plate_inspections.push(json!({
            "plate": plate,
            "defects": defects,
            "heightProfile": [],
            "captureImages": capture_images,
            "inspectionId": inspection.id,
            "summaryPath": inspection.summary_path,
            "captureSummaryPath": capture_summary_path,
            "source": "production"
        }));
    }

    Ok(Some(
        json!({
            "currentPlate": current_plate,
            "defectTypes": production_defect_types_value(),
            "defects": current_defects,
            "records": records,
            "status": production_device_status_value(state),
            "summary": summarize_defect_values(&current_defects),
            "heightProfile": [],
            "inspections": plate_inspections,
            "captureImages": current_capture_images,
            "source": "production-sqlite"
        })
        .to_string(),
    ))
}

fn build_database_snapshot_json(snapshot: db::DatabaseSnapshot) -> String {
    if snapshot.records.is_empty() && snapshot.plates.is_empty() {
        return json!({
            "currentPlate": {
                "plateNo": "暂无生产记录",
                "widthMm": 0,
                "lengthMm": 0,
                "thicknessMm": 0,
                "steelGrade": "-",
                "detectedAt": ""
            },
            "defectTypes": snapshot.defect_types.iter().map(|item| json!({
                "id": item.id,
                "label": item.label,
                "color": item.color,
                "shape": item.shape
            })).collect::<Vec<_>>(),
            "defects": [],
            "records": [],
            "status": {
                "receiverPorts": [],
                "cameraPorts": [],
                "encoder": "offline",
                "plc": "error",
                "l2": "error",
                "alarmCount": 0
            },
            "summary": {
                "total": 0,
                "bySeverity": { "severe": 0, "review": 0, "minor": 0 },
                "bySurface": { "top": 0, "bottom": 0 }
            },
            "heightProfile": [],
            "inspections": [],
            "source": "empty-production-sqlite"
        })
        .to_string();
    }
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
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Accept, Authorization, Idempotency-Key\r\n{extra_header_lines}Connection: close\r\n\r\n{}",
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
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Accept, Authorization, Idempotency-Key\r\n{extra_header_lines}Connection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

fn http_response(status: &str, content_type: &str, body: &str) -> Vec<u8> {
    http_response_with_headers(status, content_type, body, &[])
}

fn health_endpoint_for_route(method: &str, path: &str) -> Option<HealthEndpoint> {
    if method != "GET" {
        return None;
    }
    match path {
        "/api/health" => Some(HealthEndpoint::Compatibility),
        "/api/health/live" => Some(HealthEndpoint::Live),
        "/api/health/ready" => Some(HealthEndpoint::Ready),
        "/api/health/details" | "/api/health/ready/details" => Some(HealthEndpoint::Details),
        _ => None,
    }
}

fn health_latency_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HealthHttpProbeError {
    InvalidOrigin,
    Unreachable,
    Timeout,
    InvalidResponse,
}

impl HealthHttpProbeError {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidOrigin => "invalid_origin",
            Self::Unreachable => "unreachable",
            Self::Timeout => "timeout",
            Self::InvalidResponse => "invalid_response",
        }
    }
}

fn health_http_origin_endpoint(origin: &str) -> Result<(String, u16), HealthHttpProbeError> {
    let origin = origin.trim();
    let without_scheme = origin
        .strip_prefix("http://")
        .ok_or(HealthHttpProbeError::InvalidOrigin)?;
    let authority = without_scheme.split('/').next().unwrap_or_default().trim();
    if authority.is_empty() || authority.contains('@') {
        return Err(HealthHttpProbeError::InvalidOrigin);
    }
    if let Some((host, port)) = authority.rsplit_once(':') {
        let host = host.trim().trim_start_matches('[').trim_end_matches(']');
        let port = port
            .parse::<u16>()
            .map_err(|_| HealthHttpProbeError::InvalidOrigin)?;
        if host.is_empty() || port == 0 {
            return Err(HealthHttpProbeError::InvalidOrigin);
        }
        Ok((host.to_string(), port))
    } else {
        Ok((authority.to_string(), 80))
    }
}

fn health_http_io_error(error: &std::io::Error) -> HealthHttpProbeError {
    if matches!(
        error.kind(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
    ) {
        HealthHttpProbeError::Timeout
    } else {
        HealthHttpProbeError::Unreachable
    }
}

fn bounded_local_http_request(
    origin: &str,
    method: &str,
    path: &str,
    body: &str,
    timeout: Duration,
    headers: &[(&str, &str)],
) -> Result<CaptureProxyResponse, HealthHttpProbeError> {
    if !matches!(method, "GET" | "POST") {
        return Err(HealthHttpProbeError::InvalidResponse);
    }
    let (host, port) = health_http_origin_endpoint(origin)?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or(HealthHttpProbeError::Timeout)?;
    let addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|_| HealthHttpProbeError::Unreachable)?;
    let mut stream = None;
    for address in addresses {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(HealthHttpProbeError::Timeout)?;
        if remaining.is_zero() {
            return Err(HealthHttpProbeError::Timeout);
        }
        if let Ok(candidate) = TcpStream::connect_timeout(&address, remaining) {
            stream = Some(candidate);
            break;
        }
    }
    let mut stream = stream.ok_or(HealthHttpProbeError::Unreachable)?;
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or(HealthHttpProbeError::Timeout)?;
    stream
        .set_write_timeout(Some(remaining))
        .map_err(|error| health_http_io_error(&error))?;
    stream
        .set_read_timeout(Some(remaining))
        .map_err(|error| health_http_io_error(&error))?;
    let path = if path.starts_with('/') { path } else { "/" };
    let mut extra_headers = String::new();
    for (name, value) in headers {
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || value.contains(['\r', '\n'])
        {
            return Err(HealthHttpProbeError::InvalidResponse);
        }
        extra_headers.push_str(name);
        extra_headers.push_str(": ");
        extra_headers.push_str(value);
        extra_headers.push_str("\r\n");
    }
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: application/json\r\nContent-Type: application/json\r\n{extra_headers}Content-Length: {}\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| health_http_io_error(&error))?;

    let mut response = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or(HealthHttpProbeError::Timeout)?;
        if remaining.is_zero() {
            return Err(HealthHttpProbeError::Timeout);
        }
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|error| health_http_io_error(&error))?;
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                response.extend_from_slice(&buffer[..count]);
                if response.len() > HEALTH_HTTP_MAX_RESPONSE_BYTES {
                    return Err(HealthHttpProbeError::InvalidResponse);
                }
            }
            Err(error) => return Err(health_http_io_error(&error)),
        }
    }
    parse_capture_http_response(response).ok_or(HealthHttpProbeError::InvalidResponse)
}

fn bounded_health_http_get(
    origin: &str,
    path: &str,
    timeout: Duration,
) -> Result<CaptureProxyResponse, HealthHttpProbeError> {
    bounded_local_http_request(origin, "GET", path, "", timeout, &[])
}

fn database_health_component(state: &ServiceState) -> (bool, Value) {
    let started = Instant::now();
    let ok = state
        .runtime
        .block_on(state.database.connection.ping())
        .is_ok();
    (
        ok,
        json!({
            "ok": ok,
            "status": if ok { "up" } else { "unavailable" },
            "engine": state.database.engine.clone(),
            "schemaVersion": state.database.schema_version,
            "latencyMs": health_latency_ms(started),
            "reason": if ok { Value::Null } else { json!("database_ping_failed") }
        }),
    )
}

fn task_worker_health_component(state: &ServiceState) -> (bool, Value) {
    let status = match state.production_task_worker_status.lock() {
        Ok(status) => status.clone(),
        Err(_) => {
            return (
                false,
                json!({
                    "ok": false,
                    "status": "unavailable",
                    "running": false,
                    "busy": false,
                    "heartbeatFresh": false,
                    "heartbeatAgeMs": Value::Null,
                    "heartbeatPausedAtProviderBoundary": false,
                    "reason": "task_worker_status_lock_poisoned"
                }),
            );
        }
    };
    let now = current_time_millis();
    let heartbeat_age = status
        .last_heartbeat_at
        .checked_sub(0)
        .filter(|value| *value > 0)
        .map(|_| now.saturating_sub(status.last_heartbeat_at));
    let heartbeat_fresh = heartbeat_age
        .map(|age| age <= TASK_WORKER_IDLE_HEARTBEAT_MAX_AGE_MS)
        .unwrap_or(false);
    let busy = !status.current_task_id.is_empty();

    // Task execution currently crosses a synchronous provider boundary. While a task is active,
    // the worker cannot refresh its own heartbeat, so running+busy is reported honestly as busy
    // instead of being treated as a stale idle worker.
    let ok = status.running && (busy || heartbeat_fresh);
    let reason = if !status.running {
        Some("task_worker_not_running")
    } else if !busy && !heartbeat_fresh {
        Some("task_worker_heartbeat_stale")
    } else {
        None
    };
    (
        ok,
        json!({
            "ok": ok,
            "status": if ok && busy { "busy" } else if ok { "idle" } else { "unavailable" },
            "running": status.running,
            "busy": busy,
            "heartbeatFresh": heartbeat_fresh,
            "heartbeatAgeMs": heartbeat_age,
            "heartbeatPausedAtProviderBoundary": busy,
            "recoveredTasks": status.recovered_tasks,
            "reason": reason
        }),
    )
}

fn capture_health_component(state: &ServiceState) -> (bool, Value) {
    if state.capture.provider == CaptureProvider::Simulated {
        return (
            true,
            json!({
                "ok": true,
                "status": "simulated",
                "provider": state.capture.provider.as_str(),
                "managed": false,
                "apiReachable": true,
                "sdkRequired": false,
                "sdkReady": Value::Null,
                "httpStatus": Value::Null,
                "latencyMs": 0,
                "reason": Value::Null
            }),
        );
    }

    let started = Instant::now();
    let response = state
        .capture
        .probe_response("/health", Duration::from_millis(1_500));
    let latency_ms = health_latency_ms(started);
    let Some(response) = response else {
        return (
            false,
            json!({
                "ok": false,
                "status": "unavailable",
                "provider": state.capture.provider.as_str(),
                "managed": state.capture.provider.is_managed(),
                "apiReachable": false,
                "sdkRequired": true,
                "sdkReady": Value::Null,
                "httpStatus": Value::Null,
                "latencyMs": latency_ms,
                "reason": "capture_provider_unreachable"
            }),
        );
    };

    let api_reachable = true;
    let status_ok = (200..300).contains(&response.status_code);
    let payload = serde_json::from_slice::<Value>(&response.body).ok();
    let sdk_ready = payload
        .as_ref()
        .and_then(|value| value.get("sdkReady"))
        .and_then(Value::as_bool);
    let provider_ready = payload
        .as_ref()
        .and_then(|value| value.get("ready"))
        .and_then(Value::as_bool);
    let restart_required = payload.as_ref().and_then(|value| {
        value
            .get("restartRequired")
            .and_then(Value::as_bool)
            .or_else(|| {
                value
                    .get("sdkCaptureState")
                    .and_then(|state| state.get("restartRequired"))
                    .and_then(Value::as_bool)
            })
    });
    let recovery_required = payload
        .as_ref()
        .and_then(|value| value.get("recoveryRequired"))
        .and_then(Value::as_bool);
    let invalid_manifest = payload
        .as_ref()
        .and_then(|value| value.get("invalidManifest"))
        .and_then(Value::as_bool);
    let pending_recovery_count = payload
        .as_ref()
        .and_then(|value| value.get("pendingRecoveryCount"))
        .and_then(Value::as_u64);
    let contract_valid = sdk_ready.is_some();
    let ok = status_ok
        && sdk_ready == Some(true)
        && provider_ready != Some(false)
        && recovery_required != Some(true)
        && restart_required != Some(true);
    let reason = if !status_ok {
        Some("capture_health_http_error")
    } else if !contract_valid {
        Some("capture_health_contract_invalid")
    } else if recovery_required == Some(true) {
        Some("capture_calibration_recovery_required")
    } else if restart_required == Some(true) {
        Some("capture_sdk_restart_required")
    } else if provider_ready == Some(false) {
        Some("capture_provider_not_ready")
    } else if sdk_ready != Some(true) {
        Some("capture_sdk_not_ready")
    } else {
        None
    };
    (
        ok,
        json!({
            "ok": ok,
            "status": if ok { "up" } else { "unavailable" },
            "provider": state.capture.provider.as_str(),
            "managed": state.capture.provider.is_managed(),
            "apiReachable": api_reachable,
            "sdkRequired": true,
            "sdkReady": sdk_ready,
            "providerReady": provider_ready,
            "restartRequired": restart_required,
            "recoveryRequired": recovery_required,
            "invalidManifest": invalid_manifest,
            "pendingRecoveryCount": pending_recovery_count,
            "httpStatus": response.status_code,
            "latencyMs": latency_ms,
            "reason": reason
        }),
    )
}

fn calibration_reconciliation_health_component(state: &ServiceState) -> (bool, Value) {
    match state
        .runtime
        .block_on(db::list_unresolved_calibration_operations(
            &state.database.connection,
        )) {
        Ok(unresolved) => {
            let ok = unresolved.is_empty();
            (
                ok,
                json!({
                    "ok": ok,
                    "status": if ok { "clear" } else { "reconciliation-required" },
                    "unresolvedCount": unresolved.len(),
                    "unresolvedOperations": unresolved.iter().map(|operation| json!({
                        "operationId": &operation.id,
                        "kind": &operation.kind,
                        "status": &operation.status,
                        "error": &operation.error,
                        "updatedAt": &operation.updated_at
                    })).collect::<Vec<_>>(),
                    "reason": if ok { Value::Null } else { json!("calibration_reconciliation_required") }
                }),
            )
        }
        Err(_) => (
            false,
            json!({
                "ok": false,
                "status": "unavailable",
                "unresolvedCount": Value::Null,
                "unresolvedOperations": [],
                "reason": "calibration_reconciliation_lookup_failed"
            }),
        ),
    }
}

fn storage_health_component_with_timeout(state: &ServiceState, timeout: Duration) -> (bool, Value) {
    if state.capture.provider == CaptureProvider::Simulated {
        return (
            true,
            json!({
                "ok": true,
                "status": "simulated",
                "provider": state.capture.provider.as_str(),
                "simulated": true,
                "apiReachable": true,
                "rootExists": Value::Null,
                "rootWritable": Value::Null,
                "capacityAvailable": Value::Null,
                "capacityBytes": Value::Null,
                "freeBytes": Value::Null,
                "freePercent": Value::Null,
                "level": "simulated",
                "warningReason": Value::Null,
                "queueAccepting": Value::Null,
                "queueRequired": false,
                "httpStatus": Value::Null,
                "latencyMs": 0,
                "reason": Value::Null
            }),
        );
    }

    let started = Instant::now();
    let response = bounded_health_http_get(&state.capture.origin, "/api/storage/status", timeout);
    let latency_ms = health_latency_ms(started);
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return (
                false,
                json!({
                    "ok": false,
                    "status": "unavailable",
                    "provider": state.capture.provider.as_str(),
                    "simulated": false,
                    "apiReachable": false,
                    "rootExists": Value::Null,
                    "rootWritable": Value::Null,
                    "capacityAvailable": Value::Null,
                    "capacityBytes": Value::Null,
                    "freeBytes": Value::Null,
                    "freePercent": Value::Null,
                    "queueAccepting": Value::Null,
                    "queueRequired": true,
                    "httpStatus": Value::Null,
                    "latencyMs": latency_ms,
                    "reason": format!("storage_{}", error.as_str())
                }),
            );
        }
    };
    let status_ok = (200..300).contains(&response.status_code);
    let payload = serde_json::from_slice::<Value>(&response.body).ok();
    let code = payload
        .as_ref()
        .and_then(|value| value.get("code"))
        .and_then(Value::as_i64);
    let root_exists = payload
        .as_ref()
        .and_then(|value| value.get("exists"))
        .and_then(Value::as_bool);
    let root_writable = payload
        .as_ref()
        .and_then(|value| value.get("writable"))
        .and_then(Value::as_bool);
    let root_capacity_available = payload
        .as_ref()
        .and_then(|value| value.get("capacityAvailable"))
        .and_then(Value::as_bool);
    let root_capacity_bytes = payload
        .as_ref()
        .and_then(|value| value.get("capacityBytes"))
        .and_then(Value::as_u64);
    let root_free_bytes = payload
        .as_ref()
        .and_then(|value| value.get("freeBytes"))
        .and_then(Value::as_u64);
    let root_free_percent = payload
        .as_ref()
        .and_then(|value| value.get("freePercent"))
        .and_then(Value::as_f64);
    let queue = payload.as_ref().and_then(|value| value.get("queue"));
    let queue_accepting = queue
        .and_then(|value| value.get("accepting"))
        .and_then(Value::as_bool);
    let pending_items = queue
        .and_then(|value| value.get("pendingItems"))
        .and_then(Value::as_u64);
    let capacity_items = queue
        .and_then(|value| value.get("capacityItems"))
        .and_then(Value::as_u64);
    let recent_write_bytes_per_second = queue
        .and_then(|value| value.get("recentWriteBytesPerSecond"))
        .and_then(Value::as_f64);
    let camera_root_count = payload
        .as_ref()
        .and_then(|value| value.get("cameraRoots"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let camera_roots = payload
        .as_ref()
        .and_then(|value| value.get("cameraRoots"))
        .and_then(Value::as_array);
    let camera_capacity_contract_valid = camera_roots
        .map(|roots| {
            roots.iter().all(|root| {
                root.get("capacityAvailable").and_then(Value::as_bool) == Some(true)
                    && root.get("capacityBytes").and_then(Value::as_u64).is_some()
                    && root.get("freeBytes").and_then(Value::as_u64).is_some()
                    && root.get("freePercent").and_then(Value::as_f64).is_some()
            })
        })
        .unwrap_or(false);
    let minimum_free_bytes = camera_roots
        .into_iter()
        .flat_map(|roots| roots.iter())
        .filter_map(|root| root.get("freeBytes").and_then(Value::as_u64))
        .chain(root_free_bytes)
        .min();
    let minimum_free_percent = camera_roots
        .into_iter()
        .flat_map(|roots| roots.iter())
        .filter_map(|root| root.get("freePercent").and_then(Value::as_f64))
        .chain(root_free_percent)
        .reduce(f64::min);
    let minimum_capacity_bytes = camera_roots
        .into_iter()
        .flat_map(|roots| roots.iter())
        .filter_map(|root| root.get("capacityBytes").and_then(Value::as_u64))
        .chain(root_capacity_bytes)
        .min();
    let estimated_remaining_seconds = match (minimum_free_bytes, recent_write_bytes_per_second) {
        (Some(free), Some(rate)) if rate.is_finite() && rate > 0.0 => {
            Some((free as f64 / rate).floor() as u64)
        }
        _ => None,
    };
    let min_free_bytes = env::var("STEEL_STORAGE_MIN_FREE_BYTES")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(STORAGE_MIN_FREE_BYTES_DEFAULT);
    let min_free_percent = env::var("STEEL_STORAGE_MIN_FREE_PERCENT")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
        .unwrap_or(STORAGE_MIN_FREE_PERCENT_DEFAULT);
    let warning_free_bytes = min_free_bytes.saturating_mul(2);
    let warning_free_percent = (min_free_percent + 5.0).min(100.0);
    let contract_valid = code.is_some()
        && root_exists.is_some()
        && root_writable.is_some()
        && root_capacity_available == Some(true)
        && root_capacity_bytes.is_some()
        && root_free_bytes.is_some()
        && root_free_percent.is_some()
        && camera_capacity_contract_valid
        && queue_accepting.is_some();
    let capacity_healthy = minimum_free_bytes
        .map(|value| value >= min_free_bytes)
        .unwrap_or(false)
        && minimum_free_percent
            .map(|value| value >= min_free_percent)
            .unwrap_or(false);
    let ok = status_ok
        && code == Some(0)
        && root_exists == Some(true)
        && root_writable == Some(true)
        && capacity_healthy
        && queue_accepting == Some(true);
    let capacity_warning = capacity_healthy
        && (minimum_free_bytes
            .map(|value| value < warning_free_bytes)
            .unwrap_or(false)
            || minimum_free_percent
                .map(|value| value < warning_free_percent)
                .unwrap_or(false));
    let reason = if !status_ok {
        Some("storage_status_http_error")
    } else if !contract_valid {
        Some("storage_status_contract_invalid")
    } else if code != Some(0) {
        Some("storage_status_provider_error")
    } else if root_exists != Some(true) {
        Some("storage_root_missing")
    } else if root_writable != Some(true) {
        Some("storage_root_not_writable")
    } else if !capacity_healthy {
        Some("storage_capacity_below_watermark")
    } else if queue_accepting != Some(true) {
        Some("storage_queue_not_accepting")
    } else {
        None
    };
    (
        ok,
        json!({
            "ok": ok,
            "status": if !ok { "unavailable" } else if capacity_warning { "warning" } else { "up" },
            "level": if !ok { "critical" } else if capacity_warning { "warning" } else { "ok" },
            "provider": state.capture.provider.as_str(),
            "simulated": false,
            "apiReachable": true,
            "rootExists": root_exists,
            "rootWritable": root_writable,
            "capacityAvailable": root_capacity_available,
            "capacityBytes": minimum_capacity_bytes,
            "freeBytes": minimum_free_bytes,
            "freePercent": minimum_free_percent,
            "minimumFreeBytes": min_free_bytes,
            "minimumFreePercent": min_free_percent,
            "warningFreeBytes": warning_free_bytes,
            "warningFreePercent": warning_free_percent,
            "warningReason": if capacity_warning { json!("storage_capacity_near_watermark") } else { Value::Null },
            "recentWriteBytesPerSecond": recent_write_bytes_per_second,
            "estimatedRemainingSeconds": estimated_remaining_seconds,
            "queueAccepting": queue_accepting,
            "queueRequired": true,
            "queuePendingItems": pending_items,
            "queueCapacityItems": capacity_items,
            "cameraRootCount": camera_root_count,
            "httpStatus": response.status_code,
            "latencyMs": latency_ms,
            "reason": reason
        }),
    )
}

fn storage_health_component(state: &ServiceState) -> (bool, Value) {
    storage_health_component_with_timeout(state, Duration::from_millis(STORAGE_HEALTH_TIMEOUT_MS))
}

fn trigger_health_component_with_timeout(
    origin: &str,
    required: bool,
    timeout: Duration,
) -> (bool, Value) {
    let started = Instant::now();
    let response = bounded_health_http_get(origin, "/api/trigger/status", timeout);
    let latency_ms = health_latency_ms(started);
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            let ready_contribution = !required;
            return (
                ready_contribution,
                json!({
                    "ok": false,
                    "readyContribution": ready_contribution,
                    "status": if required { "unavailable" } else { "optional-unavailable" },
                    "required": required,
                    "apiReachable": false,
                    "mode": Value::Null,
                    "httpStatus": Value::Null,
                    "latencyMs": latency_ms,
                    "reason": format!("trigger_gateway_{}", error.as_str())
                }),
            );
        }
    };
    let status_ok = (200..300).contains(&response.status_code);
    let payload = serde_json::from_slice::<Value>(&response.body).ok();
    let code = payload
        .as_ref()
        .and_then(|value| value.get("code"))
        .and_then(Value::as_i64);
    let service = payload
        .as_ref()
        .and_then(|value| value.get("service"))
        .and_then(Value::as_str);
    let mode = payload
        .as_ref()
        .and_then(|value| value.get("mode"))
        .and_then(Value::as_str);
    let contract_valid = code.is_some() && service == Some("steel-trigger-gateway");
    let healthy = status_ok && code == Some(0) && contract_valid;
    let ready_contribution = healthy || !required;
    let reason = if !status_ok {
        Some("trigger_gateway_http_error")
    } else if !contract_valid {
        Some("trigger_gateway_contract_invalid")
    } else if code != Some(0) {
        Some("trigger_gateway_reported_error")
    } else {
        None
    };
    (
        ready_contribution,
        json!({
            "ok": healthy,
            "readyContribution": ready_contribution,
            "status": if healthy { "up" } else if required { "unavailable" } else { "optional-unavailable" },
            "required": required,
            "apiReachable": true,
            "mode": mode,
            "httpStatus": response.status_code,
            "latencyMs": latency_ms,
            "reason": reason
        }),
    )
}

fn trigger_health_component(state: &ServiceState) -> (bool, Value) {
    trigger_health_component_with_timeout(
        &state.trigger_gateway_origin,
        state.trigger_health_required,
        Duration::from_millis(TRIGGER_HEALTH_TIMEOUT_MS),
    )
}

fn sha256_file_hex(path: &Path) -> Option<String> {
    let mut stream = fs::File::open(path).ok()?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = stream.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Some(format!("{:x}", digest.finalize()))
}

fn algorithm_config_path() -> PathBuf {
    env::var("STEEL_ALGORITHM_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root()
                .join("config")
                .join("algorithm")
                .join("bar-surface-production.json")
        })
}

fn algorithm_config_health() -> (bool, Value, Option<Value>) {
    let path = algorithm_config_path();
    let Some(hash) = sha256_file_hex(&path) else {
        return (
            false,
            json!({
                "ok": false,
                "status": "invalid",
                "reason": "algorithm_config_unavailable"
            }),
            None,
        );
    };
    let config = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let Some(config) = config else {
        return (
            false,
            json!({
                "ok": false,
                "status": "invalid",
                "reason": "algorithm_config_invalid_json",
                "configSha256": hash
            }),
            None,
        );
    };
    let thresholds = config.get("thresholds").and_then(Value::as_object);
    let required_thresholds = [
        "contourEnabled",
        "maxFrames",
        "meshRows",
        "meshColsPerCamera",
        "radiusMm",
        "radialScaleMm",
        "maxFaceEdgeMm",
        "contourRadiusToleranceMm",
        "contourMinKeepRatio",
        "contourMinRowCoverage",
        "contourAutoPercentile",
        "contourMinimumToleranceMm",
        "contourMadMultiplier",
        "contourFallbackPercentile",
        "meshLongitudinalStepMm",
        "defectMinDepthMm",
        "defectMinAreaPoints",
        "defectMadMultiplier",
        "defectLongitudinalSpanFloorMm",
        "severitySevereAbsoluteMm",
        "severitySevereThresholdMultiplier",
        "severityReviewAbsoluteMm",
        "severityReviewThresholdMultiplier",
        "confidenceBase",
        "confidenceMagnitudeWeight",
        "confidenceAreaWeight",
        "confidenceAreaNormalizationPoints",
        "confidenceMaximum",
    ];
    let numeric_thresholds_valid = [
        ("maxFrames", 1.0, 240.0),
        ("meshRows", 24.0, 512.0),
        ("meshColsPerCamera", 24.0, 256.0),
        ("radiusMm", 0.001, 1_000_000.0),
        ("radialScaleMm", 0.0, 1_000_000.0),
        ("maxFaceEdgeMm", 0.0, 1_000_000.0),
        ("contourRadiusToleranceMm", 0.0, 1_000_000.0),
        ("contourMinKeepRatio", 0.0, 1.0),
        ("contourMinRowCoverage", 0.0, 1.0),
        ("contourAutoPercentile", 50.0, 99.9),
        ("contourMinimumToleranceMm", 0.0, 1_000_000.0),
        ("contourMadMultiplier", 0.001, 1_000_000.0),
        ("contourFallbackPercentile", 50.0, 100.0),
        ("meshLongitudinalStepMm", 0.000001, 1_000_000.0),
        ("defectMinDepthMm", 0.000001, 1_000_000.0),
        ("defectMinAreaPoints", 1.0, 1_000_000.0),
        ("defectMadMultiplier", 0.001, 1_000_000.0),
        ("defectLongitudinalSpanFloorMm", 0.0, 1_000_000.0),
        ("severitySevereAbsoluteMm", 0.0, 1_000_000.0),
        ("severitySevereThresholdMultiplier", 0.0, 1_000_000.0),
        ("severityReviewAbsoluteMm", 0.0, 1_000_000.0),
        ("severityReviewThresholdMultiplier", 0.0, 1_000_000.0),
        ("confidenceBase", 0.0, 1.0),
        ("confidenceMagnitudeWeight", 0.0, 1.0),
        ("confidenceAreaWeight", 0.0, 1.0),
        ("confidenceAreaNormalizationPoints", 0.000001, 1_000_000.0),
        ("confidenceMaximum", 0.0, 1.0),
    ]
    .iter()
    .all(|(key, minimum, maximum)| {
        thresholds
            .and_then(|values| values.get(*key))
            .and_then(Value::as_f64)
            .is_some_and(|value| value.is_finite() && value >= *minimum && value <= *maximum)
    });
    let valid = config.get("schema").and_then(Value::as_str) == Some("steel.algorithm-config.v1")
        && ["algorithmName", "algorithmVersion", "configRevision"]
            .iter()
            .all(|key| {
                config
                    .get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
            })
        && required_thresholds
            .iter()
            .all(|key| thresholds.is_some_and(|values| values.contains_key(*key)))
        && thresholds
            .and_then(|values| values.get("contourEnabled"))
            .and_then(Value::as_bool)
            .is_some()
        && numeric_thresholds_valid
        && config
            .pointer("/qualityGate/requiredCameraCount")
            .and_then(Value::as_u64)
            == Some(8)
        && config
            .pointer("/qualityGate/maximumSyntheticDefectCount")
            .and_then(Value::as_u64)
            == Some(0)
        && config
            .pointer("/qualityGate/requireCalibrationForEveryCamera")
            .and_then(Value::as_bool)
            == Some(true)
        && config
            .pointer("/qualityGate/requireReconstructionAcceptance")
            .and_then(Value::as_bool)
            == Some(true);
    let detail = json!({
        "ok": valid,
        "status": if valid { "locked" } else { "invalid" },
        "reason": if valid { Value::Null } else { json!("algorithm_config_contract_invalid") },
        "algorithmName": config.get("algorithmName"),
        "algorithmVersion": config.get("algorithmVersion"),
        "configRevision": config.get("configRevision"),
        "configSha256": hash
    });
    (valid, detail, valid.then_some(config))
}

fn algorithm_acceptance_report_valid(report: &Value, config: &Value, config_hash: &str) -> bool {
    let text_present = |pointer: &str| {
        report
            .pointer(pointer)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    };
    let hash_present = |pointer: &str| {
        report
            .pointer(pointer)
            .and_then(Value::as_str)
            .is_some_and(|value| {
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    };
    let metric_pairs = [
        (
            "/metrics/detectionRecall",
            "/acceptanceCriteria/minimumDetectionRecall",
            true,
        ),
        (
            "/metrics/falsePositiveRate",
            "/acceptanceCriteria/maximumFalsePositiveRate",
            false,
        ),
        (
            "/metrics/missRate",
            "/acceptanceCriteria/maximumMissRate",
            false,
        ),
        (
            "/metrics/localizationErrorMmP95",
            "/acceptanceCriteria/maximumLocalizationErrorMmP95",
            false,
        ),
        (
            "/metrics/sizeErrorMmP95",
            "/acceptanceCriteria/maximumSizeErrorMmP95",
            false,
        ),
        (
            "/metrics/endToEndLatencyMsP95",
            "/acceptanceCriteria/maximumEndToEndLatencyMsP95",
            false,
        ),
    ];
    report.get("schema").and_then(Value::as_str) == Some("steel.algorithm-acceptance.v1")
        && report.get("status").and_then(Value::as_str) == Some("pass")
        && report.get("algorithmName") == config.get("algorithmName")
        && report.get("algorithmVersion") == config.get("algorithmVersion")
        && report.get("configRevision") == config.get("configRevision")
        && report.get("configSha256").and_then(Value::as_str) == Some(config_hash)
        && text_present("/datasetRevision")
        && hash_present("/datasetSha256")
        && text_present("/evaluatorRevision")
        && hash_present("/evaluatorSha256")
        && text_present("/calibrationRevision")
        && hash_present("/calibrationSha256")
        && hash_present("/scriptSha256")
        && hash_present("/coreSha256")
        && report
            .get("releaseCommit")
            .and_then(Value::as_str)
            .is_some_and(|value| {
                (40..=64).contains(&value.len())
                    && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        && text_present("/approvals/algorithmOwner")
        && text_present("/approvals/qualityOwner")
        && text_present("/approvals/approvedAt")
        && metric_pairs.iter().all(|(metric, criterion, minimum)| {
            let Some(actual) = report.pointer(metric).and_then(Value::as_f64) else {
                return false;
            };
            let Some(limit) = report.pointer(criterion).and_then(Value::as_f64) else {
                return false;
            };
            if *minimum {
                actual >= limit
            } else {
                actual <= limit
            }
        })
}

fn configured_algorithm_acceptance_report() -> Option<(PathBuf, Value, String)> {
    let path = env::var("STEEL_ALGORITHM_ACCEPTANCE_REPORT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)?;
    let text = fs::read_to_string(&path).ok()?;
    let report = serde_json::from_str::<Value>(&text).ok()?;
    let hash = sha256_file_hex(&path)?;
    Some((path, report, hash))
}

fn current_algorithm_implementation_identity() -> Option<Value> {
    let script = workspace_root()
        .join("scripts")
        .join("bar_surface_reconstruct.py");
    let core = env::var("STEEL_BAR_SURFACE_CORE_EXE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)?;
    let release_commit = env::var("STEEL_RELEASE_COMMIT")
        .ok()?
        .trim()
        .to_ascii_lowercase();
    if !script.is_file()
        || !core.is_file()
        || !(40..=64).contains(&release_commit.len())
        || !release_commit.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    Some(json!({
        "scriptSha256": sha256_file_hex(&script)?,
        "coreSha256": sha256_file_hex(&core)?,
        "releaseCommit": release_commit,
        "script": script.display().to_string(),
        "core": core.display().to_string()
    }))
}

fn algorithm_implementation_binding_valid(report: &Value, implementation: &Value) -> bool {
    ["scriptSha256", "coreSha256", "releaseCommit"]
        .iter()
        .all(|key| {
            report
                .get(*key)
                .and_then(Value::as_str)
                .zip(implementation.get(*key).and_then(Value::as_str))
                .is_some_and(|(expected, actual)| expected.eq_ignore_ascii_case(actual))
        })
}

fn current_algorithm_calibration_identity() -> Option<Value> {
    let path = algorithm_calibration_path()?;
    let sha256 = sha256_file_hex(&path)?;
    let revision = env::var("STEEL_CALIBRATION_REVISION")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("sha256:{}", &sha256[..16]));
    Some(json!({
        "path": path.display().to_string(),
        "revision": revision,
        "sha256": sha256
    }))
}

fn algorithm_calibration_binding_valid(report: &Value, calibration: &Value) -> bool {
    report
        .get("calibrationRevision")
        .and_then(Value::as_str)
        .zip(calibration.get("revision").and_then(Value::as_str))
        .is_some_and(|(expected, actual)| expected == actual)
        && report
            .get("calibrationSha256")
            .and_then(Value::as_str)
            .zip(calibration.get("sha256").and_then(Value::as_str))
            .is_some_and(|(expected, actual)| expected.eq_ignore_ascii_case(actual))
}

fn algorithm_health_component(state: &ServiceState) -> (bool, Value) {
    if state.capture.provider == CaptureProvider::Simulated {
        let allowed =
            synthetic_algorithm_fixtures_allowed(&state.runtime_profile, &state.algorithm_mode);
        return (
            allowed,
            json!({
                "ok": allowed,
                "readyContribution": allowed,
                "status": if allowed { "simulation-not-required" } else { "production-simulation-forbidden" },
                "required": !allowed,
                "reason": if allowed { Value::Null } else { json!("production_simulated_algorithm_forbidden") }
            }),
        );
    }
    let (config_ok, config_detail, config) = algorithm_config_health();
    let (paths_ok, paths) = algorithm_runtime_paths_health();
    let acceptance_bundle = configured_algorithm_acceptance_report();
    let acceptance_path = acceptance_bundle.as_ref().map(|(path, _, _)| path);
    let acceptance = acceptance_bundle.as_ref().map(|(_, report, _)| report);
    let config_hash = config_detail
        .get("configSha256")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let acceptance_ok = acceptance
        .zip(config.as_ref())
        .is_some_and(|(report, config)| {
            algorithm_acceptance_report_valid(report, config, config_hash)
        });
    let implementation = current_algorithm_implementation_identity();
    let implementation_ok = acceptance
        .zip(implementation.as_ref())
        .is_some_and(|(report, identity)| algorithm_implementation_binding_valid(report, identity));
    let calibration = current_algorithm_calibration_identity();
    let calibration_ok = acceptance
        .zip(calibration.as_ref())
        .is_some_and(|(report, identity)| algorithm_calibration_binding_valid(report, identity));
    let ready = config_ok && paths_ok && acceptance_ok && implementation_ok && calibration_ok;
    (
        ready,
        json!({
            "ok": ready,
            "readyContribution": ready,
            "status": if ready { "qualified" } else { "not-qualified" },
            "required": true,
            "config": config_detail,
            "paths": paths,
            "acceptanceReportConfigured": acceptance_path.is_some(),
            "acceptanceReportValid": acceptance_ok,
            "acceptanceReportSha256": acceptance_bundle.as_ref().map(|(_, _, hash)| hash),
            "implementation": implementation,
            "implementationBindingValid": implementation_ok,
            "calibration": calibration,
            "calibrationBindingValid": calibration_ok,
            "datasetRevision": acceptance.and_then(|value| value.get("datasetRevision")),
            "calibrationRevision": acceptance.and_then(|value| value.get("calibrationRevision")),
            "reason": if !config_ok { json!("algorithm_config_invalid") } else if !paths_ok { json!("algorithm_runtime_paths_invalid") } else if !acceptance_ok { json!("algorithm_acceptance_missing_or_invalid") } else if !implementation_ok { json!("algorithm_implementation_not_approved") } else if !calibration_ok { json!("algorithm_calibration_not_approved") } else { Value::Null }
        }),
    )
}

fn production_policy_health_component(state: &ServiceState) -> (bool, Value) {
    if state.capture.provider == CaptureProvider::Simulated {
        let allowed =
            synthetic_algorithm_fixtures_allowed(&state.runtime_profile, &state.algorithm_mode);
        return (
            allowed,
            json!({
                "ok": allowed,
                "readyContribution": allowed,
                "status": if allowed { "development-simulation" } else { "production-simulation-forbidden" },
                "required": !allowed,
                "syntheticFixturesAllowed": allowed,
                "reason": if allowed { Value::Null } else { json!("production_simulated_provider_forbidden") }
            }),
        );
    }
    let mock_count = state.algorithm_mock_defect_count.parse::<u64>().ok();
    let ready = state.runtime_profile.eq_ignore_ascii_case("production")
        && state.algorithm_mode.eq_ignore_ascii_case("production")
        && mock_count == Some(0);
    (
        ready,
        json!({
            "ok": ready,
            "readyContribution": ready,
            "status": if ready { "enforced" } else { "invalid" },
            "required": true,
            "runtimeProfile": state.runtime_profile,
            "algorithmMode": state.algorithm_mode,
            "syntheticFixturesAllowed": false,
            "mockDefectCount": mock_count,
            "reason": if ready { Value::Null } else { json!("production_algorithm_policy_invalid") }
        }),
    )
}

fn service_health_snapshot(state: &ServiceState) -> ServiceHealthSnapshot {
    let (database_ok, database) = database_health_component(state);
    let (worker_ok, task_worker) = task_worker_health_component(state);
    let (capture_ok, capture) = capture_health_component(state);
    let (calibration_ok, calibration_reconciliation) =
        calibration_reconciliation_health_component(state);
    let (storage_ok, storage) = storage_health_component(state);
    let (trigger_ok, trigger) = trigger_health_component(state);
    let (algorithm_ok, algorithm) = algorithm_health_component(state);
    let (production_policy_ok, production_policy) = production_policy_health_component(state);
    let ready = database_ok
        && worker_ok
        && capture_ok
        && calibration_ok
        && storage_ok
        && trigger_ok
        && algorithm_ok
        && production_policy_ok;
    ServiceHealthSnapshot {
        ready,
        body: json!({
            "ok": ready,
            "status": if ready { "ready" } else { "not-ready" },
            "service": "steel-inspection-service",
            "language": "rust",
            "uptimeMs": current_time_millis().saturating_sub(state.started_at),
            "checks": {
                "database": database,
                "taskWorker": task_worker,
                "capture": capture,
                "calibrationReconciliation": calibration_reconciliation,
                "storage": storage,
                "trigger": trigger,
                "algorithm": algorithm,
                "productionPolicy": production_policy
            }
        }),
    }
}

#[derive(Clone, Debug)]
struct SystemHealthAlarmSpec {
    alarm_type: &'static str,
    severity: &'static str,
    message: String,
    details: Value,
}

fn health_snapshot_check<'a>(snapshot: &'a Value, name: &str) -> Option<&'a Value> {
    snapshot.get("checks").and_then(|checks| checks.get(name))
}

fn health_check_is_ok(check: &Value) -> bool {
    check.get("ok").and_then(Value::as_bool) == Some(true)
}

fn health_check_reason(check: &Value) -> &str {
    check
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or("health_check_failed")
}

fn supervisor_runtime_status_from_root(state_root: Option<&Path>) -> Result<Option<Value>, String> {
    let Some(state_root) = state_root else {
        return Ok(None);
    };
    let path = state_root.join("service").join("supervisor-status.json");
    if !path.is_file() {
        return Ok(None);
    }
    let text =
        fs::read_to_string(&path).map_err(|_| "supervisor_status_read_failed".to_string())?;
    let status = serde_json::from_str::<Value>(&text)
        .map_err(|_| "supervisor_status_invalid_json".to_string())?;
    if status.get("schema").and_then(Value::as_str) != Some("steel.runtime-supervisor.status.v1")
        || status.get("status").and_then(Value::as_str).is_none()
        || status
            .get("restartBudgetExhausted")
            .and_then(Value::as_bool)
            .is_none()
        || status
            .get("restartCountWindow")
            .and_then(Value::as_u64)
            .is_none()
        || status
            .get("restartBudgetMaximum")
            .and_then(Value::as_u64)
            .is_none()
        || status
            .get("restartBudgetWindowSeconds")
            .and_then(Value::as_u64)
            .is_none()
        || status.get("updatedAt").and_then(Value::as_str).is_none()
    {
        return Err("supervisor_status_contract_invalid".to_string());
    }
    Ok(Some(status))
}

fn supervisor_runtime_status() -> Result<Option<Value>, String> {
    let state_root = env::var("STEEL_RUNTIME_STATE_ROOT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    supervisor_runtime_status_from_root(state_root.as_deref())
}

fn system_health_alarm_specs_with_supervisor(
    snapshot: &Value,
    supervisor_status: Result<Option<Value>, String>,
) -> Vec<SystemHealthAlarmSpec> {
    let mut alarms = Vec::new();

    match supervisor_status {
        Ok(Some(status))
            if status
                .get("restartBudgetExhausted")
                .and_then(Value::as_bool)
                == Some(true) =>
        {
            alarms.push(SystemHealthAlarmSpec {
                alarm_type: "supervisor-restart-budget-exhausted",
                severity: "critical",
                message: "统一运行宿主重启预算已耗尽，自动重启已停止。".to_string(),
                details: json!({
                    "schema": "steel.system-health.alarm.v1",
                    "check": "runtimeSupervisor",
                    "status": status.get("status"),
                    "reason": status.get("reason"),
                    "restartCountWindow": status.get("restartCountWindow"),
                    "restartBudgetMaximum": status.get("restartBudgetMaximum"),
                    "restartBudgetWindowSeconds": status.get("restartBudgetWindowSeconds"),
                    "recoveryStableSeconds": status.get("recoveryStableSeconds"),
                    "updatedAt": status.get("updatedAt")
                }),
            });
        }
        Err(reason) => {
            alarms.push(SystemHealthAlarmSpec {
                alarm_type: "supervisor-status-invalid",
                severity: "severe",
                message: format!("统一运行宿主状态不可校验：{reason}。"),
                details: json!({
                    "schema": "steel.system-health.alarm.v1",
                    "check": "runtimeSupervisor",
                    "reason": reason
                }),
            });
        }
        Ok(_) => {}
    }

    if let Some(storage) = health_snapshot_check(snapshot, "storage") {
        let level = storage.get("level").and_then(Value::as_str);
        if level == Some("warning") {
            alarms.push(SystemHealthAlarmSpec {
                alarm_type: "storage-capacity-warning",
                severity: "warning",
                message: "存储容量接近生产水位，请安排归档或清理。".to_string(),
                details: json!({
                    "schema": "steel.system-health.alarm.v1",
                    "check": "storage",
                    "status": storage.get("status"),
                    "level": level,
                    "reason": storage.get("warningReason"),
                    "freeBytes": storage.get("freeBytes"),
                    "freePercent": storage.get("freePercent"),
                    "estimatedRemainingSeconds": storage.get("estimatedRemainingSeconds"),
                    "warningFreeBytes": storage.get("warningFreeBytes"),
                    "warningFreePercent": storage.get("warningFreePercent"),
                    "queuePendingItems": storage.get("queuePendingItems"),
                    "queueCapacityItems": storage.get("queueCapacityItems")
                }),
            });
        } else if !health_check_is_ok(storage) {
            alarms.push(SystemHealthAlarmSpec {
                alarm_type: "storage-critical",
                severity: "critical",
                message: format!("存储不可用于新生产会话：{}。", health_check_reason(storage)),
                details: json!({
                    "schema": "steel.system-health.alarm.v1",
                    "check": "storage",
                    "status": storage.get("status"),
                    "level": level,
                    "reason": storage.get("reason"),
                    "freeBytes": storage.get("freeBytes"),
                    "freePercent": storage.get("freePercent"),
                    "minimumFreeBytes": storage.get("minimumFreeBytes"),
                    "minimumFreePercent": storage.get("minimumFreePercent"),
                    "estimatedRemainingSeconds": storage.get("estimatedRemainingSeconds"),
                    "queueAccepting": storage.get("queueAccepting"),
                    "queuePendingItems": storage.get("queuePendingItems"),
                    "queueCapacityItems": storage.get("queueCapacityItems")
                }),
            });
        }
    }

    if let Some(capture) = health_snapshot_check(snapshot, "capture") {
        if !health_check_is_ok(capture) {
            alarms.push(SystemHealthAlarmSpec {
                alarm_type: "capture-unavailable",
                severity: if capture.get("restartRequired").and_then(Value::as_bool) == Some(true)
                    || capture.get("recoveryRequired").and_then(Value::as_bool) == Some(true)
                {
                    "critical"
                } else {
                    "severe"
                },
                message: format!("采集服务不可用：{}。", health_check_reason(capture)),
                details: json!({
                    "schema": "steel.system-health.alarm.v1",
                    "check": "capture",
                    "status": capture.get("status"),
                    "reason": capture.get("reason"),
                    "apiReachable": capture.get("apiReachable"),
                    "sdkReady": capture.get("sdkReady"),
                    "providerReady": capture.get("providerReady"),
                    "restartRequired": capture.get("restartRequired"),
                    "recoveryRequired": capture.get("recoveryRequired"),
                    "invalidManifest": capture.get("invalidManifest"),
                    "pendingRecoveryCount": capture.get("pendingRecoveryCount")
                }),
            });
        }
    }

    if let Some(worker) = health_snapshot_check(snapshot, "taskWorker") {
        if !health_check_is_ok(worker) {
            alarms.push(SystemHealthAlarmSpec {
                alarm_type: "task-worker-unavailable",
                severity: "severe",
                message: format!("生产任务执行器不可用：{}。", health_check_reason(worker)),
                details: json!({
                    "schema": "steel.system-health.alarm.v1",
                    "check": "taskWorker",
                    "status": worker.get("status"),
                    "reason": worker.get("reason"),
                    "running": worker.get("running"),
                    "busy": worker.get("busy"),
                    "heartbeatFresh": worker.get("heartbeatFresh"),
                    "heartbeatAgeMs": worker.get("heartbeatAgeMs"),
                    "recoveredTasks": worker.get("recoveredTasks")
                }),
            });
        }
    }

    if let Some(calibration) = health_snapshot_check(snapshot, "calibrationReconciliation") {
        if !health_check_is_ok(calibration) {
            alarms.push(SystemHealthAlarmSpec {
                alarm_type: "calibration-reconciliation-required",
                severity: "critical",
                message: "标定操作需要人工协调恢复，设备写入已被围栏阻止。".to_string(),
                details: json!({
                    "schema": "steel.system-health.alarm.v1",
                    "check": "calibrationReconciliation",
                    "status": calibration.get("status"),
                    "reason": calibration.get("reason"),
                    "unresolvedCount": calibration.get("unresolvedCount"),
                    "unresolvedOperations": calibration.get("unresolvedOperations")
                }),
            });
        }
    }

    if let Some(trigger) = health_snapshot_check(snapshot, "trigger") {
        let required = trigger.get("required").and_then(Value::as_bool) == Some(true);
        if required && !health_check_is_ok(trigger) {
            alarms.push(SystemHealthAlarmSpec {
                alarm_type: "trigger-unavailable",
                severity: "severe",
                message: format!("生产触发网关不可用：{}。", health_check_reason(trigger)),
                details: json!({
                    "schema": "steel.system-health.alarm.v1",
                    "check": "trigger",
                    "status": trigger.get("status"),
                    "reason": trigger.get("reason"),
                    "required": required,
                    "apiReachable": trigger.get("apiReachable"),
                    "mode": trigger.get("mode")
                }),
            });
        }
    }

    if let Some(algorithm) = health_snapshot_check(snapshot, "algorithm") {
        if !health_check_is_ok(algorithm) {
            alarms.push(SystemHealthAlarmSpec {
                alarm_type: "algorithm-not-qualified",
                severity: "severe",
                message: format!(
                    "生产算法未取得运行资格：{}。",
                    health_check_reason(algorithm)
                ),
                details: json!({
                    "schema": "steel.system-health.alarm.v1",
                    "check": "algorithm",
                    "status": algorithm.get("status"),
                    "reason": algorithm.get("reason"),
                    "acceptanceReportConfigured": algorithm.get("acceptanceReportConfigured"),
                    "acceptanceReportValid": algorithm.get("acceptanceReportValid"),
                    "implementationBindingValid": algorithm.get("implementationBindingValid"),
                    "calibrationBindingValid": algorithm.get("calibrationBindingValid"),
                    "config": algorithm.get("config").map(|config| json!({
                        "algorithmName": config.get("algorithmName"),
                        "algorithmVersion": config.get("algorithmVersion"),
                        "configRevision": config.get("configRevision"),
                        "configSha256": config.get("configSha256")
                    }))
                }),
            });
        }
    }

    if let Some(policy) = health_snapshot_check(snapshot, "productionPolicy") {
        if !health_check_is_ok(policy) {
            alarms.push(SystemHealthAlarmSpec {
                alarm_type: "production-policy-invalid",
                severity: "severe",
                message: format!("生产运行策略无效：{}。", health_check_reason(policy)),
                details: json!({
                    "schema": "steel.system-health.alarm.v1",
                    "check": "productionPolicy",
                    "status": policy.get("status"),
                    "reason": policy.get("reason"),
                    "runtimeProfile": policy.get("runtimeProfile"),
                    "algorithmMode": policy.get("algorithmMode"),
                    "mockDefectCount": policy.get("mockDefectCount"),
                    "syntheticFixturesAllowed": policy.get("syntheticFixturesAllowed")
                }),
            });
        }
    }

    alarms
}

fn system_health_alarm_specs(snapshot: &Value) -> Vec<SystemHealthAlarmSpec> {
    system_health_alarm_specs_with_supervisor(snapshot, supervisor_runtime_status())
}

fn next_system_health_alarm_id(alarm_type: &str) -> String {
    let sequence = SYSTEM_HEALTH_ALARM_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let fingerprint = format!("{alarm_type}:{}:{sequence}", current_time_millis());
    format!("ALARM-HEALTH-{:016x}", stable_alarm_hash(&fingerprint))
}

fn reconcile_system_health_alarms(
    state: &ServiceState,
    snapshot: &Value,
) -> Result<Vec<String>, String> {
    let active = system_health_alarm_specs(snapshot);
    let mut events = Vec::new();
    for alarm_type in SYSTEM_HEALTH_ALARM_TYPES {
        let spec = active.iter().find(|item| item.alarm_type == alarm_type);
        let input = spec.map(|item| db::ProductionAlarmInput {
            id: next_system_health_alarm_id(item.alarm_type),
            source: SYSTEM_HEALTH_ALARM_SOURCE.to_string(),
            alarm_type: item.alarm_type.to_string(),
            severity: item.severity.to_string(),
            material_id: String::new(),
            session_id: String::new(),
            inspection_id: String::new(),
            camera_id: String::new(),
            message: item.message.clone(),
            details: item.details.to_string(),
        });
        let outcome = state
            .runtime
            .block_on(db::reconcile_managed_alarm(
                &state.database.connection,
                SYSTEM_HEALTH_ALARM_SOURCE,
                alarm_type,
                input,
                SYSTEM_HEALTH_ALARM_ACTOR,
            ))
            .map_err(|error| error.to_string())?;
        match outcome {
            db::ManagedAlarmReconcile::Created(alarm) => {
                events.push(format!("created:{}", alarm.id));
                let _ = state.runtime.block_on(db::append_audit_log(
                    &state.database.connection,
                    SYSTEM_HEALTH_ALARM_ACTOR,
                    "system.health.alarm.created",
                    &alarm.id,
                    &format!("{} {}", alarm.alarm_type, alarm.message),
                    if alarm.severity == "critical" {
                        "error"
                    } else {
                        "warning"
                    },
                ));
            }
            db::ManagedAlarmReconcile::Resolved(alarm) => {
                events.push(format!("resolved:{}", alarm.id));
                let _ = state.runtime.block_on(db::append_audit_log(
                    &state.database.connection,
                    SYSTEM_HEALTH_ALARM_ACTOR,
                    "system.health.alarm.resolved",
                    &alarm.id,
                    &format!("{} recovered", alarm.alarm_type),
                    "info",
                ));
            }
            db::ManagedAlarmReconcile::Updated(alarm) => {
                events.push(format!("updated:{}", alarm.id));
            }
            db::ManagedAlarmReconcile::Unchanged | db::ManagedAlarmReconcile::Absent => {}
        }
    }
    Ok(events)
}

fn start_system_health_alarm_monitor(state: Arc<ServiceState>) {
    if !state.runtime_profile.eq_ignore_ascii_case("production") {
        return;
    }
    if let Err(error) = std::thread::Builder::new()
        .name("system-health-alarm-monitor".to_string())
        .spawn(move || {
            std::thread::sleep(Duration::from_secs(SYSTEM_HEALTH_ALARM_INITIAL_DELAY_SECS));
            loop {
                let snapshot = service_health_snapshot(&state);
                if let Err(error) = reconcile_system_health_alarms(&state, &snapshot.body) {
                    eprintln!("system health alarm reconciliation failed: {error}");
                }
                std::thread::sleep(Duration::from_secs(SYSTEM_HEALTH_ALARM_INTERVAL_SECS));
            }
        })
    {
        eprintln!("failed to start system health alarm monitor: {error}");
    }
}

fn service_health_response(state: &ServiceState, endpoint: HealthEndpoint) -> Vec<u8> {
    if endpoint == HealthEndpoint::Live {
        return http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({
                "ok": true,
                "status": "live",
                "service": "steel-inspection-service",
                "language": "rust",
                "uptimeMs": current_time_millis().saturating_sub(state.started_at)
            })
            .to_string(),
        );
    }

    let snapshot = service_health_snapshot(state);
    let mut body = snapshot.body;
    if let Some(object) = body.as_object_mut() {
        object.insert(
            "endpoint".to_string(),
            json!(match endpoint {
                HealthEndpoint::Compatibility => "compatibility",
                HealthEndpoint::Ready => "ready",
                HealthEndpoint::Details => "details",
                HealthEndpoint::Live => "live",
            }),
        );
    }
    http_response(
        if snapshot.ready {
            "200 OK"
        } else {
            "503 Service Unavailable"
        },
        "application/json; charset=utf-8",
        &body.to_string(),
    )
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

fn json_value_u64(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(0),
        Some(Value::String(text)) => text.parse::<u64>().unwrap_or(0),
        _ => 0,
    }
}

fn json_value_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn normalize_json_array(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items,
        Value::Null => Vec::new(),
        item => vec![item],
    }
}

#[derive(Clone)]
struct NetworkInterfaceCounters {
    received_bytes: u64,
    transmitted_bytes: u64,
}

#[derive(Clone)]
struct NetworkCounterSnapshot {
    sampled_at_ms: u128,
    interfaces: HashMap<String, NetworkInterfaceCounters>,
}

static NETWORK_COUNTER_CACHE: Mutex<Option<NetworkCounterSnapshot>> = Mutex::new(None);

fn network_counter_delta_mbps(current: u64, previous: u64, elapsed_ms: u128) -> f64 {
    if elapsed_ms == 0 || current < previous {
        return 0.0;
    }
    let elapsed_seconds = elapsed_ms as f64 / 1000.0;
    if elapsed_seconds <= 0.0 {
        return 0.0;
    }
    (current.saturating_sub(previous) as f64 * 8.0) / elapsed_seconds / 1_000_000.0
}

fn read_windows_network_snapshot_json() -> Result<String, String> {
    let script = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$statsByName = @{}
Get-NetAdapterStatistics -ErrorAction SilentlyContinue | ForEach-Object { $statsByName[$_.Name] = $_ }
Get-NetAdapter -ErrorAction SilentlyContinue |
  Sort-Object Name |
  ForEach-Object {
    $stat = $statsByName[$_.Name]
    $receivedBytes = 0
    $sentBytes = 0
    $receivedPackets = 0
    $sentPackets = 0
    if ($null -ne $stat) {
      $receivedBytes = $stat.ReceivedBytes
      $sentBytes = $stat.SentBytes
      $receivedPackets = $stat.ReceivedUnicastPackets
      $sentPackets = $stat.SentUnicastPackets
    }
    [pscustomobject]@{
      name = [string]$_.Name
      description = [string]$_.InterfaceDescription
      status = [string]$_.Status
      linkSpeed = [string]$_.LinkSpeed
      linkSpeedBitsPerSecond = [UInt64]($_.Speed -as [UInt64])
      receivedBytes = [UInt64]$receivedBytes
      transmittedBytes = [UInt64]$sentBytes
      packetsReceived = [UInt64]$receivedPackets
      packetsTransmitted = [UInt64]$sentPackets
    }
  } |
  ConvertTo-Json -Compress
"#;
    let output = Command::new("powershell.exe")
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(script)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn system_network_status_response() -> Vec<u8> {
    let sampled_at_ms = current_time_millis();
    let raw_json = match read_windows_network_snapshot_json() {
        Ok(value) if !value.trim().is_empty() => value,
        Ok(_) => "[]".to_string(),
        Err(error) => {
            return http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &format!(
                    "{{\"code\":1,\"source\":\"windows-get-netadapter\",\"sampledAtMs\":{},\"interfaces\":[],\"totalReceivedBytes\":0,\"totalTransmittedBytes\":0,\"error\":\"{}\"}}",
                    sampled_at_ms,
                    json_escape(&error)
                ),
            );
        }
    };
    let parsed = match serde_json::from_str::<Value>(&raw_json) {
        Ok(value) => normalize_json_array(value),
        Err(error) => {
            return http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &format!(
                    "{{\"code\":2,\"source\":\"windows-get-netadapter\",\"sampledAtMs\":{},\"interfaces\":[],\"totalReceivedBytes\":0,\"totalTransmittedBytes\":0,\"error\":\"{}\"}}",
                    sampled_at_ms,
                    json_escape(&error.to_string())
                ),
            );
        }
    };
    let mut total_received = 0u64;
    let mut total_transmitted = 0u64;
    let mut total_upload_mbps = 0.0f64;
    let mut total_download_mbps = 0.0f64;
    let mut total_bandwidth_mbps = 0.0f64;
    let previous_snapshot = match NETWORK_COUNTER_CACHE.lock() {
        Ok(guard) => guard.clone(),
        Err(_) => None,
    };
    let elapsed_ms = previous_snapshot
        .as_ref()
        .map(|snapshot| sampled_at_ms.saturating_sub(snapshot.sampled_at_ms))
        .unwrap_or(0);
    let mut current_counters = HashMap::new();
    let interfaces = parsed
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let name = json_value_string(item.get("name"));
            let description = json_value_string(item.get("description"));
            let status = json_value_string(item.get("status"));
            let link_speed = json_value_string(item.get("linkSpeed"));
            let link_speed_bits = json_value_u64(item.get("linkSpeedBitsPerSecond"));
            let received_bytes = json_value_u64(item.get("receivedBytes"));
            let transmitted_bytes = json_value_u64(item.get("transmittedBytes"));
            let packets_received = json_value_u64(item.get("packetsReceived"));
            let packets_transmitted = json_value_u64(item.get("packetsTransmitted"));
            let previous = previous_snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.interfaces.get(&name));
            let download_mbps = previous
                .map(|item| network_counter_delta_mbps(received_bytes, item.received_bytes, elapsed_ms))
                .unwrap_or(0.0);
            let upload_mbps = previous
                .map(|item| network_counter_delta_mbps(transmitted_bytes, item.transmitted_bytes, elapsed_ms))
                .unwrap_or(0.0);
            let bandwidth_mbps = link_speed_bits as f64 / 1_000_000.0;
            let online = status.eq_ignore_ascii_case("up") || link_speed_bits > 0;

            total_received = total_received.saturating_add(received_bytes);
            total_transmitted = total_transmitted.saturating_add(transmitted_bytes);
            total_upload_mbps += upload_mbps;
            total_download_mbps += download_mbps;
            total_bandwidth_mbps += bandwidth_mbps;
            current_counters.insert(
                name.clone(),
                NetworkInterfaceCounters {
                    received_bytes,
                    transmitted_bytes,
                },
            );
            format!(
                "{{\"index\":{},\"name\":\"{}\",\"description\":\"{}\",\"status\":\"{}\",\"linkSpeed\":\"{}\",\"linkSpeedBitsPerSecond\":{},\"receivedBytes\":{},\"transmittedBytes\":{},\"packetsReceived\":{},\"packetsTransmitted\":{},\"uploadMbps\":{:.6},\"downloadMbps\":{:.6},\"bandwidthMbps\":{:.6},\"online\":{}}}",
                index + 1,
                json_escape(&name),
                json_escape(&description),
                json_escape(&status),
                json_escape(&link_speed),
                link_speed_bits,
                received_bytes,
                transmitted_bytes,
                packets_received,
                packets_transmitted,
                upload_mbps,
                download_mbps,
                bandwidth_mbps,
                if online { "true" } else { "false" }
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    if let Ok(mut guard) = NETWORK_COUNTER_CACHE.lock() {
        *guard = Some(NetworkCounterSnapshot {
            sampled_at_ms,
            interfaces: current_counters,
        });
    }
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &format!(
            "{{\"code\":0,\"source\":\"windows-get-netadapter\",\"sampledAtMs\":{},\"interfaces\":[{}],\"totalReceivedBytes\":{},\"totalTransmittedBytes\":{},\"totalUploadMbps\":{:.6},\"totalDownloadMbps\":{:.6},\"totalBandwidthMbps\":{:.6}}}",
            sampled_at_ms,
            interfaces,
            total_received,
            total_transmitted,
            total_upload_mbps,
            total_download_mbps,
            total_bandwidth_mbps
        ),
    )
}

fn split_path_and_query(raw_path: &str) -> (&str, &str) {
    if let Some(index) = raw_path.find('?') {
        (&raw_path[..index], &raw_path[index + 1..])
    } else {
        (raw_path, "")
    }
}

fn is_production_mutation_route(method: &str, path: &str) -> bool {
    method == "POST"
        && path.starts_with("/api/production/")
        && !path.starts_with("/api/production/tasks")
}

const LINE_CONTINUOUS_PRESET_CONFIRMATION: &str = "APPLY LINE CONTINUOUS PRESET";
const LINE_CONTINUOUS_DEVICE_PERSIST_CONFIRMATION: &str = "PERSIST LINE PRESET TO CAMERA DEVICES";
const CAMERA_DEVICE_PERSIST_CONFIRMATION: &str = "PERSIST CAMERA PARAMETERS";
const SDK_PARAMETER_WRITE_CONFIRMATION: &str = "WRITE SDK PARAMETER";
const CAMERA_CALIBRATION_CONFIRMATION: &str = "APPLY CAMERA CALIBRATION";
const CAMERA_CALIBRATION_SET_CONFIRMATION: &str = "APPLY CAMERA CALIBRATION SET";
const CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION: &str = "ROLLBACK CAMERA CALIBRATION";
const CAMERA_ROI_CONFIRMATION: &str = "APPLY CAMERA ROI";
const CALIBRATION_SET_CAMERA_COUNT: usize = 8;

fn validate_calibration_set_safety(
    object: &serde_json::Map<String, Value>,
) -> Result<(), &'static str> {
    if object.get("atomic").and_then(Value::as_bool) != Some(true)
        || object.get("rollbackOnFailure").and_then(Value::as_bool) != Some(true)
        || object.get("requireAllMapped").and_then(Value::as_bool) != Some(true)
        || object.get("stopStreams").and_then(Value::as_bool) != Some(true)
    {
        return Err("calibration_set_safe_mode_required");
    }
    if object.get("expectedCameras").and_then(Value::as_u64)
        != Some(CALIBRATION_SET_CAMERA_COUNT as u64)
    {
        return Err("calibration_set_requires_eight_cameras");
    }
    if object
        .get("allowBestEffortDeviceRollback")
        .and_then(Value::as_bool)
        == Some(true)
        || object.get("saveCameraParams").and_then(Value::as_bool) == Some(true)
    {
        return Err("calibration_set_unsafe_option_rejected");
    }
    if object.get("persistActive").and_then(Value::as_bool) == Some(true)
        && object
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err("calibration_set_array_path_required");
    }

    let mappings = object
        .get("cameraCalibrations")
        .and_then(Value::as_array)
        .ok_or("calibration_set_mapping_required")?;
    if mappings.len() != CALIBRATION_SET_CAMERA_COUNT {
        return Err("calibration_set_requires_eight_cameras");
    }
    let mut mapping_ips = std::collections::BTreeSet::new();
    let mut mapping_serials = std::collections::BTreeSet::new();
    let mut mapping_paths = std::collections::BTreeSet::new();
    for mapping in mappings {
        let mapping = mapping
            .as_object()
            .ok_or("calibration_set_mapping_invalid")?;
        let required_text = |name: &str| {
            mapping
                .get(name)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let ip = required_text("ip").ok_or("calibration_set_mapping_invalid")?;
        let path = required_text("path").ok_or("calibration_set_mapping_invalid")?;
        let expected_sn = required_text("expectedSn").ok_or("calibration_set_serial_required")?;
        required_text("rollbackPath").ok_or("calibration_set_durable_rollback_path_required")?;
        if !mapping_ips.insert(ip.to_string()) {
            return Err("calibration_set_duplicate_camera");
        }
        if !mapping_serials.insert(expected_sn.to_ascii_lowercase()) {
            return Err("calibration_set_duplicate_serial");
        }
        let normalized_path = path.replace('\\', "/").to_ascii_lowercase();
        if !mapping_paths.insert(normalized_path) {
            return Err("calibration_set_duplicate_artifact");
        }
    }

    let requested_ips = object
        .get("ips")
        .and_then(Value::as_array)
        .ok_or("calibration_set_target_list_required")?;
    if requested_ips.len() != CALIBRATION_SET_CAMERA_COUNT {
        return Err("calibration_set_requires_eight_cameras");
    }
    let requested_ips = requested_ips
        .iter()
        .map(|value| value.as_str().map(str::trim).unwrap_or_default())
        .collect::<std::collections::BTreeSet<_>>();
    if requested_ips.len() != CALIBRATION_SET_CAMERA_COUNT
        || requested_ips.iter().any(|ip| !mapping_ips.contains(*ip))
    {
        return Err("calibration_set_target_mapping_mismatch");
    }
    Ok(())
}

fn validate_line_continuous_preset_request(body: &str) -> Result<(), &'static str> {
    let payload = serde_json::from_str::<Value>(body.trim()).map_err(|_| "invalid_json")?;
    let object = payload.as_object().ok_or("json_object_required")?;

    if object.get("confirmation").and_then(Value::as_str)
        != Some(LINE_CONTINUOUS_PRESET_CONFIRMATION)
    {
        return Err("line_preset_confirmation_required");
    }

    let integer_in_range = |name: &str, minimum: i64, maximum: i64| {
        object
            .get(name)
            .map(|value| {
                value
                    .as_i64()
                    .filter(|number| *number >= minimum && *number <= maximum)
                    .is_some()
            })
            .unwrap_or(true)
    };
    if !integer_in_range("lines", 1, 100_000)
        || !integer_in_range("laserPower", 0, 100)
        || !integer_in_range("laserLineSelect", 0, 2)
        || !integer_in_range("controlMode", 0, 1)
    {
        return Err("line_preset_parameter_out_of_range");
    }
    if let Some(frequency) = object.get("timeTriggerFreq") {
        let valid = frequency
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0.1 && *value <= 100_000.0)
            .is_some();
        if !valid {
            return Err("line_preset_parameter_out_of_range");
        }
    }
    if object.get("saveToDevice").and_then(Value::as_bool) == Some(true)
        && object.get("deviceConfirmation").and_then(Value::as_str)
            != Some(LINE_CONTINUOUS_DEVICE_PERSIST_CONFIRMATION)
    {
        return Err("line_preset_device_confirmation_required");
    }
    Ok(())
}

fn validate_capture_device_mutation_request(path: &str, body: &str) -> Result<(), &'static str> {
    let payload = serde_json::from_str::<Value>(body.trim()).unwrap_or_else(|_| json!({}));
    let object = payload.as_object().ok_or("json_object_required")?;

    if path == "/api/calibration/load"
        && object.get("dryRun").and_then(Value::as_bool) != Some(true)
        && object.get("confirmation").and_then(Value::as_str)
            != Some(CAMERA_CALIBRATION_CONFIRMATION)
    {
        return Err("camera_calibration_confirmation_required");
    }
    if path == "/api/calibration/apply-all" {
        validate_calibration_set_safety(object)?;
    }
    if path == "/api/calibration/apply-all"
        && object.get("dryRun").and_then(Value::as_bool) != Some(true)
        && object.get("confirmation").and_then(Value::as_str)
            != Some(CAMERA_CALIBRATION_SET_CONFIRMATION)
    {
        return Err("camera_calibration_set_confirmation_required");
    }
    if path == "/api/calibration/rollback"
        && object.get("confirmation").and_then(Value::as_str)
            != Some(CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION)
    {
        return Err("camera_calibration_rollback_confirmation_required");
    }
    if path == "/api/calibration/rollback"
        && object
            .get("applyOperationId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return Err("calibration_rollback_apply_operation_id_required");
    }
    if path == "/api/roi/load"
        && object.get("confirmation").and_then(Value::as_str) != Some(CAMERA_ROI_CONFIRMATION)
    {
        return Err("camera_roi_confirmation_required");
    }

    if path == "/api/capture/continuous-settings" {
        let valid = object
            .get("timeTriggerFreq")
            .or_else(|| object.get("time_trigger_freq"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.1 && *value <= 100_000.0)
            .is_some();
        if !valid {
            return Err("continuous_line_rate_out_of_range");
        }
    }

    if path == "/api/param" {
        let key = object
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let operator_keys = [
            "exposuretime",
            "expsure_time",
            "gaink",
            "gain_k",
            "timetriggerfreq",
            "time_trigger_freq",
            "triggermode",
            "trigger_mode",
        ];
        if !operator_keys.contains(&key.as_str())
            && object.get("confirmation").and_then(Value::as_str)
                != Some(SDK_PARAMETER_WRITE_CONFIRMATION)
        {
            return Err("sdk_parameter_write_confirmation_required");
        }
    }

    if path == "/api/param/recovery"
        && object.get("confirmation").and_then(Value::as_str)
            != Some(SDK_PARAMETER_WRITE_CONFIRMATION)
    {
        return Err("sdk_parameter_write_confirmation_required");
    }

    let explicit_device_save =
        matches!(path, "/api/param/save-device" | "/api/param/save-to-device");
    let requested_device_save = object.get("saveToDevice").and_then(Value::as_bool) == Some(true);
    if (explicit_device_save || requested_device_save)
        && object.get("deviceConfirmation").and_then(Value::as_str)
            != Some(CAMERA_DEVICE_PERSIST_CONFIRMATION)
    {
        return Err("camera_device_persist_confirmation_required");
    }

    Ok(())
}

const CAPTURE_JSON_PROXY_ROUTES: &[(&str, &str)] = &[
    ("GET", "/health"),
    ("GET", "/api/capture/health"),
    ("GET", "/api/capture/logs"),
    ("GET", "/api/storage/status"),
    ("GET", "/api/config/status"),
    ("GET", "/api/config/profiles"),
    ("GET", "/api/config/profile"),
    ("GET", "/api/cameras"),
    ("GET", "/api/camera/status"),
    ("GET", "/api/camera/statuses"),
    ("GET", "/api/steel/status"),
    ("GET", "/api/param"),
    ("GET", "/api/capture/latest"),
    ("GET", "/api/capture/continuous-settings"),
    ("GET", "/api/stream/status"),
    ("GET", "/api/calibration/active"),
    ("GET", "/api/calibration/status"),
    ("POST", "/api/storage/config"),
    ("POST", "/api/storage/camera-roots"),
    ("POST", "/api/config/profile/save"),
    ("POST", "/api/config/profile/apply"),
    ("POST", "/api/config/profile/import"),
    ("POST", "/api/config/camera-params/save-all"),
    ("POST", "/api/config/camera-params/load-all"),
    ("POST", "/api/camera/connect"),
    ("POST", "/api/camera/connect-all"),
    ("POST", "/api/cameras/connect-all"),
    ("POST", "/api/camera/disconnect"),
    ("POST", "/api/steel/capture-mode"),
    ("POST", "/api/steel/event"),
    ("POST", "/api/param"),
    ("POST", "/api/param/save-device"),
    ("POST", "/api/param/save-to-device"),
    ("POST", "/api/param/save-file"),
    ("POST", "/api/param/load-file"),
    ("POST", "/api/param/recovery"),
    ("POST", "/api/preview/capture"),
    ("POST", "/api/capture/preview"),
    ("POST", "/api/capture/depth-map"),
    ("POST", "/api/capture/continuous-test"),
    ("POST", "/api/capture/continuous-settings"),
    ("POST", "/api/capture/preset/line-continuous"),
    ("POST", "/api/stream/start"),
    ("POST", "/api/stream/stop"),
    ("POST", "/api/calibration/load"),
    ("POST", "/api/calibration/apply-all"),
    ("POST", "/api/calibration/rollback"),
    ("POST", "/api/calibration/active"),
    ("POST", "/api/roi/load"),
];

const CAPTURE_BINARY_PROXY_ROUTES: &[(&str, &str)] =
    &[("GET", "/api/capture/file"), ("GET", "/api/stream/latest")];

fn is_capture_json_proxy_route(method: &str, path: &str) -> bool {
    CAPTURE_JSON_PROXY_ROUTES.contains(&(method, path))
}

fn is_capture_binary_proxy_route(method: &str, path: &str) -> bool {
    CAPTURE_BINARY_PROXY_ROUTES.contains(&(method, path))
}

fn append_capture_proxy_manifest_routes(routes: &mut Vec<Value>) {
    for (method, path) in CAPTURE_JSON_PROXY_ROUTES
        .iter()
        .chain(CAPTURE_BINARY_PROXY_ROUTES.iter())
    {
        let already_present = routes.iter().any(|route| {
            route.get("method").and_then(Value::as_str) == Some(*method)
                && route.get("path").and_then(Value::as_str) == Some(*path)
        });
        if !already_present {
            routes.push(json!({
                "method": method,
                "path": path,
                "scope": "capture"
            }));
        }
    }
}

fn is_trigger_gateway_proxy_route(method: &str, path: &str) -> bool {
    matches!(
        (method, path),
        ("GET", "/api/trigger/status")
            | ("GET", "/api/trigger/mode")
            | ("POST", "/api/trigger/mode")
            | ("POST", "/api/trigger/manual/steel-info")
            | ("POST", "/api/trigger/manual/steel-in")
            | ("POST", "/api/trigger/manual/steel-out")
            | ("POST", "/api/trigger/capture-once")
    )
}

fn fallback_capture_response(path: &str) -> Vec<u8> {
    match path {
        "/health" | "/api/capture/health" => {
            http_response("200 OK", "application/json; charset=utf-8", &capture_health_json())
        }
        "/api/capture/logs" => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            "{\"events\":[]}",
        ),
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

fn constant_time_runtime_token_matches(expected: &[u8], supplied: &[u8]) -> bool {
    let expected_hash = Sha256::digest(expected);
    let supplied_hash = Sha256::digest(supplied);
    let mut difference = expected.len() ^ supplied.len();
    for (left, right) in expected_hash.iter().zip(supplied_hash.iter()) {
        difference |= (*left ^ *right) as usize;
    }
    difference == 0
}

fn runtime_drain_status_json(state: &ServiceState) -> Value {
    match state.runtime_admission.lock() {
        Ok(admission) => json!({
            "draining": !admission.accepting,
            "accepting": admission.accepting,
            "acceptingNewProduction": admission.accepting,
            "inFlight": admission.in_flight
        }),
        Err(_) => json!({
            "draining": true,
            "accepting": false,
            "acceptingNewProduction": false,
            "inFlight": 1,
            "error": "runtime_admission_state_unavailable"
        }),
    }
}

fn runtime_is_draining(state: &ServiceState) -> bool {
    state
        .runtime_admission
        .lock()
        .map(|admission| !admission.accepting)
        .unwrap_or(true)
}

fn runtime_draining_http_response(state: &ServiceState, path: &str) -> Vec<u8> {
    http_response(
        "503 Service Unavailable",
        "application/json; charset=utf-8",
        &json!({
            "code": 503,
            "error": "runtime_draining",
            "path": path,
            "admission": runtime_drain_status_json(state)
        })
        .to_string(),
    )
}

fn runtime_completion_route(method: &str, path: &str) -> bool {
    method == "POST"
        && matches!(
            path,
            "/api/production/steel-out"
                | "/api/production/tasks/steel-out"
                | "/api/production/tasks/cancel"
                | "/api/production/tasks"
        )
}

fn enter_runtime_admission<'a>(
    state: &'a ServiceState,
    method: &str,
    path: &str,
) -> Result<Option<RuntimeAdmissionGuard<'a>>, Vec<u8>> {
    if !matches!(method, "POST" | "DELETE") || path == "/api/runtime/drain" {
        return Ok(None);
    }
    let mut admission = state.runtime_admission.lock().map_err(|_| {
        http_response(
            "503 Service Unavailable",
            "application/json; charset=utf-8",
            &json!({ "code": 503, "error": "runtime_admission_state_unavailable" }).to_string(),
        )
    })?;
    if !admission.accepting && !runtime_completion_route(method, path) {
        drop(admission);
        return Err(runtime_draining_http_response(state, path));
    }
    admission.in_flight = admission.in_flight.saturating_add(1);
    drop(admission);
    Ok(Some(RuntimeAdmissionGuard { state }))
}

fn runtime_drain_response(
    state: &ServiceState,
    request: &str,
    peer: Option<SocketAddr>,
) -> Vec<u8> {
    if !peer.is_some_and(|address| address.ip().is_loopback()) {
        return http_response(
            "403 Forbidden",
            "application/json; charset=utf-8",
            &json!({ "code": 403, "error": "runtime_drain_loopback_only" }).to_string(),
        );
    }
    let supplied = request_header(request, "X-Trigger-Operator-Token").unwrap_or_default();
    if state.runtime_drain_token.len() < 32
        || supplied.is_empty()
        || !constant_time_runtime_token_matches(&state.runtime_drain_token, supplied.as_bytes())
    {
        return http_response(
            "401 Unauthorized",
            "application/json; charset=utf-8",
            &json!({ "code": 401, "error": "runtime_drain_auth_required" }).to_string(),
        );
    }
    let mut admission = match state.runtime_admission.lock() {
        Ok(admission) => admission,
        Err(_) => {
            return http_response(
                "503 Service Unavailable",
                "application/json; charset=utf-8",
                &json!({ "code": 503, "error": "runtime_admission_state_unavailable" }).to_string(),
            )
        }
    };
    admission.accepting = false;
    drop(admission);
    // Publish the drain state before waiting at the production-command boundary. Interruptible
    // algorithm subprocesses poll this state and can now terminate cooperatively. Camera and
    // device calls remain non-interruptible; taking this barrier waits for their authoritative
    // result without pretending that an external side effect was cancelled.
    let _production_barrier = match state.production_command_lock.lock() {
        Ok(guard) => guard,
        Err(_) => {
            return http_response(
                "503 Service Unavailable",
                "application/json; charset=utf-8",
                &json!({ "code": 503, "error": "production_command_lock_poisoned" }).to_string(),
            )
        }
    };
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({ "code": 0, "admission": runtime_drain_status_json(state) }).to_string(),
    )
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

fn complete_password_change_sessions(state: &ServiceState, user_id: &str, keep_token: &str) {
    let now = current_time_millis();
    if let Ok(mut sessions) = state.sessions.lock() {
        sessions.retain(|token, session| {
            session.expires_at > now && (session.user_id != user_id || token == keep_token)
        });
        if let Some(session) = sessions.get_mut(keep_token) {
            session.must_change_password = false;
        }
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
        | ("GET", "/api/config/status")
        | ("GET", "/api/config/profiles")
        | ("GET", "/api/config/profile")
        | ("GET", "/api/storage/status")
        | ("GET", "/api/param")
        | ("GET", "/api/calibration/active")
        | ("GET", "/api/calibration/status")
        | ("GET", "/api/calibration/operations/detail")
        | ("POST", "/api/config/capture")
        | ("POST", "/api/config/connection")
        | ("POST", "/api/storage/config")
        | ("POST", "/api/storage/camera-roots")
        | ("POST", "/api/config/profile/save")
        | ("POST", "/api/config/profile/apply")
        | ("POST", "/api/config/profile/import")
        | ("POST", "/api/config/camera-params/save-all")
        | ("POST", "/api/config/camera-params/load-all")
        | ("POST", "/api/cameras/connect-all")
        | ("POST", "/api/camera/connect-all")
        | ("POST", "/api/camera/connect")
        | ("POST", "/api/camera/disconnect")
        | ("POST", "/api/param/save-device")
        | ("POST", "/api/param/save-to-device")
        | ("POST", "/api/param/save-file")
        | ("POST", "/api/param/load-file")
        | ("POST", "/api/param/recovery")
        | ("POST", "/api/param")
        | ("POST", "/api/capture/continuous-test")
        | ("POST", "/api/capture/preset/line-continuous")
        | ("POST", "/api/calibration/load")
        | ("POST", "/api/calibration/apply-all")
        | ("POST", "/api/calibration/rollback")
        | ("POST", "/api/calibration/active")
        | ("POST", "/api/roi/load")
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
        | ("POST", "/api/admin/services/capture/restart")
        | ("POST", "/api/trigger/mode")
        | ("POST", "/api/trigger/manual/steel-info")
        | ("POST", "/api/trigger/manual/steel-in")
        | ("POST", "/api/trigger/manual/steel-out")
        | ("POST", "/api/trigger/capture-once") => Some("admin.services"),
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
        | ("GET", "/api/admin/records/reports")
        | ("GET", "/api/admin/records/reports/detail")
        | ("POST", "/api/admin/records/reports")
        | ("GET", "/api/admin/records/cleanup")
        | ("GET", "/api/admin/records/export")
        | ("POST", "/api/admin/records/retention")
        | ("POST", "/api/admin/records/cleanup/retry")
        | ("DELETE", "/api/admin/records") => Some("admin.records"),
        ("POST", "/api/alarms/acknowledge") | ("POST", "/api/alarms/resolve") => {
            Some("admin.records")
        }
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
    let required_permission = permission_for_route(method, path);
    let session = session_from_request(state, request);
    if session
        .as_ref()
        .is_some_and(|session| session.must_change_password)
        && !matches!(
            (method, path),
            ("GET", "/api/admin/auth/me")
                | ("POST", "/api/admin/auth/password")
                | ("POST", "/api/admin/auth/logout")
        )
    {
        return Err(auth_failure(
            "403 Forbidden",
            403,
            "password_change_required",
        ));
    }
    let Some(required_permission) = required_permission else {
        return Ok(session);
    };
    let Some(session) = session else {
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
        must_change_password: user.must_change_password,
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
    complete_password_change_sessions(state, &session.user_id, &token);
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
        .unwrap_or_else(|_| json!({ "running": false, "fallback": "simulated-eight-camera" }));
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
                    "检测记录 {} 条，缺陷 {} 条，钢管 {} 条",
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
        validate_optional_bool_field(
            service_object,
            "captureManaged",
            "capture_managed",
            "service",
        )?;
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
            "409 Conflict",
            "application/json; charset=utf-8",
            &json!({
                "code": 409,
                "error": "database_backup_requires_server_side_job",
                "engine": state.database.engine,
                "tool": "scripts/backup-database.ps1"
            })
            .to_string(),
        );
    };
    let Some(parent) = path.parent() else {
        return http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            "{\"error\":\"database path has no parent\"}",
        );
    };
    let snapshot_path = parent.join(format!(
        ".steel-inspection-backup-{}-{}.sqlite",
        std::process::id(),
        current_time_millis()
    ));
    let snapshot_sql_path = snapshot_path
        .display()
        .to_string()
        .replace('\\', "/")
        .replace('\'', "''");
    let snapshot_result =
        state
            .runtime
            .block_on(state.database.connection.execute(Statement::from_string(
                DbBackend::Sqlite,
                format!("VACUUM INTO '{snapshot_sql_path}'"),
            )));
    if let Err(error) = snapshot_result {
        let _ = fs::remove_file(&snapshot_path);
        let _ = state.runtime.block_on(db::append_audit_log(
            &state.database.connection,
            actor,
            "database.backup.failed",
            "steel-inspection.sqlite",
            &format!("SQLite 在线一致性快照失败：{error}"),
            "error",
        ));
        return http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "error": "sqlite_online_backup_failed" }).to_string(),
        );
    }
    let read_result = fs::read(&snapshot_path);
    let _ = fs::remove_file(&snapshot_path);
    match read_result {
        Ok(bytes) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "database.backup",
                "steel-inspection.sqlite",
                &format!("下载 SQLite 在线一致性备份（{} bytes）", bytes.len()),
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
                &format!("SQLite 在线备份读取失败：{error}"),
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

fn capture_proxy_status(status_code: u16) -> String {
    let reason = match status_code {
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        408 => "Request Timeout",
        409 => "Conflict",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Capture Provider Response",
    };
    format!("{status_code} {reason}")
}

fn capture_provider_unavailable_response(capture: &CaptureServiceManager) -> Vec<u8> {
    http_response(
        "503 Service Unavailable",
        "application/json; charset=utf-8",
        &json!({
            "code": 503,
            "error": "capture_provider_unavailable",
            "provider": capture.provider.as_str(),
            "simulated": false,
            "retryable": true
        })
        .to_string(),
    )
}

fn capture_proxy_http_response(
    capture: &CaptureServiceManager,
    method: &str,
    raw_path: &str,
    path: &str,
    body: &str,
) -> Vec<u8> {
    if method == "POST" && path == "/api/capture/preset/line-continuous" {
        if let Err(error) = validate_line_continuous_preset_request(body) {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({
                    "code": 400,
                    "error": error,
                    "requiredConfirmation": LINE_CONTINUOUS_PRESET_CONFIRMATION,
                    "requiredDeviceConfirmation": LINE_CONTINUOUS_DEVICE_PERSIST_CONFIRMATION,
                })
                .to_string(),
            );
        }
    } else if method == "POST" {
        if let Err(error) = validate_capture_device_mutation_request(path, body) {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({
                    "code": 400,
                    "error": error,
                    "requiredDeviceConfirmation": CAMERA_DEVICE_PERSIST_CONFIRMATION,
                    "requiredParameterConfirmation": SDK_PARAMETER_WRITE_CONFIRMATION,
                    "requiredCalibrationConfirmation": CAMERA_CALIBRATION_CONFIRMATION,
                    "requiredCalibrationSetConfirmation": CAMERA_CALIBRATION_SET_CONFIRMATION,
                    "requiredCalibrationRollbackConfirmation": CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION,
                    "requiredRoiConfirmation": CAMERA_ROI_CONFIRMATION,
                })
                .to_string(),
            );
        }
    }
    let proxy_response = if method == "POST" && path == "/api/capture/continuous-test" {
        let payload = serde_json::from_str::<Value>(body.trim()).unwrap_or_else(|_| json!({}));
        capture.proxy_response_with_read_timeout(
            method,
            raw_path,
            body,
            continuous_capture_proxy_timeout(&payload),
        )
    } else if method == "POST"
        && matches!(
            path,
            "/api/config/profile/apply"
                | "/api/config/camera-params/save-all"
                | "/api/config/camera-params/load-all"
                | "/api/capture/continuous-settings"
                | "/api/capture/preset/line-continuous"
                | "/api/steel/capture-mode"
                | "/api/calibration/apply-all"
                | "/api/calibration/rollback"
        )
    {
        capture.proxy_response_with_read_timeout(method, raw_path, body, Duration::from_secs(120))
    } else {
        capture.proxy_response(method, raw_path, body)
    };
    if let Some(response) = proxy_response {
        return http_bytes_response_with_headers(
            &capture_proxy_status(response.status_code),
            &response.content_type,
            &response.body,
            &[],
        );
    }
    if capture.provider == CaptureProvider::Simulated {
        return fallback_capture_response(path);
    }
    capture_provider_unavailable_response(capture)
}

fn trigger_gateway_proxy_http_response(
    state: &ServiceState,
    method: &str,
    raw_path: &str,
    body: &str,
    actor: &str,
) -> Vec<u8> {
    let operator_token = env::var("TRIGGER_OPERATOR_TOKEN").unwrap_or_default();
    let operator_headers = if method == "POST" && !operator_token.is_empty() {
        vec![("X-Trigger-Operator-Token", operator_token.as_str())]
    } else {
        Vec::new()
    };
    match bounded_local_http_request(
        &state.trigger_gateway_origin,
        method,
        raw_path,
        body,
        Duration::from_secs(8),
        &operator_headers,
    ) {
        Ok(response) => {
            if method == "POST" {
                let path = split_path_and_query(raw_path).0;
                let _ = state.runtime.block_on(db::append_audit_log(
                    &state.database.connection,
                    actor,
                    "trigger.operator.forwarded",
                    path,
                    &format!("触发网关操作已转发，HTTP 状态 {}", response.status_code),
                    if response.status_code < 400 {
                        "info"
                    } else {
                        "warning"
                    },
                ));
            }
            http_bytes_response_with_headers(
                &capture_proxy_status(response.status_code),
                &response.content_type,
                &response.body,
                &[],
            )
        }
        Err(HealthHttpProbeError::Timeout) => http_response(
            "504 Gateway Timeout",
            "application/json; charset=utf-8",
            &json!({ "code": 504, "error": "trigger_gateway_timeout" }).to_string(),
        ),
        Err(_) => http_response(
            "503 Service Unavailable",
            "application/json; charset=utf-8",
            &json!({ "code": 503, "error": "trigger_gateway_unavailable" }).to_string(),
        ),
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
    value_f64_or(payload, keys, 0.0)
}

fn value_f64_or(payload: &Value, keys: &[&str], fallback: f64) -> f64 {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(|value| {
            value.as_f64().or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<f64>().ok())
            })
        })
        .unwrap_or(fallback)
}

fn value_i32(payload: &Value, keys: &[&str], fallback: i32) -> i32 {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_bool().map(|flag| if flag { 1 } else { 0 }))
                .or_else(|| {
                    value
                        .as_str()
                        .and_then(|text| text.trim().parse::<i64>().ok())
                })
        })
        .and_then(|value| i32::try_from(value).ok())
        .unwrap_or(fallback)
}

fn value_bool(payload: &Value, keys: &[&str], fallback: bool) -> bool {
    keys.iter()
        .find_map(|key| payload.get(*key))
        .and_then(|value| {
            value
                .as_bool()
                .or_else(|| value.as_i64().map(|item| item != 0))
                .or_else(|| {
                    value.as_str().and_then(|text| {
                        match text.trim().to_ascii_lowercase().as_str() {
                            "true" | "1" | "yes" => Some(true),
                            "false" | "0" | "no" => Some(false),
                            _ => None,
                        }
                    })
                })
        })
        .unwrap_or(fallback)
}

fn material_id_from_payload(payload: &Value, fallback: &str) -> String {
    let id = value_string(
        payload,
        &[
            "materialId",
            "material_id",
            "steelId",
            "steel_id",
            "steelNo",
            "steel_no",
            "id",
        ],
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

#[derive(Debug, PartialEq, Eq)]
struct ProductionEventTarget {
    material_id: String,
    session_id: String,
}

#[derive(Debug, PartialEq, Eq)]
enum ProductionTransitionConflict {
    ActiveSessionRequired,
    ActiveSessionMismatch {
        active_material_id: String,
        active_session_id: String,
        requested_material_id: String,
        requested_session_id: String,
    },
}

fn resolve_production_event_target(
    payload: &Value,
    event: &str,
    active_session: Option<(&str, &str)>,
    generated_at: u128,
) -> Result<ProductionEventTarget, ProductionTransitionConflict> {
    let requested_material_id = material_id_from_payload(payload, "");
    let requested_session_id = value_string(payload, &["sessionId", "session_id"]);

    if event == "steel-out" && active_session.is_none() {
        return Err(ProductionTransitionConflict::ActiveSessionRequired);
    }

    if matches!(event, "steel-in" | "steel-out") {
        if let Some((active_material_id, active_session_id)) = active_session {
            let material_mismatch =
                !requested_material_id.is_empty() && requested_material_id != active_material_id;
            let session_mismatch =
                !requested_session_id.is_empty() && requested_session_id != active_session_id;
            if material_mismatch || session_mismatch {
                return Err(ProductionTransitionConflict::ActiveSessionMismatch {
                    active_material_id: active_material_id.to_string(),
                    active_session_id: active_session_id.to_string(),
                    requested_material_id,
                    requested_session_id,
                });
            }
        }
    }

    let material_id = if requested_material_id.is_empty() {
        active_session
            .map(|(material_id, _)| material_id.to_string())
            .unwrap_or_else(|| "unknown-material".to_string())
    } else {
        requested_material_id
    };
    let session_id = if requested_session_id.is_empty() {
        active_session
            .filter(|(active_material_id, _)| {
                event == "steel-out" || *active_material_id == material_id
            })
            .map(|(_, session_id)| session_id.to_string())
            .unwrap_or_else(|| format!("{material_id}-{generated_at}"))
    } else {
        requested_session_id
    };

    Ok(ProductionEventTarget {
        material_id,
        session_id,
    })
}

fn production_transition_conflict_response(conflict: ProductionTransitionConflict) -> Vec<u8> {
    let body = match conflict {
        ProductionTransitionConflict::ActiveSessionRequired => json!({
            "code": 409,
            "error": "active_session_required",
            "message": "steel-out requires an active steel-in session"
        }),
        ProductionTransitionConflict::ActiveSessionMismatch {
            active_material_id,
            active_session_id,
            requested_material_id,
            requested_session_id,
        } => json!({
            "code": 409,
            "error": "active_session_conflict",
            "message": "the requested production session does not match the active session",
            "activeMaterialId": active_material_id,
            "activeSessionId": active_session_id,
            "requestedMaterialId": requested_material_id,
            "requestedSessionId": requested_session_id
        }),
    };
    http_response(
        "409 Conflict",
        "application/json; charset=utf-8",
        &body.to_string(),
    )
}

fn production_database_error_response(operation: &str, error: &str) -> Vec<u8> {
    http_response(
        "500 Internal Server Error",
        "application/json; charset=utf-8",
        &json!({
            "code": 500,
            "error": "production_state_persistence_failed",
            "operation": operation,
            "detail": error
        })
        .to_string(),
    )
}

fn provider_code_from_response(provider: &Value, fallback: i32) -> i32 {
    provider
        .get("code")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .unwrap_or(fallback)
}

fn production_status_response(state: &ServiceState) -> Vec<u8> {
    let latest_session = match state
        .runtime
        .block_on(db::latest_material_session(&state.database.connection))
    {
        Ok(session) => session,
        Err(error) => {
            return production_database_error_response("load_latest_session", &error.to_string());
        }
    };
    let active_session = match state
        .runtime
        .block_on(db::latest_open_material_session(&state.database.connection))
    {
        Ok(session) => session,
        Err(error) => {
            return production_database_error_response("load_active_session", &error.to_string());
        }
    };
    let latest_session_json = latest_session.as_ref().map(|session| {
        json!({
            "id": session.id,
            "materialId": session.material_id,
            "status": session.status,
            "controlMode": session.control_mode,
            "triggerMode": session.trigger_mode,
            "updatedAt": session.updated_at
        })
    });
    let active_session_json = active_session.as_ref().map(|session| {
        json!({
            "id": session.id,
            "materialId": session.material_id,
            "status": session.status,
            "controlMode": session.control_mode,
            "triggerMode": session.trigger_mode,
            "updatedAt": session.updated_at
        })
    });
    let latest_inspection = match state
        .runtime
        .block_on(db::latest_production_inspection(&state.database.connection))
    {
        Ok(inspection) => inspection,
        Err(error) => {
            return production_database_error_response(
                "load_latest_production_inspection",
                &error.to_string(),
            );
        }
    };
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
                "path": state.database.display_path(),
                "schemaVersion": state.database.schema_version
            },
            "latestSession": latest_session_json,
            "activeSession": active_session_json,
            "admission": runtime_drain_status_json(state),
            "latestInspection": latest_inspection.map(|inspection| {
                let capture_summary_path = production_session_summary_path(
                    &inspection.storage_root,
                    &inspection.material_id,
                    &inspection.session_id,
                )
                .map(|path| path.display().to_string())
                .unwrap_or_default();
                json!({
                    "id": inspection.id,
                    "materialId": inspection.material_id,
                    "sessionId": inspection.session_id,
                    "status": inspection.status,
                    "summaryPath": inspection.summary_path,
                    "captureSummaryPath": capture_summary_path,
                    "captureCount": inspection.capture_count,
                    "defectCount": inspection.defect_count,
                    "startedAt": inspection.started_at,
                    "finishedAt": inspection.finished_at
                })
            }),
            "tasks": production_tasks::status_json(state),
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
    let payload_type =
        value_string(&payload, &["payloadType", "payload_type", "type"]).if_empty("secondary");
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

fn new_session_storage_admission_response(
    event: &str,
    existing_session: bool,
    storage_ok: bool,
    storage: &Value,
) -> Option<Vec<u8>> {
    if existing_session || !matches!(event, "steel-info" | "steel-in") || storage_ok {
        return None;
    }
    Some(http_response(
        "503 Service Unavailable",
        "application/json; charset=utf-8",
        &json!({
            "code": 503,
            "error": "storage_not_ready_for_new_session",
            "storageReason": storage.get("reason").cloned().unwrap_or(Value::Null),
            "retryable": true
        })
        .to_string(),
    ))
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
    if !production_tasks::worker_execution_scope_active() {
        let open_tasks = match state
            .runtime
            .block_on(db::count_open_production_tasks(&state.database.connection))
        {
            Ok(count) => count,
            Err(error) => {
                return production_database_error_response(
                    "count_open_production_tasks",
                    &error.to_string(),
                );
            }
        };
        if open_tasks > 0 {
            return http_response(
                "409 Conflict",
                "application/json; charset=utf-8",
                &json!({
                    "code": 409,
                    "error": "production_tasks_in_progress",
                    "queueDepth": open_tasks,
                    "retryable": true
                })
                .to_string(),
            );
        }
    }
    let latest_open = match state
        .runtime
        .block_on(db::latest_open_material_session(&state.database.connection))
    {
        Ok(session) => session,
        Err(error) => {
            return production_database_error_response("load_active_session", &error.to_string());
        }
    };
    if default_event == "steel-out" {
        if let Some(session) = latest_open.as_ref() {
            if !matches!(
                session.status.as_str(),
                "active" | "finishing" | "exit-failed"
            ) {
                return http_response(
                    "409 Conflict",
                    "application/json; charset=utf-8",
                    &json!({
                        "code": 409,
                        "error": "production_session_not_exit_ready",
                        "materialId": session.material_id,
                        "sessionId": session.id,
                        "status": session.status,
                        "allowedStatuses": ["active", "finishing", "exit-failed"]
                    })
                    .to_string(),
                );
            }
        }
    }
    let target = match resolve_production_event_target(
        &payload,
        default_event,
        latest_open
            .as_ref()
            .map(|session| (session.material_id.as_str(), session.id.as_str())),
        current_time_millis(),
    ) {
        Ok(target) => target,
        Err(conflict) => return production_transition_conflict_response(conflict),
    };
    let material_id = target.material_id;
    let session_id = target.session_id;
    let previous_session = latest_open
        .as_ref()
        .filter(|session| session.id == session_id && session.material_id == material_id);
    if matches!(default_event, "steel-info" | "steel-in") && previous_session.is_none() {
        let (storage_ok, storage) = storage_health_component(state);
        if let Some(response) =
            new_session_storage_admission_response(default_event, false, storage_ok, &storage)
        {
            let reason = storage
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("storage_unavailable");
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "production.session.rejected.storage",
                &material_id,
                &format!("new {default_event} session rejected: {reason}"),
                "warning",
            ));
            return response;
        }
    }
    let source = value_string(&payload, &["source"]).if_empty(
        previous_session
            .map(|session| session.source.as_str())
            .unwrap_or("api"),
    );
    let mode = value_string(&payload, &["mode", "controlMode", "control_mode"]).if_empty(
        previous_session
            .map(|session| session.control_mode.as_str())
            .unwrap_or("api"),
    );
    let trigger_mode = value_string(&payload, &["triggerMode", "trigger_mode"]).if_empty(
        previous_session
            .map(|session| session.trigger_mode.as_str())
            .unwrap_or(&mode),
    );
    let requested_capture_mode = value_string(&payload, &["captureMode", "capture_mode"]);
    let capture_mode = if requested_capture_mode.is_empty() {
        None
    } else {
        match normalize_capture_output_mode(&requested_capture_mode) {
            Some(mode) => Some(mode),
            None => {
                return http_response(
                    "400 Bad Request",
                    "application/json; charset=utf-8",
                    &json!({
                        "code": 400,
                        "error": "invalid_capture_mode",
                        "message": "captureMode must be continuous, on-demand, or disabled"
                    })
                    .to_string(),
                );
            }
        }
    };
    let command = value_string(&payload, &["cmd", "command", "event", "type"]).if_empty(
        match default_event {
            "steel-info" => "rcvSteelInfo",
            "steel-out" => "steelIn",
            _ => "steelIn",
        },
    );
    let value = match default_event {
        "steel-out" => 0,
        "steel-info" => value_i32(&payload, &["value"], 0),
        _ => value_i32(&payload, &["value", "present"], 1),
    };
    let status = match default_event {
        "steel-out" => "finishing",
        "steel-info" => "info-pending",
        "steel-in" => "starting",
        _ => "active",
    };
    let now = current_time_string();
    let steel_type = value_string(&payload, &["steelType", "steel_type", "type"]).if_empty(
        previous_session
            .map(|session| session.steel_type.as_str())
            .unwrap_or_default(),
    );
    let width_mm = value_f64_or(
        &payload,
        &["width", "widthMm", "width_mm"],
        previous_session
            .map(|session| session.width_mm)
            .unwrap_or(0.0),
    );
    let length_mm = value_f64_or(
        &payload,
        &["length", "len", "lengthMm", "length_mm"],
        previous_session
            .map(|session| session.length_mm)
            .unwrap_or(0.0),
    );
    let thickness_mm = value_f64_or(
        &payload,
        &["thick", "thickness", "thicknessMm", "thickness_mm"],
        previous_session
            .map(|session| session.thickness_mm)
            .unwrap_or(0.0),
    );
    let client = value_string(&payload, &["client"]).if_empty(
        previous_session
            .map(|session| session.client.as_str())
            .unwrap_or_default(),
    );
    let hard = value_string(&payload, &["hard"]).if_empty(
        previous_session
            .map(|session| session.hard.as_str())
            .unwrap_or_default(),
    );
    let storage_root = value_string(&payload, &["storageRoot", "storage_root"]).if_empty(
        previous_session
            .map(|session| session.storage_root.as_str())
            .unwrap_or_default(),
    );
    let started_at = previous_session
        .map(|session| session.started_at.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| now.clone());
    let session_input = db::MaterialSessionInput {
        id: session_id.clone(),
        material_id: material_id.clone(),
        source: source.clone(),
        status: status.to_string(),
        control_mode: mode.clone(),
        trigger_mode: trigger_mode.clone(),
        steel_type: steel_type.clone(),
        width_mm,
        length_mm,
        thickness_mm,
        client: client.clone(),
        hard: hard.clone(),
        storage_root: storage_root.clone(),
        started_at,
        finished_at: String::new(),
        raw_payload: payload.to_string(),
    };
    let session_result = state.runtime.block_on(db::upsert_material_session(
        &state.database.connection,
        session_input,
    ));
    let session = match session_result {
        Ok(session) => session,
        Err(error) => {
            return production_database_error_response(
                "upsert_material_session",
                &error.to_string(),
            );
        }
    };
    let inspection_id = format!("INSP-{session_id}");
    let existing_inspection = match state.runtime.block_on(db::find_production_inspection(
        &state.database.connection,
        &inspection_id,
    )) {
        Ok(inspection) => inspection,
        Err(error) => {
            return production_database_error_response(
                "load_production_inspection",
                &error.to_string(),
            );
        }
    };
    let inspection_storage_root = value_string(&payload, &["storageRoot", "storage_root"])
        .if_empty(
            existing_inspection
                .as_ref()
                .map(|inspection| inspection.storage_root.as_str())
                .unwrap_or_default(),
        );
    let inspection_summary_path = value_string(&payload, &["summaryPath", "summary_path"])
        .if_empty(
            existing_inspection
                .as_ref()
                .map(|inspection| inspection.summary_path.as_str())
                .unwrap_or_default(),
        );
    let inspection_started_at = existing_inspection
        .as_ref()
        .map(|inspection| inspection.started_at.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| now.clone());
    let inspection_capture_count = value_i32(
        &payload,
        &["captureCount", "capture_count"],
        existing_inspection
            .as_ref()
            .map(|inspection| inspection.capture_count)
            .unwrap_or(0),
    );
    let inspection_defect_count = value_i32(
        &payload,
        &["defectCount", "defect_count"],
        existing_inspection
            .as_ref()
            .map(|inspection| inspection.defect_count)
            .unwrap_or(0),
    );
    let inspection_result = state.runtime.block_on(db::upsert_production_inspection(
        &state.database.connection,
        db::ProductionInspectionInput {
            id: inspection_id.clone(),
            material_id: material_id.clone(),
            session_id: session_id.clone(),
            status: status.to_string(),
            storage_root: inspection_storage_root,
            summary_path: inspection_summary_path,
            started_at: inspection_started_at,
            finished_at: String::new(),
            capture_count: inspection_capture_count,
            defect_count: inspection_defect_count,
            raw_payload: payload.to_string(),
        },
    ));
    let inspection = match inspection_result {
        Ok(inspection) => inspection,
        Err(error) => {
            return production_database_error_response(
                "upsert_production_inspection",
                &error.to_string(),
            );
        }
    };

    let acquisition_mode = value_string(
        &payload,
        &[
            "acquisitionMode",
            "acquisition_mode",
            "triggerSource",
            "trigger_source",
        ],
    )
    .if_empty(&trigger_mode);
    let capture_save_state = match default_event {
        "steel-in" => "save",
        "steel-out" => "discard",
        _ => "idle",
    };
    let save_enabled = default_event == "steel-in";
    let discard_black_frames = payload
        .get("discardBlackFrames")
        .or_else(|| payload.get("discard_black_frames"))
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let mut provider_payload = json!({
        "cmd": command.clone(),
        "value": value,
        "id": material_id,
        "steelId": material_id,
        "steelNo": material_id,
        "sessionId": session_id,
        "inspectionId": inspection_id,
        "steelType": steel_type,
        "length": length_mm,
        "width": width_mm,
        "thick": thickness_mm,
        "client": client,
        "hard": hard,
        "acquisitionMode": acquisition_mode,
        "captureSaveState": capture_save_state,
        "saveEnabled": save_enabled,
        "saveSdkDerived": false,
        "discardBlackFrames": discard_black_frames,
        "lines": value_i32(&payload, &["lines", "depthLines", "depth_lines"], 1280).clamp(1, 100_000),
        "intervalMs": value_i32(&payload, &["intervalMs", "interval_ms"], 0).clamp(0, 600_000),
        "algorithmPhase": "pending"
    });
    if let Some(auto_capture) = payload
        .get("autoCapture")
        .or_else(|| payload.get("auto_capture"))
        .and_then(Value::as_bool)
    {
        if let Some(object) = provider_payload.as_object_mut() {
            object.insert("autoCapture".to_string(), json!(auto_capture));
        }
    }
    if let Some(capture_mode) = capture_mode {
        if let Some(object) = provider_payload.as_object_mut() {
            object.insert("captureMode".to_string(), json!(capture_mode));
        }
    }
    let provider_body = provider_payload.to_string();
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
    let provider_succeeded = provider_code == 0;
    let final_session_status = match (default_event, provider_succeeded) {
        ("steel-in", true) => "active",
        ("steel-in", false) => "start-failed",
        ("steel-out", true) => "finished",
        ("steel-out", false) => "exit-failed",
        ("steel-info", true) => "info-ready",
        ("steel-info", false) => "info-failed",
        (_, true) => "active",
        (_, false) => "event-failed",
    };
    let final_inspection_status = match (default_event, provider_succeeded) {
        ("steel-in", true) => "running",
        ("steel-in", false) => "start-failed",
        ("steel-out", true) => "finished",
        ("steel-out", false) => "exit-failed",
        ("steel-info", true) => "info-ready",
        ("steel-info", false) => "info-failed",
        (_, true) => "running",
        (_, false) => "event-failed",
    };
    let finished_at = if default_event == "steel-out" && provider_succeeded {
        now.clone()
    } else {
        String::new()
    };
    if let Err(error) = state.runtime.block_on(db::upsert_material_session(
        &state.database.connection,
        db::MaterialSessionInput {
            id: session.id.clone(),
            material_id: session.material_id.clone(),
            source: session.source.clone(),
            status: final_session_status.to_string(),
            control_mode: session.control_mode.clone(),
            trigger_mode: session.trigger_mode.clone(),
            steel_type: session.steel_type.clone(),
            width_mm: session.width_mm,
            length_mm: session.length_mm,
            thickness_mm: session.thickness_mm,
            client: session.client.clone(),
            hard: session.hard.clone(),
            storage_root: session.storage_root.clone(),
            started_at: session.started_at.clone(),
            finished_at: finished_at.clone(),
            raw_payload: payload.to_string(),
        },
    )) {
        return production_database_error_response("finalize_material_session", &error.to_string());
    }
    if let Err(error) = state.runtime.block_on(db::upsert_production_inspection(
        &state.database.connection,
        db::ProductionInspectionInput {
            id: inspection.id.clone(),
            material_id: inspection.material_id.clone(),
            session_id: inspection.session_id.clone(),
            status: final_inspection_status.to_string(),
            storage_root: inspection.storage_root.clone(),
            summary_path: inspection.summary_path.clone(),
            started_at: inspection.started_at.clone(),
            finished_at,
            capture_count: inspection.capture_count,
            defect_count: inspection.defect_count,
            raw_payload: payload.to_string(),
        },
    )) {
        return production_database_error_response(
            "finalize_production_inspection",
            &error.to_string(),
        );
    }
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        "production.trigger_event",
        &material_id,
        &format!("{default_event} from {source} mode={mode} providerCode={provider_code}"),
        if provider_code == 0 {
            "info"
        } else {
            "warning"
        },
    ));
    let final_summary = if default_event == "steel-out" && provider_succeeded {
        write_final_production_summary_file(
            state,
            &material_id,
            &session_id,
            &inspection_id,
            &provider_response,
        )
    } else {
        Value::Null
    };
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
                "flow": {
                    "recordWrittenBeforeCapture": true,
                    "captureSaveState": capture_save_state,
                    "saveEnabled": save_enabled,
                    "discardBlackFrames": discard_black_frames,
                    "algorithmPhase": "pending"
                },
                "provider": provider_response,
                "finalSummary": final_summary
            })
            .to_string(),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string(), "provider": provider_response, "finalSummary": final_summary })
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

fn capture_requires_open_session(payload: &Value) -> bool {
    value_bool(payload, &["steelStateAware", "steel_state_aware"], true)
        && value_bool(
            payload,
            &["requireSteelPresent", "require_steel_present"],
            true,
        )
}

fn validate_capture_open_session(state: &ServiceState, payload: &Value) -> Result<(), Vec<u8>> {
    if !capture_requires_open_session(payload) {
        return Ok(());
    }

    let requested_material = value_string(payload, &["materialId", "material_id", "steelId", "id"]);
    let requested_session = value_string(payload, &["sessionId", "session_id"]);
    let open_session = if requested_session.is_empty() {
        state
            .runtime
            .block_on(db::latest_open_material_session(&state.database.connection))
    } else {
        state.runtime.block_on(db::find_material_session(
            &state.database.connection,
            &requested_session,
        ))
    }
    .map_err(|error| {
        http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        )
    })?;

    let Some(session) = open_session else {
        return Err(http_response(
            "409 Conflict",
            "application/json; charset=utf-8",
            &json!({
                "code": 409,
                "error": "steel_not_present",
                "message": "capture requires an active steel-in session before saving images",
                "requireSteelPresent": true
            })
            .to_string(),
        ));
    };

    if session.status != "active" {
        return Err(http_response(
            "409 Conflict",
            "application/json; charset=utf-8",
            &json!({
                "code": 409,
                "error": "production_session_not_capture_ready",
                "message": "capture requires a production session whose steel-in command completed successfully",
                "materialId": session.material_id,
                "sessionId": session.id,
                "sessionStatus": session.status,
                "requireSteelPresent": true
            })
            .to_string(),
        ));
    }

    if !requested_material.is_empty() && session.material_id != requested_material {
        return Err(http_response(
            "409 Conflict",
            "application/json; charset=utf-8",
            &json!({
                "code": 409,
                "error": "steel_session_mismatch",
                "message": "capture material does not match the active steel-in session",
                "requestedMaterialId": requested_material,
                "activeMaterialId": session.material_id,
                "activeSessionId": session.id,
                "requireSteelPresent": true
            })
            .to_string(),
        ));
    }

    Ok(())
}

fn continuous_capture_proxy_timeout(payload: &Value) -> Duration {
    let rounds = i64::from(value_i32(payload, &["rounds"], 1)).max(1);
    let timeout_ms = i64::from(value_i32(payload, &["timeoutMs", "timeout_ms"], 8000)).max(100);
    let interval_ms = i64::from(value_i32(payload, &["intervalMs", "interval_ms"], 500)).max(0);
    let retries = i64::from(value_i32(payload, &["retries"], 0)).max(0);
    let per_round_ms = timeout_ms
        .saturating_mul(retries.saturating_add(1))
        .saturating_add(interval_ms);
    let total_ms = per_round_ms
        .saturating_mul(rounds)
        .saturating_add(90_000)
        .clamp(60_000, 3_600_000);
    Duration::from_millis(total_ms as u64)
}

fn safe_storage_segment(value: &str) -> String {
    let segment = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if segment.is_empty() {
        "unknown".to_string()
    } else {
        segment
    }
}

fn production_summary_path(
    summary: &Value,
    material_id: &str,
    session_id: &str,
) -> Option<PathBuf> {
    let storage_root = value_string(summary, &["storageRoot", "storage_root"]);
    production_session_summary_path(&storage_root, material_id, session_id)
}

fn production_session_summary_path(
    storage_root: &str,
    material_id: &str,
    session_id: &str,
) -> Option<PathBuf> {
    if storage_root.trim().is_empty() || storage_root.contains("://") {
        return None;
    }
    Some(
        Path::new(storage_root)
            .join("production")
            .join(safe_storage_segment(material_id))
            .join(safe_storage_segment(session_id))
            .join("summary.json"),
    )
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
        (
            "depth",
            "png",
            value_string(result, &["depthOutput", "output"]),
            value_bool(result, &["depthExists"], true),
        ),
        (
            "intensity",
            "png",
            value_string(result, &["intensityOutput"]),
            value_bool(result, &["intensityExists"], true),
        ),
        (
            "metadata",
            "json",
            metadata_path.clone(),
            value_bool(result, &["metadataExists"], true),
        ),
        (
            "sdk-derived",
            "png",
            value_string(result, &["sdkOutput"]),
            value_bool(result, &["sdkExists"], true),
        ),
        (
            "sdk-derived-depth",
            "png",
            value_string(result, &["sdkDepthOutput"]),
            value_bool(result, &["sdkDepthExists"], true),
        ),
        (
            "sdk-derived-intensity",
            "png",
            value_string(result, &["sdkIntensityOutput"]),
            value_bool(result, &["sdkIntensityExists"], true),
        ),
    ];
    let mut inserted = 0;
    for (data_name, file_type, path, exists) in outputs {
        if path.trim().is_empty() || !exists {
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

fn write_final_production_summary_file(
    state: &ServiceState,
    material_id: &str,
    session_id: &str,
    inspection_id: &str,
    provider_response: &Value,
) -> Value {
    let inspection = match state.runtime.block_on(db::find_production_inspection(
        &state.database.connection,
        inspection_id,
    )) {
        Ok(Some(value)) => value,
        Ok(None) => {
            return json!({
                "ok": false,
                "error": "production_inspection_not_found",
                "inspectionId": inspection_id
            });
        }
        Err(error) => {
            return json!({
                "ok": false,
                "error": error.to_string(),
                "inspectionId": inspection_id
            });
        }
    };
    let summary_path = inspection.summary_path.trim().to_string();
    if summary_path.is_empty() {
        return json!({
            "ok": false,
            "error": "summary_path_empty",
            "inspectionId": inspection_id
        });
    }

    let session = state
        .runtime
        .block_on(db::find_material_session(
            &state.database.connection,
            session_id,
        ))
        .ok()
        .flatten();
    let files = match state.runtime.block_on(db::capture_files_for_inspection(
        &state.database.connection,
        inspection_id,
    )) {
        Ok(value) => value,
        Err(error) => {
            return json!({
                "ok": false,
                "error": error.to_string(),
                "inspectionId": inspection_id,
                "path": summary_path
            });
        }
    };
    let file_items = files
        .iter()
        .map(|file| {
            json!({
                "id": file.id,
                "cameraId": file.camera_id,
                "cameraIp": file.camera_ip,
                "dataName": file.data_name,
                "sequenceNo": file.sequence_no,
                "fileType": file.file_type,
                "path": file.path,
                "metadataPath": file.metadata_path,
                "createdAt": file.created_at
            })
        })
        .collect::<Vec<_>>();
    let depth_count = files
        .iter()
        .filter(|file| file.data_name == "depth")
        .count();
    let intensity_count = files
        .iter()
        .filter(|file| file.data_name == "intensity")
        .count();
    let metadata_count = files
        .iter()
        .filter(|file| file.data_name == "metadata")
        .count();
    let sdk_derived_count = files
        .iter()
        .filter(|file| file.data_name.starts_with("sdk-derived"))
        .count();
    let file_count = file_items.len();
    let summary = json!({
        "schema": "steel.production.summary.v1",
        "writtenAt": current_time_string(),
        "materialId": material_id,
        "sessionId": session_id,
        "inspectionId": inspection_id,
        "session": session.as_ref().map(|item| {
            json!({
                "id": item.id,
                "materialId": item.material_id,
                "status": item.status,
                "controlMode": item.control_mode,
                "triggerMode": item.trigger_mode,
                "steelType": item.steel_type,
                "widthMm": item.width_mm,
                "lengthMm": item.length_mm,
                "thicknessMm": item.thickness_mm,
                "startedAt": item.started_at,
                "finishedAt": item.finished_at,
                "updatedAt": item.updated_at
            })
        }),
        "inspection": {
            "id": inspection.id,
            "materialId": inspection.material_id,
            "sessionId": inspection.session_id,
            "status": inspection.status,
            "storageRoot": inspection.storage_root,
            "summaryPath": inspection.summary_path,
            "startedAt": inspection.started_at,
            "finishedAt": inspection.finished_at,
            "captureCount": inspection.capture_count,
            "defectCount": inspection.defect_count
        },
        "captureFiles": {
            "count": file_count,
            "depth": depth_count,
            "intensity": intensity_count,
            "metadata": metadata_count,
            "sdkDerived": sdk_derived_count,
            "items": file_items
        },
        "provider": provider_response
    });
    let path = Path::new(&summary_path);
    if let Some(parent) = path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return json!({
                "ok": false,
                "error": error.to_string(),
                "path": summary_path
            });
        }
    }
    match serde_json::to_string_pretty(&summary)
        .map_err(|error| error.to_string())
        .and_then(|text| fs::write(path, text).map_err(|error| error.to_string()))
    {
        Ok(()) => json!({
            "ok": true,
            "path": summary_path,
            "fileCount": file_count,
            "depth": depth_count,
            "intensity": intensity_count,
            "metadata": metadata_count,
            "sdkDerived": sdk_derived_count
        }),
        Err(error) => json!({
            "ok": false,
            "error": error,
            "path": summary_path
        }),
    }
}

fn update_production_summary_algorithm_section(
    storage_root: &str,
    material_id: &str,
    session_id: &str,
    inspection_id: &str,
    status: &str,
    manifest_path: &str,
    algorithm_payload: &Value,
) -> Value {
    let Some(path) = production_session_summary_path(storage_root, material_id, session_id) else {
        return json!({
            "ok": false,
            "error": "capture_summary_path_unavailable",
            "storageRoot": storage_root,
            "materialId": material_id,
            "sessionId": session_id
        });
    };
    if !path.is_file() {
        return json!({
            "ok": false,
            "error": "capture_summary_not_found",
            "path": path.display().to_string()
        });
    }
    let text = match fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) => {
            return json!({
                "ok": false,
                "error": error.to_string(),
                "path": path.display().to_string()
            });
        }
    };
    let mut summary = match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(object)) => object,
        Ok(_) => serde_json::Map::new(),
        Err(error) => {
            return json!({
                "ok": false,
                "error": error.to_string(),
                "path": path.display().to_string()
            });
        }
    };
    let manifest = algorithm_payload
        .pointer("/result/manifest")
        .or_else(|| algorithm_payload.get("manifest"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let run_id = manifest
        .get("runId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let acceptance_status = manifest
        .pointer("/acceptance/status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let core_available = manifest
        .pointer("/core/available")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let core_output_bytes = manifest
        .pointer("/core/summary/outputBytes")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let traceability = algorithm_traceability_summary(&manifest);
    summary.insert(
        "algorithm".to_string(),
        json!({
            "status": status,
            "inspectionId": inspection_id,
            "manifestPath": manifest_path,
            "runId": run_id,
            "acceptanceStatus": acceptance_status,
            "coreAvailable": core_available,
            "coreOutputBytes": core_output_bytes,
            "traceability": traceability,
            "updatedAt": current_time_string()
        }),
    );
    if let Some(inspection) = summary.get_mut("inspection").and_then(Value::as_object_mut) {
        inspection.insert("status".to_string(), json!(status));
        inspection.insert(
            "captureSummaryPath".to_string(),
            json!(path.display().to_string()),
        );
        inspection.insert("algorithmSummaryPath".to_string(), json!(manifest_path));
    }
    summary.insert("writtenAt".to_string(), json!(current_time_string()));
    summary.insert("schema".to_string(), json!("steel.production.summary.v1"));
    let output = Value::Object(summary);
    match serde_json::to_string_pretty(&output)
        .map_err(|error| error.to_string())
        .and_then(|text| fs::write(&path, text).map_err(|error| error.to_string()))
    {
        Ok(()) => json!({
            "ok": true,
            "path": path.display().to_string(),
            "status": status,
            "manifestPath": manifest_path,
            "acceptanceStatus": acceptance_status,
            "coreAvailable": core_available,
            "coreOutputBytes": core_output_bytes,
            "traceability": algorithm_traceability_summary(&manifest)
        }),
        Err(error) => json!({
            "ok": false,
            "error": error,
            "path": path.display().to_string()
        }),
    }
}

fn algorithm_traceability_summary(manifest: &Value) -> Value {
    json!({
        "schema": "steel.algorithm-traceability.v1",
        "algorithmName": manifest.get("algorithmName"),
        "algorithmVersion": manifest.get("algorithmVersion"),
        "configRevision": manifest.get("configRevision"),
        "configSha256": manifest.get("configSha256"),
        "scriptSha256": manifest.get("scriptSha256"),
        "coreSha256": manifest.get("coreSha256"),
        "releaseCommit": manifest.get("releaseCommit"),
        "acceptanceReportSha256": manifest.get("acceptanceReportSha256"),
        "datasetRevision": manifest.get("datasetRevision"),
        "datasetSha256": manifest.get("datasetSha256"),
        "evaluatorRevision": manifest.get("evaluatorRevision"),
        "evaluatorSha256": manifest.get("evaluatorSha256"),
        "calibrationRevision": manifest.get("calibrationRevision"),
        "calibrationSha256": manifest.get("calibrationSha256"),
        "inputSummarySha256": manifest.get("inputSummarySha256"),
        "inputFrameIds": manifest.get("inputFrameIds"),
        "inputArtifactCount": manifest.get("inputArtifactCount"),
        "inputArtifacts": manifest.get("inputArtifacts"),
        "thresholds": manifest.get("thresholds"),
        "qualityGate": manifest.get("qualityGate"),
        "realDefectCount": manifest.get("realDefectCount"),
        "syntheticDefectCount": manifest.get("syntheticDefectCount")
    })
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
    let inspection_id = value_string(&payload, &["inspectionId", "inspection_id"])
        .if_empty(&format!("INSP-{session_id}"));
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

fn write_production_capture_once_response(
    state: &ServiceState,
    body: &str,
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
    if let Err(response) = validate_capture_open_session(state, &payload) {
        return response;
    }
    let (material_id, session_id) = active_session_for_payload(state, &payload);
    let mut capture_body = payload.as_object().cloned().unwrap_or_default();
    capture_body
        .entry("expectedCameras".to_string())
        .or_insert_with(|| json!(8));
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
    capture_body
        .entry("steelStateAware".to_string())
        .or_insert_with(|| json!(true));
    capture_body
        .entry("requireSteelPresent".to_string())
        .or_insert_with(|| json!(true));
    capture_body
        .entry("discardBlackFrames".to_string())
        .or_insert_with(|| json!(true));
    capture_body
        .entry("saveSdkDerived".to_string())
        .or_insert_with(|| json!(false));
    capture_body.insert("materialId".to_string(), json!(material_id.clone()));
    capture_body.insert("sessionId".to_string(), json!(session_id.clone()));
    capture_body.insert("productionLayout".to_string(), json!(true));
    let provider_payload = Value::Object(capture_body);
    let provider_timeout = continuous_capture_proxy_timeout(&provider_payload);
    let provider_body = provider_payload.to_string();
    let provider = state
        .capture
        .proxy_with_read_timeout(
            "POST",
            "/api/capture/continuous-test",
            &provider_body,
            provider_timeout,
        )
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
    let production_summary_output =
        production_summary_path(&Value::Object(summary.clone()), &material_id, &session_id);
    if let Some(path) = production_summary_output.as_ref() {
        summary.insert(
            "summaryOutput".to_string(),
            json!(path.to_string_lossy().to_string()),
        );
    }
    let provider_response = Value::Object(summary);
    let summary_json = provider_response.to_string();
    if let Some(path) = production_summary_output {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, &summary_json);
    }
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
            "code": provider_response.get("code").and_then(Value::as_i64).unwrap_or(0),
            "materialId": material_id,
            "sessionId": session_id,
            "provider": provider_response,
            "record": record
        })
        .to_string(),
    )
}

fn production_algorithm_session_for_payload(
    state: &ServiceState,
    payload: &Value,
) -> (String, String) {
    let latest = state
        .runtime
        .block_on(db::latest_material_session(&state.database.connection))
        .ok()
        .flatten();
    let material_id = material_id_from_payload(
        payload,
        latest
            .as_ref()
            .map(|session| session.material_id.as_str())
            .unwrap_or("unknown-material"),
    );
    let explicit_session_id = value_string(payload, &["sessionId", "session_id"]);
    if !explicit_session_id.is_empty() {
        return (material_id, explicit_session_id);
    }
    let latest_for_material = state
        .runtime
        .block_on(db::latest_material_session_for_material(
            &state.database.connection,
            &material_id,
        ))
        .ok()
        .flatten();
    let session_id = latest_for_material
        .map(|session| session.id)
        .unwrap_or_else(|| session_id_from_payload(payload, &material_id));
    (material_id, session_id)
}

fn algorithm_manifest_path_from_payload(payload: &Value) -> String {
    payload
        .pointer("/result/latest/manifestPath")
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .pointer("/result/manifest/runDir")
                .and_then(Value::as_str)
        })
        .unwrap_or_default()
        .to_string()
}

fn upsert_algorithm_inspection_state(
    state: &ServiceState,
    payload: &Value,
    material_id: &str,
    session_id: &str,
    inspection_id: &str,
    status: &str,
    summary_path: &str,
    raw_payload: &Value,
) -> Result<db::entities::production_inspection::Model, String> {
    let existing = state
        .runtime
        .block_on(db::find_production_inspection(
            &state.database.connection,
            inspection_id,
        ))
        .map_err(|error| error.to_string())?;
    let now = current_time_string();
    let storage_root = value_string(payload, &["storageRoot", "storage_root"]).if_empty(
        &value_string(payload, &["captureRoot", "capture_root"]).if_empty(
            existing
                .as_ref()
                .map(|item| item.storage_root.as_str())
                .unwrap_or_default(),
        ),
    );
    let existing_summary = existing
        .as_ref()
        .map(|item| item.summary_path.as_str())
        .unwrap_or_default();
    let next_summary_path = if summary_path.trim().is_empty() {
        value_string(payload, &["summaryPath", "summary_path"]).if_empty(existing_summary)
    } else {
        summary_path.to_string()
    };
    let started_at = existing
        .as_ref()
        .map(|item| item.started_at.clone())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| now.clone());
    let capture_count = value_i32(
        payload,
        &["captureCount", "capture_count"],
        existing
            .as_ref()
            .map(|item| item.capture_count)
            .unwrap_or(0),
    );
    let defect_count = value_i32(
        payload,
        &["defectCount", "defect_count"],
        existing.as_ref().map(|item| item.defect_count).unwrap_or(0),
    );
    state
        .runtime
        .block_on(db::upsert_production_inspection(
            &state.database.connection,
            db::ProductionInspectionInput {
                id: inspection_id.to_string(),
                material_id: material_id.to_string(),
                session_id: session_id.to_string(),
                status: status.to_string(),
                storage_root,
                summary_path: next_summary_path,
                started_at,
                finished_at: now,
                capture_count,
                defect_count,
                raw_payload: raw_payload.to_string(),
            },
        ))
        .map_err(|error| error.to_string())
}

fn write_production_algorithm_run_response(
    state: &ServiceState,
    body: &str,
    actor: &str,
    cancellation_requested: Option<&dyn Fn() -> bool>,
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
    let (material_id, session_id) = production_algorithm_session_for_payload(state, &payload);
    let inspection_id = value_string(&payload, &["inspectionId", "inspection_id"])
        .if_empty(&format!("INSP-{session_id}"));
    let mut algorithm_request = payload.as_object().cloned().unwrap_or_default();
    algorithm_request.insert("materialId".to_string(), json!(material_id.clone()));
    algorithm_request
        .entry("captureRoot".to_string())
        .or_insert_with(|| json!(bar_surface_capture_root().display().to_string()));
    algorithm_request
        .entry("outputRoot".to_string())
        .or_insert_with(|| json!(algorithm_data_root().display().to_string()));
    algorithm_request
        .entry("runCore".to_string())
        .or_insert_with(|| json!(true));
    if !production_algorithm_policy_enabled() {
        algorithm_request
            .entry("maxFrames".to_string())
            .or_insert_with(|| json!(24));
        algorithm_request
            .entry("meshRows".to_string())
            .or_insert_with(|| json!(144));
        algorithm_request
            .entry("meshColsPerCamera".to_string())
            .or_insert_with(|| json!(72));
        algorithm_request
            .entry("maxFaceEdgeMm".to_string())
            .or_insert_with(|| json!(8.0));
    }

    let running_payload = json!({
        "request": Value::Object(algorithm_request.clone()),
        "phase": "algorithm-running"
    });
    if let Err(error) = upsert_algorithm_inspection_state(
        state,
        &payload,
        &material_id,
        &session_id,
        &inspection_id,
        "algorithm-running",
        "",
        &running_payload,
    ) {
        return http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error }).to_string(),
        );
    }

    let algorithm_payload = match run_bar_surface_algorithm(
        &Value::Object(algorithm_request),
        cancellation_requested,
    ) {
        Ok(value) => value,
        Err(error) => {
            let cooperatively_cancelled = error
                .get("cooperativeCancellation")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let terminal_status = if cooperatively_cancelled {
                "algorithm-cancelled"
            } else {
                "algorithm-failed"
            };
            let failed_payload = json!({
                "request": payload,
                "algorithm": error,
                "phase": terminal_status
            });
            let failed_record = upsert_algorithm_inspection_state(
                state,
                &failed_payload["request"],
                &material_id,
                &session_id,
                &inspection_id,
                terminal_status,
                "",
                &failed_payload,
            );
            let capture_summary = failed_record
                .as_ref()
                .map(|record| {
                    update_production_summary_algorithm_section(
                        &record.storage_root,
                        &material_id,
                        &session_id,
                        &inspection_id,
                        terminal_status,
                        "",
                        &failed_payload["algorithm"],
                    )
                })
                .unwrap_or_else(|error| {
                    json!({
                        "ok": false,
                        "error": error,
                        "status": terminal_status
                    })
                });
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                if cooperatively_cancelled {
                    "production.algorithm.cancelled"
                } else {
                    "production.algorithm.failed"
                },
                &material_id,
                &format!("bar surface algorithm {terminal_status} inspection={inspection_id}"),
                if cooperatively_cancelled {
                    "warning"
                } else {
                    "error"
                },
            ));
            return http_response(
                if cooperatively_cancelled {
                    "409 Conflict"
                } else {
                    "500 Internal Server Error"
                },
                "application/json; charset=utf-8",
                &json!({
                    "code": if cooperatively_cancelled { 499 } else { 500 },
                    "cooperativeCancellation": cooperatively_cancelled,
                    "materialId": material_id,
                    "sessionId": session_id,
                    "inspectionId": inspection_id,
                    "captureSummary": capture_summary,
                    "algorithm": error
                })
                .to_string(),
            );
        }
    };

    let manifest_path = algorithm_manifest_path_from_payload(&algorithm_payload);
    let detection_ingest = ingest_algorithm_detected_defects(
        state,
        &algorithm_payload,
        &material_id,
        &session_id,
        &inspection_id,
    );
    let mut completion_payload = payload.clone();
    if let Some(object) = completion_payload.as_object_mut() {
        object.insert(
            "defectCount".to_string(),
            json!(detection_ingest
                .get("total")
                .and_then(Value::as_u64)
                .unwrap_or(0)),
        );
    }
    let record = match upsert_algorithm_inspection_state(
        state,
        &completion_payload,
        &material_id,
        &session_id,
        &inspection_id,
        "algorithm-complete",
        &manifest_path,
        &json!({
            "request": completion_payload,
            "algorithm": algorithm_payload,
            "detectionIngest": detection_ingest,
            "phase": "algorithm-complete"
        }),
    ) {
        Ok(record) => record,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error, "algorithm": algorithm_payload }).to_string(),
            );
        }
    };
    let capture_summary = update_production_summary_algorithm_section(
        &record.storage_root,
        &material_id,
        &session_id,
        &inspection_id,
        "algorithm-complete",
        &manifest_path,
        &algorithm_payload,
    );
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        "production.algorithm.complete",
        &material_id,
        &format!("bar surface algorithm complete inspection={inspection_id}"),
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
            "record": {
                "id": record.id,
                "status": record.status,
                "summaryPath": record.summary_path,
                "captureCount": record.capture_count,
                "defectCount": record.defect_count
            },
            "captureSummary": capture_summary,
            "algorithm": algorithm_payload,
            "detectionIngest": detection_ingest
        })
        .to_string(),
    )
}

fn stable_alarm_hash(value: &str) -> u64 {
    value
        .as_bytes()
        .iter()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
        })
}

fn production_defect_alarm_input(
    payload: &Value,
    material_id: &str,
    session_id: &str,
    defect: &db::ProductionDefectInput,
) -> Option<db::ProductionAlarmInput> {
    if !matches!(defect.severity.as_str(), "severe" | "review") {
        return None;
    }
    let client_key = value_string(
        payload,
        &[
            "alarmKey",
            "alarm_key",
            "defectId",
            "defect_id",
            "idempotencyKey",
            "idempotency_key",
            "id",
        ],
    );
    let fingerprint = json!({
        "source": "production-defect",
        "clientKey": client_key,
        "materialId": material_id,
        "sessionId": session_id,
        "inspectionId": defect.inspection_id,
        "cameraId": defect.camera_id,
        "type": defect.defect_type,
        "severity": defect.severity,
        "xMm": defect.x_mm,
        "yMm": defect.y_mm,
        "zMm": defect.z_mm,
        "widthMm": defect.width_mm,
        "heightMm": defect.height_mm,
        "depthMm": defect.depth_mm,
        "confidence": defect.confidence,
        "geometry": defect.geometry_json
    })
    .to_string();
    let id = format!("ALARM-DEFECT-{:016x}", stable_alarm_hash(&fingerprint));
    let camera_label = if defect.camera_id.trim().is_empty() {
        "unknown-camera"
    } else {
        defect.camera_id.as_str()
    };
    Some(db::ProductionAlarmInput {
        id,
        source: "production-defect".to_string(),
        alarm_type: defect.defect_type.clone(),
        severity: defect.severity.clone(),
        material_id: material_id.to_string(),
        session_id: session_id.to_string(),
        inspection_id: defect.inspection_id.clone(),
        camera_id: defect.camera_id.clone(),
        message: format!(
            "{} defect {} detected on {}",
            defect.severity, defect.defect_type, camera_label
        ),
        details: json!({
            "schema": "steel.production.alarm.defect.v1",
            "fingerprint": fingerprint,
            "payload": payload
        })
        .to_string(),
    })
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
    let inspection_id = value_string(&payload, &["inspectionId", "inspection_id"])
        .if_empty(&format!("INSP-{session_id}"));
    let defect = db::ProductionDefectInput {
        inspection_id: inspection_id.clone(),
        material_id: material_id.clone(),
        camera_id: value_string(&payload, &["cameraId", "camera_id", "cameraIp", "ip"]),
        defect_type: value_string(&payload, &["defectType", "defect_type", "type"])
            .if_empty("unknown"),
        severity: value_string(&payload, &["severity"])
            .if_empty("review")
            .to_ascii_lowercase(),
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
    };
    let alarm = production_defect_alarm_input(&payload, &material_id, &session_id, &defect);
    let result = state
        .runtime
        .block_on(db::append_production_defect_with_alarm(
            &state.database.connection,
            defect,
            alarm,
        ));
    match result {
        Ok((row, alarm_result)) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "production.defect",
                &material_id,
                &format!("defect {} inspection={inspection_id}", row.id),
                "info",
            ));
            if let Some((alarm, true)) = alarm_result.as_ref() {
                let _ = state.runtime.block_on(db::append_audit_log(
                    &state.database.connection,
                    actor,
                    "production.alarm.created",
                    &alarm.id,
                    &format!(
                        "{} {} alarm material={} inspection={} camera={}",
                        alarm.severity,
                        alarm.alarm_type,
                        alarm.material_id,
                        alarm.inspection_id,
                        alarm.camera_id
                    ),
                    if alarm.severity == "severe" {
                        "error"
                    } else {
                        "warning"
                    },
                ));
            }
            let alarm_json = alarm_result.as_ref().map(|(alarm, created)| {
                json!({
                    "id": alarm.id,
                    "status": alarm.status,
                    "created": created
                })
            });
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "materialId": material_id,
                    "sessionId": session_id,
                    "inspectionId": inspection_id,
                    "defectId": row.id,
                    "alarm": alarm_json
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

fn production_alarm_json(alarm: &db::entities::production_alarm::Model) -> Value {
    let details =
        serde_json::from_str::<Value>(&alarm.details).unwrap_or_else(|_| json!(alarm.details));
    json!({
        "id": alarm.id,
        "source": alarm.source,
        "type": alarm.alarm_type,
        "severity": alarm.severity,
        "materialId": alarm.material_id,
        "sessionId": alarm.session_id,
        "inspectionId": alarm.inspection_id,
        "cameraId": alarm.camera_id,
        "message": alarm.message,
        "details": details,
        "status": alarm.status,
        "createdAt": alarm.created_at,
        "acknowledgedAt": alarm.acknowledged_at,
        "resolvedAt": alarm.resolved_at,
        "acknowledgedBy": alarm.acknowledged_by,
        "acknowledgeNote": alarm.acknowledge_note,
        "resolvedBy": alarm.resolved_by,
        "resolveNote": alarm.resolve_note
    })
}

fn read_production_alarms_response(state: &ServiceState, query: &str) -> Vec<u8> {
    let status = query_value(query, "status").unwrap_or_else(|| "open".to_string());
    if !matches!(
        status.as_str(),
        "open" | "active" | "acknowledged" | "resolved" | "history" | "all"
    ) {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({
                "code": 400,
                "error": "invalid_alarm_status",
                "supportedStatuses": ["open", "active", "acknowledged", "resolved", "history", "all"]
            })
            .to_string(),
        );
    }
    let filter = db::ProductionAlarmFilter {
        status: Some(status),
        severity: query_value(query, "severity"),
        source: query_value(query, "source"),
        keyword: query_value(query, "keyword"),
        limit: query_value(query, "limit").and_then(|value| value.parse::<u64>().ok()),
        offset: Some(
            query_value(query, "offset")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0),
        ),
    };
    let page = match state.runtime.block_on(db::list_production_alarms(
        &state.database.connection,
        filter,
    )) {
        Ok(page) => page,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            );
        }
    };
    let counts = match state
        .runtime
        .block_on(db::production_alarm_counts(&state.database.connection))
    {
        Ok(counts) => counts,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            );
        }
    };
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({
            "code": 0,
            "total": page.total,
            "limit": page.limit,
            "offset": page.offset,
            "alarms": page.alarms.iter().map(production_alarm_json).collect::<Vec<_>>(),
            "counts": {
                "active": counts.active,
                "acknowledged": counts.acknowledged,
                "resolved": counts.resolved
            }
        })
        .to_string(),
    )
}

#[derive(Copy, Clone)]
enum ProductionAlarmAction {
    Acknowledge,
    Resolve,
}

fn write_production_alarm_action_response(
    state: &ServiceState,
    body: &str,
    actor: &str,
    action: ProductionAlarmAction,
) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(value) if value.is_object() => value,
        _ => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({ "code": 400, "error": "invalid_alarm_action_json" }).to_string(),
            );
        }
    };
    let alarm_id = value_string(&payload, &["alarmId", "alarm_id", "id"]);
    if alarm_id.trim().is_empty() {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "alarm_id_required" }).to_string(),
        );
    }
    let note = value_string(&payload, &["note"]);
    if note.is_empty() {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "alarm_note_required" }).to_string(),
        );
    }
    if note.chars().count() > 1000 {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "alarm_note_too_long" }).to_string(),
        );
    }
    let result = match action {
        ProductionAlarmAction::Acknowledge => state.runtime.block_on(
            db::acknowledge_production_alarm(&state.database.connection, &alarm_id, actor, &note),
        ),
        ProductionAlarmAction::Resolve => state.runtime.block_on(db::resolve_production_alarm(
            &state.database.connection,
            &alarm_id,
            actor,
            &note,
        )),
    };
    let transition = match result {
        Ok(transition) => transition,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            );
        }
    };
    match transition {
        db::ProductionAlarmTransition::Changed(alarm) => {
            let (audit_action, audit_level) = match action {
                ProductionAlarmAction::Acknowledge => ("alarm.acknowledge", "warning"),
                ProductionAlarmAction::Resolve => ("alarm.resolve", "info"),
            };
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                audit_action,
                &alarm.id,
                &format!("actor={actor} note={note}"),
                audit_level,
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({ "code": 0, "changed": true, "alarm": production_alarm_json(&alarm) })
                    .to_string(),
            )
        }
        db::ProductionAlarmTransition::Unchanged(alarm) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({ "code": 0, "changed": false, "alarm": production_alarm_json(&alarm) })
                .to_string(),
        ),
        db::ProductionAlarmTransition::Conflict(alarm) => {
            let error = match action {
                ProductionAlarmAction::Acknowledge => "alarm_not_active",
                ProductionAlarmAction::Resolve if alarm.status == "active" => {
                    "alarm_acknowledgement_required"
                }
                ProductionAlarmAction::Resolve => "alarm_not_acknowledged",
            };
            http_response(
                "409 Conflict",
                "application/json; charset=utf-8",
                &json!({
                    "code": 409,
                    "error": error,
                    "alarm": production_alarm_json(&alarm)
                })
                .to_string(),
            )
        }
        db::ProductionAlarmTransition::NotFound => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            &json!({ "code": 404, "error": "alarm_not_found" }).to_string(),
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

fn workspace_root() -> PathBuf {
    if let Ok(explicit_path) = env::var("STEEL_WORKSPACE_ROOT") {
        return PathBuf::from(explicit_path);
    }
    if let Ok(current_dir) = env::current_dir() {
        for ancestor in current_dir.ancestors().take(8) {
            if ancestor
                .join("scripts")
                .join("bar_surface_reconstruct.py")
                .is_file()
            {
                return ancestor.to_path_buf();
            }
        }
        return current_dir;
    }
    PathBuf::from(".")
}

fn algorithm_data_root() -> PathBuf {
    env::var("STEEL_ALGORITHM_DATA_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"G:\bar-surface-algorithm"))
}

fn bar_surface_capture_root() -> PathBuf {
    env::var("STEEL_BAR_CAPTURE_ROOT")
        .or_else(|_| env::var("CAPTURE_CAMERA_STORAGE_ROOT"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"H:\"))
}

fn algorithm_calibration_path() -> Option<PathBuf> {
    env::var("STEEL_ALGORITHM_CALIBRATION_PATH")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn runtime_path_readback(path: &Path, kind: &str) -> Value {
    let absolute = path.is_absolute();
    let exists = path.exists();
    let expected_type = match kind {
        "file" => path.is_file(),
        _ => path.is_dir(),
    };
    json!({
        "path": path.display().to_string(),
        "absolute": absolute,
        "exists": exists,
        "kind": kind,
        "typeValid": expected_type,
        "ready": absolute && exists && expected_type
    })
}

fn algorithm_runtime_paths_health() -> (bool, Value) {
    let capture = runtime_path_readback(&bar_surface_capture_root(), "directory");
    let output = runtime_path_readback(&algorithm_data_root(), "directory");
    let config = runtime_path_readback(&algorithm_config_path(), "file");
    let calibration = algorithm_calibration_path()
        .map(|path| runtime_path_readback(&path, "file"))
        .unwrap_or_else(|| {
            json!({
                "path": "",
                "absolute": false,
                "exists": false,
                "kind": "file",
                "typeValid": false,
                "ready": false,
                "reason": "algorithm_calibration_not_configured"
            })
        });
    let ready = [&capture, &output, &config, &calibration]
        .iter()
        .all(|item| item.get("ready").and_then(Value::as_bool) == Some(true));
    (
        ready,
        json!({
            "ok": ready,
            "status": if ready { "ready" } else { "invalid" },
            "captureRoot": capture,
            "algorithmRoot": output,
            "algorithmConfig": config,
            "algorithmCalibration": calibration
        }),
    )
}

fn configured_paths_equal(requested: &str, configured: &Path) -> bool {
    let requested = PathBuf::from(requested.trim());
    let requested = requested.canonicalize().unwrap_or(requested);
    let configured = configured
        .canonicalize()
        .unwrap_or_else(|_| configured.to_path_buf());
    let requested = requested.to_string_lossy();
    let configured = configured.to_string_lossy();
    if cfg!(windows) {
        requested.eq_ignore_ascii_case(&configured)
    } else {
        requested == configured
    }
}

fn algorithm_runtime_configuration() -> Value {
    let algorithm_root = algorithm_data_root();
    let capture_root = bar_surface_capture_root();
    let config_path = algorithm_config_path();
    let calibration_path = algorithm_calibration_path();
    let calibration_path_text = calibration_path
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    let (config_ok, config_health, config) = algorithm_config_health();
    let (paths_ok, paths) = algorithm_runtime_paths_health();
    json!({
        "schema": "steel.algorithm-runtime-config.v1",
        "desired": {
            "captureRoot": capture_root.display().to_string(),
            "algorithmRoot": algorithm_root.display().to_string(),
            "algorithmConfig": config_path.display().to_string(),
            "algorithmCalibration": calibration_path_text.clone()
        },
        "active": {
            "captureRoot": capture_root.display().to_string(),
            "algorithmRoot": algorithm_root.display().to_string(),
            "algorithmConfig": config_path.display().to_string(),
            "algorithmCalibration": calibration_path_text,
            "algorithmName": config.as_ref().and_then(|value| value.get("algorithmName")),
            "algorithmVersion": config.as_ref().and_then(|value| value.get("algorithmVersion")),
            "configRevision": config.as_ref().and_then(|value| value.get("configRevision")),
            "configSha256": config_health.get("configSha256"),
            "thresholds": config.as_ref().and_then(|value| value.get("thresholds"))
        },
        "readback": {
            "ready": config_ok && paths_ok,
            "configValid": config_ok,
            "algorithmRootExists": algorithm_root.is_dir(),
            "captureRootExists": capture_root.is_dir(),
            "config": config_health,
            "paths": paths
        }
    })
}

fn synthetic_algorithm_fixtures_allowed(runtime_profile: &str, algorithm_mode: &str) -> bool {
    matches!(
        runtime_profile.trim().to_ascii_lowercase().as_str(),
        "development" | "dev" | "test"
    ) && matches!(algorithm_mode.trim().to_ascii_lowercase().as_str(), "demo")
}

fn production_algorithm_policy_enabled() -> bool {
    let runtime_profile =
        env::var("STEEL_RUNTIME_PROFILE").unwrap_or_else(|_| "production".to_string());
    let algorithm_mode =
        env::var("STEEL_ALGORITHM_MODE").unwrap_or_else(|_| "production".to_string());
    !synthetic_algorithm_fixtures_allowed(&runtime_profile, &algorithm_mode)
}

fn algorithm_mock_defect_count(request: &Value, production_policy: bool) -> Result<i64, Value> {
    let count = match request.get("mockDefectCount") {
        None => 0,
        Some(value) => value.as_i64().ok_or_else(|| {
            json!({
                "code": 400,
                "error": "invalid_synthetic_defect_count",
                "field": "mockDefectCount",
                "requiredType": "integer"
            })
        })?,
    };
    if !(0..=64).contains(&count) {
        return Err(json!({
            "code": 400,
            "error": "invalid_synthetic_defect_count",
            "field": "mockDefectCount",
            "minimum": 0,
            "maximum": 64
        }));
    }
    if production_policy && count != 0 {
        return Err(json!({
            "code": 400,
            "error": "synthetic_defects_forbidden_in_production",
            "field": "mockDefectCount",
            "required": 0
        }));
    }
    Ok(count)
}

fn algorithm_synthetic_defect_count(payload: &Value) -> u64 {
    let declared = payload
        .pointer("/result/manifest/detection/syntheticDefectCount")
        .and_then(Value::as_u64)
        .or_else(|| {
            payload
                .pointer("/result/manifest/syntheticDefectCount")
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    let observed = payload
        .pointer("/result/manifest/detection/defects")
        .and_then(Value::as_array)
        .map(|defects| {
            defects
                .iter()
                .filter(|defect| {
                    defect
                        .pointer("/geometry/synthetic")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .count() as u64
        })
        .unwrap_or(0);
    declared.max(observed)
}

fn sha256_text_is_valid(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn canonical_value_sha256(value: &Value) -> Option<String> {
    let bytes = serde_json::to_vec(value).ok()?;
    let mut digest = Sha256::new();
    digest.update(bytes);
    Some(format!("{:x}", digest.finalize()))
}

fn algorithm_traceability_structure_error(manifest: &Value) -> Option<String> {
    for key in [
        "algorithmName",
        "algorithmVersion",
        "configRevision",
        "calibrationRevision",
        "datasetRevision",
        "evaluatorRevision",
    ] {
        if manifest
            .get(key)
            .and_then(Value::as_str)
            .map_or(true, |value| value.trim().is_empty())
        {
            return Some("algorithm_traceability_identity_missing".to_string());
        }
    }
    for key in [
        "configSha256",
        "calibrationSha256",
        "inputSummarySha256",
        "scriptSha256",
        "coreSha256",
        "acceptanceReportSha256",
        "datasetSha256",
        "evaluatorSha256",
    ] {
        if !sha256_text_is_valid(manifest.get(key)) {
            return Some("algorithm_traceability_sha256_missing".to_string());
        }
    }
    if manifest
        .get("releaseCommit")
        .and_then(Value::as_str)
        .is_none_or(|value| {
            !(40..=64).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Some("algorithm_traceability_release_commit_missing".to_string());
    }
    let artifacts = manifest.get("inputArtifacts").and_then(Value::as_array);
    if manifest
        .get("inputFrameIds")
        .and_then(Value::as_array)
        .map_or(true, Vec::is_empty)
        || artifacts.map_or(true, Vec::is_empty)
    {
        return Some("algorithm_traceability_inputs_missing".to_string());
    }
    let artifacts = artifacts.expect("checked above");
    if manifest.get("inputArtifactCount").and_then(Value::as_u64) != Some(artifacts.len() as u64)
        || artifacts.iter().any(|artifact| {
            ["camera", "frameId", "kind", "path"].iter().any(|key| {
                artifact
                    .get(*key)
                    .and_then(Value::as_str)
                    .is_none_or(|value| value.trim().is_empty())
            }) || artifact.get("bytes").and_then(Value::as_u64).is_none()
                || !sha256_text_is_valid(artifact.get("sha256"))
        })
    {
        return Some("algorithm_traceability_input_artifacts_invalid".to_string());
    }
    if canonical_value_sha256(&Value::Array(artifacts.clone())).as_deref()
        != manifest.get("inputSummarySha256").and_then(Value::as_str)
    {
        return Some("algorithm_traceability_input_summary_mismatch".to_string());
    }
    if manifest
        .get("thresholds")
        .and_then(Value::as_object)
        .is_none_or(|thresholds| thresholds.is_empty())
    {
        return Some("algorithm_traceability_thresholds_missing".to_string());
    }
    if manifest
        .pointer("/qualityGate/passed")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Some("algorithm_quality_gate_failed".to_string());
    }
    if manifest.pointer("/core/available").and_then(Value::as_bool) != Some(true)
        || manifest
            .pointer("/core/summary/outputBytes")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
    {
        return Some("algorithm_core_output_gate_failed".to_string());
    }
    if manifest
        .get("realDefectCount")
        .and_then(Value::as_u64)
        .is_none()
        || manifest
            .get("syntheticDefectCount")
            .and_then(Value::as_u64)
            .is_none()
    {
        return Some("algorithm_traceability_defect_counts_missing".to_string());
    }
    None
}

fn production_algorithm_traceability_error(payload: &Value) -> Option<String> {
    let Some(manifest) = payload.pointer("/result/manifest") else {
        return Some("algorithm_traceability_manifest_missing".to_string());
    };
    if let Some(error) = algorithm_traceability_structure_error(manifest) {
        return Some(error);
    }
    let (config_ok, config_detail, config) = algorithm_config_health();
    let Some(config) = config.filter(|_| config_ok) else {
        return Some("algorithm_traceability_current_config_invalid".to_string());
    };
    let Some((_, report, report_hash)) = configured_algorithm_acceptance_report() else {
        return Some("algorithm_traceability_acceptance_report_missing".to_string());
    };
    let config_hash = config_detail
        .get("configSha256")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !algorithm_acceptance_report_valid(&report, &config, config_hash) {
        return Some("algorithm_traceability_acceptance_report_invalid".to_string());
    }
    let Some(implementation) = current_algorithm_implementation_identity() else {
        return Some("algorithm_traceability_implementation_missing".to_string());
    };
    if !algorithm_implementation_binding_valid(&report, &implementation) {
        return Some("algorithm_traceability_implementation_not_approved".to_string());
    }
    let Some(current_calibration) = current_algorithm_calibration_identity() else {
        return Some("algorithm_traceability_calibration_missing".to_string());
    };
    if !algorithm_calibration_binding_valid(&report, &current_calibration) {
        return Some("algorithm_traceability_calibration_not_approved".to_string());
    }
    for key in ["algorithmName", "algorithmVersion", "configRevision"] {
        if manifest.get(key) != config.get(key) {
            return Some("algorithm_traceability_config_binding_mismatch".to_string());
        }
    }
    if !manifest
        .get("configSha256")
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case(config_hash))
    {
        return Some("algorithm_traceability_config_binding_mismatch".to_string());
    }
    if manifest.get("thresholds") != config.get("thresholds") {
        return Some("algorithm_traceability_threshold_binding_mismatch".to_string());
    }
    for key in [
        "scriptSha256",
        "coreSha256",
        "releaseCommit",
        "datasetRevision",
        "datasetSha256",
        "evaluatorRevision",
        "evaluatorSha256",
    ] {
        let expected = if matches!(key, "scriptSha256" | "coreSha256" | "releaseCommit") {
            implementation.get(key)
        } else {
            report.get(key)
        };
        let matches = manifest
            .get(key)
            .and_then(Value::as_str)
            .zip(expected.and_then(Value::as_str))
            .is_some_and(|(actual, expected)| actual.eq_ignore_ascii_case(expected));
        if !matches {
            return Some("algorithm_traceability_release_binding_mismatch".to_string());
        }
    }
    for key in ["calibrationRevision", "calibrationSha256"] {
        let matches = manifest
            .get(key)
            .and_then(Value::as_str)
            .zip(report.get(key).and_then(Value::as_str))
            .is_some_and(|(actual, expected)| actual.eq_ignore_ascii_case(expected));
        if !matches {
            return Some("algorithm_traceability_calibration_binding_mismatch".to_string());
        }
    }
    if !manifest
        .get("acceptanceReportSha256")
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case(&report_hash))
    {
        return Some("algorithm_traceability_acceptance_report_hash_mismatch".to_string());
    }
    None
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "json" => "application/json; charset=utf-8",
        "obj" => "text/plain; charset=utf-8",
        "mtl" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "bsmesh" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn path_stays_under(path: &Path, root: &Path) -> bool {
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };
    let Ok(canonical_root) = root.canonicalize() else {
        return false;
    };
    canonical_path.starts_with(canonical_root)
}

fn production_file_response(query: &str) -> Vec<u8> {
    let Some(path_value) = query_value(query, "path") else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"error\":\"path_required\"}",
        );
    };
    let path = PathBuf::from(path_value);
    let allowed = path_stays_under(&path, &bar_surface_capture_root())
        || path_stays_under(&path, &algorithm_data_root());
    if !allowed {
        return http_response(
            "403 Forbidden",
            "application/json; charset=utf-8",
            "{\"error\":\"path_not_allowed\"}",
        );
    }
    match fs::read(&path) {
        Ok(body) => {
            http_bytes_response_with_headers("200 OK", content_type_for_path(&path), &body, &[])
        }
        Err(error) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            &format!("{{\"error\":\"{}\"}}", json_escape(&error.to_string())),
        ),
    }
}

fn resolve_algorithm_file(root: &Path, value: &str) -> Result<PathBuf, String> {
    if value.trim().is_empty() {
        return Err("missing_path".to_string());
    }
    let candidate = PathBuf::from(value);
    let candidate = if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    };
    let root_canonical = root
        .canonicalize()
        .map_err(|error| format!("algorithm_root_unavailable: {error}"))?;
    let file_canonical = candidate
        .canonicalize()
        .map_err(|error| format!("algorithm_file_unavailable: {error}"))?;
    if !file_canonical.starts_with(&root_canonical) {
        return Err("algorithm_path_outside_root".to_string());
    }
    Ok(file_canonical)
}

fn display_algorithm_path(path: &Path) -> String {
    let text = path.display().to_string();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

fn algorithm_relative_path(root: &Path, path: &Path) -> String {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let canonical_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    canonical_path
        .strip_prefix(&canonical_root)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| display_algorithm_path(&canonical_path))
}

fn algorithm_core_summary_path(root: &Path, manifest_path: &Path, manifest: &Value) -> PathBuf {
    if let Some(mesh_json) = manifest.pointer("/mesh/json").and_then(Value::as_str) {
        if let Ok(mesh_path) = resolve_algorithm_file(root, mesh_json) {
            if let Some(parent) = mesh_path.parent() {
                return parent.join("bar_surface_core_summary.json");
            }
        }
    }
    manifest_path
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join("mesh")
        .join("bar_surface_core_summary.json")
}

fn read_algorithm_core_info(root: &Path, manifest_path: &Path, manifest: &Value) -> Value {
    let summary_path = algorithm_core_summary_path(root, manifest_path, manifest);
    if !summary_path.is_file() {
        return json!({"available": false});
    }
    let summary = fs::read_to_string(&summary_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({}));
    let binary_path = summary
        .get("binary")
        .and_then(Value::as_str)
        .and_then(|path| resolve_algorithm_file(root, path).ok());
    json!({
        "available": true,
        "summaryPath": display_algorithm_path(&summary_path),
        "summaryRelative": algorithm_relative_path(root, &summary_path),
        "binary": binary_path.as_ref().map(|path| display_algorithm_path(path)).unwrap_or_default(),
        "binaryRelative": binary_path.as_ref().map(|path| algorithm_relative_path(root, path)).unwrap_or_default(),
        "summary": summary
    })
}

fn augment_algorithm_manifest(root: &Path, manifest_path: &Path, manifest: Value) -> Value {
    let core = read_algorithm_core_info(root, manifest_path, &manifest);
    match manifest {
        Value::Object(mut object) => {
            object.insert("core".to_string(), core);
            Value::Object(object)
        }
        other => other,
    }
}

fn read_algorithm_latest_payload(root: &Path) -> Result<Value, String> {
    let latest_path = root.join("latest.json");
    let latest_text = fs::read_to_string(&latest_path)
        .map_err(|error| format!("algorithm_latest_unavailable: {error}"))?;
    let latest: Value = serde_json::from_str(&latest_text)
        .map_err(|error| format!("algorithm_latest_invalid: {error}"))?;
    let manifest_value = latest
        .get("manifestPath")
        .and_then(Value::as_str)
        .ok_or_else(|| "algorithm_manifest_path_missing".to_string())?;
    let manifest_path = resolve_algorithm_file(root, manifest_value)?;
    let manifest_text = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("algorithm_manifest_unavailable: {error}"))?;
    let manifest: Value = serde_json::from_str(&manifest_text)
        .map_err(|error| format!("algorithm_manifest_invalid: {error}"))?;
    let manifest = augment_algorithm_manifest(root, &manifest_path, manifest);
    Ok(json!({
        "code": 0,
        "root": root.display().to_string(),
        "latest": latest,
        "manifest": manifest
    }))
}

fn restore_algorithm_latest(root: &Path, previous: Option<&[u8]>) {
    let latest_path = root.join("latest.json");
    match previous {
        Some(bytes) => {
            let _ = fs::write(latest_path, bytes);
        }
        None => {
            let _ = fs::remove_file(latest_path);
        }
    }
}

fn algorithm_latest_response() -> Vec<u8> {
    let root = algorithm_data_root();
    match read_algorithm_latest_payload(&root) {
        Ok(payload) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &payload.to_string(),
        ),
        Err(error) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            &json!({"code": 404, "error": error, "root": root.display().to_string()}).to_string(),
        ),
    }
}

fn algorithm_manifest_response(query: &str) -> Vec<u8> {
    let root = algorithm_data_root();
    let manifest_path = match query_value(query, "path").or_else(|| query_value(query, "relative"))
    {
        Some(value) => match resolve_algorithm_file(&root, &value) {
            Ok(path) => path,
            Err(error) => {
                return http_response(
                    "404 Not Found",
                    "application/json; charset=utf-8",
                    &json!({"code": 404, "error": error}).to_string(),
                );
            }
        },
        None => match read_algorithm_latest_payload(&root)
            .ok()
            .and_then(|payload| payload.get("latest").cloned())
            .and_then(|latest| {
                latest
                    .get("manifestPath")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }) {
            Some(value) => match resolve_algorithm_file(&root, &value) {
                Ok(path) => path,
                Err(error) => {
                    return http_response(
                        "404 Not Found",
                        "application/json; charset=utf-8",
                        &json!({"code": 404, "error": error}).to_string(),
                    );
                }
            },
            None => {
                return http_response(
                    "404 Not Found",
                    "application/json; charset=utf-8",
                    "{\"code\":404,\"error\":\"algorithm_manifest_missing\"}",
                );
            }
        },
    };
    match fs::read_to_string(&manifest_path) {
        Ok(body) => match serde_json::from_str::<Value>(&body) {
            Ok(manifest) => http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &augment_algorithm_manifest(&root, &manifest_path, manifest).to_string(),
            ),
            Err(error) => http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({"code": 500, "error": error.to_string()}).to_string(),
            ),
        },
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({"code": 500, "error": error.to_string()}).to_string(),
        ),
    }
}

fn algorithm_file_response(query: &str) -> Vec<u8> {
    let root = algorithm_data_root();
    let Some(value) = query_value(query, "path").or_else(|| query_value(query, "relative")) else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"missing_path\"}",
        );
    };
    let path = match resolve_algorithm_file(&root, &value) {
        Ok(path) => path,
        Err(error) => {
            return http_response(
                "404 Not Found",
                "application/json; charset=utf-8",
                &json!({"code": 404, "error": error}).to_string(),
            );
        }
    };
    match fs::read(&path) {
        Ok(body) => {
            http_bytes_response_with_headers("200 OK", content_type_for_path(&path), &body, &[])
        }
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({"code": 500, "error": error.to_string()}).to_string(),
        ),
    }
}

fn algorithm_value_string(value: &Value, key: &str, fallback: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn algorithm_value_i64(value: &Value, key: &str, fallback: i64) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(fallback)
}

fn algorithm_value_f64(value: &Value, key: &str, fallback: f64) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(fallback)
}

fn algorithm_value_bool(value: &Value, key: &str, fallback: bool) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(fallback)
}

fn production_algorithm_request_config_error(request: &Value) -> Option<&'static str> {
    let (config_ok, _, config) = algorithm_config_health();
    let Some(config) = config.filter(|_| config_ok) else {
        return Some("production_algorithm_config_invalid");
    };
    let Some(thresholds) = config.get("thresholds") else {
        return Some("production_algorithm_config_invalid");
    };
    for (request_key, configured) in [
        ("captureRoot", bar_surface_capture_root()),
        ("outputRoot", algorithm_data_root()),
    ] {
        if request
            .get(request_key)
            .and_then(Value::as_str)
            .is_some_and(|requested| !configured_paths_equal(requested, &configured))
        {
            return Some("production_algorithm_path_override_forbidden");
        }
    }
    if let Some(requested) = request
        .get("calibrationPath")
        .or_else(|| request.get("calibration"))
        .and_then(Value::as_str)
    {
        let configured = env::var("STEEL_ALGORITHM_CALIBRATION_PATH")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        if configured
            .as_ref()
            .is_none_or(|configured| !configured_paths_equal(requested, configured))
        {
            return Some("production_algorithm_calibration_override_forbidden");
        }
    }
    for (request_key, config_key) in [
        ("maxFrames", "maxFrames"),
        ("meshRows", "meshRows"),
        ("meshColsPerCamera", "meshColsPerCamera"),
        ("radiusMm", "radiusMm"),
        ("radialScaleMm", "radialScaleMm"),
        ("maxFaceEdgeMm", "maxFaceEdgeMm"),
        ("contourCrop", "contourEnabled"),
        ("contourRadiusToleranceMm", "contourRadiusToleranceMm"),
        ("contourMinKeepRatio", "contourMinKeepRatio"),
        ("contourMinRowCoverage", "contourMinRowCoverage"),
        ("contourAutoPercentile", "contourAutoPercentile"),
        ("defectMinDepthMm", "defectMinDepthMm"),
        ("defectMinAreaPoints", "defectMinAreaPoints"),
    ] {
        let Some(requested) = request.get(request_key) else {
            continue;
        };
        let Some(configured) = thresholds.get(config_key) else {
            return Some("production_algorithm_config_invalid");
        };
        let equal = if requested.is_number() && configured.is_number() {
            requested.as_f64() == configured.as_f64()
        } else {
            requested == configured
        };
        if !equal {
            return Some("production_algorithm_parameter_override_forbidden");
        }
    }
    None
}

fn algorithm_core_exe_path() -> Option<PathBuf> {
    if let Ok(path) = env::var("STEEL_BAR_SURFACE_CORE_EXE") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let workspace = workspace_root();
    for configuration in ["Release", "Debug"] {
        let candidate = workspace
            .join("target")
            .join("algorithm-core")
            .join(configuration)
            .join("steel_bar_surface_core.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn algorithm_process_timeout() -> Duration {
    let seconds = env::var("STEEL_ALGORITHM_PROCESS_TIMEOUT_SEC")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(1_800)
        .clamp(10, 7_200);
    Duration::from_secs(seconds)
}

fn controlled_process_error(
    error: controlled_process::ControlledProcessError,
    operation: &str,
) -> Value {
    match error {
        controlled_process::ControlledProcessError::Cancelled => json!({
            "code": 499,
            "error": format!("{operation}_cancelled"),
            "cooperativeCancellation": true
        }),
        controlled_process::ControlledProcessError::TimedOut => json!({
            "code": 504,
            "error": format!("{operation}_timeout"),
            "timeoutSec": algorithm_process_timeout().as_secs()
        }),
        controlled_process::ControlledProcessError::Spawn(detail) => json!({
            "code": 500,
            "error": format!("{operation}_spawn_failed"),
            "detail": detail
        }),
        controlled_process::ControlledProcessError::Containment(detail) => json!({
            "code": 500,
            "error": format!("{operation}_process_tree_containment_failed"),
            "detail": detail
        }),
        controlled_process::ControlledProcessError::Wait(detail) => json!({
            "code": 500,
            "error": format!("{operation}_wait_failed"),
            "detail": detail
        }),
    }
}

fn controlled_process_output_summary(
    output: &controlled_process::ControlledProcessOutput,
) -> Value {
    json!({
        "retainedByteLimitPerStream": controlled_process::OUTPUT_RETAINED_BYTES,
        "stdoutTotalBytes": output.stdout_total_bytes,
        "stderrTotalBytes": output.stderr_total_bytes,
        "stdoutRetainedBytes": output.stdout.len(),
        "stderrRetainedBytes": output.stderr.len(),
        "stdoutTruncated": output.stdout_truncated,
        "stderrTruncated": output.stderr_truncated
    })
}

fn run_algorithm_core_for_manifest(
    manifest_path: &Path,
    cancellation_requested: Option<&dyn Fn() -> bool>,
) -> Result<Value, Value> {
    let Some(exe) = algorithm_core_exe_path() else {
        return Ok(
            json!({"attempted": false, "available": false, "error": "algorithm_core_exe_missing"}),
        );
    };
    let mut command = Command::new(&exe);
    command.arg("--manifest").arg(manifest_path);
    match controlled_process::run(
        &mut command,
        algorithm_process_timeout(),
        cancellation_requested,
    ) {
        Ok(output) => Ok(json!({
            "attempted": true,
            "available": output.status.success(),
            "exe": exe.display().to_string(),
            "status": output.status.code(),
            "stdout": String::from_utf8_lossy(&output.stdout).trim(),
            "stderr": String::from_utf8_lossy(&output.stderr).trim(),
            "processOutput": controlled_process_output_summary(&output)
        })),
        Err(error) => Err(controlled_process_error(error, "algorithm_core")),
    }
}

fn run_bar_surface_algorithm(
    request: &Value,
    cancellation_requested: Option<&dyn Fn() -> bool>,
) -> Result<Value, Value> {
    let production_policy = production_algorithm_policy_enabled();
    if production_policy {
        if let Some(error) = production_algorithm_request_config_error(request) {
            return Err(json!({
                "code": 400,
                "error": error,
                "source": "versioned_algorithm_config"
            }));
        }
        let (paths_ok, paths) = algorithm_runtime_paths_health();
        if !paths_ok {
            return Err(json!({
                "code": 503,
                "error": "production_algorithm_runtime_paths_invalid",
                "readback": paths
            }));
        }
        if request.get("runCore").and_then(Value::as_bool) == Some(false) {
            return Err(json!({
                "code": 400,
                "error": "production_algorithm_core_required",
                "field": "runCore",
                "required": true
            }));
        }
    }
    let capture_root = algorithm_value_string(
        request,
        "captureRoot",
        &bar_surface_capture_root().display().to_string(),
    );
    let output_root = algorithm_value_string(
        request,
        "outputRoot",
        &algorithm_data_root().display().to_string(),
    );
    let material_id = algorithm_value_string(request, "materialId", "latest");
    let calibration_path = algorithm_value_string(
        request,
        "calibrationPath",
        &algorithm_value_string(
            request,
            "calibration",
            &env::var("STEEL_ALGORITHM_CALIBRATION_PATH").unwrap_or_default(),
        ),
    );
    let max_frames = algorithm_value_i64(request, "maxFrames", 24)
        .clamp(1, 240)
        .to_string();
    let mesh_rows = algorithm_value_i64(request, "meshRows", 144)
        .clamp(24, 512)
        .to_string();
    let mesh_cols = algorithm_value_i64(request, "meshColsPerCamera", 72)
        .clamp(24, 256)
        .to_string();
    let max_face_edge = algorithm_value_f64(request, "maxFaceEdgeMm", 8.0)
        .clamp(0.0, 1000.0)
        .to_string();
    let contour_crop = algorithm_value_bool(request, "contourCrop", true);
    let contour_radius_tolerance = algorithm_value_f64(request, "contourRadiusToleranceMm", 0.0)
        .clamp(0.0, 1000.0)
        .to_string();
    let contour_min_keep_ratio = algorithm_value_f64(request, "contourMinKeepRatio", 0.55)
        .clamp(0.0, 1.0)
        .to_string();
    let contour_min_row_coverage = algorithm_value_f64(request, "contourMinRowCoverage", 0.25)
        .clamp(0.0, 1.0)
        .to_string();
    let contour_auto_percentile = algorithm_value_f64(request, "contourAutoPercentile", 96.0)
        .clamp(50.0, 99.9)
        .to_string();
    let mock_defect_count = algorithm_mock_defect_count(request, production_policy)?.to_string();
    let run_core = algorithm_value_bool(request, "runCore", true);
    let script = workspace_root()
        .join("scripts")
        .join("bar_surface_reconstruct.py");
    if !script.is_file() {
        return Err(
            json!({"code": 500, "error": "algorithm_script_missing", "script": script.display().to_string()}),
        );
    }
    let python = env::var("STEEL_PYTHON").unwrap_or_else(|_| "python".to_string());
    let algorithm_root = PathBuf::from(&output_root);
    let previous_latest = fs::read(algorithm_root.join("latest.json")).ok();
    let mut command = Command::new(&python);
    command
        .arg(&script)
        .arg("--capture-root")
        .arg(&capture_root)
        .arg("--output-root")
        .arg(&output_root)
        .arg("--material-id")
        .arg(&material_id)
        .arg("--mock-defect-count")
        .arg(&mock_defect_count);
    if !production_policy {
        command
            .arg("--max-frames")
            .arg(&max_frames)
            .arg("--mesh-rows")
            .arg(&mesh_rows)
            .arg("--mesh-cols-per-camera")
            .arg(&mesh_cols)
            .arg("--max-face-edge-mm")
            .arg(&max_face_edge)
            .arg("--contour-radius-tolerance-mm")
            .arg(&contour_radius_tolerance)
            .arg("--contour-min-keep-ratio")
            .arg(&contour_min_keep_ratio)
            .arg("--contour-min-row-coverage")
            .arg(&contour_min_row_coverage)
            .arg("--contour-auto-percentile")
            .arg(&contour_auto_percentile);
        if !contour_crop {
            command.arg("--no-contour-crop");
        }
    }
    if !calibration_path.trim().is_empty() {
        command.arg("--calibration").arg(&calibration_path);
    }
    let output = controlled_process::run(
        &mut command,
        algorithm_process_timeout(),
        cancellation_requested,
    );
    match output {
        Ok(output) if output.status.success() => {
            let root = PathBuf::from(output_root);
            let latest_before_core = read_algorithm_latest_payload(&root)
                .unwrap_or_else(|error| json!({"code": 0, "warning": error}));
            let manifest_path = latest_before_core
                .get("latest")
                .and_then(|latest| latest.get("manifestPath"))
                .and_then(Value::as_str)
                .and_then(|value| resolve_algorithm_file(&root, value).ok());
            let core = if run_core {
                match manifest_path.as_ref() {
                    Some(path) => {
                        match run_algorithm_core_for_manifest(path, cancellation_requested) {
                            Ok(value) => value,
                            Err(error) => {
                                restore_algorithm_latest(
                                    &algorithm_root,
                                    previous_latest.as_deref(),
                                );
                                return Err(error);
                            }
                        }
                    }
                    None => {
                        json!({"attempted": false, "available": false, "error": "algorithm_manifest_missing"})
                    }
                }
            } else {
                json!({"attempted": false, "available": false, "skipped": true})
            };
            let latest = read_algorithm_latest_payload(&root).unwrap_or(latest_before_core);
            let result = json!({
                "code": 0,
                "stdout": String::from_utf8_lossy(&output.stdout).trim(),
                "stderr": String::from_utf8_lossy(&output.stderr).trim(),
                "processOutput": controlled_process_output_summary(&output),
                "core": core,
                "result": latest
            });
            let synthetic_defect_count = algorithm_synthetic_defect_count(&result);
            if production_policy && synthetic_defect_count != 0 {
                restore_algorithm_latest(&algorithm_root, previous_latest.as_deref());
                return Err(json!({
                    "code": 422,
                    "error": "synthetic_algorithm_output_rejected",
                    "syntheticDefectCount": synthetic_defect_count
                }));
            }
            if production_policy {
                if let Some(error) = production_algorithm_traceability_error(&result) {
                    restore_algorithm_latest(&algorithm_root, previous_latest.as_deref());
                    return Err(json!({
                        "code": 422,
                        "error": error
                    }));
                }
            }
            Ok(result)
        }
        Ok(output) => {
            if production_policy {
                restore_algorithm_latest(&algorithm_root, previous_latest.as_deref());
            }
            Err(json!({
                "code": 500,
                "error": "algorithm_run_failed",
                "status": output.status.code(),
                "stdout": String::from_utf8_lossy(&output.stdout).trim(),
                "stderr": String::from_utf8_lossy(&output.stderr).trim(),
                "processOutput": controlled_process_output_summary(&output)
            }))
        }
        Err(error) => {
            restore_algorithm_latest(&algorithm_root, previous_latest.as_deref());
            Err(controlled_process_error(error, "algorithm_run"))
        }
    }
}

fn run_bar_surface_calibration_fit(
    request: &Value,
    cancellation_requested: Option<&dyn Fn() -> bool>,
) -> Result<Value, Value> {
    let capture_root = algorithm_value_string(
        request,
        "captureRoot",
        &bar_surface_capture_root().display().to_string(),
    );
    let material_id = algorithm_value_string(request, "materialId", "latest");
    let calibration_path = algorithm_value_string(
        request,
        "calibrationPath",
        &algorithm_value_string(request, "calibration", ""),
    );
    let default_output_root = bar_surface_capture_root().join("analysis");
    let output_root = algorithm_value_string(
        request,
        "outputRoot",
        &default_output_root.display().to_string(),
    );
    let rows = algorithm_value_string(request, "rows", "250,500,750");
    let max_points = algorithm_value_i64(request, "maxPointsPerCamera", 2400)
        .clamp(100, 20000)
        .to_string();
    let max_shift = algorithm_value_f64(request, "maxShiftMm", 5.0)
        .clamp(0.1, 50.0)
        .to_string();
    let expected_cameras = algorithm_value_i64(request, "expectedCameras", 8)
        .clamp(1, 24)
        .to_string();
    let min_points_per_camera = algorithm_value_i64(request, "minPointsPerCamera", 100)
        .clamp(20, 20000)
        .to_string();
    let min_diameter = algorithm_value_f64(request, "minDiameterMm", 20.0)
        .clamp(1.0, 10000.0)
        .to_string();
    let max_diameter = algorithm_value_f64(request, "maxDiameterMm", 1000.0)
        .clamp(1.0, 20000.0)
        .to_string();
    let min_angular_coverage = algorithm_value_f64(request, "minAngularCoverageDeg", 220.0)
        .clamp(30.0, 359.0)
        .to_string();
    let max_fit_residual = algorithm_value_f64(request, "maxFitResidualMm", 8.0)
        .clamp(0.05, 1000.0)
        .to_string();
    let max_relative_residual = algorithm_value_f64(request, "maxRelativeResidual", 0.08)
        .clamp(0.001, 1.0)
        .to_string();
    let min_improvement_ratio = algorithm_value_f64(request, "minImprovementRatio", 0.03)
        .clamp(0.0, 1.0)
        .to_string();
    let data_dir = algorithm_value_string(request, "dataDir", "");
    let script = workspace_root()
        .join("scripts")
        .join("fit_array_calibration_cross_section.py");
    if !script.is_file() {
        return Err(
            json!({"code": 500, "error": "calibration_fit_script_missing", "script": script.display().to_string()}),
        );
    }
    let python = env::var("STEEL_PYTHON").unwrap_or_else(|_| "python".to_string());
    let mut command = Command::new(&python);
    command.arg(&script);
    if data_dir.trim().is_empty() {
        command
            .arg("--capture-root")
            .arg(&capture_root)
            .arg("--material-id")
            .arg(&material_id);
    } else {
        command.arg("--data-dir").arg(&data_dir);
    }
    command
        .arg("--rows")
        .arg(&rows)
        .arg("--output-root")
        .arg(&output_root)
        .arg("--max-points-per-camera")
        .arg(&max_points)
        .arg("--max-shift-mm")
        .arg(&max_shift)
        .arg("--expected-cameras")
        .arg(&expected_cameras)
        .arg("--min-points-per-camera")
        .arg(&min_points_per_camera)
        .arg("--min-diameter-mm")
        .arg(&min_diameter)
        .arg("--max-diameter-mm")
        .arg(&max_diameter)
        .arg("--min-angular-coverage-deg")
        .arg(&min_angular_coverage)
        .arg("--max-fit-residual-mm")
        .arg(&max_fit_residual)
        .arg("--max-relative-residual")
        .arg(&max_relative_residual)
        .arg("--min-improvement-ratio")
        .arg(&min_improvement_ratio);
    if !calibration_path.trim().is_empty() {
        command.arg("--calibration").arg(&calibration_path);
    }
    match controlled_process::run(
        &mut command,
        algorithm_process_timeout(),
        cancellation_requested,
    ) {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if output.stdout_truncated {
                return Err(json!({
                    "code": 500,
                    "error": "calibration_fit_output_exceeded_limit",
                    "stdout": stdout,
                    "stderr": stderr,
                    "processOutput": controlled_process_output_summary(&output)
                }));
            }
            let result = serde_json::from_str::<Value>(&stdout).map_err(|error| {
                json!({
                    "code": 500,
                    "error": "calibration_fit_output_invalid",
                    "detail": error.to_string(),
                    "stdout": stdout,
                    "stderr": stderr,
                    "processOutput": controlled_process_output_summary(&output)
                })
            })?;
            Ok(json!({
                "code": 0,
                "stdout": stdout,
                "stderr": stderr,
                "processOutput": controlled_process_output_summary(&output),
                "result": result
            }))
        }
        Ok(output) => Err(json!({
            "code": 500,
            "error": "calibration_fit_failed",
            "status": output.status.code(),
            "stdout": String::from_utf8_lossy(&output.stdout).trim(),
            "stderr": String::from_utf8_lossy(&output.stderr).trim(),
            "processOutput": controlled_process_output_summary(&output)
        })),
        Err(error) => Err(controlled_process_error(error, "calibration_fit")),
    }
}

fn calibration_capture_data_dir(summary: &Value, expected_cameras: i64) -> Result<PathBuf, Value> {
    let code = summary.get("code").and_then(Value::as_i64).unwrap_or(503);
    let successes = summary
        .get("successes")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let failures = summary
        .get("failures")
        .and_then(Value::as_i64)
        .unwrap_or(expected_cameras);
    let complete_frames = summary
        .get("completeFrames")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let metadata_frames = summary
        .get("metadataFrames")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let results = summary
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut camera_ips = std::collections::BTreeSet::new();
    let per_camera_complete = results.iter().all(|result| {
        let result_code = result.get("code").and_then(Value::as_i64).unwrap_or(500);
        let complete = result
            .get("completeFrame")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let metadata = result
            .get("metadataOutput")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Some(ip) = result.get("ip").and_then(Value::as_str) {
            if !ip.trim().is_empty() {
                camera_ips.insert(ip.trim().to_string());
            }
        }
        result_code == 0 && complete && !metadata.trim().is_empty()
    });
    if code != 0
        || failures != 0
        || successes != expected_cameras
        || complete_frames != expected_cameras
        || metadata_frames != expected_cameras
        || results.len() != expected_cameras as usize
        || camera_ips.len() != expected_cameras as usize
        || !per_camera_complete
    {
        return Err(json!({
            "code": 422,
            "error": "calibration_capture_incomplete",
            "expectedCameras": expected_cameras,
            "successes": successes,
            "failures": failures,
            "completeFrames": complete_frames,
            "metadataFrames": metadata_frames,
            "resultCount": results.len(),
            "uniqueCameraCount": camera_ips.len()
        }));
    }
    let summary_path = summary
        .get("summaryOutput")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if summary_path.is_empty() || summary_path.starts_with("simulated://") {
        return Err(json!({
            "code": 422,
            "error": "calibration_capture_artifacts_unavailable",
            "summaryOutput": summary_path
        }));
    }
    let summary_path = PathBuf::from(summary_path);
    if !summary_path.is_file() {
        return Err(json!({
            "code": 422,
            "error": "calibration_capture_summary_missing",
            "summaryOutput": summary_path.display().to_string()
        }));
    }
    summary_path.parent().map(Path::to_path_buf).ok_or_else(|| {
        json!({
            "code": 422,
            "error": "calibration_capture_directory_missing",
            "summaryOutput": summary_path.display().to_string()
        })
    })
}

fn ingest_algorithm_detected_defects(
    state: &ServiceState,
    algorithm_payload: &Value,
    material_id: &str,
    session_id: &str,
    inspection_id: &str,
) -> Value {
    let defects = algorithm_payload
        .pointer("/result/manifest/detection/defects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let existing = state
        .runtime
        .block_on(db::production_defects_for_inspection(
            &state.database.connection,
            inspection_id,
        ))
        .unwrap_or_default();
    let existing_algorithm_ids = existing
        .iter()
        .filter_map(|item| serde_json::from_str::<Value>(&item.geometry_json).ok())
        .filter_map(|geometry| {
            geometry
                .get("algorithmDetectionId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<HashSet<_>>();
    let run_id = algorithm_payload
        .pointer("/result/manifest/runId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut inserted = 0usize;
    let mut skipped = 0usize;
    let mut errors = Vec::new();
    for (index, item) in defects.iter().enumerate() {
        let detection_id = item
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("ALG-{:04}", index + 1));
        let stable_id = format!("{run_id}:{detection_id}");
        if existing_algorithm_ids.contains(&stable_id) {
            skipped += 1;
            continue;
        }
        let mut geometry = item
            .get("geometry")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let synthetic = geometry
            .get("synthetic")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let detection_source = if synthetic {
            "python-temporary-mock"
        } else {
            "python-radial-residual"
        };
        geometry.insert("algorithmDetectionId".to_string(), json!(stable_id));
        geometry.insert("runId".to_string(), json!(run_id));
        geometry.insert("source".to_string(), json!(detection_source));
        let input = db::ProductionDefectInput {
            inspection_id: inspection_id.to_string(),
            material_id: material_id.to_string(),
            camera_id: value_string(item, &["cameraId", "camera_id"]),
            defect_type: value_string(item, &["defectType", "defect_type", "type"])
                .if_empty("review"),
            severity: value_string(item, &["severity"])
                .if_empty("review")
                .to_ascii_lowercase(),
            x_mm: value_f64(item, &["xMm", "x_mm", "x"]),
            y_mm: value_f64(item, &["yMm", "y_mm", "y"]),
            z_mm: value_f64(item, &["zMm", "z_mm", "z"]),
            width_mm: value_f64(item, &["widthMm", "width_mm", "width"]),
            height_mm: value_f64(item, &["heightMm", "height_mm", "height"]),
            depth_mm: value_f64(item, &["depthMm", "depth_mm", "depth"]),
            confidence: value_f64(item, &["confidence", "score"]),
            geometry_json: Value::Object(geometry).to_string(),
        };
        let alarm_payload = json!({
            "source": detection_source, "algorithmDetectionId": stable_id,
            "materialId": material_id, "sessionId": session_id,
            "inspectionId": inspection_id, "defect": item
        });
        let alarm = production_defect_alarm_input(&alarm_payload, material_id, session_id, &input);
        match state
            .runtime
            .block_on(db::append_production_defect_with_alarm(
                &state.database.connection,
                input,
                alarm,
            )) {
            Ok(_) => inserted += 1,
            Err(error) => errors.push(error.to_string()),
        }
    }
    json!({
        "status": if errors.is_empty() { "complete" } else { "partial" },
        "detected": defects.len(), "inserted": inserted, "skipped": skipped,
        "existing": existing.len(), "total": existing.len() + inserted, "errors": errors
    })
}

fn automatic_calibration_activation_decision(
    result: &Value,
    auto_activate: bool,
) -> (bool, bool, &'static str) {
    let target_detected = result
        .get("targetDetection")
        .and_then(|value| value.get("detected"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let correction_accepted = result
        .get("correctionAccepted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let reason = if !target_detected {
        "calibration_target_not_detected"
    } else if !correction_accepted {
        "correction_quality_gate_failed"
    } else if !auto_activate {
        "automatic_activation_disabled"
    } else {
        "pending"
    };
    (target_detected, correction_accepted, reason)
}

fn run_bar_surface_calibration_capture_fit(
    state: &ServiceState,
    request: &Value,
    actor: &str,
    cancellation_requested: Option<&dyn Fn() -> bool>,
) -> Result<Value, Value> {
    let expected_cameras = algorithm_value_i64(request, "expectedCameras", 8);
    if expected_cameras != 8 {
        return Err(json!({
            "code": 400,
            "error": "calibration_capture_requires_eight_cameras",
            "expectedCameras": expected_cameras
        }));
    }
    let material_id = algorithm_value_string(
        request,
        "materialId",
        &format!("CALIBRATION-{}", current_time_millis()),
    );
    let output_dir = algorithm_value_string(
        request,
        "captureOutputDir",
        &format!("continuous-test/auto-calibration-{}", current_time_millis()),
    );
    let mut capture_body = serde_json::Map::new();
    capture_body.insert("expectedCameras".to_string(), json!(8));
    capture_body.insert("rounds".to_string(), json!(1));
    capture_body.insert(
        "lines".to_string(),
        json!(algorithm_value_i64(request, "lines", 1000).clamp(1, 20000)),
    );
    capture_body.insert(
        "width".to_string(),
        json!(algorithm_value_i64(request, "width", 0).clamp(0, 20000)),
    );
    capture_body.insert(
        "timeoutMs".to_string(),
        json!(algorithm_value_i64(request, "timeoutMs", 8000).clamp(1000, 120000)),
    );
    capture_body.insert("intervalMs".to_string(), json!(500));
    capture_body.insert("retries".to_string(), json!(0));
    capture_body.insert("controlMode".to_string(), json!(0));
    capture_body.insert(
        "dataMode".to_string(),
        json!(algorithm_value_i64(request, "dataMode", 3).clamp(0, 3)),
    );
    capture_body.insert("outputDir".to_string(), json!(output_dir));
    capture_body.insert("materialId".to_string(), json!(material_id));
    capture_body.insert("connectFirst".to_string(), json!(true));
    capture_body.insert("stopStreams".to_string(), json!(true));
    capture_body.insert("steelStateAware".to_string(), json!(false));
    capture_body.insert("requireSteelPresent".to_string(), json!(false));
    if let Some(ips) = request.get("ips").and_then(Value::as_array) {
        capture_body.insert("ips".to_string(), Value::Array(ips.clone()));
    }
    let capture_request = Value::Object(capture_body);
    let capture_response = state.capture.proxy_response_with_read_timeout(
        "POST",
        "/api/capture/continuous-test",
        &capture_request.to_string(),
        continuous_capture_proxy_timeout(&capture_request),
    );
    let Some(capture_response) = capture_response else {
        return Err(json!({ "code": 503, "error": "capture_provider_offline" }));
    };
    let capture = serde_json::from_slice::<Value>(&capture_response.body).map_err(|error| {
        json!({
            "code": 502,
            "error": "calibration_capture_response_invalid",
            "detail": error.to_string()
        })
    })?;
    if !(200..300).contains(&capture_response.status_code) {
        return Err(json!({
            "code": capture_response.status_code,
            "error": "calibration_capture_provider_rejected",
            "capture": capture
        }));
    }
    let capture_summary_dir = calibration_capture_data_dir(&capture, expected_cameras)?;
    let mut fit_request = request.as_object().cloned().unwrap_or_default();
    let requested_calibration = algorithm_value_string(
        request,
        "calibrationPath",
        &algorithm_value_string(request, "calibration", ""),
    );
    if requested_calibration.trim().is_empty() {
        let active_response = state.capture.proxy_response_with_read_timeout(
            "GET",
            "/api/calibration/active",
            "",
            Duration::from_secs(10),
        );
        let Some(active_response) = active_response else {
            return Err(json!({
                "code": 503,
                "error": "active_calibration_provider_offline"
            }));
        };
        let active = serde_json::from_slice::<Value>(&active_response.body).map_err(|error| {
            json!({
                "code": 502,
                "error": "active_calibration_response_invalid",
                "detail": error.to_string()
            })
        })?;
        let active_path = active
            .get("calibrationPath")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if !(200..300).contains(&active_response.status_code)
            || active.get("code").and_then(Value::as_i64) != Some(0)
            || active_path.is_empty()
            || !active
                .get("exists")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return Err(json!({
                "code": 422,
                "error": "active_array_calibration_unavailable",
                "activeCalibration": active
            }));
        }
        fit_request.insert("calibrationPath".to_string(), json!(active_path));
    }
    fit_request.remove("dataDir");
    fit_request.insert(
        "captureRoot".to_string(),
        json!(algorithm_value_string(
            request,
            "captureRoot",
            &bar_surface_capture_root().display().to_string(),
        )),
    );
    fit_request.insert("materialId".to_string(), json!(material_id));
    let fit = run_bar_surface_calibration_fit(&Value::Object(fit_request), cancellation_requested)?;
    let result = fit.get("result").cloned().unwrap_or_else(|| json!({}));
    let auto_activate = algorithm_value_bool(request, "autoActivate", true);
    let (target_detected, correction_accepted, activation_reason) =
        automatic_calibration_activation_decision(&result, auto_activate);
    let mut auto_activation = json!({
        "attempted": false,
        "activated": false,
        "saveToDevice": false,
        "reason": activation_reason
    });
    if target_detected && correction_accepted && auto_activate {
        let corrected_xml = result
            .get("correctedXml")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if corrected_xml.is_empty() {
            return Err(json!({
                "code": 422,
                "error": "accepted_calibration_missing_corrected_xml",
                "fit": fit
            }));
        }
        let output_dir = result
            .get("outputDir")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let version = Path::new(output_dir)
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("automatic-array-calibration");
        let profile_name = algorithm_value_string(request, "profile", "current-8-time-trigger");
        let activation_request = json!({
            "name": profile_name,
            "path": corrected_xml,
            "version": version,
            "fitReport": result.get("fitReport").and_then(Value::as_str).unwrap_or_default(),
            "beforePreview": result.get("beforePreview").and_then(Value::as_str).unwrap_or_default(),
            "afterPreview": result.get("afterPreview").and_then(Value::as_str).unwrap_or_default(),
            "sourceCalibration": result.get("calibration").and_then(Value::as_str).unwrap_or_default(),
            "fitBefore": result.get("fitBefore").cloned().unwrap_or_else(|| json!({})),
            "fitAfter": result.get("fitAfter").cloned().unwrap_or_else(|| json!({})),
            "cameraParamDir": format!("config/camera-params/{profile_name}"),
            "allowExternal": true,
            "saveToDevice": false,
            "appliedBy": format!("automatic-calibration:{actor}")
        });
        let activation_response = state.capture.proxy_response_with_read_timeout(
            "POST",
            "/api/calibration/active",
            &activation_request.to_string(),
            Duration::from_secs(30),
        );
        let Some(activation_response) = activation_response else {
            return Err(json!({
                "code": 503,
                "error": "calibration_activation_provider_offline",
                "fit": fit
            }));
        };
        let activation =
            serde_json::from_slice::<Value>(&activation_response.body).map_err(|error| {
                json!({
                    "code": 502,
                    "error": "calibration_activation_response_invalid",
                    "detail": error.to_string(),
                    "fit": fit
                })
            })?;
        let activation_code = activation
            .get("code")
            .and_then(Value::as_i64)
            .unwrap_or(502);
        let activation_exists = activation
            .get("exists")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !(200..300).contains(&activation_response.status_code)
            || activation_code != 0
            || !activation_exists
        {
            return Err(json!({
                "code": 502,
                "error": "calibration_automatic_activation_failed",
                "providerStatus": activation_response.status_code,
                "activation": activation,
                "fit": fit
            }));
        }
        auto_activation = json!({
            "attempted": true,
            "activated": true,
            "saveToDevice": false,
            "profile": profile_name,
            "version": version,
            "calibrationPath": activation.get("calibrationPath").cloned().unwrap_or_else(|| json!(corrected_xml)),
            "provider": activation
        });
    }
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        "calibration.capture_fit",
        result
            .get("correctedXml")
            .and_then(Value::as_str)
            .unwrap_or("calibration-fit"),
        &format!(
            "eight-camera calibration capture and fit completed from {}; targetDetected={}; correctionAccepted={}; autoActivated={}",
            capture_summary_dir.display(),
            target_detected,
            correction_accepted,
            auto_activation.get("activated").and_then(Value::as_bool).unwrap_or(false)
        ),
        "warning",
    ));
    Ok(json!({
        "code": 0,
        "capture": capture,
        "fit": fit,
        "result": result,
        "autoActivation": auto_activation
    }))
}

fn write_production_calibration_capture_fit_response(
    state: &ServiceState,
    body: &str,
    actor: &str,
    cancellation_requested: Option<&dyn Fn() -> bool>,
) -> Vec<u8> {
    let request = match serde_json::from_str::<Value>(body.trim()) {
        Ok(value @ Value::Object(_)) => value,
        _ => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({ "code": 400, "error": "invalid_calibration_capture_fit_json" })
                    .to_string(),
            );
        }
    };
    match run_bar_surface_calibration_capture_fit(state, &request, actor, cancellation_requested) {
        Ok(payload) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &payload.to_string(),
        ),
        Err(payload) => http_response(
            if payload.get("code").and_then(Value::as_i64) == Some(400) {
                "400 Bad Request"
            } else {
                "422 Unprocessable Entity"
            },
            "application/json; charset=utf-8",
            &payload.to_string(),
        ),
    }
}

fn algorithm_run_response(body: &str) -> Vec<u8> {
    let request: Value = serde_json::from_str(body).unwrap_or_else(|_| json!({}));
    match run_bar_surface_algorithm(&request, None) {
        Ok(payload) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &payload.to_string(),
        ),
        Err(payload) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &payload.to_string(),
        ),
    }
}

fn algorithm_calibration_fit_response(body: &str) -> Vec<u8> {
    let request: Value = serde_json::from_str(body).unwrap_or_else(|_| json!({}));
    match run_bar_surface_calibration_fit(&request, None) {
        Ok(payload) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &payload.to_string(),
        ),
        Err(payload) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &payload.to_string(),
        ),
    }
}

fn path_modified_millis(path: &Path) -> u64 {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn count_files_with_extension(path: &Path, extension: &str) -> usize {
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case(extension))
                .unwrap_or(false)
        })
        .count()
}

fn algorithm_capture_materials_response(query: &str) -> Vec<u8> {
    let root = query_value(query, "captureRoot")
        .map(PathBuf::from)
        .unwrap_or_else(bar_surface_capture_root);
    let limit = query_value(query, "limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(80)
        .clamp(1, 500);
    let camera_names = [
        "camera1", "camera2", "camera3", "camera4", "camera5", "camera6", "camera7", "camera8",
    ];
    let camera_roots = camera_names
        .iter()
        .map(|name| root.join(name))
        .collect::<Vec<_>>();
    let first_root = &camera_roots[0];
    let mut materials = fs::read_dir(first_root)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .filter_map(|entry| {
            let material_dir = entry.path();
            if !material_dir.is_dir() {
                return None;
            }
            let material_id = material_dir.file_name()?.to_string_lossy().to_string();
            let mut cameras = Vec::new();
            let mut complete = true;
            let mut min_depth = usize::MAX;
            let mut latest_modified = path_modified_millis(&material_dir);
            for (index, camera_root) in camera_roots.iter().enumerate() {
                let camera_dir = camera_root.join(&material_id);
                let depth_dir = camera_dir.join("depth");
                let intensity_dir = camera_dir.join("intensity");
                let metadata_dir = camera_dir.join("metadata");
                let depth_count = count_files_with_extension(&depth_dir, "png");
                let intensity_count = count_files_with_extension(&intensity_dir, "png");
                let metadata_count = count_files_with_extension(&metadata_dir, "json");
                let present = depth_dir.is_dir() && intensity_dir.is_dir();
                complete &= present && depth_count > 0 && intensity_count > 0;
                min_depth = min_depth.min(depth_count);
                latest_modified = latest_modified.max(path_modified_millis(&camera_dir));
                cameras.push(json!({
                    "name": camera_names[index],
                    "root": camera_root.display().to_string(),
                    "path": camera_dir.display().to_string(),
                    "present": present,
                    "depthCount": depth_count,
                    "intensityCount": intensity_count,
                    "metadataCount": metadata_count
                }));
            }
            if min_depth == usize::MAX {
                min_depth = 0;
            }
            Some(json!({
                "materialId": material_id,
                "path": material_dir.display().to_string(),
                "complete": complete,
                "cameraCount": cameras.iter().filter(|camera| camera.get("present").and_then(Value::as_bool).unwrap_or(false)).count(),
                "minDepthFrames": min_depth,
                "updatedAtMillis": latest_modified,
                "cameras": cameras
            }))
        })
        .collect::<Vec<_>>();
    materials.sort_by(|a, b| {
        b.get("updatedAtMillis")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .cmp(
                &a.get("updatedAtMillis")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
    });
    materials.truncate(limit);
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({
            "code": 0,
            "captureRoot": root.display().to_string(),
            "configuration": algorithm_runtime_configuration(),
            "materials": materials
        })
        .to_string(),
    )
}

fn algorithm_runs_response(query: &str) -> Vec<u8> {
    let root = algorithm_data_root();
    let runs_root = root.join("runs");
    let material_filter = query_value(query, "materialId").filter(|value| !value.trim().is_empty());
    let mut runs = Vec::new();
    if let Ok(material_entries) = fs::read_dir(&runs_root) {
        for material_entry in material_entries.flatten() {
            let material_dir = material_entry.path();
            if !material_dir.is_dir() {
                continue;
            }
            let material_id = material_dir
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            if let Some(filter) = &material_filter {
                if &material_id != filter {
                    continue;
                }
            }
            let Ok(run_entries) = fs::read_dir(&material_dir) else {
                continue;
            };
            for run_entry in run_entries.flatten() {
                let run_dir = run_entry.path();
                let manifest_path = run_dir.join("manifest.json");
                if !manifest_path.is_file() {
                    continue;
                }
                let manifest = fs::read_to_string(&manifest_path)
                    .ok()
                    .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                    .unwrap_or_else(|| json!({}));
                let run_id = manifest
                    .get("runId")
                    .and_then(Value::as_str)
                    .or_else(|| run_dir.file_name().and_then(|value| value.to_str()))
                    .unwrap_or_default()
                    .to_string();
                let manifest_relative = manifest_path
                    .strip_prefix(&root)
                    .map(|path| path.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| manifest_path.display().to_string());
                let core_info = read_algorithm_core_info(&root, &manifest_path, &manifest);
                runs.push(json!({
                    "materialId": manifest.get("materialId").and_then(Value::as_str).unwrap_or(&material_id),
                    "runId": run_id,
                    "createdAt": manifest.get("createdAt").and_then(Value::as_str).unwrap_or_default(),
                    "runDir": run_dir.display().to_string(),
                    "manifestPath": manifest_path.display().to_string(),
                    "manifestRelative": manifest_relative,
                    "cameraCount": manifest.get("cameraCount").and_then(Value::as_u64).unwrap_or(0),
                    "frameCount": manifest.pointer("/mesh/frameCount").and_then(Value::as_u64).unwrap_or(0),
                    "vertexCount": manifest.pointer("/mesh/vertexCount").and_then(Value::as_u64).unwrap_or(0),
                    "triangleCount": manifest.pointer("/mesh/triangleCount").and_then(Value::as_u64).unwrap_or(0),
                    "coreAvailable": core_info.get("available").and_then(Value::as_bool).unwrap_or(false),
                    "coreOutputBytes": core_info.pointer("/summary/outputBytes").and_then(Value::as_u64).unwrap_or(0),
                    "coreBinaryRelative": core_info.get("binaryRelative").and_then(Value::as_str).unwrap_or_default(),
                    "coreSummaryRelative": core_info.get("summaryRelative").and_then(Value::as_str).unwrap_or_default(),
                    "updatedAtMillis": path_modified_millis(&manifest_path)
                }));
            }
        }
    }
    runs.sort_by(|a, b| {
        b.get("updatedAtMillis")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .cmp(
                &a.get("updatedAtMillis")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            )
    });
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({
            "code": 0,
            "root": root.display().to_string(),
            "configuration": algorithm_runtime_configuration(),
            "runs": runs
        })
        .to_string(),
    )
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
    deleted_capture_files: u64,
    files_planned: i64,
    files_deleted: i64,
    files_missing: i64,
    bytes_deleted: i64,
    failures: usize,
    dry_run: bool,
) -> String {
    if dry_run {
        format!(
            "预览检测记录保留策略：保留 {retention_days} 天，截止 {cutoff_at}，可清理 {matched} 条记录，计划物理文件 {files_planned} 个，规划失败 {failures} 条"
        )
    } else {
        format!(
            "执行检测记录保留策略：保留 {retention_days} 天，截止 {cutoff_at}，清理生产记录 {deleted_records} / {matched} 条，物理文件 {files_deleted} / {files_planned} 个，缺失 {files_missing} 个，删除字节 {bytes_deleted}，失败 {failures} 条，缺陷 {deleted_defects} 条，采集文件索引 {deleted_capture_files} 条；生产会话保留"
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
                "mustChangePassword": user.must_change_password,
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
        "permissions": &session.permissions,
        "mustChangePassword": session.must_change_password
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
    match production_record_status(status) {
        "detecting" => "检测中",
        "completed" => "已完成",
        _ => "检测中",
    }
}

fn inspection_record_spec(row: &db::AdminInspectionRecord) -> String {
    row.session
        .as_ref()
        .map(|session| {
            format!(
                "{:.0} x {:.0} x {:.1}mm",
                session.width_mm, session.length_mm, session.thickness_mm
            )
        })
        .unwrap_or_else(|| "-".to_string())
}

fn inspection_records_csv(rows: &[db::AdminInspectionRecord]) -> String {
    let mut csv = String::from("记录号,检测时间,管号,钢种,规格,状态,缺陷总数,严重,待复核,轻微\n");
    for row in rows {
        let steel_grade = row
            .session
            .as_ref()
            .map(|session| session.hard.as_str())
            .unwrap_or("-");
        let defect_count = row.severe_count + row.review_count + row.minor_count;
        let fields = [
            csv_escape(&row.inspection.id),
            csv_escape(&row.inspection.started_at),
            csv_escape(&row.inspection.material_id),
            csv_escape(steel_grade),
            csv_escape(&inspection_record_spec(row)),
            csv_escape(inspection_record_status_label(&row.inspection.status)),
            defect_count.to_string(),
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
    let plate = production_plate_value(&row.inspection, row.session.as_ref());
    let defect_count = row.severe_count + row.review_count + row.minor_count;
    json!({
        "id": &row.inspection.id,
        "time": &row.inspection.started_at,
        "plateNo": &row.inspection.material_id,
        "materialId": &row.inspection.material_id,
        "sessionId": &row.inspection.session_id,
        "status": production_record_status(&row.inspection.status),
        "productionStatus": &row.inspection.status,
        "defectCount": defect_count,
        "startedAt": &row.inspection.started_at,
        "finishedAt": &row.inspection.finished_at,
        "summaryPath": &row.inspection.summary_path,
        "source": "production",
        "plate": plate,
        "severity": {
            "severe": row.severe_count,
            "review": row.review_count,
            "minor": row.minor_count
        }
    })
}

fn inspection_record_detail_json(detail: db::AdminInspectionRecordDetail) -> String {
    let mut record = inspection_record_json(&detail.record);
    let plate = production_plate_value(&detail.record.inspection, detail.record.session.as_ref());
    if let Some(object) = record.as_object_mut() {
        object.insert(
            "defects".to_string(),
            Value::Array(
                detail
                    .defects
                    .iter()
                    .map(|defect| {
                        production_defect_value(defect, &detail.record.inspection, &plate)
                    })
                    .collect::<Vec<_>>(),
            ),
        );
        object.insert(
            "captureFiles".to_string(),
            Value::Array(
                detail
                    .capture_files
                    .iter()
                    .map(production_capture_image_value)
                    .collect::<Vec<_>>(),
            ),
        );
        let raw_payload = serde_json::from_str::<Value>(&detail.record.inspection.raw_payload)
            .unwrap_or_else(|_| json!({}));
        let algorithm_manifest = raw_payload
            .pointer("/algorithm/result/manifest")
            .or_else(|| raw_payload.pointer("/result/manifest"));
        object.insert(
            "algorithmTrace".to_string(),
            algorithm_manifest
                .map(algorithm_traceability_summary)
                .unwrap_or(Value::Null),
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

fn inspection_report_archive_root() -> PathBuf {
    env::var("STEEL_REPORT_ARCHIVE_ROOT")
        .map(PathBuf::from)
        .or_else(|_| {
            env::var("STEEL_RUNTIME_STATE_ROOT")
                .map(|root| PathBuf::from(root).join("reports").join("inspection"))
        })
        .unwrap_or_else(|_| config_dir().join("reports").join("inspection"))
}

fn issue_inspection_report_at(
    state: &ServiceState,
    archive_root: &Path,
    inspection_id: &str,
    actor: &str,
) -> Result<Value, String> {
    let detail = state
        .runtime
        .block_on(db::find_inspection_record_detail(
            &state.database.connection,
            inspection_id,
        ))
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "record_not_found".to_string())?;
    let detail_value = serde_json::from_str::<Value>(&inspection_record_detail_json(detail))
        .map_err(|error| format!("report_snapshot_invalid: {error}"))?;
    let record = detail_value
        .get("record")
        .cloned()
        .ok_or_else(|| "report_record_missing".to_string())?;
    let snapshot = json!({
        "schema": "steel.inspection.report.v1",
        "inspectionId": inspection_id,
        "materialId": record.get("materialId").and_then(Value::as_str).unwrap_or_default(),
        "record": record
    });
    let snapshot_bytes = serde_json::to_vec(&snapshot)
        .map_err(|error| format!("report_snapshot_serialize_failed: {error}"))?;
    let snapshot_sha256 = format!("{:x}", Sha256::digest(&snapshot_bytes));
    let report_id = format!(
        "RPT-{}-{}",
        safe_storage_segment(inspection_id),
        &snapshot_sha256[..12]
    );
    let inspection_root = archive_root.join(safe_storage_segment(inspection_id));
    fs::create_dir_all(&inspection_root)
        .map_err(|error| format!("report_archive_directory_failed: {error}"))?;
    let archive_path = inspection_root.join(format!("{report_id}.json"));
    if archive_path.is_file() {
        let existing = fs::read_to_string(&archive_path)
            .map_err(|error| format!("report_archive_read_failed: {error}"))?;
        let archive = serde_json::from_str::<Value>(&existing)
            .map_err(|error| format!("report_archive_invalid: {error}"))?;
        validate_inspection_report_archive(&archive, inspection_id, &report_id)
            .map_err(str::to_string)?;
        if archive.get("documentSha256").and_then(Value::as_str) != Some(&snapshot_sha256) {
            return Err("report_archive_hash_conflict".to_string());
        }
        return Ok(json!({
            "code": 0, "created": false, "reportId": report_id,
            "archivePath": archive_path.display().to_string(), "archive": archive
        }));
    }
    let archive = json!({
        "schema": "steel.inspection.report-archive.v1",
        "reportId": report_id,
        "inspectionId": inspection_id,
        "materialId": snapshot.get("materialId"),
        "issuedAt": current_time_string(),
        "issuedBy": actor,
        "documentSha256": snapshot_sha256,
        "document": snapshot
    });
    let archive_bytes = serde_json::to_vec_pretty(&archive)
        .map_err(|error| format!("report_archive_serialize_failed: {error}"))?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&archive_path)
        .map_err(|error| format!("report_archive_create_failed: {error}"))?;
    file.write_all(&archive_bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("report_archive_write_failed: {error}"))?;
    Ok(json!({
        "code": 0, "created": true, "reportId": report_id,
        "archivePath": archive_path.display().to_string(), "archive": archive
    }))
}

fn write_inspection_report_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(payload) if payload.is_object() => payload,
        _ => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                "{\"code\":400,\"error\":\"invalid_json\"}",
            )
        }
    };
    let inspection_id = value_string(&payload, &["inspectionId", "inspection_id", "id"]);
    if inspection_id.trim().is_empty() {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"inspection_id_required\"}",
        );
    }
    match issue_inspection_report_at(
        state,
        &inspection_report_archive_root(),
        &inspection_id,
        actor,
    ) {
        Ok(result) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "inspection.report.issue",
                &inspection_id,
                &format!(
                    "签发检测报告 {}（created={}）",
                    result
                        .get("reportId")
                        .and_then(Value::as_str)
                        .unwrap_or("-"),
                    result
                        .get("created")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                ),
                "info",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &result.to_string(),
            )
        }
        Err(error) if error == "record_not_found" => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"code\":404,\"error\":\"record_not_found\"}",
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({"code": 500, "error": error}).to_string(),
        ),
    }
}

fn validate_inspection_report_archive(
    archive: &Value,
    inspection_id: &str,
    report_id: &str,
) -> Result<(), &'static str> {
    let document = archive
        .get("document")
        .ok_or("report_archive_document_missing")?;
    let document_bytes =
        serde_json::to_vec(document).map_err(|_| "report_archive_document_invalid")?;
    let document_sha256 = format!("{:x}", Sha256::digest(document_bytes));
    let expected_report_id = format!(
        "RPT-{}-{}",
        safe_storage_segment(inspection_id),
        &document_sha256[..12]
    );
    let document_material_id = document.get("materialId").and_then(Value::as_str);
    let valid = archive.get("schema").and_then(Value::as_str)
        == Some("steel.inspection.report-archive.v1")
        && archive.get("inspectionId").and_then(Value::as_str) == Some(inspection_id)
        && archive.get("reportId").and_then(Value::as_str) == Some(report_id)
        && expected_report_id == report_id
        && document.get("schema").and_then(Value::as_str) == Some("steel.inspection.report.v1")
        && document.get("inspectionId").and_then(Value::as_str) == Some(inspection_id)
        && archive.get("materialId").and_then(Value::as_str) == document_material_id
        && archive.get("documentSha256").and_then(Value::as_str) == Some(document_sha256.as_str());
    if valid {
        Ok(())
    } else {
        Err("report_archive_integrity_failed")
    }
}

fn read_inspection_reports_at(archive_root: &Path, query: &str) -> Vec<u8> {
    let Some(inspection_id) =
        query_value(query, "inspectionId").or_else(|| query_value(query, "id"))
    else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"inspection_id_required\"}",
        );
    };
    if inspection_id.is_empty() || safe_storage_segment(&inspection_id) != inspection_id {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"invalid_report_identity\"}",
        );
    }
    let inspection_root = archive_root.join(&inspection_id);
    let entries =
        match fs::read_dir(&inspection_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return http_response(
                    "200 OK",
                    "application/json; charset=utf-8",
                    &json!({"code": 0, "inspectionId": inspection_id, "reports": []}).to_string(),
                )
            }
            Err(error) => return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({"code": 500, "error": format!("report_archive_directory_failed: {error}")})
                    .to_string(),
            ),
        };
    let mut reports = Vec::new();
    let mut invalid_archives = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                invalid_archives
                    .push(json!({"file": Value::Null, "reason": "report_archive_entry_failed"}));
                continue;
            }
        };
        let file_name = entry.file_name().to_string_lossy().to_string();
        let report_id = entry
            .path()
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();
        if entry.path().extension().and_then(|value| value.to_str()) != Some("json")
            || report_id.is_empty()
            || safe_storage_segment(&report_id) != report_id
        {
            invalid_archives
                .push(json!({"file": file_name, "reason": "unexpected_report_archive_entry"}));
            continue;
        }
        let archive = match fs::read_to_string(entry.path())
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        {
            Some(archive) => archive,
            None => {
                invalid_archives
                    .push(json!({"file": file_name, "reason": "report_archive_invalid"}));
                continue;
            }
        };
        match validate_inspection_report_archive(&archive, &inspection_id, &report_id) {
            Ok(()) => reports.push(json!({
                "reportId": archive.get("reportId"),
                "inspectionId": archive.get("inspectionId"),
                "materialId": archive.get("materialId"),
                "issuedAt": archive.get("issuedAt"),
                "issuedBy": archive.get("issuedBy"),
                "documentSha256": archive.get("documentSha256")
            })),
            Err(reason) => invalid_archives.push(json!({"file": file_name, "reason": reason})),
        }
    }
    if !invalid_archives.is_empty() {
        return http_response(
            "409 Conflict",
            "application/json; charset=utf-8",
            &json!({
                "code": 409,
                "error": "report_archive_integrity_failed",
                "inspectionId": inspection_id,
                "invalidArchiveCount": invalid_archives.len(),
                "invalidArchives": invalid_archives
            })
            .to_string(),
        );
    }
    reports.sort_by(|left, right| {
        right
            .get("issuedAt")
            .and_then(Value::as_str)
            .cmp(&left.get("issuedAt").and_then(Value::as_str))
    });
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({"code": 0, "inspectionId": inspection_id, "reports": reports}).to_string(),
    )
}

fn read_inspection_reports_response(query: &str) -> Vec<u8> {
    read_inspection_reports_at(&inspection_report_archive_root(), query)
}

fn read_inspection_report_detail_at(archive_root: &Path, query: &str) -> Vec<u8> {
    let Some(inspection_id) = query_value(query, "inspectionId") else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"inspection_id_required\"}",
        );
    };
    let Some(report_id) = query_value(query, "reportId") else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"report_id_required\"}",
        );
    };
    if inspection_id.is_empty()
        || report_id.is_empty()
        || safe_storage_segment(&inspection_id) != inspection_id
        || safe_storage_segment(&report_id) != report_id
    {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"invalid_report_identity\"}",
        );
    }
    let archive_path = archive_root
        .join(&inspection_id)
        .join(format!("{report_id}.json"));
    let archive_text = match fs::read_to_string(&archive_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return http_response(
                "404 Not Found",
                "application/json; charset=utf-8",
                "{\"code\":404,\"error\":\"report_archive_not_found\"}",
            )
        }
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({"code": 500, "error": format!("report_archive_read_failed: {error}")})
                    .to_string(),
            )
        }
    };
    let archive = match serde_json::from_str::<Value>(&archive_text) {
        Ok(value) => value,
        Err(_) => {
            return http_response(
                "409 Conflict",
                "application/json; charset=utf-8",
                "{\"code\":409,\"error\":\"report_archive_invalid\"}",
            )
        }
    };
    if validate_inspection_report_archive(&archive, &inspection_id, &report_id).is_err() {
        return http_response(
            "409 Conflict",
            "application/json; charset=utf-8",
            "{\"code\":409,\"error\":\"report_archive_integrity_failed\"}",
        );
    }
    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &json!({"code": 0, "archive": archive}).to_string(),
    )
}

fn read_inspection_report_detail_response(query: &str) -> Vec<u8> {
    read_inspection_report_detail_at(&inspection_report_archive_root(), query)
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

fn execute_record_artifact_cleanup(
    state: &ServiceState,
    record_id: &str,
    actor: &str,
    reason: &str,
) -> Result<artifact_cleanup::CleanupExecution, (String, Option<String>)> {
    if let Some(cleanup) = state
        .runtime
        .block_on(db::find_open_record_cleanup_for_record(
            &state.database.connection,
            record_id,
        ))
        .map_err(|error| (error.to_string(), None))?
    {
        let cleanup_id = cleanup.id.clone();
        return state
            .runtime
            .block_on(artifact_cleanup::execute_persisted_cleanup(
                &state.database.connection,
                cleanup,
            ))
            .map_err(|error| (error, Some(cleanup_id)));
    }
    let detail = state
        .runtime
        .block_on(db::find_inspection_record_detail(
            &state.database.connection,
            record_id,
        ))
        .map_err(|error| (error.to_string(), None))?
        .ok_or_else(|| ("record not found".to_string(), None))?;
    let unresolved = state
        .runtime
        .block_on(db::count_unresolved_production_tasks_for_session(
            &state.database.connection,
            &detail.record.inspection.session_id,
        ))
        .map_err(|error| (error.to_string(), None))?;
    if unresolved > 0 {
        return Err((
            "record cleanup is blocked by unresolved production tasks".to_string(),
            None,
        ));
    }
    let roots_text =
        artifact_cleanup::configured_roots_for_planning().map_err(|error| (error, None))?;
    let manifest =
        artifact_cleanup::build_manifest(&detail, &roots_text).map_err(|error| (error, None))?;
    let (files_planned, bytes_planned) = artifact_cleanup::manifest_plan_counts(&manifest);
    let manifest_json =
        artifact_cleanup::manifest_json(&manifest).map_err(|error| (error, None))?;
    let cleanup = state
        .runtime
        .block_on(db::create_or_load_record_cleanup(
            &state.database.connection,
            db::RecordCleanupInput {
                record_id: detail.record.inspection.id,
                material_id: detail.record.inspection.material_id,
                actor: actor.to_string(),
                reason: reason.to_string(),
                manifest_json,
                files_planned,
                bytes_planned,
            },
        ))
        .map_err(|error| (error.to_string(), None))?;
    let cleanup_id = cleanup.id.clone();
    state
        .runtime
        .block_on(artifact_cleanup::execute_persisted_cleanup(
            &state.database.connection,
            cleanup,
        ))
        .map_err(|error| (error, Some(cleanup_id)))
}

fn record_cleanup_failure_response(error: &str, cleanup_id: Option<&str>) -> Vec<u8> {
    let configuration_missing = error.contains("STEEL_ARTIFACT_ALLOWED_ROOTS");
    let not_found = error == "record not found";
    let status = if configuration_missing {
        "503 Service Unavailable"
    } else if not_found {
        "404 Not Found"
    } else {
        "409 Conflict"
    };
    let code = if configuration_missing {
        503
    } else if not_found {
        404
    } else {
        409
    };
    http_response(
        status,
        "application/json; charset=utf-8",
        &json!({
            "code": code,
            "error": "record_artifact_cleanup_failed",
            "message": error,
            "cleanupId": cleanup_id,
            "retryable": !not_found
        })
        .to_string(),
    )
}

fn record_cleanup_json(model: db::entities::record_cleanup::Model) -> Value {
    json!({
        "id": model.id,
        "recordId": model.record_id,
        "materialId": model.material_id,
        "status": model.status,
        "actor": model.actor,
        "reason": model.reason,
        "manifest": serde_json::from_str::<Value>(&model.manifest_json).unwrap_or(Value::Null),
        "filesPlanned": model.files_planned,
        "filesDeleted": model.files_deleted,
        "filesMissing": model.files_missing,
        "bytesPlanned": model.bytes_planned,
        "bytesDeleted": model.bytes_deleted,
        "error": model.error,
        "createdAt": model.created_at,
        "updatedAt": model.updated_at,
        "completedAt": model.completed_at
    })
}

fn read_record_cleanup_response(state: &ServiceState, query: &str) -> Vec<u8> {
    let Some(id) = query_value(query, "id").filter(|value| !value.trim().is_empty()) else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"cleanup id required\"}",
        );
    };
    match state
        .runtime
        .block_on(db::find_record_cleanup(&state.database.connection, &id))
    {
        Ok(Some(model)) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({ "code": 0, "cleanup": record_cleanup_json(model) }).to_string(),
        ),
        Ok(None) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"code\":404,\"error\":\"cleanup not found\"}",
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        ),
    }
}

fn retry_record_cleanup_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload = serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    let Some(id) = payload
        .get("cleanupId")
        .or_else(|| payload.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            "{\"code\":400,\"error\":\"cleanup id required\"}",
        );
    };
    let cleanup = match state
        .runtime
        .block_on(db::find_record_cleanup(&state.database.connection, id))
    {
        Ok(Some(model)) => model,
        Ok(None) => {
            return http_response(
                "404 Not Found",
                "application/json; charset=utf-8",
                "{\"code\":404,\"error\":\"cleanup not found\"}",
            )
        }
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            )
        }
    };
    if cleanup.status == "completed" {
        return http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({ "code": 0, "cleanup": record_cleanup_json(cleanup), "replayed": true })
                .to_string(),
        );
    }
    let cleanup_id = cleanup.id.clone();
    match state
        .runtime
        .block_on(artifact_cleanup::execute_persisted_cleanup(
            &state.database.connection,
            cleanup,
        )) {
        Ok(result) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "record.cleanup.retry.completed",
                &result.record_id,
                &format!("cleanup {} completed on retry", result.cleanup_id),
                "warning",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "cleanupId": result.cleanup_id,
                    "recordId": result.record_id,
                    "filesDeleted": result.files_deleted,
                    "filesMissing": result.files_missing,
                    "bytesDeleted": result.bytes_deleted
                })
                .to_string(),
            )
        }
        Err(error) => record_cleanup_failure_response(&error, Some(&cleanup_id)),
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

    let candidate_ids = match state.runtime.block_on(db::inspection_record_ids_before(
        &state.database.connection,
        retention_days,
    )) {
        Ok(ids) => ids,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            )
        }
    };
    let matched = candidate_ids.len() as u64;
    let mut deleted_records = 0_u64;
    let mut deleted_defects = 0_u64;
    let mut deleted_capture_files = 0_u64;
    let mut files_planned = 0_i64;
    let mut files_deleted = 0_i64;
    let mut files_missing = 0_i64;
    let mut bytes_planned = 0_i64;
    let mut bytes_deleted = 0_i64;
    let mut cleanup_ids = Vec::new();
    let mut failures = Vec::new();

    if dry_run {
        let roots_text = match artifact_cleanup::configured_roots_for_planning() {
            Ok(value) => value,
            Err(error) => return record_cleanup_failure_response(&error, None),
        };
        for id in &candidate_ids {
            let detail = match state.runtime.block_on(db::find_inspection_record_detail(
                &state.database.connection,
                id,
            )) {
                Ok(Some(detail)) => detail,
                Ok(None) => continue,
                Err(error) => {
                    failures.push(json!({ "recordId": id, "error": error.to_string() }));
                    continue;
                }
            };
            match artifact_cleanup::build_manifest(&detail, &roots_text) {
                Ok(manifest) => {
                    let (count, bytes) = artifact_cleanup::manifest_plan_counts(&manifest);
                    files_planned += i64::from(count);
                    bytes_planned = bytes_planned.saturating_add(bytes);
                }
                Err(error) => failures.push(json!({ "recordId": id, "error": error })),
            }
        }
    } else {
        for id in &candidate_ids {
            match execute_record_artifact_cleanup(state, id, actor, "record-retention") {
                Ok(result) => {
                    deleted_records += 1;
                    deleted_defects += result.defects_deleted;
                    deleted_capture_files += result.capture_files_deleted;
                    files_planned += i64::from(result.files_planned);
                    files_deleted += i64::from(result.files_deleted);
                    files_missing += i64::from(result.files_missing);
                    bytes_planned = bytes_planned.saturating_add(result.bytes_planned);
                    bytes_deleted = bytes_deleted.saturating_add(result.bytes_deleted);
                    cleanup_ids.push(result.cleanup_id);
                }
                Err((error, cleanup_id)) => failures.push(json!({
                    "recordId": id,
                    "cleanupId": cleanup_id,
                    "error": error
                })),
            }
        }
    }

    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        if dry_run {
            "record.retention.preview"
        } else {
            "record.retention.purge"
        },
        "production_inspection",
        &record_retention_detail(
            retention_days,
            &cutoff_at,
            matched,
            deleted_records,
            deleted_defects,
            deleted_capture_files,
            files_planned,
            files_deleted,
            files_missing,
            bytes_deleted,
            failures.len(),
            dry_run,
        ),
        if dry_run { "info" } else { "warning" },
    ));

    http_response(
        if failures.is_empty() {
            "200 OK"
        } else {
            "207 Multi-Status"
        },
        "application/json; charset=utf-8",
        &json!({
            "code": if failures.is_empty() { 0 } else { 207 },
            "retentionDays": retention_days,
            "cutoffAt": cutoff_at,
            "matched": matched,
            "deletedRecords": deleted_records,
            "deletedDefects": deleted_defects,
            "deletedCaptureFiles": deleted_capture_files,
            "deletedPlates": 0,
            "filesPlanned": files_planned,
            "filesDeleted": files_deleted,
            "filesMissing": files_missing,
            "bytesPlanned": bytes_planned,
            "bytesDeleted": bytes_deleted,
            "cleanupIds": cleanup_ids,
            "failures": failures,
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
    match execute_record_artifact_cleanup(state, &id, actor, "manual-record-delete") {
        Ok(result) => {
            let detail = format!(
                "完成清理 {}：生产检测记录 {}，材料 {}，物理文件 {}/{}，缺失 {}，删除字节 {}，缺陷 {} 条、采集文件索引 {} 条；流程会话保留",
                result.cleanup_id,
                result.record_id,
                result.material_id,
                result.files_deleted,
                result.files_planned,
                result.files_missing,
                result.bytes_deleted,
                result.defects_deleted,
                result.capture_files_deleted
            );
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "record.cleanup.completed",
                &result.record_id,
                &detail,
                "warning",
            ));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "deleted": true,
                    "cleanupId": result.cleanup_id,
                    "recordId": result.record_id,
                    "plateNo": result.material_id,
                    "materialId": result.material_id,
                    "filesPlanned": result.files_planned,
                    "filesDeleted": result.files_deleted,
                    "filesMissing": result.files_missing,
                    "bytesPlanned": result.bytes_planned,
                    "bytesDeleted": result.bytes_deleted,
                    "defectsDeleted": result.defects_deleted,
                    "captureFilesDeleted": result.capture_files_deleted,
                    "plateDeleted": false
                })
                .to_string(),
            )
        }
        Err((error, cleanup_id)) => record_cleanup_failure_response(&error, cleanup_id.as_deref()),
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
                "fallback": "simulated-eight-camera"
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
    let mut body = json!({
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
                { "name": "steel_plate", "label": "旧版材料档案（只读）", "rows": metrics.plate_count },
                { "name": "defect", "label": "旧版缺陷（只读）", "rows": metrics.defect_count },
                { "name": "defect_type", "label": "缺陷类型", "rows": metrics.defect_type_count },
                { "name": "inspection_record", "label": "旧版检测记录（只读）", "rows": metrics.record_count },
                { "name": "camera_config", "label": "相机配置", "rows": metrics.camera_count },
                { "name": "app_config", "label": "系统配置", "rows": metrics.config_count },
                { "name": "config_revision", "label": "配置版本", "rows": metrics.config_revision_count },
                { "name": "admin_user", "label": "后台账号", "rows": metrics.user_count },
                { "name": "admin_role", "label": "角色权限", "rows": metrics.role_count },
                { "name": "audit_log", "label": "审计日志", "rows": metrics.audit_log_count }
                ,
                { "name": "material_session", "label": "生产材料会话", "rows": metrics.material_session_count },
                { "name": "secondary_data", "label": "二级数据", "rows": metrics.secondary_data_count },
                { "name": "trigger_event", "label": "生产触发事件", "rows": metrics.trigger_event_count },
                { "name": "production_inspection", "label": "正式检测记录", "rows": metrics.production_inspection_count },
                { "name": "production_task", "label": "持久生产任务", "rows": metrics.production_task_count },
                { "name": "calibration_operation", "label": "持久标定操作", "rows": metrics.calibration_operation_count },
                { "name": "capture_file", "label": "采集文件索引", "rows": metrics.capture_file_count },
                { "name": "production_defect", "label": "正式缺陷", "rows": metrics.production_defect_count },
                { "name": "production_alarm", "label": "生产报警", "rows": metrics.production_alarm_count }
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
            { "method": "GET", "path": "/api/health/live", "scope": "service" },
            { "method": "GET", "path": "/api/health/ready", "scope": "service" },
            { "method": "GET", "path": "/api/health/ready/details", "scope": "service" },
            { "method": "GET", "path": "/api/health/details", "scope": "service" },
            { "method": "GET", "path": "/api/services", "scope": "service" },
            { "method": "GET", "path": "/api/system/network", "scope": "service" },
            { "method": "GET", "path": "/api/trigger/status", "scope": "trigger-proxy" },
            { "method": "GET", "path": "/api/trigger/mode", "scope": "trigger-proxy" },
            { "method": "POST", "path": "/api/trigger/mode", "scope": "trigger-proxy" },
            { "method": "POST", "path": "/api/trigger/manual/steel-info", "scope": "trigger-proxy" },
            { "method": "POST", "path": "/api/trigger/manual/steel-in", "scope": "trigger-proxy" },
            { "method": "POST", "path": "/api/trigger/manual/steel-out", "scope": "trigger-proxy" },
            { "method": "POST", "path": "/api/trigger/capture-once", "scope": "trigger-proxy" },
            { "method": "GET", "path": "/api/algorithm/bar-surface/latest", "scope": "algorithm" },
            { "method": "GET", "path": "/api/algorithm/bar-surface/manifest", "scope": "algorithm" },
            { "method": "GET", "path": "/api/algorithm/bar-surface/file", "scope": "algorithm" },
            { "method": "GET", "path": "/api/algorithm/bar-surface/captures", "scope": "algorithm" },
            { "method": "GET", "path": "/api/algorithm/bar-surface/runs", "scope": "algorithm" },
            { "method": "POST", "path": "/api/algorithm/bar-surface/run", "scope": "algorithm" },
            { "method": "POST", "path": "/api/algorithm/bar-surface/calibration/fit", "scope": "algorithm" },
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
            { "method": "GET", "path": "/api/admin/records/reports", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/records/reports/detail", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/records/reports", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/records/cleanup", "scope": "admin" },
            { "method": "GET", "path": "/api/admin/records/export", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/records/retention", "scope": "admin" },
            { "method": "POST", "path": "/api/admin/records/cleanup/retry", "scope": "admin" },
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
            { "method": "GET", "path": "/api/alarms", "scope": "alarm" },
            { "method": "POST", "path": "/api/alarms/acknowledge", "scope": "admin.records" },
            { "method": "POST", "path": "/api/alarms/resolve", "scope": "admin.records" },
            { "method": "GET", "path": "/api/production/status", "scope": "production" },
            { "method": "POST", "path": "/api/production/tasks", "scope": "production" },
            { "method": "GET", "path": "/api/production/tasks", "scope": "production" },
            { "method": "GET", "path": "/api/production/tasks/detail", "scope": "production" },
            { "method": "POST", "path": "/api/production/tasks/cancel", "scope": "production" },
            { "method": "POST", "path": "/api/production/tasks/retry", "scope": "production" },
            { "method": "POST", "path": "/api/production/tasks/steel-info", "scope": "production" },
            { "method": "POST", "path": "/api/production/tasks/steel-in", "scope": "production" },
            { "method": "POST", "path": "/api/production/tasks/steel-out", "scope": "production" },
            { "method": "POST", "path": "/api/production/tasks/trigger-event", "scope": "production" },
            { "method": "POST", "path": "/api/production/steel-info", "scope": "production" },
            { "method": "POST", "path": "/api/production/steel-in", "scope": "production" },
            { "method": "POST", "path": "/api/production/steel-out", "scope": "production" },
            { "method": "POST", "path": "/api/production/trigger-event", "scope": "production" },
            { "method": "POST", "path": "/api/production/secondary-data", "scope": "production" },
            { "method": "POST", "path": "/api/production/capture-summary", "scope": "production" },
            { "method": "POST", "path": "/api/production/capture-once", "scope": "production" },
            { "method": "POST", "path": "/api/production/algorithm/run", "scope": "production" },
            { "method": "POST", "path": "/api/production/defect", "scope": "production" },
            { "method": "GET", "path": "/api/production/file", "scope": "production" },
            { "method": "GET", "path": "/api/steel/status", "scope": "capture" },
            { "method": "POST", "path": "/api/steel/capture-mode", "scope": "capture" },
            { "method": "POST", "path": "/api/steel/event", "scope": "capture" },
            { "method": "GET", "path": "/api/camera/statuses", "scope": "capture" },
            { "method": "GET", "path": "/api/capture/latest", "scope": "capture" },
            { "method": "GET", "path": "/api/storage/status", "scope": "capture" },
            { "method": "POST", "path": "/api/storage/config", "scope": "capture" },
            { "method": "GET", "path": "/api/config/profiles", "scope": "capture" },
            { "method": "POST", "path": "/api/config/profile/apply", "scope": "capture" },
            { "method": "POST", "path": "/api/config/camera-params/save-all", "scope": "capture" },
            { "method": "POST", "path": "/api/config/camera-params/load-all", "scope": "capture" },
            { "method": "POST", "path": "/api/stream/start", "scope": "capture" },
            { "method": "POST", "path": "/api/stream/stop", "scope": "capture" },
            { "method": "GET", "path": "/api/stream/status", "scope": "capture" },
            { "method": "GET", "path": "/api/stream/latest", "scope": "capture" },
            { "method": "POST", "path": "/api/capture/continuous-test", "scope": "capture" },
            { "method": "POST", "path": "/api/capture/preset/line-continuous", "scope": "capture" },
            { "method": "GET", "path": "/api/calibration/active", "scope": "capture" },
            { "method": "POST", "path": "/api/calibration/active", "scope": "capture" },
            { "method": "POST", "path": "/api/calibration/apply-all", "scope": "capture" },
            { "method": "POST", "path": "/api/calibration/rollback", "scope": "capture" },
            { "method": "GET", "path": "/api/calibration/status", "scope": "capture" },
            { "method": "GET", "path": "/api/calibration/operations/detail", "scope": "capture-ledger" }
        ]
    });

    if let Some(routes) = body.get_mut("apiRoutes").and_then(Value::as_array_mut) {
        append_capture_proxy_manifest_routes(routes);
    }

    http_response(
        "200 OK",
        "application/json; charset=utf-8",
        &body.to_string(),
    )
}

fn handle_client(mut stream: TcpStream, state: Arc<ServiceState>) {
    let peer = stream.peer_addr().ok();
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
    if method == "POST" && path == "/api/runtime/drain" {
        let _ = stream.write_all(&runtime_drain_response(&state, &request, peer));
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
    let _runtime_admission_guard = match enter_runtime_admission(&state, method, path) {
        Ok(guard) => guard,
        Err(response) => {
            let _ = stream.write_all(&response);
            return;
        }
    };
    if calibration_operations::mutation_requires_reconciliation_fence(method, path) {
        if let Some(response) = calibration_operations::reconciliation_fence_response(&state, path)
        {
            let _ = stream.write_all(&response);
            return;
        }
    }
    let _production_command_guard = if is_production_mutation_route(method, path) {
        state.production_command_lock.lock().ok()
    } else {
        None
    };
    let health_endpoint = health_endpoint_for_route(method, path);
    let queued_production_kind = production_tasks::queued_kind_for_route(method, path);
    let response = match (method, path) {
        ("OPTIONS", _) => http_response("204 No Content", "application/json; charset=utf-8", ""),
        _ if health_endpoint.is_some() => {
            service_health_response(&state, health_endpoint.expect("health endpoint guard"))
        }
        ("GET", "/api/system/network") => system_network_status_response(),
        ("GET", "/api/services") => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &format!(
                "{{\"api\":{{\"name\":\"steel-inspection-service\",\"running\":true,\"port\":{}}},\"capture\":{}}}",
                env::var("INSPECTION_SERVICE_PORT").unwrap_or_else(|_| "4873".to_string()),
                state.capture.status_json()
            ),
        ),
        ("GET", "/api/algorithm/bar-surface/latest") => algorithm_latest_response(),
        ("GET", "/api/algorithm/bar-surface/manifest") => algorithm_manifest_response(query),
        ("GET", "/api/algorithm/bar-surface/file") => algorithm_file_response(query),
        ("GET", "/api/algorithm/bar-surface/captures") => algorithm_capture_materials_response(query),
        ("GET", "/api/algorithm/bar-surface/runs") => algorithm_runs_response(query),
        ("POST", "/api/algorithm/bar-surface/run") => algorithm_run_response(body),
        ("POST", "/api/algorithm/bar-surface/calibration/fit") => {
            algorithm_calibration_fit_response(body)
        }
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
        ("GET", "/api/admin/records/reports/detail") => {
            read_inspection_report_detail_response(query)
        }
        ("GET", "/api/admin/records/reports") => read_inspection_reports_response(query),
        ("POST", "/api/admin/records/reports") => {
            write_inspection_report_response(&state, body, actor)
        }
        ("GET", "/api/admin/records/cleanup") => read_record_cleanup_response(&state, query),
        ("POST", "/api/admin/records/retention") => {
            apply_record_retention_response(&state, body, actor)
        }
        ("POST", "/api/admin/records/cleanup/retry") => {
            retry_record_cleanup_response(&state, body, actor)
        }
        ("DELETE", "/api/admin/records") => delete_admin_record_response(&state, query, actor),
        ("GET", "/api/admin/records") => read_admin_records_response(&state, query),
        ("GET", "/api/alarms") => read_production_alarms_response(&state, query),
        ("POST", "/api/alarms/acknowledge") => write_production_alarm_action_response(
            &state,
            body,
            actor,
            ProductionAlarmAction::Acknowledge,
        ),
        ("POST", "/api/alarms/resolve") => write_production_alarm_action_response(
            &state,
            body,
            actor,
            ProductionAlarmAction::Resolve,
        ),
        ("GET", "/api/production/status") => production_status_response(&state),
        ("POST", "/api/production/tasks") => {
            production_tasks::enqueue_response(&state, body, actor)
        }
        ("GET", "/api/production/tasks") => production_tasks::list_response(&state, query),
        ("GET", "/api/production/tasks/detail") => {
            production_tasks::detail_response(&state, query)
        }
        ("POST", "/api/production/tasks/cancel") => {
            production_tasks::cancel_response(&state, body, actor)
        }
        ("POST", "/api/production/tasks/retry") => {
            production_tasks::retry_response(&state, body, actor)
        }
        _ if queued_production_kind.is_some() => production_tasks::enqueue_kind_response(
            &state,
            queued_production_kind.expect("queued production kind guard"),
            body,
            actor,
        ),
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
        ("POST", "/api/production/algorithm/run") => {
            write_production_algorithm_run_response(&state, body, actor, None)
        }
        ("POST", "/api/production/defect") => {
            write_production_defect_response(&state, body, actor)
        }
        ("GET", "/api/production/file") => production_file_response(query),
        ("GET", "/api/calibration/operations/detail") => {
            calibration_operations::detail_response(&state, query)
        }
        ("POST", "/api/calibration/apply-all") => {
            calibration_operations::apply_response(&state, body, actor)
        }
        ("POST", "/api/calibration/rollback") => {
            calibration_operations::mutation_response(&state, path, body, actor)
        }
        ("GET", "/api/inspection/snapshot") => {
            match build_production_snapshot_json(&state) {
                Ok(Some(payload)) => http_response(
                    "200 OK",
                    "application/json; charset=utf-8",
                    &payload,
                ),
                Ok(None) => match state
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
                            "{{\"error\":\"database_snapshot_unavailable\",\"detail\":\"{}\",\"fallback\":{}}}",
                            json_escape(&error.to_string()),
                            build_snapshot_json()
                        ),
                    ),
                },
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
        _ if is_trigger_gateway_proxy_route(method, path) => {
            trigger_gateway_proxy_http_response(&state, method, raw_path, body, actor)
        }
        _ if is_capture_json_proxy_route(method, path) => {
            capture_proxy_http_response(&state.capture, method, raw_path, path, body)
        }
        _ if is_capture_binary_proxy_route(method, path) => {
            capture_proxy_http_response(&state.capture, method, raw_path, path, body)
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
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(false)?;
    let database_path = config_dir.join("steel-inspection.sqlite");
    let runtime = Runtime::new()?;
    let database = runtime
        .block_on(db::open_database(database_path))
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error.to_string()))?;
    let recovered_calibration_operations = runtime
        .block_on(db::recover_dispatching_calibration_operations(
            &database.connection,
        ))
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error.to_string()))?;
    if recovered_calibration_operations > 0 {
        eprintln!(
            "marked {recovered_calibration_operations} interrupted calibration operation(s) as needs-reconciliation; no operation was replayed"
        );
    }
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
        production_command_lock: Mutex::new(()),
        calibration_operation_lock: Mutex::new(()),
        production_task_admin_lock: Mutex::new(()),
        production_task_wakeup: Condvar::new(),
        production_task_wakeup_generation: Mutex::new(0),
        production_task_worker_status: Mutex::new(ProductionTaskWorkerStatus::default()),
        production_task_sequence: AtomicU64::new(0),
        runtime_admission: Mutex::new(RuntimeAdmissionState::default()),
        runtime_drain_token: env::var("TRIGGER_OPERATOR_TOKEN")
            .unwrap_or_default()
            .into_bytes(),
        trigger_gateway_origin: trigger_gateway_origin(),
        trigger_health_required: trigger_health_required(),
        runtime_profile: env::var("STEEL_RUNTIME_PROFILE")
            .unwrap_or_else(|_| "production".to_string()),
        algorithm_mode: env::var("STEEL_ALGORITHM_MODE")
            .unwrap_or_else(|_| "production".to_string()),
        algorithm_mock_defect_count: env::var("BAR_SURFACE_MOCK_DEFECT_COUNT")
            .unwrap_or_else(|_| "0".to_string()),
        sessions: Mutex::new(HashMap::new()),
        login_failures: Mutex::new(HashMap::new()),
        started_at: current_time_millis(),
    });
    production_tasks::start_worker(Arc::clone(&state));
    start_system_health_alarm_monitor(Arc::clone(&state));
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
                if let Err(error) = std::thread::Builder::new()
                    .name("inspection-http-request".to_string())
                    .spawn(move || handle_client(stream, state))
                {
                    eprintln!("failed to start request worker: {error}");
                }
            }
            Err(error) => eprintln!("failed to accept connection: {error}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ActiveModelTrait, ConnectionTrait, DbBackend, Set, Statement};

    fn production_test_state() -> ServiceState {
        production_test_state_with_provider(CaptureProvider::Simulated, "simulated://capture")
    }

    fn production_test_state_with_provider(
        provider: CaptureProvider,
        origin: &str,
    ) -> ServiceState {
        let runtime = Runtime::new().expect("test runtime");
        let database = runtime
            .block_on(db::open_database_url(
                "sqlite::memory:".to_string(),
                PathBuf::from(":memory:"),
            ))
            .expect("in-memory production database");
        production_test_state_with_database(runtime, database, provider, origin)
    }

    fn production_test_state_with_database(
        runtime: Runtime,
        database: db::AppDatabase,
        provider: CaptureProvider,
        origin: &str,
    ) -> ServiceState {
        ServiceState {
            fallback_snapshot_json: Arc::new(build_snapshot_json()),
            config_json: Mutex::new(String::new()),
            capture: Arc::new(CaptureServiceManager {
                host: capture_host_from_origin(origin).unwrap_or_else(|| "127.0.0.1".to_string()),
                port: capture_port_from_origin(origin).unwrap_or(0),
                origin: origin.to_string(),
                provider,
                process: Mutex::new(None),
                simulated_capture_mode: Mutex::new("continuous".to_string()),
                simulated_continuous_line_rate: Mutex::new(300.0),
            }),
            database,
            runtime,
            production_command_lock: Mutex::new(()),
            calibration_operation_lock: Mutex::new(()),
            production_task_admin_lock: Mutex::new(()),
            production_task_wakeup: Condvar::new(),
            production_task_wakeup_generation: Mutex::new(0),
            production_task_worker_status: Mutex::new(ProductionTaskWorkerStatus::default()),
            production_task_sequence: AtomicU64::new(0),
            runtime_admission: Mutex::new(RuntimeAdmissionState::default()),
            runtime_drain_token: b"operator-0123456789abcdef-ABCDEF!".to_vec(),
            trigger_gateway_origin: "disabled".to_string(),
            trigger_health_required: false,
            runtime_profile: "test".to_string(),
            algorithm_mode: "demo".to_string(),
            algorithm_mock_defect_count: "0".to_string(),
            sessions: Mutex::new(HashMap::new()),
            login_failures: Mutex::new(HashMap::new()),
            started_at: current_time_millis(),
        }
    }

    fn response_text(response: Vec<u8>) -> String {
        String::from_utf8(response).expect("HTTP response should be UTF-8")
    }

    fn response_json(response: Vec<u8>) -> Value {
        let response = response_text(response);
        let body = response
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .expect("HTTP response should contain a body");
        serde_json::from_str(body).expect("HTTP response body should be JSON")
    }

    #[test]
    fn runtime_drain_requires_loopback_operator_token_and_is_idempotent() {
        let state = production_test_state();
        let valid_request = concat!(
            "POST /api/runtime/drain HTTP/1.1\r\n",
            "X-Trigger-Operator-Token: operator-0123456789abcdef-ABCDEF!\r\n",
            "Content-Length: 2\r\n\r\n{}"
        );
        let remote = response_text(runtime_drain_response(
            &state,
            valid_request,
            Some("192.0.2.20:42000".parse().expect("remote address")),
        ));
        assert!(remote.starts_with("HTTP/1.1 403 Forbidden\r\n"));
        let missing = response_text(runtime_drain_response(
            &state,
            "POST /api/runtime/drain HTTP/1.1\r\n\r\n{}",
            Some("127.0.0.1:42000".parse().expect("loopback address")),
        ));
        assert!(missing.starts_with("HTTP/1.1 401 Unauthorized\r\n"));
        assert!(!runtime_is_draining(&state));

        for _ in 0..2 {
            let accepted = response_json(runtime_drain_response(
                &state,
                valid_request,
                Some("127.0.0.1:42000".parse().expect("loopback address")),
            ));
            assert_eq!(accepted["code"], json!(0));
            assert_eq!(accepted["admission"]["draining"], json!(true));
            assert_eq!(accepted["admission"]["accepting"], json!(false));
        }
    }

    #[test]
    fn runtime_drain_atomically_closes_admission_and_counts_preexisting_work() {
        let state = Arc::new(production_test_state());
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let worker_state = Arc::clone(&state);
        let worker_entered = Arc::clone(&entered);
        let worker_release = Arc::clone(&release);
        let worker = std::thread::spawn(move || {
            let guard = enter_runtime_admission(&worker_state, "POST", "/api/production/steel-in")
                .expect("pre-drain admission")
                .expect("mutation should be counted");
            worker_entered.wait();
            worker_release.wait();
            drop(guard);
        });
        entered.wait();

        let request = concat!(
            "POST /api/runtime/drain HTTP/1.1\r\n",
            "X-Trigger-Operator-Token: operator-0123456789abcdef-ABCDEF!\r\n\r\n{}"
        );
        let accepted = response_json(runtime_drain_response(
            &state,
            request,
            Some("127.0.0.1:42000".parse().expect("loopback address")),
        ));
        assert_eq!(accepted["admission"]["accepting"], json!(false));
        assert_eq!(accepted["admission"]["inFlight"], json!(1));
        let post_drain = enter_runtime_admission(&state, "POST", "/api/production/steel-in");
        match post_drain {
            Err(response) => assert!(response_text(response).contains("runtime_draining")),
            Ok(_) => panic!("post-drain work admission must be rejected"),
        }

        release.wait();
        worker.join().expect("admitted request thread");
        assert_eq!(runtime_drain_status_json(&state)["inFlight"], json!(0));
    }

    #[test]
    fn runtime_drain_is_visible_before_waiting_for_the_production_boundary() {
        let state = Arc::new(production_test_state());
        let entered = Arc::new(std::sync::Barrier::new(2));
        let worker_state = Arc::clone(&state);
        let worker_entered = Arc::clone(&entered);
        let (observed_tx, observed_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _guard = worker_state
                .production_command_lock
                .lock()
                .expect("production command lock");
            worker_entered.wait();
            let deadline = Instant::now() + Duration::from_secs(1);
            while !runtime_is_draining(&worker_state) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            observed_tx
                .send(runtime_is_draining(&worker_state))
                .expect("publish observed drain state");
        });
        entered.wait();

        let accepted = response_json(runtime_drain_response(
            &state,
            concat!(
                "POST /api/runtime/drain HTTP/1.1\r\n",
                "X-Trigger-Operator-Token: operator-0123456789abcdef-ABCDEF!\r\n\r\n{}"
            ),
            Some("127.0.0.1:42000".parse().expect("loopback address")),
        ));

        assert_eq!(accepted["code"], json!(0));
        assert!(observed_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("worker should observe drain before releasing command lock"));
        worker.join().expect("production-boundary worker");
    }

    #[test]
    fn runtime_drain_rejects_new_admission_but_allows_safe_completion() {
        let state = production_test_state();
        let first = response_text(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"steel-in","idempotencyKey":"DRAIN-REPLAY","payload":{"materialId":"MAT-DRAIN"}}"#,
            "tester",
        ));
        assert!(first.starts_with("HTTP/1.1 202 Accepted\r\n"));
        state
            .runtime_admission
            .lock()
            .expect("runtime admission")
            .accepting = false;

        let replay = response_text(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"steel-in","idempotencyKey":"DRAIN-REPLAY","payload":{"materialId":"MAT-DRAIN"}}"#,
            "tester",
        ));
        assert!(replay.starts_with("HTTP/1.1 200 OK\r\n"));
        let rejected = response_text(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"steel-in","idempotencyKey":"DRAIN-NEW","payload":{"materialId":"MAT-NEW"}}"#,
            "tester",
        ));
        assert!(rejected.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
        assert!(rejected.contains("runtime_draining"));
        let steel_out = response_text(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"steel-out","idempotencyKey":"DRAIN-OUT","payload":{"materialId":"MAT-DRAIN"}}"#,
            "tester",
        ));
        assert!(steel_out.starts_with("HTTP/1.1 202 Accepted\r\n"));

        let rejected_admission =
            enter_runtime_admission(&state, "POST", "/api/production/steel-in");
        match rejected_admission {
            Err(response) => assert!(response_text(response).contains("runtime_draining")),
            Ok(_) => panic!("new production admission must be rejected while draining"),
        }
        let completion = enter_runtime_admission(&state, "POST", "/api/production/steel-out")
            .expect("steel-out admission")
            .expect("steel-out should be counted in flight");
        assert_eq!(runtime_drain_status_json(&state)["inFlight"], json!(1));
        drop(completion);
        assert_eq!(runtime_drain_status_json(&state)["inFlight"], json!(0));
    }

    fn calibration_apply_operation_body(operation_id: &str) -> String {
        let mappings = (1..=CALIBRATION_SET_CAMERA_COUNT)
            .map(|index| {
                json!({
                    "ip": format!("192.0.2.{index}"),
                    "path": format!("camera-{index}.xml"),
                    "rollbackPath": format!("known-good-camera-{index}.xml"),
                    "expectedSn": format!("SN-{index}"),
                    "artifactType": "camera-sdk"
                })
            })
            .collect::<Vec<_>>();
        json!({
            "operationId": operation_id,
            "dryRun": false,
            "atomic": true,
            "rollbackOnFailure": true,
            "requireAllMapped": true,
            "stopStreams": true,
            "expectedCameras": CALIBRATION_SET_CAMERA_COUNT,
            "ips": mappings
                .iter()
                .filter_map(|mapping| mapping.get("ip").cloned())
                .collect::<Vec<_>>(),
            "cameraCalibrations": mappings,
            "persistActive": false,
            "saveCameraParams": false,
            "saveToDevice": false,
            "confirmation": CAMERA_CALIBRATION_SET_CONFIRMATION
        })
        .to_string()
    }

    fn mark_task_worker_healthy(state: &ServiceState) {
        let mut status = state
            .production_task_worker_status
            .lock()
            .expect("task worker status lock");
        status.running = true;
        status.current_task_id.clear();
        status.last_heartbeat_at = current_time_millis();
        status.last_error.clear();
    }

    fn spawn_health_http_server(
        status: &'static str,
        body: String,
        delay: Duration,
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("health test listener");
        let address = listener.local_addr().expect("health test address");
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("health probe connection");
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.as_bytes().len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        });
        (format!("http://{address}"), handle)
    }

    fn unused_local_http_origin() -> String {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("unused port listener");
        let address = listener.local_addr().expect("unused port address");
        drop(listener);
        format!("http://{address}")
    }

    #[test]
    fn layered_health_routes_are_explicit_and_get_only() {
        assert_eq!(
            health_endpoint_for_route("GET", "/api/health"),
            Some(HealthEndpoint::Compatibility)
        );
        assert_eq!(
            health_endpoint_for_route("GET", "/api/health/live"),
            Some(HealthEndpoint::Live)
        );
        assert_eq!(
            health_endpoint_for_route("GET", "/api/health/ready"),
            Some(HealthEndpoint::Ready)
        );
        assert_eq!(
            health_endpoint_for_route("GET", "/api/health/details"),
            Some(HealthEndpoint::Details)
        );
        assert_eq!(
            health_endpoint_for_route("GET", "/api/health/ready/details"),
            Some(HealthEndpoint::Details)
        );
        assert_eq!(health_endpoint_for_route("POST", "/api/health/ready"), None);
        assert_eq!(health_endpoint_for_route("GET", "/health"), None);
    }

    #[test]
    fn live_health_does_not_depend_on_database_worker_or_capture() {
        let state = production_test_state_with_provider(
            CaptureProvider::ExternalApi,
            "http://127.0.0.1:0/private-capture-origin",
        );
        state
            .runtime
            .block_on(state.database.connection.close_by_ref())
            .expect("test database should close");

        let response = response_text(service_health_response(&state, HealthEndpoint::Live));
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("\"status\":\"live\""));
        assert!(!response.contains("checks"));
        assert!(!response.contains("private-capture-origin"));
    }

    #[test]
    fn readiness_accepts_explicit_simulation_with_database_and_worker_ready() {
        let state = production_test_state();
        mark_task_worker_healthy(&state);

        let snapshot = service_health_snapshot(&state);
        assert!(snapshot.ready);
        assert_eq!(snapshot.body["checks"]["database"]["ok"], json!(true));
        assert_eq!(
            snapshot.body["checks"]["taskWorker"]["status"],
            json!("idle")
        );
        assert_eq!(
            snapshot.body["checks"]["capture"]["status"],
            json!("simulated")
        );

        let response = response_text(service_health_response(&state, HealthEndpoint::Ready));
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(!response.contains("simulated://capture"));
        assert!(!response.contains("lastError"));
        assert!(!response.contains("executable"));
    }

    #[test]
    fn readiness_rejects_a_stale_idle_worker_but_allows_a_busy_worker_boundary() {
        let state = production_test_state();
        {
            let mut status = state
                .production_task_worker_status
                .lock()
                .expect("task worker status lock");
            status.running = true;
            status.last_heartbeat_at =
                current_time_millis().saturating_sub(TASK_WORKER_IDLE_HEARTBEAT_MAX_AGE_MS + 1);
        }

        let stale = service_health_snapshot(&state);
        assert!(!stale.ready);
        assert_eq!(
            stale.body["checks"]["taskWorker"]["reason"],
            json!("task_worker_heartbeat_stale")
        );
        assert!(
            response_text(service_health_response(&state, HealthEndpoint::Ready))
                .starts_with("HTTP/1.1 503 Service Unavailable\r\n")
        );

        {
            let mut status = state
                .production_task_worker_status
                .lock()
                .expect("task worker status lock");
            status.current_task_id = "TASK-LONG-PROVIDER-CALL".to_string();
        }
        let busy = service_health_snapshot(&state);
        assert!(busy.ready);
        assert_eq!(busy.body["checks"]["taskWorker"]["status"], json!("busy"));
        assert_eq!(
            busy.body["checks"]["taskWorker"]["heartbeatPausedAtProviderBoundary"],
            json!(true)
        );
    }

    #[test]
    fn readiness_rejects_unreachable_non_simulated_capture_without_leaking_origin() {
        let state = production_test_state_with_provider(
            CaptureProvider::ExternalApi,
            "http://127.0.0.1:0/private-capture-origin",
        );
        mark_task_worker_healthy(&state);

        let snapshot = service_health_snapshot(&state);
        assert!(!snapshot.ready);
        assert_eq!(
            snapshot.body["checks"]["capture"]["reason"],
            json!("capture_provider_unreachable")
        );
        let response = response_text(service_health_response(&state, HealthEndpoint::Details));
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
        assert!(!response.contains("127.0.0.1"));
        assert!(!response.contains("private-capture-origin"));
    }

    #[test]
    fn capture_health_surfaces_provider_calibration_recovery_without_leaking_artifacts() {
        let body = json!({
            "service": "steel_capture_service",
            "sdkReady": false,
            "sdkCode": 423,
            "recoveryRequired": true,
            "invalidManifest": false,
            "pendingRecoveryCount": 1,
            "manifestPath": "C:\\classified\\calibration-rollbacks\\manifest.json"
        })
        .to_string();
        let (origin, server) = spawn_health_http_server("200 OK", body, Duration::ZERO);
        let state = production_test_state_with_provider(CaptureProvider::ExternalApi, &origin);
        let (ok, detail) = capture_health_component(&state);
        server.join().expect("capture recovery health server");
        assert!(!ok);
        assert_eq!(
            detail["reason"],
            json!("capture_calibration_recovery_required")
        );
        assert_eq!(detail["recoveryRequired"], json!(true));
        assert_eq!(detail["invalidManifest"], json!(false));
        assert_eq!(detail["pendingRecoveryCount"], json!(1));
        assert!(!detail.to_string().contains("classified"));
        assert!(!detail.to_string().contains("manifest.json"));
    }

    #[test]
    fn capture_health_rejects_hard_timeout_restart_requirement_even_with_stale_sdk_ready() {
        let body = json!({
            "service": "steel_capture_service",
            "ready": true,
            "sdkReady": true,
            "sdkCode": 49007,
            "recoveryRequired": false,
            "sdkCaptureState": {
                "poisoned": true,
                "restartRequired": true,
                "reason": "production capture worker exceeded hard timeout"
            }
        })
        .to_string();
        let (origin, server) = spawn_health_http_server("200 OK", body, Duration::ZERO);
        let state = production_test_state_with_provider(CaptureProvider::ExternalApi, &origin);
        let (ok, detail) = capture_health_component(&state);
        server
            .join()
            .expect("capture restart-required health server");
        assert!(!ok);
        assert_eq!(detail["reason"], json!("capture_sdk_restart_required"));
        assert_eq!(detail["restartRequired"], json!(true));
    }

    #[test]
    fn compatibility_health_rejects_a_database_that_cannot_be_queried() {
        let state = production_test_state();
        mark_task_worker_healthy(&state);
        state
            .runtime
            .block_on(state.database.connection.close_by_ref())
            .expect("test database should close");

        let response = service_health_response(&state, HealthEndpoint::Compatibility);
        let response_text = response_text(response.clone());
        assert!(response_text.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
        let body = response_json(response);
        assert_eq!(body["ok"], json!(false));
        assert_eq!(body["endpoint"], json!("compatibility"));
        assert_eq!(
            body["checks"]["database"]["reason"],
            json!("database_ping_failed")
        );
    }

    #[test]
    fn storage_health_is_simulated_explicitly_or_validates_root_and_queue_without_path_leaks() {
        let simulated = production_test_state();
        let (simulated_ok, simulated_detail) = storage_health_component(&simulated);
        assert!(simulated_ok);
        assert_eq!(simulated_detail["status"], json!("simulated"));
        assert_eq!(simulated_detail["level"], json!("simulated"));
        assert_eq!(simulated_detail["simulated"], json!(true));
        assert_eq!(simulated_detail["queueRequired"], json!(false));

        let provider_body = json!({
            "code": 0,
            "root": "C:\\classified-storage-root",
            "exists": true,
            "writable": true,
            "capacityAvailable": true,
            "capacityBytes": 1_000_000_000_000_u64,
            "freeBytes": 500_000_000_000_u64,
            "freePercent": 50.0,
            "cameraRoots": [
                {
                    "ip": "192.168.1.10",
                    "root": "C:\\classified-camera-root",
                    "exists": true,
                    "writable": true,
                    "capacityAvailable": true,
                    "capacityBytes": 1_000_000_000_000_u64,
                    "freeBytes": 400_000_000_000_u64,
                    "freePercent": 40.0
                }
            ],
            "queue": {
                "accepting": true,
                "pendingItems": 2,
                "capacityItems": 64,
                "recentWriteBytesPerSecond": 100_000_000.0
            }
        })
        .to_string();
        let (origin, server) = spawn_health_http_server("200 OK", provider_body, Duration::ZERO);
        let state = production_test_state_with_provider(CaptureProvider::ExternalApi, &origin);
        let (ok, detail) =
            storage_health_component_with_timeout(&state, Duration::from_millis(500));
        server.join().expect("storage health server");
        assert!(ok);
        assert_eq!(detail["status"], json!("up"));
        assert_eq!(detail["level"], json!("ok"));
        assert_eq!(detail["warningReason"], Value::Null);
        assert_eq!(detail["rootExists"], json!(true));
        assert_eq!(detail["rootWritable"], json!(true));
        assert_eq!(detail["queueAccepting"], json!(true));
        assert_eq!(detail["freeBytes"], json!(400_000_000_000_u64));
        assert_eq!(detail["freePercent"], json!(40.0));
        assert_eq!(detail["recentWriteBytesPerSecond"], json!(100_000_000.0));
        assert_eq!(detail["estimatedRemainingSeconds"], json!(4_000_u64));
        assert_eq!(detail["queuePendingItems"], json!(2));
        assert_eq!(detail["cameraRootCount"], json!(1));
        let detail_text = detail.to_string();
        assert!(!detail_text.contains("classified-storage-root"));
        assert!(!detail_text.contains("classified-camera-root"));
        assert!(!detail_text.contains("192.168.1.10"));
    }

    #[test]
    fn storage_health_rejects_missing_unwritable_or_non_accepting_storage_and_times_out() {
        for (exists, writable, accepting, expected_reason) in [
            (false, false, true, "storage_root_missing"),
            (true, false, true, "storage_root_not_writable"),
            (true, true, false, "storage_queue_not_accepting"),
        ] {
            let body = json!({
                "code": 0,
                "root": "D:\\must-not-leak",
                "exists": exists,
                "writable": writable,
                "capacityAvailable": true,
                "capacityBytes": 1_000_000_000_000_u64,
                "freeBytes": 500_000_000_000_u64,
                "freePercent": 50.0,
                "cameraRoots": [{
                    "ip": "192.168.1.10",
                    "root": "D:\\must-not-leak\\camera1",
                    "capacityAvailable": true,
                    "capacityBytes": 1_000_000_000_000_u64,
                    "freeBytes": 500_000_000_000_u64,
                    "freePercent": 50.0
                }],
                "queue": { "accepting": accepting, "pendingItems": 0, "capacityItems": 8 }
            })
            .to_string();
            let (origin, server) = spawn_health_http_server("200 OK", body, Duration::ZERO);
            let state = production_test_state_with_provider(CaptureProvider::ExternalApi, &origin);
            let (ok, detail) =
                storage_health_component_with_timeout(&state, Duration::from_millis(500));
            server.join().expect("storage health server");
            assert!(!ok);
            assert_eq!(detail["reason"], json!(expected_reason));
            assert!(!detail.to_string().contains("must-not-leak"));
        }

        let low_capacity_body = json!({
            "code": 0,
            "exists": true,
            "writable": true,
            "capacityAvailable": true,
            "capacityBytes": 100_000_000_000_u64,
            "freeBytes": 1_000_000_000_u64,
            "freePercent": 1.0,
            "cameraRoots": [{
                "capacityAvailable": true,
                "capacityBytes": 100_000_000_000_u64,
                "freeBytes": 900_000_000_u64,
                "freePercent": 0.9
            }],
            "queue": { "accepting": true }
        })
        .to_string();
        let (origin, server) =
            spawn_health_http_server("200 OK", low_capacity_body, Duration::ZERO);
        let state = production_test_state_with_provider(CaptureProvider::ExternalApi, &origin);
        let (ok, detail) =
            storage_health_component_with_timeout(&state, Duration::from_millis(500));
        server.join().expect("low capacity storage health server");
        assert!(!ok);
        assert_eq!(detail["reason"], json!("storage_capacity_below_watermark"));
        assert_eq!(detail["status"], json!("unavailable"));
        assert_eq!(detail["level"], json!("critical"));
        assert_eq!(detail["warningReason"], Value::Null);
        assert_eq!(detail["freeBytes"], json!(900_000_000_u64));
        assert_eq!(detail["freePercent"], json!(0.9));

        let body = json!({
            "code": 0,
            "root": "E:\\slow-secret-root",
            "exists": true,
            "writable": true,
            "capacityAvailable": true,
            "capacityBytes": 1_000_000_000_000_u64,
            "freeBytes": 500_000_000_000_u64,
            "freePercent": 50.0,
            "cameraRoots": [{
                "capacityAvailable": true,
                "capacityBytes": 1_000_000_000_000_u64,
                "freeBytes": 500_000_000_000_u64,
                "freePercent": 50.0
            }],
            "queue": { "accepting": true }
        })
        .to_string();
        let (origin, server) = spawn_health_http_server("200 OK", body, Duration::from_millis(150));
        let state = production_test_state_with_provider(CaptureProvider::ExternalApi, &origin);
        let started = Instant::now();
        let (ok, detail) = storage_health_component_with_timeout(&state, Duration::from_millis(30));
        assert!(!ok);
        assert!(started.elapsed() < Duration::from_millis(120));
        assert_eq!(detail["reason"], json!("storage_timeout"));
        assert!(!detail.to_string().contains("slow-secret-root"));
        server.join().expect("slow storage health server");
    }

    #[test]
    fn storage_health_warns_before_the_hard_admission_watermark() {
        let warning_body = json!({
            "code": 0,
            "exists": true,
            "writable": true,
            "capacityAvailable": true,
            "capacityBytes": 100_000_000_000_u64,
            "freeBytes": 30_000_000_000_u64,
            "freePercent": 12.0,
            "cameraRoots": [{
                "capacityAvailable": true,
                "capacityBytes": 100_000_000_000_u64,
                "freeBytes": 30_000_000_000_u64,
                "freePercent": 12.0
            }],
            "queue": {
                "accepting": true,
                "recentWriteBytesPerSecond": 100_000_000.0
            }
        })
        .to_string();
        let (origin, server) = spawn_health_http_server("200 OK", warning_body, Duration::ZERO);
        let state = production_test_state_with_provider(CaptureProvider::ExternalApi, &origin);
        let (ok, detail) =
            storage_health_component_with_timeout(&state, Duration::from_millis(500));
        server.join().expect("warning storage health server");
        assert!(
            ok,
            "warning capacity must not interrupt an active production path"
        );
        assert_eq!(detail["status"], json!("warning"));
        assert_eq!(detail["level"], json!("warning"));
        assert_eq!(
            detail["warningReason"],
            json!("storage_capacity_near_watermark")
        );
        assert_eq!(
            detail["warningFreeBytes"],
            json!(40_u64 * 1024 * 1024 * 1024)
        );
        assert_eq!(detail["warningFreePercent"], json!(15.0));
        assert_eq!(detail["estimatedRemainingSeconds"], json!(300_u64));
    }

    #[test]
    fn low_storage_blocks_only_new_session_admission_and_preserves_safe_completion() {
        let storage = json!({ "reason": "storage_capacity_below_watermark" });
        let rejected = new_session_storage_admission_response("steel-in", false, false, &storage)
            .expect("new steel-in should be rejected");
        let rejected_text = String::from_utf8(rejected).expect("response utf-8");
        assert!(rejected_text.starts_with("HTTP/1.1 503 Service Unavailable"));
        assert!(rejected_text.contains("storage_not_ready_for_new_session"));
        assert!(rejected_text.contains("storage_capacity_below_watermark"));

        assert!(
            new_session_storage_admission_response("steel-in", true, false, &storage).is_none()
        );
        assert!(
            new_session_storage_admission_response("steel-out", false, false, &storage).is_none()
        );
        assert!(
            new_session_storage_admission_response("steel-info", false, true, &storage).is_none()
        );
    }

    #[test]
    fn trigger_health_defaults_required_supports_explicit_optional_and_never_leaks_origin() {
        assert!(trigger_health_required_from_value(None));
        assert!(trigger_health_required_from_value(Some("1")));
        assert!(!trigger_health_required_from_value(Some("0")));
        assert!(!trigger_health_required_from_value(Some("false")));

        let body = json!({
            "code": 0,
            "service": "steel-trigger-gateway",
            "mode": "api",
            "inspectionServiceOrigin": "http://classified-inspection-origin:4873",
            "production": { "private": "must-not-be-forwarded" }
        })
        .to_string();
        let (origin, server) = spawn_health_http_server("200 OK", body, Duration::ZERO);
        let (required_ready, detail) =
            trigger_health_component_with_timeout(&origin, true, Duration::from_millis(500));
        server.join().expect("trigger health server");
        assert!(required_ready);
        assert_eq!(detail["ok"], json!(true));
        assert_eq!(detail["required"], json!(true));
        assert_eq!(detail["mode"], json!("api"));
        let detail_text = detail.to_string();
        assert!(!detail_text.contains("classified-inspection-origin"));
        assert!(!detail_text.contains("must-not-be-forwarded"));
        assert!(!detail_text.contains(&origin));

        let unreachable = unused_local_http_origin();
        let (required_ready, required_detail) =
            trigger_health_component_with_timeout(&unreachable, true, Duration::from_millis(100));
        assert!(!required_ready);
        assert_eq!(required_detail["required"], json!(true));
        assert_eq!(required_detail["readyContribution"], json!(false));
        assert!(!required_detail.to_string().contains(&unreachable));

        let (optional_ready, optional_detail) =
            trigger_health_component_with_timeout(&unreachable, false, Duration::from_millis(100));
        assert!(optional_ready);
        assert_eq!(optional_detail["ok"], json!(false));
        assert_eq!(optional_detail["status"], json!("optional-unavailable"));
        assert_eq!(optional_detail["readyContribution"], json!(true));
    }

    #[test]
    fn trigger_health_timeout_is_bounded_and_required_trigger_gates_service_readiness() {
        let body = json!({
            "code": 0,
            "service": "steel-trigger-gateway",
            "mode": "api"
        })
        .to_string();
        let (slow_origin, slow_server) =
            spawn_health_http_server("200 OK", body, Duration::from_millis(150));
        let started = Instant::now();
        let (ready, detail) =
            trigger_health_component_with_timeout(&slow_origin, true, Duration::from_millis(30));
        assert!(!ready);
        assert!(started.elapsed() < Duration::from_millis(120));
        assert_eq!(detail["reason"], json!("trigger_gateway_timeout"));
        assert!(!detail.to_string().contains(&slow_origin));
        slow_server.join().expect("slow trigger health server");

        let mut unavailable_state = production_test_state();
        mark_task_worker_healthy(&unavailable_state);
        unavailable_state.trigger_health_required = true;
        unavailable_state.trigger_gateway_origin = unused_local_http_origin();
        let unavailable = service_health_snapshot(&unavailable_state);
        assert!(!unavailable.ready);
        assert_eq!(
            unavailable.body["checks"]["storage"]["status"],
            json!("simulated")
        );
        assert_eq!(
            unavailable.body["checks"]["trigger"]["required"],
            json!(true)
        );

        let body = json!({
            "code": 0,
            "service": "steel-trigger-gateway",
            "mode": "manual"
        })
        .to_string();
        let (origin, server) = spawn_health_http_server("200 OK", body, Duration::ZERO);
        let mut available_state = production_test_state();
        mark_task_worker_healthy(&available_state);
        available_state.trigger_health_required = true;
        available_state.trigger_gateway_origin = origin;
        let available = service_health_snapshot(&available_state);
        server.join().expect("required trigger health server");
        assert!(available.ready);
        assert_eq!(available.body["checks"]["trigger"]["status"], json!("up"));
    }

    fn install_failing_insert_trigger(state: &ServiceState, table: &str) {
        let sql = format!(
            "CREATE TRIGGER fail_{table}_insert BEFORE INSERT ON {table} \
             BEGIN SELECT RAISE(FAIL, 'forced {table} persistence failure'); END"
        );
        state
            .runtime
            .block_on(
                state
                    .database
                    .connection
                    .execute(Statement::from_string(DbBackend::Sqlite, sql)),
            )
            .expect("failing insert trigger should install");
    }

    fn insert_production_record(
        state: &ServiceState,
        inspection_id: &str,
        material_id: &str,
        session_id: &str,
        session_status: &str,
        inspection_status: &str,
        finished_at: &str,
    ) {
        state
            .runtime
            .block_on(db::upsert_material_session(
                &state.database.connection,
                db::MaterialSessionInput {
                    id: session_id.to_string(),
                    material_id: material_id.to_string(),
                    source: "test".to_string(),
                    status: session_status.to_string(),
                    control_mode: "manual".to_string(),
                    trigger_mode: "manual".to_string(),
                    steel_type: "round-bar".to_string(),
                    width_mm: 120.0,
                    length_mm: 6000.0,
                    thickness_mm: 12.0,
                    client: "test".to_string(),
                    hard: "Q355".to_string(),
                    storage_root: "H:\\".to_string(),
                    started_at: "1".to_string(),
                    finished_at: finished_at.to_string(),
                    raw_payload: "{}".to_string(),
                },
            ))
            .expect("material session insert");
        state
            .runtime
            .block_on(db::upsert_production_inspection(
                &state.database.connection,
                db::ProductionInspectionInput {
                    id: inspection_id.to_string(),
                    material_id: material_id.to_string(),
                    session_id: session_id.to_string(),
                    status: inspection_status.to_string(),
                    storage_root: "H:\\".to_string(),
                    summary_path: format!("H:\\production\\{inspection_id}.json"),
                    started_at: "1".to_string(),
                    finished_at: finished_at.to_string(),
                    capture_count: 6,
                    defect_count: 0,
                    raw_payload: "{}".to_string(),
                },
            ))
            .expect("production inspection insert");
    }

    #[test]
    fn capture_config_reads_require_admin_config_permission() {
        for (method, path) in [
            ("GET", "/api/config"),
            ("GET", "/api/config/capture"),
            ("GET", "/api/config/status"),
            ("GET", "/api/config/profiles"),
            ("GET", "/api/config/profile"),
            ("GET", "/api/storage/status"),
            ("GET", "/api/param"),
            ("GET", "/api/calibration/active"),
            ("GET", "/api/calibration/status"),
            ("GET", "/api/calibration/operations/detail"),
            ("POST", "/api/config/capture"),
            ("POST", "/api/storage/config"),
            ("POST", "/api/storage/camera-roots"),
            ("POST", "/api/config/profile/save"),
            ("POST", "/api/config/profile/apply"),
            ("POST", "/api/config/profile/import"),
            ("POST", "/api/config/camera-params/save-all"),
            ("POST", "/api/config/camera-params/load-all"),
            ("POST", "/api/cameras/connect-all"),
            ("POST", "/api/camera/connect"),
            ("POST", "/api/camera/disconnect"),
            ("POST", "/api/param/load-file"),
            ("POST", "/api/param/recovery"),
            ("POST", "/api/param"),
            ("POST", "/api/capture/continuous-test"),
            ("POST", "/api/capture/preset/line-continuous"),
            ("POST", "/api/calibration/active"),
            ("POST", "/api/calibration/apply-all"),
            ("POST", "/api/calibration/rollback"),
            ("POST", "/api/roi/load"),
        ] {
            assert_eq!(
                permission_for_route(method, path),
                Some("admin.config"),
                "capture configuration route must be protected: {method} {path}"
            );
        }
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
            permission_for_route("GET", "/api/admin/records/cleanup"),
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
            permission_for_route("POST", "/api/admin/records/cleanup/retry"),
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
    fn sqlite_database_backup_uses_a_valid_online_snapshot() {
        let root = env::temp_dir().join(format!(
            "steel-sqlite-backup-test-{}",
            db::now_millis_string()
        ));
        fs::create_dir_all(&root).expect("backup test root");
        let database_path = root.join("steel-inspection.sqlite");
        let runtime = Runtime::new().expect("test runtime");
        let database = runtime
            .block_on(db::open_database(database_path.clone()))
            .expect("file sqlite database");
        let state = production_test_state_with_database(
            runtime,
            database,
            CaptureProvider::Simulated,
            "simulated://capture",
        );

        let response = database_backup_response(&state, "backup-test");
        assert!(response.starts_with(b"HTTP/1.1 200 OK\r\n"));
        let separator = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("HTTP body separator");
        assert!(response[separator + 4..].starts_with(b"SQLite format 3\0"));
        assert!(database_path.is_file());
        assert_eq!(
            fs::read_dir(&root)
                .expect("backup directory")
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().starts_with(".steel-"))
                .count(),
            0
        );

        drop(state);
        let _ = fs::remove_dir_all(root);
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
            must_change_password: false,
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
            record_retention_detail(365, "2025-07-02 10:00:00", 4, 0, 0, 0, 8, 0, 0, 0, 0, true),
            "预览检测记录保留策略：保留 365 天，截止 2025-07-02 10:00:00，可清理 4 条记录，计划物理文件 8 个，规划失败 0 条"
        );
        assert_eq!(
            record_retention_detail(365, "2025-07-02 10:00:00", 4, 4, 12, 4, 8, 7, 1, 4096, 1, false),
            "执行检测记录保留策略：保留 365 天，截止 2025-07-02 10:00:00，清理生产记录 4 / 4 条，物理文件 7 / 8 个，缺失 1 个，删除字节 4096，失败 1 条，缺陷 12 条，采集文件索引 4 条；生产会话保留"
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
            CaptureProvider::from_env_value("external-api"),
            CaptureProvider::ExternalApi
        );
        assert_eq!(
            CaptureProvider::from_env_value("simulated"),
            CaptureProvider::Simulated
        );
    }

    #[test]
    fn latest_capture_metadata_is_read_through_the_rust_proxy() {
        assert!(is_capture_json_proxy_route("GET", "/api/capture/logs"));
        assert!(is_capture_json_proxy_route("GET", "/api/capture/latest"));
        assert!(!is_capture_json_proxy_route("POST", "/api/capture/latest"));
        assert!(!is_capture_json_proxy_route("GET", "/api/capture/file"));
        assert!(is_capture_json_proxy_route("POST", "/api/stream/start"));
        assert!(is_capture_json_proxy_route(
            "POST",
            "/api/steel/capture-mode"
        ));
        assert!(is_capture_json_proxy_route("GET", "/api/stream/status"));
        assert!(is_capture_binary_proxy_route("GET", "/api/stream/latest"));
        assert!(is_capture_json_proxy_route(
            "POST",
            "/api/capture/preset/line-continuous"
        ));
        assert!(is_capture_json_proxy_route(
            "POST",
            "/api/capture/continuous-settings"
        ));
        assert!(is_capture_json_proxy_route(
            "GET",
            "/api/capture/continuous-settings"
        ));
    }

    #[test]
    fn simulated_capture_mode_is_retained_in_provider_status() {
        let state = production_test_state();
        let changed: Value = serde_json::from_slice(
            &state
                .capture
                .simulated_proxy(
                    "POST",
                    "/api/steel/capture-mode",
                    r#"{"captureMode":"on-demand"}"#,
                )
                .expect("simulated capture mode response"),
        )
        .expect("simulated capture mode is json");
        assert_eq!(changed["code"], 0);
        assert_eq!(changed["captureMode"], "on-demand");
        assert_eq!(changed["automaticCaptureEnabled"], false);

        let status: Value = serde_json::from_slice(
            &state
                .capture
                .simulated_proxy("GET", "/api/steel/status", "")
                .expect("simulated steel status"),
        )
        .expect("simulated steel status is json");
        assert_eq!(status["captureMode"], "on-demand");
        assert_eq!(status["automaticCaptureEnabled"], false);
    }

    #[test]
    fn simulated_continuous_line_rate_requires_explicit_runtime_apply() {
        let state = production_test_state();
        let dry_run: Value = serde_json::from_slice(
            &state
                .capture
                .simulated_proxy(
                    "POST",
                    "/api/capture/continuous-settings",
                    r#"{"timeTriggerFreq":480}"#,
                )
                .expect("simulated continuous settings dry-run"),
        )
        .expect("simulated continuous settings dry-run is json");
        assert_eq!(dry_run["code"], 0);
        assert_eq!(dry_run["timeTriggerFreq"], 300.0);
        assert_eq!(dry_run["applied"], 0);

        let applied: Value = serde_json::from_slice(
            &state
                .capture
                .simulated_proxy(
                    "POST",
                    "/api/capture/continuous-settings",
                    r#"{"timeTriggerFreq":480,"applyToDevice":true}"#,
                )
                .expect("simulated continuous settings apply"),
        )
        .expect("simulated continuous settings apply is json");
        assert_eq!(applied["code"], 0);
        assert_eq!(applied["timeTriggerFreq"], 480.0);
        assert_eq!(applied["applied"], CAPTURE_CAMERA_IPS.len());

        let invalid = validate_capture_device_mutation_request(
            "/api/capture/continuous-settings",
            r#"{"timeTriggerFreq":0}"#,
        );
        assert_eq!(invalid, Err("continuous_line_rate_out_of_range"));
    }

    #[test]
    fn dangerous_line_preset_requires_exact_confirmations_and_bounded_values() {
        assert_eq!(
            validate_line_continuous_preset_request(
                r#"{"lines":1000,"timeTriggerFreq":300,"laserPower":100}"#
            ),
            Err("line_preset_confirmation_required")
        );
        assert_eq!(
            validate_line_continuous_preset_request(&format!(
                r#"{{"confirmation":"{}","lines":0}}"#,
                LINE_CONTINUOUS_PRESET_CONFIRMATION
            )),
            Err("line_preset_parameter_out_of_range")
        );
        assert_eq!(
            validate_line_continuous_preset_request(&format!(
                r#"{{"confirmation":"{}","saveToDevice":true}}"#,
                LINE_CONTINUOUS_PRESET_CONFIRMATION
            )),
            Err("line_preset_device_confirmation_required")
        );
        assert!(validate_line_continuous_preset_request(&format!(
            r#"{{"confirmation":"{}","deviceConfirmation":"{}","lines":1000,"timeTriggerFreq":300,"laserPower":100,"laserLineSelect":0,"controlMode":0,"saveToDevice":true}}"#,
            LINE_CONTINUOUS_PRESET_CONFIRMATION,
            LINE_CONTINUOUS_DEVICE_PERSIST_CONFIRMATION
        ))
        .is_ok());
    }

    #[test]
    fn capture_device_mutations_enforce_server_side_typed_confirmations() {
        assert!(validate_capture_device_mutation_request(
            "/api/param",
            r#"{"ip":"192.0.2.1","key":"ExposureTime","value":100}"#
        )
        .is_ok());
        assert_eq!(
            validate_capture_device_mutation_request(
                "/api/param",
                r#"{"ip":"192.0.2.1","key":"UndocumentedVendorKey","value":1}"#
            ),
            Err("sdk_parameter_write_confirmation_required")
        );
        assert!(validate_capture_device_mutation_request(
            "/api/param",
            &format!(
                r#"{{"ip":"192.0.2.1","key":"UndocumentedVendorKey","value":1,"confirmation":"{}"}}"#,
                SDK_PARAMETER_WRITE_CONFIRMATION
            )
        )
        .is_ok());
        assert_eq!(
            validate_capture_device_mutation_request(
                "/api/calibration/load",
                r#"{"ip":"192.0.2.1","path":"camera.xml"}"#
            ),
            Err("camera_calibration_confirmation_required")
        );
        assert!(validate_capture_device_mutation_request(
            "/api/calibration/load",
            r#"{"ip":"192.0.2.1","path":"camera.xml","dryRun":true}"#
        )
        .is_ok());
        let mappings = (1..=CALIBRATION_SET_CAMERA_COUNT)
            .map(|index| {
                json!({
                    "ip": format!("192.0.2.{index}"),
                    "path": format!("camera-{index}.xml"),
                    "rollbackPath": format!("known-good-camera-{index}.xml"),
                    "expectedSn": format!("SN-{index}"),
                    "artifactType": "camera-sdk"
                })
            })
            .collect::<Vec<_>>();
        let safe_preflight = json!({
            "dryRun": true,
            "atomic": true,
            "rollbackOnFailure": true,
            "requireAllMapped": true,
            "stopStreams": true,
            "expectedCameras": CALIBRATION_SET_CAMERA_COUNT,
            "ips": mappings.iter().filter_map(|item| item.get("ip").cloned()).collect::<Vec<_>>(),
            "cameraCalibrations": mappings,
            "persistActive": false,
            "saveCameraParams": false,
            "saveToDevice": false
        });
        assert!(validate_capture_device_mutation_request(
            "/api/calibration/apply-all",
            &safe_preflight.to_string()
        )
        .is_ok());
        let mut unsafe_partial = safe_preflight.clone();
        unsafe_partial["atomic"] = json!(false);
        assert_eq!(
            validate_capture_device_mutation_request(
                "/api/calibration/apply-all",
                &unsafe_partial.to_string()
            ),
            Err("calibration_set_safe_mode_required")
        );
        let mut missing_serial = safe_preflight.clone();
        missing_serial["cameraCalibrations"][0]["expectedSn"] = json!("");
        assert_eq!(
            validate_capture_device_mutation_request(
                "/api/calibration/apply-all",
                &missing_serial.to_string()
            ),
            Err("calibration_set_serial_required")
        );
        let mut missing_rollback = safe_preflight.clone();
        missing_rollback["cameraCalibrations"][0]["rollbackPath"] = json!("");
        assert_eq!(
            validate_capture_device_mutation_request(
                "/api/calibration/apply-all",
                &missing_rollback.to_string()
            ),
            Err("calibration_set_durable_rollback_path_required")
        );
        let mut duplicate_serial = safe_preflight.clone();
        let first_serial = duplicate_serial["cameraCalibrations"][0]["expectedSn"].clone();
        duplicate_serial["cameraCalibrations"][1]["expectedSn"] = first_serial;
        assert_eq!(
            validate_capture_device_mutation_request(
                "/api/calibration/apply-all",
                &duplicate_serial.to_string()
            ),
            Err("calibration_set_duplicate_serial")
        );
        let mut duplicate_artifact = safe_preflight.clone();
        let first_path = duplicate_artifact["cameraCalibrations"][0]["path"].clone();
        duplicate_artifact["cameraCalibrations"][1]["path"] = first_path;
        assert_eq!(
            validate_capture_device_mutation_request(
                "/api/calibration/apply-all",
                &duplicate_artifact.to_string()
            ),
            Err("calibration_set_duplicate_artifact")
        );
        let mut real_apply = safe_preflight.clone();
        real_apply["dryRun"] = json!(false);
        assert_eq!(
            validate_capture_device_mutation_request(
                "/api/calibration/apply-all",
                &real_apply.to_string()
            ),
            Err("camera_calibration_set_confirmation_required")
        );
        real_apply["confirmation"] = json!(CAMERA_CALIBRATION_SET_CONFIRMATION);
        assert!(validate_capture_device_mutation_request(
            "/api/calibration/apply-all",
            &real_apply.to_string()
        )
        .is_ok());
        assert_eq!(
            validate_capture_device_mutation_request(
                "/api/calibration/rollback",
                r#"{"rollbackToken":"calrb-test"}"#
            ),
            Err("camera_calibration_rollback_confirmation_required")
        );
        assert_eq!(
            validate_capture_device_mutation_request(
                "/api/calibration/rollback",
                &json!({
                    "operationId": "rollback-test",
                    "rollbackToken": "calrb-test",
                    "confirmation": CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION
                })
                .to_string()
            ),
            Err("calibration_rollback_apply_operation_id_required")
        );
        assert_eq!(
            validate_capture_device_mutation_request(
                "/api/roi/load",
                r#"{"ip":"192.0.2.1","path":"camera.roi"}"#
            ),
            Err("camera_roi_confirmation_required")
        );
        assert_eq!(
            validate_capture_device_mutation_request(
                "/api/config/camera-params/save-all",
                r#"{"saveToDevice":true}"#
            ),
            Err("camera_device_persist_confirmation_required")
        );
        assert!(validate_capture_device_mutation_request(
            "/api/config/camera-params/save-all",
            &format!(
                r#"{{"saveToDevice":true,"deviceConfirmation":"{}"}}"#,
                CAMERA_DEVICE_PERSIST_CONFIRMATION
            )
        )
        .is_ok());
    }

    #[test]
    fn migrated_operator_workflows_have_explicit_rust_proxy_routes() {
        let json_routes = [
            ("GET", "/api/storage/status"),
            ("POST", "/api/storage/config"),
            ("GET", "/api/config/profiles"),
            ("POST", "/api/config/profile/apply"),
            ("POST", "/api/config/camera-params/save-all"),
            ("POST", "/api/config/camera-params/load-all"),
            ("POST", "/api/cameras/connect-all"),
            ("POST", "/api/param/load-file"),
            ("POST", "/api/param/save-file"),
            ("POST", "/api/param/recovery"),
            ("POST", "/api/capture/continuous-test"),
            ("POST", "/api/capture/preset/line-continuous"),
            ("POST", "/api/stream/start"),
            ("POST", "/api/stream/stop"),
            ("GET", "/api/stream/status"),
            ("GET", "/api/calibration/active"),
            ("POST", "/api/calibration/active"),
            ("POST", "/api/calibration/apply-all"),
            ("POST", "/api/calibration/rollback"),
            ("GET", "/api/calibration/status"),
            ("POST", "/api/roi/load"),
        ];
        for (method, path) in json_routes {
            assert!(
                is_capture_json_proxy_route(method, path),
                "missing capture proxy route {method} {path}"
            );
        }
        assert!(is_capture_binary_proxy_route("GET", "/api/stream/latest"));
    }

    #[test]
    fn capture_proxy_allowlist_is_fully_reflected_in_the_api_manifest() {
        let mut routes = Vec::new();
        append_capture_proxy_manifest_routes(&mut routes);
        assert_eq!(
            routes.len(),
            CAPTURE_JSON_PROXY_ROUTES.len() + CAPTURE_BINARY_PROXY_ROUTES.len()
        );
        for (method, path) in CAPTURE_JSON_PROXY_ROUTES
            .iter()
            .chain(CAPTURE_BINARY_PROXY_ROUTES.iter())
        {
            assert!(
                routes.iter().any(|route| {
                    route.get("method").and_then(Value::as_str) == Some(*method)
                        && route.get("path").and_then(Value::as_str) == Some(*path)
                        && route.get("scope").and_then(Value::as_str) == Some("capture")
                }),
                "capture proxy route missing from manifest: {method} {path}"
            );
        }
    }

    #[test]
    fn calibration_operation_ledger_replays_terminal_response_and_rejects_conflicts() {
        let state = production_test_state();
        let body = calibration_apply_operation_body("cal-op-idempotent-001");
        let dispatches = std::sync::atomic::AtomicUsize::new(0);
        let provider_body = br#"{"code":0,"applied":6,"failed":0}"#.to_vec();

        let first = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/apply-all",
            &body,
            "admin-a",
            |_| {
                dispatches.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Some(CaptureProxyResponse {
                    status_code: 200,
                    content_type: "application/json; charset=utf-8".to_string(),
                    body: provider_body.clone(),
                })
            },
        );
        assert!(response_text(first).starts_with("HTTP/1.1 200 OK"));

        let stored = state
            .runtime
            .block_on(db::find_calibration_operation(
                &state.database.connection,
                "cal-op-idempotent-001",
            ))
            .expect("operation lookup")
            .expect("stored operation");
        assert_eq!(stored.status, "succeeded");
        assert_eq!(stored.actor, "admin-a");
        assert!(!stored.request_hash.is_empty());
        assert_eq!(stored.provider_http_status, 200);

        let replay = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/apply-all",
            &body,
            "admin-b",
            |_| panic!("a completed operation must not be dispatched again"),
        );
        assert_eq!(
            response_json(replay),
            serde_json::from_slice::<Value>(&provider_body).expect("provider JSON")
        );

        let mut conflicting = serde_json::from_str::<Value>(&body).expect("request JSON");
        conflicting["version"] = json!("different-request");
        let conflict = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/apply-all",
            &conflicting.to_string(),
            "admin-b",
            |_| panic!("an operationId conflict must not be dispatched"),
        );
        let conflict = response_json(conflict);
        assert_eq!(conflict["code"], 409);
        assert_eq!(conflict["error"], "calibration_operation_id_conflict");
        assert_eq!(dispatches.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn calibration_operation_same_id_is_single_flight_while_dispatching() {
        let state = Arc::new(production_test_state());
        let body = calibration_apply_operation_body("cal-op-concurrent-001");
        let dispatches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();

        let first_state = Arc::clone(&state);
        let first_body = body.clone();
        let first_dispatches = Arc::clone(&dispatches);
        let first = std::thread::spawn(move || {
            calibration_operations::mutation_response_with_dispatch(
                &first_state,
                "/api/calibration/apply-all",
                &first_body,
                "admin-a",
                |_| {
                    first_dispatches.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    started_sender.send(()).expect("signal dispatch start");
                    release_receiver
                        .recv_timeout(Duration::from_secs(3))
                        .expect("release first dispatch");
                    Some(CaptureProxyResponse {
                        status_code: 200,
                        content_type: "application/json".to_string(),
                        body: br#"{"code":0,"applied":6}"#.to_vec(),
                    })
                },
            )
        });
        started_receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("first operation should enter dispatch");

        let current = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/apply-all",
            &body,
            "admin-b",
            |_| {
                dispatches.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                None
            },
        );
        let current_text = response_text(current.clone());
        assert!(current_text.starts_with("HTTP/1.1 202 Accepted"));
        let current = response_json(current);
        assert_eq!(current["status"], "dispatching");
        assert_eq!(current["replayed"], true);
        assert_eq!(current["needsReconciliation"], false);
        assert_eq!(dispatches.load(std::sync::atomic::Ordering::SeqCst), 1);

        release_sender.send(()).expect("release first operation");
        let first = first.join().expect("first operation thread");
        assert!(response_text(first).starts_with("HTTP/1.1 200 OK"));
    }

    #[test]
    fn calibration_operation_rejects_a_different_id_instead_of_queueing() {
        let state = Arc::new(production_test_state());
        let first_body = calibration_apply_operation_body("cal-op-fence-001");
        let second_body = calibration_apply_operation_body("cal-op-fence-002");
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();

        let first_state = Arc::clone(&state);
        let first = std::thread::spawn(move || {
            calibration_operations::mutation_response_with_dispatch(
                &first_state,
                "/api/calibration/apply-all",
                &first_body,
                "admin-a",
                |_| {
                    started_sender.send(()).expect("signal dispatch start");
                    release_receiver
                        .recv_timeout(Duration::from_secs(3))
                        .expect("release first dispatch");
                    Some(CaptureProxyResponse {
                        status_code: 200,
                        content_type: "application/json".to_string(),
                        body: br#"{"code":0,"applied":6}"#.to_vec(),
                    })
                },
            )
        });
        started_receiver
            .recv_timeout(Duration::from_secs(3))
            .expect("first operation should enter dispatch");

        let second = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/apply-all",
            &second_body,
            "admin-b",
            |_| panic!("a distinct operation must not queue behind an active SDK mutation"),
        );
        let second_text = response_text(second.clone());
        assert!(second_text.starts_with("HTTP/1.1 409 Conflict"));
        let second = response_json(second);
        assert_eq!(second["error"], "calibration_operation_in_progress");
        assert_eq!(second["operationId"], "cal-op-fence-002");
        assert_eq!(second["retryable"], true);
        assert!(state
            .runtime
            .block_on(db::find_calibration_operation(
                &state.database.connection,
                "cal-op-fence-002",
            ))
            .expect("second operation lookup")
            .is_none());

        release_sender.send(()).expect("release first operation");
        let first = first.join().expect("first operation thread");
        assert!(response_text(first).starts_with("HTTP/1.1 200 OK"));
    }

    #[test]
    fn calibration_apply_rejects_duplicate_json_keys_before_provider_dispatch() {
        let state = production_test_state();
        let response = calibration_operations::apply_response(
            &state,
            r#"{"dryRun":false,"dryRun":true}"#,
            "admin-a",
        );
        let response_text_value = response_text(response.clone());
        assert!(response_text_value.starts_with("HTTP/1.1 400 Bad Request"));
        assert_eq!(
            response_json(response)["error"],
            "invalid_or_duplicate_calibration_operation_json"
        );
    }

    #[test]
    fn calibration_operation_unavailable_provider_is_persisted_for_reconciliation() {
        let state = production_test_state();
        let body = calibration_apply_operation_body("cal-op-unknown-001");
        let response = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/apply-all",
            &body,
            "admin-reconciler",
            |_| None,
        );
        let response_text_value = response_text(response.clone());
        assert!(response_text_value.starts_with("HTTP/1.1 409 Conflict"));
        let response = response_json(response);
        assert_eq!(response["status"], "needs-reconciliation");
        assert_eq!(response["needsReconciliation"], true);
        assert_eq!(response["error"], "capture_provider_timeout_or_unavailable");

        let replay = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/apply-all",
            &body,
            "admin-other",
            |_| panic!("an uncertain operation must never be replayed automatically"),
        );
        let replay = response_json(replay);
        assert_eq!(replay["status"], "needs-reconciliation");
        assert_eq!(replay["replayed"], true);

        let detail = calibration_operations::detail_response(&state, "id=cal-op-unknown-001");
        let detail = response_json(detail);
        assert_eq!(detail["operationId"], "cal-op-unknown-001");
        assert_eq!(detail["actor"], "admin-reconciler");
        assert_eq!(detail["needsReconciliation"], true);
    }

    #[test]
    fn unresolved_calibration_operation_fences_device_writes_until_parent_bound_rollback() {
        let state = production_test_state();
        let parent_id = "cal-op-parent-unknown-001";
        let parent_body = calibration_apply_operation_body(parent_id);
        let uncertain = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/apply-all",
            &parent_body,
            "admin-original",
            |_| None,
        );
        assert_eq!(response_json(uncertain)["status"], "needs-reconciliation");

        let blocked_id = "cal-op-blocked-apply-001";
        let blocked = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/apply-all",
            &calibration_apply_operation_body(blocked_id),
            "admin-blocked",
            |_| panic!("a fenced calibration apply must not reach the provider"),
        );
        let blocked_text = response_text(blocked.clone());
        assert!(blocked_text.starts_with("HTTP/1.1 423 Locked"));
        let blocked = response_json(blocked);
        assert_eq!(blocked["error"], "calibration_reconciliation_required");
        assert_eq!(blocked["operationId"], blocked_id);
        assert_eq!(blocked["unresolvedOperations"][0]["operationId"], parent_id);

        for path in [
            "/api/calibration/load",
            "/api/roi/load",
            "/api/calibration/active",
            "/api/config/profile/save",
            "/api/config/profile/import",
            "/api/config/profile/apply",
            "/api/config/camera-params/save-all",
            "/api/config/camera-params/load-all",
            "/api/param",
            "/api/param/save-device",
            "/api/param/save-to-device",
            "/api/param/load-file",
            "/api/param/recovery",
            "/api/capture/preset/line-continuous",
        ] {
            assert!(
                calibration_operations::mutation_requires_reconciliation_fence("POST", path),
                "device mutation must be fenced: {path}"
            );
        }
        let generic_fence =
            calibration_operations::reconciliation_fence_response(&state, "/api/param")
                .expect("unresolved operation must fence generic device mutations");
        let generic_fence_text = response_text(generic_fence.clone());
        assert!(generic_fence_text.starts_with("HTTP/1.1 423 Locked"));
        let generic_fence = response_json(generic_fence);
        assert_eq!(generic_fence["requestTarget"], "/api/param");
        assert!(generic_fence.get("operationId").is_none());

        let rollback_id = "cal-op-parent-rollback-001";
        let rollback_body = json!({
            "operationId": rollback_id,
            "parentOperationId": parent_id,
            "applyOperationId": parent_id,
            "rollbackToken": "calrb-parent-001",
            "confirmation": CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION
        })
        .to_string();
        let rollback = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/rollback",
            &rollback_body,
            "admin-reconciler",
            |_| {
                Some(CaptureProxyResponse {
                    status_code: 200,
                    content_type: "application/json; charset=utf-8".to_string(),
                    body: json!({
                        "code": 0,
                        "complete": true,
                        "applyOperationId": parent_id,
                        "rolledBack": 6,
                        "failed": 0
                    })
                    .to_string()
                    .into_bytes(),
                })
            },
        );
        assert!(response_text(rollback).starts_with("HTTP/1.1 200 OK"));

        let parent = state
            .runtime
            .block_on(db::find_calibration_operation(
                &state.database.connection,
                parent_id,
            ))
            .expect("parent operation lookup")
            .expect("parent operation");
        assert_eq!(parent.status, "reconciled");
        assert_eq!(parent.reconciliation_outcome, "restored-to-staged-baseline");
        assert_eq!(parent.reconciliation_id, rollback_id);
        assert_eq!(parent.resolved_by, "admin-reconciler");
        assert!(!parent.resolved_at.is_empty());
        assert_eq!(parent.row_version, 3);
        assert!(
            calibration_operations::reconciliation_fence_response(&state, "/api/param").is_none()
        );

        let after_reconciliation = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/apply-all",
            &calibration_apply_operation_body("cal-op-after-reconcile-001"),
            "admin-next",
            |_| {
                Some(CaptureProxyResponse {
                    status_code: 200,
                    content_type: "application/json".to_string(),
                    body: br#"{"code":0,"applied":6,"failed":0}"#.to_vec(),
                })
            },
        );
        assert!(response_text(after_reconciliation).starts_with("HTTP/1.1 200 OK"));
    }

    #[test]
    fn rollback_parent_mismatch_keeps_reconciliation_fence_closed() {
        let state = production_test_state();
        let parent_id = "cal-op-parent-mismatch-001";
        let uncertain = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/apply-all",
            &calibration_apply_operation_body(parent_id),
            "admin-original",
            |_| None,
        );
        assert_eq!(response_json(uncertain)["status"], "needs-reconciliation");

        let rollback = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/rollback",
            &json!({
                "operationId": "cal-op-mismatch-rollback-001",
                "parentOperationId": parent_id,
                "applyOperationId": parent_id,
                "rollbackToken": "calrb-parent-mismatch-001",
                "confirmation": CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION
            })
            .to_string(),
            "admin-reconciler",
            |_| {
                Some(CaptureProxyResponse {
                    status_code: 200,
                    content_type: "application/json".to_string(),
                    body: br#"{"code":0,"complete":true,"applyOperationId":"different-parent"}"#
                        .to_vec(),
                })
            },
        );
        let rollback_text = response_text(rollback.clone());
        assert!(rollback_text.starts_with("HTTP/1.1 409 Conflict"));
        assert_eq!(
            response_json(rollback)["error"],
            "calibration_reconciliation_parent_mismatch"
        );
        let parent = state
            .runtime
            .block_on(db::find_calibration_operation(
                &state.database.connection,
                parent_id,
            ))
            .expect("parent lookup")
            .expect("parent operation");
        assert_eq!(parent.status, "needs-reconciliation");
        assert!(
            calibration_operations::reconciliation_fence_response(&state, "/api/param").is_some()
        );
        let (ready, reconciliation) = calibration_reconciliation_health_component(&state);
        assert!(!ready);
        assert_eq!(reconciliation["status"], "reconciliation-required");
        assert_eq!(reconciliation["unresolvedCount"], 1);
        assert_eq!(
            reconciliation["unresolvedOperations"][0]["operationId"],
            parent_id
        );
    }

    #[test]
    fn interrupted_rollback_reconciles_against_its_original_apply_operation() {
        let state = production_test_state();
        let apply_id = "cal-op-before-interrupted-rollback-001";
        let apply = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/apply-all",
            &calibration_apply_operation_body(apply_id),
            "admin-apply",
            |_| {
                Some(CaptureProxyResponse {
                    status_code: 200,
                    content_type: "application/json".to_string(),
                    body: json!({
                        "code": 0,
                        "operationId": apply_id,
                        "applied": 6,
                        "failed": 0,
                        "rollbackToken": "calrb-interrupted-rollback-001"
                    })
                    .to_string()
                    .into_bytes(),
                })
            },
        );
        assert!(response_text(apply).starts_with("HTTP/1.1 200 OK"));

        let interrupted_rollback_id = "cal-op-interrupted-rollback-001";
        let interrupted = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/rollback",
            &json!({
                "operationId": interrupted_rollback_id,
                "applyOperationId": apply_id,
                "rollbackToken": "calrb-interrupted-rollback-001",
                "confirmation": CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION
            })
            .to_string(),
            "admin-first-rollback",
            |_| None,
        );
        assert_eq!(response_json(interrupted)["status"], "needs-reconciliation");

        let fenced = calibration_operations::reconciliation_fence_response(&state, "/api/param")
            .expect("interrupted rollback must close the fence");
        let fenced = response_json(fenced);
        assert_eq!(
            fenced["unresolvedOperations"][0]["operationId"],
            interrupted_rollback_id
        );
        assert_eq!(
            fenced["unresolvedOperations"][0]["expectedApplyOperationId"],
            apply_id
        );

        let recovery_id = "cal-op-interrupted-rollback-recovery-001";
        let recovery = calibration_operations::mutation_response_with_dispatch(
            &state,
            "/api/calibration/rollback",
            &json!({
                "operationId": recovery_id,
                "parentOperationId": interrupted_rollback_id,
                "applyOperationId": apply_id,
                "rollbackToken": "calrb-interrupted-rollback-001",
                "confirmation": CAMERA_CALIBRATION_ROLLBACK_CONFIRMATION
            })
            .to_string(),
            "admin-recovery",
            |_| {
                Some(CaptureProxyResponse {
                    status_code: 200,
                    content_type: "application/json".to_string(),
                    body: json!({
                        "code": 0,
                        "complete": true,
                        "applyOperationId": apply_id,
                        "rolledBack": 6,
                        "failed": 0
                    })
                    .to_string()
                    .into_bytes(),
                })
            },
        );
        assert!(response_text(recovery).starts_with("HTTP/1.1 200 OK"));
        let interrupted = state
            .runtime
            .block_on(db::find_calibration_operation(
                &state.database.connection,
                interrupted_rollback_id,
            ))
            .expect("interrupted rollback lookup")
            .expect("interrupted rollback row");
        assert_eq!(interrupted.status, "reconciled");
        assert_eq!(interrupted.reconciliation_id, recovery_id);
        assert!(
            calibration_operations::reconciliation_fence_response(&state, "/api/param").is_none()
        );
    }

    #[test]
    fn startup_recovery_marks_dispatching_calibration_operations_without_replay() {
        let state = production_test_state();
        state
            .runtime
            .block_on(db::insert_calibration_operation(
                &state.database.connection,
                db::CalibrationOperationInput {
                    id: "cal-op-interrupted-001".to_string(),
                    kind: "apply-all".to_string(),
                    request_hash: "fnv1a64-test".to_string(),
                    request_json: r#"{"operationId":"cal-op-interrupted-001"}"#.to_string(),
                    actor: "admin-a".to_string(),
                    parent_operation_id: String::new(),
                },
            ))
            .expect("insert interrupted operation");

        let recovered = state
            .runtime
            .block_on(db::recover_dispatching_calibration_operations(
                &state.database.connection,
            ))
            .expect("recover interrupted operations");
        assert_eq!(recovered, 1);
        let operation = state
            .runtime
            .block_on(db::find_calibration_operation(
                &state.database.connection,
                "cal-op-interrupted-001",
            ))
            .expect("operation lookup")
            .expect("recovered operation");
        assert_eq!(operation.status, "needs-reconciliation");
        assert_eq!(operation.error, "service_restart_while_dispatching");
        assert_eq!(
            state
                .runtime
                .block_on(db::recover_dispatching_calibration_operations(
                    &state.database.connection,
                ))
                .expect("second recovery"),
            0
        );
    }

    #[test]
    fn capture_proxy_preserves_provider_error_status_and_body() {
        let response = parse_capture_http_response(
            b"HTTP/1.1 422 Unprocessable Entity\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 37\r\n\r\n{\"code\":422,\"error\":\"bad_parameter\"}"
                .to_vec(),
        )
        .expect("provider response should parse");

        assert_eq!(response.status_code, 422);
        assert_eq!(response.content_type, "application/json; charset=utf-8");
        assert_eq!(
            String::from_utf8(response.body).expect("json body"),
            "{\"code\":422,\"error\":\"bad_parameter\"}"
        );
        assert_eq!(capture_proxy_status(422), "422 Unprocessable Entity");
    }

    #[test]
    fn capture_provider_unavailable_response_never_leaks_the_private_origin() {
        let state = production_test_state_with_provider(
            CaptureProvider::ExternalApi,
            "http://127.0.0.1:4317",
        );
        let response = response_text(capture_provider_unavailable_response(&state.capture));
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
        assert!(response.contains("capture_provider_unavailable"));
        assert!(!response.contains("127.0.0.1"));
        assert!(!response.contains("4317"));
        assert!(!response.contains("\"origin\""));
    }

    #[test]
    fn trigger_gateway_operator_routes_are_explicit_and_proxied_without_origin_leaks() {
        for (method, path) in [
            ("GET", "/api/trigger/status"),
            ("GET", "/api/trigger/mode"),
            ("POST", "/api/trigger/mode"),
            ("POST", "/api/trigger/manual/steel-info"),
            ("POST", "/api/trigger/manual/steel-in"),
            ("POST", "/api/trigger/manual/steel-out"),
            ("POST", "/api/trigger/capture-once"),
        ] {
            assert!(
                is_trigger_gateway_proxy_route(method, path),
                "missing trigger gateway proxy route {method} {path}"
            );
        }
        assert!(!is_trigger_gateway_proxy_route(
            "POST",
            "/api/trigger/defect"
        ));

        let body = json!({
            "code": 0,
            "service": "steel-trigger-gateway",
            "mode": "manual",
            "manualAllowed": true
        })
        .to_string();
        let (origin, server) = spawn_health_http_server("200 OK", body, Duration::ZERO);
        let mut state = production_test_state();
        state.trigger_gateway_origin = origin;
        let response = response_text(trigger_gateway_proxy_http_response(
            &state,
            "GET",
            "/api/trigger/status",
            "",
            "operator-a",
        ));
        server.join().expect("trigger proxy test server");
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("\"service\":\"steel-trigger-gateway\""));
        assert!(response.contains("\"mode\":\"manual\""));

        let mut unavailable = production_test_state();
        unavailable.trigger_gateway_origin = unused_local_http_origin();
        let private_origin = unavailable.trigger_gateway_origin.clone();
        let response = response_text(trigger_gateway_proxy_http_response(
            &unavailable,
            "GET",
            "/api/trigger/status",
            "",
            "operator-a",
        ));
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable\r\n"));
        assert!(response.contains("trigger_gateway_unavailable"));
        assert!(!response.contains(&private_origin));

        for path in [
            "/api/trigger/mode",
            "/api/trigger/manual/steel-info",
            "/api/trigger/manual/steel-in",
            "/api/trigger/manual/steel-out",
            "/api/trigger/capture-once",
        ] {
            assert_eq!(permission_for_route("POST", path), Some("admin.services"));
        }
    }

    #[test]
    fn production_mutations_share_one_serial_command_lane() {
        assert!(is_production_mutation_route(
            "POST",
            "/api/production/capture-once"
        ));
        assert!(is_production_mutation_route(
            "POST",
            "/api/production/steel-out"
        ));
        assert!(!is_production_mutation_route(
            "GET",
            "/api/production/status"
        ));
        assert!(!is_production_mutation_route("POST", "/api/param"));
    }

    #[test]
    fn steel_out_requires_an_active_session() {
        let conflict = resolve_production_event_target(
            &json!({ "materialId": "MAT-A", "sessionId": "SESSION-A" }),
            "steel-out",
            None,
            1,
        )
        .unwrap_err();
        assert_eq!(
            conflict,
            ProductionTransitionConflict::ActiveSessionRequired
        );

        let state = production_test_state();
        let response = response_text(write_production_event_response(
            &state,
            r#"{"materialId":"MAT-A","sessionId":"SESSION-A"}"#,
            "steel-out",
            "test",
        ));
        assert!(response.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(response.contains("active_session_required"));
        assert!(state
            .runtime
            .block_on(db::latest_material_session(&state.database.connection))
            .expect("session query")
            .is_none());
    }

    #[test]
    fn steel_out_mismatch_does_not_finish_the_active_session() {
        let state = production_test_state();
        let started = response_text(write_production_event_response(
            &state,
            r#"{"materialId":"MAT-A","sessionId":"SESSION-A"}"#,
            "steel-in",
            "test",
        ));
        assert!(started.starts_with("HTTP/1.1 200 OK\r\n"));

        for mismatched_body in [
            r#"{"materialId":"MAT-B","sessionId":"SESSION-A"}"#,
            r#"{"materialId":"MAT-A","sessionId":"SESSION-B"}"#,
        ] {
            let response = response_text(write_production_event_response(
                &state,
                mismatched_body,
                "steel-out",
                "test",
            ));
            assert!(response.starts_with("HTTP/1.1 409 Conflict\r\n"));
            assert!(response.contains("active_session_conflict"));

            let active = state
                .runtime
                .block_on(db::find_material_session(
                    &state.database.connection,
                    "SESSION-A",
                ))
                .expect("active session query")
                .expect("active session should remain");
            assert_eq!(active.material_id, "MAT-A");
            assert_eq!(active.status, "active");
            assert!(active.finished_at.is_empty());
        }
        assert!(state
            .runtime
            .block_on(db::find_material_session(
                &state.database.connection,
                "SESSION-B",
            ))
            .expect("mismatched session query")
            .is_none());
    }

    #[test]
    fn production_status_uses_the_latest_open_session_independently() {
        let state = production_test_state();
        insert_production_record(
            &state,
            "INSP-SESSION-A",
            "MAT-OPEN",
            "SESSION-A",
            "active",
            "running",
            "",
        );
        insert_production_record(
            &state,
            "INSP-SESSION-Z",
            "MAT-FINISHED",
            "SESSION-Z",
            "finished",
            "finished",
            "2",
        );

        let body = response_json(production_status_response(&state));
        assert_eq!(body["latestSession"]["id"], json!("SESSION-Z"));
        assert_eq!(body["activeSession"]["id"], json!("SESSION-A"));
        assert_eq!(body["activeSession"]["status"], json!("active"));
    }

    #[test]
    fn steel_in_rejects_a_second_session_but_allows_same_session_retry() {
        let target = resolve_production_event_target(
            &json!({ "materialId": "MAT-A" }),
            "steel-in",
            Some(("MAT-A", "SESSION-A")),
            1,
        )
        .expect("same material retry should resolve to the active session");
        assert_eq!(target.session_id, "SESSION-A");

        let state = production_test_state();
        let started = response_text(write_production_event_response(
            &state,
            r#"{"materialId":"MAT-A","sessionId":"SESSION-A"}"#,
            "steel-in",
            "test",
        ));
        assert!(started.starts_with("HTTP/1.1 200 OK\r\n"));

        let conflict = response_text(write_production_event_response(
            &state,
            r#"{"materialId":"MAT-B","sessionId":"SESSION-B"}"#,
            "steel-in",
            "test",
        ));
        assert!(conflict.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(state
            .runtime
            .block_on(db::find_material_session(
                &state.database.connection,
                "SESSION-B",
            ))
            .expect("second session query")
            .is_none());

        let retry = response_text(write_production_event_response(
            &state,
            r#"{"materialId":"MAT-A","sessionId":"SESSION-A"}"#,
            "steel-in",
            "test",
        ));
        assert!(retry.starts_with("HTTP/1.1 200 OK\r\n"));
        let active = state
            .runtime
            .block_on(db::latest_open_material_session(&state.database.connection))
            .expect("active session query")
            .expect("active session should exist");
        assert_eq!(active.id, "SESSION-A");
        assert_eq!(active.material_id, "MAT-A");
    }

    #[test]
    fn steel_out_provider_failure_remains_retryable_and_never_marks_session_finished() {
        let state =
            production_test_state_with_provider(CaptureProvider::ExternalApi, "http://127.0.0.1:0");
        insert_production_record(
            &state,
            "INSP-SESSION-A",
            "MAT-A",
            "SESSION-A",
            "active",
            "running",
            "",
        );
        let first = response_text(write_production_event_response(
            &state,
            r#"{"materialId":"MAT-A","sessionId":"SESSION-A"}"#,
            "steel-out",
            "test",
        ));
        assert!(first.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(first.contains("\"code\":503"));
        let failed = state
            .runtime
            .block_on(db::find_material_session(
                &state.database.connection,
                "SESSION-A",
            ))
            .expect("failed session query")
            .expect("failed session");
        assert_eq!(failed.status, "exit-failed");
        assert!(failed.finished_at.is_empty());

        let retry = response_text(write_production_event_response(
            &state,
            r#"{"materialId":"MAT-A","sessionId":"SESSION-A"}"#,
            "steel-out",
            "test",
        ));
        assert!(retry.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(retry.contains("\"code\":503"));
        assert!(!retry.contains("active_session_required"));
    }

    #[test]
    fn steel_out_preserves_existing_material_spec_when_payload_is_minimal() {
        let state = production_test_state();
        insert_production_record(
            &state,
            "INSP-SESSION-A",
            "MAT-A",
            "SESSION-A",
            "active",
            "running",
            "",
        );

        let response = response_text(write_production_event_response(
            &state,
            r#"{"materialId":"MAT-A","sessionId":"SESSION-A"}"#,
            "steel-out",
            "test",
        ));
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("\"code\":0"));

        let finished = state
            .runtime
            .block_on(db::find_material_session(
                &state.database.connection,
                "SESSION-A",
            ))
            .expect("finished session query")
            .expect("finished session");
        assert_eq!(finished.status, "finished");
        assert_eq!(finished.source, "test");
        assert_eq!(finished.control_mode, "manual");
        assert_eq!(finished.trigger_mode, "manual");
        assert_eq!(finished.steel_type, "round-bar");
        assert_eq!(finished.width_mm, 120.0);
        assert_eq!(finished.length_mm, 6000.0);
        assert_eq!(finished.thickness_mm, 12.0);
        assert_eq!(finished.client, "test");
        assert_eq!(finished.hard, "Q355");
        assert_eq!(finished.storage_root, "H:\\");
        assert_eq!(finished.started_at, "1");
        assert!(!finished.finished_at.is_empty());
    }

    #[test]
    fn steel_in_provider_failure_does_not_arm_capture() {
        let state =
            production_test_state_with_provider(CaptureProvider::ExternalApi, "http://127.0.0.1:0");
        insert_production_record(
            &state,
            "INSP-SESSION-FAILED",
            "MAT-FAILED",
            "SESSION-FAILED",
            "info-received",
            "info-received",
            "",
        );
        let response = response_text(write_production_event_response(
            &state,
            r#"{"materialId":"MAT-FAILED","sessionId":"SESSION-FAILED"}"#,
            "steel-in",
            "test",
        ));
        assert!(response.contains("\"code\":503"));
        let session = state
            .runtime
            .block_on(db::find_material_session(
                &state.database.connection,
                "SESSION-FAILED",
            ))
            .expect("failed steel-in query")
            .expect("failed steel-in session");
        assert_eq!(session.status, "start-failed");
        let capture_guard = response_text(
            validate_capture_open_session(
                &state,
                &json!({
                    "materialId": "MAT-FAILED",
                    "sessionId": "SESSION-FAILED",
                    "requireSteelPresent": true
                }),
            )
            .expect_err("failed steel-in must not allow capture"),
        );
        assert!(capture_guard.contains("production_session_not_capture_ready"));
        assert!(capture_guard.contains("start-failed"));

        let steel_out = response_text(write_production_event_response(
            &state,
            r#"{"materialId":"MAT-FAILED","sessionId":"SESSION-FAILED"}"#,
            "steel-out",
            "test",
        ));
        assert!(steel_out.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(steel_out.contains("production_session_not_exit_ready"));
        assert!(steel_out.contains("start-failed"));
    }

    #[test]
    fn pre_capture_session_persistence_failure_is_reported_for_info_and_in() {
        for event in ["steel-info", "steel-in"] {
            let state = production_test_state();
            install_failing_insert_trigger(&state, "material_session");
            let response = response_text(write_production_event_response(
                &state,
                r#"{"materialId":"MAT-A","sessionId":"SESSION-A"}"#,
                event,
                "test",
            ));
            assert!(response.starts_with("HTTP/1.1 500 Internal Server Error\r\n"));
            assert!(response.contains("production_state_persistence_failed"));
            assert!(!response.contains("recordWrittenBeforeCapture"));
        }
    }

    #[test]
    fn pre_capture_inspection_persistence_failure_is_reported_for_info_and_in() {
        for event in ["steel-info", "steel-in"] {
            let state = production_test_state();
            install_failing_insert_trigger(&state, "production_inspection");
            let response = response_text(write_production_event_response(
                &state,
                r#"{"materialId":"MAT-A","sessionId":"SESSION-A"}"#,
                event,
                "test",
            ));
            assert!(response.starts_with("HTTP/1.1 500 Internal Server Error\r\n"));
            assert!(response.contains("upsert_production_inspection"));
            assert!(!response.contains("recordWrittenBeforeCapture"));
        }
    }

    #[test]
    fn production_task_enqueue_is_idempotent_and_rejects_payload_conflicts() {
        let state = production_test_state();
        let first = response_text(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"algorithm-run","idempotencyKey":"RUN-001","payload":{"materialId":"MAT-A","maxFrames":6}}"#,
            "tester",
        ));
        assert!(first.starts_with("HTTP/1.1 202 Accepted\r\n"));
        assert!(first.contains("\"duplicate\":false"));

        let duplicate = response_text(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"algorithm-run","idempotencyKey":"RUN-001","payload":{"materialId":"MAT-A","maxFrames":6}}"#,
            "tester",
        ));
        assert!(duplicate.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(duplicate.contains("\"duplicate\":true"));

        let conflict = response_text(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"algorithm-run","idempotencyKey":"RUN-001","payload":{"materialId":"MAT-B","maxFrames":6}}"#,
            "tester",
        ));
        assert!(conflict.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(conflict.contains("idempotency_conflict"));

        let page = state
            .runtime
            .block_on(db::list_production_tasks(
                &state.database.connection,
                db::ProductionTaskFilter::default(),
            ))
            .expect("task page");
        assert_eq!(page.total, 1);
        assert_eq!(page.tasks[0].status, "queued");
    }

    #[test]
    fn queued_production_event_routes_are_explicit_and_do_not_take_the_sync_lane() {
        for (path, kind) in [
            ("/api/production/tasks/steel-info", "steel-info"),
            ("/api/production/tasks/steel-in", "steel-in"),
            ("/api/production/tasks/steel-out", "steel-out"),
            ("/api/production/tasks/trigger-event", "trigger-event"),
        ] {
            assert_eq!(
                production_tasks::queued_kind_for_route("POST", path),
                Some(kind)
            );
            assert!(!is_production_mutation_route("POST", path));
            assert_eq!(production_tasks::queued_kind_for_route("GET", path), None);
        }
        assert_eq!(
            production_tasks::queued_kind_for_route("POST", "/api/production/steel-in"),
            None
        );
        assert!(is_production_mutation_route(
            "POST",
            "/api/production/steel-in"
        ));

        let state = production_test_state();
        let request = r#"{"materialId":"MAT-IDEMPOTENT","sessionId":"SESSION-IDEMPOTENT","requestId":"STEEL-IN-001","autoCapture":false}"#;
        let first = response_text(production_tasks::enqueue_kind_response(
            &state, "steel-in", request, "tester",
        ));
        let duplicate = response_text(production_tasks::enqueue_kind_response(
            &state, "steel-in", request, "tester",
        ));
        assert!(first.starts_with("HTTP/1.1 202 Accepted\r\n"));
        assert!(duplicate.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(duplicate.contains("\"duplicate\":true"));
        assert_eq!(
            state
                .runtime
                .block_on(db::count_open_production_tasks(&state.database.connection))
                .expect("open task count"),
            1
        );
    }

    #[test]
    fn queued_production_chain_reuses_session_and_claims_fifo_through_steel_out() {
        let state = production_test_state();
        let steel_in = response_json(production_tasks::enqueue_kind_response(
            &state,
            "steel-in",
            r#"{"materialId":"MAT-FIFO","requestId":"FIFO-IN","autoCapture":false}"#,
            "tester",
        ));
        let capture = response_json(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"capture-once","idempotencyKey":"FIFO-CAPTURE","payload":{"materialId":"MAT-FIFO","requireSteelPresent":true}}"#,
            "tester",
        ));
        let algorithm = response_json(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"algorithm-run","idempotencyKey":"FIFO-ALGORITHM","payload":{"materialId":"MAT-FIFO","runCore":false}}"#,
            "tester",
        ));
        let steel_out = response_json(production_tasks::enqueue_kind_response(
            &state,
            "steel-out",
            r#"{"materialId":"MAT-FIFO","requestId":"FIFO-OUT"}"#,
            "tester",
        ));

        let session_id = steel_in["task"]["sessionId"]
            .as_str()
            .expect("steel-in task session")
            .to_string();
        assert!(!session_id.is_empty());
        for task in [&capture, &algorithm, &steel_out] {
            assert_eq!(task["task"]["sessionId"], json!(session_id.clone()));
            assert_eq!(task["task"]["chainId"], json!(session_id.clone()));
        }
        assert_eq!(steel_in["task"]["dependsOnTaskId"], Value::Null);
        assert_eq!(capture["task"]["dependsOnTaskId"], steel_in["task"]["id"]);
        assert_eq!(algorithm["task"]["dependsOnTaskId"], capture["task"]["id"]);
        assert_eq!(
            steel_out["task"]["dependsOnTaskId"],
            algorithm["task"]["id"]
        );

        let mut claimed_kinds = Vec::new();
        for _ in 0..4 {
            let task = state
                .runtime
                .block_on(db::claim_next_production_task(&state.database.connection))
                .expect("claim query")
                .expect("queued task");
            claimed_kinds.push(task.kind.clone());
            let checkpoint = state
                .runtime
                .block_on(db::update_production_task_progress(
                    &state.database.connection,
                    &task.id,
                    "dispatching-test-operation",
                    42,
                ))
                .expect("checkpoint update")
                .expect("running task checkpoint");
            assert_eq!(checkpoint.status, "running");
            assert_eq!(checkpoint.phase, "dispatching-test-operation");
            assert_eq!(checkpoint.progress, 42);
            state
                .runtime
                .block_on(db::finish_production_task(
                    &state.database.connection,
                    &task.id,
                    "succeeded",
                    100,
                    "{}".to_string(),
                    String::new(),
                ))
                .expect("finish task");
        }
        assert_eq!(
            claimed_kinds,
            ["steel-in", "capture-once", "algorithm-run", "steel-out"]
        );
    }

    #[test]
    fn failed_chain_dependency_blocks_all_downstream_tasks_until_parent_retry() {
        let state = production_test_state();
        let steel_in = response_json(production_tasks::enqueue_kind_response(
            &state,
            "steel-in",
            r#"{"materialId":"MAT-BLOCK","sessionId":"SESSION-BLOCK","requestId":"BLOCK-IN","autoCapture":false}"#,
            "tester",
        ));
        let capture = response_json(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"capture-once","idempotencyKey":"BLOCK-CAPTURE","payload":{"materialId":"MAT-BLOCK","sessionId":"SESSION-BLOCK"}}"#,
            "tester",
        ));
        let algorithm = response_json(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"algorithm-run","idempotencyKey":"BLOCK-ALGORITHM","payload":{"materialId":"MAT-BLOCK","sessionId":"SESSION-BLOCK","runCore":false}}"#,
            "tester",
        ));
        let steel_out = response_json(production_tasks::enqueue_kind_response(
            &state,
            "steel-out",
            r#"{"materialId":"MAT-BLOCK","sessionId":"SESSION-BLOCK","requestId":"BLOCK-OUT"}"#,
            "tester",
        ));
        let root_id = steel_in["task"]["id"].as_str().expect("root id");
        let capture_id = capture["task"]["id"].as_str().expect("capture id");
        let algorithm_id = algorithm["task"]["id"].as_str().expect("algorithm id");
        let steel_out_id = steel_out["task"]["id"].as_str().expect("steel-out id");

        let claimed = state
            .runtime
            .block_on(db::claim_next_production_task(&state.database.connection))
            .expect("claim root")
            .expect("root task");
        assert_eq!(claimed.id, root_id);
        state
            .runtime
            .block_on(db::finish_production_task(
                &state.database.connection,
                root_id,
                "failed",
                100,
                String::new(),
                "provider failed".to_string(),
            ))
            .expect("fail root");

        for (id, parent_id) in [
            (capture_id, root_id),
            (algorithm_id, capture_id),
            (steel_out_id, algorithm_id),
        ] {
            let task = state
                .runtime
                .block_on(db::find_production_task(&state.database.connection, id))
                .expect("blocked task query")
                .expect("blocked task");
            assert_eq!(task.status, "blocked");
            assert!(task.blocked_reason.contains(parent_id));
        }
        assert!(state
            .runtime
            .block_on(db::claim_next_production_task(&state.database.connection))
            .expect("empty claim")
            .is_none());

        let downstream_retry = response_text(production_tasks::retry_response(
            &state,
            &json!({ "taskId": capture_id }).to_string(),
            "tester",
        ));
        assert!(downstream_retry.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(downstream_retry.contains("production_task_dependency_unresolved"));

        let root_retry = response_text(production_tasks::retry_response(
            &state,
            &json!({ "taskId": root_id }).to_string(),
            "tester",
        ));
        assert!(root_retry.starts_with("HTTP/1.1 202 Accepted\r\n"));
        for id in [capture_id, algorithm_id, steel_out_id] {
            let task = state
                .runtime
                .block_on(db::find_production_task(&state.database.connection, id))
                .expect("requeued task query")
                .expect("requeued task");
            assert_eq!(task.status, "queued");
            assert!(task.blocked_reason.is_empty());
        }
        let retried_root = state
            .runtime
            .block_on(db::claim_next_production_task(&state.database.connection))
            .expect("claim retried root")
            .expect("retried root");
        assert_eq!(retried_root.id, root_id);
        state
            .runtime
            .block_on(db::finish_production_task(
                &state.database.connection,
                root_id,
                "succeeded",
                100,
                "{}".to_string(),
                String::new(),
            ))
            .expect("finish retried root");
        let next = state
            .runtime
            .block_on(db::claim_next_production_task(&state.database.connection))
            .expect("claim downstream")
            .expect("capture after recovery");
        assert_eq!(next.id, capture_id);
    }

    #[test]
    fn safety_critical_tasks_reject_always_run_bypass() {
        let state = production_test_state();
        let response = response_text(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"steel-out","dependencyPolicy":"always-run","payload":{"materialId":"MAT-SAFE","sessionId":"SESSION-SAFE"}}"#,
            "tester",
        ));
        assert!(response.starts_with("HTTP/1.1 400 Bad Request\r\n"));
        assert!(response.contains("always_run_not_allowed_for_safety_critical_task"));
    }

    #[test]
    fn one_session_cannot_fork_into_a_second_production_chain() {
        let state = production_test_state();
        let first = response_text(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"steel-in","idempotencyKey":"CHAIN-A-IN","chainId":"CHAIN-A","payload":{"materialId":"MAT-CHAIN","sessionId":"SESSION-CHAIN","autoCapture":false}}"#,
            "tester",
        ));
        assert!(first.starts_with("HTTP/1.1 202 Accepted\r\n"));
        let fork = response_text(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"capture-once","idempotencyKey":"CHAIN-B-CAPTURE","chainId":"CHAIN-B","payload":{"materialId":"MAT-CHAIN","sessionId":"SESSION-CHAIN"}}"#,
            "tester",
        ));
        assert!(fork.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(fork.contains("production_session_chain_mismatch"));
    }

    #[test]
    fn explicitly_safe_trigger_cleanup_can_run_after_terminal_dependency_failure() {
        let state = production_test_state();
        let parent = response_json(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"steel-in","idempotencyKey":"CLEANUP-IN","chainId":"CHAIN-CLEANUP","payload":{"materialId":"MAT-CLEANUP","sessionId":"SESSION-CLEANUP","autoCapture":false}}"#,
            "tester",
        ));
        let parent_id = parent["task"]["id"].as_str().expect("parent id");
        let cleanup = response_json(production_tasks::enqueue_kind_response(
            &state,
            "trigger-event",
            &json!({
                "materialId": "MAT-CLEANUP",
                "sessionId": "SESSION-CLEANUP",
                "requestId": "CLEANUP-EVENT",
                "chainId": "CHAIN-CLEANUP",
                "dependsOnTaskId": parent_id,
                "dependencyPolicy": "always-run",
                "command": "safe-cleanup"
            })
            .to_string(),
            "tester",
        ));
        let cleanup_id = cleanup["task"]["id"].as_str().expect("cleanup id");
        assert_eq!(cleanup["task"]["dependencyPolicy"], "always-run");

        let claimed_parent = state
            .runtime
            .block_on(db::claim_next_production_task(&state.database.connection))
            .expect("claim parent")
            .expect("parent");
        assert_eq!(claimed_parent.id, parent_id);
        state
            .runtime
            .block_on(db::finish_production_task(
                &state.database.connection,
                parent_id,
                "failed",
                100,
                String::new(),
                "provider failed".to_string(),
            ))
            .expect("fail parent");
        let claimed_cleanup = state
            .runtime
            .block_on(db::claim_next_production_task(&state.database.connection))
            .expect("claim cleanup")
            .expect("cleanup after terminal parent");
        assert_eq!(claimed_cleanup.id, cleanup_id);
    }

    #[test]
    fn worker_execution_scope_bypasses_only_its_own_open_task_fence() {
        let state = production_test_state();
        let queued = response_text(production_tasks::enqueue_kind_response(
            &state,
            "steel-in",
            r#"{"materialId":"MAT-WORKER","sessionId":"SESSION-WORKER","requestId":"WORKER-IN","autoCapture":false}"#,
            "tester",
        ));
        assert!(queued.starts_with("HTTP/1.1 202 Accepted\r\n"));
        let task = state
            .runtime
            .block_on(db::claim_next_production_task(&state.database.connection))
            .expect("claim query")
            .expect("steel-in task");
        assert_eq!(task.kind, "steel-in");
        assert_eq!(
            state
                .runtime
                .block_on(db::count_open_production_tasks(&state.database.connection))
                .expect("open task count"),
            1
        );
        assert!(!production_tasks::worker_execution_scope_active());

        let response = response_text(production_tasks::execute_task(&state, &task));
        assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response.contains("\"code\":0"));
        assert!(!response.contains("production_tasks_in_progress"));
        assert!(!production_tasks::worker_execution_scope_active());

        let session = state
            .runtime
            .block_on(db::find_material_session(
                &state.database.connection,
                "SESSION-WORKER",
            ))
            .expect("session query")
            .expect("worker-created session");
        assert_eq!(session.status, "active");

        let sync_response = response_text(write_production_event_response(
            &state,
            r#"{"materialId":"MAT-WORKER","sessionId":"SESSION-WORKER"}"#,
            "steel-out",
            "tester",
        ));
        assert!(sync_response.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(sync_response.contains("production_tasks_in_progress"));
    }

    #[test]
    fn queued_event_validates_state_in_worker_and_provider_failure_is_explicitly_retryable() {
        let invalid_state = production_test_state();
        let queued = response_text(production_tasks::enqueue_kind_response(
            &invalid_state,
            "steel-out",
            r#"{"materialId":"MAT-NONE","sessionId":"SESSION-NONE","requestId":"OUT-NO-SESSION"}"#,
            "tester",
        ));
        assert!(queued.starts_with("HTTP/1.1 202 Accepted\r\n"));
        let invalid_task = invalid_state
            .runtime
            .block_on(db::claim_next_production_task(
                &invalid_state.database.connection,
            ))
            .expect("claim query")
            .expect("steel-out task");
        let invalid_response = response_text(production_tasks::execute_task(
            &invalid_state,
            &invalid_task,
        ));
        assert!(invalid_response.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(invalid_response.contains("active_session_required"));

        let state =
            production_test_state_with_provider(CaptureProvider::ExternalApi, "http://127.0.0.1:0");
        let queued = response_text(production_tasks::enqueue_kind_response(
            &state,
            "steel-in",
            r#"{"materialId":"MAT-RETRY","sessionId":"SESSION-RETRY","requestId":"RETRY-IN","autoCapture":false}"#,
            "tester",
        ));
        assert!(queued.starts_with("HTTP/1.1 202 Accepted\r\n"));
        let task = state
            .runtime
            .block_on(db::claim_next_production_task(&state.database.connection))
            .expect("claim query")
            .expect("steel-in task");
        let response = production_tasks::execute_task(&state, &task);
        let body = production_tasks::response_body(&response);
        assert!(body.contains("\"code\":503"));
        let (status, progress, error) =
            production_tasks::provider_terminal_outcome(&response, &body);
        assert_eq!(status, "failed");
        state
            .runtime
            .block_on(db::finish_production_task(
                &state.database.connection,
                &task.id,
                status,
                progress,
                body,
                error,
            ))
            .expect("finish failed task");
        let failed = state
            .runtime
            .block_on(db::find_production_task(
                &state.database.connection,
                &task.id,
            ))
            .expect("task query")
            .expect("failed task");
        assert_eq!(failed.status, "failed");
        assert_eq!(failed.attempts, 1);

        let retried = response_text(production_tasks::retry_response(
            &state,
            &json!({ "taskId": task.id }).to_string(),
            "tester",
        ));
        assert!(retried.starts_with("HTTP/1.1 202 Accepted\r\n"));
        let queued_again = state
            .runtime
            .block_on(db::find_production_task(
                &state.database.connection,
                &task.id,
            ))
            .expect("task query")
            .expect("retried task");
        assert_eq!(queued_again.status, "queued");
        assert_eq!(queued_again.attempts, 1);
    }

    #[test]
    fn production_task_idempotent_replay_precedes_changed_session_validation() {
        let state = production_test_state();
        insert_production_record(
            &state,
            "INSP-SESSION-A",
            "MAT-A",
            "SESSION-A",
            "active",
            "running",
            "",
        );
        let request = r#"{"kind":"capture-once","idempotencyKey":"CAPTURE-001","payload":{"materialId":"MAT-A","sessionId":"SESSION-A","requireSteelPresent":true}}"#;
        let first = response_text(production_tasks::enqueue_response(
            &state, request, "tester",
        ));
        assert!(first.starts_with("HTTP/1.1 202 Accepted\r\n"));

        insert_production_record(
            &state,
            "INSP-SESSION-A",
            "MAT-A",
            "SESSION-A",
            "finished",
            "finished",
            "2",
        );
        let duplicate = response_text(production_tasks::enqueue_response(
            &state, request, "tester",
        ));
        assert!(duplicate.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(duplicate.contains("\"duplicate\":true"));
        assert!(!duplicate.contains("production_session_not_capture_ready"));
    }

    #[test]
    fn queued_production_task_prevents_steel_out_from_overtaking_it() {
        let state = production_test_state();
        insert_production_record(
            &state,
            "INSP-SESSION-A",
            "MAT-A",
            "SESSION-A",
            "active",
            "running",
            "",
        );
        let queued = response_text(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"capture-once","idempotencyKey":"CAPTURE-FENCE","payload":{"materialId":"MAT-A","sessionId":"SESSION-A","requireSteelPresent":true}}"#,
            "tester",
        ));
        assert!(queued.starts_with("HTTP/1.1 202 Accepted\r\n"));

        let steel_out = response_text(write_production_event_response(
            &state,
            r#"{"materialId":"MAT-A","sessionId":"SESSION-A"}"#,
            "steel-out",
            "tester",
        ));
        assert!(steel_out.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(steel_out.contains("production_tasks_in_progress"));
        let session = state
            .runtime
            .block_on(db::find_material_session(
                &state.database.connection,
                "SESSION-A",
            ))
            .expect("session query")
            .expect("session should remain");
        assert_eq!(session.status, "active");
        assert!(session.finished_at.is_empty());
    }

    #[test]
    fn queued_production_task_can_be_cancelled_and_explicitly_retried() {
        let state = production_test_state();
        let queued = response_text(production_tasks::enqueue_response(
            &state,
            r#"{"kind":"algorithm-run","idempotencyKey":"RUN-CANCEL","payload":{"materialId":"MAT-A"}}"#,
            "tester",
        ));
        assert!(queued.starts_with("HTTP/1.1 202 Accepted\r\n"));
        let page = state
            .runtime
            .block_on(db::list_production_tasks(
                &state.database.connection,
                db::ProductionTaskFilter::default(),
            ))
            .expect("task page");
        let task_id = page.tasks[0].id.clone();

        let cancelled = response_text(production_tasks::cancel_response(
            &state,
            &json!({ "taskId": task_id }).to_string(),
            "tester",
        ));
        assert!(cancelled.starts_with("HTTP/1.1 200 OK\r\n"));
        let cancelled_task = state
            .runtime
            .block_on(db::find_production_task(
                &state.database.connection,
                &page.tasks[0].id,
            ))
            .expect("cancel query")
            .expect("cancelled task");
        assert_eq!(cancelled_task.status, "cancelled");
        assert!(cancelled_task.cancel_requested);

        let retried = response_text(production_tasks::retry_response(
            &state,
            &json!({ "taskId": cancelled_task.id }).to_string(),
            "tester",
        ));
        assert!(retried.starts_with("HTTP/1.1 202 Accepted\r\n"));
        let retried_task = state
            .runtime
            .block_on(db::find_production_task(
                &state.database.connection,
                &page.tasks[0].id,
            ))
            .expect("retry query")
            .expect("retried task");
        assert_eq!(retried_task.status, "queued");
        assert!(!retried_task.cancel_requested);
    }

    #[test]
    fn service_restart_marks_inflight_task_interrupted_without_replaying_it() {
        let state = production_test_state();
        state
            .runtime
            .block_on(db::insert_production_task(
                &state.database.connection,
                db::ProductionTaskInput {
                    id: "TASK-RECOVERY".to_string(),
                    idempotency_key: "algorithm-run:RECOVERY".to_string(),
                    kind: "algorithm-run".to_string(),
                    material_id: "MAT-A".to_string(),
                    session_id: "SESSION-A".to_string(),
                    chain_id: "SESSION-A".to_string(),
                    depends_on_task_id: String::new(),
                    dependency_policy: "require-success".to_string(),
                    payload: r#"{"materialId":"MAT-A"}"#.to_string(),
                    actor: "tester".to_string(),
                    max_attempts: 3,
                },
            ))
            .expect("insert recovery task");
        state
            .runtime
            .block_on(db::insert_production_task(
                &state.database.connection,
                db::ProductionTaskInput {
                    id: "TASK-RECOVERY-DOWNSTREAM".to_string(),
                    idempotency_key: "steel-out:RECOVERY-DOWNSTREAM".to_string(),
                    kind: "steel-out".to_string(),
                    material_id: "MAT-A".to_string(),
                    session_id: "SESSION-A".to_string(),
                    chain_id: "SESSION-A".to_string(),
                    depends_on_task_id: "TASK-RECOVERY".to_string(),
                    dependency_policy: "require-success".to_string(),
                    payload: r#"{"materialId":"MAT-A"}"#.to_string(),
                    actor: "tester".to_string(),
                    max_attempts: 3,
                },
            ))
            .expect("insert downstream recovery task");
        let claimed = state
            .runtime
            .block_on(db::claim_next_production_task(&state.database.connection))
            .expect("claim task")
            .expect("claimed task");
        assert_eq!(claimed.status, "running");

        let recovered = state
            .runtime
            .block_on(db::recover_incomplete_production_tasks(
                &state.database.connection,
            ))
            .expect("recover tasks");
        assert_eq!(recovered, 1);
        let task = state
            .runtime
            .block_on(db::find_production_task(
                &state.database.connection,
                "TASK-RECOVERY",
            ))
            .expect("recovered task query")
            .expect("recovered task");
        assert_eq!(task.status, "interrupted");
        assert!(task.error.contains("explicit retry required"));
        let downstream = state
            .runtime
            .block_on(db::find_production_task(
                &state.database.connection,
                "TASK-RECOVERY-DOWNSTREAM",
            ))
            .expect("downstream recovery query")
            .expect("downstream task");
        assert_eq!(downstream.status, "blocked");
        assert!(downstream.blocked_reason.contains("dependency_interrupted"));
    }

    #[test]
    fn admin_records_use_production_tables_and_ignore_legacy_rows() {
        let state = production_test_state();
        state
            .runtime
            .block_on(
                db::entities::inspection_record::ActiveModel {
                    id: Set("R-LEGACY".to_string()),
                    time: Set("2026-01-01 00:00".to_string()),
                    plate_no: Set("LEGACY-MAT".to_string()),
                    status: Set("completed".to_string()),
                    defect_count: Set(99),
                }
                .insert(&state.database.connection),
            )
            .expect("legacy row insert");
        insert_production_record(
            &state,
            "INSP-PROD-1",
            "MAT-PROD-1",
            "SESSION-PROD-1",
            "finished",
            "algorithm-complete",
            &current_time_string(),
        );
        state
            .runtime
            .block_on(db::append_production_defect(
                &state.database.connection,
                db::ProductionDefectInput {
                    inspection_id: "INSP-PROD-1".to_string(),
                    material_id: "MAT-PROD-1".to_string(),
                    camera_id: "CAM-01".to_string(),
                    defect_type: "pit".to_string(),
                    severity: "severe".to_string(),
                    x_mm: 10.0,
                    y_mm: 20.0,
                    z_mm: -1.0,
                    width_mm: 3.0,
                    height_mm: 2.0,
                    depth_mm: 1.0,
                    confidence: 0.99,
                    geometry_json: json!({
                        "cameraIndex": 1,
                        "artifacts": {
                            "schema": "steel.surface.defect.artifacts.v1",
                            "cameraId": "camera1",
                            "frameId": "frame-001",
                            "sequenceNo": 1,
                            "roi": { "x": 10, "y": 20, "width": 30, "height": 40 },
                            "roiImage": "runs/MAT-PROD-1/RUN-1/defects/ALG-0001/intensity-roi.png",
                            "localPointCloud": "runs/MAT-PROD-1/RUN-1/defects/ALG-0001/local-point-cloud.json",
                            "lengthProfile": "runs/MAT-PROD-1/RUN-1/defects/ALG-0001/length-profile.json",
                            "widthProfile": "runs/MAT-PROD-1/RUN-1/defects/ALG-0001/width-profile.json"
                        }
                    }).to_string(),
                },
            ))
            .expect("production defect insert");
        state
            .runtime
            .block_on(db::append_capture_file(
                &state.database.connection,
                db::CaptureFileInput {
                    inspection_id: "INSP-PROD-1".to_string(),
                    session_id: "SESSION-PROD-1".to_string(),
                    material_id: "MAT-PROD-1".to_string(),
                    camera_id: "CAM-01".to_string(),
                    camera_ip: "192.168.101.100".to_string(),
                    data_name: "depth".to_string(),
                    sequence_no: 1,
                    file_type: "png".to_string(),
                    path: "H:\\camera1\\MAT-PROD-1\\depth\\1.png".to_string(),
                    metadata_path: String::new(),
                },
            ))
            .expect("capture file insert");
        state
            .runtime
            .block_on(db::append_capture_file(
                &state.database.connection,
                db::CaptureFileInput {
                    inspection_id: "INSP-PROD-1".to_string(),
                    session_id: "SESSION-PROD-1".to_string(),
                    material_id: "MAT-PROD-1".to_string(),
                    camera_id: "CAM-01".to_string(),
                    camera_ip: "192.168.101.100".to_string(),
                    data_name: "depth".to_string(),
                    sequence_no: 1,
                    file_type: "png".to_string(),
                    path: "H:\\camera1\\MAT-PROD-1\\depth\\1-replayed.png".to_string(),
                    metadata_path: String::new(),
                },
            ))
            .expect("capture file replay upsert");

        let page = state
            .runtime
            .block_on(db::list_inspection_records(
                &state.database.connection,
                db::InspectionRecordFilter::default(),
            ))
            .expect("admin production records");
        assert_eq!(page.total, 1);
        assert_eq!(page.records[0].inspection.id, "INSP-PROD-1");
        assert_eq!(page.records[0].severe_count, 1);
        let detail = state
            .runtime
            .block_on(db::find_inspection_record_detail(
                &state.database.connection,
                "INSP-PROD-1",
            ))
            .expect("record detail query")
            .expect("production record detail");
        assert_eq!(detail.defects.len(), 1);
        assert_eq!(detail.capture_files.len(), 1);
        assert!(detail.capture_files[0].path.ends_with("1-replayed.png"));
        let response = response_text(read_admin_records_response(&state, ""));
        assert!(response.contains("INSP-PROD-1"));
        assert!(response.contains("\"source\":\"production\""));
        assert!(!response.contains("R-LEGACY"));

        let snapshot: Value = serde_json::from_str(
            &build_production_snapshot_json(&state)
                .expect("production snapshot query")
                .expect("production snapshot"),
        )
        .expect("production snapshot json");
        assert_eq!(snapshot["inspections"][0]["inspectionId"], "INSP-PROD-1");
        assert_eq!(
            snapshot["inspections"][0]["summaryPath"],
            "H:\\production\\INSP-PROD-1.json"
        );
        assert!(snapshot["inspections"][0]["captureSummaryPath"]
            .as_str()
            .is_some_and(|path| !path.is_empty()));
        assert_eq!(
            snapshot["inspections"][0]["captureImages"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );
        assert_eq!(
            snapshot["inspections"][0]["defects"][0]["artifacts"]["schema"],
            "steel.surface.defect.artifacts.v1"
        );
        assert_eq!(
            snapshot["inspections"][0]["defects"][0]["artifacts"]["sequenceNo"],
            1
        );
        assert_eq!(
            snapshot["inspections"][0]["defects"][0]["artifacts"]["roiImage"],
            "runs/MAT-PROD-1/RUN-1/defects/ALG-0001/intensity-roi.png"
        );
    }

    #[test]
    fn inspection_reports_are_content_addressed_immutable_and_idempotent() {
        let state = production_test_state();
        insert_production_record(
            &state,
            "INSP-REPORT-1",
            "MAT-REPORT-1",
            "SESSION-REPORT-1",
            "finished",
            "algorithm-complete",
            &current_time_string(),
        );
        let archive_root = env::temp_dir().join(format!(
            "steel-inspection-report-test-{}",
            current_time_millis()
        ));
        let first =
            issue_inspection_report_at(&state, &archive_root, "INSP-REPORT-1", "quality-user")
                .expect("first report issue");
        assert_eq!(first["created"], true);
        assert_eq!(
            first["archive"]["schema"],
            "steel.inspection.report-archive.v1"
        );
        assert_eq!(
            first["archive"]["document"]["schema"],
            "steel.inspection.report.v1"
        );
        let first_path = PathBuf::from(first["archivePath"].as_str().expect("first archive path"));
        let first_bytes = fs::read(&first_path).expect("first archive bytes");
        let detail_response = response_text(read_inspection_report_detail_at(
            &archive_root,
            &format!(
                "inspectionId=INSP-REPORT-1&reportId={}",
                first["reportId"].as_str().expect("first report id")
            ),
        ));
        assert!(detail_response.starts_with("HTTP/1.1 200 OK\r\n"));
        let detail_body = detail_response
            .split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .expect("report detail response body");
        let detail_json: Value = serde_json::from_str(detail_body).expect("report detail json");
        assert_eq!(detail_json["archive"]["reportId"], first["reportId"]);
        assert_eq!(
            detail_json["archive"]["documentSha256"],
            first["archive"]["documentSha256"]
        );
        let replay =
            issue_inspection_report_at(&state, &archive_root, "INSP-REPORT-1", "quality-user")
                .expect("idempotent report issue");
        assert_eq!(replay["created"], false);
        assert_eq!(replay["reportId"], first["reportId"]);
        let initial_history = response_text(read_inspection_reports_at(
            &archive_root,
            "inspectionId=INSP-REPORT-1",
        ));
        assert!(initial_history.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(initial_history.contains(first["reportId"].as_str().expect("first report id")));

        state
            .runtime
            .block_on(db::append_production_defect(
                &state.database.connection,
                db::ProductionDefectInput {
                    inspection_id: "INSP-REPORT-1".to_string(),
                    material_id: "MAT-REPORT-1".to_string(),
                    camera_id: "camera1".to_string(),
                    defect_type: "pit".to_string(),
                    severity: "review".to_string(),
                    x_mm: 1.0,
                    y_mm: 2.0,
                    z_mm: -0.5,
                    width_mm: 1.0,
                    height_mm: 1.0,
                    depth_mm: 0.5,
                    confidence: 0.9,
                    geometry_json: "{}".to_string(),
                },
            ))
            .expect("report defect insert");
        let revised =
            issue_inspection_report_at(&state, &archive_root, "INSP-REPORT-1", "quality-user")
                .expect("revised report issue");
        assert_eq!(revised["created"], true);
        assert_ne!(revised["reportId"], first["reportId"]);
        assert_eq!(
            fs::read(&first_path).expect("immutable first archive"),
            first_bytes
        );
        assert_eq!(
            fs::read_dir(archive_root.join("INSP-REPORT-1"))
                .expect("report archive directory")
                .count(),
            2
        );
        assert_eq!(
            permission_for_route("POST", "/api/admin/records/reports"),
            Some("admin.records")
        );
        assert_eq!(
            permission_for_route("GET", "/api/admin/records/reports/detail"),
            Some("admin.records")
        );
        let mut tampered_archive = first["archive"].clone();
        tampered_archive["reportId"] = json!("RPT-TAMPERED");
        tampered_archive["document"]["record"]["materialId"] = json!("MAT-TAMPERED");
        fs::write(
            archive_root.join("INSP-REPORT-1").join("RPT-TAMPERED.json"),
            serde_json::to_vec_pretty(&tampered_archive).expect("tampered archive bytes"),
        )
        .expect("write tampered report archive");
        let tampered_response = response_text(read_inspection_report_detail_at(
            &archive_root,
            "inspectionId=INSP-REPORT-1&reportId=RPT-TAMPERED",
        ));
        assert!(tampered_response.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(tampered_response.contains("report_archive_integrity_failed"));
        let tampered_history = response_text(read_inspection_reports_at(
            &archive_root,
            "inspectionId=INSP-REPORT-1",
        ));
        assert!(tampered_history.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(tampered_history.contains("\"invalidArchiveCount\":1"));
        assert!(tampered_history.contains("RPT-TAMPERED.json"));
        let invalid_identity = response_text(read_inspection_report_detail_at(
            &archive_root,
            "inspectionId=../INSP-REPORT-1&reportId=RPT-invalid",
        ));
        assert!(invalid_identity.starts_with("HTTP/1.1 400 Bad Request\r\n"));
        let _ = fs::remove_dir_all(archive_root);
    }

    #[test]
    fn deleting_production_record_removes_children_but_retains_session() {
        let state = production_test_state();
        insert_production_record(
            &state,
            "INSP-DELETE",
            "MAT-DELETE",
            "SESSION-DELETE",
            "finished",
            "algorithm-complete",
            "1",
        );
        state
            .runtime
            .block_on(db::append_production_defect(
                &state.database.connection,
                db::ProductionDefectInput {
                    inspection_id: "INSP-DELETE".to_string(),
                    material_id: "MAT-DELETE".to_string(),
                    camera_id: "CAM-01".to_string(),
                    defect_type: "scratch".to_string(),
                    severity: "review".to_string(),
                    x_mm: 1.0,
                    y_mm: 2.0,
                    z_mm: 0.0,
                    width_mm: 1.0,
                    height_mm: 1.0,
                    depth_mm: 0.1,
                    confidence: 0.8,
                    geometry_json: "{}".to_string(),
                },
            ))
            .expect("defect insert");
        state
            .runtime
            .block_on(db::append_capture_file(
                &state.database.connection,
                db::CaptureFileInput {
                    inspection_id: "INSP-DELETE".to_string(),
                    session_id: "SESSION-DELETE".to_string(),
                    material_id: "MAT-DELETE".to_string(),
                    camera_id: "CAM-01".to_string(),
                    camera_ip: "192.168.101.100".to_string(),
                    data_name: "depth".to_string(),
                    sequence_no: 1,
                    file_type: "png".to_string(),
                    path: "depth.png".to_string(),
                    metadata_path: String::new(),
                },
            ))
            .expect("capture file insert");
        let deleted = state
            .runtime
            .block_on(db::delete_inspection_record(
                &state.database.connection,
                "INSP-DELETE",
            ))
            .expect("delete record")
            .expect("deleted record");
        assert_eq!(deleted.defects_deleted, 1);
        assert_eq!(deleted.capture_files_deleted, 1);
        assert!(state
            .runtime
            .block_on(db::find_material_session(
                &state.database.connection,
                "SESSION-DELETE",
            ))
            .expect("session query")
            .is_some());
        assert!(state
            .runtime
            .block_on(db::find_production_inspection(
                &state.database.connection,
                "INSP-DELETE",
            ))
            .expect("inspection query")
            .is_none());
    }

    #[test]
    fn record_cleanup_deletes_frozen_artifacts_before_database_indexes_and_is_auditable() {
        let state = production_test_state();
        let root =
            env::temp_dir().join(format!("steel-record-cleanup-{}", db::now_millis_string()));
        fs::create_dir_all(&root).expect("cleanup root");
        let depth = root.join("depth.bin");
        let metadata = root.join("metadata.json");
        let mesh = root.join("mesh.bin");
        let summary = root.join("summary.json");
        fs::write(&depth, b"depth").expect("depth artifact");
        fs::write(&metadata, b"metadata").expect("metadata artifact");
        fs::write(&mesh, b"mesh").expect("mesh artifact");
        fs::write(
            &summary,
            json!({ "mesh": mesh.display().to_string() }).to_string(),
        )
        .expect("summary artifact");
        insert_production_record(
            &state,
            "INSP-CLEANUP",
            "MAT-CLEANUP",
            "SESSION-CLEANUP",
            "finished",
            "algorithm-complete",
            "1",
        );
        state
            .runtime
            .block_on(db::upsert_production_inspection(
                &state.database.connection,
                db::ProductionInspectionInput {
                    id: "INSP-CLEANUP".to_string(),
                    material_id: "MAT-CLEANUP".to_string(),
                    session_id: "SESSION-CLEANUP".to_string(),
                    status: "algorithm-complete".to_string(),
                    storage_root: root.display().to_string(),
                    summary_path: summary.display().to_string(),
                    started_at: "1".to_string(),
                    finished_at: "1".to_string(),
                    capture_count: 1,
                    defect_count: 0,
                    raw_payload: "{}".to_string(),
                },
            ))
            .expect("inspection path update");
        state
            .runtime
            .block_on(db::append_capture_file(
                &state.database.connection,
                db::CaptureFileInput {
                    inspection_id: "INSP-CLEANUP".to_string(),
                    session_id: "SESSION-CLEANUP".to_string(),
                    material_id: "MAT-CLEANUP".to_string(),
                    camera_id: "CAM-01".to_string(),
                    camera_ip: "192.168.101.100".to_string(),
                    data_name: "depth".to_string(),
                    sequence_no: 1,
                    file_type: "bin".to_string(),
                    path: depth.display().to_string(),
                    metadata_path: metadata.display().to_string(),
                },
            ))
            .expect("capture file index");

        let previous = env::var("STEEL_ARTIFACT_ALLOWED_ROOTS").ok();
        env::set_var("STEEL_ARTIFACT_ALLOWED_ROOTS", &root);
        let detail = state
            .runtime
            .block_on(db::find_inspection_record_detail(
                &state.database.connection,
                "INSP-CLEANUP",
            ))
            .expect("cleanup detail")
            .expect("cleanup record");
        let manifest = artifact_cleanup::build_manifest(&detail, &root.display().to_string())
            .expect("cleanup manifest");
        let (files_planned, bytes_planned) = artifact_cleanup::manifest_plan_counts(&manifest);
        let cleanup = state
            .runtime
            .block_on(db::create_or_load_record_cleanup(
                &state.database.connection,
                db::RecordCleanupInput {
                    record_id: "INSP-CLEANUP".to_string(),
                    material_id: "MAT-CLEANUP".to_string(),
                    actor: "test-admin".to_string(),
                    reason: "retry-test".to_string(),
                    manifest_json: artifact_cleanup::manifest_json(&manifest)
                        .expect("manifest json"),
                    files_planned,
                    bytes_planned,
                },
            ))
            .expect("cleanup ledger");
        fs::write(&depth, b"other").expect("mutate frozen artifact");
        let failed_response = response_text(delete_admin_record_response(
            &state,
            "id=INSP-CLEANUP",
            "test-admin",
        ));
        assert!(
            failed_response.starts_with("HTTP/1.1 409 Conflict"),
            "{failed_response}"
        );
        assert!(depth.exists());
        assert!(state
            .runtime
            .block_on(db::find_production_inspection(
                &state.database.connection,
                "INSP-CLEANUP",
            ))
            .expect("inspection retained after failed cleanup")
            .is_some());
        let failed_cleanup = state
            .runtime
            .block_on(db::find_record_cleanup(
                &state.database.connection,
                &cleanup.id,
            ))
            .expect("failed cleanup lookup")
            .expect("failed cleanup row");
        assert_eq!(failed_cleanup.status, "failed");
        assert!(failed_cleanup.error.contains("changed"));

        fs::write(&depth, b"depth").expect("restore frozen artifact");
        let response = response_text(delete_admin_record_response(
            &state,
            "id=INSP-CLEANUP",
            "test-admin",
        ));
        if let Some(value) = previous {
            env::set_var("STEEL_ARTIFACT_ALLOWED_ROOTS", value);
        } else {
            env::remove_var("STEEL_ARTIFACT_ALLOWED_ROOTS");
        }

        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        let payload = response_json(response.into_bytes());
        assert_eq!(payload["filesDeleted"], json!(4));
        assert!(!depth.exists() && !metadata.exists() && !mesh.exists() && !summary.exists());
        assert!(state
            .runtime
            .block_on(db::find_production_inspection(
                &state.database.connection,
                "INSP-CLEANUP",
            ))
            .expect("inspection lookup")
            .is_none());
        let cleanup = state
            .runtime
            .block_on(db::find_record_cleanup(
                &state.database.connection,
                payload["cleanupId"].as_str().expect("cleanup id"),
            ))
            .expect("cleanup lookup")
            .expect("cleanup row");
        assert_eq!(cleanup.status, "completed");
        assert_eq!(cleanup.id, failed_cleanup.id);
        assert_eq!(cleanup.files_deleted, 4);
        assert!(!cleanup.completed_at.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn production_record_retention_excludes_active_and_recent_records() {
        let state = production_test_state();
        insert_production_record(
            &state,
            "INSP-OLD",
            "MAT-OLD",
            "SESSION-OLD",
            "finished",
            "algorithm-complete",
            "1",
        );
        insert_production_record(
            &state,
            "INSP-RECENT",
            "MAT-RECENT",
            "SESSION-RECENT",
            "finished",
            "algorithm-complete",
            &current_time_string(),
        );
        insert_production_record(
            &state,
            "INSP-ACTIVE",
            "MAT-ACTIVE",
            "SESSION-ACTIVE",
            "active",
            "algorithm-complete",
            "1",
        );
        let matched = state
            .runtime
            .block_on(db::count_inspection_records_before(
                &state.database.connection,
                1,
            ))
            .expect("retention preview");
        assert_eq!(matched, 1);
        let result = state
            .runtime
            .block_on(db::delete_inspection_records_before(
                &state.database.connection,
                1,
            ))
            .expect("retention purge");
        assert_eq!(result.matched, 1);
        assert_eq!(result.deleted_records, 1);
        assert_eq!(result.deleted_defects, 0);
        assert_eq!(result.deleted_capture_files, 0);
        assert!(state
            .runtime
            .block_on(db::find_production_inspection(
                &state.database.connection,
                "INSP-RECENT",
            ))
            .expect("recent query")
            .is_some());
        assert!(state
            .runtime
            .block_on(db::find_production_inspection(
                &state.database.connection,
                "INSP-ACTIVE",
            ))
            .expect("active query")
            .is_some());
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
    fn alarm_reads_are_public_but_state_changes_require_records_permission() {
        assert_eq!(permission_for_route("GET", "/api/alarms"), None);
        assert_eq!(
            permission_for_route("POST", "/api/alarms/acknowledge"),
            Some("admin.records")
        );
        assert_eq!(
            permission_for_route("POST", "/api/alarms/resolve"),
            Some("admin.records")
        );
    }

    #[test]
    fn radial_candidate_labels_do_not_claim_material_defect_classification() {
        let depression = json!({
            "classificationState": "candidate-only",
            "candidatePolarity": "depression"
        });
        let protrusion = json!({
            "classificationState": "candidate-only",
            "candidatePolarity": "protrusion"
        });
        assert_eq!(production_defect_label("pit", &depression), "凹陷候选");
        assert_eq!(production_defect_label("foreign", &protrusion), "凸起候选");
        assert_eq!(production_defect_label("pit", &json!({})), "凹坑");
    }

    #[test]
    fn severe_and_review_defect_ingest_create_one_idempotent_alarm() {
        let state = production_test_state();
        let severe = r#"{
            "materialId":"MAT-ALARM",
            "sessionId":"SESSION-ALARM",
            "inspectionId":"INSP-ALARM",
            "defectId":"SOURCE-DEFECT-001",
            "cameraId":"CAM-01",
            "defectType":"pit",
            "severity":"severe",
            "xMm":12.5,
            "yMm":6.25,
            "depthMm":0.21,
            "confidence":0.98
        }"#;
        let first = response_text(write_production_defect_response(&state, severe, "detector"));
        let duplicate = response_text(write_production_defect_response(&state, severe, "detector"));
        assert!(first.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(first.contains("\"created\":true"));
        assert!(duplicate.contains("\"created\":false"));

        let page = state
            .runtime
            .block_on(db::list_production_alarms(
                &state.database.connection,
                db::ProductionAlarmFilter {
                    status: Some("open".to_string()),
                    ..db::ProductionAlarmFilter::default()
                },
            ))
            .expect("alarm page");
        assert_eq!(page.total, 1);
        assert_eq!(page.alarms[0].severity, "severe");
        assert_eq!(page.alarms[0].status, "active");
        let list_response = response_text(read_production_alarms_response(
            &state,
            "status=open&severity=severe&keyword=MAT-ALARM&limit=10&offset=0",
        ));
        assert!(list_response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(list_response.contains("\"total\":1"));
        assert!(list_response.contains("\"alarms\":[{"));

        let review = severe
            .replace("SOURCE-DEFECT-001", "SOURCE-DEFECT-002")
            .replace("\"severity\":\"severe\"", "\"severity\":\"review\"");
        let review_response = response_text(write_production_defect_response(
            &state, &review, "detector",
        ));
        assert!(review_response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(review_response.contains("\"created\":true"));

        let minor = severe
            .replace("SOURCE-DEFECT-001", "SOURCE-DEFECT-003")
            .replace("\"severity\":\"severe\"", "\"severity\":\"minor\"");
        let minor_response =
            response_text(write_production_defect_response(&state, &minor, "detector"));
        assert!(minor_response.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(minor_response.contains("\"alarm\":null"));
        let counts = state
            .runtime
            .block_on(db::production_alarm_counts(&state.database.connection))
            .expect("alarm counts");
        assert_eq!(counts.active, 2);
        assert_eq!(counts.acknowledged, 0);
        assert_eq!(counts.resolved, 0);
    }

    #[test]
    fn alarm_transition_requires_acknowledgement_and_preserves_confirming_actor() {
        let state = production_test_state();
        let (alarm, created) = state
            .runtime
            .block_on(db::ensure_production_alarm(
                &state.database.connection,
                db::ProductionAlarmInput {
                    id: "ALARM-TRANSITION".to_string(),
                    source: "test".to_string(),
                    alarm_type: "camera-offline".to_string(),
                    severity: "review".to_string(),
                    material_id: "MAT-A".to_string(),
                    session_id: "SESSION-A".to_string(),
                    inspection_id: "INSP-A".to_string(),
                    camera_id: "CAM-01".to_string(),
                    message: "camera offline".to_string(),
                    details: "{}".to_string(),
                },
            ))
            .expect("insert alarm");
        assert!(created);
        assert_eq!(alarm.status, "active");

        let missing_note = response_text(write_production_alarm_action_response(
            &state,
            r#"{"alarmId":"ALARM-TRANSITION","note":""}"#,
            "operator-a",
            ProductionAlarmAction::Acknowledge,
        ));
        assert!(missing_note.starts_with("HTTP/1.1 400 Bad Request\r\n"));
        assert!(missing_note.contains("alarm_note_required"));

        let premature = response_text(write_production_alarm_action_response(
            &state,
            r#"{"alarmId":"ALARM-TRANSITION","note":"fixed"}"#,
            "operator-b",
            ProductionAlarmAction::Resolve,
        ));
        assert!(premature.starts_with("HTTP/1.1 409 Conflict\r\n"));
        assert!(premature.contains("alarm_acknowledgement_required"));

        let acknowledged = response_text(write_production_alarm_action_response(
            &state,
            r#"{"alarmId":"ALARM-TRANSITION","note":"checked on line"}"#,
            "operator-a",
            ProductionAlarmAction::Acknowledge,
        ));
        assert!(acknowledged.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(acknowledged.contains("\"changed\":true"));
        assert!(acknowledged.contains("\"acknowledgedBy\":\"operator-a\""));

        let repeated = response_text(write_production_alarm_action_response(
            &state,
            r#"{"alarmId":"ALARM-TRANSITION","note":"overwrite attempt"}"#,
            "operator-b",
            ProductionAlarmAction::Acknowledge,
        ));
        assert!(repeated.contains("\"changed\":false"));
        assert!(repeated.contains("\"acknowledgedBy\":\"operator-a\""));
        assert!(!repeated.contains("overwrite attempt"));

        let resolved = response_text(write_production_alarm_action_response(
            &state,
            r#"{"alarmId":"ALARM-TRANSITION","note":"root cause removed"}"#,
            "operator-b",
            ProductionAlarmAction::Resolve,
        ));
        assert!(resolved.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(resolved.contains("\"status\":\"resolved\""));
        assert!(resolved.contains("\"resolvedBy\":\"operator-b\""));

        let history = state
            .runtime
            .block_on(db::list_production_alarms(
                &state.database.connection,
                db::ProductionAlarmFilter {
                    status: Some("history".to_string()),
                    keyword: Some("ALARM-TRANSITION".to_string()),
                    ..db::ProductionAlarmFilter::default()
                },
            ))
            .expect("alarm history");
        assert_eq!(history.total, 1);
        assert_eq!(history.alarms[0].acknowledged_by, "operator-a");
        assert_eq!(history.alarms[0].resolved_by, "operator-b");
    }

    #[test]
    fn managed_health_alarm_is_one_episode_until_recovery_and_reopens_with_a_new_id() {
        let state = production_test_state();
        let input = |id: &str, message: &str, details: &str| db::ProductionAlarmInput {
            id: id.to_string(),
            source: SYSTEM_HEALTH_ALARM_SOURCE.to_string(),
            alarm_type: "storage-capacity-warning".to_string(),
            severity: "warning".to_string(),
            material_id: String::new(),
            session_id: String::new(),
            inspection_id: String::new(),
            camera_id: String::new(),
            message: message.to_string(),
            details: details.to_string(),
        };

        let created = state
            .runtime
            .block_on(db::reconcile_managed_alarm(
                &state.database.connection,
                SYSTEM_HEALTH_ALARM_SOURCE,
                "storage-capacity-warning",
                Some(input(
                    "ALARM-HEALTH-EPISODE-1",
                    "30 GiB remaining",
                    r#"{"free":30}"#,
                )),
                SYSTEM_HEALTH_ALARM_ACTOR,
            ))
            .expect("create managed alarm");
        let first_id = match created {
            db::ManagedAlarmReconcile::Created(alarm) => alarm.id,
            _ => panic!("first unhealthy observation must create an alarm"),
        };

        let refreshed = state
            .runtime
            .block_on(db::reconcile_managed_alarm(
                &state.database.connection,
                SYSTEM_HEALTH_ALARM_SOURCE,
                "storage-capacity-warning",
                Some(input(
                    "ALARM-HEALTH-IGNORED",
                    "24 GiB remaining",
                    r#"{"free":24}"#,
                )),
                SYSTEM_HEALTH_ALARM_ACTOR,
            ))
            .expect("refresh managed alarm");
        match refreshed {
            db::ManagedAlarmReconcile::Updated(alarm) => {
                assert_eq!(alarm.id, first_id);
                assert_eq!(alarm.message, "24 GiB remaining");
                assert_eq!(alarm.details, r#"{"free":24}"#);
            }
            _ => panic!("ongoing episode must refresh the original alarm"),
        }

        let acknowledged = state
            .runtime
            .block_on(db::acknowledge_production_alarm(
                &state.database.connection,
                &first_id,
                "operator-a",
                "cleanup scheduled",
            ))
            .expect("acknowledge managed alarm");
        assert!(matches!(
            acknowledged,
            db::ProductionAlarmTransition::Changed(_)
        ));

        let recovered = state
            .runtime
            .block_on(db::reconcile_managed_alarm(
                &state.database.connection,
                SYSTEM_HEALTH_ALARM_SOURCE,
                "storage-capacity-warning",
                None,
                SYSTEM_HEALTH_ALARM_ACTOR,
            ))
            .expect("resolve recovered managed alarm");
        match recovered {
            db::ManagedAlarmReconcile::Resolved(alarm) => {
                assert_eq!(alarm.id, first_id);
                assert_eq!(alarm.status, "resolved");
                assert_eq!(alarm.acknowledged_by, "operator-a");
                assert_eq!(alarm.resolved_by, SYSTEM_HEALTH_ALARM_ACTOR);
            }
            _ => panic!("recovery must resolve the open episode"),
        }

        let recurrence = state
            .runtime
            .block_on(db::reconcile_managed_alarm(
                &state.database.connection,
                SYSTEM_HEALTH_ALARM_SOURCE,
                "storage-capacity-warning",
                Some(input(
                    "ALARM-HEALTH-EPISODE-2",
                    "28 GiB remaining",
                    r#"{"free":28}"#,
                )),
                SYSTEM_HEALTH_ALARM_ACTOR,
            ))
            .expect("create recurring managed alarm");
        match recurrence {
            db::ManagedAlarmReconcile::Created(alarm) => {
                assert_ne!(alarm.id, first_id);
                assert_eq!(alarm.status, "active");
            }
            _ => panic!("a recurring incident must create a new history episode"),
        }

        let counts = state
            .runtime
            .block_on(db::production_alarm_counts(&state.database.connection))
            .expect("managed alarm counts");
        assert_eq!(counts.active, 1);
        assert_eq!(counts.acknowledged, 0);
        assert_eq!(counts.resolved, 1);
    }

    #[test]
    fn system_health_alarm_mapping_separates_warning_critical_and_blocking_components() {
        let warning = json!({
            "checks": {
                "storage": {
                    "ok": true,
                    "status": "warning",
                    "level": "warning",
                    "warningReason": "storage_capacity_near_watermark",
                    "freeBytes": 30_000_000_000_u64,
                    "freePercent": 12.0,
                    "estimatedRemainingSeconds": 300
                }
            }
        });
        let warning_specs = system_health_alarm_specs(&warning);
        assert_eq!(warning_specs.len(), 1);
        assert_eq!(warning_specs[0].alarm_type, "storage-capacity-warning");
        assert_eq!(warning_specs[0].severity, "warning");

        let critical = json!({
            "checks": {
                "storage": {
                    "ok": false,
                    "status": "unavailable",
                    "level": "critical",
                    "reason": "storage_capacity_below_watermark",
                    "freeBytes": 10_000_000_000_u64,
                    "freePercent": 5.0
                }
            }
        });
        let critical_specs = system_health_alarm_specs(&critical);
        assert_eq!(critical_specs.len(), 1);
        assert_eq!(critical_specs[0].alarm_type, "storage-critical");
        assert_eq!(critical_specs[0].severity, "critical");

        let blocking = json!({
            "checks": {
                "capture": {
                    "ok": false,
                    "reason": "capture_sdk_restart_required",
                    "restartRequired": true
                },
                "taskWorker": {
                    "ok": false,
                    "reason": "task_worker_heartbeat_stale"
                },
                "calibrationReconciliation": {
                    "ok": false,
                    "reason": "calibration_reconciliation_required",
                    "unresolvedCount": 1,
                    "unresolvedOperations": [{"operationId": "CAL-1"}]
                },
                "trigger": {
                    "ok": false,
                    "required": true,
                    "reason": "trigger_gateway_unreachable"
                },
                "algorithm": {
                    "ok": false,
                    "reason": "algorithm_acceptance_missing_or_invalid"
                },
                "productionPolicy": {
                    "ok": false,
                    "reason": "production_algorithm_policy_invalid"
                }
            }
        });
        let types = system_health_alarm_specs(&blocking)
            .into_iter()
            .map(|spec| spec.alarm_type)
            .collect::<HashSet<_>>();
        assert_eq!(
            types,
            HashSet::from([
                "capture-unavailable",
                "task-worker-unavailable",
                "calibration-reconciliation-required",
                "trigger-unavailable",
                "algorithm-not-qualified",
                "production-policy-invalid"
            ])
        );

        let optional_trigger = json!({
            "checks": {
                "trigger": {
                    "ok": false,
                    "required": false,
                    "reason": "trigger_gateway_unreachable"
                }
            }
        });
        assert!(system_health_alarm_specs(&optional_trigger).is_empty());
    }

    #[test]
    fn supervisor_restart_budget_status_is_validated_and_mapped_to_a_persistent_alarm() {
        let root = std::env::temp_dir().join(format!(
            "steel-supervisor-status-{}-{}",
            std::process::id(),
            current_time_millis()
        ));
        let service_root = root.join("service");
        fs::create_dir_all(&service_root).expect("create supervisor status root");
        let status_path = service_root.join("supervisor-status.json");
        fs::write(
            &status_path,
            r#"{
                "schema":"steel.runtime-supervisor.status.v1",
                "status":"restart-budget-exhausted",
                "restartBudgetExhausted":true,
                "restartCountWindow":6,
                "restartBudgetMaximum":5,
                "restartBudgetWindowSeconds":600,
                "recoveryStableSeconds":30,
                "reason":"more_than_5_restarts_in_10_minutes",
                "updatedAt":"2026-07-16T10:00:00.000Z"
            }"#,
        )
        .expect("write supervisor status");

        let status = supervisor_runtime_status_from_root(Some(&root))
            .expect("valid supervisor status")
            .expect("supervisor status present");
        let specs =
            system_health_alarm_specs_with_supervisor(&json!({"checks": {}}), Ok(Some(status)));
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].alarm_type, "supervisor-restart-budget-exhausted");
        assert_eq!(specs[0].severity, "critical");
        assert_eq!(specs[0].details["restartCountWindow"], json!(6));

        fs::write(&status_path, r#"{"schema":"wrong","status":"running"}"#)
            .expect("write invalid supervisor status");
        let invalid = supervisor_runtime_status_from_root(Some(&root))
            .expect_err("invalid status contract must fail");
        let invalid_specs =
            system_health_alarm_specs_with_supervisor(&json!({"checks": {}}), Err(invalid));
        assert_eq!(invalid_specs.len(), 1);
        assert_eq!(invalid_specs[0].alarm_type, "supervisor-status-invalid");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn system_health_alarm_reconciliation_persists_and_auto_resolves_the_episode() {
        let state = production_test_state();
        let warning = json!({
            "checks": {
                "storage": {
                    "ok": true,
                    "status": "warning",
                    "level": "warning",
                    "warningReason": "storage_capacity_near_watermark",
                    "freeBytes": 30_000_000_000_u64,
                    "freePercent": 12.0
                }
            }
        });
        let created =
            reconcile_system_health_alarms(&state, &warning).expect("persist health alarm");
        assert_eq!(created.len(), 1);
        assert!(created[0].starts_with("created:ALARM-HEALTH-"));

        let open = state
            .runtime
            .block_on(db::list_production_alarms(
                &state.database.connection,
                db::ProductionAlarmFilter {
                    status: Some("open".to_string()),
                    source: Some(SYSTEM_HEALTH_ALARM_SOURCE.to_string()),
                    ..db::ProductionAlarmFilter::default()
                },
            ))
            .expect("open health alarms");
        assert_eq!(open.total, 1);
        assert_eq!(open.alarms[0].alarm_type, "storage-capacity-warning");

        let healthy = json!({
            "checks": {
                "storage": {
                    "ok": true,
                    "status": "up",
                    "level": "ok"
                }
            }
        });
        let resolved =
            reconcile_system_health_alarms(&state, &healthy).expect("resolve health alarm");
        assert_eq!(resolved.len(), 1);
        assert!(resolved[0].starts_with("resolved:ALARM-HEALTH-"));

        let history = state
            .runtime
            .block_on(db::list_production_alarms(
                &state.database.connection,
                db::ProductionAlarmFilter {
                    status: Some("history".to_string()),
                    source: Some(SYSTEM_HEALTH_ALARM_SOURCE.to_string()),
                    ..db::ProductionAlarmFilter::default()
                },
            ))
            .expect("health alarm history");
        assert_eq!(history.total, 1);
        assert_eq!(history.alarms[0].status, "resolved");
        assert_eq!(history.alarms[0].acknowledged_by, SYSTEM_HEALTH_ALARM_ACTOR);
        assert_eq!(history.alarms[0].resolved_by, SYSTEM_HEALTH_ALARM_ACTOR);
    }

    #[test]
    fn calibration_capture_fit_requires_one_complete_frame_from_each_of_eight_cameras() {
        let root = std::env::temp_dir().join(format!(
            "steel-calibration-capture-summary-{}-{}",
            std::process::id(),
            current_time_millis()
        ));
        fs::create_dir_all(&root).expect("create calibration capture test directory");
        let summary_path = root.join("summary.json");
        fs::write(&summary_path, "{}").expect("write calibration capture summary");
        let results = (1..=8)
            .map(|index| {
                json!({
                    "code": 0,
                    "ip": format!("192.168.200.{index}"),
                    "completeFrame": true,
                    "metadataOutput": root.join(format!("camera-{index}.json")).display().to_string()
                })
            })
            .collect::<Vec<_>>();
        let complete = json!({
            "code": 0,
            "successes": 8,
            "failures": 0,
            "completeFrames": 8,
            "metadataFrames": 8,
            "summaryOutput": summary_path.display().to_string(),
            "results": results
        });
        assert_eq!(
            calibration_capture_data_dir(&complete, 8).expect("complete capture"),
            root
        );

        let mut incomplete = complete;
        incomplete["metadataFrames"] = json!(7);
        let error = calibration_capture_data_dir(&incomplete, 8)
            .expect_err("incomplete calibration capture must fail");
        assert_eq!(error["error"], "calibration_capture_incomplete");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn calibration_capture_fit_rejects_service_only_simulated_artifacts() {
        let simulated = json!({
            "code": 0,
            "successes": 8,
            "failures": 0,
            "completeFrames": 8,
            "metadataFrames": 8,
            "summaryOutput": "simulated://calibration/summary.json",
            "results": (1..=8).map(|index| json!({
                "code": 0,
                "ip": format!("192.168.200.{index}"),
                "completeFrame": true,
                "metadataOutput": format!("simulated://camera-{index}.json")
            })).collect::<Vec<_>>()
        });
        let error = calibration_capture_data_dir(&simulated, 8)
            .expect_err("non-file simulated capture must not enter fitter");
        assert_eq!(error["error"], "calibration_capture_artifacts_unavailable");
    }

    #[test]
    fn algorithm_mock_defects_default_off_and_are_rejected_by_production_policy() {
        assert!(!synthetic_algorithm_fixtures_allowed("production", "demo"));
        assert!(!synthetic_algorithm_fixtures_allowed(
            "development",
            "validation"
        ));
        assert!(synthetic_algorithm_fixtures_allowed("development", "demo"));
        assert_eq!(
            algorithm_mock_defect_count(&json!({}), false).expect("default mock count"),
            0
        );
        assert_eq!(
            algorithm_mock_defect_count(&json!({ "mockDefectCount": 4 }), false)
                .expect("explicit development fixture"),
            4
        );
        let error = algorithm_mock_defect_count(&json!({ "mockDefectCount": 1 }), true)
            .expect_err("production policy must reject synthetic defects");
        assert_eq!(error["error"], "synthetic_defects_forbidden_in_production");
    }

    #[test]
    fn algorithm_runtime_configuration_reports_one_active_source_of_truth() {
        let configuration = algorithm_runtime_configuration();
        assert_eq!(configuration["schema"], "steel.algorithm-runtime-config.v1");
        for key in ["captureRoot", "algorithmRoot", "algorithmConfig"] {
            let desired = configuration["desired"][key]
                .as_str()
                .expect("desired configuration path");
            let active = configuration["active"][key]
                .as_str()
                .expect("active configuration path");
            assert!(!desired.trim().is_empty());
            assert_eq!(desired, active);
        }
        assert_eq!(configuration["readback"]["configValid"], true);
        assert!(configuration["active"]["configRevision"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        assert!(configuration["active"]["configSha256"]
            .as_str()
            .is_some_and(|value| value.len() == 64));
        assert_eq!(
            configuration["readback"]["ready"],
            json!(
                configuration["readback"]["configValid"] == true
                    && configuration["readback"]["algorithmRootExists"] == true
                    && configuration["readback"]["captureRootExists"] == true
                    && configuration["readback"]["paths"]["algorithmCalibration"]["ready"] == true
            )
        );
        assert!(configuration["readback"]["paths"]["algorithmConfig"]["ready"] == true);
    }

    #[test]
    fn production_algorithm_paths_cannot_override_the_active_configuration() {
        let configured_request = json!({
            "captureRoot": bar_surface_capture_root().display().to_string(),
            "outputRoot": algorithm_data_root().display().to_string()
        });
        assert_eq!(
            production_algorithm_request_config_error(&configured_request),
            None
        );
        assert_eq!(
            production_algorithm_request_config_error(&json!({
                "outputRoot": algorithm_data_root().join("alternate").display().to_string()
            })),
            Some("production_algorithm_path_override_forbidden")
        );

        let test_root = env::temp_dir().join(format!(
            "steel-algorithm-runtime-path-test-{}",
            current_time_millis()
        ));
        fs::create_dir_all(&test_root).expect("runtime path fixture");
        let directory = runtime_path_readback(&test_root, "directory");
        assert_eq!(directory["ready"], true);
        let missing = runtime_path_readback(&test_root.join("missing"), "directory");
        assert_eq!(missing["ready"], false);
        let _ = fs::remove_dir_all(test_root);
    }

    #[test]
    fn production_algorithm_policy_detects_declared_or_embedded_synthetic_output() {
        assert_eq!(algorithm_synthetic_defect_count(&json!({})), 0);
        assert_eq!(
            algorithm_synthetic_defect_count(&json!({
                "result": { "manifest": { "detection": {
                    "syntheticDefectCount": 3,
                    "defects": []
                } } }
            })),
            3
        );
        assert_eq!(
            algorithm_synthetic_defect_count(&json!({
                "result": { "manifest": { "detection": {
                    "syntheticDefectCount": 0,
                    "defects": [
                        { "geometry": { "synthetic": false } },
                        { "geometry": { "synthetic": true } }
                    ]
                } } }
            })),
            1
        );
    }

    #[test]
    fn production_algorithm_traceability_requires_identity_hashes_inputs_thresholds_and_gate() {
        let sha = "a".repeat(64);
        let artifact = json!({
            "camera": "camera1",
            "frameId": "frame-001",
            "kind": "depth",
            "path": r"H:\camera1\plate\depth\frame-001.png",
            "bytes": 42,
            "sha256": "d".repeat(64)
        });
        let input_summary =
            canonical_value_sha256(&json!([artifact.clone()])).expect("canonical input hash");
        assert_eq!(
            input_summary,
            "eaf4f395409243cfebeadb938c63b5b64afeec6e3162c27b7e188e09b0441a53"
        );
        let valid = json!({
            "result": { "manifest": {
                "algorithmName": "bar-surface-defect-detector",
                "algorithmVersion": "bar-surface-radial-residual-1.0.0",
                "configRevision": "ALGCFG-1",
                "configSha256": sha,
                "calibrationRevision": "CAL-1",
                "calibrationSha256": "b".repeat(64),
                "scriptSha256": "e".repeat(64),
                "coreSha256": "f".repeat(64),
                "acceptanceReportSha256": "1".repeat(64),
                "datasetRevision": "DATASET-1",
                "datasetSha256": "2".repeat(64),
                "evaluatorRevision": "EVALUATOR-1",
                "evaluatorSha256": "3".repeat(64),
                "releaseCommit": "4".repeat(40),
                "inputSummarySha256": input_summary,
                "inputFrameIds": ["frame-001"],
                "inputArtifactCount": 1,
                "inputArtifacts": [artifact],
                "thresholds": {
                    "meshRows": 144,
                    "meshColsPerCamera": 72,
                    "radiusMm": 75.0,
                    "radialScaleMm": 8.0,
                    "maxFaceEdgeMm": 8.0,
                    "contourRadiusToleranceMm": 0.0,
                    "contourMinKeepRatio": 0.55,
                    "contourMinRowCoverage": 0.25,
                    "contourAutoPercentile": 96.0,
                    "defectMinDepthMm": 0.35,
                    "defectMinAreaPoints": 6
                },
                "qualityGate": { "passed": true, "reasons": [] },
                "core": { "available": true, "summary": { "outputBytes": 128 } },
                "realDefectCount": 0,
                "syntheticDefectCount": 0
            }}
        });
        assert_eq!(
            algorithm_traceability_structure_error(&valid["result"]["manifest"]),
            None
        );

        let mut bad_hash = valid.clone();
        bad_hash["result"]["manifest"]["inputSummarySha256"] = json!("not-a-hash");
        assert_eq!(
            algorithm_traceability_structure_error(&bad_hash["result"]["manifest"]),
            Some("algorithm_traceability_sha256_missing".to_string())
        );

        let mut failed_gate = valid;
        failed_gate["result"]["manifest"]["qualityGate"]["passed"] = json!(false);
        assert_eq!(
            algorithm_traceability_structure_error(&failed_gate["result"]["manifest"]),
            Some("algorithm_quality_gate_failed".to_string())
        );
    }

    #[test]
    fn automatic_calibration_activation_requires_target_quality_and_opt_in() {
        assert_eq!(
            automatic_calibration_activation_decision(
                &json!({ "targetDetection": { "detected": false }, "correctionAccepted": true }),
                true,
            ),
            (false, true, "calibration_target_not_detected")
        );
        assert_eq!(
            automatic_calibration_activation_decision(
                &json!({ "targetDetection": { "detected": true }, "correctionAccepted": false }),
                true,
            ),
            (true, false, "correction_quality_gate_failed")
        );
        assert_eq!(
            automatic_calibration_activation_decision(
                &json!({ "targetDetection": { "detected": true }, "correctionAccepted": true }),
                false,
            ),
            (true, true, "automatic_activation_disabled")
        );
        assert_eq!(
            automatic_calibration_activation_decision(
                &json!({ "targetDetection": { "detected": true }, "correctionAccepted": true }),
                true,
            ),
            (true, true, "pending")
        );
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
