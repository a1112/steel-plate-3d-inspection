use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
const MAX_CONSECUTIVE_START_FAILURES: u32 = 5;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RUNTIME_MODE_COMMIT_PATH: &str = "config/runtime-mode-commit.json";
const RUNTIME_MODE_RELEASE_DELAY_MILLIS: u64 = 5_000;
const RUNTIME_MODE_STALE_FENCE_MILLIS: u64 = 120_000;

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
    enabled_when_modes: Vec<String>,
    #[serde(default)]
    required_when_modes: Vec<String>,
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

fn normalize_acquisition_mode(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "online" => Some("online"),
        "offline" => Some("offline"),
        "simulation" | "simulated" | "replay" => Some("simulation"),
        _ => None,
    }
}

fn runtime_value_acquisition_mode(runtime: &Value) -> String {
    if let Some(mode) = runtime
        .get("acquisitionMode")
        .and_then(Value::as_str)
        .and_then(normalize_acquisition_mode)
    {
        return mode.to_string();
    }
    let provider = runtime
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if provider.eq_ignore_ascii_case("simulated") {
        "simulation".to_string()
    } else if provider.eq_ignore_ascii_case("bkv")
        || runtime
            .get("cameraConnection")
            .and_then(Value::as_str)
            .is_some_and(|value| value.eq_ignore_ascii_case("none"))
    {
        "offline".to_string()
    } else {
        "online".to_string()
    }
}

fn mode_list_contains(values: &[String], mode: &str) -> bool {
    values
        .iter()
        .filter_map(|value| normalize_acquisition_mode(value))
        .any(|value| value == mode)
}

fn service_enabled_for_mode(registration: &ServiceRegistration, mode: &str) -> bool {
    registration.enabled_when_modes.is_empty()
        || mode_list_contains(&registration.enabled_when_modes, mode)
}

fn service_required_for_mode(registration: &ServiceRegistration, mode: &str) -> bool {
    registration.required
        && service_enabled_for_mode(registration, mode)
        && (registration.required_when_modes.is_empty()
            || mode_list_contains(&registration.required_when_modes, mode))
}

fn resolve_config_reference(workspace_root: &Path, base: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return path;
    }
    let workspace_candidate = workspace_root.join(&path);
    if workspace_candidate.exists() {
        workspace_candidate
    } else {
        base.join(path)
    }
}

fn write_supervisor_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "目标路径缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("目标目录创建失败：{error}"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "目标文件名无效".to_string())?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", unix_time_millis()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("临时文件创建失败：{error}"))?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|error| format!("临时文件写入失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("临时文件刷盘失败：{error}"))?;
        drop(file);
        replace_supervisor_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_supervisor_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|error| format!("原子发布失败：{error}"))
}

