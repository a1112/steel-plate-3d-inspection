use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

const RUNTIME_SCHEMA: &str = "bkv-runtime-v1";
const CURSOR_SCHEMA: &str = "bkv-replay-cursor-v1";
const EXPECTED_FIRST_SEQUENCE: u64 = 1_893_700;
const EXPECTED_MATERIALS: usize = 11;
const EXPECTED_CAMERAS: usize = 6;

#[derive(Debug)]
pub struct BkvManager {
    root: PathBuf,
    manifest_path: PathBuf,
    cursor_path: PathBuf,
    batch_id: String,
    materials: Vec<Value>,
    files: HashMap<String, PathBuf>,
    cursor: Mutex<usize>,
}

impl BkvManager {
    pub fn load(root: &Path, manifest_path: &Path, cursor_path: &Path) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|error| format!("BKV data root is unavailable: {error}"))?;
        let manifest_path = contained_existing_file(&root, manifest_path, "manifest")?;
        let manifest: Value = serde_json::from_slice(
            &fs::read(&manifest_path)
                .map_err(|error| format!("BKV manifest read failed: {error}"))?,
        )
        .map_err(|error| format!("BKV manifest JSON invalid: {error}"))?;
        if manifest.get("schema").and_then(Value::as_str) != Some(RUNTIME_SCHEMA) {
            return Err("BKV manifest schema must be bkv-runtime-v1".to_string());
        }
        let batch_id = manifest
            .get("batchId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "BKV manifest batchId is missing".to_string())?
            .to_string();
        let materials = manifest
            .get("materials")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| "BKV manifest materials must be an array".to_string())?;
        if materials.len() != EXPECTED_MATERIALS
            || manifest.get("materialCount").and_then(Value::as_u64)
                != Some(EXPECTED_MATERIALS as u64)
        {
            return Err("BKV manifest must contain exactly 11 materials".to_string());
        }
        if manifest.get("cameraCount").and_then(Value::as_u64) != Some(EXPECTED_CAMERAS as u64) {
            return Err("BKV manifest must declare exactly 6 offline cameras".to_string());
        }

        let mut identities = HashSet::new();
        let mut files = HashMap::new();
        for (index, material) in materials.iter().enumerate() {
            let sequence = material
                .get("legacySeqNo")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("BKV material {index} has no legacySeqNo"))?;
            let expected = EXPECTED_FIRST_SEQUENCE + index as u64;
            if sequence != expected || !identities.insert(sequence) {
                return Err(format!(
                    "BKV material sequence coverage mismatch at {sequence}"
                ));
            }
            validate_cameras(material, sequence)?;
            collect_artifacts(&root, material, &mut files)?;
            for required in ["unwrapped", "cylinder", "summary"] {
                if material
                    .pointer(&format!("/artifacts/{required}/path"))
                    .and_then(Value::as_str)
                    .is_none()
                {
                    return Err(format!(
                        "BKV material {sequence} is missing {required} preview"
                    ));
                }
            }
        }

        let cursor_path = prepare_contained_cursor_path(&root, cursor_path)?;
        let cursor = load_cursor(&cursor_path, &batch_id, materials.len())?;
        Ok(Self {
            root,
            manifest_path,
            cursor_path,
            batch_id,
            materials,
            files,
            cursor: Mutex::new(cursor),
        })
    }

    pub fn status(&self) -> Value {
        let next_index = self
            .cursor
            .lock()
            .map(|value| *value)
            .unwrap_or(self.materials.len());
        json!({
            "provider": "bkv",
            "ready": true,
            "mode": "offline-replay-no-camera-hardware",
            "cameraMode": "offline-file",
            "cameraCount": EXPECTED_CAMERAS,
            "physicalCamerasOnline": 0,
            "batchId": self.batch_id,
            "materialCount": self.materials.len(),
            "nextIndex": next_index,
            "nextLegacySeqNo": self.materials.get(next_index).and_then(|item| item.get("legacySeqNo")).cloned(),
            "completed": next_index >= self.materials.len(),
            "manifestPath": self.manifest_path.display().to_string(),
            "dataRoot": self.root.display().to_string(),
        })
    }

    pub fn materials(&self) -> Value {
        Value::Array(self.materials.clone())
    }

    pub fn material(&self, legacy_sequence: u64) -> Option<Value> {
        self.materials
            .iter()
            .find(|item| item.get("legacySeqNo").and_then(Value::as_u64) == Some(legacy_sequence))
            .cloned()
    }

    pub fn resolve_artifact(&self, relative: &str) -> Result<PathBuf, String> {
        let normalized = normalize_relative(relative)?;
        self.files
            .get(&normalized)
            .cloned()
            .ok_or_else(|| "BKV artifact is not present in the manifest whitelist".to_string())
    }

    pub fn capture_next(&self) -> Result<Option<Value>, String> {
        let mut cursor = self
            .cursor
            .lock()
            .map_err(|_| "BKV cursor lock poisoned".to_string())?;
        let Some(material) = self.materials.get(*cursor).cloned() else {
            return Ok(None);
        };
        let legacy_sequence = material
            .get("legacySeqNo")
            .and_then(Value::as_u64)
            .ok_or_else(|| "BKV replay material identity is missing".to_string())?;
        let cameras = material
            .get("cameras")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .cloned()
                    .map(|mut camera| {
                        if let Some(object) = camera.as_object_mut() {
                            object.insert("online".to_string(), json!(false));
                            object.insert("connected".to_string(), json!(false));
                            object.insert("source".to_string(), json!("legacy-file"));
                        }
                        camera
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let summary = json!({
            "schema": "steel.capture.bkv-offline.summary.v1",
            "code": 0,
            "provider": "bkv",
            "mode": "offline-replay-no-camera-hardware",
            "legacySeqNo": legacy_sequence,
            "legacyCheckRecordSeqNo": material.get("legacyCheckRecordSeqNo").cloned().unwrap_or(Value::Null),
            "materialId": material.get("steelId").cloned().unwrap_or_else(|| json!(legacy_sequence.to_string())),
            "sessionId": format!("bkv-legacy-{legacy_sequence}"),
            "cameraCount": EXPECTED_CAMERAS,
            "physicalCamerasOnline": 0,
            "cameras": cameras,
            "artifacts": material.get("artifacts").cloned().unwrap_or_else(|| json!({})),
            "defects": material.get("defects").cloned().unwrap_or_else(|| json!([])),
            "material": material,
        });
        let capture_path = self
            .root
            .join("runtime-state")
            .join("captures")
            .join(format!("{legacy_sequence}.json"));
        persist_json(&capture_path, &summary, "capture summary")?;
        let next = cursor.saturating_add(1);
        persist_cursor(&self.cursor_path, &self.batch_id, next)?;
        *cursor = next;
        Ok(Some(summary))
    }

    pub fn reset(&self) -> Result<(), String> {
        let mut cursor = self
            .cursor
            .lock()
            .map_err(|_| "BKV cursor lock poisoned".to_string())?;
        persist_cursor(&self.cursor_path, &self.batch_id, 0)?;
        *cursor = 0;
        Ok(())
    }
}

fn validate_cameras(material: &Value, sequence: u64) -> Result<(), String> {
    let cameras = material
        .get("cameras")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("BKV material {sequence} cameras must be an array"))?;
    if cameras.len() != EXPECTED_CAMERAS {
        return Err(format!(
            "BKV material {sequence} must have exactly 6 cameras"
        ));
    }
    for (index, camera) in cameras.iter().enumerate() {
        let expected_id = (index + 1) as u64;
        if camera.get("cameraId").and_then(Value::as_u64) != Some(expected_id)
            || camera.get("mode").and_then(Value::as_str) != Some("offline-file")
        {
            return Err(format!(
                "BKV material {sequence} camera {} contract invalid",
                index + 1
            ));
        }
        let images = camera
            .get("twoDFrames")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                format!("BKV material {sequence} camera {expected_id} has no 2D frames")
            })?;
        let depths = camera
            .get("npzFrames")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                format!("BKV material {sequence} camera {expected_id} has no NPZ frames")
            })?;
        if images.is_empty()
            || depths.is_empty()
            || camera.get("twoDFrameCount").and_then(Value::as_u64) != Some(images.len() as u64)
            || camera.get("npzFrameCount").and_then(Value::as_u64) != Some(depths.len() as u64)
        {
            return Err(format!(
                "BKV material {sequence} camera {expected_id} frame coverage invalid"
            ));
        }
    }
    Ok(())
}

