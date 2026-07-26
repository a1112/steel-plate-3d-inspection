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
use std::io::Write;
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
const BKV_D3_HEADER_MIN_BYTES: usize = 84;
const BKV_IMAGE_MAX_BYTES: u64 = 64 * 1024 * 1024;

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
    inspection_world_build_lock: Arc<Mutex<()>>,
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
    run_dir: Option<PathBuf>,
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
    pub bytes: Vec<u8>,
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
    let normalized = record_id.trim().strip_prefix("bkv-").unwrap_or(record_id.trim());
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
                bounded_env_usize(
                    "STEEL_BKV_RECORD_LIMIT",
                    DEFAULT_RECORD_LIMIT,
                    1,
                    2_000,
                )
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
            inspection_world_build_lock: Arc::new(Mutex::new(())),
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
                    Ok(_) => {
                        let handle = Handle::current();
                        source.spawn_latest_processing(&handle);
                    }
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
            "latestRecord": latest_record,
            "refreshIntervalMs": self.refresh_interval.as_millis(),
            "refreshAttempts": state.attempts,
            "refreshSuccesses": state.successes,
            "lastSuccessAtMs": state.refreshed_at_ms,
            "lastError": state.last_error.as_ref().map(|_| "refresh_failed")
        })
        .to_string()
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
        self.load_inspection_world(record_id).map(|_| ())
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
        let processed = self.load_inspection_world(record_id)?;
        Ok(json!({
            "schema": "steel.inspection-world.meta.v1",
            "provider": "online",
            "recordId": canonical_bkv_record_id(sequence),
            "legacySeqNo": sequence,
            "sourceFrameCount": processed.source_frame_count,
            "world": processed.world,
            "processing": {
                "processor": self.algorithm.processor,
                "revision": processed.revision,
                "outputPath": processed.run_dir.as_ref().map(|path| path.display().to_string()),
            }
        }))
    }

    pub fn inspection_world_defects(&self, record_id: &str) -> Result<Value, String> {
        let sequence = parse_bkv_record_sequence(record_id)?;
        let canonical_id = canonical_bkv_record_id(sequence);
        let processed = self.load_inspection_world(&canonical_id)?;
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
        let processed = self.load_inspection_world(&canonical_id)?;
        let extension = match request.format {
            inspection_world::TileFormat::Jpeg => "jpg",
            inspection_world::TileFormat::Png => "png",
        };
        let cached_path = processed.run_dir.as_ref().map(|run_dir| {
            run_dir
                .join("tiles")
                .join(format!("camera{}", request.camera_id))
                .join(format!("level{}", request.level))
                .join(format!("{}_{}.{}", request.tile_x, request.tile_y, extension))
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
            |camera_id, image_index| {
                Ok(processed.frames.get(&(camera_id, image_index)).cloned())
            },
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

    fn load_inspection_world(&self, record_id: &str) -> Result<Arc<BkvOnlineInspectionWorld>, String> {
        let sequence = parse_bkv_record_sequence(record_id)?;
        if let Some(cached) = self
            .inspection_world_cache
            .lock()
            .map_err(|_| "BKV inspection-world cache lock poisoned".to_string())?
            .get(&sequence)
            .filter(|cached| cached.checked_at.elapsed() < Duration::from_secs(30))
            .cloned()
        {
            return Ok(cached);
        }
        let _build_guard = self
            .inspection_world_build_lock
            .lock()
            .map_err(|_| "BKV inspection-world build lock poisoned".to_string())?;
        let total_started = Instant::now();
        let discover_started = Instant::now();
        let mut revision_hasher = Sha256::new();
        let mut frames = HashMap::new();
        let mut camera_inputs = Vec::new();
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
                let current = image::image_dimensions(&path)
                    .map_err(|error| format!("{}: {error}", path.display()))?;
                if current != dimensions {
                    return Err(format!(
                        "camera {camera_id} frame dimensions are inconsistent"
                    ));
                }
                let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                    .map(|value| value.as_millis())
                    .unwrap_or_default();
                revision_hasher.update(camera_id.to_le_bytes());
                revision_hasher.update(frame.to_le_bytes());
                revision_hasher.update(metadata.len().to_le_bytes());
                revision_hasher.update(modified.to_le_bytes());
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
            let refreshed = Arc::new(BkvOnlineInspectionWorld {
                revision: cached.revision.clone(),
                checked_at: Instant::now(),
                world: cached.world.clone(),
                frames: cached.frames.clone(),
                source_frame_count: cached.source_frame_count,
                run_dir: cached.run_dir.clone(),
            });
            self.inspection_world_cache
                .lock()
                .map_err(|_| "BKV inspection-world cache lock poisoned".to_string())?
                .insert(sequence, Arc::clone(&refreshed));
            return Ok(refreshed);
        }
        let discover_ms = discover_started.elapsed().as_millis();
        let align_started = Instant::now();
        let mut specs = Vec::with_capacity(camera_inputs.len());
        let mut source_cameras = Vec::with_capacity(camera_inputs.len());
        for (spec, alignment_frames, image_dir) in camera_inputs {
            let alignment =
                inspection_world::detect_camera_head(&alignment_frames).map_err(|error| error.to_string())?;
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
        let run_dir = self.persist_processed_world(
            sequence,
            &revision,
            &world,
            &source_cameras,
            source_frame_count,
            discover_ms,
            align_ms,
            total_started.elapsed().as_millis(),
        )?;
        let processed = Arc::new(BkvOnlineInspectionWorld {
            revision,
            checked_at: Instant::now(),
            world,
            frames,
            source_frame_count,
            run_dir,
        });
        self.inspection_world_cache
            .lock()
            .map_err(|_| "BKV inspection-world cache lock poisoned".to_string())?
            .insert(sequence, Arc::clone(&processed));
        Ok(processed)
    }

    fn persist_processed_world(
        &self,
        sequence: i64,
        revision: &str,
        world: &InspectionWorld,
        cameras: &[Value],
        source_frame_count: usize,
        discover_ms: u128,
        align_ms: u128,
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
            "algorithmConfig": self.algorithm.config_path,
            "sourceRecord": self.algorithm.source_data.enabled.then_some("source-record.json"),
            "createdAtMs": current_time_millis(),
        });
        write_json_atomic(&run_dir.join("manifest.json"), &manifest)?;
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
                let refresh_count = self
                    .refresh_state
                    .read()
                    .await
                    .successes
                    .saturating_add(1);
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
                    let error = DbErr::Custom(format!(
                        "BKV MySQL source-data persistence failed: {error}"
                    ));
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
        match kind {
            "2d" | "intensity" => {
                let path = root
                    .join(sequence.to_string())
                    .join("2D")
                    .join(format!("{file_name}.bmp"));
                Ok(BkvImage {
                    content_type: "image/bmp",
                    bytes: read_bounded_file(&path)?,
                })
            }
            "3d" | "depth" => {
                let path = root
                    .join(sequence.to_string())
                    .join("3D")
                    .join(format!("{file_name}.d3img"));
                let raw = read_bounded_file(&path)?;
                Ok(BkvImage {
                    content_type: "image/bmp",
                    bytes: d3img_to_bmp(&raw)?,
                })
            }
            _ => Err(BkvImageError::InvalidRequest("unsupported_image_kind")),
        }
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

fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    let value = bytes.get(offset..offset + 2)?;
    Some(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    let value = bytes.get(offset..offset + 4)?;
    Some(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn d3img_to_bmp(bytes: &[u8]) -> Result<Vec<u8>, BkvImageError> {
    if bytes.len() < BKV_D3_HEADER_MIN_BYTES || bytes.get(..6) != Some(b"3DImg\0") {
        return Err(BkvImageError::InvalidFormat("invalid_d3img_header"));
    }
    let header_size = read_u16_le(bytes, 6)
        .map(usize::from)
        .ok_or(BkvImageError::InvalidFormat("invalid_d3img_header_size"))?;
    let width =
        read_u32_le(bytes, 20).ok_or(BkvImageError::InvalidFormat("invalid_d3img_width"))?;
    let height =
        read_u32_le(bytes, 24).ok_or(BkvImageError::InvalidFormat("invalid_d3img_height"))?;
    if header_size < BKV_D3_HEADER_MIN_BYTES
        || width == 0
        || height == 0
        || width > 16_384
        || height > 65_536
    {
        return Err(BkvImageError::InvalidFormat(
            "d3img_dimensions_out_of_range",
        ));
    }
    let pixel_count = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or(BkvImageError::InvalidFormat("d3img_pixel_count_overflow"))?;
    let payload_bytes = pixel_count
        .checked_mul(4)
        .and_then(|value| header_size.checked_add(value))
        .ok_or(BkvImageError::InvalidFormat("d3img_payload_overflow"))?;
    if payload_bytes > bytes.len() {
        return Err(BkvImageError::InvalidFormat("d3img_payload_truncated"));
    }

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
        if value.is_finite() && value > -999_999.0 {
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
            let (red, green, blue) = if value.is_finite() && value > -999_999.0 {
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
        .find(|record| {
            record.get("status").and_then(Value::as_str) == Some("completed")
        })
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
            records.iter().find(|record| {
                record.get("id").and_then(Value::as_str) == Some(record_id.as_str())
            })
        })
        .cloned()
        .ok_or_else(|| format!("BKV source record {record_id} is unavailable"))?;
    let inspection = snapshot
        .get("inspections")
        .and_then(Value::as_array)
        .and_then(|inspections| {
            inspections.iter().find(|inspection| {
                inspection.get("inspectionId").and_then(Value::as_str)
                    == Some(record_id.as_str())
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
    fn d3img_float_depth_is_converted_to_a_bounded_bitmap() {
        let mut bytes = vec![0_u8; 84 + 4 * 4];
        bytes[..6].copy_from_slice(b"3DImg\0");
        bytes[6..8].copy_from_slice(&84_u16.to_le_bytes());
        bytes[20..24].copy_from_slice(&2_u32.to_le_bytes());
        bytes[24..28].copy_from_slice(&2_u32.to_le_bytes());
        for (index, value) in [-1_000_000.0_f32, -10.0, -5.0, 0.0].into_iter().enumerate() {
            let offset = 84 + index * 4;
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        let bitmap = d3img_to_bmp(&bytes).expect("converted bitmap");
        assert_eq!(&bitmap[..2], b"BM");
        assert_eq!(read_u32_le(&bitmap, 18), Some(2));
        assert_eq!(read_u32_le(&bitmap, 22), Some(2));
        assert_eq!(bitmap.len(), 70);
    }
}
