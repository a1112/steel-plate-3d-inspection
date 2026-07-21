#!/usr/bin/env python3
"""Fail-closed inventory tooling for untrusted BKV legacy archives."""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import hashlib
import io
import json
import locale
import os
import re
import shutil
import stat
import struct
import subprocess
import tempfile
import threading
import time
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import BinaryIO, Callable, Iterable, Sequence

TARGET_SEQ_NOS = tuple(range(1_893_700, 1_893_711))
MANIFEST_NAME = "manifest.inventory.json"
MANIFEST_SCHEMA = "steel.bkv-archive-inventory.v1"
MAX_ZIP_MEMBERS = 100_000
MAX_ZIP_CENTRAL_DIRECTORY_RECORDS = 100_000
MAX_ZIP_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024
MAX_ZIP64_EOCD_BYTES = 1024 * 1024
MAX_INPUT_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_INPUT_ARCHIVE_TOTAL_BYTES = 4 * 1024 * 1024 * 1024
INPUT_SNAPSHOT_TIMEOUT_SECONDS = 600
MAX_ZIP_MEMBER_BYTES = 2 * 1024 * 1024 * 1024
MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024
MAX_ZIP_COMPRESSION_RATIO = 100
ZIP_INVENTORY_TIMEOUT_SECONDS = 300
MAX_RAR_LISTING_RECORDS = 1_000_000
MAX_UNRAR_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_MANIFEST_BYTES = 128 * 1024 * 1024
MAX_SQL_STATEMENT_BYTES = 64 * 1024 * 1024
MAX_SQL_FIELD_BYTES = 1024 * 1024
MAX_SQL_RESULT_ROWS = 1_000_000
MAX_SQL_REJECTED_ROWS = 100_000
UNRAR_TIMEOUT_SECONDS = 300
_IO_CHUNK_BYTES = 64 * 1024
_ZIP_EOCD_SEARCH_BYTES = 65_557
_BATCH_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_IMAGE_MEMBER = re.compile(
    r"image_copy/CamImageSource(?P<camera>[1-6])/(?P<seq>\d+)/"
    r"(?P<kind>2D|3D)/(?P<name>[^/]+(?P<extension>\.jpg|\.d3img|\.dat))\Z",
    re.IGNORECASE,
)
_WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}
_UNRAR_KEY_ALIASES = {
    "name": "name",
    "名称": "name",
    "type": "type",
    "类型": "type",
    "size": "size",
    "大小": "size",
    "target": "target",
    "目标": "target",
    "redirection": "redirection",
    "重定向": "redirection",
    "crc32": "crc32",
    "pack-crc32": "packCrc32",
    "attributes": "attributes",
    "属性": "attributes",
    "packed size": "packedSize",
    "打包大小": "packedSize",
    "ratio": "ratio",
    "压缩率": "ratio",
    "modified": "modified",
    "已修改": "modified",
    "host os": "hostOS",
    "压缩平台": "hostOS",
    "compression": "compression",
    "压缩": "compression",
}


class InventoryLimitError(RuntimeError):
    """Raised when untrusted input exceeds a named inventory bound."""


class SqlDumpLimitError(RuntimeError):
    """Raised when an untrusted SQL dump exceeds a named parser bound."""


@dataclass(frozen=True)
class FileSnapshot:
    device: int
    inode: int
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class _SqlTableSchema:
    columns: tuple[str, ...]
    foreign_keys: dict[str, tuple[str, str]]


@dataclass(frozen=True)
class _SqlTuple:
    raw_text: str
    tokens: tuple[str, ...]


@dataclass
class SqlDumpResult:
    rows_by_seq: dict[int, list[dict[str, object]]]
    rows_by_table: dict[str, list[dict[str, object]]]
    rejected_rows: list[dict[str, object]]
    counts: dict[str, dict[str, int]]
    integrity: str = "ok"
    diameter_complete: bool = False


def wanted_seq_no(value: int) -> bool:
    """Return whether value belongs to the exact approved legacy batch."""
    return value in TARGET_SEQ_NOS


_SQL_TABLES = ("allexcel", "checkrecord", "defect", "defectclass", "diameter")
_PHYSICAL_COLUMN_NAMES = {
    "depth",
    "diameter",
    "height",
    "length",
    "measurement",
    "radius",
    "thickness",
    "width",
}
_SQL_IDENTIFIER = r"(?:`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)"


def _identifier_value(value: str) -> str:
    return value[1:-1] if value.startswith("`") and value.endswith("`") else value


def _normalized_identifier(value: str) -> str:
    return value.casefold()


def _iter_sql_statements(source: BinaryIO) -> Iterable[str]:
    statement = bytearray()
    quote: int | None = None
    escaped = False
    quote_maybe_end = False
    while True:
        chunk = source.read(_IO_CHUNK_BYTES)
        if not chunk:
            break
        if not isinstance(chunk, (bytes, bytearray)):
            raise TypeError("SQL source must return bytes")
        for byte in chunk:
            statement.append(byte)
            if len(statement) > MAX_SQL_STATEMENT_BYTES:
                raise SqlDumpLimitError(
                    f"statement bytes exceed MAX_SQL_STATEMENT_BYTES={MAX_SQL_STATEMENT_BYTES}"
                )
            if quote is not None:
                if escaped:
                    escaped = False
                    continue
                if quote_maybe_end:
                    if byte == quote:
                        quote_maybe_end = False
                        continue
                    quote = None
                    quote_maybe_end = False
                elif byte == 0x5C and quote in (0x27, 0x22):
                    escaped = True
                    continue
                elif byte == quote:
                    quote_maybe_end = True
                    continue
                else:
                    continue
            if byte in (0x27, 0x22, 0x60):
                quote = byte
            elif byte == 0x3B:
                yield bytes(statement).decode("utf-8", errors="surrogateescape")
                statement.clear()
    if statement.strip():
        yield bytes(statement).decode("utf-8", errors="surrogateescape")


def _split_sql_items(value: str) -> list[str]:
    items: list[str] = []
    start = 0
    depth = 0
    quote: str | None = None
    escaped = False
    index = 0
    while index < len(value):
        character = value[index]
        if quote is not None:
            if escaped:
                escaped = False
            elif character == "\\" and quote in ("'", '"'):
                escaped = True
            elif character == quote:
                if index + 1 < len(value) and value[index + 1] == quote:
                    index += 2
                    continue
                quote = None
            index += 1
            continue
        if character in ("'", '"', "`"):
            quote = character
        elif character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
        elif character == "," and depth == 0:
            items.append(value[start:index].strip())
            start = index + 1
        index += 1
    items.append(value[start:].strip())
    return items


def _extract_parenthesized(value: str, opening: int) -> tuple[str, int] | None:
    if opening >= len(value) or value[opening] != "(":
        return None
    depth = 1
    quote: str | None = None
    escaped = False
    index = opening + 1
    while index < len(value):
        character = value[index]
        if quote is not None:
            if escaped:
                escaped = False
            elif character == "\\" and quote in ("'", '"'):
                escaped = True
            elif character == quote:
                if index + 1 < len(value) and value[index + 1] == quote:
                    index += 2
                    continue
                quote = None
            index += 1
            continue
        if character in ("'", '"', "`"):
            quote = character
        elif character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
            if depth == 0:
                return value[opening + 1 : index], index
        index += 1
    return None


