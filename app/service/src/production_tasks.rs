use super::*;
use crate::db::entities::{app_config, production_task};
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, TransactionTrait};
use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Component, Path, PathBuf};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as UnixMetadataExt, OpenOptionsExt as UnixOpenOptionsExt};
#[cfg(windows)]
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[cfg(windows)]
#[repr(C)]
struct BkvFileTime {
    low: u32,
    high: u32,
}

#[cfg(windows)]
#[repr(C)]
struct BkvByHandleFileInformation {
    attributes: u32,
    creation_time: BkvFileTime,
    last_access_time: BkvFileTime,
    last_write_time: BkvFileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetFileInformationByHandle(
        handle: *mut std::ffi::c_void,
        information: *mut BkvByHandleFileInformation,
    ) -> i32;
}

const DEFAULT_QUEUE_CAPACITY: u64 = 128;
const MAX_QUEUE_CAPACITY: u64 = 4096;
const BKV_MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;
const BKV_MAX_JSONL_BYTES: u64 = 32 * 1024 * 1024;
const BKV_MAX_JSONL_ROWS: usize = 100_000;
const BKV_MAX_JSONL_ROWS_PER_TABLE: usize = 50_000;
const BKV_MAX_ARTIFACTS: usize = 10_000;
const BKV_MAX_ARTIFACT_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const BKV_REPLAY_MAX_ARTIFACT_BYTES: u64 = 1024 * 1024 * 1024;
const BKV_REPLAY_MAX_TOTAL_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const BKV_REPLAY_HASH_BUFFER_BYTES: usize = 64 * 1024;
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
    pub camera_number: i64,
    pub seq_no: i64,
    pub kind: String,
}

#[derive(Clone, Debug)]
pub(super) struct BkvServingIndex {
    pub identity: String,
    pub batch_dir: PathBuf,
    pub artifacts: Vec<BkvServingArtifact>,
    pub deterministic_inspections: HashMap<i64, BkvExpectedInspection>,
}

#[derive(Clone, Debug)]
pub(super) struct BkvExpectedInspection {
    pub id: String,
    pub material_id: String,
    pub session_id: String,
    pub status: String,
    pub storage_root: String,
    pub summary_path: String,
    pub started_at: String,
    pub finished_at: String,
    pub capture_count: i32,
    pub defect_count: i32,
    pub raw_payload: String,
}

#[derive(Clone, Debug)]
struct BkvCompactNormalizedRow {
    seq_no: i64,
    line: usize,
    legacy_key: String,
    row_hash: String,
    legacy_id: String,
    occurred_at: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct BkvReplayRuntime {
    pub batch_id: String,
    pub content_id: String,
    pub channels: Vec<i64>,
    pub replay_index: usize,
    pub replay_status: String,
    pub replay_version: i64,
    pub replay_snapshot: Value,
    pub selected_inspection: Option<BkvImportedInspectionEvidence>,
    pub artifacts: Vec<BkvServingArtifact>,
    pub deterministic_inspections: HashMap<i64, BkvExpectedInspection>,
}

#[derive(Clone, Debug)]
pub(super) struct BkvImportedInspectionEvidence {
    pub id: String,
    pub status: String,
    pub capture_count: i32,
    pub defect_count: i32,
    pub batch_id: String,
    pub content_id: String,
    pub legacy_seq_no: i64,
    pub provenance: Value,
}

#[derive(Clone, Debug)]
pub(super) struct BkvValidatedSelectedInspection {
    pub model: db::entities::production_inspection::Model,
    pub evidence: BkvImportedInspectionEvidence,
}

#[derive(Clone, Debug)]
pub(super) struct BkvReplayArtifactEvidence {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub camera_number: i64,
    pub kind: String,
    pub verified: bool,
}

#[derive(Clone, Debug)]
pub(super) struct BkvReplaySelection {
    pub batch_id: String,
    pub content_id: String,
    pub legacy_seq_no: i64,
    pub previous_index: usize,
    pub next_index: usize,
    pub status: String,
    pub version: i64,
    pub inspection_id: String,
    pub material_id: String,
    pub session_id: String,
    pub inspection: BkvImportedInspectionEvidence,
    pub artifacts: Vec<BkvReplayArtifactEvidence>,
    pub captures: Vec<Value>,
    pub defects: Vec<Value>,
}

static BKV_RUNTIME_VERIFICATION_SINGLE_FLIGHT: OnceLock<
    Mutex<HashMap<String, std::sync::Weak<Mutex<()>>>>,
> = OnceLock::new();

#[cfg(test)]
static BKV_ARTIFACT_HASH_READS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

#[cfg(test)]
static BKV_FULL_BATCH_LOADS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

#[cfg(test)]
static BKV_MAPPING_READ_DELAYS: OnceLock<Mutex<HashMap<String, Duration>>> = OnceLock::new();

#[cfg(test)]
static BKV_RUNTIME_VERIFICATIONS_ACTIVE: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

#[cfg(test)]
static BKV_RUNTIME_VERIFICATIONS_MAX: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

#[cfg(test)]
struct BkvRuntimeVerificationActiveGuard(String);

#[cfg(test)]
impl Drop for BkvRuntimeVerificationActiveGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = BKV_RUNTIME_VERIFICATIONS_ACTIVE
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
        {
            if let Some(count) = active.get_mut(&self.0) {
                *count = count.saturating_sub(1);
            }
        }
    }
}

#[cfg(test)]
fn bkv_test_reset_runtime_verification_max(root: &Path) {
    if let Ok(mut maximums) = BKV_RUNTIME_VERIFICATIONS_MAX
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        maximums.retain(|identity, _| !identity.starts_with(root.to_string_lossy().as_ref()));
    }
}

#[cfg(test)]
fn bkv_test_runtime_verification_max(root: &Path) -> u64 {
    BKV_RUNTIME_VERIFICATIONS_MAX
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map(|maximums| {
            maximums
                .iter()
                .filter(|(identity, _)| identity.starts_with(root.to_string_lossy().as_ref()))
                .map(|(_, count)| *count)
                .max()
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

#[cfg(test)]
fn bkv_test_runtime_verification_active(root: &Path) -> u64 {
    BKV_RUNTIME_VERIFICATIONS_ACTIVE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map(|active| {
            active
                .iter()
                .filter(|(identity, _)| identity.starts_with(root.to_string_lossy().as_ref()))
                .map(|(_, count)| *count)
                .sum()
        })
        .unwrap_or_default()
}

#[cfg(test)]
fn bkv_test_root_key(root: &Path) -> String {
    fs::canonicalize(root)
        .unwrap_or_else(|_| root.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
fn bkv_test_hash_reads(root: &Path) -> u64 {
    let root = bkv_test_root_key(root);
    BKV_ARTIFACT_HASH_READS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map(|reads| {
            reads
                .iter()
                .filter(|(identity, _)| identity.contains(root.as_str()))
                .map(|(_, count)| *count)
                .sum()
        })
        .unwrap_or_default()
}

#[cfg(test)]
fn bkv_test_full_batch_loads(root: &Path) -> u64 {
    BKV_FULL_BATCH_LOADS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map(|loads| {
            loads
                .get(root.to_string_lossy().as_ref())
                .copied()
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

#[cfg(test)]
fn bkv_test_reset_full_batch_loads(root: &Path) {
    if let Ok(mut loads) = BKV_FULL_BATCH_LOADS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        loads.insert(root.to_string_lossy().into_owned(), 0);
    }
}

#[cfg(test)]
fn bkv_test_set_mapping_delay(root: &Path, delay: Duration) {
    if let Ok(mut delays) = BKV_MAPPING_READ_DELAYS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        delays.insert(bkv_test_root_key(root), delay);
    }
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
        && value != "."
        && value != ".."
        && value.as_bytes().len() <= 117
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn bkv_same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(windows)]
    {
        left.creation_time() == right.creation_time()
            && left.last_write_time() == right.last_write_time()
            && left.file_size() == right.file_size()
    }
}

fn bkv_raw_open_readonly_nofollow(path: &Path) -> Result<fs::File, BkvRejection> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.custom_flags(0x0020_0000);
    #[cfg(target_os = "linux")]
    options.custom_flags(0x0002_0000);
    #[cfg(target_os = "macos")]
    options.custom_flags(0x0000_0100);
    options
        .open(path)
        .map_err(|_| BkvRejection::new("bkv_file_unavailable", "BKV file open failed"))
}

#[cfg(windows)]
fn bkv_windows_handle_identity(file: &fs::File) -> Option<(u32, u64)> {
    let mut information = std::mem::MaybeUninit::<BkvByHandleFileInformation>::uninit();
    let ok = unsafe {
        GetFileInformationByHandle(file.as_raw_handle().cast(), information.as_mut_ptr())
    };
    if ok == 0 {
        return None;
    }
    let information = unsafe { information.assume_init() };
    Some((
        information.volume_serial_number,
        (u64::from(information.file_index_high) << 32) | u64::from(information.file_index_low),
    ))
}

fn bkv_same_open_handle_identity(left: &fs::File, right: &fs::File) -> bool {
    #[cfg(windows)]
    {
        bkv_windows_handle_identity(left)
            .zip(bkv_windows_handle_identity(right))
            .is_some_and(|(left, right)| left == right)
    }
    #[cfg(unix)]
    {
        left.metadata()
            .ok()
            .zip(right.metadata().ok())
            .is_some_and(|(left, right)| bkv_same_file_identity(&left, &right))
    }
}

fn bkv_handle_still_matches_path(file: &fs::File, path: &Path) -> bool {
    bkv_raw_open_readonly_nofollow(path)
        .ok()
        .is_some_and(|current| bkv_same_open_handle_identity(file, &current))
}

fn bkv_lock_runtime_verification_with_deadline(
    lock: &Mutex<()>,
    deadline: Option<Instant>,
) -> Result<std::sync::MutexGuard<'_, ()>, BkvRejection> {
    let Some(deadline) = deadline else {
        return lock.lock().map_err(|_| {
            BkvRejection::new(
                "bkv_status_unavailable",
                "BKV runtime verification lock unavailable",
            )
        });
    };
    loop {
        if Instant::now() >= deadline {
            return Err(BkvRejection::new(
                "bkv_verification_timeout",
                "BKV verification deadline exceeded",
            ));
        }
        match lock.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(std::sync::TryLockError::Poisoned(_)) => {
                return Err(BkvRejection::new(
                    "bkv_status_unavailable",
                    "BKV runtime verification lock unavailable",
                ));
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(BkvRejection::new(
                        "bkv_verification_timeout",
                        "BKV verification deadline exceeded",
                    ));
                }
                std::thread::sleep(remaining.min(Duration::from_millis(1)));
            }
        }
    }
}

fn bkv_runtime_verification_identity(
    configured_root: &Path,
    batch_id: &str,
    content_id: &str,
    semantic_digest: &str,
    manifest_sha256: &str,
    publication_sha256: &str,
) -> String {
    format!(
        "{}|{batch_id}|{content_id}|{semantic_digest}|{manifest_sha256}|{publication_sha256}",
        configured_root.display()
    )
}

fn bkv_runtime_verification_lock(identity: &str) -> Result<Arc<Mutex<()>>, BkvRejection> {
    let mut locks = BKV_RUNTIME_VERIFICATION_SINGLE_FLIGHT
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| {
            BkvRejection::new(
                "bkv_status_unavailable",
                "BKV runtime verification lock unavailable",
            )
        })?;
    locks.retain(|_, lock| lock.upgrade().is_some());
    if let Some(lock) = locks.get(identity).and_then(std::sync::Weak::upgrade) {
        Ok(lock)
    } else {
        let lock = Arc::new(Mutex::new(()));
        locks.insert(identity.to_string(), Arc::downgrade(&lock));
        Ok(lock)
    }
}

fn bkv_open_readonly_nofollow(path: &Path) -> Result<(fs::File, fs::Metadata), BkvRejection> {
    let before = fs::symlink_metadata(path)
        .map_err(|_| BkvRejection::new("bkv_file_unavailable", "BKV file unavailable"))?;
    if bkv_metadata_is_reparse(&before) || !before.is_file() {
        return Err(BkvRejection::new(
            "bkv_file_link_rejected",
            "BKV linked or non-file path rejected",
        ));
    }
    let file = bkv_raw_open_readonly_nofollow(path)?;
    let opened = file
        .metadata()
        .map_err(|_| BkvRejection::new("bkv_file_changed", "BKV handle metadata unavailable"))?;
    let after = fs::symlink_metadata(path)
        .map_err(|_| BkvRejection::new("bkv_file_changed", "BKV path changed during open"))?;
    if bkv_metadata_is_reparse(&opened)
        || bkv_metadata_is_reparse(&after)
        || !bkv_same_file_identity(&before, &opened)
        || !bkv_same_file_identity(&opened, &after)
        || !bkv_handle_still_matches_path(&file, path)
    {
        return Err(BkvRejection::new(
            "bkv_file_changed",
            "BKV path identity changed during open",
        ));
    }
    Ok((file, opened))
}

fn bkv_hash_file(path: &Path, max_bytes: u64) -> Result<(String, u64, Vec<u8>), BkvRejection> {
    bkv_hash_file_with_deadline(path, max_bytes, None)
}

fn bkv_hash_file_with_deadline(
    path: &Path,
    max_bytes: u64,
    deadline: Option<Instant>,
) -> Result<(String, u64, Vec<u8>), BkvRejection> {
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
    let (mut file, opened) = bkv_open_readonly_nofollow(path)?;
    if !bkv_same_file_identity(&metadata, &opened) {
        return Err(BkvRejection::new(
            "bkv_file_changed",
            "BKV file identity changed before read",
        ));
    }
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total = 0_u64;
    let mut bytes = Vec::with_capacity(metadata.len().min(max_bytes) as usize);
    loop {
        if deadline.is_some_and(|limit| Instant::now() >= limit) {
            return Err(BkvRejection::new(
                "bkv_verification_timeout",
                "BKV verification deadline exceeded",
            ));
        }
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
    if bkv_metadata_is_reparse(&after)
        || after.len() != metadata.len()
        || total != metadata.len()
        || !bkv_handle_still_matches_path(&file, path)
    {
        return Err(BkvRejection::new(
            "bkv_file_changed",
            "file changed while being read",
        ));
    }
    if !bkv_same_file_identity(&after, &metadata) {
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
    #[cfg(test)]
    if let Ok(mut loads) = BKV_FULL_BATCH_LOADS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        *loads
            .entry(configured_root.to_string_lossy().into_owned())
            .or_default() += 1;
    }
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

struct BkvDeadlineHashReader {
    file: fs::File,
    digest: Sha256,
    total: u64,
    max_bytes: u64,
    deadline: Option<Instant>,
    timed_out: bool,
    #[cfg(test)]
    delay: Duration,
}

impl Read for BkvDeadlineHashReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.deadline.is_some_and(|limit| Instant::now() >= limit) {
            self.timed_out = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "BKV verification deadline exceeded",
            ));
        }
        #[cfg(test)]
        if !self.delay.is_zero() {
            std::thread::sleep(self.delay);
        }
        let remaining = self.max_bytes.saturating_sub(self.total);
        let allowed = buffer.len().min(remaining.saturating_add(1) as usize);
        let read = self.file.read(&mut buffer[..allowed])?;
        self.total = self.total.saturating_add(read as u64);
        if self.total > self.max_bytes {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "BKV normalized file exceeds limit",
            ));
        }
        self.digest.update(&buffer[..read]);
        Ok(read)
    }
}

