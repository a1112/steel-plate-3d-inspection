#!/usr/bin/env python3
"""Offline rebuild into the simplified per-camera SICK storage layout.

Immutable raw artifacts are moved on-volume from the former
``<disk>/steel-sick-data/<flow>/capture/<camera>`` layout into
``<disk>/<camera>/<flow>``. Derived/cache artifacts, durable frame events,
playback indexes, and PostgreSQL file paths are then rebuilt from raw data.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

if __package__:
    from .sick_capture.events import publish_committed_round, write_flow_manifest
    from .sick_capture.paths import capture_root
    from .sick_capture.playback import rebuild_playback_history
else:
    from sick_capture.events import publish_committed_round, write_flow_manifest
    from sick_capture.paths import capture_root
    from sick_capture.playback import rebuild_playback_history


RAW_DIRECTORIES = ("2d", "3d", "json")
_NUMBER_FIELD = re.compile(r'"(?P<key>[A-Za-z0-9_]+)"\s*:\s*(?P<value>-?[0-9]+(?:\.[0-9eE+\-]+)?)')
_STRING_FIELD = re.compile(r'"(?P<key>[A-Za-z0-9_]+)"\s*:\s*(?P<value>"(?:\\.|[^"\\])*")')


@dataclass(frozen=True)
class MoveAction:
    source: Path
    target: Path
    source_root: Path
    camera_id: str
    flow_id: str


def _utc_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON object required: {path}")
    return value


def _minimal_metadata(path: Path) -> dict[str, Any]:
    """Extract scalar frame fields without materializing the large audit tree."""
    text = path.read_text(encoding="utf-8-sig")
    numbers: dict[str, str] = {}
    strings: dict[str, str] = {}
    for match in _NUMBER_FIELD.finditer(text):
        numbers.setdefault(match.group("key"), match.group("value"))
    for match in _STRING_FIELD.finditer(text):
        strings.setdefault(match.group("key"), match.group("value"))

    def number(key: str, default: float = 0.0) -> float:
        try:
            return float(numbers.get(key, default))
        except (TypeError, ValueError):
            return default

    def integer(key: str, default: int = 0) -> int:
        try:
            return int(numbers.get(key, default))
        except (TypeError, ValueError):
            return default

    def string(key: str, default: str = "") -> str:
        try:
            return str(json.loads(strings[key]))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return default

    return {
        "cameraKey": string("cameraKey"),
        "capturedAt": string("capturedAt", string("capTime")),
        "captureRound": integer("captureRound", -1),
        "hostUtcNs": integer("hostUtcNs", 0),
        "timestamp": integer("timestamp", 0),
        "data2D_mean": number("data2D_mean", 0.0),
        "brightPixelRatio": number("brightPixelRatio", 0.0),
        "sessionId": string("sessionId"),
    }


def _atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def _camera_roots(profile: dict[str, Any]) -> dict[str, Path]:
    result: dict[str, Path] = {}
    for row in profile.get("cameras", []):
        if not isinstance(row, dict) or not bool(row.get("enabled", True)):
            continue
        camera_id = str(row.get("id", row.get("key", ""))).strip()
        root = Path(os.path.expandvars(str(row.get("storageRoot", "")))).resolve()
        if not camera_id or root.parent == root:
            raise ValueError(f"invalid camera storage configuration: {row}")
        result[camera_id] = root
    if not result:
        raise ValueError("profile has no enabled cameras")
    return result


def build_plan(
    camera_roots: dict[str, Path],
    storage_root: Path | None = None,
) -> list[MoveAction]:
    actions: list[MoveAction] = []
    for camera_id, target_root in camera_roots.items():
        primary_source_root = target_root.parent / "steel-sick-data"
        source_roots = [primary_source_root]
        if storage_root is not None and storage_root.resolve() != primary_source_root.resolve():
            source_roots.append(storage_root)
        for source_root in source_roots:
            if not source_root.is_dir():
                continue
            # Current flow-first layout.
            for source_flow in source_root.iterdir():
                if not source_flow.is_dir() or not source_flow.name.isdecimal():
                    continue
                source = source_flow / "capture" / camera_id
                if source.is_dir():
                    flow = str(int(source_flow.name))
                    actions.append(
                        MoveAction(
                            source,
                            capture_root(target_root, flow, camera_id),
                            source_root,
                            camera_id,
                            flow,
                        )
                    )
    return actions


def validate_plan(actions: Sequence[MoveAction], *, check_targets: bool = True) -> None:
    for action in actions:
        _assert_child(action.source, action.source_root)
        if not action.source.is_dir():
            raise FileNotFoundError(action.source)
        if not any((action.source / name).exists() for name in RAW_DIRECTORIES):
            raise FileNotFoundError(f"raw artifact directories missing: {action.source}")
    if not check_targets:
        return
    for action in actions:
        if action.target.exists() and not action.target.is_dir():
            raise FileExistsError(action.target)


def _assert_child(path: Path, root: Path) -> None:
    resolved = path.resolve()
    boundary = root.resolve()
    if resolved == boundary or boundary not in resolved.parents:
        raise ValueError(f"refusing destructive operation outside {boundary}: {resolved}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _merge_move(source: Path, target: Path) -> None:
    """Move one immutable artifact, safely resuming an interrupted copy."""
    source_exists = source.exists()
    target_exists = target.exists()
    if not source_exists:
        if target_exists:
            return
        raise FileNotFoundError(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target_exists:
        try:
            source.rename(target)
            return
        except OSError:
            if source.is_file():
                descriptor, temporary_name = tempfile.mkstemp(
                    prefix=f".{target.name}.", suffix=".migration.tmp", dir=target.parent
                )
                os.close(descriptor)
                temporary = Path(temporary_name)
                try:
                    shutil.copy2(source, temporary)
                    if source.stat().st_size != temporary.stat().st_size:
                        raise OSError(f"cross-volume copy size mismatch: {source}")
                    if _sha256(source) != _sha256(temporary):
                        raise OSError(f"cross-volume copy checksum mismatch: {source}")
                    os.replace(temporary, target)
                    source.unlink()
                    return
                finally:
                    temporary.unlink(missing_ok=True)
            target.mkdir(parents=True, exist_ok=True)
    if source.is_file():
        if not target.is_file() or source.stat().st_size != target.stat().st_size:
            raise FileExistsError(f"raw artifact conflict: {source} and {target}")
        if _sha256(source) != _sha256(target):
            raise ValueError(f"raw artifact checksum conflict: {source} and {target}")
        source.unlink()
        return
    if not target.is_dir():
        raise FileExistsError(f"raw artifact type conflict: {source} and {target}")
    for child in source.iterdir():
        _merge_move(child, target / child.name)
    try:
        source.rmdir()
    except OSError:
        if any(source.iterdir()):
            raise


def _remove_derived(storage_root: Path) -> dict[str, Any]:
    targets = [
        storage_root / "alignment",
        storage_root / "measurements",
        storage_root / "defects",
        storage_root / "history",
        storage_root / "cache",
        storage_root / "catalog.json",
    ]
    if storage_root.is_dir():
        for flow in storage_root.iterdir():
            if flow.is_dir() and flow.name.isdecimal():
                targets.extend(
                    flow / name for name in ("derived", "sync", "cache", "events")
                )
                targets.append(flow / "flow.json")
    retired = 0
    skipped: list[dict[str, str]] = []
    retirement_root = (
        storage_root
        / "rebuild"
        / f"obsolete-derived-v1-{dt.datetime.now():%Y%m%d-%H%M%S}"
    )
    for target in targets:
        if not target.exists():
            continue
        _assert_child(target, storage_root)
        destination = retirement_root / target.relative_to(storage_root)
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            target.rename(destination)
            retired += 1
        except OSError as error:
            # Old v1 paths are outside every v2 lookup.  A locked cache may be
            # retired after restart without blocking the immutable raw move.
            skipped.append({"path": str(target), "error": str(error)})
    return {"retired": retired, "lockedOrSkipped": skipped}


def _remove_empty_source_containers(actions: Sequence[MoveAction]) -> int:
    removed = 0
    candidates: set[tuple[Path, Path]] = set()
    for action in actions:
        cursor = action.source.parent
        while cursor != action.source_root and action.source_root in cursor.parents:
            candidates.add((cursor, action.source_root))
            cursor = cursor.parent
    for candidate, boundary in sorted(
        candidates,
        key=lambda row: (len(row[0].parts), str(row[0])),
        reverse=True,
    ):
        _assert_child(candidate, boundary)
        try:
            candidate.rmdir()
            removed += 1
        except OSError:
            continue
    return removed


def _retire_legacy_camera_roots(
    storage_root: Path,
    camera_roots: dict[str, Path],
) -> dict[str, Any]:
    """Retain early camera-first JPEG mirrors outside the active namespace."""
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    source_roots = {
        storage_root.resolve(),
        *(root.parent.joinpath("steel-sick-data").resolve() for root in camera_roots.values()),
    }
    retired: list[dict[str, str]] = []
    for source_root in source_roots:
        for camera_id in camera_roots:
            source = source_root / camera_id
            if not source.is_dir():
                continue
            destination = (
                source_root / "rebuild" / f"obsolete-camera-v1-{stamp}" / camera_id
            )
            _assert_child(source, source_root)
            _assert_child(destination, source_root)
            destination.parent.mkdir(parents=True, exist_ok=True)
            _merge_move(source, destination)
            retired.append({"from": str(source), "to": str(destination)})
    return {"count": len(retired), "paths": retired}


def _numeric_stems(directory: Path, suffix: str) -> set[int]:
    if not directory.is_dir():
        return set()
    return {
        int(path.stem)
        for path in directory.glob(f"*{suffix}")
        if path.stem.isdecimal()
    }


def _latest_complete_rows(
    camera_roots: dict[str, Path], material_id: str
) -> tuple[int, list[dict[str, Any]], dict[str, Path]] | None:
    """Build one closed-flow checkpoint without parsing historical SDK audits."""
    latest_by_camera: dict[str, tuple[int, Path, Path, Path, int]] = {}
    capture_roots: dict[str, Path] = {}
    for camera_id, root in camera_roots.items():
        base = capture_root(root, material_id, camera_id)
        if not base.is_dir():
            continue
        complete = (
            _numeric_stems(base / "2d", ".png")
            & _numeric_stems(base / "3d", ".npz")
            & _numeric_stems(base / "json", ".json")
        )
        if not complete:
            continue
        storage_index = max(complete)
        metadata_path = base / "json" / f"{storage_index}.json"
        try:
            host_utc_ns = metadata_path.stat().st_mtime_ns
        except OSError:
            continue
        latest_by_camera[camera_id] = (
            storage_index,
            base / "2d" / f"{storage_index}.png",
            base / "3d" / f"{storage_index}.npz",
            metadata_path,
            host_utc_ns,
        )
        capture_roots[camera_id] = base
    if not latest_by_camera:
        return None
    # Use the latest round present on the largest camera set.  Minor tail
    # count differences are expected in historical sessions and do not hide
    # the rest of the immutable raw frames from the algorithm.
    checkpoint_index = max(
        {row[0] for row in latest_by_camera.values()},
        key=lambda index: (
            sum(1 for row in latest_by_camera.values() if row[0] == index),
            index,
        ),
    )
    rows: list[dict[str, Any]] = []
    for camera_id, (storage_index, intensity_path, depth_path, metadata_path, host_utc_ns) in latest_by_camera.items():
        if storage_index != checkpoint_index:
            continue
        rows.append(
            {
                "cameraId": camera_id,
                "cameraKey": camera_id,
                "round": checkpoint_index + 1,
                "sequenceNo": storage_index + 1,
                "capturedAt": dt.datetime.fromtimestamp(
                    host_utc_ns / 1_000_000_000,
                    tz=dt.timezone.utc,
                ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                "hostUtcNs": host_utc_ns,
                "deviceTimestamp": 0,
                "depthOutput": str(depth_path),
                "intensityOutput": str(intensity_path),
                "metadataOutput": str(metadata_path),
                "meanIntensity": 0.0,
                "brightPixelRatio": 0.0,
                "checksums": {},
            }
        )
    return checkpoint_index + 1, rows, capture_roots


def _rebuild_events(
    storage_root: Path, camera_roots: dict[str, Path]
) -> tuple[int, int]:
    material_ids: set[str] = set()
    for root in camera_roots.values():
        if root.is_dir():
            material_ids.update(
                path.name
                for path in root.iterdir()
                if path.is_dir() and path.name.isdecimal()
            )
    ordered = sorted(material_ids, key=int)

    def rebuild_one(material_id: str) -> tuple[bool, int]:
        checkpoint = _latest_complete_rows(camera_roots, material_id)
        if checkpoint is None:
            return False, 0
        capture_round, rows, roots = checkpoint
        session_id = f"historical-{material_id}"
        publish_committed_round(
            storage_root,
            material_id,
            session_id,
            rows,
            boundary_phase="historical-rebuild-checkpoint",
            expected_camera_ids=set(roots),
        )
        write_flow_manifest(
            storage_root,
            material_id,
            session_id=session_id,
            state="closed",
            camera_roots=roots,
            latest_round=capture_round,
        )
        return True, 1

    material_count = 0
    event_count = 0
    with ThreadPoolExecutor(max_workers=8, thread_name_prefix="flow-checkpoint") as executor:
        for completed, (rebuilt, events) in enumerate(
            executor.map(rebuild_one, ordered), start=1
        ):
            material_count += int(rebuilt)
            event_count += events
            if completed % 100 == 0 or completed == len(ordered):
                print(
                    json.dumps(
                        {
                            "stage": "events",
                            "completed": completed,
                            "total": len(ordered),
                            "rebuilt": material_count,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
    return material_count, event_count


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _database_sql(storage_root: Path, camera_roots: dict[str, Path]) -> str:
    commands = ["BEGIN;", "LOCK TABLE steel_flow IN SHARE ROW EXCLUSIVE MODE;"]
    roots = ",".join(
        f"({_sql_literal(camera_id)},{_sql_literal(str(root).rstrip('\\/') + os.sep)})"
        for camera_id, root in camera_roots.items()
    )
    commands.append(
        "UPDATE steel_flow_image AS image SET "
        "material_id=image.flow_no::text, "
        f"depth_path=roots.root || image.flow_no::text || '{os.sep}3d{os.sep}' || (image.camera_sequence_no-1)::text || '.npz', "
        f"intensity_path=roots.root || image.flow_no::text || '{os.sep}2d{os.sep}' || (image.camera_sequence_no-1)::text || '.png', "
        f"metadata_path=roots.root || image.flow_no::text || '{os.sep}json{os.sep}' || (image.camera_sequence_no-1)::text || '.json' "
        f"FROM (VALUES {roots}) AS roots(camera_id, root) "
        "WHERE image.camera_id=roots.camera_id;"
    )
    commands.append(
        "UPDATE capture_file AS capture SET material_id=flow.flow_no::text, "
        f"path=roots.root || flow.flow_no::text || '{os.sep}' || "
        f"CASE capture.data_name WHEN 'depth' THEN '3d{os.sep}' WHEN 'intensity' THEN '2d{os.sep}' ELSE 'json{os.sep}' END || "
        "(capture.sequence_no-1)::text || CASE capture.data_name WHEN 'depth' THEN '.npz' WHEN 'intensity' THEN '.png' ELSE '.json' END, "
        f"metadata_path=roots.root || flow.flow_no::text || '{os.sep}json{os.sep}' || (capture.sequence_no-1)::text || '.json' "
        f"FROM steel_flow AS flow, (VALUES {roots}) AS roots(camera_id, root) "
        "WHERE flow.session_id=capture.session_id AND capture.camera_id=roots.camera_id "
        "AND capture.data_name IN ('depth','intensity','metadata');"
    )
    central = str(storage_root).rstrip("\\/") + os.sep
    commands.extend(
        [
            f"UPDATE steel_flow SET material_id=flow_no::text, storage_root={_sql_literal(central)} || flow_no::text;",
            "DELETE FROM steel_flow_region;",
            "COMMIT;",
        ]
    )
    return "\n".join(commands)


def _load_env(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            result[key.strip()] = value.strip().strip('"').strip("'")
    return result


def _rewrite_database(env_path: Path, sql: str) -> None:
    settings = _load_env(env_path)
    database_url = settings.get("STEEL_DATABASE_URL", os.environ.get("STEEL_DATABASE_URL", ""))
    psql = os.environ.get("PSQL_EXECUTABLE", r"D:\PostgreSQL\17\server\bin\psql.exe")
    process_env = os.environ.copy()
    if database_url:
        connection_args = ["-d", database_url]
    else:
        values = {
            "host": settings.get("STEEL_POSTGRES_HOST", ""),
            "port": settings.get("STEEL_POSTGRES_PORT", "5432"),
            "user": settings.get("STEEL_POSTGRES_USER", ""),
            "database": settings.get("STEEL_POSTGRES_DATABASE", ""),
        }
        missing = [key for key in ("host", "user", "database") if not values[key]]
        if missing:
            raise ValueError(
                "database rebuild requires STEEL_DATABASE_URL or PostgreSQL fields: "
                + ", ".join(missing)
            )
        connection_args = [
            "-h", values["host"],
            "-p", values["port"],
            "-U", values["user"],
            "-d", values["database"],
        ]
        process_env["PGPASSWORD"] = settings.get("STEEL_POSTGRES_PASSWORD", "")
        process_env["PGSSLMODE"] = settings.get("STEEL_POSTGRES_SSL_MODE", "prefer")
    subprocess.run(
        [psql, "-X", "-w", "-v", "ON_ERROR_STOP=1", *connection_args, "-c", sql],
        check=True,
        env=process_env,
    )


def rebuild(profile_path: Path, env_path: Path | None, *, execute: bool) -> dict[str, Any]:
    profile = _read_json(profile_path)
    if profile.get("schema") != "steel.capture.profile.v2":
        raise ValueError("rebuild requires steel.capture.profile.v2")
    storage_root = Path(os.path.expandvars(str(profile["storageRoot"]))).resolve()
    camera_roots = _camera_roots(profile)
    actions = build_plan(camera_roots, storage_root)
    # The move phase is restartable and validates each exact source/target
    # pair.  A separate 60k-entry filesystem preflight doubles random I/O on
    # the six data disks without improving recoverability.
    validate_plan(actions, check_targets=False)
    result: dict[str, Any] = {
        "schema": "steel.camera-storage-rebuild.v3",
        "mode": "execute" if execute else "dry-run",
        "generatedAt": _utc_text(),
        "storageRoot": str(storage_root),
        "moveCount": len(actions),
        "cameraRoots": {key: str(value) for key, value in camera_roots.items()},
        "sample": [
            {"from": str(row.source), "to": str(row.target)} for row in actions[:24]
        ],
    }
    if not execute:
        return result
    occupied = [port for port in (4317, 4873, 4875) if _port_open(port)]
    if occupied:
        raise RuntimeError(f"capture/service/algorithm must be stopped; open ports: {occupied}")
    journal = storage_root / "rebuild" / f"camera-storage-v3-{dt.datetime.now():%Y%m%d-%H%M%S}.json"
    result["state"] = "running"
    _atomic_json(journal, result)
    try:
        result["derivedRetirement"] = _remove_derived(storage_root)
        for action in actions:
            _merge_move(action.source, action.target)
        result["emptyLegacyDirectoriesRemoved"] = _remove_empty_source_containers(actions)
        result["legacyCameraRetirement"] = _retire_legacy_camera_roots(
            storage_root, camera_roots
        )
        material_count, event_count = _rebuild_events(storage_root, camera_roots)
        result["materialCount"] = material_count
        result["frameEventCount"] = event_count
        def playback_progress(completed: int, total: int, rebuilt: int) -> None:
            if completed % 100 == 0 or completed == total:
                print(
                    json.dumps(
                        {
                            "stage": "playback",
                            "completed": completed,
                            "total": total,
                            "rebuilt": rebuilt,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )

        result["playback"] = rebuild_playback_history(
            camera_roots,
            storage_root,
            max_workers=8,
            progress=playback_progress,
        )
        if env_path is not None:
            _rewrite_database(env_path, _database_sql(storage_root, camera_roots))
            result["database"] = "rewritten"
        result["state"] = "complete"
        result["completedAt"] = _utc_text()
    except Exception as error:
        result["state"] = "failed"
        result["error"] = f"{type(error).__name__}: {error}"
        _atomic_json(journal, result)
        raise
    result["journalPath"] = str(journal)
    _atomic_json(journal, result)
    return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(rebuild(args.profile, args.env_file, execute=args.execute), ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        print(f"flow storage rebuild failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
