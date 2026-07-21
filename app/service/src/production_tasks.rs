use super::*;
use crate::db::entities::production_task;
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as UnixMetadataExt, OpenOptionsExt as UnixOpenOptionsExt};
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};

const DEFAULT_QUEUE_CAPACITY: u64 = 128;
const MAX_QUEUE_CAPACITY: u64 = 4096;
const BKV_MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const BKV_MAX_JSONL_BYTES: u64 = 32 * 1024 * 1024;
const BKV_MAX_JSONL_ROWS: usize = 100_000;
const BKV_MAX_JSONL_ROWS_PER_TABLE: usize = 50_000;
const BKV_MAX_ARTIFACTS: usize = 10_000;
const BKV_MAX_ARTIFACT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const BKV_MAX_PERSISTED_JSON_BYTES: usize = 60 * 1024;
const BKV_TARGET_SEQ_NOS: [i64; 11] = [
    1_893_700, 1_893_701, 1_893_702, 1_893_703, 1_893_704, 1_893_705, 1_893_706, 1_893_707,
    1_893_708, 1_893_709, 1_893_710,
];

#[derive(Clone, Debug)]
pub(super) struct BkvRejection {
    pub code: &'static str,
    _message: String,
}

impl BkvRejection {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            _message: message.into(),
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct BkvNormalizedFile {
    pub table: String,
    pub relative_path: String,
    pub rows: Vec<Value>,
}

#[derive(Clone, Debug)]
pub(super) struct BkvArtifact {
    pub path: PathBuf,
    pub relative_path: String,
    pub member_path: String,
    pub sha256: String,
    pub camera_number: i64,
    pub seq_no: i64,
    pub kind: String,
    pub extension: String,
    pub evidence: Value,
}

#[derive(Clone, Debug)]
pub(super) struct BkvValidatedBatch {
    pub batch_id: String,
    pub content_id: String,
    pub status: String,
    pub seq_nos: Vec<i64>,
    pub normalized: Vec<BkvNormalizedFile>,
    pub artifacts: Vec<BkvArtifact>,
    pub semantic_digest: String,
    pub manifest_sha256: String,
    pub publication_sha256: String,
}

#[derive(Clone, Debug)]
pub(super) struct BkvServingArtifact {
    pub relative_path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Clone, Debug)]
pub(super) struct BkvServingIndex {
    pub identity: String,
    pub batch_dir: PathBuf,
    pub artifacts: Vec<BkvServingArtifact>,
}

pub(super) fn bkv_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn bkv_valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn bkv_valid_batch_id(value: &str) -> bool {
    !value.is_empty()
        && value.as_bytes().len() <= 118
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn bkv_hash_file(path: &Path, max_bytes: u64) -> Result<(String, u64, Vec<u8>), BkvRejection> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        BkvRejection::new(
            "bkv_file_unavailable",
            format!("{}: {error}", path.display()),
        )
    })?;
    if bkv_metadata_is_reparse(&metadata) || !metadata.is_file() || metadata.len() > max_bytes {
        return Err(BkvRejection::new(
            "bkv_file_limit_exceeded",
            format!("{} exceeds the allowed file size", path.display()),
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.custom_flags(0x0020_0000);
    #[cfg(target_os = "linux")]
    options.custom_flags(0x0002_0000);
    #[cfg(target_os = "macos")]
    options.custom_flags(0x0000_0100);
    let mut file = options.open(path).map_err(|error| {
        BkvRejection::new(
            "bkv_file_unavailable",
            format!("{}: {error}", path.display()),
        )
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes) as usize);
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            BkvRejection::new(
                "bkv_file_unavailable",
                format!("{}: {error}", path.display()),
            )
        })?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > max_bytes {
            return Err(BkvRejection::new(
                "bkv_file_limit_exceeded",
                format!("{} exceeds the allowed file size", path.display()),
            ));
        }
        digest.update(&buffer[..read]);
        bytes.extend_from_slice(&buffer[..read]);
    }
    let after = file.metadata().map_err(|_| {
        BkvRejection::new("bkv_file_changed", "file metadata unavailable after read")
    })?;
    if bkv_metadata_is_reparse(&after) || after.len() != metadata.len() || total != metadata.len() {
        return Err(BkvRejection::new(
            "bkv_file_changed",
            "file changed while being read",
        ));
    }
    #[cfg(unix)]
    if after.dev() != metadata.dev() || after.ino() != metadata.ino() {
        return Err(BkvRejection::new(
            "bkv_file_changed",
            "file identity changed while being read",
        ));
    }
    Ok((format!("{:x}", digest.finalize()), total, bytes))
}

fn bkv_metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn bkv_safe_relative(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn bkv_resolve_batch_file(batch: &Path, relative: &str) -> Result<PathBuf, BkvRejection> {
    if !bkv_safe_relative(relative) {
        return Err(BkvRejection::new(
            "bkv_file_path_invalid",
            format!("invalid batch-relative path: {relative}"),
        ));
    }
    let candidate = batch.join(relative);
    let canonical = fs::canonicalize(&candidate).map_err(|error| {
        BkvRejection::new(
            "bkv_file_unavailable",
            format!("{}: {error}", candidate.display()),
        )
    })?;
    if !canonical.starts_with(batch) {
        return Err(BkvRejection::new(
            "bkv_file_outside_batch",
            format!("{} escaped the batch", candidate.display()),
        ));
    }
    let mut current = batch.to_path_buf();
    for component in Path::new(relative).components() {
        if let Component::Normal(part) = component {
            current.push(part);
            if fs::symlink_metadata(&current)
                .map(|metadata| bkv_metadata_is_reparse(&metadata))
                .unwrap_or(false)
            {
                return Err(BkvRejection::new(
                    "bkv_file_link_rejected",
                    format!("{} is a link", current.display()),
                ));
            }
        }
    }
    Ok(canonical)
}

fn bkv_evidence_path(
    batch: &Path,
    evidence: &Value,
    max_bytes: u64,
) -> Result<PathBuf, BkvRejection> {
    bkv_evidence_file(batch, evidence, max_bytes).map(|(path, _)| path)
}

fn bkv_evidence_file(
    batch: &Path,
    evidence: &Value,
    max_bytes: u64,
) -> Result<(PathBuf, Vec<u8>), BkvRejection> {
    let relative = evidence
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "file evidence path missing"))?;
    let expected_hash = evidence
        .get("sha256")
        .and_then(Value::as_str)
        .filter(|value| bkv_valid_sha256(value))
        .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "file evidence hash invalid"))?;
    let expected_size = evidence
        .get("size")
        .and_then(Value::as_u64)
        .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "file evidence size invalid"))?;
    let path = bkv_resolve_batch_file(batch, relative)?;
    let (actual_hash, actual_size, bytes) = bkv_hash_file(&path, max_bytes)?;
    if actual_hash != expected_hash.to_ascii_lowercase() || actual_size != expected_size {
        return Err(BkvRejection::new(
            "bkv_file_hash_mismatch",
            format!("file evidence changed: {relative}"),
        ));
    }
    Ok((path, bytes))
}

fn bkv_manifest_content_document(manifest: &Value) -> Result<Value, BkvRejection> {
    let archives = manifest
        .get("sourceArchives")
        .and_then(Value::as_object)
        .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "sourceArchives missing"))?;
    let mut archive_binding = serde_json::Map::new();
    for name in ["database-zip", "image-part1", "image-part2"] {
        let evidence = archives
            .get(name)
            .and_then(Value::as_object)
            .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "archive evidence missing"))?;
        let size = evidence
            .get("size")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                BkvRejection::new("bkv_manifest_invalid", "archive evidence size invalid")
            })?;
        let hash = evidence
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                BkvRejection::new("bkv_manifest_invalid", "archive evidence hash invalid")
            })?;
        if !bkv_valid_sha256(hash) {
            return Err(BkvRejection::new(
                "bkv_manifest_invalid",
                "archive evidence hash invalid",
            ));
        }
        archive_binding.insert(name.to_string(), json!({"size": size, "sha256": hash}));
    }
    let normalization_sha = manifest
        .pointer("/normalizationEvidence/sha256")
        .and_then(Value::as_str)
        .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "normalization hash missing"))?;
    if !bkv_valid_sha256(normalization_sha) {
        return Err(BkvRejection::new(
            "bkv_manifest_invalid",
            "normalization hash invalid",
        ));
    }
    let result_evidence = manifest
        .get("normalizationResultEvidence")
        .cloned()
        .ok_or_else(|| {
            BkvRejection::new("bkv_manifest_invalid", "normalization evidence missing")
        })?;
    let seq_nos = manifest
        .get("seqNos")
        .cloned()
        .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "seqNos missing"))?;
    let mut artifact_binding = Vec::new();
    for artifact in manifest
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "artifacts missing"))?
    {
        let member = artifact
            .get("memberPath")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                BkvRejection::new("bkv_manifest_invalid", "artifact memberPath missing")
            })?;
        let hash = artifact
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "artifact hash missing"))?;
        if !bkv_safe_relative(member) || member.contains('\\') || !bkv_valid_sha256(hash) {
            return Err(BkvRejection::new(
                "bkv_manifest_invalid",
                "artifact member/hash invalid",
            ));
        }
        let mut binding = json!({"memberPath": member, "sha256": hash});
        if artifact.get("extension").and_then(Value::as_str) == Some(".d3img") {
            binding["depthDecode"] = artifact.get("depthDecode").cloned().ok_or_else(|| {
                BkvRejection::new("bkv_manifest_invalid", "depth decode evidence missing")
            })?;
        }
        artifact_binding.push(binding);
    }
    artifact_binding.sort_by(|left, right| {
        left.get("memberPath")
            .and_then(Value::as_str)
            .cmp(&right.get("memberPath").and_then(Value::as_str))
    });
    if artifact_binding
        .windows(2)
        .any(|pair| pair[0].get("memberPath") == pair[1].get("memberPath"))
    {
        return Err(BkvRejection::new(
            "bkv_manifest_invalid",
            "artifact members are not unique",
        ));
    }
    Ok(json!({
        "schema": "steel.bkv-batch-content-id.v1",
        "manifestSchema": "steel.bkv-import-manifest.v1",
        "sourceArchives": archive_binding,
        "normalization": {"pointerSha256": normalization_sha, "resultEvidence": result_evidence},
        "seqNos": seq_nos,
        "artifacts": artifact_binding
    }))
}

pub(super) fn bkv_batch_content_id(manifest: &Value) -> Result<String, BkvRejection> {
    let document = bkv_manifest_content_document(manifest)?;
    let bytes = serde_json::to_vec(&document).map_err(|error| {
        BkvRejection::new("bkv_manifest_invalid", format!("content binding: {error}"))
    })?;
    Ok(bkv_sha256(&bytes))
}