fn bkv_read_deterministic_mapping_file(
    path: &Path,
    table: &str,
    expected_sha256: &str,
    expected_size: u64,
    expected_count: u64,
    deadline: Option<Instant>,
) -> Result<Vec<BkvCompactNormalizedRow>, BkvRejection> {
    if expected_size > BKV_MAX_JSONL_BYTES || expected_count > BKV_MAX_JSONL_ROWS_PER_TABLE as u64 {
        return Err(BkvRejection::new(
            "bkv_jsonl_row_limit_exceeded",
            "deterministic mapping evidence exceeds limits",
        ));
    }
    let before = fs::symlink_metadata(path)
        .map_err(|_| BkvRejection::new("bkv_file_unavailable", "mapping file unavailable"))?;
    if bkv_metadata_is_reparse(&before) || !before.is_file() || before.len() != expected_size {
        return Err(BkvRejection::new(
            "bkv_file_changed",
            "deterministic mapping file metadata changed",
        ));
    }
    let (file, opened) = bkv_open_readonly_nofollow(path)?;
    if !bkv_same_file_identity(&before, &opened) {
        return Err(BkvRejection::new(
            "bkv_file_changed",
            "mapping identity changed before read",
        ));
    }
    let mut reader = BkvDeadlineHashReader {
        file,
        digest: Sha256::new(),
        total: 0,
        max_bytes: BKV_MAX_JSONL_BYTES,
        deadline,
        timed_out: false,
        #[cfg(test)]
        delay: BKV_MAPPING_READ_DELAYS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .ok()
            .and_then(|delays| {
                delays
                    .iter()
                    .find(|(root, _)| path.to_string_lossy().contains(root.as_str()))
                    .map(|(_, delay)| *delay)
            })
            .unwrap_or_default(),
    };
    let mut rows = Vec::new();
    let mut row_count = 0u64;
    let mut parse_failed = false;
    {
        let buffered = BufReader::with_capacity(BKV_REPLAY_HASH_BUFFER_BYTES, &mut reader);
        for row in serde_json::Deserializer::from_reader(buffered).into_iter::<Value>() {
            if deadline.is_some_and(|limit| Instant::now() >= limit) {
                reader.timed_out = true;
                parse_failed = true;
                break;
            }
            let row = match row {
                Ok(row) => row,
                Err(_) => {
                    parse_failed = true;
                    break;
                }
            };
            row_count = row_count.saturating_add(1);
            if row_count > BKV_MAX_JSONL_ROWS_PER_TABLE as u64 {
                return Err(BkvRejection::new(
                    "bkv_jsonl_row_limit_exceeded",
                    "deterministic mapping row limit exceeded",
                ));
            }
            let seq_no = row
                .get("legacySeqNo")
                .and_then(Value::as_i64)
                .filter(|seq_no| BKV_TARGET_SEQ_NOS.contains(seq_no))
                .ok_or_else(|| {
                    BkvRejection::new("bkv_normalized_row_invalid", "mapping SeqNo invalid")
                })?;
            if row.get("legacyTable").and_then(Value::as_str) != Some(table) {
                return Err(BkvRejection::new(
                    "bkv_normalized_row_invalid",
                    "mapping legacy table invalid",
                ));
            }
            let id_names: &[&str] = if table == "allexcel" {
                &["id", "allexcelid", "recordid", "originalRowHash"]
            } else {
                &["id", "checkrecordid", "originalRowHash"]
            };
            let legacy_id = if table == "allexcel" {
                bkv_row_text(&row, id_names).unwrap_or_else(|| seq_no.to_string())
            } else {
                bkv_row_text(&row, id_names).unwrap_or_default()
            };
            let row_hash = row
                .get("originalRowHash")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    BkvRejection::new(
                        "bkv_normalized_row_invalid",
                        "normalized row provenance hash missing",
                    )
                })?
                .to_string();
            let legacy_key = bkv_row_text(
                &row,
                &[
                    "id",
                    "allexcelid",
                    "checkrecordid",
                    "defectid",
                    "classId",
                    "originalRowHash",
                ],
            )
            .unwrap_or_else(|| format!("{table}:{row_count}"));
            let occurred_at = bkv_row_text(
                &row,
                &["time", "checktime", "datetime", "detecttime", "createdat"],
            );
            rows.push(BkvCompactNormalizedRow {
                seq_no,
                line: row_count as usize,
                legacy_key,
                row_hash,
                legacy_id,
                occurred_at,
            });
        }
    }
    if reader.timed_out {
        return Err(BkvRejection::new(
            "bkv_verification_timeout",
            "BKV deterministic mapping deadline exceeded",
        ));
    }
    if parse_failed || row_count != expected_count {
        return Err(BkvRejection::new(
            "bkv_normalized_row_invalid",
            "deterministic mapping JSONL invalid",
        ));
    }
    let after = reader
        .file
        .metadata()
        .map_err(|_| BkvRejection::new("bkv_file_changed", "mapping metadata unavailable"))?;
    if reader.total != expected_size
        || after.len() != before.len()
        || !bkv_handle_still_matches_path(&reader.file, path)
        || format!("{:x}", reader.digest.finalize()) != expected_sha256
    {
        return Err(BkvRejection::new(
            "bkv_file_changed",
            "deterministic mapping hash or size changed",
        ));
    }
    if !bkv_same_file_identity(&after, &before) {
        return Err(BkvRejection::new(
            "bkv_file_changed",
            "deterministic mapping identity changed",
        ));
    }
    Ok(rows)
}

fn load_bkv_deterministic_inspection_map(
    batch_dir: &Path,
    manifest: &Value,
    serving_identity: &str,
    batch_id: &str,
    deadline: Option<Instant>,
) -> Result<(String, HashMap<i64, BkvExpectedInspection>), BkvRejection> {
    let normalized = manifest
        .get("normalized")
        .and_then(Value::as_array)
        .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "normalized evidence missing"))?;
    let mut evidence = HashMap::new();
    for item in normalized {
        if deadline.is_some_and(|limit| Instant::now() >= limit) {
            return Err(BkvRejection::new(
                "bkv_verification_timeout",
                "BKV deterministic mapping deadline exceeded",
            ));
        }
        let table = item
            .get("table")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if evidence.insert(table.to_string(), item).is_some() {
            return Err(BkvRejection::new(
                "bkv_normalized_table_invalid",
                "deterministic mapping table is duplicated",
            ));
        }
    }
    if evidence.len() != 5
        || [
            "allexcel",
            "checkrecord",
            "defect",
            "defectclass",
            "diameter",
        ]
        .into_iter()
        .any(|table| !evidence.contains_key(table))
    {
        return Err(BkvRejection::new(
            "bkv_normalized_table_invalid",
            "deterministic parent tables are incomplete",
        ));
    }
    let mut fingerprint = Sha256::new();
    fingerprint.update(serving_identity.as_bytes());
    let mut files = Vec::new();
    for item in normalized {
        let table = item
            .get("table")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let item = evidence.get(table).ok_or_else(|| {
            BkvRejection::new("bkv_normalized_table_invalid", "mapping table missing")
        })?;
        let relative = item.get("path").and_then(Value::as_str).unwrap_or_default();
        let sha256 = item
            .get("sha256")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let size = item
            .get("size")
            .and_then(Value::as_u64)
            .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "mapping size missing"))?;
        let count = item
            .get("count")
            .and_then(Value::as_u64)
            .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "mapping count missing"))?;
        if !bkv_safe_relative(relative) || !bkv_valid_sha256(sha256) {
            return Err(BkvRejection::new(
                "bkv_manifest_invalid",
                "mapping evidence invalid",
            ));
        }
        let path = bkv_resolve_batch_file(batch_dir, relative)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| BkvRejection::new("bkv_file_unavailable", "mapping metadata missing"))?;
        if bkv_metadata_is_reparse(&metadata) || !metadata.is_file() || metadata.len() != size {
            return Err(BkvRejection::new(
                "bkv_file_changed",
                "mapping evidence size changed",
            ));
        }
        for value in [table, relative, sha256] {
            fingerprint.update(value.as_bytes());
        }
        fingerprint.update(size.to_le_bytes());
        fingerprint.update(count.to_le_bytes());
        files.push((
            table.to_string(),
            relative.to_string(),
            path,
            sha256,
            size,
            count,
        ));
    }
    let identity = format!(
        "{serving_identity}:{}",
        format!("{:x}", fingerprint.finalize())
    );
    let mut parsed = Vec::new();
    for (table, relative, path, sha256, size, count) in files {
        let rows =
            bkv_read_deterministic_mapping_file(&path, &table, sha256, size, count, deadline)?;
        parsed.push((table, relative, rows));
    }
    let content_id = manifest
        .get("contentId")
        .and_then(Value::as_str)
        .filter(|value| bkv_valid_sha256(value))
        .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "content id invalid"))?;
    let allexcel = parsed
        .iter()
        .find(|(table, _, _)| table == "allexcel")
        .ok_or_else(|| BkvRejection::new("bkv_material_row_missing", "mapping material missing"))?;
    let checkrecord = parsed
        .iter()
        .find(|(table, _, _)| table == "checkrecord")
        .ok_or_else(|| {
            BkvRejection::new("bkv_normalized_table_invalid", "check mapping missing")
        })?;
    let mut mapping = HashMap::new();
    for seq_no in BKV_TARGET_SEQ_NOS {
        let material_row = allexcel
            .2
            .iter()
            .find(|row| row.seq_no == seq_no)
            .ok_or_else(|| {
                BkvRejection::new("bkv_material_row_missing", "mapping material missing")
            })?;
        let check_row = checkrecord.2.iter().find(|row| row.seq_no == seq_no);
        let material_legacy_id = material_row.legacy_id.as_str();
        let inspection_legacy_id = bkv_parent_inspection_legacy_id(
            check_row.map(|row| Some(row.legacy_id.clone())),
            material_legacy_id,
        );
        let material_id = bkv_deterministic_id(
            batch_id,
            "material",
            "allexcel",
            material_legacy_id,
            "normalized/allexcel.jsonl",
        );
        let session_id = bkv_deterministic_id(
            batch_id,
            "material-session",
            "allexcel",
            material_legacy_id,
            "normalized/allexcel.jsonl",
        );
        let inspection_id = bkv_deterministic_id(
            batch_id,
            "production-inspection",
            "checkrecord",
            &inspection_legacy_id,
            "normalized/checkrecord.jsonl",
        );
        let occurred_at = bkv_parent_occurred_at(
            check_row.map(|row| row.occurred_at.clone()),
            material_row.occurred_at.clone(),
            seq_no,
        );
        let row_refs = parsed
            .iter()
            .flat_map(|(table, relative, rows)| {
                rows.iter()
                    .filter(move |row| row.seq_no == seq_no)
                    .map(move |row| {
                        json!({
                            "t":table,
                            "k":row.legacy_key,
                            "h":row.row_hash,
                            "p":relative,
                            "l":row.line
                        })
                    })
            })
            .collect::<Vec<_>>();
        let artifact_provenance = manifest
            .get("artifacts")
            .and_then(Value::as_array)
            .ok_or_else(|| BkvRejection::new("bkv_manifest_invalid", "artifacts missing"))?
            .iter()
            .filter(|artifact| artifact.get("seqNo").and_then(Value::as_i64) == Some(seq_no))
            .map(|artifact| {
                json!({
                    "p":artifact.get("path"),
                    "m":artifact.get("memberPath"),
                    "h":artifact.get("sha256"),
                    "c":artifact.get("cameraNumber"),
                    "s":artifact.get("seqNo"),
                    "k":artifact.get("kind")
                })
            })
            .collect::<Vec<_>>();
        let raw_payload = json!({
            "source":"bkv",
            "batchId":batch_id,
            "contentId":content_id,
            "legacySeqNo":seq_no,
            "legacyTable":"allexcel",
            "legacyId":material_legacy_id,
            "sourcePath":"normalized/allexcel.jsonl",
            "rowRefs":row_refs,
            "artifactProvenance":artifact_provenance
        })
        .to_string();
        if raw_payload.len() > BKV_MAX_PERSISTED_JSON_BYTES {
            return Err(BkvRejection::new(
                "bkv_provenance_too_large",
                "BKV provenance exceeds storage contract",
            ));
        }
        let capture_count = manifest
            .get("artifacts")
            .and_then(Value::as_array)
            .map(|artifacts| {
                artifacts
                    .iter()
                    .filter(|artifact| {
                        artifact.get("seqNo").and_then(Value::as_i64) == Some(seq_no)
                    })
                    .count()
                    .min(i32::MAX as usize) as i32
            })
            .unwrap_or_default();
        let defect_count = parsed
            .iter()
            .find(|(table, _, _)| table == "defect")
            .map(|(_, _, rows)| {
                rows.iter()
                    .filter(|row| row.seq_no == seq_no)
                    .count()
                    .min(i32::MAX as usize) as i32
            })
            .unwrap_or_default();
        mapping.insert(
            seq_no,
            BkvExpectedInspection {
                id: inspection_id,
                material_id,
                session_id,
                status: "completed".to_string(),
                storage_root: String::new(),
                summary_path: String::new(),
                started_at: occurred_at.clone(),
                finished_at: occurred_at,
                capture_count,
                defect_count,
                raw_payload,
            },
        );
    }
    Ok((identity, mapping))
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
    load_bkv_serving_index_with_deadline(
        configured_root,
        manifest_path,
        expected_batch_id,
        expected_content_id,
        expected_semantic_digest,
        expected_manifest_sha256,
        expected_publication_sha256,
        None,
    )
}

