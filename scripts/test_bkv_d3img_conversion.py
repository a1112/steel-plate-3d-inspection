import hashlib
import json
import struct
import tempfile
import unittest
from pathlib import Path

import numpy as np


HEADER_SIZE = 84
SENTINEL = np.float32(-1_000_000.0)


def write_fixture(path: Path, depth: np.ndarray, seq_no: int = 1_893_700) -> None:
    height, width = depth.shape
    header = bytearray(HEADER_SIZE)
    header[:8] = b"3DImg\x00T\x00"
    struct.pack_into("<i", header, 8, seq_no)
    struct.pack_into("<I", header, 20, height)
    struct.pack_into("<I", header, 24, width)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(header) + depth.astype("<f4", copy=False).tobytes())


class BkvD3ImgConversionTests(unittest.TestCase):
    def test_convert_file_writes_standard_npz(self) -> None:
        from scripts.convert_bkv_d3img import convert_file

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "CamImageSource3" / "1893700" / "3D" / "0042.d3img"
            output = root / "output" / "CamImageSource3" / "1893700" / "3D" / "0042.npz"
            depth = np.array([[1.25, SENTINEL], [3.5, np.nan]], dtype=np.float32)
            write_fixture(source, depth)

            record = convert_file(source, output)

            self.assertEqual(record["status"], "ok")
            self.assertEqual(record["camera_id"], 3)
            self.assertEqual(record["legacy_seq_no"], 1_893_700)
            self.assertEqual(record["frame_no"], 42)
            self.assertEqual(record["source_sha256"], hashlib.sha256(source.read_bytes()).hexdigest())
            self.assertTrue(output.is_file())

            with np.load(output, allow_pickle=False) as artifact:
                self.assertEqual(
                    set(artifact.files),
                    {
                        "depth",
                        "valid_mask",
                        "format_version",
                        "camera_id",
                        "legacy_seq_no",
                        "frame_no",
                        "invalid_sentinel",
                        "coordinate_space",
                        "unit",
                        "source_sha256",
                    },
                )
                np.testing.assert_array_equal(artifact["depth"], depth)
                np.testing.assert_array_equal(
                    artifact["valid_mask"],
                    np.array([[True, False], [True, False]], dtype=np.bool_),
                )
                self.assertEqual(artifact["depth"].dtype, np.dtype("float32"))
                self.assertEqual(artifact["valid_mask"].dtype, np.dtype("bool"))
                self.assertEqual(str(artifact["format_version"]), "bkv-depth-v1")
                self.assertEqual(str(artifact["coordinate_space"]), "legacy-camera-raw")
                self.assertEqual(str(artifact["unit"]), "legacy-unknown")
                self.assertEqual(int(artifact["camera_id"]), 3)
                self.assertEqual(int(artifact["legacy_seq_no"]), 1_893_700)
                self.assertEqual(int(artifact["frame_no"]), 42)

    def test_parse_depth_rejects_truncated_payload(self) -> None:
        from scripts.convert_bkv_d3img import D3ImgFormatError, parse_depth

        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "CamImageSource1" / "1893700" / "3D" / "0001.d3img"
            write_fixture(source, np.ones((2, 3), dtype=np.float32))
            source.write_bytes(source.read_bytes()[:-1])

            with self.assertRaisesRegex(D3ImgFormatError, "file size mismatch"):
                parse_depth(source)

    def test_convert_batch_filters_range_and_writes_validated_manifest(self) -> None:
        from scripts.convert_bkv_d3img import convert_batch

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_root = root / "source"
            output_root = root / "output"
            included = [
                source_root / "CamImageSource1" / "1893700" / "3D" / "0001.d3img",
                source_root / "CamImageSource2" / "1893710" / "3D" / "0012.d3img",
            ]
            excluded = source_root / "CamImageSource1" / "1893711" / "3D" / "0002.d3img"
            for index, path in enumerate([*included, excluded], start=1):
                write_fixture(path, np.array([[index, SENTINEL]], dtype=np.float32), int(path.parents[1].name))

            summary = convert_batch(source_root, output_root, seq_start=1_893_700, seq_end=1_893_710)

            self.assertEqual(summary["files_scanned"], 2)
            self.assertEqual(summary["ok"], 2)
            self.assertEqual(summary["error"], 0)
            manifest_path = output_root / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["format_version"], "bkv-depth-v1")
            self.assertEqual(manifest["files_scanned"], 2)
            self.assertEqual(
                [entry["source_relative_path"] for entry in manifest["entries"]],
                [
                    "CamImageSource1/1893700/3D/0001.d3img",
                    "CamImageSource2/1893710/3D/0012.d3img",
                ],
            )
            for entry in manifest["entries"]:
                self.assertEqual(entry["status"], "ok")
                artifact_path = output_root / Path(entry["output_relative_path"])
                self.assertTrue(artifact_path.is_file())
                self.assertEqual(hashlib.sha256(artifact_path.read_bytes()).hexdigest(), entry["output_sha256"])
                with np.load(artifact_path, allow_pickle=False) as artifact:
                    self.assertEqual(str(artifact["source_sha256"]), entry["source_sha256"])
                    self.assertEqual(int(artifact["valid_mask"].sum()), entry["valid_points"])

            first_output = output_root / "CamImageSource1" / "1893700" / "3D" / "0001.npz"
            first_output.write_bytes(b"stale")
            rerun = convert_batch(source_root, output_root, seq_start=1_893_700, seq_end=1_893_710)
            self.assertEqual(rerun["error"], 0)
            with np.load(first_output, allow_pickle=False) as artifact:
                self.assertEqual(str(artifact["format_version"]), "bkv-depth-v1")
            self.assertEqual(list(output_root.rglob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
