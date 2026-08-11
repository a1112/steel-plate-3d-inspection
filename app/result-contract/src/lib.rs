//! Shared immutable result contract used by the algorithm, image and business services.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const RESULT_SCHEMA: &str = "steel.inspection-result.v1";
pub const CATALOG_SCHEMA: &str = "steel.inspection-result-catalog.v1";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultMaterial {
    pub steel_type: Option<String>,
    pub length_mm: Option<f64>,
    pub outer_diameter_mm: Option<f64>,
    pub wall_thickness_mm: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultArtifact {
    pub id: String,
    pub camera_id: String,
    pub sequence_no: u32,
    pub kind: String,
    pub path: String,
    pub mime_type: String,
    pub size: u64,
    pub sha256: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultDefect {
    pub id: String,
    pub camera_id: String,
    pub sequence_no: u32,
    pub defect_type: String,
    pub severity: Option<i64>,
    pub confidence: Option<f64>,
    #[serde(default)]
    pub artifacts: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedResult {
    pub schema: String,
    pub inspection_id: String,
    pub session_id: String,
    pub material_id: String,
    pub source: String,
    pub source_record_id: String,
    pub inspection_time: Option<String>,
    pub status: String,
    pub camera_count: usize,
    pub cameras: Vec<String>,
    pub defect_count: usize,
    pub material: ResultMaterial,
    #[serde(default)]
    pub artifacts: Vec<ResultArtifact>,
    #[serde(default)]
    pub defects: Vec<ResultDefect>,
    pub source_hash: String,
    pub config_hash: String,
    pub algorithm_version: String,
    pub published_at: String,
}

#[derive(Clone, Debug)]
pub struct PublishInput {
    pub inspection_id: String,
    pub result: UnifiedResult,
    /// Existing normalized record directory. All referenced files must be below it.
    pub source_directory: PathBuf,
    pub source_provenance: Option<Value>,
}

#[derive(Debug)]
pub enum ResultStoreError {
    Io(io::Error),
    Json(serde_json::Error),
    Sql(rusqlite::Error),
    Invalid(String),
}

impl std::fmt::Display for ResultStoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "I/O error: {error}"),
            Self::Json(error) => write!(f, "JSON error: {error}"),
            Self::Sql(error) => write!(f, "catalog error: {error}"),
            Self::Invalid(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for ResultStoreError {}
impl From<io::Error> for ResultStoreError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<serde_json::Error> for ResultStoreError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}
impl From<rusqlite::Error> for ResultStoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e)
    }
}

pub struct ResultPublisher {
    root: PathBuf,
    catalog: PathBuf,
}

impl ResultPublisher {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, ResultStoreError> {
        let root = root.into();
        fs::create_dir_all(root.join("records"))?;
        fs::create_dir_all(root.join("blobs"))?;
        fs::create_dir_all(root.join("staging"))?;
        let catalog = root.join("catalog.db");
        let connection = Connection::open(&catalog)?;
        connection.busy_timeout(Duration::from_secs(30))?;
        initialize_catalog(&connection)?;
        Ok(Self { root, catalog })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn catalog_path(&self) -> &Path {
        &self.catalog
    }

