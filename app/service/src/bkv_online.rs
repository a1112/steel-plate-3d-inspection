//! Live BKV adapter for the site MySQL database and six read-only image shares.

use crate::inspection_world::{
    self, CameraOrientation, CameraSpec, InspectionWorld, PixelRect, TileRequest,
};
use crate::runtime_profile::{RuntimeAlgorithm, RuntimeProfile};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, DbErr, QueryResult,
    Statement,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::runtime::Handle;
use tokio::sync::RwLock;
use tokio::time::MissedTickBehavior;

const DEFAULT_DATABASE: &str = "ncdtube";
const DEFAULT_RECORD_LIMIT: usize = 500;
const DEFAULT_DEFECT_WINDOW: usize = 5_000;
const DEFAULT_REFRESH_INTERVAL_MS: usize = 5_000;
const BKV_D3_HEADER_BYTES: usize = 84;
const BKV_IMAGE_MAX_BYTES: u64 = 64 * 1024 * 1024;
const BKV_D3_INVALID_DEPTH: f32 = -1_000_000.0;
const BKV_DEPTH_SURFACE_ROWS: usize = 1024;
const BKV_DEPTH_SURFACE_COLS_PER_CAMERA: usize = 64;
const BKV_DEPTH_SURFACE_MAX_FRAMES_PER_CAMERA: usize = 16;
const BKV_IMAGE_CACHE_MAX_ENTRIES: usize = 64;
const BKV_IMAGE_CACHE_MAX_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone)]
pub struct BkvSource {
    connection: DatabaseConnection,
    database: String,
    record_limit: usize,
    defect_window: usize,
    image_roots: Vec<PathBuf>,
    cameras: Vec<crate::runtime_profile::RuntimeCamera>,
    algorithm: RuntimeAlgorithm,
    refresh_interval: Duration,
    refresh_state: Arc<RwLock<BkvRefreshState>>,
    inspection_world_cache: Arc<Mutex<HashMap<i64, Arc<BkvOnlineInspectionWorld>>>>,
    image_cache: Arc<Mutex<BkvImageCache>>,
    inspection_world_build_lock: Arc<Mutex<()>>,
    inspection_world_depth_build_lock: Arc<Mutex<()>>,
    processing_log_lock: Arc<Mutex<()>>,
    auto_processing: Arc<AtomicBool>,
}

#[derive(Default)]
struct BkvRefreshState {
    snapshot: Option<String>,
    attempts: u64,
    successes: u64,
    refreshed_at_ms: u64,
    last_error: Option<String>,
}

#[derive(Clone)]
struct BkvOnlineInspectionWorld {
    revision: String,
    checked_at: Instant,
    world: InspectionWorld,
    frames: HashMap<(u32, u32), PathBuf>,
    source_frame_count: usize,
    depth_loaded: bool,
    depth_surface: Option<Value>,
    depth_surface_binary: Option<Arc<Vec<u8>>>,
    depth_surface_path: Option<PathBuf>,
    depth_source_frame_count: usize,
    depth_error: Option<String>,
    run_dir: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct BkvImageCacheKey {
    camera: usize,
    sequence: i64,
    image_index: i64,
    kind: &'static str,
}

#[derive(Clone)]
struct BkvImageCacheEntry {
    source_bytes: u64,
    source_modified_ns: u128,
    bytes: Arc<Vec<u8>>,
    last_used: u64,
}

#[derive(Default)]
struct BkvImageCache {
    entries: HashMap<BkvImageCacheKey, BkvImageCacheEntry>,
    bytes: usize,
    clock: u64,
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl BkvImageCache {
    fn get(
        &mut self,
        key: &BkvImageCacheKey,
        source_bytes: u64,
        source_modified_ns: u128,
    ) -> Option<Arc<Vec<u8>>> {
        self.clock = self.clock.saturating_add(1);
        let stale = self.entries.get(key).is_some_and(|entry| {
            entry.source_bytes != source_bytes || entry.source_modified_ns != source_modified_ns
        });
        if stale {
            if let Some(entry) = self.entries.remove(key) {
                self.bytes = self.bytes.saturating_sub(entry.bytes.len());
            }
        }
        if let Some(entry) = self.entries.get_mut(key) {
            entry.last_used = self.clock;
            self.hits = self.hits.saturating_add(1);
            return Some(Arc::clone(&entry.bytes));
        }
        self.misses = self.misses.saturating_add(1);
        None
    }

    fn insert(
        &mut self,
        key: BkvImageCacheKey,
        source_bytes: u64,
        source_modified_ns: u128,
        bytes: Arc<Vec<u8>>,
    ) {
        if bytes.len() > BKV_IMAGE_CACHE_MAX_BYTES {
            return;
        }
        if let Some(previous) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(previous.bytes.len());
        }
        while !self.entries.is_empty()
            && (self.entries.len() >= BKV_IMAGE_CACHE_MAX_ENTRIES
                || self.bytes.saturating_add(bytes.len()) > BKV_IMAGE_CACHE_MAX_BYTES)
        {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(entry.bytes.len());
                self.evictions = self.evictions.saturating_add(1);
            }
        }
        self.clock = self.clock.saturating_add(1);
        self.bytes = self.bytes.saturating_add(bytes.len());
        self.entries.insert(
            key,
            BkvImageCacheEntry {
                source_bytes,
                source_modified_ns,
                bytes,
                last_used: self.clock,
            },
        );
    }
}

#[derive(Clone, Debug)]
struct BkvRecord {
    seq_no: i64,
    steel_id: String,
    steel_type: String,
    received_diameter_mm: f64,
    received_length_mm: f64,
    measured_diameter_mm: f64,
    measured_length_samples: f64,
    length_scale_mm: f64,
    defect_count: i64,
    detected_at: String,
    wall_thickness_mm: f64,
    complete: bool,
}

#[derive(Clone, Debug)]
struct BkvDefect {
    id: i64,
    camera_no: i64,
    defect_no: i64,
    seq_no: i64,
    class_no: i64,
    grade: i64,
    confidence: f64,
    image_index: i64,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
    depth_micrometers: f64,
}

pub struct BkvImage {
    pub content_type: &'static str,
    pub bytes: Arc<Vec<u8>>,
    pub cache_hit: bool,
}

#[derive(Debug)]
pub enum BkvImageError {
    InvalidRequest(&'static str),
    NotFound,
    InvalidFormat(&'static str),
    Io(std::io::Error),
}

impl From<std::io::Error> for BkvImageError {
    fn from(error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::NotFound {
            Self::NotFound
        } else {
            Self::Io(error)
        }
    }
}

#[derive(Clone, Debug)]
struct BkvDefectType {
    class_no: i64,
    label: String,
    color: String,
    shape: &'static str,
}

fn required_env(name: &str) -> Result<String, DbErr> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| DbErr::Custom(format!("{name} is required in BKV online mode")))
}

fn identifier(value: &str) -> Result<String, DbErr> {
    if !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        Ok(value.to_string())
    } else {
        Err(DbErr::Custom(
            "STEEL_BKV_MYSQL_DATABASE must use ASCII letters, digits, or underscore".to_string(),
        ))
    }
}

fn percent_encode_url_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn bounded_env_usize(name: &str, default: usize, minimum: usize, maximum: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(default)
        .clamp(minimum, maximum)
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn parse_bkv_record_sequence(record_id: &str) -> Result<i64, String> {
    let normalized = record_id
        .trim()
        .strip_prefix("bkv-")
        .unwrap_or(record_id.trim());
    normalized
        .parse::<i64>()
        .ok()
        .filter(|sequence| *sequence > 0)
        .ok_or_else(|| format!("invalid BKV record id: {record_id}"))
}

fn canonical_bkv_record_id(sequence: i64) -> String {
    sequence.to_string()
}

fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("output path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("data"),
        std::process::id()
    ));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    write_bytes_atomic(path, &bytes)
}

fn configured_image_roots(
    host: &str,
    cameras: &[crate::runtime_profile::RuntimeCamera],
) -> Result<Vec<PathBuf>, DbErr> {
    cameras
        .iter()
        .map(|camera| {
            let source_camera_id = camera.source_camera_id;
            let name = format!("STEEL_BKV_IMAGE_ROOT_{source_camera_id}");
            let configured = env::var(&name)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    let share = if camera.source_directory.trim().is_empty() {
                        format!("CamImageSource{source_camera_id}")
                    } else {
                        camera.source_directory.trim().to_string()
                    };
                    format!(r"\\{host}\{share}")
                });
            Ok(PathBuf::from(configured))
        })
        .collect()
}

impl BkvSource {
    pub async fn from_env(profile: &RuntimeProfile) -> Result<Option<Self>, DbErr> {
        if profile.data_source != "bkv-online-mysql" {
            return Ok(None);
        }

        let host = required_env("STEEL_BKV_MYSQL_HOST")?;
        let port = env::var("STEEL_BKV_MYSQL_PORT")
            .unwrap_or_else(|_| "3306".to_string())
            .parse::<u16>()
            .map_err(|_| DbErr::Custom("STEEL_BKV_MYSQL_PORT must be a valid port".to_string()))?;
        let user = required_env("STEEL_BKV_MYSQL_USER")?;
        let password = required_env("STEEL_BKV_MYSQL_PASSWORD")?;
        let image_roots = configured_image_roots(&host, &profile.cameras)?;
        let database = identifier(
            &env::var("STEEL_BKV_MYSQL_DATABASE").unwrap_or_else(|_| DEFAULT_DATABASE.to_string()),
        )?;
        let timeout_ms = bounded_env_usize("STEEL_BKV_CONNECT_TIMEOUT_MS", 5_000, 100, 30_000);
        let url = format!(
            "mysql://{}:{}@{}:{}/{}?ssl-mode=disabled",
            percent_encode_url_component(&user),
            percent_encode_url_component(&password),
            host,
            port,
            database
        );
        let mut options = ConnectOptions::new(url);
        options
            .connect_timeout(Duration::from_millis(timeout_ms as u64))
            .max_connections(4)
            .min_connections(1);
        let connection = Database::connect(options).await?;
        connection
            .query_one(Statement::from_string(
                DbBackend::MySql,
                format!("SELECT SeqNo FROM `{database}`.`record` ORDER BY ID DESC LIMIT 1"),
            ))
            .await?;

        Ok(Some(Self {
            connection,
            database,
            record_limit: if profile.algorithm.source_data.enabled {
                profile.algorithm.source_data.record_limit
            } else {
                bounded_env_usize("STEEL_BKV_RECORD_LIMIT", DEFAULT_RECORD_LIMIT, 1, 2_000)
            },
            defect_window: bounded_env_usize(
                "STEEL_BKV_DEFECT_WINDOW",
                DEFAULT_DEFECT_WINDOW,
                100,
                50_000,
            ),
            image_roots,
            cameras: profile.cameras.clone(),
            algorithm: profile.algorithm.clone(),
            refresh_interval: Duration::from_millis(bounded_env_usize(
                "STEEL_BKV_REFRESH_INTERVAL_MS",
                DEFAULT_REFRESH_INTERVAL_MS,
                1_000,
                60_000,
            ) as u64),
            refresh_state: Arc::new(RwLock::new(BkvRefreshState::default())),
            inspection_world_cache: Arc::new(Mutex::new(HashMap::new())),
            image_cache: Arc::new(Mutex::new(BkvImageCache::default())),
            inspection_world_build_lock: Arc::new(Mutex::new(())),
            inspection_world_depth_build_lock: Arc::new(Mutex::new(())),
            processing_log_lock: Arc::new(Mutex::new(())),
            auto_processing: Arc::new(AtomicBool::new(false)),
        }))
    }

    pub async fn initialize(&self) -> Result<(), DbErr> {
        self.refresh_snapshot().await.map(|_| ())
    }

