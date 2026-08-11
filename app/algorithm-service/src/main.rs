use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, QueryResult,
    Statement,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use steel_inspection_result_contract::{
    PublishInput, ResultArtifact, ResultDefect, ResultMaterial, ResultPublisher, UnifiedResult,
    RESULT_SCHEMA,
};

const DEFAULT_PORT: u16 = 4875;

#[derive(Default)]
struct Counters {
    scanned: u64,
    published: u64,
    skipped: u64,
    failed: u64,
    last_error: Option<String>,
    last_published_at: Option<String>,
}

struct State {
    publisher: ResultPublisher,
    input_roots: Vec<PathBuf>,
    counters: Mutex<Counters>,
    scan_in_progress: AtomicBool,
    shutdown: AtomicBool,
    scan_interval: Duration,
    bkv_refresh_interval: Duration,
    processor: String,
    algorithm_core: Option<PathBuf>,
    mysql_runtime: Option<tokio::runtime::Runtime>,
    bkv: Option<BkvAdapter>,
    history_reconstruction: Mutex<HashSet<String>>,
    processed_inputs: Mutex<HashMap<PathBuf, String>>,
}

struct BkvAdapter {
    connection: DatabaseConnection,
    database: String,
    image_roots: Vec<PathBuf>,
    record_limit: usize,
    work_root: PathBuf,
}

fn main() -> std::io::Result<()> {
    let port = env::var("STEEL_ALGORITHM_SERVICE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    let result_root = env::var("STEEL_RESULT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root().join("target/data/inspection-results"));
    let publisher = ResultPublisher::open(&result_root).map_err(io_error)?;
    let input_roots = env::var("STEEL_ALGORITHM_INPUT_ROOTS")
        .unwrap_or_default()
        .split(';')
        .filter(|v| !v.trim().is_empty())
        .map(|v| PathBuf::from(v.trim()))
        .filter(|v| v.is_dir())
        .collect::<Vec<_>>();
    let mysql_runtime = tokio::runtime::Runtime::new().map_err(io_error)?;
    let bkv = mysql_runtime
        .block_on(BkvAdapter::from_env(result_root.join("staging")))
        .map_err(io_error)?;
    let state = Arc::new(State {
        publisher,
        input_roots,
        counters: Mutex::new(Counters::default()),
        scan_in_progress: AtomicBool::new(false),
        shutdown: AtomicBool::new(false),
        scan_interval: Duration::from_millis(
            env::var("STEEL_ALGORITHM_SCAN_INTERVAL_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(2_000),
        ),
        bkv_refresh_interval: Duration::from_millis(
            env::var("STEEL_BKV_REFRESH_INTERVAL_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30_000),
        ),
        processor: env::var("STEEL_ALGORITHM_PROCESSOR")
            .unwrap_or_else(|_| "standard-record-import-v1".into()),
        algorithm_core: env::var("STEEL_BAR_SURFACE_CORE_EXE")
            .ok()
            .map(PathBuf::from)
            .filter(|p| p.is_file()),
        mysql_runtime: bkv.as_ref().map(|_| mysql_runtime),
        bkv,
        history_reconstruction: Mutex::new(HashSet::new()),
        processed_inputs: Mutex::new(HashMap::new()),
    });
    // Keep the runtime alive only when the adapter connected successfully.
    // When no BKV environment is configured, local capture/standard-record adapters remain active.
    let worker_state = Arc::clone(&state);
    thread::Builder::new()
        .name("algorithm-source-adapter".into())
        .spawn(move || source_adapter_loop(worker_state))
        .map_err(io_error)?;
    let signal_state = Arc::clone(&state);
    ctrlc::set_handler(move || signal_state.shutdown.store(true, Ordering::Release))
        .map_err(io_error)?;
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;
    println!("steel algorithm service listening on http://127.0.0.1:{port}");
    while !state.shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let state = Arc::clone(&state);
                thread::spawn(move || handle_client(stream, state));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5))
            }
            Err(error) => eprintln!("algorithm listener error: {error}"),
        }
    }
    Ok(())
}

fn io_error(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, error.to_string())
}

