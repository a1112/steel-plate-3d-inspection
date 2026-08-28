use crate::service_supervisor::{
    ServiceLifecycleEvent, ServiceSupervisor, SupervisorServiceSnapshot, SupervisorSnapshot,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, State};

const TRAY_ID: &str = "background-monitor-tray";
const MENU_STATUS: &str = "background-monitor-status";
const MENU_TASKS: &str = "background-monitor-tasks";
const MENU_ISSUES: &str = "background-monitor-issues";
const MENU_OPEN_MONITOR: &str = "background-monitor-open";
const MENU_HIDE_WINDOWS: &str = "background-monitor-hide";
const MENU_QUIT: &str = "background-monitor-quit";
const MONITOR_EVENT: &str = "background-monitor-updated";
pub(crate) const MONITOR_WINDOW: &str = "background-monitor";
const DEFAULT_ORIGIN: &str = "http://127.0.0.1:4873";
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const REQUEST_TIMEOUT: Duration = Duration::from_millis(1_800);
const MAX_HTTP_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_TASKS: usize = 16;
const MAX_LOG_TAIL_CHARS: usize = 64 * 1024;
const RECENT_FAILURE_WINDOW_MS: u64 = 30 * 60 * 1000;
const RETIRED_SERVICE_IDS: [&str; 1] = ["bkv-adapter"];
const CONTROL_SERVER_ADDRESS: &str = "127.0.0.1:4899";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundTaskSnapshot {
    pub task_id: String,
    pub kind: String,
    pub material_id: String,
    pub status: String,
    pub phase: String,
    pub progress: f64,
    pub updated_at: String,
    pub error: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundMonitorService {
    pub id: String,
    pub name: String,
    pub role: String,
    pub kind: String,
    pub origin: String,
    pub port: u16,
    pub health_path: String,
    pub ok: bool,
    pub required: bool,
    pub status: String,
    pub response_status: u16,
    pub latency_ms: u64,
    pub uptime_ms: Option<u64>,
    pub reason: Option<String>,
    pub lifecycle: Option<Value>,
    pub operations: Vec<Value>,
    pub control: Option<Value>,
    pub startup_mode: String,
    pub auto_restart: bool,
    pub managed: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundMonitorLog {
    pub name: String,
    pub service_id: Option<String>,
    pub service_name: Option<String>,
    pub bytes: u64,
    pub modified_at: String,
    pub tail: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundMonitorRuntime {
    pub state_root: Option<String>,
    pub log_root: String,
    pub task_worker: Option<Value>,
    pub supervisor: Option<Value>,
}

#[derive(Default)]
struct RuntimePayloadSnapshots {
    services: Vec<BackgroundMonitorService>,
    logs: Vec<BackgroundMonitorLog>,
    runtime: Option<BackgroundMonitorRuntime>,
    registry: Option<Value>,
    monitor_protocol: Option<Value>,
    degraded: bool,
    failed_required_services: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundMonitorSnapshot {
    pub schema: &'static str,
    pub state: &'static str,
    pub origin: String,
    pub service_available: bool,
    pub service_ready: bool,
    pub worker_running: bool,
    pub queue_depth: u64,
    pub active_tasks: u64,
    pub failed_tasks: u64,
    pub blocked_tasks: u64,
    pub active_task_id: Option<String>,
    pub detail: String,
    pub updated_at_unix_ms: u64,
    pub tasks: Vec<BackgroundTaskSnapshot>,
    pub services: Vec<BackgroundMonitorService>,
    pub logs: Vec<BackgroundMonitorLog>,
    pub lifecycle_logs: Vec<ServiceLifecycleEvent>,
    pub runtime: Option<BackgroundMonitorRuntime>,
    pub registry: Option<Value>,
    pub monitor_protocol: Option<Value>,
    pub service_count: u64,
    pub healthy_service_count: u64,
}

impl Default for BackgroundMonitorSnapshot {
    fn default() -> Self {
        Self {
            schema: "steel.tauri-background-monitor.v1",
            state: "initializing",
            origin: DEFAULT_ORIGIN.to_string(),
            service_available: false,
            service_ready: false,
            worker_running: false,
            queue_depth: 0,
            active_tasks: 0,
            failed_tasks: 0,
            blocked_tasks: 0,
            active_task_id: None,
            detail: "正在连接后台检测服务".to_string(),
            updated_at_unix_ms: unix_time_millis(),
            tasks: Vec::new(),
            services: Vec::new(),
            logs: Vec::new(),
            lifecycle_logs: Vec::new(),
            runtime: None,
            registry: None,
            monitor_protocol: None,
            service_count: 0,
            healthy_service_count: 0,
        }
    }
}

#[derive(Clone)]
struct TrayUi {
    tray: TrayIcon,
    status: MenuItem<tauri::Wry>,
    tasks: MenuItem<tauri::Wry>,
    issues: MenuItem<tauri::Wry>,
}

pub(crate) struct BackgroundMonitorState {
    snapshot: Mutex<BackgroundMonitorSnapshot>,
    origin: Mutex<String>,
    tray: Mutex<Option<TrayUi>>,
    exiting: AtomicBool,
    refresh_requested: AtomicBool,
    supervisor: Mutex<ServiceSupervisor>,
}

impl Default for BackgroundMonitorState {
    fn default() -> Self {
        let origin = std::env::var("INSPECTION_SERVICE_ORIGIN")
            .ok()
            .and_then(|value| normalize_monitor_origin(&value).ok())
            .unwrap_or_else(|| DEFAULT_ORIGIN.to_string());
        let snapshot = BackgroundMonitorSnapshot {
            origin: origin.clone(),
            ..BackgroundMonitorSnapshot::default()
        };
        Self {
            snapshot: Mutex::new(snapshot),
            origin: Mutex::new(origin),
            tray: Mutex::new(None),
            exiting: AtomicBool::new(false),
            refresh_requested: AtomicBool::new(true),
            supervisor: Mutex::new(ServiceSupervisor::load()),
        }
    }
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value.trim().chars().take(max_chars).collect()
}

fn normalize_monitor_origin(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    let authority = trimmed
        .strip_prefix("http://")
        .ok_or_else(|| "后台托盘监控仅支持 http 服务地址".to_string())?;
    if authority.is_empty()
        || authority.contains(['/', '\\', '@', '?', '#', '\r', '\n'])
        || authority.chars().any(char::is_whitespace)
    {
        return Err("后台托盘监控服务地址无效".to_string());
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => {
            let parsed = port
                .parse::<u16>()
                .ok()
                .filter(|value| *value > 0)
                .ok_or_else(|| "后台托盘监控服务端口无效".to_string())?;
            (host, parsed)
        }
        None => (authority, 80),
    };
    if host.is_empty()
        || !host
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-'))
    {
        return Err("后台托盘监控服务主机无效".to_string());
    }
    let host = host.to_ascii_lowercase();
    if !matches!(host.as_str(), "127.0.0.1" | "localhost") {
        return Err("后台托盘监控仅允许连接服务器本机回环地址".to_string());
    }
    Ok(format!("http://{host}:{port}"))
}

fn monitor_origin_endpoint(origin: &str) -> Result<(String, u16), String> {
    let normalized = normalize_monitor_origin(origin)?;
    let authority = normalized
        .strip_prefix("http://")
        .ok_or_else(|| "monitor_origin_invalid".to_string())?;
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| "monitor_origin_invalid".to_string())?;
    Ok((
        host.to_string(),
        port.parse::<u16>()
            .map_err(|_| "monitor_origin_invalid".to_string())?,
    ))
}

fn remaining_timeout(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| "monitor_request_timeout".to_string())
}

fn bounded_json_get(origin: &str, path: &str) -> Result<(u16, Value), String> {
    let (host, port) = monitor_origin_endpoint(origin)?;
    let deadline = Instant::now()
        .checked_add(REQUEST_TIMEOUT)
        .ok_or_else(|| "monitor_request_timeout".to_string())?;
    let addresses = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|_| "monitor_service_unreachable".to_string())?;
    let mut stream = None;
    for address in addresses {
        let remaining = remaining_timeout(deadline)?;
        if let Ok(candidate) = TcpStream::connect_timeout(&address, remaining) {
            stream = Some(candidate);
            break;
        }
    }
    let mut stream = stream.ok_or_else(|| "monitor_service_unreachable".to_string())?;
    stream
        .set_read_timeout(Some(remaining_timeout(deadline)?))
        .map_err(|_| "monitor_request_timeout".to_string())?;
    stream
        .set_write_timeout(Some(remaining_timeout(deadline)?))
        .map_err(|_| "monitor_request_timeout".to_string())?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "monitor_service_unreachable".to_string())?;

    let mut response = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        stream
            .set_read_timeout(Some(remaining_timeout(deadline)?))
            .map_err(|_| "monitor_request_timeout".to_string())?;
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                response.extend_from_slice(&buffer[..count]);
                if response.len() > MAX_HTTP_RESPONSE_BYTES {
                    return Err("monitor_response_too_large".to_string());
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                return Err("monitor_request_timeout".to_string())
            }
            Err(_) => return Err("monitor_response_invalid".to_string()),
        }
    }
    parse_json_http_response(&response)
}