    pub fn start_refresh_loop(&self, runtime: &Handle) {
        self.spawn_latest_processing(runtime);
        let source = self.clone();
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(source.refresh_interval);
            interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
            interval.tick().await;
            loop {
                interval.tick().await;
                match source.refresh_snapshot().await {
                    // Refreshing production data every few seconds must not
                    // continuously consume SMB bandwidth by prebuilding each
                    // newly observed record. The startup record is warmed once;
                    // subsequent records are prepared when selected.
                    Ok(_) => {}
                    Err(error) => eprintln!("BKV background refresh failed: {error}"),
                }
            }
        });
    }

    pub async fn snapshot_json(&self) -> Result<String, DbErr> {
        if let Some(snapshot) = self.refresh_state.read().await.snapshot.clone() {
            return Ok(snapshot);
        }
        self.refresh_snapshot().await
    }

    pub async fn status_json(&self) -> String {
        let state = self.refresh_state.read().await;
        let snapshot = state
            .snapshot
            .as_deref()
            .and_then(|payload| serde_json::from_str::<Value>(payload).ok());
        let record_count = snapshot
            .as_ref()
            .and_then(|value| value.get("records"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or_default();
        let preview_image_count = snapshot
            .as_ref()
            .and_then(|value| value.get("captureImages"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or_default();
        let latest_record = snapshot
            .as_ref()
            .and_then(|value| value.get("records"))
            .and_then(Value::as_array)
            .and_then(|records| records.first())
            .cloned();
        let image_cache = self
            .image_cache
            .lock()
            .ok()
            .map(|cache| {
                json!({
                    "entries": cache.entries.len(),
                    "bytes": cache.bytes,
                    "hits": cache.hits,
                    "misses": cache.misses,
                    "evictions": cache.evictions,
                    "maxEntries": BKV_IMAGE_CACHE_MAX_ENTRIES,
                    "maxBytes": BKV_IMAGE_CACHE_MAX_BYTES,
                })
            })
            .unwrap_or_else(|| json!({"error": "cache_lock_failed"}));
        let processing_log = self.recent_processing_log();
        json!({
            "enabled": true,
            "running": true,
            "source": "bkv-online-mysql",
            "databaseConnected": true,
            "hasSnapshot": state.snapshot.is_some(),
            "recordLimit": self.record_limit,
            "recordCount": record_count,
            "sourceDataPersistence": {
                "enabled": self.algorithm.source_data.enabled,
                "path": self.source_catalog_path().map(|path| path.display().to_string())
            },
            "previewImageCount": preview_image_count,
            "imageCache": image_cache,
            "latestRecord": latest_record,
            "refreshIntervalMs": self.refresh_interval.as_millis(),
            "refreshAttempts": state.attempts,
            "refreshSuccesses": state.successes,
            "lastSuccessAtMs": state.refreshed_at_ms,
            // Keep the original error text.  The header is intentionally
            // compact, while the status dialog uses this field to explain
            // the exact failed step instead of showing a generic alarm.
            "lastError": state.last_error.clone(),
            "lastErrorDetail": state.last_error.clone(),
            "processingLogPath": self.processing_log_path().map(|path| path.display().to_string()),
            "processingLog": processing_log,
        })
        .to_string()
    }

    fn processing_log_path(&self) -> Option<PathBuf> {
        self.algorithm.enabled.then(|| {
            PathBuf::from(&self.algorithm.output_root).join(&self.algorithm.timing_log)
        })
    }

    fn recent_processing_log(&self) -> Vec<Value> {
        let Some(path) = self.processing_log_path() else {
            return Vec::new();
        };
        let Ok(mut file) = fs::File::open(&path) else {
            return Vec::new();
        };
        const MAX_LOG_BYTES: u64 = 512 * 1024;
        let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
            return Vec::new();
        };
        let offset = length.saturating_sub(MAX_LOG_BYTES);
        if file.seek(SeekFrom::Start(offset)).is_err() {
            return Vec::new();
        }
        let mut bytes = Vec::new();
        if file.read_to_end(&mut bytes).is_err() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&bytes);
        text.lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .rev()
            .take(24)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    }

    fn spawn_latest_processing(&self, runtime: &Handle) {
        if !self.algorithm.enabled || !self.algorithm.auto_process_latest {
            return;
        }
        if self.auto_processing.swap(true, Ordering::AcqRel) {
            return;
        }
        let source = self.clone();
        runtime.spawn_blocking(move || {
            if let Err(error) = source.process_latest_inspection_world() {
                eprintln!("BKV latest inspection-world processing failed: {error}");
            }
            source.auto_processing.store(false, Ordering::Release);
        });
    }

    fn cached_snapshot_value(&self) -> Result<Value, String> {
        let payload = self
            .refresh_state
            .blocking_read()
            .snapshot
            .clone()
            .ok_or_else(|| "BKV snapshot is not ready".to_string())?;
        serde_json::from_str(&payload).map_err(|error| error.to_string())
    }

    fn process_latest_inspection_world(&self) -> Result<(), String> {
        let snapshot = self.cached_snapshot_value()?;
        let record_id = latest_completed_record_id(&snapshot)
            .ok_or_else(|| "BKV latest completed record is unavailable".to_string())?;
        // Keep the latest 2D world warm without monopolizing the global build
        // slot for a D3IMG surface that the default dashboard does not use.
        self.load_inspection_world_metadata(record_id).map(|_| ())
    }

    pub fn inspection_world_records(&self) -> Result<Value, String> {
        let snapshot = self.cached_snapshot_value()?;
        let records = snapshot
            .get("records")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|record| {
                json!({
                    "recordId": record.get("id").and_then(Value::as_str).unwrap_or_default(),
                    "steelId": record.get("plateNo").and_then(Value::as_str).unwrap_or_default(),
                    "inspectionTime": record.get("time").and_then(Value::as_str).unwrap_or_default(),
                    "defectCount": record.get("defectCount").and_then(Value::as_i64).unwrap_or_default(),
                    "status": record.get("status").and_then(Value::as_str).unwrap_or_default(),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "schema": "steel.inspection-world.records.v1",
            "provider": "online",
            "records": records,
        }))
    }

    pub fn inspection_world_meta(&self, record_id: &str) -> Result<Value, String> {
        let sequence = parse_bkv_record_sequence(record_id)?;
        let processed = self.load_inspection_world_metadata(record_id)?;
        Ok(json!({
            "schema": "steel.inspection-world.meta.v1",
            "provider": "online",
            "recordId": canonical_bkv_record_id(sequence),
            "legacySeqNo": sequence,
            "sourceFrameCount": processed.source_frame_count,
            "sourceRevision": processed.revision,
            "world": processed.world,
            "depthSurface": {
                "available": processed.depth_surface.is_some()
                    || processed.depth_surface_binary.is_some()
                    || processed.depth_surface_path.is_some(),
                "sourceFrameCount": processed.depth_source_frame_count,
                "path": processed.depth_surface_path.as_ref()
                    .map(|path| path.display().to_string()),
                "binaryPath": processed.run_dir.as_ref()
                    .filter(|_| processed.depth_surface_binary.is_some())
                    .map(|path| path.join("surface-mesh.bsmesh").display().to_string()),
                "parametersPath": processed.run_dir.as_ref()
                    .filter(|_| processed.depth_surface.is_some())
                    .map(|path| path.join("reconstruction-parameters.json").display().to_string()),
                "error": processed.depth_error,
                "coordinateUnit": "legacy-unknown",
                "calibrated": false,
            },
            "processing": {
                "processor": self.algorithm.processor,
                "revision": processed.revision,
                "outputPath": processed.run_dir.as_ref().map(|path| path.display().to_string()),
            }
        }))
    }

    pub fn inspection_world_surface(&self, record_id: &str) -> Result<Value, String> {
        let sequence = parse_bkv_record_sequence(record_id)?;
        let processed = self.load_inspection_world(&canonical_bkv_record_id(sequence))?;
        if let Some(surface) = processed.depth_surface.clone() {
            return Ok(surface);
        }
        if let Some(path) = processed.depth_surface_path.as_ref() {
            let bytes = fs::read(path)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            return serde_json::from_slice(&bytes)
                .map_err(|error| format!("{}: {error}", path.display()));
        }
        Err(processed
            .depth_error
            .clone()
            .unwrap_or_else(|| "BKV D3IMG surface is unavailable".to_string()))
    }

    pub fn inspection_world_surface_binary(&self, record_id: &str) -> Result<Arc<Vec<u8>>, String> {
        let sequence = parse_bkv_record_sequence(record_id)?;
        let processed = self.load_inspection_world(&canonical_bkv_record_id(sequence))?;
        processed.depth_surface_binary.clone().ok_or_else(|| {
            processed
                .depth_error
                .clone()
                .unwrap_or_else(|| "BKV D3IMG binary surface is unavailable".to_string())
        })
    }

    pub fn inspection_world_defects(&self, record_id: &str) -> Result<Value, String> {
        let sequence = parse_bkv_record_sequence(record_id)?;
        let canonical_id = canonical_bkv_record_id(sequence);
        let processed = self.load_inspection_world_metadata(&canonical_id)?;
        let snapshot = self.cached_snapshot_value()?;
        let defects = snapshot
            .get("inspections")
            .and_then(Value::as_array)
            .and_then(|inspections| {
                inspections.iter().find(|inspection| {
                    inspection.get("inspectionId").and_then(Value::as_str)
                        == Some(canonical_id.as_str())
                })
            })
            .and_then(|inspection| inspection.get("defects"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|defect| {
                let camera_id = defect
                    .get("cameraIndex")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok());
                let image_index = defect
                    .get("imageIndex")
                    .and_then(Value::as_i64)
                    .and_then(|value| u32::try_from(value).ok());
                let roi = defect
                    .pointer("/artifacts/roi")
                    .and_then(|value| {
                        Some(PixelRect::new(
                            u32::try_from(value.get("x")?.as_i64()?).ok()?,
                            u32::try_from(value.get("y")?.as_i64()?).ok()?,
                            u32::try_from(value.get("width")?.as_i64()?).ok()?,
                            u32::try_from(value.get("height")?.as_i64()?).ok()?,
                        ))
                    });
                let world_rect = camera_id
                    .zip(image_index)
                    .zip(roi)
                    .and_then(|((camera, frame), rect)| {
                        processed.world.map_defect(camera, frame, rect).ok()
                    });
                let severity = defect
                    .get("severity")
                    .and_then(Value::as_str)
                    .unwrap_or("minor");
                let grade = match severity {
                    "severe" => 3,
                    "review" => 2,
                    _ => 1,
                };
                json!({
                    "id": defect.get("id").and_then(Value::as_str).unwrap_or_default(),
                    "className": defect.get("typeLabel").and_then(Value::as_str).unwrap_or("unknown"),
                    "grade": grade,
                    "confidence": defect.get("confidence").and_then(Value::as_f64).unwrap_or_default(),
                    "cameraId": camera_id,
                    "imageIndex": image_index,
                    "locatable": world_rect.is_some(),
                    "worldRect": world_rect,
                    "trace": defect,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "schema": "steel.inspection-world.defects.v1",
            "provider": "online",
            "recordId": canonical_id,
            "defects": defects,
        }))
    }

    pub fn inspection_world_tile(
        &self,
        record_id: &str,
        request: TileRequest,
    ) -> Result<Vec<u8>, String> {
        let sequence = parse_bkv_record_sequence(record_id)?;
        let canonical_id = canonical_bkv_record_id(sequence);
        let processed = self.load_inspection_world_metadata(&canonical_id)?;
        let extension = match request.format {
            inspection_world::TileFormat::Jpeg => "jpg",
            inspection_world::TileFormat::Png => "png",
        };
        let cached_path = processed.run_dir.as_ref().map(|run_dir| {
            run_dir
                .join("tiles")
                .join(format!("camera{}", request.camera_id))
                .join(format!("level{}", request.level))
                .join(format!(
                    "{}_{}.{}",
                    request.tile_x, request.tile_y, extension
                ))
        });
        if let Some(path) = cached_path.as_ref() {
            if let Ok(bytes) = fs::read(path) {
                return Ok(bytes);
            }
        }
        let started = Instant::now();
        let bytes = inspection_world::compose_camera_tile(
            &processed.world,
            request,
            |camera_id, image_index| Ok(processed.frames.get(&(camera_id, image_index)).cloned()),
        )
        .map_err(|error| error.to_string())?;
        if let Some(path) = cached_path.as_ref() {
            write_bytes_atomic(path, &bytes)?;
        }
        self.append_processing_timing(json!({
            "schema": "steel.algorithm-processing-timing.v1",
            "processor": self.algorithm.processor,
            "operation": "tile",
            "recordId": canonical_id,
            "cameraId": request.camera_id,
            "level": request.level,
            "tileX": request.tile_x,
            "tileY": request.tile_y,
            "elapsedMs": started.elapsed().as_millis(),
            "outputPath": cached_path.as_ref().map(|path| path.display().to_string()),
            "completedAtMs": current_time_millis(),
        }))?;
        Ok(bytes)
    }

    fn load_inspection_world(
        &self,
        record_id: &str,
    ) -> Result<Arc<BkvOnlineInspectionWorld>, String> {
        self.load_inspection_world_with_depth(record_id, true)
    }

    fn load_inspection_world_metadata(
        &self,
        record_id: &str,
    ) -> Result<Arc<BkvOnlineInspectionWorld>, String> {
        self.load_inspection_world_with_depth(record_id, false)
    }

    fn load_inspection_world_with_depth(
        &self,
        record_id: &str,
        require_depth: bool,
    ) -> Result<Arc<BkvOnlineInspectionWorld>, String> {
        let sequence = parse_bkv_record_sequence(record_id)?;
        if let Some(cached) = self
            .inspection_world_cache
            .lock()
            .map_err(|_| "BKV inspection-world cache lock poisoned".to_string())?
            .get(&sequence)
            .filter(|cached| {
                // 减少缓存时间到2分钟，并放宽深度检查条件
                cached.checked_at.elapsed() < Duration::from_secs(120)
                    && (cached.depth_loaded || !require_depth)
            })
            .cloned()
        {
            return Ok(cached);
        }
        // Historical BKV records are immutable after acquisition.  Reuse the
        // persisted inspection-world manifest/surface before touching the SMB
        // shares again; this makes a record switch instant after the first
        // conversion and also allows the service to recover after a restart.
        if let Some(persisted) = self.load_persisted_inspection_world(sequence, require_depth)? {
            self.inspection_world_cache
                .lock()
                .map_err(|_| "BKV inspection-world cache lock poisoned".to_string())?
                .insert(sequence, Arc::clone(&persisted));
            return Ok(persisted);
        }
        let _build_guard = if require_depth {
            self.inspection_world_depth_build_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        } else {
            self.inspection_world_build_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        };
        // Another request may have completed the same record while this request
        // waited for the single build slot. Re-check here to avoid repeating a
        // full SMB directory scan and D3IMG reconstruction.
        if let Some(cached) = self
            .inspection_world_cache
            .lock()
            .map_err(|_| "BKV inspection-world cache lock poisoned".to_string())?
            .get(&sequence)
            .filter(|cached| {
                // 使用与首次检查相同的缓存逻辑
                cached.checked_at.elapsed() < Duration::from_secs(120)
                    && (cached.depth_loaded || !require_depth)
            })
            .cloned()
        {
            return Ok(cached);
        }
        let total_started = Instant::now();
        let discover_started = Instant::now();
        let mut revision_hasher = Sha256::new();
        let mut frames = HashMap::new();
        let mut camera_inputs = Vec::new();
        let mut depth_inputs = Vec::new();
        let frame_limit = self.algorithm.max_frames_per_camera.clamp(1, 512);
        for (camera, root) in self.cameras.iter().zip(self.image_roots.iter()) {
            let camera_id = u32::try_from(camera.source_camera_id)
                .map_err(|_| format!("camera {} id is out of range", camera.id))?;
            let image_dir = root.join(sequence.to_string()).join("2D");
            let mut candidates = fs::read_dir(&image_dir)
                .map_err(|error| format!("{}: {error}", image_dir.display()))?
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let path = entry.path();
                    let is_bmp = path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("bmp"));
                    let frame = path
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .and_then(|stem| stem.parse::<u32>().ok());
                    (is_bmp && frame.is_some()).then_some((frame?, path))
                })
                .collect::<Vec<_>>();
            candidates.sort_by_key(|(frame, _)| *frame);
            candidates.truncate(frame_limit);
            if candidates.is_empty() {
                return Err(format!("{} has no 2D BMP frames", image_dir.display()));
            }
            let dimensions = image::image_dimensions(&candidates[0].1)
                .map_err(|error| format!("{}: {error}", candidates[0].1.display()))?;
            let mut alignment_frames = Vec::with_capacity(candidates.len());
            let mut frame_numbers = Vec::with_capacity(candidates.len());
            for (frame, path) in candidates {
                // 性能优化：BKV 记录目录在检测完成后是不可变的，目录列表
                // 即为完整帧集合，因此省略对每个帧的尺寸/元数据两次 SMB 往返。
                //
                // 前提假设（IMPORTANT）：同一 sequence 目录下的帧文件内容
                // 不会被原地改写。若违反此前提（例如重跑转换覆盖原文件），
                // revision 哈希将无法失效，可能导致展示旧表面。如需支持
                // 覆盖写入，应恢复基于文件大小+修改时间的哈希输入。
                revision_hasher.update(camera_id.to_le_bytes());
                revision_hasher.update(frame.to_le_bytes());
                alignment_frames.push((frame, path.clone()));
                frame_numbers.push(frame);
                frames.insert((camera_id, frame), path);
            }
            camera_inputs.push((
                CameraSpec {
                    camera_id,
                    frame_width: dimensions.0,
                    frame_height: dimensions.1,
                    frame_numbers,
                    orientation: CameraOrientation::identity(),
                },
                alignment_frames,
                image_dir,
            ));

            if require_depth {
                let depth_dir = root.join(sequence.to_string()).join("3D");
                let mut depth_candidates = fs::read_dir(&depth_dir)
                    .ok()
                    .into_iter()
                    .flatten()
                    .filter_map(Result::ok)
                    .filter_map(|entry| {
                        let path = entry.path();
                        let is_d3img = path
                            .extension()
                            .and_then(|extension| extension.to_str())
                            .is_some_and(|extension| extension.eq_ignore_ascii_case("d3img"));
                        let frame = path
                            .file_stem()
                            .and_then(|stem| stem.to_str())
                            .and_then(|stem| stem.parse::<u32>().ok());
                        (is_d3img && frame.is_some()).then_some((frame?, path))
                    })
                    .collect::<Vec<_>>();
                depth_candidates.sort_by_key(|(frame, _)| *frame);
                depth_candidates.truncate(frame_limit);
                let depth_candidates = evenly_sample_frame_paths(
                    depth_candidates,
                    BKV_DEPTH_SURFACE_MAX_FRAMES_PER_CAMERA,
                );
                depth_inputs.push((camera_id, depth_candidates, depth_dir));
            }
        }
        let revision = format!("{:x}", revision_hasher.finalize());
        let matching_cached = {
            let cache = self
                .inspection_world_cache
                .lock()
                .map_err(|_| "BKV inspection-world cache lock poisoned".to_string())?;
            cache
                .get(&sequence)
                .filter(|cached| cached.revision == revision)
                .cloned()
        };
        if let Some(cached) = matching_cached {
            if require_depth && !cached.depth_loaded {
                // The lightweight 2D world is reusable, but this caller still
                // needs the lazily generated D3IMG surface.
            } else {
                let refreshed = Arc::new(BkvOnlineInspectionWorld {
                    revision: cached.revision.clone(),
                    checked_at: Instant::now(),
                    world: cached.world.clone(),
                    frames: cached.frames.clone(),
                    source_frame_count: cached.source_frame_count,
                    depth_loaded: cached.depth_loaded,
                    depth_surface: cached.depth_surface.clone(),
                    depth_surface_binary: cached.depth_surface_binary.clone(),
                    depth_surface_path: cached.depth_surface_path.clone(),
                    depth_source_frame_count: cached.depth_source_frame_count,
                    depth_error: cached.depth_error.clone(),
                    run_dir: cached.run_dir.clone(),
                });
                self.inspection_world_cache
                    .lock()
                    .map_err(|_| "BKV inspection-world cache lock poisoned".to_string())?
                    .insert(sequence, Arc::clone(&refreshed));
                return Ok(refreshed);
            }
        }
        let discover_ms = discover_started.elapsed().as_millis();
        let align_started = Instant::now();
        let mut specs = Vec::with_capacity(camera_inputs.len());
        let mut source_cameras = Vec::with_capacity(camera_inputs.len());
        let alignment_jobs = camera_inputs
            .into_iter()
            .map(|(spec, alignment_frames, image_dir)| {
                std::thread::spawn(move || {
                    let alignment = inspection_world::detect_camera_head(&alignment_frames)
                        .map_err(|error| error.to_string())?;
                    Ok::<_, String>((spec, alignment, image_dir))
                })
            })
            .collect::<Vec<_>>();
        for job in alignment_jobs {
            let (spec, alignment, image_dir) = job
                .join()
                .map_err(|_| "BKV camera-head detection worker panicked".to_string())??;
            source_cameras.push(json!({
                "cameraId": spec.camera_id,
                "sourceDirectory": image_dir.display().to_string(),
                "frameCount": spec.frame_numbers.len(),
                "firstFrame": spec.frame_numbers.first(),
                "lastFrame": spec.frame_numbers.last(),
                "width": spec.frame_width,
                "height": spec.frame_height,
                "alignment": alignment,
            }));
            specs.push((spec, alignment));
        }
        let align_ms = align_started.elapsed().as_millis();
        let world = InspectionWorld::with_alignments(specs).map_err(|error| error.to_string())?;
        let source_frame_count = frames.len();
        let depth_started = Instant::now();
        let (depth_surface, depth_surface_binary, depth_source_frame_count, depth_error) =
            if require_depth {
                match build_d3img_surface(sequence, &depth_inputs) {
                    Ok((surface, count)) => match encode_d3img_surface_bsmesh(&surface) {
                        Ok(binary) => (Some(surface), Some(Arc::new(binary)), count, None),
                        Err(error) => (None, None, 0, Some(error)),
                    },
                    Err(error) => (None, None, 0, Some(error)),
                }
            } else {
                (None, None, 0, None)
            };
        let depth_ms = depth_started.elapsed().as_millis();
        let run_dir = if require_depth {
            self.persist_processed_world(
                sequence,
                &revision,
                &world,
                &source_cameras,
                source_frame_count,
                depth_surface.as_ref(),
                depth_surface_binary.as_ref().map(|bytes| bytes.as_slice()),
                depth_source_frame_count,
                depth_error.as_deref(),
                discover_ms,
                align_ms,
                depth_ms,
                total_started.elapsed().as_millis(),
            )?
        } else {
            None
        };
        let depth_artifact_available = depth_surface.is_some() || depth_surface_binary.is_some();
        let processed = Arc::new(BkvOnlineInspectionWorld {
            revision,
            checked_at: Instant::now(),
            world,
            frames,
            source_frame_count,
            depth_loaded: require_depth,
            depth_surface,
            depth_surface_binary,
            depth_surface_path: if require_depth && depth_artifact_available {
                Some(
                    PathBuf::from(&self.algorithm.output_root)
                        .join("runs")
                        .join(canonical_bkv_record_id(sequence))
                        .join("inspection-world-v1")
                        .join("surface-mesh.json"),
                )
            } else {
                None
            },
            depth_source_frame_count,
            depth_error,
            run_dir,
        });
        eprintln!(
            "BKV inspection-world record {sequence}: discover={discover_ms}ms align={align_ms}ms depth={depth_ms}ms total={}ms depthLoaded={require_depth}",
            total_started.elapsed().as_millis()
        );
        self.inspection_world_cache
            .lock()
            .map_err(|_| "BKV inspection-world cache lock poisoned".to_string())?
            .insert(sequence, Arc::clone(&processed));
        Ok(processed)
    }

    fn load_persisted_inspection_world(
        &self,
        sequence: i64,
        require_depth: bool,
    ) -> Result<Option<Arc<BkvOnlineInspectionWorld>>, String> {
        let output_root = self.algorithm.output_root.trim();
        if output_root.is_empty() {
            return Ok(None);
        }
        let run_dir = PathBuf::from(output_root)
            .join("runs")
            .join(canonical_bkv_record_id(sequence))
            .join("inspection-world-v1");
        let manifest_path = run_dir.join("manifest.json");
        let manifest_bytes = match fs::read(&manifest_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("{}: {error}", manifest_path.display())),
        };
        let manifest: Value = serde_json::from_slice(&manifest_bytes)
            .map_err(|error| format!("{}: {error}", manifest_path.display()))?;
        let world: InspectionWorld = serde_json::from_value(
            manifest
                .get("world")
                .cloned()
                .ok_or_else(|| format!("{}: world is missing", manifest_path.display()))?,
        )
        .map_err(|error| format!("{}: {error}", manifest_path.display()))?;

        let mut frames = HashMap::new();
        let mut sequence_ordinals = HashMap::new();
        for camera in &world.cameras {
            let Some((_, root)) = self
                .cameras
                .iter()
                .zip(self.image_roots.iter())
                .find(|(configured, _)| {
                    u32::try_from(configured.source_camera_id).ok() == Some(camera.camera_id)
                })
            else {
                return Ok(None);
            };
            let image_dir = root.join(sequence.to_string()).join("2D");
            for &image_index in &camera.frame_numbers {
                let path = image_dir.join(format!("{image_index:04}.bmp"));
                frames.insert((camera.camera_id, image_index), path);
                sequence_ordinals.insert((camera.camera_id, image_index), image_index);
            }
        }
        if frames.is_empty() {
            return Ok(None);
        }

        let depth_surface_path = run_dir.join("surface-mesh.json");
        let depth_binary_path = run_dir.join("surface-mesh.bsmesh");
        let depth_surface_binary = if require_depth {
            fs::read(&depth_binary_path)
                .ok()
                .filter(|bytes| !bytes.is_empty())
                .map(Arc::new)
        } else {
            None
        };
        let depth_surface = if require_depth && depth_surface_binary.is_none() {
            fs::read(&depth_surface_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        } else {
            None
        };
        let depth_available = depth_surface_binary.is_some()
            || depth_surface.is_some()
            || depth_surface_path.is_file();
        let depth_source_frame_count = manifest
            .pointer("/depthSurface/sourceFrameCount")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or_default();
        let depth_error = if require_depth && !depth_available {
            Some("persisted BKV D3IMG surface is unavailable".to_string())
        } else {
            None
        };
        let source_frame_count = manifest
            .get("sourceFrameCount")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(frames.len());
        let revision = manifest
            .get("revision")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        Ok(Some(Arc::new(BkvOnlineInspectionWorld {
            revision,
            checked_at: Instant::now(),
            world,
            frames,
            source_frame_count,
            depth_loaded: require_depth && depth_available,
            depth_surface,
            depth_surface_binary,
            depth_surface_path: depth_available.then_some(depth_surface_path),
            depth_source_frame_count,
            depth_error,
            run_dir: Some(run_dir),
        })))
    }

    fn persist_processed_world(
        &self,
        sequence: i64,
        revision: &str,
        world: &InspectionWorld,
        cameras: &[Value],
        source_frame_count: usize,
        depth_surface: Option<&Value>,
        depth_surface_binary: Option<&[u8]>,
        depth_source_frame_count: usize,
        depth_error: Option<&str>,
        discover_ms: u128,
        align_ms: u128,
        depth_ms: u128,
        elapsed_before_persist_ms: u128,
    ) -> Result<Option<PathBuf>, String> {
        if !self.algorithm.enabled {
            return Ok(None);
        }
        let output_root = PathBuf::from(&self.algorithm.output_root);
        let run_dir = output_root
            .join("runs")
            .join(canonical_bkv_record_id(sequence))
            .join("inspection-world-v1");
        fs::create_dir_all(&run_dir).map_err(|error| {
            format!("algorithm output directory {}: {error}", run_dir.display())
        })?;
        let persist_started = Instant::now();
        let manifest = json!({
            "schema": "steel.algorithm-inspection-world.v1",
            "processor": self.algorithm.processor,
            "recordId": canonical_bkv_record_id(sequence),
            "legacySeqNo": sequence,
            "revision": revision,
            "source": "bkv-online-mysql",
            "sourceFrameCount": source_frame_count,
            "world": world,
            "cameras": cameras,
            "depthSurface": {
                "available": depth_surface.is_some(),
                "schema": depth_surface.and_then(|surface| surface.get("schema")),
                "path": depth_surface.map(|_| "surface-mesh.json"),
                "binary": depth_surface_binary.map(|_| "surface-mesh.bsmesh"),
                "parameters": depth_surface.map(|_| "reconstruction-parameters.json"),
                "sourceFrameCount": depth_source_frame_count,
                "coordinateUnit": "legacy-unknown",
                "calibrated": false,
                "error": depth_error,
            },
            "algorithmConfig": self.algorithm.config_path,
            "sourceRecord": self.algorithm.source_data.enabled.then_some("source-record.json"),
            "createdAtMs": current_time_millis(),
        });
        write_json_atomic(&run_dir.join("manifest.json"), &manifest)?;
        if let Some(surface) = depth_surface {
            write_json_atomic(&run_dir.join("surface-mesh.json"), surface)?;
            write_json_atomic(
                &run_dir.join("reconstruction-parameters.json"),
                &d3img_reconstruction_parameters(surface),
            )?;
        }
        if let Some(binary) = depth_surface_binary {
            write_bytes_atomic(&run_dir.join("surface-mesh.bsmesh"), binary)?;
        }
        if self.algorithm.source_data.enabled {
            let snapshot = self.cached_snapshot_value()?;
            let source_record = source_record_snapshot(&snapshot, sequence, &self.database)?;
            write_json_atomic(&run_dir.join("source-record.json"), &source_record)?;
        }
        let persist_ms = persist_started.elapsed().as_millis();
        let timing = json!({
            "schema": "steel.algorithm-processing-timing.v1",
            "processor": self.algorithm.processor,
            "operation": "inspection-world",
            "recordId": canonical_bkv_record_id(sequence),
            "revision": revision,
            "sourceFrameCount": source_frame_count,
            "phases": {
                "discoverMs": discover_ms,
                "alignMs": align_ms,
                "depthMs": depth_ms,
                "persistMs": persist_ms,
            },
            "elapsedMs": elapsed_before_persist_ms + persist_ms,
            "outputPath": run_dir.display().to_string(),
            "completedAtMs": current_time_millis(),
        });
        write_json_atomic(&run_dir.join("timing.json"), &timing)?;
        self.append_processing_timing(timing)?;
        Ok(Some(run_dir))
    }

    fn append_processing_timing(&self, timing: Value) -> Result<(), String> {
        if !self.algorithm.enabled {
            return Ok(());
        }
        let _guard = self
            .processing_log_lock
            .lock()
            .map_err(|_| "algorithm processing log lock poisoned".to_string())?;
        let path = PathBuf::from(&self.algorithm.output_root).join(&self.algorithm.timing_log);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        writeln!(file, "{}", timing).map_err(|error| error.to_string())
    }

    fn source_catalog_path(&self) -> Option<PathBuf> {
        self.algorithm.source_data.enabled.then(|| {
            PathBuf::from(&self.algorithm.output_root)
                .join(&self.algorithm.source_data.directory)
                .join(format!("latest-{}.json", self.record_limit))
        })
    }

    fn persist_source_catalog(&self, snapshot: &Value) -> Result<(), String> {
        let Some(path) = self.source_catalog_path() else {
            return Ok(());
        };
        let document = json!({
            "schema": "steel.bkv-mysql-source-snapshot.v1",
            "source": "bkv-online-mysql",
            "database": self.database,
            "recordLimit": self.record_limit,
            "exportedAtMs": current_time_millis(),
            "data": snapshot
        });
        write_json_atomic(&path, &document)
    }

    async fn refresh_snapshot(&self) -> Result<String, DbErr> {
        {
            let mut state = self.refresh_state.write().await;
            state.attempts = state.attempts.saturating_add(1);
        }

        match self.snapshot_value().await {
            Ok(mut snapshot) => {
                let refreshed_at_ms = current_time_millis();
                let refresh_count = self.refresh_state.read().await.successes.saturating_add(1);
                if let Some(object) = snapshot.as_object_mut() {
                    object.insert(
                        "sync".to_string(),
                        json!({
                            "mode": "continuous",
                            "refreshIntervalMs": self.refresh_interval.as_millis(),
                            "refreshCount": refresh_count,
                            "refreshedAtMs": refreshed_at_ms
                        }),
                    );
                }
                if let Err(error) = self.persist_source_catalog(&snapshot) {
                    let error =
                        DbErr::Custom(format!("BKV MySQL source-data persistence failed: {error}"));
                    self.refresh_state.write().await.last_error = Some(error.to_string());
                    return Err(error);
                }
                let payload = snapshot.to_string();
                let mut state = self.refresh_state.write().await;
                state.snapshot = Some(payload.clone());
                state.successes = refresh_count;
                state.refreshed_at_ms = refreshed_at_ms;
                state.last_error = None;
                Ok(payload)
            }
            Err(error) => {
                self.refresh_state.write().await.last_error = Some(error.to_string());
                Err(error)
            }
        }
    }

    pub fn image(
        &self,
        camera: usize,
        sequence: i64,
        image_index: i64,
        kind: &str,
    ) -> Result<BkvImage, BkvImageError> {
        if !(1..=self.image_roots.len()).contains(&camera) {
            return Err(BkvImageError::InvalidRequest("camera_out_of_range"));
        }
        if sequence <= 0 {
            return Err(BkvImageError::InvalidRequest("sequence_out_of_range"));
        }
        if !(0..=99_999).contains(&image_index) {
            return Err(BkvImageError::InvalidRequest("image_index_out_of_range"));
        }
        let root = &self.image_roots[camera - 1];
        let file_name = format!("{image_index:04}");
        let (normalized_kind, path) = match kind {
            "2d" | "intensity" => (
                "2d",
                root.join(sequence.to_string())
                    .join("2D")
                    .join(format!("{file_name}.bmp")),
            ),
            "3d" | "depth" => (
                "depth",
                root.join(sequence.to_string())
                    .join("3D")
                    .join(format!("{file_name}.d3img")),
            ),
            _ => return Err(BkvImageError::InvalidRequest("unsupported_image_kind")),
        };
        let metadata = fs::metadata(&path)?;
        if !metadata.is_file() {
            return Err(BkvImageError::InvalidFormat("image_not_regular_file"));
        }
        let source_modified_ns = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let key = BkvImageCacheKey {
            camera,
            sequence,
            image_index,
            kind: normalized_kind,
        };
        if let Ok(mut cache) = self.image_cache.lock() {
            if let Some(bytes) = cache.get(&key, metadata.len(), source_modified_ns) {
                return Ok(BkvImage {
                    content_type: "image/bmp",
                    bytes,
                    cache_hit: true,
                });
            }
        }
        let bytes = Arc::new(if normalized_kind == "2d" {
            read_bounded_file(&path)?
        } else {
            d3img_to_bmp(&read_bounded_file(&path)?)?
        });
        if let Ok(mut cache) = self.image_cache.lock() {
            cache.insert(key, metadata.len(), source_modified_ns, Arc::clone(&bytes));
        }
        Ok(BkvImage {
            content_type: "image/bmp",
            bytes,
            cache_hit: false,
        })
    }

    async fn snapshot_value(&self) -> Result<Value, DbErr> {
        let records = self.load_records().await?;
        if records.is_empty() {
            return Ok(empty_snapshot());
        }
        let defect_types = self.load_defect_types().await?;
        let cameras = self.load_camera_status().await?;
        let seq_numbers = records
            .iter()
            .map(|record| record.seq_no)
            .collect::<HashSet<_>>();
        let defects = self.load_recent_defects(&seq_numbers).await?;
        let type_by_class = defect_types
            .iter()
            .map(|item| (item.class_no, item.clone()))
            .collect::<HashMap<_, _>>();
        let record_by_seq = records
            .iter()
            .map(|record| (record.seq_no, record))
            .collect::<HashMap<_, _>>();
        let mut defects_by_seq: HashMap<i64, Vec<Value>> = HashMap::new();
        for defect in defects {
            let Some(record) = record_by_seq.get(&defect.seq_no) else {
                continue;
            };
            defects_by_seq
                .entry(defect.seq_no)
                .or_default()
                .push(defect_value(
                    &defect,
                    record,
                    type_by_class.get(&defect.class_no),
                ));
        }

        let latest_sequence = records[0].seq_no;
        let current_capture_images =
            self.capture_images_for_sequence(latest_sequence, &records[0].detected_at);
        let inspections = records
            .iter()
            .map(|record| {
                let record_defects = defects_by_seq
                    .get(&record.seq_no)
                    .cloned()
                    .unwrap_or_default();
                let capture_images = if record.seq_no == latest_sequence {
                    current_capture_images.clone()
                } else {
                    Vec::new()
                };
                json!({
                    "plate": plate_value(record),
                    "defects": record_defects,
                    "heightProfile": [],
                    "captureImages": capture_images,
                    "inspectionId": canonical_bkv_record_id(record.seq_no),
                    "summaryPath": "",
                    "captureSummaryPath": "",
                    "source": "bkv-online-mysql"
                })
            })
            .collect::<Vec<_>>();
        let current_defects = defects_by_seq
            .get(&records[0].seq_no)
            .cloned()
            .unwrap_or_default();
        let summary = summarize_defects(&current_defects);
        let camera_ports = cameras
            .iter()
            .map(|(index, ok)| json!({ "index": index, "ok": ok }))
            .collect::<Vec<_>>();
        let records_value = records
            .iter()
            .map(|record| {
                json!({
                    "id": canonical_bkv_record_id(record.seq_no),
                    "time": time_label(&record.detected_at),
                    "plateNo": display_material_id(record),
                    "status": if record.complete { "completed" } else { "detecting" },
                    "defectCount": record.defect_count.max(
                        defects_by_seq.get(&record.seq_no).map(|items| items.len() as i64).unwrap_or(0)
                    )
                })
            })
            .collect::<Vec<_>>();

        Ok(json!({
            "currentPlate": plate_value(&records[0]),
            "defectTypes": defect_types.iter().map(|item| json!({
                "id": format!("bkv-class-{}", item.class_no),
                "label": item.label,
                "color": item.color,
                "shape": item.shape
            })).collect::<Vec<_>>(),
            "defects": current_defects,
            "records": records_value,
            "status": {
                "receiverPorts": camera_ports,
                "cameraPorts": camera_ports,
                "encoder": "sync",
                "plc": "normal",
                "l2": "normal",
                "alarmCount": cameras.iter().filter(|(_, ok)| !ok).count()
            },
            "summary": summary,
            "heightProfile": [],
            "inspections": inspections,
            "captureImages": current_capture_images,
            "source": "bkv-online-mysql"
        }))
    }

    fn capture_images_for_sequence(&self, sequence: i64, detected_at: &str) -> Vec<Value> {
        self.image_roots
            .iter()
            .enumerate()
            .filter_map(|(camera_index, root)| {
                let image_dir = root.join(sequence.to_string()).join("2D");
                let mut candidates = fs::read_dir(image_dir)
                    .ok()?
                    .filter_map(Result::ok)
                    .filter_map(|entry| {
                        let path = entry.path();
                        let is_bmp = path
                            .extension()
                            .and_then(|extension| extension.to_str())
                            .is_some_and(|extension| extension.eq_ignore_ascii_case("bmp"));
                        let image_index = path
                            .file_stem()
                            .and_then(|stem| stem.to_str())
                            .and_then(|stem| stem.parse::<i64>().ok());
                        (is_bmp && image_index.is_some()).then_some((image_index?, path))
                    })
                    .collect::<Vec<_>>();
                candidates.sort_by_key(|(image_index, _)| *image_index);
                let (image_index, path) = candidates.first()?;
                let camera = camera_index + 1;
                Some(json!({
                    "id": format!("bkv-{sequence}-camera{camera}-{image_index}"),
                    "cameraId": format!("camera{camera}"),
                    "cameraIp": format!("CamImageSource{camera}"),
                    "dataName": "intensity",
                    "sequenceNo": image_index,
                    "fileType": "bmp",
                    "path": path.to_string_lossy(),
                    "url": bkv_image_url(sequence, camera as i64, *image_index, "2d"),
                    "createdAt": detected_at
                }))
            })
            .collect()
    }

    async fn load_records(&self) -> Result<Vec<BkvRecord>, DbErr> {
        let sql = format!(
            "SELECT \
             CAST(SeqNo AS CHAR) AS seq_no, \
             COALESCE(SteelID, '') AS steel_id, \
             COALESCE(SteelType, '') AS steel_type, \
             CAST(COALESCE(RcvRadius, 0) AS CHAR) AS received_diameter, \
             CAST(COALESCE(RcvLen, 0) AS CHAR) AS received_length, \
             CAST(COALESCE(Radius, 0) AS CHAR) AS measured_diameter, \
             CAST(COALESCE(Len, 0) AS CHAR) AS measured_length, \
             CAST(COALESCE(ScaleY, 0) AS CHAR) AS length_scale, \
             CAST(COALESCE(DefectNum, 0) AS CHAR) AS defect_count, \
             COALESCE(DATE_FORMAT(DefectTime, '%Y-%m-%d %H:%i:%s'), '') AS detected_at, \
             CAST(COALESCE(WallThick, 0) AS CHAR) AS wall_thickness, \
             CASE WHEN Radius IS NULL OR Len IS NULL THEN '0' ELSE '1' END AS complete \
             FROM `{}`.`record` ORDER BY ID DESC LIMIT {}",
            self.database, self.record_limit
        );
        self.connection
            .query_all(Statement::from_string(DbBackend::MySql, sql))
            .await?
            .iter()
            .map(record_from_row)
            .collect()
    }

    async fn load_recent_defects(
        &self,
        seq_numbers: &HashSet<i64>,
    ) -> Result<Vec<BkvDefect>, DbErr> {
        let sql = format!(
            "SELECT \
             CAST(ID AS CHAR) AS id, CAST(CamNo AS CHAR) AS camera_no, \
             CAST(COALESCE(DefectNo, ID) AS CHAR) AS defect_no, \
             CAST(COALESCE(SeqNo, 0) AS CHAR) AS seq_no, \
             CAST(COALESCE(Class, 0) AS CHAR) AS class_no, \
             CAST(COALESCE(Grade, 0) AS CHAR) AS grade, \
             CAST(COALESCE(Confidence, 0) AS CHAR) AS confidence, \
             CAST(COALESCE(ImgIndex, 0) AS CHAR) AS image_index, \
             CAST(COALESCE(LeftSteel3D, LeftSteel2D, 0) AS CHAR) AS left_value, \
             CAST(COALESCE(RightSteel3D, RightSteel2D, 0) AS CHAR) AS right_value, \
             CAST(COALESCE(TopSteel3D, TopSteel2D, 0) AS CHAR) AS top_value, \
             CAST(COALESCE(BottomSteel3D, BottomSteel2D, 0) AS CHAR) AS bottom_value, \
             CAST(COALESCE(DepthSteel3D, 0) AS CHAR) AS depth_value \
             FROM `{}`.`defect` ORDER BY ID DESC LIMIT {}",
            self.database, self.defect_window
        );
        let rows = self
            .connection
            .query_all(Statement::from_string(DbBackend::MySql, sql))
            .await?;
        let mut defects = Vec::new();
        for row in &rows {
            let defect = defect_from_row(row)?;
            if seq_numbers.contains(&defect.seq_no) {
                defects.push(defect);
            }
        }
        Ok(defects)
    }

    async fn load_defect_types(&self) -> Result<Vec<BkvDefectType>, DbErr> {
        let sql = format!(
            "SELECT CAST(ClassNo AS CHAR) AS class_no, \
             COALESCE(CONVERT(ClassName USING utf8mb4), '') AS label, \
             CAST(COALESCE(Red, 128) AS CHAR) AS red_value, \
             CAST(COALESCE(Green, 128) AS CHAR) AS green_value, \
             CAST(COALESCE(Blue, 128) AS CHAR) AS blue_value \
             FROM `{}`.`defectclass` ORDER BY ClassNo",
            self.database
        );
        let rows = self
            .connection
            .query_all(Statement::from_string(DbBackend::MySql, sql))
            .await?;
        let shapes = ["circle", "square", "diamond", "rect", "star"];
        rows.iter()
            .enumerate()
            .map(|(index, row)| {
                let class_no = row_i64(row, "class_no")?;
                let label = row_string(row, "label")?;
                let red = row_i64(row, "red_value")?.clamp(0, 255);
                let green = row_i64(row, "green_value")?.clamp(0, 255);
                let blue = row_i64(row, "blue_value")?.clamp(0, 255);
                Ok(BkvDefectType {
                    class_no,
                    label: if label.trim().is_empty() {
                        format!("缺陷类型 {class_no}")
                    } else {
                        label
                    },
                    color: format!("#{red:02x}{green:02x}{blue:02x}"),
                    shape: shapes[index % shapes.len()],
                })
            })
            .collect()
    }

    async fn load_camera_status(&self) -> Result<Vec<(i64, bool)>, DbErr> {
        let sql = format!(
            "SELECT CAST(COALESCE(camerano, 0) AS CHAR) AS camera_no, \
             CAST(COALESCE(temperature, 0) AS CHAR) AS temperature_value \
             FROM `{}`.`camera` ORDER BY camerano",
            self.database
        );
        let rows = self
            .connection
            .query_all(Statement::from_string(DbBackend::MySql, sql))
            .await?;
        rows.iter()
            .map(|row| {
                let camera_no = row_i64(row, "camera_no")?;
                let temperature = row_f64(row, "temperature_value")?;
                Ok((camera_no, camera_no > 0 && temperature > 0.0))
            })
            .collect()
    }
}

