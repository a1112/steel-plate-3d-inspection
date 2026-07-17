use crate::db;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::env;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};

const CLEANUP_SCHEMA: &str = "steel.record-artifact-cleanup.v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupEntry {
    pub path: String,
    pub kind: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub status: String,
    pub error: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupManifest {
    pub schema: String,
    pub record_id: String,
    pub material_id: String,
    pub session_id: String,
    pub entries: Vec<CleanupEntry>,
}

#[derive(Clone, Debug)]
pub struct CleanupExecution {
    pub cleanup_id: String,
    pub record_id: String,
    pub material_id: String,
    pub files_planned: i32,
    pub files_deleted: i32,
    pub files_missing: i32,
    pub bytes_planned: i64,
    pub bytes_deleted: i64,
    pub defects_deleted: u64,
    pub capture_files_deleted: u64,
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    if cfg!(windows) {
        text.to_ascii_lowercase()
    } else {
        text
    }
}

fn is_forbidden_maintenance_path(path: &Path) -> bool {
    path.components().any(|component| {
        let Component::Normal(value) = component else {
            return false;
        };
        matches!(
            value.to_string_lossy().to_ascii_lowercase().as_str(),
            "maintenance" | "calibration" | "calibrations" | "config" | "profiles"
        )
    })
}

fn canonical_allowed_roots_from_text(text: &str) -> Result<Vec<PathBuf>, String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for root in env::split_paths(text) {
        if !root.is_absolute() {
            return Err("artifact cleanup roots must be absolute".to_string());
        }
        let canonical = fs::canonicalize(&root)
            .map_err(|error| format!("artifact cleanup root unavailable: {error}"))?;
        if !canonical.is_dir() {
            return Err("artifact cleanup root is not a directory".to_string());
        }
        if !roots
            .iter()
            .any(|existing| path_key(existing) == path_key(&canonical))
        {
            roots.push(canonical);
        }
    }
    if roots.is_empty() {
        return Err("STEEL_ARTIFACT_ALLOWED_ROOTS is required for artifact cleanup".to_string());
    }
    Ok(roots)
}

fn configured_allowed_roots() -> Result<Vec<PathBuf>, String> {
    canonical_allowed_roots_from_text(&env::var("STEEL_ARTIFACT_ALLOWED_ROOTS").unwrap_or_default())
}

fn canonical_file_within_roots(path: &Path, roots: &[PathBuf]) -> Result<Option<PathBuf>, String> {
    if !path.is_absolute() || is_forbidden_maintenance_path(path) {
        return Err("artifact path is outside the deletable production namespace".to_string());
    }
    if !path.exists() {
        let parent = path
            .parent()
            .ok_or_else(|| "artifact path has no parent".to_string())?;
        let canonical_parent = fs::canonicalize(parent)
            .map_err(|_| "missing artifact parent cannot be verified".to_string())?;
        if roots.iter().any(|root| canonical_parent.starts_with(root)) {
            return Ok(None);
        }
        return Err("missing artifact path is outside allowed roots".to_string());
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("artifact path cannot be canonicalized: {error}"))?;
    if !roots.iter().any(|root| canonical.starts_with(root)) {
        return Err("artifact path escapes allowed roots".to_string());
    }
    if !canonical.is_file() {
        return Err("artifact cleanup only deletes regular files".to_string());
    }
    Ok(Some(canonical))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| format!("artifact open failed: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("artifact hash read failed: {error}"))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn collect_summary_paths(value: &serde_json::Value, output: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => {
            let path = Path::new(text);
            if path.is_absolute() && !text.contains("://") {
                output.push(text.clone());
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_summary_paths(item, output);
            }
        }
        serde_json::Value::Object(items) => {
            for item in items.values() {
                collect_summary_paths(item, output);
            }
        }
        _ => {}
    }
}