pub(super) fn load_bkv_batch(
    configured_root: &Path,
    requested_manifest: &Path,
    operator_reviewed_partial: bool,
) -> Result<BkvValidatedBatch, BkvRejection> {
    if !configured_root.is_absolute() {
        return Err(BkvRejection::new(
            "bkv_root_invalid",
            "STEEL_BKV_DATA_ROOT must be absolute",
        ));
    }
    for component in [
        configured_root,
        requested_manifest.parent().unwrap_or(requested_manifest),
        requested_manifest,
    ] {
        let metadata = fs::symlink_metadata(component).map_err(|_| {
            BkvRejection::new("bkv_file_unavailable", "BKV path component unavailable")
        })?;
        if bkv_metadata_is_reparse(&metadata) {
            return Err(BkvRejection::new(
                "bkv_file_link_rejected",
                "BKV reparse path component rejected",
            ));
        }
    }
    let root = fs::canonicalize(configured_root).map_err(|error| {
        BkvRejection::new("bkv_root_invalid", format!("BKV root unavailable: {error}"))
    })?;
    let manifest_path = fs::canonicalize(requested_manifest).map_err(|error| {
        BkvRejection::new(
            "bkv_manifest_unavailable",
            format!("manifest unavailable: {error}"),
        )
    })?;
    if !manifest_path.starts_with(&root) {
        return Err(BkvRejection::new(
            "bkv_manifest_outside_root",
            "manifest is outside STEEL_BKV_DATA_ROOT",
        ));
    }
    let batch_dir = manifest_path.parent().ok_or_else(|| {
        BkvRejection::new(
            "bkv_manifest_outside_root",
            "manifest has no batch directory",
        )
    })?;
    if batch_dir.parent() != Some(root.as_path())
        || manifest_path.file_name().and_then(|v| v.to_str()) != Some("manifest.json")
    {
        return Err(BkvRejection::new(
            "bkv_manifest_outside_root",
            "manifest must be <root>/<batch-id>/manifest.json",
        ));
    }
    let (manifest_sha256, _, bytes) = bkv_hash_file(&manifest_path, BKV_MAX_MANIFEST_BYTES)?;
    let mut manifest: Value = serde_json::from_slice(&bytes).map_err(|error| {
        BkvRejection::new(
            "bkv_manifest_invalid_json",
            format!("invalid manifest JSON: {error}"),
        )
    })?;
    if manifest.get("schema").and_then(Value::as_str) != Some("steel.bkv-import-manifest.v1") {
        return Err(BkvRejection::new(
            "bkv_manifest_schema_unsupported",
            "unsupported manifest schema",
        ));
    }
    let batch_id = manifest
        .get("batchId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !bkv_valid_batch_id(&batch_id) {
        return Err(BkvRejection::new(
            "bkv_batch_id_invalid",
            "batchId violates the app_config key contract",
        ));
    }
    if batch_dir.file_name().and_then(|value| value.to_str()) != Some(batch_id.as_str()) {
        return Err(BkvRejection::new(
            "bkv_manifest_batch_mismatch",
            "batchId/path mismatch",
        ));
    }
    let seq_nos = manifest
        .get("seqNos")
        .and_then(Value::as_array)
        .ok_or_else(|| BkvRejection::new("bkv_seq_scope_invalid", "seqNos missing"))?
        .iter()
        .map(|value| value.as_i64())
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| BkvRejection::new("bkv_seq_scope_invalid", "seqNos must be integers"))?;
    if seq_nos != BKV_TARGET_SEQ_NOS {
        return Err(BkvRejection::new(
            "bkv_seq_scope_invalid",
            "manifest must contain exact approved SeqNo range",
        ));
    }
    let status = manifest
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let depth_files_valid = manifest
        .get("artifacts")
        .and_then(Value::as_array)
        .is_some_and(|artifacts| {
            artifacts.iter().all(|artifact| {
                artifact.get("extension").and_then(Value::as_str) != Some(".d3img")
                    || artifact
                        .pointer("/depthDecode/status")
                        .and_then(Value::as_str)
                        != Some("invalid")
            })
        });
    let derived_ready = manifest
        .get("targetCoverageComplete")
        .and_then(Value::as_bool)
        == Some(true)
        && manifest
            .pointer("/databaseIntegrity/allInventoryMembersVerified")
            .and_then(Value::as_bool)
            == Some(true)
        && manifest
            .pointer("/databaseIntegrity/normalizationIntegrity")
            .and_then(Value::as_str)
            == Some("ok")
        && manifest
            .pointer("/databaseIntegrity/diameterComplete")
            .and_then(Value::as_bool)
            == Some(true)
        && manifest
            .pointer("/databaseIntegrity/parseRejectedStatements")
            .and_then(Value::as_u64)
            == Some(0)
        && manifest
            .pointer("/counts/rejectedNormalizedRows")
            .and_then(Value::as_u64)
            == Some(0)
        && depth_files_valid;
    let state_consistent = match status.as_str() {
        "ready" => {
            derived_ready
                && manifest.get("importEligible").and_then(Value::as_bool) == Some(true)
                && manifest.get("reviewRequired").and_then(Value::as_bool) == Some(false)
        }
        "partial" => {
            !derived_ready
                && manifest.get("importEligible").and_then(Value::as_bool) == Some(false)
                && manifest.get("reviewRequired").and_then(Value::as_bool) == Some(true)
        }
        "failed" => manifest.get("importEligible").and_then(Value::as_bool) == Some(false),
        _ => false,
    };
    if !state_consistent {
        return Err(BkvRejection::new(
            "bkv_batch_status_invalid",
            "batch status disagrees with integrity and review evidence",
        ));
    }
    match status.as_str() {
        "ready" => {}
        "partial" if operator_reviewed_partial => {}
        "partial" => {
            return Err(BkvRejection::new(
                "bkv_partial_review_required",
                "partial batch requires explicit operator review",
            ))
        }
        "failed" => {
            return Err(BkvRejection::new(
                "bkv_batch_failed",
                "failed batch cannot be imported",
            ))
        }
        _ => {
            return Err(BkvRejection::new(
                "bkv_batch_status_invalid",
                "batch status is invalid",
            ))
        }
    }
    if let Some(pointer_path) = manifest
        .pointer("/normalizationEvidence/path")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        let (_, pointer_bytes) = bkv_evidence_file(
            batch_dir,
            &manifest["normalizationEvidence"],
            BKV_MAX_MANIFEST_BYTES,
        )?;
        let pointer_json: Value = serde_json::from_slice(&pointer_bytes)
            .map_err(|error| BkvRejection::new("bkv_manifest_invalid", error.to_string()))?;
        manifest["normalizationResultEvidence"] =
            pointer_json.get("resultEvidence").cloned().ok_or_else(|| {
                BkvRejection::new(
                    "bkv_manifest_invalid",
                    format!("{pointer_path} lacks resultEvidence"),
                )
            })?;
        manifest["normalizationPointerFiles"] =
            pointer_json.get("files").cloned().ok_or_else(|| {
                BkvRejection::new(
                    "bkv_manifest_invalid",
                    format!("{pointer_path} lacks files"),
                )
            })?;
    }
    let computed_content_id = bkv_batch_content_id(&manifest)?;
    let content_id = manifest
        .get("batchContentId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if content_id != computed_content_id
        || manifest.get("contentId").and_then(Value::as_str) != Some(content_id.as_str())
    {
        return Err(BkvRejection::new(
            "bkv_manifest_content_hash_mismatch",
            "batch content hash mismatch",
        ));
    }
    let publication_path = bkv_resolve_batch_file(batch_dir, "publication.json")?;
    let (publication_sha256, _, publication_bytes) =
        bkv_hash_file(&publication_path, BKV_MAX_MANIFEST_BYTES)?;
    let publication: Value = serde_json::from_slice(&publication_bytes).map_err(|error| {
        BkvRejection::new(
            "bkv_batch_not_committed",
            format!("invalid publication marker: {error}"),
        )
    })?;
    if publication.get("schema").and_then(Value::as_str) != Some("steel.bkv-publication.v1")
        || publication.get("state").and_then(Value::as_str) != Some("committed")
        || publication.get("batchId").and_then(Value::as_str) != Some(batch_id.as_str())
        || publication.get("contentId").and_then(Value::as_str) != Some(content_id.as_str())
    {
        return Err(BkvRejection::new(
            "bkv_batch_not_committed",
            "publication marker is not committed for this batch/content",
        ));
    }
    let mut normalized_files = Vec::new();
    let mut total_rows = 0_usize;
    let mut normalized_tables = std::collections::BTreeSet::new();
    for evidence in manifest
        .get("normalized")
        .and_then(Value::as_array)
        .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "normalized evidence missing"))?
    {
        let table = evidence
            .get("table")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(
            table,
            "allexcel" | "checkrecord" | "defect" | "defectclass" | "diameter"
        ) {
            return Err(BkvRejection::new(
                "bkv_normalized_table_invalid",
                "normalized table is invalid",
            ));
        }
        if !normalized_tables.insert(table.to_string()) {
            return Err(BkvRejection::new(
                "bkv_normalized_table_invalid",
                format!("normalized table is duplicated: {table}"),
            ));
        }
        let relative_path = evidence
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if let Some(pointer_evidence) =
            manifest.pointer(&format!("/normalizationPointerFiles/{table}"))
        {
            for key in ["sha256", "size", "count"] {
                if pointer_evidence.get(key) != evidence.get(key) {
                    return Err(BkvRejection::new(
                        "bkv_normalization_evidence_mismatch",
                        format!("{table} {key} differs from signed normalization pointer"),
                    ));
                }
            }
        }
        let (_path, payload) = bkv_evidence_file(batch_dir, evidence, BKV_MAX_JSONL_BYTES)?;
        let mut rows = Vec::new();
        for line in payload.split(|byte| *byte == b'\n') {
            if line.is_empty() {
                continue;
            }
            total_rows += 1;
            if total_rows > BKV_MAX_JSONL_ROWS {
                return Err(BkvRejection::new(
                    "bkv_jsonl_row_limit_exceeded",
                    "normalized row limit exceeded",
                ));
            }
            let row: Value = serde_json::from_slice(line).map_err(|error| {
                BkvRejection::new("bkv_normalized_row_invalid", format!("{table}: {error}"))
            })?;
            let seq = row
                .get("legacySeqNo")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    BkvRejection::new("bkv_normalized_row_invalid", "legacySeqNo missing")
                })?;
            if !BKV_TARGET_SEQ_NOS.contains(&seq)
                || row.get("legacyTable").and_then(Value::as_str) != Some(table)
            {
                return Err(BkvRejection::new(
                    "bkv_normalized_row_invalid",
                    "normalized provenance is invalid",
                ));
            }
            rows.push(row);
        }
        if evidence.get("count").and_then(Value::as_u64) != Some(rows.len() as u64) {
            return Err(BkvRejection::new(
                "bkv_normalized_count_mismatch",
                "normalized row count mismatch",
            ));
        }
        if rows.len() > BKV_MAX_JSONL_ROWS_PER_TABLE {
            return Err(BkvRejection::new(
                "bkv_jsonl_row_limit_exceeded",
                "normalized table row limit exceeded",
            ));
        }
        normalized_files.push(BkvNormalizedFile {
            table: table.to_string(),
            relative_path,
            rows,
        });
    }
    let required_tables = [
        "allexcel",
        "checkrecord",
        "defect",
        "defectclass",
        "diameter",
    ]
    .into_iter()
    .map(str::to_string)
    .collect::<std::collections::BTreeSet<_>>();
    if normalized_tables != required_tables {
        return Err(BkvRejection::new(
            "bkv_normalized_table_invalid",
            "manifest must contain each normalized table exactly once",
        ));
    }
    let mut artifacts = Vec::new();
    let manifest_artifacts = manifest
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "artifacts missing"))?;
    if manifest_artifacts.len() > BKV_MAX_ARTIFACTS {
        return Err(BkvRejection::new(
            "bkv_artifact_limit_exceeded",
            "artifact count limit exceeded",
        ));
    }
    let mut artifact_paths = std::collections::HashSet::new();
    let mut artifact_members = std::collections::HashSet::new();
    let mut artifact_bytes = 0_u64;
    for evidence in manifest_artifacts {
        let relative_path = evidence
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let member_path = evidence
            .get("memberPath")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if !artifact_paths.insert(relative_path.clone())
            || !artifact_members.insert(member_path.clone())
        {
            return Err(BkvRejection::new(
                "bkv_artifact_path_duplicate",
                "artifact paths must be unique",
            ));
        }
        artifact_bytes = artifact_bytes
            .checked_add(
                evidence
                    .get("size")
                    .and_then(Value::as_u64)
                    .unwrap_or(u64::MAX),
            )
            .ok_or_else(|| {
                BkvRejection::new(
                    "bkv_artifact_limit_exceeded",
                    "artifact byte limit exceeded",
                )
            })?;
        if artifact_bytes > BKV_MAX_ARTIFACT_BYTES {
            return Err(BkvRejection::new(
                "bkv_artifact_limit_exceeded",
                "artifact byte limit exceeded",
            ));
        }
        let path = bkv_evidence_path(batch_dir, evidence, BKV_MAX_JSONL_BYTES)?;
        let seq_no = evidence
            .get("seqNo")
            .and_then(Value::as_i64)
            .ok_or_else(|| BkvRejection::new("bkv_artifact_invalid", "artifact seqNo missing"))?;
        if !BKV_TARGET_SEQ_NOS.contains(&seq_no) {
            return Err(BkvRejection::new(
                "bkv_artifact_invalid",
                "artifact SeqNo outside approved range",
            ));
        }
        let camera_number = evidence
            .get("cameraNumber")
            .and_then(Value::as_i64)
            .ok_or_else(|| BkvRejection::new("bkv_artifact_invalid", "artifact camera missing"))?;
        if !(1..=6).contains(&camera_number) {
            return Err(BkvRejection::new(
                "bkv_artifact_invalid",
                "artifact camera outside BKV range",
            ));
        }
        artifacts.push(BkvArtifact {
            path,
            relative_path,
            member_path,
            sha256: evidence
                .get("sha256")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            camera_number,
            seq_no,
            kind: evidence
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            extension: evidence
                .get("extension")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            evidence: evidence.clone(),
        });
    }
    for field in ["sourceInventory", "quarantine"] {
        if manifest
            .get(field)
            .and_then(|value| value.get("path"))
            .and_then(Value::as_str)
            .is_some()
        {
            bkv_evidence_path(batch_dir, &manifest[field], BKV_MAX_MANIFEST_BYTES)?;
        }
    }
    let semantic_document = json!({
        "batchId":batch_id,
        "contentId":content_id,
        "normalized":normalized_files.iter().map(|file| json!({"table":file.table,"path":file.relative_path,"rows":file.rows})).collect::<Vec<_>>(),
        "artifacts":artifacts.iter().map(|artifact| &artifact.evidence).collect::<Vec<_>>()
    });
    let semantic_digest = bkv_sha256(
        &serde_json::to_vec(&semantic_document)
            .map_err(|_| BkvRejection::new("bkv_manifest_invalid", "semantic digest failed"))?,
    );
    Ok(BkvValidatedBatch {
        batch_id,
        content_id,
        status,
        seq_nos,
        normalized: normalized_files,
        artifacts,
        semantic_digest,
        manifest_sha256,
        publication_sha256,
    })
}

