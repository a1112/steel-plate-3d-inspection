use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand_core::OsRng;
use sea_orm::{
    sea_query::Expr, ActiveModelTrait, ColumnTrait, ConnectOptions, ConnectionTrait, Database,
    DatabaseConnection, DbBackend, DbErr, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    QuerySelect, Set, Statement, TransactionTrait,
};
use serde_json::{self, json, Value};
use std::env;
use std::path::PathBuf;
use std::time::Duration;

pub mod entities;

use entities::{
    admin_role, admin_user, app_config, audit_log, calibration_operation, camera_config,
    capture_file, config_revision, defect, defect_type, inspection_record, material_session,
    production_alarm, production_defect, production_inspection, production_task, record_cleanup,
    secondary_data, steel_plate, trigger_event,
};

pub const DEVELOPMENT_DEFAULT_ADMIN_PASSWORD: &str = "admin123";
pub const DATABASE_SCHEMA_VERSION: i64 = 1;
pub const NON_PRODUCTION_DATABASE_ENGINES: [&str; 3] = ["sqlite", "mysql", "postgres"];
pub const PRODUCTION_DATABASE_ENGINES: [&str; 2] = ["sqlite", "mysql"];

fn production_security_policy_enabled() -> bool {
    if cfg!(test) {
        return false;
    }
    !matches!(
        env::var("STEEL_RUNTIME_PROFILE")
            .unwrap_or_else(|_| "production".to_string())
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "development" | "dev" | "test"
    )
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn production_mysql_rejects_default_credentials_and_plaintext_remote_hosts() {
        assert!(normalize_database_url(
            "mysql://root:Strong%21Password1@127.0.0.1:3306/steel_inspection",
            true
        )
        .is_err());
        assert!(normalize_database_url(
            "mysql://steel_service:nercar@127.0.0.1:3306/steel_inspection",
            true
        )
        .is_err());
        assert!(normalize_database_url(
            "mysql://steel_service:Strong%21Password1@10.0.0.8:3306/steel_inspection",
            true
        )
        .is_err());
        assert!(normalize_database_url(
            "mysql://steel_service:Strong%21Password1@10.0.0.8:3306/steel_inspection?ssl-mode=disabled",
            true
        )
        .is_err());
        assert!(normalize_database_url(
            "mysql://steel_service:Strong%21Password1@10.0.0.8:3306/steel_inspection?ssl-mode=required",
            true
        )
        .is_err());
    }

    #[test]
    fn production_mysql_accepts_strict_remote_tls_and_redacts_credentials() {
        let url = normalize_database_url(
            "mysql://steel_service:Strong%21Password1@10.0.0.8:3306/steel_inspection?ssl-mode=verify-identity",
            true,
        )
        .expect("strict remote TLS URL");
        assert_eq!(
            redact_database_url(&url),
            "mysql://10.0.0.8:3306/steel_inspection?ssl-mode=verify-identity"
        );
        assert!(!redact_database_url(&url).contains("Password"));
    }

    #[test]
    fn development_mysql_compatibility_does_not_weaken_production() {
        let development =
            normalize_database_url("mysql://root:nercar@127.0.0.1:3306/steel_inspection", false)
                .expect("development URL");
        assert!(development.ends_with("ssl-mode=disabled"));
        let production = normalize_database_url(
            "mysql://steel_service:Strong%21Password1@127.0.0.1:3306/steel_inspection",
            true,
        )
        .expect("local production URL");
        assert!(production.ends_with("ssl-mode=disabled"));
    }

    #[test]
    fn postgres_is_a_non_production_adapter_and_fallback_is_fail_closed_in_production() {
        let development = normalize_database_url(
            "postgres://postgres:postgres@127.0.0.1:5432/steel_inspection?sslmode=disable",
            false,
        )
        .expect("development postgres URL");
        assert_eq!(
            database_engine_from_url(&development).expect("postgres engine"),
            "postgres"
        );
        assert!(normalize_database_url(&development, true).is_err());
        assert_eq!(
            database_fallback_policy(Some("sqlite"), false).expect("development fallback"),
            DatabaseFallback::Sqlite
        );
        assert!(database_fallback_policy(Some("sqlite"), true).is_err());
        assert!(database_fallback_policy(Some("postgres"), false).is_err());
    }

    #[test]
    fn explicit_non_production_fallback_uses_sqlite_when_primary_is_unreachable() {
        let runtime = tokio::runtime::Runtime::new().expect("test runtime");
        runtime.block_on(async {
            let path = env::temp_dir().join(format!(
                "steel-database-fallback-{}-{}.sqlite",
                std::process::id(),
                now_nanos_string()
            ));
            let database = open_database_request(
                DatabaseRequest {
                    url:
                        "postgres://postgres:postgres@127.0.0.1:9/steel_inspection?sslmode=disable"
                            .to_string(),
                    engine: "postgres".to_string(),
                    fallback: DatabaseFallback::Sqlite,
                },
                path.clone(),
                false,
            )
            .await
            .expect("explicit SQLite fallback");
            assert_eq!(database.engine, "sqlite");
            assert_eq!(database.requested_engine, "postgres");
            assert!(database.fallback_enabled);
            assert!(database.fallback_active);
            assert_eq!(
                database.fallback_reason.as_deref(),
                Some("primary_connection_failed")
            );
            database
                .connection
                .close_by_ref()
                .await
                .expect("fallback database close");
            let _ = std::fs::remove_file(path);
        });
    }

    #[test]
    fn fallback_does_not_hide_a_connected_primary_schema_failure() {
        let runtime = tokio::runtime::Runtime::new().expect("test runtime");
        runtime.block_on(async {
            let suffix = format!("{}-{}", std::process::id(), now_nanos_string());
            let primary_path =
                env::temp_dir().join(format!("steel-database-primary-invalid-{suffix}.sqlite"));
            let fallback_path =
                env::temp_dir().join(format!("steel-database-fallback-unused-{suffix}.sqlite"));
            let primary_url = format!("sqlite://{}?mode=rwc", primary_path.display());
            let primary = connect_database(&primary_url)
                .await
                .expect("primary sqlite connection");
            execute(
                &primary,
                "CREATE TABLE steel_schema_state (singleton_id INTEGER PRIMARY KEY)",
            )
            .await
            .expect("partial schema ledger");
            primary
                .close_by_ref()
                .await
                .expect("primary database close");

            let result = open_database_request(
                DatabaseRequest {
                    url: primary_url,
                    engine: "postgres".to_string(),
                    fallback: DatabaseFallback::Sqlite,
                },
                fallback_path.clone(),
                false,
            )
            .await;
            let error = match result {
                Ok(_) => panic!("schema failures must not activate fallback"),
                Err(error) => error,
            };
            assert!(error.to_string().contains("schema ledger is incomplete"));
            assert!(!fallback_path.exists());
            let _ = std::fs::remove_file(primary_path);
            let _ = std::fs::remove_file(fallback_path);
        });
    }

    #[test]
    fn bootstrap_admin_password_requires_a_strong_non_default_secret() {
        assert!(validate_bootstrap_admin_password("admin123").is_err());
        assert!(validate_bootstrap_admin_password("onlylowercase123!").is_err());
        assert!(validate_bootstrap_admin_password("StrongBootstrap1!").is_ok());
    }

    #[test]
    fn production_bootstrap_creates_one_admin_and_rejects_development_passwords() {
        let runtime = tokio::runtime::Runtime::new().expect("test runtime");
        runtime.block_on(async {
            let production = Database::connect("sqlite::memory:")
                .await
                .expect("production memory database");
            create_schema(&production).await.expect("production schema");
            assert!(ensure_admin_data_with_policy(&production, true, None)
                .await
                .is_err());
            ensure_admin_data_with_policy(&production, true, Some("StrongBootstrap1!"))
                .await
                .expect("production bootstrap");
            let users = admin_user::Entity::find()
                .all(&production)
                .await
                .expect("production users");
            assert_eq!(users.len(), 1);
            assert_eq!(users[0].id, "admin");
            assert!(users[0].must_change_password);
            assert!(verify_admin_password(&users[0], "StrongBootstrap1!"));
            update_admin_user_password(
                &production,
                "admin",
                &hash_admin_password("admin", "ChangedPassword2!"),
            )
            .await
            .expect("change bootstrap password");
            let changed = find_admin_user(&production, "admin")
                .await
                .expect("changed user query")
                .expect("changed user");
            assert!(!changed.must_change_password);

            let development = Database::connect("sqlite::memory:")
                .await
                .expect("development memory database");
            create_schema(&development)
                .await
                .expect("development schema");
            ensure_admin_data_with_policy(&development, false, None)
                .await
                .expect("development bootstrap");
            let error = ensure_admin_data_with_policy(&development, true, None)
                .await
                .expect_err("production must reject development passwords");
            assert!(error.to_string().contains("development default password"));
        });
    }

    #[test]
    fn production_schema_contract_rejects_unversioned_or_dirty_databases() {
        let runtime = tokio::runtime::Runtime::new().expect("test runtime");
        runtime.block_on(async {
            let fresh = Database::connect("sqlite::memory:")
                .await
                .expect("fresh memory database");
            assert_eq!(
                prepare_schema(&fresh, true)
                    .await
                    .expect("fresh production schema"),
                DATABASE_SCHEMA_VERSION
            );
            assert_eq!(
                prepare_schema(&fresh, true)
                    .await
                    .expect("versioned production schema"),
                DATABASE_SCHEMA_VERSION
            );

            execute(
                &fresh,
                "UPDATE steel_schema_state SET dirty = 1, active_migration_id = 'test' WHERE singleton_id = 1",
            )
            .await
            .expect("mark schema dirty");
            let dirty_error = prepare_schema(&fresh, true)
                .await
                .expect_err("dirty schema must fail closed");
            assert!(dirty_error.to_string().contains("dirty or has an active migration"));
            execute(
                &fresh,
                "UPDATE steel_schema_state SET current_version = 2, dirty = 0, active_migration_id = '' WHERE singleton_id = 1",
            )
            .await
            .expect("mark schema unreadable");
            let version_error = prepare_schema(&fresh, true)
                .await
                .expect_err("unreadable schema version must fail closed");
            assert!(version_error.to_string().contains("outside this service's readable range"));

            let unversioned = Database::connect("sqlite::memory:")
                .await
                .expect("legacy memory database");
            execute(&unversioned, "CREATE TABLE legacy_data (id INTEGER PRIMARY KEY)")
                .await
                .expect("legacy table");
            let legacy_error = prepare_schema(&unversioned, true)
                .await
                .expect_err("unversioned production database must fail closed");
            assert!(legacy_error
                .to_string()
                .contains("unversioned non-empty production database"));
        });
    }
}

#[derive(Clone)]
pub struct AppDatabase {
    pub connection: DatabaseConnection,
    pub path: PathBuf,
    pub engine: String,
    pub url: String,
    pub file_path: Option<PathBuf>,
    pub schema_version: i64,
    pub requested_engine: String,
    pub fallback_enabled: bool,
    pub fallback_active: bool,
    pub fallback_reason: Option<String>,
}

impl AppDatabase {
    pub fn display_path(&self) -> String {
        self.file_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| self.url.clone())
    }

    pub fn supported_engines(&self) -> &'static [&'static str] {
        if production_security_policy_enabled() {
            &PRODUCTION_DATABASE_ENGINES
        } else {
            &NON_PRODUCTION_DATABASE_ENGINES
        }
    }
}

#[derive(Clone)]
pub struct AppConfigValue {
    pub value: String,
}

#[derive(Clone)]
pub struct DatabaseSnapshot {
    pub plates: Vec<steel_plate::Model>,
    pub defects: Vec<defect::Model>,
    pub defect_types: Vec<defect_type::Model>,
    pub records: Vec<inspection_record::Model>,
}

#[derive(Clone)]
pub struct AdminDatabaseMetrics {
    pub plate_count: u64,
    pub defect_count: u64,
    pub defect_type_count: u64,
    pub record_count: u64,
    pub camera_count: u64,
    pub config_count: u64,
    pub config_revision_count: u64,
    pub user_count: u64,
    pub role_count: u64,
    pub audit_log_count: u64,
    pub material_session_count: u64,
    pub secondary_data_count: u64,
    pub trigger_event_count: u64,
    pub production_inspection_count: u64,
    pub production_task_count: u64,
    pub calibration_operation_count: u64,
    pub capture_file_count: u64,
    pub production_defect_count: u64,
    pub production_alarm_count: u64,
}

#[derive(Clone)]
pub struct AdminOverview {
    pub metrics: AdminDatabaseMetrics,
    pub configs: Vec<app_config::Model>,
    pub users: Vec<admin_user::Model>,
    pub roles: Vec<admin_role::Model>,
    pub audit_logs: Vec<audit_log::Model>,
}

#[derive(Clone, Debug)]
pub struct DatabaseMaintenanceStats {
    pub page_count: u64,
    pub page_size: u64,
    pub freelist_count: u64,
}

#[derive(Clone)]
pub struct AdminUserInput {
    pub id: String,
    pub display_name: String,
    pub role: String,
    pub status: String,
    pub password_hash: Option<String>,
    pub last_login_at: String,
}

#[derive(Clone)]
pub struct AdminRoleInput {
    pub id: String,
    pub label: String,
    pub description: String,
    pub permissions: String,
    pub status: String,
}

#[derive(Clone)]
pub struct CameraConfigInput {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub driver_id: String,
    pub model_hint: String,
    pub role: String,
    pub enabled: bool,
    pub trigger_mode: String,
    pub exposure_us: i32,
    pub gain: f64,
    pub depth_lines: i32,
    pub output_path: String,
}

#[derive(Clone, Debug)]
pub struct DefectTypeInput {
    pub id: String,
    pub label: String,
    pub color: String,
    pub shape: String,
}

#[derive(Clone, Debug)]
pub struct MaterialSessionInput {
    pub id: String,
    pub material_id: String,
    pub source: String,
    pub status: String,
    pub control_mode: String,
    pub trigger_mode: String,
    pub steel_type: String,
    pub width_mm: f64,
    pub length_mm: f64,
    pub thickness_mm: f64,
    pub client: String,
    pub hard: String,
    pub storage_root: String,
    pub started_at: String,
    pub finished_at: String,
    pub raw_payload: String,
}

#[derive(Clone, Debug)]
pub struct SecondaryDataInput {
    pub material_id: String,
    pub session_id: String,
    pub source: String,
    pub payload_type: String,
    pub payload: String,
}

#[derive(Clone, Debug)]
pub struct TriggerEventInput {
    pub material_id: String,
    pub session_id: String,
    pub source: String,
    pub mode: String,
    pub event_type: String,
    pub command: String,
    pub value: i32,
    pub payload: String,
    pub provider_code: i32,
    pub provider_response: String,
}

