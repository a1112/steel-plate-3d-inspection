use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

const PROJECT_SCHEMA: &str = "steel.project-config.v1";
const RUNTIME_PROFILE_SCHEMA: &str = "steel.runtime-profile.v1";
const CAPTURE_PROFILE_SCHEMA: &str = "steel.capture.profile.v1";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectConfig {
    schema: String,
    active_runtime_profile: String,
}

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

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStorage {
    #[serde(default)]
    pub source_root: String,
    #[serde(default)]
    pub converted_root: String,
    #[serde(default)]
    pub catalog_path: String,
    #[serde(default)]
    pub converter_origin: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCapabilities {
    pub direct_camera: bool,
    pub capture_management: bool,
    pub reconstruction: bool,
    pub offline_replay: bool,
}

#[derive(Clone, Debug)]
pub struct RuntimeProfile {
    pub id: String,
    pub display_name: String,
    pub provider: String,
    pub data_source: String,
    pub camera_connection: String,
    pub cameras: Vec<RuntimeCamera>,
    pub storage: RuntimeStorage,
    pub capabilities: RuntimeCapabilities,
    pub capture_profile: Option<String>,
    pub config_hash: String,
    pub project_path: PathBuf,
    pub profile_path: PathBuf,
}

impl RuntimeProfile {
    pub fn load(project_path: &Path, allowed_root: &Path) -> Result<Self, String> {
        let allowed_root = fs::canonicalize(allowed_root).map_err(|error| {
            format!(
                "runtime profile allowed root is unavailable ({}): {error}",
                allowed_root.display()
            )
        })?;
        let project_path = contained_existing_file(&allowed_root, project_path, "project config")?;
        let project_bytes = fs::read(&project_path)
            .map_err(|error| format!("project config read failed: {error}"))?;
        let project: ProjectConfig = serde_json::from_slice(&project_bytes)
            .map_err(|error| format!("project config JSON invalid: {error}"))?;
        if project.schema != PROJECT_SCHEMA {
            return Err(format!("project config schema must be {PROJECT_SCHEMA}"));
        }

        let profile_path =
            contained_existing_file(&allowed_root, &project.active_runtime_profile, "runtime profile")?;
        let profile_bytes = fs::read(&profile_path)
            .map_err(|error| format!("runtime profile read failed: {error}"))?;
        let document: RuntimeProfileDocument = serde_json::from_slice(&profile_bytes)
            .map_err(|error| format!("runtime profile JSON invalid: {error}"))?;
        validate_profile(&document, &allowed_root)?;

        let mut hasher = Sha256::new();
        hasher.update(&project_bytes);
        hasher.update([0]);
        hasher.update(&profile_bytes);

        if let Some(relative) = document.capture_profile.as_deref() {
            let capture_path = contained_existing_file(&allowed_root, relative, "capture profile")?;
            let capture_bytes = fs::read(&capture_path)
                .map_err(|error| format!("capture profile read failed: {error}"))?;
            validate_capture_profile(&document, &capture_bytes)?;
            hasher.update([0]);
            hasher.update(capture_bytes);
        } else if document.camera_connection == "headless-cpp" {
            return Err("direct runtime profile requires captureProfile".to_string());
        }

        Ok(Self {
            id: document.id,
            display_name: document.display_name,
            provider: document.provider,
            data_source: document.data_source,
            camera_connection: document.camera_connection,
            cameras: document.cameras,
            storage: document.storage,
            capabilities: document.capabilities,
            capture_profile: document.capture_profile,
            config_hash: format!("{:x}", hasher.finalize()),
            project_path,
            profile_path,
        })
    }

    pub fn camera_count(&self) -> usize {
        self.cameras.len()
    }

    #[cfg(test)]
    pub fn test_profile(provider: &str, camera_count: usize) -> Self {
        let direct = provider != "bkv";
        Self {
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

fn validate_profile(
    document: &RuntimeProfileDocument,
    allowed_root: &Path,
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
        }
        "headless-cpp" => {
            if !document.capabilities.direct_camera
                || !document.capabilities.capture_management
            {
                return Err(
                    "headless-cpp runtime profile requires direct camera capabilities".to_string(),
                );
            }
        }
        other => return Err(format!("unsupported cameraConnection: {other}")),
    }

    for (value, label) in [
        (&document.storage.source_root, "storage sourceRoot"),
        (&document.storage.converted_root, "storage convertedRoot"),
        (&document.storage.catalog_path, "storage catalogPath"),
    ] {
        if !value.trim().is_empty() {
            validate_relative_path(value, label)?;
            let resolved = allowed_root.join(value);
            if !resolved.starts_with(allowed_root) {
                return Err(format!("{label} escapes allowed root"));
            }
        }
    }
    if document.data_source == "converted-local"
        && (document.storage.source_root.trim().is_empty()
            || document.storage.converted_root.trim().is_empty()
            || document.storage.catalog_path.trim().is_empty())
    {
        return Err("converted-local profile requires source, converted, and catalog paths".into());
    }
    Ok(())
}

fn validate_capture_profile(
    profile: &RuntimeProfileDocument,
    bytes: &[u8],
) -> Result<(), String> {
    let capture: CaptureProfileDocument = serde_json::from_slice(bytes)
        .map_err(|error| format!("capture profile JSON invalid: {error}"))?;
    if capture.schema != CAPTURE_PROFILE_SCHEMA {
        return Err(format!(
            "capture profile schema must be {CAPTURE_PROFILE_SCHEMA}"
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
        fs::write(path, serde_json::to_vec_pretty(value).expect("fixture JSON"))
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
                "sourceRoot": "source",
                "convertedRoot": "converted",
                "catalogPath": "converted/catalog.db"
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

        let loaded =
            RuntimeProfile::load(&fixture.project, &fixture.root).expect("direct profile");

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
}
