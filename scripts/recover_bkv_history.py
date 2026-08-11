#!/usr/bin/env python3
"""Recover historical BKV algorithm runs into standard-record.v2 inputs.

The online BKV worker wrote ``inspection-world-v1`` directories before the
split runtime was introduced.  Those directories contain the MySQL snapshot,
defects, alignment metadata and the algorithm revision, but they are not
visible to the unified-result catalog.  This utility converts that durable
metadata into ``steel.standard-record.v2`` records for the algorithm service.

The default operation is deliberately metadata-only: it never copies or
rewrites BKV image files.  The original six camera roots are recorded in the
source-provenance document and can be materialized later by an explicit,
bounded recovery job.  This keeps an inventory/recovery run safe on a source
share that may contain hundreds of gigabytes of historical frames.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import tempfile
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


STANDARD_RECORD_SCHEMA = "steel.standard-record.v2"
PROVENANCE_SCHEMA = "steel.source-provenance.v1"
CAMERA_COUNT = 6
_DIGITS = re.compile(r"(\d+)$")


@dataclass(frozen=True)
class Candidate:
    canonical_id: str
    run_dir: Path
    manifest: dict[str, Any]
    source: dict[str, Any]
    numeric_directory: bool
    modified_ns: int

    @property
    def rank(self) -> tuple[int, int]:
        # A numeric run is the canonical output of the online processor.  The
        # bkv-<seq> directories are older compatibility snapshots and are only
        # selected when no numeric run exists for the same sequence.
        return (1 if self.numeric_directory else 0, self.modified_ns)


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON root is not an object: {path}")
    return value


def _text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _number(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _trailing_digits(value: Any) -> str | None:
    match = _DIGITS.search(_text(value) or "")
    return match.group(1) if match else None


def _inspection_object(source: dict[str, Any]) -> dict[str, Any]:
    value = source.get("inspection")
    return value if isinstance(value, dict) else {}


def _canonical_id(run_dir: Path, manifest: dict[str, Any], source: dict[str, Any]) -> str | None:
    for value in (
        source.get("legacySeqNo"),
        _inspection_object(source).get("legacySeqNo"),
        _inspection_object(source).get("inspectionId"),
        manifest.get("legacySeqNo"),
        manifest.get("recordId"),
        source.get("recordId"),
        run_dir.name,
    ):
        digits = _trailing_digits(value)
        if digits:
            return digits
    return None


def _source_hash(manifest_path: Path, manifest: dict[str, Any], source_path: Path) -> str:
    revision = _text(manifest.get("revision"))
    if revision and re.fullmatch(r"[0-9a-fA-F]{64}", revision):
        return revision.lower()
    digest = hashlib.sha256()
    digest.update(manifest_path.read_bytes())
    digest.update(b"\n")
    digest.update(source_path.read_bytes())
    return digest.hexdigest()


def _camera_id(value: Any) -> str:
    digits = _trailing_digits(value)
    if digits and 1 <= int(digits) <= CAMERA_COUNT:
        return f"C{int(digits)}"
    return "C1"


def _severity(value: Any) -> int | None:
    number = _number(value)
    if number is not None:
        return number
    text = (_text(value) or "").lower()
    if text in {"critical", "severe", "严重"}:
        return 3
    if text in {"warning", "moderate", "review", "中等"}:
        return 2
    if text in {"minor", "low", "轻微"}:
        return 1
    return None


def _defects(source: dict[str, Any], inspection_id: str) -> list[dict[str, Any]]:
    inspection = _inspection_object(source)
    values = inspection.get("defects")
    if not isinstance(values, list):
        return []
    defects: list[dict[str, Any]] = []
    for index, value in enumerate(values, start=1):
        if not isinstance(value, dict):
            continue
        camera_id = _camera_id(value.get("cameraId") or value.get("cameraIndex"))
        sequence = _number(value.get("imageIndex"))
        if sequence is None:
            artifacts = value.get("artifacts")
            if isinstance(artifacts, dict):
                sequence = _number(artifacts.get("sequenceNo"))
        defects.append(
            {
                "id": _text(value.get("id")) or f"{inspection_id}-defect-{index}",
                "inspectionId": inspection_id,
                "cameraId": camera_id,
                "sequenceNo": max(0, sequence or 0),
                "defectType": (
                    _text(value.get("typeLabel"))
                    or _text(value.get("typeId"))
                    or _text(value.get("className"))
                    or "unknown"
                ),
                "severity": _severity(value.get("severity") or value.get("grade")),
                "confidence": _float(
                    value.get("confidence")
                    if value.get("confidence") is not None
                    else value.get("detectionConfidence")
                ),
                "artifacts": value.get("artifacts", value),
            }
        )
    return defects


def _material(source: dict[str, Any], inspection_id: str) -> tuple[str, dict[str, Any], str | None]:
    inspection = _inspection_object(source)
    plate = inspection.get("plate")
    plate = plate if isinstance(plate, dict) else {}
    material_id = (
        _text(plate.get("plateNo"))
        or _text(source.get("materialId"))
        or inspection_id
    )
    material = {
        "steelType": _text(plate.get("steelGrade")) or _text(plate.get("steelType")),
        "lengthMm": _float(plate.get("lengthMm")),
        "outerDiameterLegacyValue": _float(plate.get("widthMm")),
        "wallThicknessMm": _float(plate.get("thicknessMm")),
    }
    return material_id, material, _text(plate.get("detectedAt"))


def _camera_metadata(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    cameras = manifest.get("cameras")
    if not isinstance(cameras, list):
        cameras = []
    output: list[dict[str, Any]] = []
    for index, camera in enumerate(cameras, start=1):
        if not isinstance(camera, dict):
            continue
        camera_id = _number(camera.get("cameraId")) or index
        output.append(
            {
                "cameraId": f"C{camera_id}",
                "sourceCameraId": camera_id,
                "sourceDirectory": _text(camera.get("sourceDirectory")),
                "frameCount": _number(camera.get("frameCount")) or 0,
                "firstFrame": _number(camera.get("firstFrame")),
                "lastFrame": _number(camera.get("lastFrame")),
                "width": _number(camera.get("width")),
                "height": _number(camera.get("height")),
            }
        )
    # Keep the protocol topology stable even for a partial legacy manifest.
    by_id = {item["sourceCameraId"]: item for item in output}
    return [
        by_id.get(camera, {"cameraId": f"C{camera}", "sourceCameraId": camera, "frameCount": 0})
        for camera in range(1, CAMERA_COUNT + 1)
    ]


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary_name, path)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def _candidate(run_dir: Path) -> Candidate:
    world = run_dir / "inspection-world-v1"
    manifest_path = world / "manifest.json"
    source_path = world / "source-record.json"
    manifest = _read_json(manifest_path)
    source = _read_json(source_path)
    canonical_id = _canonical_id(run_dir, manifest, source)
    if canonical_id is None:
        raise ValueError("legacy sequence is missing")
    return Candidate(
        canonical_id=canonical_id,
        run_dir=run_dir,
        manifest=manifest,
        source=source,
        numeric_directory=run_dir.name.isdigit(),
        modified_ns=manifest_path.stat().st_mtime_ns,
    )


def _iter_candidates(runs_root: Path) -> Iterable[tuple[Path, Candidate | None, str | None]]:
    with os.scandir(runs_root) as entries:
        for entry in entries:
            if not entry.is_dir():
                continue
            run_dir = Path(entry.path)
            world = run_dir / "inspection-world-v1"
            manifest = world / "manifest.json"
            source = world / "source-record.json"
            if not manifest.is_file() or not source.is_file():
                yield run_dir, None, "missing manifest or source-record.json"
                continue
            try:
                yield run_dir, _candidate(run_dir), None
            except (OSError, ValueError, json.JSONDecodeError) as error:
                yield run_dir, None, str(error)


def _record(candidate: Candidate) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    inspection_id = candidate.canonical_id
    material_id, material, inspection_time = _material(candidate.source, inspection_id)
    defects = _defects(candidate.source, inspection_id)
    inspection = _inspection_object(candidate.source)
    legacy_record = candidate.source.get("record")
    legacy_record = legacy_record if isinstance(legacy_record, dict) else {}
    status_text = (_text(legacy_record.get("status")) or "partial").lower()
    status = "ready" if status_text in {"completed", "complete", "ready"} else "partial"
    source_hash = _source_hash(
        candidate.run_dir / "inspection-world-v1" / "manifest.json",
        candidate.manifest,
        candidate.run_dir / "inspection-world-v1" / "source-record.json",
    )
    cameras = _camera_metadata(candidate.manifest)
    record = {
        "schema": STANDARD_RECORD_SCHEMA,
        "inspectionId": inspection_id,
        "sessionId": f"bkv-history-{inspection_id}",
        "materialId": material_id,
        "source": "bkv-online-history",
        "sourceRecordId": _text(candidate.source.get("recordId")) or inspection_id,
        "inspectionTime": inspection_time,
        "status": status,
        "cameraCount": CAMERA_COUNT,
        "cameras": [f"C{camera}" for camera in range(1, CAMERA_COUNT + 1)],
        "defectCount": len(defects),
        "material": material,
        "captureFiles": [],
        "defectsPath": "defects/defects.json",
        "sourceHash": source_hash,
        "configHash": "bkv-history-recovery-v1",
    }
    defects_document = {
        "schema": "steel.standard-defects.v1",
        "inspectionId": inspection_id,
        "defects": defects,
    }
    provenance = {
        "schema": PROVENANCE_SCHEMA,
        "provider": "bkv-online-mysql",
        "sourceRecordId": _text(candidate.source.get("recordId")) or inspection_id,
        "legacySeqNo": _number(candidate.source.get("legacySeqNo")) or int(inspection_id),
        "historyRunDirectory": str(candidate.run_dir),
        "algorithmManifest": candidate.manifest,
        "sourceDirectories": [
            camera.get("sourceDirectory") for camera in cameras if camera.get("sourceDirectory")
        ],
        "sourceFrameCount": _number(candidate.manifest.get("sourceFrameCount")) or 0,
        # Do not probe SMB paths while building the inventory.  A disconnected
        # share can make a metadata-only recovery appear hung; source access is
        # checked by the bounded materialization step instead.
        "rawAssetsDeferred": True,
        "rawAssetsAvailable": None,
        "algorithmOutput": {
            "processor": _text(candidate.manifest.get("processor")) or "bkv-inspection-world-v1",
            "revision": _text(candidate.manifest.get("revision")),
            "manifestPath": str(candidate.run_dir / "inspection-world-v1" / "manifest.json"),
            "surfaceMeshPath": str(candidate.run_dir / "inspection-world-v1" / "surface-mesh.bsmesh")
            if (candidate.run_dir / "inspection-world-v1" / "surface-mesh.bsmesh").is_file()
            else None,
        },
        "defectCount": len(defects),
        "material": material,
        "inspection": inspection,
    }
    return record, defects_document, provenance


def recover(runs_root: Path, input_root: Path, inventory_path: Path, limit: int | None) -> dict[str, Any]:
    runs_root = runs_root.resolve()
    input_root = input_root.resolve()
    if not runs_root.is_dir():
        raise ValueError(f"history runs root is unavailable: {runs_root}")
    selected: dict[str, Candidate] = {}
    skipped: list[dict[str, str]] = []
    seen = 0
    for run_dir, candidate, error in _iter_candidates(runs_root):
        seen += 1
        if candidate is None:
            skipped.append({"runDirectory": str(run_dir), "reason": error or "invalid candidate"})
            continue
        previous = selected.get(candidate.canonical_id)
        if previous is None or candidate.rank > previous.rank:
            selected[candidate.canonical_id] = candidate
    candidates = sorted(selected.values(), key=lambda item: int(item.canonical_id))
    if limit is not None:
        candidates = candidates[:limit]

    written = 0
    unchanged = 0
    conflicts = 0
    for candidate in candidates:
        record_path = input_root / "records" / candidate.canonical_id / "record.json"
        defects_path = input_root / "records" / candidate.canonical_id / "defects" / "defects.json"
        provenance_path = input_root / "records" / candidate.canonical_id / "source-provenance.json"
        record, defects, provenance = _record(candidate)
        if record_path.is_file():
            try:
                existing = _read_json(record_path)
            except (OSError, ValueError, json.JSONDecodeError):
                existing = {}
            if existing.get("sourceHash") == record["sourceHash"]:
                unchanged += 1
                continue
            conflicts += 1
            continue
        _atomic_json(record_path, record)
        _atomic_json(defects_path, defects)
        _atomic_json(provenance_path, provenance)
        written += 1

    inventory = {
        "schema": "steel.bkv-history-recovery.v1",
        "runsRoot": str(runs_root),
        "inputRoot": str(input_root),
        "seenRunDirectories": seen,
        "uniqueCanonicalRecords": len(selected),
        "selectedRecords": len(candidates),
        "written": written,
        "unchanged": unchanged,
        "conflicts": conflicts,
        "skipped": len(skipped),
        "metadataOnly": True,
        "rawSourcePreserved": True,
        "skippedDetails": skipped[:200],
    }
    _atomic_json(inventory_path.resolve(), inventory)
    return inventory


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _init_catalog(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS production_inspection (
            id TEXT PRIMARY KEY NOT NULL,
            session_id TEXT NOT NULL,
            material_id TEXT NOT NULL,
            inspection_time TEXT,
            status TEXT NOT NULL,
            defect_count INTEGER NOT NULL,
            camera_count INTEGER NOT NULL,
            source_hash TEXT NOT NULL,
            record_path TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            generation INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_production_inspection_time
            ON production_inspection(inspection_time DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_production_inspection_generation
            ON production_inspection(generation);
        CREATE TABLE IF NOT EXISTS production_defect (
            id TEXT PRIMARY KEY NOT NULL,
            inspection_id TEXT NOT NULL,
            camera_id TEXT NOT NULL,
            sequence_no INTEGER NOT NULL,
            defect_type TEXT NOT NULL,
            severity INTEGER,
            confidence REAL,
            artifacts_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_production_defect_inspection
            ON production_defect(inspection_id);
        CREATE TABLE IF NOT EXISTS capture_file (
            id TEXT PRIMARY KEY NOT NULL,
            inspection_id TEXT NOT NULL,
            camera_id TEXT NOT NULL,
            sequence_no INTEGER NOT NULL,
            kind TEXT NOT NULL,
            path TEXT NOT NULL,
            size INTEGER NOT NULL,
            sha256 TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_capture_file_inspection
            ON capture_file(inspection_id);
        INSERT INTO catalog_meta(key, value)
        VALUES ('schema', 'steel.inspection-result-catalog.v1')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value;
        """
    )


