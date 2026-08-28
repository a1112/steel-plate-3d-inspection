use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const MAX_EVENTS: usize = 240;
const HEALTH_TIMEOUT: Duration = Duration::from_millis(350);
const RESTART_BACKOFF: Duration = Duration::from_secs(3);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum StartupMode {
    Normal,
    Manual,
    Disabled,
}

impl StartupMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Manual => "manual",
            Self::Disabled => "disabled",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "normal" | "automatic" | "auto" => Ok(Self::Normal),
            "manual" | "on-demand" => Ok(Self::Manual),
            "disabled" | "off" => Ok(Self::Disabled),
            _ => Err("启动模式仅支持 normal、manual 或 disabled".to_string()),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProcessDefinition {
    #[serde(default)]
    command: String,
    #[serde(default)]
    command_candidates: Vec<String>,
    #[serde(default)]
    arguments: Vec<String>,
    #[serde(default)]
    working_directory: String,
    #[serde(default)]
    environment: HashMap<String, String>,
    #[serde(default)]
    stdout_log: String,
    #[serde(default)]
    stderr_log: String,
    #[serde(default = "default_startup_mode")]
    startup_mode: String,
}

fn default_startup_mode() -> String {
    "normal".to_string()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServiceRegistration {
    id: String,
    name: String,
    #[serde(default)]
    role: String,
    #[serde(default = "default_kind")]
    kind: String,
    default_origin: String,
    #[serde(default)]
    origin_env: Option<String>,
    #[serde(default)]
    port_env: Option<String>,
    #[serde(default = "default_health_path")]
    health_path: String,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    lifecycle: String,
    #[serde(default)]
    process: Option<ProcessDefinition>,
}

fn default_kind() -> String {
    "probe".to_string()
}

fn default_health_path() -> String {
    "/api/health/live".to_string()
}

#[derive(Clone, Debug, Deserialize)]
struct RegistryFile {
    schema: String,
    version: u32,
    services: Vec<ServiceRegistration>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceLifecycleEvent {
    pub id: u64,
    pub timestamp: String,
    pub service_id: String,
    pub service_name: String,
    pub action: String,
    pub outcome: String,
    pub source: String,
    pub message: String,
    pub pid: Option<u32>,
}

#[derive(Clone, Debug)]
pub(crate) struct SupervisorServiceSnapshot {
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
    pub lifecycle: Value,
    pub operations: Vec<Value>,
    pub control: Value,
    pub startup_mode: String,
    pub auto_restart: bool,
    pub managed: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct SupervisorSnapshot {
    pub services: Vec<SupervisorServiceSnapshot>,
    pub lifecycle_logs: Vec<ServiceLifecycleEvent>,
    pub registry: Value,
    pub state_root: PathBuf,
    pub log_root: PathBuf,
}

#[derive(Debug, Default)]
struct ServiceRuntime {
    child: Option<Child>,
    known_pid: Option<u32>,
    desired_running: bool,
    started_at: Option<u64>,
    restart_count: u32,
    last_launch_attempt: Option<Instant>,
    observed_running: bool,
    last_reason: Option<String>,
    last_probe: Option<ProbeResult>,
}

#[derive(Clone, Debug)]
struct ProbeResult {
    ok: bool,
    status: u16,
    latency_ms: u64,
    reason: Option<String>,
}

pub(crate) struct ServiceSupervisor {
    workspace_root: PathBuf,
    registry_path: PathBuf,
    state_root: PathBuf,
    log_root: PathBuf,
    registrations: Vec<ServiceRegistration>,
    runtimes: HashMap<String, ServiceRuntime>,
    modes: HashMap<String, StartupMode>,
    events: VecDeque<ServiceLifecycleEvent>,
    next_event_id: u64,
    load_error: Option<String>,
}

impl ServiceSupervisor {
    pub(crate) fn load() -> Self {
        match Self::try_load() {
            Ok(supervisor) => supervisor,
            Err(error) => {
                let workspace_root = discover_workspace_root();
                let state_root = runtime_state_root(&workspace_root);
                let log_root = state_root.join("logs");
                Self {
                    workspace_root: workspace_root.clone(),
                    registry_path: workspace_root.join("config/service-registry.json"),
                    state_root,
                    log_root,
                    registrations: Vec::new(),
                    runtimes: HashMap::new(),
                    modes: HashMap::new(),
                    events: VecDeque::new(),
                    next_event_id: 1,
                    load_error: Some(error),
                }
            }
        }
    }

    fn try_load() -> Result<Self, String> {
        let workspace_root = discover_workspace_root();
        let registry_path = std::env::var("STEEL_SERVICE_REGISTRY_PATH")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| workspace_root.join("config/service-registry.json"));
        let registry_text = fs::read_to_string(&registry_path).map_err(|error| {
            format!("服务注册表读取失败（{}）：{error}", registry_path.display())
        })?;
        let registry = serde_json::from_str::<RegistryFile>(&registry_text)
            .map_err(|error| format!("服务注册表 JSON 无效：{error}"))?;
        if registry.schema != "steel.service-registry.v1" || registry.version != 1 {
            return Err("服务注册表版本不受支持".to_string());
        }
        let state_root = runtime_state_root(&workspace_root);
        let log_root = state_root.join("logs");
        fs::create_dir_all(&log_root).map_err(|error| format!("监控日志目录创建失败：{error}"))?;
        let persisted_modes = read_modes(&state_root.join("service-startup-modes.json"));
        let mut modes = HashMap::new();
        let mut runtimes = HashMap::new();
        for service in &registry.services {
            let configured = service
                .process
                .as_ref()
                .and_then(|process| StartupMode::parse(&process.startup_mode).ok())
                .unwrap_or(if service.required {
                    StartupMode::Normal
                } else {
                    StartupMode::Manual
                });
            let mode = persisted_modes
                .get(&service.id)
                .copied()
                .unwrap_or(configured);
            modes.insert(service.id.clone(), mode);
            runtimes.insert(
                service.id.clone(),
                ServiceRuntime {
                    desired_running: mode == StartupMode::Normal,
                    ..ServiceRuntime::default()
                },
            );
        }
        let events = read_events(&log_root.join("service-lifecycle.jsonl"));
        let next_event_id = events.back().map(|event| event.id + 1).unwrap_or(1);
        Ok(Self {
            workspace_root,
            registry_path,
            state_root,
            log_root,
            registrations: registry.services,
            runtimes,
            modes,
            events,
            next_event_id,
            load_error: None,
        })
    }

    pub(crate) fn reconcile(&mut self) {
        let service_ids = self
            .registrations
            .iter()
            .map(|service| service.id.clone())
            .collect::<Vec<_>>();
        for service_id in service_ids {
            self.reconcile_service(&service_id);
        }
    }

    fn reconcile_service(&mut self, service_id: &str) {
        let Some(registration) = self
            .registrations
            .iter()
            .find(|service| service.id == service_id)
            .cloned()
        else {
            return;
        };
        let mode = self
            .modes
            .get(service_id)
            .copied()
            .unwrap_or(StartupMode::Manual);

        let mut exited = None;
        if let Some(runtime) = self.runtimes.get_mut(service_id) {
            if let Some(child) = runtime.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        exited = Some((runtime.known_pid, status.code()));
                        runtime.child = None;
                        runtime.known_pid = None;
                        runtime.started_at = None;
                    }
                    Ok(None) => runtime.known_pid = Some(child.id()),
                    Err(error) => runtime.last_reason = Some(format!("进程状态读取失败：{error}")),
                }
            }
        }
        if let Some((pid, code)) = exited {
            self.append_event(
                &registration,
                "exit",
                "warning",
                "supervisor",
                format!(
                    "进程已退出，退出码 {}",
                    code.map_or_else(|| "未知".to_string(), |value| value.to_string())
                ),
                pid,
            );
        }

        let probe = probe_registration(&registration);
        let mut should_start = false;
        let mut unexpected_exit = false;
        if let Some(runtime) = self.runtimes.get_mut(service_id) {
            if probe.ok {
                runtime.observed_running = true;
                runtime.desired_running = mode == StartupMode::Normal || runtime.desired_running;
                runtime.last_reason = None;
                if runtime.known_pid.is_none() {
                    runtime.known_pid = listener_pid(resolved_port(&registration));
                }
            } else {
                let port_pid = if runtime.child.is_some() {
                    runtime.known_pid
                } else {
                    listener_pid(resolved_port(&registration))
                };
                if port_pid.is_some() {
                    runtime.known_pid = port_pid;
                } else if runtime.child.is_none() {
                    if runtime.observed_running {
                        unexpected_exit = true;
                    }
                    runtime.observed_running = false;
                    runtime.known_pid = None;
                    runtime.started_at = None;
                    if mode == StartupMode::Manual {
                        runtime.desired_running = false;
                    }
                    should_start = mode == StartupMode::Normal
                        && runtime
                            .last_launch_attempt
                            .is_none_or(|attempt| attempt.elapsed() >= RESTART_BACKOFF);
                }
                runtime.last_reason = probe.reason.clone();
            }
            runtime.last_probe = Some(probe);
        }
        if unexpected_exit {
            self.append_event(
                &registration,
                "exit",
                "warning",
                "health-probe",
                "探针确认进程已停止".to_string(),
                None,
            );
        }
        if should_start {
            let source = if exited.is_some() || unexpected_exit {
                "auto-restart"
            } else {
                "startup"
            };
            let _ = self.start_service(service_id, source);
        }
    }

    pub(crate) fn action(
        &mut self,
        service_id: &str,
        action: &str,
        source: &str,
    ) -> Result<String, String> {
        match action.trim().to_ascii_lowercase().as_str() {
            "start" => self.start_service(service_id, source),
            "stop" => self.stop_service(service_id, source, true),
            "restart" => {
                let mode = self.mode(service_id)?;
                if mode == StartupMode::Disabled {
                    return Err("服务已禁用，请先修改启动模式".to_string());
                }
                self.stop_service(service_id, source, false)?;
                std::thread::sleep(Duration::from_millis(250));
                self.start_service(service_id, source)
            }
            _ => Err("服务操作仅支持 start、stop 或 restart".to_string()),
        }
    }

    pub(crate) fn set_startup_mode(
        &mut self,
        service_id: &str,
        mode: &str,
        source: &str,
    ) -> Result<String, String> {
        self.registration(service_id)?;
        let mode = StartupMode::parse(mode)?;
        self.modes.insert(service_id.to_string(), mode);
        if let Some(runtime) = self.runtimes.get_mut(service_id) {
            runtime.desired_running = mode == StartupMode::Normal
                || (mode == StartupMode::Manual && runtime.observed_running);
        }
        self.persist_modes()?;
        let registration = self.registration(service_id)?.clone();
        self.append_event(
            &registration,
            "startup-mode",
            "success",
            source,
            format!("启动模式已设置为 {}", mode.as_str()),
            self.runtimes
                .get(service_id)
                .and_then(|runtime| runtime.known_pid),
        );
        if mode == StartupMode::Disabled {
            let _ = self.stop_service(service_id, source, false);
        } else if mode == StartupMode::Normal {
            let probe = probe_registration(&registration);
            if !probe.ok && listener_pid(resolved_port(&registration)).is_none() {
                let _ = self.start_service(service_id, source);
            }
        }
        Ok(format!(
            "{} 启动模式已设置为 {}",
            registration.name,
            mode.as_str()
        ))
    }

    fn start_service(&mut self, service_id: &str, source: &str) -> Result<String, String> {
        let registration = self.registration(service_id)?.clone();
        let mode = self.mode(service_id)?;
        if mode == StartupMode::Disabled {
            return Err("服务已禁用，请先修改启动模式".to_string());
        }
        if probe_registration(&registration).ok {
            let pid = listener_pid(resolved_port(&registration));
            if let Some(runtime) = self.runtimes.get_mut(service_id) {
                runtime.known_pid = pid.or(runtime.known_pid);
                runtime.desired_running = true;
                runtime.observed_running = true;
            }
            let message = format!("{} 已在运行", registration.name);
            self.append_event(
                &registration,
                "start",
                "success",
                source,
                message.clone(),
                pid,
            );
            return Ok(message);
        }
        let process = registration
            .process
            .as_ref()
            .ok_or_else(|| "服务没有注册启动命令".to_string())?;
        let command_path = resolve_command(process, &self.workspace_root)
            .ok_or_else(|| format!("未找到 {} 的可执行命令", registration.name))?;
        let working_directory = resolve_workspace_path(
            &self.workspace_root,
            if process.working_directory.trim().is_empty() {
                "."
            } else {
                &process.working_directory
            },
        );
        fs::create_dir_all(&self.log_root)
            .map_err(|error| format!("服务日志目录创建失败：{error}"))?;
        let stdout_name = if process.stdout_log.trim().is_empty() {
            format!("{}.out.log", registration.id)
        } else {
            process.stdout_log.clone()
        };
        let stderr_name = if process.stderr_log.trim().is_empty() {
            format!("{}.err.log", registration.id)
        } else {
            process.stderr_log.clone()
        };
        let stdout = open_append_log(&self.log_root.join(stdout_name))?;
        let stderr = open_append_log(&self.log_root.join(stderr_name))?;
        let mut command = Command::new(&command_path);
        command
            .args(process.arguments.iter().map(|argument| {
                expand_value(
                    argument,
                    &self.workspace_root,
                    &self.state_root,
                    &self.log_root,
                )
            }))
            .current_dir(&working_directory)
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        for (name, value) in &process.environment {
            command.env(
                name,
                expand_value(
                    value,
                    &self.workspace_root,
                    &self.state_root,
                    &self.log_root,
                ),
            );
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("{} 启动失败：{error}", registration.name));
        match child {
            Ok(child) => {
                let pid = child.id();
                if let Some(runtime) = self.runtimes.get_mut(service_id) {
                    runtime.child = Some(child);
                    runtime.known_pid = Some(pid);
                    runtime.desired_running = true;
                    runtime.started_at = Some(unix_time_millis());
                    runtime.last_launch_attempt = Some(Instant::now());
                    runtime.restart_count = runtime.restart_count.saturating_add(1);
                    runtime.last_reason = None;
                    runtime.last_probe = None;
                }
                let message = format!("{} 启动命令已执行", registration.name);
                self.append_event(
                    &registration,
                    "start",
                    "success",
                    source,
                    message.clone(),
                    Some(pid),
                );
                Ok(message)
            }
            Err(error) => {
                if let Some(runtime) = self.runtimes.get_mut(service_id) {
                    runtime.last_launch_attempt = Some(Instant::now());
                    runtime.last_reason = Some(error.clone());
                }
                self.append_event(
                    &registration,
                    "start",
                    "failed",
                    source,
                    error.clone(),
                    None,
                );
                Err(error)
            }
        }
    }

    fn stop_service(
        &mut self,
        service_id: &str,
        source: &str,
        operator_stop: bool,
    ) -> Result<String, String> {
        let registration = self.registration(service_id)?.clone();
        if operator_stop && self.mode(service_id)? == StartupMode::Normal {
            self.modes
                .insert(service_id.to_string(), StartupMode::Manual);
            self.persist_modes()?;
        }
        let mut pid = self
            .runtimes
            .get(service_id)
            .and_then(|runtime| runtime.known_pid)
            .or_else(|| listener_pid(resolved_port(&registration)));
        if pid == Some(std::process::id()) {
            pid = None;
        }
        let result = if let Some(pid) = pid {
            terminate_process_tree(pid)
        } else {
            Ok(())
        };
        if let Some(runtime) = self.runtimes.get_mut(service_id) {
            if let Some(child) = runtime.child.as_mut() {
                let _ = child.try_wait();
            }
            runtime.child = None;
            runtime.known_pid = None;
            runtime.desired_running = false;
            runtime.started_at = None;
            runtime.observed_running = false;
            runtime.last_reason = None;
            runtime.last_probe = None;
        }
        match result {
            Ok(()) => {
                let message = if pid.is_some() {
                    format!("{} 已停止", registration.name)
                } else {
                    format!("{} 已处于停止状态", registration.name)
                };
                self.append_event(
                    &registration,
                    "stop",
                    "success",
                    source,
                    message.clone(),
                    pid,
                );
                Ok(message)
            }
            Err(error) => {
                self.append_event(&registration, "stop", "failed", source, error.clone(), pid);
                Err(error)
            }
        }
    }

    pub(crate) fn snapshot(&self) -> SupervisorSnapshot {
        let services = self
            .registrations
            .iter()
            .map(|registration| self.service_snapshot(registration))
            .collect::<Vec<_>>();
        SupervisorSnapshot {
            services,
            lifecycle_logs: self.events.iter().rev().cloned().collect(),
            registry: json!({
                "schema": "steel.service-registry.v1",
                "version": 1,
                "path": self.registry_path,
                "owner": "tauri-service-supervisor",
                "loadError": self.load_error,
                "services": self.registrations.iter().map(|service| json!({
                    "id": service.id,
                    "name": service.name,
                    "managed": service.process.is_some()
                })).collect::<Vec<_>>()
            }),
            state_root: self.state_root.clone(),
            log_root: self.log_root.clone(),
        }
    }

    fn service_snapshot(&self, registration: &ServiceRegistration) -> SupervisorServiceSnapshot {
        let mode = self
            .modes
            .get(&registration.id)
            .copied()
            .unwrap_or(StartupMode::Manual);
        let runtime = self.runtimes.get(&registration.id);
        let probe = runtime
            .and_then(|runtime| runtime.last_probe.clone())
            .unwrap_or_else(|| probe_registration(registration));
        let pid = runtime.and_then(|runtime| runtime.known_pid);
        let started_at = runtime.and_then(|runtime| runtime.started_at);
        let process_alive = pid.is_some();
        let status = if mode == StartupMode::Disabled {
            "disabled"
        } else if probe.ok {
            "running"
        } else if process_alive && probe.status > 0 {
            "degraded"
        } else if process_alive {
            "starting"
        } else {
            "stopped"
        };
        let reason = probe.reason.clone().or_else(|| {
            runtime
                .and_then(|runtime| runtime.last_reason.clone())
                .filter(|value| !value.is_empty())
        });
        let managed = registration.process.is_some();
        let can_start = managed && mode != StartupMode::Disabled && !probe.ok;
        let can_stop = managed && (process_alive || probe.ok);
        SupervisorServiceSnapshot {
            id: registration.id.clone(),
            name: registration.name.clone(),
            role: registration.role.clone(),
            kind: registration.kind.clone(),
            origin: resolved_origin(registration),
            port: resolved_port(registration),
            health_path: registration.health_path.clone(),
            ok: probe.ok,
            required: registration.required,
            status: status.to_string(),
            response_status: probe.status,
            latency_ms: probe.latency_ms,
            uptime_ms: started_at.map(|started| unix_time_millis().saturating_sub(started)),
            reason,
            lifecycle: json!({
                "source": "tauri-service-supervisor",
                "registeredLifecycle": registration.lifecycle,
                "phase": status,
                "desiredRunning": runtime.is_some_and(|runtime| runtime.desired_running),
                "pid": pid,
                "startedAt": started_at.map(|value| value.to_string()),
                "restartCount": runtime.map_or(0, |runtime| runtime.restart_count),
                "autoRestart": mode == StartupMode::Normal
            }),
            operations: vec![
                json!({"id":"refresh-status","label":"刷新状态","effect":"query","scope":"service","enabled":true}),
                json!({"id":"start","label":"启动","effect":"mutation","scope":"service","enabled":can_start}),
                json!({"id":"stop","label":"停止","effect":"mutation","scope":"service","enabled":can_stop}),
                json!({"id":"restart","label":"重启","effect":"mutation","scope":"service","enabled":managed && mode != StartupMode::Disabled && (process_alive || probe.ok)}),
                json!({"id":"set-startup-mode","label":"启动模式","effect":"mutation","scope":"service","enabled":managed}),
            ],
            control: json!({
                "mode": if managed { "control" } else { "observe" },
                "owner": "tauri-service-supervisor",
                "reason": if managed { Value::Null } else { json!("service_has_no_registered_process") }
            }),
            startup_mode: mode.as_str().to_string(),
            auto_restart: mode == StartupMode::Normal,
            managed,
        }
    }

    fn registration(&self, service_id: &str) -> Result<&ServiceRegistration, String> {
        self.registrations
            .iter()
            .find(|service| service.id == service_id)
            .ok_or_else(|| format!("未注册服务：{service_id}"))
    }

    fn mode(&self, service_id: &str) -> Result<StartupMode, String> {
        self.modes
            .get(service_id)
            .copied()
            .ok_or_else(|| format!("未注册服务：{service_id}"))
    }

    fn persist_modes(&self) -> Result<(), String> {
        fs::create_dir_all(&self.state_root)
            .map_err(|error| format!("启动模式目录创建失败：{error}"))?;
        let values = self
            .modes
            .iter()
            .map(|(id, mode)| (id.clone(), mode.as_str()))
            .collect::<HashMap<_, _>>();
        let payload = serde_json::to_string_pretty(&json!({
            "schema": "steel.service-startup-modes.v1",
            "services": values
        }))
        .map_err(|error| format!("启动模式序列化失败：{error}"))?;
        fs::write(self.state_root.join("service-startup-modes.json"), payload)
            .map_err(|error| format!("启动模式保存失败：{error}"))
    }

    fn append_event(
        &mut self,
        registration: &ServiceRegistration,
        action: &str,
        outcome: &str,
        source: &str,
        message: String,
        pid: Option<u32>,
    ) {
        let event = ServiceLifecycleEvent {
            id: self.next_event_id,
            timestamp: unix_time_millis().to_string(),
            service_id: registration.id.clone(),
            service_name: registration.name.clone(),
            action: action.to_string(),
            outcome: outcome.to_string(),
            source: source.to_string(),
            message,
            pid,
        };
        self.next_event_id = self.next_event_id.saturating_add(1);
        self.events.push_back(event.clone());
        while self.events.len() > MAX_EVENTS {
            self.events.pop_front();
        }
        let path = self.log_root.join("service-lifecycle.jsonl");
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            if let Ok(line) = serde_json::to_string(&event) {
                let _ = writeln!(file, "{line}");
            }
        }
    }
}

