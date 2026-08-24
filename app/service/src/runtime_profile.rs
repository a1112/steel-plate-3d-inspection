use crate::machine_site_config::{EffectiveSiteSelection, SiteSelectionSource};
use crate::site_config::{mark_project_applied, resolve_active_site, resolve_site_by_id, SiteMode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

const RUNTIME_PROFILE_SCHEMA: &str = "steel.runtime-profile.v1";
const CAPTURE_PROFILE_SCHEMAS: &[&str] = &["steel.capture.profile.v1", "steel.capture.profile.v2"];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeProfileDocument {
    schema: String,
    id: String,
    display_name: String,
    provider: String,
    data_source: String,
    camera_connection: String,
    camera_count: usize,
    #[serde(default)]
    capture_profile: Option<String>,
    cameras: Vec<RuntimeCamera>,
    #[serde(default)]
    storage: RuntimeStorage,
    #[serde(default)]
    capture: Option<RuntimeCapture>,
    #[serde(default)]
    algorithm: RuntimeAlgorithm,
    capabilities: RuntimeCapabilities,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureProfileDocument {
    schema: String,
    expected_cameras: usize,
    cameras: Vec<CaptureCamera>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureCamera {
    camera_index: usize,
    #[serde(default = "default_true")]
    enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCamera {
    pub id: String,
    pub display_order: usize,
    pub source_camera_id: usize,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub source_directory: String,
}

fn default_record_layout_version() -> u8 {
    2
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStorage {
    #[serde(default = "default_record_layout_version")]
    pub layout_version: u8,
    #[serde(default)]
    pub source_root: String,
    #[serde(default)]
    pub converted_root: String,
    #[serde(default)]
    pub catalog_path: String,
    #[serde(default)]
    pub cache_root: String,
    #[serde(default)]
    pub converter_origin: String,
    #[serde(default)]
    pub result_root: String,
    #[serde(default)]
    pub result_catalog_path: String,
}

impl Default for RuntimeStorage {
    fn default() -> Self {
        Self {
            layout_version: default_record_layout_version(),
            source_root: String::new(),
            converted_root: String::new(),
            catalog_path: String::new(),
            cache_root: String::new(),
            converter_origin: String::new(),
            result_root: String::new(),
            result_catalog_path: String::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapture {
    pub enabled: bool,
    pub autostart: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAlgorithm {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub auto_process_latest: bool,
    #[serde(default)]
    pub processor: String,
    #[serde(default)]
    pub config_path: String,
    #[serde(default)]
    pub output_root: String,
    #[serde(default = "default_timing_log")]
    pub timing_log: String,
    #[serde(default = "default_max_frames_per_camera")]
    pub max_frames_per_camera: usize,
    #[serde(default)]
    pub source_data: RuntimeSourceDataPersistence,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSourceDataPersistence {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_source_data_directory")]
    pub directory: String,
    #[serde(default = "default_source_record_limit")]
    pub record_limit: usize,
}

impl Default for RuntimeSourceDataPersistence {
    fn default() -> Self {
        Self {
            enabled: false,
            directory: default_source_data_directory(),
            record_limit: default_source_record_limit(),
        }
    }
}

impl Default for RuntimeAlgorithm {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_process_latest: false,
            processor: String::new(),
            config_path: String::new(),
            output_root: String::new(),
            timing_log: default_timing_log(),
            max_frames_per_camera: default_max_frames_per_camera(),
            source_data: RuntimeSourceDataPersistence::default(),
        }
    }
}

fn default_timing_log() -> String {
    "processing-times.jsonl".to_string()
}

fn default_max_frames_per_camera() -> usize {
    64
}

fn default_source_data_directory() -> String {
    "source-data/mysql".to_string()
}

fn default_source_record_limit() -> usize {
    500
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub direct_camera: bool,
    pub capture_management: bool,
    pub reconstruction: bool,
    pub offline_replay: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeCapability {
    DirectCamera,
    CaptureManagement,
    Reconstruction,
}

impl RuntimeCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DirectCamera => "directCamera",
            Self::CaptureManagement => "captureManagement",
            Self::Reconstruction => "reconstruction",
        }
    }
}

#[derive(Clone, Debug)]
pub struct RuntimeProfile {
    pub site_id: String,
    pub site_display_name: String,
    pub site_mode: SiteMode,
    pub site_compatibility: bool,
    pub site_selection_source: SiteSelectionSource,
    pub pending_restart: bool,
    pub id: String,
    pub display_name: String,
    pub provider: String,
    pub data_source: String,
    pub camera_connection: String,
    pub cameras: Vec<RuntimeCamera>,
    pub storage: RuntimeStorage,
    pub capture: RuntimeCapture,
    pub algorithm: RuntimeAlgorithm,
    pub capabilities: RuntimeCapabilities,
    pub capture_profile: Option<String>,
    pub config_hash: String,
    pub project_path: PathBuf,
    pub profile_path: PathBuf,
}

impl RuntimeProfile {
    pub fn load(project_path: &Path, allowed_root: &Path) -> Result<Self, String> {
        Self::load_internal(project_path, allowed_root, false, None)
    }

    pub fn load_for_startup(project_path: &Path, allowed_root: &Path) -> Result<Self, String> {
        Self::load_internal(project_path, allowed_root, true, None)
    }

    pub fn load_for_startup_selection(
        project_path: &Path,
        allowed_root: &Path,
        selection: EffectiveSiteSelection,
    ) -> Result<Self, String> {
        Self::load_internal(project_path, allowed_root, true, Some(selection))
    }

    fn load_internal(
        project_path: &Path,
        allowed_root: &Path,
        mark_applied: bool,
        selection: Option<EffectiveSiteSelection>,
    ) -> Result<Self, String> {
        let allowed_root = fs::canonicalize(allowed_root).map_err(|error| {
            format!(
                "runtime profile allowed root is unavailable ({}): {error}",
                allowed_root.display()
            )
        })?;
        let (active_site, site_selection_source) = match selection {
            Some(selection) => (
                resolve_site_by_id(project_path, &allowed_root, &selection.site_id)?,
                selection.source,
            ),
            None => (
                resolve_active_site(project_path, &allowed_root)?,
                SiteSelectionSource::Repository,
            ),
        };
        let profile_path = active_site.runtime_profile_path.clone();
        let profile_bytes = fs::read(&profile_path)
            .map_err(|error| format!("runtime profile read failed: {error}"))?;
        let document: RuntimeProfileDocument = serde_json::from_slice(&profile_bytes)
            .map_err(|error| format!("runtime profile JSON invalid: {error}"))?;
        let configuration_root = if active_site.compatibility {
            allowed_root.as_path()
        } else {
            profile_path
                .parent()
                .ok_or_else(|| "runtime profile path has no site directory".to_string())?
        };
        validate_profile(&document, &allowed_root, configuration_root)?;
        if mark_applied {
            ensure_cache_root_writable(&document.storage, &allowed_root)?;
        }

        let mut hasher = Sha256::new();
        if site_selection_source == SiteSelectionSource::Repository {
            hasher.update(hashable_project_bytes(&active_site.project_bytes)?);
        } else {
            hasher.update(b"machine-site-selection");
            hasher.update(active_site.site_id.as_bytes());
        }
        if let Some(site_bytes) = active_site.site_bytes.as_ref() {
            hasher.update([0]);
            hasher.update(site_bytes);
        }
        hasher.update([0]);
        hasher.update(&profile_bytes);

        if let Some(relative) = document.capture_profile.as_deref() {
            let capture_path =
                contained_existing_file(configuration_root, relative, "capture profile")?;
            let capture_bytes = fs::read(&capture_path)
                .map_err(|error| format!("capture profile read failed: {error}"))?;
            validate_capture_profile(&document, &capture_bytes)?;
            hasher.update([0]);
            hasher.update(capture_bytes);
        } else if document.camera_connection == "headless-cpp" {
            return Err("direct runtime profile requires captureProfile".to_string());
        }
        if document.algorithm.enabled {
            let algorithm_path = contained_existing_file(
                configuration_root,
                &document.algorithm.config_path,
                "algorithm config",
            )?;
            let algorithm_bytes = fs::read(&algorithm_path)
                .map_err(|error| format!("algorithm config read failed: {error}"))?;
            hasher.update([0]);
            hasher.update(algorithm_bytes);
        }

        let capture = resolved_capture(&document);
        if mark_applied
            && site_selection_source == SiteSelectionSource::Repository
            && active_site.pending_restart
        {
            mark_project_applied(&active_site.project_path)?;
        }
        Ok(Self {
            site_id: active_site.site_id,
            site_display_name: active_site.site_display_name,
            site_mode: active_site.site_mode,
            site_compatibility: active_site.compatibility,
            site_selection_source,
            pending_restart: active_site.pending_restart
                && (!mark_applied || site_selection_source != SiteSelectionSource::Repository),
            id: document.id,
            display_name: document.display_name,
            provider: document.provider,
            data_source: document.data_source,
            camera_connection: document.camera_connection,
            cameras: document.cameras,
            storage: document.storage,
            capture,
            algorithm: document.algorithm,
            capabilities: document.capabilities,
            capture_profile: document.capture_profile,
            config_hash: format!("{:x}", hasher.finalize()),
            project_path: active_site.project_path,
            profile_path,
        })
    }

    pub fn camera_count(&self) -> usize {
        self.cameras.len()
    }

    pub fn validate_candidate(&self, candidate: &Value) -> Result<(Vec<u8>, String), String> {
        let allowed_root = self
            .project_path
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "runtime project path has no configuration root".to_string())?;
        let allowed_root = fs::canonicalize(allowed_root)
            .map_err(|error| format!("runtime configuration root unavailable: {error}"))?;
        let document: RuntimeProfileDocument = serde_json::from_value(candidate.clone())
            .map_err(|error| format!("runtime profile JSON invalid: {error}"))?;
        if document.id != self.id {
            return Err("runtime profile id cannot change in-place".to_string());
        }
        let configuration_root = if self.site_compatibility {
            allowed_root.as_path()
        } else {
            self.profile_path
                .parent()
                .ok_or_else(|| "runtime profile path has no site directory".to_string())?
        };
        validate_profile(&document, &allowed_root, configuration_root)?;
        let profile_bytes = serde_json::to_vec_pretty(candidate)
            .map_err(|error| format!("runtime profile serialization failed: {error}"))?;
        let project_bytes = fs::read(&self.project_path)
            .map_err(|error| format!("project config read failed: {error}"))?;
        let mut hasher = Sha256::new();
        hasher.update(project_bytes);
        hasher.update([0]);
        hasher.update(&profile_bytes);
        if let Some(relative) = document.capture_profile.as_deref() {
            let capture_path =
                contained_existing_file(configuration_root, relative, "capture profile")?;
            let capture_bytes = fs::read(&capture_path)
                .map_err(|error| format!("capture profile read failed: {error}"))?;
            validate_capture_profile(&document, &capture_bytes)?;
            hasher.update([0]);
            hasher.update(capture_bytes);
        } else if document.camera_connection == "headless-cpp" {
            return Err("direct runtime profile requires captureProfile".to_string());
        }
        if document.algorithm.enabled {
            let algorithm_path = contained_existing_file(
                configuration_root,
                &document.algorithm.config_path,
                "algorithm config",
            )?;
            let algorithm_bytes = fs::read(&algorithm_path)
                .map_err(|error| format!("algorithm config read failed: {error}"))?;
            hasher.update([0]);
            hasher.update(algorithm_bytes);
        }
        Ok((profile_bytes, format!("{:x}", hasher.finalize())))
    }

    pub fn allows(&self, capability: RuntimeCapability) -> bool {
        match capability {
            RuntimeCapability::DirectCamera => self.capabilities.direct_camera,
            RuntimeCapability::CaptureManagement => self.capabilities.capture_management,
            RuntimeCapability::Reconstruction => self.capabilities.reconstruction,
        }
    }

    pub fn public_value(&self) -> Value {
        json!({
            "schema": "steel.runtime-profile.public.v1",
            "siteId": self.site_id,
            "siteDisplayName": self.site_display_name,
            "siteMode": self.site_mode,
            "siteCompatibility": self.site_compatibility,
            "siteSelectionSource": self.site_selection_source,
            "pendingRestart": self.pending_restart,
            "profileId": self.id,
            "displayName": self.display_name,
            "provider": self.provider,
            "dataSource": self.data_source,
            "cameraConnection": self.camera_connection,
            "cameraCount": self.camera_count(),
            "cameras": self.cameras.iter().map(|camera| json!({
                "id": camera.id,
                "displayOrder": camera.display_order,
                "sourceCameraId": camera.source_camera_id,
                "role": camera.role,
            })).collect::<Vec<_>>(),
            "configHash": self.config_hash,
            "capture": self.capture,
            "algorithm": self.algorithm,
            "capabilities": self.capabilities,
        })
    }

    #[cfg(test)]
    pub fn test_profile(provider: &str, camera_count: usize) -> Self {
        let direct = provider != "bkv";
        Self {
            site_id: format!("test-{provider}-{camera_count}"),
            site_display_name: "test site".to_string(),
            site_mode: if direct {
                SiteMode::DirectCamera
            } else {
                SiteMode::Bkv
            },
            site_compatibility: false,
            site_selection_source: SiteSelectionSource::Repository,
            pending_restart: false,
            id: format!("test-{provider}-{camera_count}"),
            display_name: "test runtime".to_string(),
            provider: provider.to_string(),
            data_source: if provider == "bkv" {
                "converted-local".to_string()
            } else {
                "online-production".to_string()
            },
            camera_connection: if direct {
                "headless-cpp".to_string()
            } else {
                "none".to_string()
            },
            cameras: (1..=camera_count)
                .map(|camera| RuntimeCamera {
                    id: format!("C{camera}"),
                    display_order: camera,
                    source_camera_id: camera,
                    role: String::new(),
                    source_directory: String::new(),
                })
                .collect(),
            storage: RuntimeStorage::default(),
            capture: RuntimeCapture {
                enabled: direct,
                autostart: direct,
            },
            algorithm: RuntimeAlgorithm::default(),
            capabilities: RuntimeCapabilities {
                direct_camera: direct,
                capture_management: direct,
                reconstruction: direct,
                offline_replay: !direct,
            },
            capture_profile: None,
            config_hash: "test".to_string(),
            project_path: PathBuf::new(),
            profile_path: PathBuf::new(),
        }
    }
}

fn ensure_cache_root_writable(storage: &RuntimeStorage, allowed_root: &Path) -> Result<(), String> {
    let configured = storage.cache_root.trim();
    if configured.is_empty() {
        return Ok(());
    }
    let cache_root = allowed_root.join(configured);
    fs::create_dir_all(&cache_root).map_err(|error| {
        format!(
            "storage cacheRoot is not writable ({}): {error}",
            cache_root.display()
        )
    })?;
    let canonical = fs::canonicalize(&cache_root).map_err(|error| {
        format!(
            "storage cacheRoot is unavailable ({}): {error}",
            cache_root.display()
        )
    })?;
    if !canonical.starts_with(allowed_root) {
        return Err("storage cacheRoot escapes allowed root".to_string());
    }
    let probe = canonical.join(format!(".steel-cache-write-probe-{}", std::process::id()));
    fs::create_dir(&probe).map_err(|error| {
        format!(
            "storage cacheRoot is not writable ({}): {error}",
            canonical.display()
        )
    })?;
    fs::remove_dir(&probe).map_err(|error| {
        format!(
            "storage cacheRoot write probe cleanup failed ({}): {error}",
            probe.display()
        )
    })
}

fn hashable_project_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut project: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("project config JSON invalid: {error}"))?;
    if let Some(object) = project.as_object_mut() {
        object.insert("pendingRestart".to_string(), Value::Bool(false));
    }
    serde_json::to_vec(&project)
        .map_err(|error| format!("project config serialization failed: {error}"))
}

fn validate_profile(
    document: &RuntimeProfileDocument,
    allowed_root: &Path,
    configuration_root: &Path,
) -> Result<(), String> {
    if document.schema != RUNTIME_PROFILE_SCHEMA {
        return Err(format!(
            "runtime profile schema must be {RUNTIME_PROFILE_SCHEMA}"
        ));
    }
    if document.id.trim().is_empty() || document.display_name.trim().is_empty() {
        return Err("runtime profile identity is missing".to_string());
    }
    if document.camera_count == 0 || document.camera_count != document.cameras.len() {
        return Err("runtime profile cameraCount must match cameras".to_string());
    }
    let mut ids = HashSet::new();
    let mut source_ids = HashSet::new();
    for (index, camera) in document.cameras.iter().enumerate() {
        if camera.id.trim().is_empty()
            || !ids.insert(camera.id.trim().to_ascii_lowercase())
            || camera.display_order != index + 1
            || camera.source_camera_id == 0
            || !source_ids.insert(camera.source_camera_id)
        {
            return Err(format!(
                "runtime profile camera {} identity/order is invalid",
                index + 1
            ));
        }
        if !camera.source_directory.trim().is_empty() {
            validate_relative_path(&camera.source_directory, "camera sourceDirectory")?;
        }
    }

    let capture = resolved_capture(document);
    match document.camera_connection.as_str() {
        "none" => {
            if document.capabilities.direct_camera
                || document.capabilities.capture_management
                || document.capabilities.reconstruction
            {
                return Err(
                    "non-direct runtime profile cannot enable direct-camera capabilities"
                        .to_string(),
                );
            }
            if document.provider != "bkv" {
                return Err("cameraConnection=none currently requires provider=bkv".to_string());
            }
            if capture.enabled || capture.autostart {
                return Err(
                    "cameraConnection=none requires capture.enabled=false and capture.autostart=false"
                        .to_string(),
                );
            }
        }
        "headless-cpp" => {
            if !document.capabilities.direct_camera || !document.capabilities.capture_management {
                return Err(
                    "headless-cpp runtime profile requires direct camera capabilities".to_string(),
                );
            }
            if !capture.enabled {
                return Err(
                    "headless-cpp runtime profile requires capture.enabled=true".to_string()
                );
            }
            if capture.autostart && !capture.enabled {
                return Err("capture.autostart requires capture.enabled=true".to_string());
            }
        }
        other => return Err(format!("unsupported cameraConnection: {other}")),
    }

    for (value, label) in [
        (&document.storage.source_root, "storage sourceRoot"),
        (&document.storage.converted_root, "storage convertedRoot"),
        (&document.storage.catalog_path, "storage catalogPath"),
        (&document.storage.cache_root, "storage cacheRoot"),
    ] {
        if !value.trim().is_empty() {
            validate_relative_path(value, label)?;
            let resolved = allowed_root.join(value);
            if !resolved.starts_with(allowed_root) {
                return Err(format!("{label} escapes allowed root"));
            }
        }
    }
    if document.storage.layout_version != 2 {
        return Err(
            "storage layoutVersion must be 2; migrate standard records before startup".to_string(),
        );
    }
    if document.data_source == "converted-local"
        && (document.storage.source_root.trim().is_empty()
            || document.storage.converted_root.trim().is_empty()
            || document.storage.catalog_path.trim().is_empty()
            || document.storage.cache_root.trim().is_empty())
    {
        return Err(
            "converted-local profile requires source, converted, catalog, and cache paths".into(),
        );
    }
    if document.data_source == "converted-local" {
        validate_loopback_origin(&document.storage.converter_origin)?;
    }
    if document.algorithm.enabled {
        if document.algorithm.processor.trim().is_empty() {
            return Err("enabled algorithm pipeline requires processor".to_string());
        }
        if document.algorithm.config_path.trim().is_empty() {
            return Err("enabled algorithm pipeline requires configPath".to_string());
        }
        let _ = contained_existing_file(
            configuration_root,
            &document.algorithm.config_path,
            "algorithm config",
        )?;
        if !is_absolute_non_volume_root(document.algorithm.output_root.trim()) {
            return Err(
                "enabled algorithm pipeline outputRoot must be an absolute non-volume-root path"
                    .to_string(),
            );
        }
        validate_relative_path(&document.algorithm.timing_log, "algorithm timingLog")?;
        if document.algorithm.max_frames_per_camera == 0
            || document.algorithm.max_frames_per_camera > 512
        {
            return Err("algorithm maxFramesPerCamera must be between 1 and 512".to_string());
        }
        if document.algorithm.source_data.enabled {
            validate_relative_path(
                &document.algorithm.source_data.directory,
                "algorithm sourceData directory",
            )?;
            if document.algorithm.source_data.directory.trim().is_empty() {
                return Err("algorithm sourceData directory cannot be empty".to_string());
            }
            if document.algorithm.source_data.record_limit == 0
                || document.algorithm.source_data.record_limit > 2_000
            {
                return Err(
                    "algorithm sourceData recordLimit must be between 1 and 2000".to_string(),
                );
            }
        }
    } else if document.algorithm.auto_process_latest {
        return Err("algorithm autoProcessLatest requires algorithm.enabled=true".to_string());
    }
    Ok(())
}

fn resolved_capture(document: &RuntimeProfileDocument) -> RuntimeCapture {
    document.capture.clone().unwrap_or_else(|| {
        let enabled = document.camera_connection == "headless-cpp";
        RuntimeCapture {
            enabled,
            autostart: enabled,
        }
    })
}

fn validate_loopback_origin(value: &str) -> Result<(), String> {
    let authority = value
        .strip_prefix("http://")
        .filter(|_| !value.contains(['?', '#']))
        .and_then(|rest| (!rest.contains('/')).then_some(rest))
        .ok_or_else(|| "storage converterOrigin must be a loopback HTTP origin".to_string())?;
    if authority.contains('@') {
        return Err("storage converterOrigin must be a loopback HTTP origin".to_string());
    }
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| "storage converterOrigin requires an explicit port".to_string())?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port = port
        .parse::<u16>()
        .map_err(|_| "storage converterOrigin port is invalid".to_string())?;
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    if !loopback || port == 0 {
        return Err("storage converterOrigin must be a loopback HTTP origin".to_string());
    }
    Ok(())
}

fn validate_capture_profile(profile: &RuntimeProfileDocument, bytes: &[u8]) -> Result<(), String> {
    let capture: CaptureProfileDocument = serde_json::from_slice(bytes)
        .map_err(|error| format!("capture profile JSON invalid: {error}"))?;
    if !CAPTURE_PROFILE_SCHEMAS.contains(&capture.schema.as_str()) {
        return Err(format!(
            "capture profile schema must be one of {}",
            CAPTURE_PROFILE_SCHEMAS.join(", ")
        ));
    }
    let enabled = capture
        .cameras
        .iter()
        .filter(|camera| camera.enabled)
        .collect::<Vec<_>>();
    if capture.expected_cameras != profile.camera_count
        || enabled.len() != profile.camera_count
        || enabled
            .iter()
            .enumerate()
            .any(|(index, camera)| camera.camera_index != index + 1)
    {
        return Err("capture profile camera topology does not match runtime profile".to_string());
    }
    Ok(())
}

fn validate_relative_path(value: &str, label: &str) -> Result<(), String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(format!("{label} must remain beneath the allowed root"));
    }
    Ok(())
}