fn add_candidate(
    entries: &mut Vec<CleanupEntry>,
    seen: &mut HashSet<String>,
    raw_path: &str,
    kind: &str,
    roots: &[PathBuf],
) {
    if raw_path.trim().is_empty() || raw_path.contains("://") {
        return;
    }
    let raw = PathBuf::from(raw_path);
    let result = canonical_file_within_roots(&raw, roots);
    let (path, size_bytes, sha256, status, error) = match result {
        Ok(Some(canonical)) => match fs::metadata(&canonical) {
            Ok(metadata) => match sha256_file(&canonical) {
                Ok(hash) => (
                    canonical,
                    metadata.len(),
                    hash,
                    "planned".to_string(),
                    String::new(),
                ),
                Err(error) => (canonical, 0, String::new(), "rejected".to_string(), error),
            },
            Err(error) => (
                canonical,
                0,
                String::new(),
                "rejected".to_string(),
                format!("artifact metadata failed: {error}"),
            ),
        },
        Ok(None) => (raw, 0, String::new(), "missing".to_string(), String::new()),
        Err(error) => (raw, 0, String::new(), "rejected".to_string(), error),
    };
    let key = path_key(&path);
    if seen.insert(key) {
        entries.push(CleanupEntry {
            path: path.display().to_string(),
            kind: kind.to_string(),
            size_bytes,
            sha256,
            status,
            error,
        });
    }
}

pub fn build_manifest(
    detail: &db::AdminInspectionRecordDetail,
    allowed_roots_text: &str,
) -> Result<CleanupManifest, String> {
    let session = detail
        .record
        .session
        .as_ref()
        .ok_or_else(|| "record cleanup requires a retained material session".to_string())?;
    if session.status != "finished" {
        return Err("record cleanup requires a finished material session".to_string());
    }
    let roots = canonical_allowed_roots_from_text(allowed_roots_text)?;
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for file in &detail.capture_files {
        add_candidate(&mut entries, &mut seen, &file.path, "capture", &roots);
        add_candidate(
            &mut entries,
            &mut seen,
            &file.metadata_path,
            "metadata",
            &roots,
        );
    }
    let summary_path = detail.record.inspection.summary_path.trim();
    add_candidate(&mut entries, &mut seen, summary_path, "summary", &roots);
    if !summary_path.is_empty() {
        let summary = PathBuf::from(summary_path);
        if let Ok(Some(canonical)) = canonical_file_within_roots(&summary, &roots) {
            if let Ok(bytes) = fs::read(&canonical) {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    let mut referenced = Vec::new();
                    collect_summary_paths(&value, &mut referenced);
                    for path in referenced {
                        add_candidate(&mut entries, &mut seen, &path, "summary-reference", &roots);
                    }
                }
            }
        }
    }
    Ok(CleanupManifest {
        schema: CLEANUP_SCHEMA.to_string(),
        record_id: detail.record.inspection.id.clone(),
        material_id: detail.record.inspection.material_id.clone(),
        session_id: detail.record.inspection.session_id.clone(),
        entries,
    })
}

fn manifest_counts(manifest: &CleanupManifest) -> (i32, i32, i64) {
    let deleted = manifest
        .entries
        .iter()
        .filter(|entry| entry.status == "deleted")
        .count() as i32;
    let missing = manifest
        .entries
        .iter()
        .filter(|entry| entry.status == "missing")
        .count() as i32;
    let bytes_deleted = manifest
        .entries
        .iter()
        .filter(|entry| entry.status == "deleted")
        .map(|entry| entry.size_bytes as i64)
        .sum();
    (deleted, missing, bytes_deleted)
}

pub fn manifest_plan_counts(manifest: &CleanupManifest) -> (i32, i64) {
    (
        manifest.entries.len() as i32,
        manifest
            .entries
            .iter()
            .map(|entry| entry.size_bytes as i64)
            .sum(),
    )
}

pub fn manifest_json(manifest: &CleanupManifest) -> Result<String, String> {
    serde_json::to_string(manifest).map_err(|error| error.to_string())
}

pub fn parse_manifest(text: &str) -> Result<CleanupManifest, String> {
    let manifest: CleanupManifest =
        serde_json::from_str(text).map_err(|error| error.to_string())?;
    if manifest.schema != CLEANUP_SCHEMA {
        return Err("unsupported cleanup manifest schema".to_string());
    }
    Ok(manifest)
}

pub fn configured_roots_for_planning() -> Result<String, String> {
    let text = env::var("STEEL_ARTIFACT_ALLOWED_ROOTS").unwrap_or_default();
    configured_allowed_roots()?;
    Ok(text)
}

