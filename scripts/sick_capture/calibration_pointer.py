"""Versioned active array-calibration pointer with fail-closed fallback."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .measurement import CALIBRATION_SCHEMA
from .storage import replace_file


POINTER_SCHEMA = "steel.sick-array-calibration-pointer.v1"


def calibration_pointer_path(storage_root: Path) -> Path:
    return Path(storage_root) / "system" / "calibration" / "active.json"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_array_calibration(path: Path, expected_sha256: str = "") -> dict[str, Any]:
    resolved = path.resolve()
    payload = json.loads(resolved.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict) or payload.get("schema") != CALIBRATION_SCHEMA:
        raise ValueError(f"array calibration schema must be {CALIBRATION_SCHEMA}")
    if payload.get("approved") is not True:
        raise ValueError("array calibration is not approved")
    cameras = payload.get("cameras")
    if not isinstance(cameras, dict) or len(cameras) != 6:
        raise ValueError("array calibration must contain six cameras")
    actual_sha256 = _sha256(resolved)
    if expected_sha256 and actual_sha256.lower() != expected_sha256.strip().lower():
        raise ValueError("active array calibration SHA-256 mismatch")
    return {
        "path": resolved,
        "sha256": actual_sha256,
        "revision": str(payload.get("revision", "")),
        "payload": payload,
    }


def resolve_active_array_calibration(
    storage_root: Path,
    configured_path: Path | None,
) -> dict[str, Any]:
    """Resolve the pointer, falling back to the configured approved R1 file."""
    pointer = calibration_pointer_path(storage_root)
    pointer_error = ""
    if pointer.is_file():
        try:
            value = json.loads(pointer.read_text(encoding="utf-8-sig"))
            if not isinstance(value, dict) or value.get("schema") != POINTER_SCHEMA:
                raise ValueError(f"calibration pointer schema must be {POINTER_SCHEMA}")
            active = value.get("active")
            if not isinstance(active, dict):
                raise ValueError("calibration pointer has no active entry")
            validated = validate_array_calibration(
                Path(str(active.get("path", ""))),
                str(active.get("sha256", "")),
            )
            return {
                **validated,
                "source": "active-pointer",
                "pointerPath": pointer,
                "pointer": value,
                "pointerError": "",
            }
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
            pointer_error = str(error)
    if configured_path is None:
        raise ValueError(pointer_error or "configured array calibration is unavailable")
    validated = validate_array_calibration(configured_path)
    return {
        **validated,
        "source": "configured-fallback",
        "pointerPath": pointer,
        "pointer": None,
        "pointerError": pointer_error,
    }


def write_calibration_pointer(
    storage_root: Path,
    candidate_path: Path,
    *,
    previous_path: Path | None = None,
    gate_report_path: Path | None = None,
) -> Path:
    candidate = validate_array_calibration(candidate_path)
    previous = validate_array_calibration(previous_path) if previous_path else None
    payload: dict[str, Any] = {
        "schema": POINTER_SCHEMA,
        "active": {
            "path": str(candidate["path"]),
            "sha256": candidate["sha256"],
            "revision": candidate["revision"],
        },
        "previous": (
            {
                "path": str(previous["path"]),
                "sha256": previous["sha256"],
                "revision": previous["revision"],
            }
            if previous
            else None
        ),
        "gateReportPath": str(gate_report_path.resolve()) if gate_report_path else "",
    }
    destination = calibration_pointer_path(storage_root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".active.", suffix=".tmp", dir=destination.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        replace_file(temporary, destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return destination

