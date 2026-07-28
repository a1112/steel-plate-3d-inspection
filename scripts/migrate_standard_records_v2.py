#!/usr/bin/env python3
"""Migrate the normalized standard record store to the V2 flat frame layout."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import uuid
from pathlib import Path
from typing import Any

from scripts.bkv_import_service import (
    BkvImportService,
    STANDARD_RECORD_SCHEMA,
    _atomic_json,
    _read_json,
    _replace_directory_with_retry,
    _sha256_file,
)


class StandardRecordV2Migrator:
    def __init__(self, data_root: Path, cache_root: Path | None = None) -> None:
        self.data_root = data_root.resolve()
        self.catalog_path = self.data_root / "catalog.db"
        self.cache_root = (
            cache_root.resolve()
            if cache_root is not None
            else self.data_root / "cache"
        )
        if not self.catalog_path.is_file():
            raise ValueError(f"standard catalog is unavailable: {self.catalog_path}")
        self.job_id = f"migrate-v2-{uuid.uuid4().hex}"

    def _connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.catalog_path)
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _cache_helper(self) -> BkvImportService:
        helper = BkvImportService.__new__(BkvImportService)
        helper.converted_root = self.data_root
        helper.cache_root = self.cache_root
        return helper

    def run(self) -> dict[str, int]:
        with self._connection() as connection:
            records = connection.execute(
                "SELECT id, source_hash, record_path FROM production_inspection ORDER BY id"
            ).fetchall()
        converted = 0
        skipped = 0
        for record_id, source_hash, record_path in records:
            destination = (self.data_root / str(record_path)).resolve()
            try:
                destination.relative_to(self.data_root)
            except ValueError as error:
                raise ValueError(f"record {record_id} escapes data root") from error
            metadata = _read_json(destination / "record.json", "standard record")
            if metadata.get("schema") == STANDARD_RECORD_SCHEMA:
                skipped += 1
                continue
            self._migrate_record(str(record_id), str(source_hash), destination, metadata)
            converted += 1
        return {"converted": converted, "skipped": skipped, "total": len(records)}

    def _migrate_record(
        self,
        record_id: str,
        source_hash: str,
        destination: Path,
        metadata: dict[str, Any],
    ) -> None:
        stage = (
            self.data_root
            / "imports"
            / ".staging"
            / self.job_id
            / record_id
        )
        backup = (
            self.data_root
            / "imports"
            / "replaced"
            / self.job_id
            / record_id
        )
        if stage.exists():
            shutil.rmtree(stage)
        stage.mkdir(parents=True)
        intensity_paths: dict[int, list[Path]] = {}
        updates: list[tuple[str, int, str, int, str]] = []

        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT id, camera_id, sequence_no, kind, path
                FROM capture_file
                WHERE inspection_id = ?
                ORDER BY camera_id, sequence_no, kind
                """,
                (record_id,),
            ).fetchall()
        if not rows:
            raise ValueError(f"record {record_id} has no indexed capture files")

        for file_id, camera_id, sequence_no, kind, relative in rows:
            source = (self.data_root / str(relative)).resolve()
            try:
                source.relative_to(destination)
            except ValueError as error:
                raise ValueError(
                    f"record {record_id} capture {file_id} is outside its record"
                ) from error
            numeric_camera = int(str(camera_id).removeprefix("C"))
            if kind == "intensity":
                target = (
                    stage
                    / "cameras"
                    / str(camera_id)
                    / "intensity"
                    / f"{int(sequence_no):06d}.jpg"
                )
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
                intensity_paths.setdefault(numeric_camera, []).append(target)
            elif kind == "depth":
                target = (
                    stage
                    / "cameras"
                    / str(camera_id)
                    / "depth"
                    / f"{int(sequence_no):06d}.npz"
                )
                BkvImportService._write_depth_v2(source, target)
            else:
                raise ValueError(
                    f"record {record_id} contains unsupported capture kind {kind}"
                )
            relative_target = (
                Path("records") / record_id / target.relative_to(stage)
            ).as_posix()
            updates.append(
                (
                    relative_target,
                    target.stat().st_size,
                    _sha256_file(target),
                    int(sequence_no),
                    str(file_id),
                )
            )

        for name in ("source-provenance.json",):
            source = destination / name
            if source.is_file():
                shutil.copy2(source, stage / name)
        defects = destination / "defects"
        if defects.is_dir():
            shutil.copytree(defects, stage / "defects")
        metadata["schema"] = STANDARD_RECORD_SCHEMA
        metadata["captureFiles"] = [
            {
                "cameraId": str(camera_id),
                "sequenceNo": sequence_no,
                "kind": kind,
                "path": (
                    Path("cameras")
                    / str(camera_id)
                    / ("intensity" if kind == "intensity" else "depth")
                    / f"{int(sequence_no):06d}.{'jpg' if kind == 'intensity' else 'npz'}"
                ).as_posix(),
                "size": size,
                "sha256": sha256,
            }
            for (path, size, sha256, sequence_no, file_id), (
                _,
                camera_id,
                _,
                kind,
                _,
            ) in zip(updates, rows)
        ]
        _atomic_json(stage / "record.json", metadata)

        helper = self._cache_helper()
        cache_stage = helper._stage_tile_cache(
            job_id=self.job_id,
            inspection_id=record_id,
            record_hash=source_hash,
            intensity_paths=intensity_paths,
        )
        cache_destination = (
            self.cache_root
            / "inspection-world-v2"
            / record_id
            / source_hash
        )
        backup.parent.mkdir(parents=True, exist_ok=True)
        cache_published = False
        try:
            _replace_directory_with_retry(destination, backup)
            _replace_directory_with_retry(stage, destination)
            cache_destination.parent.mkdir(parents=True, exist_ok=True)
            if cache_destination.exists():
                shutil.rmtree(cache_destination)
            _replace_directory_with_retry(cache_stage, cache_destination)
            cache_published = True
            with self._connection() as connection:
                for path, size, sha256, _, file_id in updates:
                    connection.execute(
                        """
                        UPDATE capture_file
                        SET path = ?, size = ?, sha256 = ?
                        WHERE id = ? AND inspection_id = ?
                        """,
                        (path, size, sha256, file_id, record_id),
                    )
            shutil.rmtree(backup)
            for apple_double in destination.rglob("._*"):
                if apple_double.is_file():
                    apple_double.unlink()
        except Exception:
            if cache_published and cache_destination.exists():
                shutil.rmtree(cache_destination)
            if destination.exists():
                shutil.rmtree(destination)
            if backup.exists():
                _replace_directory_with_retry(backup, destination)
            raise


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Migrate a stopped standard record store to steel.standard-record.v2"
    )
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--cache-root", type=Path)
    args = parser.parse_args()
    result = StandardRecordV2Migrator(args.data_root, args.cache_root).run()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