def _parse_create_table(statement: str) -> tuple[str, _SqlTableSchema] | None:
    match = re.search(
        rf"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<table>{_SQL_IDENTIFIER})\s*(?P<open>\()",
        statement,
        re.IGNORECASE,
    )
    if match is None:
        return None
    extracted = _extract_parenthesized(statement, match.start("open"))
    if extracted is None:
        return None
    body, _closing = extracted
    table = _normalized_identifier(_identifier_value(match.group("table")))
    columns: list[str] = []
    foreign_keys: dict[str, tuple[str, str]] = {}
    for definition in _split_sql_items(body):
        column_match = re.match(rf"\s*(?P<column>{_SQL_IDENTIFIER})\s+", definition)
        if column_match is not None:
            candidate = _identifier_value(column_match.group("column"))
            if candidate.casefold() not in {
                "constraint",
                "foreign",
                "primary",
                "unique",
                "key",
                "check",
            }:
                columns.append(candidate)
        foreign_match = re.search(
            rf"\bFOREIGN\s+KEY\s*\(\s*(?P<local>{_SQL_IDENTIFIER})\s*\)\s*"
            rf"REFERENCES\s+(?P<parent>{_SQL_IDENTIFIER})\s*\(\s*(?P<parent_column>{_SQL_IDENTIFIER})\s*\)",
            definition,
            re.IGNORECASE | re.DOTALL,
        )
        if foreign_match is not None:
            local = _identifier_value(foreign_match.group("local"))
            parent_table = _identifier_value(foreign_match.group("parent"))
            parent_column = _identifier_value(foreign_match.group("parent_column"))
            foreign_keys[_normalized_identifier(local)] = (
                _normalized_identifier(parent_table),
                _normalized_identifier(parent_column),
            )
    if not columns:
        return None
    return table, _SqlTableSchema(tuple(columns), foreign_keys)


def _mysql_unescape(value: str) -> str:
    escapes = {
        "0": "\0",
        "b": "\b",
        "n": "\n",
        "r": "\r",
        "t": "\t",
        "Z": "\x1a",
        "\\": "\\",
        "'": "'",
        '"': '"',
    }
    output: list[str] = []
    index = 0
    while index < len(value):
        character = value[index]
        if character == "\\" and index + 1 < len(value):
            index += 1
            output.append(escapes.get(value[index], value[index]))
        elif (
            index + 1 < len(value)
            and value[index + 1] == character
            and character in ("'", '"')
        ):
            output.append(character)
            index += 1
        else:
            output.append(character)
        index += 1
    return "".join(output)


def _parse_sql_value(token: str) -> object:
    token = token.strip()
    if len(token.encode("utf-8", errors="surrogateescape")) > MAX_SQL_FIELD_BYTES:
        raise SqlDumpLimitError("field_too_long")
    if token.casefold() == "null":
        return None
    if len(token) >= 2 and token[0] in ("'", '"') and token[-1] == token[0]:
        return _mysql_unescape(token[1:-1])
    if re.fullmatch(r"[+-]?\d+", token):
        return int(token)
    if re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?", token):
        return float(token)
    raise ValueError("unsupported SQL value")


def _parse_values_rows(value: str) -> tuple[list[_SqlTuple], bool]:
    value = value.rstrip().removesuffix(";").rstrip()
    rows: list[_SqlTuple] = []
    index = 0
    while True:
        while index < len(value) and value[index].isspace():
            index += 1
        if index == len(value):
            return rows, bool(rows)
        extracted = _extract_parenthesized(value, index)
        if extracted is None:
            return [], False
        body, closing = extracted
        raw_text = value[index : closing + 1]
        rows.append(_SqlTuple(raw_text, tuple(_split_sql_items(body))))
        index = closing + 1
        while index < len(value) and value[index].isspace():
            index += 1
        if index == len(value):
            return rows, True
        if value[index] != ",":
            return [], False
        index += 1


def _parse_insert(
    statement: str,
) -> tuple[str, tuple[str, ...] | None, list[_SqlTuple], bool] | None:
    match = re.search(
        rf"\bINSERT\s+INTO\s+(?P<table>{_SQL_IDENTIFIER})",
        statement,
        re.IGNORECASE,
    )
    if match is None:
        return None
    table = _normalized_identifier(_identifier_value(match.group("table")))
    remainder = statement[match.end() :].lstrip()
    columns: tuple[str, ...] | None = None
    if remainder.startswith("("):
        extracted = _extract_parenthesized(remainder, 0)
        if extracted is None:
            return table, (), [], False
        column_text, closing = extracted
        parsed_columns: list[str] = []
        valid_columns = True
        for item in _split_sql_items(column_text):
            column_match = re.fullmatch(rf"\s*(?P<column>{_SQL_IDENTIFIER})\s*", item)
            if column_match is None:
                valid_columns = False
                continue
            parsed_columns.append(_identifier_value(column_match.group("column")))
        columns = tuple(parsed_columns) if valid_columns else ()
        remainder = remainder[closing + 1 :].lstrip()
    values_match = re.match(r"VALUES\b", remainder, re.IGNORECASE)
    if values_match is None:
        return table, columns, [], False
    rows, row_count_known = _parse_values_rows(remainder[values_match.end() :])
    return table, columns, rows, row_count_known


def _row_target_seq(
    schema: _SqlTableSchema,
    row: dict[str, object],
    targets: frozenset[int],
    retained_relationships: dict[tuple[str, str], dict[object, int | None]],
) -> tuple[int | None, bool]:
    normalized = {_normalized_identifier(key): value for key, value in row.items()}
    if "seqno" in normalized:
        direct = normalized["seqno"]
        return (direct if isinstance(direct, int) and direct in targets else None), True
    for local_column, (parent_table, parent_column) in schema.foreign_keys.items():
        value = normalized.get(local_column)
        parent_values = retained_relationships.get((parent_table, parent_column), {})
        try:
            target_seq = parent_values.get(value)
        except TypeError:
            target_seq = None
        if target_seq is not None:
            return target_seq, True
    return None, False


