use crate::inspection_world::{
    compose_tile, CameraOrientation, CameraSpec, InspectionWorld, PixelRect, TileRequest,
    WorldError,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

const RUNTIME_SCHEMA: &str = "bkv-runtime-v1";
const CURSOR_SCHEMA: &str = "bkv-replay-cursor-v1";
const EXPECTED_FIRST_SEQUENCE: u64 = 1_893_700;
const EXPECTED_MATERIALS: usize = 11;
const EXPECTED_CAMERAS: usize = 6;
const TILE_CACHE_CAPACITY: usize = 64;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct TileCacheKey {
    legacy_sequence: u64,
    request: TileRequest,
}

#[derive(Debug, Default)]
struct TileCache {
    entries: HashMap<TileCacheKey, Vec<u8>>,
    order: VecDeque<TileCacheKey>,
}

impl TileCache {
    fn get(&self, key: &TileCacheKey) -> Option<Vec<u8>> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: TileCacheKey, bytes: Vec<u8>) {
        if self.entries.contains_key(&key) {
            self.entries.insert(key, bytes);
            return;
        }
        while self.entries.len() >= TILE_CACHE_CAPACITY {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            } else {
                break;
            }
        }
        self.order.push_back(key);
        self.entries.insert(key, bytes);
    }
}

#[derive(Debug)]
pub struct BkvManager {
    root: PathBuf,
    cursor_path: PathBuf,
    batch_id: String,
    materials: Vec<Value>,
    files: HashMap<String, PathBuf>,
    cursor: Mutex<usize>,
    tile_cache: Mutex<TileCache>,
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
            cursor_path,
            batch_id,
            materials,
            files,
            cursor: Mutex::new(cursor),
            tile_cache: Mutex::new(TileCache::default()),
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

    pub fn inspection_tile(
        &self,
        legacy_sequence: u64,
        request: TileRequest,
    ) -> Result<Vec<u8>, String> {
        let key = TileCacheKey {
            legacy_sequence,
            request,
        };
        if let Some(bytes) = self
            .tile_cache
            .lock()
            .map_err(|_| "BKV tile cache lock poisoned".to_string())?
            .get(&key)
        {
            return Ok(bytes);
        }

        let material = self.material_ref(legacy_sequence)?;
        let (world, sources) = build_inspection_world(material)?;
        let bytes = compose_tile(&world, request, |camera_id, frame_number| {
            let relative = sources.get(&(camera_id, frame_number)).ok_or_else(|| {
                WorldError::Artifact(format!(
                    "camera {camera_id} frame {frame_number} is not in the manifest"
                ))
            })?;
            self.resolve_artifact(relative)
                .map(Some)
                .map_err(WorldError::Artifact)
        })
        .map_err(|error| error.to_string())?;
        self.tile_cache
            .lock()
            .map_err(|_| "BKV tile cache lock poisoned".to_string())?
            .insert(key, bytes.clone());
        Ok(bytes)
    }

    pub fn inspection_world_records(&self) -> Value {
        let records = self
            .materials
            .iter()
            .map(|material| {
                let sequence = material.get("legacySeqNo").cloned().unwrap_or(Value::Null);
                json!({
                    "recordId": sequence.as_u64().map(|value| value.to_string()),
                    "legacySeqNo": sequence,
                    "steelId": material.get("steelId").cloned().unwrap_or(Value::Null),
                    "steelType": material.get("steelType").cloned().unwrap_or(Value::Null),
                    "lengthMm": material.get("lengthMm").cloned().unwrap_or(Value::Null),
                    "inspectionTime": material.get("inspectionTime").cloned().unwrap_or(Value::Null),
                    "defectCount": material.get("defects").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
                })
            })
            .collect::<Vec<_>>();
        json!({
            "schema": "steel.inspection-world.records.v1",
            "provider": "bkv",
            "records": records,
        })
    }

    pub fn inspection_world_meta(&self, legacy_sequence: u64) -> Result<Value, String> {
        let material = self.material_ref(legacy_sequence)?;
        let (world, _) = build_inspection_world(material)?;
        let source_frame_count = world
            .cameras
            .iter()
            .map(|camera| camera.frame_numbers.len())
            .sum::<usize>();
        Ok(json!({
            "schema": "steel.inspection-world.meta.v1",
            "provider": "bkv",
            "recordId": legacy_sequence.to_string(),
            "legacySeqNo": legacy_sequence,
            "sourceFrameCount": source_frame_count,
            "world": world,
        }))
    }

