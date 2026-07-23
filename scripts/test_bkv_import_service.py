from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from PIL import Image
import numpy as np

from scripts.bkv_import_service import BkvImportService, ImportInterrupted
from scripts.convert_bkv_d3img import FORMAT_VERSION, INVALID_SENTINEL


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class BkvImportServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "legacy"
        self.target = self.root / "converted"
        self.source.mkdir()
        config = self.root / "config"
        (config / "runtime-modes").mkdir(parents=True)
        self.project_path = config / "project.json"
        self.profile_path = config / "runtime-modes" / "bkv-6.json"
        self.project_path.write_text(
            json.dumps(
                {
                    "schema": "steel.project-config.v1",
                    "activeRuntimeProfile": "config/runtime-modes/bkv-6.json",
                }
            ),
            encoding="utf-8",
        )
        self.profile_path.write_text(
            json.dumps(
                {
                    "schema": "steel.runtime-profile.v1",
                    "id": "bkv-6",
                    "displayName": "fixture",
                    "provider": "bkv",
                    "dataSource": "converted-local",
                    "cameraConnection": "none",
                    "cameraCount": 6,
                    "cameras": [
                        {
                            "id": f"C{camera}",
                            "displayOrder": camera,
                            "sourceCameraId": camera,
                            "role": f"legacy-{camera}",
                            "sourceDirectory": f"camera-{camera}",
                        }
                        for camera in range(1, 7)
                    ],
                    "storage": {
                        "sourceRoot": "legacy",
                        "convertedRoot": "converted",
                        "catalogPath": "converted/catalog.db",
                        "converterOrigin": "http://127.0.0.1:4893",
                    },
                    "capabilities": {
                        "directCamera": False,
                        "captureManagement": False,
                        "reconstruction": False,
                        "offlineReplay": True,
                    },
                }
            ),
            encoding="utf-8",
        )
        self._write_manifest(materials=(10, 11))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_manifest(
        self,
        *,
        materials: tuple[int, ...],
        unknown_camera: bool = False,
        missing_depth: bool = False,
    ) -> None:
        payload_materials = []
        for material in materials:
            cameras = []
            camera_ids = list(range(1, 7)) + ([7] if unknown_camera else [])
            for camera in camera_ids:
                frame_root = self.source / "frames" / str(material) / f"C{camera}"
                frame_root.mkdir(parents=True, exist_ok=True)
                image_path = frame_root / "4.jpg"
                Image.new("L", (3, 2), color=material + camera).save(image_path)
                depth_path = frame_root / "4.npz"
                depth = np.asarray([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
                np.savez_compressed(
                    depth_path,
                    depth=depth,
                    valid_mask=np.ones(depth.shape, dtype=np.bool_),
                    format_version=np.asarray(FORMAT_VERSION),
                    camera_id=np.asarray(camera, dtype=np.int16),
                    legacy_seq_no=np.asarray(material, dtype=np.int64),
                    frame_no=np.asarray(4, dtype=np.int32),
                    invalid_sentinel=np.asarray(INVALID_SENTINEL, dtype=np.float32),
                    coordinate_space=np.asarray("legacy-camera-raw"),
                    unit=np.asarray("legacy-unknown"),
                    source_sha256=np.asarray("fixture"),
                )
                image_relative = image_path.relative_to(self.source).as_posix()
                depth_relative = depth_path.relative_to(self.source).as_posix()
                depth_frames = [] if missing_depth and material == materials[0] and camera == 6 else [
                    {
                        "frameNo": 4,
                        "path": depth_relative,
                        "size": depth_path.stat().st_size,
                        "sha256": _sha256(depth_path),
                    }
                ]
                cameras.append(
                    {
                        "cameraId": camera,
                        "mode": "offline-file",
                        "frameWidth": 3,
                        "frameHeight": 2,
                        "orientation": {
                            "frameOrder": "ascending",
                            "rotation": 0,
                            "flipX": False,
                            "flipY": False,
                        },
                        "twoDFrames": [
                            {
                                "frameNo": 4,
                                "path": image_relative,
                                "size": image_path.stat().st_size,
                                "sha256": _sha256(image_path),
                            }
                        ],
                        "npzFrames": depth_frames,
                    }
                )
            payload_materials.append(
                {
                    "legacySeqNo": material,
                    "legacyCheckRecordSeqNo": material + 100,
                    "steelId": f"STEEL-{material}",
                    "steelType": "37Mn/2",
                    "lengthMm": 12096,
                    "outerDiameterLegacyValue": 233.6,
                    "wallThicknessMm": None,
                    "inspectionTime": "2025-09-26 03:36:17",
                    "legacyDeclaredDefectCount": 1,
                    "defects": [
                        {
                            "legacyDefectId": material * 10,
                            "defectNo": 1,
                            "cameraId": 1,
                            "classNo": 2,
                            "className": "轧折",
                            "grade": 1,
                            "confidence": 51,
                            "imageIndex": 4,
                            "imageRect2d": {
                                "left": 0,
                                "right": 2,
                                "top": 0,
                                "bottom": 1,
                            },
                        }
                    ],
                    "cameras": cameras,
                    "artifacts": {},
                }
            )
        (self.source / "bkv-runtime-manifest.json").write_text(
            json.dumps(
                {
                    "schema": "bkv-runtime-v1",
                    "batchId": "fixture-batch",
                    "cameraCount": 6,
                    "materialCount": len(payload_materials),
                    "materials": payload_materials,
                    "sources": {},
                    "quarantine": {},
                }
            ),
            encoding="utf-8",
        )

    def _service(self, **kwargs) -> BkvImportService:
        return BkvImportService(
            project_path=self.project_path,
            profile_path=self.profile_path,
            **kwargs,
        )

    def test_converts_two_records_into_six_camera_standard_store(self) -> None:
        result = self._service().run_once()
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.converted_records, 2)
        self.assertTrue((self.target / "records" / "10" / "record.json").is_file())
        self.assertTrue(
            (
                self.target
                / "records"
                / "10"
                / "cameras"
                / "C6"
                / "frames"
                / "000004"
                / "depth.npz"
            ).is_file()
        )
        self.assertFalse((self.target / "records" / "10" / "cameras" / "C7").exists())
        with closing(sqlite3.connect(self.target / "catalog.db")) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT camera_count FROM production_inspection WHERE id = '10'"
                ).fetchone(),
                (6,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM capture_file WHERE inspection_id = '10'"
                ).fetchone(),
                (12,),
            )

    def test_is_idempotent_and_never_modifies_source_files(self) -> None:
        source_files = sorted(path for path in self.source.rglob("*") if path.is_file())
        before = {
            path: (_sha256(path), path.stat().st_mtime_ns)
            for path in source_files
        }
        first = self._service().run_once()
        with closing(sqlite3.connect(self.target / "catalog.db")) as connection:
            catalog_before = connection.execute(
                "SELECT id, source_hash, record_path FROM production_inspection ORDER BY id"
            ).fetchall()
        second = self._service().run_once()
        with closing(sqlite3.connect(self.target / "catalog.db")) as connection:
            catalog_after = connection.execute(
                "SELECT id, source_hash, record_path FROM production_inspection ORDER BY id"
            ).fetchall()
        self.assertEqual(first.converted_records, 2)
        self.assertEqual(second.converted_records, 0)
        self.assertEqual(second.skipped_records, 2)
        self.assertEqual(catalog_before, catalog_after)
        self.assertEqual(
            before,
            {
                path: (_sha256(path), path.stat().st_mtime_ns)
                for path in source_files
            },
        )

    def test_invalid_camera_or_missing_pair_is_quarantined(self) -> None:
        self._write_manifest(materials=(10,), unknown_camera=True)
        result = self._service().run_once()
        self.assertEqual(result.status, "completed_with_errors")
        self.assertEqual(result.converted_records, 0)
        self.assertEqual(result.quarantined_records, 1)
        self.assertFalse((self.target / "records" / "10").exists())
        quarantines = list((self.target / "imports" / "quarantine").glob("*.json"))
        self.assertEqual(len(quarantines), 1)
        self.assertIn("unknown camera", quarantines[0].read_text(encoding="utf-8"))

        self.target.rename(self.root / "converted-invalid-camera")
        self._write_manifest(materials=(10,), missing_depth=True)
        result = self._service().run_once()
        self.assertEqual(result.quarantined_records, 1)
        self.assertIn(
            "frame coverage mismatch",
            next((self.target / "imports" / "quarantine").glob("*.json")).read_text(
                encoding="utf-8"
            ),
        )

    def test_interruption_leaves_staging_and_retry_publishes_atomically(self) -> None:
        service = self._service(interrupt_after_staged_records=1)
        with self.assertRaises(ImportInterrupted):
            service.run_once()
        status = service.status()
        job_id = status["latestJob"]["id"]
        self.assertEqual(status["latestJob"]["status"], "interrupted")
        self.assertTrue(any((self.target / "imports" / ".staging" / job_id).iterdir()))
        self.assertFalse((self.target / "records" / "10").exists())
        with closing(sqlite3.connect(self.target / "catalog.db")) as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM production_inspection").fetchone(),
                (0,),
            )

        resumed = self._service().retry_failed(job_id)
        self.assertEqual(resumed.status, "completed")
        self.assertEqual(resumed.converted_records, 2)
        self.assertTrue((self.target / "records" / "10" / "record.json").is_file())

    def test_job_ledger_records_hash_progress_timestamps_and_failures(self) -> None:
        self._write_manifest(materials=(10,), unknown_camera=True)
        result = self._service().run_once()
        with closing(sqlite3.connect(self.target / "catalog.db")) as connection:
            row = connection.execute(
                """
                SELECT source_hash, config_hash, status, total_records,
                       converted_records, quarantined_records, started_at,
                       completed_at, failure_details
                FROM import_job WHERE id = ?
                """,
                (result.job_id,),
            ).fetchone()
        self.assertIsNotNone(row)
        self.assertTrue(row[0])
        self.assertTrue(row[1])
        self.assertEqual(row[2], "completed_with_errors")
        self.assertEqual(row[3:6], (1, 0, 1))
        self.assertTrue(row[6])
        self.assertTrue(row[7])
        self.assertIn("unknown camera", row[8])


if __name__ == "__main__":
    unittest.main()