fn row_string(row: &QueryResult, column: &str) -> Result<String, DbErr> {
    row.try_get("", column)
}

fn row_i64(row: &QueryResult, column: &str) -> Result<i64, DbErr> {
    row_string(row, column)?
        .parse::<i64>()
        .map_err(|_| DbErr::Custom(format!("BKV column {column} is not an integer")))
}

fn row_f64(row: &QueryResult, column: &str) -> Result<f64, DbErr> {
    row_string(row, column)?
        .parse::<f64>()
        .map_err(|_| DbErr::Custom(format!("BKV column {column} is not numeric")))
}

fn record_from_row(row: &QueryResult) -> Result<BkvRecord, DbErr> {
    Ok(BkvRecord {
        seq_no: row_i64(row, "seq_no")?,
        steel_id: row_string(row, "steel_id")?,
        steel_type: row_string(row, "steel_type")?,
        received_diameter_mm: row_f64(row, "received_diameter")?,
        received_length_mm: row_f64(row, "received_length")?,
        measured_diameter_mm: row_f64(row, "measured_diameter")?,
        measured_length_samples: row_f64(row, "measured_length")?,
        length_scale_mm: row_f64(row, "length_scale")?,
        defect_count: row_i64(row, "defect_count")?,
        detected_at: row_string(row, "detected_at")?,
        wall_thickness_mm: row_f64(row, "wall_thickness")?,
        complete: row_string(row, "complete")? == "1",
    })
}

