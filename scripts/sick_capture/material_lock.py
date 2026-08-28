"""Cross-process ownership for one flow's derived artifacts.

The capture provider, realtime analyzer and history tools can all observe the
same flow.  A small exclusive lock prevents two processes from replacing the
flow-scoped alignment/measurement/surface files at the same time.  Lock files
contain an owner token and are removed only by that owner; a lock whose process
no longer exists is recovered automatically.
"""

from __future__ import annotations

import json
import os
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator


UNKNOWN_OWNER_STALE_SECONDS = 300.0


class MaterialJobLockedError(RuntimeError):
    """Raised when another live process owns a material's derived artifacts."""


def _process_is_running(process_id: int) -> bool:
    """Check a lock owner without sending a signal on Windows."""
    if process_id <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(process_id, 0)
            return True
        except PermissionError:
            return True
        except ProcessLookupError:
            return False
        except OSError:
            return False
    try:
        import ctypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.GetExitCodeProcess.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_uint32),
        ]
        kernel32.GetExitCodeProcess.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel32.OpenProcess(
            process_query_limited_information, False, process_id
        )
        if not handle:
            # Access denied still means that the PID exists.
            return ctypes.get_last_error() == 5
        try:
            exit_code = ctypes.c_uint32()
            return bool(
                kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
            ) and exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    except (AttributeError, OSError, ValueError):
        return False


def material_job_lock_path(storage_root: Path, material_id: str) -> Path:
    return (
        storage_root
        / "system"
        / "locks"
        / "flow-derived-artifacts"
        / f"{material_id}.lock"
    )


@dataclass(frozen=True)
class MaterialJobOwner:
    path: Path
    token: str
    process_id: int
    started_at_unix_ms: int


def _read_owner(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


@contextmanager
def exclusive_material_job(
    storage_root: Path,
    material_id: str,
    *,
    purpose: str,
) -> Iterator[MaterialJobOwner]:
    """Acquire a non-blocking, stale-recovering lock for one material."""

    normalized = str(material_id).strip()
    if not normalized or not normalized.isdigit():
        raise ValueError("material_id must be numeric")
    path = material_job_lock_path(storage_root, normalized)
    path.parent.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    process_id = os.getpid()
    started_at_unix_ms = int(time.time() * 1000)
    payload = {
        "schema": "steel.flow-derived-artifact-lock.v1",
        "materialId": normalized,
        "processId": process_id,
        "token": token,
        "purpose": purpose,
        "startedAtUnixMs": started_at_unix_ms,
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )

    for attempt in range(2):
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            current = _read_owner(path)
            try:
                current_pid = int(current.get("processId", 0) or 0)
            except (TypeError, ValueError):
                current_pid = 0
            try:
                lock_age_seconds = max(0.0, time.time() - path.stat().st_mtime)
            except OSError:
                lock_age_seconds = 0.0
            recoverable = bool(
                current_pid
                and not _process_is_running(current_pid)
                or not current_pid
                and lock_age_seconds >= UNKNOWN_OWNER_STALE_SECONDS
            )
            if attempt == 0 and recoverable:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
                except OSError as error:
                    raise MaterialJobLockedError(
                        f"material {normalized} stale lock could not be recovered: {error}"
                    ) from error
                continue
            if not current_pid:
                raise MaterialJobLockedError(
                    f"material {normalized} derived artifact lock has no readable "
                    "owner and is too recent to recover"
                )
            raise MaterialJobLockedError(
                f"material {normalized} derived artifacts are owned by process "
                f"{current_pid or 'unknown'}"
            )
        else:
            try:
                os.write(descriptor, encoded)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            break
    else:  # pragma: no cover - loop either acquires or raises
        raise MaterialJobLockedError(f"material {normalized} lock unavailable")

    owner = MaterialJobOwner(path, token, process_id, started_at_unix_ms)
    try:
        yield owner
    finally:
        current = _read_owner(path)
        if current.get("token") == token and int(current.get("processId", 0) or 0) == process_id:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
