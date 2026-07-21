import contextlib
import hashlib
import io
import json
import os
import stat
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path, PurePosixPath
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

RAR_LISTING_PART2 = """Name: image_copy/CamImageSource5/1893701/2D/part2.jpg
Type: File
Size: 31
CRC32: 55555555
Attributes: ..A....
"""


class _ChunkedCrcStream:
    """A short-read stream that surfaces corruption only after partial data."""

    def __init__(self, payload, chunk_size=17):
        self._payload = payload
        self._offset = 0
        self._chunk_size = chunk_size

    def read(self, size=-1):
        if self._offset >= len(self._payload):
            raise zipfile.BadZipFile("Bad CRC-32 for file 'database.sql'")
        size = self._chunk_size if size < 0 else min(size, self._chunk_size)
        end = min(self._offset + size, len(self._payload))
        chunk = self._payload[self._offset : end]
        self._offset = end
        return chunk


class SqlDumpTests(unittest.TestCase):
    def _fixture(self):
        return rb"""
CREATE TABLE `allexcel` (
  `Description` text,
  `SeqNo` bigint NOT NULL,
  `Width` double,
  PRIMARY KEY (`SeqNo`)
);
INSERT INTO `allexcel` (`Description`, `SeqNo`, `Width`) VALUES ('malformed', 1893700);
INSERT INTO `allexcel` (`Description`, `SeqNo`, `Width`) VALUES
  ('target, one', 1893700, 12.5),
  ('escaped \'quote\'', 1893710, NULL),
  ('outside', 1893699, 4.0);
CREATE TABLE `checkrecord` (
  `Id` bigint NOT NULL,
  `Comment` text,
  `SeqNo` bigint NOT NULL,
  PRIMARY KEY (`Id`),
  UNIQUE KEY `checkrecord_seq` (`SeqNo`)
);
INSERT INTO `checkrecord` VALUES
  (71, 'chunk; boundary', 1893700),
  (72, 'second', 1893710),
  (73, 'outside', 1893699);
CREATE TABLE `defectclass` (
  `Label` varchar(255),
  `SeqNo` bigint NOT NULL,
  `ClassId` bigint NOT NULL,
  PRIMARY KEY (`ClassId`)
);
INSERT INTO `defectclass` VALUES
  ('edge', 1893700, 8),
  ('outside', 1893699, 9);
CREATE TABLE `defect` (
  `DefectId` bigint NOT NULL,
  `Depth` double,
  `SeqNo` bigint NOT NULL,
  PRIMARY KEY (`DefectId`)
);
INSERT INTO `defect` VALUES
  (801, 0.25, 1893710),
  (802, -0.1, 1893700),
  (803, 0.5, 1893699);
CREATE TABLE `diameter` (
  `Measurement` double,
  `Id` bigint NOT NULL,
  `RecordSeqNo` bigint NOT NULL,
  PRIMARY KEY (`Id`),
  CONSTRAINT `diameter_record` FOREIGN KEY (`RecordSeqNo`) REFERENCES `checkrecord` (`SeqNo`)
);
INSERT INTO `diameter` VALUES
  (33.75, 901, 1893710),
  (34.25, 902, 1893699);
"""

    def test_filters_target_rows_using_create_table_column_order(self):
        result = subject.filter_sql_dump(
            _ChunkedCrcStream(self._fixture()), subject.TARGET_SEQ_NOS
        )

        self.assertEqual(set(result.rows_by_seq), {1_893_700, 1_893_710})
        self.assertEqual(result.integrity, "partial-crc-error")
        self.assertEqual(result.rejected_rows[0]["reason"], "malformed_insert")
        self.assertFalse(result.diameter_complete)
        self.assertEqual(
            set(result.rows_by_table),
            {"allexcel", "checkrecord", "defect", "defectclass", "diameter"},
        )
        self.assertEqual(
            result.rows_by_table["allexcel"][0]["Description"], "target, one"
        )
        self.assertEqual(
            result.rows_by_table["allexcel"][1]["Description"], "escaped 'quote'"
        )
        self.assertIsNone(result.rows_by_table["allexcel"][1]["Width"])
        self.assertEqual(result.rows_by_table["diameter"][0]["RecordSeqNo"], 1_893_710)
        self.assertRegex(
            result.rows_by_table["diameter"][0]["originalRowHash"], r"^[0-9a-f]{64}$"
        )
        self.assertEqual(
            result.counts["defect"],
            {
                "accepted": 1,
                "rejected": 2,
                "statementRejectedRowsUnknown": 0,
            },
        )

    def test_rejects_unproven_diameter_association_and_invalid_physical_values(self):
        fixture = rb"""
CREATE TABLE `diameter` (`Id` bigint, `Value` double, PRIMARY KEY (`Id`));
INSERT INTO `diameter` VALUES (1893700, 12.0);
CREATE TABLE `allexcel` (`SeqNo` bigint, `Length` double, PRIMARY KEY (`SeqNo`));
INSERT INTO `allexcel` VALUES (1893700, -1.0), (1893710, 1e309);
"""
        result = subject.filter_sql_dump(io.BytesIO(fixture), subject.TARGET_SEQ_NOS)

        self.assertEqual(result.rows_by_seq, {})
        self.assertEqual(
            [row["reason"] for row in result.rejected_rows],
            [
                "relationship_unproven",
                "negative_physical_dimension",
                "non_finite_numeric",
            ],
        )
        self.assertFalse(result.diameter_complete)

    def test_enforces_statement_and_field_bounds_and_emits_jsonl(self):
        fixture = rb"""
CREATE TABLE `allexcel` (`SeqNo` bigint, `Note` text, PRIMARY KEY (`SeqNo`));
INSERT INTO `allexcel` VALUES (1893700, 'abc');
"""
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            result = subject.filter_sql_dump(
                io.BytesIO(fixture), subject.TARGET_SEQ_NOS, output_dir=output
            )
            generation = subject.resolve_sql_output(output)
            line = json.loads(
                (generation / "allexcel.jsonl").read_text(encoding="utf-8")
            )
            self.assertEqual(line, result.rows_by_table["allexcel"][0])

        with mock.patch.object(subject, "MAX_SQL_FIELD_BYTES", 2):
            result = subject.filter_sql_dump(
                io.BytesIO(fixture), subject.TARGET_SEQ_NOS
            )
            self.assertEqual(result.rejected_rows[-1]["reason"], "field_too_long")

        with mock.patch.object(subject, "MAX_SQL_STATEMENT_BYTES", 20):
            with self.assertRaisesRegex(subject.SqlDumpLimitError, "statement bytes"):
                subject.filter_sql_dump(io.BytesIO(fixture), subject.TARGET_SEQ_NOS)

    def test_filters_sql_member_through_stable_zip_open_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_zip = root / "database.zip"
            with zipfile.ZipFile(database_zip, "w") as archive:
                archive.writestr("database.sql", self._fixture())

            result = subject.filter_database_zip(database_zip, root / "normalized")

            self.assertEqual(set(result.rows_by_seq), {1_893_700, 1_893_710})
            self.assertEqual(result.integrity, "ok")
            self.assertFalse(result.diameter_complete)
            generation = subject.resolve_sql_output(root / "normalized")
            self.assertTrue((generation / "diameter.jsonl").is_file())

    def test_foreign_key_requires_a_retained_parent_relationship(self):
        fixture = rb"""
CREATE TABLE `checkrecord` (`Id` bigint, `SeqNo` bigint, PRIMARY KEY (`Id`));
INSERT INTO `checkrecord` VALUES (71, 1893700), (72, 1893699);
CREATE TABLE `diameter` (
  `Id` bigint,
  `RecordId` bigint,
  `Measurement` double,
  FOREIGN KEY (`RecordId`) REFERENCES `checkrecord` (`Id`)
);
INSERT INTO `diameter` VALUES (1, 71, 12.0), (2, 72, 13.0), (3, 999, 14.0);
"""
        result = subject.filter_sql_dump(io.BytesIO(fixture), subject.TARGET_SEQ_NOS)

        self.assertEqual(len(result.rows_by_table["diameter"]), 1)
        self.assertEqual(result.rows_by_table["diameter"][0]["legacySeqNo"], 1_893_700)
        self.assertEqual(
            result.counts["diameter"],
            {
                "accepted": 1,
                "rejected": 2,
                "statementRejectedRowsUnknown": 0,
            },
        )
        self.assertFalse(result.diameter_complete)

    def test_parses_doubled_quote_escaping_without_losing_row_boundaries(self):
        fixture = rb"""
CREATE TABLE `allexcel` (`SeqNo` bigint, `Note` text, PRIMARY KEY (`SeqNo`));
INSERT INTO `allexcel` VALUES
  (1893700, 'doubled ''quote'', comma'),
  (1893710, 'next row');
"""
        result = subject.filter_sql_dump(io.BytesIO(fixture), subject.TARGET_SEQ_NOS)

        self.assertEqual(
            [row["Note"] for row in result.rows_by_table["allexcel"]],
            ["doubled 'quote', comma", "next row"],
        )

    def test_zip_filter_reuses_inventory_compression_ratio_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database_zip = root / "database.zip"
            with zipfile.ZipFile(
                database_zip, "w", compression=zipfile.ZIP_DEFLATED
            ) as archive:
                archive.writestr("database.sql", b" " * 10_000)

            with mock.patch.object(subject, "MAX_ZIP_COMPRESSION_RATIO", 1):
                with self.assertRaisesRegex(
                    subject.InventoryLimitError, "compression ratio"
                ):
                    subject.filter_database_zip(database_zip, root / "normalized")

    def test_create_table_accepts_mysql_options_after_balanced_closing_paren(self):
        fixture = rb"""
CREATE TABLE `allexcel` (
  `Width` double DEFAULT NULL,
  `SeqNo` bigint(20) NOT NULL,
  PRIMARY KEY (`SeqNo`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='legacy ) table';
INSERT INTO `allexcel` VALUES (12.5, 1893700);
"""
        result = subject.filter_sql_dump(io.BytesIO(fixture), subject.TARGET_SEQ_NOS)

        self.assertEqual(result.rows_by_table["allexcel"][0]["SeqNo"], 1_893_700)
        self.assertEqual(result.rows_by_table["allexcel"][0]["Width"], 12.5)

    def test_invalid_explicit_columns_reject_each_safely_counted_values_row(self):
        fixture = rb"""
CREATE TABLE `allexcel` (`SeqNo` bigint, `Note` text, PRIMARY KEY (`SeqNo`));
INSERT INTO `allexcel` (`SeqNo`, `UnknownColumn`) VALUES
  (1893700, 'one'), (1893701, 'two'), (1893702, 'three');
"""
        result = subject.filter_sql_dump(io.BytesIO(fixture), subject.TARGET_SEQ_NOS)

        self.assertEqual(result.counts["allexcel"]["rejected"], 3)
        self.assertEqual(
            [row["reason"] for row in result.rejected_rows],
            ["malformed_insert", "malformed_insert", "malformed_insert"],
        )
        self.assertEqual(result.counts["allexcel"]["statementRejectedRowsUnknown"], 0)

    def test_unparseable_values_records_unknown_rejected_row_count(self):
        fixture = rb"""
CREATE TABLE `allexcel` (`SeqNo` bigint, PRIMARY KEY (`SeqNo`));
INSERT INTO `allexcel` (`UnknownColumn`) VALUES (1893700), broken tuple;
"""
        result = subject.filter_sql_dump(io.BytesIO(fixture), subject.TARGET_SEQ_NOS)

        self.assertEqual(result.counts["allexcel"]["rejected"], 0)
        self.assertEqual(result.counts["allexcel"]["statementRejectedRowsUnknown"], 1)
        self.assertEqual(result.rejected_rows, [])

    def test_original_row_hash_preserves_literal_spelling_and_ignores_chunks(self):
        fixture = rb"""
CREATE TABLE `allexcel` (`SeqNo` bigint, `Width` double, PRIMARY KEY (`SeqNo`));
INSERT INTO `allexcel` VALUES (1893700, 1.0), (1893700, 1.00);
"""
        contiguous = subject.filter_sql_dump(
            io.BytesIO(fixture), subject.TARGET_SEQ_NOS
        )
        chunked = subject.filter_sql_dump(
            _ChunkedCrcStream(fixture, chunk_size=1), subject.TARGET_SEQ_NOS
        )

        contiguous_hashes = [
            row["originalRowHash"] for row in contiguous.rows_by_table["allexcel"]
        ]
        chunked_hashes = [
            row["originalRowHash"] for row in chunked.rows_by_table["allexcel"]
        ]
        self.assertNotEqual(contiguous_hashes[0], contiguous_hashes[1])
        self.assertEqual(chunked_hashes, contiguous_hashes)

    def test_pending_foreign_key_resolves_when_child_precedes_parent(self):
        fixture = rb"""
CREATE TABLE `diameter` (`Id` bigint, `RecordId` bigint, `Measurement` double,
  FOREIGN KEY (`RecordId`) REFERENCES `checkrecord` (`Id`));
INSERT INTO `diameter` VALUES (1, 71, 12.0);
CREATE TABLE `checkrecord` (`Id` bigint, `SeqNo` bigint, PRIMARY KEY (`Id`));
INSERT INTO `checkrecord` VALUES (71, 1893700);
"""
        result = subject.filter_sql_dump(io.BytesIO(fixture), subject.TARGET_SEQ_NOS)

        self.assertEqual(len(result.rows_by_table["diameter"]), 1)
        self.assertEqual(result.rows_by_table["diameter"][0]["legacySeqNo"], 1_893_700)
        self.assertTrue(result.diameter_complete)

        crc_result = subject.filter_sql_dump(
            _ChunkedCrcStream(fixture), subject.TARGET_SEQ_NOS
        )
        self.assertEqual(len(crc_result.rows_by_table["diameter"]), 1)
        self.assertFalse(crc_result.diameter_complete)

        child_only = fixture.split(b"CREATE TABLE `checkrecord`", 1)[0]
        interrupted = subject.filter_sql_dump(
            _ChunkedCrcStream(child_only), subject.TARGET_SEQ_NOS
        )
        self.assertEqual(interrupted.rows_by_table["diameter"], [])
        self.assertEqual(
            interrupted.rejected_rows[-1]["reason"], "relationship_unproven"
        )
        self.assertFalse(interrupted.diameter_complete)

    def test_unresolved_or_unknown_diameter_rows_make_diameter_incomplete(self):
        unresolved = rb"""
CREATE TABLE `diameter` (`RecordId` bigint,
  FOREIGN KEY (`RecordId`) REFERENCES `checkrecord` (`Id`));
INSERT INTO `diameter` VALUES (999);
CREATE TABLE `checkrecord` (`Id` bigint, `SeqNo` bigint);
"""
        result = subject.filter_sql_dump(io.BytesIO(unresolved), subject.TARGET_SEQ_NOS)
        self.assertFalse(result.diameter_complete)
        self.assertEqual(result.rejected_rows[-1]["reason"], "relationship_unproven")

        unknown = rb"""
CREATE TABLE `diameter` (`SeqNo` bigint);
INSERT INTO `diameter` (`UnknownColumn`) VALUES (1893700), broken tuple;
"""
        result = subject.filter_sql_dump(io.BytesIO(unknown), subject.TARGET_SEQ_NOS)
        self.assertFalse(result.diameter_complete)
        self.assertEqual(result.counts["diameter"]["statementRejectedRowsUnknown"], 1)

    def test_any_known_diameter_row_rejection_makes_diameter_incomplete(self):
        cases = (
            (
                "malformed_insert",
                rb"""CREATE TABLE `diameter` (`SeqNo` bigint, `Measurement` double);
INSERT INTO `diameter` VALUES (1893700);""",
                None,
            ),
            (
                "non_finite_numeric",
                rb"""CREATE TABLE `diameter` (`SeqNo` bigint, `Measurement` double);
INSERT INTO `diameter` VALUES (1893700, 1e309);""",
                None,
            ),
            (
                "negative_physical_dimension",
                rb"""CREATE TABLE `diameter` (`SeqNo` bigint, `Measurement` double);
INSERT INTO `diameter` VALUES (1893700, -1.0);""",
                None,
            ),
            (
                "invalid_text_encoding",
                b"CREATE TABLE `diameter` (`SeqNo` bigint, `Note` text);"
                b"INSERT INTO `diameter` VALUES (1893700, 'bad\xff');",
                None,
            ),
            (
                "field_too_long",
                rb"""CREATE TABLE `diameter` (`SeqNo` bigint, `Note` text);
INSERT INTO `diameter` VALUES (1893700, 'long');""",
                3,
            ),
        )
        for reason, fixture, field_limit in cases:
            with self.subTest(reason=reason):
                patcher = (
                    mock.patch.object(subject, "MAX_SQL_FIELD_BYTES", field_limit)
                    if field_limit is not None
                    else contextlib.nullcontext()
                )
                with patcher:
                    result = subject.filter_sql_dump(
                        io.BytesIO(fixture), subject.TARGET_SEQ_NOS
                    )
                self.assertEqual(result.rejected_rows[-1]["reason"], reason)
                self.assertFalse(result.diameter_complete)

    def test_production_output_streams_with_small_sample_instead_of_full_rows(self):
        fixture = rb"""
CREATE TABLE `allexcel` (`SeqNo` bigint, `Note` text);
INSERT INTO `allexcel` VALUES (1893700, 'one'), (1893710, 'two');
"""
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "normalized"
            with mock.patch.object(subject, "MAX_SQL_RESULT_ROWS", 1):
                with mock.patch.object(subject, "MAX_SQL_SAMPLE_ROWS", 1):
                    result = subject.filter_sql_dump(
                        io.BytesIO(fixture),
                        subject.TARGET_SEQ_NOS,
                        output_dir=output,
                    )
            self.assertEqual(result.counts["allexcel"]["accepted"], 2)
            self.assertLessEqual(sum(map(len, result.rows_by_table.values())), 1)
            generation = subject.resolve_sql_output(output)
            self.assertEqual(
                len(
                    (generation / "allexcel.jsonl")
                    .read_text(encoding="utf-8")
                    .splitlines()
                ),
                2,
            )

    def test_sql_resource_limits_fail_closed(self):
        direct = rb"""
CREATE TABLE `allexcel` (`SeqNo` bigint, `Note` text);
INSERT INTO `allexcel` VALUES (1893700, 'one'), (1893710, 'two');
"""
        pending = rb"""
CREATE TABLE `diameter` (`RecordId` bigint,
  FOREIGN KEY (`RecordId`) REFERENCES `checkrecord` (`Id`));
INSERT INTO `diameter` VALUES (71);
"""
        relationship = rb"""
CREATE TABLE `allexcel` (`ParentKey` text, `SeqNo` bigint);
INSERT INTO `allexcel` VALUES ('one', 1893700), ('two', 1893710);
CREATE TABLE `diameter` (`ParentKey` text,
  FOREIGN KEY (`ParentKey`) REFERENCES `allexcel` (`ParentKey`));
"""
        cases = (
            ("MAX_SQL_TABLE_ROWS", 1, direct, "table rows"),
            ("MAX_SQL_NORMALIZED_BYTES", 1, direct, "normalized bytes"),
            ("MAX_SQL_RELATIONSHIP_KEYS", 1, relationship, "relationship keys"),
            ("MAX_SQL_PENDING_BYTES", 1, pending, "pending spool bytes"),
        )
        for constant, limit, fixture, message in cases:
            with self.subTest(constant=constant):
                with mock.patch.object(subject, constant, limit):
                    with self.assertRaisesRegex(subject.SqlDumpLimitError, message):
                        subject.filter_sql_dump(
                            io.BytesIO(fixture), subject.TARGET_SEQ_NOS
                        )

        with mock.patch.object(subject, "MAX_SQL_PENDING_REPLAY_PASSES", 0):
            with self.assertRaisesRegex(
                subject.SqlDumpLimitError, "pending replay passes"
            ):
                subject.filter_sql_dump(io.BytesIO(pending), subject.TARGET_SEQ_NOS)

    def test_jsonl_publish_is_atomic_and_invalid_surrogate_is_quarantined(self):
        first = rb"""
CREATE TABLE `allexcel` (`SeqNo` bigint, `Note` text);
INSERT INTO `allexcel` VALUES (1893700, 'first');
"""
        second = first.replace(b"first", b"second")
        invalid = (
            b"CREATE TABLE `allexcel` (`SeqNo` bigint, `Note` text);"
            b"INSERT INTO `allexcel` VALUES (1893700, 'bad\xff');"
        )
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "normalized"
            subject.filter_sql_dump(
                io.BytesIO(first), subject.TARGET_SEQ_NOS, output_dir=output
            )
            pointer_path = output / "normalized.current.json"
            old_pointer = pointer_path.read_bytes()
            old_generation = subject.resolve_sql_output(output)
            with mock.patch.object(
                subject,
                "_replace_sql_current_pointer",
                side_effect=OSError("pointer replace failed"),
            ):
                with self.assertRaisesRegex(OSError, "pointer replace failed"):
                    subject.filter_sql_dump(
                        io.BytesIO(second), subject.TARGET_SEQ_NOS, output_dir=output
                    )
            self.assertEqual(pointer_path.read_bytes(), old_pointer)
            self.assertEqual(subject.resolve_sql_output(output), old_generation)
            self.assertIn(
                '"first"',
                (old_generation / "allexcel.jsonl").read_text(encoding="utf-8"),
            )
            self.assertGreaterEqual(
                len(list((output / "normalized-generations").iterdir())), 2
            )
            subject.cleanup_orphan_sql_generations(output)
            self.assertEqual(
                list((output / "normalized-generations").iterdir()),
                [old_generation],
            )

            result = subject.filter_sql_dump(
                io.BytesIO(invalid), subject.TARGET_SEQ_NOS
            )
            self.assertEqual(
                result.rejected_rows[-1]["reason"], "invalid_text_encoding"
            )

    def test_jsonl_batch_fsyncs_directory_metadata_before_and_after_publish(self):
        fixture = rb"""
CREATE TABLE `allexcel` (`SeqNo` bigint);
INSERT INTO `allexcel` VALUES (1893700);
"""
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "normalized"
            with mock.patch.object(subject, "_fsync_directory") as fsync_directory:
                subject.filter_sql_dump(
                    io.BytesIO(fixture), subject.TARGET_SEQ_NOS, output_dir=output
                )
            self.assertGreaterEqual(fsync_directory.call_count, 2)

    def test_generation_pointer_switches_once_and_verifies_file_hashes(self):
        first = rb"""CREATE TABLE `allexcel` (`SeqNo` bigint, `Note` text);
INSERT INTO `allexcel` VALUES (1893700, 'first');"""
        second = first.replace(b"first", b"second")
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "normalized"
            subject.filter_sql_dump(
                io.BytesIO(first), subject.TARGET_SEQ_NOS, output_dir=output
            )
            old_generation = subject.resolve_sql_output(output)
            original_replace = subject._replace_sql_current_pointer
            with mock.patch.object(
                subject,
                "_replace_sql_current_pointer",
                wraps=original_replace,
            ) as replace_pointer:
                subject.filter_sql_dump(
                    io.BytesIO(second), subject.TARGET_SEQ_NOS, output_dir=output
                )
            self.assertEqual(replace_pointer.call_count, 1)
            current_generation = subject.resolve_sql_output(output)
            self.assertNotEqual(current_generation, old_generation)
            self.assertTrue(old_generation.is_dir())
            pointer = json.loads(
                (output / "normalized.current.json").read_text(encoding="utf-8")
            )
            self.assertEqual(pointer["schema"], "steel.bkv-sql-current.v1")
            self.assertEqual(set(pointer["files"]), set(subject._SQL_TABLES))
            for table, evidence in pointer["files"].items():
                payload = (current_generation / f"{table}.jsonl").read_bytes()
                self.assertEqual(
                    evidence["sha256"], hashlib.sha256(payload).hexdigest()
                )
                self.assertEqual(evidence["size"], len(payload))
                self.assertEqual(evidence["count"], 1 if table == "allexcel" else 0)

            pointer_path = output / "normalized.current.json"
            original_pointer = pointer_path.read_bytes()
            pointer["files"]["allexcel"]["count"] += 1
            pointer_path.write_text(json.dumps(pointer), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "count mismatch"):
                subject.resolve_sql_output(output)
            pointer_path.write_bytes(original_pointer)

            current_file = current_generation / "allexcel.jsonl"
            original_payload = current_file.read_bytes()
            current_file.write_bytes(
                bytes([original_payload[0] ^ 1]) + original_payload[1:]
            )
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                subject.resolve_sql_output(output)

    def test_first_publish_failure_has_no_partial_pointer_and_orphan_is_cleanable(self):
        fixture = rb"""CREATE TABLE `allexcel` (`SeqNo` bigint);
INSERT INTO `allexcel` VALUES (1893700);"""
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "normalized"
            with mock.patch.object(
                subject,
                "_replace_sql_current_pointer",
                side_effect=OSError("simulated process interruption"),
            ):
                with self.assertRaisesRegex(OSError, "process interruption"):
                    subject.filter_sql_dump(
                        io.BytesIO(fixture),
                        subject.TARGET_SEQ_NOS,
                        output_dir=output,
                    )
            self.assertFalse((output / "normalized.current.json").exists())
            self.assertEqual(
                len(list((output / "normalized-generations").iterdir())), 1
            )
            subject.cleanup_orphan_sql_generations(output)
            self.assertEqual(list((output / "normalized-generations").iterdir()), [])

    def test_schema_qualified_tables_and_unsupported_target_syntax(self):
        fixture = rb"""
CREATE TABLE `legacy`.`allexcel` (`Note` text, `SeqNo` bigint);
INSERT INTO legacy.allexcel VALUES ('qualified', 1893700);
"""
        result = subject.filter_sql_dump(io.BytesIO(fixture), subject.TARGET_SEQ_NOS)
        self.assertEqual(result.rows_by_table["allexcel"][0]["Note"], "qualified")

        malformed = rb"""
CREATE TABLE legacy..allexcel (`SeqNo` bigint);
INSERT INTO legacy..allexcel VALUES (1893700);
"""
        result = subject.filter_sql_dump(io.BytesIO(malformed), subject.TARGET_SEQ_NOS)
        self.assertEqual(result.integrity, "partial-parse-error")
        self.assertEqual(result.parse_rejected_statements, 2)
        self.assertEqual(result.counts["allexcel"]["statementRejectedRowsUnknown"], 1)

    def test_original_row_hash_is_exact_raw_tuple_bytes(self):
        lf = rb"""CREATE TABLE `allexcel` (`SeqNo` bigint, `Width` double);
INSERT INTO `allexcel` VALUES (1893700,
 1.0);"""
        crlf = lf.replace(b"\n 1.0", b"\r\n 1.0")
        lf_result = subject.filter_sql_dump(io.BytesIO(lf), subject.TARGET_SEQ_NOS)
        crlf_result = subject.filter_sql_dump(io.BytesIO(crlf), subject.TARGET_SEQ_NOS)
        expected = hashlib.sha256(b"(1893700,\n 1.0)").hexdigest()

        self.assertEqual(
            lf_result.rows_by_table["allexcel"][0]["originalRowHash"], expected
        )
        self.assertNotEqual(
            lf_result.rows_by_table["allexcel"][0]["originalRowHash"],
            crlf_result.rows_by_table["allexcel"][0]["originalRowHash"],
        )

    def test_common_legacy_physical_column_names_are_non_negative(self):
        fixture = rb"""
CREATE TABLE `allexcel` (`SeqNo` bigint, `PlateWidth` double, `OuterDiameter` double);
INSERT INTO `allexcel` VALUES (1893700, -1.0, 20.0);
"""
        result = subject.filter_sql_dump(io.BytesIO(fixture), subject.TARGET_SEQ_NOS)

        self.assertEqual(
            result.rejected_rows[-1]["reason"], "negative_physical_dimension"
        )

    def test_all_direct_and_foreign_key_proofs_must_be_unique_and_consistent(self):
        parents = rb"""
CREATE TABLE `checkrecord` (`Id` bigint, `SeqNo` bigint);
INSERT INTO `checkrecord` VALUES (71, 1893700), (72, 1893710);
CREATE TABLE `allexcel` (`Id` bigint, `SeqNo` bigint);
INSERT INTO `allexcel` VALUES (81, 1893700), (82, 1893710);
"""
        conflicts = (
            rb"""CREATE TABLE `diameter` (`CheckId` bigint, `ExcelId` bigint,
  FOREIGN KEY (`CheckId`) REFERENCES `checkrecord` (`Id`),
  FOREIGN KEY (`ExcelId`) REFERENCES `allexcel` (`Id`));
INSERT INTO `diameter` VALUES (71, 82);""",
            rb"""CREATE TABLE `diameter` (`CheckId` bigint, `ExcelId` bigint,
  FOREIGN KEY (`ExcelId`) REFERENCES `allexcel` (`Id`),
  FOREIGN KEY (`CheckId`) REFERENCES `checkrecord` (`Id`));
INSERT INTO `diameter` VALUES (71, 82);""",
        )
        for child in conflicts:
            with self.subTest(order=child.splitlines()[1]):
                result = subject.filter_sql_dump(
                    io.BytesIO(parents + child), subject.TARGET_SEQ_NOS
                )
                self.assertEqual(
                    result.rejected_rows[-1]["reason"], "relationship_conflict"
                )
                self.assertFalse(result.diameter_complete)

        direct_conflict = rb"""
CREATE TABLE `diameter` (`SeqNo` bigint, `CheckId` bigint,
  FOREIGN KEY (`CheckId`) REFERENCES `checkrecord` (`Id`));
INSERT INTO `diameter` VALUES (1893700, 72);
"""
        result = subject.filter_sql_dump(
            io.BytesIO(parents + direct_conflict), subject.TARGET_SEQ_NOS
        )
        self.assertEqual(result.rejected_rows[-1]["reason"], "relationship_conflict")

        consistent_child = rb"""
CREATE TABLE `diameter` (`CheckId` bigint, `ExcelId` bigint,
  FOREIGN KEY (`CheckId`) REFERENCES `checkrecord` (`Id`),
  FOREIGN KEY (`ExcelId`) REFERENCES `allexcel` (`Id`));
INSERT INTO `diameter` VALUES (71, 81);
"""
        result = subject.filter_sql_dump(
            io.BytesIO(consistent_child + parents), subject.TARGET_SEQ_NOS
        )
        self.assertEqual(result.rows_by_table["diameter"][0]["legacySeqNo"], 1_893_700)

        mixed_child = consistent_child.replace(b"(71, 81)", b"(71, 999)")
        result = subject.filter_sql_dump(
            io.BytesIO(parents + mixed_child), subject.TARGET_SEQ_NOS
        )
        self.assertEqual(result.rejected_rows[-1]["reason"], "relationship_unproven")
        self.assertEqual(result.rows_by_table["diameter"], [])

    def test_relationship_index_only_keeps_referenced_columns_and_bounds_bytes(self):
        long_key = "k" * 200
        fixture = f"""
CREATE TABLE `allexcel` (`UnusedA` text, `ParentKey` text, `UnusedB` text, `SeqNo` bigint);
INSERT INTO `allexcel` VALUES ('a', '{long_key}', 'b', 1893700);
CREATE TABLE `diameter` (`ParentKey` text,
  FOREIGN KEY (`ParentKey`) REFERENCES `allexcel` (`ParentKey`));
INSERT INTO `diameter` VALUES ('{long_key}');
""".encode()
        with mock.patch.object(subject, "MAX_SQL_RELATIONSHIP_KEYS", 1):
            result = subject.filter_sql_dump(
                io.BytesIO(fixture), subject.TARGET_SEQ_NOS
            )
        self.assertEqual(len(result.rows_by_table["diameter"]), 1)

        with mock.patch.object(subject, "MAX_SQL_RELATIONSHIP_KEYS", 100):
            with mock.patch.object(subject, "MAX_SQL_RELATIONSHIP_INDEX_BYTES", 32):
                with self.assertRaisesRegex(
                    subject.SqlDumpLimitError, "relationship index bytes"
                ):
                    subject.filter_sql_dump(io.BytesIO(fixture), subject.TARGET_SEQ_NOS)

    def test_pointer_types_fail_with_stable_value_errors(self):
        fixture = rb"""CREATE TABLE `allexcel` (`SeqNo` bigint);
INSERT INTO `allexcel` VALUES (1893700);"""
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "normalized"
            subject.filter_sql_dump(
                io.BytesIO(fixture), subject.TARGET_SEQ_NOS, output_dir=output
            )
            pointer_path = output / "normalized.current.json"
            valid = json.loads(pointer_path.read_text(encoding="utf-8"))
            invalid_documents = (
                [],
                {"schema": "steel.bkv-sql-current.v1", "generation": [], "files": {}},
                {
                    **valid,
                    "files": {
                        **valid["files"],
                        "allexcel": {**valid["files"]["allexcel"], "count": "1"},
                    },
                },
                {
                    **valid,
                    "files": {
                        **valid["files"],
                        "allexcel": {**valid["files"]["allexcel"], "sha256": []},
                    },
                },
            )
            for document in invalid_documents:
                with self.subTest(document=document):
                    pointer_path.write_text(json.dumps(document), encoding="utf-8")
                    with self.assertRaisesRegex(
                        ValueError, "invalid SQL current pointer"
                    ):
                        subject.resolve_sql_output(output)

    def test_generation_reparse_boundaries_reject_write_resolve_and_cleanup(self):
        fixture = rb"""CREATE TABLE `allexcel` (`SeqNo` bigint);
INSERT INTO `allexcel` VALUES (1893700);"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            external = root / "external"
            external.mkdir()
            linked_output = root / "linked-output"
            try:
                os.symlink(external, linked_output, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"directory symlink unavailable: {error}")
            with self.assertRaisesRegex(ValueError, "reparse"):
                subject.filter_sql_dump(
                    io.BytesIO(fixture),
                    subject.TARGET_SEQ_NOS,
                    output_dir=linked_output,
                )
            self.assertEqual(list(external.iterdir()), [])

            output = root / "normalized"
            subject.filter_sql_dump(
                io.BytesIO(fixture), subject.TARGET_SEQ_NOS, output_dir=output
            )
            pointer_path = output / "normalized.current.json"
            original_pointer = pointer_path.read_bytes()
            external_generation = root / "external-generation"
            external_generation.mkdir()
            evil = output / "normalized-generations" / "generation-evil"
            os.symlink(external_generation, evil, target_is_directory=True)
            pointer = json.loads(original_pointer)
            pointer["generation"] = "normalized-generations/generation-evil"
            pointer_path.write_text(json.dumps(pointer), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "reparse"):
                subject.resolve_sql_output(output)
            pointer_path.write_bytes(original_pointer)
            with self.assertRaisesRegex(ValueError, "reparse"):
                subject.cleanup_orphan_sql_generations(output)
            self.assertEqual(list(external_generation.iterdir()), [])

    def test_backtick_keyword_columns_and_index_prefixes_are_distinguished(self):
        fixture = rb"""
