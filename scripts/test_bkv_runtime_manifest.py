import csv
import hashlib
import json
import tempfile
import unittest
from pathlib import Path


def _write_csv(path: Path, fieldnames: list[str], rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class BkvRuntimeManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.extract = self.root / "extract"
        self.images = self.root / "images"
        self.npz = self.root / "standard"
        self.previews = self.root / "previews"
        self.output = self.root / "bkv-runtime-manifest.json"

        check_fields = [
            "ID", "SeqNo", "SteelID", "SteelType", "Circle", "RcvRadius",
            "RcvLen", "Radius", "Len", "ScaleY", "DefectNum", "Grade",
            "DefectTime", "WallThick",
        ]
        _write_csv(self.extract / "checkrecord.csv", check_fields, [
            {"ID": 10, "SeqNo": 1010, "SteelID": "STEEL-A", "SteelType": "37Mn/2", "RcvLen": 12000, "Radius": 233.5, "DefectNum": 1, "DefectTime": "2025-01-02 03:04:05", "WallThick": 0},
            {"ID": 11, "SeqNo": 1011, "SteelID": "STEEL-B", "SteelType": "37Mn/2", "RcvLen": -1, "Radius": 232.2, "DefectNum": 0, "DefectTime": "2025-01-02 03:05:05", "WallThick": 12.5},
        ])
        defect_fields = ["ID", "CamNo", "DefectNo", "SeqNo", "Class", "Grade", "Confidence", "DefectCycle", "AreaSteel3D", "DepthSteel3D", "ImgIndex"]
        _write_csv(self.extract / "defect.csv", defect_fields, [
            {"ID": 99, "CamNo": 2, "DefectNo": 7, "SeqNo": 1010, "Class": 16, "Grade": 2, "Confidence": 88, "DefectCycle": 1000, "AreaSteel3D": 3, "DepthSteel3D": -7, "ImgIndex": 4},
            {"ID": 10, "CamNo": 3, "DefectNo": 8, "SeqNo": 9999, "Class": 7, "Grade": 1, "Confidence": 70, "DefectCycle": 1000, "AreaSteel3D": 4, "DepthSteel3D": -6, "ImgIndex": 5},
        ])
        _write_csv(self.extract / "defectclass.csv", ["ID", "ClassNo", "ClassName", "Red", "Green", "Blue", "Warn", "Parent"], [
            {"ID": 7, "ClassNo": 7, "ClassName": "外折", "Red": 255, "Green": 0, "Blue": 0, "Warn": 0, "Parent": ""},
            {"ID": 16, "ClassNo": 16, "ClassName": "轧折", "Red": 255, "Green": 0, "Blue": 0, "Warn": 0, "Parent": ""},
        ])
        _write_csv(self.extract / "allexcel.csv", ["ID", "SteelID"], [{"ID": 10, "SteelID": "CONFLICT"}])

        entries = []
        for material in (10, 11):
            for camera in range(1, 7):
                image = self.images / f"CamImageSource{camera}" / str(material) / "2D" / "0000.jpg"
                image.parent.mkdir(parents=True, exist_ok=True)
                image.write_bytes(b"jpeg" + bytes([material, camera]))
                artifact = self.npz / f"CamImageSource{camera}" / str(material) / "3D" / "0000.npz"
                artifact.parent.mkdir(parents=True, exist_ok=True)
                artifact.write_bytes(b"npz" + bytes([material, camera]))
                entries.append({
                    "status": "ok", "camera_id": camera, "legacy_seq_no": material,
                    "frame_no": 0, "output_relative_path": artifact.relative_to(self.npz).as_posix(),
                    "output_sha256": _sha256(artifact),
                })
            preview = self.previews / str(material)
            preview.mkdir(parents=True)
            (preview / "unwrapped-height.png").write_bytes(b"png" + bytes([material]))
            (preview / "cylinder-preview.json").write_text(json.dumps({"schema": "bkv-cylinder-preview.v1", "material": material}), encoding="utf-8")
            (preview / "stitch-summary.json").write_text(json.dumps({"schema": "bkv-3d-stitch-preview.v1", "material": material}), encoding="utf-8")
        self.npz.mkdir(parents=True, exist_ok=True)
        (self.npz / "manifest.json").write_text(json.dumps({"format_version": "bkv-depth-v1", "ok": len(entries), "error": 0, "entries": entries}), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _build(self):
        from scripts.build_bkv_runtime_manifest import build_runtime_manifest
        return build_runtime_manifest(
            data_root=self.root,
            extract_root=self.extract,
            image_root=self.images,
            npz_root=self.npz,
            preview_root=self.previews,
            output_path=self.output,
            seq_start=10,
            seq_end=11,
            expected_cameras=6,
            expected_materials=2,
        )

    def test_builds_traceable_manifest_with_strict_associations(self) -> None:
        manifest = self._build()
        self.assertEqual(manifest["schema"], "bkv-runtime-v1")
        self.assertEqual([item["legacySeqNo"] for item in manifest["materials"]], [10, 11])
        first = manifest["materials"][0]
        self.assertEqual(first["legacyCheckRecordSeqNo"], 1010)
        self.assertEqual(first["defects"][0]["className"], "轧折")
        self.assertEqual(first["wallThicknessMm"], None)
        self.assertEqual(manifest["materials"][1]["lengthMm"], None)
        self.assertEqual(len(first["cameras"]), 6)
        self.assertTrue(all(camera["twoDFrameCount"] == 1 and camera["npzFrameCount"] == 1 for camera in first["cameras"]))
        self.assertEqual(manifest["quarantine"]["unassociatedDefects"][0]["ID"], "10")
        self.assertEqual(manifest["quarantine"]["conflictingAllExcelRows"][0]["SteelID"], "CONFLICT")
        self.assertEqual(json.loads(self.output.read_text(encoding="utf-8")), manifest)

    def test_output_is_idempotent_and_contains_source_hashes(self) -> None:
        first = self._build()
        first_bytes = self.output.read_bytes()
        second = self._build()
        self.assertEqual(first, second)
        self.assertEqual(first_bytes, self.output.read_bytes())
        self.assertEqual(first["sources"]["checkrecord"]["sha256"], _sha256(self.extract / "checkrecord.csv"))
        self.assertEqual(first["materials"][0]["artifacts"]["unwrapped"]["sha256"], _sha256(self.previews / "10" / "unwrapped-height.png"))

    def test_rejects_duplicate_material_identity(self) -> None:
        path = self.extract / "checkrecord.csv"
        with path.open(encoding="utf-8-sig") as handle:
            rows = list(csv.DictReader(handle))
        _write_csv(path, list(rows[0]), rows + [rows[0]])
        with self.assertRaisesRegex(ValueError, "duplicate.*10"):
            self._build()

    def test_rejects_missing_camera_preview_and_npz_coverage(self) -> None:
        cases = (
            (self.images / "CamImageSource6" / "10" / "2D" / "0000.jpg", "camera 6"),
            (self.previews / "10" / "unwrapped-height.png", "preview"),
            (self.npz / "CamImageSource6" / "10" / "3D" / "0000.npz", "NPZ"),
        )
        for path, message in cases:
            with self.subTest(path=path):
                original = path.read_bytes()
                path.unlink()
                with self.assertRaisesRegex(ValueError, message):
                    self._build()
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(original)

    def test_rejects_npz_manifest_path_escape(self) -> None:
        manifest_path = self.npz / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["entries"][0]["output_relative_path"] = "../escape.npz"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "escapes"):
            self._build()


if __name__ == "__main__":
    unittest.main()