fn parse_json_http_response(response: &[u8]) -> Result<(u16, Value), String> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "monitor_response_invalid".to_string())?;
    let header = std::str::from_utf8(&response[..separator])
        .map_err(|_| "monitor_response_invalid".to_string())?;
    let status = header
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "monitor_response_invalid".to_string())?;
    let body = response
        .get(separator + 4..)
        .ok_or_else(|| "monitor_response_invalid".to_string())?;
    let value = serde_json::from_slice(body).map_err(|_| "monitor_response_invalid".to_string())?;
    Ok((status, value))
}

fn task_snapshot(value: &Value) -> Option<BackgroundTaskSnapshot> {
    let task_id = value
        .get("taskId")
        .or_else(|| value.get("id"))
        .and_then(Value::as_str)
        .map(|value| bounded_text(value, 96))
        .filter(|value| !value.is_empty())?;
    Some(BackgroundTaskSnapshot {
        task_id,
        kind: bounded_text(
            value
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            48,
        ),
        material_id: bounded_text(
            value
                .get("materialId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            64,
        ),
        status: bounded_text(
            value
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            32,
        )
        .to_ascii_lowercase(),
        phase: bounded_text(
            value
                .get("phase")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            64,
        ),
        progress: value
            .get("progress")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .unwrap_or(0.0)
            .clamp(0.0, 1.0),
        updated_at: bounded_text(
            value
                .get("updatedAt")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            64,
        ),
        error: bounded_text(
            value
                .get("error")
                .and_then(Value::as_str)
                .or_else(|| value.get("blockedReason").and_then(Value::as_str))
                .unwrap_or_default(),
            240,
        ),
    })
}

fn value_text(value: &Value, key: &str, fallback: &str, max_chars: usize) -> String {
    bounded_text(
        value.get(key).and_then(Value::as_str).unwrap_or(fallback),
        max_chars,
    )
}

fn value_u64(value: &Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(|item| item.as_u64().or_else(|| item.as_str()?.parse().ok()))
        .unwrap_or(0)
}

fn service_snapshot(value: &Value) -> Option<BackgroundMonitorService> {
    let id = value_text(value, "id", "", 96);
    if id.is_empty() {
        return None;
    }
    let origin = value_text(value, "origin", "", 180);
    let health_path = value_text(value, "healthPath", "/api/health/live", 160);
    let response_status = value_u64(value, "responseStatus").min(u64::from(u16::MAX)) as u16;
    let port = value_u64(value, "port").min(u64::from(u16::MAX)) as u16;
    let reason = value
        .get("reason")
        .and_then(Value::as_str)
        .map(|item| bounded_text(item, 240))
        .filter(|item| !item.is_empty());
    Some(BackgroundMonitorService {
        id,
        name: value_text(value, "name", "未命名服务", 160),
        role: value_text(value, "role", "service", 96),
        kind: value_text(value, "kind", "probe", 48),
        origin,
        port,
        health_path,
        ok: value.get("ok").and_then(Value::as_bool).unwrap_or(false),
        required: value
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        status: value_text(value, "status", "unknown", 48),
        response_status,
        latency_ms: value_u64(value, "latencyMs"),
        uptime_ms: value
            .get("uptimeMs")
            .and_then(|item| item.as_u64().or_else(|| item.as_str()?.parse().ok())),
        reason,
        lifecycle: value.get("lifecycle").cloned(),
        operations: value
            .get("operations")
            .and_then(Value::as_array)
            .map(|items| items.iter().take(16).cloned().collect())
            .unwrap_or_default(),
        control: value.get("control").cloned(),
        startup_mode: value_text(value, "startupMode", "manual", 32),
        auto_restart: value
            .get("autoRestart")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        managed: value
            .get("managed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn log_snapshot(value: &Value) -> Option<BackgroundMonitorLog> {
    let name = value_text(value, "name", "", 180);
    if name.is_empty() {
        return None;
    }
    let optional_text = |key: &str, max_chars: usize| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(|item| bounded_text(item, max_chars))
            .filter(|item| !item.is_empty())
    };
    Some(BackgroundMonitorLog {
        name,
        service_id: optional_text("serviceId", 96),
        service_name: optional_text("serviceName", 160),
        bytes: value_u64(value, "bytes"),
        modified_at: value_text(value, "modifiedAt", "", 64),
        tail: value_text(value, "tail", "", MAX_LOG_TAIL_CHARS),
        truncated: value
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn runtime_snapshot(value: &Value) -> Option<BackgroundMonitorRuntime> {
    let runtime = value.get("runtime")?.as_object()?;
    Some(BackgroundMonitorRuntime {
        state_root: runtime
            .get("stateRoot")
            .and_then(Value::as_str)
            .map(|item| bounded_text(item, 260)),
        log_root: runtime
            .get("logRoot")
            .and_then(Value::as_str)
            .map(|item| bounded_text(item, 260))
            .unwrap_or_default(),
        task_worker: runtime.get("taskWorker").cloned(),
        supervisor: runtime.get("supervisor").cloned(),
    })
}

fn runtime_payload_snapshots(value: Option<&Value>) -> RuntimePayloadSnapshots {
    let Some(value) = value else {
        return RuntimePayloadSnapshots::default();
    };
    let services = value
        .get("services")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(service_snapshot)
        .filter(|service| !RETIRED_SERVICE_IDS.contains(&service.id.as_str()))
        .take(32)
        .collect::<Vec<_>>();
    let logs = value
        .get("logs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(log_snapshot)
        .filter(|log| {
            !log.service_id
                .as_deref()
                .is_some_and(|id| RETIRED_SERVICE_IDS.contains(&id))
        })
        .take(64)
        .collect::<Vec<_>>();
    let failed_required = services
        .iter()
        .filter(|service| service.required && !service.ok)
        .map(|service| service.name.clone())
        .collect::<Vec<_>>();
    let degraded = value.get("status").and_then(Value::as_str) == Some("degraded")
        || !failed_required.is_empty();
    RuntimePayloadSnapshots {
        services,
        logs,
        runtime: runtime_snapshot(value),
        registry: value.get("registry").cloned(),
        monitor_protocol: value.get("monitorProtocol").cloned(),
        degraded,
        failed_required_services: failed_required,
    }
}

fn task_is_recent(task: &BackgroundTaskSnapshot, now: u64) -> bool {
    task.updated_at
        .parse::<u64>()
        .ok()
        .map(|updated| now.saturating_sub(updated) <= RECENT_FAILURE_WINDOW_MS)
        .unwrap_or(true)
}

fn snapshot_from_payloads(
    origin: &str,
    health: &Value,
    production: Option<&Value>,
    task_page: Option<&Value>,
    runtime_status: Option<&Value>,
    now: u64,
) -> BackgroundMonitorSnapshot {
    let service_ready = health.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let health_worker = health
        .pointer("/checks/taskWorker/running")
        .and_then(Value::as_bool);
    let production_worker = production
        .and_then(|value| value.pointer("/tasks/worker/running"))
        .and_then(Value::as_bool);
    let worker_running = health_worker.or(production_worker).unwrap_or(false);

    let tasks = task_page
        .and_then(|value| value.get("tasks"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(task_snapshot)
        .take(MAX_TASKS)
        .collect::<Vec<_>>();
    let queued_in_page = tasks.iter().filter(|task| task.status == "queued").count() as u64;
    let queue_depth = production
        .and_then(|value| value.pointer("/tasks/queueDepth"))
        .and_then(Value::as_u64)
        .unwrap_or(queued_in_page);
    let listed_active_tasks = tasks.iter().filter(|task| task.status == "running").count() as u64;
    let failed_tasks = tasks
        .iter()
        .filter(|task| {
            matches!(task.status.as_str(), "failed" | "interrupted") && task_is_recent(task, now)
        })
        .count() as u64;
    let blocked_tasks = tasks
        .iter()
        .filter(|task| task.status == "blocked" && task_is_recent(task, now))
        .count() as u64;
    let active_task_id = production
        .and_then(|value| value.pointer("/tasks/worker/activeTaskId"))
        .and_then(Value::as_str)
        .map(|value| bounded_text(value, 96))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            tasks
                .iter()
                .find(|task| task.status == "running")
                .map(|task| task.task_id.clone())
        });
    let active_tasks = listed_active_tasks.max(u64::from(active_task_id.is_some()));
    let task_data_available = production.is_some() && task_page.is_some();
    let RuntimePayloadSnapshots {
        services,
        logs,
        runtime,
        registry,
        monitor_protocol,
        degraded: runtime_degraded,
        failed_required_services,
    } = runtime_payload_snapshots(runtime_status);
    let state = if !service_ready
        || !worker_running
        || !task_data_available
        || failed_tasks > 0
        || blocked_tasks > 0
        || runtime_degraded
    {
        "degraded"
    } else if active_tasks > 0 || queue_depth > 0 {
        "busy"
    } else {
        "healthy"
    };
    let detail = match state {
        "healthy" => "后台服务与生产任务队列运行正常".to_string(),
        "busy" => format!("正在执行 {active_tasks} 项任务，队列等待 {queue_depth} 项"),
        _ if !service_ready => bounded_text(
            health
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("服务尚未就绪"),
            120,
        ),
        _ if !worker_running => "生产任务工作线程未运行".to_string(),
        _ if !task_data_available => "任务状态接口暂时不可用".to_string(),
        _ if runtime_degraded && !failed_required_services.is_empty() => format!(
            "注册服务未就绪：{}",
            failed_required_services
                .iter()
                .take(3)
                .map(String::as_str)
                .collect::<Vec<_>>()
                .join("、")
        ),
        _ if runtime_degraded => "服务运行状态需要关注".to_string(),
        _ => format!(
            "最近任务异常 {} 项，阻塞 {} 项",
            failed_tasks, blocked_tasks
        ),
    };
    BackgroundMonitorSnapshot {
        schema: "steel.tauri-background-monitor.v1",
        state,
        origin: origin.to_string(),
        service_available: true,
        service_ready,
        worker_running,
        queue_depth,
        active_tasks,
        failed_tasks,
        blocked_tasks,
        active_task_id,
        detail,
        updated_at_unix_ms: now,
        tasks,
        service_count: services.len() as u64,
        healthy_service_count: services.iter().filter(|service| service.ok).count() as u64,
        services,
        logs,
        lifecycle_logs: Vec::new(),
        runtime,
        registry,
        monitor_protocol,
    }
}

fn offline_snapshot(origin: &str, error: &str) -> BackgroundMonitorSnapshot {
    BackgroundMonitorSnapshot {
        schema: "steel.tauri-background-monitor.v1",
        state: "offline",
        origin: origin.to_string(),
        service_available: false,
        service_ready: false,
        worker_running: false,
        queue_depth: 0,
        active_tasks: 0,
        failed_tasks: 0,
        blocked_tasks: 0,
        active_task_id: None,
        detail: match error {
            "monitor_request_timeout" => "后台检测服务连接超时".to_string(),
            "monitor_service_unreachable" => "后台检测服务不可达".to_string(),
            _ => "后台检测服务响应无效".to_string(),
        },
        updated_at_unix_ms: unix_time_millis(),
        tasks: Vec::new(),
        services: Vec::new(),
        logs: Vec::new(),
        lifecycle_logs: Vec::new(),
        runtime: None,
        registry: None,
        monitor_protocol: None,
        service_count: 0,
        healthy_service_count: 0,
    }
}

fn poll_snapshot(origin: &str) -> BackgroundMonitorSnapshot {
    let health = match bounded_json_get(origin, "/api/health/details") {
        Ok((status, value)) if (200..300).contains(&status) || status == 503 => value,
        Ok(_) => return offline_snapshot(origin, "monitor_response_invalid"),
        Err(error) => return offline_snapshot(origin, &error),
    };
    let production = bounded_json_get(origin, "/api/production/status")
        .ok()
        .filter(|(status, _)| (200..300).contains(status))
        .map(|(_, value)| value);
    let tasks = bounded_json_get(origin, "/api/production/tasks?limit=16")
        .ok()
        .filter(|(status, _)| (200..300).contains(status))
        .map(|(_, value)| value);
    let runtime_status = bounded_json_get(origin, "/api/runtime/status")
        .ok()
        .filter(|(status, _)| (200..300).contains(status))
        .map(|(_, value)| value);
    snapshot_from_payloads(
        origin,
        &health,
        production.as_ref(),
        tasks.as_ref(),
        runtime_status.as_ref(),
        unix_time_millis(),
    )
}

fn supervisor_service_snapshot(value: SupervisorServiceSnapshot) -> BackgroundMonitorService {
    BackgroundMonitorService {
        id: value.id,
        name: value.name,
        role: value.role,
        kind: value.kind,
        origin: value.origin,
        port: value.port,
        health_path: value.health_path,
        ok: value.ok,
        required: value.required,
        status: value.status,
        response_status: value.response_status,
        latency_ms: value.latency_ms,
        uptime_ms: value.uptime_ms,
        reason: value.reason,
        lifecycle: Some(value.lifecycle),
        operations: value.operations,
        control: Some(value.control),
        startup_mode: value.startup_mode,
        auto_restart: value.auto_restart,
        managed: value.managed,
    }
}

fn apply_supervisor_snapshot(
    snapshot: &mut BackgroundMonitorSnapshot,
    supervisor: SupervisorSnapshot,
) {
    snapshot.services = supervisor
        .services
        .into_iter()
        .filter(|service| !RETIRED_SERVICE_IDS.contains(&service.id.as_str()))
        .map(supervisor_service_snapshot)
        .collect();
    snapshot.service_count = snapshot.services.len() as u64;
    snapshot.healthy_service_count = snapshot
        .services
        .iter()
        .filter(|service| service.ok)
        .count() as u64;
    snapshot.lifecycle_logs = supervisor.lifecycle_logs;
    snapshot.registry = Some(supervisor.registry);
    let task_worker = snapshot
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.task_worker.clone());
    snapshot.runtime = Some(BackgroundMonitorRuntime {
        state_root: Some(supervisor.state_root.to_string_lossy().into_owned()),
        log_root: supervisor.log_root.to_string_lossy().into_owned(),
        task_worker,
        supervisor: Some(serde_json::json!({
            "status": "running",
            "owner": "tauri-service-supervisor",
            "controlOrigin": format!("http://{CONTROL_SERVER_ADDRESS}"),
            "pollIntervalMs": POLL_INTERVAL.as_millis()
        })),
    });
    snapshot.monitor_protocol = Some(serde_json::json!({
        "schema": "steel.runtime-monitor-capabilities.v1",
        "version": 2,
        "selectionKey": "serviceId",
        "logScopes": ["service", "all"],
        "operationEffects": ["query", "mutation"],
        "mutationPolicy": "tauri-supervisor-owned",
        "readAccess": "loopback-only",
        "controlOrigin": format!("http://{CONTROL_SERVER_ADDRESS}")
    }));
    let failed_required = snapshot
        .services
        .iter()
        .filter(|service| service.required && !service.ok && service.startup_mode != "disabled")
        .map(|service| service.name.clone())
        .collect::<Vec<_>>();
    if !failed_required.is_empty() {
        snapshot.state = if snapshot.service_available {
            "degraded"
        } else {
            "offline"
        };
        snapshot.detail = format!(
            "注册服务未就绪：{}",
            failed_required
                .into_iter()
                .take(3)
                .collect::<Vec<_>>()
                .join("、")
        );
    } else if snapshot.service_available && snapshot.active_tasks == 0 && snapshot.queue_depth == 0
    {
        snapshot.state = "healthy";
        snapshot.detail = "服务 supervisor 与生产任务队列运行正常".to_string();
    }
}

fn state_label(state: &str) -> &'static str {
    match state {
        "healthy" => "正常",
        "busy" => "任务运行中",
        "degraded" => "需要关注",
        "offline" => "服务离线",
        _ => "正在连接",
    }
}

fn update_tray_ui(ui: &TrayUi, snapshot: &BackgroundMonitorSnapshot) {
    let _ = ui
        .status
        .set_text(format!("状态：{}", state_label(snapshot.state)));
    let _ = ui.tasks.set_text(format!(
        "任务：运行 {} · 排队 {}",
        snapshot.active_tasks, snapshot.queue_depth
    ));
    let _ = ui.issues.set_text(format!(
        "关注：异常 {} · 阻塞 {}",
        snapshot.failed_tasks, snapshot.blocked_tasks
    ));
    let tooltip = format!(
        "北满特钢任务监控 · {} · 运行 {} · 排队 {} · 异常 {}",
        state_label(snapshot.state),
        snapshot.active_tasks,
        snapshot.queue_depth,
        snapshot.failed_tasks + snapshot.blocked_tasks
    );
    let _ = ui.tray.set_tooltip(Some(tooltip));
}

fn publish_snapshot(app: &AppHandle, snapshot: BackgroundMonitorSnapshot) {
    let state = app.state::<BackgroundMonitorState>();
    if let Ok(mut current) = state.snapshot.lock() {
        *current = snapshot.clone();
    }
    if let Ok(tray) = state.tray.lock() {
        if let Some(ui) = tray.as_ref() {
            update_tray_ui(ui, &snapshot);
        }
    }
    let _ = app.emit(MONITOR_EVENT, snapshot);
}

fn open_monitor_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MONITOR_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_all_windows(app: &AppHandle) {
    for window in app.webview_windows().values() {
        let _ = window.hide();
    }
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        MENU_OPEN_MONITOR => open_monitor_window(app),
        MENU_HIDE_WINDOWS => hide_all_windows(app),
        MENU_QUIT => {
            app.state::<BackgroundMonitorState>()
                .exiting
                .store(true, Ordering::SeqCst);
            app.exit(0);
        }
        _ => {}
    }
}

pub(crate) fn install(app: &mut App) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, MENU_STATUS, "状态：正在连接", false, None::<&str>)?;
    let tasks = MenuItem::with_id(
        app,
        MENU_TASKS,
        "任务：运行 0 · 排队 0",
        false,
        None::<&str>,
    )?;
    let issues = MenuItem::with_id(
        app,
        MENU_ISSUES,
        "关注：异常 0 · 阻塞 0",
        false,
        None::<&str>,
    )?;
    let open_monitor =
        MenuItem::with_id(app, MENU_OPEN_MONITOR, "打开任务监控", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, MENU_HIDE_WINDOWS, "隐藏监控窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(
        app,
        MENU_QUIT,
        "退出任务监控（后台服务继续）",
        true,
        None::<&str>,
    )?;
    let separator_one = PredefinedMenuItem::separator(app)?;
    let separator_two = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &tasks,
            &issues,
            &separator_one,
            &open_monitor,
            &hide,
            &separator_two,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("北满特钢任务监控 · 正在连接")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => open_monitor_window(tray.app_handle()),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    let ui = TrayUi {
        tray,
        status,
        tasks,
        issues,
    };
    if let Ok(mut current) = app.state::<BackgroundMonitorState>().tray.lock() {
        *current = Some(ui);
    }
    Ok(())
}

pub(crate) fn start_worker(app: AppHandle) {
    let _ = thread::Builder::new()
        .name("tauri-background-monitor".to_string())
        .spawn(move || loop {
            let state = app.state::<BackgroundMonitorState>();
            if state.exiting.load(Ordering::SeqCst) {
                break;
            }
            state.refresh_requested.store(false, Ordering::SeqCst);
            let origin = state
                .origin
                .lock()
                .map(|value| value.clone())
                .unwrap_or_else(|_| DEFAULT_ORIGIN.to_string());
            let supervisor_snapshot = state.supervisor.lock().ok().map(|mut supervisor| {
                supervisor.reconcile();
                supervisor.snapshot()
            });
            if let Some(supervisor_snapshot) = supervisor_snapshot.as_ref() {
                let mut service_snapshot = state
                    .snapshot
                    .lock()
                    .map(|snapshot| snapshot.clone())
                    .unwrap_or_default();
                service_snapshot.updated_at_unix_ms = unix_time_millis();
                apply_supervisor_snapshot(&mut service_snapshot, supervisor_snapshot.clone());
                publish_snapshot(&app, service_snapshot);
            }
            let mut snapshot = poll_snapshot(&origin);
            if let Some(supervisor_snapshot) = supervisor_snapshot {
                apply_supervisor_snapshot(&mut snapshot, supervisor_snapshot);
            }
            publish_snapshot(&app, snapshot);
            let slices = (POLL_INTERVAL.as_millis() / 100) as usize;
            for _ in 0..slices.max(1) {
                if state.exiting.load(Ordering::SeqCst)
                    || state.refresh_requested.swap(false, Ordering::SeqCst)
                {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
}

fn control_origin_allowed(value: &str) -> bool {
    let origin = value.trim();
    matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost" | "null"
    ) || origin
        .strip_prefix("http://127.0.0.1:")
        .or_else(|| origin.strip_prefix("http://localhost:"))
        .is_some_and(|port| port.parse::<u16>().is_ok())
}

fn control_http_response(status: &str, origin: Option<&str>, body: &str) -> Vec<u8> {
    let allow_origin = origin
        .filter(|value| control_origin_allowed(value))
        .unwrap_or("http://127.0.0.1:4873");
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: {allow_origin}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, X-Steel-Monitor-Client\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

fn handle_control_client(mut stream: TcpStream, app: &AppHandle) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let mut request = Vec::new();
    let mut buffer = [0_u8; 8192];
    let mut sent_continue = false;
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                request.extend_from_slice(&buffer[..count]);
                if request.len() > 64 * 1024 {
                    break;
                }
                if let Some(separator) = request.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let header = String::from_utf8_lossy(&request[..separator]);
                    let content_length = header
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                                .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if !sent_continue
                        && content_length > 0
                        && header.lines().any(|line| {
                            line.split_once(':').is_some_and(|(name, value)| {
                                name.eq_ignore_ascii_case("expect")
                                    && value.trim().eq_ignore_ascii_case("100-continue")
                            })
                        })
                    {
                        let _ = stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
                        sent_continue = true;
                    }
                    if request.len() >= separator + 4 + content_length {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&request);
    let Some(header_end) = text.find("\r\n\r\n") else {
        let body = serde_json::json!({"success":false,"message":"请求无效"}).to_string();
        let _ = stream.write_all(&control_http_response("400 Bad Request", None, &body));
        return;
    };
    let header = &text[..header_end];
    let mut lines = header.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let path = request_parts.next().unwrap_or_default();
    let origin = lines.find_map(|line| {
        line.split_once(':')
            .filter(|(name, _)| name.eq_ignore_ascii_case("origin"))
            .map(|(_, value)| value.trim())
    });
    let monitor_client = header.lines().find_map(|line| {
        line.split_once(':')
            .filter(|(name, _)| name.eq_ignore_ascii_case("x-steel-monitor-client"))
            .map(|(_, value)| value.trim())
    });
    if origin.is_some_and(|value| !control_origin_allowed(value)) {
        let body =
            serde_json::json!({"success":false,"message":"来源不允许控制本机服务"}).to_string();
        let _ = stream.write_all(&control_http_response("403 Forbidden", None, &body));
        return;
    }
    if method == "OPTIONS" {
        let _ = stream.write_all(&control_http_response("204 No Content", origin, ""));
        return;
    }
    if method == "POST" && monitor_client != Some("main-ui-v1") {
        let body = serde_json::json!({"success":false,"message":"服务控制请求缺少受信客户端标识"})
            .to_string();
        let _ = stream.write_all(&control_http_response("403 Forbidden", origin, &body));
        return;
    }
    let response = if method == "GET" && path == "/api/health" {
        Ok(serde_json::json!({
            "ok": true,
            "schema": "steel.tauri-service-supervisor.v1",
            "controlOrigin": format!("http://{CONTROL_SERVER_ADDRESS}")
        }))
    } else if method == "GET" && path == "/api/status" {
        app.state::<BackgroundMonitorState>()
            .snapshot
            .lock()
            .map(|snapshot| serde_json::to_value(snapshot.clone()).unwrap_or(Value::Null))
            .map_err(|_| "后台监控状态不可用".to_string())
    } else if method == "POST" {
        let segments = path.trim_matches('/').split('/').collect::<Vec<_>>();
        if segments.len() == 4 && segments[0] == "api" && segments[1] == "services" {
            let service_id = segments[2].to_string();
            let action = segments[3];
            let state = app.state::<BackgroundMonitorState>();
            if action == "startup-mode" {
                let body = text.get(header_end + 4..).unwrap_or_default();
                let mode = serde_json::from_str::<Value>(body)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("mode")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .ok_or_else(|| "请求缺少启动模式".to_string());
                mode.and_then(|mode| {
                    perform_startup_mode_change(service_id, mode, "main-ui", state).and_then(
                        |result| serde_json::to_value(result).map_err(|error| error.to_string()),
                    )
                })
            } else {
                perform_service_action(service_id, action.to_string(), "main-ui", state).and_then(
                    |result| serde_json::to_value(result).map_err(|error| error.to_string()),
                )
            }
        } else {
            Err("控制接口不存在".to_string())
        }
    } else {
        Err("控制接口不存在".to_string())
    };
    let (status, body) = match response {
        Ok(value) => ("200 OK", value.to_string()),
        Err(message) => (
            if message == "控制接口不存在" {
                "404 Not Found"
            } else {
                "409 Conflict"
            },
            serde_json::json!({"success":false,"message":message}).to_string(),
        ),
    };
    let _ = stream.write_all(&control_http_response(status, origin, &body));
}

pub(crate) fn start_control_server(app: AppHandle) -> tauri::Result<()> {
    let listener = TcpListener::bind(CONTROL_SERVER_ADDRESS)?;
    listener.set_nonblocking(true)?;
    thread::Builder::new()
        .name("tauri-service-control-http".to_string())
        .spawn(move || loop {
            if app
                .state::<BackgroundMonitorState>()
                .exiting
                .load(Ordering::SeqCst)
            {
                break;
            }
            match listener.accept() {
                Ok((stream, address)) if address.ip().is_loopback() => {
                    handle_control_client(stream, &app);
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => thread::sleep(Duration::from_millis(100)),
            }
        })?;
    Ok(())
}

pub(crate) fn should_hide_monitor_window(window_label: &str, exiting: bool) -> bool {
    window_label == MONITOR_WINDOW && !exiting
}

pub(crate) fn is_exiting(state: State<'_, BackgroundMonitorState>) -> bool {
    state.exiting.load(Ordering::SeqCst)
}

#[tauri::command]
pub(crate) fn configure_background_monitor(
    origin: String,
    state: State<'_, BackgroundMonitorState>,
) -> Result<BackgroundMonitorSnapshot, String> {
    let normalized = normalize_monitor_origin(&origin)?;
    let origin_changed = {
        let mut configured_origin = state
            .origin
            .lock()
            .map_err(|_| "后台监控地址状态不可用".to_string())?;
        let changed = *configured_origin != normalized;
        *configured_origin = normalized.clone();
        changed
    };
    state.refresh_requested.store(true, Ordering::SeqCst);
    let mut snapshot = state
        .snapshot
        .lock()
        .map_err(|_| "后台监控状态不可用".to_string())?;
    if origin_changed {
        *snapshot = BackgroundMonitorSnapshot {
            origin: normalized,
            ..BackgroundMonitorSnapshot::default()
        };
    } else {
        snapshot.origin = normalized;
    }
    Ok(snapshot.clone())
}

#[tauri::command]
pub(crate) fn read_background_monitor(
    state: State<'_, BackgroundMonitorState>,
) -> Result<BackgroundMonitorSnapshot, String> {
    state
        .snapshot
        .lock()
        .map(|value| value.clone())
        .map_err(|_| "后台监控状态不可用".to_string())
}

#[tauri::command]
pub(crate) fn refresh_background_monitor(
    state: State<'_, BackgroundMonitorState>,
) -> Result<BackgroundMonitorSnapshot, String> {
    state.refresh_requested.store(true, Ordering::SeqCst);
    read_background_monitor(state)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundServiceActionResult {
    success: bool,
    service_id: String,
    action: String,
    message: String,
}

fn perform_service_action(
    service_id: String,
    action: String,
    source: &str,
    state: State<'_, BackgroundMonitorState>,
) -> Result<BackgroundServiceActionResult, String> {
    let message = state
        .supervisor
        .lock()
        .map_err(|_| "服务 supervisor 状态不可用".to_string())?
        .action(&service_id, &action, source)?;
    state.refresh_requested.store(true, Ordering::SeqCst);
    Ok(BackgroundServiceActionResult {
        success: true,
        service_id,
        action,
        message,
    })
}

fn perform_startup_mode_change(
    service_id: String,
    mode: String,
    source: &str,
    state: State<'_, BackgroundMonitorState>,
) -> Result<BackgroundServiceActionResult, String> {
    let message = state
        .supervisor
        .lock()
        .map_err(|_| "服务 supervisor 状态不可用".to_string())?
        .set_startup_mode(&service_id, &mode, source)?;
    state.refresh_requested.store(true, Ordering::SeqCst);
    Ok(BackgroundServiceActionResult {
        success: true,
        service_id,
        action: "startup-mode".to_string(),
        message,
    })
}

#[tauri::command]
pub(crate) fn control_background_service(
    service_id: String,
    action: String,
    state: State<'_, BackgroundMonitorState>,
) -> Result<BackgroundServiceActionResult, String> {
    perform_service_action(service_id, action, "monitor-ui", state)
}

#[tauri::command]
pub(crate) fn set_background_service_startup_mode(
    service_id: String,
    mode: String,
    state: State<'_, BackgroundMonitorState>,
) -> Result<BackgroundServiceActionResult, String> {
    perform_startup_mode_change(service_id, mode, "monitor-ui", state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn healthy_payload() -> Value {
        json!({
            "ok": true,
            "status": "ready",
            "checks": { "taskWorker": { "running": true } }
        })
    }

    #[test]
    fn monitor_origin_accepts_bounded_http_authorities_only() {
        assert_eq!(
            normalize_monitor_origin("http://127.0.0.1:4873/"),
            Ok("http://127.0.0.1:4873".to_string())
        );
        assert_eq!(
            normalize_monitor_origin("http://LOCALHOST"),
            Ok("http://localhost:80".to_string())
        );
        for invalid in [
            "https://127.0.0.1:4873",
            "http://inspection-host:4873",
            "http://user@127.0.0.1:4873",
            "http://127.0.0.1:4873/private",
            "http://127.0.0.1:0",
            "http://127.0.0.1:4873\r\nInjected: yes",
        ] {
            assert!(normalize_monitor_origin(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn task_snapshot_marks_busy_and_recent_failures() {
        let now = 1_800_000_000_000_u64;
        let production = json!({
            "tasks": {
                "queueDepth": 2,
                "worker": { "running": true, "activeTaskId": "TASK-1" }
            }
        });
        let page = json!({
            "tasks": [
                {"taskId":"TASK-1","kind":"capture-once","materialId":"63","status":"running","phase":"capture","progress":0.5,"updatedAt":now.to_string()},
                {"taskId":"TASK-2","kind":"algorithm-run","materialId":"62","status":"failed","error":"boom","updatedAt":now.to_string()},
                {"taskId":"TASK-3","kind":"steel-out","materialId":"61","status":"blocked","blockedReason":"dependency failed","updatedAt":now.to_string()}
            ]
        });
        let snapshot = snapshot_from_payloads(
            DEFAULT_ORIGIN,
            &healthy_payload(),
            Some(&production),
            Some(&page),
            None,
            now,
        );
        assert_eq!(snapshot.state, "degraded");
        assert_eq!(snapshot.queue_depth, 2);
        assert_eq!(snapshot.active_tasks, 1);
        assert_eq!(snapshot.failed_tasks, 1);
        assert_eq!(snapshot.blocked_tasks, 1);
        assert_eq!(snapshot.active_task_id.as_deref(), Some("TASK-1"));
        assert_eq!(snapshot.tasks[0].progress, 0.5);
        assert_eq!(snapshot.tasks[2].error, "dependency failed");
    }

    #[test]
    fn task_snapshot_reports_healthy_busy_and_missing_task_data() {
        let production = json!({"tasks":{"queueDepth":0,"worker":{"running":true}}});
        let page = json!({"tasks":[]});
        let healthy = snapshot_from_payloads(
            DEFAULT_ORIGIN,
            &healthy_payload(),
            Some(&production),
            Some(&page),
            None,
            1,
        );
        assert_eq!(healthy.state, "healthy");

        let queued = json!({"tasks":{"queueDepth":3,"worker":{"running":true}}});
        let busy = snapshot_from_payloads(
            DEFAULT_ORIGIN,
            &healthy_payload(),
            Some(&queued),
            Some(&page),
            None,
            1,
        );
        assert_eq!(busy.state, "busy");

        let active_only = json!({"tasks":{"queueDepth":0,"worker":{"running":true,"activeTaskId":"TASK-ACTIVE"}}});
        let active = snapshot_from_payloads(
            DEFAULT_ORIGIN,
            &healthy_payload(),
            Some(&active_only),
            Some(&page),
            None,
            1,
        );
        assert_eq!(active.state, "busy");
        assert_eq!(active.active_tasks, 1);

        let missing =
            snapshot_from_payloads(DEFAULT_ORIGIN, &healthy_payload(), None, None, None, 1);
        assert_eq!(missing.state, "degraded");
        assert_eq!(missing.detail, "任务状态接口暂时不可用");
    }

    #[test]
    fn runtime_capability_contract_survives_the_tauri_snapshot_boundary() {
        let runtime = json!({
            "status": "running",
            "monitorProtocol": {
                "schema": "steel.runtime-monitor-capabilities.v1",
                "version": 1,
                "selectionKey": "serviceId",
                "logScopes": ["service", "all"],
                "operationEffects": ["query", "local", "mutation"],
                "mutationPolicy": "capability-only",
                "readAccess": "loopback-or-private-network"
            },
            "services": [{
                "id": "inspection",
                "name": "业务服务",
                "role": "api",
                "kind": "inspection",
                "origin": "http://127.0.0.1:4873",
                "port": 4873,
                "healthPath": "/api/health/live",
                "ok": true,
                "required": true,
                "status": "running",
                "responseStatus": 200,
                "operations": [{
                    "id": "refresh-status",
                    "effect": "query",
                    "scope": "service",
                    "enabled": true
                }],
                "control": { "mode": "observe", "owner": "service" }
            }],
            "logs": []
        });
        let production = json!({"tasks":{"queueDepth":0,"worker":{"running":true}}});
        let page = json!({"tasks":[]});
        let snapshot = snapshot_from_payloads(
            DEFAULT_ORIGIN,
            &healthy_payload(),
            Some(&production),
            Some(&page),
            Some(&runtime),
            1,
        );

        assert_eq!(snapshot.services[0].operations[0]["id"], "refresh-status");
        assert_eq!(
            snapshot.services[0].control.as_ref().unwrap()["mode"],
            "observe"
        );
        assert_eq!(
            snapshot.monitor_protocol.as_ref().unwrap()["mutationPolicy"],
            "capability-only"
        );
    }

    #[test]
    fn retired_bkv_history_adapter_is_removed_from_monitor_snapshots() {
        let runtime = json!({
            "status": "degraded",
            "registry": {
                "schema": "steel.service-registry.v1",
                "services": [{ "id": "inspection" }]
            },
            "services": [
                {
                    "id": "inspection",
                    "name": "业务服务",
                    "role": "api",
                    "kind": "inspection",
                    "origin": "http://127.0.0.1:4873",
                    "port": 4873,
                    "healthPath": "/api/health/live",
                    "ok": true,
                    "required": true,
                    "status": "running",
                    "responseStatus": 200
                },
                {
                    "id": "bkv-adapter",
                    "name": "BKV 历史适配器",
                    "role": "bkv-history-image-worker",
                    "kind": "probe",
                    "origin": "http://127.0.0.1:4877",
                    "port": 4877,
                    "healthPath": "/api/health/live",
                    "ok": false,
                    "required": true,
                    "status": "unavailable",
                    "responseStatus": 0
                }
            ],
            "logs": [
                { "name": "inspection-service.out.log", "serviceId": "inspection" },
                { "name": "bkv-image-worker.out.log", "serviceId": "bkv-adapter" }
            ]
        });

        let RuntimePayloadSnapshots {
            services,
            logs,
            failed_required_services,
            ..
        } = runtime_payload_snapshots(Some(&runtime));

        assert_eq!(services.len(), 1);
        assert_eq!(services[0].id, "inspection");
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].service_id.as_deref(), Some("inspection"));
        assert!(failed_required_services.is_empty());
    }

    #[test]
    fn parses_bounded_json_http_responses() {
        let body = br#"{"ok":true}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            std::str::from_utf8(body).unwrap()
        );
        let (status, value) = parse_json_http_response(response.as_bytes()).unwrap();
        assert_eq!(status, 200);
        assert_eq!(value["ok"], json!(true));
        assert!(parse_json_http_response(b"invalid").is_err());
    }

    #[test]
    fn monitor_window_hides_while_the_independent_process_keeps_running() {
        assert!(should_hide_monitor_window(MONITOR_WINDOW, false));
        assert!(!should_hide_monitor_window("other", false));
        assert!(!should_hide_monitor_window(MONITOR_WINDOW, true));
    }

    #[test]
    fn native_monitor_refreshes_live_status_and_log_tails_each_second() {
        assert_eq!(POLL_INTERVAL, Duration::from_secs(1));
    }
}
