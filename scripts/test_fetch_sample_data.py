from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.fetch_sample_data import _safe_extract, _verify_inventory


class FetchSampleDataTests(unittest.TestCase):
    def test_verifies_complete_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "data"
            data.mkdir()
            payload = data / "frame.bin"
            payload.write_bytes(b"verified-frame")
            inventory = root / "inventory.json"
            inventory.write_text(
                json.dumps(
                    {
                        "fileCount": 1,
                        "totalBytes": payload.stat().st_size,
                        "files": [
                            {
                                "path": "frame.bin",
                                "size": payload.stat().st_size,
                                "sha256": hashlib.sha256(
                                    payload.read_bytes()
                                ).hexdigest(),
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(_verify_inventory(data, inventory)["fileCount"], 1)
            (data / "extra.bin").write_bytes(b"unexpected")
            with self.assertRaisesRegex(ValueError, "coverage mismatch"):
                _verify_inventory(data, inventory)

    def test_rejects_zip_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "unsafe.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("../escape.txt", "blocked")
            with self.assertRaisesRegex(ValueError, "unsafe ZIP member"):
                _safe_extract(archive, root / "output")

    def test_extracts_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "safe.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("sample-data/frame.bin", b"frame")
            destination = root / "output"
            _safe_extract(archive, destination)
            self.assertEqual(
                (destination / "sample-data" / "frame.bin").read_bytes(),
                b"frame",
            )


if __name__ == "__main__":
    unittest.main()