    pub fn publish(&self, mut input: PublishInput) -> Result<u64, ResultStoreError> {
        validate_id(&input.inspection_id)?;
        if input.result.schema != RESULT_SCHEMA {
            return Err(ResultStoreError::Invalid(
                "unsupported unified result schema".into(),
            ));
        }
        if input.result.inspection_id != input.inspection_id {
            return Err(ResultStoreError::Invalid("inspection id mismatch".into()));
        }
        if let Some(generation) = self.existing_generation_if_unchanged(&input)? {
            return Ok(generation);
        }
        let job_id = format!("{}-{}", input.inspection_id, unique_suffix());
        let staging = self.root.join("staging").join(&job_id);
        let record_stage = staging.join("records").join(&input.inspection_id);
        fs::create_dir_all(&record_stage)?;

        // Copy/verify the files declared by the result into content-addressed storage.
        for artifact in &mut input.result.artifacts {
            let relative = safe_relative(&artifact.path)?;
            let source = input.source_directory.join(relative);
            let source = fs::canonicalize(source)?;
            let source_root = fs::canonicalize(&input.source_directory)?;
            if !source.starts_with(&source_root) || !source.is_file() {
                return Err(ResultStoreError::Invalid(
                    "artifact escaped source directory".into(),
                ));
            }
            let (size, sha256) = file_digest(&source)?;
            if artifact.size != 0 && artifact.size != size {
                return Err(ResultStoreError::Invalid(format!(
                    "artifact size mismatch: {}",
                    artifact.id
                )));
            }
            if !artifact.sha256.is_empty() && artifact.sha256.to_ascii_lowercase() != sha256 {
                return Err(ResultStoreError::Invalid(format!(
                    "artifact hash mismatch: {}",
                    artifact.id
                )));
            }
            artifact.size = size;
            artifact.sha256 = sha256.clone();
            let blob = self.root.join("blobs").join(&sha256);
            if !blob.exists() {
                let temporary = staging.join(format!("blob-{sha256}.tmp"));
                fs::copy(&source, &temporary)?;
                if let Err(error) = fs::rename(&temporary, &blob) {
                    if !blob.exists() {
                        return Err(ResultStoreError::Io(error));
                    }
                    let _ = fs::remove_file(&temporary);
                }
            }
            artifact.path = format!("blobs/{sha256}");
        }

        let record_json = serde_json::to_vec_pretty(&input.result)?;
        fs::write(record_stage.join("result.json"), &record_json)?;
        fs::write(record_stage.join("record.json"), &record_json)?;
        if let Some(provenance) = input.source_provenance.take() {
            fs::write(
                record_stage.join("source-provenance.json"),
                serde_json::to_vec_pretty(&provenance)?,
            )?;
        }
        fs::write(
            record_stage.join("defects.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "schema": "steel.standard-defects.v1",
                "inspectionId": input.result.inspection_id,
                "defects": input.result.defects,
            }))?,
        )?;

