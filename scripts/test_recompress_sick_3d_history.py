from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
import zipfile

import numpy as np

from scripts.recompress_sick_3d_history import run_event_reconciliation, run_migration


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_metadata(path: Path, camera_id: str, depth_hash: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schema": "steel.sick-frame.v1",
                "cameraId": camera_id,
                "checksums": {"lg3d3d": depth_hash, "steelDepth": depth_hash},
                "frameArtifact": {
                    "checksums": {"lg3d3d": depth_hash, "steelDepth": depth_hash}
                },
            }
        ),
        encoding="utf-8",
    )


class RecompressSick3dHistoryTests(unittest.TestCase):
    def test_parallel_migration_rewrites_stored_npz_and_updates_references(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            storage_root = root / "central"
            c1 = root / "C1"
            c2 = root / "C2"
            profile = root / "capture.json"
            profile.write_text(
                json.dumps(
                    {
                        "storageRoot": str(storage_root),
                        "cameras": [
                            {"id": "C1", "storageRoot": str(c1)},
                            {"id": "C2", "storageRoot": str(c2)},
                        ],
                    }
                ),
                encoding="utf-8",
            )
            source = np.arange(4096, dtype=np.uint16).reshape(64, 64)
            paths = []
            for camera_root, compressed in ((c1, False), (c2, True)):
                depth = camera_root / "7" / "3d" / "0.npz"
                depth.parent.mkdir(parents=True)
                if compressed:
                    np.savez_compressed(depth, array=source)
                else:
                    np.savez(depth, array=source)
                write_metadata(
                    camera_root / "7" / "json" / "0.json",
                    camera_root.name,
                    file_hash(depth),
                )
                paths.append(depth)
            event = storage_root / "7" / "events" / "frame-committed" / "000000000001.json"
            event.parent.mkdir(parents=True)
            event.write_text(
                json.dumps(
                    {
                        "schema": "steel.capture-frame-committed.v1",
                        "frames": [
                            {
                                "cameraId": path.parents[2].name,
                                "storageIndex": 0,
                                "checksums": {"lg3d3d": file_hash(path), "steelDepth": file_hash(path)},
                            }
                            for path in paths
                        ],
                        "eventHash": "stale",
                    }
                ),
                encoding="utf-8",
            )

            report = run_migration(profile, workers=4, apply=True, progress_every=0)

            self.assertEqual(report["status"], "complete")
            self.assertEqual(report["counts"]["rewritten"], 1)
            self.assertEqual(report["counts"]["already-compressed"], 1)
            for path in paths:
                with zipfile.ZipFile(path) as archive:
                    self.assertTrue(
                        all(item.compress_type == zipfile.ZIP_DEFLATED for item in archive.infolist())
                    )
                with np.load(path, allow_pickle=False) as archive:
                    np.testing.assert_array_equal(archive["array"], source)
                metadata = json.loads(
                    (path.parent.parent / "json" / "0.json").read_text(encoding="utf-8")
                )
                if path == paths[0]:
                    self.assertEqual(metadata["depthCompression"], "zip-deflate")
                else:
                    self.assertNotIn("depthCompression", metadata)
                self.assertEqual(metadata["checksums"]["steelDepth"], file_hash(path))
                self.assertEqual(
                    metadata["frameArtifact"]["checksums"]["lg3d3d"], file_hash(path)
                )
            updated_event = json.loads(event.read_text(encoding="utf-8"))
            self.assertNotEqual(updated_event["eventHash"], "stale")
            self.assertEqual(
                {frame["checksums"]["steelDepth"] for frame in updated_event["frames"]},
                {file_hash(path) for path in paths},
            )

    def test_dry_run_does_not_modify_archive_or_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            camera = root / "C1"
            central = root / "central"
            profile = root / "capture.json"
            profile.write_text(
                json.dumps(
                    {
                        "storageRoot": str(central),
                        "cameras": [{"id": "C1", "storageRoot": str(camera)}],
                    }
                ),
                encoding="utf-8",
            )
            depth = camera / "8" / "3d" / "0.npz"
            depth.parent.mkdir(parents=True)
            np.savez(depth, array=np.ones((2, 3), dtype=np.uint16))
            metadata = camera / "8" / "json" / "0.json"
            write_metadata(metadata, "C1", file_hash(depth))
            before_depth = depth.read_bytes()
            before_metadata = metadata.read_bytes()

            report = run_migration(profile, workers=2, apply=False, progress_every=0)

            self.assertEqual(report["counts"]["would-rewrite"], 1)
            self.assertEqual(depth.read_bytes(), before_depth)
            self.assertEqual(metadata.read_bytes(), before_metadata)

    def test_flow_shards_are_disjoint_and_complete(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            camera = root / "C1"
            central = root / "central"
            profile = root / "capture.json"
            profile.write_text(
                json.dumps(
                    {
                        "storageRoot": str(central),
                        "cameras": [{"id": "C1", "storageRoot": str(camera)}],
                    }
                ),
                encoding="utf-8",
            )
            for flow_id in (7, 8, 9, 10):
                depth = camera / str(flow_id) / "3d" / "0.npz"
                depth.parent.mkdir(parents=True)
                np.savez(depth, array=np.ones((2, 3), dtype=np.uint16))
                write_metadata(
                    camera / str(flow_id) / "json" / "0.json",
                    "C1",
                    file_hash(depth),
                )

            reports = [
                run_migration(
                    profile,
                    workers=2,
                    apply=False,
                    shard_count=2,
                    shard_index=index,
                    progress_every=0,
                )
                for index in range(2)
            ]

            self.assertEqual([report["framesDiscovered"] for report in reports], [2, 2])
            self.assertEqual(sum(report["framesDiscovered"] for report in reports), 4)

    def test_event_only_pass_uses_current_metadata_checksum(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            camera = root / "C1"
            central = root / "central"
            profile = root / "capture.json"
            profile.write_text(
                json.dumps(
                    {
                        "storageRoot": str(central),
                        "cameras": [{"id": "C1", "storageRoot": str(camera)}],
                    }
                ),
                encoding="utf-8",
            )
            depth = camera / "12" / "3d" / "0.npz"
            depth.parent.mkdir(parents=True)
            np.savez_compressed(depth, array=np.ones((2, 3), dtype=np.uint16))
            metadata = camera / "12" / "json" / "0.json"
            write_metadata(metadata, "C1", file_hash(depth))
            event = central / "12" / "events" / "frame-committed" / "000000000001.json"
            event.parent.mkdir(parents=True)
            event.write_text(
                json.dumps(
                    {
                        "frames": [
                            {
                                "cameraId": "C1",
                                "storageIndex": 0,
                                "metadataPath": str(metadata),
                                "checksums": {},
                            }
                        ],
                        "eventHash": "stale",
                    }
                ),
                encoding="utf-8",
            )

            report = run_event_reconciliation(profile, workers=2, apply=True)

            self.assertEqual(report["status"], "complete")
            self.assertEqual(report["framesUpdated"], 1)
            payload = json.loads(event.read_text(encoding="utf-8"))
            self.assertEqual(payload["frames"][0]["checksums"]["steelDepth"], file_hash(depth))
            self.assertNotEqual(payload["eventHash"], "stale")


if __name__ == "__main__":
    unittest.main()