def _stable_row_hash(table: str, columns: Sequence[str], raw_tuple: str) -> str:
    """Hash UTF-8/surrogateescape SQL with CRLF and CR canonically mapped to LF."""
    normalized_tuple = raw_tuple.replace("\r\n", "\n").replace("\r", "\n")
    context = json.dumps(
        [table.casefold(), [column.casefold() for column in columns]],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    payload = (
        "steel.bkv-original-sql-tuple.v1\n" + context + "\n" + normalized_tuple
    ).encode("utf-8", errors="surrogateescape")
    return hashlib.sha256(payload).hexdigest()


def _write_sql_jsonl(output_dir: Path, result: SqlDumpResult) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    for table in _SQL_TABLES:
        destination = output_dir / f"{table}.jsonl"
        with destination.open("w", encoding="utf-8", newline="\n") as output:
            for row in result.rows_by_table[table]:
                output.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def filter_sql_dump(
    source: BinaryIO,
    target_seq_nos: Sequence[int],
    *,
    output_dir: os.PathLike[str] | str | None = None,
) -> SqlDumpResult:
    """Stream a MySQL dump and retain only schema-proven target relationships."""
    targets = frozenset(target_seq_nos)
    if targets != frozenset(TARGET_SEQ_NOS):
        raise ValueError("target SeqNo allowlist must exactly match TARGET_SEQ_NOS")
    result = SqlDumpResult(
        rows_by_seq={},
        rows_by_table={table: [] for table in _SQL_TABLES},
        rejected_rows=[],
        counts={
            table: {
                "accepted": 0,
                "rejected": 0,
                "statementRejectedRowsUnknown": 0,
            }
            for table in _SQL_TABLES
        },
    )
    schemas: dict[str, _SqlTableSchema] = {}
    retained_relationships: dict[tuple[str, str], dict[object, int | None]] = {}

    def reject(table: str, reason: str) -> None:
        result.counts[table]["rejected"] += 1
        if len(result.rejected_rows) >= MAX_SQL_REJECTED_ROWS:
            raise SqlDumpLimitError(
                f"rejected rows exceed MAX_SQL_REJECTED_ROWS={MAX_SQL_REJECTED_ROWS}"
            )
        result.rejected_rows.append({"table": table, "reason": reason})

    try:
        for statement in _iter_sql_statements(source):
            created = _parse_create_table(statement)
            if created is not None:
                table, schema = created
                if table in _SQL_TABLES:
                    schemas[table] = schema
                continue
            inserted = _parse_insert(statement)
            if inserted is None:
                continue
            table, explicit_columns, sql_rows, row_count_known = inserted
            if table not in _SQL_TABLES:
                continue
            if not row_count_known:
                result.counts[table]["statementRejectedRowsUnknown"] += 1
                continue
            schema = schemas.get(table)
            if schema is None:
                for _sql_row in sql_rows:
                    reject(table, "schema_unknown")
                continue
            columns = (
                explicit_columns if explicit_columns is not None else schema.columns
            )
            schema_names = {column.casefold() for column in schema.columns}
            if not columns or any(
                column.casefold() not in schema_names for column in columns
            ):
                for _sql_row in sql_rows:
                    reject(table, "malformed_insert")
                continue
            for sql_row in sql_rows:
                tokens = sql_row.tokens
                if len(tokens) != len(columns):
                    reject(table, "malformed_insert")
                    continue
                try:
                    values = [_parse_sql_value(token) for token in tokens]
                except SqlDumpLimitError as error:
                    if str(error) == "field_too_long":
                        reject(table, "field_too_long")
                        continue
                    raise
                except (TypeError, ValueError, OverflowError):
                    reject(table, "malformed_insert")
                    continue
                row = dict(zip(columns, values, strict=True))
                invalid_numeric = any(
                    isinstance(value, float)
                    and not (float("-inf") < value < float("inf"))
                    for value in values
                )
                if invalid_numeric:
                    reject(table, "non_finite_numeric")
                    continue
                negative_dimension = any(
                    column.casefold() in _PHYSICAL_COLUMN_NAMES
                    and isinstance(value, (int, float))
                    and not isinstance(value, bool)
                    and value < 0
                    for column, value in row.items()
                )
                if negative_dimension:
                    reject(table, "negative_physical_dimension")
                    continue
                target_seq, relationship_proven = _row_target_seq(
                    schema, row, targets, retained_relationships
                )
                if not relationship_proven:
                    reject(table, "relationship_unproven")
                    continue
                if target_seq is None:
                    reject(table, "seq_not_target")
                    continue
                accepted_total = sum(
                    item["accepted"] for item in result.counts.values()
                )
                if accepted_total >= MAX_SQL_RESULT_ROWS:
                    raise SqlDumpLimitError(
                        f"accepted rows exceed MAX_SQL_RESULT_ROWS={MAX_SQL_RESULT_ROWS}"
                    )
                normalized_row = dict(row)
                normalized_row["legacySeqNo"] = target_seq
                normalized_row["legacyTable"] = table
                normalized_row["originalRowHash"] = _stable_row_hash(
                    table, columns, sql_row.raw_text
                )
                result.rows_by_table[table].append(normalized_row)
                result.rows_by_seq.setdefault(target_seq, []).append(normalized_row)
                result.counts[table]["accepted"] += 1
                for column, value in row.items():
                    if value is None:
                        continue
                    try:
                        hash(value)
                    except TypeError:
                        continue
                    relationship_values = retained_relationships.setdefault(
                        (table, column.casefold()), {}
                    )
                    previous = relationship_values.get(value)
                    if previous is None and value not in relationship_values:
                        relationship_values[value] = target_seq
                    elif previous != target_seq:
                        relationship_values[value] = None
    except (zipfile.BadZipFile, OSError, EOFError) as error:
        if "crc" not in str(error).casefold():
            raise
        result.integrity = "partial-crc-error"

    diameter_schema = schemas.get("diameter")
    diameter_relationship_proven = False
    if diameter_schema is not None:
        diameter_relationship_proven = any(
            column.casefold() == "seqno" for column in diameter_schema.columns
        )
        for parent_table, parent_column in diameter_schema.foreign_keys.values():
            parent_schema = schemas.get(parent_table)
            if parent_schema is not None and any(
                column.casefold() == parent_column for column in parent_schema.columns
            ):
                diameter_relationship_proven = True
                break
    result.diameter_complete = result.integrity == "ok" and diameter_relationship_proven
    if output_dir is not None:
        _write_sql_jsonl(Path(output_dir), result)
    return result


def filter_database_zip(
    database_zip: os.PathLike[str] | str,
    output_dir: os.PathLike[str] | str,
    target_seq_nos: Sequence[int] = TARGET_SEQ_NOS,
) -> SqlDumpResult:
    """Open the dump through the Task 1 stable ZIP boundary and filter it."""
    database = _resolve_input(database_zip, "database ZIP")
    with _stable_archive_inputs((database,)) as working:
        snapshot = working[database]
        structure = _inspect_zip_structure(snapshot)
        with zipfile.ZipFile(snapshot) as archive:
            infos = archive.infolist()
            if len(infos) != structure["records"]:
                raise zipfile.BadZipFile(
                    "ZIP central directory record count changed during parsing"
                )
            total_declared = 0
            for info in infos:
                if info.file_size > MAX_ZIP_MEMBER_BYTES:
                    raise InventoryLimitError(
                        f"ZIP member bytes {info.file_size} exceeds "
                        f"MAX_ZIP_MEMBER_BYTES={MAX_ZIP_MEMBER_BYTES}: {info.filename}"
                    )
                total_declared += info.file_size
                if total_declared > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES:
                    raise InventoryLimitError(
                        f"ZIP total uncompressed bytes {total_declared} exceeds "
                        "MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES="
                        f"{MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES}"
                    )
                ratio = (
                    info.file_size / info.compress_size
                    if info.compress_size
                    else (float("inf") if info.file_size else 0)
                )
                if ratio > MAX_ZIP_COMPRESSION_RATIO:
                    raise InventoryLimitError(
                        f"ZIP compression ratio {ratio:.2f} exceeds "
                        f"MAX_ZIP_COMPRESSION_RATIO={MAX_ZIP_COMPRESSION_RATIO}: "
                        f"{info.filename}"
                    )
                if info.is_dir():
                    continue
                member = normalize_member(info.filename)
                if member is None:
                    raise ValueError(f"unsafe ZIP member path: {info.filename!r}")
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise ValueError(f"ZIP link member is not allowed: {member}")
            candidates = [
                info
                for info in infos
                if not info.is_dir()
                and normalize_member(info.filename) is not None
                and info.filename.casefold().endswith(".sql")
            ]
            preferred = [
                info
                for info in candidates
                if PurePosixPath(info.filename).name.casefold() == "database.sql"
            ]
            selected = preferred or candidates
            if len(selected) != 1:
                raise ValueError(
                    "database ZIP must contain exactly one unambiguous SQL dump"
                )
            info = selected[0]
            if info.file_size > MAX_ZIP_MEMBER_BYTES:
                raise InventoryLimitError(
                    f"SQL member bytes exceed MAX_ZIP_MEMBER_BYTES={MAX_ZIP_MEMBER_BYTES}"
                )
            with archive.open(info, "r") as source:
                return filter_sql_dump(source, target_seq_nos, output_dir=output_dir)


def _safe_windows_component(value: str) -> bool:
    if not value or value in (".", ".."):
        return False
    if any(ord(character) < 32 for character in value):
        return False
    if any(character in '<>:"/\\|?*' for character in value):
        return False
    if value.endswith((".", " ")):
        return False
    stem = value.split(".", 1)[0].upper()
    return stem not in _WINDOWS_RESERVED_NAMES


def normalize_member(value: str) -> str | None:
    """Return a safe canonical archive member, or None for unsafe syntax."""
    if not isinstance(value, str) or not value or "\x00" in value:
        return None
    if value.startswith(("/", "\\")) or PureWindowsPath(value).drive:
        return None
    canonical = value.replace("\\", "/")
    path = PurePosixPath(canonical)
    components = canonical.split("/")
    if path.is_absolute() or any(
        not _safe_windows_component(component) for component in components
    ):
        return None
    return path.as_posix()


def _image_metadata(member: str) -> dict[str, object] | None:
    normalized = normalize_member(member)
    if normalized is None:
        return None
    match = _IMAGE_MEMBER.fullmatch(normalized)
    if match is None:
        return None
    seq_no = int(match.group("seq"))
    if not wanted_seq_no(seq_no):
        return None
    return {
        "cameraNumber": int(match.group("camera")),
        "seqNo": seq_no,
        "kind": match.group("kind").upper(),
        "extension": match.group("extension").lower(),
    }


def wanted_image_member(value: str) -> bool:
    return _image_metadata(value) is not None


def _sha256_file(
    path: Path,
    *,
    max_bytes: int | None = None,
    deadline: float | None = None,
) -> str:
    if max_bytes is None:
        max_bytes = MAX_INPUT_ARCHIVE_BYTES
    if deadline is None:
        deadline = time.monotonic() + INPUT_SNAPSHOT_TIMEOUT_SECONDS
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            if time.monotonic() > deadline:
                raise TimeoutError(
                    "input archive hash deadline exceeded "
                    f"({INPUT_SNAPSHOT_TIMEOUT_SECONDS} seconds)"
                )
            total += len(chunk)
            if total > max_bytes:
                raise InventoryLimitError(
                    f"hash input archive bytes {total} exceed limit {max_bytes}: {path}"
                )
            digest.update(chunk)
    return digest.hexdigest()


def _file_snapshot(path: Path) -> FileSnapshot:
    details = path.stat()
    return FileSnapshot(
        device=details.st_dev,
        inode=details.st_ino,
        size=details.st_size,
        mtime_ns=details.st_mtime_ns,
    )


def _assert_snapshot(path: Path, expected: FileSnapshot) -> None:
    if _file_snapshot(path) != expected:
        raise RuntimeError(f"input archive changed during inventory: {path}")


def _open_windows_locked_file(path: Path) -> int:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
    ]
    create_file.restype = ctypes.c_void_p
    handle = create_file(
        str(path),
        0x80000000,  # GENERIC_READ
        0x00000001,  # FILE_SHARE_READ; deny concurrent write/delete
        None,
        3,  # OPEN_EXISTING
        0x08000080,  # FILE_FLAG_SEQUENTIAL_SCAN | FILE_ATTRIBUTE_NORMAL
        None,
    )
    if handle == ctypes.c_void_p(-1).value:
        error = ctypes.get_last_error()
        raise OSError(error, f"cannot lock input archive for stable read: {path}")
    return handle