fn is_absolute_non_volume_root(value: &str) -> bool {
    let path = Path::new(value);
    if path.is_absolute() {
        return path.parent().is_some()
            && path
                .parent()
                .is_some_and(|parent| parent.parent().is_some());
    }

    let bytes = value.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !matches!(bytes[2], b'\\' | b'/')
    {
        return false;
    }
    value[3..]
        .split(['\\', '/'])
        .filter(|component| !component.is_empty())
        .count()
        >= 2
}

fn contained_existing_file(
    root: &Path,
    candidate: impl AsRef<Path>,
    label: &str,
) -> Result<PathBuf, String> {
    let candidate = candidate.as_ref();
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let canonical = fs::canonicalize(&joined)
        .map_err(|error| format!("{label} is unavailable ({}): {error}", joined.display()))?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err(format!("{label} must be a file beneath the allowed root"));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::site_config::{CreateSiteConfig, SiteConfigStore, SiteMode};
    use serde_json::{json, Value};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        root: PathBuf,
        project: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn write_json(path: &Path, value: &Value) {
        fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture");
        fs::write(
            path,
            serde_json::to_vec_pretty(value).expect("fixture JSON"),
        )
        .expect("write fixture");
    }

    fn fixture(profile: Value, capture_profile: Option<Value>) -> Fixture {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "steel-runtime-profile-{}-{stamp}",
            std::process::id()
        ));
        let project = root.join("project.json");
        write_json(
            &project,
            &json!({
                "schema": "steel.project-config.v1",
                "activeRuntimeProfile": "runtime-modes/active.json"
            }),
        );
        write_json(&root.join("runtime-modes/active.json"), &profile);
        if let Some(capture) = capture_profile {
            write_json(
                &root.join("capture/profiles/current/profile.json"),
                &capture,
            );
        }
        Fixture { root, project }
    }

    fn cameras(count: usize) -> Vec<Value> {
        (1..=count)
            .map(|camera| {
                json!({
                    "id": format!("C{camera}"),
                    "displayOrder": camera,
                    "sourceCameraId": camera,
                    "role": format!("array-{camera}")
                })
            })
            .collect()
    }

    fn bkv_profile() -> Value {
        json!({
            "schema": "steel.runtime-profile.v1",
            "id": "bkv-6",
            "displayName": "BKV 六相机",
            "provider": "bkv",
            "dataSource": "converted-local",
            "cameraConnection": "none",
            "cameraCount": 6,
            "cameras": cameras(6),
            "storage": {
                "layoutVersion": 2,
                "sourceRoot": "source",
                "convertedRoot": "converted",
                "catalogPath": "converted/catalog.db",
                "cacheRoot": "converted/cache",
                "converterOrigin": "http://127.0.0.1:4893"
            },
            "capabilities": {
                "directCamera": false,
                "captureManagement": false,
                "reconstruction": false,
                "offlineReplay": true
            }
        })
    }

    #[test]
    fn loads_six_camera_bkv_profile_with_non_direct_capabilities() {
        let fixture = fixture(bkv_profile(), None);
        fs::create_dir_all(fixture.root.join("source")).expect("source root");
        fs::create_dir_all(fixture.root.join("converted")).expect("converted root");

        let loaded = RuntimeProfile::load(&fixture.project, &fixture.root).expect("BKV profile");

        assert_eq!(loaded.camera_count(), 6);
        assert_eq!(loaded.provider, "bkv");
        assert!(!loaded.capabilities.direct_camera);
        assert!(!loaded.capabilities.capture_management);
        assert!(!loaded.capabilities.reconstruction);
        assert!(loaded.capabilities.offline_replay);
    }

    #[test]
    fn loads_eight_camera_direct_profile_and_capture_reference() {
        let profile = json!({
            "schema": "steel.runtime-profile.v1",
            "id": "direct-8",
            "displayName": "八相机直连",
            "provider": "headless-cpp",
            "dataSource": "online-production",
            "cameraConnection": "headless-cpp",
            "cameraCount": 8,
            "captureProfile": "capture/profiles/current/profile.json",
            "cameras": cameras(8),
            "storage": {},
            "capabilities": {
                "directCamera": true,
                "captureManagement": true,
                "reconstruction": true,
                "offlineReplay": false
            }
        });
        let capture = json!({
            "schema": "steel.capture.profile.v1",
            "name": "current",
            "expectedCameras": 8,
            "cameras": (1..=8).map(|camera| json!({
                "cameraIndex": camera,
                "enabled": true
            })).collect::<Vec<_>>()
        });
        let fixture = fixture(profile, Some(capture));

        let loaded = RuntimeProfile::load(&fixture.project, &fixture.root).expect("direct profile");

        assert_eq!(loaded.camera_count(), 8);
        assert_eq!(
            loaded.capture_profile.as_deref(),
            Some("capture/profiles/current/profile.json")
        );
        assert!(loaded.capabilities.direct_camera);
    }

    #[test]
    fn rejects_camera_count_mismatch_duplicate_ids_and_path_escape() {
        let mut mismatch = bkv_profile();
        mismatch["cameraCount"] = json!(8);
        let mismatch_fixture = fixture(mismatch, None);
        assert!(RuntimeProfile::load(&mismatch_fixture.project, &mismatch_fixture.root).is_err());

        let mut duplicate = bkv_profile();
        duplicate["cameras"][1]["id"] = json!("C1");
        let duplicate_fixture = fixture(duplicate, None);
        assert!(RuntimeProfile::load(&duplicate_fixture.project, &duplicate_fixture.root).is_err());

        let mut escaped = bkv_profile();
        escaped["storage"]["convertedRoot"] = json!("../outside");
        let escaped_fixture = fixture(escaped, None);
        assert!(RuntimeProfile::load(&escaped_fixture.project, &escaped_fixture.root).is_err());
    }

    #[test]
    fn loads_runtime_profile_relative_to_the_active_site_manifest() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("steel-runtime-site-{}-{stamp}", std::process::id()));
        let config_root = root.join("config");
        let store =
            SiteConfigStore::new(config_root.join("sites")).expect("site configuration store");
        store
            .create(CreateSiteConfig {
                id: "bkv-default".to_string(),
                display_name: "BKV 六相机现场".to_string(),
                mode: SiteMode::Bkv,
            })
            .expect("site package");
        let project = config_root.join("project.json");
        write_json(
            &project,
            &json!({
                "schema": "steel.project-config.v1",
                "activeSiteConfig": "config/sites/bkv-default/site.json",
                "pendingRestart": false
            }),
        );

        let loaded = RuntimeProfile::load(&project, &root).expect("site runtime");

        assert_eq!(loaded.site_id, "bkv-default");
        assert_eq!(loaded.site_display_name, "BKV 六相机现场");
        assert_eq!(loaded.site_mode, SiteMode::Bkv);
        assert_eq!(loaded.camera_count(), 6);
        assert!(!loaded.site_compatibility);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn marks_active_runtime_profile_projects_as_legacy_compatibility_sites() {
        let fixture = fixture(bkv_profile(), None);
        fs::create_dir_all(fixture.root.join("source")).expect("source root");
        fs::create_dir_all(fixture.root.join("converted")).expect("converted root");

        let loaded = RuntimeProfile::load(&fixture.project, &fixture.root).expect("legacy runtime");

        assert!(loaded.site_compatibility);
        assert_eq!(loaded.site_id, "bkv-6");
        assert_eq!(loaded.site_mode, SiteMode::Bkv);
    }

    #[test]
    fn accepts_a_project_path_relative_to_the_allowed_root() {
        let fixture = fixture(bkv_profile(), None);
        fs::create_dir_all(fixture.root.join("source")).expect("source root");
        fs::create_dir_all(fixture.root.join("converted")).expect("converted root");
        let relative_project = fixture
            .project
            .strip_prefix(&fixture.root)
            .expect("relative project");

        let loaded =
            RuntimeProfile::load(relative_project, &fixture.root).expect("relative project");

        assert_eq!(loaded.site_id, "bkv-6");
    }

    #[test]
    fn checked_in_project_uses_the_bkv_six_camera_site_package() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .expect("workspace");

        let loaded = RuntimeProfile::load(&workspace.join("config/project.json"), &workspace)
            .expect("checked-in runtime");

        assert_eq!(loaded.site_id, "bkv-default");
        assert_eq!(loaded.site_mode, SiteMode::Bkv);
        assert_eq!(loaded.camera_count(), 6);
        assert!(!loaded.site_compatibility);
    }

    #[test]
    fn recognizes_configured_windows_output_roots_on_every_host_platform() {
        assert!(is_absolute_non_volume_root(
            r"D:\steel-inspection\algorithm-data"
        ));
        assert!(is_absolute_non_volume_root(
            "D:/steel-inspection/algorithm-data"
        ));
        assert!(!is_absolute_non_volume_root(r"D:\"));
        assert!(!is_absolute_non_volume_root("D:relative/path"));
    }

    #[test]
    fn successful_startup_clears_the_pending_restart_marker() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "steel-runtime-restart-{}-{stamp}",
            std::process::id()
        ));
        let config_root = root.join("config");
        let store =
            SiteConfigStore::new(config_root.join("sites")).expect("site configuration store");
        store
            .create(CreateSiteConfig {
                id: "bkv-restart".to_string(),
                display_name: "BKV 重启现场".to_string(),
                mode: SiteMode::Bkv,
            })
            .expect("site package");
        let project = config_root.join("project.json");
        write_json(
            &project,
            &json!({
                "schema": "steel.project-config.v1",
                "activeSiteConfig": "config/sites/bkv-restart/site.json",
                "pendingRestart": true
            }),
        );

        let loaded = RuntimeProfile::load_for_startup(&project, &root).expect("site runtime");
        let persisted: Value = serde_json::from_slice(&fs::read(&project).expect("project bytes"))
            .expect("project JSON");

        assert!(!loaded.pending_restart);
        assert_eq!(persisted["pendingRestart"], false);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn startup_selection_loads_the_explicit_site_and_exposes_its_source() {
        use crate::machine_site_config::{EffectiveSiteSelection, SiteSelectionSource};

        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "steel-runtime-selection-{}-{stamp}",
            std::process::id()
        ));
        let config_root = root.join("config");
        let store =
            SiteConfigStore::new(config_root.join("sites")).expect("site configuration store");
        for id in ["repo-site", "registry-site"] {
            store
                .create(CreateSiteConfig {
                    id: id.to_string(),
                    display_name: id.to_string(),
                    mode: SiteMode::Bkv,
                })
                .expect("site package");
        }
        let project = config_root.join("project.json");
        write_json(
            &project,
            &json!({
                "schema": "steel.project-config.v1",
                "activeSiteConfig": "config/sites/repo-site/site.json",
                "pendingRestart": false
            }),
        );

        let loaded = RuntimeProfile::load_for_startup_selection(
            &project,
            &root,
            EffectiveSiteSelection {
                site_id: "registry-site".to_string(),
                source: SiteSelectionSource::Registry,
            },
        )
        .expect("selected site runtime");

        assert_eq!(loaded.site_id, "registry-site");
        assert_eq!(
            loaded.public_value()["siteSelectionSource"],
            json!("registry")
        );
        let _ = fs::remove_dir_all(root);
    }
}