fn workspace_root() -> PathBuf {
    env::var("STEEL_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

impl BkvAdapter {
    async fn from_env(work_root: PathBuf) -> Result<Option<Self>, String> {
        let host = match env::var("STEEL_BKV_MYSQL_HOST")
            .ok()
            .filter(|v| !v.trim().is_empty())
        {
            Some(value) => value,
            None => return Ok(None),
        };
        let user = env::var("STEEL_BKV_MYSQL_USER")
            .map_err(|_| "STEEL_BKV_MYSQL_USER missing".to_string())?;
        let password = env::var("STEEL_BKV_MYSQL_PASSWORD")
            .map_err(|_| "STEEL_BKV_MYSQL_PASSWORD missing".to_string())?;
        let database = env::var("STEEL_BKV_MYSQL_DATABASE").unwrap_or_else(|_| "ncdtube".into());
        let port = env::var("STEEL_BKV_MYSQL_PORT").unwrap_or_else(|_| "3306".into());
        let url = format!(
            "mysql://{}:{}@{}:{}/{}?ssl-mode=disabled",
            url_encode(&user),
            url_encode(&password),
            host,
            port,
            database
        );
        let mut options = ConnectOptions::new(url);
        options.connect_timeout(Duration::from_millis(
            env::var("STEEL_BKV_CONNECT_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(5_000),
        ));
        options.max_connections(4).min_connections(1);
        let connection = Database::connect(options)
            .await
            .map_err(|e| e.to_string())?;
        connection
            .query_one(Statement::from_string(
                DbBackend::MySql,
                format!("SELECT SeqNo FROM `{database}`.`record` ORDER BY ID DESC LIMIT 1"),
            ))
            .await
            .map_err(|e| e.to_string())?;
        let mut roots = Vec::new();
        let base = env::var("STEEL_BKV_IMAGE_ROOT")
            .ok()
            .filter(|v| !v.trim().is_empty());
        for index in 1..=6 {
            let key = format!("STEEL_BKV_IMAGE_ROOT_{index}");
            let root = env::var(&key)
                .ok()
                .filter(|v| !v.trim().is_empty())
                .or_else(|| {
                    base.as_ref().map(|base| {
                        PathBuf::from(base)
                            .join(format!("CamImageSource{index}"))
                            .to_string_lossy()
                            .into_owned()
                    })
                })
                .or_else(|| Some(format!(r"\\{}\CamImageSource{}", host, index)));
            if let Some(root) = root {
                roots.push(PathBuf::from(root));
            }
        }
        if roots.is_empty() {
            return Err("STEEL_BKV_IMAGE_ROOT or per-camera roots missing".into());
        }
        fs::create_dir_all(&work_root).map_err(|e| e.to_string())?;
        Ok(Some(Self {
            connection,
            database,
            image_roots: roots,
            record_limit: env::var("STEEL_BKV_RECORD_LIMIT")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(500)
                .clamp(1, 2_000),
            work_root,
        }))
    }

    async fn refresh(&self, publisher: &ResultPublisher, processor: &str) -> Result<(), String> {
        let rows = self.connection.query_all(Statement::from_string(DbBackend::MySql, format!("SELECT CAST(SeqNo AS CHAR) AS seq_no, COALESCE(SteelID, '') AS steel_id, COALESCE(SteelType, '') AS steel_type, CAST(COALESCE(RcvLen, 0) AS CHAR) AS length_mm, CAST(COALESCE(Radius, 0) AS CHAR) AS diameter_mm, CAST(COALESCE(WallThick, 0) AS CHAR) AS wall_mm, COALESCE(DATE_FORMAT(DefectTime, '%Y-%m-%d %H:%i:%s'), '') AS detected_at, CAST(COALESCE(DefectNum, 0) AS CHAR) AS defect_count, CASE WHEN Radius IS NULL OR Len IS NULL THEN '0' ELSE '1' END AS complete FROM `{}`.`record` ORDER BY ID DESC LIMIT {}", self.database, self.record_limit))).await.map_err(|e| e.to_string())?;
        for row in rows.iter().take(self.record_limit) {
            if let Err(error) = self.publish_record(publisher, processor, row).await {
                eprintln!("BKV record publish failed: {error}");
            }
        }
        Ok(())
    }

    async fn publish_record(
        &self,
        publisher: &ResultPublisher,
        processor: &str,
        row: &QueryResult,
    ) -> Result<(), String> {
        let seq = row_string(row, "seq_no")?
            .parse::<i64>()
            .map_err(|_| "BKV SeqNo is invalid".to_string())?;
        if seq <= 0 {
            return Ok(());
        }
        let inspection_id = seq.to_string();
        // Unified results are the durable source of truth.  Once a complete
        // result has been published, a BKV refresh must not copy the same
        // network-share frames again just because the tile cache was cleared.
        // Set STEEL_BKV_FORCE_REBUILD=1 only for an intentional raw-frame
        // re-materialization of already published records.
        let force_rebuild = env::var("STEEL_BKV_FORCE_REBUILD").as_deref() == Ok("1");
        if !force_rebuild && published_result_is_complete(publisher, &inspection_id) {
            return Ok(());
        }
        let record_source = self.work_root.join(&inspection_id);
        if record_source.exists() {
            fs::remove_dir_all(&record_source).map_err(|e| e.to_string())?;
        }
        fs::create_dir_all(&record_source).map_err(|e| e.to_string())?;
        let mut artifacts = Vec::new();
        let mut source_digest = Sha256::new();
        for (camera_index, root) in self.image_roots.iter().enumerate() {
            let source_dir = root.join(seq.to_string()).join("2D");
            let target_dir = record_source.join(format!("C{}", camera_index + 1));
            let Ok(entries) = fs::read_dir(source_dir) else {
                continue;
            };
            let mut files = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.extension()
                        .and_then(|v| v.to_str())
                        .is_some_and(|extension| {
                            extension.eq_ignore_ascii_case("bmp")
                                || extension.eq_ignore_ascii_case("jpg")
                                || extension.eq_ignore_ascii_case("jpeg")
                        })
                })
                .collect::<Vec<_>>();
            files.sort();
            for (index, source) in files.into_iter().take(256).enumerate() {
                let Some(name) = source.file_name() else {
                    continue;
                };
                fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;
                let target = target_dir.join(name);
                fs::copy(&source, &target).map_err(|e| e.to_string())?;
                let (size, hash) = steel_inspection_result_contract::file_digest(&target)
                    .map_err(|e| e.to_string())?;
                source_digest.update(hash.as_bytes());
                let mime_type = match source
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(|value| value.to_ascii_lowercase())
                    .as_deref()
                {
                    Some("jpg") | Some("jpeg") => "image/jpeg",
                    _ => "image/bmp",
                };
                artifacts.push(ResultArtifact {
                    id: format!("{inspection_id}-C{}-{index:06}-intensity", camera_index + 1),
                    camera_id: format!("C{}", camera_index + 1),
                    sequence_no: index as u32,
                    kind: "intensity".into(),
                    path: format!("C{}/{}", camera_index + 1, name.to_string_lossy()),
                    mime_type: mime_type.into(),
                    size,
                    sha256: hash,
                    width: None,
                    height: None,
                });
            }
        }
        if artifacts.is_empty() {
            let _ = fs::remove_dir_all(&record_source);
            return Ok(());
        }
        let defects = self.load_defects(seq).await.unwrap_or_default();
        let result = UnifiedResult {
            schema: RESULT_SCHEMA.into(),
            inspection_id: inspection_id.clone(),
            session_id: format!("bkv-{inspection_id}"),
            material_id: row_string(row, "steel_id")?,
            source: "bkv-online-mysql".into(),
            source_record_id: inspection_id.clone(),
            inspection_time: Some(row_string(row, "detected_at")?),
            status: if row_string(row, "complete")? == "1" {
                "ready"
            } else {
                "partial"
            }
            .into(),
            camera_count: self.image_roots.len(),
            cameras: (1..=self.image_roots.len())
                .map(|index| format!("C{index}"))
                .collect(),
            defect_count: defects.len(),
            material: ResultMaterial {
                steel_type: Some(row_string(row, "steel_type")?),
                length_mm: row_string(row, "length_mm")?.parse().ok(),
                outer_diameter_mm: row_string(row, "diameter_mm")?.parse().ok(),
                wall_thickness_mm: row_string(row, "wall_mm")?.parse().ok(),
            },
            artifacts,
            defects,
            source_hash: format!("bkv:{:x}", source_digest.finalize()),
            config_hash: "bkv-mysql-adapter-v1".into(),
            algorithm_version: processor.into(),
            published_at: utc_now(),
        };
        publisher.publish(PublishInput { inspection_id, result, source_directory: record_source.clone(), source_provenance: Some(json!({"schema":"steel.source-provenance.v1","provider":"bkv-online-mysql","sourceRecordId":seq})) }).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(record_source);
        Ok(())
    }

    async fn load_defects(&self, sequence: i64) -> Result<Vec<ResultDefect>, String> {
        let rows = self.connection.query_all(Statement::from_string(DbBackend::MySql, format!("SELECT CAST(ID AS CHAR) AS id, CAST(CamNo AS CHAR) AS camera_no, CAST(COALESCE(ImgIndex, 0) AS CHAR) AS image_index, CAST(COALESCE(Class, 0) AS CHAR) AS class_no, CAST(COALESCE(Grade, 0) AS CHAR) AS grade, CAST(COALESCE(Confidence, 0) AS CHAR) AS confidence FROM `{}`.`defect` WHERE SeqNo = {} ORDER BY ID DESC LIMIT 5000", self.database, sequence))).await.map_err(|e| e.to_string())?;
        rows.iter().map(|row| Ok(ResultDefect { id: row_string(row, "id")?, camera_id: format!("C{}", row_string(row, "camera_no")?), sequence_no: row_string(row, "image_index")?.parse().unwrap_or(0), defect_type: format!("bkv-class-{}", row_string(row, "class_no")?), severity: row_string(row, "grade")?.parse().ok(), confidence: row_string(row, "confidence")?.parse().ok(), artifacts: json!({"classNo": row_string(row, "class_no")?, "imageIndex": row_string(row, "image_index")?}) })).collect()
    }
}

fn published_result_is_complete(publisher: &ResultPublisher, inspection_id: &str) -> bool {
    let path = publisher
        .root()
        .join("records")
        .join(inspection_id)
        .join("result.json");
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|value| value.get("artifacts").cloned())
        .and_then(|value| value.as_array().cloned())
        .is_some_and(|artifacts| !artifacts.is_empty())
}