pub(super) fn load_bkv_serving_index(
    configured_root: &Path,
    manifest_path: &Path,
    expected_batch_id: &str,
    expected_content_id: &str,
    expected_semantic_digest: &str,
    expected_manifest_sha256: &str,
    expected_publication_sha256: &str,
) -> Result<BkvServingIndex, BkvRejection> {
    if !configured_root.is_absolute() || !bkv_valid_batch_id(expected_batch_id) {
        return Err(BkvRejection::new(
            "bkv_root_invalid",
            "invalid serving root",
        ));
    }
    let root = fs::canonicalize(configured_root)
        .map_err(|_| BkvRejection::new("bkv_root_invalid", "serving root unavailable"))?;
    for component in [
        configured_root,
        manifest_path.parent().unwrap_or(manifest_path),
        manifest_path,
    ] {
        let metadata = fs::symlink_metadata(component)
            .map_err(|_| BkvRejection::new("bkv_file_unavailable", "serving path unavailable"))?;
        if bkv_metadata_is_reparse(&metadata) {
            return Err(BkvRejection::new(
                "bkv_file_link_rejected",
                "serving reparse path rejected",
            ));
        }
    }
    let manifest_path = fs::canonicalize(manifest_path)
        .map_err(|_| BkvRejection::new("bkv_manifest_unavailable", "manifest unavailable"))?;
    let batch_dir = manifest_path
        .parent()
        .ok_or_else(|| BkvRejection::new("bkv_manifest_outside_root", "manifest parent missing"))?;
    if batch_dir.parent() != Some(root.as_path())
        || batch_dir.file_name().and_then(|value| value.to_str()) != Some(expected_batch_id)
        || manifest_path.file_name().and_then(|value| value.to_str()) != Some("manifest.json")
    {
        return Err(BkvRejection::new(
            "bkv_manifest_outside_root",
            "serving manifest path invalid",
        ));
    }
    let (manifest_sha256, _, manifest_bytes) =
        bkv_hash_file(&manifest_path, BKV_MAX_MANIFEST_BYTES)?;
    if manifest_sha256 != expected_manifest_sha256 {
        return Err(BkvRejection::new(
            "bkv_manifest_changed",
            "manifest hash changed",
        ));
    }
    let manifest: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| BkvRejection::new("bkv_manifest_invalid_json", "manifest JSON invalid"))?;
    if manifest.get("schema").and_then(Value::as_str) != Some("steel.bkv-import-manifest.v1")
        || manifest.get("batchId").and_then(Value::as_str) != Some(expected_batch_id)
        || manifest.get("batchContentId").and_then(Value::as_str) != Some(expected_content_id)
        || manifest.get("contentId").and_then(Value::as_str) != Some(expected_content_id)
    {
        return Err(BkvRejection::new(
            "bkv_manifest_changed",
            "manifest binding changed",
        ));
    }
    let publication_path = batch_dir.join("publication.json");
    let (publication_sha256, _, publication_bytes) =
        bkv_hash_file(&publication_path, BKV_MAX_MANIFEST_BYTES)?;
    if publication_sha256 != expected_publication_sha256 {
        return Err(BkvRejection::new(
            "bkv_manifest_changed",
            "publication hash changed",
        ));
    }
    let publication: Value = serde_json::from_slice(&publication_bytes)
        .map_err(|_| BkvRejection::new("bkv_batch_not_committed", "publication JSON invalid"))?;
    if publication.get("schema").and_then(Value::as_str) != Some("steel.bkv-publication.v1")
        || publication.get("state").and_then(Value::as_str) != Some("committed")
        || publication.get("batchId").and_then(Value::as_str) != Some(expected_batch_id)
        || publication.get("contentId").and_then(Value::as_str) != Some(expected_content_id)
    {
        return Err(BkvRejection::new(
            "bkv_batch_not_committed",
            "publication binding changed",
        ));
    }
    let evidence = manifest
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "artifact list missing"))?;
    if evidence.len() > BKV_MAX_ARTIFACTS {
        return Err(BkvRejection::new(
            "bkv_artifact_limit_exceeded",
            "artifact count limit exceeded",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut artifacts = Vec::with_capacity(evidence.len());
    for item in evidence {
        let relative_path = item.get("path").and_then(Value::as_str).unwrap_or_default();
        let sha256 = item
            .get("sha256")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let size = item.get("size").and_then(Value::as_u64);
        if !bkv_safe_relative(relative_path)
            || !relative_path.starts_with("artifacts/")
            || !bkv_valid_sha256(sha256)
            || size.is_none()
            || !seen.insert(relative_path.to_string())
        {
            return Err(BkvRejection::new(
                "bkv_manifest_invalid",
                "artifact allowlist invalid",
            ));
        }
        artifacts.push(BkvServingArtifact {
            relative_path: relative_path.to_string(),
            sha256: sha256.to_string(),
            size: size.unwrap_or_default(),
        });
    }
    Ok(BkvServingIndex {
        identity: format!(
            "{}:{expected_batch_id}:{expected_content_id}:{expected_semantic_digest}:{manifest_sha256}:{publication_sha256}",
            batch_dir.display()
        ),
        batch_dir: batch_dir.to_path_buf(),
        artifacts,
    })
}

pub(super) fn resolve_bkv_serving_path(
    index: &BkvServingIndex,
    artifact: &BkvServingArtifact,
) -> Result<PathBuf, BkvRejection> {
    bkv_resolve_batch_file(&index.batch_dir, &artifact.relative_path)
}

fn bkv_row_value<'a>(row: &'a Value, names: &[&str]) -> Option<&'a Value> {
    let object = row.as_object()?;
    names.iter().find_map(|name| {
        object
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value)
    })
}

fn bkv_row_text(row: &Value, names: &[&str]) -> Option<String> {
    bkv_row_value(row, names).and_then(|value| match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

fn bkv_row_number(row: &Value, names: &[&str]) -> Option<f64> {
    bkv_row_value(row, names).and_then(|value| {
        value
            .as_f64()
            .or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.trim().parse::<f64>().ok())
            })
            .filter(|number| number.is_finite())
    })
}

fn bkv_required_dimension(row: &Value, names: &[&str], label: &str) -> Result<f64, BkvRejection> {
    bkv_row_number(row, names)
        .filter(|value| *value >= 0.0)
        .ok_or_else(|| {
            BkvRejection::new(
                "bkv_material_dimensions_invalid",
                format!("legacy material {label} is missing or invalid"),
            )
        })
}

fn bkv_canonical_defect_type(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "pit" | "dent" | "凹坑" => Some("pit"),
        "roll" | "roll-mark" | "rollmark" | "辊印" => Some("roll"),
        "scratch" | "划伤" => Some("scratch"),
        "foreign" | "foreign-object" | "异物压入" => Some("foreign"),
        "burnt" | "burnt-steel" | "烂钢" => Some("burnt"),
        "edge" | "edge-crack" | "边裂" => Some("edge"),
        "longitudinal" | "longitudinal-crack" | "纵裂" => Some("longitudinal"),
        "bubble" | "气泡" => Some("bubble"),
        "inclusion" | "夹杂" => Some("inclusion"),
        "review" | "待复核" => Some("review"),
        _ => None,
    }
}

fn bkv_artifact_token(batch_id: &str, relative_path: &str) -> String {
    format!("bkv://{batch_id}/{relative_path}")
}

fn bkv_canonical_severity(value: Option<String>) -> (&'static str, Option<String>) {
    let legacy = value.filter(|item| !item.trim().is_empty());
    let canonical = match legacy.as_deref().map(str::trim) {
        Some("严重" | "重度" | "3") => "severe",
        Some("复核" | "待复核" | "2") => "review",
        Some("轻微" | "轻度" | "1") => "minor",
        Some(value) if value.eq_ignore_ascii_case("severe") => "severe",
        Some(value) if value.eq_ignore_ascii_case("review") => "review",
        Some(value) if value.eq_ignore_ascii_case("minor") => "minor",
        _ => "review",
    };
    (canonical, legacy)
}

fn bkv_required_defect_number(
    row: &Value,
    names: &[&str],
    label: &str,
) -> Result<f64, BkvRejection> {
    bkv_row_number(row, names).ok_or_else(|| {
        BkvRejection::new(
            "bkv_defect_invalid",
            format!("defect {label} is missing or non-finite"),
        )
    })
}