def _windows_locked_file_size(handle: int) -> int:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    get_size = kernel32.GetFileSizeEx
    get_size.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_longlong)]
    get_size.restype = ctypes.c_int
    size = ctypes.c_longlong()
    if not get_size(handle, ctypes.byref(size)):
        error = ctypes.get_last_error()
        raise OSError(error, "cannot fstat locked input archive")
    return size.value


def _close_windows_handle(handle: int) -> None:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [ctypes.c_void_p]
    close_handle.restype = ctypes.c_int
    close_handle(handle)


def _copy_snapshot_bounded(
    source: Path,
    destination: Path,
    *,
    deadline: float,
    cumulative_bytes: int,
) -> int:
    member_bytes = 0
    with source.open("rb") as input_file, destination.open("xb") as output_file:
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError(
                    "controlled snapshot deadline exceeded "
                    f"({INPUT_SNAPSHOT_TIMEOUT_SECONDS} seconds)"
                )
            chunk = input_file.read(_IO_CHUNK_BYTES)
            if not chunk:
                break
            member_bytes += len(chunk)
            cumulative_bytes += len(chunk)
            if member_bytes > MAX_INPUT_ARCHIVE_BYTES:
                raise InventoryLimitError(
                    f"snapshot input archive bytes {member_bytes} exceed "
                    f"MAX_INPUT_ARCHIVE_BYTES={MAX_INPUT_ARCHIVE_BYTES}: {source}"
                )
            if cumulative_bytes > MAX_INPUT_ARCHIVE_TOTAL_BYTES:
                raise InventoryLimitError(
                    f"snapshot input archive bytes total {cumulative_bytes} exceed "
                    "MAX_INPUT_ARCHIVE_TOTAL_BYTES="
                    f"{MAX_INPUT_ARCHIVE_TOTAL_BYTES}"
                )
            output_file.write(chunk)
    return cumulative_bytes


def _is_windows() -> bool:
    return os.name == "nt"


@contextlib.contextmanager
def _stable_archive_inputs(
    paths: Sequence[Path],
) -> Iterable[dict[Path, Path]]:
    """Hold Windows read locks, or use verified controlled snapshots elsewhere."""
    if _is_windows():
        handles: list[int] = []
        try:
            for path in paths:
                handles.append(_open_windows_locked_file(path))
            sizes = [_windows_locked_file_size(handle) for handle in handles]
            for path, size in zip(paths, sizes, strict=True):
                if size > MAX_INPUT_ARCHIVE_BYTES:
                    raise InventoryLimitError(
                        f"locked input archive bytes {size} exceed "
                        f"MAX_INPUT_ARCHIVE_BYTES={MAX_INPUT_ARCHIVE_BYTES}: {path}"
                    )
            total_size = sum(sizes)
            if total_size > MAX_INPUT_ARCHIVE_TOTAL_BYTES:
                raise InventoryLimitError(
                    f"locked input archive bytes total {total_size} exceed "
                    "MAX_INPUT_ARCHIVE_TOTAL_BYTES="
                    f"{MAX_INPUT_ARCHIVE_TOTAL_BYTES}"
                )
            yield {path: path for path in paths}
        finally:
            for handle in reversed(handles):
                _close_windows_handle(handle)
        return

    temp_parent = Path(tempfile.gettempdir())
    required_free = MAX_INPUT_ARCHIVE_TOTAL_BYTES + 256 * 1024 * 1024
    if shutil.disk_usage(temp_parent).free < required_free:
        raise InventoryLimitError(
            f"controlled snapshot requires {required_free} free bytes under {temp_parent}"
        )
    with tempfile.TemporaryDirectory(
        prefix="bkv-inventory-snapshot-", dir=temp_parent
    ) as root:
        snapshot_root = Path(root)
        mapping: dict[Path, Path] = {}
        deadline = time.monotonic() + INPUT_SNAPSHOT_TIMEOUT_SECONDS
        cumulative_bytes = 0
        for index, path in enumerate(paths):
            before = _file_snapshot(path)
            before_hash = _sha256_file(path, deadline=deadline)
            destination = snapshot_root / f"{index}-{path.name}"
            cumulative_bytes = _copy_snapshot_bounded(
                path,
                destination,
                deadline=deadline,
                cumulative_bytes=cumulative_bytes,
            )
            destination_hash = _sha256_file(destination, deadline=deadline)
            after_hash = _sha256_file(path, deadline=deadline)
            _assert_snapshot(path, before)
            if before_hash != after_hash or before_hash != destination_hash:
                raise RuntimeError(
                    f"input archive changed while creating snapshot: {path}"
                )
            mapping[path] = destination
        snapshot_sizes = [path.stat().st_size for path in mapping.values()]
        if any(size > MAX_INPUT_ARCHIVE_BYTES for size in snapshot_sizes):
            raise InventoryLimitError(
                "controlled snapshot file exceeds per-archive limit"
            )
        if sum(snapshot_sizes) != cumulative_bytes:
            raise RuntimeError("controlled snapshot byte count changed after copy")
        if cumulative_bytes > MAX_INPUT_ARCHIVE_TOTAL_BYTES:
            raise InventoryLimitError("controlled snapshot total exceeds archive limit")
        yield mapping


