import hashlib
import json
import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np


HEADER_SIZE = 84
HEADER_STRUCT = struct.Struct("<6sh5if5i3B29s")
SENTINEL = np.float32(-1_000_000.0)


def write_fixture(
    path: Path,
    depth: np.ndarray,
    seq_no: int = 1_893_700,
    *,
    image_index: int = 42,
    image_sequence: int = 95_323,
    scale_x: float = 0.2782926,
    left: int = 992,
    right: int | None = None,
    start_length: int = 95_323,
    end_length: int = 95_323,
    start_position: int = 992,
    camera_number: int = 3,
    data_type: int = 1,
) -> None:
    height, width = depth.shape
    header = HEADER_STRUCT.pack(
        b"3DImg\0",
        HEADER_SIZE,
        seq_no,
        image_index,
        image_sequence,
        width,
        height,
        scale_x,
        left,
        left + width if right is None else right,
        start_length,
        end_length,
        start_position,
        camera_number,
        data_type,
        4,
        bytes(29),
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + depth.astype("<f4", copy=False).tobytes())


class BkvD3ImgConversionTests(unittest.TestCase):
    def test_parse_identifiers_accepts_unc_camera_share(self) -> None:
        from pathlib import Path

        from scripts.convert_bkv_d3img import parse_identifiers

        source = Path(r"\\10.5.241.17\CamImageSource6\1913329\3D\0007.d3img")
        self.assertEqual(parse_identifiers(source), (6, 1913329, 7))

    def test_history_materializer_publishes_intensity_and_converted_depth(self) -> None:
        from scripts.materialize_bkv_record import _materialize_camera

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_root = root / "source"
            intensity = source_root / "CamImageSource1" / "1893700" / "2D"
            depth = intensity.parent / "3D"
            intensity.mkdir(parents=True)
            (intensity / "0001.jpg").write_bytes(b"jpeg-fixture")
            write_fixture(
                depth / "0001.d3img",
                np.array([[1.0, SENTINEL], [2.0, 3.0]], dtype=np.float32),
                camera_number=1,
            )
            candidate = SimpleNamespace(
                manifest={
                    "recordId": 1_893_700,
                    "cameras": [
                        {"cameraId": 1, "sourceDirectory": str(intensity)}
                    ],
                }
            )
            staged = root / "staged"

            camera_id, files, _hashes, _size = _materialize_camera(
                candidate, 1, str(source_root), 10, False, staged
            )

            self.assertEqual(camera_id, "C1")
            self.assertEqual([item["kind"] for item in files], ["intensity", "depth"])
            depth_artifact = staged / files[1]["path"]
            self.assertTrue(depth_artifact.is_file())
            with np.load(depth_artifact, allow_pickle=False) as artifact:
                np.testing.assert_array_equal(
                    artifact["depth"],
                    np.array([[1.0, SENTINEL], [2.0, 3.0]], dtype=np.float32),
                )

    def test_parse_d3img_reads_complete_header_and_preserves_asymmetric_shape(self) -> None:
        from scripts.convert_bkv_d3img import parse_d3img

        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "CamImageSource3" / "1893700" / "3D" / "0042.d3img"
            depth = np.arange(6, dtype=np.float32).reshape(2, 3)
            write_fixture(source, depth)

            parsed = parse_d3img(source)

            self.assertEqual(parsed.header.tag, b"3DImg\0")
            self.assertEqual(parsed.header.head_size, 84)
            self.assertEqual(parsed.header.steel_no, 1_893_700)
            self.assertEqual(parsed.header.image_index, 42)
            self.assertEqual(parsed.header.image_sequence, 95_323)
            self.assertEqual(parsed.header.width, 3)
            self.assertEqual(parsed.header.height, 2)
            self.assertAlmostEqual(parsed.header.scale_x, 0.2782926, places=6)
            self.assertEqual(parsed.header.left, 992)
            self.assertEqual(parsed.header.right, 995)
            self.assertEqual(parsed.header.start_length, 95_323)
            self.assertEqual(parsed.header.end_length, 95_323)
            self.assertEqual(parsed.header.start_position, 992)
            self.assertEqual(parsed.header.camera_number, 3)
            self.assertEqual(parsed.header.data_type, 1)
            self.assertEqual(parsed.header.pixel_size, 4)
            self.assertEqual(parsed.header.reserve, bytes(29))
            self.assertEqual(parsed.depth.shape, (2, 3))
            np.testing.assert_array_equal(parsed.depth, depth)

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

    def test_parse_depth_rejects_trailing_payload(self) -> None:
        from scripts.convert_bkv_d3img import D3ImgFormatError, parse_depth

        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "CamImageSource1" / "1893700" / "3D" / "0001.d3img"
            write_fixture(source, np.ones((2, 3), dtype=np.float32))
            source.write_bytes(source.read_bytes() + b"\0")

            with self.assertRaisesRegex(D3ImgFormatError, "file size mismatch"):
                parse_depth(source)

    def test_parse_header_rejects_invalid_contract_fields(self) -> None:
        from scripts.convert_bkv_d3img import D3ImgFormatError, parse_header

        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "CamImageSource1" / "1893700" / "3D" / "0001.d3img"
            write_fixture(source, np.ones((2, 3), dtype=np.float32))
            valid = source.read_bytes()
            with self.assertRaisesRegex(D3ImgFormatError, "shorter than 84-byte header"):
                parse_header(b"3DImg\0")
            cases = [
                ("magic", 0, b"BADImg", "unexpected d3img magic"),
                ("head size", 6, struct.pack("<h", 82), "unexpected d3img header size"),
                ("negative width", 20, struct.pack("<i", -3), "invalid dimensions"),
                ("oversized width", 20, struct.pack("<i", 20_001), "invalid dimensions"),
                ("zero height", 24, struct.pack("<i", 0), "invalid dimensions"),
                ("pixel size", 54, b"\x02", "unexpected d3img pixel size"),
            ]
            for name, offset, replacement, message in cases:
                with self.subTest(name=name):
                    mutated = bytearray(valid)
                    mutated[offset : offset + len(replacement)] = replacement
                    with self.assertRaisesRegex(D3ImgFormatError, message):
                        parse_header(bytes(mutated))

    def test_convert_file_can_write_optional_rgba_preview(self) -> None:
        from PIL import Image
        from scripts.convert_bkv_d3img import convert_file

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "CamImageSource1" / "1893700" / "3D" / "0001.d3img"
            output = root / "output" / "CamImageSource1" / "1893700" / "3D" / "0001.npz"
            preview = output.with_suffix(".png")
            write_fixture(source, np.array([[1.0, 2.0, SENTINEL]], dtype=np.float32))

            record = convert_file(source, output, preview_output=preview)

            self.assertEqual(record["preview_path"], str(preview))
            with Image.open(preview) as image:
                self.assertEqual(image.mode, "RGBA")
                self.assertEqual(image.size, (3, 1))
                self.assertEqual(image.getpixel((2, 0))[3], 0)

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

    def test_convert_batch_exposes_optional_png_flag(self) -> None:
        from scripts.convert_bkv_d3img import convert_batch, parse_args

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source_root = root / "source"
            output_root = root / "output"
            source = source_root / "CamImageSource1" / "1893700" / "3D" / "0001.d3img"
            write_fixture(source, np.array([[1.0, SENTINEL]], dtype=np.float32))

            args = parse_args(["--src-dir", str(source_root), "--out-dir", str(output_root), "--save-png"])
            self.assertTrue(args.save_png)
            manifest = convert_batch(source_root, output_root, save_png=True)

            preview = output_root / "CamImageSource1" / "1893700" / "3D" / "0001.png"
            self.assertTrue(preview.is_file())
            self.assertEqual(
                manifest["entries"][0]["preview_relative_path"],
                "CamImageSource1/1893700/3D/0001.png",
            )


if __name__ == "__main__":
    unittest.main()
