from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


TOOL_NAME = "validate_algorithm_dataset"
TOOL_VERSION = "1.0.0"
DATASET_SCHEMA = "steel.algorithm-dataset.v1"
ANNOTATION_SCHEMA = "steel.defect-annotation.v1"
VALIDATION_SCHEMA = "steel.algorithm-dataset-validation.v1"
PURPOSES = ("development", "validation", "qualification", "benchmark")
SPLIT_NAMES = ("train", "validation", "test", "qualification")
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
SCHEME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
WINDOWS_DRIVE_PATTERN = re.compile(r"^[A-Za-z]:")
REPARSE_POINT_ATTRIBUTE = 0x400


@dataclass(frozen=True)
class VerifiedFile:
    path: Path
    data: bytes


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_manifest_bytes(payload: dict[str, Any]) -> bytes:
    """Return the documented canonical identity with manifestSha256 removed."""
    canonical = copy.deepcopy(payload)
    canonical.pop("manifestSha256", None)
    return json.dumps(
        canonical,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def canonical_manifest_sha256(payload: dict[str, Any]) -> str:
    return sha256_bytes(canonical_manifest_bytes(payload))


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_reparse_point(path: Path) -> bool:
    try:
        if path.is_symlink():
            return True
        attributes = getattr(path.lstat(), "st_file_attributes", 0)
        return bool(attributes & REPARSE_POINT_ATTRIBUTE)
    except OSError:
        return False


def _has_reparse_component(path: Path) -> bool:
    absolute = path.absolute()
    current = Path(absolute.anchor) if absolute.anchor else Path()
    parts = absolute.parts[1:] if absolute.anchor else absolute.parts
    for part in parts:
        current = current / part
        if current.exists() and _is_reparse_point(current):
            return True
    return False


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip()
    if candidate.endswith("Z"):
        candidate = candidate[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _load_strict_json(data: bytes) -> Any:
    def reject_constant(value: str) -> None:
        raise ValueError(f"non-finite JSON number is forbidden: {value}")

    return json.loads(data.decode("utf-8"), parse_constant=reject_constant)


class DatasetValidator:
    def __init__(
        self,
        manifest_path: Path,
        *,
        data_roots: Sequence[Path] | None = None,
        purpose: str = "qualification",
    ) -> None:
        self.manifest_path = manifest_path
        self.purpose = purpose
        self.checks: list[dict[str, Any]] = []
        self.source_paths: set[Path] = set()
        self.manifest_file_sha256 = ""
        self.dataset_revision = ""
        self.statistics = {
            "sampleCount": 0,
            "materialCount": 0,
            "batchCount": 0,
            "splitCounts": {},
            "classCounts": {},
        }
        requested_roots = list(data_roots or [manifest_path.parent])
        self.data_roots: list[Path] = []
        for index, root in enumerate(requested_roots):
            subject = f"dataRoots[{index}]"
            if not root.exists() or not root.is_dir():
                self.check(False, "data_root_invalid", subject, "approved data root must be an existing directory")
                continue
            if _has_reparse_component(root):
                self.check(False, "path_reparse_forbidden", subject, "approved data root contains a symlink or reparse point")
                continue
            self.data_roots.append(root.resolve(strict=True))
            self.check(True, "data_root_valid", subject, "approved data root is a normal directory")

    def check(self, passed: bool, code: str, subject: str, message: str) -> bool:
        self.checks.append(
            {
                "code": code,
                "status": "passed" if passed else "failed",
                "subject": subject,
                "message": message,
            }
        )
        return passed

    def manifest_path_allowed(self) -> bool:
        if (
            not self.manifest_path.exists()
            or not self.manifest_path.is_file()
            or _has_reparse_component(self.manifest_path)
        ):
            return False
        try:
            resolved = self.manifest_path.resolve(strict=True)
        except OSError:
            return False
        matches = 0
        for root in self.data_roots:
            try:
                resolved.relative_to(root)
                matches += 1
            except ValueError:
                continue
        allowed = matches == 1
        if allowed:
            self.source_paths.add(resolved)
        return allowed

    def exact_keys(
        self,
        value: Any,
        subject: str,
        required: Iterable[str],
        optional: Iterable[str] = (),
    ) -> dict[str, Any]:
        if not self.check(isinstance(value, dict), "object_invalid", subject, "value must be an object"):
            return {}
        required_set = set(required)
        allowed = required_set | set(optional)
        actual = set(value)
        missing = sorted(required_set - actual)
        unknown = sorted(actual - allowed)
        self.check(
            not missing and not unknown,
            "object_keys_invalid",
            subject,
            f"missing={missing}; unknown={unknown}",
        )
        return value

    def required_string(self, value: Any, subject: str, *, identifier: bool = False) -> str:
        valid = isinstance(value, str) and bool(value.strip())
        if identifier:
            valid = valid and bool(ID_PATTERN.fullmatch(value))
        self.check(valid, "string_invalid", subject, "value must be a non-empty string with the required format")
        return value if isinstance(value, str) else ""

    def required_sha256(self, value: Any, subject: str) -> str:
        valid = isinstance(value, str) and bool(SHA256_PATTERN.fullmatch(value))
        self.check(valid, "sha256_invalid", subject, "value must be a 64-character SHA-256 hex digest")
        return value.lower() if valid else ""

    def required_integer(self, value: Any, subject: str, *, minimum: int = 0) -> int | None:
        valid = isinstance(value, int) and not isinstance(value, bool) and value >= minimum
        self.check(valid, "integer_invalid", subject, f"value must be an integer >= {minimum}")
        return value if valid else None

    def timestamp(self, value: Any, subject: str, *, nullable: bool = False) -> datetime | None:
        if nullable and value is None:
            self.check(True, "timestamp_valid", subject, "nullable timestamp is absent")
            return None
        parsed = _parse_timestamp(value)
        self.check(parsed is not None, "timestamp_invalid", subject, "timestamp must be ISO-8601 with an explicit timezone")
        return parsed

    def resolve_reference(self, uri: Any, subject: str) -> Path | None:
        if not isinstance(uri, str) or not uri.strip():
            self.check(False, "path_invalid", subject, "file reference must be a non-empty relative path")
            return None
        normalized = uri.replace("\\", "/")
        parts = normalized.split("/")
        invalid = (
            SCHEME_PATTERN.match(normalized) is not None
            or WINDOWS_DRIVE_PATTERN.match(normalized) is not None
            or normalized.startswith("/")
            or normalized.startswith("//")
            or any(part in ("", ".", "..") for part in parts)
        )
        if invalid:
            self.check(False, "path_invalid", subject, "absolute paths, URI schemes, traversal, and non-canonical segments are forbidden")
            return None

        matches: list[Path] = []
        unsafe = False
        for root in self.data_roots:
            candidate = root.joinpath(*parts)
            if not candidate.exists():
                continue
            if _has_reparse_component(candidate):
                unsafe = True
                continue
            try:
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(root)
            except (OSError, ValueError):
                unsafe = True
                continue
            if resolved.is_file():
                matches.append(resolved)

        if unsafe:
            self.check(False, "path_reparse_forbidden", subject, "file reference traverses a symlink, reparse point, or approved-root boundary")
            return None
        if not matches:
            self.check(False, "file_missing", subject, "referenced ordinary file was not found under an approved data root")
            return None
        unique = list(dict.fromkeys(matches))
        if len(unique) != 1:
            self.check(False, "file_reference_ambiguous", subject, "file reference resolves in more than one approved data root")
            return None
        self.check(True, "path_valid", subject, "file reference is a normal file under exactly one approved data root")
        return unique[0]

    def verify_file(
        self,
        value: Any,
        subject: str,
        *,
        versioned: bool = False,
        artifact: bool = False,
    ) -> VerifiedFile | None:
        required = ["uri", "bytes", "sha256"]
        if versioned:
            required.insert(0, "revision")
        if artifact:
            required = ["artifactId", "kind", *required]
        item = self.exact_keys(value, subject, required)
        if versioned:
            self.required_string(item.get("revision"), f"{subject}.revision", identifier=True)
        if artifact:
            self.required_string(item.get("artifactId"), f"{subject}.artifactId", identifier=True)
            self.required_string(item.get("kind"), f"{subject}.kind")
        expected_size = self.required_integer(item.get("bytes"), f"{subject}.bytes")
        expected_hash = self.required_sha256(item.get("sha256"), f"{subject}.sha256")
        path = self.resolve_reference(item.get("uri"), f"{subject}.uri")
        if path is None:
            return None
        self.source_paths.add(path)
        try:
            data = path.read_bytes()
        except OSError as error:
            self.check(False, "file_read_failed", subject, f"referenced file could not be read: {type(error).__name__}")
            return None
        self.check(expected_size == len(data), "file_size_mismatch", subject, "referenced file byte count must match")
        self.check(expected_hash == sha256_bytes(data), "file_sha256_mismatch", subject, "referenced file SHA-256 must match")
        return VerifiedFile(path=path, data=data)

    def validate(self, raw_manifest: bytes) -> dict[str, Any]:
        self.manifest_file_sha256 = sha256_bytes(raw_manifest)
        if not self.check(
            self.manifest_path_allowed(),
            "manifest_file_invalid",
            "manifest",
            "manifest must be an ordinary file below exactly one approved root and must not traverse a symlink or reparse point",
        ):
            return self.report()
        try:
            payload = _load_strict_json(raw_manifest)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self.check(False, "manifest_json_invalid", "manifest", f"manifest must be valid UTF-8 JSON: {type(error).__name__}")
            return self.report()
        manifest = self.exact_keys(
            payload,
            "manifest",
            [
                "schema",
                "datasetRevision",
                "manifestSha256",
                "createdAt",
                "source",
                "accessLevel",
                "license",
                "surface",
                "taxonomy",
                "splits",
                "expectedStatistics",
            ],
        )
        self.check(manifest.get("schema") == DATASET_SCHEMA, "manifest_schema_invalid", "manifest.schema", f"schema must be {DATASET_SCHEMA}")
        self.dataset_revision = self.required_string(manifest.get("datasetRevision"), "manifest.datasetRevision", identifier=True)
        declared_manifest_hash = self.required_sha256(manifest.get("manifestSha256"), "manifest.manifestSha256")
        try:
            canonical_hash = canonical_manifest_sha256(manifest)
        except (TypeError, ValueError):
            canonical_hash = ""
        self.check(
            bool(declared_manifest_hash) and declared_manifest_hash == canonical_hash,
            "manifest_hash_mismatch",
            "manifest.manifestSha256",
            "declared manifest identity must match canonical JSON with manifestSha256 removed",
        )
        self.timestamp(manifest.get("createdAt"), "manifest.createdAt")
        self.validate_source(manifest.get("source"))
        self.check(
            manifest.get("accessLevel") in ("public", "internal", "restricted", "confidential"),
            "access_level_invalid",
            "manifest.accessLevel",
            "access level must be public, internal, restricted, or confidential",
        )
        self.validate_license(manifest.get("license"))
        self.validate_surface(manifest.get("surface"))
        taxonomy_revision, taxonomy_classes = self.validate_taxonomy(manifest.get("taxonomy"))
        actual = self.validate_splits(manifest.get("splits"), taxonomy_revision, taxonomy_classes)
        self.statistics = actual
        self.validate_statistics(manifest.get("expectedStatistics"), actual, taxonomy_classes)
        return self.report()

    def validate_source(self, value: Any) -> None:
        source = self.exact_keys(value, "manifest.source", ["name", "siteId", "sensorProfile"])
        self.required_string(source.get("name"), "manifest.source.name")
        self.required_string(source.get("siteId"), "manifest.source.siteId", identifier=True)
        self.required_string(source.get("sensorProfile"), "manifest.source.sensorProfile")

    def validate_license(self, value: Any) -> None:
        license_value = self.exact_keys(value, "manifest.license", ["status", "purposes", "evidence"])
        status = license_value.get("status")
        self.check(status in ("Approved", "Restricted", "Blocked"), "license_status_invalid", "manifest.license.status", "license status must be Approved, Restricted, or Blocked")
        purposes = license_value.get("purposes")
        purposes_valid = isinstance(purposes, list) and all(item in PURPOSES for item in purposes) and len(set(purposes)) == len(purposes)
        self.check(purposes_valid, "license_purposes_invalid", "manifest.license.purposes", "license purposes must be unique supported purposes")
        self.verify_file(license_value.get("evidence"), "manifest.license.evidence")
        self.check(status != "Blocked", "license_blocked", "manifest.license.status", "Blocked assets cannot be validated for use")
        self.check(
            purposes_valid and self.purpose in purposes,
            "license_purpose_forbidden",
            "manifest.license.purposes",
            f"license must explicitly permit purpose '{self.purpose}'",
        )

    def validate_surface(self, value: Any) -> None:
        surface = self.exact_keys(
            value,
            "manifest.surface",
            ["geometry", "coordinateSystem", "lengthUnit", "depthInvalidValue", "calibration"],
        )
        self.check(surface.get("geometry") in ("cylinder", "plate"), "geometry_profile_invalid", "manifest.surface.geometry", "geometry must be cylinder or plate")
        self.required_string(surface.get("coordinateSystem"), "manifest.surface.coordinateSystem")
        self.check(surface.get("lengthUnit") == "mm", "surface_unit_invalid", "manifest.surface.lengthUnit", "qualified surface length unit must be mm")
        invalid_depth = surface.get("depthInvalidValue")
        self.check(
            (_is_number(invalid_depth) and math.isfinite(float(invalid_depth)))
            or invalid_depth in ("nan", "none", "masked"),
            "depth_invalid_value_invalid",
            "manifest.surface.depthInvalidValue",
            "depth invalid value must be finite numeric or an explicit supported token",
        )
        self.verify_file(surface.get("calibration"), "manifest.surface.calibration", versioned=True)

    def validate_taxonomy(self, value: Any) -> tuple[str, set[str]]:
        taxonomy = self.exact_keys(value, "manifest.taxonomy", ["revision", "classes"])
        revision = self.required_string(taxonomy.get("revision"), "manifest.taxonomy.revision", identifier=True)
        classes = taxonomy.get("classes")
        if not self.check(isinstance(classes, list) and bool(classes), "taxonomy_classes_invalid", "manifest.taxonomy.classes", "taxonomy classes must be a non-empty array"):
            return revision, set()
        class_ids: set[str] = set()
        for index, raw_class in enumerate(classes):
            subject = f"manifest.taxonomy.classes[{index}]"
            item = self.exact_keys(raw_class, subject, ["id", "name"])
            class_id = self.required_string(item.get("id"), f"{subject}.id", identifier=True)
            self.required_string(item.get("name"), f"{subject}.name")
            self.check(bool(class_id) and class_id not in class_ids, "duplicate_taxonomy_class", f"{subject}.id", "taxonomy class IDs must be unique")
            if class_id:
                class_ids.add(class_id)
        return revision, class_ids

    def validate_splits(
        self,
        value: Any,
        taxonomy_revision: str,
        taxonomy_classes: set[str],
    ) -> dict[str, Any]:
        if not self.check(isinstance(value, list) and bool(value), "splits_invalid", "manifest.splits", "splits must be a non-empty array"):
            return self.statistics
        seen_splits: set[str] = set()
        sample_ids: set[str] = set()
        artifact_ids: set[str] = set()
        defect_ids: set[str] = set()
        material_splits: dict[str, str] = {}
        batch_splits: dict[str, str] = {}
        acquisition_batch_splits: dict[str, str] = {}
        materials: set[str] = set()
        batches: set[str] = set()
        class_counts = {class_id: 0 for class_id in sorted(taxonomy_classes)}
        split_counts: dict[str, int] = {}
        sample_count = 0

        for split_index, raw_split in enumerate(value):
            split_subject = f"manifest.splits[{split_index}]"
            split = self.exact_keys(raw_split, split_subject, ["name", "exclusive", "samples"])
            split_name = split.get("name")
            self.check(split_name in SPLIT_NAMES, "split_name_invalid", f"{split_subject}.name", "split name is unsupported")
            self.check(isinstance(split_name, str) and split_name not in seen_splits, "duplicate_split", f"{split_subject}.name", "split names must be unique")
            if isinstance(split_name, str):
                seen_splits.add(split_name)
            self.check(split.get("exclusive") is True, "split_not_exclusive", f"{split_subject}.exclusive", "every declared split must be mutually exclusive")
            samples = split.get("samples")
            if not self.check(isinstance(samples, list), "samples_invalid", f"{split_subject}.samples", "samples must be an array"):
                continue
            split_counts[str(split_name)] = len(samples)
            for sample_index, raw_sample in enumerate(samples):
                sample_subject = f"{split_subject}.samples[{sample_index}]"
                sample = self.exact_keys(
                    raw_sample,
                    sample_subject,
                    ["sampleId", "materialId", "batchId", "acquisitionBatch", "artifacts", "annotation"],
                    ["cameraId"],
                )
                sample_id = self.required_string(sample.get("sampleId"), f"{sample_subject}.sampleId", identifier=True)
                material_id = self.required_string(sample.get("materialId"), f"{sample_subject}.materialId", identifier=True)
                batch_id = self.required_string(sample.get("batchId"), f"{sample_subject}.batchId", identifier=True)
                acquisition_batch = self.required_string(sample.get("acquisitionBatch"), f"{sample_subject}.acquisitionBatch", identifier=True)
                if "cameraId" in sample:
                    self.required_string(sample.get("cameraId"), f"{sample_subject}.cameraId", identifier=True)
                self.check(bool(sample_id) and sample_id not in sample_ids, "duplicate_sample_id", f"{sample_subject}.sampleId", "sample IDs must be globally unique")
                if sample_id:
                    sample_ids.add(sample_id)
                previous_material_split = material_splits.get(material_id)
                self.check(not previous_material_split or previous_material_split == split_name, "material_split_leakage", f"{sample_subject}.materialId", "a material must not cross mutually exclusive splits")
                previous_batch_split = batch_splits.get(batch_id)
                self.check(not previous_batch_split or previous_batch_split == split_name, "batch_split_leakage", f"{sample_subject}.batchId", "a batch must not cross mutually exclusive splits")
                previous_acquisition_split = acquisition_batch_splits.get(acquisition_batch)
                self.check(
                    not previous_acquisition_split or previous_acquisition_split == split_name,
                    "acquisition_batch_split_leakage",
                    f"{sample_subject}.acquisitionBatch",
                    "an acquisition batch must not cross mutually exclusive splits",
                )
                if material_id and isinstance(split_name, str):
                    material_splits.setdefault(material_id, split_name)
                    materials.add(material_id)
                if batch_id and isinstance(split_name, str):
                    batch_splits.setdefault(batch_id, split_name)
                    batches.add(batch_id)
                if acquisition_batch and isinstance(split_name, str):
                    acquisition_batch_splits.setdefault(acquisition_batch, split_name)

                artifacts = sample.get("artifacts")
                if self.check(isinstance(artifacts, list) and bool(artifacts), "artifacts_invalid", f"{sample_subject}.artifacts", "sample artifacts must be a non-empty array"):
                    for artifact_index, artifact in enumerate(artifacts):
                        artifact_subject = f"{sample_subject}.artifacts[{artifact_index}]"
                        artifact_item = artifact if isinstance(artifact, dict) else {}
                        artifact_id = artifact_item.get("artifactId")
                        self.check(isinstance(artifact_id, str) and artifact_id not in artifact_ids, "duplicate_artifact_id", f"{artifact_subject}.artifactId", "artifact IDs must be globally unique")
                        if isinstance(artifact_id, str):
                            artifact_ids.add(artifact_id)
                        self.verify_file(artifact, artifact_subject, artifact=True)

                annotation_file = self.verify_file(sample.get("annotation"), f"{sample_subject}.annotation")
                if annotation_file is not None:
                    self.validate_annotation(
                        annotation_file,
                        f"{sample_subject}.annotation",
                        sample_id=sample_id,
                        material_id=material_id,
                        split_name=str(split_name),
                        taxonomy_revision=taxonomy_revision,
                        taxonomy_classes=taxonomy_classes,
                        defect_ids=defect_ids,
                        class_counts=class_counts,
                    )
                sample_count += 1

        return {
            "sampleCount": sample_count,
            "materialCount": len(materials),
            "batchCount": len(batches),
            "splitCounts": split_counts,
            "classCounts": class_counts,
        }

    def validate_annotation(
        self,
        verified: VerifiedFile,
        subject: str,
        *,
        sample_id: str,
        material_id: str,
        split_name: str,
        taxonomy_revision: str,
        taxonomy_classes: set[str],
        defect_ids: set[str],
        class_counts: dict[str, int],
    ) -> None:
        try:
            payload = _load_strict_json(verified.data)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self.check(False, "annotation_json_invalid", subject, f"annotation must be valid UTF-8 JSON: {type(error).__name__}")
            return
        annotation = self.exact_keys(
            payload,
            subject,
            [
                "schema",
                "annotationId",
                "sampleId",
                "materialId",
                "taxonomyRevision",
                "status",
                "disposition",
                "source",
                "annotator",
                "reviewer",
                "adjudicator",
                "createdAt",
                "reviewedAt",
                "adjudicatedAt",
                "disputes",
                "defects",
            ],
        )
        self.check(annotation.get("schema") == ANNOTATION_SCHEMA, "annotation_schema_invalid", f"{subject}.schema", f"schema must be {ANNOTATION_SCHEMA}")
        self.required_string(annotation.get("annotationId"), f"{subject}.annotationId", identifier=True)
        self.check(annotation.get("sampleId") == sample_id and annotation.get("materialId") == material_id and annotation.get("taxonomyRevision") == taxonomy_revision, "annotation_identity_mismatch", subject, "annotation sample, material, and taxonomy identities must match the dataset")
        status = annotation.get("status")
        self.check(status in ("pending", "reviewed", "adjudicated"), "annotation_status_invalid", f"{subject}.status", "annotation status is unsupported")
        if split_name == "qualification":
            self.check(status == "adjudicated", "annotation_status_not_adjudicated", f"{subject}.status", "qualification accepts only adjudicated annotations")
        disposition = annotation.get("disposition")
        self.check(disposition in ("defect", "no-defect", "hard-negative", "indeterminate"), "annotation_disposition_invalid", f"{subject}.disposition", "annotation disposition is unsupported")
        self.required_string(annotation.get("source"), f"{subject}.source")
        self.required_string(annotation.get("annotator"), f"{subject}.annotator")
        created_at = self.timestamp(annotation.get("createdAt"), f"{subject}.createdAt")
        reviewed_at = self.timestamp(annotation.get("reviewedAt"), f"{subject}.reviewedAt", nullable=True)
        adjudicated_at = self.timestamp(annotation.get("adjudicatedAt"), f"{subject}.adjudicatedAt", nullable=True)
        if status in ("reviewed", "adjudicated"):
            self.required_string(annotation.get("reviewer"), f"{subject}.reviewer")
            self.check(reviewed_at is not None, "review_time_missing", f"{subject}.reviewedAt", "reviewed annotations require a review timestamp")
        if status == "adjudicated":
            self.required_string(annotation.get("adjudicator"), f"{subject}.adjudicator")
            self.check(adjudicated_at is not None, "adjudication_time_missing", f"{subject}.adjudicatedAt", "adjudicated annotations require an adjudication timestamp")
        ordered = (
            created_at is not None
            and (reviewed_at is None or reviewed_at >= created_at)
            and (adjudicated_at is None or reviewed_at is not None and adjudicated_at >= reviewed_at)
        )
        self.check(ordered, "annotation_time_order_invalid", subject, "annotation timestamps must be ordered created <= reviewed <= adjudicated")

        disputes = annotation.get("disputes")
        self.check(isinstance(disputes, list), "annotation_disputes_invalid", f"{subject}.disputes", "disputes must be an array")
        if isinstance(disputes, list):
            for index, raw_dispute in enumerate(disputes):
                dispute_subject = f"{subject}.disputes[{index}]"
                dispute = self.exact_keys(raw_dispute, dispute_subject, ["recordedAt", "summary", "resolution"])
                self.timestamp(dispute.get("recordedAt"), f"{dispute_subject}.recordedAt")
                self.required_string(dispute.get("summary"), f"{dispute_subject}.summary")
                self.required_string(dispute.get("resolution"), f"{dispute_subject}.resolution")

        defects = annotation.get("defects")
        if not self.check(isinstance(defects, list), "annotation_defects_invalid", f"{subject}.defects", "defects must be an array"):
            return
        self.check((disposition == "defect" and bool(defects)) or (disposition != "defect" and not defects), "annotation_disposition_mismatch", subject, "defect disposition requires defects; other explicit dispositions require an empty defect list")
        for index, raw_defect in enumerate(defects):
            self.validate_defect(
                raw_defect,
                f"{subject}.defects[{index}]",
                taxonomy_classes=taxonomy_classes,
                defect_ids=defect_ids,
                class_counts=class_counts,
            )

    def validate_defect(
        self,
        value: Any,
        subject: str,
        *,
        taxonomy_classes: set[str],
        defect_ids: set[str],
        class_counts: dict[str, int],
    ) -> None:
        defect = self.exact_keys(value, subject, ["defectId", "classId", "roi2d", "measurements"], ["geometry3d"])
        defect_id = self.required_string(defect.get("defectId"), f"{subject}.defectId", identifier=True)
        self.check(bool(defect_id) and defect_id not in defect_ids, "duplicate_defect_id", f"{subject}.defectId", "defect IDs must be globally unique")
        if defect_id:
            defect_ids.add(defect_id)
        class_id = self.required_string(defect.get("classId"), f"{subject}.classId", identifier=True)
        self.check(class_id in taxonomy_classes, "taxonomy_unknown_class", f"{subject}.classId", "defect class must exist in the frozen taxonomy")
        if class_id in class_counts:
            class_counts[class_id] += 1

        roi = self.exact_keys(defect.get("roi2d"), f"{subject}.roi2d", ["x", "y", "width", "height", "imageWidth", "imageHeight"], ["contour"])
        x, y, width, height = (roi.get(key) for key in ("x", "y", "width", "height"))
        image_width, image_height = roi.get("imageWidth"), roi.get("imageHeight")
        geometry_valid = (
            all(_is_number(item) for item in (x, y, width, height))
            and isinstance(image_width, int)
            and not isinstance(image_width, bool)
            and isinstance(image_height, int)
            and not isinstance(image_height, bool)
            and x >= 0
            and y >= 0
            and width > 0
            and height > 0
            and image_width > 0
            and image_height > 0
            and x + width <= image_width
            and y + height <= image_height
        )
        self.check(geometry_valid, "geometry_out_of_bounds", f"{subject}.roi2d", "2D ROI must be positive and remain inside the declared image bounds")
        contour = roi.get("contour")
        if contour is not None:
            contour_valid = isinstance(contour, list) and len(contour) >= 3
            if contour_valid:
                for point in contour:
                    contour_valid = (
                        isinstance(point, dict)
                        and set(point) == {"x", "y"}
                        and _is_number(point.get("x"))
                        and _is_number(point.get("y"))
                        and 0 <= point["x"] <= image_width
                        and 0 <= point["y"] <= image_height
                    )
                    if not contour_valid:
                        break
            self.check(contour_valid, "geometry_out_of_bounds", f"{subject}.roi2d.contour", "contour must contain at least three in-bounds points")
        if "geometry3d" in defect:
            self.verify_file(defect.get("geometry3d"), f"{subject}.geometry3d")

        measurements = defect.get("measurements")
        if not self.check(isinstance(measurements, list) and bool(measurements), "measurements_invalid", f"{subject}.measurements", "defect measurements must be a non-empty array"):
            return
        kinds: set[str] = set()
        expected_units = {"length": "mm", "width": "mm", "depth": "mm", "height": "mm", "area": "mm2"}
        for index, raw_measurement in enumerate(measurements):
            measurement_subject = f"{subject}.measurements[{index}]"
            measurement = self.exact_keys(raw_measurement, measurement_subject, ["kind", "value", "unit"])
            kind = measurement.get("kind")
            unit = measurement.get("unit")
            self.check(kind in expected_units and kind not in kinds, "measurement_kind_invalid", f"{measurement_subject}.kind", "measurement kind must be supported and unique per defect")
            if isinstance(kind, str):
                kinds.add(kind)
            measurement_value = measurement.get("value")
            self.check(
                _is_number(measurement_value)
                and math.isfinite(float(measurement_value))
                and measurement_value >= 0,
                "measurement_value_invalid",
                f"{measurement_subject}.value",
                "measurement value must be finite and non-negative",
            )
            self.check(expected_units.get(kind) == unit, "measurement_unit_invalid", f"{measurement_subject}.unit", "length/depth/height use mm and area uses mm2")

    def validate_statistics(
        self,
        value: Any,
        actual: dict[str, Any],
        taxonomy_classes: set[str],
    ) -> None:
        expected = self.exact_keys(
            value,
            "manifest.expectedStatistics",
            ["sampleCount", "materialCount", "batchCount", "splitCounts", "classCounts"],
        )
        for name in ("sampleCount", "materialCount", "batchCount"):
            self.required_integer(expected.get(name), f"manifest.expectedStatistics.{name}")
        for map_name in ("splitCounts", "classCounts"):
            count_map = expected.get(map_name)
            valid = isinstance(count_map, dict) and all(
                isinstance(key, str)
                and bool(ID_PATTERN.fullmatch(key))
                and isinstance(count, int)
                and not isinstance(count, bool)
                and count >= 0
                for key, count in count_map.items()
            )
            self.check(valid, "statistics_map_invalid", f"manifest.expectedStatistics.{map_name}", "statistics maps must contain non-negative integer counts")
        expected_classes = expected.get("classCounts")
        self.check(not isinstance(expected_classes, dict) or set(expected_classes) == taxonomy_classes, "statistics_taxonomy_mismatch", "manifest.expectedStatistics.classCounts", "class count keys must exactly match the frozen taxonomy")
        self.check(expected == actual, "statistics_mismatch", "manifest.expectedStatistics", "declared aggregate statistics must exactly match validated files")

    def report(self) -> dict[str, Any]:
        failures = [item for item in self.checks if item["status"] == "failed"]
        return {
            "schema": VALIDATION_SCHEMA,
            "tool": {"name": TOOL_NAME, "version": TOOL_VERSION},
            "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "status": "pass" if not failures else "fail",
            "code": 0 if not failures else 1,
            "purpose": self.purpose,
            "manifest": {
                "name": self.manifest_path.name,
                "sha256": self.manifest_file_sha256,
                "datasetRevision": self.dataset_revision,
            },
            "summary": {
                "checkCount": len(self.checks),
                "passedCount": len(self.checks) - len(failures),
                "errorCount": len(failures),
                **self.statistics,
            },
            "checks": self.checks,
        }


def validate_dataset(
    manifest_path: Path,
    *,
    data_roots: Sequence[Path] | None = None,
    purpose: str = "qualification",
) -> dict[str, Any]:
    validator = DatasetValidator(manifest_path, data_roots=data_roots, purpose=purpose)
    if not validator.manifest_path_allowed():
        validator.check(
            False,
            "manifest_file_invalid",
            "manifest",
            "manifest must be an ordinary file below exactly one approved root and must not traverse a symlink or reparse point",
        )
        return validator.report()
    try:
        raw_manifest = manifest_path.read_bytes()
    except OSError as error:
        validator.check(False, "manifest_read_failed", "manifest", f"manifest could not be read: {type(error).__name__}")
        return validator.report()
    return validator.validate(raw_manifest)


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def paths_alias(first: Path, second: Path) -> bool:
    try:
        if first.resolve(strict=False) == second.resolve(strict=False):
            return True
    except OSError:
        pass
    if first.exists() and second.exists():
        try:
            return os.path.samefile(first, second)
        except OSError:
            pass
    return False


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate a frozen steel algorithm dataset without mutating source assets")
    parser.add_argument("--manifest", required=True, type=Path, help="steel.algorithm-dataset.v1 manifest")
    parser.add_argument("--data-root", action="append", type=Path, default=None, help="approved data root; repeat for multiple roots (defaults to manifest directory)")
    parser.add_argument("--purpose", choices=PURPOSES, default="qualification")
    parser.add_argument("--output", required=True, type=Path, help="atomic steel.algorithm-dataset-validation.v1 report path")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if paths_alias(args.output, args.manifest):
        print("validation output must not overwrite the input manifest", file=sys.stderr)
        return 2
    dataset_validator = DatasetValidator(args.manifest, data_roots=args.data_root, purpose=args.purpose)
    if not dataset_validator.manifest_path_allowed():
        dataset_validator.check(
            False,
            "manifest_file_invalid",
            "manifest",
            "manifest must be an ordinary file below exactly one approved root and must not traverse a symlink or reparse point",
        )
        result = dataset_validator.report()
    else:
        try:
            raw_manifest = args.manifest.read_bytes()
        except OSError as error:
            dataset_validator.check(False, "manifest_read_failed", "manifest", f"manifest could not be read: {type(error).__name__}")
            result = dataset_validator.report()
        else:
            result = dataset_validator.validate(raw_manifest)
    aliased_source = next(
        (source for source in dataset_validator.source_paths if paths_alias(args.output, source)),
        None,
    )
    if aliased_source is not None:
        print(f"validation output must not overwrite a source asset: {aliased_source.name}", file=sys.stderr)
        return 2
    try:
        write_json_atomic(args.output, result)
    except OSError as error:
        print(f"cannot write validation report: {type(error).__name__}: {error}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return int(result["code"])


if __name__ == "__main__":
    raise SystemExit(main())
