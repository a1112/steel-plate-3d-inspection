#!/usr/bin/env python3
"""Bounded evidence probe for legacy BKV ``.d3img`` files.

There is intentionally no binary decoder in this module yet.  The supplied
Capture 6.7 SDK reader does not accept the observed legacy container and no
published layout proves its field or payload boundaries.  Keeping probing and
decoding separate prevents observations from silently becoming a format
contract.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import stat
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping, Sequence

PROBE_SCHEMA = "steel.bkv-d3img-probe.v1"
CONTRACT_SCHEMA = "steel.bkv-d3img-evidence-contract.v1"
OBSERVED_MAGIC = b"3DImg\0"
MAX_HEADER_PROBE_BYTES = 256
MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_DIMENSION = 16_384
MAX_PIXELS = 64 * 1024 * 1024
MAX_PAYLOAD_BYTES = 512 * 1024 * 1024


class D3ImageError(ValueError):
    """Base class for stable legacy depth-format failures."""


class UnsupportedFormatError(D3ImageError):
    """Raised when no evidence-approved decoder exists."""


class InvalidContractError(D3ImageError):
    """Raised when an evidence contract is internally unsafe or unsupported."""


class OutputCollisionError(D3ImageError):
    """Raised before an output alias can replace the probed source."""


@dataclass(frozen=True)
class D3ImageProbe:
    schema: str
    status: str
    reason: str
    size: int
    sha256: str
    magicHex: str
    headerPrefixHex: str
    parserVersion: str = "bkv-d3img-probe/1"
    decoderAvailable: bool = False

    def to_document(self) -> dict[str, object]:
        return asdict(self)


UNSUPPORTED_EVIDENCE_CONTRACT: Mapping[str, object] = {
    "schema": CONTRACT_SCHEMA,
    "contractId": "unapproved-observation-only",
    "magicHex": OBSERVED_MAGIC.hex(),
    "version": None,
    "width": 1024,
    "height": 682,
    "headerBytes": 84,
    "sampleBytes": 4,
    "dataType": "float32",
    "byteOrder": "little",
    "statistics": {"minimum": -1_000_000.0, "maximum": 0.0},
}


def unsupported_contract_template() -> dict[str, object]:
    """Return a mutable validation fixture; it is not an approved decoder."""

    result = dict(UNSUPPORTED_EVIDENCE_CONTRACT)
    result["statistics"] = dict(UNSUPPORTED_EVIDENCE_CONTRACT["statistics"])
    return result


def _hash_and_prefix(path: Path) -> tuple[int, str, bytes]:
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or path.is_symlink():
        raise OSError(f"input is not a regular file: {path}")
    declared_size = before.st_size
    if declared_size > MAX_FILE_BYTES:
        raise D3ImageError("file_too_large")
    digest = hashlib.sha256()
    prefix = bytearray()
    total = 0
    with path.open("rb") as reader:
        opened = os.fstat(reader.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise D3ImageError("file_changed_during_probe")
        while True:
            chunk = reader.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_FILE_BYTES:
                raise D3ImageError("file_too_large")
            digest.update(chunk)
            if len(prefix) < MAX_HEADER_PROBE_BYTES:
                prefix.extend(chunk[: MAX_HEADER_PROBE_BYTES - len(prefix)])
        after_open = os.fstat(reader.fileno())
    after_path = path.lstat()
    if (
        total != declared_size
        or (after_open.st_size, after_open.st_mtime_ns)
        != (opened.st_size, opened.st_mtime_ns)
        or (after_path.st_dev, after_path.st_ino, after_path.st_size, after_path.st_mtime_ns)
        != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    ):
        raise D3ImageError("file_changed_during_probe")
    return total, digest.hexdigest(), bytes(prefix)


def probe_d3img(path: os.PathLike[str] | str) -> D3ImageProbe:
    source = Path(path)
    try:
        size, digest, prefix = _hash_and_prefix(source)
    except D3ImageError as error:
        return D3ImageProbe(
            schema=PROBE_SCHEMA,
            status="invalid",
            reason=str(error),
            size=0,
            sha256="",
            magicHex="",
            headerPrefixHex="",
        )
    magic = prefix[: len(OBSERVED_MAGIC)]
    common = {
        "schema": PROBE_SCHEMA,
        "size": size,
        "sha256": digest,
        "magicHex": magic.hex(),
        "headerPrefixHex": prefix.hex(),
    }
    if size < len(OBSERVED_MAGIC):
        return D3ImageProbe(status="invalid", reason="truncated_header", **common)
    if magic != OBSERVED_MAGIC:
        return D3ImageProbe(status="unsupported", reason="unsupported_magic", **common)
    return D3ImageProbe(
        status="unsupported", reason="no_evidenced_decoder", **common
    )


def validate_evidence_contract(contract: Mapping[str, object]) -> None:
    """Validate bounded contract mechanics without approving a decoder."""

    if contract.get("schema") != CONTRACT_SCHEMA:
        raise InvalidContractError("unsupported_contract_schema")
    if contract.get("magicHex") != OBSERVED_MAGIC.hex():
        raise InvalidContractError("unsupported_magic")
    if contract.get("version") is not None:
        raise InvalidContractError("unsupported_version")
    width = contract.get("width")
    height = contract.get("height")
    if (
        isinstance(width, bool)
        or not isinstance(width, int)
        or isinstance(height, bool)
        or not isinstance(height, int)
        or width < 1
        or height < 1
        or width > MAX_DIMENSION
        or height > MAX_DIMENSION
    ):
        raise InvalidContractError("dimension_out_of_range")
    pixels = width * height
    if pixels > MAX_PIXELS:
        raise InvalidContractError("pixel_count_out_of_range")
    sample_bytes = contract.get("sampleBytes")
    header_bytes = contract.get("headerBytes")
    if sample_bytes not in (2, 4) or (
        isinstance(header_bytes, bool)
        or not isinstance(header_bytes, int)
        or header_bytes < len(OBSERVED_MAGIC)
        or header_bytes > MAX_HEADER_PROBE_BYTES * 1024
    ):
        raise InvalidContractError("payload_layout_out_of_range")
    payload_bytes = pixels * int(sample_bytes)
    if payload_bytes > MAX_PAYLOAD_BYTES:
        raise InvalidContractError("payload_size_out_of_range")
    statistics = contract.get("statistics")
    if not isinstance(statistics, Mapping):
        raise InvalidContractError("invalid_statistics")
    for key in ("minimum", "maximum"):
        value = statistics.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise InvalidContractError("invalid_statistics")
        if not math.isfinite(float(value)):
            raise InvalidContractError("non_finite_statistics")


def decode_d3img(
    path: os.PathLike[str] | str, evidence_contract: Mapping[str, object]
) -> object:
    """Decode only through an approved evidence contract (none exists yet)."""

    validate_evidence_contract(evidence_contract)
    probe = probe_d3img(path)
    if probe.status == "invalid":
        raise D3ImageError(probe.reason)
    raise UnsupportedFormatError(
        "no evidenced decoder is approved for the observed legacy .d3img container"
    )


def _reject_output_alias(input_path: Path, output_path: Path) -> None:
    source = input_path.resolve(strict=True)
    destination = output_path.resolve(strict=False)
    if source == destination:
        raise OutputCollisionError("output_aliases_input")
    try:
        same_file = output_path.exists() and os.path.samefile(source, output_path)
    except OSError as error:
        raise OutputCollisionError("output_identity_unverifiable") from error
    if same_file:
        raise OutputCollisionError("output_aliases_input")


def _write_json_atomic(
    path: Path,
    document: Mapping[str, object],
    *,
    protected_input: Path | None = None,
) -> None:
    if protected_input is not None:
        _reject_output_alias(protected_input, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(document, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode(
        "utf-8"
    )
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as writer:
            writer.write(payload)
            writer.flush()
            os.fsync(writer.fileno())
        if protected_input is not None:
            _reject_output_alias(protected_input, path)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    probe = subcommands.add_parser("probe", help="write bounded legacy format evidence")
    probe.add_argument("--input", required=True, type=Path)
    probe.add_argument("--json", required=True, type=Path)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _build_parser().parse_args(argv)
    if arguments.command != "probe":
        return 2
    try:
        _reject_output_alias(arguments.input, arguments.json)
        result = probe_d3img(arguments.input)
    except OutputCollisionError as error:
        print(str(error), file=sys.stderr)
        return 2
    except OSError as error:
        result = D3ImageProbe(
            schema=PROBE_SCHEMA,
            status="invalid",
            reason="input_unreadable",
            size=0,
            sha256="",
            magicHex="",
            headerPrefixHex="",
        )
        document = result.to_document()
        document["diagnostic"] = str(error)[:1024]
    else:
        document = result.to_document()
    try:
        _write_json_atomic(
            arguments.json, document, protected_input=arguments.input
        )
    except OutputCollisionError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(document, ensure_ascii=False, sort_keys=True))
    return 0 if result.status == "decoded" else 2


if __name__ == "__main__":
    raise SystemExit(main())
