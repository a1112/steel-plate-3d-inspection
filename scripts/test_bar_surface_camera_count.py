from __future__ import annotations

import unittest

from scripts import bar_surface_reconstruct as subject


class BarSurfaceCameraCountTests(unittest.TestCase):
    @staticmethod
    def six_camera_mesh() -> dict[str, object]:
        positions: list[float] = []
        for camera in range(6):
            positions.extend([75.0, float(camera), 0.0])
        return {
            "cameraCount": 6,
            "positions": positions,
            "validMask": [1] * 6,
        }

    def test_mock_defects_use_mesh_camera_count_without_eight_camera_fallback(self) -> None:
        defects = subject.generate_mock_defects(self.six_camera_mesh(), 14)

        self.assertEqual(len(defects), 14)
        self.assertEqual(
            {row["cameraId"] for row in defects},
            {f"camera{camera}" for camera in range(1, 7)},
        )
        self.assertLessEqual(
            max(int(row["geometry"]["cameraIndex"]) for row in defects),
            6,
        )
        self.assertTrue(
            all(0.0 <= float(row["geometry"]["circumferenceRatio"]) < 1.0 for row in defects)
        )

    def test_mock_defects_reject_mesh_without_authoritative_camera_count(self) -> None:
        mesh = self.six_camera_mesh()
        mesh.pop("cameraCount")

        with self.assertRaisesRegex(ValueError, "mesh cameraCount"):
            subject.generate_mock_defects(mesh, 1)


if __name__ == "__main__":
    unittest.main()