fn bkv_validated_to_db(batch: &BkvValidatedBatch) -> Result<db::BkvImportBatch, BkvRejection> {
    let rows_for = |table: &str, seq_no: i64| -> Vec<&Value> {
        batch
            .normalized
            .iter()
            .filter(|file| file.table == table)
            .flat_map(|file| file.rows.iter())
            .filter(|row| row.get("legacySeqNo").and_then(Value::as_i64) == Some(seq_no))
            .collect()
    };
    let mut materials = Vec::with_capacity(batch.seq_nos.len());
    for seq_no in &batch.seq_nos {
        let allexcel = rows_for("allexcel", *seq_no);
        let material_row = allexcel.first().copied().ok_or_else(|| {
            BkvRejection::new(
                "bkv_material_row_missing",
                format!("allexcel row missing for SeqNo {seq_no}"),
            )
        })?;
        let check_rows = rows_for("checkrecord", *seq_no);
        let check_row = check_rows.first().copied().unwrap_or(material_row);
        let legacy_id = bkv_row_text(
            material_row,
            &["id", "allexcelid", "recordid", "originalRowHash"],
        )
        .unwrap_or_else(|| seq_no.to_string());
        let source_path = "normalized/allexcel.jsonl";
        let material_id = bkv_deterministic_id(
            &batch.batch_id,
            "material",
            "allexcel",
            &legacy_id,
            source_path,
        );
        let session_id = bkv_deterministic_id(
            &batch.batch_id,
            "material-session",
            "allexcel",
            &legacy_id,
            source_path,
        );
        let inspection_id = bkv_deterministic_id(
            &batch.batch_id,
            "production-inspection",
            "checkrecord",
            &bkv_row_text(check_row, &["id", "checkrecordid", "originalRowHash"])
                .unwrap_or_else(|| legacy_id.clone()),
            "normalized/checkrecord.jsonl",
        );
        let provenance_rows = batch
            .normalized
            .iter()
            .flat_map(|file| {
                file.rows
                    .iter()
                    .enumerate()
                    .map(move |(line, row)| (file, line, row))
            })
            .filter(|(_, _, row)| row.get("legacySeqNo").and_then(Value::as_i64) == Some(*seq_no))
            .map(|(file, line, row)| {
                let row_hash = row
                    .get("originalRowHash")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        BkvRejection::new(
                            "bkv_normalized_row_invalid",
                            "normalized row provenance hash missing",
                        )
                    })?;
                let legacy_key = bkv_row_text(
                    row,
                    &[
                        "id",
                        "allexcelid",
                        "checkrecordid",
                        "defectid",
                        "classId",
                        "originalRowHash",
                    ],
                )
                .unwrap_or_else(|| format!("{}:{}", file.table, line + 1));
                Ok(json!({
                    "t":row.get("legacyTable"),
                    "k":legacy_key,
                    "h":row_hash,
                    "p":file.relative_path,
                    "l":line + 1
                }))
            })
            .collect::<Result<Vec<_>, BkvRejection>>()?;
        let artifact_provenance = batch
            .artifacts
            .iter()
            .filter(|artifact| artifact.seq_no == *seq_no)
            .map(|artifact| {
                json!({
                    "p": artifact.relative_path,
                    "m": artifact.member_path,
                    "h": artifact.sha256,
                    "c": artifact.camera_number,
                    "s": artifact.seq_no,
                    "k": artifact.kind
                })
            })
            .collect::<Vec<_>>();
        materials.push(db::BkvImportMaterial {
            seq_no: *seq_no,
            material_id,
            steel_plate_id: bkv_deterministic_id(
                &batch.batch_id,
                "steel-plate",
                "allexcel",
                &legacy_id,
                source_path,
            ),
            inspection_record_id: bkv_deterministic_id(
                &batch.batch_id,
                "inspection-record",
                "checkrecord",
                &legacy_id,
                "normalized/checkrecord.jsonl",
            ),
            session_id,
            inspection_id,
            width_mm: bkv_required_dimension(
                material_row,
                &[
                    "width",
                    "widthmm",
                    "diameter",
                    "outdiameter",
                    "outerdiameter",
                    "outsideDiameter",
                ],
                "width/diameter",
            )?,
            length_mm: bkv_required_dimension(
                material_row,
                &["length", "lengthmm", "steelLength", "tubeLength"],
                "length",
            )?,
            thickness_mm: bkv_required_dimension(
                material_row,
                &["thickness", "thicknessmm", "wallthickness", "wallThickness"],
                "thickness",
            )?,
            steel_grade: bkv_row_text(
                material_row,
                &["steelgrade", "steeltype", "grade", "material"],
            )
            .unwrap_or_else(|| "legacy-unknown".to_string()),
            occurred_at: bkv_row_text(
                check_row,
                &["time", "checktime", "datetime", "detecttime", "createdat"],
            )
            .unwrap_or_else(|| seq_no.to_string()),
            raw_payload: {
                let payload = json!({
                "source": "bkv",
                "batchId": batch.batch_id,
                "contentId": batch.content_id,
                "legacySeqNo": seq_no,
                "legacyTable": "allexcel",
                "legacyId": legacy_id,
                "sourcePath": source_path,
                "rowRefs": provenance_rows,
                "artifactProvenance": artifact_provenance
                })
                .to_string();
                if payload.len() > BKV_MAX_PERSISTED_JSON_BYTES {
                    return Err(BkvRejection::new(
                        "bkv_provenance_too_large",
                        "BKV provenance exceeds storage contract",
                    ));
                }
                payload
            },
        });
    }
    let material_for = |seq_no: i64| {
        materials
            .iter()
            .find(|material| material.seq_no == seq_no)
            .ok_or_else(|| {
                BkvRejection::new(
                    "bkv_seq_scope_invalid",
                    "artifact/defect SeqNo has no material",
                )
            })
    };
    let mut artifacts = Vec::with_capacity(batch.artifacts.len());
    for artifact in &batch.artifacts {
        let material = material_for(artifact.seq_no)?;
        let data_name = artifact
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| BkvRejection::new("bkv_artifact_invalid", "artifact file name invalid"))?
            .to_string();
        let metadata_path = batch
            .artifacts
            .iter()
            .find(|candidate| {
                candidate.camera_number == artifact.camera_number
                    && candidate.seq_no == artifact.seq_no
                    && candidate.extension.eq_ignore_ascii_case(".dat")
            })
            .or_else(|| {
                batch.artifacts.iter().find(|candidate| {
                    candidate.camera_number == artifact.camera_number
                        && candidate.seq_no == artifact.seq_no
                        && candidate.kind.eq_ignore_ascii_case("metadata")
                })
            })
            .map(|candidate| candidate.relative_path.clone())
            .unwrap_or_default();
        let metadata_path = if metadata_path.is_empty() {
            String::new()
        } else {
            bkv_artifact_token(&batch.batch_id, &metadata_path)
        };
        artifacts.push(db::BkvImportArtifact {
            id: bkv_deterministic_id(
                &batch.batch_id,
                "capture-file",
                "archive",
                &artifact.sha256,
                &artifact.relative_path,
            ),
            inspection_id: material.inspection_id.clone(),
            session_id: material.session_id.clone(),
            material_id: material.material_id.clone(),
            camera_id: format!("bkv-camera-{}", artifact.camera_number),
            data_name,
            sequence_no: artifact.seq_no,
            file_type: artifact.kind.clone(),
            path: bkv_artifact_token(&batch.batch_id, &artifact.relative_path),
            metadata_path,
        });
    }
    let mut defect_classes = std::collections::HashMap::<String, String>::new();
    for row in batch
        .normalized
        .iter()
        .filter(|file| file.table == "defectclass")
        .flat_map(|file| file.rows.iter())
    {
        if let (Some(id), Some(name)) = (
            bkv_row_text(row, &["id", "classid", "defectclassid", "typeid", "code"]),
            bkv_row_text(
                row,
                &["name", "defectname", "typename", "label", "classname"],
            ),
        ) {
            defect_classes.insert(id, name);
        }
    }
    let mut defects = Vec::new();
    for file in batch
        .normalized
        .iter()
        .filter(|file| file.table == "defect")
    {
        for (line, row) in file.rows.iter().enumerate() {
            let seq_no = row
                .get("legacySeqNo")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    BkvRejection::new("bkv_normalized_row_invalid", "defect legacySeqNo missing")
                })?;
            let material = material_for(seq_no)?;
            let legacy_id = bkv_row_text(row, &["id", "defectid", "originalRowHash"])
                .unwrap_or_else(|| format!("{seq_no}-{}", defects.len()));
            let camera =
                bkv_required_defect_number(row, &["camera", "cameraid", "camerano"], "camera")?;
            if camera.fract() != 0.0 || !(1.0..=6.0).contains(&camera) {
                return Err(BkvRejection::new(
                    "bkv_defect_invalid",
                    "defect camera must be an integer from 1 through 6",
                ));
            }
            let x_mm = bkv_required_defect_number(row, &["x", "xmm"], "x")?;
            let y_mm = bkv_required_defect_number(row, &["y", "ymm", "distance"], "y")?;
            let z_mm = bkv_required_defect_number(row, &["z", "zmm"], "z")?;
            let width_mm = bkv_required_defect_number(row, &["width", "widthmm"], "width")?;
            let height_mm = bkv_required_defect_number(row, &["height", "heightmm"], "height")?;
            let depth_mm = bkv_required_defect_number(row, &["depth", "depthmm"], "depth")?;
            let confidence =
                bkv_required_defect_number(row, &["confidence", "score"], "confidence")?;
            if width_mm < 0.0
                || height_mm < 0.0
                || depth_mm < 0.0
                || !(0.0..=1.0).contains(&confidence)
            {
                return Err(BkvRejection::new(
                    "bkv_defect_invalid",
                    "defect dimensions must be non-negative and confidence must be 0..=1",
                ));
            }
            let class_id = bkv_row_text(
                row,
                &[
                    "classid",
                    "defectclassid",
                    "typeid",
                    "class",
                    "defecttypeid",
                ],
            );
            let mapped_class_name = class_id
                .as_ref()
                .and_then(|id| defect_classes.get(id))
                .cloned();
            let original_name = mapped_class_name.clone().or_else(|| {
                bkv_row_text(
                    row,
                    &["defectname", "typename", "name", "defecttype", "type"],
                )
            });
            let defect_type = original_name
                .as_deref()
                .and_then(bkv_canonical_defect_type)
                .unwrap_or("review");
            let (mapped_severity, legacy_severity) =
                bkv_canonical_severity(bkv_row_text(row, &["severity", "level"]));
            let severity = if defect_type == "review" {
                "review"
            } else {
                mapped_severity
            };
            let provenance_json = json!({
                "source":"bkv","batchId":batch.batch_id,"contentId":batch.content_id,
                "rowRef": {
                    "t":"defect","k":legacy_id,"h":row.get("originalRowHash"),
                    "p":file.relative_path,"l":line + 1
                },
                "legacyClassId":class_id,
                "legacyName":original_name,
                "legacySeverity":legacy_severity,
                "legacyClassName":mapped_class_name
            })
            .to_string();
            if provenance_json.len() > BKV_MAX_PERSISTED_JSON_BYTES {
                return Err(BkvRejection::new(
                    "bkv_persisted_json_too_large",
                    "BKV defect provenance exceeds storage contract",
                ));
            }
            defects.push(db::BkvImportDefect {
                id: bkv_deterministic_id(
                    &batch.batch_id,
                    "production-defect",
                    "defect",
                    &legacy_id,
                    &file.relative_path,
                ),
                inspection_id: material.inspection_id.clone(),
                material_id: material.material_id.clone(),
                camera_id: format!("bkv-camera-{}", camera as i64),
                defect_type: defect_type.to_string(),
                severity: severity.to_string(),
                x_mm,
                y_mm,
                z_mm,
                width_mm,
                height_mm,
                depth_mm,
                confidence,
                provenance_json,
            });
        }
    }
    let manifest_json = serde_json::to_string(&json!({
        "batchId": batch.batch_id,
        "contentId": batch.content_id,
        "status": batch.status,
        "semanticDigest": batch.semantic_digest,
        "manifestPath": format!("{}/manifest.json", batch.batch_id),
        "manifestSha256": batch.manifest_sha256,
        "publicationSha256": batch.publication_sha256,
        "counts": {
            "normalizedFiles": batch.normalized.len(),
            "normalizedRows": batch.normalized.iter().map(|file| file.rows.len()).sum::<usize>(),
            "artifacts": artifacts.len(),
            "materials": materials.len(),
            "defects": defects.len()
        }
    }))
    .map_err(|error| {
        BkvRejection::new(
            "bkv_manifest_invalid",
            format!("manifest serialization: {error}"),
        )
    })?;
    if manifest_json.len() > BKV_MAX_PERSISTED_JSON_BYTES {
        return Err(BkvRejection::new(
            "bkv_summary_too_large",
            "BKV import summary exceeds storage contract",
        ));
    }
    Ok(db::BkvImportBatch {
        batch_id: batch.batch_id.clone(),
        content_id: batch.content_id.clone(),
        manifest_json,
        status: batch.status.clone(),
        materials,
        artifacts,
        defects,
    })
}

fn bkv_rejection_response(error: BkvRejection) -> Vec<u8> {
    let status = match error.code {
        "bkv_root_invalid" | "bkv_manifest_unavailable" | "bkv_file_unavailable" => {
            "503 Service Unavailable"
        }
        "bkv_batch_failed" | "bkv_partial_review_required" | "bkv_batch_id_collision" => {
            "409 Conflict"
        }
        _ => "422 Unprocessable Entity",
    };
    http_response(
        status,
        "application/json; charset=utf-8",
        &json!({"code":error.code,"error":error.code,"message":"BKV request could not be processed"}).to_string(),
    )
}

fn configured_bkv_root() -> Result<PathBuf, BkvRejection> {
    let value = env::var("STEEL_BKV_DATA_ROOT")
        .map_err(|_| BkvRejection::new("bkv_root_invalid", "STEEL_BKV_DATA_ROOT is required"))?;
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(BkvRejection::new(
            "bkv_root_invalid",
            "STEEL_BKV_DATA_ROOT must be absolute",
        ));
    }
    Ok(path)
}

pub(super) fn bkv_status_response(state: &ServiceState) -> Vec<u8> {
    let active = state.runtime.block_on(db::get_config(
        &state.database.connection,
        "bkv.active-batch",
    ));
    match active {
        Ok(None) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({"code":0,"active":false}).to_string(),
        ),
        Ok(Some(active)) => {
            let active_value: Value = serde_json::from_str(&active.value).unwrap_or(Value::Null);
            let batch_id = active_value
                .get("batchId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let batch = state
                .runtime
                .block_on(db::get_config(
                    &state.database.connection,
                    &format!("bkv.batch.{batch_id}"),
                ))
                .ok()
                .flatten();
            let replay = state
                .runtime
                .block_on(db::get_config(
                    &state.database.connection,
                    &format!("bkv.replay.{batch_id}"),
                ))
                .ok()
                .flatten();
            let batch_value = batch
                .and_then(|value| serde_json::from_str::<Value>(&value.value).ok())
                .unwrap_or(Value::Null);
            let replay_value = replay
                .and_then(|value| serde_json::from_str::<Value>(&value.value).ok())
                .unwrap_or(Value::Null);
            http_response("200 OK", "application/json; charset=utf-8", &json!({
                "code":0,
                "active":true,
                "activeBatch": {
                    "batchId": active_value.get("batchId"),
                    "contentId": active_value.get("contentId")
                },
                "batch": {
                    "batchId": batch_value.get("batchId"),
                    "contentId": batch_value.get("contentId"),
                    "status": batch_value.get("status"),
                    "counts": batch_value.get("counts")
                },
                "replay": {
                    "index": replay_value.get("index"),
                    "status": replay_value.get("status"),
                    "version": replay_value.get("version")
                }
            }).to_string())
        }
        Err(_) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({"code":"bkv_status_unavailable","error":"bkv_status_unavailable","message":"BKV status is unavailable"}).to_string(),
        ),
    }
}