fn row_string(row: &QueryResult, column: &str) -> Result<String, String> {
    row.try_get("", column)
        .map_err(|e| format!("BKV column {column}: {e}"))
}
fn url_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn source_adapter_loop(state: Arc<State>) {
    let mut next_bkv_refresh = Instant::now();
    while !state.shutdown.load(Ordering::Acquire) {
        scan_sources(&state);
        if Instant::now() >= next_bkv_refresh {
            if let (Some(runtime), Some(adapter)) =
                (state.mysql_runtime.as_ref(), state.bkv.as_ref())
            {
                if let Err(error) =
                    runtime.block_on(adapter.refresh(&state.publisher, &state.processor))
                {
                    let mut counters = state.counters.lock().unwrap_or_else(|p| p.into_inner());
                    counters.failed = counters.failed.saturating_add(1);
                    counters.last_error = Some(format!("BKV adapter: {error}"));
                }
            }
            next_bkv_refresh = Instant::now() + state.bkv_refresh_interval;
        }
        thread::sleep(state.scan_interval);
    }
}

fn history_input_root(state: &State, record_id: &str) -> Result<PathBuf, String> {
    let mut roots = state.input_roots.clone();
    let recovered = workspace_root()
        .join("target")
        .join("run")
        .join("bkv-history-recovery")
        .join("input");
    if recovered.is_dir() && !roots.iter().any(|root| root == &recovered) {
        roots.push(recovered);
    }
    roots
        .iter()
        .find(|root| {
            root.join("records")
                .join(record_id)
                .join("source-provenance.json")
                .is_file()
                || root
                    .join("records")
                    .join(record_id)
                    .join("record.json")
                    .is_file()
        })
        .cloned()
        .or_else(|| roots.first().cloned())
        .ok_or_else(|| "historical reconstruction input root is unavailable".to_string())
}