def is_reparse_point(path: Path) -> bool:
    """Detect links and Windows reparse points without following them."""
    try:
        details = path.lstat()
    except FileNotFoundError:
        return False
    attributes = getattr(details, "st_file_attributes", 0)
    reparse_attribute = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return path.is_symlink() or bool(attributes & reparse_attribute)


def _existing_chain(path: Path) -> Iterable[Path]:
    current = path
    while True:
        if current.exists() or is_reparse_point(current):
            yield current
        if current == current.parent:
            return
        current = current.parent


def _validate_output_path(
    output_root: Path, batch_id: str, inputs: Sequence[Path]
) -> Path:
    if not _BATCH_ID.fullmatch(batch_id) or not _safe_windows_component(batch_id):
        raise ValueError("batch-id must be a safe single path component")

    raw_output_root = output_root.expanduser()
    if ".." in raw_output_root.parts:
        raise ValueError("output-root must not contain parent traversal")
    if not raw_output_root.is_absolute():
        raw_output_root = Path.cwd() / raw_output_root
    raw_batch_root = raw_output_root / batch_id
    for candidate in _existing_chain(raw_batch_root):
        if is_reparse_point(candidate):
            raise ValueError(f"output path contains a reparse point: {candidate}")

    output_root = raw_output_root.resolve(strict=False)
    batch_root = (output_root / batch_id).resolve(strict=False)
    if batch_root.parent != output_root:
        raise ValueError("batch output escapes output-root")

    for input_path in inputs:
        if output_root == input_path or output_root.is_relative_to(input_path):
            raise ValueError(f"output-root overlaps input archive: {input_path}")
        if input_path.is_relative_to(output_root):
            raise ValueError(f"input archive overlaps output-root: {input_path}")

    for candidate in _existing_chain(batch_root):
        if is_reparse_point(candidate):
            raise ValueError(f"output path contains a reparse point: {candidate}")
    return batch_root


def _resolve_input(path: os.PathLike[str] | str, label: str) -> Path:
    resolved = Path(path).resolve(strict=True)
    if not resolved.is_file():
        raise ValueError(f"{label} must be a file: {resolved}")
    return resolved


def _trusted_unrar_candidate(candidate: Path, source: str) -> Path:
    candidate = candidate.expanduser()
    if not candidate.is_absolute():
        raise ValueError(f"{source} must be an absolute path to UnRAR.exe")
    if is_reparse_point(candidate):
        raise ValueError(f"{source} must not be a reparse point: {candidate}")
    try:
        details = candidate.lstat()
    except FileNotFoundError as error:
        raise FileNotFoundError(f"{source} does not exist: {candidate}") from error
    if not stat.S_ISREG(details.st_mode):
        raise ValueError(f"{source} must be a regular file: {candidate}")
    resolved = candidate.resolve(strict=True)
    if resolved.name.casefold() != "unrar.exe":
        raise ValueError(f"{source} must name UnRAR.exe: {resolved}")
    return resolved


def locate_unrar(explicit: os.PathLike[str] | str | None = None) -> Path:
    if explicit is not None:
        return _trusted_unrar_candidate(Path(explicit), "--unrar")

    configured = os.environ.get("UNRAR_EXE")
    if configured:
        return _trusted_unrar_candidate(Path(configured), "UNRAR_EXE")

    candidates: list[Path] = []
    for variable in ("ProgramFiles", "ProgramFiles(x86)"):
        root = os.environ.get(variable)
        if root and Path(root).is_absolute():
            candidates.append(Path(root) / "WinRAR" / "UnRAR.exe")
    for candidate in candidates:
        try:
            return _trusted_unrar_candidate(
                candidate, f"fixed {candidate.parent} candidate"
            )
        except (FileNotFoundError, ValueError):
            continue
    raise FileNotFoundError(
        "UnRAR.exe was not found in fixed Program Files locations; pass an absolute "
        "--unrar or set UNRAR_EXE to an absolute path"
    )


def _base_entry(
    *,
    archive_part: str,
    member: str,
    size: int,
    sha256: str | None,
    integrity_status: str,
    integrity_evidence: str | None,
) -> dict[str, object]:
    return {
        "sha256": sha256,
        "size": size,
        "archivePart": archive_part,
        "memberPath": member,
        "cameraNumber": None,
        "seqNo": None,
        "kind": "database" if archive_part == "database-zip" else None,
        "extension": PurePosixPath(member).suffix.lower(),
        "integrityStatus": integrity_status,
        "integrityEvidence": integrity_evidence,
    }


def _check_zip_deadline(deadline: float) -> None:
    if time.monotonic() > deadline:
        raise TimeoutError(
            f"ZIP inventory deadline exceeded ({ZIP_INVENTORY_TIMEOUT_SECONDS} seconds)"
        )