fn defect_from_row(row: &QueryResult) -> Result<BkvDefect, DbErr> {
    Ok(BkvDefect {
        id: row_i64(row, "id")?,
        camera_no: row_i64(row, "camera_no")?,
        defect_no: row_i64(row, "defect_no")?,
        seq_no: row_i64(row, "seq_no")?,
        class_no: row_i64(row, "class_no")?,
        grade: row_i64(row, "grade")?,
        confidence: row_f64(row, "confidence")?,
        image_index: row_i64(row, "image_index")?,
        left: row_f64(row, "left_value")?,
        right: row_f64(row, "right_value")?,
        top: row_f64(row, "top_value")?,
        bottom: row_f64(row, "bottom_value")?,
        depth_micrometers: row_f64(row, "depth_value")?,
    })
}

fn display_material_id(record: &BkvRecord) -> String {
    let material = if record.steel_id.trim().is_empty() {
        "BKV"
    } else {
        record.steel_id.trim()
    };
    format!("{material} / {}", record.seq_no)
}

fn measured_length_mm(record: &BkvRecord) -> f64 {
    let measured = record.measured_length_samples * record.length_scale_mm;
    if measured > 0.0 {
        measured
    } else {
        record.received_length_mm.max(0.0)
    }
}

fn plate_value(record: &BkvRecord) -> Value {
    let diameter = if record.measured_diameter_mm > 0.0 {
        record.measured_diameter_mm
    } else {
        record.received_diameter_mm.max(0.0)
    };
    json!({
        "plateNo": display_material_id(record),
        "widthMm": std::f64::consts::PI * diameter,
        "lengthMm": measured_length_mm(record),
        "thicknessMm": record.wall_thickness_mm.max(0.0),
        "steelGrade": if record.steel_type.trim().is_empty() { "BKV 在线" } else { record.steel_type.as_str() },
        "detectedAt": record.detected_at
    })
}