CREATE TABLE `allexcel` (
  `Key` bigint,
  `Primary` text,
  `Unique` text,
  `Constraint` text,
  `Check` text,
  `Foreign` text,
  `FULLTEXT` text,
  `SPATIAL` geometry,
  `Key``Part` text,
  `SeqNo` bigint,
  PRIMARY KEY (`Key`),
  UNIQUE KEY `uq_unique` (`Unique`),
  KEY `idx_constraint` (`Constraint`),
  INDEX `idx_foreign` (`Foreign`),
  FULLTEXT KEY `ft_key` (`FULLTEXT`) USING BTREE KEY_BLOCK_SIZE = 1024
    WITH PARSER `ngram` COMMENT 'search ) ''quoted'' (' VISIBLE
    ENGINE_ATTRIBUTE = '{"note":"value ) (","escaped":"a\"b"}'
    SECONDARY_ENGINE_ATTRIBUTE '{"secondary":"(ok)"}',
  FULLTEXT INDEX `ft_index` (`FULLTEXT`) USING HASH KEY_BLOCK_SIZE 2048
    ENGINE_ATTRIBUTE '{"engine":"plain"}'
    SECONDARY_ENGINE_ATTRIBUTE = '{"secondary":"plain"}' INVISIBLE,
  FULLTEXT ft_name (`FULLTEXT`) COMMENT 'named index',
  FULLTEXT (`FULLTEXT`) VISIBLE COMMENT 'unnamed',
  SPATIAL KEY `sp_key` (`SPATIAL`) COMMENT 'shape \' ) (' INVISIBLE,
  SPATIAL INDEX `sp_index` (`SPATIAL`) VISIBLE,
  SPATIAL sp_name (`SPATIAL`),
  SPATIAL (`SPATIAL`),
  CHECK (`Check` IS NOT NULL)
);
INSERT INTO `allexcel` VALUES
  (71, 'primary', 'unique', 'constraint', 'check', 'foreign', 'fulltext', 'spatial',
   'escaped', 1893700);