pub(super) fn bkv_import_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let payload: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => {
            return bkv_rejection_response(BkvRejection::new(
                "bkv_import_request_invalid",
                "request must be JSON",
            ))
        }
    };
    let root = match configured_bkv_root() {
        Ok(root) => root,
        Err(error) => return bkv_rejection_response(error),
    };
    let requested = match payload
        .get("manifestPath")
        .or_else(|| payload.get("manifest_path"))
        .and_then(Value::as_str)
    {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => {
            return bkv_rejection_response(BkvRejection::new(
                "bkv_import_request_invalid",
                "manifestPath is required",
            ))
        }
    };
    let manifest_path = if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    };
    let reviewed = payload
        .get("operatorReviewedPartial")
        .or_else(|| payload.get("operator_reviewed_partial"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let first = match load_bkv_batch(&root, &manifest_path, reviewed) {
        Ok(batch) => batch,
        Err(error) => return bkv_rejection_response(error),
    };
    if let Err(error) = bkv_validated_to_db(&first) {
        return bkv_rejection_response(error);
    }
    let verified = match load_bkv_batch(&root, &manifest_path, reviewed) {
        Ok(batch) => batch,
        Err(error) => return bkv_rejection_response(error),
    };
    let db_batch = match bkv_validated_to_db(&verified) {
        Ok(batch) => batch,
        Err(error) => return bkv_rejection_response(error),
    };
    let final_verification = match load_bkv_batch(&root, &manifest_path, reviewed) {
        Ok(batch) => batch,
        Err(error) => return bkv_rejection_response(error),
    };
    let persisted_semantic_digest = serde_json::from_str::<Value>(&db_batch.manifest_json)
        .ok()
        .and_then(|value| {
            value
                .get("semanticDigest")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    if final_verification.content_id != db_batch.content_id
        || persisted_semantic_digest.as_deref() != Some(final_verification.semantic_digest.as_str())
    {
        return bkv_rejection_response(BkvRejection::new(
            "bkv_manifest_changed",
            "batch changed before transaction",
        ));
    }
    match state.runtime.block_on(db::import_bkv_batch(
        &state.database.connection,
        db_batch,
        actor,
    )) {
        Ok(result) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({
                "code":0,"batchId":result.batch_id,"contentId":result.content_id,
                "alreadyImported":result.already_imported,"counts":result.counts
            })
            .to_string(),
        ),
        Err(error) => {
            let message = error.to_string();
            let code = if message.contains("bkv_batch_id_collision") {
                "bkv_batch_id_collision"
            } else {
                "bkv_import_transaction_failed"
            };
            bkv_rejection_response(BkvRejection::new(code, "BKV transaction failed"))
        }
    }
}

pub(super) fn bkv_replay_reset_response(state: &ServiceState, actor: &str) -> Vec<u8> {
    match state
        .runtime
        .block_on(db::reset_bkv_replay(&state.database.connection, actor))
    {
        Ok(replay) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({"code":0,"replay":replay}).to_string(),
        ),
        Err(error) => {
            let message = error.to_string();
            let code = if message.contains("bkv_active_batch_missing") {
                "bkv_active_batch_missing"
            } else if message.contains("bkv_replay_state_missing") {
                "bkv_replay_state_missing"
            } else {
                "bkv_replay_reset_failed"
            };
            bkv_rejection_response(BkvRejection::new(code, message))
        }
    }
}

pub(super) fn bkv_deterministic_id(
    batch_id: &str,
    kind: &str,
    legacy_table: &str,
    legacy_id: &str,
    source_path: &str,
) -> String {
    let binding = format!("{batch_id}|{kind}|{legacy_table}|{legacy_id}|{source_path}");
    format!("{:x}", Sha256::digest(binding.as_bytes()))
}

fn queue_capacity() -> u64 {
    env::var("STEEL_PRODUCTION_TASK_QUEUE_CAPACITY")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(DEFAULT_QUEUE_CAPACITY)
        .clamp(1, MAX_QUEUE_CAPACITY)
}

fn normalize_kind(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "capture" | "capture-once" | "capture_once" => Some("capture-once"),
        "algorithm" | "algorithm-run" | "algorithm_run" => Some("algorithm-run"),
        "steel-info" | "steel_info" | "steelinfo" | "info" => Some("steel-info"),
        "steel-in" | "steel_in" | "steelin" | "in" => Some("steel-in"),
        "steel-out" | "steel_out" | "steelout" | "out" => Some("steel-out"),
        "trigger-event" | "trigger_event" | "triggerevent" | "event" => Some("trigger-event"),
        _ => None,
    }
}

fn valid_task_chain_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
}

fn normalize_dependency_policy(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "require-success" | "require_success" => Some("require-success"),
        "always-run" | "always_run" => Some("always-run"),
        _ => None,
    }
}

pub(super) fn queued_kind_for_route(method: &str, path: &str) -> Option<&'static str> {
    if method != "POST" {
        return None;
    }
    match path {
        "/api/production/tasks/steel-info" => Some("steel-info"),
        "/api/production/tasks/steel-in" => Some("steel-in"),
        "/api/production/tasks/steel-out" => Some("steel-out"),
        "/api/production/tasks/trigger-event" => Some("trigger-event"),
        _ => None,
    }
}

thread_local! {
    static WORKER_EXECUTION_DEPTH: Cell<u32> = const { Cell::new(0) };
}

struct WorkerExecutionScope;

impl WorkerExecutionScope {
    fn enter() -> Self {
        WORKER_EXECUTION_DEPTH.with(|depth| depth.set(depth.get().saturating_add(1)));
        Self
    }
}

impl Drop for WorkerExecutionScope {
    fn drop(&mut self) {
        WORKER_EXECUTION_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

pub(super) fn worker_execution_scope_active() -> bool {
    WORKER_EXECUTION_DEPTH.with(|depth| depth.get() > 0)
}

fn task_json(task: &production_task::Model) -> Value {
    let result = if task.result.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&task.result).unwrap_or_else(|_| json!(task.result))
    };
    json!({
        "id": task.id,
        "taskId": task.id,
        "idempotencyKey": task.idempotency_key,
        "kind": task.kind,
        "materialId": task.material_id,
        "sessionId": task.session_id,
        "chainId": task.chain_id,
        "dependsOnTaskId": if task.depends_on_task_id.is_empty() { Value::Null } else { json!(task.depends_on_task_id) },
        "dependencyPolicy": task.dependency_policy,
        "blockedReason": task.blocked_reason,
        "status": task.status,
        "phase": task.phase,
        "progress": task.progress,
        "attempts": task.attempts,
        "maxAttempts": task.max_attempts,
        "cancelRequested": task.cancel_requested,
        "result": result,
        "error": task.error,
        "actor": task.actor,
        "createdAt": task.created_at,
        "startedAt": task.started_at,
        "finishedAt": task.finished_at,
        "updatedAt": task.updated_at
    })
}

fn worker_json(state: &ServiceState) -> Value {
    let status = match state.production_task_worker_status.lock() {
        Ok(value) => value.clone(),
        Err(_) => {
            return json!({
                "running": false,
                "activeTaskId": "worker_status_unavailable",
                "lastHeartbeatAt": Value::Null,
                "heartbeatAgeMs": Value::Null,
                "lastError": "worker_status_unavailable",
                "recoveredTasks": Value::Null,
                "capacity": queue_capacity()
            });
        }
    };
    let now = current_time_millis();
    json!({
        "running": status.running,
        "activeTaskId": if status.current_task_id.is_empty() { Value::Null } else { json!(status.current_task_id) },
        "lastHeartbeatAt": status.last_heartbeat_at.to_string(),
        "heartbeatAgeMs": if status.last_heartbeat_at == 0 { 0 } else { now.saturating_sub(status.last_heartbeat_at) },
        "lastError": status.last_error,
        "recoveredTasks": status.recovered_tasks,
        "capacity": queue_capacity()
    })
}

pub(super) fn status_json(state: &ServiceState) -> Value {
    let queue_depth = state
        .runtime
        .block_on(db::count_open_production_tasks(&state.database.connection))
        .ok();
    let queue_depth_available = queue_depth.is_some();
    json!({
        "worker": worker_json(state),
        "queueDepth": queue_depth,
        "queueDepthAvailable": queue_depth_available,
        "capacity": queue_capacity()
    })
}

fn notify_worker(state: &ServiceState) {
    if let Ok(mut generation) = state.production_task_wakeup_generation.lock() {
        *generation = generation.wrapping_add(1);
        state.production_task_wakeup.notify_one();
    }
}

fn task_target(state: &ServiceState, payload: &Value) -> (String, String) {
    let latest_open = state
        .runtime
        .block_on(db::latest_open_material_session(&state.database.connection))
        .ok()
        .flatten();
    let requested_material_id = material_id_from_payload(payload, "");
    let latest_task = state
        .runtime
        .block_on(db::latest_unresolved_production_task(
            &state.database.connection,
            (!requested_material_id.is_empty()).then_some(requested_material_id.as_str()),
        ))
        .ok()
        .flatten();
    let material_id = if requested_material_id.is_empty() {
        latest_open
            .as_ref()
            .map(|session| session.material_id.clone())
            .or_else(|| latest_task.as_ref().map(|task| task.material_id.clone()))
            .unwrap_or_else(|| "unknown-material".to_string())
    } else {
        requested_material_id
    };
    let explicit_session_id = value_string(payload, &["sessionId", "session_id"]);
    let session_id = if explicit_session_id.is_empty() {
        latest_open
            .as_ref()
            .filter(|session| session.material_id == material_id)
            .map(|session| session.id.clone())
            .or_else(|| {
                latest_task
                    .as_ref()
                    .filter(|task| task.material_id == material_id)
                    .map(|task| task.session_id.clone())
            })
            .unwrap_or_else(|| session_id_from_payload(payload, &material_id))
    } else {
        explicit_session_id
    };
    (material_id, session_id)
}

fn task_admin_guard(state: &ServiceState) -> Result<std::sync::MutexGuard<'_, ()>, Vec<u8>> {
    state.production_task_admin_lock.lock().map_err(|_| {
        http_response(
            "503 Service Unavailable",
            "application/json; charset=utf-8",
            &json!({ "code": 503, "error": "production_task_admin_lock_poisoned" }).to_string(),
        )
    })
}

pub(super) fn enqueue_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let request = match serde_json::from_str::<Value>(body.trim()) {
        Ok(value) if value.is_object() => value,
        _ => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({ "code": 400, "error": "invalid_production_task_json" }).to_string(),
            );
        }
    };
    let Some(kind) = normalize_kind(&value_string(&request, &["kind", "type", "command"])) else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({
                "code": 400,
                "error": "unsupported_production_task_kind",
                "supportedKinds": [
                    "capture-once",
                    "algorithm-run",
                    "steel-info",
                    "steel-in",
                    "steel-out",
                    "trigger-event"
                ]
            })
            .to_string(),
        );
    };
    let payload = request.get("payload").cloned().unwrap_or_else(|| json!({}));
    if !payload.is_object() {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "production_task_payload_must_be_object" }).to_string(),
        );
    }
    let requested_chain_id = value_string(&request, &["chainId", "chain_id"]);
    let requested_dependency_id = value_string(
        &request,
        &["dependsOnTaskId", "depends_on_task_id", "dependsOn"],
    );
    if requested_dependency_id.len() > 128 {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "dependency_task_id_too_long" }).to_string(),
        );
    }
    let dependency_policy_value =
        value_string(&request, &["dependencyPolicy", "dependency_policy"]);
    let Some(dependency_policy) = normalize_dependency_policy(&dependency_policy_value) else {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({
                "code": 400,
                "error": "invalid_dependency_policy",
                "supportedPolicies": ["require-success", "always-run"]
            })
            .to_string(),
        );
    };
    if dependency_policy == "always-run" && kind != "trigger-event" {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({
                "code": 400,
                "error": "always_run_not_allowed_for_safety_critical_task",
                "kind": kind
            })
            .to_string(),
        );
    }
    let raw_key = value_string(
        &request,
        &[
            "idempotencyKey",
            "idempotency_key",
            "requestId",
            "request_id",
        ],
    );
    if raw_key.len() > 160 {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "idempotency_key_too_long" }).to_string(),
        );
    }
    let payload_text = payload.to_string();
    let _admin_guard = match task_admin_guard(state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };
    let compound_key = if raw_key.trim().is_empty() {
        String::new()
    } else {
        format!("{kind}:{}", raw_key.trim())
    };
    if !compound_key.is_empty() {
        match state
            .runtime
            .block_on(db::find_production_task_by_idempotency_key(
                &state.database.connection,
                &compound_key,
            )) {
            Ok(Some(existing)) => {
                if existing.kind != kind
                    || existing.payload != payload_text
                    || (!requested_chain_id.is_empty() && existing.chain_id != requested_chain_id)
                    || (!requested_dependency_id.is_empty()
                        && existing.depends_on_task_id != requested_dependency_id)
                    || (!dependency_policy_value.is_empty()
                        && existing.dependency_policy != dependency_policy)
                {
                    return http_response(
                        "409 Conflict",
                        "application/json; charset=utf-8",
                        &json!({
                            "code": 409,
                            "error": "idempotency_conflict",
                            "task": task_json(&existing)
                        })
                        .to_string(),
                    );
                }
                return http_response(
                    "200 OK",
                    "application/json; charset=utf-8",
                    &json!({ "code": 0, "duplicate": true, "task": task_json(&existing) })
                        .to_string(),
                );
            }
            Ok(None) => {}
            Err(error) => {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &json!({ "code": 500, "error": error.to_string() }).to_string(),
                );
            }
        }
    }
    if runtime_is_draining(state) && kind != "steel-out" {
        return http_response(
            "503 Service Unavailable",
            "application/json; charset=utf-8",
            &json!({
                "code": 503,
                "error": "runtime_draining",
                "kind": kind,
                "admission": runtime_drain_status_json(state)
            })
            .to_string(),
        );
    }
    // Replays must return the persisted task even if the surrounding production session has
    // since advanced. Production state is deliberately validated by the FIFO worker at execution
    // time so steel-in, capture, algorithm and steel-out can be accepted as one ordered chain.
    let open_tasks = match state
        .runtime
        .block_on(db::count_open_production_tasks(&state.database.connection))
    {
        Ok(count) => count,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            );
        }
    };
    if open_tasks >= queue_capacity() {
        return http_response(
            "429 Too Many Requests",
            "application/json; charset=utf-8",
            &json!({
                "code": 429,
                "error": "production_task_queue_full",
                "queueDepth": open_tasks,
                "capacity": queue_capacity()
            })
            .to_string(),
        );
    }
    let sequence = state
        .production_task_sequence
        .fetch_add(1, Ordering::Relaxed);
    let task_id = format!("TASK-{}-{sequence:020}", current_time_millis());
    let stored_key = if compound_key.is_empty() {
        format!("{kind}:{task_id}")
    } else {
        compound_key
    };
    let (material_id, session_id) = task_target(state, &payload);
    if !requested_chain_id.is_empty() && !valid_task_chain_id(&requested_chain_id) {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "invalid_production_chain_id" }).to_string(),
        );
    }
    let latest_session_task = match state
        .runtime
        .block_on(db::latest_production_task_for_session(
            &state.database.connection,
            &session_id,
        )) {
        Ok(task) => task,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            );
        }
    };
    let chain_id = if requested_chain_id.is_empty() {
        latest_session_task
            .as_ref()
            .map(|task| task.chain_id.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| session_id.clone())
    } else {
        requested_chain_id.clone()
    };
    if latest_session_task
        .as_ref()
        .is_some_and(|task| !task.chain_id.is_empty() && task.chain_id != chain_id)
    {
        return http_response(
            "409 Conflict",
            "application/json; charset=utf-8",
            &json!({
                "code": 409,
                "error": "production_session_chain_mismatch",
                "existingChainId": latest_session_task.as_ref().map(|task| task.chain_id.clone()),
                "requestedChainId": chain_id
            })
            .to_string(),
        );
    }
    let depends_on_task_id = if !requested_dependency_id.is_empty() {
        requested_dependency_id.clone()
    } else if kind == "trigger-event" {
        String::new()
    } else {
        match state.runtime.block_on(db::latest_production_task_in_chain(
            &state.database.connection,
            &chain_id,
        )) {
            Ok(Some(task)) => task.id,
            Ok(None) => String::new(),
            Err(error) => {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &json!({ "code": 500, "error": error.to_string() }).to_string(),
                );
            }
        }
    };
    if !depends_on_task_id.is_empty() {
        let dependency = match state.runtime.block_on(db::find_production_task(
            &state.database.connection,
            &depends_on_task_id,
        )) {
            Ok(Some(task)) => task,
            Ok(None) => {
                return http_response(
                    "409 Conflict",
                    "application/json; charset=utf-8",
                    &json!({
                        "code": 409,
                        "error": "production_task_dependency_not_found",
                        "dependsOnTaskId": depends_on_task_id
                    })
                    .to_string(),
                );
            }
            Err(error) => {
                return http_response(
                    "500 Internal Server Error",
                    "application/json; charset=utf-8",
                    &json!({ "code": 500, "error": error.to_string() }).to_string(),
                );
            }
        };
        if dependency.chain_id != chain_id
            || dependency.session_id != session_id
            || dependency.material_id != material_id
        {
            return http_response(
                "409 Conflict",
                "application/json; charset=utf-8",
                &json!({
                    "code": 409,
                    "error": "production_task_dependency_chain_mismatch",
                    "dependsOnTaskId": dependency.id
                })
                .to_string(),
            );
        }
    }
    let max_attempts = request
        .get("maxAttempts")
        .or_else(|| request.get("max_attempts"))
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 10) as i32;
    let task = match state.runtime.block_on(db::insert_production_task(
        &state.database.connection,
        db::ProductionTaskInput {
            id: task_id,
            idempotency_key: stored_key,
            kind: kind.to_string(),
            material_id,
            session_id,
            chain_id,
            depends_on_task_id,
            dependency_policy: dependency_policy.to_string(),
            payload: payload_text,
            actor: actor.to_string(),
            max_attempts,
        },
    )) {
        Ok(task) => task,
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            );
        }
    };
    let _ = state.runtime.block_on(db::append_audit_log(
        &state.database.connection,
        actor,
        "production.task.enqueue",
        &task.id,
        &format!("queued {} for {}", task.kind, task.material_id),
        "info",
    ));
    notify_worker(state);
    http_response(
        "202 Accepted",
        "application/json; charset=utf-8",
        &json!({ "code": 0, "duplicate": false, "task": task_json(&task) }).to_string(),
    )
}