fn bkv_image_url(sequence: i64, camera: i64, image_index: i64, kind: &str) -> String {
    format!("/api/bkv-online/image?camera={camera}&seq={sequence}&index={image_index}&kind={kind}")
}

fn defect_value(
    defect: &BkvDefect,
    record: &BkvRecord,
    defect_type: Option<&BkvDefectType>,
) -> Value {
    let length = measured_length_mm(record).max(1.0);
    let diameter = if record.measured_diameter_mm > 0.0 {
        record.measured_diameter_mm
    } else {
        record.received_diameter_mm.max(1.0)
    };
    let circumference = (std::f64::consts::PI * diameter).max(1.0);
    let center_line = (defect.top + defect.bottom) / 2.0;
    let distance = (center_line * record.length_scale_mm.max(0.001)).rem_euclid(length);
    let camera_no = defect.camera_no.clamp(1, 6);
    let local_ratio = (((defect.left + defect.right) / 2.0) / 1024.0).clamp(0.0, 0.999);
    let circumference_ratio = ((camera_no - 1) as f64 + local_ratio) / 6.0;
    let operator_side = circumference * circumference_ratio;
    let type_id = format!("bkv-class-{}", defect.class_no);
    let type_label = defect_type
        .map(|item| item.label.clone())
        .unwrap_or_else(|| format!("缺陷类型 {}", defect.class_no));
    let severity = if defect.grade >= 3 {
        "severe"
    } else if defect.grade == 2 {
        "review"
    } else {
        "minor"
    };
    let intensity_url = bkv_image_url(defect.seq_no, camera_no, defect.image_index, "2d");
    let depth_url = bkv_image_url(defect.seq_no, camera_no, defect.image_index, "depth");
    let roi_x = defect.left.min(defect.right).max(0.0).round() as i64;
    let roi_y = (defect.top.min(defect.bottom) % 1024.0).max(0.0).round() as i64;
    let roi_width = (defect.right - defect.left).abs().max(1.0).round() as i64;
    let roi_height = (defect.bottom - defect.top).abs().max(1.0).round() as i64;
    json!({
        "id": format!("BKV-D-{}-{}", defect.defect_no, defect.id),
        "plateNo": display_material_id(record),
        "cameraId": format!("camera{camera_no}"),
        "cameraIndex": camera_no,
        "typeId": type_id,
        "typeLabel": type_label,
        "surface": if camera_no <= 3 { "top" } else { "bottom" },
        "severity": severity,
        "distanceHeadMm": distance.round() as i64,
        "operatorSideMm": operator_side.round() as i64,
        "driveSideMm": (circumference - operator_side).round() as i64,
        "widthMm": ((defect.right - defect.left).abs() * circumference / (6.0 * 1024.0)).max(0.0),
        "heightMm": ((defect.bottom - defect.top).abs() * record.length_scale_mm).max(0.0),
        "depthMm": defect.depth_micrometers / 1000.0,
        "xRatio": (distance / length).clamp(0.0, 1.0),
        "yOffsetMm": ((circumference_ratio - 0.5) * 3.0).clamp(-1.5, 1.5),
        "previewX": (local_ratio * 100.0).round() as i64,
        "previewY": ((distance / length) * 100.0).round() as i64,
        "previewImageUrl": intensity_url.clone(),
        "circumferenceRatio": circumference_ratio,
        "confidence": (defect.confidence / 100.0).clamp(0.0, 1.0),
        "detectionConfidence": (defect.confidence / 100.0).clamp(0.0, 1.0),
        "synthetic": false,
        "imageIndex": defect.image_index,
        "artifacts": {
            "schema": "steel.surface.defect.artifacts.v1",
            "cameraId": format!("camera{camera_no}"),
            "frameId": format!("bkv-{}-{}-{}", defect.seq_no, camera_no, defect.image_index),
            "sequenceNo": defect.image_index,
            "roi": {
                "x": roi_x,
                "y": roi_y,
                "width": roi_width,
                "height": roi_height
            },
            "sourceFrame": {
                "intensity": intensity_url.clone(),
                "depth": depth_url.clone()
            },
            "roiImage": intensity_url,
            "depthRoiImage": depth_url
        }
    })
}

fn summarize_defects(defects: &[Value]) -> Value {
    let mut severe = 0;
    let mut review = 0;
    let mut minor = 0;
    let mut top = 0;
    let mut bottom = 0;
    for defect in defects {
        match defect.get("severity").and_then(Value::as_str) {
            Some("severe") => severe += 1,
            Some("review") => review += 1,
            _ => minor += 1,
        }
        if defect.get("surface").and_then(Value::as_str) == Some("top") {
            top += 1;
        } else {
            bottom += 1;
        }
    }
    json!({
        "total": defects.len(),
        "bySeverity": { "severe": severe, "review": review, "minor": minor },
        "bySurface": { "top": top, "bottom": bottom }
    })
}

fn time_label(value: &str) -> String {
    value
        .get(11..16)
        .filter(|label| !label.trim().is_empty())
        .unwrap_or("--:--")
        .to_string()
}

fn empty_snapshot() -> Value {
    json!({
        "currentPlate": {
            "plateNo": "暂无 BKV 生产记录",
            "widthMm": 0,
            "lengthMm": 0,
            "thicknessMm": 0,
            "steelGrade": "-",
            "detectedAt": ""
        },
        "defectTypes": [],
        "defects": [],
        "records": [],
        "status": {
            "receiverPorts": [],
            "cameraPorts": [],
            "encoder": "offline",
            "plc": "error",
            "l2": "error",
            "alarmCount": 0
        },
        "summary": {
            "total": 0,
            "bySeverity": { "severe": 0, "review": 0, "minor": 0 },
            "bySurface": { "top": 0, "bottom": 0 }
        },
        "heightProfile": [],
        "inspections": [],
        "captureImages": [],
        "source": "bkv-online-mysql"
    })
}

fn read_bounded_file(path: &Path) -> Result<Vec<u8>, BkvImageError> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(BkvImageError::InvalidFormat("image_not_regular_file"));
    }
    if metadata.len() == 0 || metadata.len() > BKV_IMAGE_MAX_BYTES {
        return Err(BkvImageError::InvalidFormat("image_size_out_of_range"));
    }
    Ok(fs::read(path)?)
}

fn read_i16_le(bytes: &[u8], offset: usize) -> Option<i16> {
    let value = bytes.get(offset..offset + 2)?;
    Some(i16::from_le_bytes([value[0], value[1]]))
}