def _inspect_zip_structure(path: Path, deadline: float | None = None) -> dict[str, int]:
    if deadline is None:
        deadline = time.monotonic() + ZIP_INVENTORY_TIMEOUT_SECONDS
    _check_zip_deadline(deadline)
    file_size = path.stat().st_size
    tail_size = min(file_size, _ZIP_EOCD_SEARCH_BYTES)
    with path.open("rb") as source:
        source.seek(file_size - tail_size)
        tail = source.read(tail_size)
        _check_zip_deadline(deadline)
        marker = tail.rfind(b"PK\x05\x06")
        if marker < 0 or len(tail) - marker < 22:
            raise zipfile.BadZipFile("ZIP EOCD record is missing or truncated")
        eocd = struct.unpack("<4s4H2LH", tail[marker : marker + 22])
        (
            _,
            disk_number,
            central_disk,
            disk_records,
            total_records,
            central_size,
            central_offset,
            comment_size,
        ) = eocd
        eocd_offset = file_size - tail_size + marker
        if eocd_offset + 22 + comment_size != file_size:
            raise zipfile.BadZipFile(
                "ZIP EOCD comment length or trailing data is invalid"
            )
        if disk_number != 0 or central_disk != 0 or disk_records != total_records:
            raise zipfile.BadZipFile("multi-disk ZIP archives are not supported")

        sentinel = (
            total_records == 0xFFFF
            or central_size == 0xFFFFFFFF
            or central_offset == 0xFFFFFFFF
        )
        central_boundary = eocd_offset
        if sentinel:
            locator_offset = eocd_offset - 20
            if locator_offset < 0:
                raise zipfile.BadZipFile("ZIP64 locator is missing")
            source.seek(locator_offset)
            locator = source.read(20)
            if len(locator) != 20 or locator[:4] != b"PK\x06\x07":
                raise zipfile.BadZipFile("ZIP64 locator is missing or malformed")
            _, zip64_disk, zip64_offset, total_disks = struct.unpack("<4sLQL", locator)
            if zip64_disk != 0 or total_disks != 1:
                raise zipfile.BadZipFile("multi-disk ZIP64 archives are not supported")
            if zip64_offset >= locator_offset:
                raise zipfile.BadZipFile("ZIP64 EOCD offset is invalid")
            source.seek(zip64_offset)
            fixed = source.read(56)
            if len(fixed) != 56 or fixed[:4] != b"PK\x06\x06":
                raise zipfile.BadZipFile("ZIP64 EOCD is missing or malformed")
            values = struct.unpack("<4sQ2H2L4Q", fixed)
            record_bytes = values[1] + 12
            if record_bytes > MAX_ZIP64_EOCD_BYTES:
                raise InventoryLimitError(
                    f"ZIP64 EOCD bytes {record_bytes} exceed "
                    f"MAX_ZIP64_EOCD_BYTES={MAX_ZIP64_EOCD_BYTES}"
                )
            if record_bytes != 56 or zip64_offset + record_bytes != locator_offset:
                raise zipfile.BadZipFile(
                    "ZIP64 standard fixed layout is required; gaps and dual records "
                    "are not supported"
                )
            source.seek(locator_offset - 56)
            adjacent = source.read(56)
            if adjacent != fixed:
                raise zipfile.BadZipFile(
                    "ZIP64 locator and adjacent record describe different objects"
                )
            (
                _,
                _,
                _,
                _,
                zip64_disk_number,
                zip64_central_disk,
                zip64_disk_records,
                total_records,
                central_size,
                central_offset,
            ) = values
            if (
                zip64_disk_number != 0
                or zip64_central_disk != 0
                or zip64_disk_records != total_records
            ):
                raise zipfile.BadZipFile("multi-disk ZIP64 archives are not supported")
            if zip64_offset + record_bytes > locator_offset:
                raise zipfile.BadZipFile("ZIP64 EOCD overlaps its locator")
            central_boundary = zip64_offset

        if total_records > MAX_ZIP_MEMBERS:
            raise InventoryLimitError(
                f"ZIP member count {total_records} exceeds "
                f"MAX_ZIP_MEMBERS={MAX_ZIP_MEMBERS}"
            )
        if total_records > MAX_ZIP_CENTRAL_DIRECTORY_RECORDS:
            raise InventoryLimitError(
                f"ZIP central directory record count {total_records} exceeds "
                f"MAX_ZIP_CENTRAL_DIRECTORY_RECORDS={MAX_ZIP_CENTRAL_DIRECTORY_RECORDS}"
            )
        if central_size > MAX_ZIP_CENTRAL_DIRECTORY_BYTES:
            raise InventoryLimitError(
                f"ZIP central directory bytes {central_size} exceeds "
                f"MAX_ZIP_CENTRAL_DIRECTORY_BYTES={MAX_ZIP_CENTRAL_DIRECTORY_BYTES}"
            )
        if central_offset + central_size > central_boundary:
            raise zipfile.BadZipFile("ZIP central directory range is invalid")
        if total_records:
            source.seek(central_offset)
            if source.read(4) != b"PK\x01\x02":
                raise zipfile.BadZipFile("ZIP central directory signature is invalid")
    _check_zip_deadline(deadline)
    return {
        "records": int(total_records),
        "centralDirectoryBytes": int(central_size),
    }


