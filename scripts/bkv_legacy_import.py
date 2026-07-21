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
MAX_UNRAR_STDERR_BYTES = 1024 * 1024
MAX_STAGE_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024
MAX_STAGE_TOTAL_BYTES = 16 * 1024 * 1024 * 1024
STAGE_TIMEOUT_SECONDS = 60 * 60
MAX_MANIFEST_BYTES = 128 * 1024 * 1024
MAX_SQL_STATEMENT_BYTES = 64 * 1024 * 1024
MAX_SQL_FIELD_BYTES = 1024 * 1024
MAX_SQL_RESULT_ROWS = 1_000_000
MAX_SQL_RESULT_BYTES = 256 * 1024 * 1024
MAX_SQL_SAMPLE_ROWS = 1_000
MAX_SQL_SAMPLE_BYTES = 4 * 1024 * 1024
MAX_SQL_TABLE_ROWS = 2_000_000
MAX_SQL_NORMALIZED_BYTES = 2 * 1024 * 1024 * 1024
MAX_SQL_RELATIONSHIP_KEYS = 10_000
MAX_SQL_RELATIONSHIP_INDEX_BYTES = 16 * 1024 * 1024
MAX_SQL_PENDING_BYTES = 512 * 1024 * 1024
MAX_SQL_PENDING_REPLAY_PASSES = 32
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


class StageFailedError(RuntimeError):
    """Raised after a failed stage run has been preserved as bounded evidence."""

    def __init__(self, message: str, failed_evidence_path: Path):
        self.failed_evidence_path = failed_evidence_path
        super().__init__(f"{message}; failedEvidencePath={failed_evidence_path}")


class SourceUnavailableError(RuntimeError):
    """Raised when deep import verification cannot reopen original evidence."""


class _QuarantineWriter:
    def __init__(self, path: Path):
        self.path = path
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags, 0o600)
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode) or is_reparse_point(path):
                raise ValueError("quarantine must be a regular non-reparse file")
            self._file = os.fdopen(descriptor, "wb", buffering=0)
        except BaseException:
            os.close(descriptor)
            raise
        self.count = 0

    @property
    def closed(self) -> bool:
        return self._file.closed

    def append(self, document: dict[str, object]) -> None:
        if self.closed:
            raise ValueError("quarantine evidence handle is closed")
        if is_reparse_point(self.path) or not self.path.is_file():
            raise ValueError("quarantine path changed or became a reparse point")
        payload = (
            json.dumps(document, ensure_ascii=False, sort_keys=True) + "\n"
        ).encode("utf-8")
        if len(payload) > 8192:
            raise InventoryLimitError("failed quarantine evidence exceeds 8192 bytes")
        self._file.write(payload)
        self._file.flush()
        os.fsync(self._file.fileno())
        if is_reparse_point(self.path) or not self.path.is_file():
            raise ValueError("quarantine path changed after evidence write")
        self.count += 1

    def sync(self) -> None:
        if not self.closed:
            self._file.flush()
            os.fsync(self._file.fileno())

    def close(self) -> None:
        if not self.closed:
            self.sync()
            self._file.close()


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
    parse_rejected_statements: int = 0


def wanted_seq_no(value: int) -> bool:
    """Return whether value belongs to the exact approved legacy batch."""
    return value in TARGET_SEQ_NOS


_SQL_TABLES = ("allexcel", "checkrecord", "defect", "defectclass", "diameter")
_PHYSICAL_COLUMN_NAMES = {
    "depth",
    "diameter",
    "height",
    "innerdiameter",
    "inner_diameter",
    "length",
    "measurement",
    "nominaldiameter",
    "nominal_diameter",
    "outerdiameter",
    "outer_diameter",
    "platelength",
    "plate_length",
    "platewidth",
    "plate_width",
    "plateheight",
    "plate_height",
    "radius",
    "thickness",
    "wallthickness",
    "wall_thickness",
    "width",
}
_SQL_IDENTIFIER = r"(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_]*)"
_SQL_TABLE_REFERENCE = rf"{_SQL_IDENTIFIER}(?:\s*\.\s*{_SQL_IDENTIFIER})?"


def _identifier_value(value: str) -> str:
    return (
        value[1:-1].replace("``", "`")
        if value.startswith("`") and value.endswith("`")
        else value
    )


def _table_reference_value(value: str) -> str:
    identifiers = re.findall(_SQL_IDENTIFIER, value)
    if not identifiers:
        raise ValueError("invalid SQL table reference")
    return _identifier_value(identifiers[-1])


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


def _quoted_sql_token_end(value: str, opening: int) -> int | None:
    if opening >= len(value) or value[opening] not in ("'", '"'):
        return None
    quote = value[opening]
    index = opening + 1
    while index < len(value):
        character = value[index]
        if character == "\\":
            index += 2
            continue
        if character == quote:
            if index + 1 < len(value) and value[index + 1] == quote:
                index += 2
                continue
            return index + 1
        index += 1
    return None


def _sql_option_value_start(value: str, keyword_end: int) -> int | None:
    position = keyword_end
    while position < len(value) and value[position].isspace():
        position += 1
    if position < len(value) and value[position] == "=":
        position += 1
        while position < len(value) and value[position].isspace():
            position += 1
        return position
    return position if position > keyword_end else None


def _has_valid_fulltext_or_spatial_options(value: str) -> bool:
    position = 0
    seen: set[str] = set()
    while True:
        position_match = re.match(r"\s*", value[position:])
        assert position_match is not None
        position += position_match.end()
        if position == len(value):
            return True

        key_block_match = re.match(r"KEY_BLOCK_SIZE\b", value[position:], re.IGNORECASE)
        if key_block_match is not None:
            if "key_block_size" in seen:
                return False
            value_start = _sql_option_value_start(
                value, position + key_block_match.end()
            )
            if value_start is None:
                return False
            value_match = re.match(r"\d+\b", value[value_start:])
            if value_match is None:
                return False
            seen.add("key_block_size")
            position = value_start + value_match.end()
            continue

        using_match = re.match(
            r"USING\s+(?P<index_type>BTREE|HASH)\b",
            value[position:],
            re.IGNORECASE,
        )
        if using_match is not None:
            if "index_type" in seen:
                return False
            seen.add("index_type")
            position += using_match.end()
            continue

        parser_match = re.match(
            rf"WITH\s+PARSER\s+(?P<parser>{_SQL_IDENTIFIER})(?![A-Za-z0-9_])",
            value[position:],
            re.IGNORECASE,
        )
        if parser_match is not None:
            if "parser" in seen:
                return False
            seen.add("parser")
            position += parser_match.end()
            continue

        comment_match = re.match(r"COMMENT\b\s*", value[position:], re.IGNORECASE)
        if comment_match is not None:
            if "comment" in seen:
                return False
            opening = position + comment_match.end()
            closing = _quoted_sql_token_end(value, opening)
            if closing is None:
                return False
            seen.add("comment")
            position = closing
            continue

        attribute_match = re.match(
            r"(?P<attribute>ENGINE_ATTRIBUTE|SECONDARY_ENGINE_ATTRIBUTE)\b",
            value[position:],
            re.IGNORECASE,
        )
        if attribute_match is not None:
            attribute = attribute_match.group("attribute").casefold()
            if attribute in seen:
                return False
            value_start = _sql_option_value_start(
                value, position + attribute_match.end()
            )
            if value_start is None:
                return False
            closing = _quoted_sql_token_end(value, value_start)
            if closing is None:
                return False
            seen.add(attribute)
            position = closing
            continue

        visibility_match = re.match(
            r"(?P<visibility>VISIBLE|INVISIBLE)\b",
            value[position:],
            re.IGNORECASE,
        )
        if visibility_match is not None:
            if "visibility" in seen:
                return False
            seen.add("visibility")
            position += visibility_match.end()
            continue
        return False


def _classify_fulltext_or_spatial_index(definition: str) -> str:
    prefix = re.match(r"(?:FULLTEXT|SPATIAL)\b", definition, re.IGNORECASE)
    if prefix is None:
        return "column"
    explicit_kind = re.match(
        r"\s+(?:INDEX|KEY)\b", definition[prefix.end() :], re.IGNORECASE
    )
    match = re.match(
        rf"(?:FULLTEXT|SPATIAL)\b(?:\s+(?:INDEX|KEY)\b)?"
        rf"(?:\s+(?P<name>{_SQL_IDENTIFIER}))?\s*(?P<open>\()",
        definition,
        re.IGNORECASE,
    )
    if match is None:
        return "malformed" if explicit_kind is not None else "column"
    extracted = _extract_parenthesized(definition, match.start("open"))
    if extracted is None:
        if explicit_kind is not None or match.group("name") is None:
            return "malformed"
        return "column"
    body, closing = extracted
    key_parts = _split_sql_items(body)
    key_part_pattern = rf"{_SQL_IDENTIFIER}(?:\s*\(\s*\d+\s*\))?(?:\s+(?:ASC|DESC))?"
    valid_key_parts = bool(key_parts) and all(
        re.fullmatch(key_part_pattern, key_part.strip(), re.IGNORECASE) is not None
        for key_part in key_parts
    )
    if not valid_key_parts:
        return "malformed" if explicit_kind is not None else "column"
    if not _has_valid_fulltext_or_spatial_options(definition[closing + 1 :]):
        return "malformed"
    return "index"


def _is_fulltext_or_spatial_index(definition: str) -> bool:
    return _classify_fulltext_or_spatial_index(definition) == "index"


def _is_unquoted_table_constraint(definition: str) -> bool:
    value = definition.lstrip()
    if _is_fulltext_or_spatial_index(value):
        return True
    patterns = (
        r"PRIMARY\s+KEY\b",
        r"FOREIGN\s+KEY\b",
        r"UNIQUE\b(?:\s+(?:KEY|INDEX)\b)?",
        r"KEY\b",
        r"INDEX\b",
        r"CONSTRAINT\b",
        r"CHECK\b",
    )
    return any(
        re.match(pattern, value, re.IGNORECASE) is not None for pattern in patterns
    )


def _parse_create_table(statement: str) -> tuple[str, _SqlTableSchema] | None:
    match = re.search(
        rf"\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<table>{_SQL_TABLE_REFERENCE})\s*(?P<open>\()",
        statement,
        re.IGNORECASE,
    )
    if match is None:
        return None
    extracted = _extract_parenthesized(statement, match.start("open"))
    if extracted is None:
        return None
    body, _closing = extracted
    table = _normalized_identifier(_table_reference_value(match.group("table")))
    columns: list[str] = []
    foreign_keys: dict[str, tuple[str, str]] = {}
    for definition in _split_sql_items(body):
        stripped_definition = definition.lstrip()
        index_classification = _classify_fulltext_or_spatial_index(stripped_definition)
        if index_classification == "malformed":
            return None
        column_match = re.match(
            rf"(?P<column>{_SQL_IDENTIFIER})\s+", stripped_definition
        )
        if column_match is not None and (
            stripped_definition.startswith("`")
            or not _is_unquoted_table_constraint(stripped_definition)
        ):
            candidate = _identifier_value(column_match.group("column"))
            columns.append(candidate)
        foreign_match = re.search(
            rf"\bFOREIGN\s+KEY\s*\(\s*(?P<local>{_SQL_IDENTIFIER})\s*\)\s*"
            rf"REFERENCES\s+(?P<parent>{_SQL_TABLE_REFERENCE})\s*\(\s*(?P<parent_column>{_SQL_IDENTIFIER})\s*\)",
            definition,
            re.IGNORECASE | re.DOTALL,
        )
        if foreign_match is not None:
            local = _identifier_value(foreign_match.group("local"))
            parent_table = _table_reference_value(foreign_match.group("parent"))
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
        rf"\bINSERT\s+INTO\s+(?P<table>{_SQL_TABLE_REFERENCE})",
        statement,
        re.IGNORECASE,
    )
    if match is None:
        return None
    table = _normalized_identifier(_table_reference_value(match.group("table")))
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
) -> tuple[int | None, str]:
    normalized = {_normalized_identifier(key): value for key, value in row.items()}
    proofs: set[int] = set()
    unresolved = False
    if "seqno" in normalized:
        direct = normalized["seqno"]
        if isinstance(direct, int):
            proofs.add(direct)
    for local_column, (parent_table, parent_column) in schema.foreign_keys.items():
        value = normalized.get(local_column)
        if value is None:
            continue
        parent_values = retained_relationships.get((parent_table, parent_column), {})
        try:
            present = value in parent_values
            target_seq = parent_values.get(value)
        except TypeError:
            present = False
            target_seq = None
        if not present:
            unresolved = True
        elif target_seq is None:
            return None, "conflict"
        else:
            proofs.add(target_seq)
    if len(proofs) > 1:
        return None, "conflict"
    if unresolved:
        return None, "pending"
    if len(proofs) == 1:
        proof = next(iter(proofs))
        return (proof, "accepted") if proof in targets else (None, "not_target")
    return None, "unproven"


