use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand_core::OsRng;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, Database, DatabaseConnection, DbBackend, DbErr,
    EntityTrait, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, Set, Statement,
};
use serde_json::{self, json, Value};
use std::collections::BTreeSet;
use std::env;
use std::path::PathBuf;

pub mod entities;

use entities::{
    admin_role, admin_user, app_config, audit_log, camera_config, capture_file, config_revision,
    defect, defect_type, inspection_record, material_session, production_defect,
    production_inspection, secondary_data, steel_plate, trigger_event,
};

pub const DEFAULT_ADMIN_PASSWORD: &str = "admin123";

#[derive(Clone)]
pub struct AppDatabase {
    pub connection: DatabaseConnection,
    pub path: PathBuf,
    pub engine: String,
    pub url: String,
    pub file_path: Option<PathBuf>,
}

impl AppDatabase {
    pub fn display_path(&self) -> String {
        self.file_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| self.url.clone())
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
    pub capture_file_count: u64,
    pub production_defect_count: u64,
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
    pub record: inspection_record::Model,
    pub plate: Option<steel_plate::Model>,
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
    pub defects: Vec<defect::Model>,
}

#[derive(Clone)]
pub struct DeleteInspectionRecordResult {
    pub id: String,
    pub plate_no: String,
    pub defects_deleted: u64,
    pub plate_deleted: bool,
}

#[derive(Clone)]
pub struct InspectionRecordRetentionResult {
    pub matched: u64,
    pub deleted_records: u64,
    pub deleted_defects: u64,
    pub deleted_plates: u64,
}

#[derive(Clone)]
pub struct AdminAuditLogPage {
    pub logs: Vec<audit_log::Model>,
    pub total: u64,
    pub limit: u64,
    pub offset: u64,
}

pub async fn open_database(path: PathBuf) -> Result<AppDatabase, DbErr> {
    if let Ok(url) = env::var("STEEL_DATABASE_URL") {
        let url = normalize_database_url(url.trim());
        if !url.is_empty() {
            return open_database_url(url, path).await;
        }
    }
    if env::var("STEEL_DATABASE_ENGINE")
        .map(|value| value.eq_ignore_ascii_case("mysql"))
        .unwrap_or(false)
    {
        let host = env::var("STEEL_MYSQL_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = env::var("STEEL_MYSQL_PORT").unwrap_or_else(|_| "3306".to_string());
        let user = env::var("STEEL_MYSQL_USER").unwrap_or_else(|_| "root".to_string());
        let password = env::var("STEEL_MYSQL_PASSWORD").unwrap_or_else(|_| "nercar".to_string());
        let database =
            env::var("STEEL_MYSQL_DATABASE").unwrap_or_else(|_| "steel_inspection".to_string());
        let url = normalize_database_url(&format!(
            "mysql://{user}:{password}@{host}:{port}/{database}"
        ));
        return open_database_url(url, path).await;
    }

    let url = format!("sqlite://{}?mode=rwc", path.display());
    let connection = Database::connect(url.clone()).await?;
    create_schema(&connection).await?;
    seed_database(&connection).await?;
    Ok(AppDatabase {
        connection,
        path: path.clone(),
        engine: "sqlite".to_string(),
        url,
        file_path: Some(path),
    })
}

fn normalize_database_url(url: &str) -> String {
    if (url.starts_with("mysql://") || url.starts_with("mysqlx://"))
        && !url.to_ascii_lowercase().contains("ssl-mode=")
    {
        let separator = if url.contains('?') { '&' } else { '?' };
        format!("{url}{separator}ssl-mode=disabled")
    } else {
        url.to_string()
    }
}

pub async fn open_database_url(url: String, fallback_path: PathBuf) -> Result<AppDatabase, DbErr> {
    if url.starts_with("mysql://") || url.starts_with("mysqlx://") {
        ensure_mysql_database(&url).await?;
    }
    let connection = Database::connect(url.clone()).await?;
    create_schema(&connection).await?;
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
        url,
        file_path,
    })
}

