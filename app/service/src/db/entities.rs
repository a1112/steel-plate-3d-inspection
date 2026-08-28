pub mod app_config {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "app_config")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub key: String,
        pub value: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod config_revision {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "config_revision")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub config_key: String,
        pub value: String,
        pub actor: String,
        pub action: String,
        pub bytes: i32,
        pub created_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod camera_config {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "camera_config")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
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

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod steel_plate {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "steel_plate")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub plate_no: String,
        pub width_mm: i32,
        pub length_mm: i32,
        pub thickness_mm: i32,
        pub steel_grade: String,
        pub detected_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod defect_type {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "defect_type")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub label: String,
        pub color: String,
        pub shape: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod inspection_record {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "inspection_record")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub time: String,
        pub plate_no: String,
        pub status: String,
        pub defect_count: i32,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod material_session {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "material_session")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
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
        pub updated_at: String,
        pub raw_payload: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod secondary_data {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "secondary_data")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub material_id: String,
        pub session_id: String,
        pub source: String,
        pub payload_type: String,
        pub payload: String,
        pub received_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod trigger_event {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "trigger_event")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
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
        pub created_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod production_inspection {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "production_inspection")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
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

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod production_task {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "production_task")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub idempotency_key: String,
        pub kind: String,
        pub material_id: String,
        pub session_id: String,
        pub chain_id: String,
        pub depends_on_task_id: String,
        pub dependency_policy: String,
        pub blocked_reason: String,
        pub status: String,
        pub phase: String,
        pub payload: String,
        pub result: String,
        pub error: String,
        pub actor: String,
        pub progress: i32,
        pub attempts: i32,
        pub max_attempts: i32,
        pub cancel_requested: bool,
        pub created_at: String,
        pub started_at: String,
        pub finished_at: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod calibration_operation {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "calibration_operation")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub kind: String,
        pub request_hash: String,
        pub request_json: String,
        pub status: String,
        pub provider_http_status: i32,
        pub provider_response_body: String,
        pub error: String,
        pub actor: String,
        pub parent_operation_id: String,
        pub reconciliation_outcome: String,
        pub reconciliation_id: String,
        pub resolved_by: String,
        pub resolved_at: String,
        pub row_version: i32,
        pub created_at: String,
        pub dispatch_started_at: String,
        pub finished_at: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod capture_file {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "capture_file")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
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
        pub created_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod steel_flow {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "steel_flow")]
    pub struct Model {
        #[sea_orm(primary_key)]
        pub flow_no: i64,
        pub flow_code: String,
        pub session_id: String,
        pub material_id: String,
        pub source: String,
        pub status: String,
        pub next_image_no: i64,
        pub image_count: i64,
        pub storage_root: String,
        pub started_at: String,
        pub finished_at: String,
        pub updated_at: String,
        pub raw_payload: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod steel_flow_image {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "steel_flow_image")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub flow_no: i64,
        #[sea_orm(primary_key, auto_increment = false)]
        pub image_no: i64,
        pub inspection_id: String,
        pub session_id: String,
        pub material_id: String,
        pub camera_id: String,
        pub camera_ip: String,
        pub camera_sequence_no: i64,
        pub depth_path: String,
        pub intensity_path: String,
        pub metadata_path: String,
        pub width: i32,
        pub height: i32,
        pub mean_intensity: f64,
        pub captured_at: String,
        pub created_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod steel_flow_region {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "steel_flow_region")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub flow_no: i64,
        #[sea_orm(primary_key, auto_increment = false)]
        pub camera_id: String,
        pub material_id: String,
        pub state: String,
        pub source_width: i32,
        pub source_height: i32,
        pub crop_left: i32,
        pub crop_right: i32,
        pub overlap_column_count: i32,
        pub owned_column_count: i32,
        pub calibration_revision: String,
        pub calibration_sha256: String,
        pub manifest_path: String,
        pub manifest_sha256: String,
        pub quality_json: String,
        pub region_json: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod record_cleanup {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "record_cleanup")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub record_id: String,
        pub material_id: String,
        pub status: String,
        pub actor: String,
        pub reason: String,
        pub manifest_json: String,
        pub files_planned: i32,
        pub files_deleted: i32,
        pub files_missing: i32,
        pub bytes_planned: i64,
        pub bytes_deleted: i64,
        pub error: String,
        pub created_at: String,
        pub updated_at: String,
        pub completed_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod defect {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "defect")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub plate_no: String,
        pub type_id: String,
        pub type_label: String,
        pub surface: String,
        pub severity: String,
        pub distance_head_mm: i32,
        pub operator_side_mm: i32,
        pub drive_side_mm: i32,
        pub width_mm: f64,
        pub height_mm: f64,
        pub depth_mm: f64,
        pub x_ratio: f64,
        pub y_offset_mm: f64,
        pub preview_x: i32,
        pub preview_y: i32,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod production_defect {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "production_defect")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
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
        pub geometry_json: String,
        pub source: String,
        pub algorithm_revision: String,
        pub source_defect_id: String,
        pub preview_image_path: String,
        pub review_status: String,
        pub reviewed_by: String,
        pub reviewed_at: String,
        pub review_note: String,
        pub created_at: String,
        pub updated_at: String,
        pub active: bool,
        pub superseded_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod production_alarm {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "production_alarm")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
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
        pub status: String,
        pub created_at: String,
        pub acknowledged_at: String,
        pub resolved_at: String,
        pub acknowledged_by: String,
        pub acknowledge_note: String,
        pub resolved_by: String,
        pub resolve_note: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod admin_user {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "admin_user")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub display_name: String,
        pub role: String,
        pub status: String,
        pub password_hash: String,
        pub must_change_password: bool,
        pub last_login_at: String,
        pub created_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod admin_role {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "admin_role")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub label: String,
        pub description: String,
        pub permissions: String,
        pub status: String,
        pub updated_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod audit_log {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "audit_log")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub actor: String,
        pub action: String,
        pub target: String,
        pub detail: String,
        pub level: String,
        pub created_at: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