fn load_bkv_serving_index_with_deadline(
    configured_root: &Path,
    manifest_path: &Path,
    expected_batch_id: &str,
    expected_content_id: &str,
    expected_semantic_digest: &str,
    expected_manifest_sha256: &str,
    expected_publication_sha256: &str,
    deadline: Option<Instant>,
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
        bkv_hash_file_with_deadline(&manifest_path, BKV_MAX_MANIFEST_BYTES, deadline)?;
    if manifest_sha256 != expected_manifest_sha256 {
        return Err(BkvRejection::new(
            "bkv_manifest_changed",
            "manifest hash changed",
        ));
    }
    let manifest: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| BkvRejection::new("bkv_manifest_invalid_json", "manifest JSON invalid"))?;
    if deadline.is_some_and(|limit| Instant::now() >= limit) {
        return Err(BkvRejection::new(
            "bkv_verification_timeout",
            "BKV manifest parse deadline exceeded",
        ));
    }
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
        bkv_hash_file_with_deadline(&publication_path, BKV_MAX_MANIFEST_BYTES, deadline)?;
    if publication_sha256 != expected_publication_sha256 {
        return Err(BkvRejection::new(
            "bkv_manifest_changed",
            "publication hash changed",
        ));
    }
    let publication: Value = serde_json::from_slice(&publication_bytes)
        .map_err(|_| BkvRejection::new("bkv_batch_not_committed", "publication JSON invalid"))?;
    if deadline.is_some_and(|limit| Instant::now() >= limit) {
        return Err(BkvRejection::new(
            "bkv_verification_timeout",
            "BKV publication parse deadline exceeded",
        ));
    }
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
        if deadline.is_some_and(|limit| Instant::now() >= limit) {
            return Err(BkvRejection::new(
                "bkv_verification_timeout",
                "BKV serving index deadline exceeded",
            ));
        }
        let relative_path = item.get("path").and_then(Value::as_str).unwrap_or_default();
        let sha256 = item
            .get("sha256")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let size = item.get("size").and_then(Value::as_u64);
        let camera_number = item.get("cameraNumber").and_then(Value::as_i64);
        let seq_no = item.get("seqNo").and_then(Value::as_i64);
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or_default();
        if !bkv_safe_relative(relative_path)
            || !relative_path.starts_with("artifacts/")
            || !bkv_valid_sha256(sha256)
            || size.is_none()
            || !matches!(camera_number, Some(1..=6))
            || !matches!(seq_no, Some(1_893_700..=1_893_710))
            || kind.trim().is_empty()
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
            camera_number: camera_number.unwrap_or_default(),
            seq_no: seq_no.unwrap_or_default(),
            kind: kind.to_string(),
        });
    }
    let serving_identity = format!(
        "{}:{expected_batch_id}:{expected_content_id}:{expected_semantic_digest}:{manifest_sha256}:{publication_sha256}",
        batch_dir.display()
    );
    let (identity, deterministic_inspections) = load_bkv_deterministic_inspection_map(
        batch_dir,
        &manifest,
        &serving_identity,
        expected_batch_id,
        deadline,
    )?;
    Ok(BkvServingIndex {
        identity,
        batch_dir: batch_dir.to_path_buf(),
        artifacts,
        deterministic_inspections,
    })
}

pub(super) fn resolve_bkv_serving_path(
    index: &BkvServingIndex,
    artifact: &BkvServingArtifact,
) -> Result<PathBuf, BkvRejection> {
    bkv_resolve_batch_file(&index.batch_dir, &artifact.relative_path)
}

fn bkv_config_json(
    value: Option<db::AppConfigValue>,
    code: &'static str,
) -> Result<Value, BkvRejection> {
    let value = value.ok_or_else(|| BkvRejection::new(code, "BKV configuration is missing"))?;
    serde_json::from_str(&value.value).map_err(|_| {
        BkvRejection::new(
            "bkv_replay_state_invalid",
            "BKV configuration JSON is invalid",
        )
    })
}

fn bkv_imported_inspection_evidence(
    inspection: &db::entities::production_inspection::Model,
    expected_batch_id: &str,
    expected_content_id: &str,
    expected_seq_no: i64,
) -> Result<BkvImportedInspectionEvidence, BkvRejection> {
    let raw: Value = serde_json::from_str(&inspection.raw_payload).map_err(|_| {
        BkvRejection::new(
            "bkv_selected_inspection_invalid",
            "selected inspection provenance is invalid",
        )
    })?;
    if raw.get("source").and_then(Value::as_str) != Some("bkv")
        || raw.get("batchId").and_then(Value::as_str) != Some(expected_batch_id)
        || raw.get("contentId").and_then(Value::as_str) != Some(expected_content_id)
        || raw.get("legacySeqNo").and_then(Value::as_i64) != Some(expected_seq_no)
    {
        return Err(BkvRejection::new(
            "bkv_selected_inspection_invalid",
            "selected inspection is not bound to the active replay item",
        ));
    }
    let legacy_id = raw
        .get("legacyId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            BkvRejection::new(
                "bkv_selected_inspection_invalid",
                "selected inspection legacy identity is missing",
            )
        })?;
    let expected_material_id = bkv_deterministic_id(
        expected_batch_id,
        "material",
        "allexcel",
        legacy_id,
        "normalized/allexcel.jsonl",
    );
    let expected_session_id = bkv_deterministic_id(
        expected_batch_id,
        "material-session",
        "allexcel",
        legacy_id,
        "normalized/allexcel.jsonl",
    );
    let expected_capture_count = raw
        .get("artifactProvenance")
        .and_then(Value::as_array)
        .map(|rows| rows.len().min(i32::MAX as usize) as i32)
        .ok_or_else(|| {
            BkvRejection::new(
                "bkv_selected_inspection_invalid",
                "selected inspection artifact binding is missing",
            )
        })?;
    let expected_defect_count = raw
        .get("rowRefs")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|row| row.get("t").and_then(Value::as_str) == Some("defect"))
                .count()
                .min(i32::MAX as usize) as i32
        })
        .ok_or_else(|| {
            BkvRejection::new(
                "bkv_selected_inspection_invalid",
                "selected inspection row binding is missing",
            )
        })?;
    if inspection.material_id != expected_material_id
        || inspection.session_id != expected_session_id
        || inspection.status != "completed"
        || inspection.started_at.is_empty()
        || inspection.started_at != inspection.finished_at
        || inspection.capture_count != expected_capture_count
        || inspection.defect_count != expected_defect_count
        || !inspection.storage_root.is_empty()
        || !inspection.summary_path.is_empty()
    {
        return Err(BkvRejection::new(
            "bkv_selected_inspection_invalid",
            "selected inspection parent fields do not match deterministic evidence",
        ));
    }
    Ok(BkvImportedInspectionEvidence {
        id: inspection.id.clone(),
        status: inspection.status.clone(),
        capture_count: inspection.capture_count,
        defect_count: inspection.defect_count,
        batch_id: expected_batch_id.to_string(),
        content_id: expected_content_id.to_string(),
        legacy_seq_no: expected_seq_no,
        provenance: json!({
            "source":"bkv",
            "batchId":expected_batch_id,
            "contentId":expected_content_id,
            "legacySeqNo":expected_seq_no
        }),
    })
}

fn bkv_inspection_matches_expected(
    inspection: &db::entities::production_inspection::Model,
    expected: &BkvExpectedInspection,
) -> bool {
    inspection.id == expected.id
        && inspection.material_id == expected.material_id
        && inspection.session_id == expected.session_id
        && inspection.status == expected.status
        && inspection.storage_root == expected.storage_root
        && inspection.summary_path == expected.summary_path
        && inspection.started_at == expected.started_at
        && inspection.finished_at == expected.finished_at
        && inspection.capture_count == expected.capture_count
        && inspection.defect_count == expected.defect_count
        && inspection.raw_payload == expected.raw_payload
}

async fn bkv_validate_replay_state(
    connection: &sea_orm::DatabaseConnection,
    batch_id: &str,
    content_id: &str,
    replay: &Value,
) -> Result<(usize, String, i64, Option<BkvValidatedSelectedInspection>), BkvRejection> {
    if replay.get("batchId").and_then(Value::as_str) != Some(batch_id)
        || replay.get("contentId").and_then(Value::as_str) != Some(content_id)
    {
        return Err(BkvRejection::new(
            "bkv_replay_state_invalid",
            "replay binding is invalid",
        ));
    }
    let index = replay
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value <= BKV_TARGET_SEQ_NOS.len())
        .ok_or_else(|| BkvRejection::new("bkv_replay_state_invalid", "replay index invalid"))?;
    let status = replay
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| BkvRejection::new("bkv_replay_state_invalid", "replay status missing"))?;
    let expected_status = if index == 0 {
        "ready"
    } else if index == BKV_TARGET_SEQ_NOS.len() {
        "completed"
    } else {
        "replaying"
    };
    let version = replay
        .get("version")
        .and_then(Value::as_i64)
        .filter(|value| *value >= index as i64)
        .ok_or_else(|| BkvRejection::new("bkv_replay_state_invalid", "replay version invalid"))?;
    let selected_seq_value = replay.get("selectedLegacySeqNo");
    let selected_id_value = replay.get("selectedInspectionId");
    if selected_seq_value.is_some_and(|value| !value.is_null() && !value.is_i64())
        || selected_id_value.is_some_and(|value| !value.is_null() && !value.is_string())
    {
        return Err(BkvRejection::new(
            "bkv_replay_state_invalid",
            "selected replay fields have invalid types",
        ));
    }
    let selected_seq = selected_seq_value.and_then(Value::as_i64);
    let selected_id = selected_id_value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if status != expected_status {
        return Err(BkvRejection::new(
            "bkv_replay_state_invalid",
            "replay status contradicts index",
        ));
    }
    if index == 0 {
        if selected_seq.is_some() || selected_id.is_some() {
            return Err(BkvRejection::new(
                "bkv_replay_state_invalid",
                "ready replay must not select an inspection",
            ));
        }
        return Ok((index, status.to_string(), version, None));
    }
    let expected_seq = BKV_TARGET_SEQ_NOS[index - 1];
    if selected_seq != Some(expected_seq) || selected_id.is_none() {
        return Err(BkvRejection::new(
            "bkv_replay_state_invalid",
            "selected replay item contradicts index",
        ));
    }
    let inspection = db::find_production_inspection(connection, selected_id.unwrap())
        .await
        .map_err(|_| {
            BkvRejection::new(
                "bkv_imported_data_unavailable",
                "selected inspection lookup failed",
            )
        })?
        .ok_or_else(|| {
            BkvRejection::new(
                "bkv_selected_inspection_invalid",
                "selected inspection is missing",
            )
        })?;
    let evidence =
        bkv_imported_inspection_evidence(&inspection, batch_id, content_id, expected_seq)?;
    Ok((
        index,
        status.to_string(),
        version,
        Some(BkvValidatedSelectedInspection {
            model: inspection,
            evidence,
        }),
    ))
}

fn verify_bkv_runtime_artifact(
    index: &BkvServingIndex,
    artifact: &BkvServingArtifact,
    deadline: Option<Instant>,
) -> Result<PathBuf, BkvRejection> {
    let path = resolve_bkv_serving_path(index, artifact).map_err(|error| {
        let code = if matches!(error.code, "bkv_file_unavailable" | "bkv_file_changed") {
            "bkv_artifact_missing"
        } else {
            error.code
        };
        BkvRejection::new(code, "BKV replay artifact is unavailable")
    })?;
    let metadata = fs::metadata(&path).map_err(|_| {
        BkvRejection::new("bkv_artifact_missing", "BKV artifact metadata unavailable")
    })?;
    if artifact.size > BKV_REPLAY_MAX_ARTIFACT_BYTES || metadata.len() != artifact.size {
        return Err(BkvRejection::new(
            "bkv_artifact_changed",
            "BKV replay artifact size changed or exceeds the replay limit",
        ));
    }
    let (mut file, opened) = bkv_open_readonly_nofollow(&path)
        .map_err(|_| BkvRejection::new("bkv_artifact_missing", "BKV artifact open failed"))?;
    if !bkv_same_file_identity(&metadata, &opened) {
        return Err(BkvRejection::new(
            "bkv_artifact_changed",
            "BKV artifact identity changed before read",
        ));
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; BKV_REPLAY_HASH_BUFFER_BYTES];
    let mut read_total = 0u64;
    loop {
        if deadline.is_some_and(|limit| Instant::now() >= limit) {
            return Err(BkvRejection::new(
                "bkv_verification_timeout",
                "BKV artifact verification deadline exceeded",
            ));
        }
        let read = file
            .read(&mut buffer)
            .map_err(|_| BkvRejection::new("bkv_artifact_changed", "BKV artifact read failed"))?;
        if read == 0 {
            break;
        }
        #[cfg(test)]
        if let Ok(mut reads) = BKV_ARTIFACT_HASH_READS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
        {
            *reads.entry(index.identity.clone()).or_default() += 1;
        }
        read_total = read_total.saturating_add(read as u64);
        if read_total > artifact.size {
            return Err(BkvRejection::new(
                "bkv_artifact_changed",
                "BKV artifact grew during verification",
            ));
        }
        digest.update(&buffer[..read]);
    }
    let after = file
        .metadata()
        .map_err(|_| BkvRejection::new("bkv_artifact_changed", "BKV artifact metadata changed"))?;
    let path_after = fs::symlink_metadata(&path)
        .map_err(|_| BkvRejection::new("bkv_artifact_changed", "BKV artifact path changed"))?;
    if !bkv_same_file_identity(&opened, &after)
        || !bkv_same_file_identity(&after, &path_after)
        || bkv_metadata_is_reparse(&path_after)
        || !bkv_handle_still_matches_path(&file, &path)
        || read_total != artifact.size
        || format!("{:x}", digest.finalize()) != artifact.sha256
    {
        return Err(BkvRejection::new(
            "bkv_artifact_changed",
            "BKV replay artifact hash or size changed",
        ));
    }
    Ok(path)
}

fn verify_bkv_runtime_artifacts(
    index: &BkvServingIndex,
    deadline: Option<Instant>,
) -> Result<(), BkvRejection> {
    let mut total = 0u64;
    for artifact in &index.artifacts {
        if deadline.is_some_and(|limit| Instant::now() >= limit) {
            return Err(BkvRejection::new(
                "bkv_verification_timeout",
                "BKV artifact verification deadline exceeded",
            ));
        }
        if artifact.size > BKV_REPLAY_MAX_ARTIFACT_BYTES {
            return Err(BkvRejection::new(
                "bkv_artifact_changed",
                "BKV artifact exceeds the replay limit",
            ));
        }
        total = total.checked_add(artifact.size).ok_or_else(|| {
            BkvRejection::new("bkv_artifact_changed", "BKV artifact size overflow")
        })?;
        if total > BKV_REPLAY_MAX_TOTAL_ARTIFACT_BYTES {
            return Err(BkvRejection::new(
                "bkv_artifact_changed",
                "BKV batch exceeds the replay artifact limit",
            ));
        }
    }
    for artifact in &index.artifacts {
        verify_bkv_runtime_artifact(index, artifact, deadline)?;
    }
    Ok(())
}

pub(super) async fn load_bkv_replay_runtime(
    connection: &sea_orm::DatabaseConnection,
    configured_root: &Path,
) -> Result<BkvReplayRuntime, BkvRejection> {
    load_bkv_replay_runtime_with_deadline(connection, configured_root, None).await
}

