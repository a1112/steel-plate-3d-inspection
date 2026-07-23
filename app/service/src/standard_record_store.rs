use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfiguredCamera {
    pub id: String,
    pub display_order: usize,
    pub source_camera_id: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionRecordDto {
    pub record_id: String,
    pub steel_id: String,
    pub steel_type: Option<String>,
    pub length_mm: Option<f64>,
    pub inspection_time: Option<String>,
    pub defect_count: i64,
    pub camera_count: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionDefectDto {
    pub id: String,
    pub record_id: String,
    pub camera_id: String,
    pub sequence_no: u32,
    pub defect_type: String,
    pub severity: Option<i64>,
    pub confidence: Option<f64>,
    pub artifacts: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CaptureFileDto {
    pub id: String,
    pub record_id: String,
    pub camera_id: String,
    pub sequence_no: u32,
    pub kind: String,
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug)]
pub struct StoreError(String);

impl StoreError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self(format!("converted catalog query failed: {error}"))
    }
}

pub trait InspectionRecordStore {
    fn records(&self) -> Result<Vec<InspectionRecordDto>, StoreError>;
    fn record(&self, id: &str) -> Result<Option<InspectionRecordDto>, StoreError>;
    fn defects(&self, id: &str) -> Result<Vec<InspectionDefectDto>, StoreError>;
    fn capture_files(&self, id: &str) -> Result<Vec<CaptureFileDto>, StoreError>;
}

#[derive(Debug)]
pub struct ConvertedLocalStore {
    root: PathBuf,
    catalog_path: PathBuf,
    cameras: Vec<ConfiguredCamera>,
    camera_orders: HashMap<String, usize>,
}

