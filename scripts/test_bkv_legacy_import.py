import contextlib
import hashlib
import io
import json
import os
import stat
import struct
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
        cases = (
            ("MAX_SQL_TABLE_ROWS", 1, direct, "table rows"),
            ("MAX_SQL_NORMALIZED_BYTES", 1, direct, "normalized bytes"),
            ("MAX_SQL_RELATIONSHIP_KEYS", 1, direct, "relationship keys"),
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
            with subject._stable_archive_inputs((archive_path,)) as working:
                output = subject._run_unrar_listing(
                    Path(r"C:\Program Files\WinRAR\UnRAR.exe"),
                    working[archive_path],
                )
            records = subject._parse_unrar_listing(output)
            entries, statistics = subject._records_to_rar_entries(
                records, "image-part1"
            )
            self.assertEqual([entry["memberPath"] for entry in entries], [member])
            self.assertGreaterEqual(statistics["recordsSeen"], 1)


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
