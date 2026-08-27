use serde_json::{json, Value};
use std::env;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use steel_runtime_contract::{WorkerRole, SERVICE_HEALTH_SCHEMA};

const DEFAULT_PORT: u16 = 4876;

#[derive(Clone)]
struct WorkerConfig {
    python: PathBuf,
    script: PathBuf,
    profile: PathBuf,
    capture_origin: String,
    database_origin: String,
    poll_seconds: String,
    settle_seconds: String,
}

#[derive(Default)]
struct WorkerStatus {
    running: bool,
    pid: Option<u32>,
    restarts: u64,
    last_error: Option<String>,
}

struct State {
    role: WorkerRole,
    config: Option<WorkerConfig>,
    status: Mutex<WorkerStatus>,
    shutdown: AtomicBool,
}

fn main() -> std::io::Result<()> {
    let role = executable_role();
    let port_env = match role {
        WorkerRole::Image => "STEEL_IMAGE_WORKER_PORT",
        WorkerRole::Defect => "STEEL_DEFECT_WORKER_PORT",
    };
    let port = env::var(port_env)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| default_port(role));
    let state = Arc::new(State {
        role,
        config: worker_config(role),
        status: Mutex::new(WorkerStatus::default()),
        shutdown: AtomicBool::new(false),
    });
    let signal_state = Arc::clone(&state);
    ctrlc::set_handler(move || signal_state.shutdown.store(true, Ordering::Release))
        .map_err(io_error)?;

    if state.config.is_some() {
        let worker_state = Arc::clone(&state);
        thread::Builder::new()
            .name(format!("{}-python-worker", role_arg(role)))
            .spawn(move || worker_loop(worker_state))
            .map_err(io_error)?;
    } else if let Ok(mut status) = state.status.lock() {
        status.last_error = Some("STEEL_SICK_CAPTURE_PROFILE is not configured".into());
    }

    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;
    println!(
        "{} listening on http://127.0.0.1:{port}",
        role.service_name()
    );
    while !state.shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let request_state = Arc::clone(&state);
                thread::spawn(move || handle_client(stream, request_state));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => eprintln!("defect worker listener error: {error}"),
        }
    }
    Ok(())
}