fn collect_artifacts(
    root: &Path,
    value: &Value,
    files: &mut HashMap<String, PathBuf>,
) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            if let Some(relative) = object.get("path").and_then(Value::as_str) {
                let declared_size = object
                    .get("size")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| format!("BKV artifact {relative} has no size"))?;
                let declared_hash = object
                    .get("sha256")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("BKV artifact {relative} has no sha256"))?;
                if declared_hash.len() != 64
                    || !declared_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err(format!("BKV artifact {relative} sha256 is invalid"));
                }
                let normalized = normalize_relative(relative)?;
                let path =
                    contained_existing_file(root, &root.join(Path::new(&normalized)), "artifact")?;
                let metadata = fs::metadata(&path)
                    .map_err(|error| format!("BKV artifact metadata failed: {error}"))?;
                if metadata.len() != declared_size {
                    return Err(format!("BKV artifact size mismatch: {relative}"));
                }
                let actual_hash = sha256_file(&path)?;
                if !actual_hash.eq_ignore_ascii_case(declared_hash) {
                    return Err(format!("BKV artifact hash mismatch: {relative}"));
                }
                if files.insert(normalized, path).is_some() {
                    return Err(format!("duplicate BKV artifact path: {relative}"));
                }
                return Ok(());
            }
            for child in object.values() {
                collect_artifacts(root, child, files)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_artifacts(root, item, files)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn normalize_relative(value: &str) -> Result<String, String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("BKV artifact path escapes data root: {value}"));
    }
    if value.is_empty() {
        return Err("BKV artifact path is empty".to_string());
    }
    Ok(path
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn contained_existing_file(root: &Path, path: &Path, label: &str) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("BKV {label} is unavailable: {error}"))?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err(format!(
            "BKV {label} path escapes data root: {}",
            path.display()
        ));
    }
    Ok(canonical)
}