fn history_runs_root(input_root: &Path, record_id: &str) -> Result<PathBuf, String> {
    if let Some(root) = env::var("STEEL_BKV_HISTORY_RUNS_ROOT")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        let root = PathBuf::from(root);
        if root.is_dir() {
            return Ok(root);
        }
    }
    let provenance = input_root
        .join("records")
        .join(record_id)
        .join("source-provenance.json");
    let bytes = fs::read(&provenance)
        .map_err(|error| format!("historical provenance unavailable: {error}"))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("historical provenance invalid: {error}"))?;
    let run = value
        .get("historyRunDirectory")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| "historical run directory is missing".to_string())?;
    run.parent()
        .filter(|parent| parent.is_dir())
        .map(Path::to_path_buf)
        .ok_or_else(|| "historical runs root is unavailable".to_string())
}

fn run_history_materializer(
    record_id: &str,
    input_root: &Path,
    runs_root: &Path,
) -> Result<(), String> {
    if record_id.is_empty() || !record_id.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("historical reconstruction requires a numeric record id".to_string());
    }
    let script = env::var("STEEL_BKV_HISTORY_MATERIALIZER")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            workspace_root()
                .join("scripts")
                .join("materialize_bkv_record.py")
        });
    if !script.is_file() {
        return Err(format!(
            "historical materializer is unavailable: {}",
            script.display()
        ));
    }
    let source_host = env::var("STEEL_BKV_IMAGE_HOST")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| r"\\10.5.241.17".to_string());
    let max_frames = env::var("STEEL_BKV_HISTORY_MAX_FRAMES_PER_CAMERA")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(256)
        .clamp(1, 4096);
    let python = env::var("STEEL_PYTHON_EXECUTABLE").unwrap_or_else(|_| "python".to_string());
    let mut command = Command::new(python);
    command
        .arg(&script)
        .arg("--runs-root")
        .arg(runs_root)
        .arg("--input-root")
        .arg(input_root)
        .arg("--record-id")
        .arg(record_id);
    let provenance = input_root
        .join("records")
        .join(record_id)
        .join("source-provenance.json");
    if let Ok(bytes) = fs::read(&provenance) {
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if let Some(run_dir) = value
                .get("historyRunDirectory")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                command.arg("--run-dir").arg(run_dir);
            }
        }
    }
    command
        .arg("--source-host")
        .arg(source_host)
        .arg("--max-frames-per-camera")
        .arg(max_frames.to_string())
        .arg("--force")
        .current_dir(workspace_root())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if env::var("STEEL_BKV_HISTORY_COMPRESS_JPEG").as_deref() == Ok("1") {
        command.arg("--compress-jpeg");
    }
    let output = command
        .output()
        .map_err(|error| format!("historical materializer start failed: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("historical materializer exited with {}", output.status)
        } else {
            stderr
        });
    }
    Ok(())
}

