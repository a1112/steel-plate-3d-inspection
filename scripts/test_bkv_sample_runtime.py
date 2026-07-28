from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from scripts.build_bkv_sample_runtime import build_sample_runtime_manifest, main


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class BkvSampleRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.sample = self.root / "sample-data" / "bkv" / "7"
        entries = []
        for camera_id in range(1, 7):
            for frame_no in range(2):
                image = (
                    self.sample
                    / f"camera-{camera_id}"
                    / "2D"
                    / f"{frame_no:04d}.jpg"
                )
                image.parent.mkdir(parents=True, exist_ok=True)
                Image.new("L", (8, 4), camera_id + frame_no).save(
                    image, format="JPEG"
                )
                depth = (
                    self.sample
                    / f"camera-{camera_id}"
                    / "3D"
                    / f"{frame_no:04d}.npz"
                )
                depth.parent.mkdir(parents=True, exist_ok=True)
                depth.write_bytes(f"npz-{camera_id}-{frame_no}".encode())
                entries.append(
                    {
                        "status": "ok",
                        "camera_id": camera_id,
                        "legacy_seq_no": 7,
                        "frame_no": frame_no,
                        "shape": [4, 8],
                        "output_relative_path": depth.relative_to(
                            self.sample
                        ).as_posix(),
                        "output_sha256": _sha256(depth),
                    }
                )
        (self.sample / "manifest.json").write_text(
            json.dumps(
                {
                    "schema": "steel.bkv-depth-sample.v1",
                    "format_version": "bkv-depth-v1",
                    "legacy_seq_no": 7,
                    "camera_count": 6,
                    "frames_per_camera": 2,
                    "frame_count": 12,
                    "unit": "legacy-unknown",
                    "invalid_sentinel": -1_000_000.0,
                    "entries": entries,
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_builds_single_material_runtime_with_project_relative_artifacts(self) -> None:
        manifest = build_sample_runtime_manifest(
            project_root=self.root, sample_root=self.sample
        )
        self.assertEqual(manifest["batchId"], "sample-7")
        self.assertEqual(manifest["materialCount"], 1)
        self.assertFalse(manifest["previewRequired"])
        material = manifest["materials"][0]
        self.assertEqual(material["legacySeqNo"], 7)
        self.assertEqual(material["legacyDeclaredDefectCount"], 0)
        self.assertEqual(len(material["cameras"]), 6)
        self.assertTrue(
            material["cameras"][0]["twoDFrames"][0]["path"].startswith(
                "sample-data/bkv/7/"
            )
        )
        self.assertEqual(material["cameras"][5]["npzFrameCount"], 2)

    def test_check_detects_a_stale_committed_manifest(self) -> None:
        output = self.sample / "bkv-runtime-manifest.json"
        output.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "stale"):
            main(
                [
                    "--project-root",
                    str(self.root),
                    "--sample-root",
                    str(self.sample),
                    "--output",
                    str(output),
                    "--check",
                ]
            )


if __name__ == "__main__":
    unittest.main()