fn read_i32_le(bytes: &[u8], offset: usize) -> Option<i32> {
    let value = bytes.get(offset..offset + 4)?;
    Some(i32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn read_f32_le(bytes: &[u8], offset: usize) -> Option<f32> {
    let value = bytes.get(offset..offset + 4)?;
    Some(f32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq)]
struct D3ImgHeader {
    tag: [u8; 6],
    head_size: i16,
    steel_no: i32,
    image_index: i32,
    image_sequence: i32,
    width: i32,
    height: i32,
    scale_x: f32,
    left: i32,
    right: i32,
    start_length: i32,
    end_length: i32,
    start_position: i32,
    camera_number: u8,
    data_type: u8,
    pixel_size: u8,
    reserve: [u8; 29],
}

fn parse_d3img_header(bytes: &[u8]) -> Result<D3ImgHeader, BkvImageError> {
    parse_d3img_header_with_file_len(bytes, bytes.len())
}

fn parse_d3img_header_with_file_len(
    bytes: &[u8],
    file_len: usize,
) -> Result<D3ImgHeader, BkvImageError> {
    if bytes.len() < BKV_D3_HEADER_BYTES {
        return Err(BkvImageError::InvalidFormat("invalid_d3img_header"));
    }
    let header = D3ImgHeader {
        tag: bytes[0..6]
            .try_into()
            .map_err(|_| BkvImageError::InvalidFormat("invalid_d3img_header"))?,
        head_size: read_i16_le(bytes, 6)
            .ok_or(BkvImageError::InvalidFormat("invalid_d3img_header_size"))?,
        steel_no: read_i32_le(bytes, 8)
            .ok_or(BkvImageError::InvalidFormat("invalid_d3img_steel_no"))?,
        image_index: read_i32_le(bytes, 12)
            .ok_or(BkvImageError::InvalidFormat("invalid_d3img_image_index"))?,
        image_sequence: read_i32_le(bytes, 16)
            .ok_or(BkvImageError::InvalidFormat("invalid_d3img_image_sequence"))?,
        width: read_i32_le(bytes, 20).ok_or(BkvImageError::InvalidFormat("invalid_d3img_width"))?,
        height: read_i32_le(bytes, 24)
            .ok_or(BkvImageError::InvalidFormat("invalid_d3img_height"))?,
        scale_x: read_f32_le(bytes, 28)
            .ok_or(BkvImageError::InvalidFormat("invalid_d3img_scale_x"))?,
        left: read_i32_le(bytes, 32).ok_or(BkvImageError::InvalidFormat("invalid_d3img_left"))?,
        right: read_i32_le(bytes, 36).ok_or(BkvImageError::InvalidFormat("invalid_d3img_right"))?,
        start_length: read_i32_le(bytes, 40)
            .ok_or(BkvImageError::InvalidFormat("invalid_d3img_start_length"))?,
        end_length: read_i32_le(bytes, 44)
            .ok_or(BkvImageError::InvalidFormat("invalid_d3img_end_length"))?,
        start_position: read_i32_le(bytes, 48)
            .ok_or(BkvImageError::InvalidFormat("invalid_d3img_start_position"))?,
        camera_number: bytes[52],
        data_type: bytes[53],
        pixel_size: bytes[54],
        reserve: bytes[55..84]
            .try_into()
            .map_err(|_| BkvImageError::InvalidFormat("invalid_d3img_header"))?,
    };
    if header.tag != *b"3DImg\0" {
        return Err(BkvImageError::InvalidFormat("invalid_d3img_header"));
    }
    if header.head_size != BKV_D3_HEADER_BYTES as i16 {
        return Err(BkvImageError::InvalidFormat("invalid_d3img_header_size"));
    }
    if header.pixel_size != 4 {
        return Err(BkvImageError::InvalidFormat("invalid_d3img_pixel_size"));
    }
    if header.width <= 0 || header.height <= 0 || header.width > 16_384 || header.height > 65_536 {
        return Err(BkvImageError::InvalidFormat(
            "d3img_dimensions_out_of_range",
        ));
    }
    let pixel_count = usize::try_from(header.width)
        .ok()
        .and_then(|width| {
            usize::try_from(header.height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or(BkvImageError::InvalidFormat("d3img_pixel_count_overflow"))?;
    let expected_bytes = pixel_count
        .checked_mul(usize::from(header.pixel_size))
        .and_then(|value| BKV_D3_HEADER_BYTES.checked_add(value))
        .ok_or(BkvImageError::InvalidFormat("d3img_payload_overflow"))?;
    if expected_bytes > file_len {
        return Err(BkvImageError::InvalidFormat("d3img_payload_truncated"));
    }
    if expected_bytes < file_len {
        return Err(BkvImageError::InvalidFormat("d3img_payload_trailing"));
    }
    Ok(header)
}

fn valid_d3img_depth(value: f32) -> bool {
    value.is_finite() && value != BKV_D3_INVALID_DEPTH
}

fn evenly_sample_frame_paths(
    candidates: Vec<(u32, PathBuf)>,
    maximum: usize,
) -> Vec<(u32, PathBuf)> {
    if candidates.len() <= maximum || maximum == 0 {
        return candidates;
    }
    if maximum == 1 {
        return candidates.into_iter().take(1).collect();
    }
    let last = candidates.len() - 1;
    (0..maximum)
        .map(|index| candidates[index * last / (maximum - 1)].clone())
        .collect()
}

struct LoadedD3Img {
    frame_number: u32,
    source_path: PathBuf,
    header: D3ImgHeader,
}

fn load_d3img(path: &Path, frame_number: u32) -> Result<LoadedD3Img, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.len() > BKV_IMAGE_MAX_BYTES {
        return Err(format!("{}: D3IMG size is out of range", path.display()));
    }
    let file_len = usize::try_from(metadata.len())
        .map_err(|_| format!("{}: D3IMG size is out of range", path.display()))?;
    let mut file = fs::File::open(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut header_bytes = [0u8; BKV_D3_HEADER_BYTES];
    file.read_exact(&mut header_bytes)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    let header = parse_d3img_header_with_file_len(&header_bytes, file_len)
        .map_err(|error| format!("{}: {error:?}", path.display()))?;
    Ok(LoadedD3Img {
        frame_number,
        source_path: path.to_path_buf(),
        header,
    })
}

fn read_sampled_d3img_row(
    file: &mut fs::File,
    frame: &LoadedD3Img,
    source_row: usize,
    columns: usize,
) -> Result<Vec<Option<f32>>, String> {
    let width = usize::try_from(frame.header.width)
        .map_err(|_| format!("{}: invalid D3IMG width", frame.source_path.display()))?;
    let height = usize::try_from(frame.header.height)
        .map_err(|_| format!("{}: invalid D3IMG height", frame.source_path.display()))?;
    if source_row >= height {
        return Err(format!(
            "{}: sampled D3IMG row is out of range",
            frame.source_path.display()
        ));
    }
    let row_bytes = width
        .checked_mul(4)
        .ok_or_else(|| "D3IMG row size overflow".to_string())?;
    let offset = BKV_D3_HEADER_BYTES
        .checked_add(
            source_row
                .checked_mul(row_bytes)
                .ok_or_else(|| "D3IMG row offset overflow".to_string())?,
        )
        .ok_or_else(|| "D3IMG row offset overflow".to_string())?;
    file.seek(SeekFrom::Start(offset as u64))
        .map_err(|error| format!("{}: {error}", frame.source_path.display()))?;
    let mut row = vec![0u8; row_bytes];
    file.read_exact(&mut row)
        .map_err(|error| format!("{}: {error}", frame.source_path.display()))?;
    Ok((0..columns)
        .map(|target_column| {
            let source_column = if columns <= 1 {
                0
            } else {
                target_column * (width - 1) / (columns - 1)
            };
            let offset = source_column * 4;
            let depth = f32::from_le_bytes([
                row[offset],
                row[offset + 1],
                row[offset + 2],
                row[offset + 3],
            ]);
            valid_d3img_depth(depth).then_some(depth)
        })
        .collect())
}

fn median_f32(values: &mut [f32]) -> Option<f32> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f32::total_cmp);
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) * 0.5
    } else {
        values[middle]
    })
}

fn build_d3img_surface(
    sequence: i64,
    camera_inputs: &[(u32, Vec<(u32, PathBuf)>, PathBuf)],
) -> Result<(Value, usize), String> {
    if camera_inputs.is_empty() {
        return Err("BKV D3IMG camera list is empty".to_string());
    }
    if let Some((camera_id, _, directory)) = camera_inputs
        .iter()
        .find(|(_, candidates, _)| candidates.is_empty())
    {
        return Err(format!(
            "camera {camera_id} has no D3IMG frames in {}",
            directory.display()
        ));
    }

    let rows = BKV_DEPTH_SURFACE_ROWS;
    let cols_per_camera = BKV_DEPTH_SURFACE_COLS_PER_CAMERA;
    let camera_count = camera_inputs.len();
    let angular_columns = cols_per_camera
        .checked_mul(camera_count)
        .ok_or_else(|| "D3IMG surface column count overflow".to_string())?;
    let mut sampled_cameras = Vec::with_capacity(camera_count);
    let mut camera_metadata = Vec::with_capacity(camera_count);
    let mut frame_stems = Vec::new();
    let mut source_frame_count = 0usize;

    for (camera_id, candidates, directory) in camera_inputs {
        let frames = candidates
            .iter()
            .map(|(frame, path)| load_d3img(path, *frame))
            .collect::<Result<Vec<_>, _>>()?;
        source_frame_count += frames.len();
        let total_height = frames.iter().try_fold(0usize, |total, frame| {
            usize::try_from(frame.header.height)
                .ok()
                .and_then(|height| total.checked_add(height))
                .ok_or_else(|| "D3IMG combined height overflow".to_string())
        })?;
        if total_height == 0 {
            return Err(format!("camera {camera_id} has no D3IMG rows"));
        }
        let mut samples = vec![None; rows * cols_per_camera];
        let mut row_mappings = Vec::with_capacity(rows);

        // 预计算每帧的起始行，避免在循环中重复计算
        let mut frame_start_rows = Vec::with_capacity(frames.len());
        let mut current_row = 0usize;
        for frame in &frames {
            frame_start_rows.push(current_row);
            let height = usize::try_from(frame.header.height).unwrap_or(0);
            current_row = current_row.saturating_add(height);
        }

        for target_row in 0..rows {
            let global_row = if rows <= 1 {
                0
            } else {
                // 确保不超出总高度范围
                let calculated =
                    target_row * (total_height.saturating_sub(1)) / (rows.saturating_sub(1));
                calculated.min(total_height.saturating_sub(1))
            };

            // 使用预计算的帧起始行来查找正确的帧。从后向前找到第一个
            // 起始行 <= global_row 的帧。理论上必然命中第一帧（起始行为0），
            // 但用显式错误而非静默兜底，以便在帧高度总和与 total_height
            // 不一致时尽早暴露数据损坏。
            let frame_index = frame_start_rows
                .iter()
                .enumerate()
                .rev()
                .find(|(_, &start_row)| global_row >= start_row)
                .map(|(index, _)| index)
                .ok_or_else(|| format!("camera {camera_id} D3IMG row mapping failed"))?;

            let source_row = global_row.saturating_sub(frame_start_rows[frame_index]);
            row_mappings.push((frame_index, source_row));
        }
        for (frame_index, frame) in frames.iter().enumerate() {
            let mut file = fs::File::open(&frame.source_path)
                .map_err(|error| format!("{}: {error}", frame.source_path.display()))?;
            for (target_row, (_, source_row)) in row_mappings
                .iter()
                .enumerate()
                .filter(|(_, (mapped_frame, _))| *mapped_frame == frame_index)
            {
                let sampled =
                    read_sampled_d3img_row(&mut file, frame, *source_row, cols_per_camera)?;
                let start = target_row * cols_per_camera;
                samples[start..start + cols_per_camera].copy_from_slice(&sampled);
            }
        }
        let mut valid_values = samples.iter().flatten().copied().collect::<Vec<_>>();
        let baseline = median_f32(&mut valid_values)
            .ok_or_else(|| format!("camera {camera_id} D3IMG has no valid sampled depth"))?;
        let first = frames
            .first()
            .ok_or_else(|| format!("camera {camera_id} D3IMG frame list is empty"))?;
        let last = frames.last().unwrap_or(first);
        for frame in &frames {
            frame_stems.push(format!("camera{camera_id}:{:04}", frame.frame_number));
        }
        camera_metadata.push(json!({
            "cameraId": camera_id,
            "sourceDirectory": directory.display().to_string(),
            "frameCount": frames.len(),
            "firstFrame": first.frame_number,
            "lastFrame": last.frame_number,
            "sourceWidth": first.header.width,
            "sourceHeight": first.header.height,
            "scaleX": first.header.scale_x,
            "dataType": first.header.data_type,
            "pixelSize": first.header.pixel_size,
            "baseline": baseline,
            "sourceFirst": first.source_path.display().to_string(),
            "sourceLast": last.source_path.display().to_string(),
        }));
        sampled_cameras.push((baseline, samples));
    }

    let mut absolute_residuals = sampled_cameras
        .iter()
        .flat_map(|(baseline, samples)| {
            samples
                .iter()
                .flatten()
                .map(move |value| (value - baseline).abs())
        })
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    absolute_residuals.sort_by(f32::total_cmp);
    let robust_residual = absolute_residuals
        .get((absolute_residuals.len().saturating_sub(1) * 95) / 100)
        .copied()
        .unwrap_or(1.0)
        .max(f32::EPSILON);
    let display_scale = 0.18 / robust_residual;
    let point_count = rows
        .checked_mul(angular_columns)
        .ok_or_else(|| "D3IMG surface point count overflow".to_string())?;
    let mut positions = Vec::with_capacity(point_count * 3);
    let mut uvs = Vec::with_capacity(point_count * 2);
    let mut colors = Vec::with_capacity(point_count * 3);
    let mut valid_mask = Vec::with_capacity(point_count);
    let calibrated_mask = vec![0u8; point_count];

    for row in 0..rows {
        let longitudinal = if rows <= 1 {
            0.0
        } else {
            row as f32 / (rows - 1) as f32
        };
        for angular_column in 0..angular_columns {
            let camera_index = angular_column / cols_per_camera;
            let camera_column = angular_column % cols_per_camera;
            let (baseline, samples) = &sampled_cameras[camera_index];
            let sample = samples[row * cols_per_camera + camera_column];
            let residual = sample.map(|value| value - baseline).unwrap_or_default();
            let radial_offset = (residual * display_scale).clamp(-0.28, 0.28);
            let radius = 1.0 + radial_offset;
            let angle = std::f32::consts::TAU * angular_column as f32 / angular_columns as f32;
            positions.extend_from_slice(&[
                longitudinal * 8.0 - 4.0,
                radius * angle.cos(),
                radius * angle.sin(),
            ]);
            uvs.extend_from_slice(&[longitudinal, angular_column as f32 / angular_columns as f32]);
            if sample.is_some() {
                let tone = (residual / robust_residual).clamp(-1.0, 1.0);
                if tone >= 0.0 {
                    colors.extend_from_slice(&[
                        0.45 + tone * 0.50,
                        0.68 - tone * 0.30,
                        0.72 - tone * 0.45,
                    ]);
                } else {
                    let magnitude = -tone;
                    colors.extend_from_slice(&[
                        0.45 - magnitude * 0.28,
                        0.68 + magnitude * 0.18,
                        0.72 + magnitude * 0.25,
                    ]);
                }
                valid_mask.push(1u8);
            } else {
                colors.extend_from_slice(&[0.03, 0.06, 0.08]);
                valid_mask.push(0u8);
            }
        }
    }

    let mut indices = Vec::new();
    for row in 0..rows.saturating_sub(1) {
        for column in 0..angular_columns {
            let next_column = (column + 1) % angular_columns;
            let a = row * angular_columns + column;
            let b = row * angular_columns + next_column;
            let c = (row + 1) * angular_columns + column;
            let d = (row + 1) * angular_columns + next_column;
            if valid_mask[a] != 0 && valid_mask[b] != 0 && valid_mask[c] != 0 && valid_mask[d] != 0
            {
                indices.extend_from_slice(&[
                    u32::try_from(a).map_err(|_| "D3IMG mesh index overflow")?,
                    u32::try_from(c).map_err(|_| "D3IMG mesh index overflow")?,
                    u32::try_from(b).map_err(|_| "D3IMG mesh index overflow")?,
                    u32::try_from(b).map_err(|_| "D3IMG mesh index overflow")?,
                    u32::try_from(c).map_err(|_| "D3IMG mesh index overflow")?,
                    u32::try_from(d).map_err(|_| "D3IMG mesh index overflow")?,
                ]);
            }
        }
    }

    Ok((
        json!({
            "schema": "steel.bkv-depth-surface.v1",
            "recordId": canonical_bkv_record_id(sequence),
            "coordinateUnit": "legacy-unknown",
            "coordinateFrame": {
                "schema": "steel.bkv-depth-display-frame.v1",
                "applied": false,
                "origin": "camera-relative-median",
                "axis": "x=longitudinal,yz=circumference",
                "reason": "D3IMG physical depth unit and camera extrinsics are not confirmed",
            },
            "cameraCount": camera_count,
            "frameStems": frame_stems,
            "rows": rows,
            "colsPerCamera": cols_per_camera,
            "positions": positions,
            "uvs": uvs,
            "colors": colors,
            "validMask": valid_mask,
            "calibratedMask": calibrated_mask,
            "indices": indices,
            "source": "d3img-float32",
            "sourceHeaderBytes": BKV_D3_HEADER_BYTES,
            "sourcePixelSize": 4,
            "sourceInvalidSentinelObserved": BKV_D3_INVALID_DEPTH,
            "sourceFrameCount": source_frame_count,
            "display": {
                "mode": "camera-relative-residual",
                "robustResidualP95": robust_residual,
                "radialScale": display_scale,
                "calibrated": false,
                "unit": "legacy-unknown",
            },
            "cameras": camera_metadata,
            "createdAtMs": current_time_millis(),
        }),
        source_frame_count,
    ))
}