#[cfg(windows)]
fn replace_supervisor_file(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(format!("原子发布失败：{}", std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

fn validated_staged_runtime_profile(
    workspace_root: &Path,
    relative: &str,
) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        || !relative.starts_with(Path::new("config/runtime-mode-staging"))
    {
        return Err("运行模式暂存路径越界".to_string());
    }
    let canonical_root =
        fs::canonicalize(workspace_root).map_err(|error| format!("工作目录不可用：{error}"))?;
    let candidate = fs::canonicalize(workspace_root.join(relative))
        .map_err(|error| format!("运行模式暂存文件不可用：{error}"))?;
    if !candidate.starts_with(&canonical_root) || !candidate.is_file() {
        return Err("运行模式暂存文件越界或不是普通文件".to_string());
    }
    Ok(candidate)
}

fn configured_acquisition_mode(workspace_root: &Path) -> Result<String, String> {
    let project_path = workspace_root.join("config/project.json");
    let project = fs::read_to_string(&project_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let Some(project) = project else {
        return Ok("online".to_string());
    };
    let project_root = project_path.parent().unwrap_or(workspace_root);
    let runtime_path = if let Some(site_reference) = project
        .get("activeSiteConfig")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        let site_path =
            resolve_config_reference(workspace_root, project_root, site_reference.trim());
        let site = fs::read_to_string(&site_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok());
        site.and_then(|site| {
            let runtime = site.get("runtimeProfile")?.as_str()?.trim();
            let base = site_path.parent().unwrap_or(project_root);
            Some(resolve_config_reference(workspace_root, base, runtime))
        })
    } else {
        project
            .get("activeRuntimeProfile")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(|value| resolve_config_reference(workspace_root, project_root, value.trim()))
    };
    let runtime_path =
        runtime_path.ok_or_else(|| "运行模式配置路径缺失，监督器保持已应用模式".to_string())?;
    let runtime_bytes = fs::read(&runtime_path)
        .map_err(|error| format!("运行模式配置读取失败，监督器保持已应用模式：{error}"))?;
    let runtime = serde_json::from_slice::<Value>(&runtime_bytes).ok();
    let Some(runtime) = runtime else {
        return Err("运行模式配置无效，监督器保持已应用模式".to_string());
    };
    let profile_mode = runtime_value_acquisition_mode(&runtime);

    let commit_path = workspace_root.join(RUNTIME_MODE_COMMIT_PATH);
    if !commit_path.exists() {
        return Ok(profile_mode);
    }
    let commit_bytes = fs::read(&commit_path)
        .map_err(|error| format!("运行模式提交记录读取失败，监督器保持已应用模式：{error}"))?;
    let commit = serde_json::from_slice::<Value>(&commit_bytes)
        .map_err(|error| format!("运行模式提交记录无效，监督器保持已应用模式：{error}"))?;
    if commit.get("schema").and_then(Value::as_str) != Some("steel.runtime-mode-commit.v1") {
        return Err("运行模式提交记录 schema 无效，监督器保持已应用模式".to_string());
    }
    let committed_mode = commit
        .get("acquisitionMode")
        .and_then(Value::as_str)
        .and_then(normalize_acquisition_mode)
        .ok_or_else(|| "运行模式提交记录 mode 无效，监督器保持已应用模式".to_string())?
        .to_string();
    match commit.get("state").and_then(Value::as_str) {
        // A fence is written with the currently applied mode before new profile
        // bytes are published. Holding that mode is intentional even after the
        // profile hash changes: revision/audit persistence has not committed yet.
        Some("fence") => {
            let expected_hash =
                commit
                    .get("profileSha256")
                    .and_then(Value::as_str)
                    .filter(|value| {
                        value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                    });
            let actual_hash = format!("{:x}", Sha256::digest(&runtime_bytes));
            let fence_matches_previous = expected_hash
                .is_some_and(|value| value.eq_ignore_ascii_case(&actual_hash))
                && committed_mode == profile_mode;
            let updated_at = commit
                .get("updatedAt")
                .and_then(|value| {
                    value
                        .as_u64()
                        .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
                })
                .unwrap_or(u64::MAX);
            if fence_matches_previous
                && unix_time_millis().saturating_sub(updated_at) >= RUNTIME_MODE_STALE_FENCE_MILLIS
            {
                let mut recovered = commit.clone();
                recovered["state"] = json!("committed");
                recovered["recoveredAt"] = json!(unix_time_millis().to_string());
                recovered["recoveryReason"] = json!("stale-fence-profile-unchanged");
                let recovered_bytes = serde_json::to_vec_pretty(&recovered)
                    .map_err(|error| format!("运行模式围栏恢复序列化失败：{error}"))?;
                write_supervisor_bytes_atomic(&commit_path, &recovered_bytes).map_err(|error| {
                    format!("运行模式围栏恢复失败，监督器保持已应用模式：{error}")
                })?;
            }
            Ok(committed_mode)
        }
        Some("committed") => {
            let expected_hash = commit
                .get("profileSha256")
                .and_then(Value::as_str)
                .filter(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| {
                    "运行模式提交记录缺少有效 profileSha256，监督器保持已应用模式".to_string()
                })?;
            let actual_hash = format!("{:x}", Sha256::digest(&runtime_bytes));
            if !expected_hash.eq_ignore_ascii_case(&actual_hash) || committed_mode != profile_mode {
                return Err(
                    "运行模式提交记录与当前 profile 不一致，监督器保持已应用模式".to_string(),
                );
            }
            Ok(committed_mode)
        }
        Some("ready") => {
            let expected_hash = commit
                .get("profileSha256")
                .and_then(Value::as_str)
                .filter(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| {
                    "运行模式就绪记录缺少有效 profileSha256，监督器保持已应用模式".to_string()
                })?;
            let actual_hash = format!("{:x}", Sha256::digest(&runtime_bytes));
            if !expected_hash.eq_ignore_ascii_case(&actual_hash) || committed_mode != profile_mode {
                return Err(
                    "运行模式就绪记录与当前 profile 不一致，监督器保持已应用模式".to_string(),
                );
            }
            let previous_mode = commit
                .get("previousAcquisitionMode")
                .and_then(Value::as_str)
                .and_then(normalize_acquisition_mode)
                .ok_or_else(|| {
                    "运行模式就绪记录缺少 previousAcquisitionMode，监督器保持已应用模式".to_string()
                })?;
            let release_after = commit
                .get("releaseAfterMillis")
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    "运行模式就绪记录缺少 releaseAfterMillis，监督器保持已应用模式".to_string()
                })?;
            if unix_time_millis() < release_after {
                Ok(previous_mode.to_string())
            } else {
                Ok(committed_mode)
            }
        }
        Some("publish") => {
            let expected_hash = commit
                .get("profileSha256")
                .and_then(Value::as_str)
                .filter(|value| {
                    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| {
                    "运行模式发布日志缺少有效 profileSha256，监督器保持已应用模式".to_string()
                })?;
            let staged_relative = commit
                .get("stagedProfile")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    "运行模式发布日志缺少 stagedProfile，监督器保持已应用模式".to_string()
                })?;
            let staged_path = validated_staged_runtime_profile(workspace_root, staged_relative)?;
            let staged_bytes = fs::read(&staged_path)
                .map_err(|error| format!("运行模式暂存文件读取失败：{error}"))?;
            let staged_hash = format!("{:x}", Sha256::digest(&staged_bytes));
            let staged_value = serde_json::from_slice::<Value>(&staged_bytes)
                .map_err(|error| format!("运行模式暂存 JSON 无效：{error}"))?;
            if !expected_hash.eq_ignore_ascii_case(&staged_hash)
                || runtime_value_acquisition_mode(&staged_value) != committed_mode
            {
                return Err("运行模式暂存文件与发布日志不一致，监督器保持已应用模式".to_string());
            }
            let current_hash = format!("{:x}", Sha256::digest(&runtime_bytes));
            if !current_hash.eq_ignore_ascii_case(expected_hash) {
                write_supervisor_bytes_atomic(&runtime_path, &staged_bytes).map_err(|error| {
                    format!("运行模式故障恢复发布 profile 失败，监督器保持已应用模式：{error}")
                })?;
            }
            let previous_mode = commit
                .get("previousAcquisitionMode")
                .and_then(Value::as_str)
                .and_then(normalize_acquisition_mode)
                .ok_or_else(|| {
                    "运行模式发布日志缺少 previousAcquisitionMode，监督器保持已应用模式".to_string()
                })?;
            let mut ready = commit.clone();
            ready["state"] = json!("ready");
            ready["releaseAfterMillis"] =
                json!(unix_time_millis().saturating_add(RUNTIME_MODE_RELEASE_DELAY_MILLIS));
            ready["updatedAt"] = json!(unix_time_millis().to_string());
            let ready_bytes = serde_json::to_vec_pretty(&ready)
                .map_err(|error| format!("运行模式就绪日志序列化失败：{error}"))?;
            write_supervisor_bytes_atomic(&commit_path, &ready_bytes).map_err(|error| {
                format!("运行模式就绪日志发布失败，监督器保持已应用模式：{error}")
            })?;
            let _ = fs::remove_file(staged_path);
            Ok(previous_mode.to_string())
        }
        _ => Err("运行模式提交记录 state 无效，监督器保持已应用模式".to_string()),
    }
}

