#!/usr/bin/env python3
"""Import verified legacy BKV records into the current normalized local store."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

try:
    from scripts.build_bkv_runtime_manifest import load_verified_runtime_manifest
    from scripts.convert_bkv_d3img import validate_artifact_identity
except ModuleNotFoundError:
    from build_bkv_runtime_manifest import load_verified_runtime_manifest
    from convert_bkv_d3img import validate_artifact_identity


PUBLIC_SERVICE_SCHEMA = "steel.bkv-import-service.v1"
STANDARD_RECORD_SCHEMA = "steel.standard-record.v2"
TILE_CACHE_SCHEMA = "steel.inspection-world-cache.v2"
TILE_SIZE = 128
PROFILE_SCHEMA = "steel.runtime-profile.v1"
PROJECT_SCHEMA = "steel.project-config.v1"
SITE_SCHEMA = "steel.site-config.v1"


class ImportInterrupted(RuntimeError):
    """Raised by the explicit test/operations interruption hook."""


@dataclass(frozen=True)
class ImportResult:
    job_id: str
    status: str
    total_records: int
    converted_records: int
    skipped_records: int
    quarantined_records: int


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = (
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def _replace_directory_with_retry(
    source: Path,
    destination: Path,
    *,
    attempts: int = 4,
) -> None:
    """Preserve atomic publication while tolerating brief Windows file locks."""
    for attempt in range(attempts):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt + 1 >= attempts:
                raise
            time.sleep(0.05 * (2**attempt))


def _remove_tree_resilient(path: Path, *, attempts: int = 4) -> bool:
    """Remove transaction residue despite disappearing AppleDouble sidecar files."""
    for attempt in range(attempts):
        if not path.exists():
            return True
        shutil.rmtree(path, ignore_errors=True)
        if not path.exists():
            return True
        for apple_double in path.rglob("._*"):
            if apple_double.is_file():
                apple_double.unlink(missing_ok=True)
        time.sleep(0.05 * (2**attempt))
    return not path.exists()


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid {label}: {path}: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object: {path}")
    return value


def _severity_grade(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = value.strip().lower()
        named = {
            "minor": 1,
            "review": 2,
            "moderate": 2,
            "warning": 2,
            "severe": 3,
            "critical": 3,
        }
        if normalized in named:
            return named[normalized]
    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"defect severity is invalid: {value}") from error


def _contained(root: Path, relative: str, label: str) -> Path:
    relative_path = Path(str(relative))
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise ValueError(f"{label} must remain beneath project root")
    resolved = (root / relative_path).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as error:
        raise ValueError(f"{label} escapes project root") from error
    return resolved


class BkvImportService:
    """Read-only legacy source adapter with atomic normalized record publication."""

    def __init__(
        self,
        *,
        project_path: Path,
        profile_path: Path | None = None,
        interrupt_after_staged_records: int | None = None,
    ) -> None:
        self.project_path = Path(project_path).resolve()
        self.project_root = (
            self.project_path.parent.parent
            if self.project_path.parent.name.lower() == "config"
            else self.project_path.parent
        ).resolve()
        project = _read_json(self.project_path, "project config")
        if project.get("schema") != PROJECT_SCHEMA:
            raise ValueError(f"project schema must be {PROJECT_SCHEMA}")
        self.site_path: Path | None = None
        active_site = str(project.get("activeSiteConfig", "")).strip()
        if active_site:
            self.site_path = _contained(
                self.project_root,
                active_site,
                "active site config",
            )
            site = _read_json(self.site_path, "active site config")
            if site.get("schema") != SITE_SCHEMA:
                raise ValueError(f"site schema must be {SITE_SCHEMA}")
            configured_profile = _contained(
                self.site_path.parent,
                str(site.get("runtimeProfile", "")),
                "site runtime profile",
            )
        else:
            configured_profile = _contained(
                self.project_root,
                str(project.get("activeRuntimeProfile", "")),
                "active runtime profile",
            )
        self.profile_path = (
            Path(profile_path).resolve() if profile_path is not None else configured_profile
        )
        if self.profile_path != configured_profile:
            raise ValueError("profile_path must match the active runtime profile")
        self.profile = _read_json(self.profile_path, "runtime profile")
        self._validate_profile()
        storage = self.profile["storage"]
        self.source_root = _contained(
            self.project_root, storage["sourceRoot"], "BKV source root"
        )
        self.converted_root = _contained(
            self.project_root, storage["convertedRoot"], "converted root"
        )
        self.catalog_path = _contained(
            self.project_root, storage["catalogPath"], "catalog path"
        )
        self.cache_root = _contained(
            self.project_root, storage["cacheRoot"], "cache root"
        )
        try:
            self.catalog_path.relative_to(self.converted_root)
            self.cache_root.relative_to(self.converted_root)
        except ValueError as error:
            raise ValueError(
                "catalog and cache paths must remain beneath converted root"
            ) from error
        manifest_relative = str(
            storage.get("manifestPath", "bkv-runtime-manifest.json")
        ).strip()
        self.manifest_path = _contained(
            self.source_root,
            manifest_relative,
            "BKV runtime manifest",
        )
        self.interrupt_after_staged_records = interrupt_after_staged_records
        self._lock = threading.Lock()
        self._ensure_catalog()
        self._recover_replaced_records()

    def _recover_replaced_records(self) -> None:
        replaced_root = self.converted_root / "imports" / "replaced"
        if not replaced_root.exists():
            return
        for job_root in tuple(replaced_root.iterdir()):
            if job_root.name.startswith("._") or not job_root.is_dir():
                continue
            for backup in tuple(job_root.iterdir()):
                if backup.name.startswith("._") or not backup.is_dir():
                    continue
                destination = self.converted_root / "records" / backup.name
                if destination.exists():
                    _remove_tree_resilient(backup)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    _replace_directory_with_retry(backup, destination)
            _remove_tree_resilient(job_root)
        for apple_double in (self.converted_root / "imports").rglob("._*"):
            if apple_double.is_file():
                apple_double.unlink(missing_ok=True)

    def _validate_profile(self) -> None:
        if self.profile.get("schema") != PROFILE_SCHEMA:
            raise ValueError(f"runtime profile schema must be {PROFILE_SCHEMA}")
        if (
            self.profile.get("provider") != "bkv"
            or self.profile.get("dataSource") != "converted-local"
            or self.profile.get("cameraConnection") != "none"
        ):
            raise ValueError("BKV importer requires a non-direct converted-local profile")
        cameras = self.profile.get("cameras")
        expected_count = int(self.profile.get("cameraCount", 0))
        if not isinstance(cameras, list) or expected_count != 6 or len(cameras) != 6:
            raise ValueError("BKV importer requires exactly six configured cameras")
        identities = []
        for order, camera in enumerate(cameras, start=1):
            if not isinstance(camera, dict):
                raise ValueError("camera configuration must be an object")
            identity = (
                str(camera.get("id", "")),
                int(camera.get("displayOrder", 0)),
                int(camera.get("sourceCameraId", 0)),
            )
            if identity != (f"C{order}", order, order):
                raise ValueError("BKV camera mapping must be ordered C1 through C6")
            identities.append(identity)
        if len(set(identities)) != 6:
            raise ValueError("BKV camera mappings must be unique")
        storage = self.profile.get("storage")
        if not isinstance(storage, dict):
            raise ValueError("BKV profile storage is missing")
        if int(storage.get("layoutVersion", 0)) != 2:
            raise ValueError("BKV profile storage.layoutVersion must be 2")
        for field in ("sourceRoot", "convertedRoot", "catalogPath", "cacheRoot"):
            if not str(storage.get(field, "")).strip():
                raise ValueError(f"BKV profile storage.{field} is missing")

    @property
    def config_hash(self) -> str:
        digest = hashlib.sha256()
        digest.update(self.project_path.read_bytes())
        digest.update(b"\0")
        if self.site_path is not None:
            digest.update(self.site_path.read_bytes())
            digest.update(b"\0")
        digest.update(self.profile_path.read_bytes())
        return digest.hexdigest()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.catalog_path)
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    @contextmanager
    def _database(self):
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def _ensure_catalog(self) -> None:
        self.catalog_path.parent.mkdir(parents=True, exist_ok=True)
        with self._database() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS import_job (
                    id TEXT PRIMARY KEY,
                    source_hash TEXT NOT NULL,
                    config_hash TEXT NOT NULL,
                    status TEXT NOT NULL,
                    total_records INTEGER NOT NULL,
                    converted_records INTEGER NOT NULL DEFAULT 0,
                    skipped_records INTEGER NOT NULL DEFAULT 0,
                    quarantined_records INTEGER NOT NULL DEFAULT 0,
                    started_at TEXT NOT NULL,
                    completed_at TEXT,
                    failure_details TEXT NOT NULL DEFAULT '[]'
                );
                CREATE TABLE IF NOT EXISTS import_record (
                    job_id TEXT NOT NULL,
                    inspection_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    source_hash TEXT,
                    error TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (job_id, inspection_id),
                    FOREIGN KEY (job_id) REFERENCES import_job(id)
                );
                CREATE TABLE IF NOT EXISTS material_session (
                    id TEXT PRIMARY KEY,
                    material_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    started_at TEXT,
                    ended_at TEXT,
                    source TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS production_inspection (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    material_id TEXT NOT NULL,
                    inspection_time TEXT,
                    status TEXT NOT NULL,
                    defect_count INTEGER NOT NULL,
                    camera_count INTEGER NOT NULL,
                    source_hash TEXT NOT NULL,
                    record_path TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    FOREIGN KEY (session_id) REFERENCES material_session(id)
                );
                CREATE TABLE IF NOT EXISTS production_defect (
                    id TEXT PRIMARY KEY,
                    inspection_id TEXT NOT NULL,
                    camera_id TEXT NOT NULL,
                    sequence_no INTEGER NOT NULL,
                    defect_type TEXT NOT NULL,
                    severity INTEGER,
                    confidence REAL,
                    artifacts_json TEXT NOT NULL,
                    FOREIGN KEY (inspection_id) REFERENCES production_inspection(id)
                );
                CREATE TABLE IF NOT EXISTS capture_file (
                    id TEXT PRIMARY KEY,
                    inspection_id TEXT NOT NULL,
                    camera_id TEXT NOT NULL,
                    sequence_no INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    path TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    sha256 TEXT NOT NULL,
                    FOREIGN KEY (inspection_id) REFERENCES production_inspection(id)
                );
                CREATE INDEX IF NOT EXISTS capture_file_inspection_idx
                    ON capture_file(inspection_id, camera_id, sequence_no, kind);
                CREATE INDEX IF NOT EXISTS production_defect_inspection_idx
                    ON production_defect(inspection_id);
                """
            )

    def _load_manifest(self) -> tuple[dict[str, Any], str]:
        manifest = load_verified_runtime_manifest(
            self.manifest_path, expected_cameras=6
        )
        return manifest, _sha256_file(self.manifest_path)

    def run_once(self) -> ImportResult:
        with self._lock:
            manifest, source_hash = self._load_manifest()
            job_id = uuid.uuid4().hex
            now = _utc_now()
            with self._database() as connection:
                connection.execute(
                    """
                    INSERT INTO import_job (
                        id, source_hash, config_hash, status, total_records, started_at
                    ) VALUES (?, ?, ?, 'running', ?, ?)
                    """,
                    (
                        job_id,
                        source_hash,
                        self.config_hash,
                        len(manifest["materials"]),
                        now,
                    ),
                )
            return self._run_job(job_id, manifest)

    def retry_failed(self, job_id: str) -> ImportResult:
        with self._lock:
            manifest, source_hash = self._load_manifest()
            with self._database() as connection:
                row = connection.execute(
                    "SELECT status, source_hash, config_hash FROM import_job WHERE id = ?",
                    (job_id,),
                ).fetchone()
                if row is None:
                    raise ValueError(f"unknown import job: {job_id}")
                if row[0] not in ("interrupted", "failed", "completed_with_errors"):
                    raise ValueError(f"import job is not retryable: {row[0]}")
                if row[1] != source_hash or row[2] != self.config_hash:
                    raise ValueError("source or configuration changed; start a new import job")
                connection.execute("DELETE FROM import_record WHERE job_id = ?", (job_id,))
                connection.execute(
                    """
                    UPDATE import_job
                    SET status = 'running', converted_records = 0, skipped_records = 0,
                        quarantined_records = 0, started_at = ?, completed_at = NULL,
                        failure_details = '[]'
                    WHERE id = ?
                    """,
                    (_utc_now(), job_id),
                )
            return self._run_job(job_id, manifest, ignore_interrupt_hook=True)

    def _run_job(
        self,
        job_id: str,
        manifest: dict[str, Any],
        *,
        ignore_interrupt_hook: bool = False,
    ) -> ImportResult:
        converted = 0
        skipped = 0
        quarantined = 0
        failures: list[dict[str, str]] = []
        staged = 0
        try:
            for material in manifest["materials"]:
                inspection_id = str(material.get("legacySeqNo", "unknown"))
                try:
                    validated = self._validate_material(material)
                    record_hash = _sha256_bytes(
                        _canonical_json(
                            {
                                "configHash": self.config_hash,
                                "material": material,
                            }
                        )
                    )
                    if self._is_current_record(inspection_id, record_hash):
                        skipped += 1
                        self._write_import_record(
                            job_id, inspection_id, "skipped", record_hash, None
                        )
                        continue
                    stage = self._stage_record(
                        job_id, inspection_id, material, validated, record_hash
                    )
                    staged += 1
                    if (
                        not ignore_interrupt_hook
                        and self.interrupt_after_staged_records is not None
                        and staged >= self.interrupt_after_staged_records
                    ):
                        raise ImportInterrupted(
                            f"forced interruption after staging {staged} record(s)"
                        )
                    self._publish_record(
                        job_id, inspection_id, material, validated, record_hash, stage
                    )
                    converted += 1
                except ImportInterrupted:
                    raise
                except Exception as error:  # quarantine is an explicit record boundary
                    quarantined += 1
                    detail = {
                        "inspectionId": inspection_id,
                        "error": str(error),
                    }
                    failures.append(detail)
                    self._quarantine(job_id, inspection_id, detail)
                    self._write_import_record(
                        job_id, inspection_id, "quarantined", None, str(error)
                    )
        except ImportInterrupted as error:
            self._finish_job(
                job_id,
                "interrupted",
                converted,
                skipped,
                quarantined,
                failures + [{"error": str(error)}],
            )
            raise
        except Exception as error:
            self._finish_job(
                job_id,
                "failed",
                converted,
                skipped,
                quarantined,
                failures + [{"error": str(error)}],
            )
            raise

        status = "completed_with_errors" if quarantined else "completed"
        self._finish_job(
            job_id, status, converted, skipped, quarantined, failures
        )
        return ImportResult(
            job_id=job_id,
            status=status,
            total_records=len(manifest["materials"]),
            converted_records=converted,
            skipped_records=skipped,
            quarantined_records=quarantined,
        )

    def _validate_material(self, material: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(material, dict):
            raise ValueError("material must be an object")
        inspection_id = str(material.get("legacySeqNo", "")).strip()
        if not inspection_id or not inspection_id.isdigit():
            raise ValueError("material legacySeqNo is invalid")
        cameras = material.get("cameras")
        if not isinstance(cameras, list):
            raise ValueError("material cameras must be an array")
        by_source: dict[int, dict[str, Any]] = {}
        for camera in cameras:
            camera_id = int(camera.get("cameraId", 0))
            if camera_id not in range(1, 7):
                raise ValueError(f"unknown camera {camera_id}; configured cameras are C1-C6")
            if camera_id in by_source:
                raise ValueError(f"duplicate camera {camera_id}")
            by_source[camera_id] = camera
        if set(by_source) != set(range(1, 7)):
            raise ValueError("camera coverage must contain exactly C1-C6")

        frames: dict[int, list[tuple[int, dict[str, Any], dict[str, Any]]]] = {}
        for camera_id in range(1, 7):
            camera = by_source[camera_id]
            intensity = camera.get("twoDFrames")
            depth = camera.get("npzFrames")
            if not isinstance(intensity, list) or not isinstance(depth, list):
                raise ValueError(f"camera C{camera_id} frame lists are invalid")
            intensity_by_sequence = {
                int(frame.get("frameNo", -1)): frame for frame in intensity
            }
            depth_by_sequence = {int(frame.get("frameNo", -1)): frame for frame in depth}
            if (
                not intensity_by_sequence
                or len(intensity_by_sequence) != len(intensity)
                or len(depth_by_sequence) != len(depth)
                or set(intensity_by_sequence) != set(depth_by_sequence)
            ):
                raise ValueError(f"camera C{camera_id} frame coverage mismatch")
            pairs = []
            for sequence in sorted(intensity_by_sequence):
                if sequence < 0:
                    raise ValueError(f"camera C{camera_id} frame number is invalid")
                image = self._verified_source_artifact(
                    intensity_by_sequence[sequence], f"C{camera_id} intensity frame"
                )
                npz = self._verified_source_artifact(
                    depth_by_sequence[sequence], f"C{camera_id} depth frame"
                )
                validate_artifact_identity(
                    npz["sourcePath"],
                    expected_camera_id=camera_id,
                    expected_legacy_seq_no=int(inspection_id),
                    expected_frame_no=sequence,
                )
                pairs.append((sequence, image, npz))
            frames[camera_id] = pairs

        defects = material.get("defects", [])
        if not isinstance(defects, list):
            raise ValueError("material defects must be an array")
        sequence_sets = {
            camera_id: {entry[0] for entry in entries}
            for camera_id, entries in frames.items()
        }
        for defect in defects:
            camera_id = int(defect.get("cameraId", 0))
            sequence = int(defect.get("imageIndex", -1))
            if camera_id not in sequence_sets:
                raise ValueError(f"defect references unknown camera {camera_id}")
            if sequence not in sequence_sets[camera_id]:
                raise ValueError(
                    f"defect references missing frame C{camera_id}/{sequence}"
                )
        return {"frames": frames, "defects": defects}

    def _verified_source_artifact(
        self, artifact: dict[str, Any], label: str
    ) -> dict[str, Any]:
        if not isinstance(artifact, dict):
            raise ValueError(f"{label} metadata is invalid")
        path = _contained(self.source_root, str(artifact.get("path", "")), label)
        if not path.is_file():
            raise ValueError(f"missing {label}: {path}")
        actual_size = path.stat().st_size
        declared_size = int(artifact.get("size", -1))
        if actual_size != declared_size:
            raise ValueError(f"{label} size mismatch")
        actual_hash = _sha256_file(path)
        if actual_hash != str(artifact.get("sha256", "")):
            raise ValueError(f"{label} hash mismatch")
        return {
            "sourcePath": path,
            "sourceRelativePath": path.relative_to(self.source_root).as_posix(),
            "size": actual_size,
            "sha256": actual_hash,
        }

    def _is_current_record(self, inspection_id: str, record_hash: str) -> bool:
        with self._database() as connection:
            row = connection.execute(
                "SELECT source_hash, record_path FROM production_inspection WHERE id = ?",
                (inspection_id,),
            ).fetchone()
        if row is None or row[0] != record_hash:
            return False
        record_path = _contained(self.converted_root, row[1], "record path")
        record_file = record_path / "record.json"
        if not record_file.is_file():
            return False
        record = _read_json(record_file, "standard record")
        return record.get("schema") == STANDARD_RECORD_SCHEMA

    @staticmethod
    def _write_depth_v2(source: Path, target: Path) -> dict[str, Any]:
        with np.load(source, allow_pickle=False) as payload:
            if "depth" not in payload.files:
                raise ValueError(f"depth NPZ has no depth matrix: {source}")
            depth = np.asarray(payload["depth"], dtype=np.float32)
            if depth.ndim != 2 or not depth.size:
                raise ValueError(f"depth NPZ matrix is invalid: {source}")
            if "valid_mask" in payload.files:
                valid_mask = np.asarray(payload["valid_mask"], dtype=np.bool_)
                if valid_mask.shape != depth.shape:
                    raise ValueError(f"depth NPZ mask shape mismatch: {source}")
            else:
                valid_mask = np.isfinite(depth) & (depth > -999_999.0)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("wb") as stream:
                np.savez_compressed(
                    stream,
                    depth=depth,
                    valid_mask=valid_mask,
                )
            with np.load(temporary, allow_pickle=False) as verified:
                if set(verified.files) != {"depth", "valid_mask"}:
                    raise ValueError("standard depth NPZ contains unexpected arrays")
                if (
                    verified["depth"].dtype != np.dtype("float32")
                    or verified["depth"].shape != depth.shape
                    or verified["valid_mask"].shape != depth.shape
                ):
                    raise ValueError("standard depth NPZ verification failed")
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return {
            "size": target.stat().st_size,
            "sha256": _sha256_file(target),
        }

    @staticmethod
    def _detect_head_offset(images: list[Image.Image]) -> int:
        background_rows = 32
        sample_step = 4
        stable_rows = 8
        stable: list[float] = []
        for frame_index, source in enumerate(images):
            image = source.convert("L")
            background = [
                image.getpixel((x, y))
                for y in range(min(background_rows, image.height))
                for x in range(0, image.width, sample_step)
            ]
            background.sort()
            baseline = background[(len(background) - 1) // 20] if background else 0
            threshold = max(35, min(255, baseline + 18))
            for y in range(image.height):
                samples = [
                    image.getpixel((x, y)) > threshold
                    for x in range(0, image.width, sample_step)
                ]
                occupancy = sum(samples) / max(1, len(samples))
                if occupancy >= 0.12:
                    stable.append(occupancy)
                    stable = stable[-stable_rows:]
                    if len(stable) == stable_rows:
                        return frame_index * image.height + y + 1 - stable_rows
                else:
                    stable.clear()
        return 0

    def _stage_tile_cache(
        self,
        *,
        job_id: str,
        inspection_id: str,
        record_hash: str,
        intensity_paths: dict[int, list[Path]],
    ) -> Path:
        cache_stage = (
            self.converted_root
            / "imports"
            / ".staging"
            / job_id
            / ".cache"
            / inspection_id
            / record_hash
        )
        if cache_stage.exists():
            shutil.rmtree(cache_stage)
        cache_stage.mkdir(parents=True)

        camera_sources: dict[int, tuple[list[Image.Image], int, int, int]] = {}
        world_width = 0
        world_height = 0
        try:
            for camera_id, paths in sorted(intensity_paths.items()):
                images = [Image.open(path).convert("L") for path in paths]
                if not images:
                    raise ValueError(f"camera C{camera_id} has no intensity images")
                dimensions = {(image.width, image.height) for image in images}
                if len(dimensions) != 1:
                    raise ValueError(f"camera C{camera_id} intensity dimensions differ")
                width, frame_height = next(iter(dimensions))
                head_offset = self._detect_head_offset(images)
                height = frame_height * len(images) - head_offset
                if height <= 0:
                    raise ValueError(f"camera C{camera_id} aligned height is invalid")
                camera_sources[camera_id] = (images, width, height, head_offset)
                world_width += width
                world_height = max(world_height, height)

            longest_side = max(world_width, world_height)
            max_level = 0
            while longest_side > 1:
                longest_side = (longest_side + 1) // 2
                max_level += 1

            camera_meta = []
            expected_tiles = 0
            actual_tiles = 0
            for camera_id, (images, width, height, head_offset) in camera_sources.items():
                frame_height = images[0].height
                mosaic = Image.new("L", (width, frame_height * len(images)))
                for frame_index, image in enumerate(images):
                    mosaic.paste(image, (0, frame_index * frame_height))
                current = mosaic.crop((0, head_offset, width, head_offset + height))
                camera_count = 0
                for level in range(max_level + 1):
                    if level > 0:
                        current = current.resize(
                            (
                                max(1, (current.width + 1) // 2),
                                max(1, (current.height + 1) // 2),
                            ),
                            Image.Resampling.NEAREST,
                        )
                    tiles_x = max(1, (current.width + TILE_SIZE - 1) // TILE_SIZE)
                    tiles_y = max(1, (current.height + TILE_SIZE - 1) // TILE_SIZE)
                    expected_tiles += tiles_x * tiles_y
                    level_root = cache_stage / "tile" / f"C{camera_id}" / f"L{level}"
                    level_root.mkdir(parents=True, exist_ok=True)
                    for tile_x in range(tiles_x):
                        for tile_y in range(tiles_y):
                            left = tile_x * TILE_SIZE
                            top = tile_y * TILE_SIZE
                            tile = current.crop(
                                (
                                    left,
                                    top,
                                    min(left + TILE_SIZE, current.width),
                                    min(top + TILE_SIZE, current.height),
                                )
                            )
                            tile.save(
                                level_root / f"{tile_x}_{tile_y}.jpg",
                                format="JPEG",
                                quality=88,
                                optimize=False,
                            )
                            actual_tiles += 1
                            camera_count += 1
                camera_meta.append(
                    {
                        "cameraId": camera_id,
                        "width": width,
                        "height": height,
                        "headOffsetY": head_offset,
                        "tileCount": camera_count,
                    }
                )
        finally:
            for images, _, _, _ in camera_sources.values():
                for image in images:
                    image.close()

        _atomic_json(
            cache_stage / "cache.json",
            {
                "schema": TILE_CACHE_SCHEMA,
                "recordId": inspection_id,
                "sourceHash": record_hash,
                "state": "complete",
                "complete": True,
                "tile": {
                    "tileSize": TILE_SIZE,
                    "format": "jpeg",
                    "maxLevel": max_level,
                    "expectedCount": expected_tiles,
                    "actualCount": actual_tiles,
                },
                "world": {
                    "width": world_width,
                    "height": world_height,
                    "cameras": camera_meta,
                },
                "completedAt": _utc_now(),
            },
        )
        return cache_stage

    def _stage_record(
        self,
        job_id: str,
        inspection_id: str,
        material: dict[str, Any],
        validated: dict[str, Any],
        record_hash: str,
    ) -> Path:
        stage = (
            self.converted_root
            / "imports"
            / ".staging"
            / job_id
            / inspection_id
        )
        if stage.exists():
            shutil.rmtree(stage)
        stage.mkdir(parents=True)
        capture_files = []
        intensity_paths: dict[int, list[Path]] = {}
        for camera_id, entries in validated["frames"].items():
            for sequence, image, depth in entries:
                camera_root = stage / "cameras" / f"C{camera_id}"
                intensity_target = camera_root / "intensity" / f"{sequence:06d}.jpg"
                depth_target = camera_root / "depth" / f"{sequence:06d}.npz"
                intensity_target.parent.mkdir(parents=True, exist_ok=True)
                depth_target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(image["sourcePath"], intensity_target)
                if (
                    intensity_target.stat().st_size != image["size"]
                    or _sha256_file(intensity_target) != image["sha256"]
                ):
                    raise ValueError(
                        f"staged C{camera_id}/{sequence}/intensity verification failed"
                    )
                depth_result = self._write_depth_v2(depth["sourcePath"], depth_target)
                intensity_paths.setdefault(camera_id, []).append(intensity_target)
                for kind, target, source, stored in (
                    (
                        "intensity",
                        intensity_target,
                        image,
                        {"size": image["size"], "sha256": image["sha256"]},
                    ),
                    ("depth", depth_target, depth, depth_result),
                ):
                    capture_files.append(
                        {
                            "cameraId": f"C{camera_id}",
                            "sequenceNo": sequence,
                            "kind": kind,
                            "path": target.relative_to(stage).as_posix(),
                            "size": stored["size"],
                            "sha256": stored["sha256"],
                            "sourcePath": source["sourceRelativePath"],
                            "sourceSize": source["size"],
                            "sourceSha256": source["sha256"],
                        }
                    )
        normalized_defects = [
            {
                "id": f"{inspection_id}-{defect.get('legacyDefectId', index)}",
                "inspectionId": inspection_id,
                "cameraId": f"C{int(defect['cameraId'])}",
                "sequenceNo": int(defect["imageIndex"]),
                "defectType": str(defect.get("className", "")),
                "severity": _severity_grade(defect.get("grade")),
                "confidence": defect.get("confidence"),
                "artifacts": defect,
            }
            for index, defect in enumerate(validated["defects"], start=1)
        ]
        record = {
            "schema": STANDARD_RECORD_SCHEMA,
            "inspectionId": inspection_id,
            "sessionId": f"bkv-{inspection_id}",
            "materialId": str(material.get("steelId") or inspection_id),
            "source": "bkv-converter",
            "sourceRecordId": inspection_id,
            "inspectionTime": material.get("inspectionTime"),
            "status": "legacy-imported",
            "cameraCount": 6,
            "cameras": [f"C{camera}" for camera in range(1, 7)],
            "defectCount": len(normalized_defects),
            "material": {
                "steelType": material.get("steelType"),
                "lengthMm": material.get("lengthMm"),
                "outerDiameterLegacyValue": material.get(
                    "outerDiameterLegacyValue"
                ),
                "wallThicknessMm": material.get("wallThicknessMm"),
            },
            "captureFiles": [
                {
                    key: value
                    for key, value in item.items()
                    if key not in {"sourcePath", "sourceSize", "sourceSha256"}
                }
                for item in capture_files
            ],
            "defectsPath": "defects/defects.json",
            "sourceHash": record_hash,
            "configHash": self.config_hash,
        }
        _atomic_json(stage / "record.json", record)
        _atomic_json(
            stage / "source-provenance.json",
            {
                "schema": "steel.source-provenance.v1",
                "provider": "bkv",
                "sourceManifest": self.manifest_path.name,
                "sourceRecordId": inspection_id,
                "sourceHash": record_hash,
                "configHash": self.config_hash,
                "files": [
                    {
                        "cameraId": item["cameraId"],
                        "sequenceNo": item["sequenceNo"],
                        "kind": item["kind"],
                        "sourcePath": item["sourcePath"],
                        "sourceSize": item["sourceSize"],
                        "sourceSha256": item["sourceSha256"],
                        "storedSize": item["size"],
                        "storedSha256": item["sha256"],
                    }
                    for item in capture_files
                ],
            },
        )
        _atomic_json(
            stage / "defects" / "defects.json",
            {
                "schema": "steel.standard-defects.v1",
                "inspectionId": inspection_id,
                "defects": normalized_defects,
            },
        )
        self._stage_tile_cache(
            job_id=job_id,
            inspection_id=inspection_id,
            record_hash=record_hash,
            intensity_paths=intensity_paths,
        )
        return stage

    def _publish_record(
        self,
        job_id: str,
        inspection_id: str,
        material: dict[str, Any],
        validated: dict[str, Any],
        record_hash: str,
        stage: Path,
    ) -> None:
        destination = self.converted_root / "records" / inspection_id
        destination.parent.mkdir(parents=True, exist_ok=True)
        staged_cache = (
            self.converted_root
            / "imports"
            / ".staging"
            / job_id
            / ".cache"
            / inspection_id
            / record_hash
        )
        cache_record_root = (
            self.cache_root / "inspection-world-v2" / inspection_id
        )
        cache_destination = cache_record_root / record_hash
        if not (staged_cache / "cache.json").is_file():
            raise ValueError("staged inspection-world cache is incomplete")
        replaced_destination: Path | None = None
        published_cache = False
        if destination.exists():
            provenance = _read_json(
                destination / "source-provenance.json", "published provenance"
            )
            published_record = _read_json(
                destination / "record.json", "published standard record"
            )
            if (
                provenance.get("sourceHash") == record_hash
                and published_record.get("schema") == STANDARD_RECORD_SCHEMA
            ):
                shutil.rmtree(stage)
            else:
                replaced_destination = (
                    self.converted_root
                    / "imports"
                    / "replaced"
                    / job_id
                    / inspection_id
                )
                replaced_destination.parent.mkdir(parents=True, exist_ok=True)
                _replace_directory_with_retry(destination, replaced_destination)
                _replace_directory_with_retry(stage, destination)
        else:
            _replace_directory_with_retry(stage, destination)

        cache_destination.parent.mkdir(parents=True, exist_ok=True)
        if cache_destination.exists():
            shutil.rmtree(cache_destination)
        _replace_directory_with_retry(staged_cache, cache_destination)
        published_cache = True

        record = _read_json(destination / "record.json", "standard record")
        if record.get("schema") != STANDARD_RECORD_SCHEMA:
            raise ValueError(
                f"published record schema must be {STANDARD_RECORD_SCHEMA}"
            )
        defects = _read_json(
            destination / "defects" / "defects.json", "standard defects"
        )["defects"]
        record_relative = destination.relative_to(self.converted_root).as_posix()
        session_id = record["sessionId"]
        try:
            with self._database() as connection:
                connection.execute(
                    """
                    INSERT INTO material_session
                        (id, material_id, status, started_at, ended_at, source)
                    VALUES (?, ?, 'completed', ?, ?, 'bkv-converter')
                    ON CONFLICT(id) DO UPDATE SET
                        material_id = excluded.material_id,
                        status = excluded.status,
                        started_at = excluded.started_at,
                        ended_at = excluded.ended_at,
                        source = excluded.source
                    """,
                    (
                        session_id,
                        record["materialId"],
                        record.get("inspectionTime"),
                        record.get("inspectionTime"),
                    ),
                )
                connection.execute(
                    "DELETE FROM capture_file WHERE inspection_id = ?",
                    (inspection_id,),
                )
                connection.execute(
                    "DELETE FROM production_defect WHERE inspection_id = ?",
                    (inspection_id,),
                )
                connection.execute(
                    """
                    INSERT INTO production_inspection (
                        id, session_id, material_id, inspection_time, status,
                        defect_count, camera_count, source_hash, record_path,
                        metadata_json
                    ) VALUES (?, ?, ?, ?, ?, ?, 6, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        session_id = excluded.session_id,
                        material_id = excluded.material_id,
                        inspection_time = excluded.inspection_time,
                        status = excluded.status,
                        defect_count = excluded.defect_count,
                        camera_count = excluded.camera_count,
                        source_hash = excluded.source_hash,
                        record_path = excluded.record_path,
                        metadata_json = excluded.metadata_json
                    """,
                    (
                        inspection_id,
                        session_id,
                        record["materialId"],
                        record.get("inspectionTime"),
                        record["status"],
                        len(defects),
                        record_hash,
                        record_relative,
                        json.dumps(record["material"], ensure_ascii=False),
                    ),
                )
                for capture in record["captureFiles"]:
                    connection.execute(
                        """
                        INSERT INTO capture_file (
                            id, inspection_id, camera_id, sequence_no, kind,
                            path, size, sha256
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            f"{inspection_id}-{capture['cameraId']}-"
                            f"{int(capture['sequenceNo']):06d}-{capture['kind']}",
                            inspection_id,
                            capture["cameraId"],
                            capture["sequenceNo"],
                            capture["kind"],
                            f"{record_relative}/{capture['path']}",
                            capture["size"],
                            capture["sha256"],
                        ),
                    )
                for defect in defects:
                    connection.execute(
                        """
                        INSERT INTO production_defect (
                            id, inspection_id, camera_id, sequence_no,
                            defect_type, severity, confidence, artifacts_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            defect["id"],
                            inspection_id,
                            defect["cameraId"],
                            defect["sequenceNo"],
                            defect["defectType"],
                            defect.get("severity"),
                            defect.get("confidence"),
                            json.dumps(defect.get("artifacts", {}), ensure_ascii=False),
                        ),
                    )
                connection.execute(
                    """
                    INSERT OR REPLACE INTO import_record (
                        job_id, inspection_id, status, source_hash, error, updated_at
                    ) VALUES (?, ?, 'converted', ?, NULL, ?)
                    """,
                    (job_id, inspection_id, record_hash, _utc_now()),
                )
        except Exception:
            if published_cache and cache_destination.exists():
                _remove_tree_resilient(cache_destination)
            if destination.exists():
                _remove_tree_resilient(destination)
            if replaced_destination is not None and replaced_destination.exists():
                _replace_directory_with_retry(replaced_destination, destination)
            raise
        if replaced_destination is not None and replaced_destination.exists():
            _remove_tree_resilient(replaced_destination)
        if cache_record_root.exists():
            for candidate in cache_record_root.iterdir():
                if candidate != cache_destination and candidate.is_dir():
                    _remove_tree_resilient(candidate)
        staging_job = self.converted_root / "imports" / ".staging" / job_id
        for apple_double in destination.rglob("._*"):
            if apple_double.is_file():
                apple_double.unlink()
        if staging_job.exists():
            for empty in sorted(
                (path for path in staging_job.rglob("*") if path.is_dir()),
                key=lambda path: len(path.parts),
                reverse=True,
            ):
                try:
                    empty.rmdir()
                except OSError:
                    pass

    def _write_import_record(
        self,
        job_id: str,
        inspection_id: str,
        status: str,
        source_hash: str | None,
        error: str | None,
    ) -> None:
        with self._database() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO import_record (
                    job_id, inspection_id, status, source_hash, error, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (job_id, inspection_id, status, source_hash, error, _utc_now()),
            )

    def _quarantine(
        self, job_id: str, inspection_id: str, detail: dict[str, str]
    ) -> None:
        safe_id = "".join(
            character if character.isalnum() or character in "-_" else "_"
            for character in inspection_id
        )
        _atomic_json(
            self.converted_root
            / "imports"
            / "quarantine"
            / f"{job_id}-{safe_id}.json",
            {
                "schema": "steel.bkv-import-quarantine.v1",
                "jobId": job_id,
                "inspectionId": inspection_id,
                "createdAt": _utc_now(),
                **detail,
            },
        )

    def _finish_job(
        self,
        job_id: str,
        status: str,
        converted: int,
        skipped: int,
        quarantined: int,
        failures: list[dict[str, str]],
    ) -> None:
        with self._database() as connection:
            connection.execute(
                """
                UPDATE import_job
                SET status = ?, converted_records = ?, skipped_records = ?,
                    quarantined_records = ?, completed_at = ?,
                    failure_details = ?
                WHERE id = ?
                """,
                (
                    status,
                    converted,
                    skipped,
                    quarantined,
                    _utc_now(),
                    json.dumps(failures, ensure_ascii=False),
                    job_id,
                ),
            )

    def status(self) -> dict[str, Any]:
        with self._database() as connection:
            row = connection.execute(
                """
                SELECT id, source_hash, config_hash, status, total_records,
                       converted_records, skipped_records, quarantined_records,
                       started_at, completed_at, failure_details
                FROM import_job ORDER BY rowid DESC LIMIT 1
                """
            ).fetchone()
        latest = None
        if row is not None:
            latest = {
                "id": row[0],
                "sourceHash": row[1],
                "configHash": row[2],
                "status": row[3],
                "totalRecords": row[4],
                "convertedRecords": row[5],
                "skippedRecords": row[6],
                "quarantinedRecords": row[7],
                "startedAt": row[8],
                "completedAt": row[9],
                "failureDetails": json.loads(row[10]),
            }
        return {
            "schema": PUBLIC_SERVICE_SCHEMA,
            "ready": self.manifest_path.is_file(),
            "profileId": self.profile["id"],
            "cameraCount": 6,
            "latestJob": latest,
        }


class _ImportRequestHandler(BaseHTTPRequestHandler):
    service: BkvImportService

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(200, {"ok": True, **self.service.status()})
        elif self.path == "/status":
            self._json(200, self.service.status())
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        try:
            if self.path == "/start":
                self._json(200, asdict(self.service.run_once()))
                return
            if self.path.startswith("/retry/"):
                job_id = self.path.removeprefix("/retry/")
                self._json(200, asdict(self.service.retry_failed(job_id)))
                return
            self._json(404, {"error": "not_found"})
        except ImportInterrupted as error:
            self._json(409, {"error": "import_interrupted", "message": str(error)})
        except (OSError, ValueError) as error:
            self._json(400, {"error": "import_failed", "message": str(error)})

    def log_message(self, format: str, *args: object) -> None:
        return


def _serve(service: BkvImportService, host: str, port: int) -> None:
    handler = type(
        "BoundImportRequestHandler",
        (_ImportRequestHandler,),
        {"service": service},
    )
    with ThreadingHTTPServer((host, port), handler) as server:
        server.serve_forever()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path("config/project.json"))
    parser.add_argument("--profile", type=Path)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--once", action="store_true")
    action.add_argument("--status", action="store_true")
    action.add_argument("--retry", metavar="JOB_ID")
    action.add_argument("--serve", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4893)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    service = BkvImportService(
        project_path=args.project,
        profile_path=args.profile,
    )
    if args.once:
        print(json.dumps(asdict(service.run_once()), ensure_ascii=False))
    elif args.status:
        print(json.dumps(service.status(), ensure_ascii=False))
    elif args.retry:
        print(json.dumps(asdict(service.retry_failed(args.retry)), ensure_ascii=False))
    else:
        _serve(service, args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
