use serde::{Deserialize, Serialize};

pub const SERVICE_HEALTH_SCHEMA: &str = "steel.service-health.v1";
pub const ACQUISITION_MANIFEST_SCHEMA: &str = "steel.acquisition-manifest.v1";
pub const PIPELINE_TASK_SCHEMA: &str = "steel.pipeline-task.v1";
pub const IMAGE_RESULT_SCHEMA: &str = "steel.image-result.v1";
pub const DEFECT_REPORT_SCHEMA: &str = "steel.defect-report.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkerRole {
    Image,
    Defect,
}

impl WorkerRole {
    pub const fn service_name(self) -> &'static str {
        match self {
            Self::Image => "steel-image-worker",
            Self::Defect => "steel-defect-worker",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    pub kind: String,
    pub uri: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTask {
    pub schema: String,
    pub task_id: String,
    pub inspection_id: String,
    pub stage: WorkerRole,
    pub input_manifest_ref: String,
    pub input_manifest_sha256: String,
    #[serde(default)]
    pub attempt: u32,
}

impl PipelineTask {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.schema != PIPELINE_TASK_SCHEMA {
            return Err("unsupported pipeline task schema");
        }
        if self.task_id.trim().is_empty() || self.inspection_id.trim().is_empty() {
            return Err("task and inspection identifiers are required");
        }
        if self.input_manifest_ref.trim().is_empty() || self.input_manifest_sha256.len() != 64 {
            return Err("input manifest identity is invalid");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceHealth {
    pub schema: String,
    pub service: String,
    pub role: WorkerRole,
    pub live: bool,
    pub ready: bool,
    pub version: String,
    #[serde(default)]
    pub child_pid: Option<u32>,
    #[serde(default)]
    pub restart_count: u64,
    #[serde(default)]
    pub detail: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_names_are_stable() {
        assert_eq!(WorkerRole::Image.service_name(), "steel-image-worker");
        assert_eq!(WorkerRole::Defect.service_name(), "steel-defect-worker");
    }

    #[test]
    fn task_requires_content_addressed_input() {
        let task = PipelineTask {
            schema: PIPELINE_TASK_SCHEMA.into(),
            task_id: "TASK-1".into(),
            inspection_id: "INSP-1".into(),
            stage: WorkerRole::Image,
            input_manifest_ref: "manifest://acquisition/INSP-1/CAP-1".into(),
            input_manifest_sha256: "a".repeat(64),
            attempt: 0,
        };
        assert_eq!(task.validate(), Ok(()));
    }
}