impl ConvertedLocalStore {
    pub fn open(
        root: &Path,
        catalog_path: &Path,
        cameras: Vec<ConfiguredCamera>,
    ) -> Result<Self, StoreError> {
        let root = fs::canonicalize(root)
            .map_err(|error| StoreError::new(format!("converted root unavailable: {error}")))?;
        if cameras.is_empty() {
            return Err(StoreError::new("converted store camera topology is empty"));
        }
        let mut ids = HashSet::new();
        let mut camera_orders = HashMap::new();
        for (index, camera) in cameras.iter().enumerate() {
            if camera.id.trim().is_empty()
                || !ids.insert(camera.id.clone())
                || camera.display_order != index + 1
                || camera.source_camera_id == 0
            {
                return Err(StoreError::new(
                    "converted store camera topology is invalid",
                ));
            }
            camera_orders.insert(camera.id.clone(), camera.display_order);
        }
        let catalog_path = fs::canonicalize(catalog_path)
            .map_err(|error| StoreError::new(format!("converted catalog unavailable: {error}")))?;
        if !catalog_path.starts_with(&root) || !catalog_path.is_file() {
            return Err(StoreError::new(
                "converted catalog must be a file beneath converted root",
            ));
        }
        Connection::open_with_flags(
            &catalog_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(StoreError::from)?;
        Ok(Self {
            root,
            catalog_path,
            cameras,
            camera_orders,
        })
    }

    pub fn configured_cameras(&self) -> &[ConfiguredCamera] {
        &self.cameras
    }

    fn connection(&self) -> Result<Connection, StoreError> {
        Connection::open_with_flags(
            &self.catalog_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(StoreError::from)
    }

    fn validate_record_path(&self, relative: &str) -> Result<(), StoreError> {
        let relative = validated_relative(relative, "record path")?;
        if relative.components().next() != Some(Component::Normal("records".as_ref())) {
            return Err(StoreError::new(
                "converted record path must be beneath records",
            ));
        }
        let directory = fs::canonicalize(self.root.join(relative)).map_err(|error| {
            StoreError::new(format!("converted record directory unavailable: {error}"))
        })?;
        if !directory.starts_with(&self.root)
            || !directory.is_dir()
            || !directory.join("record.json").is_file()
        {
            return Err(StoreError::new(
                "converted record directory failed containment or publication checks",
            ));
        }
        Ok(())
    }

    fn record_from_row(&self, row: &Row<'_>) -> Result<InspectionRecordDto, StoreError> {
        let metadata_json: String = row.get(8)?;
        let metadata: Value = serde_json::from_str(&metadata_json)
            .map_err(|error| StoreError::new(format!("record metadata JSON invalid: {error}")))?;
        let camera_count = usize::try_from(row.get::<_, i64>(6)?)
            .map_err(|_| StoreError::new("record camera count is invalid"))?;
        if camera_count != self.cameras.len() {
            return Err(StoreError::new(format!(
                "record camera count {camera_count} does not match configured {}",
                self.cameras.len()
            )));
        }
        let record_path: String = row.get(9)?;
        self.validate_record_path(&record_path)?;
        Ok(InspectionRecordDto {
            record_id: row.get(0)?,
            steel_id: row.get(1)?,
            inspection_time: row.get(2)?,
            defect_count: row.get(5)?,
            camera_count,
            steel_type: metadata
                .get("steelType")
                .and_then(Value::as_str)
                .map(str::to_string),
            length_mm: metadata.get("lengthMm").and_then(Value::as_f64),
        })
    }

    fn query_records(&self, id: Option<&str>) -> Result<Vec<InspectionRecordDto>, StoreError> {
        let connection = self.connection()?;
        let base = r#"
            SELECT id, material_id, inspection_time, status, source_hash,
                   defect_count, camera_count, session_id, metadata_json, record_path
            FROM production_inspection
        "#;
        let mut values = Vec::new();
        if let Some(id) = id {
            let mut statement = connection.prepare(&format!("{base} WHERE id = ?"))?;
            let rows = statement.query_map([id], |row| {
                self.record_from_row(row)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
            })?;
            for row in rows {
                values.push(row.map_err(StoreError::from)?);
            }
        } else {
            let mut statement =
                connection.prepare(&format!("{base} ORDER BY inspection_time DESC, id DESC"))?;
            let rows = statement.query_map([], |row| {
                self.record_from_row(row)
                    .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
            })?;
            for row in rows {
                values.push(row.map_err(StoreError::from)?);
            }
        }
        Ok(values)
    }
}

impl InspectionRecordStore for ConvertedLocalStore {
    fn records(&self) -> Result<Vec<InspectionRecordDto>, StoreError> {
        self.query_records(None)
    }

    fn record(&self, id: &str) -> Result<Option<InspectionRecordDto>, StoreError> {
        Ok(self.query_records(Some(id))?.into_iter().next())
    }

    fn defects(&self, id: &str) -> Result<Vec<InspectionDefectDto>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, inspection_id, camera_id, sequence_no, defect_type,
                   severity, confidence, artifacts_json
            FROM production_defect
            WHERE inspection_id = ?
            ORDER BY id
            "#,
        )?;
        let rows = statement.query_map([id], |row| {
            let camera_id: String = row.get(2)?;
            if !self.camera_orders.contains_key(&camera_id) {
                return Err(rusqlite::Error::InvalidColumnName(format!(
                    "unknown configured camera {camera_id}"
                )));
            }
            let sequence_no = u32::try_from(row.get::<_, i64>(3)?).map_err(|_| {
                rusqlite::Error::IntegralValueOutOfRange(3, row.get::<_, i64>(3).unwrap_or(-1))
            })?;
            let artifacts_json: String = row.get(7)?;
            let artifacts = serde_json::from_str(&artifacts_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    7,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(InspectionDefectDto {
                id: row.get(0)?,
                record_id: row.get(1)?,
                camera_id,
                sequence_no,
                defect_type: row.get(4)?,
                severity: row.get(5)?,
                confidence: row.get(6)?,
                artifacts,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::from)
    }

    fn capture_files(&self, id: &str) -> Result<Vec<CaptureFileDto>, StoreError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, inspection_id, camera_id, sequence_no, kind, path, size, sha256
            FROM capture_file
            WHERE inspection_id = ?
            "#,
        )?;
        let rows = statement.query_map([id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?;
        let mut files = Vec::new();
        for row in rows {
            let (
                file_id,
                record_id,
                camera_id,
                sequence,
                kind,
                relative,
                declared_size,
                declared_hash,
            ) = row?;
            if !self.camera_orders.contains_key(&camera_id) {
                return Err(StoreError::new(format!(
                    "capture file references unknown configured camera {camera_id}"
                )));
            }
            let sequence_no = u32::try_from(sequence)
                .map_err(|_| StoreError::new("capture sequence is invalid"))?;
            let size = u64::try_from(declared_size)
                .map_err(|_| StoreError::new("capture size is invalid"))?;
            let relative = validated_relative(&relative, "capture path")?;
            let path = fs::canonicalize(self.root.join(relative)).map_err(|error| {
                StoreError::new(format!("indexed capture file unavailable: {error}"))
            })?;
            if !path.starts_with(&self.root) || !path.is_file() {
                return Err(StoreError::new(
                    "indexed capture file is outside converted root",
                ));
            }
            let metadata = fs::metadata(&path)
                .map_err(|error| StoreError::new(format!("capture metadata failed: {error}")))?;
            if metadata.len() != size {
                return Err(StoreError::new("indexed capture file size mismatch"));
            }
            if declared_hash.len() != 64
                || !declared_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                || sha256_file(&path)? != declared_hash.to_ascii_lowercase()
            {
                return Err(StoreError::new("indexed capture file hash mismatch"));
            }
            files.push(CaptureFileDto {
                id: file_id,
                record_id,
                camera_id,
                sequence_no,
                kind,
                path,
                size,
                sha256: declared_hash.to_ascii_lowercase(),
            });
        }
        files.sort_by_key(|file| {
            (
                self.camera_orders
                    .get(&file.camera_id)
                    .copied()
                    .unwrap_or(usize::MAX),
                file.sequence_no,
                file.kind.clone(),
            )
        });
        Ok(files)
    }
}

fn validated_relative(value: &str, label: &str) -> Result<PathBuf, StoreError> {
    let path = Path::new(value);
    if path.is_absolute()
        || value.is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(StoreError::new(format!(
            "{label} is outside the standard root"
        )));
    }
    Ok(path.to_path_buf())
}

fn sha256_file(path: &Path) -> Result<String, StoreError> {
    let mut digest = Sha256::new();
    digest.update(
        fs::read(path)
            .map_err(|error| StoreError::new(format!("capture read failed: {error}")))?,
    );
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::{
        ConfiguredCamera, ConvertedLocalStore, InspectionRecordDto, InspectionRecordStore,
    };
    use rusqlite::Connection;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        root: PathBuf,
        store: ConvertedLocalStore,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn sha256(path: &Path) -> String {
        let mut digest = Sha256::new();
        digest.update(fs::read(path).expect("fixture bytes"));
        format!("{:x}", digest.finalize())
    }

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "steel-standard-store-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        let records = root.join("records").join("10");
        fs::create_dir_all(&records).expect("record root");
        fs::write(records.join("record.json"), "{}").expect("published record marker");
        fs::create_dir_all(root.join("imports").join(".staging").join("job").join("99"))
            .expect("staging fixture");
        fs::write(
            root.join("imports")
                .join(".staging")
                .join("job")
                .join("99")
                .join("record.json"),
            "{}",
        )
        .expect("staging record");
        let catalog = root.join("catalog.db");
        let connection = Connection::open(&catalog).expect("fixture catalog");
        connection
            .execute_batch(
                r#"
                CREATE TABLE production_inspection (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    material_id TEXT NOT NULL,
                    inspection_time TEXT,
                    status TEXT NOT NULL,
                    defect_count INTEGER NOT NULL,
                    camera_count INTEGER NOT NULL,
                    source_hash TEXT NOT NULL,
                    record_path TEXT NOT NULL,
                    metadata_json TEXT NOT NULL
                );
                CREATE TABLE production_defect (
                    id TEXT PRIMARY KEY,
                    inspection_id TEXT NOT NULL,
                    camera_id TEXT NOT NULL,
                    sequence_no INTEGER NOT NULL,
                    defect_type TEXT NOT NULL,
                    severity INTEGER,
                    confidence REAL,
                    artifacts_json TEXT NOT NULL
                );
                CREATE TABLE capture_file (
                    id TEXT PRIMARY KEY,
                    inspection_id TEXT NOT NULL,
                    camera_id TEXT NOT NULL,
                    sequence_no INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    path TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    sha256 TEXT NOT NULL
                );
                INSERT INTO production_inspection VALUES (
                    '10', 'bkv-10', 'STEEL-10', '2025-09-26 03:36:17',
                    'legacy-imported', 1, 6, 'record-hash', 'records/10',
                    '{"steelType":"37Mn/2","lengthMm":12096}'
                );
                INSERT INTO production_defect VALUES (
                    '10-100', '10', 'C1', 4, '轧折', 1, 51,
                    '{"imageRect2d":{"left":0,"right":2,"top":0,"bottom":1}}'
                );
                "#,
            )
            .expect("fixture schema");
        for camera in 1..=6 {
            let relative = format!(
                "records/10/cameras/C{camera}/frames/000004/intensity.jpg"
            );
            let path = root.join(&relative);
            fs::create_dir_all(path.parent().expect("frame parent")).expect("frame root");
            image::RgbImage::from_pixel(3, 2, image::Rgb([camera as u8 * 20, 80, 90]))
                .save(&path)
                .expect("fixture frame");
            connection
                .execute(
                    "INSERT INTO capture_file VALUES (?, '10', ?, 4, 'intensity', ?, ?, ?)",
                    rusqlite::params![
                        format!("10-C{camera}-4-intensity"),
                        format!("C{camera}"),
                        relative,
                        path.metadata().expect("metadata").len(),
                        sha256(&path),
                    ],
                )
                .expect("capture row");
        }
        drop(connection);
        let cameras = (1..=6)
            .map(|camera| ConfiguredCamera {
                id: format!("C{camera}"),
                display_order: camera,
                source_camera_id: camera as u32,
            })
            .collect();
        let store =
            ConvertedLocalStore::open(&root, &catalog, cameras).expect("converted local store");
        Fixture { root, store }
    }

    #[test]
    fn reads_normalized_record_and_defect_dtos_from_catalog() {
        let fixture = fixture();

        assert_eq!(
            fixture.store.records().expect("records"),
            vec![InspectionRecordDto {
                record_id: "10".to_string(),
                steel_id: "STEEL-10".to_string(),
                steel_type: Some("37Mn/2".to_string()),
                length_mm: Some(12096.0),
                inspection_time: Some("2025-09-26 03:36:17".to_string()),
                defect_count: 1,
                camera_count: 6,
            }]
        );
        let defects = fixture.store.defects("10").expect("defects");
        assert_eq!(defects.len(), 1);
        assert_eq!(defects[0].camera_id, "C1");
        assert_eq!(defects[0].sequence_no, 4);
        assert_eq!(defects[0].defect_type, "轧折");
    }

    #[test]
    fn exposes_exactly_configured_six_camera_files_and_ignores_staging() {
        let fixture = fixture();

        let files = fixture.store.capture_files("10").expect("capture files");
        assert_eq!(files.len(), 6);
        assert_eq!(
            files
                .iter()
                .map(|file| file.camera_id.as_str())
                .collect::<Vec<_>>(),
            vec!["C1", "C2", "C3", "C4", "C5", "C6"]
        );
        assert!(fixture
            .store
            .records()
            .expect("records")
            .iter()
            .all(|record| record.record_id != "99"));
        assert!(!files.iter().any(|file| file.camera_id == "C7"));
    }

    #[test]
    fn indexed_file_path_and_hash_fail_closed() {
        let fixture = fixture();
        let outside = fixture.root.parent().expect("parent").join(format!(
            "{}-outside.jpg",
            fixture.root.file_name().expect("root name").to_string_lossy()
        ));
        fs::write(&outside, b"outside").expect("outside fixture");
        let connection = Connection::open(fixture.root.join("catalog.db")).expect("catalog");
        connection
            .execute(
                "UPDATE capture_file SET path = ? WHERE id = '10-C1-4-intensity'",
                [outside.display().to_string()],
            )
            .expect("escape row");
        drop(connection);
        assert!(fixture.store.capture_files("10").is_err());

        let connection = Connection::open(fixture.root.join("catalog.db")).expect("catalog");
        connection
            .execute(
                "UPDATE capture_file SET path = 'records/10/cameras/C1/frames/000004/intensity.jpg', sha256 = '00' WHERE id = '10-C1-4-intensity'",
                [],
            )
            .expect("hash row");
        drop(connection);
        let error = fixture
            .store
            .capture_files("10")
            .expect_err("invalid hash must fail");
        assert!(error.to_string().contains("hash"));
        let _ = fs::remove_file(outside);
    }
}
