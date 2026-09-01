use crate::machine_site_config::{EffectiveSiteSelection, SiteSelectionSource};
use crate::site_config::{mark_project_applied, resolve_active_site, resolve_site_by_id, SiteMode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const RUNTIME_PROFILE_SCHEMA: &str = "steel.runtime-profile.v1";
const CAPTURE_PROFILE_SCHEMAS: &[&str] = &["steel.capture.profile.v1", "steel.capture.profile.v2"];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeProfileDocument {
    schema: String,
    id: String,
    display_name: String,
    #[serde(default)]
    acquisition_mode: Option<AcquisitionMode>,
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
    #[serde(default)]
    simulation: Option<RuntimeSimulation>,
    capabilities: RuntimeCapabilities,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureProfileDocument {
    schema: String,
    #[serde(default)]
    storage_root: String,
    expected_cameras: usize,
    cameras: Vec<CaptureCamera>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureCamera {
    camera_index: usize,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    storage_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnlineCaptureHardwareDocument {
    #[serde(default)]
    driver_mode: String,
    #[serde(default)]
    sick: Option<OnlineSickHardwareDocument>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnlineSickHardwareDocument {
    #[serde(default)]
    cti_path: String,
    #[serde(default)]
    cti_sha256: String,
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AcquisitionMode {
    Online,
    Offline,
    Simulation,
}

impl AcquisitionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Offline => "offline",
            Self::Simulation => "simulation",
        }
    }

    pub fn physical_camera_required(self) -> bool {
        matches!(self, Self::Online)
    }
}

fn default_simulation_speed() -> f64 {
    1.0
}

fn default_simulation_inter_session_gap_ms() -> u64 {
    1_500
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSimulation {
    #[serde(default)]
    pub source_root: String,
    #[serde(default = "default_simulation_speed")]
    pub speed: f64,
    #[serde(default, rename = "loop")]
    pub loop_playback: bool,
    #[serde(default = "default_simulation_inter_session_gap_ms", alias = "gapMs")]
    pub inter_session_gap_ms: u64,
}

impl Default for RuntimeSimulation {
    fn default() -> Self {
        Self {
            source_root: String::new(),
            speed: default_simulation_speed(),
            loop_playback: false,
            inter_session_gap_ms: default_simulation_inter_session_gap_ms(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub direct_camera: bool,
    pub capture_management: bool,
    pub reconstruction: bool,
    pub offline_replay: bool,
}

impl RuntimeCapabilities {
    fn effective_for_mode(&self, mode: AcquisitionMode) -> Self {
        match mode {
            AcquisitionMode::Online => self.clone(),
            AcquisitionMode::Offline => Self {
                direct_camera: false,
                capture_management: false,
                reconstruction: false,
                offline_replay: self.offline_replay,
            },
            AcquisitionMode::Simulation => Self {
                direct_camera: false,
                capture_management: self.capture_management,
                reconstruction: self.reconstruction,
                offline_replay: true,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeCapability {
    DirectCamera,
    CaptureManagement,
    Reconstruction,
    OfflineReplay,
}

impl RuntimeCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DirectCamera => "directCamera",
            Self::CaptureManagement => "captureManagement",
            Self::Reconstruction => "reconstruction",
            Self::OfflineReplay => "offlineReplay",
        }
    }
}

#[derive(Clone, Debug)]
pub struct RuntimeProfile {
    pub site_id: String,
    pub site_display_name: String,
    pub site_deprecated: bool,
    pub site_deprecation_notice: String,
    pub site_mode: SiteMode,
    pub site_compatibility: bool,
    pub site_selection_source: SiteSelectionSource,
    pub pending_restart: bool,
    pub id: String,
    pub display_name: String,
    pub acquisition_mode: AcquisitionMode,
    pub provider: String,
    pub data_source: String,
    pub camera_connection: String,
    pub cameras: Vec<RuntimeCamera>,
    pub storage: RuntimeStorage,
    pub capture: RuntimeCapture,
    pub algorithm: RuntimeAlgorithm,
    pub simulation: Option<RuntimeSimulation>,
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
        let acquisition_mode = resolved_acquisition_mode(&document);
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
            validate_online_capture_hardware(&document, &capture_bytes)?;
            validate_simulation_path_isolation(&document, &capture_bytes, &allowed_root)?;
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
            site_deprecated: active_site.site_deprecated,
            site_deprecation_notice: active_site.site_deprecation_notice,
            site_mode: active_site.site_mode,
            site_compatibility: active_site.compatibility,
            site_selection_source,
            pending_restart: active_site.pending_restart
                && (!mark_applied || site_selection_source != SiteSelectionSource::Repository),
            id: document.id,
            display_name: document.display_name,
            acquisition_mode,
            provider: document.provider,
            data_source: document.data_source,
            camera_connection: document.camera_connection,
            cameras: document.cameras,
            storage: document.storage,
            capture,
            algorithm: document.algorithm,
            simulation: document.simulation,
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
        let mut normalized_candidate = candidate.clone();
        if let Some(profile) = normalized_candidate.as_object_mut() {
            profile.insert(
                "acquisitionMode".to_string(),
                json!(resolved_acquisition_mode(&document)),
            );
            if let Some(simulation) = document.simulation.as_ref() {
                if let Some(settings) = profile.get_mut("simulation").and_then(Value::as_object_mut)
                {
                    settings.remove("gapMs");
                    settings.insert(
                        "interSessionGapMs".to_string(),
                        json!(simulation.inter_session_gap_ms),
                    );
                }
            }
        }
        let profile_bytes = serde_json::to_vec_pretty(&normalized_candidate)
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
            validate_online_capture_hardware(&document, &capture_bytes)?;
            validate_simulation_path_isolation(&document, &capture_bytes, &allowed_root)?;
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

    pub fn candidate_acquisition_mode(&self, candidate: &Value) -> Result<AcquisitionMode, String> {
        let document: RuntimeProfileDocument = serde_json::from_value(candidate.clone())
            .map_err(|error| format!("runtime profile JSON invalid: {error}"))?;
        Ok(resolved_acquisition_mode(&document))
    }

    pub fn allows(&self, capability: RuntimeCapability) -> bool {
        let capabilities = self.capabilities.effective_for_mode(self.acquisition_mode);
        match capability {
            RuntimeCapability::DirectCamera => capabilities.direct_camera,
            RuntimeCapability::CaptureManagement => capabilities.capture_management,
            RuntimeCapability::Reconstruction => capabilities.reconstruction,
            RuntimeCapability::OfflineReplay => capabilities.offline_replay,
        }
    }

    pub fn effective_capabilities(&self) -> RuntimeCapabilities {
        self.capabilities.effective_for_mode(self.acquisition_mode)
    }

    pub fn public_value(&self) -> Value {
        let capabilities = self.effective_capabilities();
        json!({
            "schema": "steel.runtime-profile.public.v1",
            "siteId": self.site_id,
            "siteDisplayName": self.site_display_name,
            "siteDeprecated": self.site_deprecated,
            "siteDeprecationNotice": self.site_deprecation_notice,
            "siteMode": self.site_mode,
            "siteCompatibility": self.site_compatibility,
            "siteSelectionSource": self.site_selection_source,
            "pendingRestart": self.pending_restart,
            "profileId": self.id,
            "displayName": self.display_name,
            "acquisitionMode": self.acquisition_mode,
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
            "simulation": self.simulation.as_ref().map(|simulation| json!({
                "configured": !simulation.source_root.trim().is_empty(),
                "speed": simulation.speed,
                "loop": simulation.loop_playback,
                "interSessionGapMs": simulation.inter_session_gap_ms,
            })),
            "capabilities": capabilities,
        })
    }

    #[cfg(test)]
    pub fn test_profile(provider: &str, camera_count: usize) -> Self {
        let acquisition_mode = match provider {
            "bkv" => AcquisitionMode::Offline,
            "simulated" => AcquisitionMode::Simulation,
            _ => AcquisitionMode::Online,
        };
        let direct = acquisition_mode == AcquisitionMode::Online;
        let capture_enabled = acquisition_mode != AcquisitionMode::Offline;
        Self {
            site_id: format!("test-{provider}-{camera_count}"),
            site_display_name: "test site".to_string(),
            site_deprecated: false,
            site_deprecation_notice: String::new(),
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
            acquisition_mode,
            provider: provider.to_string(),
            data_source: if provider == "bkv" {
                "converted-local".to_string()
            } else {
                "online-production".to_string()
            },
            camera_connection: match acquisition_mode {
                AcquisitionMode::Online => "headless-cpp",
                AcquisitionMode::Offline => "none",
                AcquisitionMode::Simulation => "simulated",
            }
            .to_string(),
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
                enabled: capture_enabled,
                autostart: capture_enabled,
            },
            algorithm: RuntimeAlgorithm::default(),
            simulation: (acquisition_mode == AcquisitionMode::Simulation).then(|| {
                RuntimeSimulation {
                    source_root: std::env::temp_dir().display().to_string(),
                    ..RuntimeSimulation::default()
                }
            }),
            capabilities: RuntimeCapabilities {
                direct_camera: direct,
                capture_management: capture_enabled,
                reconstruction: capture_enabled,
                offline_replay: acquisition_mode != AcquisitionMode::Online,
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

    let acquisition_mode = resolved_acquisition_mode(document);
    let capture = resolved_capture(document);
    if capture.autostart && !capture.enabled {
        return Err("capture.autostart requires capture.enabled=true".to_string());
    }
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
        }
        other => return Err(format!("unsupported cameraConnection: {other}")),
    }

    if acquisition_mode == AcquisitionMode::Online
        && matches!(document.provider.as_str(), "bkv" | "simulated")
    {
        return Err("online mode requires a physical capture provider".to_string());
    }
    if acquisition_mode == AcquisitionMode::Simulation {
        if document.camera_count != 6 {
            return Err("formal simulation mode requires runtime cameraCount=6".to_string());
        }
        if document.provider != "external-api"
            || document.camera_connection != "headless-cpp"
            || !capture.enabled
            || !document.capabilities.capture_management
        {
            return Err(
                "simulation mode requires the configured external-api capture pipeline".to_string(),
            );
        }
        let simulation = document
            .simulation
            .as_ref()
            .ok_or_else(|| "simulation mode requires simulation settings".to_string())?;
        if !is_absolute_non_volume_root(simulation.source_root.trim()) {
            return Err(
                "simulation sourceRoot must be an absolute non-volume-root path".to_string(),
            );
        }
        validate_simulation_source_directory(simulation.source_root.trim())?;
        if !simulation.speed.is_finite() || !(0.25..=4.0).contains(&simulation.speed) {
            return Err("simulation speed must be between 0.25 and 4.0".to_string());
        }
        if !(1_001..=3_600_000).contains(&simulation.inter_session_gap_ms) {
            return Err(
                "simulation interSessionGapMs must be between 1001 and 3600000".to_string(),
            );
        }
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

fn resolved_acquisition_mode(document: &RuntimeProfileDocument) -> AcquisitionMode {
    document.acquisition_mode.unwrap_or_else(|| {
        if document.provider.eq_ignore_ascii_case("simulated")
            || document.camera_connection.eq_ignore_ascii_case("simulated")
        {
            AcquisitionMode::Simulation
        } else if document.provider.eq_ignore_ascii_case("bkv")
            || document.camera_connection.eq_ignore_ascii_case("none")
        {
            AcquisitionMode::Offline
        } else {
            AcquisitionMode::Online
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
    if resolved_acquisition_mode(profile) == AcquisitionMode::Simulation
        && capture.expected_cameras != 6
    {
        return Err("formal simulation mode requires capture expectedCameras=6".to_string());
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

fn validate_online_capture_hardware(
    profile: &RuntimeProfileDocument,
    bytes: &[u8],
) -> Result<(), String> {
    if resolved_acquisition_mode(profile) != AcquisitionMode::Online {
        return Ok(());
    }
    let capture: OnlineCaptureHardwareDocument = serde_json::from_slice(bytes)
        .map_err(|error| format!("capture hardware profile JSON invalid: {error}"))?;
    if !capture
        .driver_mode
        .trim()
        .eq_ignore_ascii_case("sick-gentl")
    {
        return Err("online mode requires capture driverMode=sick-gentl".to_string());
    }
    let sick = capture
        .sick
        .as_ref()
        .ok_or_else(|| "online mode requires capture sick settings".to_string())?;
    if sick.cti_path.trim().is_empty() {
        return Err("online mode requires sick.ctiPath".to_string());
    }
    let expected_hash = sick.cti_sha256.trim();
    if expected_hash.len() != 64 || !expected_hash.bytes().all(|value| value.is_ascii_hexdigit()) {
        return Err("sick.ctiSha256 must be a 64-character hexadecimal SHA-256".to_string());
    }
    let cti_path = effective_sick_cti_path(&sick.cti_path)?;
    validate_regular_file_without_links(&cti_path, "sick.ctiPath")?;

    let mut source = fs::File::open(&cti_path).map_err(|error| {
        format!(
            "sick.ctiPath could not be opened ({}): {error}",
            cti_path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = source.read(&mut buffer).map_err(|error| {
            format!(
                "sick.ctiPath could not be hashed ({}): {error}",
                cti_path.display()
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let actual_hash = format!("{:x}", hasher.finalize());
    if !actual_hash.eq_ignore_ascii_case(expected_hash) {
        return Err(format!(
            "SICK GenTL producer hash mismatch: expected={} actual={actual_hash}",
            expected_hash.to_ascii_lowercase()
        ));
    }
    Ok(())
}

fn effective_sick_cti_path(configured: &str) -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("SICK_GENTL_CTI").filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err("SICK_GENTL_CTI must be an absolute path".to_string());
        }
        return Ok(path);
    }

    let mut expanded = configured.trim().to_string();
    let mut cursor = 0usize;
    while let Some(relative_start) = expanded[cursor..].find('%') {
        let start = cursor + relative_start;
        let Some(relative_end) = expanded[start + 1..].find('%') else {
            return Err(
                "sick.ctiPath contains an unterminated environment placeholder".to_string(),
            );
        };
        let end = start + 1 + relative_end;
        let name = &expanded[start + 1..end];
        if name.is_empty() {
            return Err("sick.ctiPath contains an empty environment placeholder".to_string());
        }
        let replacement = env::var(name)
            .map_err(|_| format!("sick.ctiPath environment variable {name} is unavailable"))?;
        expanded.replace_range(start..=end, &replacement);
        cursor = start + replacement.len();
    }
    let path = PathBuf::from(expanded);
    if !path.is_absolute() {
        return Err("sick.ctiPath must be an absolute path".to_string());
    }
    Ok(path)
}

fn validate_regular_file_without_links(path: &Path, label: &str) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(format!("{label} must be an unambiguous absolute path"));
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|error| format!("{label} is unavailable ({}): {error}", ancestor.display()))?;
        #[cfg(windows)]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
            metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        };
        #[cfg(not(windows))]
        let linked = metadata.file_type().is_symlink();
        if linked {
            return Err(format!(
                "{label} path must not contain links or reparse points"
            ));
        }
        if ancestor == path && !metadata.file_type().is_file() {
            return Err(format!("{label} must be a regular file"));
        }
    }
    Ok(())
}

fn validate_simulation_source_directory(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if !path.is_dir() {
        return Err("simulation sourceRoot must exist and be a directory".to_string());
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|error| {
            format!(
                "simulation sourceRoot metadata is unavailable ({}): {error}",
                ancestor.display()
            )
        })?;
        #[cfg(windows)]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
            metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        };
        #[cfg(not(windows))]
        let linked = metadata.file_type().is_symlink();
        if linked {
            return Err(
                "simulation sourceRoot path must not contain links or reparse points".to_string(),
            );
        }
    }
    Ok(())
}

fn looks_like_windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/'))
        || value.starts_with("\\\\")
}

fn canonicalize_existing_prefix(path: &Path) -> PathBuf {
    if let Ok(canonical) = fs::canonicalize(path) {
        return canonical;
    }
    let mut cursor = path.to_path_buf();
    let mut suffix = Vec::new();
    loop {
        if let Ok(mut canonical) = fs::canonicalize(&cursor) {
            for component in suffix.iter().rev() {
                canonical.push(component);
            }
            return canonical;
        }
        let Some(component) = cursor.file_name().map(|value| value.to_os_string()) else {
            break;
        };
        suffix.push(component);
        if !cursor.pop() {
            break;
        }
    }
    path.to_path_buf()
}

fn resolved_isolation_path(value: &str, base: &Path) -> PathBuf {
    let path = Path::new(value.trim());
    if path.is_absolute() {
        canonicalize_existing_prefix(path)
    } else if looks_like_windows_absolute(value.trim()) {
        path.to_path_buf()
    } else {
        canonicalize_existing_prefix(&base.join(path))
    }
}

fn isolation_path_components(path: &Path) -> Vec<String> {
    let mut value = path.to_string_lossy().replace('\\', "/");
    if let Some(stripped) = value.strip_prefix("//?/") {
        value = stripped.to_string();
    }
    let case_insensitive =
        cfg!(windows) || looks_like_windows_absolute(&value) || value.starts_with("//");
    let mut components = Vec::new();
    for component in value.split('/') {
        match component {
            "" | "." => continue,
            ".." => {
                let _ = components.pop();
            }
            component => components.push(if case_insensitive {
                component.to_ascii_lowercase()
            } else {
                component.to_string()
            }),
        }
    }
    components
}

fn isolation_paths_overlap(left: &Path, right: &Path) -> bool {
    let left = isolation_path_components(left);
    let right = isolation_path_components(right);
    let prefix_matches = |shorter: &[String], longer: &[String]| {
        shorter.len() <= longer.len()
            && shorter
                .iter()
                .zip(longer.iter())
                .all(|(left, right)| left == right)
    };
    prefix_matches(&left, &right) || prefix_matches(&right, &left)
}

fn validate_simulation_path_isolation(
    profile: &RuntimeProfileDocument,
    capture_bytes: &[u8],
    allowed_root: &Path,
) -> Result<(), String> {
    if resolved_acquisition_mode(profile) != AcquisitionMode::Simulation {
        return Ok(());
    }
    let simulation = profile
        .simulation
        .as_ref()
        .ok_or_else(|| "simulation mode requires simulation settings".to_string())?;
    let source = resolved_isolation_path(&simulation.source_root, allowed_root);
    let capture: CaptureProfileDocument = serde_json::from_slice(capture_bytes)
        .map_err(|error| format!("capture profile JSON invalid: {error}"))?;
    let mut outputs = Vec::new();
    if !capture.storage_root.trim().is_empty() {
        outputs.push(("capture.storageRoot".to_string(), capture.storage_root));
    }
    outputs.extend(
        capture
            .cameras
            .into_iter()
            .filter(|camera| camera.enabled && !camera.storage_root.trim().is_empty())
            .map(|camera| {
                (
                    format!("capture camera {} storageRoot", camera.camera_index),
                    camera.storage_root,
                )
            }),
    );
    if !profile.algorithm.output_root.trim().is_empty() {
        outputs.push((
            "algorithm.outputRoot".to_string(),
            profile.algorithm.output_root.clone(),
        ));
    }
    for (label, value) in outputs {
        let output = resolved_isolation_path(&value, allowed_root);
        if isolation_paths_overlap(&source, &output) {
            return Err(format!("simulation sourceRoot must not overlap {label}"));
        }
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
        return path.file_name().is_some();
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
        >= 1
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

    fn install_valid_sick_hardware(fixture: &Fixture) -> PathBuf {
        let cti_path = fixture.root.join("vendor/SICKGigEVisionTL.cti");
        fs::create_dir_all(cti_path.parent().expect("CTI fixture parent"))
            .expect("CTI fixture directory");
        let cti_bytes = b"fixture SICK GenTL producer";
        fs::write(&cti_path, cti_bytes).expect("CTI fixture");
        let cti_hash = format!("{:x}", Sha256::digest(cti_bytes));
        let capture_path = fixture.root.join("capture/profiles/current/profile.json");
        let mut capture: Value =
            serde_json::from_slice(&fs::read(&capture_path).expect("capture profile fixture"))
                .expect("capture profile JSON");
        capture["driverMode"] = json!("sick-gentl");
        capture["sick"] = json!({
            "ctiPath": cti_path.display().to_string(),
            "ctiSha256": cti_hash,
        });
        write_json(&capture_path, &capture);
        cti_path
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

    fn direct_profile(acquisition_mode: &str) -> (Value, Value) {
        let simulation_root = std::env::temp_dir()
            .join(format!("steel-simulation-{}", std::process::id()))
            .join("recorded-dataset");
        fs::create_dir_all(&simulation_root).expect("simulation source fixture");
        let simulation_root = simulation_root.display().to_string();
        let mut profile = json!({
            "schema": "steel.runtime-profile.v1",
            "id": "direct-6",
            "displayName": "六相机直连",
            "acquisitionMode": acquisition_mode,
            "provider": "external-api",
            "dataSource": "online-production",
            "cameraConnection": "headless-cpp",
            "cameraCount": 6,
            "captureProfile": "capture/profiles/current/profile.json",
            "cameras": cameras(6),
            "storage": {},
            "capture": { "enabled": true, "autostart": true },
            "capabilities": {
                "directCamera": true,
                "captureManagement": true,
                "reconstruction": true,
                "offlineReplay": true
            }
        });
        if acquisition_mode == "simulation" {
            profile["simulation"] = json!({
                "sourceRoot": simulation_root,
                "speed": 1.0,
                "loop": true,
                "interSessionGapMs": 1500
            });
        }
        let capture = json!({
            "schema": "steel.capture.profile.v1",
            "expectedCameras": 6,
            "cameras": (1..=6).map(|camera| json!({
                "cameraIndex": camera,
                "enabled": true
            })).collect::<Vec<_>>()
        });
        (profile, capture)
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
        assert_eq!(loaded.acquisition_mode, AcquisitionMode::Offline);
        assert!(loaded.allows(RuntimeCapability::OfflineReplay));
    }

    #[test]
    fn offline_mode_preserves_physical_configuration_but_exposes_no_capture_capabilities() {
        let (profile, capture) = direct_profile("offline");
        let fixture = fixture(profile, Some(capture));

        let loaded = RuntimeProfile::load(&fixture.project, &fixture.root).expect("offline mode");

        assert_eq!(loaded.provider, "external-api");
        assert_eq!(loaded.camera_connection, "headless-cpp");
        assert!(loaded.capture.enabled);
        assert!(!loaded.allows(RuntimeCapability::DirectCamera));
        assert!(!loaded.allows(RuntimeCapability::CaptureManagement));
        assert!(!loaded.allows(RuntimeCapability::Reconstruction));
        assert_eq!(loaded.public_value()["acquisitionMode"], json!("offline"));
    }

    #[test]
    fn simulation_mode_keeps_external_provider_and_masks_only_physical_camera_capability() {
        let (profile, capture) = direct_profile("simulation");
        let fixture = fixture(profile, Some(capture));

        let loaded =
            RuntimeProfile::load(&fixture.project, &fixture.root).expect("simulation mode");

        assert_eq!(loaded.provider, "external-api");
        assert_eq!(loaded.camera_connection, "headless-cpp");
        assert!(!loaded.allows(RuntimeCapability::DirectCamera));
        assert!(loaded.allows(RuntimeCapability::CaptureManagement));
        assert!(loaded.allows(RuntimeCapability::Reconstruction));
        assert!(loaded.allows(RuntimeCapability::OfflineReplay));
        assert_eq!(loaded.public_value()["simulation"]["configured"], true);
        assert_eq!(
            loaded.public_value()["simulation"]["interSessionGapMs"],
            json!(1_500)
        );
        assert!(loaded.public_value().to_string().contains("\"speed\":1.0"));
        assert!(!loaded
            .public_value()
            .to_string()
            .contains("recorded-dataset"));
    }

    #[test]
    fn formal_simulation_rejects_non_six_channel_runtime_and_capture_topology() {
        let (mut profile, mut capture) = direct_profile("simulation");
        profile["cameraCount"] = json!(1);
        profile["cameras"] = json!([{
            "id": "C1",
            "displayOrder": 1,
            "sourceCameraId": 1,
            "role": "single-lab"
        }]);
        capture["expectedCameras"] = json!(1);
        capture["cameras"] = json!([{
            "cameraIndex": 1,
            "enabled": true
        }]);
        let fixture = fixture(profile, Some(capture));

        let error = RuntimeProfile::load(&fixture.project, &fixture.root)
            .expect_err("single-channel formal simulation must fail");
        assert!(error.contains("cameraCount=6"), "{error}");
    }

    #[test]
    fn offline_and_simulation_never_require_or_access_cti_hardware() {
        for mode in ["offline", "simulation"] {
            let (profile, mut capture) = direct_profile(mode);
            capture["driverMode"] = json!("not-a-camera-driver");
            capture["sick"] = json!({
                "ctiPath": "relative/missing/vendor.cti",
                "ctiSha256": "not-a-hash"
            });
            let fixture = fixture(profile, Some(capture));
            RuntimeProfile::load(&fixture.project, &fixture.root)
                .unwrap_or_else(|error| panic!("{mode} must not inspect CTI hardware: {error}"));
        }
    }

    #[test]
    fn online_startup_and_candidate_require_verified_sick_cti() {
        let (profile, capture) = direct_profile("online");
        let fixture = fixture(profile.clone(), Some(capture));
        let cti_path = install_valid_sick_hardware(&fixture);

        let mut loaded =
            RuntimeProfile::load(&fixture.project, &fixture.root).expect("verified online CTI");
        let candidate_project = fixture.root.join("config/project.json");
        write_json(
            &candidate_project,
            &json!({
                "schema": "steel.project-config.v1",
                "activeRuntimeProfile": "runtime-modes/active.json"
            }),
        );
        loaded.project_path = candidate_project;
        loaded
            .validate_candidate(&profile)
            .expect("verified online candidate");

        fs::write(&cti_path, b"tampered producer").expect("tamper CTI fixture");
        let startup_error = RuntimeProfile::load(&fixture.project, &fixture.root)
            .expect_err("startup must re-hash CTI");
        assert!(startup_error.contains("hash mismatch"), "{startup_error}");
        let candidate_error = loaded
            .validate_candidate(&profile)
            .expect_err("candidate must re-hash CTI");
        assert!(
            candidate_error.contains("hash mismatch"),
            "{candidate_error}"
        );
    }

    #[test]
    fn online_rejects_missing_driver_invalid_hash_and_non_file_cti() {
        let (profile, capture) = direct_profile("online");
        let fixture = fixture(profile, Some(capture));
        let cti_path = install_valid_sick_hardware(&fixture);
        let capture_path = fixture.root.join("capture/profiles/current/profile.json");
        let mut capture: Value =
            serde_json::from_slice(&fs::read(&capture_path).expect("capture profile"))
                .expect("capture JSON");

        capture["driverMode"] = json!("headless-cpp");
        write_json(&capture_path, &capture);
        let driver_error = RuntimeProfile::load(&fixture.project, &fixture.root)
            .expect_err("online driver mismatch");
        assert!(
            driver_error.contains("driverMode=sick-gentl"),
            "{driver_error}"
        );

        capture["driverMode"] = json!("sick-gentl");
        capture["sick"]["ctiSha256"] = json!("abc");
        write_json(&capture_path, &capture);
        let hash_error =
            RuntimeProfile::load(&fixture.project, &fixture.root).expect_err("online hash format");
        assert!(hash_error.contains("64-character"), "{hash_error}");

        capture["sick"]["ctiSha256"] = json!(format!(
            "{:x}",
            Sha256::digest(b"fixture SICK GenTL producer")
        ));
        fs::remove_file(&cti_path).expect("remove CTI fixture");
        fs::create_dir(&cti_path).expect("replace CTI with directory");
        write_json(&capture_path, &capture);
        let file_error = RuntimeProfile::load(&fixture.project, &fixture.root)
            .expect_err("CTI directory must fail");
        assert!(file_error.contains("regular file"), "{file_error}");
    }

    #[test]
    fn online_rejects_cti_path_links_or_reparse_points() {
        let (profile, capture) = direct_profile("online");
        let fixture = fixture(profile, Some(capture));
        let cti_path = install_valid_sick_hardware(&fixture);
        let linked_path = fixture.root.join("vendor/linked.cti");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&cti_path, &linked_path);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&cti_path, &linked_path);
        #[cfg(not(any(windows, unix)))]
        let linked: std::io::Result<()> = Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "file links unsupported",
        ));
        if linked.is_err() {
            return;
        }
        let capture_path = fixture.root.join("capture/profiles/current/profile.json");
        let mut capture: Value =
            serde_json::from_slice(&fs::read(&capture_path).expect("capture profile"))
                .expect("capture JSON");
        capture["sick"]["ctiPath"] = json!(linked_path.display().to_string());
        write_json(&capture_path, &capture);

        let error = RuntimeProfile::load(&fixture.project, &fixture.root)
            .expect_err("linked CTI must fail");
        assert!(error.contains("links or reparse points"), "{error}");
    }

    #[test]
    fn simulation_mode_rejects_missing_source_and_out_of_range_speed() {
        let (mut missing, capture) = direct_profile("simulation");
        missing["simulation"] = Value::Null;
        let missing_fixture = fixture(missing, Some(capture.clone()));
        assert!(RuntimeProfile::load(&missing_fixture.project, &missing_fixture.root).is_err());

        let (mut too_fast, _) = direct_profile("simulation");
        too_fast["simulation"]["speed"] = json!(4.01);
        let speed_fixture = fixture(too_fast, Some(capture));
        assert!(RuntimeProfile::load(&speed_fixture.project, &speed_fixture.root).is_err());

        let (mut short_gap, capture) = direct_profile("simulation");
        short_gap["simulation"]["interSessionGapMs"] = json!(1_000);
        let gap_fixture = fixture(short_gap, Some(capture));
        assert!(RuntimeProfile::load(&gap_fixture.project, &gap_fixture.root).is_err());

        let (mut missing_directory, capture) = direct_profile("simulation");
        missing_directory["simulation"]["sourceRoot"] = json!(std::env::temp_dir()
            .join(format!(
                "steel-simulation-missing-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("clock")
                    .as_nanos()
            ))
            .display()
            .to_string());
        let missing_directory_fixture = fixture(missing_directory, Some(capture));
        assert!(RuntimeProfile::load(
            &missing_directory_fixture.project,
            &missing_directory_fixture.root
        )
        .expect_err("missing simulation source directory")
        .contains("must exist"));
    }

    #[test]
    fn simulation_gap_defaults_above_departure_threshold_and_accepts_legacy_alias() {
        let (mut default_gap, capture) = direct_profile("simulation");
        default_gap["simulation"]
            .as_object_mut()
            .expect("simulation object")
            .remove("interSessionGapMs");
        let default_fixture = fixture(default_gap, Some(capture));
        let loaded = RuntimeProfile::load(&default_fixture.project, &default_fixture.root)
            .expect("default simulation gap");
        assert_eq!(loaded.simulation.unwrap().inter_session_gap_ms, 1_500);

        let (mut alias_gap, capture) = direct_profile("simulation");
        let simulation = alias_gap["simulation"]
            .as_object_mut()
            .expect("simulation object");
        simulation.remove("interSessionGapMs");
        simulation.insert("gapMs".to_string(), json!(2_000));
        let alias_fixture = fixture(alias_gap, Some(capture));
        let loaded = RuntimeProfile::load(&alias_fixture.project, &alias_fixture.root)
            .expect("legacy simulation gap alias");
        assert_eq!(
            loaded
                .simulation
                .as_ref()
                .expect("simulation settings")
                .inter_session_gap_ms,
            2_000
        );
    }

    #[test]
    fn simulation_source_rejects_capture_and_algorithm_output_overlap() {
        let (profile, mut capture) = direct_profile("simulation");
        let source = profile["simulation"]["sourceRoot"]
            .as_str()
            .expect("simulation source")
            .to_string();
        capture["storageRoot"] = json!(Path::new(&source)
            .parent()
            .expect("simulation source parent")
            .display()
            .to_string());
        let capture_fixture = fixture(profile, Some(capture));
        assert!(
            RuntimeProfile::load(&capture_fixture.project, &capture_fixture.root)
                .expect_err("capture parent overlap")
                .contains("capture.storageRoot")
        );

        let (profile, mut capture) = direct_profile("simulation");
        let source = profile["simulation"]["sourceRoot"]
            .as_str()
            .expect("simulation source")
            .to_string();
        capture["cameras"][0]["storageRoot"] =
            json!(Path::new(&source).join("writer").display().to_string());
        let camera_fixture = fixture(profile, Some(capture));
        assert!(
            RuntimeProfile::load(&camera_fixture.project, &camera_fixture.root)
                .expect_err("camera child overlap")
                .contains("capture camera 1 storageRoot")
        );

        let (mut profile, capture) = direct_profile("simulation");
        let source = profile["simulation"]["sourceRoot"]
            .as_str()
            .expect("simulation source")
            .to_string();
        profile["algorithm"] = json!({
            "enabled": false,
            "outputRoot": source
        });
        let algorithm_fixture = fixture(profile, Some(capture));
        assert!(
            RuntimeProfile::load(&algorithm_fixture.project, &algorithm_fixture.root)
                .expect_err("algorithm exact overlap")
                .contains("algorithm.outputRoot")
        );
    }

    #[test]
    fn simulation_source_overlap_resolves_existing_directory_links() {
        let base = std::env::temp_dir().join(format!(
            "steel-simulation-path-link-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let source = base.join("source");
        let alias = base.join("alias");
        fs::create_dir_all(&source).expect("simulation source directory");
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&source, &alias);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&source, &alias);
        #[cfg(not(any(windows, unix)))]
        let linked: std::io::Result<()> = Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "directory links unsupported",
        ));
        if linked.is_err() {
            fs::remove_dir_all(base).ok();
            return;
        }

        let (mut profile, mut capture) = direct_profile("simulation");
        profile["simulation"]["sourceRoot"] = json!(source.display().to_string());
        capture["storageRoot"] = json!(alias.join("writer").display().to_string());
        let linked_fixture = fixture(profile, Some(capture));
        assert!(
            RuntimeProfile::load(&linked_fixture.project, &linked_fixture.root)
                .expect_err("linked output overlap")
                .contains("capture.storageRoot")
        );

        let (mut linked_source_profile, capture) = direct_profile("simulation");
        linked_source_profile["simulation"]["sourceRoot"] = json!(alias.display().to_string());
        let linked_source_fixture = fixture(linked_source_profile, Some(capture));
        assert!(
            RuntimeProfile::load(&linked_source_fixture.project, &linked_source_fixture.root)
                .expect_err("linked simulation source")
                .contains("links or reparse points")
        );
        fs::remove_dir_all(base).expect("remove directory link fixture");
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
        install_valid_sick_hardware(&fixture);

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
    fn checked_in_project_uses_the_sick_six_camera_site_package() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .expect("workspace");

        let loaded = match RuntimeProfile::load(&workspace.join("config/project.json"), &workspace)
        {
            Ok(loaded) => loaded,
            Err(error) => {
                assert!(error.contains("sick.ctiPath"), "{error}");
                return;
            }
        };

        assert_eq!(loaded.site_id, "sick-array-6");
        assert_eq!(loaded.site_mode, SiteMode::DirectCamera);
        assert_eq!(loaded.camera_count(), 6);
        assert!(!loaded.site_deprecated);
        assert!(!loaded.site_compatibility);
    }

    #[test]
    fn recognizes_configured_windows_output_roots_on_every_host_platform() {
        assert!(is_absolute_non_volume_root(
            r"H:\steel-inspection-sample-50vol-20260831"
        ));
        assert!(!is_absolute_non_volume_root(r"H:\"));
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