fn published_artifacts_present(state: &State, record_id: &str) -> bool {
    let result = state
        .publisher
        .root()
        .join("records")
        .join(record_id)
        .join("result.json");
    let Ok(bytes) = fs::read(result) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    value
        .get("artifacts")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
}

fn reconstruct_history_record(state: &State, record_id: &str) -> Result<Value, String> {
    if published_artifacts_present(state, record_id) {
        return Ok(json!({
            "accepted": true,
            "recordId": record_id,
            "status": "ready",
            "reconstructed": false,
        }));
    }
    {
        let mut active = state
            .history_reconstruction
            .lock()
            .map_err(|_| "historical reconstruction lock poisoned".to_string())?;
        if !active.insert(record_id.to_string()) {
            return Ok(json!({
                "accepted": true,
                "recordId": record_id,
                "status": "processing",
                "reconstructed": false,
            }));
        }
    }
    let result = (|| {
        let input_root = history_input_root(state, record_id)?;
        let runs_root = history_runs_root(&input_root, record_id)?;
        run_history_materializer(record_id, &input_root, &runs_root)?;
        // Publish only this record synchronously so the inspection API can
        // retry the same request without waiting for a full history rescan.
        let record_path = input_root
            .join("records")
            .join(record_id)
            .join("record.json");
        process_single_record(state, &record_path)?;
        let deadline = std::time::Instant::now()
            + Duration::from_secs(
                env::var("STEEL_BKV_HISTORY_RECONSTRUCT_WAIT_SEC")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(90)
                    .clamp(1, 600),
            );
        while !published_artifacts_present(state, record_id) {
            if std::time::Instant::now() >= deadline {
                return Err("historical algorithm result publication timed out".to_string());
            }
            if !published_artifacts_present(state, record_id) {
                process_single_record(state, &record_path)?;
            }
            thread::sleep(Duration::from_millis(100));
        }
        Ok(json!({
            "accepted": true,
            "recordId": record_id,
            "status": "ready",
            "reconstructed": true,
        }))
    })();
    if let Ok(mut active) = state.history_reconstruction.lock() {
        active.remove(record_id);
    }
    result
}