CREATE TABLE `diameter` (
  `Foreign` bigint,
  FULLTEXT TEXT,
  SPATIAL VARCHAR(32),
  FOREIGN KEY (`Foreign`) REFERENCES `allexcel` (`Key`)
);
INSERT INTO `diameter` VALUES (71, 'fulltext data', 'spatial data');
"""
        result = subject.filter_sql_dump(io.BytesIO(fixture), subject.TARGET_SEQ_NOS)

        parent = result.rows_by_table["allexcel"][0]
        self.assertEqual(
            [
                parent["Key"],
                parent["Primary"],
                parent["Unique"],
                parent["Constraint"],
                parent["Check"],
                parent["Foreign"],
                parent["FULLTEXT"],
                parent["SPATIAL"],
                parent["Key`Part"],
                parent["SeqNo"],
            ],
            [
                71,
                "primary",
                "unique",
                "constraint",
                "check",
                "foreign",
                "fulltext",
                "spatial",
                "escaped",
                1_893_700,
            ],
        )
        diameter = result.rows_by_table["diameter"][0]
        self.assertEqual(diameter["legacySeqNo"], 1_893_700)
        self.assertEqual(diameter["FULLTEXT"], "fulltext data")
        self.assertEqual(diameter["SPATIAL"], "spatial data")

        for definition in (
            "FULLTEXT KEY ft_key (Note) USING BTREE KEY_BLOCK_SIZE = 1024 "
            "WITH PARSER ngram COMMENT 'note ) (' VISIBLE "
            'ENGINE_ATTRIBUTE = \'{"escaped":"a\\"b"}\' '
            'SECONDARY_ENGINE_ATTRIBUTE \'{"secondary":"(ok)"}\'',
            'FULLTEXT INDEX ft_index (Note) COMMENT "double ""quote"" (" INVISIBLE',
            "FULLTEXT ft_name (Note) COMMENT 'named index'",
            "FULLTEXT (Note) VISIBLE COMMENT 'unnamed'",
            "SPATIAL KEY sp_key (Shape) USING HASH KEY_BLOCK_SIZE 2048 "
            "COMMENT 'shape \\' ) (' INVISIBLE",
            'SPATIAL INDEX sp_index (Shape) ENGINE_ATTRIBUTE \'{"shape":"(polygon)"}\' '
            'SECONDARY_ENGINE_ATTRIBUTE = \'{"escaped":"x\\"y"}\' VISIBLE',
            "SPATIAL sp_name (Shape)",
            "SPATIAL (Shape)",
        ):
            with self.subTest(definition=definition):
                self.assertTrue(subject._is_unquoted_table_constraint(definition))
        for definition in (
            "FULLTEXT TEXT",
            "SPATIAL VARCHAR(32)",
            "FULLTEXT KEY missing_columns",
            "SPATIAL INDEX broken (Shape",
            "FULLTEXT ft_name (Note) UNKNOWN option",
            "SPATIAL (Shape) COMMENT unquoted",
            "FULLTEXT (Note) KEY_BLOCK_SIZE = nope",
            "FULLTEXT (Note) USING RTREE",
            'SPATIAL (Shape) ENGINE_ATTRIBUTE {"unquoted":true}',
            "SPATIAL (Shape) SECONDARY_ENGINE_ATTRIBUTE =",
            "FULLTEXT (Note) VISIBLE INVISIBLE",
        ):
            with self.subTest(definition=definition):
                self.assertFalse(subject._is_unquoted_table_constraint(definition))

        malformed = rb"CREATE TABLE `allexcel` (`unterminated bigint);"
        malformed_result = subject.filter_sql_dump(
            io.BytesIO(malformed), subject.TARGET_SEQ_NOS
        )
        self.assertEqual(malformed_result.integrity, "partial-parse-error")
        self.assertEqual(malformed_result.parse_rejected_statements, 1)

    def test_malformed_fulltext_spatial_indexes_downgrade_parse_integrity(self):
        for definition in (
            "FULLTEXT KEY missing_columns",
            "SPATIAL INDEX broken (Shape",
            "FULLTEXT ft_name (Note) UNKNOWN option",
            "SPATIAL (Shape) COMMENT unquoted",
            "FULLTEXT (Note) KEY_BLOCK_SIZE = nope",
            "FULLTEXT (Note) USING RTREE",
            'SPATIAL (Shape) ENGINE_ATTRIBUTE {"unquoted":true}',
            "SPATIAL (Shape) SECONDARY_ENGINE_ATTRIBUTE =",
            "FULLTEXT (Note) VISIBLE INVISIBLE",
        ):
            with self.subTest(definition=definition):
                fixture = f"""