fn runtime_mode_transition_hold(workspace_root: &Path) -> bool {
    let path = workspace_root.join(RUNTIME_MODE_COMMIT_PATH);
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    let Ok(marker) = serde_json::from_slice::<Value>(&bytes) else {
        return true;
    };
    if marker.get("schema").and_then(Value::as_str) != Some("steel.runtime-mode-commit.v1") {
        return true;
    }
    match marker.get("state").and_then(Value::as_str) {
        Some("committed") => {
            marker
                .get("acquisitionMode")
                .and_then(Value::as_str)
                .and_then(normalize_acquisition_mode)
                .is_none()
                || marker
                    .get("profileSha256")
                    .and_then(Value::as_str)
                    .is_none_or(|value| {
                        value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
        }
        Some("fence") => true,
        Some("ready") => marker
            .get("releaseAfterMillis")
            .and_then(Value::as_u64)
            .is_none_or(|release_after| unix_time_millis() < release_after),
        Some("publish") => true,
        _ => true,
    }
}

fn promote_released_runtime_mode(
    workspace_root: &Path,
    acquisition_mode: &str,
) -> Result<(), String> {
    let path = workspace_root.join(RUNTIME_MODE_COMMIT_PATH);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("运行模式就绪日志读取失败：{error}")),
    };
    let mut marker: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("运行模式就绪日志无效：{error}"))?;
    if marker.get("state").and_then(Value::as_str) == Some("committed") {
        return Ok(());
    }
    if marker.get("state").and_then(Value::as_str) != Some("ready")
        || marker
            .get("acquisitionMode")
            .and_then(Value::as_str)
            .and_then(normalize_acquisition_mode)
            != normalize_acquisition_mode(acquisition_mode)
        || marker
            .get("releaseAfterMillis")
            .and_then(Value::as_u64)
            .is_none_or(|release_after| unix_time_millis() < release_after)
    {
        return Err("运行模式就绪日志尚未释放或与目标模式不一致".to_string());
    }
    marker["state"] = json!("committed");
    marker["committedAt"] = json!(unix_time_millis().to_string());
    let bytes = serde_json::to_vec_pretty(&marker)
        .map_err(|error| format!("运行模式提交日志序列化失败：{error}"))?;
    write_supervisor_bytes_atomic(&path, &bytes)
}

