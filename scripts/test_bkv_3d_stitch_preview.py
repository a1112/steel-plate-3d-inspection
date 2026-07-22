import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np


def write_npz(root: Path, camera: int, sequence: int, frame: int, depth: np.ndarray, mask: np.ndarray) -> Path:
    path = root / f"CamImageSource{camera}" / str(sequence) / "3D" / f"{frame:04d}.npz"
    path.parent.mkdir(parents=True, exist_ok=True)
    source_hash = hashlib.sha256(f"camera={camera};sequence={sequence};frame={frame}".encode()).hexdigest()
    np.savez_compressed(
        path,
        depth=depth.astype(np.float32),
        valid_mask=mask.astype(np.bool_),
        format_version=np.asarray("bkv-depth-v1"),
        camera_id=np.asarray(camera, dtype=np.int16),
        legacy_seq_no=np.asarray(sequence, dtype=np.int64),
        frame_no=np.asarray(frame, dtype=np.int32),
        invalid_sentinel=np.asarray(-1_000_000.0, dtype=np.float32),
        coordinate_space=np.asarray("legacy-camera-raw"),
        unit=np.asarray("legacy-unknown"),
        source_sha256=np.asarray(source_hash),
    )
    return path


def write_sequence(root: Path, sequence: int = 1_893_700, frame_count: int = 2) -> None:
    for camera in range(1, 7):
        for frame in range(1, frame_count + 1):
            rows = camera + 2
            depth = (
                np.float32(camera * 100)
                + np.arange(rows, dtype=np.float32)[:, None] * np.float32(0.25)
                + np.arange(4, dtype=np.float32)[None, :]
                + np.float32(frame * 0.1)
            )
            mask = np.ones(depth.shape, dtype=np.bool_)
            if camera == 1 and frame == 1:
                mask[0, 0] = False
                depth[0, 0] = np.float32(-1_000_000.0)
            write_npz(root, camera, sequence, frame, depth, mask)


class Bkv3DStitchPreviewTests(unittest.TestCase):
    def test_stitch_sequence_synchronizes_resamples_and_centers_six_cameras(self) -> None:
        from scripts.build_bkv_3d_stitch_preview import stitch_sequence

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_sequence(root)

            result = stitch_sequence(root, 1_893_700, rows_per_frame=4, cols_per_camera=3)

            self.assertEqual(result.depth.shape, (8, 18))
            self.assertEqual(result.valid_mask.shape, (8, 18))
            self.assertEqual(result.frame_ids, [1, 2])
            self.assertEqual(result.camera_ids, [1, 2, 3, 4, 5, 6])
            self.assertEqual(result.seam_columns, [0, 3, 6, 9, 12, 15, 18])
            self.assertFalse(result.valid_mask[0, 0])
            for camera_index in range(6):
                sector = result.depth[:, camera_index * 3 : (camera_index + 1) * 3]
                mask = result.valid_mask[:, camera_index * 3 : (camera_index + 1) * 3]
                self.assertAlmostEqual(float(np.median(sector[mask])), 0.0, places=5)

    def test_stitch_sequence_preserves_missing_tail_frame_as_transparent_gap(self) -> None:
        from scripts.build_bkv_3d_stitch_preview import stitch_sequence

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_sequence(root)
            (root / "CamImageSource6" / "1893700" / "3D" / "0002.npz").unlink()

            result = stitch_sequence(root, 1_893_700, rows_per_frame=4, cols_per_camera=3)

            self.assertEqual(result.depth.shape, (8, 18))
            self.assertEqual(result.frame_ids, [1, 2])
            self.assertEqual(result.camera_frame_ids[6], [1])
            self.assertFalse(result.valid_mask[4:, 15:18].any())
            self.assertEqual(len(result.source_paths), 11)

    def test_stitch_sequence_rejects_camera_without_any_frames(self) -> None:
        from scripts.build_bkv_3d_stitch_preview import PreviewInputError, stitch_sequence

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            write_sequence(root)
            for path in (root / "CamImageSource6" / "1893700" / "3D").glob("*.npz"):
                path.unlink()

            with self.assertRaisesRegex(PreviewInputError, "camera 6 has no frames"):
                stitch_sequence(root, 1_893_700, rows_per_frame=4, cols_per_camera=3)

    def test_build_preview_writes_traceable_uncalibrated_artifacts(self) -> None:
        from PIL import Image
        from scripts.build_bkv_3d_stitch_preview import build_preview

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_root = root / "source"
            output_root = root / "output"
            write_sequence(source_root, frame_count=21)

            summary = build_preview(
                source_root,
                output_root,
                1_893_700,
                rows_per_frame=2,
                cols_per_camera=3,
                mesh_rows=10,
                mesh_cols_per_camera=2,
            )

            image_path = output_root / "unwrapped-height.png"
            summary_path = output_root / "stitch-summary.json"
            cylinder_path = output_root / "cylinder-preview.json"
            self.assertTrue(image_path.is_file())
            self.assertTrue(summary_path.is_file())
            self.assertTrue(cylinder_path.is_file())
            with Image.open(image_path) as image:
                self.assertEqual(image.mode, "RGBA")
                self.assertEqual(image.size, (18, 42))
                self.assertLess(image.getpixel((0, 0))[3], 255)

            persisted = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(summary, persisted)
            self.assertEqual(summary["schema"], "bkv-3d-stitch-preview.v1")
            self.assertFalse(summary["calibrated"])
            self.assertEqual(summary["unit"], "legacy-unknown")
            self.assertEqual(summary["coordinate_space"], "uncalibrated-six-camera-preview")
            self.assertEqual(summary["input_count"], 126)
            self.assertEqual(len(summary["inputs"]), 126)
            self.assertEqual(len({item["npz_sha256"] for item in summary["inputs"]}), 126)
            self.assertEqual(summary["seam_columns"], [0, 3, 6, 9, 12, 15, 18])
            self.assertEqual(summary["outputs"]["unwrapped_height"]["sha256"], hashlib.sha256(image_path.read_bytes()).hexdigest())
            self.assertEqual(summary["outputs"]["cylinder_preview"]["sha256"], hashlib.sha256(cylinder_path.read_bytes()).hexdigest())

            cylinder = json.loads(cylinder_path.read_text(encoding="utf-8"))
            self.assertEqual(cylinder["schema"], "bkv-cylinder-preview.v1")
            self.assertEqual(cylinder["longitudinal_samples"], 10)
            self.assertEqual(cylinder["angular_samples"], 12)
            self.assertEqual(cylinder["camera_ids"], [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6])
            self.assertEqual(cylinder["seam_indices"], [0, 2, 4, 6, 8, 10, 12])
            self.assertEqual(len(cylinder["display_residual"]), 10)
            self.assertEqual(len(cylinder["display_residual"][0]), 12)
            self.assertEqual(list(output_root.rglob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