    pub fn inspection_world_defects(&self, legacy_sequence: u64) -> Result<Value, String> {
        let material = self.material_ref(legacy_sequence)?;
        let (world, _) = build_inspection_world(material)?;
        let defects = material
            .get("defects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|defect| {
                let camera_id = defect
                    .get("cameraId")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok());
                let image_index = defect
                    .get("imageIndex")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok());
                let image_rect = defect.get("imageRect2d");
                let local = image_rect.and_then(|rect| {
                    Some(
                        PixelRect::from_edges(
                            json_u32(rect, "left", "defect rectangle").ok()?,
                            json_u32(rect, "right", "defect rectangle").ok()?,
                            json_u32(rect, "top", "defect rectangle").ok()?,
                            json_u32(rect, "bottom", "defect rectangle").ok()?,
                        )
                        .ok()?,
                    )
                });
                let world_rect = camera_id
                    .zip(image_index)
                    .zip(local)
                    .and_then(|((camera, frame), rect)| world.map_defect(camera, frame, rect).ok());
                json!({
                    "id": defect.get("legacyDefectId").cloned().unwrap_or(Value::Null),
                    "className": defect.get("className").cloned().unwrap_or(Value::Null),
                    "grade": defect.get("grade").cloned().unwrap_or(Value::Null),
                    "confidence": defect.get("confidence").cloned().unwrap_or(Value::Null),
                    "cameraId": camera_id,
                    "imageIndex": image_index,
                    "locatable": world_rect.is_some(),
                    "worldRect": world_rect,
                    "trace": {
                        "imageRect2d": image_rect.cloned().unwrap_or(Value::Null),
                        "steelRect2d": defect.get("steelRect2d").cloned().unwrap_or(Value::Null),
                    }
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "schema": "steel.inspection-world.defects.v1",
            "provider": "bkv",
            "recordId": legacy_sequence.to_string(),
            "defects": defects,
        }))
    }

    fn material_ref(&self, legacy_sequence: u64) -> Result<&Value, String> {
        self.materials
            .iter()
            .find(|item| item.get("legacySeqNo").and_then(Value::as_u64) == Some(legacy_sequence))
            .ok_or_else(|| format!("BKV material {legacy_sequence} is unavailable"))
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
    let mut buffer = vec![0_u8; 1024 * 1024];
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
    use crate::inspection_world::{TileFormat, TileRequest};
    use image::{codecs::jpeg::JpegEncoder, Rgb, RgbImage};
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

    fn jpeg_bytes(color: [u8; 3]) -> Vec<u8> {
        let image = RgbImage::from_pixel(2, 2, Rgb(color));
        let mut bytes = Vec::new();
        JpegEncoder::new_with_quality(&mut bytes, 95)
            .encode_image(&image)
            .unwrap();
        bytes
    }

    fn fixture(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = temp_root(name);
        let mut materials = Vec::new();
        for offset in 0..11 {
            let legacy = 1_893_700 + offset;
            let mut cameras = Vec::new();
            for camera in 1..=6 {
                let jpg_bytes = jpeg_bytes([camera as u8 * 20, 10, 5]);
                let jpg = artifact(
                    &root,
                    &format!("images/{legacy}/{camera}/0000.jpg"),
                    &jpg_bytes,
                );
                let npz = artifact(&root, &format!("npz/{legacy}/{camera}/0000.npz"), b"npz");
                cameras.push(json!({
                    "cameraId": camera, "mode": "offline-file",
                    "frameWidth": 2, "frameHeight": 2,
                    "orientation": {"frameOrder": "ascending", "rotation": 0, "flipX": false, "flipY": false},
                    "twoDFrameCount": 1,
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
                "defects": if offset == 0 { json!([{
                    "legacyDefectId": 2019096,
                    "cameraId": 1,
                    "imageIndex": 0,
                    "className": "轧折",
                    "grade": 16,
                    "confidence": 51,
                    "imageRect2d": {"left": 0, "right": 1, "top": 0, "bottom": 1},
                    "steelRect2d": {"left": 100, "right": 101, "top": 200, "bottom": 201}
                }]) } else { json!([]) },
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
    fn manifest_hash_validation_does_not_consume_the_thread_stack() {
        let (root, manifest, cursor) = fixture("small-stack");
        let worker_root = root.clone();
        let worker = std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(move || {
                BkvManager::load(&worker_root, &manifest, &cursor).map(|manager| manager.status())
            })
            .unwrap();
        assert_eq!(worker.join().unwrap().unwrap()["ready"], true);
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
    fn inspection_tile_uses_manifest_sources_and_bounded_cache() {
        let (root, manifest, cursor) = fixture("tile-cache");
        let manager = BkvManager::load(&root, &manifest, &cursor).unwrap();
        let request = TileRequest::new(0, 0, 0, TileFormat::Jpeg);

        let first = manager.inspection_tile(1_893_700, request).unwrap();
        let decoded = image::load_from_memory(&first).unwrap();
        assert_eq!(decoded.width(), 12);
        assert_eq!(decoded.height(), 2);

        fs::write(
            root.join("images/1893700/1/0000.jpg"),
            b"corrupt after cache fill",
        )
        .unwrap();
        let cached = manager.inspection_tile(1_893_700, request).unwrap();
        assert_eq!(cached, first);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inspection_tile_rejects_unsupported_manifest_orientation() {
        let (root, manifest, cursor) = fixture("tile-orientation");
        let mut value: Value = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        value["materials"][0]["cameras"][0]["orientation"]["rotation"] = json!(90);
        fs::write(&manifest, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        let manager = BkvManager::load(&root, &manifest, &cursor).unwrap();

        let error = manager
            .inspection_tile(1_893_700, TileRequest::new(0, 0, 0, TileFormat::Png))
            .unwrap_err();
        assert!(error.contains("UnsupportedOrientation"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exposes_unified_world_metadata_and_defect_coordinates() {
        let (root, manifest, cursor) = fixture("world-contract");
        let manager = BkvManager::load(&root, &manifest, &cursor).unwrap();

        let records = manager.inspection_world_records();
        assert_eq!(records["schema"], "steel.inspection-world.records.v1");
        assert_eq!(records["provider"], "bkv");
        assert_eq!(records["records"].as_array().unwrap().len(), 11);

        let meta = manager.inspection_world_meta(1_893_700).unwrap();
        assert_eq!(meta["schema"], "steel.inspection-world.meta.v1");
        assert_eq!(meta["world"]["width"], 12);
        assert_eq!(meta["world"]["height"], 2);
        assert_eq!(meta["sourceFrameCount"], 6);
        assert_eq!(meta["world"]["cameras"].as_array().unwrap().len(), 6);

        let defects = manager.inspection_world_defects(1_893_700).unwrap();
        assert_eq!(defects["schema"], "steel.inspection-world.defects.v1");
        assert_eq!(defects["defects"][0]["locatable"], true);
        assert_eq!(defects["defects"][0]["worldRect"]["x"], 0);
        assert_eq!(defects["defects"][0]["worldRect"]["y"], 0);
        assert_eq!(defects["defects"][0]["trace"]["steelRect2d"]["top"], 200);
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
        let image_path = root2.join("images/1893700/1/0000.jpg");
        let mut corrupted = fs::read(&image_path).unwrap();
        corrupted[0] ^= 0xff;
        fs::write(&image_path, corrupted).unwrap();
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

fn json_u32(value: &Value, key: &str, label: &str) -> Result<u32, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|number| u32::try_from(number).ok())
        .ok_or_else(|| format!("BKV {label} {key} is invalid"))
}

fn build_inspection_world(
    material: &Value,
) -> Result<(InspectionWorld, HashMap<(u32, u32), String>), String> {
    let legacy_sequence = material
        .get("legacySeqNo")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let cameras = material
        .get("cameras")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("BKV material {legacy_sequence} cameras are unavailable"))?;
    let mut specs = Vec::with_capacity(cameras.len());
    let mut sources = HashMap::<(u32, u32), String>::new();
    for camera in cameras {
        let camera_id = json_u32(camera, "cameraId", "camera")?;
        let frame_width = json_u32(camera, "frameWidth", "camera")?;
        let frame_height = json_u32(camera, "frameHeight", "camera")?;
        let frames = camera
            .get("twoDFrames")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("BKV camera {camera_id} twoDFrames are unavailable"))?;
        let mut frame_numbers = Vec::with_capacity(frames.len());
        for frame in frames {
            let frame_number = json_u32(frame, "frameNo", "frame")?;
            let relative = frame.get("path").and_then(Value::as_str).ok_or_else(|| {
                format!("BKV camera {camera_id} frame {frame_number} path is missing")
            })?;
            frame_numbers.push(frame_number);
            sources.insert((camera_id, frame_number), relative.to_string());
        }
        specs.push(CameraSpec {
            camera_id,
            frame_width,
            frame_height,
            frame_numbers,
            orientation: serde_json::from_value::<CameraOrientation>(
                camera.get("orientation").cloned().unwrap_or(Value::Null),
            )
            .map_err(|error| format!("BKV camera {camera_id} orientation is invalid: {error}"))?,
        });
    }
    let world = InspectionWorld::new(specs).map_err(|error| error.to_string())?;
    Ok((world, sources))
}