fn worker_config(role: WorkerRole) -> Option<WorkerConfig> {
    let profile = env::var("STEEL_SICK_CAPTURE_PROFILE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)?;
    if !profile.is_file() {
        eprintln!(
            "{} profile is missing: {}",
            role.service_name(),
            profile.display()
        );
        return None;
    }
    let workspace = workspace_root();
    let script = env::var("STEEL_SICK_ALGORITHM_SCRIPT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace.join("scripts/sick_flow_analysis_service.py"));
    if !script.is_file() {
        eprintln!(
            "{} script is missing: {}",
            role.service_name(),
            script.display()
        );
        return None;
    }
    let python = env::var("STEEL_PYTHON_EXECUTABLE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("python"));
    if python.is_absolute() && !python.is_file() {
        eprintln!(
            "{} Python executable is missing: {}",
            role.service_name(),
            python.display()
        );
        return None;
    }
    Some(WorkerConfig {
        python,
        script,
        profile,
        capture_origin: env::var("CAPTURE_SERVICE_ORIGIN")
            .unwrap_or_else(|_| "http://127.0.0.1:4317".into()),
        database_origin: env::var("INSPECTION_SERVICE_ORIGIN")
            .unwrap_or_else(|_| "http://127.0.0.1:4873".into()),
        poll_seconds: env::var(match role {
            WorkerRole::Image => "STEEL_IMAGE_WORKER_POLL_SECONDS",
            WorkerRole::Defect => "STEEL_DEFECT_WORKER_POLL_SECONDS",
        })
        .unwrap_or_else(|_| "1".into()),
        settle_seconds: env::var(match role {
            WorkerRole::Image => "STEEL_IMAGE_WORKER_SETTLE_SECONDS",
            WorkerRole::Defect => "STEEL_DEFECT_WORKER_SETTLE_SECONDS",
        })
        .unwrap_or_else(|_| "2".into()),
    })
}

fn worker_command(config: &WorkerConfig, role: WorkerRole) -> Command {
    let mut command = Command::new(&config.python);
    command
        .arg(&config.script)
        .arg("--role")
        .arg(role_arg(role))
        .arg("--profile")
        .arg(&config.profile)
        .arg("--capture-origin")
        .arg(&config.capture_origin)
        .arg("--database-origin")
        .arg(&config.database_origin)
        .arg("--poll-seconds")
        .arg(&config.poll_seconds)
        .arg("--settle-seconds")
        .arg(&config.settle_seconds)
        .current_dir(workspace_root())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    command
}

fn worker_loop(state: Arc<State>) {
    let Some(config) = state.config.clone() else {
        return;
    };
    while !state.shutdown.load(Ordering::Acquire) {
        match worker_command(&config, state.role).spawn() {
            Ok(mut child) => monitor_child(&state, &mut child),
            Err(error) => {
                update_status(
                    &state,
                    false,
                    None,
                    Some(format!("worker start failed: {error}")),
                );
            }
        }
        if !state.shutdown.load(Ordering::Acquire) {
            if let Ok(mut status) = state.status.lock() {
                status.restarts = status.restarts.saturating_add(1);
            }
            thread::sleep(Duration::from_secs(2));
        }
    }
}

fn monitor_child(state: &State, child: &mut Child) {
    update_status(state, true, Some(child.id()), None);
    loop {
        if state.shutdown.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            update_status(state, false, None, None);
            return;
        }
        match child.try_wait() {
            Ok(Some(exit)) => {
                update_status(
                    state,
                    false,
                    None,
                    (!exit.success()).then(|| format!("worker exited with {exit}")),
                );
                return;
            }
            Ok(None) => thread::sleep(Duration::from_millis(250)),
            Err(error) => {
                update_status(
                    state,
                    false,
                    None,
                    Some(format!("worker status failed: {error}")),
                );
                return;
            }
        }
    }
}

fn update_status(state: &State, running: bool, pid: Option<u32>, error: Option<String>) {
    if let Ok(mut status) = state.status.lock() {
        status.running = running;
        status.pid = pid;
        if error.is_some() {
            status.last_error = error;
        }
    }
}

fn request_reprocess(state: &Arc<State>, material_id: &str) -> Result<u32, String> {
    if material_id.is_empty() || !material_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("positive numeric materialId required".into());
    }
    let config = state
        .config
        .as_ref()
        .ok_or_else(|| "defect worker is not configured".to_string())?;
    let mut command = worker_command(config, state.role);
    command.arg("--once").arg(material_id);
    if state.role == WorkerRole::Image {
        command.arg("--final");
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(pid)
}

fn handle_client(mut stream: TcpStream, state: Arc<State>) {
    let bytes = read_http_request(&mut stream);
    let request = String::from_utf8_lossy(&bytes);
    let mut lines = request.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or_default();
    let path = target.split('?').next().unwrap_or(target);
    let body = request.split("\r\n\r\n").nth(1).unwrap_or_default();
    let response = match (method, path) {
        ("GET", "/api/health/live") | ("GET", "/health") => {
            response(200, &health_json(&state).to_string())
        }
        ("GET", "/internal/v1/status") => response(200, &status_json(&state).to_string()),
        ("POST", "/internal/v1/reprocess") => {
            let payload = serde_json::from_str::<Value>(body).unwrap_or_else(|_| json!({}));
            match payload.get("materialId").and_then(Value::as_str) {
                Some(material_id) => match request_reprocess(&state, material_id.trim()) {
                    Ok(pid) => response(
                        202,
                        &json!({
                            "accepted":true,
                            "service":state.role.service_name(),
                            "materialId":material_id.trim(),
                            "pid":pid
                        })
                        .to_string(),
                    ),
                    Err(error) => {
                        response(409, &json!({"accepted":false,"error":error}).to_string())
                    }
                },
                None => response(
                    400,
                    &json!({"accepted":false,"error":"materialId_required"}).to_string(),
                ),
            }
        }
        _ => response(404, &json!({"error":"not_found"}).to_string()),
    };
    let _ = stream.write_all(response.as_bytes());
}

fn health_json(state: &State) -> Value {
    let status = state
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    json!({
        "schema":SERVICE_HEALTH_SCHEMA,
        "status":"live",
        "service":state.role.service_name(),
        "role":role_arg(state.role),
        "live":true,
        "ready":state.config.is_some() && status.running,
        "version":env!("CARGO_PKG_VERSION"),
        "childPid":status.pid,
        "restartCount":status.restarts,
        "detail":status.last_error
    })
}

fn status_json(state: &State) -> Value {
    let status = state
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    json!({
        "schema":format!("steel.{}-worker.status.v1", role_arg(state.role)),
        "service":state.role.service_name(),
        "role":role_arg(state.role),
        "configured":state.config.is_some(),
        "running":status.running,
        "pid":status.pid,
        "restarts":status.restarts,
        "lastError":status.last_error,
        "boundary":match state.role {
            WorkerRole::Image => "acquisition-manifest-to-image-result",
            WorkerRole::Defect => "image-result-to-defect-report",
        }
    })
}

fn read_http_request(stream: &mut TcpStream) -> Vec<u8> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                bytes.extend_from_slice(&buffer[..size]);
                if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    bytes
}

fn response(code: u16, body: &str) -> String {
    let reason = match code {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Error",
    };
    format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn workspace_root() -> PathBuf {
    let current = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for candidate in current.ancestors() {
        if candidate
            .join("scripts/sick_flow_analysis_service.py")
            .is_file()
        {
            return candidate.to_path_buf();
        }
    }
    current
}

fn executable_role() -> WorkerRole {
    let executable = env::args().next().unwrap_or_default().to_ascii_lowercase();
    if executable.contains("image-worker") || executable.contains("image_worker") {
        WorkerRole::Image
    } else {
        WorkerRole::Defect
    }
}

const fn default_port(role: WorkerRole) -> u16 {
    match role {
        WorkerRole::Image => 4875,
        WorkerRole::Defect => DEFAULT_PORT,
    }
}

const fn role_arg(role: WorkerRole) -> &'static str {
    match role {
        WorkerRole::Image => "image",
        WorkerRole::Defect => "defect",
    }
}

fn io_error(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_contains_json_length() {
        let response = response(200, "{}");
        assert!(response.contains("Content-Length: 2"));
        assert!(response.ends_with("{}"));
    }

    #[test]
    fn worker_roles_have_stable_service_names_and_ports() {
        assert_eq!(WorkerRole::Image.service_name(), "steel-image-worker");
        assert_eq!(WorkerRole::Defect.service_name(), "steel-defect-worker");
        assert_eq!(default_port(WorkerRole::Image), 4875);
        assert_eq!(default_port(WorkerRole::Defect), 4876);
    }
}
