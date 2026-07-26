use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const SITE_CONFIG_SCHEMA: &str = "steel.site-config.v1";
const PROJECT_CONFIG_SCHEMA: &str = "steel.project-config.v1";

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SiteMode {
    Bkv,
    DirectCamera,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteConfigDocument {
    pub schema: String,
    pub id: String,
    pub display_name: String,
    pub mode: SiteMode,
    pub runtime_profile: String,
    pub connection_config: String,
    pub capture_config: String,
}

#[derive(Clone, Debug)]
pub struct SiteConfigPackage {
    pub root: PathBuf,
    pub document: SiteConfigDocument,
}

#[derive(Clone, Debug)]
pub struct ActiveSiteResolution {
    pub project_path: PathBuf,
    pub project_bytes: Vec<u8>,
    pub site_bytes: Option<Vec<u8>>,
    pub runtime_profile_path: PathBuf,
    pub site_id: String,
    pub site_display_name: String,
    pub site_mode: SiteMode,
    pub pending_restart: bool,
    pub compatibility: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectConfigDocument {
    schema: String,
    #[serde(default)]
    active_site_config: Option<String>,
    #[serde(default)]
    active_runtime_profile: Option<String>,
    #[serde(default)]
    pending_restart: bool,
}

#[derive(Clone, Debug)]
pub struct CreateSiteConfig {
    pub id: String,
    pub display_name: String,
    pub mode: SiteMode,
}

#[derive(Clone, Debug, Default)]
pub struct UpdateSiteMetadata {
    pub display_name: Option<String>,
    pub mode: Option<SiteMode>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CheckDepth {
    Default,
    Deep,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Normal,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteConfigCheck {
    pub id: String,
    pub label: String,
    pub status: CheckStatus,
    pub message: String,
    pub blocking: bool,
}

impl SiteConfigCheck {
    fn normal(id: &str, label: &str, message: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            status: CheckStatus::Normal,
            message: message.into(),
            blocking: false,
        }
    }

    fn warning(id: &str, label: &str, message: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            status: CheckStatus::Warning,
            message: message.into(),
            blocking: false,
        }
    }

    fn blocking(id: &str, label: &str, message: impl Into<String>) -> Self {
        Self {
            id: id.to_string(),
            label: label.to_string(),
            status: CheckStatus::Error,
            message: message.into(),
            blocking: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteConfigCheckReport {
    pub site_id: String,
    pub depth: CheckDepth,
    pub checked_at: u64,
    pub checks: Vec<SiteConfigCheck>,
}

impl SiteConfigCheckReport {
    pub fn has_blocking_errors(&self) -> bool {
        self.checks.iter().any(|item| item.blocking)
    }
}

pub trait SiteConfigProbe: Send + Sync {
    fn check(&self, package: &SiteConfigPackage) -> Vec<SiteConfigCheck>;
}

struct NoopSiteConfigProbe;

impl SiteConfigProbe for NoopSiteConfigProbe {
    fn check(&self, package: &SiteConfigPackage) -> Vec<SiteConfigCheck> {
        vec![SiteConfigCheck::warning(
            "deep.probe",
            "深度探测",
            format!("{} 尚未配置设备深度探测器", package.document.display_name),
        )]
    }
}

#[derive(Clone)]
pub struct SiteConfigStore {
    root: PathBuf,
    probe: Arc<dyn SiteConfigProbe>,
}

impl SiteConfigStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root)
            .map_err(|error| format!("site config root create failed: {error}"))?;
        let root = fs::canonicalize(&root)
            .map_err(|error| format!("site config root unavailable: {error}"))?;
        Ok(Self {
            root,
            probe: Arc::new(NoopSiteConfigProbe),
        })
    }

    pub fn with_probe(mut self, probe: Arc<dyn SiteConfigProbe>) -> Self {
        self.probe = probe;
        self
    }

    pub fn list(&self) -> Result<Vec<SiteConfigPackage>, String> {
        let mut packages = fs::read_dir(&self.root)
            .map_err(|error| format!("site config list failed: {error}"))?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter_map(|entry| self.get(&entry.file_name().to_string_lossy()).ok())
            .collect::<Vec<_>>();
        packages.sort_by(|left, right| left.document.id.cmp(&right.document.id));
        Ok(packages)
    }

    pub fn get(&self, id: &str) -> Result<SiteConfigPackage, String> {
        validate_site_id(id)?;
        let root = self.root.join(id);
        let root = contained_existing_directory(&self.root, &root, "site config")?;
        let document = read_site_document(&root.join("site.json"))?;
        if document.id != id {
            return Err("site config directory and document id differ".to_string());
        }
        Ok(SiteConfigPackage { root, document })
    }

    pub fn create(&self, request: CreateSiteConfig) -> Result<SiteConfigPackage, String> {
        validate_site_id(&request.id)?;
        let display_name = request.display_name.trim();
        if display_name.is_empty() {
            return Err("site config display name is required".to_string());
        }
        let root = self.root.join(&request.id);
        if root.exists() {
            return Err("site config already exists".to_string());
        }
        fs::create_dir(&root)
            .map_err(|error| format!("site config directory create failed: {error}"))?;
        let result = (|| {
            let document = SiteConfigDocument {
                schema: SITE_CONFIG_SCHEMA.to_string(),
                id: request.id.clone(),
                display_name: display_name.to_string(),
                mode: request.mode.clone(),
                runtime_profile: "runtime.json".to_string(),
                connection_config: "connection.json".to_string(),
                capture_config: "capture.json".to_string(),
            };
            write_json_atomic(&root.join("site.json"), &document)?;
            write_json_atomic(
                &root.join("runtime.json"),
                &runtime_template(&request.id, display_name, &request.mode),
            )?;
            write_json_atomic(
                &root.join("connection.json"),
                &json!({
                    "mode": if request.mode == SiteMode::Bkv { "online" } else { "device" },
                    "host": "127.0.0.1",
                    "port": 4873
                }),
            )?;
            write_json_atomic(&root.join("capture.json"), &capture_template(&request.mode))?;
            Ok(SiteConfigPackage {
                root: root.clone(),
                document,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&root);
        }
        result
    }

    pub fn clone_site(
        &self,
        source_id: &str,
        target_id: &str,
        display_name: &str,
    ) -> Result<SiteConfigPackage, String> {
        validate_site_id(target_id)?;
        let source = self.get(source_id)?;
        let target = self.root.join(target_id);
        if target.exists() {
            return Err("site config already exists".to_string());
        }
        copy_directory(&source.root, &target)?;
        let result = (|| {
            let mut document = read_site_document(&target.join("site.json"))?;
            document.id = target_id.to_string();
            document.display_name = display_name.trim().to_string();
            if document.display_name.is_empty() {
                return Err("site config display name is required".to_string());
            }
            write_json_atomic(&target.join("site.json"), &document)?;
            Ok(SiteConfigPackage {
                root: target.clone(),
                document,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&target);
        }
        result
    }

    pub fn update_metadata(
        &self,
        id: &str,
        update: UpdateSiteMetadata,
    ) -> Result<SiteConfigPackage, String> {
        let mut package = self.get(id)?;
        if update
            .mode
            .as_ref()
            .is_some_and(|mode| mode != &package.document.mode)
        {
            return Err("site config mode cannot change after creation".to_string());
        }
        if let Some(display_name) = update.display_name {
            let display_name = display_name.trim();
            if display_name.is_empty() {
                return Err("site config display name is required".to_string());
            }
            package.document.display_name = display_name.to_string();
        }
        write_json_atomic(&package.root.join("site.json"), &package.document)?;
        Ok(package)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let package = self.get(id)?;
        fs::remove_dir_all(package.root)
            .map_err(|error| format!("site config delete failed: {error}"))
    }

    pub fn check(&self, id: &str, depth: CheckDepth) -> Result<SiteConfigCheckReport, String> {
        let package = self.get(id)?;
        let mut checks = Vec::new();
        checks.push(SiteConfigCheck::normal(
            "site.schema",
            "现场配置结构",
            format!("Schema {}", package.document.schema),
        ));

        let runtime = check_json_reference(
            &package,
            &package.document.runtime_profile,
            "runtime.profile",
            "运行配置",
            &mut checks,
        );
        let _connection = check_json_reference(
            &package,
            &package.document.connection_config,
            "connection.config",
            "连接配置",
            &mut checks,
        );
        let capture = check_json_reference(
            &package,
            &package.document.capture_config,
            "capture.config",
            "采集配置",
            &mut checks,
        );

        match package.document.mode {
            SiteMode::Bkv => check_bkv_configuration(runtime.as_ref(), &mut checks),
            SiteMode::DirectCamera => {
                check_direct_configuration(runtime.as_ref(), capture.as_ref(), &mut checks)
            }
        }

        if depth == CheckDepth::Deep {
            checks.extend(self.probe.check(&package));
        }

        Ok(SiteConfigCheckReport {
            site_id: package.document.id,
            depth,
            checked_at: current_time_millis()?,
            checks,
        })
    }
}

pub fn resolve_active_site(
    project_path: &Path,
    allowed_root: &Path,
) -> Result<ActiveSiteResolution, String> {
    let allowed_root = fs::canonicalize(allowed_root).map_err(|error| {
        format!(
            "site config allowed root is unavailable ({}): {error}",
            allowed_root.display()
        )
    })?;
    let project_path =
        contained_existing_file(&allowed_root, project_path, "project configuration")?;
    let project_bytes = fs::read(&project_path)
        .map_err(|error| format!("project configuration read failed: {error}"))?;
    let project: ProjectConfigDocument = serde_json::from_slice(&project_bytes)
        .map_err(|error| format!("project configuration JSON invalid: {error}"))?;
    if project.schema != PROJECT_CONFIG_SCHEMA {
        return Err(format!(
            "project configuration schema must be {PROJECT_CONFIG_SCHEMA}"
        ));
    }

    if let Some(relative) = project.active_site_config.as_deref() {
        let site_path = contained_existing_file(&allowed_root, relative, "active site config")?;
        let site_root = site_path
            .parent()
            .ok_or_else(|| "active site config has no parent".to_string())?;
        let site_bytes = fs::read(&site_path)
            .map_err(|error| format!("active site config read failed: {error}"))?;
        let document: SiteConfigDocument = serde_json::from_slice(&site_bytes)
            .map_err(|error| format!("active site config JSON invalid: {error}"))?;
        if document.schema != SITE_CONFIG_SCHEMA {
            return Err(format!("site config schema must be {SITE_CONFIG_SCHEMA}"));
        }
        validate_site_id(&document.id)?;
        let runtime_profile_path =
            contained_existing_file(site_root, &document.runtime_profile, "site runtime profile")?;
        return Ok(ActiveSiteResolution {
            project_path,
            project_bytes,
            site_bytes: Some(site_bytes),
            runtime_profile_path,
            site_id: document.id,
            site_display_name: document.display_name,
            site_mode: document.mode,
            pending_restart: project.pending_restart,
            compatibility: false,
        });
    }

    let relative = project.active_runtime_profile.as_deref().ok_or_else(|| {
        "project configuration requires activeSiteConfig or activeRuntimeProfile".to_string()
    })?;
    let runtime_profile_path =
        contained_existing_file(&allowed_root, relative, "legacy runtime profile")?;
    let runtime_bytes = fs::read(&runtime_profile_path)
        .map_err(|error| format!("legacy runtime profile read failed: {error}"))?;
    let runtime: Value = serde_json::from_slice(&runtime_bytes)
        .map_err(|error| format!("legacy runtime profile JSON invalid: {error}"))?;
    let site_id = runtime
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "legacy runtime profile id is missing".to_string())?
        .to_string();
    let site_display_name = runtime
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or(&site_id)
        .to_string();
    let site_mode = if runtime.get("provider").and_then(Value::as_str) == Some("bkv") {
        SiteMode::Bkv
    } else {
        SiteMode::DirectCamera
    };
    Ok(ActiveSiteResolution {
        project_path,
        project_bytes,
        site_bytes: None,
        runtime_profile_path,
        site_id,
        site_display_name,
        site_mode,
        pending_restart: project.pending_restart,
        compatibility: true,
    })
}

pub fn mark_project_applied(project_path: &Path) -> Result<(), String> {
    let bytes = fs::read(project_path)
        .map_err(|error| format!("project configuration read failed: {error}"))?;
    let mut project: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("project configuration JSON invalid: {error}"))?;
    if project.get("pendingRestart").and_then(Value::as_bool) != Some(true) {
        return Ok(());
    }
    let object = project
        .as_object_mut()
        .ok_or_else(|| "project configuration must be a JSON object".to_string())?;
    object.insert("pendingRestart".to_string(), Value::Bool(false));
    write_json_atomic(project_path, &project)
}

fn check_json_reference(
    package: &SiteConfigPackage,
    relative: &str,
    id: &str,
    label: &str,
    checks: &mut Vec<SiteConfigCheck>,
) -> Option<Value> {
    let candidate = package.root.join(relative);
    let resolved = match fs::canonicalize(&candidate) {
        Ok(path) if path.starts_with(&package.root) && path.is_file() => path,
        Ok(_) => {
            checks.push(SiteConfigCheck::blocking(
                id,
                label,
                "引用文件必须位于现场配置目录内",
            ));
            return None;
        }
        Err(error) => {
            checks.push(SiteConfigCheck::blocking(
                id,
                label,
                format!("引用文件不可用：{error}"),
            ));
            return None;
        }
    };
    let value = match fs::read(&resolved)
        .map_err(|error| error.to_string())
        .and_then(|bytes| {
            serde_json::from_slice::<Value>(&bytes).map_err(|error| error.to_string())
        }) {
        Ok(value) => value,
        Err(error) => {
            checks.push(SiteConfigCheck::blocking(
                id,
                label,
                format!("JSON 无法读取：{error}"),
            ));
            return None;
        }
    };
    checks.push(SiteConfigCheck::normal(
        id,
        label,
        format!("{} 可读取", resolved.display()),
    ));
    Some(value)
}

fn check_bkv_configuration(runtime: Option<&Value>, checks: &mut Vec<SiteConfigCheck>) {
    let data_source = runtime
        .and_then(|value| value.get("dataSource"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if data_source.is_empty() {
        checks.push(SiteConfigCheck::blocking(
            "bkv.dataSource",
            "BKV 数据源",
            "未配置 BKV 数据来源",
        ));
    } else {
        checks.push(SiteConfigCheck::normal(
            "bkv.dataSource",
            "BKV 数据源",
            data_source,
        ));
    }

    let converted_root = runtime
        .and_then(|value| value.pointer("/storage/convertedRoot"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if converted_root.is_empty() {
        checks.push(SiteConfigCheck::warning(
            "storage.convertedRoot",
            "标准数据目录",
            "尚未设置标准数据目录",
        ));
    } else {
        checks.push(SiteConfigCheck::normal(
            "storage.convertedRoot",
            "标准数据目录",
            converted_root,
        ));
    }
}

fn check_direct_configuration(
    runtime: Option<&Value>,
    capture: Option<&Value>,
    checks: &mut Vec<SiteConfigCheck>,
) {
    let runtime_count = runtime
        .and_then(|value| value.get("cameraCount"))
        .and_then(Value::as_u64)
        .unwrap_or_default() as usize;
    let runtime_cameras = runtime
        .and_then(|value| value.get("cameras"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    let expected = capture
        .and_then(|value| value.get("expectedCameras"))
        .and_then(Value::as_u64)
        .unwrap_or_default() as usize;
    let capture_cameras = capture
        .and_then(|value| value.get("cameras"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default();
    if runtime_count == 0
        || runtime_count != runtime_cameras
        || runtime_count != expected
        || runtime_count != capture_cameras
    {
        checks.push(SiteConfigCheck::blocking(
            "camera.mapping",
            "相机数量与映射",
            format!(
                "运行配置 {runtime_count}/{runtime_cameras}，采集配置 {expected}/{capture_cameras}"
            ),
        ));
    } else {
        checks.push(SiteConfigCheck::normal(
            "camera.mapping",
            "相机数量与映射",
            format!("{runtime_count} 个相机映射一致"),
        ));
    }
}

fn current_time_millis() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| format!("site config clock failed: {error}"))
}

fn validate_site_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
    if valid {
        Ok(())
    } else {
        Err("site config id must contain only letters, numbers, '-' or '_'".to_string())
    }
}

fn contained_existing_directory(
    allowed_root: &Path,
    candidate: &Path,
    label: &str,
) -> Result<PathBuf, String> {
    let resolved =
        fs::canonicalize(candidate).map_err(|error| format!("{label} is unavailable: {error}"))?;
    if resolved == allowed_root || !resolved.starts_with(allowed_root) {
        return Err(format!("{label} must be beneath the allowed root"));
    }
    if !resolved.is_dir() {
        return Err(format!("{label} must be a directory"));
    }
    Ok(resolved)
}

fn contained_existing_file(
    allowed_root: &Path,
    candidate: impl AsRef<Path>,
    label: &str,
) -> Result<PathBuf, String> {
    let candidate = candidate.as_ref();
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        allowed_root.join(candidate)
    };
    let resolved = fs::canonicalize(&joined)
        .map_err(|error| format!("{label} is unavailable ({}): {error}", joined.display()))?;
    if !resolved.starts_with(allowed_root) || !resolved.is_file() {
        return Err(format!("{label} must be a file beneath the allowed root"));
    }
    Ok(resolved)
}

fn read_site_document(path: &Path) -> Result<SiteConfigDocument, String> {
    let bytes = fs::read(path).map_err(|error| format!("site config read failed: {error}"))?;
    let document: SiteConfigDocument = serde_json::from_slice(&bytes)
        .map_err(|error| format!("site config JSON invalid: {error}"))?;
    if document.schema != SITE_CONFIG_SCHEMA {
        return Err(format!("site config schema must be {SITE_CONFIG_SCHEMA}"));
    }
    Ok(document)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("site config serialization failed: {error}"))?;
    let parent = path
        .parent()
        .ok_or_else(|| "site config path has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("site config parent create failed: {error}"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("site config clock failed: {error}"))?
        .as_nanos();
    let temporary = parent.join(format!(".site-config-{stamp}.tmp"));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("site config temporary create failed: {error}"))?;
    let result = (|| {
        file.write_all(&bytes)
            .map_err(|error| format!("site config write failed: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("site config sync failed: {error}"))?;
        drop(file);
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|error| format!("site config publish failed: {error}"))
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
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
        Err(format!(
            "site config publish failed: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir(target)
        .map_err(|error| format!("site config clone directory failed: {error}"))?;
    for entry in
        fs::read_dir(source).map_err(|error| format!("site config clone read failed: {error}"))?
    {
        let entry = entry.map_err(|error| format!("site config clone entry failed: {error}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|error| format!("site config clone type failed: {error}"))?
            .is_dir()
        {
            copy_directory(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path)
                .map_err(|error| format!("site config clone copy failed: {error}"))?;
        }
    }
    Ok(())
}

fn runtime_template(id: &str, display_name: &str, mode: &SiteMode) -> Value {
    let camera_count = if mode == &SiteMode::Bkv { 6 } else { 8 };
    let provider = if mode == &SiteMode::Bkv {
        "bkv"
    } else {
        "camera"
    };
    let camera_connection = if mode == &SiteMode::Bkv {
        "none"
    } else {
        "headless-cpp"
    };
    json!({
        "schema": "steel.runtime-profile.v1",
        "id": id,
        "displayName": display_name,
        "provider": provider,
        "dataSource": if mode == &SiteMode::Bkv { "bkv-online-mysql" } else { "online-production" },
        "cameraConnection": camera_connection,
        "cameraCount": camera_count,
        "cameras": (1..=camera_count).map(|camera| json!({
            "id": format!("C{camera}"),
            "displayOrder": camera,
            "sourceCameraId": camera,
            "role": format!("camera{camera}"),
            "sourceDirectory": format!("camera{camera}")
        })).collect::<Vec<_>>(),
        "storage": {
            "sourceRoot": "",
            "convertedRoot": "",
            "catalogPath": "",
            "converterOrigin": ""
        },
        "capture": {
            "enabled": mode == &SiteMode::DirectCamera,
            "autostart": false
        },
        "algorithm": {
            "enabled": false
        },
        "capabilities": {
            "directCamera": mode == &SiteMode::DirectCamera,
            "captureManagement": mode == &SiteMode::DirectCamera,
            "reconstruction": mode == &SiteMode::DirectCamera,
            "offlineReplay": mode == &SiteMode::Bkv
        }
    })
}

fn capture_template(mode: &SiteMode) -> Value {
    let camera_count = if mode == &SiteMode::Bkv { 6 } else { 8 };
    json!({
        "schema": "steel.capture.profile.v1",
        "expectedCameras": camera_count,
        "cameras": (1..=camera_count).map(|camera| json!({
            "cameraIndex": camera,
            "enabled": mode == &SiteMode::DirectCamera
        })).collect::<Vec<_>>()
    })
}

#[cfg(test)]
mod tests {
    use super::{
        CheckDepth, CreateSiteConfig, SiteConfigCheck, SiteConfigPackage, SiteConfigProbe,
        SiteConfigStore, SiteMode, UpdateSiteMetadata,
    };
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct SiteConfigFixture {
        root: PathBuf,
        store: SiteConfigStore,
    }

    impl SiteConfigFixture {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let root = std::env::temp_dir()
                .join(format!("steel-site-config-{}-{stamp}", std::process::id()));
            fs::create_dir_all(&root).expect("fixture root");
            let store = SiteConfigStore::new(root.clone()).expect("site store");
            Self { root, store }
        }

        fn create_bkv(&self, id: &str) {
            self.store
                .create(CreateSiteConfig {
                    id: id.to_string(),
                    display_name: "BKV 东线".to_string(),
                    mode: SiteMode::Bkv,
                })
                .expect("BKV site");
        }

        fn create_direct(&self, id: &str) {
            self.store
                .create(CreateSiteConfig {
                    id: id.to_string(),
                    display_name: "直连八相机".to_string(),
                    mode: SiteMode::DirectCamera,
                })
                .expect("direct site");
        }
    }

    impl Drop for SiteConfigFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn creates_a_bkv_site_package_with_an_immutable_mode() {
        let fixture = SiteConfigFixture::new();
        let created = fixture
            .store
            .create(CreateSiteConfig {
                id: "bkv-east".to_string(),
                display_name: "BKV 东线".to_string(),
                mode: SiteMode::Bkv,
            })
            .expect("create site");

        assert_eq!(created.document.mode, SiteMode::Bkv);
        assert!(created.root.join("runtime.json").is_file());
        assert!(created.root.join("connection.json").is_file());
        assert!(created.root.join("capture.json").is_file());
    }

    #[test]
    fn rejects_mode_changes_for_an_existing_site() {
        let fixture = SiteConfigFixture::new();
        fixture.create_bkv("bkv-east");

        let error = fixture
            .store
            .update_metadata(
                "bkv-east",
                UpdateSiteMetadata {
                    display_name: Some("东线".to_string()),
                    mode: Some(SiteMode::DirectCamera),
                },
            )
            .expect_err("mode update must fail");

        assert!(error.contains("mode cannot change"));
    }

    #[test]
    fn rejects_ids_that_escape_the_sites_root() {
        let fixture = SiteConfigFixture::new();
        let error = fixture
            .store
            .get("../outside")
            .expect_err("escape must fail");
        assert!(error.contains("site config id"));
    }

    #[test]
    fn lists_clones_and_deletes_site_packages() {
        let fixture = SiteConfigFixture::new();
        fixture.create_bkv("bkv-east");

        let cloned = fixture
            .store
            .clone_site("bkv-east", "bkv-west", "BKV 西线")
            .expect("clone site");
        assert_eq!(cloned.document.id, "bkv-west");
        assert_eq!(cloned.document.mode, SiteMode::Bkv);
        assert_eq!(fixture.store.list().expect("list sites").len(), 2);

        fixture.store.delete("bkv-west").expect("delete clone");
        assert_eq!(fixture.store.list().expect("list sites").len(), 1);
    }

    #[test]
    fn default_bkv_check_reports_required_data_source_and_storage() {
        let fixture = SiteConfigFixture::new();
        fixture.create_bkv("bkv-east");

        let report = fixture
            .store
            .check("bkv-east", CheckDepth::Default)
            .expect("default check");

        assert!(report.checks.iter().any(|item| item.id == "bkv.dataSource"));
        assert!(report
            .checks
            .iter()
            .any(|item| item.id == "storage.convertedRoot"));
        assert!(!report.checks.iter().any(|item| item.id == "camera.devices"));
    }

    #[test]
    fn direct_check_requires_capture_and_camera_mapping() {
        let fixture = SiteConfigFixture::new();
        fixture.create_direct("line-eight");
        let package = fixture.store.get("line-eight").expect("direct site");
        fs::write(
            package.root.join("capture.json"),
            serde_json::to_vec_pretty(&json!({
                "schema": "steel.capture.profile.v1",
                "expectedCameras": 7,
                "cameras": []
            }))
            .expect("capture JSON"),
        )
        .expect("break capture mapping");

        let report = fixture
            .store
            .check("line-eight", CheckDepth::Default)
            .expect("default check");

        assert!(report.has_blocking_errors());
        assert!(report
            .checks
            .iter()
            .any(|item| item.id == "camera.mapping" && item.blocking));
    }

    struct ProbeSpy {
        calls: Arc<AtomicUsize>,
    }

    impl SiteConfigProbe for ProbeSpy {
        fn check(&self, _package: &SiteConfigPackage) -> Vec<SiteConfigCheck> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Vec::new()
        }
    }

    #[test]
    fn default_checks_do_not_run_deep_probes() {
        let fixture = SiteConfigFixture::new();
        fixture.create_bkv("bkv-east");
        let calls = Arc::new(AtomicUsize::new(0));
        let store = fixture.store.clone().with_probe(Arc::new(ProbeSpy {
            calls: Arc::clone(&calls),
        }));

        store
            .check("bkv-east", CheckDepth::Default)
            .expect("default check");

        assert_eq!(calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn deep_checks_invoke_the_mode_probe_once() {
        let fixture = SiteConfigFixture::new();
        fixture.create_bkv("bkv-east");
        let calls = Arc::new(AtomicUsize::new(0));
        let store = fixture.store.clone().with_probe(Arc::new(ProbeSpy {
            calls: Arc::clone(&calls),
        }));

        store
            .check("bkv-east", CheckDepth::Deep)
            .expect("deep check");

        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }
}