def _stable_row_hash(table: str, columns: Sequence[str], raw_tuple: str) -> str:
    """Hash the exact captured tuple bytes via UTF-8 surrogateescape round-trip."""
    del table, columns
    return hashlib.sha256(
        raw_tuple.encode("utf-8", errors="surrogateescape")
    ).hexdigest()


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _strict_sql_output_root(
    output_root: os.PathLike[str] | str, *, create: bool
) -> Path:
    raw = Path(output_root).expanduser()
    if not raw.is_absolute():
        raw = Path.cwd() / raw
    for candidate in _existing_chain(raw):
        if is_reparse_point(candidate):
            raise ValueError(f"SQL output root contains a reparse point: {candidate}")
    if create:
        raw.mkdir(parents=True, exist_ok=True)
    if not raw.is_dir():
        raise ValueError(f"SQL output root is not a directory: {raw}")
    for candidate in _existing_chain(raw):
        if is_reparse_point(candidate):
            raise ValueError(f"SQL output root contains a reparse point: {candidate}")
    return raw.resolve(strict=True)


def _strict_sql_generations_root(root: Path, *, create: bool) -> Path:
    candidate = root / "normalized-generations"
    if is_reparse_point(candidate):
        raise ValueError(f"SQL generations root is a reparse point: {candidate}")
    if create:
        candidate.mkdir(exist_ok=True)
    if not candidate.is_dir() or is_reparse_point(candidate):
        raise ValueError(
            f"SQL generations root is missing or a reparse point: {candidate}"
        )
    canonical = candidate.resolve(strict=True)
    if canonical.parent != root or canonical.name != "normalized-generations":
        raise ValueError("SQL generations root escaped the fixed output root")
    return canonical


def _strict_sql_generation(generations_root: Path, candidate: Path) -> Path:
    if candidate.parent != generations_root or is_reparse_point(candidate):
        raise ValueError("SQL generation is a reparse point or escaped its fixed root")
    canonical = candidate.resolve(strict=True)
    try:
        canonical.relative_to(generations_root)
    except ValueError as error:
        raise ValueError("SQL generation escaped its fixed root") from error
    if canonical.parent != generations_root or is_reparse_point(canonical):
        raise ValueError("SQL generation is a reparse point or escaped its fixed root")
    return canonical


def _replace_sql_current_pointer(temporary: Path, current: Path) -> None:
    os.replace(temporary, current)


def _sql_file_evidence(path: Path, count: int) -> dict[str, object]:
    if is_reparse_point(path):
        raise ValueError(f"SQL generation file is a reparse point: {path}")
    digest = hashlib.sha256()
    size = 0
    actual_count = 0
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(_IO_CHUNK_BYTES), b""):
            size += len(chunk)
            if size > MAX_SQL_NORMALIZED_BYTES:
                raise SqlDumpLimitError(
                    "normalized bytes exceed "
                    f"MAX_SQL_NORMALIZED_BYTES={MAX_SQL_NORMALIZED_BYTES}"
                )
            digest.update(chunk)
            actual_count += chunk.count(b"\n")
    if actual_count != count:
        raise ValueError(
            f"SQL generation count mismatch: expected {count}, got {actual_count}: {path}"
        )
    return {"sha256": digest.hexdigest(), "size": size, "count": actual_count}


def _publish_sql_output(
    incoming: Path,
    output_root: Path,
    result: SqlDumpResult,
) -> Path:
    """Publish an immutable generation, then atomically switch its small pointer."""
    output_root = _strict_sql_output_root(output_root, create=False)
    generations_root = _strict_sql_generations_root(output_root, create=False)
    incoming = _strict_sql_generation(generations_root, incoming)
    generation = generations_root / (
        f"generation-{time.time_ns()}-{os.getpid()}-{incoming.name.rsplit('-', 1)[-1]}"
    )
    os.replace(incoming, generation)
    generation = _strict_sql_generation(generations_root, generation)
    _fsync_directory(generations_root)
    files: dict[str, dict[str, object]] = {}
    for table in _SQL_TABLES:
        path = generation / f"{table}.jsonl"
        if not path.is_file() or is_reparse_point(path):
            raise ValueError(f"generation file is missing or unsafe: {path}")
        files[table] = _sql_file_evidence(path, result.counts[table]["accepted"])
    pointer = {
        "schema": "steel.bkv-sql-current.v1",
        "generation": f"normalized-generations/{generation.name}",
        "files": files,
        "resultEvidence": {
            "integrity": result.integrity,
            "diameterComplete": result.diameter_complete,
            "parseRejectedStatements": result.parse_rejected_statements,
            "counts": result.counts,
        },
    }
    payload = (
        json.dumps(pointer, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    temporary_pointer: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=".normalized.current.",
            suffix=".tmp",
            dir=output_root,
            delete=False,
        ) as output:
            temporary_pointer = Path(output.name)
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        _fsync_directory(output_root)
        current = output_root / "normalized.current.json"
        if is_reparse_point(current):
            raise ValueError("SQL current pointer is a reparse point")
        _replace_sql_current_pointer(temporary_pointer, current)
        temporary_pointer = None
        _fsync_directory(output_root)
    finally:
        if temporary_pointer is not None:
            temporary_pointer.unlink(missing_ok=True)
    return generation


def _validate_sql_current_pointer(pointer: object) -> dict[str, object]:
    if not isinstance(pointer, dict):
        raise ValueError("invalid SQL current pointer: top level must be an object")
    if pointer.get("schema") != "steel.bkv-sql-current.v1":
        raise ValueError("invalid SQL current pointer: unsupported schema")
    if not isinstance(pointer.get("generation"), str):
        raise ValueError("invalid SQL current pointer: generation must be a string")
    files = pointer.get("files")
    if not isinstance(files, dict) or set(files) != set(_SQL_TABLES):
        raise ValueError(
            "invalid SQL current pointer: files must name exactly five tables"
        )
    for table in _SQL_TABLES:
        evidence = files[table]
        if not isinstance(evidence, dict):
            raise ValueError(
                f"invalid SQL current pointer: file evidence must be an object: {table}"
            )
        count = evidence.get("count")
        size = evidence.get("size")
        sha256 = evidence.get("sha256")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError(
                f"invalid SQL current pointer: count must be a non-negative integer: {table}"
            )
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise ValueError(
                f"invalid SQL current pointer: size must be a non-negative integer: {table}"
            )
        if not isinstance(sha256, str) or re.fullmatch(r"[0-9a-f]{64}", sha256) is None:
            raise ValueError(
                f"invalid SQL current pointer: sha256 must be lowercase hex: {table}"
            )
    result_evidence = pointer.get("resultEvidence")
    if not isinstance(result_evidence, dict):
        raise ValueError("invalid SQL current pointer: resultEvidence is required")
    if result_evidence.get("integrity") not in (
        "ok", "partial-parse-error", "partial-crc-error"
    ):
        raise ValueError("invalid SQL current pointer: result integrity")
    if not isinstance(result_evidence.get("diameterComplete"), bool):
        raise ValueError("invalid SQL current pointer: diameterComplete")
    parse_rejected = result_evidence.get("parseRejectedStatements")
    if isinstance(parse_rejected, bool) or not isinstance(parse_rejected, int) or parse_rejected < 0:
        raise ValueError("invalid SQL current pointer: parseRejectedStatements")
    result_counts = result_evidence.get("counts")
    if not isinstance(result_counts, dict) or set(result_counts) != set(_SQL_TABLES):
        raise ValueError("invalid SQL current pointer: result counts")
    for table in _SQL_TABLES:
        table_counts = result_counts[table]
        if not isinstance(table_counts, dict):
            raise ValueError(f"invalid SQL current pointer: counts for {table}")
        for key in ("accepted", "rejected", "statementRejectedRowsUnknown"):
            value = table_counts.get(key)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"invalid SQL current pointer: {table} {key}")
        file_evidence = files[table]
        assert isinstance(file_evidence, dict)
        if table_counts["accepted"] != file_evidence["count"]:
            raise ValueError(f"invalid SQL current pointer: accepted count {table}")
    return pointer


def resolve_sql_output(output_root: os.PathLike[str] | str) -> Path:
    """Resolve and verify the immutable generation named by the current pointer."""
    root = _strict_sql_output_root(output_root, create=False)
    generations_root = _strict_sql_generations_root(root, create=False)
    pointer_path = root / "normalized.current.json"
    if is_reparse_point(pointer_path):
        raise ValueError("SQL current pointer may not be a reparse point")
    payload = pointer_path.read_bytes()
    if len(payload) > MAX_MANIFEST_BYTES:
        raise SqlDumpLimitError("SQL current pointer exceeds MAX_MANIFEST_BYTES")
    pointer = _validate_sql_current_pointer(json.loads(payload))
    relative = pointer["generation"]
    assert isinstance(relative, str)
    normalized = normalize_member(relative)
    if normalized != relative:
        raise ValueError("unsafe SQL generation path")
    parts = PurePosixPath(relative).parts
    if len(parts) != 2 or parts[0] != "normalized-generations":
        raise ValueError("SQL generation must be below normalized-generations")
    generation = _strict_sql_generation(generations_root, root / Path(*parts))
    files = pointer["files"]
    assert isinstance(files, dict)
    for table in _SQL_TABLES:
        evidence = files[table]
        assert isinstance(evidence, dict)
        path = generation / f"{table}.jsonl"
        actual = _sql_file_evidence(path, evidence["count"])
        if evidence.get("size") != actual["size"]:
            raise ValueError(f"SQL generation size mismatch: {table}")
        if evidence.get("sha256") != actual["sha256"]:
            raise ValueError(f"SQL generation hash mismatch: {table}")
    return generation


def cleanup_orphan_sql_generations(output_root: os.PathLike[str] | str) -> None:
    """Explicitly remove orphan generations; never called by the publish path."""
    root = _strict_sql_output_root(output_root, create=False)
    current = (
        resolve_sql_output(root)
        if (root / "normalized.current.json").is_file()
        else None
    )
    generations_root = _strict_sql_generations_root(root, create=False)
    for candidate in generations_root.iterdir():
        candidate = _strict_sql_generation(generations_root, candidate)
        if current is not None and candidate == current:
            continue
        if candidate.name.startswith(("generation-", ".incoming-")):
            shutil.rmtree(candidate)