CREATE TABLE `allexcel` (`SeqNo` bigint, {definition});
INSERT INTO `allexcel` VALUES (1893700);
""".encode()
                result = subject.filter_sql_dump(
                    io.BytesIO(fixture), subject.TARGET_SEQ_NOS
                )
                self.assertEqual(result.integrity, "partial-parse-error")
                self.assertEqual(result.parse_rejected_statements, 1)
                self.assertEqual(result.rows_by_table["allexcel"], [])


class MemberPolicyTests(unittest.TestCase):
    def test_target_sequence_numbers_and_member_filter_are_exact(self):
        self.assertEqual(subject.TARGET_SEQ_NOS, tuple(range(1_893_700, 1_893_711)))
        self.assertEqual(
            subject.normalize_member("image_copy/CamImageSource1/1893700/2D/a.jpg"),
            "image_copy/CamImageSource1/1893700/2D/a.jpg",
        )
        self.assertIsNone(subject.normalize_member("../escape.jpg"))
        self.assertFalse(
            subject.wanted_image_member("image_copy/CamImageSource1/1893699/2D/a.jpg")
        )
        self.assertTrue(
            subject.wanted_image_member("image_copy/CamImageSource6/1893710/3D/a.d3img")
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


class ExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.output_root = self.root / "batches"
        self.database_zip = self.root / "database.zip"
        self.part1 = self.root / "image_copy.part1.rar"
        self.part2 = self.root / "image_copy.part2.rar"
        self.database_zip.write_bytes(b"database-archive")
        self.part1.write_bytes(b"part-one")
        self.part2.write_bytes(b"part-two")
        self.unrar = self.root / "UnRAR.exe"
        self.unrar.write_bytes(b"not executed")
        self.normalized = self.root / "sql-output"
        subject.filter_sql_dump(
            io.BytesIO(
                b"CREATE TABLE `allexcel` (`SeqNo` bigint);"
                b"INSERT INTO `allexcel` VALUES (1893700);"
            ),
            subject.TARGET_SEQ_NOS,
            output_dir=self.normalized,
        )
        self.payloads = {
            "image_copy/CamImageSource1/1893700/2D/one.jpg": b"jpeg-one",
            "image_copy/CamImageSource1/1893700/3D/one.d3img": b"depth-one",
            "image_copy/CamImageSource6/1893710/3D/camera.dat": b"metadata-six",
        }
        self.inventory_path = self.root / "manifest.inventory.json"
        self._write_inventory()
        self.commands = []

    def tearDown(self):
        self.temp_dir.cleanup()

    def _archive_evidence(self, path):
        payload = path.read_bytes()
        details = path.stat()
        return {
            "path": str(path.resolve()),
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "fileIdentity": f"{details.st_dev}:{details.st_ino}",
            "mtimeNs": details.st_mtime_ns,
        }

    def _write_inventory(self, *, database_integrity="ok"):
        entries = [
            {
                "sha256": hashlib.sha256(b"normalized source").hexdigest(),
                "size": len(b"normalized source"),
                "archivePart": "database-zip",
                "memberPath": "ncdtube.sql",
                "cameraNumber": None,
                "seqNo": None,
                "kind": "database",
                "extension": ".sql",
                "integrityStatus": database_integrity,
                "integrityEvidence": None,
            }
        ]
        for member, payload in self.payloads.items():
            metadata = subject._image_metadata(member)
            self.assertIsNotNone(metadata)
            archive_part = "image-part2" if metadata["cameraNumber"] == 6 else "image-part1"
            entries.append(
                {
                    "sha256": None,
                    "size": len(payload),
                    "archivePart": archive_part,
                    "archiveParts": [archive_part],
                    "archiveMetadata": {
                        "type": "file",
                        "size": len(payload),
                        "crc32": None,
                    },
                    "volumeMetadata": {archive_part: {}},
                    "memberPath": member,
                    "integrityStatus": "listed-unverified",
                    "integrityEvidence": None,
                    **metadata,
                }
            )
        document = {
            "schema": "steel.bkv-archive-inventory.v1",
            "batchId": "batch-001",
            "archives": {
                "database-zip": self._archive_evidence(self.database_zip),
                "image-part1": self._archive_evidence(self.part1),
                "image-part2": self._archive_evidence(self.part2),
            },
            "statistics": {
                "database-zip": {"recordsSeen": 1, "accepted": 1, "rejected": 0},
                "image-part1": {"recordsSeen": 2, "accepted": 2, "rejected": 0},
                "image-part2": {"recordsSeen": 1, "accepted": 1, "rejected": 0},
            },
            "entries": entries,
        }
        self.inventory_path.write_text(json.dumps(document), encoding="utf-8")

    def _use_complete_target_coverage(self):
        for index, seq_no in enumerate(subject.TARGET_SEQ_NOS):
            camera = index % 6 + 1
            member = (
                f"image_copy/CamImageSource{camera}/{seq_no}/2D/"
                f"coverage-{seq_no}.jpg"
            )
            self.payloads.setdefault(member, f"jpeg-{camera}-{seq_no}".encode("ascii"))
        self._write_inventory()

    def _runner(self, command, **kwargs):
        self.commands.append((command, kwargs))
        member = command[-1]
        self.assertIn(member, self.payloads)
        self.assertEqual(kwargs["timeout"], subject.UNRAR_TIMEOUT_SECONDS)
        self.assertEqual(kwargs["max_stdout_bytes"], len(self.payloads[member]))
        self.assertEqual(kwargs["max_stderr_bytes"], subject.MAX_UNRAR_STDERR_BYTES)
        return subprocess.CompletedProcess(command, 0, self.payloads[member], b"")

    def _stage(self, **overrides):
        arguments = {
            "inventory_manifest": self.inventory_path,
            "normalized_output": self.normalized,
            "output_root": self.output_root,
            "batch_id": "batch-001",
            "unrar": self.unrar,
            "runner": self._runner,
        }
        arguments.update(overrides)
        return subject.stage_batch(**arguments)

    def test_extracts_only_explicit_inventory_members_and_publishes_verified_layout(self):
        self._use_complete_target_coverage()
        batch = self._stage()

        self.assertEqual(batch, self.output_root.resolve() / "batch-001")
        expected_commands = []
        for member in self.payloads:
            archive = self.part2 if "CamImageSource6" in member else self.part1
            expected_commands.append(
                [
                    str(self.unrar.resolve()),
                    "p",
                    "-inul",
                    "-cfg-",
                    "-p-",
                    str(archive.resolve()),
                    member,
                ]
            )
        self.assertEqual([call[0] for call in self.commands], expected_commands)
        self.assertFalse(any("*" in argument for command, _ in self.commands for argument in command))

        manifest = json.loads((batch / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(set(manifest), self._complete_manifest_fields())
        self.assertEqual(manifest["schema"], "steel.bkv-import-manifest.v1")
        self.assertEqual(manifest["status"], "ready")
        self.assertEqual(manifest["seqNos"], list(subject.TARGET_SEQ_NOS))
        self.assertEqual(manifest["presentSeqNos"], list(subject.TARGET_SEQ_NOS))
        self.assertTrue(manifest["targetCoverageComplete"])
        self.assertEqual(set(manifest["cameraInventory"]), {str(value) for value in range(1, 7)})
        self.assertTrue(manifest["databaseIntegrity"]["allInventoryMembersVerified"])
        self.assertEqual(manifest["counts"]["acceptedArtifacts"], len(self.payloads))
        self.assertEqual(manifest["counts"]["rejectedEntries"], 0)
        for artifact in manifest["artifacts"]:
            path = batch / Path(*PurePosixPath(artifact["path"]).parts)
            payload = path.read_bytes()
            self.assertEqual(artifact["size"], len(payload))
            self.assertEqual(artifact["sha256"], hashlib.sha256(payload).hexdigest())

        self.assertEqual(
            (batch / "artifacts/camera1/1893700/2d/one.jpg").read_bytes(),
            b"jpeg-one",
        )
        self.assertEqual(
            (batch / "artifacts/camera1/1893700/3d/one.d3img").read_bytes(),
            b"depth-one",
        )
        self.assertEqual(
            (batch / "artifacts/camera6/1893710/metadata/camera.dat").read_bytes(),
            b"metadata-six",
        )
        self.assertEqual(
            {path.name for path in (batch / "artifacts").iterdir()},
            {f"camera{number}" for number in range(1, 7)},
        )
        self.assertEqual(
            json.loads((batch / "source/inventory.json").read_text(encoding="utf-8"))["batchId"],
            "batch-001",
        )
        self.assertEqual((batch / "quarantine.jsonl").read_bytes(), b"")
        self.assertEqual(
            {path.name for path in (batch / "normalized").iterdir()},
            {f"{table}.jsonl" for table in subject._SQL_TABLES},
        )
        self.assertEqual(list(self.output_root.glob("batch-001.incoming-*")), [])

    def test_refuses_to_overwrite_a_precreated_stage_artifact(self):
        def overwrite_runner(command, **kwargs):
            if not self.commands:
                incoming = next(self.output_root.glob("batch-001.incoming-*"))
                destination = incoming / "artifacts/camera1/1893700/2d/one.jpg"
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(b"attacker")
            return self._runner(command, **kwargs)

        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage(runner=overwrite_runner)
        self.assertFalse((self.output_root / "batch-001").exists())
        self.assertEqual(
            subject._verify_staged_batch(
                raised.exception.failed_evidence_path, allow_failed=True
            )["status"],
            "failed",
        )

    def test_declared_total_is_rejected_before_any_unrar_member_runs(self):
        with mock.patch.object(subject, "MAX_STAGE_TOTAL_BYTES", 1):
            with self.assertRaises(subject.StageFailedError) as raised:
                self._stage()
        self.assertEqual(self.commands, [])
        self.assertFalse((self.output_root / "batch-001").exists())
        self.assertIn(
            "declared artifact total",
            (raised.exception.failed_evidence_path / "quarantine.jsonl").read_text(
                encoding="utf-8"
            ),
        )

    def test_duplicate_member_selects_volume_that_supplied_final_crc(self):
        entry = {
            "archiveParts": ["image-part1", "image-part2"],
            "archiveMetadata": {"crc32": "A1B2C3D4"},
            "volumeMetadata": {
                "image-part1": {"crc32": "A1B2C3D4"},
                "image-part2": {"crc32": None},
            },
        }
        self.assertEqual(subject._select_archive_part(entry), "image-part1")

    def test_second_run_revalidates_hashes_and_detects_changed_artifact(self):
        batch = self._stage()
        first_command_count = len(self.commands)
        self.assertEqual(self._stage(), batch)
        self.assertEqual(len(self.commands), first_command_count)

        (batch / "artifacts/camera1/1893700/2d/one.jpg").write_bytes(b"tampered")
        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage()
        self._assert_complete_failed_contract(raised.exception.failed_evidence_path)

    def test_same_batch_id_with_changed_source_archive_is_a_collision(self):
        self._stage()
        self.part1.write_bytes(b"changed!")
        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage()
        self._assert_complete_failed_contract(raised.exception.failed_evidence_path)

    def test_batch_output_may_not_overlap_supplied_normalized_output(self):
        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage(output_root=self.normalized / "nested-batches")
        self._assert_complete_failed_contract(raised.exception.failed_evidence_path)

    def test_extraction_failure_is_atomically_preserved_as_failed_evidence(self):
        def short_runner(command, **kwargs):
            result = self._runner(command, **kwargs)
            return subprocess.CompletedProcess(command, 0, result.stdout[:-1], b"")

        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage(runner=short_runner)
        self.assertFalse((self.output_root / "batch-001").exists())
        self.assertEqual(list(self.output_root.glob("batch-001.incoming-*")), [])
        failed = raised.exception.failed_evidence_path
        self.assertTrue(failed.name.startswith("batch-001.failed-"))
        manifest = subject._verify_staged_batch(failed, allow_failed=True)
        self.assertEqual(manifest["status"], "failed")
        self.assertFalse(manifest["importEligible"])
        self.assertEqual(manifest["seqNos"], list(subject.TARGET_SEQ_NOS))
        self.assertFalse(subject.batch_is_importable(failed))
        with self.assertRaisesRegex(ValueError, "failed"):
            subject._verify_staged_batch(failed)

    def test_hash_validation_failure_is_preserved_as_failed_evidence(self):
        verify = subject._verify_staged_batch
        tampered = False

        def tamper_before_verify(batch, *, allow_failed=False):
            nonlocal tampered
            batch = Path(batch)
            if not allow_failed and ".incoming-" in batch.name and not tampered:
                artifact = batch / "artifacts/camera1/1893700/2d/one.jpg"
                payload = artifact.read_bytes()
                artifact.write_bytes(bytes([payload[0] ^ 1]) + payload[1:])
                tampered = True
            return verify(batch, allow_failed=allow_failed)

        with mock.patch.object(
            subject, "_verify_staged_batch", side_effect=tamper_before_verify
        ):
            with self.assertRaises(subject.StageFailedError) as raised:
                self._stage()
        failed = raised.exception.failed_evidence_path
        self.assertFalse((self.output_root / "batch-001").exists())
        self.assertEqual(verify(failed, allow_failed=True)["status"], "failed")
        self.assertIn(
            "artifact hash mismatch",
            (failed / "quarantine.jsonl").read_text(encoding="utf-8"),
        )

    def test_invalid_camera_coverage_evidence_is_preserved_as_failed(self):
        inventory = json.loads(self.inventory_path.read_text(encoding="utf-8"))
        image = next(entry for entry in inventory["entries"] if entry["seqNo"] is not None)
        image["cameraNumber"] = 2
        self.inventory_path.write_text(json.dumps(inventory), encoding="utf-8")

        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage()
        failed = raised.exception.failed_evidence_path
        self.assertFalse((self.output_root / "batch-001").exists())
        manifest = subject._verify_staged_batch(failed, allow_failed=True)
        self.assertEqual(manifest["seqNos"], list(subject.TARGET_SEQ_NOS))
        self.assertEqual(manifest["presentSeqNos"], [])
        self.assertIn(
            "cameraNumber",
            (failed / "quarantine.jsonl").read_text(encoding="utf-8"),
        )

    def test_failed_quarantine_is_bounded_valid_utf8_jsonl(self):
        def unicode_failure_runner(command, **kwargs):
            raise RuntimeError("坏" * 5_000)

        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage(runner=unicode_failure_runner)
        payload = (raised.exception.failed_evidence_path / "quarantine.jsonl").read_bytes()
        self.assertLessEqual(len(payload), 8_192)
        document = json.loads(payload.decode("utf-8"))
        self.assertEqual(document["reason"], "RuntimeError")

    def _assert_complete_failed_contract(self, failed):
        manifest = subject._verify_staged_batch(failed, allow_failed=True)
        self.assertEqual(set(manifest), self._complete_manifest_fields())
        self.assertEqual(manifest["status"], "failed")
        self.assertFalse(manifest["importEligible"])
        self.assertEqual(manifest["seqNos"], list(subject.TARGET_SEQ_NOS))
        self.assertEqual(set(manifest["sourceArchives"]), {
            "database-zip", "image-part1", "image-part2"
        })
        self.assertEqual(set(manifest["cameraInventory"]), {
            str(number) for number in range(1, 7)
        })
        self.assertIn("databaseIntegrity", manifest)
        self.assertIn("counts", manifest)
        self.assertIn("artifacts", manifest)
        self.assertIn("coverage", manifest)
        self.assertEqual(manifest["counts"]["quarantineEntries"], 1)
        self.assertIn("code", manifest["failure"])
        self.assertIn("stage", manifest["failure"])
        return manifest

    def _complete_manifest_fields(self):
        return {
            "schema", "batchId", "status", "importEligible", "seqNos",
            "presentSeqNos", "targetCoverageComplete", "coverage",
            "sourceInventory", "sourceArchives", "databaseIntegrity", "counts",
            "cameraInventory", "normalized", "artifacts", "failure", "quarantine",
        }

    def test_invalid_inventory_schema_is_preserved_before_source_resolution(self):
        inventory = json.loads(self.inventory_path.read_text(encoding="utf-8"))
        inventory["schema"] = "invalid.schema"
        self.inventory_path.write_text(json.dumps(inventory), encoding="utf-8")

        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage()
        self.assertEqual(self.commands, [])
        self.assertFalse((self.output_root / "batch-001").exists())
        manifest = self._assert_complete_failed_contract(
            raised.exception.failed_evidence_path
        )
        self.assertEqual(manifest["failure"]["stage"], "inventory")

    def test_missing_inventory_file_publishes_complete_failed_evidence(self):
        self.inventory_path.unlink()
        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage()
        manifest = self._assert_complete_failed_contract(
            raised.exception.failed_evidence_path
        )
        self.assertEqual(manifest["failure"]["stage"], "inventory")
        self.assertIsNone(manifest["sourceInventory"]["sha256"])
        self.assertEqual(manifest["sourceInventory"]["evidenceStatus"], "unavailable")

    def test_missing_source_publishes_failed_evidence(self):
        self.part1.unlink()
        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage()
        manifest = self._assert_complete_failed_contract(
            raised.exception.failed_evidence_path
        )
        source = manifest["sourceArchives"]["image-part1"]
        self.assertIsNone(source["size"])
        self.assertIsNone(source["sha256"])
        self.assertEqual(source["evidenceStatus"], "unavailable")

    def test_bad_normalized_pointer_publishes_failed_evidence(self):
        (self.normalized / "normalized.current.json").write_text("{}", encoding="utf-8")
        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage()
        self._assert_complete_failed_contract(raised.exception.failed_evidence_path)

    def test_missing_unrar_publishes_failed_evidence(self):
        self.unrar.unlink()
        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage()
        self._assert_complete_failed_contract(raised.exception.failed_evidence_path)

    def test_precreated_quarantine_is_rejected_before_unrar_runs(self):
        real_mkdtemp = tempfile.mkdtemp

        def precreate_quarantine(*args, **kwargs):
            incoming = Path(real_mkdtemp(*args, **kwargs))
            (incoming / "quarantine.jsonl").write_bytes(b"attacker")
            return str(incoming)

        with mock.patch.object(
            subject.tempfile, "mkdtemp", side_effect=precreate_quarantine
        ):
            with self.assertRaises(FileExistsError):
                self._stage()
        self.assertEqual(self.commands, [])
        self.assertFalse((self.output_root / "batch-001").exists())

    @unittest.skipUnless(hasattr(os, "symlink"), "requires symlink support")
    def test_quarantine_symlink_never_writes_outside_incoming(self):
        outside = self.root / "outside.txt"
        outside.write_bytes(b"outside-safe")
        real_mkdtemp = tempfile.mkdtemp

        def symlink_quarantine(*args, **kwargs):
            incoming = Path(real_mkdtemp(*args, **kwargs))
            try:
                os.symlink(outside, incoming / "quarantine.jsonl")
            except OSError as error:
                self.skipTest(f"symlink unavailable: {error}")
            return str(incoming)

        with mock.patch.object(
            subject.tempfile, "mkdtemp", side_effect=symlink_quarantine
        ):
            with self.assertRaises((FileExistsError, ValueError)):
                self._stage()
        self.assertEqual(outside.read_bytes(), b"outside-safe")
        self.assertEqual(self.commands, [])

    def test_failed_verifier_checks_artifact_hashes_without_early_return(self):
        self._use_complete_target_coverage()

        def fail_after_first(command, **kwargs):
            if self.commands:
                raise RuntimeError("stop after one verified artifact")
            return self._runner(command, **kwargs)

        with self.assertRaises(subject.StageFailedError) as raised:
            self._stage(runner=fail_after_first)
        failed = raised.exception.failed_evidence_path
        manifest = self._assert_complete_failed_contract(failed)
        self.assertEqual(len(manifest["artifacts"]), 1)
        artifact = failed / Path(*PurePosixPath(manifest["artifacts"][0]["path"]).parts)
        artifact.write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "artifact.*mismatch"):
            subject._verify_staged_batch(failed, allow_failed=True)

    def test_partial_database_requires_explicit_operator_review(self):
        self._write_inventory(database_integrity="crc-failed")
        batch = self._stage()
        manifest = json.loads((batch / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["status"], "partial")
        self.assertFalse(subject.batch_is_importable(batch))
        self.assertTrue(subject.batch_is_importable(batch, operator_reviewed_partial=True))

    def test_incomplete_target_or_camera_coverage_is_partial(self):
        batch = self._stage()
        manifest = json.loads((batch / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["status"], "partial")
        self.assertEqual(manifest["seqNos"], list(subject.TARGET_SEQ_NOS))
        self.assertEqual(manifest["presentSeqNos"], [1_893_700, 1_893_710])
        self.assertFalse(manifest["targetCoverageComplete"])

    def test_stage_cli_routes_explicit_inventory_and_normalized_generation(self):
        expected = self.output_root / "batch-001"
        with mock.patch.object(subject, "stage_batch", return_value=expected) as stage:
            result = subject.main(
                [
                    "stage",
                    "--inventory-manifest",
                    str(self.inventory_path),
                    "--normalized-output",
                    str(self.normalized),
                    "--output-root",
                    str(self.output_root),
                    "--batch-id",
                    "batch-001",
                    "--unrar",
                    str(self.unrar),
                ]
            )
        self.assertEqual(result, 0)
        stage.assert_called_once_with(
            inventory_manifest=self.inventory_path,
            normalized_output=self.normalized,
            output_root=self.output_root,
            batch_id="batch-001",
            unrar=self.unrar,
        )

    def test_real_pipe_timeout_does_not_wait_for_blocked_stdout_read(self):
        released = threading.Event()

        class BlockingStream:
            def read(self, _size):
                released.wait(0.25)
                return b""

            def close(self):
                pass

        class EmptyStream:
            def read(self, _size):
                return b""

            def close(self):
                pass

        class HangingProcess:
            def __init__(self):
                self.stdout = BlockingStream()
                self.stderr = EmptyStream()

            def wait(self, timeout=None):
                if released.is_set():
                    return -9
                time.sleep(timeout or 0)
                raise subprocess.TimeoutExpired(["UnRAR.exe"], timeout)

            def kill(self):
                released.set()

        destination = self.root / "blocked-output.bin"
        started = time.monotonic()
        with mock.patch.object(subject.subprocess, "Popen", return_value=HangingProcess()):
            with mock.patch.object(subject, "UNRAR_TIMEOUT_SECONDS", 0.01):
                with self.assertRaisesRegex(RuntimeError, "timed out"):
                    subject._extract_unrar_member_default(
                        ["UnRAR.exe", "p", "member"], destination, 0
                    )
        self.assertLess(time.monotonic() - started, 0.1)


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
        listing = RAR_LISTING if archive == self.part1.resolve() else RAR_LISTING_PART2
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
            manifest_path,
            output_root.resolve() / "batch-001" / "manifest.inventory.json",
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["schema"], "steel.bkv-archive-inventory.v1")
        self.assertEqual(manifest["batchId"], "batch-001")
        self.assertFalse(
            (manifest_path.parent / "manifest.inventory.json.tmp").exists()
        )

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
            entry
            for entry in manifest["entries"]
            if entry["archivePart"] == "image-part1"
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
        self.assertEqual(
            manifest["statistics"]["image-part2"],
            {"recordsSeen": 1, "accepted": 1, "rejected": 0},
        )
        part2_entry = next(
            entry
            for entry in manifest["entries"]
            if entry["archivePart"] == "image-part2"
        )
        self.assertEqual(part2_entry["cameraNumber"], 5)

    def test_zip_crc_failure_is_recorded_not_reported_ok(self):
        original_open = zipfile.ZipFile.open

        def fail_member_open(archive, name, *args, **kwargs):
            if (
                name == "ncdtube.sql"
                or getattr(name, "filename", None) == "ncdtube.sql"
            ):
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

        with mock.patch.object(
            subject, "is_reparse_point", side_effect=output_is_reparse
        ):
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
        with mock.patch.object(subject, "MAX_INPUT_ARCHIVE_TOTAL_BYTES", 1):
            with self.assertRaisesRegex(
                subject.InventoryLimitError, "input archive bytes"
            ):
                subject.inventory_archives(
                    database_zip=self.database_zip,
                    image_part1=self.part1,
                    image_part2=self.part2,
                    output_root=self.root / "input-limit-output",
                    batch_id="input-limit",
                    unrar=self.unrar,
                    runner=self._runner,
                )

        with mock.patch.object(subject, "MAX_ZIP_MEMBERS", 0):
            with self.assertRaisesRegex(
                subject.InventoryLimitError, "ZIP member count"
            ):
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
            with self.assertRaisesRegex(
                subject.InventoryLimitError, "compression ratio"
            ):
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
        replacement_blocked = False

        def mutating_runner(command, **kwargs):
            nonlocal replacement_blocked
            archive = Path(command[-1])
            if archive == self.part1.resolve():
                replacement = self.root / "replacement.rar"
                replacement.write_bytes(b"replacement"[: self.part1.stat().st_size])
                original = self.part1.stat()
                os.utime(
                    replacement,
                    ns=(original.st_atime_ns, original.st_mtime_ns),
                )
                try:
                    os.replace(replacement, self.part1)
                except PermissionError:
                    replacement_blocked = True
                return subprocess.CompletedProcess(command, 0, RAR_LISTING, "")
            return subprocess.CompletedProcess(command, 0, RAR_LISTING_PART2, "")

        subject.inventory_archives(
            database_zip=self.database_zip,
            image_part1=self.part1,
            image_part2=self.part2,
            output_root=self.root / "changed-output",
            batch_id="changed",
            unrar=self.unrar,
            runner=mutating_runner,
        )
        if os.name == "nt":
            self.assertTrue(
                replacement_blocked, "Windows input lock allowed replacement"
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

    def test_two_rar_volumes_merge_unique_and_identical_duplicate_members(self):
        shared = "image_copy/CamImageSource4/1893705/3D/shared.d3img"
        first_listing = f"""Name: image_copy/CamImageSource1/1893700/2D/one.jpg