fn runtime_state_root(workspace_root: &Path) -> PathBuf {
    std::env::var("STEEL_MONITOR_STATE_ROOT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| workspace_root.join("target/run/server-monitor"))
}

fn discover_workspace_root() -> PathBuf {
    if let Ok(explicit) = std::env::var("STEEL_WORKSPACE_ROOT") {
        let root = PathBuf::from(explicit);
        if root.join("config/service-registry.json").is_file() {
            return root;
        }
    }
    let mut candidates = Vec::new();
    if let Ok(current) = std::env::current_dir() {
        candidates.push(current);
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.to_path_buf());
        }
    }
    for candidate in candidates {
        for ancestor in candidate.ancestors() {
            if ancestor.join("config/service-registry.json").is_file() {
                return ancestor.to_path_buf();
            }
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn read_modes(path: &Path) -> HashMap<String, StartupMode> {
    let Ok(text) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return HashMap::new();
    };
    value
        .get("services")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(id, mode)| Some((id.clone(), StartupMode::parse(mode.as_str()?).ok()?)))
        .collect()
}

fn read_events(path: &Path) -> VecDeque<ServiceLifecycleEvent> {
    let Ok(text) = fs::read_to_string(path) else {
        return VecDeque::new();
    };
    text.lines()
        .rev()
        .take(MAX_EVENTS)
        .filter_map(|line| serde_json::from_str::<ServiceLifecycleEvent>(line).ok())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

fn resolved_origin(registration: &ServiceRegistration) -> String {
    if let Some(name) = registration.origin_env.as_deref() {
        if let Ok(value) = std::env::var(name) {
            if normalize_origin(&value).is_some() {
                return value.trim_end_matches('/').to_string();
            }
        }
    }
    if let Some(name) = registration.port_env.as_deref() {
        if let Some(port) = std::env::var(name)
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
        {
            let base = normalize_origin(&registration.default_origin)
                .unwrap_or_else(|| "http://127.0.0.1:80".to_string());
            let host = base
                .strip_prefix("http://")
                .and_then(|authority| authority.rsplit_once(':').map(|(host, _)| host))
                .unwrap_or("127.0.0.1");
            return format!("http://{host}:{port}");
        }
    }
    normalize_origin(&registration.default_origin)
        .unwrap_or_else(|| registration.default_origin.clone())
}

fn resolved_port(registration: &ServiceRegistration) -> u16 {
    normalize_origin(&resolved_origin(registration))
        .and_then(|origin| origin.rsplit_once(':')?.1.parse::<u16>().ok())
        .unwrap_or(80)
}

fn normalize_origin(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    let authority = trimmed.strip_prefix("http://")?;
    if authority.is_empty()
        || authority.contains(['/', '\\', '@', '?', '#', '\r', '\n'])
        || authority.chars().any(char::is_whitespace)
    {
        return None;
    }
    let (host, port) = authority.rsplit_once(':')?;
    let port = port.parse::<u16>().ok().filter(|port| *port > 0)?;
    if !matches!(host, "127.0.0.1" | "localhost") {
        return None;
    }
    Some(format!("http://{host}:{port}"))
}

fn probe_registration(registration: &ServiceRegistration) -> ProbeResult {
    let origin = resolved_origin(registration);
    let started = Instant::now();
    let Some(authority) = origin.strip_prefix("http://") else {
        return ProbeResult {
            ok: false,
            status: 0,
            latency_ms: 0,
            reason: Some("服务地址无效".to_string()),
        };
    };
    let Some((host, port)) = authority.rsplit_once(':') else {
        return ProbeResult {
            ok: false,
            status: 0,
            latency_ms: 0,
            reason: Some("服务地址无效".to_string()),
        };
    };
    let Some(port) = port.parse::<u16>().ok() else {
        return ProbeResult {
            ok: false,
            status: 0,
            latency_ms: 0,
            reason: Some("服务端口无效".to_string()),
        };
    };
    let address = (host, port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next());
    let Some(address) = address else {
        return ProbeResult {
            ok: false,
            status: 0,
            latency_ms: started.elapsed().as_millis() as u64,
            reason: Some("服务地址不可解析".to_string()),
        };
    };
    let mut stream = match TcpStream::connect_timeout(&address, HEALTH_TIMEOUT) {
        Ok(stream) => stream,
        Err(_) => {
            return ProbeResult {
                ok: false,
                status: 0,
                latency_ms: started.elapsed().as_millis() as u64,
                reason: Some("进程未监听服务端口".to_string()),
            }
        }
    };
    let _ = stream.set_read_timeout(Some(HEALTH_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HEALTH_TIMEOUT));
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n",
        registration.health_path
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return ProbeResult {
            ok: false,
            status: 0,
            latency_ms: started.elapsed().as_millis() as u64,
            reason: Some("健康请求发送失败".to_string()),
        };
    }
    let mut response = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                response.extend_from_slice(&buffer[..count]);
                if response.len() > 256 * 1024 {
                    break;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                break;
            }
            Err(_) => break,
        }
    }
    let separator = response.windows(4).position(|window| window == b"\r\n\r\n");
    let header_end = separator.unwrap_or(response.len());
    let status = std::str::from_utf8(&response[..header_end])
        .ok()
        .and_then(|text| text.lines().next())
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    let payload = separator
        .and_then(|index| response.get(index + 4..))
        .and_then(|body| serde_json::from_slice::<Value>(body).ok());
    let http_ok = (200..300).contains(&status);
    let semantic_ready = if registration.kind == "capture" {
        payload.as_ref().and_then(|value| {
            value
                .get("providerReady")
                .or_else(|| value.get("ready"))
                .and_then(Value::as_bool)
        })
    } else {
        payload.as_ref().and_then(|value| {
            value
                .get("ready")
                .or_else(|| value.get("gatewayReady"))
                .or_else(|| value.get("ok"))
                .and_then(Value::as_bool)
        })
    };
    let ok = http_ok && semantic_ready.unwrap_or(true);
    let reason = if !http_ok {
        Some(if status == 0 {
            "健康响应无效".to_string()
        } else {
            format!("健康检查返回 HTTP {status}")
        })
    } else if semantic_ready == Some(false) && registration.kind == "capture" {
        let payload = payload.as_ref();
        let history_only = payload
            .and_then(|value| value.get("historyOnly"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let connected = payload
            .and_then(|value| value.get("cameraCount"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let expected = payload
            .and_then(|value| value.get("expectedCameras"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let detail = payload
            .and_then(|value| value.get("lastError"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.chars().take(160).collect::<String>());
        Some(if history_only {
            "采集服务正在历史只读模式运行，未尝试连接相机".to_string()
        } else if let Some(detail) = detail {
            format!("采集进程运行且已尝试连接相机（{connected}/{expected}）：{detail}")
        } else {
            format!("采集进程运行且已尝试连接相机，但相机尚未就绪（{connected}/{expected}）")
        })
    } else if semantic_ready == Some(false) {
        Some("服务进程可达，但内部就绪检查未通过".to_string())
    } else {
        None
    };
    ProbeResult {
        ok,
        status,
        latency_ms: started.elapsed().as_millis() as u64,
        reason,
    }
}

fn resolve_command(process: &ProcessDefinition, workspace_root: &Path) -> Option<PathBuf> {
    std::iter::once(process.command.as_str())
        .chain(process.command_candidates.iter().map(String::as_str))
        .filter(|value| !value.trim().is_empty())
        .map(|value| resolve_workspace_path(workspace_root, value))
        .find(|path| path.is_file())
}

fn resolve_workspace_path(workspace_root: &Path, value: &str) -> PathBuf {
    let expanded = value.replace("{workspaceRoot}", &workspace_root.to_string_lossy());
    let path = PathBuf::from(expanded);
    if path.is_absolute() {
        path
    } else {
        workspace_root.join(path)
    }
}

fn expand_value(value: &str, workspace_root: &Path, state_root: &Path, log_root: &Path) -> String {
    value
        .replace("{workspaceRoot}", &workspace_root.to_string_lossy())
        .replace("{stateRoot}", &state_root.to_string_lossy())
        .replace("{logRoot}", &log_root.to_string_lossy())
}

fn open_append_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("服务日志打开失败（{}）：{error}", path.display()))
}

#[cfg(windows)]
fn listener_pid(port: u16) -> Option<u32> {
    let script = format!(
        "(Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)"
    );
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

#[cfg(not(windows))]
fn listener_pid(_port: u16) -> Option<u32> {
    None
}

#[cfg(windows)]
fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let status = Command::new("taskkill.exe")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| format!("停止进程 {pid} 失败：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("停止进程 {pid} 失败，退出码 {:?}", status.code()))
    }
}

#[cfg(not(windows))]
fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|error| format!("停止进程 {pid} 失败：{error}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("停止进程 {pid} 失败"))
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_modes_are_bounded_and_normal_enables_auto_restart() {
        assert_eq!(StartupMode::parse("normal"), Ok(StartupMode::Normal));
        assert_eq!(StartupMode::parse("auto"), Ok(StartupMode::Normal));
        assert_eq!(StartupMode::parse("manual"), Ok(StartupMode::Manual));
        assert_eq!(StartupMode::parse("disabled"), Ok(StartupMode::Disabled));
        assert!(StartupMode::parse("legacy").is_err());
        assert_eq!(StartupMode::Normal.as_str(), "normal");
    }

    #[test]
    fn monitor_only_accepts_loopback_service_origins() {
        assert_eq!(
            normalize_origin("http://127.0.0.1:4873/"),
            Some("http://127.0.0.1:4873".to_string())
        );
        assert!(normalize_origin("https://127.0.0.1:4873").is_none());
        assert!(normalize_origin("http://10.0.0.1:4873").is_none());
    }
}