pub(super) fn enqueue_kind_response(
    state: &ServiceState,
    kind: &str,
    body: &str,
    actor: &str,
) -> Vec<u8> {
    let payload = match serde_json::from_str::<Value>(body.trim()) {
        Ok(value) if value.is_object() => value,
        _ => {
            return http_response(
                "400 Bad Request",
                "application/json; charset=utf-8",
                &json!({ "code": 400, "error": "invalid_production_task_payload" }).to_string(),
            );
        }
    };
    let idempotency_key = value_string(
        &payload,
        &[
            "idempotencyKey",
            "idempotency_key",
            "requestId",
            "request_id",
        ],
    );
    let max_attempts = payload
        .get("maxAttempts")
        .or_else(|| payload.get("max_attempts"))
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 10);
    let chain_id = value_string(&payload, &["chainId", "chain_id"]);
    let depends_on_task_id = value_string(
        &payload,
        &["dependsOnTaskId", "depends_on_task_id", "dependsOn"],
    );
    let dependency_policy = value_string(&payload, &["dependencyPolicy", "dependency_policy"]);
    enqueue_response(
        state,
        &json!({
            "kind": kind,
            "idempotencyKey": idempotency_key,
            "maxAttempts": max_attempts,
            "chainId": chain_id,
            "dependsOnTaskId": depends_on_task_id,
            "dependencyPolicy": dependency_policy,
            "payload": payload
        })
        .to_string(),
        actor,
    )
}

pub(super) fn list_response(state: &ServiceState, query: &str) -> Vec<u8> {
    let limit = query_value(query, "limit").and_then(|value| value.parse::<u64>().ok());
    let offset = query_value(query, "offset")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    match state.runtime.block_on(db::list_production_tasks(
        &state.database.connection,
        db::ProductionTaskFilter {
            status: query_value(query, "status"),
            kind: query_value(query, "kind"),
            limit,
            offset: Some(offset),
        },
    )) {
        Ok(page) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({
                "code": 0,
                "total": page.total,
                "limit": page.limit,
                "offset": page.offset,
                "tasks": page.tasks.iter().map(task_json).collect::<Vec<_>>(),
                "taskWorker": worker_json(state)
            })
            .to_string(),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        ),
    }
}

pub(super) fn detail_response(state: &ServiceState, query: &str) -> Vec<u8> {
    let id = query_value(query, "id").unwrap_or_default();
    if id.trim().is_empty() {
        return http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "production_task_id_required" }).to_string(),
        );
    }
    match state.runtime.block_on(db::find_production_task(
        &state.database.connection,
        id.trim(),
    )) {
        Ok(Some(task)) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &json!({ "code": 0, "task": task_json(&task) }).to_string(),
        ),
        Ok(None) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            &json!({ "code": 404, "error": "production_task_not_found" }).to_string(),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        ),
    }
}

fn task_id_from_body(body: &str) -> Result<String, Vec<u8>> {
    let payload = serde_json::from_str::<Value>(body.trim()).map_err(|_| {
        http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "invalid_production_task_action_json" }).to_string(),
        )
    })?;
    let id = value_string(&payload, &["taskId", "task_id", "id"]);
    if id.trim().is_empty() {
        Err(http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "production_task_id_required" }).to_string(),
        ))
    } else {
        Ok(id)
    }
}

pub(super) fn cancel_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let id = match task_id_from_body(body) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let _admin_guard = match task_admin_guard(state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };
    let existing = match state
        .runtime
        .block_on(db::find_production_task(&state.database.connection, &id))
    {
        Ok(Some(task)) => task,
        Ok(None) => {
            return http_response(
                "404 Not Found",
                "application/json; charset=utf-8",
                &json!({ "code": 404, "error": "production_task_not_found" }).to_string(),
            );
        }
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            );
        }
    };
    if matches!(
        existing.status.as_str(),
        "succeeded" | "failed" | "cancelled" | "interrupted" | "blocked"
    ) {
        return http_response(
            "409 Conflict",
            "application/json; charset=utf-8",
            &json!({
                "code": 409,
                "error": "production_task_is_terminal",
                "task": task_json(&existing)
            })
            .to_string(),
        );
    }
    match state.runtime.block_on(db::request_cancel_production_task(
        &state.database.connection,
        &id,
    )) {
        Ok(Some(task)) => {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "production.task.cancel",
                &task.id,
                "cancellation requested",
                "warning",
            ));
            notify_worker(state);
            http_response(
                if task.status == "running" {
                    "202 Accepted"
                } else {
                    "200 OK"
                },
                "application/json; charset=utf-8",
                &json!({ "code": 0, "task": task_json(&task) }).to_string(),
            )
        }
        Ok(None) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            &json!({ "code": 404, "error": "production_task_not_found" }).to_string(),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        ),
    }
}

pub(super) fn retry_response(state: &ServiceState, body: &str, actor: &str) -> Vec<u8> {
    let id = match task_id_from_body(body) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let _admin_guard = match task_admin_guard(state) {
        Ok(guard) => guard,
        Err(response) => return response,
    };
    let existing = match state
        .runtime
        .block_on(db::find_production_task(&state.database.connection, &id))
    {
        Ok(Some(task)) => task,
        Ok(None) => {
            return http_response(
                "404 Not Found",
                "application/json; charset=utf-8",
                &json!({ "code": 404, "error": "production_task_not_found" }).to_string(),
            );
        }
        Err(error) => {
            return http_response(
                "500 Internal Server Error",
                "application/json; charset=utf-8",
                &json!({ "code": 500, "error": error.to_string() }).to_string(),
            );
        }
    };
    if !matches!(
        existing.status.as_str(),
        "failed" | "cancelled" | "interrupted" | "blocked"
    ) {
        return http_response(
            "409 Conflict",
            "application/json; charset=utf-8",
            &json!({
                "code": 409,
                "error": "production_task_not_retryable",
                "task": task_json(&existing)
            })
            .to_string(),
        );
    }
    match state
        .runtime
        .block_on(db::retry_production_task(&state.database.connection, &id))
    {
        Ok(Some(task)) => {
            if task.status == "blocked" {
                return http_response(
                    "409 Conflict",
                    "application/json; charset=utf-8",
                    &json!({
                        "code": 409,
                        "error": "production_task_dependency_unresolved",
                        "task": task_json(&task)
                    })
                    .to_string(),
                );
            }
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                actor,
                "production.task.retry",
                &task.id,
                &format!("explicit retry after {} attempt(s)", task.attempts),
                "warning",
            ));
            notify_worker(state);
            http_response(
                "202 Accepted",
                "application/json; charset=utf-8",
                &json!({ "code": 0, "task": task_json(&task) }).to_string(),
            )
        }
        Ok(None) => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            &json!({ "code": 404, "error": "production_task_not_found" }).to_string(),
        ),
        Err(error) => http_response(
            "500 Internal Server Error",
            "application/json; charset=utf-8",
            &json!({ "code": 500, "error": error.to_string() }).to_string(),
        ),
    }
}

pub(super) fn response_body(response: &[u8]) -> String {
    response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| String::from_utf8_lossy(&response[index + 4..]).to_string())
        .unwrap_or_else(|| String::from_utf8_lossy(response).to_string())
}

fn response_succeeded(response: &[u8], body: &str) -> bool {
    let status_ok = String::from_utf8_lossy(response)
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .map(|status| (200..300).contains(&status))
        .unwrap_or(false);
    if !status_ok {
        return false;
    }
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("code").and_then(Value::as_i64))
        .map(|code| code == 0)
        .unwrap_or(true)
}

fn response_error(response: &[u8], body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| {
            String::from_utf8_lossy(response)
                .lines()
                .next()
                .unwrap_or("production task failed")
                .to_string()
        })
}