async fn ensure_mysql_database(url: &str) -> Result<(), DbErr> {
    let Some(database_name) = mysql_database_name(url) else {
        return Ok(());
    };
    let Some(server_url) = mysql_server_url(url) else {
        return Ok(());
    };
    let admin = Database::connect(server_url).await?;
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
            capture_file_count: capture_file::Entity::find().count(connection).await?,
            production_defect_count: production_defect::Entity::find()
                .count(connection)
                .await?,
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
        }
        active.last_login_at = Set(input.last_login_at);
        active.update(connection).await
    } else {
        let password_hash = input
            .password_hash
            .unwrap_or_else(|| hash_admin_password(&input.id, DEFAULT_ADMIN_PASSWORD));
        admin_user::ActiveModel {
            id: Set(input.id),
            display_name: Set(input.display_name),
            role: Set(input.role),
            status: Set(input.status),
            password_hash: Set(password_hash),
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

pub async fn list_inspection_records(
    connection: &DatabaseConnection,
    filter: InspectionRecordFilter,
) -> Result<AdminInspectionRecordPage, DbErr> {
    let limit = filter.limit.unwrap_or(20).clamp(1, 100);
    let offset = filter.offset.unwrap_or(0);
    let mut query = inspection_record::Entity::find().order_by_desc(inspection_record::Column::Id);

    if let Some(status) = filter
        .status
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "all")
    {
        query = query.filter(inspection_record::Column::Status.eq(status));
    }
    if let Some(keyword) = filter.keyword.as_deref().filter(|value| !value.is_empty()) {
        query = query.filter(
            inspection_record::Column::PlateNo
                .contains(keyword)
                .or(inspection_record::Column::Id.contains(keyword)),
        );
    }

    let total = query.clone().count(connection).await?;
    let records = query.limit(limit).offset(offset).all(connection).await?;
    let mut rows = Vec::with_capacity(records.len());

    for record in records {
        let plate = steel_plate::Entity::find()
            .filter(steel_plate::Column::PlateNo.eq(&record.plate_no))
            .one(connection)
            .await?;
        let defects = defect::Entity::find()
            .filter(defect::Column::PlateNo.eq(&record.plate_no))
            .all(connection)
            .await?;
        let severe_count = defects
            .iter()
            .filter(|item| item.severity == "severe")
            .count() as u64;
        let review_count = defects
            .iter()
            .filter(|item| item.severity == "review")
            .count() as u64;
        let minor_count = defects
            .iter()
            .filter(|item| item.severity == "minor")
            .count() as u64;
        rows.push(AdminInspectionRecord {
            record,
            plate,
            severe_count,
            review_count,
            minor_count,
        });
    }

    Ok(AdminInspectionRecordPage {
        records: rows,
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
    let mut query = inspection_record::Entity::find().order_by_desc(inspection_record::Column::Id);

    if let Some(status) = filter
        .status
        .as_deref()
        .filter(|value| !value.is_empty() && *value != "all")
    {
        query = query.filter(inspection_record::Column::Status.eq(status));
    }
    if let Some(keyword) = filter.keyword.as_deref().filter(|value| !value.is_empty()) {
        query = query.filter(
            inspection_record::Column::PlateNo
                .contains(keyword)
                .or(inspection_record::Column::Id.contains(keyword)),
        );
    }

    let records = query.limit(limit).all(connection).await?;
    let mut rows = Vec::with_capacity(records.len());
    for record in records {
        let plate = steel_plate::Entity::find()
            .filter(steel_plate::Column::PlateNo.eq(&record.plate_no))
            .one(connection)
            .await?;
        let defects = defect::Entity::find()
            .filter(defect::Column::PlateNo.eq(&record.plate_no))
            .all(connection)
            .await?;
        let severe_count = defects
            .iter()
            .filter(|item| item.severity == "severe")
            .count() as u64;
        let review_count = defects
            .iter()
            .filter(|item| item.severity == "review")
            .count() as u64;
        let minor_count = defects
            .iter()
            .filter(|item| item.severity == "minor")
            .count() as u64;
        rows.push(AdminInspectionRecord {
            record,
            plate,
            severe_count,
            review_count,
            minor_count,
        });
    }
    Ok(rows)
}

pub async fn find_inspection_record_detail(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<AdminInspectionRecordDetail>, DbErr> {
    let Some(record) = inspection_record::Entity::find()
        .filter(inspection_record::Column::Id.eq(id))
        .one(connection)
        .await?
    else {
        return Ok(None);
    };
    let plate = steel_plate::Entity::find()
        .filter(steel_plate::Column::PlateNo.eq(&record.plate_no))
        .one(connection)
        .await?;
    let defects = defect::Entity::find()
        .filter(defect::Column::PlateNo.eq(&record.plate_no))
        .order_by_asc(defect::Column::DistanceHeadMm)
        .all(connection)
        .await?;
    let severe_count = defects
        .iter()
        .filter(|item| item.severity == "severe")
        .count() as u64;
    let review_count = defects
        .iter()
        .filter(|item| item.severity == "review")
        .count() as u64;
    let minor_count = defects
        .iter()
        .filter(|item| item.severity == "minor")
        .count() as u64;
    Ok(Some(AdminInspectionRecordDetail {
        record: AdminInspectionRecord {
            record,
            plate,
            severe_count,
            review_count,
            minor_count,
        },
        defects,
    }))
}

pub async fn delete_inspection_record(
    connection: &DatabaseConnection,
    id: &str,
) -> Result<Option<DeleteInspectionRecordResult>, DbErr> {
    let Some(record) = inspection_record::Entity::find()
        .filter(inspection_record::Column::Id.eq(id))
        .one(connection)
        .await?
    else {
        return Ok(None);
    };
    let plate_no = record.plate_no.clone();
    let delete_result = inspection_record::Entity::delete_many()
        .filter(inspection_record::Column::Id.eq(id))
        .exec(connection)
        .await?;
    if delete_result.rows_affected == 0 {
        return Ok(None);
    }
    let remaining_records_for_plate = inspection_record::Entity::find()
        .filter(inspection_record::Column::PlateNo.eq(&plate_no))
        .count(connection)
        .await?;
    let mut defects_deleted = 0;
    let mut plate_deleted = false;
    if remaining_records_for_plate == 0 {
        defects_deleted = defect::Entity::delete_many()
            .filter(defect::Column::PlateNo.eq(&plate_no))
            .exec(connection)
            .await?
            .rows_affected;
        plate_deleted = steel_plate::Entity::delete_many()
            .filter(steel_plate::Column::PlateNo.eq(&plate_no))
            .exec(connection)
            .await?
            .rows_affected
            > 0;
    }
    Ok(Some(DeleteInspectionRecordResult {
        id: record.id,
        plate_no,
        defects_deleted,
        plate_deleted,
    }))
}

pub async fn inspection_record_retention_cutoff(
    connection: &DatabaseConnection,
    retention_days: u64,
) -> Result<String, DbErr> {
    let backend = connection.get_database_backend();
    let sql = match backend {
        DbBackend::MySql => format!(
            "SELECT DATE_FORMAT(DATE_SUB(NOW(), INTERVAL {retention_days} DAY), '%Y-%m-%d %H:%i') AS cutoff_at"
        ),
        _ => format!("SELECT datetime('now', '-{retention_days} days') AS cutoff_at"),
    };
    let Some(row) = connection
        .query_one(Statement::from_string(backend, sql))
        .await?
    else {
        return Ok(String::new());
    };
    row.try_get("", "cutoff_at")
}

async fn inspection_records_before(
    connection: &DatabaseConnection,
    retention_days: u64,
) -> Result<Vec<(String, String)>, DbErr> {
    let backend = connection.get_database_backend();
    let sql = match backend {
        DbBackend::MySql => format!(
            "SELECT r.id AS id, r.plate_no AS plate_no \
             FROM inspection_record r \
             LEFT JOIN steel_plate p ON p.plate_no = r.plate_no \
             WHERE COALESCE(p.detected_at, '1970-01-01 00:00') < DATE_FORMAT(DATE_SUB(NOW(), INTERVAL {retention_days} DAY), '%Y-%m-%d %H:%i')"
        ),
        _ => format!(
            "SELECT r.id AS id, r.plate_no AS plate_no \
             FROM inspection_record r \
             LEFT JOIN steel_plate p ON p.plate_no = r.plate_no \
             WHERE datetime(COALESCE(p.detected_at, '1970-01-01 00:00')) < datetime('now', '-{retention_days} days')"
        ),
    };
    let rows = connection
        .query_all(Statement::from_string(backend, sql))
        .await?;
    rows.into_iter()
        .map(|row| {
            let id: String = row.try_get("", "id")?;
            let plate_no: String = row.try_get("", "plate_no")?;
            Ok((id, plate_no))
        })
        .collect()
}

pub async fn count_inspection_records_before(
    connection: &DatabaseConnection,
    retention_days: u64,
) -> Result<u64, DbErr> {
    Ok(inspection_records_before(connection, retention_days)
        .await?
        .len() as u64)
}

pub async fn delete_inspection_records_before(
    connection: &DatabaseConnection,
    retention_days: u64,
) -> Result<InspectionRecordRetentionResult, DbErr> {
    let candidates = inspection_records_before(connection, retention_days).await?;
    let matched = candidates.len() as u64;
    let plate_nos = candidates
        .iter()
        .map(|(_, plate_no)| plate_no.clone())
        .collect::<BTreeSet<_>>();

    let mut deleted_records = 0;
    for (id, _) in &candidates {
        deleted_records += inspection_record::Entity::delete_many()
            .filter(inspection_record::Column::Id.eq(id))
            .exec(connection)
            .await?
            .rows_affected;
    }

    let mut deleted_defects = 0;
    let mut deleted_plates = 0;
    for plate_no in plate_nos {
        let remaining_records_for_plate = inspection_record::Entity::find()
            .filter(inspection_record::Column::PlateNo.eq(&plate_no))
            .count(connection)
            .await?;
        if remaining_records_for_plate == 0 {
            deleted_defects += defect::Entity::delete_many()
                .filter(defect::Column::PlateNo.eq(&plate_no))
                .exec(connection)
                .await?
                .rows_affected;
            deleted_plates += steel_plate::Entity::delete_many()
                .filter(steel_plate::Column::PlateNo.eq(&plate_no))
                .exec(connection)
                .await?
                .rows_affected;
        }
    }

    Ok(InspectionRecordRetentionResult {
        matched,
        deleted_records,
        deleted_defects,
        deleted_plates,
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
        .one(connection)
        .await
}

pub async fn latest_open_material_session(
    connection: &DatabaseConnection,
) -> Result<Option<material_session::Model>, DbErr> {
    material_session::Entity::find()
        .filter(material_session::Column::Status.ne("finished"))
        .order_by_desc(material_session::Column::UpdatedAt)
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

pub async fn finish_material_session(
    connection: &DatabaseConnection,
    session_id: &str,
    finished_at: &str,
) -> Result<Option<material_session::Model>, DbErr> {
    let Some(model) = find_material_session(connection, session_id).await? else {
        return Ok(None);
    };
    let mut active: material_session::ActiveModel = model.into();
    active.status = Set("finished".to_string());
    active.finished_at = Set(finished_at.to_string());
    active.updated_at = Set(now_millis_string());
    Ok(Some(active.update(connection).await?))
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

pub async fn append_capture_file(
    connection: &DatabaseConnection,
    input: CaptureFileInput,
) -> Result<capture_file::Model, DbErr> {
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

pub async fn append_production_defect(
    connection: &DatabaseConnection,
    input: ProductionDefectInput,
) -> Result<production_defect::Model, DbErr> {
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
                || message.contains("already exists")
            {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

async fn create_schema(connection: &DatabaseConnection) -> Result<(), DbErr> {
    execute(
        connection,
        "CREATE TABLE IF NOT EXISTS app_config (
            `key` VARCHAR(128) PRIMARY KEY NOT NULL,
            value TEXT NOT NULL,
            updated_at VARCHAR(64) NOT NULL
        )",
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
            gain REAL NOT NULL,
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
            width_mm REAL NOT NULL,
            length_mm REAL NOT NULL,
            thickness_mm REAL NOT NULL,
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
            width_mm REAL NOT NULL,
            height_mm REAL NOT NULL,
            depth_mm REAL NOT NULL,
            x_ratio REAL NOT NULL,
            y_offset_mm REAL NOT NULL,
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
            x_mm REAL NOT NULL,
            y_mm REAL NOT NULL,
            z_mm REAL NOT NULL,
            width_mm REAL NOT NULL,
            height_mm REAL NOT NULL,
            depth_mm REAL NOT NULL,
            confidence REAL NOT NULL,
            geometry_json TEXT NOT NULL,
            created_at VARCHAR(64) NOT NULL
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
    .await
}

async fn seed_database(connection: &DatabaseConnection) -> Result<(), DbErr> {
    ensure_default_configs(connection).await?;
    ensure_admin_data(connection).await?;

    if steel_plate::Entity::find().count(connection).await? > 0 {
        return Ok(());
    }

    seed_defect_types(connection).await?;
    seed_inspection_data(connection).await
}

async fn ensure_admin_data(connection: &DatabaseConnection) -> Result<(), DbErr> {
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
        let rows = [
            (
                "admin",
                "系统管理员",
                "administrator",
                "active",
                "2026-06-13 19:00",
            ),
            (
                "engineer",
                "工艺工程师",
                "engineer",
                "active",
                "2026-06-13 18:42",
            ),
            (
                "operator",
                "产线操作员",
                "operator",
                "active",
                "2026-06-13 18:20",
            ),
        ];
        for (id, display_name, role, status, last_login_at) in rows {
            admin_user::ActiveModel {
                id: Set(id.to_string()),
                display_name: Set(display_name.to_string()),
                role: Set(role.to_string()),
                status: Set(status.to_string()),
                password_hash: Set(hash_admin_password(id, DEFAULT_ADMIN_PASSWORD)),
                last_login_at: Set(last_login_at.to_string()),
                created_at: Set(created_at.clone()),
            }
            .insert(connection)
            .await?;
        }
    }

    for user in admin_user::Entity::find().all(connection).await? {
        if user.password_hash.trim().is_empty() {
            let mut active: admin_user::ActiveModel = user.clone().into();
            active.password_hash = Set(hash_admin_password(&user.id, DEFAULT_ADMIN_PASSWORD));
            active.update(connection).await?;
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
            "data.seed",
            "inspection-demo-data",
            "写入钢板、缺陷、记录、相机和默认配置模拟数据",
            "info",
        )
        .await?;
    }

    Ok(())
}

fn default_camera_configs() -> Vec<CameraConfigInput> {
    let cameras = [
        ("192.168.105.13", "LVM3450CA", "上表面入口相机"),
        ("192.168.102.100", "LVM3450CA", "上表面中部相机"),
        ("192.168.101.100", "LVM3450BE", "上表面出口相机"),
        ("192.168.103.100", "LVM3450RE", "下表面入口相机"),
        ("192.168.104.100", "LVM3450BE", "下表面中部相机"),
        ("192.168.106.100", "LVM3450RE", "下表面出口相机"),
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
            "mode": "six-camera",
            "driver": "lvm-nvt",
            "fallback": "simulated",
            "cameras": cameras
        }
    })
}

fn capture_config_matches_current_cameras(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| value.pointer("/capture/cameras").and_then(Value::as_array).cloned())
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

    let should_refresh_default_cameras = camera_config::Entity::find().count(connection).await? < 6;
    for camera in default_camera_configs() {
        if should_refresh_default_cameras || find_camera_config(connection, &camera.id).await?.is_none() {
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