pub(super) async fn load_bkv_replay_runtime_with_deadline(
    connection: &sea_orm::DatabaseConnection,
    configured_root: &Path,
    deadline: Option<Instant>,
) -> Result<BkvReplayRuntime, BkvRejection> {
    let active = bkv_config_json(
        db::get_config(connection, "bkv.active-batch")
            .await
            .map_err(|_| {
                BkvRejection::new("bkv_status_unavailable", "active batch lookup failed")
            })?,
        "bkv_active_batch_missing",
    )?;
    let batch_id = active
        .get("batchId")
        .and_then(Value::as_str)
        .filter(|value| bkv_valid_batch_id(value))
        .ok_or_else(|| BkvRejection::new("bkv_replay_state_invalid", "active batch id invalid"))?
        .to_string();
    let content_id = active
        .get("contentId")
        .and_then(Value::as_str)
        .filter(|value| bkv_valid_sha256(value))
        .ok_or_else(|| BkvRejection::new("bkv_replay_state_invalid", "active content id invalid"))?
        .to_string();
    let batch = bkv_config_json(
        db::get_config(connection, &format!("bkv.batch.{batch_id}"))
            .await
            .map_err(|_| BkvRejection::new("bkv_status_unavailable", "batch lookup failed"))?,
        "bkv_batch_state_missing",
    )?;
    if batch.get("batchId").and_then(Value::as_str) != Some(batch_id.as_str())
        || batch.get("contentId").and_then(Value::as_str) != Some(content_id.as_str())
        || !matches!(
            batch.get("status").and_then(Value::as_str),
            Some("ready" | "partial")
        )
    {
        return Err(BkvRejection::new(
            "bkv_replay_state_invalid",
            "active batch binding is invalid",
        ));
    }
    let summary = batch
        .get("summary")
        .ok_or_else(|| BkvRejection::new("bkv_replay_state_invalid", "batch summary missing"))?;
    let manifest_relative = summary
        .get("manifestPath")
        .and_then(Value::as_str)
        .ok_or_else(|| BkvRejection::new("bkv_replay_state_invalid", "manifest path missing"))?;
    let semantic_digest = summary
        .get("semanticDigest")
        .and_then(Value::as_str)
        .filter(|value| bkv_valid_sha256(value))
        .ok_or_else(|| BkvRejection::new("bkv_replay_state_invalid", "semantic digest invalid"))?;
    let manifest_sha256 = summary
        .get("manifestSha256")
        .and_then(Value::as_str)
        .filter(|value| bkv_valid_sha256(value))
        .ok_or_else(|| BkvRejection::new("bkv_replay_state_invalid", "manifest hash invalid"))?;
    let publication_sha256 = summary
        .get("publicationSha256")
        .and_then(Value::as_str)
        .filter(|value| bkv_valid_sha256(value))
        .ok_or_else(|| BkvRejection::new("bkv_replay_state_invalid", "publication hash invalid"))?;
    let verification_identity = bkv_runtime_verification_identity(
        configured_root,
        &batch_id,
        &content_id,
        semantic_digest,
        manifest_sha256,
        publication_sha256,
    );
    let verification_lock = bkv_runtime_verification_lock(&verification_identity)?;
    let verification_guard =
        bkv_lock_runtime_verification_with_deadline(&verification_lock, deadline)?;
    #[cfg(test)]
    let _verification_active_guard = {
        let active = {
            let mut active = BKV_RUNTIME_VERIFICATIONS_ACTIVE
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
                .expect("BKV verification active counter lock");
            let count = active.entry(verification_identity.clone()).or_default();
            *count += 1;
            *count
        };
        let mut maximums = BKV_RUNTIME_VERIFICATIONS_MAX
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .expect("BKV verification maximum counter lock");
        let maximum = maximums.entry(verification_identity.clone()).or_default();
        *maximum = (*maximum).max(active);
        BkvRuntimeVerificationActiveGuard(verification_identity.clone())
    };
    let index = load_bkv_serving_index_with_deadline(
        configured_root,
        &configured_root.join(manifest_relative),
        &batch_id,
        &content_id,
        semantic_digest,
        manifest_sha256,
        publication_sha256,
        deadline,
    )?;
    verify_bkv_runtime_artifacts(&index, deadline)?;
    #[cfg(test)]
    drop(_verification_active_guard);
    drop(verification_guard);
    let mut channels = std::collections::BTreeSet::new();
    for artifact in &index.artifacts {
        channels.insert(artifact.camera_number);
    }
    let channels = channels.into_iter().collect::<Vec<_>>();
    if channels != vec![1, 2, 3, 4, 5, 6] {
        return Err(BkvRejection::new(
            "bkv_channel_coverage_invalid",
            "BKV replay must contain six channels",
        ));
    }
    let replay = bkv_config_json(
        db::get_config(connection, &format!("bkv.replay.{batch_id}"))
            .await
            .map_err(|_| BkvRejection::new("bkv_status_unavailable", "replay lookup failed"))?,
        "bkv_replay_state_missing",
    )?;
    let (replay_index, replay_status, replay_version, selected_inspection) =
        bkv_validate_replay_state(connection, &batch_id, &content_id, &replay).await?;
    if let Some(selected) = selected_inspection.as_ref() {
        let expected = index
            .deterministic_inspections
            .get(&selected.evidence.legacy_seq_no)
            .ok_or_else(|| {
                BkvRejection::new(
                    "bkv_selected_inspection_invalid",
                    "selected deterministic mapping is missing",
                )
            })?;
        if !bkv_inspection_matches_expected(&selected.model, expected) {
            return Err(BkvRejection::new(
                "bkv_selected_inspection_invalid",
                "selected inspection does not match deterministic evidence",
            ));
        }
    }
    Ok(BkvReplayRuntime {
        batch_id,
        content_id,
        channels,
        replay_index,
        replay_status,
        replay_version,
        replay_snapshot: replay,
        selected_inspection: selected_inspection.map(|selected| selected.evidence),
        artifacts: index.artifacts,
        deterministic_inspections: index.deterministic_inspections,
    })
}

pub(super) async fn advance_bkv_replay(
    connection: &sea_orm::DatabaseConnection,
    configured_root: &Path,
    actor: &str,
) -> Result<BkvReplaySelection, BkvRejection> {
    let runtime = load_bkv_replay_runtime(connection, configured_root).await?;
    if runtime.replay_status == "completed" || runtime.replay_index >= BKV_TARGET_SEQ_NOS.len() {
        return Err(BkvRejection::new(
            "bkv_replay_completed",
            "BKV replay is complete",
        ));
    }
    let legacy_seq_no = BKV_TARGET_SEQ_NOS[runtime.replay_index];
    let manifest_path = configured_root
        .join(&runtime.batch_id)
        .join("manifest.json");
    let batch_config = bkv_config_json(
        db::get_config(connection, &format!("bkv.batch.{}", runtime.batch_id))
            .await
            .map_err(|_| BkvRejection::new("bkv_status_unavailable", "batch lookup failed"))?,
        "bkv_batch_state_missing",
    )?;
    let summary = &batch_config["summary"];
    let verification_identity = bkv_runtime_verification_identity(
        configured_root,
        &runtime.batch_id,
        &runtime.content_id,
        summary["semanticDigest"].as_str().unwrap_or_default(),
        summary["manifestSha256"].as_str().unwrap_or_default(),
        summary["publicationSha256"].as_str().unwrap_or_default(),
    );
    let verification_lock = bkv_runtime_verification_lock(&verification_identity)?;
    let _verification_guard =
        bkv_lock_runtime_verification_with_deadline(&verification_lock, None)?;
    let serving_index = load_bkv_serving_index(
        configured_root,
        &manifest_path,
        &runtime.batch_id,
        &runtime.content_id,
        summary["semanticDigest"].as_str().unwrap_or_default(),
        summary["manifestSha256"].as_str().unwrap_or_default(),
        summary["publicationSha256"].as_str().unwrap_or_default(),
    )?;
    let mut selected_artifacts = Vec::new();
    let mut selected_channels = std::collections::BTreeSet::new();
    verify_bkv_runtime_artifacts(&serving_index, None)?;
    for artifact in serving_index
        .artifacts
        .iter()
        .filter(|artifact| artifact.seq_no == legacy_seq_no)
    {
        selected_channels.insert(artifact.camera_number);
        selected_artifacts.push(BkvReplayArtifactEvidence {
            path: artifact.relative_path.clone(),
            sha256: artifact.sha256.clone(),
            size: artifact.size,
            camera_number: artifact.camera_number,
            kind: artifact.kind.clone(),
            verified: true,
        });
    }
    if selected_channels.into_iter().collect::<Vec<_>>() != vec![1, 2, 3, 4, 5, 6] {
        return Err(BkvRejection::new(
            "bkv_seq_artifacts_incomplete",
            "selected SeqNo does not contain six channels",
        ));
    }
    let reviewed_partial = batch_config.get("status").and_then(Value::as_str) == Some("partial");
    let verified = load_bkv_batch(configured_root, &manifest_path, reviewed_partial)?;
    if verified.batch_id != runtime.batch_id || verified.content_id != runtime.content_id {
        return Err(BkvRejection::new(
            "bkv_manifest_changed",
            "active manifest binding changed before replay selection",
        ));
    }
    let deterministic_batch = bkv_validated_to_db(&verified)?;
    let expected_material = deterministic_batch
        .materials
        .iter()
        .find(|material| material.seq_no == legacy_seq_no)
        .ok_or_else(|| {
            BkvRejection::new(
                "bkv_imported_data_unavailable",
                "deterministic inspection mapping is missing",
            )
        })?;
    let inspection = db::find_production_inspection(connection, &expected_material.inspection_id)
        .await
        .map_err(|_| {
            BkvRejection::new("bkv_imported_data_unavailable", "inspection lookup failed")
        })?
        .ok_or_else(|| {
            BkvRejection::new(
                "bkv_imported_data_unavailable",
                "selected imported inspection is missing",
            )
        })?;
    let expected_capture_count = deterministic_batch
        .artifacts
        .iter()
        .filter(|row| row.inspection_id == expected_material.inspection_id)
        .count()
        .min(i32::MAX as usize) as i32;
    let expected_defect_count = deterministic_batch
        .defects
        .iter()
        .filter(|row| row.inspection_id == expected_material.inspection_id)
        .count()
        .min(i32::MAX as usize) as i32;
    if inspection.id != expected_material.inspection_id
        || inspection.material_id != expected_material.material_id
        || inspection.session_id != expected_material.session_id
        || inspection.status != "completed"
        || inspection.started_at != expected_material.occurred_at
        || inspection.finished_at != expected_material.occurred_at
        || inspection.capture_count != expected_capture_count
        || inspection.defect_count != expected_defect_count
        || !inspection.storage_root.is_empty()
        || !inspection.summary_path.is_empty()
        || inspection.raw_payload != expected_material.raw_payload
    {
        return Err(BkvRejection::new(
            "bkv_imported_parent_invalid",
            "imported BKV inspection does not match deterministic parent fields",
        ));
    }
    let inspection_evidence = bkv_imported_inspection_evidence(
        &inspection,
        &runtime.batch_id,
        &runtime.content_id,
        legacy_seq_no,
    )?;
    let capture_rows = db::capture_files_for_inspection(connection, &inspection.id)
        .await
        .map_err(|_| BkvRejection::new("bkv_imported_data_unavailable", "capture lookup failed"))?;
    let defect_rows = db::production_defects_for_inspection(connection, &inspection.id)
        .await
        .map_err(|_| BkvRejection::new("bkv_imported_data_unavailable", "defect lookup failed"))?;
    let expected_captures = deterministic_batch
        .artifacts
        .iter()
        .filter(|row| row.inspection_id == inspection.id)
        .collect::<Vec<_>>();
    let capture_by_id = capture_rows
        .iter()
        .map(|row| (row.id.as_str(), row))
        .collect::<HashMap<_, _>>();
    let captures_match = capture_rows.len() == expected_captures.len()
        && expected_captures.iter().all(|expected| {
            capture_by_id.get(expected.id.as_str()).is_some_and(|row| {
                row.inspection_id == expected.inspection_id
                    && row.session_id == expected.session_id
                    && row.material_id == expected.material_id
                    && row.camera_id == expected.camera_id
                    && row.data_name == expected.data_name
                    && i64::from(row.sequence_no) == expected.sequence_no
                    && row.file_type == expected.file_type
                    && row.path == expected.path
                    && row.metadata_path == expected.metadata_path
            })
        });
    let expected_defects = deterministic_batch
        .defects
        .iter()
        .filter(|row| row.inspection_id == inspection.id)
        .collect::<Vec<_>>();
    let defect_by_id = defect_rows
        .iter()
        .map(|row| (row.id.as_str(), row))
        .collect::<HashMap<_, _>>();
    let defects_match = defect_rows.len() == expected_defects.len()
        && expected_defects.iter().all(|expected| {
            defect_by_id.get(expected.id.as_str()).is_some_and(|row| {
                row.inspection_id == expected.inspection_id
                    && row.material_id == expected.material_id
                    && row.camera_id == expected.camera_id
                    && row.defect_type == expected.defect_type
                    && row.severity == expected.severity
                    && row.x_mm == expected.x_mm
                    && row.y_mm == expected.y_mm
                    && row.z_mm == expected.z_mm
                    && row.width_mm == expected.width_mm
                    && row.height_mm == expected.height_mm
                    && row.depth_mm == expected.depth_mm
                    && row.confidence == expected.confidence
                    && row.geometry_json == expected.provenance_json
            })
        });
    if !captures_match || !defects_match {
        return Err(BkvRejection::new(
            "bkv_imported_children_invalid",
            "imported BKV child rows do not match the deterministic manifest mapping",
        ));
    }
    let captures = expected_captures
        .iter()
        .map(|expected| {
            let evidence = selected_artifacts
                .iter()
                .find(|artifact| {
                    bkv_artifact_token(&runtime.batch_id, &artifact.path) == expected.path
                })
                .ok_or_else(|| {
                    BkvRejection::new(
                        "bkv_imported_children_invalid",
                        "capture evidence is missing from the serving index",
                    )
                })?;
            Ok(json!({
                "id":expected.id,
                "cameraId":expected.camera_id,
                "sequenceNo":expected.sequence_no,
                "fileType":expected.file_type,
                "artifactToken":expected.path,
                "metadataToken":expected.metadata_path,
                "sha256":evidence.sha256,
                "size":evidence.size,
                "verified":true
            }))
        })
        .collect::<Result<Vec<_>, BkvRejection>>()?;
    let defects = expected_defects
        .iter()
        .map(|row| {
            json!({
                "id":row.id,"cameraId":row.camera_id,"type":row.defect_type,
                "severity":row.severity,"xMm":row.x_mm,"yMm":row.y_mm,"zMm":row.z_mm,
                "widthMm":row.width_mm,"heightMm":row.height_mm,"depthMm":row.depth_mm,
                "confidence":row.confidence
            })
        })
        .collect::<Vec<_>>();
    let replay_key = format!("bkv.replay.{}", runtime.batch_id);
    let transaction = connection
        .begin()
        .await
        .map_err(|_| BkvRejection::new("bkv_replay_update_failed", "transaction unavailable"))?;
    let replay_model = app_config::Entity::find()
        .filter(app_config::Column::Key.eq(&replay_key))
        .one(&transaction)
        .await
        .map_err(|_| BkvRejection::new("bkv_replay_update_failed", "replay lookup failed"))?
        .ok_or_else(|| BkvRejection::new("bkv_replay_state_missing", "replay state missing"))?;
    let current: Value = serde_json::from_str(&replay_model.value)
        .map_err(|_| BkvRejection::new("bkv_replay_state_invalid", "replay state invalid"))?;
    if current != runtime.replay_snapshot
        || current.get("version").and_then(Value::as_i64) != Some(runtime.replay_version)
        || current.get("index").and_then(Value::as_u64) != Some(runtime.replay_index as u64)
    {
        transaction.rollback().await.ok();
        return Err(BkvRejection::new(
            "bkv_replay_conflict",
            "replay version changed",
        ));
    }
    let next_index = runtime.replay_index + 1;
    let status = if next_index == BKV_TARGET_SEQ_NOS.len() {
        "completed"
    } else {
        "replaying"
    };
    let version = runtime.replay_version.saturating_add(1);
    let now = current_time_string();
    let next = json!({
        "batchId":runtime.batch_id,"contentId":runtime.content_id,"index":next_index,
        "status":status,"version":version,"updatedAt":now,"advancedBy":actor,
        "selectedLegacySeqNo":legacy_seq_no,"selectedInspectionId":inspection.id
    });
    let update = app_config::Entity::update_many()
        .col_expr(app_config::Column::Value, Expr::value(next.to_string()))
        .col_expr(app_config::Column::UpdatedAt, Expr::value(now))
        .filter(app_config::Column::Key.eq(&replay_key))
        .filter(app_config::Column::Value.eq(replay_model.value))
        .exec(&transaction)
        .await
        .map_err(|_| BkvRejection::new("bkv_replay_update_failed", "replay update failed"))?;
    if update.rows_affected != 1 {
        transaction.rollback().await.ok();
        return Err(BkvRejection::new(
            "bkv_replay_conflict",
            "replay compare-and-swap failed",
        ));
    }
    transaction
        .commit()
        .await
        .map_err(|_| BkvRejection::new("bkv_replay_update_failed", "replay commit failed"))?;
    Ok(BkvReplaySelection {
        batch_id: runtime.batch_id,
        content_id: runtime.content_id,
        legacy_seq_no,
        previous_index: runtime.replay_index,
        next_index,
        status: status.to_string(),
        version,
        inspection_id: inspection.id,
        material_id: inspection.material_id,
        session_id: inspection.session_id,
        inspection: inspection_evidence,
        artifacts: selected_artifacts,
        captures,
        defects,
    })
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

fn bkv_parent_inspection_legacy_id(
    check_row_legacy_id: Option<Option<String>>,
    material_legacy_id: &str,
) -> String {
    check_row_legacy_id
        .flatten()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| material_legacy_id.to_string())
}