fn response_cooperatively_cancelled(body: &str) -> bool {
    serde_json::from_str::<Value>(body)
        .ok()
        .map(|value| {
            value
                .get("cooperativeCancellation")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || value
                    .get("algorithm")
                    .and_then(|algorithm| algorithm.get("cooperativeCancellation"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn production_event_payload(task: &production_task::Model) -> String {
    let mut payload = serde_json::from_str::<Value>(&task.payload).unwrap_or_else(|_| json!({}));
    let missing_material_id = material_id_from_payload(&payload, "").is_empty();
    let missing_session_id = value_string(&payload, &["sessionId", "session_id"]).is_empty();
    let Some(object) = payload.as_object_mut() else {
        return task.payload.clone();
    };
    if missing_material_id {
        object.insert("materialId".to_string(), json!(task.material_id));
    }
    if missing_session_id {
        object.insert("sessionId".to_string(), json!(task.session_id));
    }
    payload.to_string()
}

pub(super) fn execute_task(state: &ServiceState, task: &production_task::Model) -> Vec<u8> {
    let _execution_scope = WorkerExecutionScope::enter();
    let cancellation_requested = || {
        runtime_is_draining(state)
            || state
                .runtime
                .block_on(db::find_production_task(
                    &state.database.connection,
                    &task.id,
                ))
                .ok()
                .flatten()
                .map(|item| item.cancel_requested)
                .unwrap_or(false)
    };
    match task.kind.as_str() {
        "capture-once" => write_production_capture_once_response(state, &task.payload, &task.actor),
        "algorithm-run" => {
            let payload =
                serde_json::from_str::<Value>(&task.payload).unwrap_or_else(|_| json!({}));
            if value_string(&payload, &["operation", "operationType"]) == "calibration-capture-fit"
            {
                write_production_calibration_capture_fit_response(
                    state,
                    &task.payload,
                    &task.actor,
                    Some(&cancellation_requested),
                )
            } else {
                write_production_algorithm_run_response(
                    state,
                    &task.payload,
                    &task.actor,
                    Some(&cancellation_requested),
                )
            }
        }
        "steel-info" | "steel-in" | "steel-out" | "trigger-event" => {
            let payload = production_event_payload(task);
            write_production_event_response(state, &payload, &task.kind, &task.actor)
        }
        _ => http_response(
            "400 Bad Request",
            "application/json; charset=utf-8",
            &json!({ "code": 400, "error": "unsupported_production_task_kind" }).to_string(),
        ),
    }
}

pub(super) fn provider_terminal_outcome(
    response: &[u8],
    body: &str,
) -> (&'static str, i32, String) {
    if response_succeeded(response, body) {
        ("succeeded", 100, String::new())
    } else {
        ("failed", 100, response_error(response, body))
    }
}

fn dispatch_phase(kind: &str) -> &'static str {
    match kind {
        "capture-once" => "dispatching-capture-provider",
        "algorithm-run" => "dispatching-algorithm",
        "steel-info" => "dispatching-steel-info",
        "steel-in" => "dispatching-steel-in",
        "steel-out" => "dispatching-steel-out",
        "trigger-event" => "dispatching-trigger-event",
        _ => "dispatching-production-operation",
    }
}

fn persist_task_checkpoint(
    state: &ServiceState,
    task: &production_task::Model,
    phase: &str,
    progress: i32,
) {
    if let Err(error) = state.runtime.block_on(db::update_production_task_progress(
        &state.database.connection,
        &task.id,
        phase,
        progress,
    )) {
        set_worker_status(state, true, Some(&task.id), Some(error.to_string()));
    }
}

fn set_worker_status(
    state: &ServiceState,
    running: bool,
    current_task_id: Option<&str>,
    last_error: Option<String>,
) {
    if let Ok(mut status) = state.production_task_worker_status.lock() {
        status.running = running;
        status.last_heartbeat_at = current_time_millis();
        if let Some(id) = current_task_id {
            status.current_task_id = id.to_string();
        } else {
            status.current_task_id.clear();
        }
        if let Some(error) = last_error {
            status.last_error = error;
        }
    }
}

fn wait_for_work(state: &ServiceState) {
    if let Ok(generation) = state.production_task_wakeup_generation.lock() {
        let observed = *generation;
        let _ = state.production_task_wakeup.wait_timeout_while(
            generation,
            Duration::from_millis(500),
            |value| *value == observed,
        );
    } else {
        std::thread::sleep(Duration::from_millis(500));
    }
}

fn worker_loop(state: Arc<ServiceState>) {
    set_worker_status(&state, true, None, None);
    loop {
        set_worker_status(&state, true, None, None);
        let claimed = state
            .runtime
            .block_on(db::claim_next_production_task(&state.database.connection));
        let task = match claimed {
            Ok(Some(task)) => task,
            Ok(None) => {
                wait_for_work(&state);
                continue;
            }
            Err(error) => {
                set_worker_status(&state, true, None, Some(error.to_string()));
                wait_for_work(&state);
                continue;
            }
        };
        set_worker_status(&state, true, Some(&task.id), None);
        persist_task_checkpoint(&state, &task, "waiting-command-lane", 10);
        let latest = state
            .runtime
            .block_on(db::find_production_task(
                &state.database.connection,
                &task.id,
            ))
            .ok()
            .flatten();
        if latest
            .as_ref()
            .map(|item| item.cancel_requested)
            .unwrap_or(false)
        {
            let _ = state.runtime.block_on(db::finish_production_task(
                &state.database.connection,
                &task.id,
                "cancelled",
                0,
                String::new(),
                "cancelled before dispatch".to_string(),
            ));
            continue;
        }
        let response = match state.production_command_lock.lock() {
            Ok(_command_guard) => {
                let cancelled = state
                    .runtime
                    .block_on(db::find_production_task(
                        &state.database.connection,
                        &task.id,
                    ))
                    .ok()
                    .flatten()
                    .map(|item| item.cancel_requested)
                    .unwrap_or(false);
                if cancelled {
                    None
                } else {
                    persist_task_checkpoint(&state, &task, dispatch_phase(&task.kind), 25);
                    Some(execute_task(&state, &task))
                }
            }
            Err(_) => Some(http_response(
                "503 Service Unavailable",
                "application/json; charset=utf-8",
                &json!({ "code": 503, "error": "production_command_lock_poisoned" }).to_string(),
            )),
        };
        let Some(response) = response else {
            let _ = state.runtime.block_on(db::finish_production_task(
                &state.database.connection,
                &task.id,
                "cancelled",
                0,
                String::new(),
                "cancelled before dispatch".to_string(),
            ));
            continue;
        };
        persist_task_checkpoint(&state, &task, "finalizing-result", 90);
        let body = response_body(&response);
        let cancellation_requested = state
            .runtime
            .block_on(db::find_production_task(
                &state.database.connection,
                &task.id,
            ))
            .ok()
            .flatten()
            .map(|item| item.cancel_requested)
            .unwrap_or(false);
        // A running provider call cannot currently be interrupted. Once dispatch has crossed that
        // boundary, its real result remains authoritative; cancel_requested records the late intent
        // instead of falsely claiming that a completed camera side effect was cancelled.
        let cooperative_cancellation = response_cooperatively_cancelled(&body);
        let (status, progress, error) = if cooperative_cancellation {
            (
                "cancelled",
                100,
                if runtime_is_draining(&state) && !cancellation_requested {
                    "cancelled during runtime drain at interruptible algorithm computation"
                        .to_string()
                } else {
                    "cancelled during interruptible algorithm computation".to_string()
                },
            )
        } else {
            provider_terminal_outcome(&response, &body)
        };
        if cancellation_requested && !cooperative_cancellation {
            let _ = state.runtime.block_on(db::append_audit_log(
                &state.database.connection,
                &task.actor,
                "production.task.cancel_too_late",
                &task.id,
                &format!("provider completed with terminal status {status}"),
                "warning",
            ));
        }
        if let Err(error) = state.runtime.block_on(db::finish_production_task(
            &state.database.connection,
            &task.id,
            status,
            progress,
            body,
            error,
        )) {
            set_worker_status(&state, true, Some(&task.id), Some(error.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn bkv_test_root(name: &str) -> PathBuf {
        let root = env::temp_dir().join(format!(
            "steel-bkv-{name}-{}-{}",
            std::process::id(),
            current_time_millis()
        ));
        fs::create_dir_all(&root).expect("create BKV test root");
        root
    }

    fn write_bkv_test_batch(root: &Path, status: &str, review_required: bool) -> PathBuf {
        let batch = root.join("batch-001");
        fs::create_dir_all(batch.join("normalized")).expect("normalized directory");
        fs::create_dir_all(batch.join("artifacts/camera1/1893700/2d")).expect("artifact directory");
        fs::create_dir_all(batch.join("artifacts/camera1/1893700/metadata"))
            .expect("metadata directory");
        let mut normalized = Vec::new();
        for table in [
            "allexcel",
            "checkrecord",
            "defect",
            "defectclass",
            "diameter",
        ] {
            let relative = format!("normalized/{table}.jsonl");
            let payload = if table == "allexcel" {
                (1_893_700..=1_893_710)
                    .map(|seq| format!(r#"{{"legacySeqNo":{seq},"legacyTable":"allexcel","originalRowHash":"{:064x}","width":100,"length":12000,"thickness":10,"steelGrade":"Q235"}}"#, seq) + "\n")
                    .collect::<String>()
            } else {
                String::new()
            };
            fs::write(batch.join(&relative), payload.as_bytes()).expect("write normalized");
            normalized.push(json!({
                "table": table,
                "path": relative,
                "size": payload.len(),
                "sha256": bkv_sha256(payload.as_bytes()),
                "count": if table == "allexcel" { 11 } else { 0 },
                "evidenceStatus": "verified",
                "error": Value::Null
            }));
        }
        let artifact_relative = "artifacts/camera1/1893700/2d/one.jpg";
        let metadata_relative = "artifacts/camera1/1893700/metadata/camera.dat";
        fs::write(batch.join(artifact_relative), b"jpeg").expect("write artifact");
        fs::write(batch.join(metadata_relative), b"camera-metadata").expect("write metadata");
        let seq_nos = (1_893_700..=1_893_710).collect::<Vec<_>>();
        let manifest = json!({
            "schema": "steel.bkv-import-manifest.v1",
            "batchId": "batch-001",
            "status": status,
            "importEligible": status == "ready",
            "batchContentId": "0".repeat(64),
            "contentId": "0".repeat(64),
            "reviewRequired": review_required,
            "seqNos": seq_nos,
            "targetCoverageComplete": status == "ready",
            "databaseIntegrity": {
                "allInventoryMembersVerified": status == "ready",
                "normalizationIntegrity": if status == "ready" { "ok" } else { "partial-crc-error" },
                "diameterComplete": status == "ready",
                "parseRejectedStatements": 0
            },
            "counts": {"rejectedNormalizedRows": 0},
            "sourceArchives": {
                "database-zip": {"size": 1, "sha256": "1".repeat(64)},
                "image-part1": {"size": 1, "sha256": "2".repeat(64)},
                "image-part2": {"size": 1, "sha256": "3".repeat(64)}
            },
            "normalizationEvidence": {"sha256": "4".repeat(64)},
            "normalizationResultEvidence": {},
            "normalized": normalized,
            "artifacts": [{
                "path": artifact_relative,
                "memberPath": "image_copy/CamImageSource1/1893700/2D/one.jpg",
                "size": 4,
                "sha256": bkv_sha256(b"jpeg"),
                "cameraNumber": 1,
                "seqNo": 1893700,
                "kind": "2d",
                "extension": ".jpg"
            }, {
                "path": metadata_relative,
                "memberPath": "image_copy/CamImageSource1/1893700/3D/camera.dat",
                "size": 15,
                "sha256": bkv_sha256(b"camera-metadata"),
                "cameraNumber": 1,
                "seqNo": 1893700,
                "kind": "metadata",
                "extension": ".dat"
            }]
        });
        let content_id = bkv_batch_content_id(&manifest).expect("content id");
        let mut manifest = manifest;
        manifest["batchContentId"] = json!(content_id);
        manifest["contentId"] = manifest["batchContentId"].clone();
        let path = batch.join("manifest.json");
        fs::write(
            &path,
            serde_json::to_vec(&manifest).expect("serialize manifest"),
        )
        .expect("write manifest");
        fs::write(
            batch.join("publication.json"),
            serde_json::to_vec(&json!({
                "schema":"steel.bkv-publication.v1","state":"committed",
                "batchId":"batch-001","contentId":manifest["contentId"]
            }))
            .expect("serialize publication marker"),
        )
        .expect("write publication marker");
        path
    }

    #[test]
    fn bkv_import_ids_are_deterministic_sha256_bindings() {
        let first = bkv_deterministic_id(
            "batch-001",
            "inspection",
            "checkrecord",
            "legacy-42",
            "normalized/checkrecord.jsonl",
        );
        let second = bkv_deterministic_id(
            "batch-001",
            "inspection",
            "checkrecord",
            "legacy-42",
            "normalized/checkrecord.jsonl",
        );
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(
            first,
            bkv_deterministic_id(
                "batch-001",
                "inspection",
                "checkrecord",
                "legacy-43",
                "normalized/checkrecord.jsonl",
            )
        );
    }

    #[test]
    fn bkv_import_content_binding_rejects_malformed_hashes_and_members() {
        let root = bkv_test_root("binding");
        let path = write_bkv_test_batch(&root, "ready", false);
        let mut manifest: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        manifest["normalizationEvidence"]["sha256"] = json!("bad");
        assert_eq!(
            bkv_batch_content_id(&manifest).unwrap_err().code,
            "bkv_manifest_invalid"
        );
        manifest["normalizationEvidence"]["sha256"] = json!("4".repeat(64));
        manifest["artifacts"][0]["memberPath"] = json!("../escape.jpg");
        assert_eq!(
            bkv_batch_content_id(&manifest).unwrap_err().code,
            "bkv_manifest_invalid"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_import_requires_each_normalized_table_exactly_once() {
        let root = bkv_test_root("tables");
        let path = write_bkv_test_batch(&root, "ready", false);
        let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        manifest["normalized"].as_array_mut().unwrap().pop();
        fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(
            load_bkv_batch(&root, &path, false).unwrap_err().code,
            "bkv_normalized_table_invalid"
        );
        fs::remove_dir_all(root).ok();
    }

    fn defect_row(class_id: &str, original_name: &str) -> Value {
        json!({
            "legacySeqNo":1893700,"legacyTable":"defect","originalRowHash":format!("hash-{class_id}"),
            "classId":class_id,"defectName":original_name,"camera":1,
            "x":1.0,"y":2.0,"z":-0.1,"width":3.0,"height":4.0,"depth":0.5,
            "confidence":0.8
        })
    }

    #[test]
    fn bkv_import_rejects_missing_or_out_of_range_defect_measurements() {
        let root = bkv_test_root("defect-invalid");
        let path = write_bkv_test_batch(&root, "ready", false);
        let mut batch = load_bkv_batch(&root, &path, false).unwrap();
        let defect_file = batch
            .normalized
            .iter_mut()
            .find(|file| file.table == "defect")
            .unwrap();
        let mut invalid = defect_row("7", "凹坑");
        invalid.as_object_mut().unwrap().remove("camera");
        defect_file.rows.push(invalid);
        assert_eq!(
            bkv_validated_to_db(&batch).unwrap_err().code,
            "bkv_defect_invalid"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_import_maps_defectclass_and_preserves_unknown_names_for_review() {
        let root = bkv_test_root("defect-map");
        let path = write_bkv_test_batch(&root, "ready", false);
        let mut batch = load_bkv_batch(&root, &path, false).unwrap();
        batch
            .normalized
            .iter_mut()
            .find(|file| file.table == "defectclass")
            .unwrap()
            .rows
            .push(json!({
                "legacySeqNo":1893700,"legacyTable":"defectclass","id":"7","name":"凹坑",
                "originalRowHash":"class-hash"
            }));
        let defect_file = batch
            .normalized
            .iter_mut()
            .find(|file| file.table == "defect")
            .unwrap();
        let mut large_legacy_row = defect_row("7", "legacy-pit");
        large_legacy_row["unusedLegacyBlob"] = json!("x".repeat(65_536));
        defect_file.rows.push(large_legacy_row);
        defect_file.rows.push(defect_row("99", "神秘缺陷"));
        let imported = bkv_validated_to_db(&batch).unwrap();
        assert_eq!(imported.defects[0].defect_type, "pit");
        assert_eq!(imported.defects[1].defect_type, "review");
        assert_eq!(imported.defects[1].severity, "review");
        assert!(imported.defects[1].provenance_json.contains("神秘缺陷"));
        assert!(imported.defects[0].provenance_json.contains("凹坑"));
        assert!(imported.defects[0].provenance_json.len() < 60 * 1024);
        assert!(!imported.defects[0]
            .provenance_json
            .contains(&"x".repeat(1024)));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_capture_metadata_path_is_verified_file_and_provenance_is_centralized() {
        let root = bkv_test_root("metadata-path");
        let path = write_bkv_test_batch(&root, "ready", false);
        let batch = load_bkv_batch(&root, &path, false).unwrap();
        let imported = bkv_validated_to_db(&batch).unwrap();
        assert_eq!(
            imported.artifacts[0].metadata_path,
            "bkv://batch-001/artifacts/camera1/1893700/metadata/camera.dat"
        );
        assert!(!imported.artifacts[0].metadata_path.starts_with('{'));
        assert!(imported.materials[0]
            .raw_payload
            .contains("artifactProvenance"));
        assert!(imported.materials[0]
            .raw_payload
            .contains("image_copy/CamImageSource1/1893700/2D/one.jpg"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_severity_is_canonical_and_unknown_values_require_review() {
        for (input, expected) in [
            (Some("严重".to_string()), "severe"),
            (Some("3".to_string()), "severe"),
            (Some("待复核".to_string()), "review"),
            (Some("2".to_string()), "review"),
            (Some("轻微".to_string()), "minor"),
            (Some("1".to_string()), "minor"),
            (Some("legacy-unknown".to_string()), "review"),
            (None, "review"),
        ] {
            let (canonical, legacy) = bkv_canonical_severity(input.clone());
            assert_eq!(canonical, expected);
            assert_eq!(legacy, input);
        }
    }

    #[test]
    fn bkv_batch_id_fits_the_app_config_key_contract() {
        assert!(bkv_valid_batch_id(&"a".repeat(118)));
        assert!(!bkv_valid_batch_id(&"a".repeat(119)));
        assert!(!bkv_valid_batch_id("unsafe/path"));
    }

    #[test]
    fn bkv_persisted_summary_and_row_provenance_fit_mysql_text() {
        let root = bkv_test_root("compact-storage");
        let path = write_bkv_test_batch(&root, "ready", false);
        let mut batch = load_bkv_batch(&root, &path, false).unwrap();
        let template = batch.artifacts[0].clone();
        batch.artifacts.clear();
        for index in 0..2_724 {
            let mut artifact = template.clone();
            artifact.seq_no = BKV_TARGET_SEQ_NOS[index % BKV_TARGET_SEQ_NOS.len()];
            artifact.relative_path = format!("artifacts/c1/{}/{index}.d3img", artifact.seq_no);
            artifact.member_path = format!("legacy/{index}.d3img");
            artifact.sha256 = bkv_sha256(artifact.member_path.as_bytes());
            batch.artifacts.push(artifact);
        }
        let imported = bkv_validated_to_db(&batch).unwrap();
        assert!(imported.manifest_json.len() < 64 * 1024);
        assert!(imported
            .materials
            .iter()
            .all(|material| material.raw_payload.len() < 64 * 1024));
        assert!(!imported.manifest_json.contains("sourceArchives"));
        assert!(imported.manifest_json.contains("semanticDigest"));
        assert_eq!(imported.artifacts.len(), 2_724);
        let provenance: Value = serde_json::from_str(&imported.materials[0].raw_payload).unwrap();
        let row = &provenance["rowRefs"][0];
        assert!(row.get("t").and_then(Value::as_str).is_some());
        assert!(row.get("k").and_then(Value::as_str).is_some());
        assert!(row.get("h").and_then(Value::as_str).is_some());
        assert!(row.get("p").and_then(Value::as_str).is_some());
        assert!(row.get("l").and_then(Value::as_u64).is_some());
        let artifact = &provenance["artifactProvenance"][0];
        for key in ["p", "m", "h", "c", "s", "k"] {
            assert!(
                artifact.get(key).is_some(),
                "missing artifact provenance {key}"
            );
        }
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_rejection_response_never_exposes_internal_paths_or_errors() {
        let response = String::from_utf8(bkv_rejection_response(BkvRejection::new(
            "bkv_file_unavailable",
            r#"C:\secret\batch\manifest.json: access denied"#,
        )))
        .unwrap();
        assert!(response.contains("bkv_file_unavailable"));
        assert!(!response.contains("C:\\secret"));
        assert!(!response.contains("access denied"));
    }

    #[test]
    fn bkv_import_manifest_is_root_bound_hashed_and_exactly_scoped() {
        let root = bkv_test_root("manifest");
        let manifest = write_bkv_test_batch(&root, "ready", false);
        let batch = load_bkv_batch(&root, &manifest, false).expect("valid batch");
        assert_eq!(batch.seq_nos, (1_893_700..=1_893_710).collect::<Vec<_>>());

        let outside = root.parent().expect("parent").join("outside-manifest.json");
        fs::copy(&manifest, &outside).expect("outside copy");
        assert_eq!(
            load_bkv_batch(&root, &outside, false).unwrap_err().code,
            "bkv_manifest_outside_root"
        );

        fs::write(
            root.join("batch-001/artifacts/camera1/1893700/2d/one.jpg"),
            b"evil",
        )
        .expect("tamper artifact");
        assert_eq!(
            load_bkv_batch(&root, &manifest, false).unwrap_err().code,
            "bkv_file_hash_mismatch"
        );
        fs::remove_dir_all(root).ok();
        fs::remove_file(outside).ok();
    }

    #[test]
    fn bkv_serving_index_reads_only_manifest_and_publication() {
        let root = bkv_test_root("serving-index");
        let manifest = write_bkv_test_batch(&root, "ready", false);
        let imported = load_bkv_batch(&root, &manifest, false).unwrap();
        fs::write(
            root.join("batch-001/normalized/allexcel.jsonl"),
            b"corrupted-but-not-opened",
        )
        .unwrap();
        fs::write(
            root.join("batch-001/artifacts/camera1/1893700/metadata/camera.dat"),
            b"corrupted-other-artifact",
        )
        .unwrap();
        let index = load_bkv_serving_index(
            &root,
            &manifest,
            &imported.batch_id,
            &imported.content_id,
            &imported.semantic_digest,
            &imported.manifest_sha256,
            &imported.publication_sha256,
        )
        .expect("serving validation must not open JSONL or artifacts");
        assert_eq!(index.artifacts.len(), 2);
        assert!(index
            .artifacts
            .iter()
            .any(|artifact| artifact.relative_path.ends_with("one.jpg")));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_import_rejects_failed_and_unreviewed_partial_batches() {
        let failed_root = bkv_test_root("failed");
        let failed = write_bkv_test_batch(&failed_root, "failed", false);
        assert_eq!(
            load_bkv_batch(&failed_root, &failed, true)
                .unwrap_err()
                .code,
            "bkv_batch_failed"
        );
        let partial_root = bkv_test_root("partial");
        let partial = write_bkv_test_batch(&partial_root, "partial", true);
        assert_eq!(
            load_bkv_batch(&partial_root, &partial, false)
                .unwrap_err()
                .code,
            "bkv_partial_review_required"
        );
        assert!(load_bkv_batch(&partial_root, &partial, true).is_ok());

        let mut forged: Value = serde_json::from_slice(&fs::read(&partial).unwrap()).unwrap();
        forged["status"] = json!("ready");
        fs::write(&partial, serde_json::to_vec(&forged).unwrap()).unwrap();
        assert_eq!(
            load_bkv_batch(&partial_root, &partial, false)
                .unwrap_err()
                .code,
            "bkv_batch_status_invalid"
        );
        fs::remove_dir_all(failed_root).ok();
        fs::remove_dir_all(partial_root).ok();
    }

    #[test]
    fn bkv_import_rejects_uncommitted_publication() {
        let root = bkv_test_root("uncommitted");
        let manifest = write_bkv_test_batch(&root, "ready", false);
        fs::write(
            root.join("batch-001/publication.json"),
            serde_json::to_vec(&json!({
                "schema":"steel.bkv-publication.v1","state":"prepared",
                "batchId":"batch-001","contentId":"0".repeat(64)
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            load_bkv_batch(&root, &manifest, false).unwrap_err().code,
            "bkv_batch_not_committed"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn durable_task_dispatch_phases_are_operation_specific() {
        assert_eq!(
            dispatch_phase("capture-once"),
            "dispatching-capture-provider"
        );
        assert_eq!(dispatch_phase("algorithm-run"), "dispatching-algorithm");
        assert_eq!(dispatch_phase("steel-info"), "dispatching-steel-info");
        assert_eq!(dispatch_phase("steel-in"), "dispatching-steel-in");
        assert_eq!(dispatch_phase("steel-out"), "dispatching-steel-out");
        assert_eq!(dispatch_phase("trigger-event"), "dispatching-trigger-event");
    }

    #[test]
    fn provider_result_is_authoritative_after_dispatch_boundary() {
        let success = http_response("200 OK", "application/json; charset=utf-8", r#"{"code":0}"#);
        let success_body = response_body(&success);
        assert_eq!(
            provider_terminal_outcome(&success, &success_body),
            ("succeeded", 100, String::new())
        );

        let failure = http_response(
            "200 OK",
            "application/json; charset=utf-8",
            r#"{"code":503,"error":"capture_provider_offline"}"#,
        );
        let failure_body = response_body(&failure);
        let outcome = provider_terminal_outcome(&failure, &failure_body);
        assert_eq!(outcome.0, "failed");
        assert!(outcome.2.contains("capture_provider_offline"));
    }

    #[test]
    fn cooperative_algorithm_cancellation_is_explicitly_distinguishable() {
        assert!(response_cooperatively_cancelled(
            r#"{"code":499,"cooperativeCancellation":true}"#
        ));
        assert!(response_cooperatively_cancelled(
            r#"{"algorithm":{"cooperativeCancellation":true}}"#
        ));
        assert!(!response_cooperatively_cancelled(
            r#"{"code":500,"error":"provider_failed"}"#
        ));
    }
}

pub(super) fn start_worker(state: Arc<ServiceState>) {
    let recovered = state
        .runtime
        .block_on(db::recover_incomplete_production_tasks(
            &state.database.connection,
        ))
        .unwrap_or(0);
    if let Ok(mut status) = state.production_task_worker_status.lock() {
        status.recovered_tasks = recovered;
        status.last_heartbeat_at = current_time_millis();
    }
    let worker_state = Arc::clone(&state);
    if let Err(error) = std::thread::Builder::new()
        .name("production-task-worker".to_string())
        .spawn(move || worker_loop(worker_state))
    {
        set_worker_status(&state, false, None, Some(error.to_string()));
    }
}
