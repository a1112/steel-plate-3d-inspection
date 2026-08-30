from __future__ import annotations

import json
import os
import pickle
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

from sick_capture.calibration_pointer import (
    POINTER_SCHEMA,
    calibration_pointer_path,
    resolve_active_array_calibration,
    write_calibration_pointer,
)
from sick_capture.measurement import CALIBRATION_SCHEMA
from sick_capture.paths import rendition_image_path, rendition_metadata_path
import sick_capture.renditions as renditions_module
from sick_capture.renditions import (
    RENDITION_SCHEMA,
    RenditionNotReady,
    _alignment_fit_signature,
    _cached_calibration,
    _cached_foreground_mask,
    _cached_json,
    _cached_sha256_file,
    _load_depth,
    _metadata_records,
    _read_grayscale,
    build_gray_rendition,
    clear_rendition_memory_cache,
    resolve_display_crop,
    row_foreground_mask,
    verify_and_cleanup_legacy_renditions,
)


class ReadableRenditionTests(unittest.TestCase):
    @staticmethod
    def _advance_mtime(path: Path) -> None:
        stat = path.stat()
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))

    def test_processing_state_survives_worker_process_serialization(self) -> None:
        restored = pickle.loads(
            pickle.dumps(RenditionNotReady("alignment-building", processing=True))
        )
        self.assertEqual(restored.reason, "alignment-building")
        self.assertTrue(restored.processing)

    def test_jet_fit_signature_ignores_growing_tail_but_tracks_head_clock(self) -> None:
        first = {
            "quality": {"completeCameras": 6},
            "softSyncAnchors": [{"ordinal": 1}],
            "cameras": {
                "C1": {
                    "headDeviceTime": 10.25,
                    "lineRateHz": 4000.0,
                    "tailDeviceTime": 12.0,
                }
            },
        }
        growing = json.loads(json.dumps(first))
        growing["softSyncAnchors"].append({"ordinal": 2})
        growing["cameras"]["C1"]["tailDeviceTime"] = 18.0
        self.assertEqual(
            _alignment_fit_signature(first),
            _alignment_fit_signature(growing),
        )
        growing["cameras"]["C1"]["headDeviceTime"] = 10.5
        self.assertNotEqual(
            _alignment_fit_signature(first),
            _alignment_fit_signature(growing),
        )

    def test_short_names_and_exactly_two_gray_levels(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            camera_root = Path(directory) / "C1"
            source = camera_root / "42" / "2d" / "0.png"
            source.parent.mkdir(parents=True)
            plane = np.zeros((64, 128), dtype=np.uint8)
            plane[:, 30:100] = 160
            plane[20:30, 60] = 0
            Image.fromarray(plane).save(source)
            metadata = build_gray_rendition(source)

            thumbnail = rendition_image_path(camera_root, "42", "gray", "thumbnail", 0)
            original = rendition_image_path(camera_root, "42", "gray", "original", 0)
            manifest = rendition_metadata_path(camera_root, "42", "gray", 0)
            self.assertEqual(thumbnail.name, "0.jpg")
            self.assertEqual(original.name, "0.jpg")
            self.assertEqual(manifest.name, "0.json")
            self.assertTrue(thumbnail.is_file())
            self.assertTrue(original.is_file())
            self.assertEqual(metadata["levels"].keys(), {"thumbnail", "original"})
            self.assertEqual(
                sorted(path.parent.name for path in (camera_root / "42" / "cache").rglob("*.jpg")),
                ["original", "thumbnail"],
            )
            with Image.open(thumbnail) as image:
                self.assertLessEqual(image.width, 384)
            with Image.open(original) as image:
                self.assertEqual(image.height, 64)

    def test_row_envelope_keeps_dark_defects_inside_material(self) -> None:
        plane = np.zeros((8, 96), dtype=np.uint8)
        plane[:, 20:80] = 180
        plane[3, 45:55] = 0
        mask = row_foreground_mask(plane, [0, 0, 96, 8])
        self.assertTrue(mask[3, 50])
        self.assertFalse(mask[3, 5])

    def test_grayscale_cache_avoids_reads_and_expires_on_mtime_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "0.png"
            first_plane = np.full((16, 24), 80, dtype=np.uint8)
            Image.fromarray(first_plane).save(source)
            clear_rendition_memory_cache()

            with patch(
                "sick_capture.renditions.Image.open",
                wraps=renditions_module.Image.open,
            ) as opened:
                first = _read_grayscale(source)
                second = _read_grayscale(source)
                self.assertEqual(opened.call_count, 1)
            self.assertIs(first, second)
            self.assertFalse(first.flags.writeable)

            Image.fromarray(np.full((16, 24), 170, dtype=np.uint8)).save(source)
            self._advance_mtime(source)
            with patch(
                "sick_capture.renditions.Image.open",
                wraps=renditions_module.Image.open,
            ) as reopened:
                changed = _read_grayscale(source)
                self.assertEqual(reopened.call_count, 1)
            self.assertFalse(np.array_equal(first, changed))

    def test_depth_cache_avoids_npz_reads_and_expires_on_mtime_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "0.npz"
            np.savez(source, depth=np.full((8, 12), 1.25, dtype=np.float32))
            clear_rendition_memory_cache()

            with patch(
                "sick_capture.renditions.np.load",
                wraps=renditions_module.np.load,
            ) as loaded:
                first = _load_depth(source)
                second = _load_depth(source)
                self.assertEqual(loaded.call_count, 1)
            self.assertIs(first, second)
            self.assertFalse(first.flags.writeable)

            np.savez(source, depth=np.full((8, 12), 3.5, dtype=np.float32))
            self._advance_mtime(source)
            with patch(
                "sick_capture.renditions.np.load",
                wraps=renditions_module.np.load,
            ) as reloaded:
                changed = _load_depth(source)
                self.assertEqual(reloaded.call_count, 1)
            self.assertFalse(np.array_equal(first, changed))

    def test_flow_crop_cache_avoids_repeated_frame_reads_and_expires(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "C1" / "11" / "2d" / "0.png"
            source.parent.mkdir(parents=True)
            plane = np.zeros((32, 96), dtype=np.uint8)
            plane[:, 20:76] = 150
            Image.fromarray(plane).save(source)
            clear_rendition_memory_cache()

            with patch(
                "sick_capture.renditions._read_grayscale",
                wraps=renditions_module._read_grayscale,
            ) as read:
                first, _ = resolve_display_crop(source)
                second, _ = resolve_display_crop(source)
                self.assertEqual(read.call_count, 1)
            self.assertEqual(first, second)

            self._advance_mtime(source)
            with patch(
                "sick_capture.renditions._read_grayscale",
                wraps=renditions_module._read_grayscale,
            ) as reread:
                changed, _ = resolve_display_crop(source)
                self.assertEqual(reread.call_count, 1)
            self.assertEqual(first, changed)

    def test_metadata_cache_avoids_json_reads_and_expires_on_mtime_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            flow = Path(directory) / "C1" / "12"
            metadata_root = flow / "json"
            metadata_root.mkdir(parents=True)
            for index in range(2):
                (metadata_root / f"{index}.json").write_text(
                    json.dumps(
                        {
                            "timestamp": 1000 + index,
                            "timestamp_frequency": 100,
                            "height": 16,
                            "width": 24,
                        }
                    ),
                    encoding="utf-8",
                )
            clear_rendition_memory_cache()

            with patch(
                "sick_capture.renditions._read_json",
                wraps=renditions_module._read_json,
            ) as read:
                first = _metadata_records(flow, 0.0)
                second = _metadata_records(flow, 0.0)
                self.assertEqual(read.call_count, 2)
            self.assertIsNot(first, second)
            self.assertEqual(first[0]["storageIndex"], second[0]["storageIndex"])

            changed_path = metadata_root / "1.json"
            changed_path.write_text(
                json.dumps(
                    {
                        "timestamp": 2000,
                        "timestamp_frequency": 100,
                        "height": 16,
                        "width": 24,
                    }
                ),
                encoding="utf-8",
            )
            self._advance_mtime(changed_path)
            with patch(
                "sick_capture.renditions._read_json",
                wraps=renditions_module._read_json,
            ) as reread:
                changed = _metadata_records(flow, 0.0)
                # The changed record is decoded again; the untouched record
                # is served by the path-signature JSON cache.
                self.assertEqual(reread.call_count, 1)
            self.assertNotEqual(first[1]["start"], changed[1]["start"])

    def test_foreground_mask_cache_avoids_recompute_and_expires(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "0.png"
            plane = np.zeros((24, 64), dtype=np.uint8)
            plane[:, 12:52] = 160
            Image.fromarray(plane).save(source)
            crop = [0, 0, 64, 24]
            clear_rendition_memory_cache()

            with patch(
                "sick_capture.renditions.row_foreground_mask",
                wraps=renditions_module.row_foreground_mask,
            ) as build_mask:
                first = _cached_foreground_mask(source, crop)
                second = _cached_foreground_mask(source, crop)
                self.assertEqual(build_mask.call_count, 1)
            self.assertIs(first, second)
            self.assertFalse(first.flags.writeable)

            self._advance_mtime(source)
            with patch(
                "sick_capture.renditions.row_foreground_mask",
                wraps=renditions_module.row_foreground_mask,
            ) as rebuilt:
                changed = _cached_foreground_mask(source, crop)
                self.assertEqual(rebuilt.call_count, 1)
            self.assertTrue(np.array_equal(first, changed))

    def test_alignment_json_cache_is_defensive_and_expires(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "alignment.json"
            source.write_text(
                json.dumps({"quality": {"geometrySynchronized": True}}),
                encoding="utf-8",
            )
            clear_rendition_memory_cache()

            with patch(
                "sick_capture.renditions._read_json",
                wraps=renditions_module._read_json,
            ) as read:
                first = _cached_json(source)
                first["quality"]["geometrySynchronized"] = False
                second = _cached_json(source)
                self.assertEqual(read.call_count, 1)
            self.assertTrue(second["quality"]["geometrySynchronized"])

            source.write_text(
                json.dumps({"quality": {"geometrySynchronized": False}}),
                encoding="utf-8",
            )
            self._advance_mtime(source)
            with patch(
                "sick_capture.renditions._read_json",
                wraps=renditions_module._read_json,
            ) as reread:
                changed = _cached_json(source)
                self.assertEqual(reread.call_count, 1)
            self.assertFalse(changed["quality"]["geometrySynchronized"])

    def test_calibration_cache_is_defensive_and_expires(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "calibration.json"

            def write_calibration(revision: str) -> None:
                source.write_text(
                    json.dumps(
                        {
                            "schema": CALIBRATION_SCHEMA,
                            "revision": revision,
                            "approved": True,
                            "cameras": {"C1": {"serialNumber": "1"}},
                        }
                    ),
                    encoding="utf-8",
                )

            write_calibration("R1")
            clear_rendition_memory_cache()
            with patch(
                "sick_capture.renditions._load_calibration",
                wraps=renditions_module._load_calibration,
            ) as load:
                first = _cached_calibration(source)
                first["revision"] = "caller-mutation"
                second = _cached_calibration(source)
                self.assertEqual(load.call_count, 1)
            self.assertEqual(second["revision"], "R1")

            write_calibration("R2")
            self._advance_mtime(source)
            with patch(
                "sick_capture.renditions._load_calibration",
                wraps=renditions_module._load_calibration,
            ) as reload:
                changed = _cached_calibration(source)
                self.assertEqual(reload.call_count, 1)
            self.assertEqual(changed["revision"], "R2")

    def test_sha256_cache_avoids_hashing_and_expires_on_mtime_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "metadata.json"
            source.write_bytes(b"metadata-v1")
            clear_rendition_memory_cache()

            with patch(
                "sick_capture.renditions.sha256_file",
                wraps=renditions_module.sha256_file,
            ) as hashed:
                first = _cached_sha256_file(source)
                second = _cached_sha256_file(source)
                self.assertEqual(hashed.call_count, 1)
            self.assertEqual(first, second)

            source.write_bytes(b"metadata-v2")
            self._advance_mtime(source)
            with patch(
                "sick_capture.renditions.sha256_file",
                wraps=renditions_module.sha256_file,
            ) as rehashed:
                changed = _cached_sha256_file(source)
                self.assertEqual(rehashed.call_count, 1)
            self.assertNotEqual(first, changed)

    def test_cleanup_waits_for_complete_two_level_gray_and_jet(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            camera_root = root / "C1"
            flow = camera_root / "7"
            (flow / "2d").mkdir(parents=True)
            Image.fromarray(np.full((64, 96), 120, dtype=np.uint8)).save(flow / "2d" / "0.png")
            central = root / "central"
            (central / "7").mkdir(parents=True)
            (central / "7" / "flow.json").write_text(
                json.dumps({"state": "closed"}), encoding="utf-8"
            )
            legacy = flow / "cache" / ("a" * 64 + "-w320.jpg")
            legacy.parent.mkdir(parents=True)
            legacy.write_bytes(b"legacy")
            surface = flow / "jet" / "surface.jpg"
            surface.parent.mkdir(parents=True)
            surface.write_bytes(b"legacy")

            incomplete = verify_and_cleanup_legacy_renditions(
                {"C1": camera_root}, central, "7"
            )
            self.assertFalse(incomplete["verified"])
            self.assertTrue(legacy.is_file())

            for modality in ("gray", "jet"):
                for level in ("thumbnail", "original"):
                    path = rendition_image_path(camera_root, "7", modality, level, 0)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b"\xff\xd8fixture")
                manifest = rendition_metadata_path(camera_root, "7", modality, 0)
                manifest.parent.mkdir(parents=True, exist_ok=True)
                manifest.write_text(
                    json.dumps(
                        {
                            "schema": RENDITION_SCHEMA,
                            "modality": modality,
                            "storageIndex": 0,
                        }
                    ),
                    encoding="utf-8",
                )
            complete = verify_and_cleanup_legacy_renditions(
                {"C1": camera_root}, central, "7"
            )
            self.assertTrue(complete["verified"])
            self.assertFalse(legacy.exists())
            self.assertFalse(surface.exists())


class CalibrationPointerTests(unittest.TestCase):
    @staticmethod
    def _calibration(path: Path, revision: str) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "schema": CALIBRATION_SCHEMA,
                    "revision": revision,
                    "approved": True,
                    "cameras": {
                        f"C{index}": {
                            "serialNumber": str(index),
                            "localToArray": np.eye(4).tolist(),
                        }
                        for index in range(1, 7)
                    },
                }
            ),
            encoding="utf-8",
        )
        return path

    def test_pointer_switch_and_invalid_pointer_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = self._calibration(root / "base.json", "R1")
            candidate = self._calibration(root / "candidate.json", "R2")
            pointer = write_calibration_pointer(
                root / "storage", candidate, previous_path=base
            )
            self.assertEqual(pointer, calibration_pointer_path(root / "storage"))
            active = resolve_active_array_calibration(root / "storage", base)
            self.assertEqual(active["revision"], "R2")

            value = json.loads(pointer.read_text(encoding="utf-8"))
            self.assertEqual(value["schema"], POINTER_SCHEMA)
            value["active"]["sha256"] = "0" * 64
            pointer.write_text(json.dumps(value), encoding="utf-8")
            fallback = resolve_active_array_calibration(root / "storage", base)
            self.assertEqual(fallback["revision"], "R1")
            self.assertEqual(fallback["source"], "configured-fallback")
            self.assertIn("SHA-256", fallback["pointerError"])


if __name__ == "__main__":
    unittest.main()