def _safe_record_json(record_path: Path) -> dict[str, Any]:
    record = _read_json(record_path)
    if record.get("schema") != STANDARD_RECORD_SCHEMA:
        raise ValueError(f"unsupported record schema: {record_path}")
    inspection_id = _text(record.get("inspectionId"))
    if not inspection_id or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", inspection_id):
        raise ValueError(f"invalid inspection id: {record_path}")
    return record


def _result_from_standard(record: dict[str, Any], defects: list[dict[str, Any]], processor: str) -> dict[str, Any]:
    result = {
        "schema": "steel.inspection-result.v1",
        "inspectionId": record["inspectionId"],
        "sessionId": record.get("sessionId") or f"bkv-history-{record['inspectionId']}",
        "materialId": record.get("materialId") or record["inspectionId"],
        "source": record.get("source") or "bkv-online-history",
        "sourceRecordId": record.get("sourceRecordId") or record["inspectionId"],
        "inspectionTime": record.get("inspectionTime"),
        "status": record.get("status") or "partial",
        "cameraCount": int(record.get("cameraCount") or CAMERA_COUNT),
        "cameras": record.get("cameras") or [f"C{camera}" for camera in range(1, CAMERA_COUNT + 1)],
        "defectCount": len(defects),
        "material": record.get("material") or {},
        # Image materialization is intentionally deferred.  The provenance
        # points back to the read-only BKV roots for a later bounded job.
        "artifacts": [],
        "defects": defects,
        "sourceHash": record.get("sourceHash") or "",
        "configHash": record.get("configHash") or "bkv-history-recovery-v1",
        "algorithmVersion": processor,
        "publishedAt": _utc_now(),
    }
    return result