        let destination = self.root.join("records").join(&input.inspection_id);
        let previous = staging.join("previous-record");
        if destination.exists() {
            fs::rename(&destination, &previous)?;
        }
        if let Err(error) = fs::rename(&record_stage, &destination) {
            if previous.exists() {
                let _ = fs::rename(&previous, &destination);
            }
            return Err(ResultStoreError::Io(error));
        }
        let database_result = (|| -> Result<u64, ResultStoreError> {
            let connection = Connection::open(&self.catalog)?;
            connection.busy_timeout(Duration::from_secs(30))?;
            let transaction = connection.unchecked_transaction()?;
            let generation = transaction.query_row(
                "SELECT COALESCE(MAX(generation), 0) + 1 FROM production_inspection",
                [],
                |row| row.get::<_, i64>(0),
            )? as u64;
            let result = &input.result;
            transaction.execute(
                "INSERT INTO production_inspection (id, session_id, material_id, inspection_time, status, defect_count, camera_count, source_hash, record_path, metadata_json, generation) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, material_id=excluded.material_id, inspection_time=excluded.inspection_time, status=excluded.status, defect_count=excluded.defect_count, camera_count=excluded.camera_count, source_hash=excluded.source_hash, record_path=excluded.record_path, metadata_json=excluded.metadata_json, generation=excluded.generation",
                params![result.inspection_id, result.session_id, result.material_id, result.inspection_time, result.status, result.defect_count as i64, result.camera_count as i64, result.source_hash, format!("records/{}", result.inspection_id), serde_json::to_string(&result.material)?, generation as i64],
            )?;
            transaction.execute(
                "DELETE FROM production_defect WHERE inspection_id = ?1",
                params![result.inspection_id],
            )?;
            transaction.execute(
                "DELETE FROM capture_file WHERE inspection_id = ?1",
                params![result.inspection_id],
            )?;
            for defect in &result.defects {
                transaction.execute(
                    "INSERT INTO production_defect (id, inspection_id, camera_id, sequence_no, defect_type, severity, confidence, artifacts_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![defect.id, result.inspection_id, defect.camera_id, defect.sequence_no as i64, defect.defect_type, defect.severity, defect.confidence, serde_json::to_string(&defect.artifacts)?],
                )?;
            }
            for artifact in &result.artifacts {
                transaction.execute(
                    "INSERT INTO capture_file (id, inspection_id, camera_id, sequence_no, kind, path, size, sha256) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![artifact.id, result.inspection_id, artifact.camera_id, artifact.sequence_no as i64, artifact.kind, artifact.path, artifact.size as i64, artifact.sha256],
                )?;
            }
            transaction.commit()?;
            Ok(generation)
        })();
        let generation = match database_result {
            Ok(generation) => generation,
            Err(error) => {
                if let Err(rollback_error) = restore_previous_record(&destination, &previous) {
                    return Err(ResultStoreError::Invalid(format!(
                        "catalog publication failed: {error}; record rollback failed: {rollback_error}"
                    )));
                }
                let _ = fs::remove_dir_all(&staging);
                return Err(error);
            }
        };
        if previous.exists() {
            let _ = fs::remove_dir_all(previous);
        }
        let _ = fs::remove_dir_all(&staging);
        Ok(generation)
    }

    fn existing_generation_if_unchanged(
        &self,
        input: &PublishInput,
    ) -> Result<Option<u64>, ResultStoreError> {
        let record_path = self
            .root
            .join("records")
            .join(&input.inspection_id)
            .join("result.json");
        if !record_path.is_file() {
            return Ok(None);
        }
        let existing: UnifiedResult = match serde_json::from_slice(&fs::read(record_path)?) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        if existing.schema != input.result.schema
            || existing.session_id != input.result.session_id
            || existing.material_id != input.result.material_id
            || existing.source != input.result.source
            || existing.source_record_id != input.result.source_record_id
            || existing.inspection_time != input.result.inspection_time
            || existing.source_hash != input.result.source_hash
            || existing.config_hash != input.result.config_hash
            || existing.algorithm_version != input.result.algorithm_version
            || existing.status != input.result.status
            || existing.camera_count != input.result.camera_count
            || existing.cameras != input.result.cameras
            || existing.defect_count != input.result.defect_count
            || existing.material != input.result.material
            || existing.defects != input.result.defects
            || existing.artifacts.len() != input.result.artifacts.len()
        {
            return Ok(None);
        }
        for (old, new) in existing.artifacts.iter().zip(input.result.artifacts.iter()) {
            if old.id != new.id
                || old.camera_id != new.camera_id
                || old.sequence_no != new.sequence_no
                || old.kind != new.kind
                || old.mime_type != new.mime_type
                || old.width != new.width
                || old.height != new.height
                || (new.size != 0 && old.size != new.size)
                || (!new.sha256.is_empty() && old.sha256 != new.sha256)
            {
                return Ok(None);
            }
        }
        let connection = Connection::open(&self.catalog)?;
        connection.busy_timeout(Duration::from_secs(30))?;
        let generation = connection
            .query_row(
                "SELECT generation FROM production_inspection WHERE id = ?1",
                params![input.inspection_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok(generation.and_then(|value| u64::try_from(value).ok()))
    }
}

fn restore_previous_record(destination: &Path, previous: &Path) -> io::Result<()> {
    if destination.exists() {
        fs::remove_dir_all(destination)?;
    }
    if previous.exists() {
        fs::rename(previous, destination)?;
    }
    Ok(())
}

pub fn initialize_catalog(connection: &Connection) -> Result<(), ResultStoreError> {
    connection.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);\
         CREATE TABLE IF NOT EXISTS production_inspection (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, material_id TEXT NOT NULL, inspection_time TEXT, status TEXT NOT NULL, defect_count INTEGER NOT NULL, camera_count INTEGER NOT NULL, source_hash TEXT NOT NULL, record_path TEXT NOT NULL, metadata_json TEXT NOT NULL, generation INTEGER NOT NULL);\
         CREATE INDEX IF NOT EXISTS idx_production_inspection_time ON production_inspection(inspection_time DESC, id DESC);\
         CREATE INDEX IF NOT EXISTS idx_production_inspection_generation ON production_inspection(generation);\
         CREATE TABLE IF NOT EXISTS production_defect (id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL, camera_id TEXT NOT NULL, sequence_no INTEGER NOT NULL, defect_type TEXT NOT NULL, severity INTEGER, confidence REAL, artifacts_json TEXT NOT NULL);\
         CREATE INDEX IF NOT EXISTS idx_production_defect_inspection ON production_defect(inspection_id);\
         CREATE TABLE IF NOT EXISTS capture_file (id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL, camera_id TEXT NOT NULL, sequence_no INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL);\
         CREATE INDEX IF NOT EXISTS idx_capture_file_inspection ON capture_file(inspection_id);\
         INSERT INTO catalog_meta(key, value) VALUES ('schema', '{CATALOG_SCHEMA}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;"
    ))?;
    Ok(())
}