def _inventory_zip(
    path: Path,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    deadline = time.monotonic() + ZIP_INVENTORY_TIMEOUT_SECONDS
    structure = _inspect_zip_structure(path, deadline)
    _check_zip_deadline(deadline)
    entries: list[dict[str, object]] = []
    with zipfile.ZipFile(path) as archive:
        infos = archive.infolist()
        _check_zip_deadline(deadline)
        if len(infos) != structure["records"]:
            raise zipfile.BadZipFile(
                "ZIP central directory record count changed during parsing"
            )
        if len(infos) > MAX_ZIP_MEMBERS:
            raise InventoryLimitError(
                f"ZIP member count {len(infos)} exceeds MAX_ZIP_MEMBERS={MAX_ZIP_MEMBERS}"
            )
        total_declared = 0
        for info in infos:
            _check_zip_deadline(deadline)
            if info.file_size > MAX_ZIP_MEMBER_BYTES:
                raise InventoryLimitError(
                    f"ZIP member bytes {info.file_size} exceeds "
                    f"MAX_ZIP_MEMBER_BYTES={MAX_ZIP_MEMBER_BYTES}: {info.filename}"
                )
            total_declared += info.file_size
            if total_declared > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES:
                raise InventoryLimitError(
                    f"ZIP total uncompressed bytes {total_declared} exceeds "
                    "MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES="
                    f"{MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES}"
                )
            ratio = (
                info.file_size / info.compress_size
                if info.compress_size
                else (float("inf") if info.file_size else 0)
            )
            if ratio > MAX_ZIP_COMPRESSION_RATIO:
                raise InventoryLimitError(
                    f"ZIP compression ratio {ratio:.2f} exceeds "
                    f"MAX_ZIP_COMPRESSION_RATIO={MAX_ZIP_COMPRESSION_RATIO}: "
                    f"{info.filename}"
                )

        actual_total = 0
        for info in sorted(infos, key=lambda item: item.filename):
            _check_zip_deadline(deadline)
            if info.is_dir():
                continue
            member = normalize_member(info.filename)
            if member is None:
                raise ValueError(f"unsafe ZIP member path: {info.filename!r}")
            unix_mode = info.external_attr >> 16
            if stat.S_ISLNK(unix_mode):
                raise ValueError(f"ZIP link member is not allowed: {member}")
            digest = hashlib.sha256()
            status = "ok"
            evidence = None
            try:
                with archive.open(info, "r") as source:
                    actual_member = 0
                    for chunk in iter(lambda: source.read(_IO_CHUNK_BYTES), b""):
                        _check_zip_deadline(deadline)
                        actual_member += len(chunk)
                        actual_total += len(chunk)
                        if actual_member > MAX_ZIP_MEMBER_BYTES:
                            raise InventoryLimitError(
                                f"ZIP member bytes exceed MAX_ZIP_MEMBER_BYTES="
                                f"{MAX_ZIP_MEMBER_BYTES}: {member}"
                            )
                        if actual_total > MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES:
                            raise InventoryLimitError(
                                "ZIP total uncompressed bytes exceed "
                                "MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES="
                                f"{MAX_ZIP_TOTAL_UNCOMPRESSED_BYTES}"
                            )
                        digest.update(chunk)
                member_sha256: str | None = digest.hexdigest()
            except InventoryLimitError:
                raise
            except TimeoutError:
                raise
            except (zipfile.BadZipFile, RuntimeError, OSError) as error:
                member_sha256 = None
                status = "crc-failed" if "CRC" in str(error).upper() else "read-failed"
                evidence = str(error)
            entries.append(
                _base_entry(
                    archive_part="database-zip",
                    member=member,
                    size=info.file_size,
                    sha256=member_sha256,
                    integrity_status=status,
                    integrity_evidence=evidence,
                )
            )
    _check_zip_deadline(deadline)
    statistics = {
        "recordsSeen": len([info for info in infos if not info.is_dir()]),
        "accepted": len(entries),
        "rejected": 0,
    }
    return entries, statistics


def _decode_console(data: bytes) -> str:
    encodings = [locale.getpreferredencoding(False), "utf-8", "gb18030"]
    for encoding in dict.fromkeys(encodings):
        try:
            return data.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return data.decode("utf-8", errors="replace")


def _run_process_bounded(command: Sequence[str]) -> subprocess.CompletedProcess[str]:
    process = subprocess.Popen(
        list(command),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=(
            getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        ),
    )
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    lock = threading.Lock()
    exceeded = threading.Event()

    def drain(name: str, stream: object) -> None:
        try:
            while True:
                chunk = stream.read(_IO_CHUNK_BYTES)  # type: ignore[attr-defined]
                if not chunk:
                    return
                with lock:
                    captured = len(buffers["stdout"]) + len(buffers["stderr"])
                    remaining = MAX_UNRAR_OUTPUT_BYTES - captured
                    if len(chunk) > remaining:
                        if remaining > 0:
                            buffers[name].extend(chunk[:remaining])
                        exceeded.set()
                    else:
                        buffers[name].extend(chunk)
                if exceeded.is_set():
                    try:
                        process.kill()
                    except OSError:
                        pass
                    return
        finally:
            stream.close()  # type: ignore[attr-defined]

    threads = [
        threading.Thread(target=drain, args=("stdout", process.stdout), daemon=True),
        threading.Thread(target=drain, args=("stderr", process.stderr), daemon=True),
    ]
    for thread in threads:
        thread.start()
    try:
        return_code = process.wait(timeout=UNRAR_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as error:
        process.kill()
        process.wait()
        for thread in threads:
            thread.join(timeout=5)
        raise RuntimeError(
            f"UnRAR timed out after {UNRAR_TIMEOUT_SECONDS} seconds"
        ) from error
    for thread in threads:
        thread.join(timeout=5)
    if any(thread.is_alive() for thread in threads):
        process.kill()
        raise RuntimeError("UnRAR output readers did not terminate")
    if exceeded.is_set():
        raise InventoryLimitError(
            "UnRAR output bytes exceed "
            f"MAX_UNRAR_OUTPUT_BYTES={MAX_UNRAR_OUTPUT_BYTES}"
        )
    return subprocess.CompletedProcess(
        list(command),
        return_code,
        _decode_console(bytes(buffers["stdout"])),
        _decode_console(bytes(buffers["stderr"])),
    )


def _run_unrar_listing(
    unrar: Path,
    path: Path,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
) -> str:
    command = [str(unrar), "lt", "-cfg-", "-c-", "-p-", str(path)]
    if runner is None:
        result = _run_process_bounded(command)
    else:
        try:
            result = runner(
                command,
                timeout=UNRAR_TIMEOUT_SECONDS,
                max_output_bytes=MAX_UNRAR_OUTPUT_BYTES,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(
                f"UnRAR timed out after {UNRAR_TIMEOUT_SECONDS} seconds"
            ) from error
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        output_bytes = len(stdout.encode("utf-8")) + len(stderr.encode("utf-8"))
        if output_bytes > MAX_UNRAR_OUTPUT_BYTES:
            raise InventoryLimitError(
                f"UnRAR output bytes {output_bytes} exceed "
                f"MAX_UNRAR_OUTPUT_BYTES={MAX_UNRAR_OUTPUT_BYTES}"
            )
    if result.returncode != 0:
        raise RuntimeError(
            f"UnRAR listing failed for {path} with exit {result.returncode}: "
            f"{(result.stderr or '').strip()}"
        )
    output = result.stdout or ""
    if output.strip() and not _parse_unrar_listing(output):
        raise RuntimeError("UnRAR produced output but no structured technical records")
    return output


def _parse_unrar_listing(output: str) -> list[dict[str, str]]:
    records: list[dict[str, str]] = []
    current: dict[str, str] = {}

    def finish_record() -> None:
        nonlocal current
        if not current:
            return
        records.append(current)
        if len(records) > MAX_RAR_LISTING_RECORDS:
            raise InventoryLimitError(
                "UnRAR listing record count exceeds "
                f"MAX_RAR_LISTING_RECORDS={MAX_RAR_LISTING_RECORDS}"
            )
        current = {}

    for line in io.StringIO(output):
        stripped = line.strip()
        if not stripped:
            finish_record()
            continue
        key, separator, value = stripped.partition(":")
        if not separator:
            key, separator, value = stripped.partition("：")
        if separator:
            canonical_key = _UNRAR_KEY_ALIASES.get(key.strip().lower())
            if canonical_key:
                current[canonical_key] = value.strip()
    finish_record()
    return records


def _records_to_rar_entries(
    records: Sequence[dict[str, str]],
    archive_part: str,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    entries: list[dict[str, object]] = []
    statistics = {"recordsSeen": len(records), "accepted": 0, "rejected": 0}
    seen_candidates: dict[str, str] = {}
    for record in records:
        if "name" not in record:
            statistics["rejected"] += 1
            continue
        raw_member = record["name"]
        member = normalize_member(raw_member)
        if member is None:
            raise ValueError(f"unsafe RAR member path: {raw_member!r}")
        metadata = _image_metadata(member)
        if metadata is None:
            statistics["rejected"] += 1
            continue
        member_type = record.get("type", "File").lower()
        if "link" in member_type or "target" in record or "redirection" in record:
            raise ValueError(f"RAR link member is not allowed: {member}")
        if member_type not in ("file", "文件"):
            statistics["rejected"] += 1
            continue
        try:
            size = int(record["size"])
        except (KeyError, ValueError) as error:
            raise ValueError(f"RAR member lacks a valid size: {member}") from error
        if size < 0:
            raise ValueError(f"RAR member has a negative size: {member}")
        collision_key = unicodedata.normalize("NFC", member).casefold()
        previous = seen_candidates.get(collision_key)
        if previous is not None:
            raise ValueError(
                f"Windows case-insensitive collision: {previous!r} and {member!r}"
            )
        seen_candidates[collision_key] = member
        entry = _base_entry(
            archive_part=archive_part,
            member=member,
            size=size,
            sha256=None,
            integrity_status="listed-unverified",
            integrity_evidence=(
                f"UnRAR CRC32={record['crc32']}" if record.get("crc32") else None
            ),
        )
        entry.update(metadata)
        entry["archiveParts"] = [archive_part]
        entry["archiveMetadata"] = {
            "type": "file",
            "size": size,
            "crc32": record.get("crc32", "").upper() or None,
            "attributes": record.get("attributes"),
            "modified": record.get("modified"),
            "hostOS": record.get("hostOS"),
            "compression": record.get("compression"),
        }
        entry["volumeMetadata"] = {
            archive_part: {
                "packedSize": record.get("packedSize"),
                "ratio": record.get("ratio"),
                "packCrc32": record.get("packCrc32"),
            }
        }
        entries.append(entry)
        statistics["accepted"] += 1
    return entries, statistics


def _inventory_rar(
    path: Path,
    archive_part: str,
    unrar: Path,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None,
) -> tuple[list[dict[str, object]], dict[str, int]]:
    output = _run_unrar_listing(unrar, path, runner)
    records = _parse_unrar_listing(output)
    if output.strip() and not any(
        "name" in record and "type" in record for record in records
    ):
        raise RuntimeError("UnRAR output contained no structured member records")
    return _records_to_rar_entries(records, archive_part)


def _merge_rar_entries(
    first: Sequence[dict[str, object]],
    second: Sequence[dict[str, object]],
) -> list[dict[str, object]]:
    merged: dict[str, dict[str, object]] = {}
    for entry in [*first, *second]:
        member = str(entry["memberPath"])
        previous = merged.get(member)
        if previous is None:
            merged[member] = entry
            continue
        previous_metadata = previous.get("archiveMetadata")
        current_metadata = entry.get("archiveMetadata")
        assert isinstance(previous_metadata, dict) and isinstance(
            current_metadata, dict
        )
        for key in previous_metadata.keys() | current_metadata.keys():
            previous_value = previous_metadata.get(key)
            current_value = current_metadata.get(key)
            if (
                previous_value is not None
                and current_value is not None
                and previous_value != current_value
            ):
                raise ValueError(
                    f"conflicting duplicate RAR member metadata for {member}: "
                    f"{key}={previous_value!r} != {current_value!r}"
                )
            if previous_value is None and current_value is not None:
                previous_metadata[key] = current_value
        if previous_metadata.get("crc32"):
            previous["integrityEvidence"] = f"UnRAR CRC32={previous_metadata['crc32']}"
        previous_volume_metadata = previous.get("volumeMetadata")
        current_volume_metadata = entry.get("volumeMetadata")
        assert isinstance(previous_volume_metadata, dict)
        assert isinstance(current_volume_metadata, dict)
        previous_volume_metadata.update(current_volume_metadata)
        previous_parts = previous["archiveParts"]
        current_parts = entry["archiveParts"]
        assert isinstance(previous_parts, list) and isinstance(current_parts, list)
        for archive_part in current_parts:
            if archive_part not in previous_parts:
                previous_parts.append(archive_part)
    return list(merged.values())


def _archive_evidence(
    inventory_path: Path,
    snapshot: FileSnapshot,
    source_path: Path,
) -> dict[str, object]:
    digest = _sha256_file(inventory_path)
    _assert_snapshot(inventory_path, snapshot)
    return {
        "path": str(source_path),
        "size": snapshot.size,
        "sha256": digest,
        "fileIdentity": f"{snapshot.device}:{snapshot.inode}",
        "mtimeNs": snapshot.mtime_ns,
    }


def _assert_casefold_unique(entries: Sequence[dict[str, object]]) -> None:
    candidates: dict[str, str] = {}
    for entry in entries:
        member = str(entry["memberPath"])
        key = unicodedata.normalize("NFC", member).casefold()
        previous = candidates.get(key)
        if previous is not None:
            raise ValueError(
                f"Windows case-insensitive collision: {previous!r} and {member!r}"
            )
        candidates[key] = member


def _assert_publish_path(destination: Path) -> None:
    for candidate in _existing_chain(destination):
        if is_reparse_point(candidate):
            raise ValueError(f"manifest output contains a reparse point: {candidate}")


def _write_json_atomic(
    destination: Path,
    document: object,
    pre_publish: Callable[[], None] | None = None,
) -> None:
    _assert_publish_path(destination)
    payload = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    payload_bytes = len(payload.encode("utf-8"))
    if payload_bytes > MAX_MANIFEST_BYTES:
        raise InventoryLimitError(
            f"manifest bytes {payload_bytes} exceed "
            f"MAX_MANIFEST_BYTES={MAX_MANIFEST_BYTES}"
        )
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{destination.name}.",
            suffix=".tmp",
            dir=destination.parent,
            delete=False,
        ) as output:
            temporary = Path(output.name)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        _assert_publish_path(destination)
        if is_reparse_point(temporary):
            raise ValueError(f"temporary manifest became a reparse point: {temporary}")
        if pre_publish is not None:
            pre_publish()
        os.replace(temporary, destination)
        temporary = None
        _assert_publish_path(destination)
        if not destination.is_file():
            raise RuntimeError(
                f"manifest publication did not create a regular file: {destination}"
            )
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def inventory_archives(
    *,
    database_zip: os.PathLike[str] | str,
    image_part1: os.PathLike[str] | str,
    image_part2: os.PathLike[str] | str,
    output_root: os.PathLike[str] | str,
    batch_id: str,
    unrar: os.PathLike[str] | str | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
) -> Path:
    database = _resolve_input(database_zip, "database ZIP")
    part1 = _resolve_input(image_part1, "image part 1")
    part2 = _resolve_input(image_part2, "image part 2")
    inputs = (database, part1, part2)
    if len(set(inputs)) != len(inputs):
        raise ValueError("input archives must be distinct files")
    unrar_path = locate_unrar(unrar)
    batch_root = _validate_output_path(Path(output_root), batch_id, inputs)

    with _stable_archive_inputs(inputs) as working:
        working_database = working[database]
        working_part1 = working[part1]
        working_part2 = working[part2]
        snapshots = {path: _file_snapshot(path) for path in working.values()}
        archives = {
            "database-zip": _archive_evidence(
                working_database, snapshots[working_database], database
            ),
            "image-part1": _archive_evidence(
                working_part1, snapshots[working_part1], part1
            ),
            "image-part2": _archive_evidence(
                working_part2, snapshots[working_part2], part2
            ),
        }
        database_entries, zip_statistics = _inventory_zip(working_database)
        first_entries, first_statistics = _inventory_rar(
            working_part1, "image-part1", unrar_path, runner
        )
        second_entries, second_statistics = _inventory_rar(
            working_part2, "image-part2", unrar_path, runner
        )
        image_entries = _merge_rar_entries(first_entries, second_entries)
        entries = [*database_entries, *image_entries]
        _assert_casefold_unique(entries)
        for path, snapshot in snapshots.items():
            _assert_snapshot(path, snapshot)
        entries.sort(
            key=lambda item: (str(item["archivePart"]), str(item["memberPath"]))
        )
        manifest = {
            "schema": MANIFEST_SCHEMA,
            "batchId": batch_id,
            "archives": archives,
            "statistics": {
                "database-zip": zip_statistics,
                "image-part1": first_statistics,
                "image-part2": second_statistics,
            },
            "entries": entries,
        }

        batch_root.mkdir(parents=True, exist_ok=True)
        for candidate in _existing_chain(batch_root):
            if is_reparse_point(candidate):
                raise ValueError(f"output path contains a reparse point: {candidate}")
        destination = batch_root / MANIFEST_NAME

        def assert_inputs_unchanged() -> None:
            for path, snapshot in snapshots.items():
                _assert_snapshot(path, snapshot)

        _write_json_atomic(destination, manifest, pre_publish=assert_inputs_unchanged)
        return destination


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    inventory = subparsers.add_parser("inventory", help="inventory legacy archives")
    inventory.add_argument("--database-zip", required=True, type=Path)
    inventory.add_argument("--image-part1", required=True, type=Path)
    inventory.add_argument("--image-part2", required=True, type=Path)
    inventory.add_argument("--output-root", required=True, type=Path)
    inventory.add_argument("--batch-id", required=True)
    inventory.add_argument("--unrar", type=Path, help="absolute path to UnRAR.exe")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "inventory":
        destination = inventory_archives(
            database_zip=args.database_zip,
            image_part1=args.image_part1,
            image_part2=args.image_part2,
            output_root=args.output_root,
            batch_id=args.batch_id,
            unrar=args.unrar,
        )
        print(destination)
        return 0
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
