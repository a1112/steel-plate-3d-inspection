import hashlib
import json
import os
import stat
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import bkv_legacy_import as subject


RAR_LISTING = """Name: image_copy/CamImageSource1/1893700/2D/a.jpg
Type: File
Size: 12
CRC32: ABCDEF01

Name: image_copy/CamImageSource6/1893710/3D/a.d3img
Type: File
Size: 24
CRC32: 12345678

Name: image_copy/CamImageSource1/1893699/2D/old.jpg
Type: File
Size: 7
CRC32: 87654321
"""

RAR_LISTING_ZH = """名称: image_copy/CamImageSource1/1893700/2D/a.jpg
类型: 文件
大小: 12
CRC32: ABCDEF01

名称: image_copy/CamImageSource6/1893710/3D/a.d3img
类型: 文件
大小: 24
CRC32: 12345678
"""


class MemberPolicyTests(unittest.TestCase):
    def test_target_sequence_numbers_and_member_filter_are_exact(self):
        self.assertEqual(
            subject.TARGET_SEQ_NOS, tuple(range(1_893_700, 1_893_711))
        )
        self.assertEqual(
            subject.normalize_member(
                "image_copy/CamImageSource1/1893700/2D/a.jpg"
            ),
            "image_copy/CamImageSource1/1893700/2D/a.jpg",
        )
        self.assertIsNone(subject.normalize_member("../escape.jpg"))
        self.assertFalse(
            subject.wanted_image_member(
                "image_copy/CamImageSource1/1893699/2D/a.jpg"
            )
        )
        self.assertTrue(
            subject.wanted_image_member(
                "image_copy/CamImageSource6/1893710/3D/a.d3img"
            )
        )

    def test_member_policy_rejects_absolute_and_non_file_paths(self):
        for value in (
            "/absolute.jpg",
            "C:/absolute.jpg",
            r"C:\absolute.jpg",
            r"\\server\share\file.jpg",
            "image_copy//a.jpg",
            "image_copy/./a.jpg",
            "image_copy/CamImageSource7/1893700/2D/a.jpg",
            "image_copy/CamImageSource1/1893700/2D/a.exe",
        ):
            with self.subTest(value=value):
                if "CamImageSource" in value:
                    self.assertFalse(subject.wanted_image_member(value))
                else:
                    self.assertIsNone(subject.normalize_member(value))

    def test_windows_unsafe_components_and_batch_ids_are_rejected(self):
        unsafe_names = (
            "bad:name.jpg",
            "control\x1f.jpg",
            "trailing.jpg.",
            "trailing.jpg ",
            "CON.jpg",
            "prn",
            "AUX.dat",
            "nul.jpg",
            "COM1.jpg",
            "lpt9.d3img",
        )
        for name in unsafe_names:
            member = f"image_copy/CamImageSource1/1893700/2D/{name}"
            with self.subTest(member=member):
                self.assertIsNone(subject.normalize_member(member))

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output"
            for batch_id in ("CON", "aux.txt", "bad:id", "bad.", "bad "):
                with self.subTest(batch_id=batch_id):
                    with self.assertRaisesRegex(ValueError, "batch-id"):
                        subject._validate_output_path(output, batch_id, ())


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.database_zip = self.root / "database.zip"
        with zipfile.ZipFile(self.database_zip, "w") as archive:
            archive.writestr("ncdtube.sql", b"SELECT 1;\n")
        self.part1 = self.root / "image_copy.part1.rar"
        self.part2 = self.root / "image_copy.part2.rar"
        self.part1.write_bytes(b"part-one")
        self.part2.write_bytes(b"part-two")
        self.unrar = self.root / "UnRAR.exe"
        self.unrar.write_bytes(b"not executed")

    def tearDown(self):
        self.temp_dir.cleanup()

    def _runner(self, command, **kwargs):
        self.assertEqual(Path(command[0]), self.unrar.resolve())
        self.assertIn("lt", command)
        self.assertIn("-cfg-", command)
        self.assertEqual(kwargs["timeout"], subject.UNRAR_TIMEOUT_SECONDS)
        archive = Path(command[-1])
        listing = RAR_LISTING if archive == self.part1.resolve() else ""
        return subprocess.CompletedProcess(command, 0, listing, "")

    def test_inventory_is_atomic_deterministic_and_has_required_evidence(self):
        output_root = self.root / "output"
        manifest_path = subject.inventory_archives(
            database_zip=self.database_zip,
            image_part1=self.part1,
            image_part2=self.part2,
            output_root=output_root,
            batch_id="batch-001",
            unrar=self.unrar,
            runner=self._runner,
        )

        self.assertEqual(
            manifest_path, output_root.resolve() / "batch-001" / "manifest.inventory.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], "steel.bkv-archive-inventory.v1")
        self.assertEqual(manifest["batchId"], "batch-001")
        self.assertFalse((manifest_path.parent / "manifest.inventory.json.tmp").exists())

        required = {
            "sha256",
            "size",
            "archivePart",
            "memberPath",
            "cameraNumber",
            "seqNo",
            "kind",
            "extension",
            "integrityStatus",
        }
        self.assertTrue(manifest["entries"])
        for entry in manifest["entries"]:
            self.assertTrue(required.issubset(entry), entry)

        image_entries = [
            entry for entry in manifest["entries"] if entry["archivePart"] == "image-part1"
        ]
        self.assertEqual(
            [entry["seqNo"] for entry in image_entries], [1_893_700, 1_893_710]
        )
        self.assertEqual(image_entries[0]["cameraNumber"], 1)
        self.assertEqual(image_entries[1]["kind"], "3D")
        self.assertEqual(image_entries[1]["extension"], ".d3img")
        self.assertEqual(
            manifest["archives"]["image-part1"]["sha256"],
            hashlib.sha256(b"part-one").hexdigest(),
        )
        self.assertEqual(
            manifest["statistics"]["image-part1"],
            {"recordsSeen": 3, "accepted": 2, "rejected": 1},
        )
        self.assertEqual(
            manifest["statistics"]["database-zip"],
            {"recordsSeen": 1, "accepted": 1, "rejected": 0},
        )

    def test_zip_crc_failure_is_recorded_not_reported_ok(self):
        original_open = zipfile.ZipFile.open

        def fail_member_open(archive, name, *args, **kwargs):
            if name == "ncdtube.sql" or getattr(name, "filename", None) == "ncdtube.sql":
                raise zipfile.BadZipFile("Bad CRC-32 for file 'ncdtube.sql'")
            return original_open(archive, name, *args, **kwargs)

        with mock.patch.object(zipfile.ZipFile, "open", fail_member_open):
            manifest_path = subject.inventory_archives(
                database_zip=self.database_zip,
                image_part1=self.part1,
                image_part2=self.part2,
                output_root=self.root / "crc-output",
                batch_id="crc-batch",
                unrar=self.unrar,
                runner=self._runner,
            )

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        database_entry = next(
            entry
            for entry in manifest["entries"]
            if entry["archivePart"] == "database-zip"
        )
        self.assertEqual(database_entry["integrityStatus"], "crc-failed")
        self.assertIsNone(database_entry["sha256"])
        self.assertIn("Bad CRC-32", database_entry["integrityEvidence"])

    def test_output_must_not_overlap_inputs_or_use_reparse_ancestors(self):
        with self.assertRaises(ValueError):
            subject.inventory_archives(
                database_zip=self.database_zip,
                image_part1=self.part1,
                image_part2=self.part2,
                output_root=self.database_zip / "nested",
                batch_id="bad",
                unrar=self.unrar,
                runner=self._runner,
            )

        def output_is_reparse(path):
            return "reparse-output" in Path(path).parts

        with mock.patch.object(subject, "is_reparse_point", side_effect=output_is_reparse):
            with self.assertRaises(ValueError):
                subject.inventory_archives(
                    database_zip=self.database_zip,
                    image_part1=self.part1,
                    image_part2=self.part2,
                    output_root=self.root / "reparse-output",
                    batch_id="bad",
                    unrar=self.unrar,
                    runner=self._runner,
                )

        alias = self.root / "alias-output"
        target = self.root / "resolved-target"
        alias.mkdir()
        target.mkdir()
        path_type = type(alias)
        original_resolve = path_type.resolve

        def follow_mocked_alias(path, strict=False):
            if path == alias:
                return target
            if path == alias / "bad":
                return target / "bad"
            return original_resolve(path, strict=strict)

        def alias_is_reparse(path):
            return Path(path) == alias

        with mock.patch.object(path_type, "resolve", follow_mocked_alias):
            with mock.patch.object(
                subject, "is_reparse_point", side_effect=alias_is_reparse
            ):
                with self.assertRaises(ValueError):
                    subject._validate_output_path(
                        alias,
                        "bad",
                        (self.database_zip, self.part1, self.part2),
                    )

    def test_archive_link_members_are_rejected(self):
        linked_zip = self.root / "linked-database.zip"
        link = zipfile.ZipInfo("dump-link.sql")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(linked_zip, "w") as archive:
            archive.writestr(link, "ncdtube.sql")

        with self.assertRaisesRegex(ValueError, "link"):
            subject.inventory_archives(
                database_zip=linked_zip,
                image_part1=self.part1,
                image_part2=self.part2,
                output_root=self.root / "linked-output",
                batch_id="bad-link",
                unrar=self.unrar,
                runner=self._runner,
            )

        def linked_rar_runner(command, **kwargs):
            listing = """Name: image_copy/CamImageSource1/1893700/2D/a.jpg
Type: Unix symbolic link
Size: 12
Target: ../../escape.jpg
"""
            return subprocess.CompletedProcess(command, 0, listing, "")

        with self.assertRaisesRegex(ValueError, "link"):
            subject.inventory_archives(
                database_zip=self.database_zip,
                image_part1=self.part1,
                image_part2=self.part2,
                output_root=self.root / "rar-linked-output",
                batch_id="bad-rar-link",
                unrar=self.unrar,
                runner=linked_rar_runner,
            )

    def test_unrar_english_chinese_and_malformed_listings(self):
        for listing in (RAR_LISTING, RAR_LISTING_ZH):
            with self.subTest(language=listing[:4]):
                records = subject._parse_unrar_listing(listing)
                entries, statistics = subject._records_to_rar_entries(
                    records, "image-part1"
                )
                self.assertEqual(len(entries), 2)
                self.assertEqual(statistics["recordsSeen"], len(records))
                self.assertEqual(statistics["accepted"], 2)

        def malformed_runner(command, **kwargs):
            return subprocess.CompletedProcess(command, 0, "not technical output\n", "")

        with self.assertRaisesRegex(RuntimeError, "structured"):
            subject.inventory_archives(
                database_zip=self.database_zip,
                image_part1=self.part1,
                image_part2=self.part2,
                output_root=self.root / "malformed-output",
                batch_id="malformed",
                unrar=self.unrar,
                runner=malformed_runner,
            )

    def test_inventory_limits_are_fail_closed(self):
        with mock.patch.object(subject, "MAX_ZIP_MEMBERS", 0):
            with self.assertRaisesRegex(subject.InventoryLimitError, "ZIP member count"):
                subject.inventory_archives(
                    database_zip=self.database_zip,
                    image_part1=self.part1,
                    image_part2=self.part2,
                    output_root=self.root / "zip-limit-output",
                    batch_id="zip-limit",
                    unrar=self.unrar,
                    runner=self._runner,
                )

        for constant, message in (
            ("MAX_ZIP_MEMBER_BYTES", "ZIP member bytes"),
            ("MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES", "ZIP total uncompressed bytes"),
        ):
            with self.subTest(constant=constant):
                with mock.patch.object(subject, constant, 1):
                    with self.assertRaisesRegex(subject.InventoryLimitError, message):
                        subject.inventory_archives(
                            database_zip=self.database_zip,
                            image_part1=self.part1,
                            image_part2=self.part2,
                            output_root=self.root / f"{constant}-output",
                            batch_id=constant.lower(),
                            unrar=self.unrar,
                            runner=self._runner,
                        )

        with mock.patch.object(subject, "MAX_ZIP_COMPRESSION_RATIO", 0.5):
            with self.assertRaisesRegex(subject.InventoryLimitError, "compression ratio"):
                subject.inventory_archives(
                    database_zip=self.database_zip,
                    image_part1=self.part1,
                    image_part2=self.part2,
                    output_root=self.root / "ratio-limit-output",
                    batch_id="ratio-limit",
                    unrar=self.unrar,
                    runner=self._runner,
                )

        with mock.patch.object(subject, "MAX_UNRAR_OUTPUT_BYTES", 8):
            with self.assertRaisesRegex(subject.InventoryLimitError, "output bytes"):
                subject.inventory_archives(
                    database_zip=self.database_zip,
                    image_part1=self.part1,
                    image_part2=self.part2,
                    output_root=self.root / "output-limit-output",
                    batch_id="output-limit",
                    unrar=self.unrar,
                    runner=self._runner,
                )

        with mock.patch.object(subject, "MAX_RAR_LISTING_RECORDS", 1):
            with self.assertRaisesRegex(subject.InventoryLimitError, "record count"):
                subject.inventory_archives(
                    database_zip=self.database_zip,
                    image_part1=self.part1,
                    image_part2=self.part2,
                    output_root=self.root / "record-limit-output",
                    batch_id="record-limit",
                    unrar=self.unrar,
                    runner=self._runner,
                )

        with mock.patch.object(subject, "MAX_MANIFEST_BYTES", 1):
            with self.assertRaisesRegex(subject.InventoryLimitError, "manifest bytes"):
                subject.inventory_archives(
                    database_zip=self.database_zip,
                    image_part1=self.part1,
                    image_part2=self.part2,
                    output_root=self.root / "manifest-limit-output",
                    batch_id="manifest-limit",
                    unrar=self.unrar,
                    runner=self._runner,
                )

    def test_unrar_timeout_and_absolute_trust_boundary(self):
        with self.assertRaisesRegex(ValueError, "absolute"):
            subject.locate_unrar("UnRAR.exe")

        def timeout_runner(command, **kwargs):
            raise subprocess.TimeoutExpired(command, kwargs["timeout"])

        with self.assertRaisesRegex(RuntimeError, "timed out"):
            subject.inventory_archives(
                database_zip=self.database_zip,
                image_part1=self.part1,
                image_part2=self.part2,
                output_root=self.root / "timeout-output",
                batch_id="timeout",
                unrar=self.unrar,
                runner=timeout_runner,
            )

    def test_archive_change_during_inventory_is_rejected(self):
        changed = False

        def mutating_runner(command, **kwargs):
            nonlocal changed
            if not changed:
                self.part1.write_bytes(b"changed-during-listing")
                changed = True
            return subprocess.CompletedProcess(command, 0, RAR_LISTING, "")

        with self.assertRaisesRegex(RuntimeError, "changed during inventory"):
            subject.inventory_archives(
                database_zip=self.database_zip,
                image_part1=self.part1,
                image_part2=self.part2,
                output_root=self.root / "changed-output",
                batch_id="changed",
                unrar=self.unrar,
                runner=mutating_runner,
            )
        self.assertFalse(
            (self.root / "changed-output" / "changed" / subject.MANIFEST_NAME).exists()
        )

    def test_windows_casefold_collisions_are_rejected(self):
        collision_listing = """Name: image_copy/CamImageSource1/1893700/2D/A.jpg
Type: File
Size: 12

Name: image_copy/CamImageSource1/1893700/2D/a.JPG
Type: File
Size: 12
"""

        def collision_runner(command, **kwargs):
            return subprocess.CompletedProcess(command, 0, collision_listing, "")

        with self.assertRaisesRegex(ValueError, "case-insensitive collision"):
            subject.inventory_archives(
                database_zip=self.database_zip,
                image_part1=self.part1,
                image_part2=self.part2,
                output_root=self.root / "collision-output",
                batch_id="collision",
                unrar=self.unrar,
                runner=collision_runner,
            )

        collision_zip = self.root / "collision-database.zip"
        with zipfile.ZipFile(collision_zip, "w") as archive:
            archive.writestr("A.sql", b"one")
            archive.writestr("a.SQL", b"two")
        with self.assertRaisesRegex(ValueError, "case-insensitive collision"):
            subject.inventory_archives(
                database_zip=collision_zip,
                image_part1=self.part1,
                image_part2=self.part2,
                output_root=self.root / "zip-collision-output",
                batch_id="zip-collision",
                unrar=self.unrar,
                runner=self._runner,
            )


@unittest.skipUnless(
    os.name == "nt"
    and Path(r"C:\Program Files\WinRAR\UnRAR.exe").is_file()
    and Path(r"C:\Program Files\WinRAR\WinRAR.exe").is_file(),
    "requires local WinRAR and UnRAR executables",
)
class RealUnrarSmokeTests(unittest.TestCase):
    def test_localized_unrar_technical_listing_is_parsed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_path = root / "smoke.rar"
            member = "image_copy/CamImageSource1/1893700/2D/smoke.jpg"
            source = root / Path(member)
            source.parent.mkdir(parents=True)
            source.write_bytes(b"smoke")
            created = subprocess.run(
                [
                    r"C:\Program Files\WinRAR\WinRAR.exe",
                    "a",
                    "-cfg-",
                    "-r",
                    str(archive_path),
                    "image_copy",
                ],
                cwd=root,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=30,
            )
            self.assertEqual(created.returncode, 0, created.stderr)
            output = subject._run_unrar_listing(
                Path(r"C:\Program Files\WinRAR\UnRAR.exe"), archive_path
            )
            records = subject._parse_unrar_listing(output)
            entries, statistics = subject._records_to_rar_entries(
                records, "image-part1"
            )
            self.assertEqual([entry["memberPath"] for entry in entries], [member])
            self.assertGreaterEqual(statistics["recordsSeen"], 1)


if __name__ == "__main__":
    unittest.main()
