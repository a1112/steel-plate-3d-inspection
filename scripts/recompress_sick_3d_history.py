#!/usr/bin/env python3
"""Atomically migrate historical SICK raw 3D NPZ frames to ZIP DEFLATE.

The migration is intentionally limited to the camera storage contract
``<camera-root>/<numeric-flow>/3d/<numeric-index>.npz``.  Work is parallelized
with threads because NumPy/zlib releases the GIL and the configured cameras
normally live on independent disks.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict, deque
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import threading
import time
from typing import Any, Iterable
import uuid
import zipfile

import numpy as np


REPORT_SCHEMA = "steel.sick-3d-history-recompression.v1"
DEPTH_KEYS = ("lg3d3d", "steelDepth")
REPLACE_RETRY_DELAYS = (0.0, 0.01, 0.025, 0.05, 0.1, 0.2, 0.4)


@dataclass(frozen=True)
class RootSpec:
    path: Path
    camera_id: str


@dataclass(frozen=True)
class FrameTask:
    root: Path
    camera_id: str
    flow_id: str
    storage_index: int
    depth_path: Path
    metadata_path: Path


@dataclass(frozen=True)
class FrameResult:
    root: str
    camera_id: str
    flow_id: str
    storage_index: int
    path: str
    status: str
    bytes_before: int = 0
    bytes_after: int = 0
    sha256: str = ""
    metadata_updated: bool = False
    event_updated: bool = False
    warning: str = ""
    error: str = ""


@dataclass(frozen=True)
class EventResult:
    path: str
    status: str
    frames_updated: int = 0
    warning: str = ""
    error: str = ""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _temporary_path(path: Path) -> Path:
    return path.with_name(f".{path.name}.{uuid.uuid4().hex}.recompress.tmp")


def _replace_file(temporary: Path, target: Path) -> None:
    for attempt, delay in enumerate(REPLACE_RETRY_DELAYS):
        if delay:
            time.sleep(delay)
        try:
            os.replace(temporary, target)
            return
        except PermissionError:
            if attempt + 1 == len(REPLACE_RETRY_DELAYS):
                raise


def _atomic_json(
    path: Path,
    payload: dict[str, Any],
    source_stat: os.stat_result,
    *,
    fsync: bool,
) -> None:
    temporary = _temporary_path(path)
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            if fsync:
                os.fsync(stream.fileno())
        os.chmod(temporary, stat.S_IMODE(source_stat.st_mode))
        os.utime(temporary, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
        _replace_file(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _archive_is_deflated(path: Path) -> bool:
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if [member.filename for member in members] != ["array.npy"]:
            raise ValueError(f"NPZ members must be exactly ['array.npy']: {path}")
        return all(member.compress_type == zipfile.ZIP_DEFLATED for member in members)


def _load_depth(path: Path) -> np.ndarray:
    with np.load(path, allow_pickle=False) as archive:
        if archive.files != ["array"]:
            raise ValueError(f"NPZ keys must be exactly ['array']: {path}")
        array = np.asarray(archive["array"])
        if array.ndim != 2 or not array.size or array.dtype.hasobject:
            raise ValueError(f"depth array is not a non-empty numeric 2D matrix: {path}")
        return np.ascontiguousarray(array)


def _array_digest(array: np.ndarray) -> str:
    return hashlib.sha256(memoryview(np.ascontiguousarray(array)).cast("B")).hexdigest()


def _write_verified_compressed_npz(
    path: Path,
    source_stat: os.stat_result,
    *,
    compression_level: int,
    fsync: bool,
) -> tuple[int, str]:
    source = _load_depth(path)
    source_digest = _array_digest(source)
    temporary = _temporary_path(path)
    try:
        with temporary.open("xb") as stream:
            with zipfile.ZipFile(
                stream,
                mode="w",
                compression=zipfile.ZIP_DEFLATED,
                compresslevel=compression_level,
                allowZip64=True,
            ) as archive:
                with archive.open("array.npy", mode="w", force_zip64=True) as member:
                    np.lib.format.write_array(member, source, allow_pickle=False)
            stream.flush()
            if fsync:
                os.fsync(stream.fileno())
        if not _archive_is_deflated(temporary):
            raise ValueError(f"temporary NPZ is not ZIP DEFLATE: {temporary}")
        verified = _load_depth(temporary)
        if (
            verified.dtype != source.dtype
            or verified.shape != source.shape
            or _array_digest(verified) != source_digest
        ):
            raise ValueError(f"compressed depth verification failed: {path}")
        current_stat = path.stat()
        if (
            current_stat.st_size != source_stat.st_size
            or current_stat.st_mtime_ns != source_stat.st_mtime_ns
        ):
            raise RuntimeError(f"source changed during recompression: {path}")
        os.chmod(temporary, stat.S_IMODE(source_stat.st_mode))
        os.utime(temporary, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
        size = temporary.stat().st_size
        digest = sha256_file(temporary)
        _replace_file(temporary, path)
        return size, digest
    finally:
        temporary.unlink(missing_ok=True)


def _updated_checksums(value: Any, digest: str) -> bool:
    if not isinstance(value, dict):
        return False
    changed = False
    for key in DEPTH_KEYS:
        if value.get(key) != digest:
            value[key] = digest
            changed = True
    return changed


def _update_metadata(
    path: Path,
    digest: str,
    *,
    apply: bool,
    fsync: bool,
) -> tuple[bool, str, str, int | None]:
    if not path.is_file():
        return False, "matching metadata is missing", "", None
    source_stat = path.stat()
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError(f"metadata must be a JSON object: {path}")
    changed = _updated_checksums(payload.setdefault("checksums", {}), digest)
    frame_artifact = payload.get("frameArtifact")
    if isinstance(frame_artifact, dict):
        changed = _updated_checksums(frame_artifact.setdefault("checksums", {}), digest) or changed
    if payload.get("depthPersistenceMode") != "single-lg3d-npz-deflate":
        payload["depthPersistenceMode"] = "single-lg3d-npz-deflate"
        changed = True
    if payload.get("depthCompression") != "zip-deflate":
        payload["depthCompression"] = "zip-deflate"
        changed = True
    if changed and apply:
        current_stat = path.stat()
        if (
            current_stat.st_size != source_stat.st_size
            or current_stat.st_mtime_ns != source_stat.st_mtime_ns
        ):
            raise RuntimeError(f"metadata changed during migration: {path}")
        _atomic_json(path, payload, source_stat, fsync=fsync)
    camera_id = str(payload.get("cameraId", payload.get("cameraKey", ""))).strip()
    try:
        capture_round = int(payload["captureRound"])
    except (KeyError, TypeError, ValueError):
        capture_round = None
    return changed, "", camera_id, capture_round


def _canonical_event_hash(payload: dict[str, Any]) -> str:
    content = {key: value for key, value in payload.items() if key != "eventHash"}
    canonical = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class EventUpdater:
    def __init__(
        self,
        storage_root: Path,
        *,
        apply: bool,
        fsync: bool,
        enabled: bool = True,
    ) -> None:
        self.storage_root = storage_root
        self.apply = apply
        self.fsync = fsync
        self.enabled = enabled
        self._guard = threading.Lock()
        self._locks: dict[Path, threading.Lock] = {}

    def _lock(self, path: Path) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(path, threading.Lock())

    def update(self, task: FrameTask, digest: str, capture_round: int | None) -> bool:
        if not self.enabled:
            return False
        resolved_round = task.storage_index + 1 if capture_round is None else capture_round
        event_path = (
            self.storage_root
            / task.flow_id
            / "events"
            / "frame-committed"
            / f"{resolved_round:012d}.json"
        )
        if not event_path.is_file():
            return False
        with self._lock(event_path):
            source_stat = event_path.stat()
            payload = json.loads(event_path.read_text(encoding="utf-8-sig"))
            if not isinstance(payload, dict):
                raise ValueError(f"event must be a JSON object: {event_path}")
            changed = False
            for frame in payload.get("frames", []):
                if not isinstance(frame, dict):
                    continue
                if (
                    str(frame.get("cameraId", "")) == task.camera_id
                    and int(frame.get("storageIndex", -1)) == task.storage_index
                ):
                    changed = _updated_checksums(frame.setdefault("checksums", {}), digest) or changed
            if not changed:
                return False
            payload["eventHash"] = _canonical_event_hash(payload)
            if self.apply:
                current_stat = event_path.stat()
                if (
                    current_stat.st_size != source_stat.st_size
                    or current_stat.st_mtime_ns != source_stat.st_mtime_ns
                ):
                    raise RuntimeError(f"event changed during migration: {event_path}")
                _atomic_json(event_path, payload, source_stat, fsync=self.fsync)
            return True


def iter_event_paths(storage_root: Path) -> Iterable[Path]:
    with os.scandir(storage_root) as flows:
        for flow in flows:
            if not flow.is_dir(follow_symlinks=False) or not flow.name.isdecimal():
                continue
            event_root = Path(flow.path) / "events" / "frame-committed"
            if not event_root.is_dir() or event_root.is_symlink():
                continue
            with os.scandir(event_root) as entries:
                for entry in entries:
                    path = Path(entry.path)
                    if (
                        entry.is_file(follow_symlinks=False)
                        and not entry.is_symlink()
                        and path.suffix.lower() == ".json"
                    ):
                        yield path


def _valid_sha256(value: Any) -> str:
    text = str(value or "").strip().lower()
    if len(text) == 64 and all(character in "0123456789abcdef" for character in text):
        return text
    return ""


def reconcile_event_file(
    path: Path,
    *,
    apply: bool,
    fsync: bool,
) -> EventResult:
    try:
        source_stat = path.stat()
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        if not isinstance(payload, dict) or not isinstance(payload.get("frames"), list):
            raise ValueError("event must contain a frames array")
        updated = 0
        warnings: list[str] = []
        for frame in payload["frames"]:
            if not isinstance(frame, dict):
                continue
            metadata_text = str(frame.get("metadataPath", "")).strip()
            metadata_path = Path(metadata_text) if metadata_text else None
            if metadata_path is None or not metadata_path.is_absolute() or not metadata_path.is_file():
                warnings.append(f"metadata unavailable: {metadata_text or '<empty>'}")
                continue
            metadata = json.loads(metadata_path.read_text(encoding="utf-8-sig"))
            checksums = metadata.get("checksums", {}) if isinstance(metadata, dict) else {}
            digest = _valid_sha256(
                checksums.get("lg3d3d") if isinstance(checksums, dict) else ""
            ) or _valid_sha256(
                checksums.get("steelDepth") if isinstance(checksums, dict) else ""
            )
            if not digest:
                warnings.append(f"depth checksum unavailable: {metadata_path}")
                continue
            target = frame.setdefault("checksums", {})
            if not isinstance(target, dict):
                target = {}
                frame["checksums"] = target
            if _updated_checksums(target, digest):
                updated += 1
        expected_hash = _canonical_event_hash(payload)
        changed = updated > 0 or payload.get("eventHash") != expected_hash
        if changed:
            payload["eventHash"] = expected_hash
            if apply:
                current_stat = path.stat()
                if (
                    current_stat.st_size != source_stat.st_size
                    or current_stat.st_mtime_ns != source_stat.st_mtime_ns
                ):
                    raise RuntimeError("event changed during reconciliation")
                _atomic_json(path, payload, source_stat, fsync=fsync)
        return EventResult(
            path=str(path),
            status="updated" if changed else "unchanged",
            frames_updated=updated,
            warning="; ".join(warnings[:20]),
        )
    except Exception as error:
        return EventResult(
            path=str(path),
            status="error",
            error=f"{type(error).__name__}: {error}",
        )


def run_event_reconciliation(
    profile_path: Path,
    *,
    workers: int,
    apply: bool,
    fsync: bool = False,
) -> dict[str, Any]:
    started_at = utc_now()
    started = time.monotonic()
    storage_root, _ = load_roots(profile_path)
    paths = list(iter_event_paths(storage_root))
    counts: Counter[str] = Counter()
    frames_updated = 0
    failures: list[dict[str, str]] = []
    warnings: list[str] = []
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="event-reconcile") as pool:
        futures = [
            pool.submit(reconcile_event_file, path, apply=apply, fsync=fsync)
            for path in paths
        ]
        for future in futures:
            result = future.result()
            counts[result.status] += 1
            frames_updated += result.frames_updated
            if result.warning and len(warnings) < 1000:
                warnings.append(f"{result.path}: {result.warning}")
            if result.error and len(failures) < 1000:
                failures.append({"path": result.path, "error": result.error})
    return {
        "schema": REPORT_SCHEMA,
        "status": "failed" if counts["error"] else "complete",
        "mode": "events-apply" if apply else "events-dry-run",
        "startedAt": started_at,
        "completedAt": utc_now(),
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "profile": str(Path(profile_path).resolve()),
        "storageRoot": str(storage_root),
        "workers": workers,
        "eventsDiscovered": len(paths),
        "framesUpdated": frames_updated,
        "counts": dict(counts),
        "warnings": warnings,
        "failures": failures,
    }


def load_roots(
    profile_path: Path,
    extra_roots: Iterable[Path] = (),
    *,
    roots_only: bool = False,
) -> tuple[Path, list[RootSpec]]:
    profile_path = profile_path.resolve(strict=True)
    profile = json.loads(profile_path.read_text(encoding="utf-8-sig"))
    if not isinstance(profile, dict):
        raise ValueError("capture profile must be a JSON object")
    storage_root = Path(os.path.expandvars(str(profile.get("storageRoot", "")))).resolve()
    candidates: list[RootSpec] = [] if roots_only else [RootSpec(storage_root, "")]
    if not roots_only:
        for camera in profile.get("cameras", []):
            if not isinstance(camera, dict):
                continue
            root_text = str(camera.get("storageRoot", "")).strip()
            camera_id = str(camera.get("id", camera.get("key", ""))).strip()
            if root_text:
                candidates.append(
                    RootSpec(Path(os.path.expandvars(root_text)).resolve(), camera_id)
                )
    candidates.extend(RootSpec(Path(value).resolve(), "") for value in extra_roots)
    roots: dict[str, RootSpec] = {}
    for candidate in candidates:
        if candidate.path.parent == candidate.path:
            raise ValueError(f"drive/filesystem root is not an allowed migration target: {candidate.path}")
        if not candidate.path.is_dir():
            continue
        key = os.path.normcase(str(candidate.path))
        previous = roots.get(key)
        if previous is None or (not previous.camera_id and candidate.camera_id):
            roots[key] = candidate
    if not roots:
        raise ValueError("capture profile has no existing storage roots")
    return storage_root, sorted(roots.values(), key=lambda item: str(item.path).lower())


def _iter_root_tasks(
    root: RootSpec,
    warnings: list[str] | None,
    *,
    shard_count: int,
    shard_index: int,
) -> Iterable[FrameTask]:
    with os.scandir(root.path) as flows:
        for flow in flows:
            if not flow.is_dir(follow_symlinks=False) or not flow.name.isdecimal():
                continue
            if int(flow.name) % shard_count != shard_index:
                continue
            depth_dir = Path(flow.path) / "3d"
            if not depth_dir.is_dir() or depth_dir.is_symlink():
                continue
            with os.scandir(depth_dir) as entries:
                for entry in entries:
                    candidate = Path(entry.path)
                    if entry.is_symlink():
                        if warnings is not None and len(warnings) < 1000:
                            warnings.append(f"symlink skipped: {candidate}")
                        continue
                    if (
                        not entry.is_file(follow_symlinks=False)
                        or candidate.suffix.lower() != ".npz"
                        or not candidate.stem.isdecimal()
                    ):
                        continue
                    yield FrameTask(
                        root=root.path,
                        camera_id=root.camera_id,
                        flow_id=flow.name,
                        storage_index=int(candidate.stem),
                        depth_path=candidate,
                        metadata_path=depth_dir.parent / "json" / f"{candidate.stem}.json",
                    )


def iter_tasks(
    roots: Iterable[RootSpec],
    warnings: list[str] | None = None,
    *,
    shard_count: int = 1,
    shard_index: int = 0,
) -> Iterable[FrameTask]:
    # Round-robin roots so the bounded worker window stays distributed across
    # the independent camera disks instead of finishing one volume at a time.
    iterators = deque(
        iter(
            _iter_root_tasks(
                root,
                warnings,
                shard_count=shard_count,
                shard_index=shard_index,
            )
        )
        for root in roots
    )
    while iterators:
        current = iterators.popleft()
        try:
            task = next(current)
        except StopIteration:
            continue
        yield task
        iterators.append(current)


def _bounded_results(
    pool: ThreadPoolExecutor,
    tasks: Iterable[FrameTask],
    *,
    apply: bool,
    rewrite_all: bool,
    compression_level: int,
    fsync: bool,
    event_updater: EventUpdater,
    maximum_pending: int,
) -> Iterable[FrameResult]:
    iterator = iter(tasks)
    pending: set[Future[FrameResult]] = set()

    def submit_one() -> bool:
        try:
            task = next(iterator)
        except StopIteration:
            return False
        pending.add(
            pool.submit(
                migrate_frame,
                task,
                apply=apply,
                rewrite_all=rewrite_all,
                compression_level=compression_level,
                fsync=fsync,
                event_updater=event_updater,
            )
        )
        return True

    while len(pending) < maximum_pending and submit_one():
        pass
    while pending:
        completed, pending = wait(pending, return_when=FIRST_COMPLETED)
        for future in completed:
            yield future.result()
            submit_one()


def migrate_frame(
    task: FrameTask,
    *,
    apply: bool,
    rewrite_all: bool,
    compression_level: int,
    fsync: bool,
    event_updater: EventUpdater,
) -> FrameResult:
    try:
        source_stat = task.depth_path.stat()
        already_deflated = _archive_is_deflated(task.depth_path)
        should_rewrite = rewrite_all or not already_deflated
        if already_deflated and not rewrite_all:
            return FrameResult(
                root=str(task.root),
                camera_id=task.camera_id,
                flow_id=task.flow_id,
                storage_index=task.storage_index,
                path=str(task.depth_path),
                status="already-compressed",
                bytes_before=source_stat.st_size,
                bytes_after=source_stat.st_size,
            )
        if apply and should_rewrite:
            bytes_after, digest = _write_verified_compressed_npz(
                task.depth_path,
                source_stat,
                compression_level=compression_level,
                fsync=fsync,
            )
            status = "rewritten"
        else:
            bytes_after = source_stat.st_size
            digest = sha256_file(task.depth_path)
            status = "would-rewrite" if should_rewrite else "already-compressed"
        metadata_updated, warning, metadata_camera_id, capture_round = _update_metadata(
            task.metadata_path,
            digest,
            apply=apply,
            fsync=fsync,
        )
        camera_id = task.camera_id or metadata_camera_id
        if camera_id != task.camera_id:
            task = FrameTask(
                root=task.root,
                camera_id=camera_id,
                flow_id=task.flow_id,
                storage_index=task.storage_index,
                depth_path=task.depth_path,
                metadata_path=task.metadata_path,
            )
        event_updated = (
            event_updater.update(task, digest, capture_round) if camera_id else False
        )
        return FrameResult(
            root=str(task.root),
            camera_id=camera_id,
            flow_id=task.flow_id,
            storage_index=task.storage_index,
            path=str(task.depth_path),
            status=status,
            bytes_before=source_stat.st_size,
            bytes_after=bytes_after,
            sha256=digest,
            metadata_updated=metadata_updated,
            event_updated=event_updated,
            warning=warning,
        )
    except Exception as error:
        return FrameResult(
            root=str(task.root),
            camera_id=task.camera_id,
            flow_id=task.flow_id,
            storage_index=task.storage_index,
            path=str(task.depth_path),
            status="error",
            error=f"{type(error).__name__}: {error}",
        )


def run_migration(
    profile_path: Path,
    *,
    workers: int,
    apply: bool,
    rewrite_all: bool = False,
    compression_level: int = 1,
    fsync: bool = False,
    shard_count: int = 1,
    shard_index: int = 0,
    extra_roots: Iterable[Path] = (),
    roots_only: bool = False,
    update_events: bool = True,
    progress_every: int = 1000,
) -> dict[str, Any]:
    started_at = utc_now()
    started = time.monotonic()
    storage_root, roots = load_roots(
        profile_path,
        extra_roots,
        roots_only=roots_only,
    )
    if shard_count < 1 or shard_index < 0 or shard_index >= shard_count:
        raise ValueError("shard index must be in [0, shard count)")
    task_count = sum(
        1
        for _ in iter_tasks(
            roots,
            shard_count=shard_count,
            shard_index=shard_index,
        )
    )
    discovery_warnings: list[str] = []
    event_updater = EventUpdater(
        storage_root,
        apply=apply,
        fsync=fsync,
        enabled=update_events,
    )
    counts: Counter[str] = Counter()
    root_counts: dict[str, Counter[str]] = defaultdict(Counter)
    bytes_before = 0
    bytes_after = 0
    failures: list[dict[str, str]] = []
    warnings = list(discovery_warnings)
    print(
        json.dumps(
            {
                "phase": "start",
                "apply": apply,
                "workers": workers,
                "compressionLevel": compression_level,
                "fsync": fsync,
                "shardCount": shard_count,
                "shardIndex": shard_index,
                "updateEvents": update_events,
                "frames": task_count,
                "roots": [str(root.path) for root in roots],
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="npz-recompress") as pool:
        results = _bounded_results(
            pool,
            iter_tasks(
                roots,
                discovery_warnings,
                shard_count=shard_count,
                shard_index=shard_index,
            ),
            apply=apply,
            rewrite_all=rewrite_all,
            compression_level=compression_level,
            fsync=fsync,
            event_updater=event_updater,
            maximum_pending=max(workers * 4, workers),
        )
        for processed, result in enumerate(results, start=1):
            counts[result.status] += 1
            root_counts[result.root][result.status] += 1
            bytes_before += result.bytes_before
            bytes_after += result.bytes_after
            if result.metadata_updated:
                counts["metadata-updated"] += 1
                root_counts[result.root]["metadata-updated"] += 1
            if result.event_updated:
                counts["event-updated"] += 1
            if result.warning and len(warnings) < 1000:
                warnings.append(f"{result.path}: {result.warning}")
            if result.error and len(failures) < 1000:
                failures.append({"path": result.path, "error": result.error})
            if progress_every > 0 and (processed % progress_every == 0 or processed == task_count):
                print(
                    json.dumps(
                        {
                            "phase": "progress",
                            "processed": processed,
                            "total": task_count,
                            "counts": dict(counts),
                            "savedGiB": round((bytes_before - bytes_after) / 1024**3, 3),
                            "elapsedSeconds": round(time.monotonic() - started, 1),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
    return {
        "schema": REPORT_SCHEMA,
        "status": "failed" if counts["error"] else "complete",
        "mode": "apply" if apply else "dry-run",
        "startedAt": started_at,
        "completedAt": utc_now(),
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "profile": str(Path(profile_path).resolve()),
        "storageRoot": str(storage_root),
        "workers": workers,
        "compressionLevel": compression_level,
        "fsync": fsync,
        "shardCount": shard_count,
        "shardIndex": shard_index,
        "updateEvents": update_events,
        "rewriteAll": rewrite_all,
        "roots": [str(root.path) for root in roots],
        "framesDiscovered": task_count,
        "counts": dict(counts),
        "bytesBefore": bytes_before,
        "bytesAfter": bytes_after,
        "bytesSaved": bytes_before - bytes_after,
        "rootCounts": {root: dict(values) for root, values in sorted(root_counts.items())},
        "warnings": warnings,
        "failures": failures,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--root", action="append", type=Path, default=[])
    parser.add_argument(
        "--roots-only",
        action="store_true",
        help="scan only explicit --root values while retaining the profile storage root for reports",
    )
    parser.add_argument("--workers", type=int, default=min(24, max(2, os.cpu_count() or 2)))
    parser.add_argument("--apply", action="store_true", help="atomically replace historical files")
    parser.add_argument("--compression-level", type=int, default=1)
    parser.add_argument(
        "--fsync",
        action="store_true",
        help="flush every replacement to stable media (much slower on multi-million-frame history)",
    )
    parser.add_argument(
        "--rewrite-all",
        action="store_true",
        help="rewrite already-DEFLATE archives too; normally they are verified and skipped",
    )
    parser.add_argument("--progress-every", type=int, default=1000)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument("--report", type=Path)
    parser.add_argument(
        "--events-only",
        action="store_true",
        help="reconcile committed-event hashes from migrated frame metadata",
    )
    parser.add_argument(
        "--skip-events",
        action="store_true",
        help="defer committed-event checksum reconciliation to a later bounded pass",
    )
    args = parser.parse_args(argv)
    if args.workers < 1 or args.workers > 128:
        parser.error("--workers must be between 1 and 128")
    if args.progress_every < 0:
        parser.error("--progress-every cannot be negative")
    if args.compression_level < 1 or args.compression_level > 9:
        parser.error("--compression-level must be between 1 and 9")
    if args.shard_count < 1 or args.shard_count > 64:
        parser.error("--shard-count must be between 1 and 64")
    if args.shard_index < 0 or args.shard_index >= args.shard_count:
        parser.error("--shard-index must be in [0, shard count)")
    if args.roots_only and not args.root:
        parser.error("--roots-only requires at least one --root")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.events_only:
        report = run_event_reconciliation(
            args.profile,
            workers=args.workers,
            apply=args.apply,
            fsync=args.fsync,
        )
    else:
        report = run_migration(
            args.profile,
            workers=args.workers,
            apply=args.apply,
            rewrite_all=args.rewrite_all,
            compression_level=args.compression_level,
            fsync=args.fsync,
            shard_count=args.shard_count,
            shard_index=args.shard_index,
            extra_roots=args.root,
            roots_only=args.roots_only,
            update_events=not args.skip_events,
            progress_every=args.progress_every,
        )
    report_path = args.report
    if report_path is None:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shard = (
            "-events"
            if args.events_only
            else f"-shard-{args.shard_index:02d}-of-{args.shard_count:02d}"
            if args.shard_count > 1
            else ""
        )
        report_path = (
            Path(report["storageRoot"])
            / "system"
            / "migrations"
            / f"3d-recompression-{stamp}{shard}.json"
        )
    report_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = _temporary_path(report_path)
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        _replace_file(temporary, report_path)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({"phase": "complete", "report": str(report_path), **report}, ensure_ascii=False), flush=True)
    return 1 if report["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
