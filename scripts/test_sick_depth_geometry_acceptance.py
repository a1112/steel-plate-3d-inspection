from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import sick_depth_geometry_acceptance as acceptance
from scripts.sick_capture.depth_geometry import DepthGeometryConfig


def _write_six_camera_profile(root: Path) -> Path:
    storage_root = root / "storage"
    cameras = []
    for index in range(1, 7):
        camera_root = root / f"camera{index}"
        camera_root.mkdir(parents=True, exist_ok=True)
        cameras.append(
            {
                "cameraIndex": index,
                "id": f"C{index}",
                "key": f"C{index}",
                "serialNumber": f"SN-{index:02d}",
                "model": "RANGER3-60",
                "firmware": "test",
                "ip": f"192.0.2.{index}",
                "role": "test",
                "storageRoot": str(camera_root),
                "enabled": True,
                "nodeOverrides": {},
            }
        )
    payload = {
        "schema": "steel.capture.profile.v2",
        "name": "acceptance-test",
        "driverMode": "sick-gentl",
        "storageRoot": str(storage_root),
        "autoConnect": False,
        "expectedCameras": 6,
        "sick": {
            "ctiPath": "not-installed.cti",
            "ctiSha256": "",
            "deviceScanType": "Linescan3D",
            "expectedDepthFormats": ["Coord3D_C16"],
            "expectedIntensityFormats": ["Mono8"],
        },
        "captureDefaults": {
            "timeoutMs": 1000,
            "steelDetectionEdge": "bottom",
            "steelDetectionTailRows": 32,
            "frameTriggerMode": "free-run",
        },
        "compatibility": {"jpegQuality": 95, "fsync": False},
        "cameras": cameras,
    }
    profile_path = root / "capture.json"
    profile_path.write_text(
        json.dumps(payload, indent=2), encoding="utf-8"
    )
    return profile_path


def _make_material_directories(root: Path, *, highest: int = 31) -> Path:
    profile_path = _write_six_camera_profile(root)
    for index in range(1, 7):
        camera_root = root / f"camera{index}"
        for material_id in range(1, highest + 1):
            (camera_root / str(material_id)).mkdir(parents=True, exist_ok=True)
        (camera_root / "not-a-material").mkdir()
        (camera_root / "0").mkdir()
    # This ID is deliberately absent from one head and must not be selected.
    (root / "camera1" / "999").mkdir()
    return profile_path


class SickDepthGeometryAcceptanceTests(unittest.TestCase):
    def test_common_ids_are_newest_first_and_limited(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            profile_path = _make_material_directories(root)

            values = acceptance.discover_common_material_ids(
                profile_path, limit=30
            )

            self.assertEqual(len(values), 30)
            self.assertEqual(values, [str(value) for value in range(31, 1, -1)])

    def test_runner_is_finite_summarizes_classes_and_writes_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            profile_path = _make_material_directories(root)
            report_path = root / "reports" / "depth-acceptance.json"
            calls: list[tuple[str, int]] = []

            def fake_builder(**kwargs: object) -> dict[str, object]:
                material_id = str(kwargs["material_id"])
                config = kwargs["config"]
                self.assertIsInstance(config, DepthGeometryConfig)
                calls.append((material_id, int(config.max_frames)))
                class_name = acceptance.PROVISIONAL_CLASSES[
                    (31 - int(material_id)) % len(acceptance.PROVISIONAL_CLASSES)
                ]
                return {
                    "state": "ready",
                    "defects": [
                        {
                            "className": class_name,
                            "longitudinalSpanMm": None,
                            "longitudinalMm": None,
                            "areaMm2": None,
                        }
                    ],
                    "cameras": {
                        f"C{index}": {"metric": {"horizontalValid": True}}
                        for index in range(1, 7)
                    },
                }

            with patch.object(
                acceptance, "build_flow_depth_geometry", side_effect=fake_builder
            ):
                report = acceptance.run_acceptance(
                    profile_path,
                    limit=30,
                    max_frames=5,
                    report_path=report_path,
                )

            self.assertEqual(report["status"], "pass")
            self.assertEqual(report["flowCountDiscovered"], 31)
            self.assertEqual(report["flowCountSelected"], 30)
            self.assertEqual(report["successfulFlowCount"], 30)
            self.assertEqual(report["failedFlowCount"], 0)
            self.assertEqual(
                report["materialIds"], [str(value) for value in range(31, 1, -1)]
            )
            self.assertEqual(report["maxFrames"], 5)
            self.assertEqual(
                report["candidateCounts"],
                {name: 30 // 4 + (1 if index < 30 % 4 else 0)
                 for index, name in enumerate(acceptance.PROVISIONAL_CLASSES)},
            )
            self.assertEqual(
                report["horizontalCalibration"]["availabilityRate"], 1.0
            )
            self.assertEqual(report["longitudinalMmNonNullCount"], 0)
            self.assertEqual(report["longitudinalSpanMmNonNullCount"], 0)
            self.assertEqual(report["areaMm2NonNullCount"], 0)
            self.assertEqual(len(calls), 30)
            self.assertEqual([item[0] for item in calls], report["materialIds"])
            self.assertEqual({item[1] for item in calls}, {5})

            self.assertTrue(report_path.is_file())
            saved = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(saved["schema"], acceptance.ACCEPTANCE_SCHEMA)
            self.assertEqual(
                list(report_path.parent.glob(".depth-acceptance.json.*.tmp")), []
            )

    def test_limit_is_never_allowed_to_be_less_than_thirty(self) -> None:
        with self.assertRaises(ValueError):
            acceptance.run_acceptance("does-not-exist.json", limit=29)


if __name__ == "__main__":
    unittest.main()