pub fn execute_entry(entry: &mut CleanupEntry, roots: &[PathBuf]) -> Result<(), String> {
    if matches!(entry.status.as_str(), "deleted" | "missing") {
        return Ok(());
    }
    if entry.status == "rejected" {
        return Err(entry.error.clone());
    }
    let path = PathBuf::from(&entry.path);
    let Some(canonical) = canonical_file_within_roots(&path, roots)? else {
        entry.status = "missing".to_string();
        entry.error.clear();
        return Ok(());
    };
    let metadata =
        fs::metadata(&canonical).map_err(|error| format!("artifact metadata changed: {error}"))?;
    if metadata.len() != entry.size_bytes || sha256_file(&canonical)? != entry.sha256 {
        return Err("artifact changed after cleanup plan was frozen".to_string());
    }
    fs::remove_file(&canonical).map_err(|error| format!("artifact delete failed: {error}"))?;
    entry.status = "deleted".to_string();
    entry.error.clear();
    Ok(())
}

pub async fn execute_persisted_cleanup(
    connection: &sea_orm::DatabaseConnection,
    cleanup: db::entities::record_cleanup::Model,
) -> Result<CleanupExecution, String> {
    let roots = configured_allowed_roots()?;
    let mut manifest = parse_manifest(&cleanup.manifest_json)?;
    if manifest.record_id != cleanup.record_id {
        return Err("cleanup manifest record mismatch".to_string());
    }
    for index in 0..manifest.entries.len() {
        let result = execute_entry(&mut manifest.entries[index], &roots);
        if let Err(error) = result {
            manifest.entries[index].status = "failed".to_string();
            manifest.entries[index].error = error.clone();
            let (deleted, missing, bytes_deleted) = manifest_counts(&manifest);
            let serialized = manifest_json(&manifest)?;
            db::update_record_cleanup_progress(
                connection,
                &cleanup.id,
                "failed",
                &serialized,
                deleted,
                missing,
                bytes_deleted,
                &error,
            )
            .await
            .map_err(|db_error| db_error.to_string())?;
            return Err(error);
        }
        let (deleted, missing, bytes_deleted) = manifest_counts(&manifest);
        let serialized = manifest_json(&manifest)?;
        db::update_record_cleanup_progress(
            connection,
            &cleanup.id,
            "deleting",
            &serialized,
            deleted,
            missing,
            bytes_deleted,
            "",
        )
        .await
        .map_err(|error| error.to_string())?;
    }
    let (files_deleted, files_missing, bytes_deleted) = manifest_counts(&manifest);
    let serialized = manifest_json(&manifest)?;
    let deleted = db::complete_record_cleanup(
        connection,
        &cleanup.id,
        &cleanup.record_id,
        &serialized,
        files_deleted,
        files_missing,
        bytes_deleted,
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(CleanupExecution {
        cleanup_id: cleanup.id,
        record_id: deleted.id,
        material_id: deleted.material_id,
        files_planned: cleanup.files_planned,
        files_deleted,
        files_missing,
        bytes_planned: cleanup.bytes_planned,
        bytes_deleted,
        defects_deleted: deleted.defects_deleted,
        capture_files_deleted: deleted.capture_files_deleted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_root(name: &str) -> PathBuf {
        let root =
            env::temp_dir().join(format!("steel-cleanup-{name}-{}", db::now_millis_string()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn cleanup_entry_rechecks_hash_and_never_deletes_outside_allowed_roots() {
        let root = temp_root("hash");
        let outside = temp_root("outside");
        let file_path = root.join("capture.bin");
        let mut file = File::create(&file_path).unwrap();
        file.write_all(b"original").unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        let mut entry = CleanupEntry {
            path: file_path.display().to_string(),
            kind: "capture".to_string(),
            size_bytes: 8,
            sha256: sha256_file(&file_path).unwrap(),
            status: "planned".to_string(),
            error: String::new(),
        };
        fs::write(&file_path, b"changed!").unwrap();
        assert!(execute_entry(&mut entry, &[canonical_root.clone()])
            .unwrap_err()
            .contains("changed"));
        assert!(file_path.exists());

        let outside_path = outside.join("outside.bin");
        fs::write(&outside_path, b"outside").unwrap();
        let mut outside_entry = CleanupEntry {
            path: outside_path.display().to_string(),
            kind: "capture".to_string(),
            size_bytes: 7,
            sha256: sha256_file(&outside_path).unwrap(),
            status: "planned".to_string(),
            error: String::new(),
        };
        assert!(execute_entry(&mut outside_entry, &[canonical_root]).is_err());
        assert!(outside_path.exists());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }
}
