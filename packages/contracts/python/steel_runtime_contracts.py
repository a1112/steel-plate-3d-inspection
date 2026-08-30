"""Pure Python bindings for the runtime process contracts."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

SERVICE_HEALTH_SCHEMA = "steel.service-health.v1"
ACQUISITION_MANIFEST_SCHEMA = "steel.acquisition-manifest.v1"
PIPELINE_TASK_SCHEMA = "steel.pipeline-task.v1"
IMAGE_RESULT_SCHEMA = "steel.image-result.v1"
DEFECT_REPORT_SCHEMA = "steel.defect-report.v1"
REPRODUCTION_MANIFEST_SCHEMA = "steel.reproduction-manifest.v1"
ALGORITHM_DATASET_SCHEMA = "steel.algorithm-dataset.v1"
DEFECT_ANNOTATION_SCHEMA = "steel.defect-annotation.v1"
ALGORITHM_BENCHMARK_SCHEMA = "steel.algorithm-benchmark.v1"
ALGORITHM_DATASET_VALIDATION_SCHEMA = "steel.algorithm-dataset-validation.v1"

WorkerRole = Literal["image", "defect"]


@dataclass(frozen=True, slots=True)
class ArtifactRef:
    kind: str
    uri: str
    size: int
    sha256: str

    def validate(self) -> None:
        if not self.kind or not self.uri or self.size < 0 or len(self.sha256) != 64:
            raise ValueError("invalid artifact reference")


@dataclass(frozen=True, slots=True)
class PipelineTask:
    task_id: str
    inspection_id: str
    stage: WorkerRole
    input_manifest_ref: str
    input_manifest_sha256: str
    attempt: int = 0
    schema: str = PIPELINE_TASK_SCHEMA

    def validate(self) -> None:
        if self.schema != PIPELINE_TASK_SCHEMA:
            raise ValueError("unsupported pipeline task schema")
        if not self.task_id or not self.inspection_id:
            raise ValueError("task and inspection identifiers are required")
        if not self.input_manifest_ref or len(self.input_manifest_sha256) != 64:
            raise ValueError("input manifest identity is invalid")
        if self.attempt < 0:
            raise ValueError("attempt cannot be negative")
