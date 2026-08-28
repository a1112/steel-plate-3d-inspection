"""Resolve the immutable seed and mutable runtime depth-geometry configuration."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


DEPTH_GEOMETRY_CONFIG_SCHEMA = "steel.sick-depth-geometry-config.v1"


class DepthGeometryConfigChanged(RuntimeError):
    """Raised at a bounded checkpoint so a flow restarts with one revision."""


@dataclass(frozen=True)
class DepthGeometryConfigSnapshot:
    value: dict[str, Any]
    sha256: str
    revision: int
    source_path: Path


def canonical_config_bytes(value: dict[str, Any]) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def config_sha256(value: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_config_bytes(value)).hexdigest()


def mutable_depth_geometry_config_path() -> Path | None:
    explicit = os.environ.get("STEEL_DEPTH_GEOMETRY_CONFIG", "").strip()
    if explicit:
        return Path(os.path.expandvars(explicit)).resolve()
    state_root = os.environ.get("STEEL_RUNTIME_STATE_ROOT", "").strip()
    if not state_root:
        return None
    return (
        Path(os.path.expandvars(state_root)).resolve()
        / "config"
        / "algorithm"
        / "depth-geometry.json"
    )


def seed_depth_geometry_config_path(profile_path: Path) -> Path:
    return Path(profile_path).resolve().parent / "algorithm.json"


def _read_config(path: Path, *, nested_seed: bool) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"depth geometry config must be an object: {path}")
    if nested_seed:
        value = value.get("depthGeometry")
        if not isinstance(value, dict):
            raise ValueError(f"depthGeometry seed is missing: {path}")
    if value.get("schema") != DEPTH_GEOMETRY_CONFIG_SCHEMA:
        raise ValueError(
            f"depth geometry schema must be {DEPTH_GEOMETRY_CONFIG_SCHEMA}: {path}"
        )
    return dict(value)


def load_depth_geometry_config_snapshot(
    profile_path: Path | str,
) -> DepthGeometryConfigSnapshot:
    mutable = mutable_depth_geometry_config_path()
    if mutable is not None and mutable.is_file():
        source = mutable
        value = _read_config(source, nested_seed=False)
    else:
        source = seed_depth_geometry_config_path(Path(profile_path))
        value = _read_config(source, nested_seed=True)
    return DepthGeometryConfigSnapshot(
        value=value,
        sha256=config_sha256(value),
        revision=max(1, int(value.get("revision", 1) or 1)),
        source_path=source,
    )


def config_checkpoint(
    profile_path: Path | str,
    snapshot: DepthGeometryConfigSnapshot,
    delegate: Callable[[str], None] | None = None,
) -> Callable[[str], None]:
    """Compose an existing execution gate with revision-change cancellation."""

    def checkpoint(phase: str) -> None:
        if delegate is not None:
            delegate(phase)
        current = load_depth_geometry_config_snapshot(profile_path)
        if current.sha256 != snapshot.sha256:
            raise DepthGeometryConfigChanged(
                "depth geometry configuration changed during analysis; restart required"
            )

    return checkpoint


def backfill_job_root(storage_root: Path | str) -> Path:
    return Path(storage_root) / "system" / "jobs" / "depth-geometry-backfill"


def backfill_control_path(storage_root: Path | str) -> Path:
    return backfill_job_root(storage_root) / "control.json"


def backfill_is_paused(storage_root: Path | str) -> bool:
    try:
        value = json.loads(
            backfill_control_path(storage_root).read_text(encoding="utf-8-sig")
        )
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return False
    return isinstance(value, dict) and bool(value.get("paused"))
