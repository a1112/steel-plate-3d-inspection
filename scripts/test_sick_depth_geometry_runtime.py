from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.sick_capture.depth_geometry_runtime import (
    DepthGeometryConfigChanged,
    config_checkpoint,
    load_depth_geometry_config_snapshot,
)


class SickDepthGeometryRuntimeTests(unittest.TestCase):
    def test_mutable_config_overrides_seed_and_change_cancels(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            site = root / "site"
            state = root / "state"
            site.mkdir()
            (site / "capture.json").write_text("{}", encoding="utf-8")
            (site / "algorithm.json").write_text(
                json.dumps(
                    {
                        "depthGeometry": {
                            "schema": "steel.sick-depth-geometry-config.v1",
                            "revision": 1,
                        }
                    }
                ),
                encoding="utf-8",
            )
            mutable = state / "config" / "algorithm" / "depth-geometry.json"
            mutable.parent.mkdir(parents=True)
            mutable.write_text(
                json.dumps(
                    {
                        "schema": "steel.sick-depth-geometry-config.v1",
                        "revision": 2,
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"STEEL_RUNTIME_STATE_ROOT": str(state)}):
                snapshot = load_depth_geometry_config_snapshot(site / "capture.json")
                self.assertEqual(snapshot.revision, 2)
                gate = config_checkpoint(site / "capture.json", snapshot)
                mutable.write_text(
                    json.dumps(
                        {
                            "schema": "steel.sick-depth-geometry-config.v1",
                            "revision": 3,
                        }
                    ),
                    encoding="utf-8",
                )
                with self.assertRaises(DepthGeometryConfigChanged):
                    gate("next-frame")


if __name__ == "__main__":
    unittest.main()