fn prepare_contained_cursor_path(root: &Path, cursor_path: &Path) -> Result<PathBuf, String> {
    let parent = cursor_path
        .parent()
        .ok_or_else(|| "BKV cursor has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("BKV cursor directory create failed: {error}"))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("BKV cursor directory unavailable: {error}"))?;
    if !canonical_parent.starts_with(root) {
        return Err(format!(
            "BKV cursor path escapes data root: {}",
            cursor_path.display()
        ));
    }
    let name = cursor_path
        .file_name()
        .ok_or_else(|| "BKV cursor filename is missing".to_string())?;
    Ok(canonical_parent.join(name))
}

fn load_cursor(path: &Path, batch_id: &str, material_count: usize) -> Result<usize, String> {
    if !path.exists() {
        return Ok(0);
    }
    let value: Value = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("BKV cursor read failed: {error}"))?,
    )
    .map_err(|error| format!("BKV cursor JSON invalid: {error}"))?;
    if value.get("schema").and_then(Value::as_str) != Some(CURSOR_SCHEMA)
        || value.get("batchId").and_then(Value::as_str) != Some(batch_id)
    {
        return Err("BKV cursor schema or batch does not match manifest".to_string());
    }
    let next = value
        .get("nextIndex")
        .and_then(Value::as_u64)
        .ok_or_else(|| "BKV cursor nextIndex is invalid".to_string())? as usize;
    if next > material_count {
        return Err("BKV cursor nextIndex exceeds material count".to_string());
    }
    Ok(next)
}

fn persist_cursor(path: &Path, batch_id: &str, next: usize) -> Result<(), String> {
    persist_json(
        path,
        &json!({"schema": CURSOR_SCHEMA, "batchId": batch_id, "nextIndex": next}),
        "cursor",
    )
}