def _target_table_mentioned(statement: str) -> str | None:
    if (
        re.search(r"\b(?:CREATE\s+TABLE|INSERT\s+INTO)\b", statement, re.IGNORECASE)
        is None
    ):
        return None
    folded = statement.casefold()
    for table in _SQL_TABLES:
        if re.search(rf"(?<![a-z0-9_]){re.escape(table)}(?![a-z0-9_])", folded):
            return table
    return None


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
    relationship_demands: set[tuple[str, str]] = set()
    table_rows_seen = {table: 0 for table in _SQL_TABLES}
    relationship_key_count = 0
    relationship_index_bytes = 0
    normalized_bytes = 0
    memory_result_bytes = 0
    sample_rows = 0
    sample_bytes = 0
    unknown_statement_rows = False
    diameter_rejected_or_incomplete = False
    output_destination = Path(output_dir) if output_dir is not None else None
    incoming: Path | None = None
    writers: dict[str, BinaryIO] = {}

    def reject(table: str, reason: str) -> None:
        nonlocal diameter_rejected_or_incomplete
        result.counts[table]["rejected"] += 1
        if table == "diameter":
            diameter_rejected_or_incomplete = True
        if len(result.rejected_rows) >= MAX_SQL_REJECTED_ROWS:
            raise SqlDumpLimitError(
                f"rejected rows exceed MAX_SQL_REJECTED_ROWS={MAX_SQL_REJECTED_ROWS}"
            )
        result.rejected_rows.append({"table": table, "reason": reason})

    def validate_text(row: dict[str, object], raw_text: str) -> bool:
        try:
            raw_text.encode("utf-8", errors="strict")
            for value in row.values():
                if isinstance(value, str):
                    value.encode("utf-8", errors="strict")
        except UnicodeEncodeError:
            return False
        return True

    def add_relationships(table: str, row: dict[str, object], target_seq: int) -> None:
        nonlocal relationship_key_count, relationship_index_bytes
        normalized_row = {column.casefold(): value for column, value in row.items()}
        demanded_columns = [
            parent_column
            for parent_table, parent_column in relationship_demands
            if parent_table == table
        ]
        for column in demanded_columns:
            value = normalized_row.get(column)
            if value is None:
                continue
            try:
                hash(value)
            except TypeError:
                continue
            relationship_values = retained_relationships.setdefault((table, column), {})
            if value not in relationship_values:
                if relationship_key_count >= MAX_SQL_RELATIONSHIP_KEYS:
                    raise SqlDumpLimitError(
                        "relationship keys exceed "
                        f"MAX_SQL_RELATIONSHIP_KEYS={MAX_SQL_RELATIONSHIP_KEYS}"
                    )
                key_bytes = (
                    len(
                        json.dumps(
                            [table, column, value, target_seq],
                            ensure_ascii=False,
                            separators=(",", ":"),
                        ).encode("utf-8", errors="strict")
                    )
                    + 128
                )
                if (
                    relationship_index_bytes + key_bytes
                    > MAX_SQL_RELATIONSHIP_INDEX_BYTES
                ):
                    raise SqlDumpLimitError(
                        "relationship index bytes exceed "
                        "MAX_SQL_RELATIONSHIP_INDEX_BYTES="
                        f"{MAX_SQL_RELATIONSHIP_INDEX_BYTES}"
                    )
                relationship_key_count += 1
                relationship_index_bytes += key_bytes
                relationship_values[value] = target_seq
            elif relationship_values[value] != target_seq:
                relationship_values[value] = None

    def accept(
        table: str,
        columns: Sequence[str],
        row: dict[str, object],
        raw_text: str,
        target_seq: int,
        *,
        index_relationships: bool = False,
    ) -> None:
        nonlocal normalized_bytes, memory_result_bytes, sample_rows, sample_bytes
        normalized_row = dict(row)
        normalized_row["legacySeqNo"] = target_seq
        normalized_row["legacyTable"] = table
        normalized_row["originalRowHash"] = _stable_row_hash(table, columns, raw_text)
        normalized_row["originalRowHashAlgorithm"] = "sha256-raw-sql-tuple-bytes-v1"
        line = (
            json.dumps(normalized_row, ensure_ascii=False, sort_keys=True) + "\n"
        ).encode("utf-8", errors="strict")
        if normalized_bytes + len(line) > MAX_SQL_NORMALIZED_BYTES:
            raise SqlDumpLimitError(
                "normalized bytes exceed "
                f"MAX_SQL_NORMALIZED_BYTES={MAX_SQL_NORMALIZED_BYTES}"
            )
        normalized_bytes += len(line)
        if index_relationships:
            add_relationships(table, row, target_seq)
        if output_destination is None:
            accepted_total = sum(item["accepted"] for item in result.counts.values())
            if accepted_total >= MAX_SQL_RESULT_ROWS:
                raise SqlDumpLimitError(
                    f"accepted rows exceed MAX_SQL_RESULT_ROWS={MAX_SQL_RESULT_ROWS}"
                )
            if memory_result_bytes + len(line) > MAX_SQL_RESULT_BYTES:
                raise SqlDumpLimitError(
                    f"result bytes exceed MAX_SQL_RESULT_BYTES={MAX_SQL_RESULT_BYTES}"
                )
            memory_result_bytes += len(line)
            result.rows_by_table[table].append(normalized_row)
            result.rows_by_seq.setdefault(target_seq, []).append(normalized_row)
        else:
            writers[table].write(line)
            if (
                sample_rows < MAX_SQL_SAMPLE_ROWS
                and sample_bytes + len(line) <= MAX_SQL_SAMPLE_BYTES
            ):
                result.rows_by_table[table].append(normalized_row)
                result.rows_by_seq.setdefault(target_seq, []).append(normalized_row)
                sample_rows += 1
                sample_bytes += len(line)
        result.counts[table]["accepted"] += 1

    def spool_record(
        pending: BinaryIO,
        table: str,
        columns: Sequence[str],
        row: dict[str, object],
        raw_text: str,
        pending_bytes: int,
    ) -> int:
        document = {
            "table": table,
            "columns": list(columns),
            "row": row,
            "rawText": raw_text,
        }
        payload = (
            json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8", errors="strict")
        if pending_bytes + len(payload) > MAX_SQL_PENDING_BYTES:
            raise SqlDumpLimitError(
                f"pending spool bytes exceed MAX_SQL_PENDING_BYTES={MAX_SQL_PENDING_BYTES}"
            )
        pending.write(payload)
        return pending_bytes + len(payload)

    with tempfile.TemporaryDirectory(prefix="bkv-sql-spool-") as spool_directory:
        pending_path = Path(spool_directory) / "pending-0.jsonl"
        pending_bytes = 0
        try:
            if output_destination is not None:
                output_destination = _strict_sql_output_root(
                    output_destination, create=True
                )
                generations_root = _strict_sql_generations_root(
                    output_destination, create=True
                )
                incoming = Path(
                    tempfile.mkdtemp(
                        prefix=".incoming-",
                        dir=generations_root,
                    )
                )
                writers = {
                    table: (incoming / f"{table}.jsonl").open("wb")
                    for table in _SQL_TABLES
                }
            with pending_path.open("wb") as pending:
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
                            target_table = _target_table_mentioned(statement)
                            if target_table is not None:
                                result.parse_rejected_statements += 1
                                result.integrity = "partial-parse-error"
                                if "insert" in statement.casefold():
                                    result.counts[target_table][
                                        "statementRejectedRowsUnknown"
                                    ] += 1
                                    unknown_statement_rows = True
                            continue
                        table, explicit_columns, sql_rows, row_count_known = inserted
                        if table not in _SQL_TABLES:
                            target_table = _target_table_mentioned(statement)
                            if target_table is not None:
                                result.parse_rejected_statements += 1
                                result.integrity = "partial-parse-error"
                                result.counts[target_table][
                                    "statementRejectedRowsUnknown"
                                ] += 1
                                unknown_statement_rows = True
                            continue
                        if not row_count_known:
                            result.counts[table]["statementRejectedRowsUnknown"] += 1
                            unknown_statement_rows = True
                            continue
                        if table_rows_seen[table] + len(sql_rows) > MAX_SQL_TABLE_ROWS:
                            raise SqlDumpLimitError(
                                "table rows exceed "
                                f"MAX_SQL_TABLE_ROWS={MAX_SQL_TABLE_ROWS}: {table}"
                            )
                        table_rows_seen[table] += len(sql_rows)
                        schema = schemas.get(table)
                        if schema is None:
                            for _sql_row in sql_rows:
                                reject(table, "schema_unknown")
                            continue
                        columns = (
                            explicit_columns
                            if explicit_columns is not None
                            else schema.columns
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
                            if not validate_text(row, sql_row.raw_text):
                                reject(table, "invalid_text_encoding")
                                continue
                            if any(
                                isinstance(value, float)
                                and not (float("-inf") < value < float("inf"))
                                for value in values
                            ):
                                reject(table, "non_finite_numeric")
                                continue
                            if any(
                                column.casefold() in _PHYSICAL_COLUMN_NAMES
                                and isinstance(value, (int, float))
                                and not isinstance(value, bool)
                                and value < 0
                                for column, value in row.items()
                            ):
                                reject(table, "negative_physical_dimension")
                                continue
                            target_seq, relationship_state = _row_target_seq(
                                schema, row, targets, retained_relationships
                            )
                            if relationship_state == "accepted":
                                assert target_seq is not None
                                accept(
                                    table,
                                    columns,
                                    row,
                                    sql_row.raw_text,
                                    target_seq,
                                )
                            elif relationship_state == "pending":
                                pending_bytes = spool_record(
                                    pending,
                                    table,
                                    columns,
                                    row,
                                    sql_row.raw_text,
                                    pending_bytes,
                                )
                            elif relationship_state == "conflict":
                                reject(table, "relationship_conflict")
                            elif relationship_state == "not_target":
                                reject(table, "seq_not_target")
                            else:
                                reject(table, "relationship_unproven")
                except (zipfile.BadZipFile, OSError, EOFError) as error:
                    if "crc" not in str(error).casefold():
                        raise
                    result.integrity = "partial-crc-error"

            for schema in schemas.values():
                relationship_demands.update(schema.foreign_keys.values())
            if output_destination is None:
                accepted_rows = (
                    (table, row)
                    for table, rows in result.rows_by_table.items()
                    for row in rows
                )
                for table, row in accepted_rows:
                    add_relationships(table, row, int(row["legacySeqNo"]))
            else:
                for writer in writers.values():
                    writer.flush()
                assert incoming is not None
                for table in _SQL_TABLES:
                    with (incoming / f"{table}.jsonl").open(
                        "r", encoding="utf-8"
                    ) as accepted_input:
                        for line in accepted_input:
                            row = json.loads(line)
                            add_relationships(table, row, int(row["legacySeqNo"]))

            current = pending_path
            for pass_number in range(MAX_SQL_PENDING_REPLAY_PASSES):
                if not current.exists() or current.stat().st_size == 0:
                    break
                next_path = Path(spool_directory) / f"pending-{pass_number + 1}.jsonl"
                progress = False
                with current.open("rb") as pending_input, next_path.open(
                    "wb"
                ) as pending_output:
                    for payload in pending_input:
                        document = json.loads(payload)
                        table = document["table"]
                        columns = tuple(document["columns"])
                        row = document["row"]
                        raw_text = document["rawText"]
                        schema = schemas.get(table)
                        if schema is None:
                            reject(table, "relationship_unproven")
                            continue
                        target_seq, relationship_state = _row_target_seq(
                            schema, row, targets, retained_relationships
                        )
                        if relationship_state == "accepted":
                            assert target_seq is not None
                            accept(
                                table,
                                columns,
                                row,
                                raw_text,
                                target_seq,
                                index_relationships=True,
                            )
                            progress = True
                        elif relationship_state == "pending":
                            pending_output.write(payload)
                        elif relationship_state == "conflict":
                            reject(table, "relationship_conflict")
                        elif relationship_state == "not_target":
                            reject(table, "seq_not_target")
                        else:
                            reject(table, "relationship_unproven")
                current.unlink(missing_ok=True)
                current = next_path
                if not progress:
                    with current.open("rb") as unresolved:
                        for payload in unresolved:
                            document = json.loads(payload)
                            reject(document["table"], "relationship_unproven")
                    current.unlink(missing_ok=True)
                    break
            if current.exists() and current.stat().st_size:
                raise SqlDumpLimitError(
                    "pending replay passes exceed "
                    "MAX_SQL_PENDING_REPLAY_PASSES="
                    f"{MAX_SQL_PENDING_REPLAY_PASSES}"
                )

            diameter_schema = schemas.get("diameter")
            diameter_relationship_proven = False
            if diameter_schema is not None:
                diameter_relationship_proven = any(
                    column.casefold() == "seqno" for column in diameter_schema.columns
                )
                for (
                    parent_table,
                    parent_column,
                ) in diameter_schema.foreign_keys.values():
                    parent_schema = schemas.get(parent_table)
                    if parent_schema is not None and any(
                        column.casefold() == parent_column
                        for column in parent_schema.columns
                    ):
                        diameter_relationship_proven = True
                        break
            result.diameter_complete = (
                result.integrity == "ok"
                and not unknown_statement_rows
                and not diameter_rejected_or_incomplete
                and diameter_relationship_proven
            )
            if output_destination is not None:
                for writer in writers.values():
                    writer.flush()
                    os.fsync(writer.fileno())
                    writer.close()
                writers.clear()
                assert incoming is not None
                _fsync_directory(incoming)
                _publish_sql_output(incoming, output_destination, result)
                incoming = None
        finally:
            for writer in writers.values():
                writer.close()
            if incoming is not None:
                shutil.rmtree(incoming, ignore_errors=True)

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
                "crc32": record.get("crc32", "").upper() or None,
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


def _load_json_document(path: Path, label: str) -> dict[str, object]:
    if is_reparse_point(path):
        raise ValueError(f"{label} may not be a reparse point")
    payload = path.read_bytes()
    if len(payload) > MAX_MANIFEST_BYTES:
        raise InventoryLimitError(
            f"{label} bytes {len(payload)} exceed MAX_MANIFEST_BYTES={MAX_MANIFEST_BYTES}"
        )
    document = json.loads(payload)
    if not isinstance(document, dict):
        raise ValueError(f"{label} must be a JSON object")
    return document


def _verify_named_file(
    path: Path,
    evidence: object,
    label: str,
    *,
    max_bytes: int = MAX_STAGE_ARTIFACT_BYTES,
) -> None:
    if not isinstance(evidence, dict):
        raise ValueError(f"{label} evidence must be an object")
    expected_size = evidence.get("size")
    expected_hash = evidence.get("sha256")
    if (
        isinstance(expected_size, bool)
        or not isinstance(expected_size, int)
        or expected_size < 0
        or expected_size > max_bytes
    ):
        raise ValueError(f"{label} evidence has an invalid size")
    if not isinstance(expected_hash, str) or re.fullmatch(r"[0-9a-f]{64}", expected_hash) is None:
        raise ValueError(f"{label} evidence has an invalid sha256")
    if is_reparse_point(path) or not path.is_file():
        raise ValueError(f"{label} is not a regular non-reparse file: {path}")
    if path.stat().st_size != expected_size:
        raise ValueError(f"{label} size mismatch: {path}")
    actual_hash = _sha256_file(
        path,
        max_bytes=max_bytes,
        deadline=time.monotonic() + STAGE_TIMEOUT_SECONDS,
    )
    if actual_hash != expected_hash:
        raise ValueError(f"{label} hash mismatch: {path}")


def _stage_path(root: Path, relative: str) -> Path:
    normalized = normalize_member(relative)
    if normalized != relative:
        raise ValueError(f"unsafe staged relative path: {relative!r}")
    candidate = root / Path(*PurePosixPath(relative).parts)
    resolved = candidate.resolve(strict=False)
    if resolved == root or not resolved.is_relative_to(root):
        raise ValueError(f"staged path escapes incoming batch: {relative!r}")
    for existing in _existing_chain(candidate):
        if is_reparse_point(existing):
            raise ValueError(f"staged path contains a reparse point: {existing}")
    return candidate


def _write_bytes_exclusive(destination: Path, payload: bytes) -> dict[str, object]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    for existing in _existing_chain(destination):
        if is_reparse_point(existing):
            raise ValueError(f"staged path contains a reparse point: {existing}")
    digest = hashlib.sha256()
    total = 0
    with destination.open("xb") as output:
        for offset in range(0, len(payload), _IO_CHUNK_BYTES):
            chunk = payload[offset : offset + _IO_CHUNK_BYTES]
            total += len(chunk)
            if total > MAX_STAGE_ARTIFACT_BYTES:
                raise InventoryLimitError(
                    "staged artifact exceeds "
                    f"MAX_STAGE_ARTIFACT_BYTES={MAX_STAGE_ARTIFACT_BYTES}"
                )
            output.write(chunk)
            digest.update(chunk)
        output.flush()
        os.fsync(output.fileno())
    return {"size": total, "sha256": digest.hexdigest()}


def _extract_unrar_member_default(
    command: Sequence[str], destination: Path, expected_size: int
) -> tuple[int, bytes, int, str]:
    output = destination.open("xb")
    try:
        process = subprocess.Popen(
            list(command),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=(
                getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
            ),
        )
    except BaseException:
        output.close()
        raise
    assert process.stdout is not None and process.stderr is not None
    stderr = bytearray()
    stderr_exceeded = threading.Event()
    stdout_exceeded = threading.Event()
    reader_error: list[BaseException] = []
    digest = hashlib.sha256()
    total = 0

    def drain_stdout() -> None:
        nonlocal total
        try:
            while True:
                chunk = process.stdout.read(_IO_CHUNK_BYTES)
                if not chunk:
                    return
                total += len(chunk)
                if total > expected_size or total > MAX_STAGE_ARTIFACT_BYTES:
                    stdout_exceeded.set()
                    process.kill()
                    return
                output.write(chunk)
                digest.update(chunk)
        except BaseException as error:
            reader_error.append(error)
            process.kill()
        finally:
            process.stdout.close()

    def drain_stderr() -> None:
        try:
            while True:
                chunk = process.stderr.read(_IO_CHUNK_BYTES)
                if not chunk:
                    return
                remaining = MAX_UNRAR_STDERR_BYTES - len(stderr)
                if len(chunk) > remaining:
                    if remaining > 0:
                        stderr.extend(chunk[:remaining])
                    stderr_exceeded.set()
                    process.kill()
                    return
                stderr.extend(chunk)
        finally:
            process.stderr.close()

    threads = [
        threading.Thread(target=drain_stdout, daemon=True),
        threading.Thread(target=drain_stderr, daemon=True),
    ]
    for thread in threads:
        thread.start()
    timed_out = False
    try:
        try:
            return_code = process.wait(timeout=UNRAR_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.kill()
            return_code = process.wait()
    finally:
        for thread in threads:
            thread.join(timeout=5)
        output.flush()
        os.fsync(output.fileno())
        output.close()
        if any(thread.is_alive() for thread in threads):
            process.kill()
            raise RuntimeError("UnRAR extraction output reader did not terminate")
    if timed_out:
        raise RuntimeError(
            f"UnRAR timed out after {UNRAR_TIMEOUT_SECONDS} seconds"
        )
    if reader_error:
        raise RuntimeError("UnRAR stdout reader failed") from reader_error[0]
    if stderr_exceeded.is_set():
        raise InventoryLimitError(
            f"UnRAR stderr exceeds MAX_UNRAR_STDERR_BYTES={MAX_UNRAR_STDERR_BYTES}"
        )
    if stdout_exceeded.is_set():
        raise InventoryLimitError(
            f"UnRAR member output exceeds declared size {expected_size}"
        )
    return return_code, bytes(stderr), total, digest.hexdigest()


def _extract_unrar_member(
    *,
    unrar: Path,
    archive: Path,
    member: str,
    destination: Path,
    expected_size: int,
    runner: Callable[..., subprocess.CompletedProcess[bytes]] | None,
) -> dict[str, object]:
    if expected_size < 0 or expected_size > MAX_STAGE_ARTIFACT_BYTES:
        raise InventoryLimitError(f"invalid staged artifact size for {member}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    for existing in _existing_chain(destination):
        if is_reparse_point(existing):
            raise ValueError(f"staged artifact path contains a reparse point: {existing}")
    command = [
        str(unrar),
        "p",
        "-inul",
        "-cfg-",
        "-p-",
        str(archive),
        member,
    ]
    if runner is None:
        return_code, stderr, total, digest = _extract_unrar_member_default(
            command, destination, expected_size
        )
    else:
        try:
            result = runner(
                command,
                timeout=UNRAR_TIMEOUT_SECONDS,
                max_stdout_bytes=expected_size,
                max_stderr_bytes=MAX_UNRAR_STDERR_BYTES,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(
                f"UnRAR timed out after {UNRAR_TIMEOUT_SECONDS} seconds"
            ) from error
        stdout = result.stdout or b""
        stderr = result.stderr or b""
        if isinstance(stdout, str):
            raise TypeError("UnRAR extraction runner stdout must be bytes")
        if isinstance(stderr, str):
            stderr = stderr.encode("utf-8", errors="replace")
        if len(stderr) > MAX_UNRAR_STDERR_BYTES:
            raise InventoryLimitError(
                f"UnRAR stderr exceeds MAX_UNRAR_STDERR_BYTES={MAX_UNRAR_STDERR_BYTES}"
            )
        if len(stdout) > expected_size:
            raise InventoryLimitError(
                f"UnRAR member output exceeds declared size {expected_size}"
            )
        evidence = _write_bytes_exclusive(destination, stdout)
        return_code = result.returncode
        total = int(evidence["size"])
        digest = str(evidence["sha256"])
    if return_code != 0:
        raise RuntimeError(
            f"UnRAR extraction failed for {member} with exit {return_code}: "
            f"{_decode_console(stderr).strip()}"
        )
    if total != expected_size:
        raise ValueError(
            f"UnRAR member size mismatch for {member}: expected {expected_size}, got {total}"
        )
    return {"size": total, "sha256": digest}


def _artifact_relative_path(entry: dict[str, object]) -> str:
    member = str(entry.get("memberPath", ""))
    metadata = _image_metadata(member)
    if metadata is None:
        raise ValueError(f"inventory contains a non-approved image member: {member!r}")
    for key in ("cameraNumber", "seqNo", "kind", "extension"):
        if entry.get(key) != metadata[key]:
            raise ValueError(f"inventory image metadata mismatch for {member}: {key}")
    extension = str(metadata["extension"])
    kind = str(metadata["kind"])
    if extension == ".dat":
        destination_kind = "metadata"
    elif extension == ".jpg" and kind == "2D":
        destination_kind = "2d"
    elif extension == ".d3img" and kind == "3D":
        destination_kind = "3d"
    else:
        raise ValueError(f"unsupported inventory image semantics: {member}")
    filename = PurePosixPath(member).name
    return (
        f"artifacts/camera{metadata['cameraNumber']}/{metadata['seqNo']}/"
        f"{destination_kind}/{filename}"
    )


def _select_archive_part(entry: dict[str, object]) -> str:
    parts = entry.get("archiveParts")
    if not isinstance(parts, list) or not parts or not all(isinstance(item, str) for item in parts):
        archive_part = entry.get("archivePart")
        if not isinstance(archive_part, str):
            raise ValueError("inventory image entry lacks archiveParts")
        parts = [archive_part]
    if any(part not in ("image-part1", "image-part2") for part in parts):
        raise ValueError("inventory image entry names an unknown archive part")
    archive_metadata = entry.get("archiveMetadata")
    volume_metadata = entry.get("volumeMetadata")
    final_crc = (
        archive_metadata.get("crc32")
        if isinstance(archive_metadata, dict)
        else None
    )
    if isinstance(final_crc, str) and final_crc:
        matches = []
        for part in parts:
            evidence = (
                volume_metadata.get(part)
                if isinstance(volume_metadata, dict)
                else None
            )
            volume_crc = evidence.get("crc32") if isinstance(evidence, dict) else None
            if isinstance(volume_crc, str) and volume_crc.upper() == final_crc.upper():
                matches.append(part)
        if matches:
            return matches[0]
        if len(parts) > 1:
            raise ValueError(
                "duplicate RAR member lacks per-volume evidence for its final CRC"
            )
    # Without a member CRC, use a deterministic single extraction from the
    # last listing occurrence; duplicate metadata was already cross-checked.
    return parts[-1]


def _copy_verified_file(source: Path, destination: Path, max_bytes: int) -> dict[str, object]:
    snapshot = _file_snapshot(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    total = 0
    with source.open("rb") as reader, destination.open("xb") as writer:
        while True:
            chunk = reader.read(_IO_CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise InventoryLimitError(f"staged copy exceeds byte limit: {source}")
            writer.write(chunk)
            digest.update(chunk)
        writer.flush()
        os.fsync(writer.fileno())
    _assert_snapshot(source, snapshot)
    return {"size": total, "sha256": digest.hexdigest()}


def _bounded_utf8_text(value: object, max_bytes: int) -> str:
    encoded = str(value).encode("utf-8", errors="replace")
    if len(encoded) <= max_bytes:
        return encoded.decode("utf-8")
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def _unavailable_file_evidence(error: object) -> dict[str, object]:
    return {
        "path": None,
        "size": None,
        "sha256": None,
        "evidenceStatus": "unavailable",
        "error": _bounded_utf8_text(error, 1024),
    }


def _failed_file_evidence(
    path: Path, relative: str, *, max_bytes: int = MAX_STAGE_ARTIFACT_BYTES
) -> dict[str, object]:
    if is_reparse_point(path) or not path.is_file():
        return _unavailable_file_evidence(f"file unavailable: {relative}")
    snapshot = _file_snapshot(path)
    digest = _sha256_file(
        path,
        max_bytes=max_bytes,
        deadline=time.monotonic() + STAGE_TIMEOUT_SECONDS,
    )
    _assert_snapshot(path, snapshot)
    if is_reparse_point(path):
        raise ValueError(f"file evidence became a reparse point: {relative}")
    return {
        "path": relative,
        "size": snapshot.size,
        "sha256": digest,
        "evidenceStatus": "verified",
        "error": None,
    }


def _empty_camera_inventory() -> dict[str, dict[str, object]]:
    return {
        str(number): {
            "cameraNumber": number,
            "artifactCount": 0,
            "seqNos": [],
            "countsByKind": {"2d": 0, "3d": 0, "metadata": 0},
            "matrix": {
                str(seq_no): {"2d": 0, "3d": 0, "metadata": 0}
                for seq_no in TARGET_SEQ_NOS
            },
        }
        for number in range(1, 7)
    }


def _collect_failed_artifacts(
    incoming: Path,
    candidates: object,
) -> tuple[list[dict[str, object]], dict[str, dict[str, object]]]:
    artifacts: list[dict[str, object]] = []
    cameras = _empty_camera_inventory()
    if not isinstance(candidates, list):
        return artifacts, cameras
    for candidate in candidates:
        if not isinstance(candidate, dict) or not isinstance(candidate.get("path"), str):
            continue
        relative = str(candidate["path"])
        path = _stage_path(incoming, relative)
        parts = PurePosixPath(relative).parts
        if len(parts) < 5 or re.fullmatch(r"camera([1-6])", parts[1]) is None:
            raise ValueError(f"invalid failed artifact path: {relative}")
        camera_number = int(parts[1][6:])
        if not parts[2].isdecimal() or int(parts[2]) not in TARGET_SEQ_NOS:
            raise ValueError(f"invalid failed artifact SeqNo path: {relative}")
        kind = parts[3]
        if kind not in ("2d", "3d", "metadata"):
            raise ValueError(f"invalid failed artifact kind path: {relative}")
        try:
            _verify_named_file(path, candidate, "failed artifact candidate")
        except (OSError, ValueError, InventoryLimitError):
            continue
        evidence = dict(candidate)
        evidence["evidenceStatus"] = "verified"
        evidence["error"] = None
        artifacts.append(evidence)
        camera = cameras[str(camera_number)]
        camera["artifactCount"] = int(camera["artifactCount"]) + 1
        seq_nos = camera["seqNos"]
        assert isinstance(seq_nos, list)
        if int(parts[2]) not in seq_nos:
            seq_nos.append(int(parts[2]))
        counts = camera["countsByKind"]
        assert isinstance(counts, dict)
        counts[kind] = int(counts[kind]) + 1
        matrix = camera["matrix"]
        assert isinstance(matrix, dict)
        matrix[str(int(parts[2]))][kind] += 1
    for camera in cameras.values():
        camera["seqNos"] = sorted(camera["seqNos"])
    return artifacts, cameras


def _publish_failed_stage(
    incoming: Path,
    output: Path,
    batch_id: str,
    error: BaseException,
    quarantine_writer: _QuarantineWriter,
    context: dict[str, object],
) -> Path:
    if not incoming.is_dir() or is_reparse_point(incoming):
        raise RuntimeError("cannot preserve failed stage evidence") from error
    (incoming / "manifest.json").unlink(missing_ok=True)
    evidence = {
        "schema": "steel.bkv-stage-quarantine.v1",
        "reason": _bounded_utf8_text(type(error).__name__, 128),
        "message": _bounded_utf8_text(error, 4096),
        "code": _bounded_utf8_text(context.get("code", "stage_failed"), 128),
        "stage": _bounded_utf8_text(context.get("stage", "unknown"), 128),
    }
    quarantine = incoming / "quarantine.jsonl"
    quarantine_writer.append(evidence)
    quarantine_writer.close()
    quarantine_evidence = _failed_file_evidence(
        quarantine, "quarantine.jsonl", max_bytes=MAX_MANIFEST_BYTES
    )
    artifacts, camera_inventory = _collect_failed_artifacts(
        incoming, context.get("artifacts")
    )
    accepted_paths = {str(item["path"]) for item in artifacts}
    artifact_root = incoming / "artifacts"
    if artifact_root.is_dir() and not is_reparse_point(artifact_root):
        for path in artifact_root.rglob("*"):
            if is_reparse_point(path):
                raise ValueError(f"failed artifact tree contains a reparse point: {path}")
            if path.is_file() and path.relative_to(incoming).as_posix() not in accepted_paths:
                path.unlink()
    present_seq_nos = sorted({int(item["seqNo"]) for item in artifacts})
    inventory = context.get("inventory")
    source_inventory_path = incoming / "source" / "inventory.json"
    source_inventory = _failed_file_evidence(
        source_inventory_path,
        "source/inventory.json",
        max_bytes=MAX_MANIFEST_BYTES,
    )
    source_inventory["originalPath"] = context.get("inventoryPath")
    source_inventory["originalSha256"] = (
        source_inventory.get("sha256")
        if source_inventory.get("evidenceStatus") == "verified"
        else None
    )
    source_archives: dict[str, dict[str, object]] = {}
    inventory_archives = inventory.get("archives") if isinstance(inventory, dict) else None
    for archive_part in ("database-zip", "image-part1", "image-part2"):
        archive_evidence = (
            inventory_archives.get(archive_part)
            if isinstance(inventory_archives, dict)
            else None
        )
        verified_archive: dict[str, object] | None = None
        if source_inventory.get("evidenceStatus") == "verified" and isinstance(
            archive_evidence, dict
        ) and isinstance(
            archive_evidence.get("path"), str
        ):
            try:
                archive_path = Path(str(archive_evidence["path"])).resolve(strict=True)
                _verify_named_file(
                    archive_path,
                    archive_evidence,
                    f"failed source archive {archive_part}",
                    max_bytes=MAX_INPUT_ARCHIVE_BYTES,
                )
                verified_archive = {
                    "path": str(archive_path),
                    "size": archive_evidence.get("size"),
                    "sha256": archive_evidence.get("sha256"),
                    "fileIdentity": archive_evidence.get("fileIdentity"),
                    "mtimeNs": archive_evidence.get("mtimeNs"),
                    "integrity": archive_evidence.get("integrityStatus", "verified"),
                    "evidenceStatus": "verified",
                    "error": None,
                }
            except (OSError, ValueError, InventoryLimitError):
                verified_archive = None
        if verified_archive is not None:
            source_archives[archive_part] = verified_archive
        else:
            unavailable = _unavailable_file_evidence(error)
            unavailable["integrity"] = None
            unavailable["fileIdentity"] = None
            unavailable["mtimeNs"] = None
            source_archives[archive_part] = unavailable
    normalization_evidence = _failed_file_evidence(
        incoming / "source" / "normalized.current.json",
        "source/normalized.current.json",
        max_bytes=MAX_MANIFEST_BYTES,
    )
    pointer_document = context.get("normalizationPointer")
    pointer_files = (
        pointer_document.get("files") if isinstance(pointer_document, dict) else None
    )
    normalized: list[dict[str, object]] = []
    for table in _SQL_TABLES:
        relative = f"normalized/{table}.jsonl"
        file_evidence = _failed_file_evidence(incoming / relative, relative)
        normalized.append(
            {
                "table": table,
                "count": (
                    pointer_files[table]["count"]
                    if isinstance(pointer_files, dict) and table in pointer_files
                    else None
                ),
                **file_evidence,
            }
        )
    entries = inventory.get("entries") if isinstance(inventory, dict) else None
    database_statuses = [
        str(entry.get("integrityStatus"))
        for entry in entries
        if isinstance(entry, dict) and entry.get("archivePart") == "database-zip"
    ] if isinstance(entries, list) else []
    database_members = [
        {
            key: entry.get(key)
            for key in (
                "memberPath", "size", "sha256", "integrityStatus",
                "integrityEvidence",
            )
        }
        for entry in entries
        if isinstance(entry, dict) and entry.get("archivePart") == "database-zip"
    ] if isinstance(entries, list) else []
    if source_inventory.get("evidenceStatus") != "verified":
        database_statuses = []
        database_members = []
    rejected_entries = 0
    statistics = inventory.get("statistics") if isinstance(inventory, dict) else None
    if isinstance(statistics, dict):
        for statistic in statistics.values():
            rejected = statistic.get("rejected") if isinstance(statistic, dict) else None
            if isinstance(rejected, int) and not isinstance(rejected, bool) and rejected >= 0:
                rejected_entries += rejected
    result_evidence = (
        pointer_document.get("resultEvidence")
        if isinstance(pointer_document, dict)
        and normalization_evidence.get("evidenceStatus") == "verified"
        else None
    )
    result_counts = (
        result_evidence.get("counts") if isinstance(result_evidence, dict) else None
    )
    normalized_rows_by_table = {
        table: (
            int(next(item for item in normalized if item["table"] == table)["count"])
            if next(item for item in normalized if item["table"] == table).get(
                "evidenceStatus"
            ) == "verified"
            else 0
        )
        for table in _SQL_TABLES
    }
    normalized_rejected = sum(
        int(result_counts[table]["rejected"])
        + int(result_counts[table]["statementRejectedRowsUnknown"])
        for table in _SQL_TABLES
    ) if isinstance(result_counts, dict) else 0
    normalized_files_verified = all(
        item.get("evidenceStatus") == "verified" for item in normalized
    ) and normalization_evidence.get("evidenceStatus") == "verified"
    failed_manifest = {
        "schema": "steel.bkv-import-manifest.v1",
        "batchId": batch_id,
        "status": "failed",
        "importEligible": False,
        "seqNos": list(TARGET_SEQ_NOS),
        "presentSeqNos": present_seq_nos,
        "targetCoverageComplete": False,
        "coverage": {
            "complete": False,
            "presentSeqNos": present_seq_nos,
            "missingSeqNos": [
                seq_no for seq_no in TARGET_SEQ_NOS if seq_no not in present_seq_nos
            ],
            "missingCameraSeq": [
                {"cameraNumber": number, "seqNo": seq_no}
                for number in range(1, 7)
                for seq_no in TARGET_SEQ_NOS
                if sum(
                    int(value)
                    for value in camera_inventory[str(number)]["matrix"][str(seq_no)].values()
                ) == 0
            ],
        },
        "sourceInventory": source_inventory,
        "normalizationEvidence": normalization_evidence,
        "sourceArchives": source_archives,
        "databaseIntegrity": {
            "statuses": database_statuses,
            "sourceMembers": database_members,
            "allInventoryMembersVerified": bool(database_statuses) and all(
                item == "ok" for item in database_statuses
            ),
            "normalizedGenerationVerified": normalized_files_verified,
            "crcFailed": "crc-failed" in database_statuses,
            "evidenceStatus": (
                "verified"
                if source_inventory.get("evidenceStatus") == "verified"
                and normalization_evidence.get("evidenceStatus") == "verified"
                else "failed"
            ),
            "normalizationIntegrity": (
                result_evidence.get("integrity")
                if isinstance(result_evidence, dict)
                else None
            ),
            "diameterComplete": (
                result_evidence.get("diameterComplete")
                if isinstance(result_evidence, dict)
                else None
            ),
            "parseRejectedStatements": (
                result_evidence.get("parseRejectedStatements")
                if isinstance(result_evidence, dict)
                else None
            ),
        },
        "counts": {
            "acceptedArtifacts": len(artifacts),
            "rejectedEntries": rejected_entries,
            "quarantineEntries": quarantine_writer.count,
            "acceptedNormalizedRows": sum(normalized_rows_by_table.values()),
            "rejectedNormalizedRows": normalized_rejected,
            "normalizedRowsByTable": normalized_rows_by_table,
        },
        "cameraInventory": camera_inventory,
        "normalized": normalized,
        "artifacts": artifacts,
        "failure": evidence,
        "quarantine": quarantine_evidence,
    }
    _write_json_atomic(incoming / "manifest.json", failed_manifest)
    _verify_staged_batch(incoming, allow_failed=True)
    prefix = f"{batch_id}.incoming-"
    if not incoming.name.startswith(prefix):
        raise ValueError("incoming batch lacks its trusted run identifier")
    run_id = incoming.name[len(prefix) :]
    failed = output / f"{batch_id}.failed-{run_id}"
    if failed.exists() or is_reparse_point(failed):
        raise FileExistsError(f"failed evidence collision: {failed}")
    os.rename(incoming, failed)
    _fsync_directory(output)
    _verify_staged_batch(failed, allow_failed=True)
    return failed


def _verify_manifest_file_evidence(
    batch: Path,
    evidence: object,
    label: str,
    *,
    max_bytes: int,
    external: bool = False,
) -> Path | None:
    if not isinstance(evidence, dict):
        raise ValueError(f"{label} evidence must be an object")
    status = evidence.get("evidenceStatus")
    if status == "unavailable":
        if (
            evidence.get("path") is not None
            or evidence.get("size") is not None
            or evidence.get("sha256") is not None
            or not isinstance(evidence.get("error"), str)
        ):
            raise ValueError(f"{label} unavailable evidence must use explicit nulls")
        return None
    if status != "verified" or evidence.get("error") is not None:
        raise ValueError(f"{label} evidence status is invalid")
    relative_or_path = evidence.get("path")
    if not isinstance(relative_or_path, str):
        raise ValueError(f"{label} verified evidence lacks a path")
    path = (
        Path(relative_or_path).resolve(strict=True)
        if external
        else _stage_path(batch, relative_or_path)
    )
    _verify_named_file(path, evidence, label, max_bytes=max_bytes)
    return path


def _deep_verify_original_sources(
    manifest: dict[str, object],
    staged_inventory: dict[str, object],
    source_inventory_evidence: dict[str, object],
) -> None:
    original_path_value = source_inventory_evidence.get("originalPath")
    original_sha256 = source_inventory_evidence.get("originalSha256")
    if (
        not isinstance(original_path_value, str)
        or not isinstance(original_sha256, str)
        or re.fullmatch(r"[0-9a-f]{64}", original_sha256) is None
    ):
        raise ValueError("original inventory evidence is invalid")
    try:
        original_inventory_path = Path(original_path_value).resolve(strict=True)
    except (OSError, FileNotFoundError) as error:
        raise SourceUnavailableError("original inventory is unavailable") from error

    inventory_archives = staged_inventory.get("archives")
    if not isinstance(inventory_archives, dict):
        raise ValueError("original inventory archives are invalid")
    archive_paths: dict[str, Path] = {}
    try:
        for archive_part in ("database-zip", "image-part1", "image-part2"):
            evidence = inventory_archives.get(archive_part)
            if not isinstance(evidence, dict) or not isinstance(evidence.get("path"), str):
                raise ValueError(f"original inventory archive is invalid: {archive_part}")
            archive_paths[archive_part] = Path(str(evidence["path"])).resolve(strict=True)
    except (OSError, FileNotFoundError) as error:
        raise SourceUnavailableError("original source archive is unavailable") from error

    locked_paths = (original_inventory_path, *archive_paths.values())
    try:
        with _stable_archive_inputs(locked_paths) as working:
            locked_inventory = working[original_inventory_path]
            try:
                if is_reparse_point(locked_inventory) or not locked_inventory.is_file():
                    raise ValueError("original inventory is not a regular file")
                actual_inventory_sha256 = _sha256_file(
                    locked_inventory,
                    max_bytes=MAX_MANIFEST_BYTES,
                    deadline=time.monotonic() + STAGE_TIMEOUT_SECONDS,
                )
                if actual_inventory_sha256 != original_sha256:
                    raise ValueError("original inventory hash mismatch")
            except ValueError as error:
                raise SourceUnavailableError("original inventory changed") from error
            original_inventory = _load_json_document(
                locked_inventory, "original inventory"
            )
            if original_inventory != staged_inventory:
                raise ValueError("staged source inventory differs from original inventory")

            source_archives = manifest.get("sourceArchives")
            assert isinstance(source_archives, dict)
            for archive_part, original_archive_path in archive_paths.items():
                inventory_evidence = inventory_archives[archive_part]
                assert isinstance(inventory_evidence, dict)
                manifest_evidence = source_archives.get(archive_part)
                if not isinstance(manifest_evidence, dict) or any(
                    manifest_evidence.get(key) != inventory_evidence.get(key)
                    for key in ("path", "size", "sha256", "fileIdentity", "mtimeNs")
                ):
                    raise ValueError(
                        f"source archive inventory mismatch: {archive_part}"
                    )
                try:
                    _verify_named_file(
                        working[original_archive_path],
                        inventory_evidence,
                        f"original source archive {archive_part}",
                        max_bytes=MAX_INPUT_ARCHIVE_BYTES,
                    )
                except ValueError as error:
                    raise SourceUnavailableError(
                        f"original source archive changed: {archive_part}"
                    ) from error

            actual_database_entries, _ = _inventory_zip(
                working[archive_paths["database-zip"]]
            )
    except SourceUnavailableError:
        raise
    except (OSError, FileNotFoundError, RuntimeError) as error:
        raise SourceUnavailableError("original source evidence is unavailable") from error

    keys = (
        "memberPath", "size", "sha256", "integrityStatus", "integrityEvidence"
    )
    actual_database_members = [
        {key: entry.get(key) for key in keys} for entry in actual_database_entries
    ]
    original_entries = original_inventory.get("entries")
    if not isinstance(original_entries, list):
        raise ValueError("original inventory entries are invalid")
    expected_database_members = [
        {key: entry.get(key) for key in keys}
        for entry in original_entries
        if isinstance(entry, dict) and entry.get("archivePart") == "database-zip"
    ]
    database_integrity = manifest.get("databaseIntegrity")
    manifest_database_members = (
        database_integrity.get("sourceMembers")
        if isinstance(database_integrity, dict)
        else None
    )
    if (
        actual_database_members != expected_database_members
        or manifest_database_members != actual_database_members
    ):
        raise ValueError("database ZIP integrity differs from source evidence")


def _verify_staged_batch(
    batch: Path, *, allow_failed: bool = False, deep_source: bool = True
) -> dict[str, object]:
    batch = batch.resolve(strict=True)
    if is_reparse_point(batch) or not batch.is_dir():
        raise ValueError("staged batch must be a non-reparse directory")
    manifest = _load_json_document(batch / "manifest.json", "staged manifest")
    if manifest.get("schema") != "steel.bkv-import-manifest.v1":
        raise ValueError("invalid staged manifest schema")
    status = manifest.get("status")
    if status not in ("ready", "partial", "failed"):
        raise ValueError("staged manifest status must be ready, partial, or failed")
    if manifest.get("seqNos") != list(TARGET_SEQ_NOS):
        raise ValueError("staged manifest seqNos must be the exact approved target")
    present_seq_nos = manifest.get("presentSeqNos")
    if (
        not isinstance(present_seq_nos, list)
        or not all(
            isinstance(seq_no, int) and not isinstance(seq_no, bool)
            for seq_no in present_seq_nos
        )
        or present_seq_nos != sorted(set(present_seq_nos))
        or any(seq_no not in TARGET_SEQ_NOS for seq_no in present_seq_nos)
    ):
        raise ValueError("staged manifest presentSeqNos is invalid")
    expected_eligible = status == "ready"
    if manifest.get("importEligible") != expected_eligible:
        raise ValueError("staged manifest importEligible does not match status")
    if status == "failed" and not allow_failed:
        raise ValueError("failed staged batch is not canonical")
    failure = manifest.get("failure")
    if status == "failed":
        if (
            not isinstance(failure, dict)
            or failure.get("schema") != "steel.bkv-stage-quarantine.v1"
            or not isinstance(failure.get("reason"), str)
            or len(failure["reason"].encode("utf-8")) > 128
            or not isinstance(failure.get("message"), str)
            or len(failure["message"].encode("utf-8")) > 4096
            or not isinstance(failure.get("code"), str)
            or not isinstance(failure.get("stage"), str)
        ):
            raise ValueError("failed staged batch has invalid bounded failure evidence")
    elif failure is not None:
        raise ValueError("non-failed staged batch must use failure=null")

    source_inventory = manifest.get("sourceInventory")
    source_inventory_path = _verify_manifest_file_evidence(
        batch,
        source_inventory,
        "source inventory",
        max_bytes=MAX_MANIFEST_BYTES,
    )
    inventory_document: dict[str, object] | None = None
    if source_inventory_path is not None:
        inventory_document = _load_json_document(
            source_inventory_path, "staged source inventory"
        )
        if inventory_document.get("schema") != MANIFEST_SCHEMA:
            raise ValueError("staged source inventory schema mismatch")
        if inventory_document.get("batchId") != manifest.get("batchId"):
            raise ValueError("staged source inventory batchId mismatch")
    archives = manifest.get("sourceArchives")
    if not isinstance(archives, dict) or set(archives) != {
        "database-zip", "image-part1", "image-part2"
    }:
        raise ValueError("staged manifest must declare exactly three source archives")
    for archive_part in ("database-zip", "image-part1", "image-part2"):
        evidence = archives.get(archive_part)
        if not isinstance(evidence, dict) or not all(
            key in evidence
            for key in ("integrity", "fileIdentity", "mtimeNs")
        ):
            raise ValueError(f"invalid source archive evidence: {archive_part}")
        if evidence.get("evidenceStatus") == "verified":
            if (
                not isinstance(evidence.get("path"), str)
                or isinstance(evidence.get("size"), bool)
                or not isinstance(evidence.get("size"), int)
                or not isinstance(evidence.get("sha256"), str)
                or re.fullmatch(r"[0-9a-f]{64}", str(evidence["sha256"])) is None
            ):
                raise ValueError(f"invalid offline source archive evidence: {archive_part}")
            verified_archive_path = Path(str(evidence["path"]))
        else:
            _verify_manifest_file_evidence(
                batch,
                evidence,
                f"source archive {archive_part}",
                max_bytes=MAX_INPUT_ARCHIVE_BYTES,
                external=True,
            )
            verified_archive_path = None
        if inventory_document is not None:
            inventory_archives = inventory_document.get("archives")
            expected = (
                inventory_archives.get(archive_part)
                if isinstance(inventory_archives, dict)
                else None
            )
            if not isinstance(expected, dict):
                raise ValueError(f"source inventory archive missing: {archive_part}")
            if verified_archive_path is None:
                if status != "failed":
                    raise ValueError(f"source archive unavailable: {archive_part}")
            else:
                if (
                    str(verified_archive_path) != expected.get("path")
                    or evidence.get("size") != expected.get("size")
                    or evidence.get("sha256") != expected.get("sha256")
                    or evidence.get("fileIdentity") != expected.get("fileIdentity")
                    or evidence.get("mtimeNs") != expected.get("mtimeNs")
                ):
                    raise ValueError(f"source archive inventory mismatch: {archive_part}")
        elif evidence.get("evidenceStatus") == "unavailable" and (
            evidence.get("fileIdentity") is not None
            or evidence.get("mtimeNs") is not None
            or evidence.get("integrity") is not None
        ):
            raise ValueError(f"unavailable source archive evidence is not null: {archive_part}")

    normalization_pointer_path = _verify_manifest_file_evidence(
        batch,
        manifest.get("normalizationEvidence"),
        "normalization pointer evidence",
        max_bytes=MAX_MANIFEST_BYTES,
    )
    normalization_pointer: dict[str, object] | None = None
    if normalization_pointer_path is not None:
        normalization_pointer = _validate_sql_current_pointer(
            _load_json_document(
                normalization_pointer_path, "staged normalization pointer"
            )
        )
    normalized = manifest.get("normalized")
    if not isinstance(normalized, list) or len(normalized) != len(_SQL_TABLES):
        raise ValueError("staged manifest must declare five normalized files")
    if {item.get("table") for item in normalized if isinstance(item, dict)} != set(
        _SQL_TABLES
    ):
        raise ValueError("normalized evidence must name exactly five tables")
    normalized_counts: dict[str, int] = {}
    normalized_available: set[str] = set()
    for evidence in normalized:
        normalized_path = _verify_manifest_file_evidence(
            batch, evidence, "normalized file", max_bytes=MAX_STAGE_ARTIFACT_BYTES
        )
        table = str(evidence["table"])
        if normalized_path is None:
            if status != "failed":
                raise ValueError(f"normalized file unavailable: {table}")
            normalized_counts[table] = 0
            continue
        if normalization_pointer is None:
            raise ValueError("normalized files lack their bound pointer evidence")
        pointer_files = normalization_pointer["files"]
        assert isinstance(pointer_files, dict)
        pointer_evidence = pointer_files[table]
        assert isinstance(pointer_evidence, dict)
        actual = _sql_file_evidence(normalized_path, int(pointer_evidence["count"]))
        if actual != {
            "sha256": pointer_evidence["sha256"],
            "size": pointer_evidence["size"],
            "count": pointer_evidence["count"],
        }:
            raise ValueError(f"normalized pointer evidence mismatch: {table}")
        if evidence.get("count") != actual["count"]:
            raise ValueError(f"normalized manifest count mismatch: {table}")
        normalized_counts[table] = int(actual["count"])
        normalized_available.add(table)
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list):
        raise ValueError("staged manifest artifacts must be an array")
    total = 0
    seen: set[str] = set()
    declared_artifact_paths: set[str] = set()
    for evidence in artifacts:
        if not isinstance(evidence, dict) or not isinstance(evidence.get("path"), str):
            raise ValueError("invalid artifact evidence")
        relative = str(evidence["path"])
        collision_key = unicodedata.normalize("NFC", relative).casefold()
        if collision_key in seen:
            raise ValueError(f"duplicate staged artifact path: {relative}")
        seen.add(collision_key)
        declared_artifact_paths.add(relative)
        path = _stage_path(batch, relative)
        try:
            _verify_manifest_file_evidence(
                batch, evidence, "artifact", max_bytes=MAX_STAGE_ARTIFACT_BYTES
            )
        except ValueError as error:
            if "hash mismatch" in str(error):
                raise ValueError(f"artifact hash mismatch: {path}") from error
            raise
        total += int(evidence["size"])
        if total > MAX_STAGE_TOTAL_BYTES:
            raise InventoryLimitError(
                f"staged artifact total exceeds MAX_STAGE_TOTAL_BYTES={MAX_STAGE_TOTAL_BYTES}"
            )
    disk_artifact_paths: set[str] = set()
    artifact_root = batch / "artifacts"
    if artifact_root.is_dir() and not is_reparse_point(artifact_root):
        for path in artifact_root.rglob("*"):
            if is_reparse_point(path):
                raise ValueError(f"artifact tree contains a reparse point: {path}")
            if path.is_file():
                disk_artifact_paths.add(path.relative_to(batch).as_posix())
    if disk_artifact_paths != declared_artifact_paths:
        raise ValueError("artifact set contains deleted or unmanifested files")

    derived_camera_inventory = _empty_camera_inventory()
    inventory_members = {}
    if inventory_document is not None:
        inventory_entries = inventory_document.get("entries")
        if not isinstance(inventory_entries, list):
            raise ValueError("source inventory entries must be an array")
        inventory_members = {
            str(entry.get("memberPath")): entry
            for entry in inventory_entries
            if isinstance(entry, dict) and entry.get("cameraNumber") is not None
        }
    for evidence in artifacts:
        assert isinstance(evidence, dict)
        relative = str(evidence["path"])
        parts = PurePosixPath(relative).parts
        camera_match = re.fullmatch(r"camera([1-6])", parts[1]) if len(parts) == 5 else None
        if (
            camera_match is None
            or not parts[2].isdecimal()
            or int(parts[2]) not in TARGET_SEQ_NOS
            or parts[3] not in ("2d", "3d", "metadata")
        ):
            raise ValueError(f"invalid artifact semantic path: {relative}")
        camera_number = int(camera_match.group(1))
        seq_no = int(parts[2])
        if evidence.get("cameraNumber") != camera_number or evidence.get("seqNo") != seq_no:
            raise ValueError(f"artifact camera/SeqNo mismatch: {relative}")
        if inventory_document is not None:
            member = evidence.get("memberPath")
            inventory_entry = inventory_members.get(str(member))
            if not isinstance(inventory_entry, dict):
                raise ValueError(f"artifact lacks source inventory member: {relative}")
            if _artifact_relative_path(inventory_entry) != relative:
                raise ValueError(f"artifact path conflicts with source inventory member: {relative}")
            expected_archive_parts = inventory_entry.get("archiveParts")
            if not isinstance(expected_archive_parts, list):
                expected_archive_parts = [inventory_entry.get("archivePart")]
            expected_fields = {
                "kind": inventory_entry.get("kind"),
                "extension": inventory_entry.get("extension"),
                "cameraNumber": inventory_entry.get("cameraNumber"),
                "seqNo": inventory_entry.get("seqNo"),
                "archivePart": _select_archive_part(inventory_entry),
                "archiveParts": expected_archive_parts,
                "archiveMetadata": inventory_entry.get("archiveMetadata"),
                "volumeMetadata": inventory_entry.get("volumeMetadata"),
            }
            if any(evidence.get(key) != value for key, value in expected_fields.items()):
                raise ValueError(
                    f"artifact fields conflict with source inventory: {relative}"
                )
        camera = derived_camera_inventory[str(camera_number)]
        camera["artifactCount"] = int(camera["artifactCount"]) + 1
        camera_seq_nos = camera["seqNos"]
        assert isinstance(camera_seq_nos, list)
        if seq_no not in camera_seq_nos:
            camera_seq_nos.append(seq_no)
        counts_by_kind = camera["countsByKind"]
        matrix = camera["matrix"]
        assert isinstance(counts_by_kind, dict) and isinstance(matrix, dict)
        counts_by_kind[parts[3]] = int(counts_by_kind[parts[3]]) + 1
        matrix[str(seq_no)][parts[3]] += 1
    for camera in derived_camera_inventory.values():
        camera["seqNos"] = sorted(camera["seqNos"])
    camera_inventory = manifest.get("cameraInventory")
    if not isinstance(camera_inventory, dict) or set(camera_inventory) != {
        str(number) for number in range(1, 7)
    }:
        raise ValueError("cameraInventory must contain all six cameras")
    for number in range(1, 7):
        camera = camera_inventory[str(number)]
        if (
            not isinstance(camera, dict)
            or camera.get("cameraNumber") != number
            or isinstance(camera.get("artifactCount"), bool)
            or not isinstance(camera.get("artifactCount"), int)
            or not isinstance(camera.get("seqNos"), list)
            or not isinstance(camera.get("countsByKind"), dict)
        ):
            raise ValueError(f"invalid camera inventory: {number}")
    if camera_inventory != derived_camera_inventory:
        raise ValueError("cameraInventory does not match artifact disk evidence")
    derived_present_seq_nos = sorted(
        {
            int(evidence["seqNo"])
            for evidence in artifacts
            if isinstance(evidence, dict)
        }
    )
    if present_seq_nos != derived_present_seq_nos:
        raise ValueError("presentSeqNos does not match artifact disk evidence")
    missing_camera_seq = [
        {"cameraNumber": number, "seqNo": seq_no}
        for number in range(1, 7)
        for seq_no in TARGET_SEQ_NOS
        if sum(
            int(value)
            for value in derived_camera_inventory[str(number)]["matrix"][str(seq_no)].values()
        ) == 0
    ]
    derived_coverage = {
        "complete": (
            derived_present_seq_nos == list(TARGET_SEQ_NOS)
            and not missing_camera_seq
        ),
        "presentSeqNos": derived_present_seq_nos,
        "missingSeqNos": [
            seq_no for seq_no in TARGET_SEQ_NOS if seq_no not in derived_present_seq_nos
        ],
        "missingCameraSeq": missing_camera_seq,
    }
    if manifest.get("coverage") != derived_coverage:
        raise ValueError("coverage does not match artifact disk evidence")
    if manifest.get("targetCoverageComplete") != derived_coverage["complete"]:
        raise ValueError("targetCoverageComplete does not match disk evidence")

    inventory_entries = (
        inventory_document.get("entries") if isinstance(inventory_document, dict) else []
    )
    if not isinstance(inventory_entries, list):
        raise ValueError("source inventory entries must be an array")
    database_entries = [
        entry
        for entry in inventory_entries
        if isinstance(entry, dict) and entry.get("archivePart") == "database-zip"
    ]
    database_statuses = [str(entry.get("integrityStatus")) for entry in database_entries]
    database_members = [
        {
            key: entry.get(key)
            for key in (
                "memberPath", "size", "sha256", "integrityStatus",
                "integrityEvidence",
            )
        }
        for entry in database_entries
    ]
    source_database_complete = bool(database_statuses) and all(
        item == "ok" for item in database_statuses
    )
    result_evidence = (
        normalization_pointer.get("resultEvidence")
        if isinstance(normalization_pointer, dict)
        else None
    )
    result_counts = (
        result_evidence.get("counts") if isinstance(result_evidence, dict) else None
    )
    rejected_normalized = (
        sum(
            int(result_counts[table]["rejected"])
            + int(result_counts[table]["statementRejectedRowsUnknown"])
            for table in _SQL_TABLES
        )
        if isinstance(result_counts, dict)
        else 0
    )
    normalization_generation_verified = normalized_available == set(_SQL_TABLES)
    normalization_complete = (
        normalization_generation_verified
        and isinstance(result_evidence, dict)
        and result_evidence.get("integrity") == "ok"
        and result_evidence.get("diameterComplete") is True
        and result_evidence.get("parseRejectedStatements") == 0
        and rejected_normalized == 0
    )
    derived_database_integrity = {
        "statuses": database_statuses,
        "sourceMembers": database_members,
        "allInventoryMembersVerified": source_database_complete,
        "normalizedGenerationVerified": normalization_generation_verified,
        "crcFailed": "crc-failed" in database_statuses,
        "evidenceStatus": (
            "verified"
            if inventory_document is not None and normalization_pointer is not None
            else "failed"
        ),
        "normalizationIntegrity": (
            result_evidence.get("integrity")
            if isinstance(result_evidence, dict)
            else None
        ),
        "diameterComplete": (
            result_evidence.get("diameterComplete")
            if isinstance(result_evidence, dict)
            else None
        ),
        "parseRejectedStatements": (
            result_evidence.get("parseRejectedStatements")
            if isinstance(result_evidence, dict)
            else None
        ),
    }
    if manifest.get("databaseIntegrity") != derived_database_integrity:
        raise ValueError("databaseIntegrity does not match source and normalized evidence")
    counts = manifest.get("counts")
    if not isinstance(counts, dict):
        raise ValueError("staged manifest counts must be an object")
    for key in (
        "acceptedArtifacts", "rejectedEntries", "quarantineEntries",
        "acceptedNormalizedRows", "rejectedNormalizedRows",
    ):
        value = counts.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ValueError(f"invalid staged count: {key}")
    statistics = (
        inventory_document.get("statistics")
        if isinstance(inventory_document, dict)
        else None
    )
    rejected_inventory = 0
    if isinstance(statistics, dict):
        for statistic in statistics.values():
            if isinstance(statistic, dict):
                rejected_inventory += int(statistic.get("rejected", 0))
    expected_counts_without_quarantine = {
        "acceptedArtifacts": len(artifacts),
        "rejectedEntries": rejected_inventory,
        "acceptedNormalizedRows": sum(normalized_counts.values()),
        "rejectedNormalizedRows": rejected_normalized,
        "normalizedRowsByTable": normalized_counts,
    }
    for key, value in expected_counts_without_quarantine.items():
        if counts.get(key) != value:
            raise ValueError(f"staged count does not match disk evidence: {key}")
    quarantine_evidence = manifest.get("quarantine")
    quarantine_path = _verify_manifest_file_evidence(
        batch,
        quarantine_evidence,
        "quarantine evidence",
        max_bytes=MAX_MANIFEST_BYTES,
    )
    if quarantine_path != batch / "quarantine.jsonl":
        raise ValueError("quarantine evidence path is invalid")
    quarantine_lines = quarantine_path.read_text(encoding="utf-8").splitlines()
    for line in quarantine_lines:
        if line:
            json.loads(line)
    if counts["quarantineEntries"] != len(quarantine_lines):
        raise ValueError("quarantineEntries does not match disk evidence")
    if status == "failed" and not quarantine_lines:
        raise ValueError("failed stage must contain quarantine evidence")
    derived_ready = (
        source_database_complete
        and normalization_complete
        and bool(derived_coverage["complete"])
    )
    if status != "failed":
        expected_status = "ready" if derived_ready else "partial"
        if status != expected_status:
            raise ValueError(f"{status} status conflicts with derived {expected_status} evidence")
        if manifest.get("importEligible") != derived_ready:
            raise ValueError("importEligible conflicts with derived evidence")
        if deep_source:
            if not isinstance(source_inventory, dict) or inventory_document is None:
                raise ValueError("original inventory evidence is unavailable")
            _deep_verify_original_sources(
                manifest, inventory_document, source_inventory
            )
    return manifest


def _verify_current_inputs(
    *, inventory_path: Path, normalized_output: Path, existing: dict[str, object]
) -> None:
    source_inventory = existing.get("sourceInventory")
    _verify_named_file(
        inventory_path,
        source_inventory,
        "source inventory input",
        max_bytes=MAX_MANIFEST_BYTES,
    )
    generation = resolve_sql_output(normalized_output)
    normalized = existing.get("normalized")
    if not isinstance(normalized, list):
        raise ValueError("existing batch lacks normalized evidence")
    expected = {str(item.get("table")): item for item in normalized if isinstance(item, dict)}
    if set(expected) != set(_SQL_TABLES):
        raise ValueError("existing batch normalized evidence mismatch")
    for table in _SQL_TABLES:
        evidence = expected[table]
        _verify_named_file(generation / f"{table}.jsonl", evidence, "normalized input")


def _stage_batch_into(
    *,
    inventory_manifest: os.PathLike[str] | str,
    normalized_output: os.PathLike[str] | str,
    output_root: os.PathLike[str] | str,
    batch_id: str,
    unrar: os.PathLike[str] | str | None = None,
    runner: Callable[..., subprocess.CompletedProcess[bytes]] | None = None,
    incoming: Path,
    quarantine_writer: _QuarantineWriter,
    failure_context: dict[str, object],
) -> Path:
    failure_context["stage"] = "inventory"
    failure_context["inventoryPath"] = str(
        Path(inventory_manifest).expanduser().resolve(strict=False)
    )
    inventory_path = _resolve_input(inventory_manifest, "inventory manifest")
    inventory = _load_json_document(inventory_path, "inventory manifest")
    failure_context["inventory"] = inventory
    if inventory.get("schema") != MANIFEST_SCHEMA:
        raise ValueError("invalid inventory manifest schema")
    if inventory.get("batchId") != batch_id:
        raise ValueError("inventory batchId does not match requested batch-id")
    archives = inventory.get("archives")
    if not isinstance(archives, dict) or set(archives) != {
        "database-zip", "image-part1", "image-part2"
    }:
        raise ValueError("inventory must name exactly three source archives")
    archive_paths: dict[str, Path] = {}
    failure_context["stage"] = "source-archives"
    for archive_part, evidence in archives.items():
        if not isinstance(evidence, dict) or not isinstance(evidence.get("path"), str):
            raise ValueError(f"invalid archive evidence: {archive_part}")
        archive_paths[archive_part] = _resolve_input(
            str(evidence["path"]), f"source archive {archive_part}"
        )
        _verify_named_file(
            archive_paths[archive_part],
            evidence,
            f"source archive {archive_part}",
            max_bytes=MAX_INPUT_ARCHIVE_BYTES,
        )
    failure_context["stage"] = "normalized-pointer"
    normalized_root = Path(normalized_output).resolve(strict=True)
    generation = resolve_sql_output(normalized_root)
    pointer_document = _validate_sql_current_pointer(
        _load_json_document(
            normalized_root / "normalized.current.json", "SQL current pointer"
        )
    )
    failure_context["normalizationPointer"] = pointer_document
    failure_context["stage"] = "unrar"
    unrar_path = locate_unrar(unrar)
    failure_context["stage"] = "output-overlap"
    final = _validate_output_path(
        Path(output_root),
        batch_id,
        [*archive_paths.values(), inventory_path, normalized_root],
    )
    output = final.parent
    output.mkdir(parents=True, exist_ok=True)
    for existing_path in _existing_chain(output):
        if is_reparse_point(existing_path):
            raise ValueError(f"output path contains a reparse point: {existing_path}")
    if final.exists() or is_reparse_point(final):
        if is_reparse_point(final) or not final.is_dir():
            raise ValueError("batch-id collision with a non-directory or reparse point")
        existing = _verify_staged_batch(final)
        if existing.get("batchId") != batch_id:
            raise ValueError("existing batch-id collision")
        _verify_current_inputs(
            inventory_path=inventory_path,
            normalized_output=normalized_root,
            existing=existing,
        )
        return final

    try:
        failure_context["stage"] = "source-inventory"
        (incoming / "source").mkdir()
        source_inventory_evidence = _copy_verified_file(
            inventory_path, incoming / "source" / "inventory.json", MAX_MANIFEST_BYTES
        )
        source_inventory_evidence.update(
            {
                "path": "source/inventory.json",
                "originalPath": str(inventory_path),
                "originalSha256": source_inventory_evidence["sha256"],
                "evidenceStatus": "verified",
                "error": None,
            }
        )
        normalization_pointer_evidence = _copy_verified_file(
            normalized_root / "normalized.current.json",
            incoming / "source" / "normalized.current.json",
            MAX_MANIFEST_BYTES,
        )
        normalization_pointer_evidence.update(
            {
                "path": "source/normalized.current.json",
                "evidenceStatus": "verified",
                "error": None,
            }
        )

        failure_context["stage"] = "normalized-copy"
        normalized_evidence: list[dict[str, object]] = []
        for table in _SQL_TABLES:
            source = generation / f"{table}.jsonl"
            relative = f"normalized/{table}.jsonl"
            evidence = _copy_verified_file(
                source, _stage_path(incoming, relative), MAX_STAGE_ARTIFACT_BYTES
            )
            normalized_evidence.append(
                {
                    "table": table,
                    "count": pointer_document["files"][table]["count"],
                    "path": relative,
                    "evidenceStatus": "verified",
                    "error": None,
                    **evidence,
                }
            )
        # Re-resolve the pointer and re-hash its generation after every copy.
        if resolve_sql_output(normalized_root) != generation:
            raise RuntimeError("SQL normalized generation changed during staging")

        failure_context["stage"] = "coverage"
        entries = inventory.get("entries")
        if not isinstance(entries, list):
            raise ValueError("inventory entries must be an array")
        artifact_entries = [
            entry
            for entry in entries
            if isinstance(entry, dict) and entry.get("cameraNumber") is not None
        ]
        planned: list[tuple[dict[str, object], str]] = []
        destinations: dict[str, str] = {}
        for entry in artifact_entries:
            relative = _artifact_relative_path(entry)
            key = unicodedata.normalize("NFC", relative).casefold()
            previous = destinations.get(key)
            if previous is not None:
                raise ValueError(
                    f"Windows case-insensitive staged collision: {previous!r} and {relative!r}"
                )
            destinations[key] = relative
            planned.append((entry, relative))
        declared_total = 0
        for entry, _ in planned:
            size = entry.get("size")
            if isinstance(size, bool) or not isinstance(size, int) or size < 0:
                raise ValueError("inventory image entry lacks a valid declared size")
            declared_total += size
            if declared_total > MAX_STAGE_TOTAL_BYTES:
                raise InventoryLimitError(
                    "declared artifact total exceeds "
                    f"MAX_STAGE_TOTAL_BYTES={MAX_STAGE_TOTAL_BYTES}"
                )

        artifact_evidence: list[dict[str, object]] = []
        failure_context["artifacts"] = artifact_evidence
        camera_inventory = _empty_camera_inventory()
        failure_context["stage"] = "extraction"
        with _stable_archive_inputs(tuple(archive_paths.values())) as working:
            for archive_part, evidence in archives.items():
                assert isinstance(evidence, dict)
                _verify_named_file(
                    working[archive_paths[archive_part]],
                    evidence,
                    f"locked source archive {archive_part}",
                    max_bytes=MAX_INPUT_ARCHIVE_BYTES,
                )
            for entry, relative in planned:
                archive_part = _select_archive_part(entry)
                member = str(entry["memberPath"])
                expected_size = entry.get("size")
                if isinstance(expected_size, bool) or not isinstance(expected_size, int):
                    raise ValueError(f"inventory member lacks valid size: {member}")
                evidence = _extract_unrar_member(
                    unrar=unrar_path,
                    archive=working[archive_paths[archive_part]],
                    member=member,
                    destination=_stage_path(incoming, relative),
                    expected_size=expected_size,
                    runner=runner,
                )
                metadata = _image_metadata(member)
                assert metadata is not None
                artifact = {
                    "path": relative,
                    "memberPath": member,
                    "archivePart": archive_part,
                    "archiveParts": entry.get("archiveParts", [entry.get("archivePart")]),
                    "archiveMetadata": entry.get("archiveMetadata"),
                    "volumeMetadata": entry.get("volumeMetadata"),
                    **metadata,
                    "evidenceStatus": "verified",
                    "error": None,
                    **evidence,
                }
                artifact_evidence.append(artifact)
                camera = camera_inventory[str(metadata["cameraNumber"])]
                camera["artifactCount"] = int(camera["artifactCount"]) + 1
                seq_nos = camera["seqNos"]
                assert isinstance(seq_nos, list)
                if metadata["seqNo"] not in seq_nos:
                    seq_nos.append(metadata["seqNo"])
                destination_kind = PurePosixPath(relative).parts[-2]
                counts_by_kind = camera["countsByKind"]
                assert isinstance(counts_by_kind, dict)
                counts_by_kind[destination_kind] = int(counts_by_kind[destination_kind]) + 1
                matrix = camera["matrix"]
                assert isinstance(matrix, dict)
                matrix[str(metadata["seqNo"])][destination_kind] += 1
            for archive_part, evidence in archives.items():
                assert isinstance(evidence, dict)
                _verify_named_file(
                    working[archive_paths[archive_part]],
                    evidence,
                    f"locked source archive {archive_part}",
                    max_bytes=MAX_INPUT_ARCHIVE_BYTES,
                )

        for camera in camera_inventory.values():
            camera["seqNos"] = sorted(camera["seqNos"])
        database_entries = [
            entry
            for entry in entries
            if isinstance(entry, dict) and entry.get("archivePart") == "database-zip"
        ]
        database_statuses = [str(entry.get("integrityStatus")) for entry in database_entries]
        database_verified = bool(database_entries) and all(
            status == "ok" for status in database_statuses
        )
        result_evidence = pointer_document["resultEvidence"]
        assert isinstance(result_evidence, dict)
        result_counts = result_evidence["counts"]
        assert isinstance(result_counts, dict)
        normalized_accepted = sum(
            int(result_counts[table]["accepted"]) for table in _SQL_TABLES
        )
        normalized_rejected = sum(
            int(result_counts[table]["rejected"])
            + int(result_counts[table]["statementRejectedRowsUnknown"])
            for table in _SQL_TABLES
        )
        normalization_complete = (
            result_evidence["integrity"] == "ok"
            and result_evidence["diameterComplete"] is True
            and result_evidence["parseRejectedStatements"] == 0
            and normalized_rejected == 0
        )
        statistics = inventory.get("statistics")
        if not isinstance(statistics, dict):
            raise ValueError("inventory statistics must be an object")
        rejected = 0
        for value in statistics.values():
            if not isinstance(value, dict):
                raise ValueError("inventory statistics entry must be an object")
            count = value.get("rejected")
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise ValueError("inventory rejected count must be non-negative")
            rejected += count
        seq_nos = sorted({int(item["seqNo"]) for item in artifact_evidence})
        if any(seq_no not in TARGET_SEQ_NOS for seq_no in seq_nos):
            raise ValueError("staged artifact contains an unapproved SeqNo")
        missing_camera_seq = [
            {"cameraNumber": number, "seqNo": seq_no}
            for number in range(1, 7)
            for seq_no in TARGET_SEQ_NOS
            if sum(
                int(value)
                for value in camera_inventory[str(number)]["matrix"][str(seq_no)].values()
            ) == 0
        ]
        target_coverage_complete = (
            seq_nos == list(TARGET_SEQ_NOS) and not missing_camera_seq
        )
        quarantine_writer.sync()
        quarantine_path = incoming / "quarantine.jsonl"
        quarantine_evidence = _failed_file_evidence(
            quarantine_path, "quarantine.jsonl", max_bytes=MAX_MANIFEST_BYTES
        )
        manifest_archives = {
            archive_part: {
                "path": str(archive_paths[archive_part]),
                "size": evidence.get("size"),
                "sha256": evidence.get("sha256"),
                "fileIdentity": evidence.get("fileIdentity"),
                "mtimeNs": evidence.get("mtimeNs"),
                "integrity": "verified",
                "evidenceStatus": "verified",
                "error": None,
            }
            for archive_part, evidence in archives.items()
            if isinstance(evidence, dict)
        }
        manifest = {
            "schema": "steel.bkv-import-manifest.v1",
            "batchId": batch_id,
            "status": (
                "ready"
                if database_verified and target_coverage_complete and normalization_complete
                else "partial"
            ),
            "importEligible": (
                database_verified and target_coverage_complete and normalization_complete
            ),
            "seqNos": list(TARGET_SEQ_NOS),
            "presentSeqNos": seq_nos,
            "targetCoverageComplete": target_coverage_complete,
            "coverage": {
                "complete": target_coverage_complete,
                "presentSeqNos": seq_nos,
                "missingSeqNos": [
                    seq_no for seq_no in TARGET_SEQ_NOS if seq_no not in seq_nos
                ],
                "missingCameraSeq": missing_camera_seq,
            },
            "sourceInventory": source_inventory_evidence,
            "normalizationEvidence": normalization_pointer_evidence,
            "sourceArchives": manifest_archives,
            "databaseIntegrity": {
                "statuses": database_statuses,
                "sourceMembers": [
                    {
                        key: entry.get(key)
                        for key in (
                            "memberPath", "size", "sha256", "integrityStatus",
                            "integrityEvidence",
                        )
                    }
                    for entry in database_entries
                ],
                "allInventoryMembersVerified": database_verified,
                "normalizedGenerationVerified": True,
                "crcFailed": "crc-failed" in database_statuses,
                "evidenceStatus": "verified",
                "normalizationIntegrity": result_evidence["integrity"],
                "diameterComplete": result_evidence["diameterComplete"],
                "parseRejectedStatements": result_evidence[
                    "parseRejectedStatements"
                ],
            },
            "counts": {
                "acceptedArtifacts": len(artifact_evidence),
                "rejectedEntries": rejected,
                "quarantineEntries": quarantine_writer.count,
                "acceptedNormalizedRows": normalized_accepted,
                "rejectedNormalizedRows": normalized_rejected,
                "normalizedRowsByTable": {
                    table: int(result_counts[table]["accepted"])
                    for table in _SQL_TABLES
                },
            },
            "cameraInventory": camera_inventory,
            "normalized": normalized_evidence,
            "artifacts": artifact_evidence,
            "failure": None,
            "quarantine": quarantine_evidence,
        }
        failure_context["stage"] = "validation"
        _write_json_atomic(incoming / "manifest.json", manifest)
        _verify_staged_batch(incoming)
        if final.exists() or is_reparse_point(final):
            raise FileExistsError(f"batch-id collision during publish: {final}")
        quarantine_writer.close()
        os.rename(incoming, final)
        _fsync_directory(output)
        _verify_staged_batch(final)
        return final
    except BaseException as error:
        raise


def stage_batch(
    *,
    inventory_manifest: os.PathLike[str] | str,
    normalized_output: os.PathLike[str] | str,
    output_root: os.PathLike[str] | str,
    batch_id: str,
    unrar: os.PathLike[str] | str | None = None,
    runner: Callable[..., subprocess.CompletedProcess[bytes]] | None = None,
) -> Path:
    # Only the path syntax boundary is evaluated before the evidence channel
    # exists. All untrusted manifests, sources, pointers, and executables are
    # handled inside the unified failure publication scope below.
    final = _validate_output_path(Path(output_root), batch_id, ())
    output = final.parent
    output.mkdir(parents=True, exist_ok=True)
    for existing_path in _existing_chain(output):
        if is_reparse_point(existing_path):
            raise ValueError(f"output path contains a reparse point: {existing_path}")
    incoming = Path(
        tempfile.mkdtemp(prefix=f"{batch_id}.incoming-", dir=output)
    ).resolve(strict=True)
    quarantine_writer = _QuarantineWriter(incoming / "quarantine.jsonl")
    context: dict[str, object] = {
        "stage": "initialization",
        "code": "stage_failed",
        "inventory": None,
    }
    try:
        result = _stage_batch_into(
            inventory_manifest=inventory_manifest,
            normalized_output=normalized_output,
            output_root=output_root,
            batch_id=batch_id,
            unrar=unrar,
            runner=runner,
            incoming=incoming,
            quarantine_writer=quarantine_writer,
            failure_context=context,
        )
        if incoming.exists():
            quarantine_writer.close()
            resolved_incoming = incoming.resolve(strict=True)
            if resolved_incoming.parent != output or not resolved_incoming.name.startswith(
                f"{batch_id}.incoming-"
            ):
                raise ValueError("refusing to clean an untrusted incoming directory")
            shutil.rmtree(resolved_incoming)
            _fsync_directory(output)
        return result
    except BaseException as error:
        if isinstance(error, StageFailedError):
            raise
        failed = _publish_failed_stage(
            incoming,
            output,
            batch_id,
            error,
            quarantine_writer,
            context,
        )
        raise StageFailedError("BKV stage failed", failed) from error
    finally:
        quarantine_writer.close()


def batch_is_importable(
    batch: os.PathLike[str] | str, *, operator_reviewed_partial: bool = False
) -> bool:
    try:
        manifest = _verify_staged_batch(
            Path(batch), allow_failed=True, deep_source=True
        )
    except SourceUnavailableError:
        return False
    status = manifest["status"]
    return status == "ready" or (
        status == "partial" and operator_reviewed_partial is True
    )


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
    stage = subparsers.add_parser("stage", help="stage an immutable legacy batch")
    stage.add_argument("--inventory-manifest", required=True, type=Path)
    stage.add_argument("--normalized-output", required=True, type=Path)
    stage.add_argument("--output-root", required=True, type=Path)
    stage.add_argument("--batch-id", required=True)
    stage.add_argument("--unrar", type=Path, help="absolute path to UnRAR.exe")
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
    if args.command == "stage":
        destination = stage_batch(
            inventory_manifest=args.inventory_manifest,
            normalized_output=args.normalized_output,
            output_root=args.output_root,
            batch_id=args.batch_id,
            unrar=args.unrar,
        )
        print(destination)
        return 0
    raise AssertionError(f"unhandled command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