fn d3img_reconstruction_parameters(surface: &Value) -> Value {
    json!({
        "schema": "steel.bkv-depth-reconstruction-parameters.v1",
        "recordId": surface.get("recordId"),
        "input": {
            "format": "D3IMG",
            "headerBytes": surface.get("sourceHeaderBytes"),
            "pixelSize": surface.get("sourcePixelSize"),
            "invalidSentinelObserved": surface.get("sourceInvalidSentinelObserved"),
            "sourceFrameCount": surface.get("sourceFrameCount"),
            "frameStems": surface.get("frameStems"),
        },
        "sampling": {
            "rows": surface.get("rows"),
            "colsPerCamera": surface.get("colsPerCamera"),
            "cameraCount": surface.get("cameraCount"),
            "maximumFramesPerCamera": BKV_DEPTH_SURFACE_MAX_FRAMES_PER_CAMERA,
            "frameSelection": "evenly-spaced",
            "rowSelection": "evenly-spaced-across-selected-frames",
        },
        "reconstruction": {
            "geometry": "closed-cylinder",
            "longitudinalExtent": 8.0,
            "nominalRadius": 1.0,
            "maximumRadialOffset": 0.28,
            "cameraNormalization": "valid-sample-median",
            "coordinateUnit": surface.get("coordinateUnit"),
            "coordinateFrame": surface.get("coordinateFrame"),
            "calibrated": false,
        },
        "display": surface.get("display"),
        "cameras": surface.get("cameras"),
        "createdAtMs": surface.get("createdAtMs"),
    })
}

fn surface_f32_values(surface: &Value, name: &str) -> Result<Vec<f32>, String> {
    surface
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("D3IMG surface {name} is missing"))?
        .iter()
        .map(|value| {
            value
                .as_f64()
                .map(|value| value as f32)
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("D3IMG surface {name} contains an invalid number"))
        })
        .collect()
}

fn surface_u32_values(surface: &Value, name: &str) -> Result<Vec<u32>, String> {
    surface
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("D3IMG surface {name} is missing"))?
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
                .ok_or_else(|| format!("D3IMG surface {name} contains an invalid index"))
        })
        .collect()
}

fn surface_u8_values(surface: &Value, name: &str) -> Result<Vec<u8>, String> {
    surface
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("D3IMG surface {name} is missing"))?
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|value| u8::try_from(value).ok())
                .ok_or_else(|| format!("D3IMG surface {name} contains an invalid mask"))
        })
        .collect()
}

fn encode_d3img_surface_bsmesh(surface: &Value) -> Result<Vec<u8>, String> {
    let positions = surface_f32_values(surface, "positions")?;
    if positions.len() % 3 != 0 {
        return Err("D3IMG surface positions are not xyz triples".to_string());
    }
    let vertex_count = positions.len() / 3;
    let uvs = surface_f32_values(surface, "uvs")?;
    let colors = surface_f32_values(surface, "colors")?;
    let indices = surface_u32_values(surface, "indices")?;
    let valid_mask = surface_u8_values(surface, "validMask")?;
    let calibrated_mask = surface_u8_values(surface, "calibratedMask")?;
    if uvs.len() != vertex_count * 2
        || colors.len() != vertex_count * 3
        || valid_mask.len() != vertex_count
        || calibrated_mask.len() != vertex_count
    {
        return Err("D3IMG surface attribute lengths are inconsistent".to_string());
    }
    let rows = surface
        .get("rows")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "D3IMG surface rows are invalid".to_string())?;
    let cols_per_camera = surface
        .get("colsPerCamera")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "D3IMG surface columns are invalid".to_string())?;
    let camera_count = surface
        .get("cameraCount")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "D3IMG surface camera count is invalid".to_string())?;
    let vertex_count = u32::try_from(vertex_count)
        .map_err(|_| "D3IMG surface vertex count is out of range".to_string())?;
    let index_count = u32::try_from(indices.len())
        .map_err(|_| "D3IMG surface index count is out of range".to_string())?;
    let mut output = Vec::with_capacity(
        40 + positions.len() * 4
            + uvs.len() * 4
            + colors.len() * 4
            + indices.len() * 4
            + valid_mask.len()
            + calibrated_mask.len(),
    );
    output.extend_from_slice(b"BSMESH01");
    for value in [
        1u32,
        vertex_count,
        index_count,
        0x02 | 0x04,
        rows,
        cols_per_camera,
        camera_count,
        0,
    ] {
        output.extend_from_slice(&value.to_le_bytes());
    }
    for values in [&positions, &uvs, &colors] {
        for value in values {
            output.extend_from_slice(&value.to_le_bytes());
        }
    }
    for value in indices {
        output.extend_from_slice(&value.to_le_bytes());
    }
    output.extend_from_slice(&valid_mask);
    output.extend_from_slice(&calibrated_mask);
    Ok(output)
}

fn d3img_to_bmp(bytes: &[u8]) -> Result<Vec<u8>, BkvImageError> {
    let header = parse_d3img_header(bytes)?;
    let header_size = usize::try_from(header.head_size)
        .map_err(|_| BkvImageError::InvalidFormat("invalid_d3img_header_size"))?;
    let width = u32::try_from(header.width)
        .map_err(|_| BkvImageError::InvalidFormat("invalid_d3img_width"))?;
    let height = u32::try_from(header.height)
        .map_err(|_| BkvImageError::InvalidFormat("invalid_d3img_height"))?;
    let pixel_count = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or(BkvImageError::InvalidFormat("d3img_pixel_count_overflow"))?;

    let mut minimum = f32::INFINITY;
    let mut maximum = f32::NEG_INFINITY;
    for index in 0..pixel_count {
        let offset = header_size + index * 4;
        let value = f32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]);
        if valid_d3img_depth(value) {
            minimum = minimum.min(value);
            maximum = maximum.max(value);
        }
    }
    if !minimum.is_finite() || !maximum.is_finite() {
        return Err(BkvImageError::InvalidFormat("d3img_has_no_valid_depth"));
    }
    let span = (maximum - minimum).max(f32::EPSILON);
    let row_bytes = usize::try_from(width)
        .ok()
        .and_then(|width| width.checked_mul(3))
        .ok_or(BkvImageError::InvalidFormat("bmp_row_overflow"))?;
    let row_stride = row_bytes
        .checked_add(3)
        .map(|value| value & !3)
        .ok_or(BkvImageError::InvalidFormat("bmp_row_overflow"))?;
    let bitmap_bytes = row_stride
        .checked_mul(height as usize)
        .ok_or(BkvImageError::InvalidFormat("bmp_size_overflow"))?;
    let file_size = 54usize
        .checked_add(bitmap_bytes)
        .ok_or(BkvImageError::InvalidFormat("bmp_size_overflow"))?;
    let file_size_u32 = u32::try_from(file_size)
        .map_err(|_| BkvImageError::InvalidFormat("bmp_size_out_of_range"))?;
    let bitmap_bytes_u32 = u32::try_from(bitmap_bytes)
        .map_err(|_| BkvImageError::InvalidFormat("bmp_size_out_of_range"))?;
    let mut output = vec![0_u8; file_size];
    output[0..2].copy_from_slice(b"BM");
    output[2..6].copy_from_slice(&file_size_u32.to_le_bytes());
    output[10..14].copy_from_slice(&54_u32.to_le_bytes());
    output[14..18].copy_from_slice(&40_u32.to_le_bytes());
    output[18..22].copy_from_slice(&width.to_le_bytes());
    output[22..26].copy_from_slice(&height.to_le_bytes());
    output[26..28].copy_from_slice(&1_u16.to_le_bytes());
    output[28..30].copy_from_slice(&24_u16.to_le_bytes());
    output[34..38].copy_from_slice(&bitmap_bytes_u32.to_le_bytes());
    output[38..42].copy_from_slice(&2_835_u32.to_le_bytes());
    output[42..46].copy_from_slice(&2_835_u32.to_le_bytes());

    let width_usize = width as usize;
    let height_usize = height as usize;
    for source_y in 0..height_usize {
        let target_y = height_usize - 1 - source_y;
        let target_row = 54 + target_y * row_stride;
        for x in 0..width_usize {
            let source_offset = header_size + (source_y * width_usize + x) * 4;
            let value = f32::from_le_bytes([
                bytes[source_offset],
                bytes[source_offset + 1],
                bytes[source_offset + 2],
                bytes[source_offset + 3],
            ]);
            let (red, green, blue) = if valid_d3img_depth(value) {
                depth_color(((value - minimum) / span).clamp(0.0, 1.0))
            } else {
                (0, 0, 0)
            };
            let target_offset = target_row + x * 3;
            output[target_offset] = blue;
            output[target_offset + 1] = green;
            output[target_offset + 2] = red;
        }
    }
    Ok(output)
}

fn latest_completed_record_id(snapshot: &Value) -> Option<&str> {
    snapshot
        .get("records")
        .and_then(Value::as_array)?
        .iter()
        .find(|record| record.get("status").and_then(Value::as_str) == Some("completed"))
        .and_then(|record| record.get("id"))
        .and_then(Value::as_str)
}

fn source_record_snapshot(
    snapshot: &Value,
    sequence: i64,
    database: &str,
) -> Result<Value, String> {
    let record_id = canonical_bkv_record_id(sequence);
    let record = snapshot
        .get("records")
        .and_then(Value::as_array)
        .and_then(|records| {
            records
                .iter()
                .find(|record| record.get("id").and_then(Value::as_str) == Some(record_id.as_str()))
        })
        .cloned()
        .ok_or_else(|| format!("BKV source record {record_id} is unavailable"))?;
    let inspection = snapshot
        .get("inspections")
        .and_then(Value::as_array)
        .and_then(|inspections| {
            inspections.iter().find(|inspection| {
                inspection.get("inspectionId").and_then(Value::as_str) == Some(record_id.as_str())
            })
        })
        .cloned()
        .ok_or_else(|| format!("BKV source inspection {record_id} is unavailable"))?;
    Ok(json!({
        "schema": "steel.bkv-mysql-record-snapshot.v1",
        "source": "bkv-online-mysql",
        "database": database,
        "recordId": record_id,
        "legacySeqNo": sequence,
        "record": record,
        "inspection": inspection,
        "defectTypes": snapshot.get("defectTypes").cloned().unwrap_or_else(|| json!([])),
        "sourceSync": snapshot.get("sync").cloned().unwrap_or(Value::Null),
        "exportedAtMs": current_time_millis()
    }))
}