fn scan_sources(state: &State) {
    if state.scan_in_progress.swap(true, Ordering::AcqRel) {
        return;
    }
    let mut candidates = Vec::new();
    for root in &state.input_roots {
        collect_record_files(root, &mut candidates);
    }
    for record_path in candidates {
        if let Err(error) = process_record(state, &record_path) {
            let mut counters = state.counters.lock().unwrap_or_else(|p| p.into_inner());
            counters.failed = counters.failed.saturating_add(1);
            counters.last_error = Some(error);
        }
    }
    state.scan_in_progress.store(false, Ordering::Release);
}

fn process_single_record(state: &State, record_path: &Path) -> Result<(), String> {
    // The periodic source scan and an on-demand record switch share the same
    // publication gate. Waiting here avoids two SQLite result publications
    // racing while still allowing the normal scanner to continue afterwards.
    while state.scan_in_progress.swap(true, Ordering::AcqRel) {
        thread::sleep(Duration::from_millis(50));
    }
    let result = process_record(state, record_path);
    state.scan_in_progress.store(false, Ordering::Release);
    result
}

fn collect_record_files(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_record_files(&path, output);
        } else if path.file_name().and_then(|v| v.to_str()) == Some("record.json") {
            output.push(path);
        }
    }
}

fn process_record(state: &State, record_path: &Path) -> Result<(), String> {
    let record_dir = record_path
        .parent()
        .ok_or_else(|| "record has no parent".to_string())?;
    let bytes = fs::read(record_path).map_err(|e| e.to_string())?;
    let source: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("record JSON invalid: {e}"))?;
    let schema = source
        .get("schema")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if schema != "steel.standard-record.v2" && schema != RESULT_SCHEMA {
        return Ok(());
    }
    if record_dir.starts_with(state.publisher.root()) {
        return Ok(());
    }
    let inspection_id = source
        .get("inspectionId")
        .and_then(Value::as_str)
        .or_else(|| record_dir.file_name().and_then(|v| v.to_str()))
        .ok_or_else(|| "inspection id missing".to_string())?
        .to_string();
    let source_hash = source
        .get("sourceHash")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{:x}", Sha256::digest(&bytes)));
    if state
        .processed_inputs
        .lock()
        .ok()
        .and_then(|cache| cache.get(record_path).cloned())
        .is_some_and(|hash| hash == source_hash)
    {
        let mut counters = state.counters.lock().unwrap_or_else(|p| p.into_inner());
        counters.skipped = counters.skipped.saturating_add(1);
        return Ok(());
    }
    let has_capture_files = source
        .get("captureFiles")
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    // Metadata-first recovery already published the facts to the unified
    // catalog. Do not re-publish thousands of empty historical records on
    // every two-second scan; the first materialized capture changes the input
    // hash and naturally re-enters the full publication path below.
    if !has_capture_files
        && state
            .publisher
            .root()
            .join("records")
            .join(&inspection_id)
            .join("result.json")
            .is_file()
    {
        if let Ok(mut cache) = state.processed_inputs.lock() {
            cache.insert(record_path.to_path_buf(), source_hash);
        }
        let mut counters = state.counters.lock().unwrap_or_else(|p| p.into_inner());
        counters.skipped = counters.skipped.saturating_add(1);
        return Ok(());
    }
    let artifacts = source
        .get("captureFiles")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| {
                    let path = item.get("path").and_then(Value::as_str)?.to_string();
                    let camera_id = item
                        .get("cameraId")
                        .and_then(Value::as_str)
                        .unwrap_or("C1")
                        .to_string();
                    let sequence_no = item
                        .get("sequenceNo")
                        .and_then(Value::as_u64)
                        .unwrap_or(index as u64) as u32;
                    let kind = item
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("intensity")
                        .to_string();
                    let mime_type = if kind.eq_ignore_ascii_case("depth") {
                        "application/octet-stream"
                    } else {
                        "image/jpeg"
                    };
                    Some(ResultArtifact {
                        id: format!("{inspection_id}-{camera_id}-{sequence_no:06}-{kind}"),
                        camera_id,
                        sequence_no,
                        kind,
                        path,
                        mime_type: mime_type.into(),
                        size: item.get("size").and_then(Value::as_u64).unwrap_or(0),
                        sha256: item
                            .get("sha256")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .into(),
                        width: None,
                        height: None,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let defects = load_defects(record_dir, &source, &inspection_id);
    let material_value = source.get("material").cloned().unwrap_or_else(|| json!({}));
    let material = ResultMaterial {
        steel_type: material_value
            .get("steelType")
            .and_then(Value::as_str)
            .map(str::to_string),
        length_mm: material_value.get("lengthMm").and_then(Value::as_f64),
        outer_diameter_mm: material_value
            .get("outerDiameterLegacyValue")
            .and_then(Value::as_f64)
            .or_else(|| {
                material_value
                    .get("outerDiameterMm")
                    .and_then(Value::as_f64)
            }),
        wall_thickness_mm: material_value
            .get("wallThicknessMm")
            .and_then(Value::as_f64),
    };
    let cameras: Vec<String> = source
        .get("cameras")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_else(|| {
            (1..=source
                .get("cameraCount")
                .and_then(Value::as_u64)
                .unwrap_or(0))
                .map(|n| format!("C{n}"))
                .collect()
        });
    let default_session = format!("algorithm-{inspection_id}");
    let default_material = inspection_id.clone();
    let default_source_record = inspection_id.clone();
    let result = UnifiedResult {
        schema: RESULT_SCHEMA.into(),
        inspection_id: inspection_id.clone(),
        session_id: source
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or(&default_session)
            .into(),
        material_id: source
            .get("materialId")
            .and_then(Value::as_str)
            .unwrap_or(&default_material)
            .into(),
        source: "algorithm-service".into(),
        source_record_id: source
            .get("sourceRecordId")
            .and_then(Value::as_str)
            .unwrap_or(&default_source_record)
            .into(),
        inspection_time: source
            .get("inspectionTime")
            .and_then(Value::as_str)
            .map(str::to_string),
        status: "ready".into(),
        camera_count: cameras.len(),
        cameras,
        defect_count: defects.len(),
        material,
        artifacts,
        defects,
        source_hash: source_hash.clone(),
        config_hash: source
            .get("configHash")
            .and_then(Value::as_str)
            .unwrap_or("algorithm-default")
            .into(),
        algorithm_version: state.processor.clone(),
        published_at: utc_now(),
    };
    let provenance = record_dir
        .join("source-provenance.json")
        .is_file()
        .then(|| fs::read(record_dir.join("source-provenance.json")).ok())
        .flatten()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let generation = state
        .publisher
        .publish(PublishInput {
            inspection_id,
            result,
            source_directory: record_dir.to_path_buf(),
            source_provenance: provenance,
        })
        .map_err(|e| e.to_string())?;
    if let Some(core) = &state.algorithm_core {
        run_core_if_requested(core, &source, record_dir);
    }
    let mut counters = state.counters.lock().unwrap_or_else(|p| p.into_inner());
    counters.scanned = counters.scanned.saturating_add(1);
    counters.published = counters.published.saturating_add(1);
    counters.last_published_at = Some(utc_now());
    counters.last_error = None;
    if let Ok(mut cache) = state.processed_inputs.lock() {
        cache.insert(record_path.to_path_buf(), source_hash);
    }
    let _ = generation;
    Ok(())
}

fn load_defects(record_dir: &Path, source: &Value, inspection_id: &str) -> Vec<ResultDefect> {
    let relative = source
        .get("defectsPath")
        .and_then(Value::as_str)
        .unwrap_or("defects/defects.json");
    let Ok(bytes) = fs::read(record_dir.join(relative)) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return Vec::new();
    };
    value
        .get("defects")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, item)| ResultDefect {
                    id: item
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(&format!("{inspection_id}-defect-{index}"))
                        .into(),
                    camera_id: item
                        .get("cameraId")
                        .and_then(Value::as_str)
                        .unwrap_or("C1")
                        .into(),
                    sequence_no: item.get("sequenceNo").and_then(Value::as_u64).unwrap_or(0) as u32,
                    defect_type: item
                        .get("defectType")
                        .or_else(|| item.get("className"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .into(),
                    severity: item.get("severity").and_then(Value::as_i64),
                    confidence: item.get("confidence").and_then(Value::as_f64),
                    artifacts: item
                        .get("artifacts")
                        .cloned()
                        .unwrap_or_else(|| item.clone()),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn run_core_if_requested(core: &Path, source: &Value, record_dir: &Path) {
    let Some(manifest) = source.get("algorithmManifest").and_then(Value::as_str) else {
        return;
    };
    let manifest_path = record_dir.join(manifest);
    if !manifest_path.is_file() {
        return;
    }
    let _ = Command::new(core)
        .arg("--manifest")
        .arg(manifest_path)
        .current_dir(record_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn handle_client(mut stream: TcpStream, state: Arc<State>) {
    let bytes = read_http_request(&mut stream);
    let request = String::from_utf8_lossy(&bytes);
    let mut lines = request.split("\r\n");
    let Some(first) = lines.next() else {
        return;
    };
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let body = request.split("\r\n\r\n").nth(1).unwrap_or("");
    let query_record_id = query.split('&').find_map(|part| {
        let (key, value) = part.split_once('=')?;
        (key == "recordId" && !value.is_empty()).then(|| value.to_string())
    });
    let response = match (method, path) {
        ("GET", "/api/health/live") | ("GET", "/health") => response(200, &json!({"status":"live","service":"steel-algorithm-service","schema":"steel.algorithm-service.health.v1"}).to_string()),
        ("GET", "/internal/v1/status") => response(200, &status_json(&state)),
        ("POST", "/internal/v1/reprocess") => { let _ = serde_json::from_str::<Value>(body); scan_sources(&state); response(202, &json!({"accepted":true,"service":"steel-algorithm-service"}).to_string()) }
        ("POST", "/internal/v1/run") => { scan_sources(&state); response(202, &json!({"accepted":true}).to_string()) }
        ("POST", "/internal/v1/reconstruct") => {
            let record_id = serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|value| value.get("recordId").and_then(Value::as_str).map(str::to_owned))
                .or(query_record_id);
            match record_id {
                Some(record_id) => match reconstruct_history_record(&state, &record_id) {
                    Ok(payload) => response(200, &payload.to_string()),
                    Err(error) => response(422, &json!({"accepted":false,"recordId":record_id,"error":error}).to_string()),
                },
                None => response(400, &json!({"accepted":false,"error":"recordId_required"}).to_string()),
            }
        }
        _ => response(404, &json!({"error":"not_found"}).to_string()),
    };
    let _ = stream.write_all(response.as_bytes());
}

fn read_http_request(stream: &mut TcpStream) -> Vec<u8> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                bytes.extend_from_slice(&buffer[..size]);
                if let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let header = String::from_utf8_lossy(&bytes[..header_end]);
                    let content_length = header
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.trim()
                                .eq_ignore_ascii_case("Content-Length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    if bytes.len() >= header_end + 4 + content_length {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
    bytes
}

fn status_json(state: &State) -> String {
    let counters = state.counters.lock().unwrap_or_else(|p| p.into_inner());
    let bkv = state.bkv.as_ref();
    json!({
        "schema":"steel.algorithm-service.status.v1",
        "service":"steel-algorithm-service",
        "ready":true,
        "resultRoot":state.publisher.root(),
        "inputRoots":state.input_roots,
        "processor":state.processor,
        "scanInProgress":state.scan_in_progress.load(Ordering::Acquire),
        "bkvOnline": {
            "configured": bkv.is_some(),
            "databaseConnected": bkv.is_some(),
            "recordLimit": bkv.map(|adapter| adapter.record_limit).unwrap_or(0),
            "imageRootCount": bkv.map(|adapter| adapter.image_roots.len()).unwrap_or(0),
            "onlineImageRoots": bkv.map(|adapter| adapter.image_roots.iter().filter(|root| root.is_dir()).count()).unwrap_or(0),
        },
        "counters":{
            "scanned":counters.scanned,
            "published":counters.published,
            "skipped":counters.skipped,
            "failed":counters.failed,
            "lastError":counters.last_error,
            "lastPublishedAt":counters.last_published_at
        }
    }).to_string()
}

fn response(code: u16, body: &str) -> String {
    let reason = match code {
        200 => "OK",
        202 => "Accepted",
        404 => "Not Found",
        _ => "Error",
    };
    format!("HTTP/1.1 {code} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

fn utc_now() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}