fn read_applied_acquisition_mode(path: &Path) -> Option<String> {
    let payload = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&payload).ok()?;
    value
        .get("acquisitionMode")
        .and_then(Value::as_str)
        .and_then(normalize_acquisition_mode)
        .map(str::to_string)
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
    pub enabled_for_mode: bool,
    pub acquisition_mode: String,
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
    consecutive_start_failures: u32,
    startup_faulted: bool,
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

fn restart_backoff(consecutive_failures: u32) -> Duration {
    let multiplier = 1_u32 << consecutive_failures.min(4);
    RESTART_BACKOFF.saturating_mul(multiplier)
}

fn record_start_failure(runtime: &mut ServiceRuntime) -> bool {
    runtime.consecutive_start_failures = runtime.consecutive_start_failures.saturating_add(1);
    runtime.startup_faulted = runtime.consecutive_start_failures >= MAX_CONSECUTIVE_START_FAILURES;
    runtime.startup_faulted
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
    acquisition_mode: String,
    mode_transition_hold: bool,
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
                    acquisition_mode: "online".to_string(),
                    mode_transition_hold: false,
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
        let applied_mode =
            read_applied_acquisition_mode(&state_root.join("applied-acquisition-mode.json"));
        let (configured_mode, mode_load_error) = match configured_acquisition_mode(&workspace_root)
        {
            Ok(mode) => (mode, None),
            Err(error) => (
                applied_mode
                    .clone()
                    .unwrap_or_else(|| "invalid".to_string()),
                Some(error),
            ),
        };
        let acquisition_mode = applied_mode.unwrap_or_else(|| "unknown".to_string());
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
                    desired_running: mode == StartupMode::Normal
                        && service_enabled_for_mode(service, &configured_mode),
                    ..ServiceRuntime::default()
                },
            );
        }
        let events = read_events(&log_root.join("service-lifecycle.jsonl"));
        let next_event_id = events.back().map(|event| event.id + 1).unwrap_or(1);
        let mode_transition_hold =
            mode_load_error.is_some() || runtime_mode_transition_hold(&workspace_root);
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
            load_error: mode_load_error,
            acquisition_mode,
            mode_transition_hold,
        })
    }

    pub(crate) fn reconcile(&mut self) {
        self.mode_transition_hold = runtime_mode_transition_hold(&self.workspace_root);
        match configured_acquisition_mode(&self.workspace_root) {
            Ok(configured_mode) => {
                if self
                    .load_error
                    .as_deref()
                    .is_some_and(|error| error.starts_with("运行模式"))
                {
                    self.load_error = None;
                }
                if configured_mode != self.acquisition_mode {
                    self.apply_acquisition_mode(configured_mode);
                }
            }
            Err(error) => {
                self.mode_transition_hold = true;
                self.load_error = Some(error);
            }
        }
        let service_ids = self
            .registrations
            .iter()
            .map(|service| service.id.clone())
            .collect::<Vec<_>>();
        for service_id in service_ids {
            self.reconcile_service(&service_id);
        }
    }

    fn apply_acquisition_mode(&mut self, acquisition_mode: String) {
        let mut service_ids = self
            .registrations
            .iter()
            .filter(|service| service.process.is_some())
            .map(|service| service.id.clone())
            .collect::<Vec<_>>();
        // Stop data-plane services first and the business API last.  The API
        // save request has already returned before the supervisor observes the
        // profile change, while capture receives a chance to drain through its
        // own mode-switch fence.
        service_ids.sort_by_key(|id| if id == "inspection" { 1 } else { 0 });
        let mut stop_errors = Vec::new();
        for service_id in service_ids {
            let observed = self.runtimes.get(&service_id).is_some_and(|runtime| {
                runtime.child.is_some() || runtime.known_pid.is_some() || runtime.observed_running
            }) || self
                .registration(&service_id)
                .is_ok_and(|registration| probe_registration(registration).ok);
            if observed {
                if let Err(error) = self.stop_service(&service_id, "acquisition-mode-change", false)
                {
                    stop_errors.push(format!("{service_id}: {error}"));
                }
            }
        }
        if !stop_errors.is_empty() {
            self.load_error = Some(format!(
                "运行模式切换停止服务失败，保持模式 {}：{}",
                self.acquisition_mode,
                stop_errors.join("; ")
            ));
            return;
        }
        let path = self.state_root.join("applied-acquisition-mode.json");
        let persisted = fs::create_dir_all(&self.state_root).and_then(|_| {
            fs::write(
                path,
                serde_json::to_vec_pretty(&json!({
                    "schema": "steel.applied-acquisition-mode.v1",
                    "acquisitionMode": acquisition_mode,
                    "updatedAt": unix_time_millis().to_string()
                }))
                .unwrap_or_default(),
            )
        });
        if let Err(error) = persisted {
            self.load_error = Some(format!(
                "运行模式切换状态持久化失败，保持模式 {}：{error}",
                self.acquisition_mode
            ));
            return;
        }
        if let Err(error) = promote_released_runtime_mode(&self.workspace_root, &acquisition_mode) {
            self.load_error = Some(format!(
                "目标模式已持久化，但提交日志晋级失败，将保持目标模式故障状态：{error}"
            ));
        }
        self.acquisition_mode = acquisition_mode;
        for runtime in self.runtimes.values_mut() {
            runtime.consecutive_start_failures = 0;
            runtime.startup_faulted = false;
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

        if !service_enabled_for_mode(&registration, &self.acquisition_mode) {
            let observed = self.runtimes.get(service_id).is_some_and(|runtime| {
                runtime.child.is_some() || runtime.known_pid.is_some() || runtime.observed_running
            }) || probe_registration(&registration).ok;
            if observed {
                let _ = self.stop_service(service_id, "acquisition-mode", false);
            } else if let Some(runtime) = self.runtimes.get_mut(service_id) {
                runtime.desired_running = false;
                runtime.observed_running = false;
                runtime.last_reason = None;
                runtime.last_probe = None;
            }
            return;
        }

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
            if let Some(runtime) = self.runtimes.get_mut(service_id) {
                if record_start_failure(runtime) {
                    runtime.last_reason = Some(format!(
                        "目标模式服务连续启动失败 {} 次，已停止自动重试；请修复配置后显式启动",
                        runtime.consecutive_start_failures
                    ));
                }
            }
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
                runtime.consecutive_start_failures = 0;
                runtime.startup_faulted = false;
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
                    should_start = !self.mode_transition_hold
                        && !runtime.startup_faulted
                        && mode == StartupMode::Normal
                        && runtime.last_launch_attempt.is_none_or(|attempt| {
                            attempt.elapsed() >= restart_backoff(runtime.consecutive_start_failures)
                        });
                }
                if !runtime.startup_faulted {
                    runtime.last_reason = probe.reason.clone();
                }
            }
            runtime.last_probe = Some(probe);
        }
        if unexpected_exit {
            if let Some(runtime) = self.runtimes.get_mut(service_id) {
                record_start_failure(runtime);
            }
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
            "start" => {
                self.clear_startup_fault(service_id);
                self.start_service(service_id, source)
            }
            "stop" => self.stop_service(service_id, source, true),
            "restart" => {
                self.clear_startup_fault(service_id);
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

    fn clear_startup_fault(&mut self, service_id: &str) {
        if let Some(runtime) = self.runtimes.get_mut(service_id) {
            runtime.consecutive_start_failures = 0;
            runtime.startup_faulted = false;
            runtime.last_launch_attempt = None;
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
            if mode == StartupMode::Normal {
                runtime.consecutive_start_failures = 0;
                runtime.startup_faulted = false;
                runtime.last_launch_attempt = None;
            }
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
        } else if mode == StartupMode::Normal
            && service_enabled_for_mode(&registration, &self.acquisition_mode)
        {
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
        if self.mode_transition_hold {
            return Err("运行模式切换正在提交，暂不允许启动服务".to_string());
        }
        let registration = self.registration(service_id)?.clone();
        if !service_enabled_for_mode(&registration, &self.acquisition_mode) {
            return Err(format!(
                "{} 在 {} 采集模式下已停用",
                registration.name, self.acquisition_mode
            ));
        }
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
        // The supervisor's persisted mode is the process-level authority.  A
        // child must reject startup if its selected profile disagrees, which
        // prevents a fenced/ready transition from creating split-brain state.
        command.env("STEEL_ACQUISITION_MODE", &self.acquisition_mode);
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
                    record_start_failure(runtime);
                    runtime.last_reason = Some(if runtime.startup_faulted {
                        format!(
                            "{error}；连续失败 {} 次，已停止自动重试",
                            runtime.consecutive_start_failures
                        )
                    } else {
                        error.clone()
                    });
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
                "acquisitionMode": self.acquisition_mode,
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
        let enabled_for_mode = service_enabled_for_mode(registration, &self.acquisition_mode);
        let probe = if enabled_for_mode {
            runtime
                .and_then(|runtime| runtime.last_probe.clone())
                .unwrap_or_else(|| probe_registration(registration))
        } else {
            ProbeResult {
                ok: true,
                status: 0,
                latency_ms: 0,
                reason: None,
            }
        };
        let pid = runtime.and_then(|runtime| runtime.known_pid);
        let started_at = runtime.and_then(|runtime| runtime.started_at);
        let process_alive = pid.is_some();
        let startup_faulted = runtime.is_some_and(|runtime| runtime.startup_faulted);
        let status = if !enabled_for_mode {
            "disabled-for-mode"
        } else if mode == StartupMode::Disabled {
            "disabled"
        } else if startup_faulted && !process_alive {
            "startup-failed"
        } else if probe.ok {
            "running"
        } else if process_alive && probe.status > 0 {
            "degraded"
        } else if process_alive {
            "starting"
        } else {
            "stopped"
        };
        let reason = runtime
            .filter(|runtime| runtime.startup_faulted)
            .and_then(|runtime| runtime.last_reason.clone())
            .filter(|value| !value.is_empty())
            .or_else(|| probe.reason.clone())
            .or_else(|| {
                runtime
                    .and_then(|runtime| runtime.last_reason.clone())
                    .filter(|value| !value.is_empty())
            });
        let managed = registration.process.is_some();
        let can_start = managed && enabled_for_mode && mode != StartupMode::Disabled && !probe.ok;
        let can_stop = managed && enabled_for_mode && (process_alive || probe.ok);
        SupervisorServiceSnapshot {
            id: registration.id.clone(),
            name: registration.name.clone(),
            role: registration.role.clone(),
            kind: registration.kind.clone(),
            origin: resolved_origin(registration),
            port: resolved_port(registration),
            health_path: registration.health_path.clone(),
            ok: probe.ok,
            required: service_required_for_mode(registration, &self.acquisition_mode),
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
                "consecutiveStartFailures": runtime.map_or(0, |runtime| runtime.consecutive_start_failures),
                "startupFaulted": startup_faulted,
                "autoRestart": enabled_for_mode && mode == StartupMode::Normal && !startup_faulted,
                "acquisitionMode": self.acquisition_mode,
                "enabledForMode": enabled_for_mode
            }),
            operations: vec![
                json!({"id":"refresh-status","label":"刷新状态","effect":"query","scope":"service","enabled":true}),
                json!({"id":"start","label":"启动","effect":"mutation","scope":"service","enabled":can_start}),
                json!({"id":"stop","label":"停止","effect":"mutation","scope":"service","enabled":can_stop}),
                json!({"id":"restart","label":"重启","effect":"mutation","scope":"service","enabled":managed && enabled_for_mode && mode != StartupMode::Disabled && (process_alive || probe.ok)}),
                json!({"id":"set-startup-mode","label":"启动模式","effect":"mutation","scope":"service","enabled":managed}),
            ],
            control: json!({
                "mode": if managed { "control" } else { "observe" },
                "owner": "tauri-service-supervisor",
                "reason": if managed { Value::Null } else { json!("service_has_no_registered_process") }
            }),
            startup_mode: mode.as_str().to_string(),
            auto_restart: enabled_for_mode && mode == StartupMode::Normal && !startup_faulted,
            managed,
            enabled_for_mode,
            acquisition_mode: self.acquisition_mode.clone(),
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
    use std::time::{SystemTime, UNIX_EPOCH};

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
    fn startup_failures_use_bounded_backoff_and_fault_after_five_attempts() {
        assert_eq!(restart_backoff(0), Duration::from_secs(3));
        assert_eq!(restart_backoff(1), Duration::from_secs(6));
        assert_eq!(restart_backoff(4), Duration::from_secs(48));
        assert_eq!(restart_backoff(40), Duration::from_secs(48));

        let mut runtime = ServiceRuntime::default();
        for attempt in 1..MAX_CONSECUTIVE_START_FAILURES {
            assert!(!record_start_failure(&mut runtime));
            assert_eq!(runtime.consecutive_start_failures, attempt);
        }
        assert!(record_start_failure(&mut runtime));
        assert_eq!(
            runtime.consecutive_start_failures,
            MAX_CONSECUTIVE_START_FAILURES
        );
        assert!(runtime.startup_faulted);
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

    #[test]
    fn acquisition_mode_conditions_disable_capture_without_disabling_history_services() {
        let registration = ServiceRegistration {
            id: "capture".to_string(),
            name: "capture".to_string(),
            role: String::new(),
            kind: "capture".to_string(),
            default_origin: "http://127.0.0.1:4317".to_string(),
            origin_env: None,
            port_env: None,
            health_path: "/health".to_string(),
            required: true,
            enabled_when_modes: vec!["online".to_string(), "simulation".to_string()],
            required_when_modes: vec!["online".to_string(), "simulation".to_string()],
            lifecycle: String::new(),
            process: None,
        };
        assert!(service_enabled_for_mode(&registration, "online"));
        assert!(service_required_for_mode(&registration, "simulation"));
        assert!(!service_enabled_for_mode(&registration, "offline"));
        assert!(!service_required_for_mode(&registration, "offline"));
    }

    #[test]
    fn acquisition_mode_is_read_from_the_active_site_runtime_profile() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "steel-monitor-acquisition-mode-{}-{stamp}",
            std::process::id()
        ));
        let site_root = root.join("config/sites/test-site");
        fs::create_dir_all(&site_root).expect("site root");
        fs::write(
            root.join("config/project.json"),
            r#"{"activeSiteConfig":"config/sites/test-site/site.json"}"#,
        )
        .expect("project");
        fs::write(
            site_root.join("site.json"),
            r#"{"runtimeProfile":"runtime.json"}"#,
        )
        .expect("site");
        fs::write(
            site_root.join("runtime.json"),
            r#"{"acquisitionMode":"simulation","provider":"external-api"}"#,
        )
        .expect("runtime");

        assert_eq!(
            configured_acquisition_mode(&root).expect("configured mode"),
            "simulation"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn committed_mode_record_fences_an_uncommitted_profile_publish() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "steel-monitor-mode-commit-{}-{stamp}",
            std::process::id()
        ));
        let config_root = root.join("config");
        fs::create_dir_all(&config_root).expect("config root");
        fs::write(
            config_root.join("project.json"),
            r#"{"activeRuntimeProfile":"config/runtime.json"}"#,
        )
        .expect("project");
        fs::write(
            config_root.join("runtime.json"),
            r#"{"acquisitionMode":"simulation","provider":"external-api"}"#,
        )
        .expect("new profile bytes");
        fs::write(
            root.join(RUNTIME_MODE_COMMIT_PATH),
            serde_json::to_vec(&json!({
                "schema": "steel.runtime-mode-commit.v1",
                "state": "fence",
                "acquisitionMode": "online",
                "configHash": "old-generation",
                "profileSha256": "0".repeat(64)
            }))
            .expect("commit json"),
        )
        .expect("commit record");

        assert_eq!(
            configured_acquisition_mode(&root).expect("fenced mode"),
            "online"
        );

        let runtime_bytes = fs::read(config_root.join("runtime.json")).expect("runtime bytes");
        let runtime_sha256 = format!("{:x}", Sha256::digest(&runtime_bytes));

        fs::write(
            root.join(RUNTIME_MODE_COMMIT_PATH),
            serde_json::to_vec(&json!({
                "schema": "steel.runtime-mode-commit.v1",
                "state": "ready",
                "acquisitionMode": "simulation",
                "previousAcquisitionMode": "online",
                "releaseAfterMillis": unix_time_millis() + 60_000,
                "profileSha256": runtime_sha256
            }))
            .expect("ready json"),
        )
        .expect("ready record");
        assert_eq!(
            configured_acquisition_mode(&root).expect("ready mode before release"),
            "online"
        );

        let runtime_bytes = fs::read(config_root.join("runtime.json")).expect("runtime bytes");
        let runtime_sha256 = format!("{:x}", Sha256::digest(&runtime_bytes));
        fs::write(
            root.join(RUNTIME_MODE_COMMIT_PATH),
            serde_json::to_vec(&json!({
                "schema": "steel.runtime-mode-commit.v1",
                "state": "ready",
                "acquisitionMode": "simulation",
                "previousAcquisitionMode": "online",
                "releaseAfterMillis": 0,
                "profileSha256": runtime_sha256
            }))
            .expect("released ready json"),
        )
        .expect("released ready record");
        assert_eq!(
            configured_acquisition_mode(&root).expect("ready mode after release"),
            "simulation"
        );

        fs::write(
            root.join(RUNTIME_MODE_COMMIT_PATH),
            serde_json::to_vec(&json!({
                "schema": "steel.runtime-mode-commit.v1",
                "state": "committed",
                "acquisitionMode": "simulation",
                "configHash": "new-generation",
                "profileSha256": runtime_sha256
            }))
            .expect("commit json"),
        )
        .expect("advance commit record");
        assert_eq!(
            configured_acquisition_mode(&root).expect("committed mode"),
            "simulation"
        );

        fs::write(
            config_root.join("runtime.json"),
            r#"{"acquisitionMode":"simulation","provider":"external-api","displayName":"same-mode edit"}"#,
        )
        .expect("same-mode edit");
        assert!(configured_acquisition_mode(&root).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn publish_journal_recovers_staged_profile_and_holds_until_release() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "steel-monitor-mode-publish-{}-{stamp}",
            std::process::id()
        ));
        let config_root = root.join("config");
        let staging_root = config_root.join("runtime-mode-staging");
        fs::create_dir_all(&staging_root).expect("staging root");
        fs::write(
            config_root.join("project.json"),
            r#"{"activeRuntimeProfile":"config/runtime.json"}"#,
        )
        .expect("project");
        fs::write(
            config_root.join("runtime.json"),
            r#"{"acquisitionMode":"online","provider":"external-api"}"#,
        )
        .expect("old runtime");
        let target = br#"{"acquisitionMode":"simulation","provider":"external-api"}"#;
        fs::write(staging_root.join("transition.json"), target).expect("staged runtime");
        let target_hash = format!("{:x}", Sha256::digest(target));
        fs::write(
            root.join(RUNTIME_MODE_COMMIT_PATH),
            serde_json::to_vec(&json!({
                "schema": "steel.runtime-mode-commit.v1",
                "state": "publish",
                "acquisitionMode": "simulation",
                "previousAcquisitionMode": "online",
                "profileSha256": target_hash,
                "stagedProfile": "config/runtime-mode-staging/transition.json"
            }))
            .expect("publish journal"),
        )
        .expect("publish marker");

        assert!(runtime_mode_transition_hold(&root));
        assert_eq!(
            configured_acquisition_mode(&root).expect("recover publish journal"),
            "online"
        );
        assert_eq!(
            fs::read(config_root.join("runtime.json")).expect("published runtime"),
            target
        );
        let marker_path = root.join(RUNTIME_MODE_COMMIT_PATH);
        let mut marker: Value =
            serde_json::from_slice(&fs::read(&marker_path).expect("ready marker"))
                .expect("ready marker JSON");
        assert_eq!(marker["state"], json!("ready"));
        assert!(runtime_mode_transition_hold(&root));

        marker["releaseAfterMillis"] = json!(0);
        fs::write(
            &marker_path,
            serde_json::to_vec(&marker).expect("released marker JSON"),
        )
        .expect("released marker");
        assert!(!runtime_mode_transition_hold(&root));
        assert_eq!(
            configured_acquisition_mode(&root).expect("released mode"),
            "simulation"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn transition_hold_is_fail_closed_for_incomplete_or_invalid_markers() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "steel-monitor-mode-hold-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("config")).expect("config root");
        let marker = root.join(RUNTIME_MODE_COMMIT_PATH);
        fs::write(&marker, b"not-json").expect("invalid marker");
        assert!(runtime_mode_transition_hold(&root));
        fs::write(
            &marker,
            serde_json::to_vec(&json!({
                "schema": "steel.runtime-mode-commit.v1",
                "state": "committed"
            }))
            .expect("committed marker"),
        )
        .expect("committed marker");
        assert!(runtime_mode_transition_hold(&root));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_fence_with_unchanged_profile_recovers_the_previous_mode() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "steel-monitor-stale-fence-{}-{stamp}",
            std::process::id()
        ));
        let config_root = root.join("config");
        fs::create_dir_all(&config_root).expect("config root");
        fs::write(
            config_root.join("project.json"),
            r#"{"activeRuntimeProfile":"config/runtime.json"}"#,
        )
        .expect("project");
        let runtime = br#"{"acquisitionMode":"online","provider":"external-api"}"#;
        fs::write(config_root.join("runtime.json"), runtime).expect("runtime profile");
        let profile_sha256 = format!("{:x}", Sha256::digest(runtime));
        let marker_path = root.join(RUNTIME_MODE_COMMIT_PATH);
        fs::write(
            &marker_path,
            serde_json::to_vec(&json!({
                "schema": "steel.runtime-mode-commit.v1",
                "state": "fence",
                "acquisitionMode": "online",
                "previousAcquisitionMode": "online",
                "targetAcquisitionMode": "simulation",
                "updatedAt": 0,
                "profileSha256": profile_sha256
            }))
            .expect("fence marker"),
        )
        .expect("fence record");

        assert_eq!(
            configured_acquisition_mode(&root).expect("recover stale fence"),
            "online"
        );
        let recovered: Value =
            serde_json::from_slice(&fs::read(&marker_path).expect("recovered marker"))
                .expect("recovered marker JSON");
        assert_eq!(recovered["state"], json!("committed"));
        assert_eq!(
            recovered["recoveryReason"],
            json!("stale-fence-profile-unchanged")
        );
        assert!(!runtime_mode_transition_hold(&root));
        let _ = fs::remove_dir_all(root);
    }
}