fn persist_json(path: &Path, value: &Value, label: &str) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("BKV {label} serialize failed: {error}"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("BKV {label} directory create failed: {error}"))?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("BKV {label} temp create failed: {error}"))?;
        file.write_all(&payload)
            .map_err(|error| format!("BKV {label} write failed: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("BKV {label} sync failed: {error}"))?;
        atomic_replace(&temporary, path)
            .map_err(|error| format!("BKV {label} replace failed: {error}"))
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("BKV artifact open failed: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("BKV artifact read failed: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::BkvManager;
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("steel-bkv-{name}-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn artifact(root: &Path, relative: &str, contents: &[u8]) -> Value {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        let hash = format!("{:x}", Sha256::digest(contents));
        json!({"path": relative.replace('\\', "/"), "size": contents.len(), "sha256": hash})
    }

    fn fixture(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = temp_root(name);
        let mut materials = Vec::new();
        for offset in 0..11 {
            let legacy = 1_893_700 + offset;
            let mut cameras = Vec::new();
            for camera in 1..=6 {
                let jpg = artifact(&root, &format!("images/{legacy}/{camera}/0000.jpg"), b"jpg");
                let npz = artifact(&root, &format!("npz/{legacy}/{camera}/0000.npz"), b"npz");
                cameras.push(json!({
                    "cameraId": camera, "mode": "offline-file", "twoDFrameCount": 1,
                    "npzFrameCount": 1,
                    "twoDFrames": [{"frameNo": 0, "path": jpg["path"], "size": jpg["size"], "sha256": jpg["sha256"]}],
                    "npzFrames": [{"frameNo": 0, "path": npz["path"], "size": npz["size"], "sha256": npz["sha256"]}]
                }));
            }
            materials.push(json!({
                "legacySeqNo": legacy,
                "legacyCheckRecordSeqNo": 1_451_214 + offset,
                "steelId": format!("STEEL-{offset}"),
                "steelType": "37Mn/2",
                "lengthMm": 12096.0,
                "wallThicknessMm": null,
                "defects": [],
                "cameras": cameras,
                "artifacts": {
                    "unwrapped": artifact(&root, &format!("preview/{legacy}/unwrapped.png"), b"png"),
                    "cylinder": artifact(&root, &format!("preview/{legacy}/cylinder.json"), b"{}"),
                    "summary": artifact(&root, &format!("preview/{legacy}/summary.json"), b"{}")
                }
            }));
        }
        let manifest = json!({
            "schema": "bkv-runtime-v1", "batchId": "legacy-1893700-1893710",
            "cameraCount": 6, "materialCount": 11, "materials": materials
        });
        let manifest_path = root.join("bkv-runtime-manifest.json");
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let cursor_path = root.join("runtime-state/replay.json");
        (root, manifest_path, cursor_path)
    }

    #[test]
    fn loads_exact_batch_and_exposes_ready_status() {
        let (root, manifest, cursor) = fixture("load");
        let manager = BkvManager::load(&root, &manifest, &cursor).unwrap();
        assert_eq!(manager.materials().as_array().unwrap().len(), 11);
        assert_eq!(
            manager.material(1_893_703).unwrap()["legacySeqNo"],
            1_893_703
        );
        let status = manager.status();
        assert_eq!(status["provider"], "bkv");
        assert_eq!(status["ready"], true);
        assert_eq!(status["cameraMode"], "offline-file");
        assert_eq!(status["cameraCount"], 6);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replay_cursor_is_sequential_durable_completed_and_resettable() {
        let (root, manifest, cursor) = fixture("cursor");
        let manager = BkvManager::load(&root, &manifest, &cursor).unwrap();
        for expected in 1_893_700..=1_893_710 {
            assert_eq!(
                manager.capture_next().unwrap().unwrap()["legacySeqNo"],
                expected
            );
        }
        assert!(manager.capture_next().unwrap().is_none());
        assert_eq!(manager.status()["completed"], true);
        drop(manager);
        let reloaded = BkvManager::load(&root, &manifest, &cursor).unwrap();
        assert_eq!(reloaded.status()["nextIndex"], 11);
        reloaded.reset().unwrap();
        assert_eq!(
            reloaded.capture_next().unwrap().unwrap()["legacySeqNo"],
            1_893_700
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn capture_next_writes_six_camera_offline_summary_before_advancing() {
        let (root, manifest, cursor) = fixture("capture");
        let manager = BkvManager::load(&root, &manifest, &cursor).unwrap();
        let summary = manager.capture_next().unwrap().unwrap();
        assert_eq!(summary["schema"], "steel.capture.bkv-offline.summary.v1");
        assert_eq!(summary["provider"], "bkv");
        assert_eq!(summary["legacySeqNo"], 1_893_700);
        assert_eq!(summary["cameras"].as_array().unwrap().len(), 6);
        assert!(summary["cameras"]
            .as_array()
            .unwrap()
            .iter()
            .all(|camera| { camera["mode"] == "offline-file" && camera["online"] == false }));
        assert!(summary["artifacts"]["unwrapped"]["path"].is_string());
        let persisted = root.join("runtime-state/captures/1893700.json");
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(persisted).unwrap()).unwrap(),
            summary
        );
        assert_eq!(manager.status()["nextIndex"], 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_manifest_whitelisted_files_can_be_resolved() {
        let (root, manifest, cursor) = fixture("files");
        fs::write(root.join("secret.txt"), b"secret").unwrap();
        let manager = BkvManager::load(&root, &manifest, &cursor).unwrap();
        let allowed = manager
            .resolve_artifact("images/1893700/1/0000.jpg")
            .unwrap();
        assert!(allowed.ends_with("0000.jpg"));
        assert!(manager.resolve_artifact("secret.txt").is_err());
        assert!(manager.resolve_artifact("../secret.txt").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_wrong_cardinality_hash_and_path_escape() {
        let (root, manifest, cursor) = fixture("reject");
        let mut value: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        value["materialCount"] = json!(10);
        fs::write(&manifest, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        assert!(BkvManager::load(&root, &manifest, &cursor)
            .unwrap_err()
            .contains("11 materials"));

        let (root2, manifest2, cursor2) = fixture("hash");
        fs::write(root2.join("images/1893700/1/0000.jpg"), b"bad").unwrap();
        assert!(BkvManager::load(&root2, &manifest2, &cursor2)
            .unwrap_err()
            .contains("hash mismatch"));

        let (root3, manifest3, cursor3) = fixture("escape");
        let mut escaped: Value = serde_json::from_slice(&fs::read(&manifest3).unwrap()).unwrap();
        escaped["materials"][0]["cameras"][0]["twoDFrames"][0]["path"] = json!("../outside.jpg");
        fs::write(&manifest3, serde_json::to_vec_pretty(&escaped).unwrap()).unwrap();
        assert!(BkvManager::load(&root3, &manifest3, &cursor3)
            .unwrap_err()
            .contains("escapes"));
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(root2).unwrap();
        fs::remove_dir_all(root3).unwrap();
    }
}