pub fn file_digest(path: &Path) -> Result<(u64, String), ResultStoreError> {
    let mut file = fs::File::open(path)?;
    let size = file.metadata()?.len();
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok((size, format!("{:x}", digest.finalize())))
}

pub fn safe_relative(value: &str) -> Result<PathBuf, ResultStoreError> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ResultStoreError::Invalid(
            "path must be a relative contained path".into(),
        ));
    }
    Ok(path.to_path_buf())
}

fn validate_id(value: &str) -> Result<(), ResultStoreError> {
    if value.trim().is_empty()
        || value.len() > 128
        || value
            .chars()
            .any(|ch| !(ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.')))
    {
        return Err(ResultStoreError::Invalid("invalid inspection id".into()));
    }
    Ok(())
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture_result(id: &str, source_hash: &str, defect_id: Option<&str>) -> UnifiedResult {
        let defects = defect_id
            .map(|defect_id| {
                vec![ResultDefect {
                    id: defect_id.to_string(),
                    camera_id: "C1".into(),
                    sequence_no: 1,
                    defect_type: "test".into(),
                    severity: Some(1),
                    confidence: Some(0.9),
                    artifacts: serde_json::json!({}),
                }]
            })
            .unwrap_or_default();
        UnifiedResult {
            schema: RESULT_SCHEMA.into(),
            inspection_id: id.into(),
            session_id: format!("session-{id}"),
            material_id: format!("material-{id}"),
            source: "test".into(),
            source_record_id: id.into(),
            inspection_time: None,
            status: "ready".into(),
            camera_count: 1,
            cameras: vec!["C1".into()],
            defect_count: defects.len(),
            material: ResultMaterial::default(),
            artifacts: vec![ResultArtifact {
                id: format!("artifact-{id}"),
                camera_id: "C1".into(),
                sequence_no: 1,
                kind: "intensity".into(),
                path: "camera/0001.jpg".into(),
                mime_type: "image/jpeg".into(),
                size: 0,
                sha256: String::new(),
                width: None,
                height: None,
            }],
            defects,
            source_hash: source_hash.into(),
            config_hash: "config".into(),
            algorithm_version: "test".into(),
            published_at: "now".into(),
        }
    }

    fn publish_fixture(
        publisher: &ResultPublisher,
        source: &Path,
        result: UnifiedResult,
    ) -> Result<u64, ResultStoreError> {
        publisher.publish(PublishInput {
            inspection_id: result.inspection_id.clone(),
            result,
            source_directory: source.to_path_buf(),
            source_provenance: None,
        })
    }

    #[test]
    fn safe_relative_rejects_escape() {
        assert!(safe_relative("../secret").is_err());
        assert!(safe_relative("C:/secret").is_err());
        assert!(safe_relative("camera/0001.jpg").is_ok());
    }

    #[test]
    fn publication_is_atomic_and_indexed() {
        let root = std::env::temp_dir().join(format!("steel-result-contract-{}", unique_suffix()));
        let source = root.join("source");
        fs::create_dir_all(source.join("camera")).unwrap();
        fs::write(source.join("camera/0001.jpg"), b"image").unwrap();
        let publisher = ResultPublisher::open(root.join("results")).unwrap();
        let result = UnifiedResult {
            schema: RESULT_SCHEMA.into(),
            inspection_id: "1".into(),
            session_id: "s".into(),
            material_id: "m".into(),
            source: "test".into(),
            source_record_id: "1".into(),
            inspection_time: None,
            status: "ready".into(),
            camera_count: 1,
            cameras: vec!["C1".into()],
            defect_count: 0,
            material: ResultMaterial::default(),
            artifacts: vec![ResultArtifact {
                id: "a".into(),
                camera_id: "C1".into(),
                sequence_no: 1,
                kind: "intensity".into(),
                path: "camera/0001.jpg".into(),
                mime_type: "image/jpeg".into(),
                size: 0,
                sha256: String::new(),
                width: None,
                height: None,
            }],
            defects: vec![],
            source_hash: "source".into(),
            config_hash: "config".into(),
            algorithm_version: "test".into(),
            published_at: "now".into(),
        };
        let generation = publisher
            .publish(PublishInput {
                inspection_id: "1".into(),
                result: result.clone(),
                source_directory: source.clone(),
                source_provenance: None,
            })
            .unwrap();
        assert_eq!(generation, 1);
        let repeated = publisher
            .publish(PublishInput {
                inspection_id: "1".into(),
                result,
                source_directory: source,
                source_provenance: None,
            })
            .unwrap();
        assert_eq!(repeated, generation);
        assert!(publisher.root().join("records/1/result.json").is_file());
        let connection = Connection::open(publisher.catalog_path()).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM production_inspection", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            1
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn metadata_changes_are_not_treated_as_an_unchanged_publication() {
        let root = std::env::temp_dir().join(format!("steel-result-metadata-{}", unique_suffix()));
        let source = root.join("source");
        fs::create_dir_all(source.join("camera")).unwrap();
        fs::write(source.join("camera/0001.jpg"), b"image").unwrap();
        let publisher = ResultPublisher::open(root.join("results")).unwrap();
        let initial = fixture_result("1", "source", None);
        assert_eq!(
            publish_fixture(&publisher, &source, initial.clone()).unwrap(),
            1
        );

        let mut updated = initial;
        updated.inspection_time = Some("2026-08-11T08:00:00Z".into());
        updated.session_id = "session-updated".into();
        assert_eq!(publish_fixture(&publisher, &source, updated).unwrap(), 2);
        let stored: UnifiedResult = serde_json::from_slice(
            &fs::read(publisher.root().join("records/1/result.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(stored.session_id, "session-updated");
        assert_eq!(
            stored.inspection_time.as_deref(),
            Some("2026-08-11T08:00:00Z")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn database_execute_failure_restores_the_previous_record_directory() {
        let root = std::env::temp_dir().join(format!("steel-result-rollback-{}", unique_suffix()));
        let source = root.join("source");
        fs::create_dir_all(source.join("camera")).unwrap();
        fs::write(source.join("camera/0001.jpg"), b"image").unwrap();
        let publisher = ResultPublisher::open(root.join("results")).unwrap();
        publish_fixture(&publisher, &source, fixture_result("1", "source-old", None)).unwrap();
        publish_fixture(
            &publisher,
            &source,
            fixture_result("2", "source-two", Some("shared-defect")),
        )
        .unwrap();

        let failed = publish_fixture(
            &publisher,
            &source,
            fixture_result("1", "source-new", Some("shared-defect")),
        );
        assert!(failed.is_err());
        let stored: UnifiedResult = serde_json::from_slice(
            &fs::read(publisher.root().join("records/1/result.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(stored.source_hash, "source-old");
        assert!(stored.defects.is_empty());
        let connection = Connection::open(publisher.catalog_path()).unwrap();
        let source_hash: String = connection
            .query_row(
                "SELECT source_hash FROM production_inspection WHERE id = '1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(source_hash, "source-old");
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM production_defect WHERE inspection_id = '1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        drop(connection);

        publish_fixture(
            &publisher,
            &source,
            fixture_result("1", "source-new", Some("record-one-defect")),
        )
        .unwrap();
        let repaired: UnifiedResult = serde_json::from_slice(
            &fs::read(publisher.root().join("records/1/result.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(repaired.source_hash, "source-new");
        let _ = fs::remove_dir_all(root);
    }
}
