use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SITE_CONFIG_SCHEMA: &str = "steel.site-config.v1";

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

#[derive(Clone, Debug)]
pub struct SiteConfigStore {
    root: PathBuf,
}

impl SiteConfigStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root)
            .map_err(|error| format!("site config root create failed: {error}"))?;
        let root = fs::canonicalize(&root)
            .map_err(|error| format!("site config root unavailable: {error}"))?;
        Ok(Self { root })
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
        "dataSource": if mode == &SiteMode::Bkv { "converted-local" } else { "online-production" },
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
    use super::{CreateSiteConfig, SiteConfigStore, SiteMode, UpdateSiteMetadata};
    use std::fs;
    use std::path::PathBuf;
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
}
