from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from repair_sick_flow_boundaries import (
    backup_database,
    detect_one_round_segments,
    finalize_database,
    load_committed_events,
    prepare_segment,
    reference_observations,
    reserve_flow_numbers,
    split_segments_before_storage_indices,
    ReferenceObservation,
)
from sick_capture.events import publish_committed_round
from sick_capture.profile import CameraProfile, SickCaptureProfile


class RepairSickFlowBoundariesTests(unittest.TestCase):
    def test_missing_committed_round_closes_failed_callback_segment(self) -> None:
        observations = [
            ReferenceObservation(10, 0, 0.1, True),
            ReferenceObservation(11, 1, 0.1, True),
            ReferenceObservation(15, 2, 0.1, True),
            ReferenceObservation(16, 3, 0.0, False),
        ]
        self.assertEqual(
            [
                (item.start_round, item.end_round, item.start_storage_index, item.end_storage_index)
                for item in detect_one_round_segments(observations)
            ],
            [(10, 11, 0, 1), (15, 16, 2, 3)],
        )

    def test_operator_boundary_splits_a_continuous_round_run(self) -> None:
        observations = [
            ReferenceObservation(20, 10, 0.1, True),
            ReferenceObservation(21, 11, 0.1, True),
            ReferenceObservation(22, 12, 0.1, True),
            ReferenceObservation(23, 13, 0.1, True),
            ReferenceObservation(24, 14, 0.0, False),
        ]
        detected = detect_one_round_segments(observations)
        self.assertEqual(
            [(item.start_storage_index, item.end_storage_index) for item in detected],
            [(10, 14)],
        )

        split = split_segments_before_storage_indices(
            detected,
            observations,
            [12],
        )
        self.assertEqual(
            [
                (
                    item.ordinal,
                    item.start_round,
                    item.end_round,
                    item.start_storage_index,
                    item.end_storage_index,
                )
                for item in split
            ],
            [(1, 20, 21, 10, 11), (2, 22, 24, 12, 14)],
        )

    def test_operator_boundary_requires_a_steel_present_frame(self) -> None:
        observations = [
            ReferenceObservation(30, 20, 0.1, True),
            ReferenceObservation(31, 21, 0.0, False),
        ]
        with self.assertRaisesRegex(ValueError, "first steel-present frame"):
            split_segments_before_storage_indices(
                detect_one_round_segments(observations),
                observations,
                [21],
            )

    def _profile(self, root: Path) -> SickCaptureProfile:
        cameras = tuple(
            CameraProfile(
                camera_index=index,
                camera_id=camera_id,
                key=camera_id,
                serial_number=f"serial-{camera_id}",
                model="test",
                firmware="test",
                ip=f"192.0.2.{index}",
                role="test",
                storage_root=root / camera_id,
            )
            for index, camera_id in enumerate(("C1", "C4"), start=1)
        )
        return SickCaptureProfile(
            source_path=root / "capture.json",
            name="test",
            cti_path=root / "test.cti",
            cti_sha256="0" * 64,
            device_scan_type="Linescan3D",
            expected_depth_formats=("Coord3D_C16",),
            expected_intensity_formats=("Mono8",),
            expected_cameras=2,
            storage_root=root / "central",
            cameras=cameras,
            auto_connect=False,
            timeout_ms=1000,
            jpeg_quality=90,
            fsync=False,
            black_frame_threshold=1.0,
            raw={
                "captureDefaults": {
                    "steelDetectionCameraKeys": ["C4"],
                    "steelBrightPixelRatio": 0.02,
                }
            },
        )

    def _source_archive(self, profile: SickCaptureProfile, source_flow: int) -> None:
        # C1 deliberately remains bright.  Only C4 owns boundaries.
        c4_ratios = (0.0, 0.10, 0.11, 0.0, 0.0, 0.12, 0.0)
        for camera in profile.enabled_cameras:
            root = camera.storage_root / str(source_flow)
            root.mkdir(parents=True)
            (root / "camera_config.json").write_text(
                json.dumps({"cameraId": camera.camera_id}), encoding="utf-8"
            )
        for capture_round, c4_ratio in enumerate(c4_ratios, start=1):
            rows = []
            for camera in profile.enabled_cameras:
                index = capture_round - 1
                root = camera.storage_root / str(source_flow)
                depth = root / "3d" / f"{index}.npz"
                intensity = root / "2d" / f"{index}.png"
                metadata = root / "json" / f"{index}.json"
                depth.parent.mkdir(parents=True, exist_ok=True)
                intensity.parent.mkdir(parents=True, exist_ok=True)
                metadata.parent.mkdir(parents=True, exist_ok=True)
                depth.write_bytes(f"depth-{camera.camera_id}-{index}".encode())
                intensity.write_bytes(f"image-{camera.camera_id}-{index}".encode())
                metadata_payload = {
                    "schema": "steel.sick-frame.v1",
                    "width": 8,
                    "height": 4,
                    "coilId": str(source_flow),
                    "save_index": index,
                    "sequenceNo": index + 1,
                    "captureRound": capture_round,
                    "sessionId": "source-session",
                    "inspectionId": "INSP-source-session",
                    "productionEventId": "FLOW-0000000010",
                    "syncGroupId": f"source:round-{capture_round}",
                    "depthOutput": str(depth),
                    "intensityOutput": str(intensity),
                    "metadataOutput": str(metadata),
                    "frameArtifact": {
                        "materialId": str(source_flow),
                        "sessionId": "source-session",
                        "inspectionId": "INSP-source-session",
                        "productionEventId": "FLOW-0000000010",
                        "syncGroupId": f"source:round-{capture_round}",
                        "captureRound": capture_round,
                        "sequence": {"storageIndex": index, "sequenceNo": index + 1},
                        "artifacts": {
                            "depth": str(depth),
                            "intensity": str(intensity),
                            "metadata": str(metadata),
                            "cameraConfig": str(root / "camera_config.json"),
                        },
                    },
                }
                metadata.write_text(json.dumps(metadata_payload), encoding="utf-8")
                rows.append(
                    {
                        "round": capture_round,
                        "cameraId": camera.camera_id,
                        "cameraKey": camera.key,
                        "sequenceNo": index + 1,
                        "depthOutput": str(depth),
                        "intensityOutput": str(intensity),
                        "metadataOutput": str(metadata),
                        "capturedAt": f"2026-01-01T00:00:0{capture_round}.000Z",
                        "hostUtcNs": 1_800_000_000_000_000_000 + capture_round * 1_000_000,
                        "deviceTimestamp": capture_round,
                        "meanIntensity": 1.0,
                        "brightPixelRatio": c4_ratio if camera.camera_id == "C4" else 0.5,
                        "imageQuality": {"status": "accepted"},
                        "checksums": {},
                    }
                )
            publish_committed_round(
                profile.storage_root,
                source_flow,
                "source-session",
                rows,
                boundary_phase="normal",
                expected_camera_ids=["C1", "C4"],
            )

    def _database(self, path: Path, source_flow: int) -> None:
        connection = sqlite3.connect(path)
        connection.executescript(
            """
            CREATE TABLE steel_flow (
              flow_no INTEGER PRIMARY KEY AUTOINCREMENT, flow_code TEXT NOT NULL UNIQUE,
              session_id TEXT NOT NULL UNIQUE, material_id TEXT NOT NULL, source TEXT NOT NULL,
              status TEXT NOT NULL, next_image_no INTEGER NOT NULL, image_count INTEGER NOT NULL,
              storage_root TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
              updated_at TEXT NOT NULL, raw_payload TEXT NOT NULL
            );
            CREATE TABLE steel_flow_image (
              flow_no INTEGER NOT NULL, image_no INTEGER NOT NULL, inspection_id TEXT NOT NULL,
              session_id TEXT NOT NULL, material_id TEXT NOT NULL, camera_id TEXT NOT NULL,
              camera_ip TEXT NOT NULL, camera_sequence_no INTEGER NOT NULL, depth_path TEXT NOT NULL,
              intensity_path TEXT NOT NULL, metadata_path TEXT NOT NULL, width INTEGER NOT NULL,
              height INTEGER NOT NULL, mean_intensity REAL NOT NULL, captured_at TEXT NOT NULL,
              created_at TEXT NOT NULL, PRIMARY KEY(flow_no,image_no),
              FOREIGN KEY(flow_no) REFERENCES steel_flow(flow_no) ON DELETE CASCADE
            );
            CREATE TABLE material_session (
              id TEXT PRIMARY KEY, material_id TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
              control_mode TEXT NOT NULL, trigger_mode TEXT NOT NULL, steel_type TEXT NOT NULL,
              width_mm REAL NOT NULL, length_mm REAL NOT NULL, thickness_mm REAL NOT NULL,
              client TEXT NOT NULL, hard TEXT NOT NULL, storage_root TEXT NOT NULL,
              started_at TEXT NOT NULL, finished_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              raw_payload TEXT NOT NULL
            );
            CREATE TABLE production_inspection (
              id TEXT PRIMARY KEY, material_id TEXT NOT NULL, session_id TEXT NOT NULL,
              status TEXT NOT NULL, storage_root TEXT NOT NULL, summary_path TEXT NOT NULL,
              started_at TEXT NOT NULL, finished_at TEXT NOT NULL, capture_count INTEGER NOT NULL,
              defect_count INTEGER NOT NULL, raw_payload TEXT NOT NULL
            );
            CREATE TABLE capture_file (
              id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL, session_id TEXT NOT NULL,
              material_id TEXT NOT NULL, camera_id TEXT NOT NULL, camera_ip TEXT NOT NULL,
              data_name TEXT NOT NULL, sequence_no INTEGER NOT NULL, file_type TEXT NOT NULL,
              path TEXT NOT NULL, metadata_path TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE trigger_event (
              id TEXT PRIMARY KEY, material_id TEXT NOT NULL, session_id TEXT NOT NULL,
              source TEXT NOT NULL, mode TEXT NOT NULL, event_type TEXT NOT NULL,
              command TEXT NOT NULL, value INTEGER NOT NULL, payload TEXT NOT NULL,
              provider_code INTEGER NOT NULL, provider_response TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE TABLE production_defect (
              id TEXT PRIMARY KEY, material_id TEXT NOT NULL, active INTEGER NOT NULL,
              superseded_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            """
        )
        raw = json.dumps({"source": "grayscale"})
        connection.execute(
            "INSERT INTO steel_flow VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                source_flow,
                "FLOW-0000000010",
                "source-session",
                str(source_flow),
                "grayscale",
                "finished",
                15,
                14,
                "central",
                "1000",
                "2000",
                "2000",
                raw,
            ),
        )
        connection.execute(
            "INSERT INTO material_session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "source-session",
                str(source_flow),
                "grayscale",
                "finished",
                "grayscale",
                "grayscale",
                "",
                0.0,
                0.0,
                0.0,
                "",
                "",
                "central",
                "1000",
                "2000",
                "2000",
                raw,
            ),
        )
        connection.execute(
            "INSERT INTO production_inspection VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                "INSP-source-session",
                str(source_flow),
                "source-session",
                "finished",
                "central",
                "",
                "1000",
                "2000",
                0,
                1,
                raw,
            ),
        )
        connection.execute(
            "INSERT INTO capture_file VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "source-capture",
                "INSP-source-session",
                "source-session",
                str(source_flow),
                "C4",
                "192.0.2.2",
                "intensity",
                1,
                "png",
                "source.png",
                "source.json",
                "1000",
            ),
        )
        connection.execute(
            "INSERT INTO production_defect VALUES (?,?,?,?,?)",
            ("source-defect", str(source_flow), 1, "", "1000"),
        )
        connection.commit()
        connection.close()

    def test_reference_camera_one_round_split_and_non_destructive_apply(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            profile = self._profile(root)
            source_flow = 10
            self._source_archive(profile, source_flow)
            database = root / "inspection.sqlite"
            backup = root / "backup.sqlite"
            self._database(database, source_flow)

            events = load_committed_events(profile.storage_root, source_flow)
            observations = reference_observations(events, "C4", 0.02)
            segments = detect_one_round_segments(observations)
            self.assertEqual(
                [(item.start_storage_index, item.end_storage_index) for item in segments],
                [(1, 3), (5, 6)],
            )

            backup_database(database, backup)
            targets = reserve_flow_numbers(database, profile, source_flow, segments)
            self.assertEqual(targets, [11, 12])
            prepared = [
                prepare_segment(
                    profile,
                    source_flow,
                    target,
                    segment,
                    events,
                    "C4",
                )
                for target, segment in zip(targets, segments)
            ]
            deleted = finalize_database(
                database, profile, source_flow, prepared, backup
            )
            self.assertEqual(deleted, 1)

            connection = sqlite3.connect(database)
            self.assertEqual(
                connection.execute(
                    "SELECT status FROM steel_flow WHERE flow_no=?", (source_flow,)
                ).fetchone(),
                ("finished",),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT flow_no,status,image_count FROM steel_flow ORDER BY flow_no"
                ).fetchall(),
                [(10, "finished", 14), (11, "finished", 6), (12, "finished", 4)],
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM capture_file WHERE material_id=?", ("10",)
                ).fetchone(),
                (0,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT active FROM production_defect WHERE id='source-defect'"
                ).fetchone(),
                (0,),
            )
            connection.close()

            source_depth = profile.cameras[1].storage_root / "10" / "3d" / "1.npz"
            target_depth = profile.cameras[1].storage_root / "11" / "3d" / "0.npz"
            self.assertTrue(source_depth.is_file())
            self.assertTrue(target_depth.is_file())
            self.assertTrue(target_depth.samefile(source_depth))
            metadata = json.loads(
                (profile.cameras[1].storage_root / "11" / "json" / "0.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(metadata["coilId"], "11")
            self.assertEqual(metadata["sequenceNo"], 1)
            self.assertEqual(metadata["boundaryRepair"]["referenceCamera"], "C4")
            self.assertEqual(metadata["frameArtifact"]["materialId"], "11")
            self.assertTrue(backup.is_file())


if __name__ == "__main__":
    unittest.main()