Type: File
Size: 11
CRC32: 11111111
Attributes: ..A....

Name: {shared}
Type: File
Size: 44
Attributes: ..A....
"""
        second_listing = f"""名称: {shared}
类型: 文件
大小: 44
CRC32: ABCDEF12
属性: ..A....

名称: image_copy/CamImageSource6/1893710/2D/six.jpg
类型: 文件
大小: 66
CRC32: 66666666
属性: ..A....
"""

        def two_volume_runner(command, **kwargs):
            listing = (
                first_listing
                if Path(command[-1]) == self.part1.resolve()
                else second_listing
            )
            return subprocess.CompletedProcess(command, 0, listing, "")

        manifest_path = subject.inventory_archives(
            database_zip=self.database_zip,
            image_part1=self.part1,
            image_part2=self.part2,
            output_root=self.root / "two-volume-output",
            batch_id="two-volume",
            unrar=self.unrar,
            runner=two_volume_runner,
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        image_entries = [entry for entry in manifest["entries"] if entry["seqNo"]]
        self.assertEqual(len(image_entries), 3)
        shared_entry = next(
            entry for entry in image_entries if entry["memberPath"] == shared
        )
        self.assertEqual(shared_entry["archiveParts"], ["image-part1", "image-part2"])
        self.assertEqual(shared_entry["archiveMetadata"]["crc32"], "ABCDEF12")
        self.assertEqual(manifest["statistics"]["image-part1"]["accepted"], 2)
        self.assertEqual(manifest["statistics"]["image-part2"]["accepted"], 2)

        conflicts = (
            second_listing.replace("大小: 44", "大小: 45"),
            second_listing.replace("属性: ..A....", "属性: ..D....", 1),
        )
        for index, conflicting_listing in enumerate(conflicts):
            with self.subTest(conflict=index):

                def conflict_runner(command, **kwargs):
                    listing = (
                        first_listing
                        if Path(command[-1]) == self.part1.resolve()
                        else conflicting_listing
                    )
                    return subprocess.CompletedProcess(command, 0, listing, "")

                with self.assertRaisesRegex(ValueError, "conflicting duplicate"):
                    subject.inventory_archives(
                        database_zip=self.database_zip,
                        image_part1=self.part1,
                        image_part2=self.part2,
                        output_root=self.root / f"conflict-output-{index}",
                        batch_id=f"conflict-{index}",
                        unrar=self.unrar,
                        runner=conflict_runner,
                    )

        first_with_crc = first_listing.replace(
            "Size: 44\nAttributes:", "Size: 44\nCRC32: ABCDEF12\nAttributes:"
        )
        second_crc_conflict = second_listing.replace("ABCDEF12", "DEADBEEF")

        def crc_conflict_runner(command, **kwargs):
            listing = (
                first_with_crc
                if Path(command[-1]) == self.part1.resolve()
                else second_crc_conflict
            )
            return subprocess.CompletedProcess(command, 0, listing, "")

        with self.assertRaisesRegex(ValueError, "conflicting duplicate"):
            subject.inventory_archives(
                database_zip=self.database_zip,
                image_part1=self.part1,
                image_part2=self.part2,
                output_root=self.root / "crc-conflict-output",
                batch_id="crc-conflict",
                unrar=self.unrar,
                runner=crc_conflict_runner,
            )

    def test_zip_eocd_central_directory_limits_and_deadline(self):
        with mock.patch.object(subject, "MAX_ZIP_CENTRAL_DIRECTORY_RECORDS", 0):
            with self.assertRaisesRegex(subject.InventoryLimitError, "record count"):
                subject._inspect_zip_structure(self.database_zip)

        with mock.patch.object(subject, "MAX_ZIP_CENTRAL_DIRECTORY_BYTES", 1):
            with self.assertRaisesRegex(
                subject.InventoryLimitError, "central directory bytes"
            ):
                subject._inspect_zip_structure(self.database_zip)

        malformed = self.root / "malformed-eocd.zip"
        malformed.write_bytes(b"not-a-zip")
        with self.assertRaisesRegex(zipfile.BadZipFile, "EOCD"):
            subject._inspect_zip_structure(malformed)

        sentinel = self.root / "zip64-sentinel.zip"
        sentinel.write_bytes(
            struct.pack(
                "<4s4H2LH",
                b"PK\x05\x06",
                0,
                0,
                0xFFFF,
                0xFFFF,
                0xFFFFFFFF,
                0xFFFFFFFF,
                0,
            )
        )
        with self.assertRaisesRegex(zipfile.BadZipFile, "ZIP64"):
            subject._inspect_zip_structure(sentinel)

        with mock.patch.object(subject, "ZIP_INVENTORY_TIMEOUT_SECONDS", -1):
            with self.assertRaisesRegex(TimeoutError, "deadline"):
                subject._inventory_zip(self.database_zip)

    def test_zip64_dual_interpretation_and_locator_gap_are_rejected(self):
        def zip64_record(records):
            return struct.pack(
                "<4sQ2H2L4Q",
                b"PK\x06\x06",
                44,
                45,
                45,
                0,
                0,
                records,
                records,
                0,
                0,
            )

        eocd = struct.pack(
            "<4s4H2LH",
            b"PK\x05\x06",
            0,
            0,
            0xFFFF,
            0xFFFF,
            0xFFFFFFFF,
            0xFFFFFFFF,
            0,
        )
        malicious = self.root / "dual-zip64.zip"
        first = zip64_record(0)
        adjacent = zip64_record(99_999)
        locator = struct.pack("<4sLQL", b"PK\x06\x07", 0, 0, 1)
        malicious.write_bytes(first + adjacent + locator + eocd)
        with self.assertRaisesRegex(zipfile.BadZipFile, "ZIP64.*layout"):
            subject._inspect_zip_structure(malicious)

        gap = self.root / "gap-zip64.zip"
        locator_offset = len(first) + 8
        gap_locator = struct.pack("<4sLQL", b"PK\x06\x07", 0, 0, 1)
        self.assertEqual(locator_offset, 64)
        gap.write_bytes(first + b"gap-data" + gap_locator + eocd)
        with self.assertRaisesRegex(zipfile.BadZipFile, "ZIP64.*layout"):
            subject._inspect_zip_structure(gap)

    @unittest.skipUnless(os.name == "nt", "Windows locking contract")
    def test_size_is_rechecked_from_locked_file_after_prelock_replacement(self):
        replacement = self.root / "larger-part1.rar"
        replacement.write_bytes(b"x" * 32)
        original_open = subject._open_windows_locked_file
        replaced = False

        def replace_then_lock(path):
            nonlocal replaced
            if Path(path) == self.part1.resolve() and not replaced:
                os.replace(replacement, self.part1)
                replaced = True
            return original_open(path)

        with mock.patch.object(subject, "MAX_INPUT_ARCHIVE_BYTES", 16):
            with mock.patch.object(
                subject, "_open_windows_locked_file", side_effect=replace_then_lock
            ):
                with self.assertRaisesRegex(
                    subject.InventoryLimitError, "locked input archive bytes"
                ):
                    subject.inventory_archives(
                        database_zip=self.database_zip,
                        image_part1=self.part1,
                        image_part2=self.part2,
                        output_root=self.root / "locked-size-output",
                        batch_id="locked-size",
                        unrar=self.unrar,
                        runner=self._runner,
                    )

    def test_controlled_snapshot_copy_counts_actual_stream_bytes(self):
        source = self.root / "growing-source.rar"
        source.write_bytes(b"0123456789")
        destination = self.root / "snapshot.rar"
        with mock.patch.object(subject, "MAX_INPUT_ARCHIVE_BYTES", 5):
            with self.assertRaisesRegex(
                subject.InventoryLimitError, "snapshot input archive bytes"
            ):
                subject._copy_snapshot_bounded(
                    source,
                    destination,
                    deadline=float("inf"),
                    cumulative_bytes=0,
                )
            with self.assertRaisesRegex(
                subject.InventoryLimitError, "hash input archive bytes"
            ):
                subject._sha256_file(source, deadline=float("inf"))

    def test_controlled_snapshot_space_preflight_uses_maximum_allowed_bytes(self):
        available = subject.MAX_INPUT_ARCHIVE_TOTAL_BYTES
        with mock.patch.object(subject, "_is_windows", return_value=False):
            with mock.patch.object(
                subject.shutil,
                "disk_usage",
                return_value=mock.Mock(free=available),
            ):
                with self.assertRaisesRegex(
                    subject.InventoryLimitError, "controlled snapshot requires"
                ):
                    with subject._stable_archive_inputs(
                        (self.database_zip, self.part1, self.part2)
                    ):
                        self.fail("space preflight unexpectedly allowed snapshot copy")


@unittest.skipUnless(
    os.name == "nt"
    and Path(r"C:\Program Files\WinRAR\UnRAR.exe").is_file()
    and Path(r"C:\Program Files\WinRAR\WinRAR.exe").is_file(),
    "requires local WinRAR and UnRAR executables",
)
class RealUnrarSmokeTests(unittest.TestCase):
    def test_real_unrar_p_extracts_exact_member_bytes_and_sha256(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_path = root / "smoke.rar"
            member = "single-member.dat"
            payload = b"BKV-stage-real-pipe-smoke"
            self.assertEqual(len(payload), 25)
            source = root / member
            source.write_bytes(payload)
            created = subprocess.run(
                [
                    r"C:\Program Files\WinRAR\WinRAR.exe",
                    "a",
                    "-cfg-",
                    "-ep",
                    str(archive_path),
                    member,
                ],
                cwd=root,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=30,
            )
            self.assertEqual(created.returncode, 0, created.stderr)
            destination = root / "safe-output" / "extracted.dat"
            destination.parent.mkdir()
            evidence = subject._extract_unrar_member(
                unrar=Path(r"C:\Program Files\WinRAR\UnRAR.exe"),
                archive=archive_path,
                member=member,
                destination=destination,
                expected_size=len(payload),
                runner=None,
            )
            self.assertEqual(destination.read_bytes(), payload)
            self.assertEqual(evidence["size"], 25)
            self.assertEqual(evidence["sha256"], hashlib.sha256(payload).hexdigest())


@unittest.skipUnless(
    os.environ.get("BKV_SUPPLIED_ARCHIVE_DIR")
    and Path(r"C:\Program Files\WinRAR\UnRAR.exe").is_file(),
    "set BKV_SUPPLIED_ARCHIVE_DIR for supplied read-only archive smoke",
)
class SuppliedArchiveSmokeTests(unittest.TestCase):
    def test_both_supplied_rar_volumes_have_unique_target_members_and_six_cameras(self):
        root = Path(os.environ["BKV_SUPPLIED_ARCHIVE_DIR"])
        unrar = Path(r"C:\Program Files\WinRAR\UnRAR.exe")
        smoke_parent = Path(os.environ.get("BKV_SMOKE_OUTPUT_ROOT", r"E:\Temp\codex"))
        smoke_parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="bkv-supplied-contract-", dir=smoke_parent
        ) as directory:
            manifest_path = subject.inventory_archives(
                database_zip=root / "database.zip",
                image_part1=root / "image_copy.part1.rar",
                image_part2=root / "image_copy.part2.rar",
                output_root=Path(directory) / "output",
                batch_id="supplied-contract",
                unrar=unrar,
            )
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        images = [entry for entry in manifest["entries"] if entry["seqNo"] is not None]
        cameras = {entry["cameraNumber"] for entry in images}
        shared = [entry for entry in images if len(entry["archiveParts"]) == 2]
        self.assertEqual(len(images), 2_724)
        self.assertEqual(cameras, set(range(1, 7)))
        self.assertEqual(len(shared), 1)
        self.assertEqual(shared[0]["archiveParts"], ["image-part1", "image-part2"])
        self.assertEqual(manifest["schema"], "steel.bkv-archive-inventory.v1")
        self.assertEqual(manifest["statistics"]["image-part1"]["accepted"], 1_441)
        self.assertEqual(manifest["statistics"]["image-part2"]["accepted"], 1_284)
        for archive in manifest["archives"].values():
            self.assertRegex(archive["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            next(
                entry["integrityStatus"]
                for entry in manifest["entries"]
                if entry["archivePart"] == "database-zip"
            ),
            "crc-failed",
        )
        print(
            json.dumps(
                {
                    "part1": manifest["statistics"]["image-part1"],
                    "part2": manifest["statistics"]["image-part2"],
                    "overlap": len(shared),
                    "union": len(images),
                    "cameras": sorted(cameras),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )


if __name__ == "__main__":
    unittest.main()