def _publish_metadata(input_root: Path, result_root: Path, processor: str) -> dict[str, int | str]:
    input_root = input_root.resolve()
    result_root = result_root.resolve()
    records_root = input_root / "records"
    if not records_root.is_dir():
        raise ValueError(f"recovery input records root is unavailable: {records_root}")
    result_root.mkdir(parents=True, exist_ok=True)
    (result_root / "records").mkdir(exist_ok=True)
    (result_root / "blobs").mkdir(exist_ok=True)
    (result_root / "staging").mkdir(exist_ok=True)

    record_paths = sorted(records_root.glob("*/record.json"), key=lambda path: path.parent.name)
    catalog_path = result_root / "catalog.db"
    catalog_ids: set[str] = set()
    if catalog_path.is_file():
        try:
            with sqlite3.connect(catalog_path, timeout=60) as existing_connection:
                catalog_ids = {
                    row[0]
                    for row in existing_connection.execute(
                        "SELECT id FROM production_inspection"
                    )
                }
        except sqlite3.Error:
            # The normal publish transaction below will surface a catalog
            # failure.  Treat an unreadable catalog as empty here so a stale
            # record directory cannot silently hide a recovery candidate.
            catalog_ids = set()
    skipped_existing = 0
    invalid = 0
    prepared: list[tuple[dict[str, Any], list[dict[str, Any]], Path, Path | None]] = []
    for record_path in record_paths:
        try:
            record = _safe_record_json(record_path)
            record_id = record["inspectionId"]
            destination = result_root / "records" / record_id
            existing = destination / "result.json"
            if existing.is_file() and record_id in catalog_ids:
                skipped_existing += 1
                continue
            defects_path = record_path.parent / str(record.get("defectsPath") or "defects/defects.json")
            defects_document = _read_json(defects_path) if defects_path.is_file() else {"defects": []}
            defects = defects_document.get("defects")
            if not isinstance(defects, list):
                defects = []
            provenance = record_path.parent / "source-provenance.json"
            prepared.append((record, defects, record_path.parent, provenance if provenance.is_file() else None))
        except (OSError, ValueError, json.JSONDecodeError):
            invalid += 1

    # Publish record directories first.  They are not visible to the service
    # until the catalog transaction below makes them reachable.
    published: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    used_defect_ids: set[str] = set()
    for record, raw_defects, source_dir, provenance in prepared:
        normalized_defects: list[dict[str, Any]] = []
        for index, defect in enumerate(raw_defects, start=1):
            value = dict(defect) if isinstance(defect, dict) else {}
            original_id = _text(value.get("id")) or f"{record['inspectionId']}-defect-{index}"
            defect_id = original_id
            if defect_id in used_defect_ids:
                defect_id = f"{record['inspectionId']}-{index}-{original_id}"
            used_defect_ids.add(defect_id)
            value["id"] = defect_id
            value["inspectionId"] = record["inspectionId"]
            normalized_defects.append(value)
        result = _result_from_standard(record, normalized_defects, processor)
        destination = result_root / "records" / record["inspectionId"]
        staging = result_root / "staging" / f"history-{record['inspectionId']}-{os.getpid()}"
        if staging.exists():
            # This is a per-record recovery staging directory, never a data
            # root.  A stale directory is safe to replace before publication.
            for child in staging.iterdir():
                if child.is_dir():
                    import shutil

                    shutil.rmtree(child)
                else:
                    child.unlink()
        staging.mkdir(parents=True, exist_ok=True)
        _atomic_json(staging / "result.json", result)
        _atomic_json(staging / "record.json", result)
        _atomic_json(
            staging / "defects.json",
            {"schema": "steel.standard-defects.v1", "inspectionId": record["inspectionId"], "defects": normalized_defects},
        )
        if provenance is not None:
            _atomic_json(staging / "source-provenance.json", _read_json(provenance))
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            # A previous publisher can leave a fully written record directory
            # behind if its SQLite transaction is interrupted.  Preserve that
            # orphan under staging and make the replacement recoverable rather
            # than deleting it or exposing a half-written directory.
            orphan = result_root / "staging" / f"orphan-{record['inspectionId']}-{os.getpid()}"
            if orphan.exists():
                import shutil

                shutil.rmtree(orphan)
            os.replace(destination, orphan)
        os.replace(staging, destination)
        published.append((result, normalized_defects))

    connection = sqlite3.connect(catalog_path, timeout=60)
    connection.execute("PRAGMA busy_timeout=60000")
    try:
        _init_catalog(connection)
        with connection:
            generation = connection.execute(
                "SELECT COALESCE(MAX(generation), 0) FROM production_inspection"
            ).fetchone()[0]
            for result, defects in published:
                generation += 1
                connection.execute(
                    """
                    INSERT INTO production_inspection
                    (id, session_id, material_id, inspection_time, status,
                     defect_count, camera_count, source_hash, record_path,
                     metadata_json, generation)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                      session_id=excluded.session_id,
                      material_id=excluded.material_id,
                      inspection_time=excluded.inspection_time,
                      status=excluded.status,
                      defect_count=excluded.defect_count,
                      camera_count=excluded.camera_count,
                      source_hash=excluded.source_hash,
                      record_path=excluded.record_path,
                      metadata_json=excluded.metadata_json,
                      generation=excluded.generation
                    """,
                    (
                        result["inspectionId"],
                        result["sessionId"],
                        result["materialId"],
                        result["inspectionTime"],
                        result["status"],
                        len(defects),
                        result["cameraCount"],
                        result["sourceHash"],
                        f"records/{result['inspectionId']}",
                        json.dumps(result["material"], ensure_ascii=False, separators=(",", ":")),
                        generation,
                    ),
                )
                connection.execute(
                    "DELETE FROM production_defect WHERE inspection_id = ?",
                    (result["inspectionId"],),
                )
                for defect in defects:
                    connection.execute(
                        """
                        INSERT INTO production_defect
                        (id, inspection_id, camera_id, sequence_no, defect_type,
                         severity, confidence, artifacts_json)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            defect["id"],
                            result["inspectionId"],
                            defect.get("cameraId") or "C1",
                            int(defect.get("sequenceNo") or 0),
                            defect.get("defectType") or "unknown",
                            defect.get("severity"),
                            defect.get("confidence"),
                            json.dumps(defect.get("artifacts") or {}, ensure_ascii=False, separators=(",", ":")),
                        ),
                    )
    finally:
        connection.close()
    return {
        "resultRoot": str(result_root),
        "published": len(published),
        "skippedExisting": skipped_existing,
        "invalid": invalid,
        "metadataOnly": 1,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs-root", type=Path, required=True)
    parser.add_argument("--input-root", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    parser.add_argument(
        "--publish-root",
        type=Path,
        help="publish metadata-only steel.inspection-result.v1 records into this result root",
    )
    parser.add_argument(
        "--algorithm-version",
        default="bkv-history-recovery-v1",
        help="algorithm version stored in the unified result",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = recover(args.runs_root, args.input_root, args.inventory, args.limit)
    if args.publish_root is not None:
        result["publish"] = _publish_metadata(
            args.input_root,
            args.publish_root,
            args.algorithm_version,
        )
        _atomic_json(args.inventory.resolve(), result)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