#[derive(Clone, Debug)]
pub struct ProductionInspectionInput {
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
pub struct ProductionTaskInput {
    pub id: String,
    pub idempotency_key: String,
    pub kind: String,
    pub material_id: String,
    pub session_id: String,
    pub chain_id: String,
    pub depends_on_task_id: String,
    pub dependency_policy: String,
    pub payload: String,
    pub actor: String,
    pub max_attempts: i32,
}

#[derive(Clone, Debug)]
pub struct CalibrationOperationInput {
    pub id: String,
    pub kind: String,
    pub request_hash: String,
    pub request_json: String,
    pub actor: String,
    pub parent_operation_id: String,
}

#[derive(Clone, Default)]
pub struct ProductionTaskFilter {
    pub status: Option<String>,
    pub kind: Option<String>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

#[derive(Clone)]
pub struct ProductionTaskPage {
    pub tasks: Vec<production_task::Model>,
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
}

#[derive(Clone, Debug)]
pub struct CaptureFileInput {
    pub inspection_id: String,
    pub session_id: String,
    pub material_id: String,
    pub camera_id: String,
    pub camera_ip: String,
    pub data_name: String,
    pub sequence_no: i32,
    pub file_type: String,
    pub path: String,
    pub metadata_path: String,
}

#[derive(Clone, Debug)]
pub struct ProductionDefectInput {
    pub inspection_id: String,
    pub material_id: String,
    pub camera_id: String,
    pub defect_type: String,
    pub severity: String,
    pub x_mm: f64,
    pub y_mm: f64,
    pub z_mm: f64,
    pub width_mm: f64,
    pub height_mm: f64,
    pub depth_mm: f64,
    pub confidence: f64,
    pub geometry_json: String,
}

#[derive(Clone, Debug)]
pub struct ProductionAlarmInput {
    pub id: String,
    pub source: String,
    pub alarm_type: String,
    pub severity: String,
    pub material_id: String,
    pub session_id: String,
    pub inspection_id: String,
    pub camera_id: String,
    pub message: String,
    pub details: String,
}

#[derive(Clone, Default)]
pub struct ProductionAlarmFilter {
    pub status: Option<String>,
    pub severity: Option<String>,
    pub source: Option<String>,
    pub keyword: Option<String>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

#[derive(Clone)]
pub struct ProductionAlarmPage {
    pub alarms: Vec<production_alarm::Model>,
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
}

#[derive(Clone, Default)]
pub struct ProductionAlarmCounts {
    pub active: u64,
    pub acknowledged: u64,
    pub resolved: u64,
}

#[derive(Clone)]
pub enum ProductionAlarmTransition {
    Changed(production_alarm::Model),
    Unchanged(production_alarm::Model),
    Conflict(production_alarm::Model),
    NotFound,
}

#[derive(Clone)]
pub enum ManagedAlarmReconcile {
    Created(production_alarm::Model),
    Updated(production_alarm::Model),
    Resolved(production_alarm::Model),
    Unchanged,
    Absent,
}

#[derive(Clone, Default)]
pub struct AuditLogFilter {
    pub keyword: Option<String>,
    pub level: Option<String>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

#[derive(Clone, Default)]
pub struct InspectionRecordFilter {
    pub keyword: Option<String>,
    pub status: Option<String>,
    pub limit: Option<u64>,
    pub offset: Option<u64>,
}

#[derive(Clone)]
pub struct AdminInspectionRecord {
    pub inspection: production_inspection::Model,
    pub session: Option<material_session::Model>,
    pub severe_count: u64,
    pub review_count: u64,
    pub minor_count: u64,
}

#[derive(Clone)]
pub struct AdminInspectionRecordPage {
    pub records: Vec<AdminInspectionRecord>,
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
}

#[derive(Clone)]
pub struct AdminInspectionRecordDetail {
    pub record: AdminInspectionRecord,
    pub defects: Vec<production_defect::Model>,
    pub capture_files: Vec<capture_file::Model>,
}

#[derive(Clone)]
pub struct DeleteInspectionRecordResult {
    pub id: String,
    pub material_id: String,
    pub defects_deleted: u64,
    pub capture_files_deleted: u64,
}

#[cfg(test)]
#[derive(Clone)]
pub struct InspectionRecordRetentionResult {
    pub matched: u64,
    pub deleted_records: u64,
    pub deleted_defects: u64,
    pub deleted_capture_files: u64,
}

#[derive(Clone)]
pub struct RecordCleanupInput {
    pub record_id: String,
    pub material_id: String,
    pub actor: String,
    pub reason: String,
    pub manifest_json: String,
    pub files_planned: i32,
    pub bytes_planned: i64,
}

#[derive(Clone)]
pub struct AdminAuditLogPage {
    pub logs: Vec<audit_log::Model>,
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DatabaseFallback {
    None,
    Sqlite,
}

#[derive(Clone, Debug)]
struct DatabaseRequest {
    url: String,
    engine: String,
    fallback: DatabaseFallback,
}

pub async fn open_database(path: PathBuf) -> Result<AppDatabase, DbErr> {
    let production_policy = production_security_policy_enabled();
    let request = configured_database_request(&path, production_policy)?;
    open_database_request(request, path, production_policy).await
}

fn configured_database_request(
    path: &PathBuf,
    production_policy: bool,
) -> Result<DatabaseRequest, DbErr> {
    let fallback = database_fallback_policy(
        env::var("STEEL_DATABASE_FALLBACK").ok().as_deref(),
        production_policy,
    )?;
    if let Ok(url) = env::var("STEEL_DATABASE_URL") {
        let url = normalize_database_url(url.trim(), production_policy)?;
        if !url.is_empty() {
            return Ok(DatabaseRequest {
                engine: database_engine_from_url(&url)?.to_string(),
                url,
                fallback,
            });
        }
    }

    let engine = env::var("STEEL_DATABASE_ENGINE")
        .unwrap_or_else(|_| "sqlite".to_string())
        .trim()
        .to_ascii_lowercase();
    let url = match engine.as_str() {
        "" | "sqlite" | "sqlite3" => format!("sqlite://{}?mode=rwc", path.display()),
        "mysql" => {
            let host = env::var("STEEL_MYSQL_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
            let port = env::var("STEEL_MYSQL_PORT").unwrap_or_else(|_| "3306".to_string());
            let user = required_production_database_setting(
                "STEEL_MYSQL_USER",
                "root",
                production_policy,
            )?;
            let password = required_production_database_setting(
                "STEEL_MYSQL_PASSWORD",
                "nercar",
                production_policy,
            )?;
            let database =
                env::var("STEEL_MYSQL_DATABASE").unwrap_or_else(|_| "steel_inspection".to_string());
            normalize_database_url(
                &format!(
                    "mysql://{}:{}@{}:{}/{}",
                    percent_encode_url_component(&user),
                    percent_encode_url_component(&password),
                    host,
                    port,
                    mysql_identifier(&database)?
                ),
                production_policy,
            )?
        }
        "postgres" | "postgresql" if production_policy => {
            return Err(DbErr::Custom(
                "PostgreSQL is available only in non-production runtime profiles".to_string(),
            ));
        }
        "postgres" | "postgresql" => {
            let host = env::var("STEEL_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
            let port = env::var("STEEL_POSTGRES_PORT").unwrap_or_else(|_| "5432".to_string());
            let user = env::var("STEEL_POSTGRES_USER").unwrap_or_else(|_| "postgres".to_string());
            let password =
                env::var("STEEL_POSTGRES_PASSWORD").unwrap_or_else(|_| "postgres".to_string());
            let database = env::var("STEEL_POSTGRES_DATABASE")
                .unwrap_or_else(|_| "steel_inspection".to_string());
            let ssl_mode =
                env::var("STEEL_POSTGRES_SSL_MODE").unwrap_or_else(|_| "disable".to_string());
            normalize_database_url(
                &format!(
                    "postgres://{}:{}@{}:{}/{}?sslmode={}",
                    percent_encode_url_component(&user),
                    percent_encode_url_component(&password),
                    host,
                    port,
                    postgres_identifier(&database)?,
                    percent_encode_url_component(&ssl_mode)
                ),
                false,
            )?
        }
        other => {
            return Err(DbErr::Custom(format!(
                "unsupported STEEL_DATABASE_ENGINE '{other}'; expected sqlite, mysql, or postgres"
            )));
        }
    };
    Ok(DatabaseRequest {
        engine: database_engine_from_url(&url)?.to_string(),
        url,
        fallback,
    })
}

fn database_fallback_policy(
    value: Option<&str>,
    production_policy: bool,
) -> Result<DatabaseFallback, DbErr> {
    let fallback = match value.unwrap_or("none").trim().to_ascii_lowercase().as_str() {
        "" | "none" | "off" | "disabled" | "0" => DatabaseFallback::None,
        "sqlite" | "sqlite3" => DatabaseFallback::Sqlite,
        other => {
            return Err(DbErr::Custom(format!(
                "unsupported STEEL_DATABASE_FALLBACK '{other}'; expected none or sqlite"
            )));
        }
    };
    if production_policy && fallback != DatabaseFallback::None {
        return Err(DbErr::Custom(
            "database fallback is forbidden in production; startup must fail closed".to_string(),
        ));
    }
    Ok(fallback)
}

fn database_engine_from_url(url: &str) -> Result<&'static str, DbErr> {
    let normalized = url.trim().to_ascii_lowercase();
    if normalized.starts_with("sqlite:") {
        Ok("sqlite")
    } else if normalized.starts_with("mysql://") || normalized.starts_with("mysqlx://") {
        Ok("mysql")
    } else if normalized.starts_with("postgres://") || normalized.starts_with("postgresql://") {
        Ok("postgres")
    } else {
        Err(DbErr::Custom(
            "STEEL_DATABASE_URL must use sqlite, mysql, or postgres".to_string(),
        ))
    }
}

fn database_connect_timeout_ms() -> u64 {
    env::var("STEEL_DATABASE_CONNECT_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(5_000)
        .clamp(100, 30_000)
}

async fn connect_database(url: &str) -> Result<DatabaseConnection, DbErr> {
    let mut options = ConnectOptions::new(url.to_string());
    options.connect_timeout(Duration::from_millis(database_connect_timeout_ms()));
    Database::connect(options).await
}

async fn connect_requested_database(url: &str) -> Result<DatabaseConnection, DbErr> {
    if database_engine_from_url(url)? == "mysql" {
        ensure_mysql_database(url).await?;
    }
    connect_database(url).await
}

async fn open_database_request(
    request: DatabaseRequest,
    fallback_path: PathBuf,
    production_policy: bool,
) -> Result<AppDatabase, DbErr> {
    match connect_requested_database(&request.url).await {
        Ok(connection) => {
            initialize_database(
                connection,
                request.url,
                fallback_path,
                production_policy,
                request.engine,
                request.fallback != DatabaseFallback::None,
                false,
                None,
            )
            .await
        }
        Err(primary_error)
            if !production_policy
                && request.fallback == DatabaseFallback::Sqlite
                && request.engine != "sqlite" =>
        {
            eprintln!(
                "database adapter {} unavailable; using explicit non-production SQLite fallback: {}",
                request.engine, primary_error
            );
            let fallback_url = format!("sqlite://{}?mode=rwc", fallback_path.display());
            let connection = connect_database(&fallback_url).await?;
            initialize_database(
                connection,
                fallback_url,
                fallback_path,
                false,
                request.engine,
                true,
                true,
                Some("primary_connection_failed".to_string()),
            )
            .await
        }
        Err(error) => Err(error),
    }
}

async fn initialize_database(
    connection: DatabaseConnection,
    url: String,
    fallback_path: PathBuf,
    production_policy: bool,
    requested_engine: String,
    fallback_enabled: bool,
    fallback_active: bool,
    fallback_reason: Option<String>,
) -> Result<AppDatabase, DbErr> {
    let schema_version = prepare_schema(&connection, production_policy).await?;
    seed_database(&connection).await?;
    let engine = match connection.get_database_backend() {
        DbBackend::MySql => "mysql",
        DbBackend::Postgres => "postgres",
        DbBackend::Sqlite => "sqlite",
    }
    .to_string();
    let file_path = (engine == "sqlite").then_some(fallback_path.clone());
    Ok(AppDatabase {
        connection,
        path: fallback_path,
        engine,
        url: redact_database_url(&url),
        file_path,
        schema_version,
        requested_engine,
        fallback_enabled,
        fallback_active,
        fallback_reason,
    })
}

fn required_production_database_setting(
    name: &str,
    development_default: &str,
    production_policy: bool,
) -> Result<String, DbErr> {
    match env::var(name).ok().filter(|value| !value.trim().is_empty()) {
        Some(value) => Ok(value),
        None if production_policy => Err(DbErr::Custom(format!(
            "{name} is required when STEEL_DATABASE_ENGINE=mysql in production"
        ))),
        None => Ok(development_default.to_string()),
    }
}

fn normalize_database_url(url: &str, production_policy: bool) -> Result<String, DbErr> {
    if url.trim().is_empty() {
        return Ok(String::new());
    }
    let engine = database_engine_from_url(url)?;
    if engine == "postgres" {
        if production_policy {
            return Err(DbErr::Custom(
                "PostgreSQL is available only in non-production runtime profiles".to_string(),
            ));
        }
        return Ok(url.to_string());
    }
    if engine != "mysql" {
        return Ok(url.to_string());
    }
    if production_policy {
        validate_production_mysql_url(url)?;
    }
    if mysql_ssl_mode(url).is_none() {
        let separator = if url.contains('?') { '&' } else { '?' };
        Ok(format!("{url}{separator}ssl-mode=disabled"))
    } else {
        Ok(url.to_string())
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

fn validate_production_mysql_url(url: &str) -> Result<(), DbErr> {
    let (user, password, host) = mysql_connection_identity(url).ok_or_else(|| {
        DbErr::Custom("production MySQL URL must include user, password, host, and database".into())
    })?;
    if user.eq_ignore_ascii_case("root") {
        return Err(DbErr::Custom(
            "production MySQL must not use the root account".to_string(),
        ));
    }
    if password.is_empty() || password.eq_ignore_ascii_case("nercar") {
        return Err(DbErr::Custom(
            "production MySQL requires a non-default password".to_string(),
        ));
    }
    if !mysql_host_is_loopback(&host) {
        let ssl_mode = mysql_ssl_mode(url).unwrap_or_default();
        if !matches!(ssl_mode.as_str(), "verify-ca" | "verify-identity") {
            return Err(DbErr::Custom(
                "remote production MySQL requires ssl-mode=verify-ca or verify-identity"
                    .to_string(),
            ));
        }
    }
    Ok(())
}

fn mysql_connection_identity(url: &str) -> Option<(String, String, String)> {
    let (_, remainder) = url.split_once("://")?;
    let (authority, database_and_query) = remainder.split_once('/')?;
    if database_and_query.split('?').next()?.trim().is_empty() {
        return None;
    }
    let (user_info, host_port) = authority.rsplit_once('@')?;
    let (user, password) = user_info.split_once(':')?;
    let host = if let Some(ipv6) = host_port.strip_prefix('[') {
        ipv6.split(']').next()?.to_string()
    } else {
        host_port
            .rsplit_once(':')
            .filter(|(_, port)| port.chars().all(|ch| ch.is_ascii_digit()))
            .map(|(host, _)| host)
            .unwrap_or(host_port)
            .to_string()
    };
    Some((
        percent_decode_url_component(user),
        percent_decode_url_component(password),
        host,
    ))
}

fn percent_decode_url_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &value[index + 1..index + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn mysql_host_is_loopback(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    )
}

fn mysql_ssl_mode(url: &str) -> Option<String> {
    url.split_once('?')?.1.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        key.eq_ignore_ascii_case("ssl-mode").then(|| {
            percent_decode_url_component(value)
                .trim()
                .to_ascii_lowercase()
        })
    })
}

fn redact_database_url(url: &str) -> String {
    let Some((scheme, remainder)) = url.split_once("://") else {
        return url.to_string();
    };
    let Some((authority, suffix)) = remainder.split_once('/') else {
        return format!("{scheme}://<redacted>");
    };
    let redacted_authority = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    format!("{scheme}://{redacted_authority}/{suffix}")
}

#[cfg(test)]
pub async fn open_database_url(url: String, fallback_path: PathBuf) -> Result<AppDatabase, DbErr> {
    let production_policy = production_security_policy_enabled();
    let url = normalize_database_url(&url, production_policy)?;
    let engine = database_engine_from_url(&url)?.to_string();
    open_database_request(
        DatabaseRequest {
            url,
            engine,
            fallback: DatabaseFallback::None,
        },
        fallback_path,
        production_policy,
    )
    .await
}

async fn ensure_mysql_database(url: &str) -> Result<(), DbErr> {
    let Some(database_name) = mysql_database_name(url) else {
        return Ok(());
    };
    let Some(server_url) = mysql_server_url(url) else {
        return Ok(());
    };
    let admin = connect_database(&server_url).await?;
    let sql = format!(
        "CREATE DATABASE IF NOT EXISTS `{}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
        mysql_identifier(&database_name)?
    );
    admin
        .execute(Statement::from_string(DbBackend::MySql, sql))
        .await?;
    Ok(())
}

fn mysql_database_name(url: &str) -> Option<String> {
    let without_query = url.split('?').next().unwrap_or(url);
    let name = without_query.rsplit('/').next()?.trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn mysql_server_url(url: &str) -> Option<String> {
    let query = url.find('?').map(|index| &url[index..]).unwrap_or_default();
    let without_query = url.split('?').next().unwrap_or(url);
    let (server, database) = without_query.rsplit_once('/')?;
    if database.is_empty() {
        return None;
    }
    Some(format!("{server}{query}"))
}

fn mysql_identifier(value: &str) -> Result<String, DbErr> {
    if !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        Ok(value.to_string())
    } else {
        Err(DbErr::Custom(
            "mysql database name must use ASCII letters, digits, or underscore".to_string(),
        ))
    }
}

fn postgres_identifier(value: &str) -> Result<String, DbErr> {
    mysql_identifier(value).map_err(|_| {
        DbErr::Custom(
            "postgres database name must use ASCII letters, digits, or underscore".to_string(),
        )
    })
}

pub async fn load_snapshot(connection: &DatabaseConnection) -> Result<DatabaseSnapshot, DbErr> {
    Ok(DatabaseSnapshot {
        plates: steel_plate::Entity::find().all(connection).await?,
        defects: defect::Entity::find().all(connection).await?,
        defect_types: defect_type::Entity::find().all(connection).await?,
        records: inspection_record::Entity::find().all(connection).await?,
    })
}

pub async fn load_admin_overview(connection: &DatabaseConnection) -> Result<AdminOverview, DbErr> {
    Ok(AdminOverview {
        metrics: AdminDatabaseMetrics {
            plate_count: steel_plate::Entity::find().count(connection).await?,
            defect_count: defect::Entity::find().count(connection).await?,
            defect_type_count: defect_type::Entity::find().count(connection).await?,
            record_count: inspection_record::Entity::find().count(connection).await?,
            camera_count: camera_config::Entity::find().count(connection).await?,
            config_count: app_config::Entity::find().count(connection).await?,
            config_revision_count: config_revision::Entity::find().count(connection).await?,
            user_count: admin_user::Entity::find().count(connection).await?,
            role_count: admin_role::Entity::find().count(connection).await?,
            audit_log_count: audit_log::Entity::find().count(connection).await?,
            material_session_count: material_session::Entity::find().count(connection).await?,
            secondary_data_count: secondary_data::Entity::find().count(connection).await?,
            trigger_event_count: trigger_event::Entity::find().count(connection).await?,
            production_inspection_count: production_inspection::Entity::find()
                .count(connection)
                .await?,
            production_task_count: production_task::Entity::find().count(connection).await?,
            calibration_operation_count: calibration_operation::Entity::find()
                .count(connection)
                .await?,
            capture_file_count: capture_file::Entity::find().count(connection).await?,
            production_defect_count: production_defect::Entity::find().count(connection).await?,
            production_alarm_count: production_alarm::Entity::find().count(connection).await?,
        },
        configs: app_config::Entity::find()
            .order_by_asc(app_config::Column::Key)
            .all(connection)
            .await?,
        users: list_admin_users(connection).await?,
        roles: list_admin_roles(connection).await?,
        audit_logs: list_audit_logs(
            connection,
            AuditLogFilter {
                limit: Some(20),
                ..AuditLogFilter::default()
            },
        )
        .await?,
    })
}

async fn sqlite_u64_metric(
    connection: &DatabaseConnection,
    sql: &str,
    column: &str,
) -> Result<u64, DbErr> {
    let Some(row) = connection
        .query_one(Statement::from_string(
            connection.get_database_backend(),
            sql.to_string(),
        ))
        .await?
    else {
        return Ok(0);
    };
    let value: i64 = row.try_get("", column)?;
    Ok(value.max(0) as u64)
}

pub async fn database_maintenance_stats(
    connection: &DatabaseConnection,
) -> Result<DatabaseMaintenanceStats, DbErr> {
    if connection.get_database_backend() != DbBackend::Sqlite {
        return Ok(DatabaseMaintenanceStats {
            page_count: 0,
            page_size: 0,
            freelist_count: 0,
        });
    }
    Ok(DatabaseMaintenanceStats {
        page_count: sqlite_u64_metric(
            connection,
            "SELECT page_count AS value FROM pragma_page_count",
            "value",
        )
        .await?,
        page_size: sqlite_u64_metric(
            connection,
            "SELECT page_size AS value FROM pragma_page_size",
            "value",
        )
        .await?,
        freelist_count: sqlite_u64_metric(
            connection,
            "SELECT freelist_count AS value FROM pragma_freelist_count",
            "value",
        )
        .await?,
    })
}

pub async fn database_integrity_messages(
    connection: &DatabaseConnection,
) -> Result<Vec<String>, DbErr> {
    if connection.get_database_backend() != DbBackend::Sqlite {
        connection.ping().await?;
        return Ok(vec!["ok".to_string()]);
    }
    let rows = connection
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT integrity_check AS message FROM pragma_integrity_check".to_string(),
        ))
        .await?;
    rows.into_iter()
        .map(|row| row.try_get("", "message"))
        .collect()
}

pub async fn run_database_maintenance(connection: &DatabaseConnection) -> Result<(), DbErr> {
    if connection.get_database_backend() != DbBackend::Sqlite {
        return Ok(());
    }
    execute(connection, "VACUUM").await?;
    execute(connection, "ANALYZE").await?;
    execute(connection, "PRAGMA optimize").await
}

pub async fn list_admin_roles(
    connection: &DatabaseConnection,
) -> Result<Vec<admin_role::Model>, DbErr> {
    admin_role::Entity::find()
        .order_by_asc(admin_role::Column::Id)
        .all(connection)
        .await
}

pub async fn save_admin_role(
    connection: &DatabaseConnection,
    input: AdminRoleInput,
) -> Result<admin_role::Model, DbErr> {
    let existing = admin_role::Entity::find()
        .filter(admin_role::Column::Id.eq(&input.id))
        .one(connection)
        .await?;

    if let Some(model) = existing {
        let mut active: admin_role::ActiveModel = model.into();
        active.label = Set(input.label);
        active.description = Set(input.description);
        active.permissions = Set(input.permissions);
        active.status = Set(input.status);
        active.updated_at = Set(now_millis_string());
        active.update(connection).await
    } else {
        admin_role::ActiveModel {
            id: Set(input.id),
            label: Set(input.label),
            description: Set(input.description),
            permissions: Set(input.permissions),
            status: Set(input.status),
            updated_at: Set(now_millis_string()),
        }
        .insert(connection)
        .await
    }
}

pub async fn list_admin_users(
    connection: &DatabaseConnection,
) -> Result<Vec<admin_user::Model>, DbErr> {
    admin_user::Entity::find()
        .order_by_asc(admin_user::Column::Id)
        .all(connection)
        .await
}

pub async fn find_admin_user(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<admin_user::Model>, DbErr> {
    admin_user::Entity::find()
        .filter(admin_user::Column::Id.eq(id))
        .one(connection)
        .await
}

pub async fn find_admin_role(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<admin_role::Model>, DbErr> {
    admin_role::Entity::find()
        .filter(admin_role::Column::Id.eq(id))
        .one(connection)
        .await
}

pub async fn count_admin_users_by_role(
    connection: &DatabaseConnection,
    role: &str,
    status: Option<&str>,
) -> Result<u64, DbErr> {
    let mut query = admin_user::Entity::find().filter(admin_user::Column::Role.eq(role));
    if let Some(status) = status {
        query = query.filter(admin_user::Column::Status.eq(status));
    }
    query.count(connection).await
}

pub async fn save_admin_user(
    connection: &DatabaseConnection,
    input: AdminUserInput,
) -> Result<admin_user::Model, DbErr> {
    let existing = admin_user::Entity::find()
        .filter(admin_user::Column::Id.eq(&input.id))
        .one(connection)
        .await?;

    if let Some(model) = existing {
        let mut active: admin_user::ActiveModel = model.into();
        active.display_name = Set(input.display_name);
        active.role = Set(input.role);
        active.status = Set(input.status);
        if let Some(password_hash) = input.password_hash {
            active.password_hash = Set(password_hash);
            active.must_change_password = Set(true);
        }
        active.last_login_at = Set(input.last_login_at);
        active.update(connection).await
    } else {
        let password_hash = input.password_hash.ok_or_else(|| {
            DbErr::Custom("password hash is required when creating an admin user".to_string())
        })?;
        admin_user::ActiveModel {
            id: Set(input.id),
            display_name: Set(input.display_name),
            role: Set(input.role),
            status: Set(input.status),
            password_hash: Set(password_hash),
            must_change_password: Set(true),
            last_login_at: Set(input.last_login_at),
            created_at: Set(now_millis_string()),
        }
        .insert(connection)
        .await
    }
}

pub async fn update_admin_user_last_login(
    connection: &DatabaseConnection,
    id: &str,
    last_login_at: &str,
) -> Result<(), DbErr> {
    if let Some(model) = find_admin_user(connection, id).await? {
        let mut active: admin_user::ActiveModel = model.into();
        active.last_login_at = Set(last_login_at.to_string());
        active.update(connection).await?;
    }
    Ok(())
}

pub async fn update_admin_user_password(
    connection: &DatabaseConnection,
    id: &str,
    password_hash: &str,
) -> Result<(), DbErr> {
    if let Some(model) = find_admin_user(connection, id).await? {
        let mut active: admin_user::ActiveModel = model.into();
        active.password_hash = Set(password_hash.to_string());
        active.must_change_password = Set(false);
        active.update(connection).await?;
    }
    Ok(())
}

pub async fn delete_admin_user(connection: &DatabaseConnection, id: &str) -> Result<bool, DbErr> {
    let result = admin_user::Entity::delete_by_id(id.to_string())
        .exec(connection)
        .await?;
    Ok(result.rows_affected > 0)
}

pub async fn delete_admin_role(connection: &DatabaseConnection, id: &str) -> Result<bool, DbErr> {
    let result = admin_role::Entity::delete_by_id(id.to_string())
        .exec(connection)
        .await?;
    Ok(result.rows_affected > 0)
}

pub async fn list_camera_configs(
    connection: &DatabaseConnection,
) -> Result<Vec<camera_config::Model>, DbErr> {
    camera_config::Entity::find()
        .order_by_asc(camera_config::Column::Id)
        .all(connection)
        .await
}

pub async fn find_camera_config(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<camera_config::Model>, DbErr> {
    camera_config::Entity::find()
        .filter(camera_config::Column::Id.eq(id))
        .one(connection)
        .await
}

pub async fn save_camera_config(
    connection: &DatabaseConnection,
    input: CameraConfigInput,
) -> Result<camera_config::Model, DbErr> {
    let existing = camera_config::Entity::find()
        .filter(camera_config::Column::Id.eq(&input.id))
        .one(connection)
        .await?;

    if let Some(model) = existing {
        let mut active: camera_config::ActiveModel = model.into();
        active.name = Set(input.name);
        active.ip = Set(input.ip);
        active.driver_id = Set(input.driver_id);
        active.model_hint = Set(input.model_hint);
        active.role = Set(input.role);
        active.enabled = Set(input.enabled);
        active.trigger_mode = Set(input.trigger_mode);
        active.exposure_us = Set(input.exposure_us);
        active.gain = Set(input.gain);
        active.depth_lines = Set(input.depth_lines);
        active.output_path = Set(input.output_path);
        active.update(connection).await
    } else {
        camera_config::ActiveModel {
            id: Set(input.id),
            name: Set(input.name),
            ip: Set(input.ip),
            driver_id: Set(input.driver_id),
            model_hint: Set(input.model_hint),
            role: Set(input.role),
            enabled: Set(input.enabled),
            trigger_mode: Set(input.trigger_mode),
            exposure_us: Set(input.exposure_us),
            gain: Set(input.gain),
            depth_lines: Set(input.depth_lines),
            output_path: Set(input.output_path),
        }
        .insert(connection)
        .await
    }
}

pub async fn delete_camera_config(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<bool, DbErr> {
    let result = camera_config::Entity::delete_by_id(id.to_string())
        .exec(connection)
        .await?;
    Ok(result.rows_affected > 0)
}

pub async fn list_defect_types(
    connection: &DatabaseConnection,
) -> Result<Vec<defect_type::Model>, DbErr> {
    defect_type::Entity::find()
        .order_by_asc(defect_type::Column::Id)
        .all(connection)
        .await
}

pub async fn find_defect_type(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<defect_type::Model>, DbErr> {
    defect_type::Entity::find()
        .filter(defect_type::Column::Id.eq(id))
        .one(connection)
        .await
}

pub async fn save_defect_type(
    connection: &DatabaseConnection,
    input: DefectTypeInput,
) -> Result<defect_type::Model, DbErr> {
    let existing = defect_type::Entity::find()
        .filter(defect_type::Column::Id.eq(&input.id))
        .one(connection)
        .await?;

    if let Some(model) = existing {
        let mut active: defect_type::ActiveModel = model.into();
        active.label = Set(input.label);
        active.color = Set(input.color);
        active.shape = Set(input.shape);
        active.update(connection).await
    } else {
        defect_type::ActiveModel {
            id: Set(input.id),
            label: Set(input.label),
            color: Set(input.color),
            shape: Set(input.shape),
        }
        .insert(connection)
        .await
    }
}

pub async fn count_defects_by_type(
    connection: &DatabaseConnection,
    type_id: &str,
) -> Result<u64, DbErr> {
    defect::Entity::find()
        .filter(defect::Column::TypeId.eq(type_id))
        .count(connection)
        .await
}

pub async fn delete_defect_type(connection: &DatabaseConnection, id: &str) -> Result<bool, DbErr> {
    let result = defect_type::Entity::delete_by_id(id.to_string())
        .exec(connection)
        .await?;
    Ok(result.rows_affected > 0)
}

pub async fn list_audit_logs(
    connection: &DatabaseConnection,
    filter: AuditLogFilter,
) -> Result<Vec<audit_log::Model>, DbErr> {
    Ok(list_audit_logs_page(connection, filter).await?.logs)
}

pub async fn list_audit_logs_page(
    connection: &DatabaseConnection,
    filter: AuditLogFilter,
) -> Result<AdminAuditLogPage, DbErr> {
    let limit = filter.limit.unwrap_or(50).clamp(1, 200);
    let offset = filter.offset.unwrap_or(0);
    let mut query = audit_log::Entity::find().order_by_desc(audit_log::Column::CreatedAt);
    if let Some(level) = filter
        .level
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "all")
    {
        query = query.filter(audit_log::Column::Level.eq(level));
    }
    if let Some(keyword) = filter.keyword.as_deref().filter(|value| !value.is_empty()) {
        query = query.filter(
            audit_log::Column::Detail
                .contains(keyword)
                .or(audit_log::Column::Actor.contains(keyword))
                .or(audit_log::Column::Action.contains(keyword))
                .or(audit_log::Column::Target.contains(keyword)),
        );
    }
    let total = query.clone().count(connection).await?;
    let logs = query.limit(limit).offset(offset).all(connection).await?;
    Ok(AdminAuditLogPage {
        logs,
        total,
        limit,
        offset,
    })
}

pub async fn export_audit_logs(
    connection: &DatabaseConnection,
    filter: AuditLogFilter,
    max_rows: u64,
) -> Result<Vec<audit_log::Model>, DbErr> {
    let limit = max_rows.clamp(1, 5000);
    let mut query = audit_log::Entity::find().order_by_desc(audit_log::Column::CreatedAt);
    if let Some(level) = filter
        .level
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "all")
    {
        query = query.filter(audit_log::Column::Level.eq(level));
    }
    if let Some(keyword) = filter.keyword.as_deref().filter(|value| !value.is_empty()) {
        query = query.filter(
            audit_log::Column::Detail
                .contains(keyword)
                .or(audit_log::Column::Actor.contains(keyword))
                .or(audit_log::Column::Action.contains(keyword))
                .or(audit_log::Column::Target.contains(keyword)),
        );
    }
    query.limit(limit).all(connection).await
}

pub async fn count_audit_logs_before(
    connection: &DatabaseConnection,
    cutoff_at: &str,
) -> Result<u64, DbErr> {
    let cutoff = parse_millis_cutoff(cutoff_at)?;
    let Some(row) = connection
        .query_one(Statement::from_string(
            connection.get_database_backend(),
            format!("SELECT COUNT(*) AS count FROM audit_log WHERE CAST(created_at AS INTEGER) < {cutoff}"),
        ))
        .await?
    else {
        return Ok(0);
    };
    let count: i64 = row.try_get("", "count")?;
    Ok(count.max(0) as u64)
}

pub async fn delete_audit_logs_before(
    connection: &DatabaseConnection,
    cutoff_at: &str,
) -> Result<u64, DbErr> {
    let cutoff = parse_millis_cutoff(cutoff_at)?;
    let result = connection
        .execute(Statement::from_string(
            connection.get_database_backend(),
            format!("DELETE FROM audit_log WHERE CAST(created_at AS INTEGER) < {cutoff}"),
        ))
        .await?;
    Ok(result.rows_affected())
}

fn filtered_production_inspections(
    filter: &InspectionRecordFilter,
) -> sea_orm::Select<production_inspection::Entity> {
    let mut query = production_inspection::Entity::find()
        .order_by_desc(production_inspection::Column::StartedAt)
        .order_by_desc(production_inspection::Column::Id);
    if let Some(status) = filter
        .status
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "all")
    {
        query = match status {
            "completed" => query.filter(production_inspection::Column::Status.is_in([
                "algorithm-complete",
                "completed",
                "finished",
            ])),
            "detecting" => query.filter(production_inspection::Column::Status.is_not_in([
                "algorithm-complete",
                "completed",
                "finished",
            ])),
            _ => query.filter(production_inspection::Column::Status.eq(status)),
        };
    }
    if let Some(keyword) = filter.keyword.as_deref().filter(|value| !value.is_empty()) {
        query = query.filter(
            production_inspection::Column::MaterialId
                .contains(keyword)
                .or(production_inspection::Column::Id.contains(keyword))
                .or(production_inspection::Column::SessionId.contains(keyword)),
        );
    }
    query
}

async fn admin_production_record(
    connection: &DatabaseConnection,
    inspection: production_inspection::Model,
) -> Result<AdminInspectionRecord, DbErr> {
    let session = material_session::Entity::find()
        .filter(material_session::Column::Id.eq(&inspection.session_id))
        .one(connection)
        .await?;
    let defects = production_defect::Entity::find()
        .filter(production_defect::Column::InspectionId.eq(&inspection.id))
        .all(connection)
        .await?;
    Ok(AdminInspectionRecord {
        inspection,
        session,
        severe_count: defects
            .iter()
            .filter(|item| item.severity == "severe")
            .count() as u64,
        review_count: defects
            .iter()
            .filter(|item| item.severity == "review")
            .count() as u64,
        minor_count: defects
            .iter()
            .filter(|item| item.severity == "minor")
            .count() as u64,
    })
}

pub async fn list_inspection_records(
    connection: &DatabaseConnection,
    filter: InspectionRecordFilter,
) -> Result<AdminInspectionRecordPage, DbErr> {
    let limit = filter.limit.unwrap_or(20).clamp(1, 100);
    let offset = filter.offset.unwrap_or(0);
    let query = filtered_production_inspections(&filter);
    let total = query.clone().count(connection).await?;
    let inspections = query.limit(limit).offset(offset).all(connection).await?;
    let mut records = Vec::with_capacity(inspections.len());
    for inspection in inspections {
        records.push(admin_production_record(connection, inspection).await?);
    }
    Ok(AdminInspectionRecordPage {
        records,
        total,
        limit,
        offset,
    })
}

pub async fn export_inspection_records(
    connection: &DatabaseConnection,
    filter: InspectionRecordFilter,
    max_rows: u64,
) -> Result<Vec<AdminInspectionRecord>, DbErr> {
    let limit = max_rows.clamp(1, 5000);
    let inspections = filtered_production_inspections(&filter)
        .limit(limit)
        .all(connection)
        .await?;
    let mut records = Vec::with_capacity(inspections.len());
    for inspection in inspections {
        records.push(admin_production_record(connection, inspection).await?);
    }
    Ok(records)
}

pub async fn find_inspection_record_detail(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<AdminInspectionRecordDetail>, DbErr> {
    let Some(inspection) = production_inspection::Entity::find()
        .filter(production_inspection::Column::Id.eq(id))
        .one(connection)
        .await?
    else {
        return Ok(None);
    };
    let defects = production_defect::Entity::find()
        .filter(production_defect::Column::InspectionId.eq(id))
        .order_by_asc(production_defect::Column::CameraId)
        .order_by_asc(production_defect::Column::YMm)
        .all(connection)
        .await?;
    let capture_files = capture_file::Entity::find()
        .filter(capture_file::Column::InspectionId.eq(id))
        .order_by_asc(capture_file::Column::CameraId)
        .order_by_asc(capture_file::Column::SequenceNo)
        .all(connection)
        .await?;
    let record = admin_production_record(connection, inspection).await?;
    Ok(Some(AdminInspectionRecordDetail {
        record,
        defects,
        capture_files,
    }))
}

#[cfg(test)]
pub async fn delete_inspection_record(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<DeleteInspectionRecordResult>, DbErr> {
    let Some(inspection) = production_inspection::Entity::find()
        .filter(production_inspection::Column::Id.eq(id))
        .one(connection)
        .await?
    else {
        return Ok(None);
    };
    let material_id = inspection.material_id.clone();
    let transaction = connection.begin().await?;
    let defects_deleted = production_defect::Entity::delete_many()
        .filter(production_defect::Column::InspectionId.eq(id))
        .exec(&transaction)
        .await?
        .rows_affected;
    let capture_files_deleted = capture_file::Entity::delete_many()
        .filter(capture_file::Column::InspectionId.eq(id))
        .exec(&transaction)
        .await?
        .rows_affected;
    let deleted = production_inspection::Entity::delete_many()
        .filter(production_inspection::Column::Id.eq(id))
        .exec(&transaction)
        .await?
        .rows_affected;
    if deleted == 0 {
        transaction.rollback().await?;
        return Ok(None);
    }
    transaction.commit().await?;
    Ok(Some(DeleteInspectionRecordResult {
        id: inspection.id,
        material_id,
        defects_deleted,
        capture_files_deleted,
    }))
}

pub async fn create_or_load_record_cleanup(
    connection: &DatabaseConnection,
    input: RecordCleanupInput,
) -> Result<record_cleanup::Model, DbErr> {
    if let Some(existing) = record_cleanup::Entity::find()
        .filter(record_cleanup::Column::RecordId.eq(&input.record_id))
        .filter(record_cleanup::Column::Status.is_in(["planned", "deleting", "failed"]))
        .order_by_desc(record_cleanup::Column::CreatedAt)
        .one(connection)
        .await?
    {
        return Ok(existing);
    }
    let now = now_millis_string();
    record_cleanup::ActiveModel {
        id: Set(format!("CLEAN-{}", now_nanos_string())),
        record_id: Set(input.record_id),
        material_id: Set(input.material_id),
        status: Set("planned".to_string()),
        actor: Set(input.actor),
        reason: Set(input.reason),
        manifest_json: Set(input.manifest_json),
        files_planned: Set(input.files_planned),
        files_deleted: Set(0),
        files_missing: Set(0),
        bytes_planned: Set(input.bytes_planned),
        bytes_deleted: Set(0),
        error: Set(String::new()),
        created_at: Set(now.clone()),
        updated_at: Set(now),
        completed_at: Set(String::new()),
    }
    .insert(connection)
    .await
}

pub async fn find_record_cleanup(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<record_cleanup::Model>, DbErr> {
    record_cleanup::Entity::find()
        .filter(record_cleanup::Column::Id.eq(id))
        .one(connection)
        .await
}

pub async fn find_open_record_cleanup_for_record(
    connection: &DatabaseConnection,
    record_id: &str,
) -> Result<Option<record_cleanup::Model>, DbErr> {
    record_cleanup::Entity::find()
        .filter(record_cleanup::Column::RecordId.eq(record_id))
        .filter(record_cleanup::Column::Status.is_in(["planned", "deleting", "failed"]))
        .order_by_desc(record_cleanup::Column::CreatedAt)
        .one(connection)
        .await
}

pub async fn update_record_cleanup_progress(
    connection: &DatabaseConnection,
    id: &str,
    status: &str,
    manifest_json: &str,
    files_deleted: i32,
    files_missing: i32,
    bytes_deleted: i64,
    error: &str,
) -> Result<record_cleanup::Model, DbErr> {
    let Some(model) = find_record_cleanup(connection, id).await? else {
        return Err(DbErr::RecordNotFound(format!("record cleanup {id}")));
    };
    let mut active: record_cleanup::ActiveModel = model.into();
    active.status = Set(status.to_string());
    active.manifest_json = Set(manifest_json.to_string());
    active.files_deleted = Set(files_deleted);
    active.files_missing = Set(files_missing);
    active.bytes_deleted = Set(bytes_deleted);
    active.error = Set(error.to_string());
    active.updated_at = Set(now_millis_string());
    active.update(connection).await
}

pub async fn complete_record_cleanup(
    connection: &DatabaseConnection,
    cleanup_id: &str,
    record_id: &str,
    manifest_json: &str,
    files_deleted: i32,
    files_missing: i32,
    bytes_deleted: i64,
) -> Result<DeleteInspectionRecordResult, DbErr> {
    let Some(inspection) = production_inspection::Entity::find()
        .filter(production_inspection::Column::Id.eq(record_id))
        .one(connection)
        .await?
    else {
        return Err(DbErr::RecordNotFound(format!(
            "production inspection {record_id}"
        )));
    };
    let transaction = connection.begin().await?;
    let defects_deleted = production_defect::Entity::delete_many()
        .filter(production_defect::Column::InspectionId.eq(record_id))
        .exec(&transaction)
        .await?
        .rows_affected;
    let capture_files_deleted = capture_file::Entity::delete_many()
        .filter(capture_file::Column::InspectionId.eq(record_id))
        .exec(&transaction)
        .await?
        .rows_affected;
    let deleted = production_inspection::Entity::delete_many()
        .filter(production_inspection::Column::Id.eq(record_id))
        .exec(&transaction)
        .await?
        .rows_affected;
    if deleted != 1 {
        transaction.rollback().await?;
        return Err(DbErr::Custom(
            "record cleanup lost inspection ownership".to_string(),
        ));
    }
    let cleanup = record_cleanup::Entity::find()
        .filter(record_cleanup::Column::Id.eq(cleanup_id))
        .one(&transaction)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound(format!("record cleanup {cleanup_id}")))?;
    let now = now_millis_string();
    let mut active: record_cleanup::ActiveModel = cleanup.into();
    active.status = Set("completed".to_string());
    active.manifest_json = Set(manifest_json.to_string());
    active.files_deleted = Set(files_deleted);
    active.files_missing = Set(files_missing);
    active.bytes_deleted = Set(bytes_deleted);
    active.error = Set(String::new());
    active.updated_at = Set(now.clone());
    active.completed_at = Set(now);
    active.update(&transaction).await?;
    transaction.commit().await?;
    Ok(DeleteInspectionRecordResult {
        id: inspection.id,
        material_id: inspection.material_id,
        defects_deleted,
        capture_files_deleted,
    })
}

pub async fn inspection_record_retention_cutoff(
    _connection: &DatabaseConnection,
    retention_days: u64,
) -> Result<String, DbErr> {
    let now = now_millis_string().parse::<u128>().unwrap_or(0);
    let retention_ms = (retention_days as u128).saturating_mul(24 * 60 * 60 * 1000);
    Ok(now.saturating_sub(retention_ms).to_string())
}

async fn inspection_records_before(
    connection: &DatabaseConnection,
    retention_days: u64,
) -> Result<Vec<String>, DbErr> {
    let cutoff = inspection_record_retention_cutoff(connection, retention_days)
        .await?
        .parse::<u128>()
        .unwrap_or(0);
    let inspections = production_inspection::Entity::find()
        .filter(production_inspection::Column::Status.is_in([
            "algorithm-complete",
            "completed",
            "finished",
        ]))
        .all(connection)
        .await?;
    let mut candidates = Vec::new();
    for inspection in inspections {
        let finished_at = inspection.finished_at.parse::<u128>().unwrap_or(u128::MAX);
        if inspection.finished_at.is_empty() || finished_at >= cutoff {
            continue;
        }
        let session = material_session::Entity::find()
            .filter(material_session::Column::Id.eq(&inspection.session_id))
            .one(connection)
            .await?;
        if session
            .as_ref()
            .map(|item| item.status == "finished")
            .unwrap_or(true)
        {
            candidates.push(inspection.id);
        }
    }
    Ok(candidates)
}

pub async fn inspection_record_ids_before(
    connection: &DatabaseConnection,
    retention_days: u64,
) -> Result<Vec<String>, DbErr> {
    inspection_records_before(connection, retention_days).await
}

#[cfg(test)]
pub async fn count_inspection_records_before(
    connection: &DatabaseConnection,
    retention_days: u64,
) -> Result<u64, DbErr> {
    Ok(inspection_records_before(connection, retention_days)
        .await?
        .len() as u64)
}

#[cfg(test)]
pub async fn delete_inspection_records_before(
    connection: &DatabaseConnection,
    retention_days: u64,
) -> Result<InspectionRecordRetentionResult, DbErr> {
    let candidates = inspection_records_before(connection, retention_days).await?;
    let matched = candidates.len() as u64;
    let mut deleted_records = 0;
    let mut deleted_defects = 0;
    let mut deleted_capture_files = 0;
    for id in candidates {
        if let Some(result) = delete_inspection_record(connection, &id).await? {
            deleted_records += 1;
            deleted_defects += result.defects_deleted;
            deleted_capture_files += result.capture_files_deleted;
        }
    }

    Ok(InspectionRecordRetentionResult {
        matched,
        deleted_records,
        deleted_defects,
        deleted_capture_files,
    })
}

pub async fn find_material_session(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<material_session::Model>, DbErr> {
    material_session::Entity::find()
        .filter(material_session::Column::Id.eq(id))
        .one(connection)
        .await
}

pub async fn latest_material_session(
    connection: &DatabaseConnection,
) -> Result<Option<material_session::Model>, DbErr> {
    material_session::Entity::find()
        .order_by_desc(material_session::Column::UpdatedAt)
        .order_by_desc(material_session::Column::Id)
        .one(connection)
        .await
}

pub async fn latest_open_material_session(
    connection: &DatabaseConnection,
) -> Result<Option<material_session::Model>, DbErr> {
    material_session::Entity::find()
        .filter(material_session::Column::Status.ne("finished"))
        .order_by_desc(material_session::Column::UpdatedAt)
        .order_by_desc(material_session::Column::Id)
        .one(connection)
        .await
}

pub async fn latest_material_session_for_material(
    connection: &DatabaseConnection,
    material_id: &str,
) -> Result<Option<material_session::Model>, DbErr> {
    material_session::Entity::find()
        .filter(material_session::Column::MaterialId.eq(material_id))
        .order_by_desc(material_session::Column::UpdatedAt)
        .order_by_desc(material_session::Column::Id)
        .one(connection)
        .await
}

pub async fn upsert_material_session(
    connection: &DatabaseConnection,
    input: MaterialSessionInput,
) -> Result<material_session::Model, DbErr> {
    let now = now_millis_string();
    let existing = material_session::Entity::find()
        .filter(material_session::Column::Id.eq(&input.id))
        .one(connection)
        .await?;
    if let Some(model) = existing {
        let existing_started_at = model.started_at.clone();
        let mut active: material_session::ActiveModel = model.into();
        active.material_id = Set(input.material_id);
        active.source = Set(input.source);
        active.status = Set(input.status);
        active.control_mode = Set(input.control_mode);
        active.trigger_mode = Set(input.trigger_mode);
        active.steel_type = Set(input.steel_type);
        active.width_mm = Set(input.width_mm);
        active.length_mm = Set(input.length_mm);
        active.thickness_mm = Set(input.thickness_mm);
        active.client = Set(input.client);
        active.hard = Set(input.hard);
        active.storage_root = Set(input.storage_root);
        if existing_started_at.is_empty() && !input.started_at.is_empty() {
            active.started_at = Set(input.started_at);
        }
        active.finished_at = Set(input.finished_at);
        active.updated_at = Set(now);
        active.raw_payload = Set(input.raw_payload);
        active.update(connection).await
    } else {
        material_session::ActiveModel {
            id: Set(input.id),
            material_id: Set(input.material_id),
            source: Set(input.source),
            status: Set(input.status),
            control_mode: Set(input.control_mode),
            trigger_mode: Set(input.trigger_mode),
            steel_type: Set(input.steel_type),
            width_mm: Set(input.width_mm),
            length_mm: Set(input.length_mm),
            thickness_mm: Set(input.thickness_mm),
            client: Set(input.client),
            hard: Set(input.hard),
            storage_root: Set(input.storage_root),
            started_at: Set(if input.started_at.is_empty() {
                now.clone()
            } else {
                input.started_at
            }),
            finished_at: Set(input.finished_at),
            updated_at: Set(now),
            raw_payload: Set(input.raw_payload),
        }
        .insert(connection)
        .await
    }
}

pub async fn append_secondary_data(
    connection: &DatabaseConnection,
    input: SecondaryDataInput,
) -> Result<secondary_data::Model, DbErr> {
    secondary_data::ActiveModel {
        id: Set(format!("L2-{}", now_nanos_string())),
        material_id: Set(input.material_id),
        session_id: Set(input.session_id),
        source: Set(input.source),
        payload_type: Set(input.payload_type),
        payload: Set(input.payload),
        received_at: Set(now_millis_string()),
    }
    .insert(connection)
    .await
}

pub async fn append_trigger_event(
    connection: &DatabaseConnection,
    input: TriggerEventInput,
) -> Result<trigger_event::Model, DbErr> {
    trigger_event::ActiveModel {
        id: Set(format!("TRG-{}", now_nanos_string())),
        material_id: Set(input.material_id),
        session_id: Set(input.session_id),
        source: Set(input.source),
        mode: Set(input.mode),
        event_type: Set(input.event_type),
        command: Set(input.command),
        value: Set(input.value),
        payload: Set(input.payload),
        provider_code: Set(input.provider_code),
        provider_response: Set(input.provider_response),
        created_at: Set(now_millis_string()),
    }
    .insert(connection)
    .await
}

pub async fn upsert_production_inspection(
    connection: &DatabaseConnection,
    input: ProductionInspectionInput,
) -> Result<production_inspection::Model, DbErr> {
    let existing = production_inspection::Entity::find()
        .filter(production_inspection::Column::Id.eq(&input.id))
        .one(connection)
        .await?;
    if let Some(model) = existing {
        let mut active: production_inspection::ActiveModel = model.into();
        active.material_id = Set(input.material_id);
        active.session_id = Set(input.session_id);
        active.status = Set(input.status);
        active.storage_root = Set(input.storage_root);
        active.summary_path = Set(input.summary_path);
        active.finished_at = Set(input.finished_at);
        active.capture_count = Set(input.capture_count);
        active.defect_count = Set(input.defect_count);
        active.raw_payload = Set(input.raw_payload);
        active.update(connection).await
    } else {
        production_inspection::ActiveModel {
            id: Set(input.id),
            material_id: Set(input.material_id),
            session_id: Set(input.session_id),
            status: Set(input.status),
            storage_root: Set(input.storage_root),
            summary_path: Set(input.summary_path),
            started_at: Set(input.started_at),
            finished_at: Set(input.finished_at),
            capture_count: Set(input.capture_count),
            defect_count: Set(input.defect_count),
            raw_payload: Set(input.raw_payload),
        }
        .insert(connection)
        .await
    }
}

pub async fn latest_production_inspection(
    connection: &DatabaseConnection,
) -> Result<Option<production_inspection::Model>, DbErr> {
    production_inspection::Entity::find()
        .order_by_desc(production_inspection::Column::FinishedAt)
        .order_by_desc(production_inspection::Column::StartedAt)
        .one(connection)
        .await
}

pub async fn list_recent_production_inspections(
    connection: &DatabaseConnection,
    limit: u64,
) -> Result<Vec<production_inspection::Model>, DbErr> {
    production_inspection::Entity::find()
        .order_by_desc(production_inspection::Column::FinishedAt)
        .order_by_desc(production_inspection::Column::StartedAt)
        .limit(limit)
        .all(connection)
        .await
}

pub async fn find_production_inspection(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<production_inspection::Model>, DbErr> {
    production_inspection::Entity::find()
        .filter(production_inspection::Column::Id.eq(id))
        .one(connection)
        .await
}

pub async fn insert_calibration_operation(
    connection: &DatabaseConnection,
    input: CalibrationOperationInput,
) -> Result<calibration_operation::Model, DbErr> {
    let now = now_millis_string();
    calibration_operation::ActiveModel {
        id: Set(input.id),
        kind: Set(input.kind),
        request_hash: Set(input.request_hash),
        request_json: Set(input.request_json),
        status: Set("dispatching".to_string()),
        provider_http_status: Set(0),
        provider_response_body: Set(String::new()),
        error: Set(String::new()),
        actor: Set(input.actor),
        parent_operation_id: Set(input.parent_operation_id),
        reconciliation_outcome: Set(String::new()),
        reconciliation_id: Set(String::new()),
        resolved_by: Set(String::new()),
        resolved_at: Set(String::new()),
        row_version: Set(1),
        created_at: Set(now.clone()),
        dispatch_started_at: Set(now.clone()),
        finished_at: Set(String::new()),
        updated_at: Set(now),
    }
    .insert(connection)
    .await
}

pub async fn find_calibration_operation(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<calibration_operation::Model>, DbErr> {
    calibration_operation::Entity::find()
        .filter(calibration_operation::Column::Id.eq(id))
        .one(connection)
        .await
}

pub async fn list_unresolved_calibration_operations(
    connection: &DatabaseConnection,
) -> Result<Vec<calibration_operation::Model>, DbErr> {
    calibration_operation::Entity::find()
        .filter(
            calibration_operation::Column::Status.is_in(["dispatching", "needs-reconciliation"]),
        )
        .order_by_asc(calibration_operation::Column::CreatedAt)
        .all(connection)
        .await
}

pub async fn reconcile_calibration_operation(
    connection: &DatabaseConnection,
    operation_id: &str,
    reconciliation_id: &str,
    outcome: &str,
    actor: &str,
) -> Result<Option<calibration_operation::Model>, DbErr> {
    let Some(existing) = find_calibration_operation(connection, operation_id).await? else {
        return Ok(None);
    };
    if existing.status != "needs-reconciliation" {
        return Ok(Some(existing));
    }
    let now = now_millis_string();
    calibration_operation::Entity::update_many()
        .col_expr(
            calibration_operation::Column::Status,
            Expr::value("reconciled"),
        )
        .col_expr(
            calibration_operation::Column::ReconciliationOutcome,
            Expr::value(outcome.to_string()),
        )
        .col_expr(
            calibration_operation::Column::ReconciliationId,
            Expr::value(reconciliation_id.to_string()),
        )
        .col_expr(
            calibration_operation::Column::ResolvedBy,
            Expr::value(actor.to_string()),
        )
        .col_expr(
            calibration_operation::Column::ResolvedAt,
            Expr::value(now.clone()),
        )
        .col_expr(
            calibration_operation::Column::RowVersion,
            Expr::value(existing.row_version.saturating_add(1)),
        )
        .col_expr(calibration_operation::Column::UpdatedAt, Expr::value(now))
        .filter(calibration_operation::Column::Id.eq(operation_id))
        .filter(calibration_operation::Column::Status.eq("needs-reconciliation"))
        .filter(calibration_operation::Column::RowVersion.eq(existing.row_version))
        .exec(connection)
        .await?;
    find_calibration_operation(connection, operation_id).await
}

pub async fn finish_calibration_operation(
    connection: &DatabaseConnection,
    id: &str,
    status: &str,
    provider_http_status: i32,
    provider_response_body: String,
    error: String,
) -> Result<Option<calibration_operation::Model>, DbErr> {
    let Some(existing) = find_calibration_operation(connection, id).await? else {
        return Ok(None);
    };
    if existing.status != "dispatching" {
        return Ok(Some(existing));
    }
    let now = now_millis_string();
    let update = calibration_operation::Entity::update_many()
        .col_expr(
            calibration_operation::Column::Status,
            Expr::value(status.to_string()),
        )
        .col_expr(
            calibration_operation::Column::ProviderHttpStatus,
            Expr::value(provider_http_status),
        )
        .col_expr(
            calibration_operation::Column::ProviderResponseBody,
            Expr::value(provider_response_body),
        )
        .col_expr(calibration_operation::Column::Error, Expr::value(error))
        .col_expr(
            calibration_operation::Column::FinishedAt,
            Expr::value(now.clone()),
        )
        .col_expr(calibration_operation::Column::UpdatedAt, Expr::value(now))
        .col_expr(
            calibration_operation::Column::RowVersion,
            Expr::value(existing.row_version.saturating_add(1)),
        )
        .filter(calibration_operation::Column::Id.eq(id))
        .filter(calibration_operation::Column::Status.eq("dispatching"))
        .filter(calibration_operation::Column::RowVersion.eq(existing.row_version))
        .exec(connection)
        .await?;
    if update.rows_affected == 0 {
        return find_calibration_operation(connection, id).await;
    }
    find_calibration_operation(connection, id).await
}

pub async fn recover_dispatching_calibration_operations(
    connection: &DatabaseConnection,
) -> Result<u64, DbErr> {
    let interrupted = calibration_operation::Entity::find()
        .filter(calibration_operation::Column::Status.eq("dispatching"))
        .all(connection)
        .await?;
    let mut recovered = 0_u64;
    for existing in interrupted {
        let now = now_millis_string();
        let update = calibration_operation::Entity::update_many()
            .col_expr(
                calibration_operation::Column::Status,
                Expr::value("needs-reconciliation"),
            )
            .col_expr(
                calibration_operation::Column::Error,
                Expr::value("service_restart_while_dispatching"),
            )
            .col_expr(
                calibration_operation::Column::FinishedAt,
                Expr::value(now.clone()),
            )
            .col_expr(calibration_operation::Column::UpdatedAt, Expr::value(now))
            .col_expr(
                calibration_operation::Column::RowVersion,
                Expr::value(existing.row_version.saturating_add(1)),
            )
            .filter(calibration_operation::Column::Id.eq(&existing.id))
            .filter(calibration_operation::Column::Status.eq("dispatching"))
            .filter(calibration_operation::Column::RowVersion.eq(existing.row_version))
            .exec(connection)
            .await?;
        recovered = recovered.saturating_add(update.rows_affected);
    }
    Ok(recovered)
}

pub async fn insert_production_task(
    connection: &DatabaseConnection,
    input: ProductionTaskInput,
) -> Result<production_task::Model, DbErr> {
    let now = now_millis_string();
    production_task::ActiveModel {
        id: Set(input.id),
        idempotency_key: Set(input.idempotency_key),
        kind: Set(input.kind),
        material_id: Set(input.material_id),
        session_id: Set(input.session_id),
        chain_id: Set(input.chain_id),
        depends_on_task_id: Set(input.depends_on_task_id),
        dependency_policy: Set(input.dependency_policy),
        blocked_reason: Set(String::new()),
        status: Set("queued".to_string()),
        phase: Set("queued".to_string()),
        payload: Set(input.payload),
        result: Set(String::new()),
        error: Set(String::new()),
        actor: Set(input.actor),
        progress: Set(0),
        attempts: Set(0),
        max_attempts: Set(input.max_attempts.clamp(1, 10)),
        cancel_requested: Set(false),
        created_at: Set(now.clone()),
        started_at: Set(String::new()),
        finished_at: Set(String::new()),
        updated_at: Set(now),
    }
    .insert(connection)
    .await
}

pub async fn find_production_task(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<production_task::Model>, DbErr> {
    production_task::Entity::find()
        .filter(production_task::Column::Id.eq(id))
        .one(connection)
        .await
}

pub async fn find_production_task_by_idempotency_key(
    connection: &DatabaseConnection,
    idempotency_key: &str,
) -> Result<Option<production_task::Model>, DbErr> {
    if idempotency_key.trim().is_empty() {
        return Ok(None);
    }
    production_task::Entity::find()
        .filter(production_task::Column::IdempotencyKey.eq(idempotency_key))
        .order_by_desc(production_task::Column::CreatedAt)
        .one(connection)
        .await
}

pub async fn latest_production_task_in_chain(
    connection: &DatabaseConnection,
    chain_id: &str,
) -> Result<Option<production_task::Model>, DbErr> {
    if chain_id.trim().is_empty() {
        return Ok(None);
    }
    production_task::Entity::find()
        .filter(production_task::Column::ChainId.eq(chain_id))
        .order_by_desc(production_task::Column::CreatedAt)
        .order_by_desc(production_task::Column::Id)
        .one(connection)
        .await
}

#[derive(Debug, PartialEq, Eq)]
enum ProductionTaskDependencyState {
    Ready,
    Waiting,
    Blocked(String),
}

fn production_task_status_is_terminal(status: &str) -> bool {
    matches!(
        status,
        "succeeded" | "failed" | "cancelled" | "interrupted" | "blocked"
    )
}

async fn production_task_dependency_state(
    connection: &DatabaseConnection,
    task: &production_task::Model,
) -> Result<ProductionTaskDependencyState, DbErr> {
    if task.depends_on_task_id.trim().is_empty() {
        return Ok(ProductionTaskDependencyState::Ready);
    }
    if task.depends_on_task_id == task.id {
        return Ok(ProductionTaskDependencyState::Blocked(format!(
            "dependency_cycle:{}",
            task.id
        )));
    }
    let Some(dependency) = find_production_task(connection, &task.depends_on_task_id).await? else {
        return Ok(ProductionTaskDependencyState::Blocked(format!(
            "dependency_not_found:{}",
            task.depends_on_task_id
        )));
    };
    if dependency.chain_id != task.chain_id
        || dependency.session_id != task.session_id
        || dependency.material_id != task.material_id
    {
        return Ok(ProductionTaskDependencyState::Blocked(format!(
            "dependency_chain_mismatch:{}",
            dependency.id
        )));
    }
    if task.dependency_policy == "always-run" {
        return Ok(if production_task_status_is_terminal(&dependency.status) {
            ProductionTaskDependencyState::Ready
        } else {
            ProductionTaskDependencyState::Waiting
        });
    }
    Ok(match dependency.status.as_str() {
        "succeeded" => ProductionTaskDependencyState::Ready,
        "failed" | "cancelled" | "interrupted" | "blocked" => {
            ProductionTaskDependencyState::Blocked(format!(
                "dependency_{}:{}",
                dependency.status, dependency.id
            ))
        }
        _ => ProductionTaskDependencyState::Waiting,
    })
}

async fn mark_production_task_blocked(
    connection: &DatabaseConnection,
    id: &str,
    reason: &str,
) -> Result<bool, DbErr> {
    let now = now_millis_string();
    let update = production_task::Entity::update_many()
        .col_expr(production_task::Column::Status, Expr::value("blocked"))
        .col_expr(production_task::Column::Phase, Expr::value("blocked"))
        .col_expr(production_task::Column::Progress, Expr::value(0))
        .col_expr(
            production_task::Column::BlockedReason,
            Expr::value(reason.to_string()),
        )
        .col_expr(
            production_task::Column::Error,
            Expr::value(reason.to_string()),
        )
        .col_expr(
            production_task::Column::FinishedAt,
            Expr::value(now.clone()),
        )
        .col_expr(production_task::Column::UpdatedAt, Expr::value(now))
        .filter(production_task::Column::Id.eq(id))
        .filter(production_task::Column::Status.eq("queued"))
        .exec(connection)
        .await?;
    Ok(update.rows_affected == 1)
}

pub async fn propagate_production_task_dependency_failure(
    connection: &DatabaseConnection,
    parent_id: &str,
) -> Result<u64, DbErr> {
    let mut frontier = vec![parent_id.to_string()];
    let mut blocked = 0_u64;
    while let Some(parent) = frontier.pop() {
        let dependents = production_task::Entity::find()
            .filter(production_task::Column::DependsOnTaskId.eq(&parent))
            .filter(production_task::Column::DependencyPolicy.eq("require-success"))
            .filter(production_task::Column::Status.eq("queued"))
            .all(connection)
            .await?;
        let parent_status = find_production_task(connection, &parent)
            .await?
            .map(|task| task.status)
            .unwrap_or_else(|| "not_found".to_string());
        for dependent in dependents {
            let reason = format!("dependency_{}:{}", parent_status, parent);
            if mark_production_task_blocked(connection, &dependent.id, &reason).await? {
                blocked = blocked.saturating_add(1);
                frontier.push(dependent.id);
            }
        }
    }
    Ok(blocked)
}

async fn requeue_blocked_production_task_descendants(
    connection: &DatabaseConnection,
    parent_id: &str,
) -> Result<u64, DbErr> {
    let mut frontier = vec![parent_id.to_string()];
    let mut requeued = 0_u64;
    while let Some(parent) = frontier.pop() {
        let dependents = production_task::Entity::find()
            .filter(production_task::Column::DependsOnTaskId.eq(&parent))
            .filter(production_task::Column::Status.eq("blocked"))
            .all(connection)
            .await?;
        for dependent in dependents {
            let now = now_millis_string();
            let update = production_task::Entity::update_many()
                .col_expr(production_task::Column::Status, Expr::value("queued"))
                .col_expr(
                    production_task::Column::Phase,
                    Expr::value("waiting-dependency"),
                )
                .col_expr(production_task::Column::BlockedReason, Expr::value(""))
                .col_expr(production_task::Column::Error, Expr::value(""))
                .col_expr(production_task::Column::FinishedAt, Expr::value(""))
                .col_expr(production_task::Column::UpdatedAt, Expr::value(now))
                .filter(production_task::Column::Id.eq(&dependent.id))
                .filter(production_task::Column::Status.eq("blocked"))
                .exec(connection)
                .await?;
            if update.rows_affected == 1 {
                requeued = requeued.saturating_add(1);
                frontier.push(dependent.id);
            }
        }
    }
    Ok(requeued)
}

pub async fn count_open_production_tasks(connection: &DatabaseConnection) -> Result<u64, DbErr> {
    production_task::Entity::find()
        .filter(production_task::Column::Status.is_in(["queued", "running"]))
        .count(connection)
        .await
}

pub async fn count_unresolved_production_tasks_for_session(
    connection: &DatabaseConnection,
    session_id: &str,
) -> Result<u64, DbErr> {
    production_task::Entity::find()
        .filter(production_task::Column::SessionId.eq(session_id))
        .filter(production_task::Column::Status.is_in([
            "queued",
            "running",
            "failed",
            "interrupted",
            "blocked",
        ]))
        .count(connection)
        .await
}

pub async fn latest_unresolved_production_task(
    connection: &DatabaseConnection,
    material_id: Option<&str>,
) -> Result<Option<production_task::Model>, DbErr> {
    let mut query = production_task::Entity::find()
        .filter(production_task::Column::Status.is_in([
            "queued",
            "running",
            "failed",
            "cancelled",
            "interrupted",
            "blocked",
        ]))
        .order_by_desc(production_task::Column::CreatedAt)
        .order_by_desc(production_task::Column::Id);
    if let Some(material_id) = material_id.filter(|value| !value.trim().is_empty()) {
        query = query.filter(production_task::Column::MaterialId.eq(material_id));
    }
    query.one(connection).await
}

pub async fn latest_production_task_for_session(
    connection: &DatabaseConnection,
    session_id: &str,
) -> Result<Option<production_task::Model>, DbErr> {
    if session_id.trim().is_empty() {
        return Ok(None);
    }
    production_task::Entity::find()
        .filter(production_task::Column::SessionId.eq(session_id))
        .order_by_desc(production_task::Column::CreatedAt)
        .order_by_desc(production_task::Column::Id)
        .one(connection)
        .await
}

pub async fn list_production_tasks(
    connection: &DatabaseConnection,
    filter: ProductionTaskFilter,
) -> Result<ProductionTaskPage, DbErr> {
    let limit = filter.limit.unwrap_or(50).clamp(1, 200);
    let offset = filter.offset.unwrap_or(0);
    let mut query = production_task::Entity::find()
        .order_by_desc(production_task::Column::CreatedAt)
        .order_by_desc(production_task::Column::Id);
    if let Some(status) = filter.status.as_deref().filter(|value| !value.is_empty()) {
        query = query.filter(production_task::Column::Status.eq(status));
    }
    if let Some(kind) = filter.kind.as_deref().filter(|value| !value.is_empty()) {
        query = query.filter(production_task::Column::Kind.eq(kind));
    }
    let total = query.clone().count(connection).await?;
    let tasks = query.limit(limit).offset(offset).all(connection).await?;
    Ok(ProductionTaskPage {
        tasks,
        total,
        limit,
        offset,
    })
}

pub async fn claim_next_production_task(
    connection: &DatabaseConnection,
) -> Result<Option<production_task::Model>, DbErr> {
    loop {
        let queued = production_task::Entity::find()
            .filter(production_task::Column::Status.eq("queued"))
            .filter(production_task::Column::CancelRequested.eq(false))
            .order_by_asc(production_task::Column::CreatedAt)
            .order_by_asc(production_task::Column::Id)
            .all(connection)
            .await?;
        if queued.is_empty() {
            return Ok(None);
        }
        let mut changed = false;
        for model in queued {
            match production_task_dependency_state(connection, &model).await? {
                ProductionTaskDependencyState::Waiting => continue,
                ProductionTaskDependencyState::Blocked(reason) => {
                    changed |= mark_production_task_blocked(connection, &model.id, &reason).await?;
                }
                ProductionTaskDependencyState::Ready => {
                    let now = now_millis_string();
                    let update = production_task::Entity::update_many()
                        .col_expr(production_task::Column::Status, Expr::value("running"))
                        .col_expr(production_task::Column::Phase, Expr::value("executing"))
                        .col_expr(production_task::Column::Progress, Expr::value(5))
                        .col_expr(
                            production_task::Column::Attempts,
                            Expr::value(model.attempts + 1),
                        )
                        .col_expr(production_task::Column::BlockedReason, Expr::value(""))
                        .col_expr(production_task::Column::StartedAt, Expr::value(now.clone()))
                        .col_expr(production_task::Column::FinishedAt, Expr::value(""))
                        .col_expr(production_task::Column::UpdatedAt, Expr::value(now))
                        .filter(production_task::Column::Id.eq(&model.id))
                        .filter(production_task::Column::Status.eq("queued"))
                        .filter(production_task::Column::CancelRequested.eq(false))
                        .exec(connection)
                        .await?;
                    if update.rows_affected == 1 {
                        return find_production_task(connection, &model.id).await;
                    }
                    changed = true;
                }
            }
        }
        if !changed {
            return Ok(None);
        }
    }
}

pub async fn update_production_task_progress(
    connection: &DatabaseConnection,
    id: &str,
    phase: &str,
    progress: i32,
) -> Result<Option<production_task::Model>, DbErr> {
    let now = now_millis_string();
    let update = production_task::Entity::update_many()
        .col_expr(
            production_task::Column::Phase,
            Expr::value(phase.trim().to_string()),
        )
        .col_expr(
            production_task::Column::Progress,
            Expr::value(progress.clamp(0, 99)),
        )
        .col_expr(production_task::Column::UpdatedAt, Expr::value(now))
        .filter(production_task::Column::Id.eq(id))
        .filter(production_task::Column::Status.eq("running"))
        .exec(connection)
        .await?;
    if update.rows_affected == 0 {
        return Ok(None);
    }
    find_production_task(connection, id).await
}

pub async fn finish_production_task(
    connection: &DatabaseConnection,
    id: &str,
    status: &str,
    progress: i32,
    result: String,
    error: String,
) -> Result<Option<production_task::Model>, DbErr> {
    let Some(model) = find_production_task(connection, id).await? else {
        return Ok(None);
    };
    let terminal = production_task_status_is_terminal(status);
    let now = now_millis_string();
    let mut active: production_task::ActiveModel = model.into();
    active.status = Set(status.to_string());
    active.phase = Set(status.to_string());
    active.progress = Set(progress.clamp(0, 100));
    active.result = Set(result);
    active.error = Set(error);
    active.finished_at = Set(if terminal { now.clone() } else { String::new() });
    active.updated_at = Set(now);
    let updated = active.update(connection).await?;
    if matches!(status, "failed" | "cancelled" | "interrupted" | "blocked") {
        propagate_production_task_dependency_failure(connection, id).await?;
    }
    Ok(Some(updated))
}

pub async fn request_cancel_production_task(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<production_task::Model>, DbErr> {
    let Some(model) = find_production_task(connection, id).await? else {
        return Ok(None);
    };
    if matches!(
        model.status.as_str(),
        "succeeded" | "failed" | "cancelled" | "interrupted" | "blocked"
    ) {
        return Ok(Some(model));
    }
    let now = now_millis_string();
    let queued = model.status == "queued";
    let mut active: production_task::ActiveModel = model.into();
    active.cancel_requested = Set(true);
    active.updated_at = Set(now.clone());
    if queued {
        active.status = Set("cancelled".to_string());
        active.phase = Set("cancelled".to_string());
        active.error = Set("cancelled before execution".to_string());
        active.finished_at = Set(now);
    }
    let updated = active.update(connection).await?;
    if queued {
        propagate_production_task_dependency_failure(connection, id).await?;
    }
    Ok(Some(updated))
}

pub async fn retry_production_task(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<production_task::Model>, DbErr> {
    let Some(model) = find_production_task(connection, id).await? else {
        return Ok(None);
    };
    if !matches!(
        model.status.as_str(),
        "failed" | "cancelled" | "interrupted" | "blocked"
    ) {
        return Ok(Some(model));
    }
    if model.status == "blocked"
        && production_task_dependency_state(connection, &model).await?
            != ProductionTaskDependencyState::Ready
    {
        return Ok(Some(model));
    }
    let now = now_millis_string();
    let next_max_attempts = model.max_attempts.max(model.attempts + 1).min(10);
    let mut active: production_task::ActiveModel = model.into();
    active.status = Set("queued".to_string());
    active.phase = Set("queued".to_string());
    active.progress = Set(0);
    active.max_attempts = Set(next_max_attempts);
    active.cancel_requested = Set(false);
    active.blocked_reason = Set(String::new());
    active.result = Set(String::new());
    active.error = Set(String::new());
    active.started_at = Set(String::new());
    active.finished_at = Set(String::new());
    active.updated_at = Set(now);
    let updated = active.update(connection).await?;
    requeue_blocked_production_task_descendants(connection, id).await?;
    Ok(Some(updated))
}

pub async fn recover_incomplete_production_tasks(
    connection: &DatabaseConnection,
) -> Result<u64, DbErr> {
    let tasks = production_task::Entity::find()
        .filter(production_task::Column::Status.eq("running"))
        .all(connection)
        .await?;
    let mut recovered = 0;
    for model in tasks {
        let task_id = model.id.clone();
        let now = now_millis_string();
        let cancelled = model.cancel_requested;
        let mut active: production_task::ActiveModel = model.into();
        active.status = Set(if cancelled {
            "cancelled"
        } else {
            "interrupted"
        }
        .to_string());
        active.phase = Set(if cancelled {
            "cancelled"
        } else {
            "interrupted"
        }
        .to_string());
        active.progress = Set(0);
        active.error = Set(if cancelled {
            "cancelled during service restart".to_string()
        } else {
            "execution interrupted by service restart; explicit retry required".to_string()
        });
        active.started_at = Set(String::new());
        active.finished_at = Set(now.clone());
        active.updated_at = Set(now);
        active.update(connection).await?;
        propagate_production_task_dependency_failure(connection, &task_id).await?;
        recovered += 1;
    }
    Ok(recovered)
}

pub async fn append_capture_file(
    connection: &DatabaseConnection,
    input: CaptureFileInput,
) -> Result<capture_file::Model, DbErr> {
    let existing = capture_file::Entity::find()
        .filter(capture_file::Column::InspectionId.eq(&input.inspection_id))
        .filter(capture_file::Column::CameraId.eq(&input.camera_id))
        .filter(capture_file::Column::SequenceNo.eq(input.sequence_no))
        .filter(capture_file::Column::DataName.eq(&input.data_name))
        .one(connection)
        .await?;
    if let Some(model) = existing {
        let mut active: capture_file::ActiveModel = model.into();
        active.session_id = Set(input.session_id);
        active.material_id = Set(input.material_id);
        active.camera_ip = Set(input.camera_ip);
        active.file_type = Set(input.file_type);
        active.path = Set(input.path);
        active.metadata_path = Set(input.metadata_path);
        active.created_at = Set(now_millis_string());
        return active.update(connection).await;
    }
    capture_file::ActiveModel {
        id: Set(format!("CAP-{}", now_nanos_string())),
        inspection_id: Set(input.inspection_id),
        session_id: Set(input.session_id),
        material_id: Set(input.material_id),
        camera_id: Set(input.camera_id),
        camera_ip: Set(input.camera_ip),
        data_name: Set(input.data_name),
        sequence_no: Set(input.sequence_no),
        file_type: Set(input.file_type),
        path: Set(input.path),
        metadata_path: Set(input.metadata_path),
        created_at: Set(now_millis_string()),
    }
    .insert(connection)
    .await
}

pub async fn capture_files_for_inspection(
    connection: &DatabaseConnection,
    inspection_id: &str,
) -> Result<Vec<capture_file::Model>, DbErr> {
    capture_file::Entity::find()
        .filter(capture_file::Column::InspectionId.eq(inspection_id))
        .order_by_asc(capture_file::Column::CameraId)
        .order_by_asc(capture_file::Column::SequenceNo)
        .order_by_asc(capture_file::Column::DataName)
        .all(connection)
        .await
}

pub async fn production_defects_for_inspection(
    connection: &DatabaseConnection,
    inspection_id: &str,
) -> Result<Vec<production_defect::Model>, DbErr> {
    production_defect::Entity::find()
        .filter(production_defect::Column::InspectionId.eq(inspection_id))
        .order_by_asc(production_defect::Column::CreatedAt)
        .all(connection)
        .await
}

async fn insert_production_defect<C>(
    connection: &C,
    input: ProductionDefectInput,
) -> Result<production_defect::Model, DbErr>
where
    C: ConnectionTrait,
{
    production_defect::ActiveModel {
        id: Set(format!("PDF-{}", now_nanos_string())),
        inspection_id: Set(input.inspection_id),
        material_id: Set(input.material_id),
        camera_id: Set(input.camera_id),
        defect_type: Set(input.defect_type),
        severity: Set(input.severity),
        x_mm: Set(input.x_mm),
        y_mm: Set(input.y_mm),
        z_mm: Set(input.z_mm),
        width_mm: Set(input.width_mm),
        height_mm: Set(input.height_mm),
        depth_mm: Set(input.depth_mm),
        confidence: Set(input.confidence),
        geometry_json: Set(input.geometry_json),
        created_at: Set(now_millis_string()),
    }
    .insert(connection)
    .await
}

#[cfg(test)]
pub async fn append_production_defect(
    connection: &DatabaseConnection,
    input: ProductionDefectInput,
) -> Result<production_defect::Model, DbErr> {
    insert_production_defect(connection, input).await
}

async fn ensure_production_alarm_on<C>(
    connection: &C,
    input: ProductionAlarmInput,
) -> Result<(production_alarm::Model, bool), DbErr>
where
    C: ConnectionTrait,
{
    if let Some(existing) = production_alarm::Entity::find()
        .filter(production_alarm::Column::Id.eq(&input.id))
        .one(connection)
        .await?
    {
        return Ok((existing, false));
    }
    let model = production_alarm::ActiveModel {
        id: Set(input.id),
        source: Set(input.source),
        alarm_type: Set(input.alarm_type),
        severity: Set(input.severity),
        material_id: Set(input.material_id),
        session_id: Set(input.session_id),
        inspection_id: Set(input.inspection_id),
        camera_id: Set(input.camera_id),
        message: Set(input.message),
        details: Set(input.details),
        status: Set("active".to_string()),
        created_at: Set(now_millis_string()),
        acknowledged_at: Set(String::new()),
        resolved_at: Set(String::new()),
        acknowledged_by: Set(String::new()),
        acknowledge_note: Set(String::new()),
        resolved_by: Set(String::new()),
        resolve_note: Set(String::new()),
    }
    .insert(connection)
    .await?;
    Ok((model, true))
}

#[cfg(test)]
pub async fn ensure_production_alarm(
    connection: &DatabaseConnection,
    input: ProductionAlarmInput,
) -> Result<(production_alarm::Model, bool), DbErr> {
    ensure_production_alarm_on(connection, input).await
}

pub async fn reconcile_managed_alarm(
    connection: &DatabaseConnection,
    source: &str,
    alarm_type: &str,
    active: Option<ProductionAlarmInput>,
    actor: &str,
) -> Result<ManagedAlarmReconcile, DbErr> {
    let existing = production_alarm::Entity::find()
        .filter(production_alarm::Column::Source.eq(source))
        .filter(production_alarm::Column::AlarmType.eq(alarm_type))
        .filter(production_alarm::Column::Status.is_in(["active", "acknowledged"]))
        .order_by_desc(production_alarm::Column::CreatedAt)
        .order_by_desc(production_alarm::Column::Id)
        .one(connection)
        .await?;

    match (existing, active) {
        (None, None) => Ok(ManagedAlarmReconcile::Absent),
        (None, Some(input)) => {
            let (alarm, created) = ensure_production_alarm_on(connection, input).await?;
            if created {
                Ok(ManagedAlarmReconcile::Created(alarm))
            } else {
                Ok(ManagedAlarmReconcile::Unchanged)
            }
        }
        (Some(existing), Some(input)) => {
            let changed = existing.severity != input.severity
                || existing.material_id != input.material_id
                || existing.session_id != input.session_id
                || existing.inspection_id != input.inspection_id
                || existing.camera_id != input.camera_id
                || existing.message != input.message
                || existing.details != input.details;
            if !changed {
                return Ok(ManagedAlarmReconcile::Unchanged);
            }
            production_alarm::Entity::update_many()
                .col_expr(
                    production_alarm::Column::Severity,
                    Expr::value(input.severity),
                )
                .col_expr(
                    production_alarm::Column::MaterialId,
                    Expr::value(input.material_id),
                )
                .col_expr(
                    production_alarm::Column::SessionId,
                    Expr::value(input.session_id),
                )
                .col_expr(
                    production_alarm::Column::InspectionId,
                    Expr::value(input.inspection_id),
                )
                .col_expr(
                    production_alarm::Column::CameraId,
                    Expr::value(input.camera_id),
                )
                .col_expr(
                    production_alarm::Column::Message,
                    Expr::value(input.message),
                )
                .col_expr(
                    production_alarm::Column::Details,
                    Expr::value(input.details),
                )
                .filter(production_alarm::Column::Id.eq(&existing.id))
                .filter(production_alarm::Column::Status.is_in(["active", "acknowledged"]))
                .exec(connection)
                .await?;
            let current = production_alarm::Entity::find_by_id(&existing.id)
                .one(connection)
                .await?
                .ok_or_else(|| {
                    DbErr::Custom("managed alarm disappeared during refresh".to_string())
                })?;
            Ok(ManagedAlarmReconcile::Updated(current))
        }
        (Some(existing), None) => {
            let now = now_millis_string();
            let acknowledged_at = if existing.acknowledged_at.is_empty() {
                now.clone()
            } else {
                existing.acknowledged_at.clone()
            };
            let acknowledged_by = if existing.acknowledged_by.is_empty() {
                actor.to_string()
            } else {
                existing.acknowledged_by.clone()
            };
            let acknowledge_note = if existing.acknowledge_note.is_empty() {
                "系统检测到运行条件已恢复，自动确认并关闭告警。".to_string()
            } else {
                existing.acknowledge_note.clone()
            };
            production_alarm::Entity::update_many()
                .col_expr(production_alarm::Column::Status, Expr::value("resolved"))
                .col_expr(
                    production_alarm::Column::AcknowledgedAt,
                    Expr::value(acknowledged_at),
                )
                .col_expr(
                    production_alarm::Column::AcknowledgedBy,
                    Expr::value(acknowledged_by),
                )
                .col_expr(
                    production_alarm::Column::AcknowledgeNote,
                    Expr::value(acknowledge_note),
                )
                .col_expr(production_alarm::Column::ResolvedAt, Expr::value(now))
                .col_expr(
                    production_alarm::Column::ResolvedBy,
                    Expr::value(actor.to_string()),
                )
                .col_expr(
                    production_alarm::Column::ResolveNote,
                    Expr::value("系统健康监视器确认运行条件已恢复。"),
                )
                .filter(production_alarm::Column::Id.eq(&existing.id))
                .filter(production_alarm::Column::Status.is_in(["active", "acknowledged"]))
                .exec(connection)
                .await?;
            let current = production_alarm::Entity::find_by_id(&existing.id)
                .one(connection)
                .await?
                .ok_or_else(|| {
                    DbErr::Custom("managed alarm disappeared during recovery".to_string())
                })?;
            Ok(ManagedAlarmReconcile::Resolved(current))
        }
    }
}

pub async fn append_production_defect_with_alarm(
    connection: &DatabaseConnection,
    defect: ProductionDefectInput,
    alarm: Option<ProductionAlarmInput>,
) -> Result<
    (
        production_defect::Model,
        Option<(production_alarm::Model, bool)>,
    ),
    DbErr,
> {
    let transaction = connection.begin().await?;
    let defect = insert_production_defect(&transaction, defect).await?;
    let alarm = match alarm {
        Some(input) => Some(ensure_production_alarm_on(&transaction, input).await?),
        None => None,
    };
    transaction.commit().await?;
    Ok((defect, alarm))
}

fn filtered_production_alarms(
    filter: &ProductionAlarmFilter,
) -> sea_orm::Select<production_alarm::Entity> {
    let mut query = production_alarm::Entity::find()
        .order_by_desc(production_alarm::Column::CreatedAt)
        .order_by_desc(production_alarm::Column::Id);
    if let Some(status) = filter.status.as_deref().filter(|value| !value.is_empty()) {
        query = match status {
            "open" => {
                query.filter(production_alarm::Column::Status.is_in(["active", "acknowledged"]))
            }
            "history" => query.filter(production_alarm::Column::Status.eq("resolved")),
            "all" => query,
            _ => query.filter(production_alarm::Column::Status.eq(status)),
        };
    }
    if let Some(severity) = filter
        .severity
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "all")
    {
        query = query.filter(production_alarm::Column::Severity.eq(severity));
    }
    if let Some(source) = filter
        .source
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "all")
    {
        query = query.filter(production_alarm::Column::Source.eq(source));
    }
    if let Some(keyword) = filter.keyword.as_deref().filter(|value| !value.is_empty()) {
        query = query.filter(
            production_alarm::Column::Id
                .contains(keyword)
                .or(production_alarm::Column::AlarmType.contains(keyword))
                .or(production_alarm::Column::Message.contains(keyword))
                .or(production_alarm::Column::MaterialId.contains(keyword))
                .or(production_alarm::Column::InspectionId.contains(keyword))
                .or(production_alarm::Column::CameraId.contains(keyword)),
        );
    }
    query
}

pub async fn list_production_alarms(
    connection: &DatabaseConnection,
    filter: ProductionAlarmFilter,
) -> Result<ProductionAlarmPage, DbErr> {
    let limit = filter.limit.unwrap_or(50).clamp(1, 200);
    let offset = filter.offset.unwrap_or(0);
    let query = filtered_production_alarms(&filter);
    let total = query.clone().count(connection).await?;
    let alarms = query.limit(limit).offset(offset).all(connection).await?;
    Ok(ProductionAlarmPage {
        alarms,
        total,
        limit,
        offset,
    })
}

pub async fn production_alarm_counts(
    connection: &DatabaseConnection,
) -> Result<ProductionAlarmCounts, DbErr> {
    Ok(ProductionAlarmCounts {
        active: production_alarm::Entity::find()
            .filter(production_alarm::Column::Status.eq("active"))
            .count(connection)
            .await?,
        acknowledged: production_alarm::Entity::find()
            .filter(production_alarm::Column::Status.eq("acknowledged"))
            .count(connection)
            .await?,
        resolved: production_alarm::Entity::find()
            .filter(production_alarm::Column::Status.eq("resolved"))
            .count(connection)
            .await?,
    })
}

pub async fn acknowledge_production_alarm(
    connection: &DatabaseConnection,
    id: &str,
    actor: &str,
    note: &str,
) -> Result<ProductionAlarmTransition, DbErr> {
    let Some(existing) = production_alarm::Entity::find()
        .filter(production_alarm::Column::Id.eq(id))
        .one(connection)
        .await?
    else {
        return Ok(ProductionAlarmTransition::NotFound);
    };
    if existing.status == "acknowledged" {
        return Ok(ProductionAlarmTransition::Unchanged(existing));
    }
    if existing.status != "active" {
        return Ok(ProductionAlarmTransition::Conflict(existing));
    }
    let now = now_millis_string();
    let update = production_alarm::Entity::update_many()
        .col_expr(
            production_alarm::Column::Status,
            Expr::value("acknowledged"),
        )
        .col_expr(production_alarm::Column::AcknowledgedAt, Expr::value(now))
        .col_expr(
            production_alarm::Column::AcknowledgedBy,
            Expr::value(actor.to_string()),
        )
        .col_expr(
            production_alarm::Column::AcknowledgeNote,
            Expr::value(note.to_string()),
        )
        .filter(production_alarm::Column::Id.eq(id))
        .filter(production_alarm::Column::Status.eq("active"))
        .exec(connection)
        .await?;
    let current = production_alarm::Entity::find()
        .filter(production_alarm::Column::Id.eq(id))
        .one(connection)
        .await?
        .ok_or_else(|| DbErr::Custom("alarm disappeared during acknowledge".to_string()))?;
    if update.rows_affected == 1 {
        Ok(ProductionAlarmTransition::Changed(current))
    } else if current.status == "acknowledged" {
        Ok(ProductionAlarmTransition::Unchanged(current))
    } else {
        Ok(ProductionAlarmTransition::Conflict(current))
    }
}

pub async fn resolve_production_alarm(
    connection: &DatabaseConnection,
    id: &str,
    actor: &str,
    note: &str,
) -> Result<ProductionAlarmTransition, DbErr> {
    let Some(existing) = production_alarm::Entity::find()
        .filter(production_alarm::Column::Id.eq(id))
        .one(connection)
        .await?
    else {
        return Ok(ProductionAlarmTransition::NotFound);
    };
    if existing.status == "resolved" {
        return Ok(ProductionAlarmTransition::Unchanged(existing));
    }
    if existing.status != "acknowledged" {
        return Ok(ProductionAlarmTransition::Conflict(existing));
    }
    let now = now_millis_string();
    let update = production_alarm::Entity::update_many()
        .col_expr(production_alarm::Column::Status, Expr::value("resolved"))
        .col_expr(production_alarm::Column::ResolvedAt, Expr::value(now))
        .col_expr(
            production_alarm::Column::ResolvedBy,
            Expr::value(actor.to_string()),
        )
        .col_expr(
            production_alarm::Column::ResolveNote,
            Expr::value(note.to_string()),
        )
        .filter(production_alarm::Column::Id.eq(id))
        .filter(production_alarm::Column::Status.eq("acknowledged"))
        .exec(connection)
        .await?;
    let current = production_alarm::Entity::find()
        .filter(production_alarm::Column::Id.eq(id))
        .one(connection)
        .await?
        .ok_or_else(|| DbErr::Custom("alarm disappeared during resolve".to_string()))?;
    if update.rows_affected == 1 {
        Ok(ProductionAlarmTransition::Changed(current))
    } else if current.status == "resolved" {
        Ok(ProductionAlarmTransition::Unchanged(current))
    } else {
        Ok(ProductionAlarmTransition::Conflict(current))
    }
}

pub async fn get_config(
    connection: &DatabaseConnection,
    key: &str,
) -> Result<Option<AppConfigValue>, DbErr> {
    let value = app_config::Entity::find()
        .filter(app_config::Column::Key.eq(key))
        .one(connection)
        .await?;
    Ok(value.map(|model| AppConfigValue { value: model.value }))
}

pub async fn set_config(
    connection: &DatabaseConnection,
    key: &str,
    value: &str,
) -> Result<(), DbErr> {
    let existing = app_config::Entity::find()
        .filter(app_config::Column::Key.eq(key))
        .one(connection)
        .await?;
    if let Some(model) = existing {
        let mut active: app_config::ActiveModel = model.into();
        active.value = Set(value.to_string());
        active.updated_at = Set(now_millis_string());
        active.update(connection).await?;
    } else {
        app_config::ActiveModel {
            key: Set(key.to_string()),
            value: Set(value.to_string()),
            updated_at: Set(now_millis_string()),
        }
        .insert(connection)
        .await?;
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct BkvImportMaterial {
    pub seq_no: i64,
    pub material_id: String,
    pub steel_plate_id: String,
    pub inspection_record_id: String,
    pub session_id: String,
    pub inspection_id: String,
    pub width_mm: f64,
    pub length_mm: f64,
    pub thickness_mm: f64,
    pub steel_grade: String,
    pub occurred_at: String,
    pub raw_payload: String,
}

#[derive(Clone, Debug)]
pub struct BkvImportArtifact {
    pub id: String,
    pub inspection_id: String,
    pub session_id: String,
    pub material_id: String,
    pub camera_id: String,
    pub data_name: String,
    pub sequence_no: i64,
    pub file_type: String,
    pub path: String,
    pub metadata_json: String,
}

#[derive(Clone, Debug)]
pub struct BkvImportDefect {
    pub id: String,
    pub inspection_id: String,
    pub material_id: String,
    pub camera_id: String,
    pub defect_type: String,
    pub severity: String,
    pub x_mm: f64,
    pub y_mm: f64,
    pub z_mm: f64,
    pub width_mm: f64,
    pub height_mm: f64,
    pub depth_mm: f64,
    pub confidence: f64,
    pub provenance_json: String,
}

#[derive(Clone, Debug)]
pub struct BkvImportBatch {
    pub batch_id: String,
    pub content_id: String,
    pub manifest_json: String,
    pub status: String,
    pub materials: Vec<BkvImportMaterial>,
    pub artifacts: Vec<BkvImportArtifact>,
    pub defects: Vec<BkvImportDefect>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct BkvImportCounts {
    pub materials: usize,
    pub inspections: usize,
    pub artifacts: usize,
    pub defects: usize,
}

#[derive(Clone, Debug)]
pub struct BkvImportResult {
    pub batch_id: String,
    pub content_id: String,
    pub already_imported: bool,
    pub counts: BkvImportCounts,
}

async fn bkv_upsert_config<C>(
    connection: &C,
    key: String,
    value: String,
    now: &str,
) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    if let Some(existing) = app_config::Entity::find()
        .filter(app_config::Column::Key.eq(&key))
        .one(connection)
        .await?
    {
        let mut active: app_config::ActiveModel = existing.into();
        active.value = Set(value);
        active.updated_at = Set(now.to_string());
        active.update(connection).await?;
    } else {
        app_config::ActiveModel {
            key: Set(key),
            value: Set(value),
            updated_at: Set(now.to_string()),
        }
        .insert(connection)
        .await?;
    }
    Ok(())
}

fn bkv_finite_non_negative(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}

pub async fn import_bkv_batch(
    connection: &DatabaseConnection,
    batch: BkvImportBatch,
    actor: &str,
) -> Result<BkvImportResult, DbErr> {
    let config_key = format!("bkv.batch.{}", batch.batch_id);
    if let Some(existing) = app_config::Entity::find()
        .filter(app_config::Column::Key.eq(&config_key))
        .one(connection)
        .await?
    {
        let value: Value = serde_json::from_str(&existing.value)
            .map_err(|error| DbErr::Custom(format!("bkv_import_state_invalid: {error}")))?;
        if value.get("contentId").and_then(Value::as_str) != Some(batch.content_id.as_str()) {
            return Err(DbErr::Custom("bkv_batch_id_collision".to_string()));
        }
        let counts: BkvImportCounts =
            serde_json::from_value(value.get("counts").cloned().unwrap_or(Value::Null))
                .map_err(|error| DbErr::Custom(format!("bkv_import_state_invalid: {error}")))?;
        return Ok(BkvImportResult {
            batch_id: batch.batch_id,
            content_id: batch.content_id,
            already_imported: true,
            counts,
        });
    }
    if batch
        .materials
        .iter()
        .map(|item| item.seq_no)
        .collect::<Vec<_>>()
        != (1_893_700_i64..=1_893_710).collect::<Vec<_>>()
    {
        return Err(DbErr::Custom("bkv_seq_scope_invalid".to_string()));
    }
    let counts = BkvImportCounts {
        materials: batch.materials.len(),
        inspections: batch.materials.len(),
        artifacts: batch.artifacts.len(),
        defects: batch.defects.len(),
    };
    let now = now_millis_string();
    let transaction = connection.begin().await?;
    for material in &batch.materials {
        if !bkv_finite_non_negative(material.width_mm)
            || !bkv_finite_non_negative(material.length_mm)
            || !bkv_finite_non_negative(material.thickness_mm)
            || material.width_mm > i32::MAX as f64
            || material.length_mm > i32::MAX as f64
            || material.thickness_mm > i32::MAX as f64
        {
            transaction.rollback().await?;
            return Err(DbErr::Custom("bkv_normalized_row_invalid".to_string()));
        }
        let defect_count = batch
            .defects
            .iter()
            .filter(|defect| defect.inspection_id == material.inspection_id)
            .count();
        let capture_count = batch
            .artifacts
            .iter()
            .filter(|artifact| artifact.inspection_id == material.inspection_id)
            .count();
        steel_plate::ActiveModel {
            plate_no: Set(material.steel_plate_id.clone()),
            width_mm: Set(material.width_mm.round() as i32),
            length_mm: Set(material.length_mm.round() as i32),
            thickness_mm: Set(material.thickness_mm.round() as i32),
            steel_grade: Set(material.steel_grade.clone()),
            detected_at: Set(material.occurred_at.clone()),
        }
        .insert(&transaction)
        .await?;
        inspection_record::ActiveModel {
            id: Set(material.inspection_record_id.clone()),
            time: Set(material.occurred_at.clone()),
            plate_no: Set(material.steel_plate_id.clone()),
            status: Set(if defect_count == 0 {
                "normal"
            } else {
                "defect"
            }
            .to_string()),
            defect_count: Set(defect_count.min(i32::MAX as usize) as i32),
        }
        .insert(&transaction)
        .await?;
        material_session::ActiveModel {
            id: Set(material.session_id.clone()),
            material_id: Set(material.material_id.clone()),
            source: Set("bkv".to_string()),
            status: Set("completed".to_string()),
            control_mode: Set("offline-replay".to_string()),
            trigger_mode: Set("bkv".to_string()),
            steel_type: Set(material.steel_grade.clone()),
            width_mm: Set(material.width_mm),
            length_mm: Set(material.length_mm),
            thickness_mm: Set(material.thickness_mm),
            client: Set(String::new()),
            hard: Set(String::new()),
            storage_root: Set(String::new()),
            started_at: Set(material.occurred_at.clone()),
            finished_at: Set(material.occurred_at.clone()),
            updated_at: Set(now.clone()),
            raw_payload: Set(material.raw_payload.clone()),
        }
        .insert(&transaction)
        .await?;
        production_inspection::ActiveModel {
            id: Set(material.inspection_id.clone()),
            material_id: Set(material.material_id.clone()),
            session_id: Set(material.session_id.clone()),
            status: Set(if defect_count == 0 {
                "completed"
            } else {
                "defect"
            }
            .to_string()),
            storage_root: Set(String::new()),
            summary_path: Set(String::new()),
            started_at: Set(material.occurred_at.clone()),
            finished_at: Set(material.occurred_at.clone()),
            capture_count: Set(capture_count.min(i32::MAX as usize) as i32),
            defect_count: Set(defect_count.min(i32::MAX as usize) as i32),
            raw_payload: Set(material.raw_payload.clone()),
        }
        .insert(&transaction)
        .await?;
    }
    for artifact in &batch.artifacts {
        capture_file::ActiveModel {
            id: Set(artifact.id.clone()),
            inspection_id: Set(artifact.inspection_id.clone()),
            session_id: Set(artifact.session_id.clone()),
            material_id: Set(artifact.material_id.clone()),
            camera_id: Set(artifact.camera_id.clone()),
            camera_ip: Set(String::new()),
            data_name: Set(artifact.data_name.clone()),
            sequence_no: Set(i32::try_from(artifact.sequence_no)
                .map_err(|_| DbErr::Custom("bkv_artifact_invalid".to_string()))?),
            file_type: Set(artifact.file_type.clone()),
            path: Set(artifact.path.clone()),
            metadata_path: Set(artifact.metadata_json.clone()),
            created_at: Set(now.clone()),
        }
        .insert(&transaction)
        .await?;
    }
    for defect in &batch.defects {
        if ![
            defect.x_mm,
            defect.y_mm,
            defect.z_mm,
            defect.width_mm,
            defect.height_mm,
            defect.depth_mm,
            defect.confidence,
        ]
        .into_iter()
        .all(f64::is_finite)
        {
            transaction.rollback().await?;
            return Err(DbErr::Custom("bkv_normalized_row_invalid".to_string()));
        }
        production_defect::ActiveModel {
            id: Set(defect.id.clone()),
            inspection_id: Set(defect.inspection_id.clone()),
            material_id: Set(defect.material_id.clone()),
            camera_id: Set(defect.camera_id.clone()),
            defect_type: Set(defect.defect_type.clone()),
            severity: Set(defect.severity.clone()),
            x_mm: Set(defect.x_mm),
            y_mm: Set(defect.y_mm),
            z_mm: Set(defect.z_mm),
            width_mm: Set(defect.width_mm),
            height_mm: Set(defect.height_mm),
            depth_mm: Set(defect.depth_mm),
            confidence: Set(defect.confidence),
            geometry_json: Set(defect.provenance_json.clone()),
            created_at: Set(now.clone()),
        }
        .insert(&transaction)
        .await?;
    }
    let batch_state = json!({
        "batchId": batch.batch_id,
        "contentId": batch.content_id,
        "status": batch.status,
        "manifest": serde_json::from_str::<Value>(&batch.manifest_json).map_err(|error| DbErr::Custom(format!("bkv_manifest_invalid_json: {error}")))?,
        "counts": counts,
        "importedAt": now,
        "actor": actor
    });
    bkv_upsert_config(&transaction, config_key, batch_state.to_string(), &now).await?;
    bkv_upsert_config(
        &transaction,
        format!("bkv.replay.{}", batch.batch_id),
        json!({"batchId":batch.batch_id,"contentId":batch.content_id,"index":0,"status":"ready","version":0,"updatedAt":now}).to_string(),
        &now,
    )
    .await?;
    bkv_upsert_config(
        &transaction,
        "bkv.active-batch".to_string(),
        json!({"batchId":batch.batch_id,"contentId":batch.content_id}).to_string(),
        &now,
    )
    .await?;
    audit_log::ActiveModel {
        id: Set(format!("AUD-BKV-{}", batch.content_id)),
        actor: Set(actor.to_string()),
        action: Set("bkv.import".to_string()),
        target: Set(batch.batch_id.clone()),
        detail: Set(
            json!({"batchId":batch.batch_id,"contentId":batch.content_id,"counts":counts})
                .to_string(),
        ),
        level: Set("info".to_string()),
        created_at: Set(now),
    }
    .insert(&transaction)
    .await?;
    transaction.commit().await?;
    Ok(BkvImportResult {
        batch_id: batch.batch_id,
        content_id: batch.content_id,
        already_imported: false,
        counts,
    })
}

pub async fn reset_bkv_replay(
    connection: &DatabaseConnection,
    actor: &str,
) -> Result<Value, DbErr> {
    let transaction = connection.begin().await?;
    let active = app_config::Entity::find()
        .filter(app_config::Column::Key.eq("bkv.active-batch"))
        .one(&transaction)
        .await?
        .ok_or_else(|| DbErr::Custom("bkv_active_batch_missing".to_string()))?;
    let active_value: Value = serde_json::from_str(&active.value)
        .map_err(|error| DbErr::Custom(format!("bkv_import_state_invalid: {error}")))?;
    let batch_id = active_value
        .get("batchId")
        .and_then(Value::as_str)
        .ok_or_else(|| DbErr::Custom("bkv_import_state_invalid".to_string()))?;
    let replay_key = format!("bkv.replay.{batch_id}");
    let replay = app_config::Entity::find()
        .filter(app_config::Column::Key.eq(&replay_key))
        .one(&transaction)
        .await?
        .ok_or_else(|| DbErr::Custom("bkv_replay_state_missing".to_string()))?;
    let previous: Value = serde_json::from_str(&replay.value)
        .map_err(|error| DbErr::Custom(format!("bkv_import_state_invalid: {error}")))?;
    let now = now_millis_string();
    let next = json!({
        "batchId": batch_id,
        "contentId": active_value.get("contentId").cloned().unwrap_or(Value::Null),
        "index": 0,
        "status": "ready",
        "version": previous.get("version").and_then(Value::as_i64).unwrap_or(0).saturating_add(1),
        "updatedAt": now,
        "resetBy": actor
    });
    let mut active_replay: app_config::ActiveModel = replay.into();
    active_replay.value = Set(next.to_string());
    active_replay.updated_at = Set(now.clone());
    active_replay.update(&transaction).await?;
    audit_log::ActiveModel {
        id: Set(format!("AUD-BKV-RESET-{batch_id}-{}", next["version"])),
        actor: Set(actor.to_string()),
        action: Set("bkv.replay.reset".to_string()),
        target: Set(batch_id.to_string()),
        detail: Set(json!({"batchId":batch_id,"version":next["version"]}).to_string()),
        level: Set("warning".to_string()),
        created_at: Set(now),
    }
    .insert(&transaction)
    .await?;
    transaction.commit().await?;
    Ok(next)
}

pub async fn append_config_revision(
    connection: &DatabaseConnection,
    key: &str,
    value: &str,
    actor: &str,
    action: &str,
) -> Result<config_revision::Model, DbErr> {
    config_revision::ActiveModel {
        id: Set(format!("CFG-{}", now_nanos_string())),
        config_key: Set(key.to_string()),
        value: Set(value.to_string()),
        actor: Set(actor.to_string()),
        action: Set(action.to_string()),
        bytes: Set(value.len().min(i32::MAX as usize) as i32),
        created_at: Set(now_millis_string()),
    }
    .insert(connection)
    .await
}

pub async fn list_config_revisions(
    connection: &DatabaseConnection,
    key: Option<String>,
    limit: u64,
) -> Result<Vec<config_revision::Model>, DbErr> {
    let mut query = config_revision::Entity::find()
        .order_by_desc(config_revision::Column::CreatedAt)
        .limit(limit.clamp(1, 100));
    if let Some(key) = key.filter(|value| !value.trim().is_empty() && value != "all") {
        query = query.filter(config_revision::Column::ConfigKey.eq(key));
    }
    query.all(connection).await
}

pub async fn find_config_revision(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<config_revision::Model>, DbErr> {
    config_revision::Entity::find()
        .filter(config_revision::Column::Id.eq(id))
        .one(connection)
        .await
}

pub async fn append_audit_log(
    connection: &DatabaseConnection,
    actor: &str,
    action: &str,
    target: &str,
    detail: &str,
    level: &str,
) -> Result<(), DbErr> {
    audit_log::ActiveModel {
        id: Set(format!("AUD-{}", now_nanos_string())),
        actor: Set(actor.to_string()),
        action: Set(action.to_string()),
        target: Set(target.to_string()),
        detail: Set(detail.to_string()),
        level: Set(level.to_string()),
        created_at: Set(now_millis_string()),
    }
    .insert(connection)
    .await?;
    Ok(())
}

pub fn now_millis_string() -> String {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis().to_string(),
        Err(_) => "0".to_string(),
    }
}

pub fn legacy_admin_password_hash(user_id: &str, password: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
            hash ^= hash.rotate_left(13);
        }
    };
    feed(b"steel-inspection-admin-auth:v1");
    feed(user_id.as_bytes());
    feed(b":");
    feed(password.as_bytes());
    format!("steel-v1:{}:{:016x}", user_id, hash)
}

pub fn hash_admin_password(_user_id: &str, password: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .expect("argon2 admin password hashing should not fail")
        .to_string()
}

pub fn admin_password_hash_needs_upgrade(password_hash: &str) -> bool {
    !password_hash.starts_with("$argon2")
}

pub fn verify_admin_password(user: &admin_user::Model, password: &str) -> bool {
    if user.password_hash.is_empty() {
        return false;
    }
    if user.password_hash.starts_with("$argon2") {
        return PasswordHash::new(&user.password_hash)
            .ok()
            .and_then(|parsed| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &parsed)
                    .ok()
            })
            .is_some();
    }
    user.password_hash == legacy_admin_password_hash(&user.id, password)
}

fn append_permission(permissions: &str, permission: &str) -> String {
    let mut items = serde_json::from_str::<Vec<String>>(permissions).unwrap_or_default();
    if !items.iter().any(|item| item == permission) {
        items.push(permission.to_string());
    }
    serde_json::to_string(&items).unwrap_or_else(|_| "[]".to_string())
}

fn now_nanos_string() -> String {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos().to_string(),
        Err(_) => "0".to_string(),
    }
}

fn parse_millis_cutoff(cutoff_at: &str) -> Result<i64, DbErr> {
    cutoff_at
        .parse::<i64>()
        .map_err(|_| DbErr::Custom("invalid audit retention cutoff".to_string()))
}

async fn execute(connection: &DatabaseConnection, sql: &str) -> Result<(), DbErr> {
    connection
        .execute(Statement::from_string(
            connection.get_database_backend(),
            sql.to_string(),
        ))
        .await
        .map(|_| ())
}

async fn execute_compatible_migration(
    connection: &DatabaseConnection,
    sql: &str,
) -> Result<(), DbErr> {
    match execute(connection, sql).await {
        Ok(()) => Ok(()),
        Err(error) => {
            let message = error.to_string().to_ascii_lowercase();
            if message.contains("duplicate column")
                || message.contains("duplicate column name")
                || message.contains("duplicate key name")
                || message.contains("already exists")
            {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

async fn schema_table_count(
    connection: &DatabaseConnection,
    table_name: &str,
) -> Result<i64, DbErr> {
    if table_name != "steel_schema_state" && table_name != "steel_schema_migration" {
        return Err(DbErr::Custom(
            "unsupported schema ledger table name".to_string(),
        ));
    }
    let sql = match connection.get_database_backend() {
        DbBackend::Sqlite => format!(
            "SELECT COUNT(*) AS table_count FROM sqlite_master WHERE type = 'table' AND name = '{table_name}'"
        ),
        DbBackend::MySql => format!(
            "SELECT CAST(COUNT(*) AS SIGNED) AS table_count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '{table_name}'"
        ),
        DbBackend::Postgres => format!(
            "SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = '{table_name}'"
        ),
    };
    connection
        .query_one(Statement::from_string(
            connection.get_database_backend(),
            sql,
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("schema table count query returned no row".to_string()))?
        .try_get("", "table_count")
}

async fn application_table_count(connection: &DatabaseConnection) -> Result<i64, DbErr> {
    let sql = match connection.get_database_backend() {
        DbBackend::Sqlite => "SELECT COUNT(*) AS table_count FROM sqlite_master \
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
             AND name NOT IN ('steel_schema_state', 'steel_schema_migration')"
            .to_string(),
        DbBackend::MySql => "SELECT CAST(COUNT(*) AS SIGNED) AS table_count \
             FROM information_schema.tables WHERE table_schema = DATABASE() \
             AND table_name NOT IN ('steel_schema_state', 'steel_schema_migration')"
            .to_string(),
        DbBackend::Postgres => "SELECT COUNT(*) AS table_count \
             FROM information_schema.tables WHERE table_schema = current_schema() \
             AND table_name NOT IN ('steel_schema_state', 'steel_schema_migration')"
            .to_string(),
    };
    connection
        .query_one(Statement::from_string(
            connection.get_database_backend(),
            sql,
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("application table count query returned no row".to_string()))?
        .try_get("", "table_count")
}

async fn create_schema_ledger(connection: &DatabaseConnection) -> Result<(), DbErr> {
    execute(
        connection,
        "CREATE TABLE steel_schema_state (
            singleton_id INTEGER PRIMARY KEY NOT NULL,
            current_version BIGINT NOT NULL,
            dirty INTEGER NOT NULL,
            active_migration_id VARCHAR(128) NOT NULL,
            updated_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE steel_schema_migration (
            migration_id VARCHAR(128) PRIMARY KEY NOT NULL,
            from_version BIGINT NOT NULL,
            to_version BIGINT NOT NULL,
            engine VARCHAR(32) NOT NULL,
            checksum VARCHAR(64) NOT NULL,
            release_version VARCHAR(64) NOT NULL,
            release_commit VARCHAR(64) NOT NULL,
            transaction_id VARCHAR(128) NOT NULL,
            state VARCHAR(32) NOT NULL,
            started_at VARCHAR(64) NOT NULL,
            applied_at VARCHAR(64) NOT NULL,
            error TEXT NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        &format!(
            "INSERT INTO steel_schema_state \
             (singleton_id, current_version, dirty, active_migration_id, updated_at) \
             VALUES (1, {}, 0, '', '{}')",
            DATABASE_SCHEMA_VERSION,
            now_millis_string()
        ),
    )
    .await
}

async fn validate_schema_ledger(connection: &DatabaseConnection) -> Result<i64, DbErr> {
    let count_sql = match connection.get_database_backend() {
        DbBackend::MySql => "SELECT CAST(COUNT(*) AS SIGNED) AS row_count FROM steel_schema_state",
        _ => "SELECT COUNT(*) AS row_count FROM steel_schema_state",
    };
    let row_count = connection
        .query_one(Statement::from_string(
            connection.get_database_backend(),
            count_sql.to_string(),
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("schema state count query returned no row".to_string()))?
        .try_get::<i64>("", "row_count")?;
    if row_count != 1 {
        return Err(DbErr::Custom(format!(
            "steel_schema_state must contain exactly one row, found {row_count}"
        )));
    }
    let state_sql = match connection.get_database_backend() {
        DbBackend::MySql => {
            "SELECT current_version, CAST(dirty AS SIGNED) AS dirty, active_migration_id \
             FROM steel_schema_state WHERE singleton_id = 1"
        }
        _ => {
            "SELECT current_version, dirty, active_migration_id \
             FROM steel_schema_state WHERE singleton_id = 1"
        }
    };
    let row = connection
        .query_one(Statement::from_string(
            connection.get_database_backend(),
            state_sql.to_string(),
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("steel_schema_state singleton row is missing".to_string()))?;
    let current_version = row.try_get::<i64>("", "current_version")?;
    let dirty = if connection.get_database_backend() == DbBackend::Postgres {
        i64::from(row.try_get::<i32>("", "dirty")?)
    } else {
        row.try_get::<i64>("", "dirty")?
    };
    let active_migration_id = row.try_get::<String>("", "active_migration_id")?;
    if dirty != 0 || !active_migration_id.is_empty() {
        return Err(DbErr::Custom(
            "database schema is dirty or has an active migration; service startup is forbidden"
                .to_string(),
        ));
    }
    if current_version != DATABASE_SCHEMA_VERSION {
        return Err(DbErr::Custom(format!(
            "database schema version {current_version} is outside this service's readable range {}..={}",
            DATABASE_SCHEMA_VERSION, DATABASE_SCHEMA_VERSION
        )));
    }
    Ok(current_version)
}

async fn prepare_schema(
    connection: &DatabaseConnection,
    production_policy: bool,
) -> Result<i64, DbErr> {
    let state_tables = schema_table_count(connection, "steel_schema_state").await?;
    let migration_tables = schema_table_count(connection, "steel_schema_migration").await?;
    if state_tables == 1 && migration_tables == 1 {
        return validate_schema_ledger(connection).await;
    }
    if state_tables != 0 || migration_tables != 0 {
        return Err(DbErr::Custom(
            "database schema ledger is incomplete; offline recovery is required".to_string(),
        ));
    }
    if production_policy && application_table_count(connection).await? != 0 {
        return Err(DbErr::Custom(
            "refusing to adopt an unversioned non-empty production database; use an approved baseline migration"
                .to_string(),
        ));
    }
    create_schema(connection).await?;
    create_schema_ledger(connection).await?;
    validate_schema_ledger(connection).await
}

async fn create_schema(connection: &DatabaseConnection) -> Result<(), DbErr> {
    let app_config_key = if connection.get_database_backend() == DbBackend::Postgres {
        "\"key\""
    } else {
        "`key`"
    };
    execute(
        connection,
        &format!(
            "CREATE TABLE IF NOT EXISTS app_config (
            {app_config_key} VARCHAR(128) PRIMARY KEY NOT NULL,
            value TEXT NOT NULL,
            updated_at VARCHAR(64) NOT NULL
        )"
        ),
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS config_revision (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            config_key VARCHAR(128) NOT NULL,
            value TEXT NOT NULL,
            actor VARCHAR(128) NOT NULL,
            action VARCHAR(128) NOT NULL,
            bytes INTEGER NOT NULL,
            created_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS camera_config (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            name VARCHAR(128) NOT NULL,
            ip VARCHAR(64) NOT NULL,
            driver_id VARCHAR(64) NOT NULL,
            model_hint VARCHAR(128) NOT NULL,
            role VARCHAR(128) NOT NULL,
            enabled BOOLEAN NOT NULL,
            trigger_mode VARCHAR(64) NOT NULL,
            exposure_us INTEGER NOT NULL,
            gain DOUBLE PRECISION NOT NULL,
            depth_lines INTEGER NOT NULL,
            output_path VARCHAR(512) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS steel_plate (
            plate_no VARCHAR(128) PRIMARY KEY NOT NULL,
            width_mm INTEGER NOT NULL,
            length_mm INTEGER NOT NULL,
            thickness_mm INTEGER NOT NULL,
            steel_grade VARCHAR(128) NOT NULL,
            detected_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS defect_type (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            label VARCHAR(128) NOT NULL,
            color VARCHAR(32) NOT NULL,
            shape VARCHAR(32) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS inspection_record (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            time VARCHAR(64) NOT NULL,
            plate_no VARCHAR(128) NOT NULL,
            status VARCHAR(64) NOT NULL,
            defect_count INTEGER NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS material_session (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            material_id VARCHAR(128) NOT NULL,
            source VARCHAR(128) NOT NULL,
            status VARCHAR(64) NOT NULL,
            control_mode VARCHAR(64) NOT NULL,
            trigger_mode VARCHAR(64) NOT NULL,
            steel_type VARCHAR(128) NOT NULL,
            width_mm DOUBLE PRECISION NOT NULL,
            length_mm DOUBLE PRECISION NOT NULL,
            thickness_mm DOUBLE PRECISION NOT NULL,
            client VARCHAR(128) NOT NULL,
            hard VARCHAR(128) NOT NULL,
            storage_root VARCHAR(512) NOT NULL,
            started_at VARCHAR(64) NOT NULL,
            finished_at VARCHAR(64) NOT NULL,
            updated_at VARCHAR(64) NOT NULL,
            raw_payload TEXT NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS secondary_data (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            material_id VARCHAR(128) NOT NULL,
            session_id VARCHAR(128) NOT NULL,
            source VARCHAR(128) NOT NULL,
            payload_type VARCHAR(64) NOT NULL,
            payload TEXT NOT NULL,
            received_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS trigger_event (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            material_id VARCHAR(128) NOT NULL,
            session_id VARCHAR(128) NOT NULL,
            source VARCHAR(128) NOT NULL,
            mode VARCHAR(64) NOT NULL,
            event_type VARCHAR(64) NOT NULL,
            command VARCHAR(64) NOT NULL,
            value INTEGER NOT NULL,
            payload TEXT NOT NULL,
            provider_code INTEGER NOT NULL,
            provider_response TEXT NOT NULL,
            created_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS production_inspection (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            material_id VARCHAR(128) NOT NULL,
            session_id VARCHAR(128) NOT NULL,
            status VARCHAR(64) NOT NULL,
            storage_root VARCHAR(512) NOT NULL,
            summary_path VARCHAR(512) NOT NULL,
            started_at VARCHAR(64) NOT NULL,
            finished_at VARCHAR(64) NOT NULL,
            capture_count INTEGER NOT NULL,
            defect_count INTEGER NOT NULL,
            raw_payload TEXT NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS production_task (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            idempotency_key VARCHAR(256) NOT NULL,
            kind VARCHAR(64) NOT NULL,
            material_id VARCHAR(128) NOT NULL,
            session_id VARCHAR(128) NOT NULL,
            chain_id VARCHAR(128) NOT NULL DEFAULT '',
            depends_on_task_id VARCHAR(128) NOT NULL DEFAULT '',
            dependency_policy VARCHAR(32) NOT NULL DEFAULT 'require-success',
            blocked_reason VARCHAR(512) NOT NULL DEFAULT '',
            status VARCHAR(32) NOT NULL,
            phase VARCHAR(64) NOT NULL,
            payload TEXT NOT NULL,
            result TEXT NOT NULL,
            error TEXT NOT NULL,
            actor VARCHAR(128) NOT NULL,
            progress INTEGER NOT NULL,
            attempts INTEGER NOT NULL,
            max_attempts INTEGER NOT NULL,
            cancel_requested BOOLEAN NOT NULL,
            created_at VARCHAR(64) NOT NULL,
            started_at VARCHAR(64) NOT NULL,
            finished_at VARCHAR(64) NOT NULL,
            updated_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS calibration_operation (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            kind VARCHAR(64) NOT NULL,
            request_hash VARCHAR(64) NOT NULL,
            request_json TEXT NOT NULL,
            status VARCHAR(32) NOT NULL,
            provider_http_status INTEGER NOT NULL,
            provider_response_body TEXT NOT NULL,
            error TEXT NOT NULL,
            actor VARCHAR(128) NOT NULL,
            parent_operation_id VARCHAR(128) NOT NULL DEFAULT '',
            reconciliation_outcome VARCHAR(64) NOT NULL DEFAULT '',
            reconciliation_id VARCHAR(128) NOT NULL DEFAULT '',
            resolved_by VARCHAR(128) NOT NULL DEFAULT '',
            resolved_at VARCHAR(64) NOT NULL DEFAULT '',
            row_version INTEGER NOT NULL DEFAULT 1,
            created_at VARCHAR(64) NOT NULL,
            dispatch_started_at VARCHAR(64) NOT NULL,
            finished_at VARCHAR(64) NOT NULL,
            updated_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    for migration in [
        "ALTER TABLE calibration_operation ADD COLUMN parent_operation_id VARCHAR(128) NOT NULL DEFAULT ''",
        "ALTER TABLE calibration_operation ADD COLUMN reconciliation_outcome VARCHAR(64) NOT NULL DEFAULT ''",
        "ALTER TABLE calibration_operation ADD COLUMN reconciliation_id VARCHAR(128) NOT NULL DEFAULT ''",
        "ALTER TABLE calibration_operation ADD COLUMN resolved_by VARCHAR(128) NOT NULL DEFAULT ''",
        "ALTER TABLE calibration_operation ADD COLUMN resolved_at VARCHAR(64) NOT NULL DEFAULT ''",
        "ALTER TABLE calibration_operation ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1",
    ] {
        execute_compatible_migration(connection, migration).await?;
    }
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS capture_file (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            inspection_id VARCHAR(128) NOT NULL,
            session_id VARCHAR(128) NOT NULL,
            material_id VARCHAR(128) NOT NULL,
            camera_id VARCHAR(128) NOT NULL,
            camera_ip VARCHAR(64) NOT NULL,
            data_name VARCHAR(64) NOT NULL,
            sequence_no INTEGER NOT NULL,
            file_type VARCHAR(32) NOT NULL,
            path VARCHAR(1024) NOT NULL,
            metadata_path VARCHAR(1024) NOT NULL,
            created_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS record_cleanup (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            record_id VARCHAR(128) NOT NULL,
            material_id VARCHAR(128) NOT NULL,
            status VARCHAR(32) NOT NULL,
            actor VARCHAR(128) NOT NULL,
            reason VARCHAR(256) NOT NULL,
            manifest_json TEXT NOT NULL,
            files_planned INTEGER NOT NULL,
            files_deleted INTEGER NOT NULL,
            files_missing INTEGER NOT NULL,
            bytes_planned BIGINT NOT NULL,
            bytes_deleted BIGINT NOT NULL,
            error TEXT NOT NULL,
            created_at VARCHAR(64) NOT NULL,
            updated_at VARCHAR(64) NOT NULL,
            completed_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS defect (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            plate_no VARCHAR(128) NOT NULL,
            type_id VARCHAR(128) NOT NULL,
            type_label VARCHAR(128) NOT NULL,
            surface VARCHAR(32) NOT NULL,
            severity VARCHAR(32) NOT NULL,
            distance_head_mm INTEGER NOT NULL,
            operator_side_mm INTEGER NOT NULL,
            drive_side_mm INTEGER NOT NULL,
            width_mm DOUBLE PRECISION NOT NULL,
            height_mm DOUBLE PRECISION NOT NULL,
            depth_mm DOUBLE PRECISION NOT NULL,
            x_ratio DOUBLE PRECISION NOT NULL,
            y_offset_mm DOUBLE PRECISION NOT NULL,
            preview_x INTEGER NOT NULL,
            preview_y INTEGER NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS production_defect (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            inspection_id VARCHAR(128) NOT NULL,
            material_id VARCHAR(128) NOT NULL,
            camera_id VARCHAR(128) NOT NULL,
            defect_type VARCHAR(128) NOT NULL,
            severity VARCHAR(32) NOT NULL,
            x_mm DOUBLE PRECISION NOT NULL,
            y_mm DOUBLE PRECISION NOT NULL,
            z_mm DOUBLE PRECISION NOT NULL,
            width_mm DOUBLE PRECISION NOT NULL,
            height_mm DOUBLE PRECISION NOT NULL,
            depth_mm DOUBLE PRECISION NOT NULL,
            confidence DOUBLE PRECISION NOT NULL,
            geometry_json TEXT NOT NULL,
            created_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS production_alarm (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            source VARCHAR(64) NOT NULL,
            alarm_type VARCHAR(128) NOT NULL,
            severity VARCHAR(32) NOT NULL,
            material_id VARCHAR(128) NOT NULL,
            session_id VARCHAR(128) NOT NULL,
            inspection_id VARCHAR(128) NOT NULL,
            camera_id VARCHAR(128) NOT NULL,
            message VARCHAR(1024) NOT NULL,
            details TEXT NOT NULL,
            status VARCHAR(32) NOT NULL,
            created_at VARCHAR(64) NOT NULL,
            acknowledged_at VARCHAR(64) NOT NULL,
            resolved_at VARCHAR(64) NOT NULL,
            acknowledged_by VARCHAR(128) NOT NULL,
            acknowledge_note VARCHAR(1024) NOT NULL,
            resolved_by VARCHAR(128) NOT NULL,
            resolve_note VARCHAR(1024) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS admin_user (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            display_name VARCHAR(128) NOT NULL,
            role VARCHAR(128) NOT NULL,
            status VARCHAR(64) NOT NULL,
            password_hash VARCHAR(512) NOT NULL DEFAULT '',
            must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
            last_login_at VARCHAR(64) NOT NULL,
            created_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    execute_compatible_migration(
        connection,
        "ALTER TABLE admin_user ADD COLUMN password_hash VARCHAR(512) NOT NULL DEFAULT ''",
    )
    .await?;
    execute_compatible_migration(
        connection,
        "ALTER TABLE admin_user ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS admin_role (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            label VARCHAR(128) NOT NULL,
            description VARCHAR(512) NOT NULL,
            permissions TEXT NOT NULL,
            status VARCHAR(64) NOT NULL,
            updated_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS audit_log (
            id VARCHAR(128) PRIMARY KEY NOT NULL,
            actor VARCHAR(128) NOT NULL,
            action VARCHAR(128) NOT NULL,
            target VARCHAR(256) NOT NULL,
            detail TEXT NOT NULL,
            level VARCHAR(32) NOT NULL,
            created_at VARCHAR(64) NOT NULL
        )",
    )
    .await?;
    for migration in [
        "ALTER TABLE production_task ADD COLUMN chain_id VARCHAR(128) NOT NULL DEFAULT ''",
        "ALTER TABLE production_task ADD COLUMN depends_on_task_id VARCHAR(128) NOT NULL DEFAULT ''",
        "ALTER TABLE production_task ADD COLUMN dependency_policy VARCHAR(32) NOT NULL DEFAULT 'require-success'",
        "ALTER TABLE production_task ADD COLUMN blocked_reason VARCHAR(512) NOT NULL DEFAULT ''",
    ] {
        execute_compatible_migration(connection, migration).await?;
    }
    for index in [
        "CREATE UNIQUE INDEX idx_production_task_idempotency ON production_task(idempotency_key)",
        "CREATE INDEX idx_production_task_due ON production_task(status, created_at)",
        "CREATE INDEX idx_production_task_session ON production_task(session_id, created_at)",
        "CREATE INDEX idx_production_task_chain ON production_task(chain_id, created_at)",
        "CREATE INDEX idx_production_task_dependency ON production_task(depends_on_task_id, status)",
        "CREATE INDEX idx_calibration_operation_status_updated ON calibration_operation(status, updated_at)",
        "CREATE INDEX idx_production_inspection_status_started ON production_inspection(status, started_at)",
        "CREATE INDEX idx_production_inspection_material ON production_inspection(material_id)",
        "CREATE INDEX idx_production_inspection_session ON production_inspection(session_id)",
        "CREATE INDEX idx_production_defect_inspection ON production_defect(inspection_id)",
        "CREATE INDEX idx_production_alarm_status_created ON production_alarm(status, created_at)",
        "CREATE INDEX idx_production_alarm_severity_created ON production_alarm(severity, created_at)",
        "CREATE INDEX idx_production_alarm_inspection ON production_alarm(inspection_id)",
        "CREATE INDEX idx_capture_file_inspection ON capture_file(inspection_id)",
        "CREATE INDEX idx_capture_file_frame_data ON capture_file(inspection_id, camera_id, sequence_no, data_name)",
        "CREATE INDEX idx_record_cleanup_record_created ON record_cleanup(record_id, created_at)",
        "CREATE INDEX idx_record_cleanup_status_updated ON record_cleanup(status, updated_at)",
    ] {
        execute_compatible_migration(connection, index).await?;
    }
    Ok(())
}

async fn seed_database(connection: &DatabaseConnection) -> Result<(), DbErr> {
    ensure_default_configs(connection).await?;
    ensure_admin_data(connection).await?;
    if defect_type::Entity::find().count(connection).await? == 0 {
        seed_defect_types(connection).await?;
    }
    let seed_demo = env::var("STEEL_SEED_DEMO_DATA")
        .map(|value| matches!(value.trim(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false);
    if !seed_demo || steel_plate::Entity::find().count(connection).await? > 0 {
        return Ok(());
    }
    seed_inspection_data(connection).await
}

fn validate_bootstrap_admin_password(password: &str) -> Result<(), DbErr> {
    let valid = password.chars().count() >= 12
        && password.chars().any(|ch| ch.is_ascii_lowercase())
        && password.chars().any(|ch| ch.is_ascii_uppercase())
        && password.chars().any(|ch| ch.is_ascii_digit())
        && password.chars().any(|ch| !ch.is_ascii_alphanumeric())
        && password != DEVELOPMENT_DEFAULT_ADMIN_PASSWORD;
    if valid {
        Ok(())
    } else {
        Err(DbErr::Custom(
            "STEEL_BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters with uppercase, lowercase, digit, and symbol"
                .to_string(),
        ))
    }
}

async fn ensure_admin_data(connection: &DatabaseConnection) -> Result<(), DbErr> {
    let bootstrap_password = env::var("STEEL_BOOTSTRAP_ADMIN_PASSWORD").ok();
    ensure_admin_data_with_policy(
        connection,
        production_security_policy_enabled(),
        bootstrap_password.as_deref(),
    )
    .await
}

async fn ensure_admin_data_with_policy(
    connection: &DatabaseConnection,
    production_policy: bool,
    bootstrap_password: Option<&str>,
) -> Result<(), DbErr> {
    if admin_role::Entity::find().count(connection).await? == 0 {
        let updated_at = now_millis_string();
        let roles = [
            (
                "administrator",
                "管理员",
                "拥有后台管理、配置、采集、数据和审计全部权限",
                "[\"admin.overview\",\"admin.services\",\"admin.users\",\"admin.roles\",\"admin.config\",\"admin.cameras\",\"admin.records\",\"admin.audit\"]",
                "active",
            ),
            (
                "engineer",
                "工程师",
                "维护检测数据、采集参数和相机配置",
                "[\"admin.overview\",\"admin.services\",\"admin.config\",\"admin.cameras\",\"admin.records\"]",
                "active",
            ),
            (
                "operator",
                "操作员",
                "查看运行状态、检测记录和基础统计",
                "[\"admin.overview\",\"admin.records\"]",
                "active",
            ),
        ];
        for (id, label, description, permissions, status) in roles {
            admin_role::ActiveModel {
                id: Set(id.to_string()),
                label: Set(label.to_string()),
                description: Set(description.to_string()),
                permissions: Set(permissions.to_string()),
                status: Set(status.to_string()),
                updated_at: Set(updated_at.clone()),
            }
            .insert(connection)
            .await?;
        }
    }

    for (role_id, permission) in [
        ("administrator", "admin.services"),
        ("engineer", "admin.services"),
    ] {
        if let Some(role) = admin_role::Entity::find()
            .filter(admin_role::Column::Id.eq(role_id))
            .one(connection)
            .await?
        {
            let permissions = append_permission(&role.permissions, permission);
            if permissions != role.permissions {
                let mut active: admin_role::ActiveModel = role.into();
                active.permissions = Set(permissions);
                active.updated_at = Set(now_millis_string());
                active.update(connection).await?;
            }
        }
    }

    if admin_user::Entity::find().count(connection).await? == 0 {
        let created_at = now_millis_string();
        let bootstrap_password = if production_policy {
            let password = bootstrap_password.ok_or_else(|| {
                DbErr::Custom(
                    "STEEL_BOOTSTRAP_ADMIN_PASSWORD is required for an empty production database"
                        .to_string(),
                )
            })?;
            validate_bootstrap_admin_password(password)?;
            password.to_string()
        } else {
            DEVELOPMENT_DEFAULT_ADMIN_PASSWORD.to_string()
        };
        let production_rows = [("admin", "系统管理员", "administrator", "active", "")];
        let development_rows = [
            ("admin", "系统管理员", "administrator", "active", ""),
            ("engineer", "工艺工程师", "engineer", "active", ""),
            ("operator", "产线操作员", "operator", "active", ""),
        ];
        let rows: &[_] = if production_policy {
            &production_rows
        } else {
            &development_rows
        };
        for (id, display_name, role, status, last_login_at) in rows {
            admin_user::ActiveModel {
                id: Set((*id).to_string()),
                display_name: Set((*display_name).to_string()),
                role: Set((*role).to_string()),
                status: Set((*status).to_string()),
                password_hash: Set(hash_admin_password(id, &bootstrap_password)),
                must_change_password: Set(production_policy),
                last_login_at: Set((*last_login_at).to_string()),
                created_at: Set(created_at.clone()),
            }
            .insert(connection)
            .await?;
        }
    }

    for user in admin_user::Entity::find().all(connection).await? {
        if user.password_hash.trim().is_empty() {
            if production_policy {
                return Err(DbErr::Custom(format!(
                    "production admin user {} has an empty password hash",
                    user.id
                )));
            }
            let mut active: admin_user::ActiveModel = user.clone().into();
            active.password_hash = Set(hash_admin_password(
                &user.id,
                DEVELOPMENT_DEFAULT_ADMIN_PASSWORD,
            ));
            active.update(connection).await?;
        }
        if production_policy && verify_admin_password(&user, DEVELOPMENT_DEFAULT_ADMIN_PASSWORD) {
            return Err(DbErr::Custom(format!(
                "production admin user {} still uses the development default password",
                user.id
            )));
        }
    }

    if audit_log::Entity::find().count(connection).await? == 0 {
        append_audit_log(
            connection,
            "system",
            "service.bootstrap",
            "steel-inspection-service",
            "服务启动并完成 SQLite/SeaORM 初始化",
            "info",
        )
        .await?;
        append_audit_log(
            connection,
            "system",
            "data.bootstrap",
            "system-defaults",
            "写入默认配置、权限和管理账号；生产检测记录不注入演示数据",
            "info",
        )
        .await?;
    }

    Ok(())
}

#[allow(dead_code)]
fn legacy_default_camera_configs() -> Vec<CameraConfigInput> {
    let cameras = [
        ("192.168.105.13", "LVM3450CA", "camera1 周向采集相机"),
        ("192.168.102.100", "LVM3450CA", "camera2 周向采集相机"),
        ("192.168.101.100", "LVM3450BE", "camera3 周向采集相机"),
        ("192.168.103.100", "LVM3450RE", "camera4 周向采集相机"),
        ("192.168.104.100", "LVM3450BE", "camera5 周向采集相机"),
        ("192.168.106.100", "LVM3450RE", "camera6 周向采集相机"),
    ];
    cameras
        .iter()
        .enumerate()
        .map(|(index, (ip, model, role))| {
            let camera_no = index + 1;
            let id = format!("CAM-{camera_no:02}");
            CameraConfigInput {
                id: id.clone(),
                name: format!("{camera_no} 号采集相机"),
                ip: (*ip).to_string(),
                driver_id: "lvm-nvt".to_string(),
                model_hint: (*model).to_string(),
                role: (*role).to_string(),
                enabled: true,
                trigger_mode: "软件触发".to_string(),
                exposure_us: 850,
                gain: 1.0,
                depth_lines: 1280,
                output_path: format!("captures/{id}"),
            }
        })
        .collect()
}

fn default_camera_configs() -> Vec<CameraConfigInput> {
    let cameras = [
        ("192.168.101.100", "LVM3450BE", "camera1 array camera"),
        ("192.168.102.100", "LVM3450CA", "camera2 array camera"),
        ("192.168.103.100", "LVM3450RE", "camera3 array camera"),
        ("192.168.104.100", "LVM3450GE(520)", "camera4 array camera"),
        ("192.168.105.100", "LVM3450BE", "camera5 array camera"),
        ("192.168.106.100", "LVM3450CA", "camera6 array camera"),
        ("192.168.107.100", "LVM3450RE", "camera7 array camera"),
        ("192.168.108.100", "LVM3450GE(520)", "camera8 array camera"),
    ];
    cameras
        .iter()
        .enumerate()
        .map(|(index, (ip, model, role))| {
            let camera_no = index + 1;
            let id = format!("CAM-{camera_no:02}");
            CameraConfigInput {
                id: id.clone(),
                name: format!("camera{camera_no}"),
                ip: (*ip).to_string(),
                driver_id: "lvm-nvt".to_string(),
                model_hint: (*model).to_string(),
                role: (*role).to_string(),
                enabled: true,
                trigger_mode: "device-current".to_string(),
                exposure_us: 850,
                gain: 1.0,
                depth_lines: 1280,
                output_path: format!("captures/{id}"),
            }
        })
        .collect()
}

fn default_capture_config_value() -> Value {
    let cameras = default_camera_configs()
        .into_iter()
        .map(|camera| {
            json!({
                "id": camera.id,
                "name": camera.name,
                "ip": camera.ip,
                "driverId": camera.driver_id,
                "modelHint": camera.model_hint,
                "role": camera.role,
                "enabled": camera.enabled,
                "triggerMode": camera.trigger_mode,
                "exposureUs": camera.exposure_us,
                "gain": camera.gain,
                "depthLines": camera.depth_lines,
                "outputPath": camera.output_path,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "service": {
            "name": "steel-inspection-service",
            "role": "api-config-capture-orchestrator",
            "updatedAt": now_millis_string()
        },
        "capture": {
            "mode": "eight-camera",
            "driver": "lvm-nvt",
            "fallback": "simulated",
            "cameras": cameras
        }
    })
}

#[allow(dead_code)]
fn legacy_capture_config_matches_current_cameras(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| {
            value
                .pointer("/capture/cameras")
                .and_then(Value::as_array)
                .cloned()
        })
        .is_some_and(|cameras| {
            cameras.len() >= 6
                && cameras.iter().all(|camera| {
                    camera
                        .get("triggerMode")
                        .and_then(Value::as_str)
                        .is_some_and(|mode| mode == "软件触发")
                })
                && cameras.iter().any(|camera| {
                    camera
                        .get("ip")
                        .and_then(Value::as_str)
                        .is_some_and(|ip| ip == "192.168.105.13")
                })
                && cameras.iter().any(|camera| {
                    camera
                        .get("ip")
                        .and_then(Value::as_str)
                        .is_some_and(|ip| ip == "192.168.106.100")
                })
        })
}

fn capture_config_matches_current_cameras(raw: &str) -> bool {
    const EXPECTED_IPS: [&str; 8] = [
        "192.168.101.100",
        "192.168.102.100",
        "192.168.103.100",
        "192.168.104.100",
        "192.168.105.100",
        "192.168.106.100",
        "192.168.107.100",
        "192.168.108.100",
    ];
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| {
            value
                .pointer("/capture/cameras")
                .and_then(Value::as_array)
                .cloned()
        })
        .is_some_and(|cameras| {
            cameras.len() >= EXPECTED_IPS.len()
                && EXPECTED_IPS.iter().all(|ip| {
                    cameras
                        .iter()
                        .any(|camera| camera.get("ip").and_then(Value::as_str) == Some(*ip))
                })
        })
}

async fn ensure_default_configs(connection: &DatabaseConnection) -> Result<(), DbErr> {
    let connection_config = "{\"mode\":\"online\",\"host\":\"127.0.0.1\",\"port\":4873}";
    if get_config(connection, "connection").await?.is_none() {
        set_config(connection, "connection", connection_config).await?;
    }
    match get_config(connection, "capture").await? {
        Some(config) if capture_config_matches_current_cameras(&config.value) => {}
        _ => {
            set_config(connection, "capture", &default_capture_config_json()).await?;
        }
    }
    if get_config(connection, "security_policy").await?.is_none() {
        set_config(
            connection,
            "security_policy",
            "{\"auditRetentionDays\":180}",
        )
        .await?;
    }
    if get_config(connection, "inspection_settings")
        .await?
        .is_none()
    {
        set_config(
            connection,
            "inspection_settings",
            "{\"severeDepthMm\":0.12,\"reviewDepthMm\":0.08,\"minDefectWidthMm\":0.2,\"cameraExposureUs\":850,\"encoderPulsePerMeter\":2048,\"autoReview\":true,\"alarmVolume\":86,\"saveRawImages\":true}",
        )
        .await?;
    }
    if get_config(connection, "alarm_rules").await?.is_none() {
        set_config(
            connection,
            "alarm_rules",
            "{\"enabled\":true,\"severeDefectThreshold\":1,\"reviewDefectThreshold\":3,\"cameraOffline\":true,\"receiverPortFailure\":true,\"plcOffline\":true,\"l2Offline\":true,\"notifySound\":true,\"notifyBanner\":true,\"retainMinutes\":60}",
        )
        .await?;
    }
    if get_config(connection, "external_integrations")
        .await?
        .is_none()
    {
        set_config(
            connection,
            "external_integrations",
            "{\"plc\":{\"enabled\":true,\"protocol\":\"modbus-tcp\",\"host\":\"127.0.0.1\",\"port\":1502,\"path\":\"/plc/status\",\"timeoutMs\":1000,\"retryIntervalMs\":3000},\"l2\":{\"enabled\":true,\"protocol\":\"http-json\",\"host\":\"127.0.0.1\",\"port\":8082,\"path\":\"/api/l2/status\",\"timeoutMs\":1500,\"retryIntervalMs\":5000},\"mes\":{\"enabled\":false,\"protocol\":\"http-json\",\"host\":\"127.0.0.1\",\"port\":8088,\"path\":\"/api/mes/report\",\"timeoutMs\":2000,\"retryIntervalMs\":10000}}",
        )
        .await?;
    }

    let should_refresh_default_cameras = camera_config::Entity::find().count(connection).await? < 8;
    for camera in default_camera_configs() {
        if should_refresh_default_cameras
            || find_camera_config(connection, &camera.id).await?.is_none()
        {
            save_camera_config(connection, camera).await?;
        }
    }
    Ok(())
}

fn default_capture_config_json() -> String {
    default_capture_config_value().to_string()
}

async fn seed_defect_types(connection: &DatabaseConnection) -> Result<(), DbErr> {
    let rows = [
        ("pit", "凹坑", "#2f6bff", "circle"),
        ("roll", "辊印", "#ff7f1f", "square"),
        ("scratch", "划伤", "#24a647", "rect"),
        ("foreign", "异物压入", "#f0141e", "diamond"),
        ("burnt", "烂钢", "#8b5cf6", "square"),
        ("edge", "边裂", "#f6b800", "diamond"),
        ("longitudinal", "纵裂", "#17bce1", "rect"),
        ("bubble", "气泡", "#ec4899", "circle"),
        ("inclusion", "夹杂", "#a63a1f", "circle"),
        ("review", "待复核", "#737373", "star"),
    ];
    for (id, label, color, shape) in rows {
        defect_type::ActiveModel {
            id: Set(id.to_string()),
            label: Set(label.to_string()),
            color: Set(color.to_string()),
            shape: Set(shape.to_string()),
        }
        .insert(connection)
        .await?;
    }
    Ok(())
}

async fn seed_inspection_data(connection: &DatabaseConnection) -> Result<(), DbErr> {
    let records = [
        ("R-001", "19:00", "202606131900", "detecting", 12),
        ("R-002", "18:42", "202606131858", "completed", 8),
        ("R-003", "18:20", "202606131820", "completed", 0),
        ("R-004", "17:55", "202606131755", "completed", 24),
        ("R-005", "17:30", "202606131730", "completed", 5),
        ("R-006", "17:05", "202606131705", "completed", 16),
        ("R-007", "16:40", "202606131640", "completed", 2),
        ("R-008", "16:15", "202606131615", "completed", 7),
        ("R-009", "15:50", "202606131550", "completed", 10),
        ("R-010", "15:25", "202606131525", "completed", 3),
    ];

    for (index, (id, time, plate_no, status, defect_count)) in records.iter().enumerate() {
        let (width_mm, length_mm, thickness_mm, steel_grade) = match *plate_no {
            "202606131900" => (3500, 12000, 12, "Q355B"),
            "202606131858" => (3600, 11800, 14, "Q355B"),
            "202606131820" => (3200, 10000, 10, "Q235B"),
            "202606131755" => (3800, 12500, 16, "Q420B"),
            _ => (
                3300 + (index % 4) as i32 * 120,
                10800 + (index % 5) as i32 * 350,
                10 + (index % 4) as i32 * 2,
                if index % 3 == 0 { "Q355B" } else { "Q235B" },
            ),
        };
        inspection_record::ActiveModel {
            id: Set((*id).to_string()),
            time: Set((*time).to_string()),
            plate_no: Set((*plate_no).to_string()),
            status: Set((*status).to_string()),
            defect_count: Set(*defect_count),
        }
        .insert(connection)
        .await?;
        steel_plate::ActiveModel {
            plate_no: Set((*plate_no).to_string()),
            width_mm: Set(width_mm),
            length_mm: Set(length_mm),
            thickness_mm: Set(thickness_mm),
            steel_grade: Set(steel_grade.to_string()),
            detected_at: Set(format!("2026-06-13 {}", time)),
        }
        .insert(connection)
        .await?;
    }

    for model in demo_defects() {
        let active: defect::ActiveModel = model.into();
        active.insert(connection).await?;
    }
    Ok(())
}

fn demo_defects() -> Vec<defect::Model> {
    let rows = [
        (
            "D-001", "pit", "凹坑", "top", "severe", 8342, 1260, 2240, 0.42, 0.36, -0.12, 0.18,
            0.92, 54, 48,
        ),
        (
            "D-002", "scratch", "划伤", "bottom", "minor", 5260, 580, 2920, 0.64, 0.18, -0.05,
            0.12, 0.52, 38, 40,
        ),
        (
            "D-003", "roll", "辊印", "top", "review", 4100, 2050, 1450, 0.28, 0.28, -0.08, 0.42,
            -0.40, 50, 54,
        ),
        (
            "D-004",
            "foreign",
            "异物压入",
            "bottom",
            "severe",
            3880,
            960,
            2540,
            0.48,
            0.42,
            -0.14,
            0.04,
            0.82,
            43,
            48,
        ),
        (
            "D-005", "pit", "凹坑", "top", "severe", 3200, 1780, 1720, 0.38, 0.31, -0.10, 0.61,
            0.84, 56, 45,
        ),
        (
            "D-006", "scratch", "划伤", "top", "minor", 2910, 1560, 1940, 0.71, 0.16, -0.04, 0.62,
            -0.48, 48, 53,
        ),
        (
            "D-007", "roll", "辊印", "bottom", "review", 2600, 1440, 2060, 0.36, 0.33, -0.07, 0.24,
            -0.52, 46, 57,
        ),
        (
            "D-008", "pit", "凹坑", "bottom", "minor", 1980, 1840, 1660, 0.40, 0.33, -0.09, 0.72,
            -0.45, 59, 50,
        ),
        (
            "D-009", "bubble", "气泡", "bottom", "minor", 1460, 1740, 1760, 0.26, 0.24, -0.03,
            0.71, 0.52, 52, 49,
        ),
        (
            "D-010",
            "foreign",
            "异物压入",
            "top",
            "severe",
            920,
            2680,
            820,
            0.50,
            0.42,
            -0.16,
            0.78,
            0.90,
            61,
            45,
        ),
        (
            "D-011", "burnt", "烂钢", "bottom", "review", 640, 2240, 1260, 0.34, 0.34, -0.08, 0.82,
            -0.52, 63, 55,
        ),
        (
            "D-012", "edge", "边裂", "bottom", "minor", 540, 2480, 1020, 0.55, 0.26, -0.05, 0.84,
            -0.95, 65, 58,
        ),
    ];
    rows.iter()
        .map(|row| defect::Model {
            id: row.0.to_string(),
            plate_no: "202606131900".to_string(),
            type_id: row.1.to_string(),
            type_label: row.2.to_string(),
            surface: row.3.to_string(),
            severity: row.4.to_string(),
            distance_head_mm: row.5,
            operator_side_mm: row.6,
            drive_side_mm: row.7,
            width_mm: row.8,
            height_mm: row.9,
            depth_mm: row.10,
            x_ratio: row.11,
            y_offset_mm: row.12,
            preview_x: row.13,
            preview_y: row.14,
        })
        .collect()
}

#[cfg(test)]
mod bkv_import_tests {
    use super::*;

    fn material(seq_no: i64) -> BkvImportMaterial {
        BkvImportMaterial {
            seq_no,
            material_id: format!("material-{seq_no}"),
            steel_plate_id: format!("plate-{seq_no}"),
            inspection_record_id: format!("record-{seq_no}"),
            session_id: format!("session-{seq_no}"),
            inspection_id: format!("inspection-{seq_no}"),
            width_mm: 100.0,
            length_mm: 12000.0,
            thickness_mm: 10.0,
            steel_grade: "Q235".to_string(),
            occurred_at: "1893700".to_string(),
            raw_payload: json!({"legacySeqNo": seq_no}).to_string(),
        }
    }

    fn batch() -> BkvImportBatch {
        BkvImportBatch {
            batch_id: "batch-001".to_string(),
            content_id: "a".repeat(64),
            manifest_json: json!({"schema":"steel.bkv-import-manifest.v1"}).to_string(),
            status: "ready".to_string(),
            materials: (1_893_700..=1_893_710).map(material).collect(),
            artifacts: vec![BkvImportArtifact {
                id: "artifact-1".to_string(),
                inspection_id: "inspection-1893700".to_string(),
                session_id: "session-1893700".to_string(),
                material_id: "material-1893700".to_string(),
                camera_id: "bkv-camera-1".to_string(),
                data_name: "one.jpg".to_string(),
                sequence_no: 1_893_700,
                file_type: "2d".to_string(),
                path: "artifacts/camera1/1893700/2d/one.jpg".to_string(),
                metadata_json: json!({"sha256":"b".repeat(64)}).to_string(),
            }],
            defects: vec![BkvImportDefect {
                id: "defect-1".to_string(),
                inspection_id: "inspection-1893700".to_string(),
                material_id: "material-1893700".to_string(),
                camera_id: "bkv-camera-1".to_string(),
                defect_type: "pit".to_string(),
                severity: "review".to_string(),
                x_mm: 1.0,
                y_mm: 2.0,
                z_mm: 0.0,
                width_mm: 3.0,
                height_mm: 4.0,
                depth_mm: 0.5,
                confidence: 1.0,
                provenance_json: json!({"legacyTable":"defect"}).to_string(),
            }],
        }
    }

    #[test]
    fn bkv_import_is_idempotent_and_uses_only_existing_tables() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime.block_on(async {
            let database =
                open_database_url("sqlite::memory:".to_string(), PathBuf::from(":memory:"))
                    .await
                    .expect("database");
            let first = import_bkv_batch(&database.connection, batch(), "tester")
                .await
                .expect("first import");
            let second = import_bkv_batch(&database.connection, batch(), "tester")
                .await
                .expect("idempotent import");
            assert!(!first.already_imported);
            assert!(second.already_imported);
            assert_eq!(
                steel_plate::Entity::find()
                    .count(&database.connection)
                    .await
                    .unwrap(),
                11
            );
            assert_eq!(
                production_inspection::Entity::find()
                    .count(&database.connection)
                    .await
                    .unwrap(),
                11
            );
            assert_eq!(
                capture_file::Entity::find()
                    .count(&database.connection)
                    .await
                    .unwrap(),
                1
            );
            assert_eq!(
                production_defect::Entity::find()
                    .count(&database.connection)
                    .await
                    .unwrap(),
                1
            );
            assert!(get_config(&database.connection, "bkv.active-batch")
                .await
                .unwrap()
                .is_some());
        });
    }

    #[test]
    fn bkv_import_rolls_back_every_row_when_one_row_is_invalid() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime.block_on(async {
            let database =
                open_database_url("sqlite::memory:".to_string(), PathBuf::from(":memory:"))
                    .await
                    .expect("database");
            let mut invalid = batch();
            invalid.materials[10].width_mm = f64::NAN;
            assert!(import_bkv_batch(&database.connection, invalid, "tester")
                .await
                .is_err());
            assert_eq!(
                steel_plate::Entity::find()
                    .count(&database.connection)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                inspection_record::Entity::find()
                    .count(&database.connection)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                material_session::Entity::find()
                    .count(&database.connection)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(
                production_inspection::Entity::find()
                    .count(&database.connection)
                    .await
                    .unwrap(),
                0
            );
            assert!(get_config(&database.connection, "bkv.active-batch")
                .await
                .unwrap()
                .is_none());
        });
    }

    #[test]
    fn bkv_replay_reset_updates_state_and_audit_atomically() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime.block_on(async {
            let database =
                open_database_url("sqlite::memory:".to_string(), PathBuf::from(":memory:"))
                    .await
                    .expect("database");
            import_bkv_batch(&database.connection, batch(), "tester")
                .await
                .unwrap();
            let audit_before = audit_log::Entity::find()
                .count(&database.connection)
                .await
                .unwrap();
            let reset = reset_bkv_replay(&database.connection, "tester")
                .await
                .unwrap();
            assert_eq!(reset.get("index").and_then(Value::as_i64), Some(0));
            assert_eq!(reset.get("version").and_then(Value::as_i64), Some(1));
            assert_eq!(
                audit_log::Entity::find()
                    .count(&database.connection)
                    .await
                    .unwrap(),
                audit_before + 1
            );
        });
    }

    #[test]
    fn bkv_import_of_a_new_batch_switches_active_batch_atomically() {
        let runtime = tokio::runtime::Runtime::new().expect("runtime");
        runtime.block_on(async {
            let database =
                open_database_url("sqlite::memory:".to_string(), PathBuf::from(":memory:"))
                    .await
                    .expect("database");
            import_bkv_batch(&database.connection, batch(), "tester")
                .await
                .unwrap();
            let mut second = batch();
            second.batch_id = "batch-002".to_string();
            second.content_id = "c".repeat(64);
            for material in &mut second.materials {
                material.material_id.push_str("-two");
                material.steel_plate_id.push_str("-two");
                material.inspection_record_id.push_str("-two");
                material.session_id.push_str("-two");
                material.inspection_id.push_str("-two");
            }
            second.artifacts[0].id.push_str("-two");
            second.artifacts[0].material_id.push_str("-two");
            second.artifacts[0].session_id.push_str("-two");
            second.artifacts[0].inspection_id.push_str("-two");
            second.defects[0].id.push_str("-two");
            second.defects[0].material_id.push_str("-two");
            second.defects[0].inspection_id.push_str("-two");
            import_bkv_batch(&database.connection, second, "tester")
                .await
                .unwrap();
            let active: Value = serde_json::from_str(
                &get_config(&database.connection, "bkv.active-batch")
                    .await
                    .unwrap()
                    .unwrap()
                    .value,
            )
            .unwrap();
            assert_eq!(
                active.get("batchId").and_then(Value::as_str),
                Some("batch-002")
            );
        });
    }
}