fn bkv_parent_occurred_at(
    check_row_time: Option<Option<String>>,
    material_row_time: Option<String>,
    seq_no: i64,
) -> String {
    match check_row_time {
        Some(check_time) => check_time,
        None => material_row_time,
    }
    .unwrap_or_else(|| seq_no.to_string())
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
        let check_row = check_rows.first().copied();
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
            &bkv_parent_inspection_legacy_id(
                check_row.map(|row| bkv_row_text(row, &["id", "checkrecordid", "originalRowHash"])),
                &legacy_id,
            ),
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
            occurred_at: bkv_parent_occurred_at(
                check_row.map(|row| {
                    bkv_row_text(
                        row,
                        &["time", "checktime", "datetime", "detecttime", "createdat"],
                    )
                }),
                bkv_row_text(
                    material_row,
                    &["time", "checktime", "datetime", "detecttime", "createdat"],
                ),
                *seq_no,
            ),
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

fn bkv_final_db_batch(
    verified: &BkvValidatedBatch,
    final_verification: &BkvValidatedBatch,
) -> Result<db::BkvImportBatch, BkvRejection> {
    if final_verification.batch_id != verified.batch_id
        || final_verification.content_id != verified.content_id
        || final_verification.status != verified.status
        || final_verification.semantic_digest != verified.semantic_digest
    {
        return Err(BkvRejection::new(
            "bkv_manifest_changed",
            "batch semantics changed before transaction",
        ));
    }
    bkv_validated_to_db(final_verification)
}

fn bkv_rejection_response(error: BkvRejection) -> Vec<u8> {
    let status = match error.code {
        "bkv_root_invalid"
        | "bkv_manifest_unavailable"
        | "bkv_file_unavailable"
        | "bkv_status_unavailable"
        | "bkv_imported_data_unavailable" => "503 Service Unavailable",
        "bkv_batch_failed" | "bkv_partial_review_required" | "bkv_batch_id_collision" => {
            "409 Conflict"
        }
        "bkv_replay_completed" | "bkv_replay_conflict" => "409 Conflict",
        _ => "422 Unprocessable Entity",
    };
    http_response(
        status,
        "application/json; charset=utf-8",
        &json!({"code":error.code,"error":error.code,"message":"BKV request could not be processed"}).to_string(),
    )
}

pub(super) fn configured_bkv_root() -> Result<PathBuf, BkvRejection> {
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

pub(super) fn bkv_capture_once_response(
    state: &ServiceState,
    configured_root: &Path,
    actor: &str,
) -> Vec<u8> {
    match state.runtime.block_on(advance_bkv_replay(
        &state.database.connection,
        configured_root,
        actor,
    )) {
        Ok(selection) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &bkv_replay_selection_value(&selection).to_string(),
        ),
        Err(error) => bkv_rejection_response(error),
    }
}

fn bkv_replay_selection_value(selection: &BkvReplaySelection) -> Value {
    json!({
        "code":0,
        "source":"bkv",
        "offline":true,
        "provider":"bkv",
        "cameraCount":6,
        "batchId":selection.batch_id,
        "contentId":selection.content_id,
        "legacySeqNo":selection.legacy_seq_no,
        "inspectionId":selection.inspection_id,
        "materialId":selection.material_id,
        "sessionId":selection.session_id,
        "inspection":{
            "id":selection.inspection.id,
            "status":selection.inspection.status,
            "captureCount":selection.inspection.capture_count,
            "defectCount":selection.inspection.defect_count,
            "batchId":selection.inspection.batch_id,
            "contentId":selection.inspection.content_id,
            "legacySeqNo":selection.inspection.legacy_seq_no,
            "provenance":selection.inspection.provenance
        },
        "replay":{
            "previousIndex":selection.previous_index,
            "index":selection.next_index,
            "status":selection.status,
            "version":selection.version,
            "total":BKV_TARGET_SEQ_NOS.len()
        },
        "artifacts":selection.artifacts.iter().map(|artifact| json!({
            "path":artifact.path,
            "sha256":artifact.sha256,
            "size":artifact.size,
            "cameraNumber":artifact.camera_number,
            "kind":artifact.kind,
            "verified":artifact.verified
        })).collect::<Vec<_>>(),
        "captures":selection.captures,
        "defects":selection.defects
    })
}

pub(super) fn bkv_capture_once_configured_response(state: &ServiceState, actor: &str) -> Vec<u8> {
    match configured_bkv_root() {
        Ok(root) => bkv_capture_once_response(state, &root, actor),
        Err(error) => bkv_rejection_response(error),
    }
}

pub(super) async fn selected_bkv_inspection(
    connection: &sea_orm::DatabaseConnection,
) -> Result<Option<db::entities::production_inspection::Model>, BkvRejection> {
    let active = match db::get_config(connection, "bkv.active-batch")
        .await
        .map_err(|_| BkvRejection::new("bkv_status_unavailable", "active batch lookup failed"))?
    {
        Some(value) => serde_json::from_str::<Value>(&value.value)
            .map_err(|_| BkvRejection::new("bkv_replay_state_invalid", "active batch invalid"))?,
        None => {
            return Err(BkvRejection::new(
                "bkv_active_batch_missing",
                "active BKV batch is missing",
            ))
        }
    };
    let batch_id = active
        .get("batchId")
        .and_then(Value::as_str)
        .filter(|value| bkv_valid_batch_id(value))
        .ok_or_else(|| BkvRejection::new("bkv_replay_state_invalid", "active batch id missing"))?;
    let content_id = active
        .get("contentId")
        .and_then(Value::as_str)
        .filter(|value| bkv_valid_sha256(value))
        .ok_or_else(|| {
            BkvRejection::new("bkv_replay_state_invalid", "active content id missing")
        })?;
    let replay = bkv_config_json(
        db::get_config(connection, &format!("bkv.replay.{batch_id}"))
            .await
            .map_err(|_| BkvRejection::new("bkv_status_unavailable", "replay lookup failed"))?,
        "bkv_replay_state_missing",
    )?;
    let (_, _, _, selected) =
        bkv_validate_replay_state(connection, batch_id, content_id, &replay).await?;
    Ok(selected.map(|inspection| inspection.model))
}

pub(super) async fn selected_bkv_inspection_id(
    connection: &sea_orm::DatabaseConnection,
) -> Result<Option<String>, BkvRejection> {
    Ok(selected_bkv_inspection(connection)
        .await?
        .map(|inspection| inspection.id))
}

#[cfg(test)]
pub(super) async fn selected_bkv_inspection_unverified_test(
    connection: &sea_orm::DatabaseConnection,
) -> Result<Option<db::entities::production_inspection::Model>, BkvRejection> {
    let active = bkv_config_json(
        db::get_config(connection, "bkv.active-batch")
            .await
            .map_err(|_| BkvRejection::new("bkv_status_unavailable", "active lookup failed"))?,
        "bkv_active_batch_missing",
    )?;
    let batch_id = active
        .get("batchId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let replay = bkv_config_json(
        db::get_config(connection, &format!("bkv.replay.{batch_id}"))
            .await
            .map_err(|_| BkvRejection::new("bkv_status_unavailable", "replay lookup failed"))?,
        "bkv_replay_state_missing",
    )?;
    let Some(id) = replay.get("selectedInspectionId").and_then(Value::as_str) else {
        return Ok(None);
    };
    let model = db::find_production_inspection(connection, id)
        .await
        .map_err(|_| {
            BkvRejection::new("bkv_imported_data_unavailable", "inspection lookup failed")
        })?;
    let Some(model) = model else {
        return Ok(None);
    };
    let raw: Value = serde_json::from_str(&model.raw_payload).map_err(|_| {
        BkvRejection::new(
            "bkv_selected_inspection_invalid",
            "selected provenance invalid",
        )
    })?;
    if raw.get("source").and_then(Value::as_str) != Some("bkv")
        || raw.get("batchId") != active.get("batchId")
        || raw.get("contentId") != active.get("contentId")
        || raw.get("legacySeqNo") != replay.get("selectedLegacySeqNo")
    {
        return Err(BkvRejection::new(
            "bkv_selected_inspection_invalid",
            "selected provenance binding invalid",
        ));
    }
    Ok(Some(model))
}

pub(super) async fn selected_bkv_inspection_exact(
    connection: &sea_orm::DatabaseConnection,
    deterministic_inspections: &HashMap<i64, BkvExpectedInspection>,
) -> Result<Option<db::entities::production_inspection::Model>, BkvRejection> {
    let selected = selected_bkv_inspection(connection).await?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let raw: Value = serde_json::from_str(&selected.raw_payload).map_err(|_| {
        BkvRejection::new(
            "bkv_selected_inspection_invalid",
            "selected provenance invalid",
        )
    })?;
    let seq_no = raw
        .get("legacySeqNo")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            BkvRejection::new("bkv_selected_inspection_invalid", "selected SeqNo invalid")
        })?;
    let expected = deterministic_inspections.get(&seq_no).ok_or_else(|| {
        BkvRejection::new(
            "bkv_selected_inspection_invalid",
            "selected mapping missing",
        )
    })?;
    if !bkv_inspection_matches_expected(&selected, expected) {
        return Err(BkvRejection::new(
            "bkv_selected_inspection_invalid",
            "selected inspection does not match deterministic evidence",
        ));
    }
    Ok(Some(selected))
}

async fn bkv_status_value(
    connection: &sea_orm::DatabaseConnection,
    configured_root: &Path,
) -> Result<Value, BkvRejection> {
    if db::get_config(connection, "bkv.active-batch")
        .await
        .map_err(|_| BkvRejection::new("bkv_status_unavailable", "active batch lookup failed"))?
        .is_none()
    {
        return Ok(json!({"code":0,"active":false}));
    }
    let runtime = load_bkv_replay_runtime_with_deadline(
        connection,
        configured_root,
        Some(Instant::now() + Duration::from_millis(1_500)),
    )
    .await?;
    let selected =
        selected_bkv_inspection_exact(connection, &runtime.deterministic_inspections).await?;
    if runtime.replay_index > 0 && selected.is_none() {
        return Err(BkvRejection::new(
            "bkv_replay_state_invalid",
            "active replay selection is missing",
        ));
    }
    let batch = bkv_config_json(
        db::get_config(connection, &format!("bkv.batch.{}", runtime.batch_id))
            .await
            .map_err(|_| BkvRejection::new("bkv_status_unavailable", "batch lookup failed"))?,
        "bkv_batch_state_missing",
    )?;
    Ok(json!({
        "code":0,
        "active":true,
        "activeBatch": {"batchId":runtime.batch_id,"contentId":runtime.content_id},
        "batch": {
            "batchId":batch.get("batchId"),
            "contentId":batch.get("contentId"),
            "status":batch.get("status"),
            "counts":batch.get("counts")
        },
        "replay": {
            "index":runtime.replay_index,
            "status":runtime.replay_status,
            "version":runtime.replay_version
        }
    }))
}

pub(super) fn bkv_status_response(state: &ServiceState) -> Vec<u8> {
    match state.runtime.block_on(db::get_config(
        &state.database.connection,
        "bkv.active-batch",
    )) {
        Ok(None) => {
            return http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({"code":0,"active":false}).to_string(),
            )
        }
        Err(_) => {
            return bkv_rejection_response(BkvRejection::new(
                "bkv_status_unavailable",
                "active batch lookup failed",
            ))
        }
        Ok(Some(_)) => {}
    }
    let root = match configured_bkv_root() {
        Ok(root) => root,
        Err(error) => {
            #[cfg(test)]
            if let Err(selected_error) = state
                .runtime
                .block_on(selected_bkv_inspection(&state.database.connection))
            {
                return bkv_rejection_response(selected_error);
            }
            return bkv_rejection_response(error);
        }
    };
    match state
        .runtime
        .block_on(bkv_status_value(&state.database.connection, &root))
    {
        Ok(value) => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &value.to_string(),
        ),
        Err(error) => bkv_rejection_response(error),
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
    if let Err(error) = bkv_validated_to_db(&verified) {
        return bkv_rejection_response(error);
    }
    let final_verification = match load_bkv_batch(&root, &manifest_path, reviewed) {
        Ok(batch) => batch,
        Err(error) => return bkv_rejection_response(error),
    };
    let db_batch = match bkv_final_db_batch(&verified, &final_verification) {
        Ok(batch) => batch,
        Err(error) => return bkv_rejection_response(error),
    };
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