fn depth_color(value: f32) -> (u8, u8, u8) {
    fn channel(value: f32) -> u8 {
        (value.clamp(0.0, 1.0) * 255.0).round() as u8
    }
    let red = 1.5 - (4.0 * value - 3.0).abs();
    let green = 1.5 - (4.0 * value - 2.0).abs();
    let blue = 1.5 - (4.0 * value - 1.0).abs();
    (channel(red), channel(green), channel(blue))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d3img_fixture(width: i32, height: i32, depth: &[f32]) -> Vec<u8> {
        assert_eq!(depth.len(), usize::try_from(width * height).unwrap());
        let mut bytes = vec![0_u8; BKV_D3_HEADER_BYTES + depth.len() * 4];
        bytes[..6].copy_from_slice(b"3DImg\0");
        bytes[6..8].copy_from_slice(&(BKV_D3_HEADER_BYTES as i16).to_le_bytes());
        bytes[8..12].copy_from_slice(&18_000_i32.to_le_bytes());
        bytes[12..16].copy_from_slice(&42_i32.to_le_bytes());
        bytes[16..20].copy_from_slice(&95_323_i32.to_le_bytes());
        bytes[20..24].copy_from_slice(&width.to_le_bytes());
        bytes[24..28].copy_from_slice(&height.to_le_bytes());
        bytes[28..32].copy_from_slice(&0.2782926_f32.to_le_bytes());
        bytes[32..36].copy_from_slice(&992_i32.to_le_bytes());
        bytes[36..40].copy_from_slice(&(992_i32 + width).to_le_bytes());
        bytes[40..44].copy_from_slice(&95_323_i32.to_le_bytes());
        bytes[44..48].copy_from_slice(&95_323_i32.to_le_bytes());
        bytes[48..52].copy_from_slice(&992_i32.to_le_bytes());
        bytes[52] = 3;
        bytes[53] = 1;
        bytes[54] = 4;
        for (index, value) in depth.iter().enumerate() {
            let offset = BKV_D3_HEADER_BYTES + index * 4;
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        bytes
    }

    fn invalid_d3img_reason(result: Result<D3ImgHeader, BkvImageError>) -> &'static str {
        match result {
            Err(BkvImageError::InvalidFormat(reason)) => reason,
            _ => panic!("expected invalid d3img format"),
        }
    }

    fn sample_record() -> BkvRecord {
        BkvRecord {
            seq_no: 42,
            steel_id: "PIPE-001".to_string(),
            steel_type: "29Mn5".to_string(),
            received_diameter_mm: 140.0,
            received_length_mm: 11_500.0,
            measured_diameter_mm: 0.0,
            measured_length_samples: 10_000.0,
            length_scale_mm: 1.0,
            defect_count: 1,
            detected_at: "2026-07-24 15:01:02".to_string(),
            wall_thickness_mm: 8.0,
            complete: true,
        }
    }

    #[test]
    fn record_sequence_uses_a_bare_canonical_id() {
        assert_eq!(display_material_id(&sample_record()), "PIPE-001 / 42");
        assert_eq!(time_label("2026-07-24 15:01:02"), "15:01");
        assert_eq!(canonical_bkv_record_id(42), "42");
        assert_eq!(parse_bkv_record_sequence("42"), Ok(42));
        assert_eq!(parse_bkv_record_sequence("bkv-42"), Ok(42));
    }

    #[test]
    fn automatic_processing_skips_the_incomplete_latest_record() {
        let snapshot = json!({
            "records": [
                {"id": "44", "status": "detecting"},
                {"id": "43", "status": "completed"},
                {"id": "42", "status": "completed"}
            ]
        });
        assert_eq!(latest_completed_record_id(&snapshot), Some("43"));
    }

    #[test]
    fn source_record_snapshot_keeps_mysql_record_and_defects_together() {
        let snapshot = json!({
            "records": [{"id": "43", "status": "completed", "defectCount": 1}],
            "inspections": [{
                "inspectionId": "43",
                "plate": {"plateNo": "PIPE-43"},
                "defects": [{"id": 7}]
            }],
            "defectTypes": [{"id": "bkv-class-13"}],
            "sync": {"refreshedAtMs": 123}
        });
        let exported = source_record_snapshot(&snapshot, 43, "ncdtube").expect("source snapshot");
        assert_eq!(exported["record"]["id"], json!("43"));
        assert_eq!(exported["inspection"]["defects"][0]["id"], json!(7));
        assert_eq!(exported["database"], json!("ncdtube"));
    }

    #[test]
    fn image_cache_hits_and_invalidates_when_the_source_revision_changes() {
        let mut cache = BkvImageCache::default();
        let key = BkvImageCacheKey {
            camera: 1,
            sequence: 19_083_25,
            image_index: 0,
            kind: "depth",
        };
        let bytes = Arc::new(vec![1u8, 2, 3, 4]);
        cache.insert(key.clone(), 100, 200, Arc::clone(&bytes));

        let cached = cache.get(&key, 100, 200).expect("cache hit");
        assert!(Arc::ptr_eq(&cached, &bytes));
        assert_eq!(cache.hits, 1);
        assert_eq!(cache.misses, 0);
        assert_eq!(cache.bytes, 4);

        assert!(cache.get(&key, 101, 200).is_none());
        assert_eq!(cache.entries.len(), 0);
        assert_eq!(cache.bytes, 0);
        assert_eq!(cache.misses, 1);
    }

    #[test]
    fn defect_mapping_stays_inside_the_unfolded_surface() {
        let record = sample_record();
        let defect = BkvDefect {
            id: 7,
            camera_no: 6,
            defect_no: 9,
            seq_no: 42,
            class_no: 13,
            grade: 3,
            confidence: 81.0,
            image_index: 4,
            left: 940.0,
            right: 950.0,
            top: 1_000.0,
            bottom: 1_100.0,
            depth_micrometers: -1_126.0,
        };
        let value = defect_value(&defect, &record, None);
        assert!(value["xRatio"].as_f64().unwrap() >= 0.0);
        assert!(value["xRatio"].as_f64().unwrap() <= 1.0);
        assert!(value["circumferenceRatio"].as_f64().unwrap() < 1.0);
        assert_eq!(value["depthMm"], json!(-1.126));
        assert_eq!(value["synthetic"], json!(false));
        assert_eq!(
            value["previewImageUrl"],
            json!("/api/bkv-online/image?camera=6&seq=42&index=4&kind=2d")
        );
    }

    #[test]
    fn d3img_header_matches_the_legacy_dat3dheader_layout() {
        let bytes = d3img_fixture(3, 2, &[-1_000_000.0_f32, 10.0, 20.0, 30.0, 40.0, 50.0]);
        let header = parse_d3img_header(&bytes).expect("parsed header");
        assert_eq!(header.tag, *b"3DImg\0");
        assert_eq!(header.head_size, 84);
        assert_eq!(header.steel_no, 18_000);
        assert_eq!(header.image_index, 42);
        assert_eq!(header.image_sequence, 95_323);
        assert_eq!(header.width, 3);
        assert_eq!(header.height, 2);
        assert!((header.scale_x - 0.2782926).abs() < f32::EPSILON);
        assert_eq!(header.left, 992);
        assert_eq!(header.right, 995);
        assert_eq!(header.start_length, 95_323);
        assert_eq!(header.end_length, 95_323);
        assert_eq!(header.start_position, 992);
        assert_eq!(header.camera_number, 3);
        assert_eq!(header.data_type, 1);
        assert_eq!(header.pixel_size, 4);
        assert_eq!(header.reserve, [0; 29]);
    }

    #[test]
    fn d3img_header_rejects_invalid_contract_and_payload_lengths() {
        let valid = d3img_fixture(3, 2, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);

        assert_eq!(
            invalid_d3img_reason(parse_d3img_header(b"3DImg\0")),
            "invalid_d3img_header"
        );

        let mut invalid_magic = valid.clone();
        invalid_magic[0] = b'X';
        assert_eq!(
            invalid_d3img_reason(parse_d3img_header(&invalid_magic)),
            "invalid_d3img_header"
        );

        let mut invalid_header_size = valid.clone();
        invalid_header_size[6..8].copy_from_slice(&82_i16.to_le_bytes());
        assert_eq!(
            invalid_d3img_reason(parse_d3img_header(&invalid_header_size)),
            "invalid_d3img_header_size"
        );

        let mut invalid_width = valid.clone();
        invalid_width[20..24].copy_from_slice(&(-3_i32).to_le_bytes());
        assert_eq!(
            invalid_d3img_reason(parse_d3img_header(&invalid_width)),
            "d3img_dimensions_out_of_range"
        );

        let mut oversized_width = valid.clone();
        oversized_width[20..24].copy_from_slice(&16_385_i32.to_le_bytes());
        assert_eq!(
            invalid_d3img_reason(parse_d3img_header(&oversized_width)),
            "d3img_dimensions_out_of_range"
        );

        let mut invalid_pixel_size = valid.clone();
        invalid_pixel_size[54] = 2;
        assert_eq!(
            invalid_d3img_reason(parse_d3img_header(&invalid_pixel_size)),
            "invalid_d3img_pixel_size"
        );

        let mut truncated = valid.clone();
        truncated.pop();
        assert_eq!(
            invalid_d3img_reason(parse_d3img_header(&truncated)),
            "d3img_payload_truncated"
        );

        let mut trailing = valid;
        trailing.push(0);
        assert_eq!(
            invalid_d3img_reason(parse_d3img_header(&trailing)),
            "d3img_payload_trailing"
        );
    }

    #[test]
    fn d3img_float_depth_is_converted_to_a_bounded_bitmap() {
        let bytes = d3img_fixture(3, 2, &[-1_000_000.0_f32, -10.0, -5.0, 0.0, 5.0, 10.0]);
        let bitmap = d3img_to_bmp(&bytes).expect("converted bitmap");
        assert_eq!(&bitmap[..2], b"BM");
        assert_eq!(u32::from_le_bytes(bitmap[18..22].try_into().unwrap()), 3);
        assert_eq!(u32::from_le_bytes(bitmap[22..26].try_into().unwrap()), 2);
        assert_eq!(bitmap.len(), 78);
    }

    #[test]
    fn d3img_frames_build_and_persist_a_record_bound_surface_mesh() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "steel-bkv-depth-surface-{}-{stamp}",
            std::process::id()
        ));
        let mut camera_inputs = Vec::new();
        for camera_id in 1..=2u32 {
            let directory = root
                .join(format!("CamImageSource{camera_id}"))
                .join("18000")
                .join("3D");
            fs::create_dir_all(&directory).expect("depth fixture directory");
            let path = directory.join("0000.d3img");
            let mut depth = (0..16)
                .map(|index| camera_id as f32 * 100.0 + index as f32)
                .collect::<Vec<_>>();
            if camera_id == 1 {
                depth[0] = BKV_D3_INVALID_DEPTH;
            }
            fs::write(&path, d3img_fixture(4, 4, &depth)).expect("depth fixture");
            camera_inputs.push((camera_id, vec![(0, path)], directory));
        }

        let (surface, source_frame_count) =
            build_d3img_surface(18_000, &camera_inputs).expect("surface mesh");
        let expected_points = BKV_DEPTH_SURFACE_ROWS * BKV_DEPTH_SURFACE_COLS_PER_CAMERA * 2;
        assert_eq!(surface["schema"], "steel.bkv-depth-surface.v1");
        assert_eq!(surface["recordId"], "18000");
        assert_eq!(surface["coordinateUnit"], "legacy-unknown");
        assert_eq!(surface["cameraCount"], 2);
        assert_eq!(source_frame_count, 2);
        assert_eq!(
            surface["positions"].as_array().map(Vec::len),
            Some(expected_points * 3)
        );
        assert_eq!(
            surface["validMask"].as_array().map(Vec::len),
            Some(expected_points)
        );
        assert!(surface["validMask"]
            .as_array()
            .is_some_and(|mask| mask.iter().any(|value| value == 0)));
        assert!(surface["indices"]
            .as_array()
            .is_some_and(|indices| !indices.is_empty()));

        let output = root.join("surface-mesh.json");
        write_json_atomic(&output, &surface).expect("persisted surface");
        let stored: Value = serde_json::from_slice(&fs::read(&output).expect("surface bytes"))
            .expect("surface JSON");
        assert_eq!(stored["schema"], "steel.bkv-depth-surface.v1");
        assert_eq!(stored["sourceFrameCount"], 2);
        let parameters = d3img_reconstruction_parameters(&stored);
        assert_eq!(
            parameters["schema"],
            "steel.bkv-depth-reconstruction-parameters.v1"
        );
        assert_eq!(parameters["sampling"]["rows"], BKV_DEPTH_SURFACE_ROWS);
        assert_eq!(
            parameters["sampling"]["colsPerCamera"],
            BKV_DEPTH_SURFACE_COLS_PER_CAMERA
        );
        assert_eq!(
            parameters["reconstruction"]["coordinateUnit"],
            "legacy-unknown"
        );
        write_json_atomic(&root.join("reconstruction-parameters.json"), &parameters)
            .expect("persisted reconstruction parameters");
        let binary = encode_d3img_surface_bsmesh(&stored).expect("binary surface");
        assert_eq!(&binary[..8], b"BSMESH01");
        assert_eq!(u32::from_le_bytes(binary[8..12].try_into().unwrap()), 1);
        assert_eq!(
            u32::from_le_bytes(binary[12..16].try_into().unwrap()) as usize,
            expected_points
        );
        assert!(binary.len() < serde_json::to_vec(&stored).unwrap().len());
        write_bytes_atomic(&root.join("surface-mesh.bsmesh"), &binary)
            .expect("persisted binary surface");
        fs::remove_dir_all(&root).expect("fixture cleanup");
    }

    #[test]
    fn d3img_multi_frame_row_mapping_distributes_samples_across_frames() {
        // 验证 build_d3img_surface 的多帧行映射逻辑：当单个相机由多个 D3IMG
        // 帧文件拼接而成时，目标行应均匀分布在所有帧上，且每个帧都被读取。
        // 这直接覆盖 frame_start_rows 预计算 + 反向查找的重写逻辑。
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "steel-bkv-depth-surface-multiframe-{}-{stamp}",
            std::process::id()
        ));
        let directory = root.join("CamImageSource1").join("18000").join("3D");
        fs::create_dir_all(&directory).expect("depth fixture directory");

        // 构造 1 个相机，由 3 个 D3IMG 帧文件拼接。为每帧填入可区分的深度值，
        // 便于验证采样确实跨越了多个帧（帧0=100.x, 帧1=200.x, 帧2=300.x）。
        let frame_width = BKV_DEPTH_SURFACE_COLS_PER_CAMERA as i32;
        let frame_height = 4i32;
        let mut frame_candidates = Vec::new();
        for frame_no in 0..3u32 {
            let path = directory.join(format!("{frame_no:04}.d3img"));
            let base = (frame_no as f32 + 1.0) * 100.0;
            let depth = (0..frame_width * frame_height)
                .map(|index| base + index as f32)
                .collect::<Vec<_>>();
            fs::write(&path, d3img_fixture(frame_width, frame_height, &depth))
                .expect("depth fixture");
            frame_candidates.push((frame_no, path));
        }
        // 单个相机 + 多帧：验证行映射在帧间正确分布
        let camera_inputs = vec![(1u32, frame_candidates, directory.clone())];

        let (surface, source_frame_count) =
            build_d3img_surface(18_000, &camera_inputs).expect("surface mesh");

        // 三个帧都应被计入
        assert_eq!(source_frame_count, 3);
        assert_eq!(surface["cameraCount"], 1);

        // 所有目标行应成功映射，并产生预期的点数。
        let expected_points = BKV_DEPTH_SURFACE_ROWS * BKV_DEPTH_SURFACE_COLS_PER_CAMERA;
        assert_eq!(
            surface["positions"].as_array().map(Vec::len),
            Some(expected_points * 3)
        );

        // 关键校验：所有目标行都成功映射（未触发 "row mapping failed" 错误），
        // 且 validMask 中有效样本占绝大多数——证明三个帧都被读取并采样，
        // 而不是只采样了某一帧。
        let valid_count = surface["validMask"]
            .as_array()
            .map(|mask| mask.iter().filter(|v| v != &0).count())
            .unwrap_or(0);
        assert!(
            valid_count > expected_points / 2,
            "多帧采样后有效点过少：{valid_count}/{expected_points}"
        );

        fs::remove_dir_all(&root).expect("fixture cleanup");
    }
}