pub(super) fn normalize_kind(value: &str) -> Option<&'static str> {
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
    if let Some(capability) = runtime_capability_for_production_task_kind(&task.kind) {
        if !state.runtime_config.allows(capability) {
            return http_response(
                "409 Conflict",
                "application/json; charset=utf-8",
                &json!({
                    "code": 409,
                    "error": "runtime_capability_unavailable",
                    "capability": capability.as_str(),
                    "profileId": state.runtime_config.id,
                    "message": "The active runtime profile does not provide this task capability"
                })
                .to_string(),
            );
        }
    }
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
        if state.runtime_config.acquisition_mode == runtime_profile::AcquisitionMode::Offline {
            set_worker_status(&state, false, None, None);
            wait_for_work(&state);
            continue;
        }
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

    fn write_bkv_replay_test_batch(root: &Path) -> PathBuf {
        let path = write_bkv_test_batch(root, "ready", false);
        let batch = path.parent().unwrap();
        let mut manifest: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let mut artifacts = Vec::new();
        for seq_no in BKV_TARGET_SEQ_NOS {
            for camera_number in 1..=6 {
                let relative = format!(
                    "artifacts/camera{camera_number}/{seq_no}/2d/camera-{camera_number}.jpg"
                );
                let payload = format!("bkv-{seq_no}-{camera_number}").into_bytes();
                fs::create_dir_all(batch.join(&relative).parent().unwrap()).unwrap();
                fs::write(batch.join(&relative), &payload).unwrap();
                artifacts.push(json!({
                    "path": relative,
                    "memberPath": format!("image_copy/CamImageSource{camera_number}/{seq_no}/2D/camera-{camera_number}.jpg"),
                    "size": payload.len(),
                    "sha256": bkv_sha256(&payload),
                    "cameraNumber": camera_number,
                    "seqNo": seq_no,
                    "kind": "2d",
                    "extension": ".jpg"
                }));
            }
        }
        manifest["artifacts"] = Value::Array(artifacts);
        manifest["batchContentId"] = json!("0".repeat(64));
        manifest["contentId"] = manifest["batchContentId"].clone();
        let content_id = bkv_batch_content_id(&manifest).unwrap();
        manifest["batchContentId"] = json!(content_id);
        manifest["contentId"] = manifest["batchContentId"].clone();
        fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        fs::write(
            batch.join("publication.json"),
            serde_json::to_vec(&json!({
                "schema":"steel.bkv-publication.v1","state":"committed",
                "batchId":"batch-001","contentId":manifest["contentId"]
            }))
            .unwrap(),
        )
        .unwrap();
        path
    }

    fn imported_bkv_replay_fixture(name: &str) -> (Runtime, db::AppDatabase, PathBuf) {
        let root = bkv_test_root(name);
        let manifest = write_bkv_replay_test_batch(&root);
        let runtime = Runtime::new().unwrap();
        let database = runtime
            .block_on(db::open_database_url(
                "sqlite::memory:".to_string(),
                PathBuf::from(":memory:"),
            ))
            .unwrap();
        let verified = load_bkv_batch(&root, &manifest, false).unwrap();
        let batch = bkv_validated_to_db(&verified).unwrap();
        runtime
            .block_on(db::import_bkv_batch(
                &database.connection,
                batch,
                "bkv-test",
            ))
            .unwrap();
        (runtime, database, root)
    }

    fn imported_bkv_replay_fixture_with_missing_check_time(
        name: &str,
    ) -> (Runtime, db::AppDatabase, PathBuf) {
        let root = bkv_test_root(name);
        let manifest_path = write_bkv_replay_test_batch(&root);
        let batch_dir = manifest_path.parent().unwrap();
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        let allexcel_path = batch_dir.join("normalized/allexcel.jsonl");
        let mut allexcel_rows = fs::read_to_string(&allexcel_path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        allexcel_rows[0]["time"] = json!("must-not-be-used");
        let allexcel_payload = allexcel_rows
            .iter()
            .map(|row| format!("{}\n", row))
            .collect::<String>();
        fs::write(&allexcel_path, &allexcel_payload).unwrap();
        let checkrecord_payload = format!(
            "{}\n",
            json!({
                "legacySeqNo":BKV_TARGET_SEQ_NOS[0],
                "legacyTable":"checkrecord",
                "id":"check-without-time",
                "originalRowHash":"9".repeat(64)
            })
        );
        fs::write(
            batch_dir.join("normalized/checkrecord.jsonl"),
            &checkrecord_payload,
        )
        .unwrap();
        for (table, payload, count) in [
            ("allexcel", allexcel_payload.as_str(), 11u64),
            ("checkrecord", checkrecord_payload.as_str(), 1u64),
        ] {
            let item = manifest["normalized"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|item| item["table"] == table)
                .unwrap();
            item["size"] = json!(payload.len());
            item["sha256"] = json!(bkv_sha256(payload.as_bytes()));
            item["count"] = json!(count);
        }
        manifest["batchContentId"] = json!("0".repeat(64));
        manifest["contentId"] = manifest["batchContentId"].clone();
        let content_id = bkv_batch_content_id(&manifest).unwrap();
        manifest["batchContentId"] = json!(content_id);
        manifest["contentId"] = manifest["batchContentId"].clone();
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        fs::write(
            batch_dir.join("publication.json"),
            serde_json::to_vec(&json!({
                "schema":"steel.bkv-publication.v1",
                "state":"committed",
                "batchId":"batch-001",
                "contentId":manifest["contentId"]
            }))
            .unwrap(),
        )
        .unwrap();
        let runtime = Runtime::new().unwrap();
        let database = runtime
            .block_on(db::open_database_url(
                "sqlite::memory:".to_string(),
                PathBuf::from(":memory:"),
            ))
            .unwrap();
        let verified = load_bkv_batch(&root, &manifest_path, false).unwrap();
        let batch = bkv_validated_to_db(&verified).unwrap();
        runtime
            .block_on(db::import_bkv_batch(
                &database.connection,
                batch,
                "bkv-test",
            ))
            .unwrap();
        (runtime, database, root)
    }

    #[test]
    fn bkv_runtime_health_requires_six_verified_offline_channels() {
        let (runtime, database, root) = imported_bkv_replay_fixture("runtime-health");
        let health = runtime
            .block_on(load_bkv_replay_runtime(&database.connection, &root))
            .unwrap();
        assert_eq!(health.batch_id, "batch-001");
        assert_eq!(health.channels, vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(health.replay_index, 0);
        assert_eq!(health.replay_status, "ready");
        assert_eq!(health.artifacts.len(), 66);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_checkrecord_without_time_uses_seq_no_in_full_and_compact_paths() {
        let (runtime, database, root) =
            imported_bkv_replay_fixture_with_missing_check_time("check-time-fallback");
        let selection = runtime
            .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
            .unwrap();
        let expected_time = BKV_TARGET_SEQ_NOS[0].to_string();
        let imported = runtime
            .block_on(db::find_production_inspection(
                &database.connection,
                &selection.inspection_id,
            ))
            .unwrap()
            .unwrap();
        assert_eq!(imported.started_at, expected_time);
        assert_eq!(imported.finished_at, expected_time);
        let replay = runtime
            .block_on(load_bkv_replay_runtime(&database.connection, &root))
            .unwrap();
        assert_eq!(
            replay
                .deterministic_inspections
                .get(&BKV_TARGET_SEQ_NOS[0])
                .unwrap()
                .started_at,
            expected_time
        );
        assert_eq!(
            runtime
                .block_on(bkv_status_value(&database.connection, &root))
                .unwrap()["active"],
            json!(true)
        );
        assert!(runtime
            .block_on(selected_bkv_inspection_exact(
                &database.connection,
                &replay.deterministic_inspections,
            ))
            .unwrap()
            .is_some());
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_replay_advances_in_order_completes_and_reset_returns_to_first_item() {
        let (runtime, database, root) = imported_bkv_replay_fixture("runtime-advance");
        for (index, seq_no) in BKV_TARGET_SEQ_NOS.into_iter().enumerate() {
            let selected = runtime
                .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
                .unwrap();
            assert_eq!(selected.legacy_seq_no, seq_no);
            assert_eq!(selected.previous_index, index);
            assert_eq!(selected.next_index, index + 1);
            assert_eq!(selected.artifacts.len(), 6);
            assert!(selected.artifacts.iter().all(|artifact| artifact.verified));
        }
        assert_eq!(
            runtime
                .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test",))
                .unwrap_err()
                .code,
            "bkv_replay_completed"
        );
        runtime
            .block_on(db::reset_bkv_replay(&database.connection, "bkv-test"))
            .unwrap();
        assert_eq!(
            runtime
                .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test",))
                .unwrap()
                .legacy_seq_no,
            BKV_TARGET_SEQ_NOS[0]
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_replay_state_machine_rejects_contradictory_status_index_selection_and_version() {
        let (runtime, database, root) = imported_bkv_replay_fixture("runtime-state-machine");
        let key = "bkv.replay.batch-001";
        let active: Value = serde_json::from_str(
            &runtime
                .block_on(db::get_config(&database.connection, "bkv.active-batch"))
                .unwrap()
                .unwrap()
                .value,
        )
        .unwrap();
        let content_id = active["contentId"].clone();
        for invalid in [
            json!({"batchId":"batch-001","contentId":content_id,"index":0,"status":"replaying","version":0}),
            json!({"batchId":"batch-001","contentId":content_id,"index":0,"status":"ready","version":0,"selectedLegacySeqNo":1893700,"selectedInspectionId":"unexpected"}),
            json!({"batchId":"batch-001","contentId":content_id,"index":0,"status":"ready","version":0,"selectedLegacySeqNo":"wrong-type","selectedInspectionId":7}),
            json!({"batchId":"batch-001","contentId":content_id,"index":1,"status":"replaying","version":0,"selectedLegacySeqNo":1893700,"selectedInspectionId":"missing"}),
            json!({"batchId":"batch-001","contentId":content_id,"index":11,"status":"replaying","version":11,"selectedLegacySeqNo":1893710,"selectedInspectionId":"missing"}),
        ] {
            runtime
                .block_on(db::set_config(
                    &database.connection,
                    key,
                    &invalid.to_string(),
                ))
                .unwrap();
            assert_eq!(
                runtime
                    .block_on(load_bkv_replay_runtime(&database.connection, &root))
                    .unwrap_err()
                    .code,
                "bkv_replay_state_invalid"
            );
            assert_eq!(
                runtime
                    .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
                    .unwrap_err()
                    .code,
                "bkv_replay_state_invalid"
            );
        }
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_replay_uses_exact_deterministic_inspection_id_beyond_recent_windows() {
        let (runtime, database, root) = imported_bkv_replay_fixture("exact-inspection-id");
        runtime
            .block_on(
                database.connection.execute(Statement::from_string(
                    DbBackend::Sqlite,
                    r#"
                WITH RECURSIVE seq(value) AS (
                    VALUES(1) UNION ALL SELECT value + 1 FROM seq WHERE value < 10001
                )
                INSERT INTO production_inspection (
                    id, material_id, session_id, status, storage_root, summary_path,
                    started_at, finished_at, capture_count, defect_count, raw_payload
                )
                SELECT
                    printf('newer-%05d', value), printf('REAL-%05d', value),
                    printf('real-session-%05d', value), 'completed', '', '',
                    '9999-12-31T23:59:59Z', '9999-12-31T23:59:59Z', 0, 0,
                    '{"source":"real"}'
                FROM seq
                "#
                    .to_string(),
                )),
            )
            .unwrap();
        let selected = runtime
            .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
            .unwrap();
        assert_eq!(selected.legacy_seq_no, 1_893_700);
        assert_eq!(selected.inspection.legacy_seq_no, 1_893_700);
        assert_eq!(selected.inspection.provenance["source"], "bkv");
        assert!(!selected.inspection.id.starts_with("newer-"));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_selected_inspection_must_match_active_batch_content_and_selected_seq() {
        let (runtime, database, root) = imported_bkv_replay_fixture("selected-binding");
        let selected = runtime
            .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
            .unwrap();
        assert_eq!(
            runtime
                .block_on(selected_bkv_inspection_id(&database.connection))
                .unwrap(),
            Some(selected.inspection_id.clone())
        );
        let key = "bkv.replay.batch-001";
        let original_replay = runtime
            .block_on(db::get_config(&database.connection, key))
            .unwrap()
            .unwrap()
            .value;
        let mut replay: Value = serde_json::from_str(&original_replay).unwrap();
        replay["selectedLegacySeqNo"] = json!(1_893_701);
        runtime
            .block_on(db::set_config(
                &database.connection,
                key,
                &replay.to_string(),
            ))
            .unwrap();
        assert_eq!(
            runtime
                .block_on(load_bkv_replay_runtime(&database.connection, &root))
                .unwrap_err()
                .code,
            "bkv_replay_state_invalid"
        );
        runtime
            .block_on(db::set_config(&database.connection, key, &original_replay))
            .unwrap();
        let wrong_inspection = runtime
            .block_on(db::list_recent_production_inspections(
                &database.connection,
                100,
            ))
            .unwrap()
            .into_iter()
            .find(|item| {
                serde_json::from_str::<Value>(&item.raw_payload)
                    .ok()
                    .and_then(|raw| raw["legacySeqNo"].as_i64())
                    == Some(1_893_701)
            })
            .unwrap();
        let mut replay: Value = serde_json::from_str(&original_replay).unwrap();
        replay["selectedInspectionId"] = json!(wrong_inspection.id);
        runtime
            .block_on(db::set_config(
                &database.connection,
                key,
                &replay.to_string(),
            ))
            .unwrap();
        assert_eq!(
            runtime
                .block_on(selected_bkv_inspection_id(&database.connection))
                .unwrap_err()
                .code,
            "bkv_selected_inspection_invalid"
        );
        runtime
            .block_on(db::set_config(&database.connection, key, &original_replay))
            .unwrap();
        let mut inspection = runtime
            .block_on(db::find_production_inspection(
                &database.connection,
                &selected.inspection_id,
            ))
            .unwrap()
            .unwrap();
        let original: Value = serde_json::from_str(&inspection.raw_payload).unwrap();
        for (field, invalid) in [
            ("source", json!("real")),
            ("batchId", json!("other-batch")),
            ("contentId", json!("f".repeat(64))),
            ("legacySeqNo", json!(1_893_701)),
        ] {
            let mut raw = original.clone();
            raw[field] = invalid;
            let mut candidate = inspection.clone();
            candidate.raw_payload = raw.to_string();
            assert_eq!(
                bkv_imported_inspection_evidence(
                    &candidate,
                    "batch-001",
                    selected.content_id.as_str(),
                    1_893_700,
                )
                .unwrap_err()
                .code,
                "bkv_selected_inspection_invalid"
            );
        }
        let mut raw: Value = serde_json::from_str(&inspection.raw_payload).unwrap();
        raw["contentId"] = json!("f".repeat(64));
        inspection.raw_payload = raw.to_string();
        runtime
            .block_on(db::upsert_production_inspection(
                &database.connection,
                db::ProductionInspectionInput {
                    id: inspection.id,
                    material_id: inspection.material_id,
                    session_id: inspection.session_id,
                    status: inspection.status,
                    storage_root: inspection.storage_root,
                    summary_path: inspection.summary_path,
                    started_at: inspection.started_at,
                    finished_at: inspection.finished_at,
                    capture_count: inspection.capture_count,
                    defect_count: inspection.defect_count,
                    raw_payload: inspection.raw_payload,
                },
            ))
            .unwrap();
        assert_eq!(
            runtime
                .block_on(selected_bkv_inspection_id(&database.connection))
                .unwrap_err()
                .code,
            "bkv_selected_inspection_invalid"
        );
        assert_eq!(
            runtime
                .block_on(load_bkv_replay_runtime(&database.connection, &root))
                .unwrap_err()
                .code,
            "bkv_selected_inspection_invalid"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_selected_inspection_id_must_equal_manifest_deterministic_id() {
        let (runtime, database, root) = imported_bkv_replay_fixture("selected-exact-id");
        let selected = runtime
            .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
            .unwrap();
        let deterministic_inspections = runtime
            .block_on(load_bkv_replay_runtime(&database.connection, &root))
            .unwrap()
            .deterministic_inspections;
        let original = runtime
            .block_on(db::find_production_inspection(
                &database.connection,
                &selected.inspection_id,
            ))
            .unwrap()
            .unwrap();
        runtime
            .block_on(db::upsert_production_inspection(
                &database.connection,
                db::ProductionInspectionInput {
                    id: "forged-same-provenance".to_string(),
                    material_id: original.material_id,
                    session_id: original.session_id,
                    status: original.status,
                    storage_root: original.storage_root,
                    summary_path: original.summary_path,
                    started_at: original.started_at,
                    finished_at: original.finished_at,
                    capture_count: original.capture_count,
                    defect_count: original.defect_count,
                    raw_payload: original.raw_payload,
                },
            ))
            .unwrap();
        let key = "bkv.replay.batch-001";
        let mut replay: Value = serde_json::from_str(
            &runtime
                .block_on(db::get_config(&database.connection, key))
                .unwrap()
                .unwrap()
                .value,
        )
        .unwrap();
        replay["selectedInspectionId"] = json!("forged-same-provenance");
        runtime
            .block_on(db::set_config(
                &database.connection,
                key,
                &replay.to_string(),
            ))
            .unwrap();

        assert_eq!(
            runtime
                .block_on(selected_bkv_inspection(&database.connection))
                .unwrap()
                .unwrap()
                .id,
            "forged-same-provenance"
        );
        assert_eq!(
            runtime
                .block_on(load_bkv_replay_runtime(&database.connection, &root))
                .unwrap_err()
                .code,
            "bkv_selected_inspection_invalid"
        );
        assert_eq!(
            runtime
                .block_on(selected_bkv_inspection_exact(
                    &database.connection,
                    &deterministic_inspections,
                ))
                .unwrap_err()
                .code,
            "bkv_selected_inspection_invalid"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_runtime_and_replay_fail_closed_when_an_artifact_is_tampered() {
        let (runtime, database, root) = imported_bkv_replay_fixture("runtime-tamper");
        fs::write(
            root.join("batch-001/artifacts/camera1/1893700/2d/camera-1.jpg"),
            b"tampered",
        )
        .unwrap();
        assert_eq!(
            runtime
                .block_on(load_bkv_replay_runtime(&database.connection, &root))
                .unwrap_err()
                .code,
            "bkv_artifact_changed"
        );
        assert_eq!(
            runtime
                .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test",))
                .unwrap_err()
                .code,
            "bkv_artifact_changed"
        );
        fs::write(
            root.join("batch-001/artifacts/camera1/1893700/2d/camera-1.jpg"),
            b"bkv-1893700-1",
        )
        .unwrap();
        fs::remove_file(root.join("batch-001/artifacts/camera2/1893700/2d/camera-2.jpg")).unwrap();
        assert_eq!(
            runtime
                .block_on(load_bkv_replay_runtime(&database.connection, &root))
                .unwrap_err()
                .code,
            "bkv_artifact_missing"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_replay_rejects_tampered_imported_capture_fields() {
        let (runtime, database, root) = imported_bkv_replay_fixture("capture-row-tamper");
        let inspection = runtime
            .block_on(db::list_recent_production_inspections(
                &database.connection,
                100,
            ))
            .unwrap()
            .into_iter()
            .find(|row| {
                serde_json::from_str::<Value>(&row.raw_payload)
                    .ok()
                    .and_then(|raw| raw.get("legacySeqNo").and_then(Value::as_i64))
                    == Some(BKV_TARGET_SEQ_NOS[0])
            })
            .unwrap();
        runtime
            .block_on(database.connection.execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "UPDATE capture_file SET path = ? WHERE inspection_id = ?",
                ["C:/legacy/raw/path.jpg".into(), inspection.id.into()],
            )))
            .unwrap();

        assert_eq!(
            runtime
                .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
                .unwrap_err()
                .code,
            "bkv_imported_children_invalid"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_replay_rejects_tampered_imported_defect_fields() {
        let (runtime, database, root) = imported_bkv_replay_fixture("defect-row-tamper");
        let inspection = runtime
            .block_on(db::list_recent_production_inspections(
                &database.connection,
                100,
            ))
            .unwrap()
            .into_iter()
            .find(|row| {
                serde_json::from_str::<Value>(&row.raw_payload)
                    .ok()
                    .and_then(|raw| raw.get("legacySeqNo").and_then(Value::as_i64))
                    == Some(BKV_TARGET_SEQ_NOS[0])
            })
            .unwrap();
        runtime
            .block_on(database.connection.execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                r#"INSERT INTO production_defect (
                    id, inspection_id, material_id, camera_id, defect_type, severity,
                    x_mm, y_mm, z_mm, width_mm, height_mm, depth_mm, confidence,
                    geometry_json, created_at
                ) VALUES ('forged-defect', ?, ?, 'bkv-camera-1', 'review', 'review',
                    0, 0, 0, 0, 0, 0, 1, '{}', 'now')"#,
                [inspection.id.into(), inspection.material_id.into()],
            )))
            .unwrap();

        assert_eq!(
            runtime
                .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
                .unwrap_err()
                .code,
            "bkv_imported_children_invalid"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_replay_rejects_every_tampered_parent_inspection_field() {
        let (runtime, database, root) = imported_bkv_replay_fixture("parent-row-tamper");
        let original = runtime
            .block_on(db::list_recent_production_inspections(
                &database.connection,
                100,
            ))
            .unwrap()
            .into_iter()
            .find(|row| {
                serde_json::from_str::<Value>(&row.raw_payload)
                    .ok()
                    .and_then(|raw| raw.get("legacySeqNo").and_then(Value::as_i64))
                    == Some(BKV_TARGET_SEQ_NOS[0])
            })
            .unwrap();
        for field in [
            "material_id",
            "session_id",
            "status",
            "storage_root",
            "summary_path",
            "started_at",
            "finished_at",
            "capture_count",
            "defect_count",
            "raw_payload",
        ] {
            let tampered = match field {
                "material_id" => "forged-material".to_string(),
                "session_id" => "forged-session".to_string(),
                "status" => "running".to_string(),
                "storage_root" => "C:/forged".to_string(),
                "summary_path" => "C:/forged.json".to_string(),
                "started_at" => format!("{}x", original.started_at),
                "finished_at" => format!("{}x", original.finished_at),
                "capture_count" => (original.capture_count + 1).to_string(),
                "defect_count" => (original.defect_count + 1).to_string(),
                "raw_payload" => json!({"source":"bkv"}).to_string(),
                _ => unreachable!(),
            };
            runtime
                .block_on(database.connection.execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    format!("UPDATE production_inspection SET {field} = ? WHERE id = ?"),
                    [tampered.into(), original.id.clone().into()],
                )))
                .unwrap();
            match runtime.block_on(advance_bkv_replay(&database.connection, &root, "bkv-test")) {
                Err(error) => assert_eq!(
                    error.code, "bkv_imported_parent_invalid",
                    "field {field} must fail closed"
                ),
                Ok(_) => panic!("field {field} was not rejected"),
            }
            let restored = match field {
                "material_id" => original.material_id.clone(),
                "session_id" => original.session_id.clone(),
                "status" => original.status.clone(),
                "storage_root" => original.storage_root.clone(),
                "summary_path" => original.summary_path.clone(),
                "started_at" => original.started_at.clone(),
                "finished_at" => original.finished_at.clone(),
                "capture_count" => original.capture_count.to_string(),
                "defect_count" => original.defect_count.to_string(),
                "raw_payload" => original.raw_payload.clone(),
                _ => unreachable!(),
            };
            runtime
                .block_on(database.connection.execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    format!("UPDATE production_inspection SET {field} = ? WHERE id = ?"),
                    [restored.into(), original.id.clone().into()],
                )))
                .unwrap();
        }
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_runtime_status_and_snapshot_reject_synchronized_parent_tampering() {
        let (runtime, database, root) = imported_bkv_replay_fixture("parent-trusted-model");
        let selected = runtime
            .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
            .unwrap();
        let original = runtime
            .block_on(db::find_production_inspection(
                &database.connection,
                &selected.inspection_id,
            ))
            .unwrap()
            .unwrap();

        runtime
            .block_on(database.connection.execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "UPDATE production_inspection SET started_at = ?, finished_at = ? WHERE id = ?",
                [
                    "synchronized-forged-time".into(),
                    "synchronized-forged-time".into(),
                    original.id.clone().into(),
                ],
            )))
            .unwrap();
        assert_eq!(
            runtime
                .block_on(load_bkv_replay_runtime(&database.connection, &root))
                .unwrap_err()
                .code,
            "bkv_selected_inspection_invalid"
        );
        assert_eq!(
            runtime
                .block_on(bkv_status_value(&database.connection, &root))
                .unwrap_err()
                .code,
            "bkv_selected_inspection_invalid"
        );
        runtime
            .block_on(database.connection.execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "UPDATE production_inspection SET started_at = ?, finished_at = ? WHERE id = ?",
                [
                    original.started_at.clone().into(),
                    original.finished_at.clone().into(),
                    original.id.clone().into(),
                ],
            )))
            .unwrap();

        let forged_legacy_id = "forged-legacy-id";
        let mut forged_raw: Value = serde_json::from_str(&original.raw_payload).unwrap();
        forged_raw["legacyId"] = json!(forged_legacy_id);
        let forged_material_id = bkv_deterministic_id(
            "batch-001",
            "material",
            "allexcel",
            forged_legacy_id,
            "normalized/allexcel.jsonl",
        );
        let forged_session_id = bkv_deterministic_id(
            "batch-001",
            "material-session",
            "allexcel",
            forged_legacy_id,
            "normalized/allexcel.jsonl",
        );
        runtime
            .block_on(database.connection.execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "UPDATE production_inspection SET material_id = ?, session_id = ?, raw_payload = ? WHERE id = ?",
                [
                    forged_material_id.into(),
                    forged_session_id.into(),
                    forged_raw.to_string().into(),
                    original.id.clone().into(),
                ],
            )))
            .unwrap();
        assert_eq!(
            runtime
                .block_on(load_bkv_replay_runtime(&database.connection, &root))
                .unwrap_err()
                .code,
            "bkv_selected_inspection_invalid"
        );
        runtime
            .block_on(database.connection.execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "UPDATE production_inspection SET material_id = ?, session_id = ?, raw_payload = ? WHERE id = ?",
                [
                    original.material_id.clone().into(),
                    original.session_id.clone().into(),
                    original.raw_payload.clone().into(),
                    original.id.clone().into(),
                ],
            )))
            .unwrap();

        for (field, tampered, restored) in [
            ("status", "running".to_string(), original.status.clone()),
            (
                "capture_count",
                (original.capture_count + 1).to_string(),
                original.capture_count.to_string(),
            ),
            (
                "defect_count",
                (original.defect_count + 1).to_string(),
                original.defect_count.to_string(),
            ),
        ] {
            runtime
                .block_on(database.connection.execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    format!("UPDATE production_inspection SET {field} = ? WHERE id = ?"),
                    [tampered.into(), original.id.clone().into()],
                )))
                .unwrap();
            assert_eq!(
                runtime
                    .block_on(load_bkv_replay_runtime(&database.connection, &root))
                    .unwrap_err()
                    .code,
                "bkv_selected_inspection_invalid",
                "runtime must reject {field}"
            );
            runtime
                .block_on(database.connection.execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    format!("UPDATE production_inspection SET {field} = ? WHERE id = ?"),
                    [restored.into(), original.id.clone().into()],
                )))
                .unwrap();
        }
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_status_value_rejects_missing_or_malformed_active_state_dependencies() {
        let (runtime, database, root) = imported_bkv_replay_fixture("status-strict-errors");
        runtime
            .block_on(db::set_config(
                &database.connection,
                "bkv.batch.batch-001",
                "not-json",
            ))
            .unwrap();
        assert_eq!(
            runtime
                .block_on(bkv_status_value(&database.connection, &root))
                .unwrap_err()
                .code,
            "bkv_replay_state_invalid"
        );

        let (runtime2, database2, root2) = imported_bkv_replay_fixture("status-missing-replay");
        runtime2
            .block_on(database2.connection.execute(Statement::from_string(
                DbBackend::Sqlite,
                "DELETE FROM app_config WHERE key = 'bkv.replay.batch-001'".to_string(),
            )))
            .unwrap();
        assert_eq!(
            runtime2
                .block_on(bkv_status_value(&database2.connection, &root2))
                .unwrap_err()
                .code,
            "bkv_replay_state_missing"
        );
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(root2).ok();
    }

    #[test]
    fn bkv_index_one_health_storage_and_status_never_reload_the_full_batch() {
        let (runtime, database, root) = imported_bkv_replay_fixture("runtime-compact-map");
        runtime
            .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
            .unwrap();
        bkv_test_reset_full_batch_loads(&root);
        let artifact_reads = bkv_test_hash_reads(&root);

        for _component in ["capture-health", "storage-health"] {
            let replay = runtime
                .block_on(load_bkv_replay_runtime_with_deadline(
                    &database.connection,
                    &root,
                    Some(Instant::now() + Duration::from_secs(30)),
                ))
                .unwrap();
            assert_eq!(replay.replay_index, 1);
        }
        assert_eq!(
            runtime
                .block_on(bkv_status_value(&database.connection, &root))
                .unwrap()["active"],
            json!(true)
        );
        assert_eq!(bkv_test_full_batch_loads(&root), 0);
        assert!(bkv_test_hash_reads(&root) > artifact_reads);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_index_one_slow_mapping_honors_capture_storage_and_status_deadlines() {
        let (runtime, database, root) = imported_bkv_replay_fixture("runtime-map-deadline");
        runtime
            .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
            .unwrap();
        bkv_test_reset_full_batch_loads(&root);
        let artifact_reads = bkv_test_hash_reads(&root);

        for _component in ["capture-health", "storage-health"] {
            bkv_test_set_mapping_delay(&root, Duration::from_millis(20));
            assert_eq!(
                runtime
                    .block_on(load_bkv_replay_runtime_with_deadline(
                        &database.connection,
                        &root,
                        Some(Instant::now() + Duration::from_millis(5)),
                    ))
                    .unwrap_err()
                    .code,
                "bkv_verification_timeout"
            );
        }

        bkv_test_set_mapping_delay(&root, Duration::from_millis(1_600));
        assert_eq!(
            runtime
                .block_on(bkv_status_value(&database.connection, &root))
                .unwrap_err()
                .code,
            "bkv_verification_timeout"
        );
        bkv_test_set_mapping_delay(&root, Duration::ZERO);
        assert_eq!(bkv_test_full_batch_loads(&root), 0);
        assert_eq!(bkv_test_hash_reads(&root), artifact_reads);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_concurrent_runtime_verification_is_single_flight() {
        let (_runtime, database, root) = imported_bkv_replay_fixture("runtime-single-flight");
        bkv_test_reset_runtime_verification_max(&root);
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let handles = (0..4)
            .map(|_| {
                let connection = database.connection.clone();
                let root = root.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    Runtime::new()
                        .unwrap()
                        .block_on(load_bkv_replay_runtime_with_deadline(
                            &connection,
                            &root,
                            Some(Instant::now() + Duration::from_secs(10)),
                        ))
                })
            })
            .collect::<Vec<_>>();
        for handle in handles {
            let _ = handle.join().unwrap();
        }
        assert_eq!(bkv_test_runtime_verification_max(&root), 1);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_single_flight_waiter_honors_its_deadline_while_identity_is_busy() {
        let (runtime, database, root) = imported_bkv_replay_fixture("runtime-lock-deadline");
        runtime
            .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
            .unwrap();
        bkv_test_set_mapping_delay(&root, Duration::from_millis(250));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let holder_connection = database.connection.clone();
        let holder_root = root.clone();
        let holder_barrier = barrier.clone();
        let holder = std::thread::spawn(move || {
            holder_barrier.wait();
            Runtime::new()
                .unwrap()
                .block_on(load_bkv_replay_runtime_with_deadline(
                    &holder_connection,
                    &holder_root,
                    None,
                ))
        });
        barrier.wait();
        let wait_started = Instant::now();
        while bkv_test_runtime_verification_active(&root) == 0 {
            assert!(wait_started.elapsed() < Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(1));
        }

        let started = Instant::now();
        let error = runtime
            .block_on(load_bkv_replay_runtime_with_deadline(
                &database.connection,
                &root,
                Some(Instant::now() + Duration::from_millis(5)),
            ))
            .unwrap_err();
        assert_eq!(error.code, "bkv_verification_timeout");
        assert!(started.elapsed() < Duration::from_millis(100));
        holder.join().unwrap().unwrap();
        bkv_test_set_mapping_delay(&root, Duration::ZERO);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_single_flight_allows_different_serving_identities_in_parallel() {
        let (runtime_a, database_a, root_a) = imported_bkv_replay_fixture("runtime-lock-a");
        let (runtime_b, database_b, root_b) = imported_bkv_replay_fixture("runtime-lock-b");
        runtime_a
            .block_on(advance_bkv_replay(
                &database_a.connection,
                &root_a,
                "bkv-test",
            ))
            .unwrap();
        runtime_b
            .block_on(advance_bkv_replay(
                &database_b.connection,
                &root_b,
                "bkv-test",
            ))
            .unwrap();
        bkv_test_set_mapping_delay(&root_a, Duration::from_millis(250));
        bkv_test_set_mapping_delay(&root_b, Duration::from_millis(250));
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let handles = [
            (database_a.connection.clone(), root_a.clone()),
            (database_b.connection.clone(), root_b.clone()),
        ]
        .into_iter()
        .map(|(connection, root)| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                Runtime::new()
                    .unwrap()
                    .block_on(load_bkv_replay_runtime_with_deadline(
                        &connection,
                        &root,
                        None,
                    ))
            })
        })
        .collect::<Vec<_>>();
        barrier.wait();
        let wait_started = Instant::now();
        while bkv_test_runtime_verification_active(&root_a) == 0
            || bkv_test_runtime_verification_active(&root_b) == 0
        {
            assert!(wait_started.elapsed() < Duration::from_secs(2));
            std::thread::sleep(Duration::from_millis(1));
        }
        for handle in handles {
            handle.join().unwrap().unwrap();
        }
        bkv_test_set_mapping_delay(&root_a, Duration::ZERO);
        bkv_test_set_mapping_delay(&root_b, Duration::ZERO);
        fs::remove_dir_all(root_a).ok();
        fs::remove_dir_all(root_b).ok();
    }

    #[test]
    fn bkv_readiness_shares_one_verified_runtime_between_capture_and_storage() {
        let (runtime, database, root) = imported_bkv_replay_fixture("readiness-shared-runtime");
        let before = bkv_test_hash_reads(&root);
        let replay = runtime
            .block_on(load_bkv_replay_runtime_with_deadline(
                &database.connection,
                &root,
                Some(Instant::now() + Duration::from_secs(5)),
            ))
            .unwrap();
        let after_load = bkv_test_hash_reads(&root);
        assert!(after_load > before);
        let _capture = crate::bkv_capture_health_ready_value(&replay, json!({"phase":"stopped"}));
        let _storage = crate::bkv_storage_health_ready_value(&replay);
        assert_eq!(bkv_test_hash_reads(&root), after_load);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_runtime_rejects_same_size_artifact_tamper_without_cache_trust() {
        let (runtime, database, root) = imported_bkv_replay_fixture("artifact-same-size");
        runtime
            .block_on(load_bkv_replay_runtime(&database.connection, &root))
            .unwrap();
        let path = root.join("batch-001/artifacts/camera1/1893700/2d/camera-1.jpg");
        let original = fs::read(&path).unwrap();
        fs::write(&path, vec![b'x'; original.len()]).unwrap();
        assert_eq!(
            runtime
                .block_on(load_bkv_replay_runtime(&database.connection, &root))
                .unwrap_err()
                .code,
            "bkv_artifact_changed"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_runtime_rejects_a_final_component_link_swap() {
        let (runtime, database, root) = imported_bkv_replay_fixture("artifact-link-swap");
        let path = root.join("batch-001/artifacts/camera1/1893700/2d/camera-1.jpg");
        let replacement = path.with_file_name("replacement.jpg");
        fs::write(&replacement, fs::read(&path).unwrap()).unwrap();
        fs::remove_file(&path).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&replacement, &path).is_err() {
            fs::remove_dir_all(root).ok();
            return;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&replacement, &path).unwrap();
        let code = runtime
            .block_on(load_bkv_replay_runtime(&database.connection, &root))
            .unwrap_err()
            .code;
        assert!(
            matches!(
                code,
                "bkv_artifact_missing"
                    | "bkv_artifact_invalid"
                    | "bkv_file_link_rejected"
                    | "bkv_file_changed"
            ),
            "unexpected rejection code: {code}"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_deterministic_mapping_cache_invalidates_on_same_size_file_change() {
        let (runtime, database, root) = imported_bkv_replay_fixture("runtime-map-tamper");
        runtime
            .block_on(advance_bkv_replay(&database.connection, &root, "bkv-test"))
            .unwrap();
        let path = root.join("batch-001/normalized/allexcel.jsonl");
        let original = fs::read_to_string(&path).unwrap();
        let tampered = original.replacen("Q235", "Q236", 1);
        assert_eq!(tampered.len(), original.len());
        fs::write(&path, tampered).unwrap();

        assert_eq!(
            runtime
                .block_on(load_bkv_replay_runtime_with_deadline(
                    &database.connection,
                    &root,
                    Some(Instant::now() + Duration::from_secs(5)),
                ))
                .unwrap_err()
                .code,
            "bkv_file_changed"
        );
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_readiness_runtime_rehashes_artifacts_across_requests_and_honors_deadline() {
        let (runtime, database, root) = imported_bkv_replay_fixture("runtime-cache");
        assert_eq!(bkv_test_hash_reads(&root), 0);
        runtime
            .block_on(load_bkv_replay_runtime_with_deadline(
                &database.connection,
                &root,
                Some(Instant::now() + Duration::from_secs(5)),
            ))
            .unwrap();
        let first_reads = bkv_test_hash_reads(&root);
        assert!(first_reads > 0);
        runtime
            .block_on(load_bkv_replay_runtime_with_deadline(
                &database.connection,
                &root,
                Some(Instant::now() + Duration::from_secs(5)),
            ))
            .unwrap();
        assert_eq!(bkv_test_hash_reads(&root), first_reads * 2);

        let (timeout_runtime, timeout_database, timeout_root) =
            imported_bkv_replay_fixture("runtime-timeout");
        assert_eq!(
            timeout_runtime
                .block_on(load_bkv_replay_runtime_with_deadline(
                    &timeout_database.connection,
                    &timeout_root,
                    Some(Instant::now()),
                ))
                .unwrap_err()
                .code,
            "bkv_verification_timeout"
        );
        fs::remove_dir_all(root).ok();
        fs::remove_dir_all(timeout_root).ok();
    }

    #[test]
    fn bkv_oversized_replacement_is_rejected_before_content_allocation_or_read() {
        let (runtime, database, root) = imported_bkv_replay_fixture("runtime-oversized");
        fs::OpenOptions::new()
            .write(true)
            .open(root.join("batch-001/artifacts/camera1/1893700/2d/camera-1.jpg"))
            .unwrap()
            .set_len(BKV_REPLAY_MAX_ARTIFACT_BYTES + 1)
            .unwrap();
        assert_eq!(bkv_test_hash_reads(&root), 0);
        assert_eq!(
            runtime
                .block_on(load_bkv_replay_runtime(&database.connection, &root))
                .unwrap_err()
                .code,
            "bkv_artifact_changed"
        );
        assert_eq!(bkv_test_hash_reads(&root), 0);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_capture_once_provider_evidence_is_explicit_and_exact() {
        let selection = BkvReplaySelection {
            batch_id: "batch-001".to_string(),
            content_id: "a".repeat(64),
            legacy_seq_no: 1_893_700,
            previous_index: 0,
            next_index: 1,
            status: "replaying".to_string(),
            version: 1,
            inspection_id: "inspection-001".to_string(),
            material_id: "material-001".to_string(),
            session_id: "session-001".to_string(),
            inspection: BkvImportedInspectionEvidence {
                id: "inspection-001".to_string(),
                status: "completed".to_string(),
                capture_count: 6,
                defect_count: 1,
                batch_id: "batch-001".to_string(),
                content_id: "a".repeat(64),
                legacy_seq_no: 1_893_700,
                provenance: json!({
                    "source":"bkv","batchId":"batch-001",
                    "contentId":"a".repeat(64),"legacySeqNo":1_893_700
                }),
            },
            artifacts: vec![BkvReplayArtifactEvidence {
                path: "artifacts/camera1/1893700/2d/one.jpg".to_string(),
                sha256: "b".repeat(64),
                size: 4,
                camera_number: 1,
                kind: "2d".to_string(),
                verified: true,
            }],
            captures: vec![json!({"id":"capture-001"})],
            defects: vec![json!({"id":"defect-001"})],
        };
        let evidence = bkv_replay_selection_value(&selection);
        assert_eq!(evidence["source"], "bkv");
        assert_eq!(evidence["offline"], true);
        assert_eq!(evidence["cameraCount"], 6);
        assert_eq!(evidence["legacySeqNo"], 1_893_700);
        assert_eq!(
            evidence["artifacts"][0]["path"],
            "artifacts/camera1/1893700/2d/one.jpg"
        );
        assert_eq!(evidence["artifacts"][0]["sha256"], "b".repeat(64));
        assert_eq!(evidence["inspectionId"], "inspection-001");
        assert_eq!(evidence["inspection"]["id"], "inspection-001");
        assert_eq!(evidence["inspection"]["status"], "completed");
        assert_eq!(evidence["inspection"]["captureCount"], 6);
        assert_eq!(evidence["inspection"]["defectCount"], 1);
        assert_eq!(evidence["inspection"]["provenance"]["source"], "bkv");
        assert_eq!(
            evidence["inspection"]["provenance"]["legacySeqNo"],
            1_893_700
        );
        assert_eq!(evidence["captures"][0]["id"], "capture-001");
        assert_eq!(evidence["defects"][0]["id"], "defect-001");
    }

    #[test]
    fn bkv_completed_replay_uses_stable_http_409_contract() {
        let response = String::from_utf8(bkv_rejection_response(BkvRejection::new(
            "bkv_replay_completed",
            "internal detail",
        )))
        .unwrap();
        assert!(response.starts_with("HTTP/1.1 409 Conflict"));
        let body = response.split_once("\r\n\r\n").unwrap().1;
        let payload: Value = serde_json::from_str(body).unwrap();
        assert_eq!(payload["code"], "bkv_replay_completed");
        assert_eq!(payload["error"], "bkv_replay_completed");
        assert!(!body.contains("internal detail"));
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
        assert!(bkv_valid_batch_id(&"a".repeat(117)));
        assert!(!bkv_valid_batch_id(&"a".repeat(118)));
        assert!(bkv_valid_batch_id("batch.001"));
        assert!(!bkv_valid_batch_id("."));
        assert!(!bkv_valid_batch_id(".."));
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
    fn bkv_serving_index_reads_only_manifest_publication_and_normalized_rows() {
        let root = bkv_test_root("serving-index");
        let manifest = write_bkv_test_batch(&root, "ready", false);
        let imported = load_bkv_batch(&root, &manifest, false).unwrap();
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
        .expect("serving validation must read only identity mapping rows, not artifacts");
        assert_eq!(index.artifacts.len(), 2);
        assert_eq!(index.deterministic_inspections.len(), 11);
        assert!(index
            .artifacts
            .iter()
            .any(|artifact| artifact.relative_path.ends_with("one.jpg")));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_final_manifest_identity_is_built_from_the_third_verification() {
        let root = bkv_test_root("final-manifest-identity");
        let manifest_path = write_bkv_test_batch(&root, "ready", false);
        let second = load_bkv_batch(&root, &manifest_path, false).unwrap();
        let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let third = load_bkv_batch(&root, &manifest_path, false).unwrap();
        assert_eq!(second.semantic_digest, third.semantic_digest);
        assert_ne!(second.manifest_sha256, third.manifest_sha256);
        let final_db = bkv_final_db_batch(&second, &third).unwrap();
        let summary: Value = serde_json::from_str(&final_db.manifest_json).unwrap();
        assert_eq!(
            summary.get("manifestSha256").and_then(Value::as_str),
            Some(third.manifest_sha256.as_str())
        );
        load_bkv_serving_index(
            &root,
            &manifest_path,
            &third.batch_id,
            &third.content_id,
            &third.semantic_digest,
            &third.manifest_sha256,
            &third.publication_sha256,
        )
        .expect("final manifest identity must remain serviceable");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn bkv_final_publication_identity_is_built_from_the_third_verification() {
        let root = bkv_test_root("final-publication-identity");
        let manifest_path = write_bkv_test_batch(&root, "ready", false);
        let second = load_bkv_batch(&root, &manifest_path, false).unwrap();
        let publication_path = root.join("batch-001/publication.json");
        let publication: Value =
            serde_json::from_slice(&fs::read(&publication_path).unwrap()).unwrap();
        fs::write(
            &publication_path,
            serde_json::to_string_pretty(&publication).unwrap(),
        )
        .unwrap();
        let third = load_bkv_batch(&root, &manifest_path, false).unwrap();
        assert_eq!(second.semantic_digest, third.semantic_digest);
        assert_ne!(second.publication_sha256, third.publication_sha256);
        let final_db = bkv_final_db_batch(&second, &third).unwrap();
        let summary: Value = serde_json::from_str(&final_db.manifest_json).unwrap();
        assert_eq!(
            summary.get("publicationSha256").and_then(Value::as_str),
            Some(third.publication_sha256.as_str())
        );
        load_bkv_serving_index(
            &root,
            &manifest_path,
            &third.batch_id,
            &third.content_id,
            &third.semantic_digest,
            &third.manifest_sha256,
            &third.publication_sha256,
        )
        .expect("final publication identity must remain serviceable");
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
