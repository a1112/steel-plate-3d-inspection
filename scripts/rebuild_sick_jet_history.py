#!/usr/bin/env python3
"""Rebuild calibrated, head-aligned JET images for historical SICK flows."""

from __future__ import annotations

import argparse
import concurrent.futures
from contextlib import contextmanager
import json
import os
import secrets
import sys
import time
from pathlib import Path
from typing import Any, Iterator

from sick_capture.alignment import AlignmentConfig, build_and_write_flow_alignment
from sick_capture.material_lock import MaterialJobLockedError, exclusive_material_job
from sick_capture.measurement import MeasurementConfig
from sick_capture.paths import (
    algorithm_state_path,
    capture_root,
    measurement_path,
    rendition_image_path,
    rendition_metadata_path,
    region_path,
    surface_path,
)
from sick_capture.profile import load_profile
from sick_capture.storage import atomic_summary
from sick_capture.surface import (
    build_and_write_flow_surface,
    measurement_artifact_from_surface,
    upgrade_surface_display_contract,
)
from sick_capture.renditions import (
    GRAY_ALGORITHM,
    JET_ALGORITHM,
    build_gray_rendition,
    build_jet_rendition,
)


JOB_SCHEMA = "steel.jet-history-rebuild.v1"
JOB_LOCK_STALE_SECONDS = 300
JOB_STATUS_STALE_SECONDS = 300


def _configs(profile_path: Path) -> tuple[
    dict[str, Path], Path, Path | None, AlignmentConfig, MeasurementConfig
]:
    profile = load_profile(profile_path)
    defaults = profile.raw.get("captureDefaults", {})
    camera_roots = {
        camera.camera_id: camera.storage_root for camera in profile.enabled_cameras
    }
    alignment = AlignmentConfig(
        search_frames=int(defaults.get("alignmentSearchFrames", 12)),
        stable_rows=int(defaults.get("alignmentStableRows", 8)),
        sample_step=int(defaults.get("alignmentSampleStep", 4)),
        depth_valid_ratio=float(defaults.get("alignmentDepthValidRatio", 0.005)),
        intensity_threshold=float(defaults.get("steelBrightPixelThreshold", 8.0)),
        intensity_ratio=float(defaults.get("steelBrightPixelRatio", 0.02)),
        anchor_interval_frames=int(defaults.get("softSyncAnchorIntervalFrames", 16)),
        maximum_anchor_residual_ms=float(
            defaults.get("softSyncMaximumResidualMs", 40.0)
        ),
    ).bounded()
    measurement = MeasurementConfig(
        row_window=int(defaults.get("measurementRowWindow", 16)),
        maximum_profile_points=int(
            defaults.get("measurementMaximumProfilePoints", 320)
        ),
        maximum_sections=int(defaults.get("measurementMaximumSections", 0)),
        minimum_circle_points=int(defaults.get("measurementMinimumCirclePoints", 48)),
        minimum_camera_profile_points=int(
            defaults.get("measurementMinimumCameraProfilePoints", 8)
        ),
        maximum_circle_residual_mm=float(
            defaults.get("measurementMaximumCircleResidualMm", 0.5)
        ),
    ).bounded()
    calibration_text = str(defaults.get("arrayCalibrationPath", "")).strip()
    calibration_path: Path | None = None
    if calibration_text:
        candidate = Path(os.path.expandvars(calibration_text))
        calibration_path = (
            candidate
            if candidate.is_absolute()
            else profile.source_path.parent / candidate
        )
    return camera_roots, profile.storage_root, calibration_path, alignment, measurement


def _material_ids(camera_roots: dict[str, Path]) -> tuple[list[str], list[str]]:
    sets: list[set[str]] = []
    all_ids: set[str] = set()
    for camera_root in camera_roots.values():
        ids = {
            child.name
            for child in camera_root.iterdir()
            if child.is_dir() and child.name.isdigit()
        }
        sets.append(ids)
        all_ids.update(ids)
    common = set.intersection(*sets) if sets else set()
    incomplete = all_ids - common
    numeric = lambda value: int(value)
    return sorted(common, key=numeric), sorted(incomplete, key=numeric)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _process_is_alive(pid: int) -> bool:
    if pid <= 0 or pid == os.getpid():
        return pid == os.getpid()
    try:
        os.kill(pid, 0)
    except PermissionError:
        # A live process can be inaccessible to the current user.  Treat it as
        # live rather than risking two writers for the same archive.
        return True
    except (ProcessLookupError, OSError):
        return False
    return True


def _lock_owner(payload: dict[str, Any] | None) -> tuple[int, str]:
    if not isinstance(payload, dict):
        return 0, ""
    try:
        pid = int(payload.get("ownerPid", payload.get("pid", 0)) or 0)
    except (TypeError, ValueError):
        pid = 0
    token = str(
        payload.get("ownerStartToken", payload.get("startToken", "")) or ""
    ).strip()
    return pid, token


class JetHistoryLockError(RuntimeError):
    """Raised when another history rebuild owns the archive lock."""


def _stale_lock_archive_path(lock_path: Path, token: str) -> Path:
    return lock_path.with_name(
        f"{lock_path.name}.stale-{int(time.time() * 1000)}-{token[:12]}"
    )


def _acquire_job_lock(lock_path: Path, owner: dict[str, Any]) -> None:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(owner, ensure_ascii=False, indent=2)
    while True:
        try:
            descriptor = os.open(
                lock_path,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                0o600,
            )
        except FileExistsError:
            existing = _read_json(lock_path)
            existing_pid, existing_token = _lock_owner(existing)
            if existing_pid and _process_is_alive(existing_pid):
                raise JetHistoryLockError(
                    "jet history rebuild already running "
                    f"(pid={existing_pid}, startToken={existing_token or 'unknown'})"
                )
            try:
                age_seconds = max(0.0, time.time() - lock_path.stat().st_mtime)
            except OSError:
                age_seconds = 0.0
            if existing_pid or age_seconds >= JOB_LOCK_STALE_SECONDS:
                stale_path = _stale_lock_archive_path(lock_path, owner["runToken"])
                try:
                    # Rename is atomic on the same volume.  If another starter
                    # wins the race, retry the O_EXCL create against its lock.
                    os.replace(lock_path, stale_path)
                except FileNotFoundError:
                    continue
                except OSError as error:
                    raise JetHistoryLockError(
                        f"cannot recover stale history rebuild lock {lock_path}: {error}"
                    ) from error
                continue
            raise JetHistoryLockError(
                f"history rebuild lock {lock_path} exists but its owner is unknown; "
                f"wait at least {JOB_LOCK_STALE_SECONDS}s before retrying"
            )
        except OSError as error:
            raise JetHistoryLockError(
                f"cannot create history rebuild lock {lock_path}: {error}"
            ) from error
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(payload)
                stream.write("\n")
        except BaseException:
            try:
                lock_path.unlink()
            except OSError:
                pass
            raise
        return


def _release_job_lock(lock_path: Path, owner: dict[str, Any]) -> None:
    current = _read_json(lock_path)
    current_pid, current_token = _lock_owner(current)
    if current_pid == int(owner["ownerPid"]) and current_token == owner["ownerStartToken"]:
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


@contextmanager
def _job_lock(status_path: Path, profile_path: Path) -> Iterator[dict[str, Any]]:
    lock_path = status_path.with_suffix(".lock")
    run_token = secrets.token_hex(16)
    owner = {
        "schema": JOB_SCHEMA,
        "ownerPid": os.getpid(),
        "ownerStartToken": secrets.token_hex(16),
        "runToken": run_token,
        "profile": str(profile_path.resolve()),
        "lockPath": str(lock_path),
        "startedAtUnixMs": round(time.time() * 1000),
    }
    _acquire_job_lock(lock_path, owner)
    try:
        yield owner
    finally:
        _release_job_lock(lock_path, owner)


def _status_owner(status: dict[str, Any] | None) -> tuple[int, str]:
    if not isinstance(status, dict):
        return 0, ""
    owner = status.get("owner")
    if isinstance(owner, dict):
        return _lock_owner(owner)
    return _lock_owner(status)


def _status_is_recent(status: dict[str, Any] | None) -> bool:
    if not isinstance(status, dict) or status.get("state") != "running":
        return False
    try:
        updated_ms = int(status.get("updatedAtUnixMs", 0) or 0)
    except (TypeError, ValueError):
        updated_ms = 0
    if updated_ms <= 0:
        return False
    age_seconds = (time.time() * 1000 - updated_ms) / 1000.0
    return 0 <= age_seconds < JOB_STATUS_STALE_SECONDS


def _recover_stale_status(status_path: Path, owner: dict[str, Any]) -> None:
    previous = _read_json(status_path)
    if not isinstance(previous, dict) or previous.get("state") != "running":
        return
    previous_pid, previous_token = _status_owner(previous)
    if previous_pid and _process_is_alive(previous_pid):
        raise JetHistoryLockError(
            "history rebuild status reports a live owner "
            f"(pid={previous_pid}, startToken={previous_token or 'unknown'})"
        )
    if not previous_pid and _status_is_recent(previous):
        # This is the compatibility guard for a job started by the pre-lock
        # script.  It prevents a new invocation from racing a still-live old
        # invocation while its status heartbeat is fresh.
        raise JetHistoryLockError(
            "history rebuild status is fresh but has no owner PID; "
            f"wait at least {JOB_STATUS_STALE_SECONDS}s before retrying"
        )
    recovered = dict(previous)
    now_ms = round(time.time() * 1000)
    recovered.update(
        {
            "state": "aborted",
            "phase": "aborted",
            "abortedReason": "owner-not-running",
            "abortedAtUnixMs": now_ms,
            "recoveredByRunToken": owner["runToken"],
            "updatedAtUnixMs": now_ms,
        }
    )
    atomic_summary(status_path, recovered)


def _flow_region_map(
    storage_root: Path, material_id: str
) -> tuple[dict[str, Any] | None, str]:
    """Read only this flow's region manifest.

    A region manifest contains calibrated crop ownership for a specific flow.
    Falling back to another flow's manifest silently applies the wrong crop and
    also leaves a misleading ``manifestPath`` in the derived surface.  A
    missing/invalid local manifest therefore deliberately returns ``None`` so
    the surface builder uses its per-frame fallback for this flow.
    """

    path = region_path(storage_root, material_id)
    payload = _read_json(path)
    if not payload or not isinstance(payload.get("cameras"), dict):
        return None, ""
    # Do not trust a stale path embedded in a copied manifest.  The source
    # recorded in a rebuilt surface must always be this flow's canonical path.
    local_payload = dict(payload)
    local_payload["manifestPath"] = str(path)
    return local_payload, str(path)


def _surface_region_manifest_path(surface: dict[str, Any]) -> str:
    camera_tiles = surface.get("cameraTiles")
    if not isinstance(camera_tiles, dict):
        return ""
    return str(camera_tiles.get("regionManifestPath", "") or "").strip()


def _surface_uses_local_region_manifest(
    surface: dict[str, Any], local_manifest_path: str
) -> bool:
    current = _surface_region_manifest_path(surface)
    if local_manifest_path:
        try:
            return Path(current).resolve() == Path(local_manifest_path).resolve()
        except OSError:
            return current.casefold() == local_manifest_path.casefold()
    # A surface with no local manifest must not retain a path to another flow.
    return not current


def _source_ready(camera_roots: dict[str, Path], material_id: str) -> tuple[bool, str]:
    for camera_id, camera_root in camera_roots.items():
        root = capture_root(camera_root, material_id, camera_id)
        for directory, suffix in (("2d", ".png"), ("3d", ".npz"), ("json", ".json")):
            path = root / directory
            if not path.is_dir() or next(path.glob(f"*{suffix}"), None) is None:
                return False, f"{camera_id}-{directory}-unavailable"
    return True, ""


def _jet_ready(
    camera_roots: dict[str, Path], storage_root: Path, material_id: str
) -> bool:
    if not surface_path(storage_root, material_id).is_file():
        return False
    for camera_id, camera_root in camera_roots.items():
        flow = capture_root(camera_root, material_id, camera_id)
        sources = sorted(
            path
            for path in (flow / "2d").glob("*.png")
            if path.is_file() and path.stem.isdecimal()
        )
        if not sources:
            return False
        for source in sources:
            storage_index = int(source.stem)
            for modality in ("gray", "jet"):
                metadata_file = rendition_metadata_path(
                    camera_root, material_id, modality, storage_index
                )
                metadata = _read_json(metadata_file)
                expected_algorithm = (
                    GRAY_ALGORITHM if modality == "gray" else JET_ALGORITHM
                )
                if not metadata or metadata.get("algorithm") != expected_algorithm:
                    return False
                for level in ("thumbnail", "original"):
                    if not rendition_image_path(
                        camera_root,
                        material_id,
                        modality,
                        level,
                        storage_index,
                    ).is_file():
                        return False
    return True


def _write_surface_measurement(
    storage_root: Path, material_id: str, surface: dict[str, Any]
) -> Path:
    path = measurement_path(storage_root, material_id)
    atomic_summary(path, measurement_artifact_from_surface(surface))
    return path


def _upgrade_existing_surface(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
) -> dict[str, bool]:
    """Upgrade one complete historical surface under the shared writer lock."""

    if not _jet_ready(camera_roots, storage_root, material_id):
        return {"ready": False, "upgraded": False, "measurementRestored": False}
    with exclusive_material_job(
        storage_root,
        material_id,
        purpose="jet-history-upgrade",
    ):
        surface_file = surface_path(storage_root, material_id)
        surface = _read_json(surface_file)
        _region_map, local_region_path = _flow_region_map(storage_root, material_id)
        if surface is None or not _surface_uses_local_region_manifest(
            surface, local_region_path
        ):
            return {"ready": False, "upgraded": False, "measurementRestored": False}
        usable, changed = upgrade_surface_display_contract(surface)
        if not usable:
            return {"ready": False, "upgraded": False, "measurementRestored": False}
        measurement_file = measurement_path(storage_root, material_id)
        measurement_missing = not measurement_file.is_file()
        if not changed and not measurement_missing:
            return {"ready": True, "upgraded": False, "measurementRestored": False}

        state_path = algorithm_state_path(storage_root, material_id)
        started_at_unix_ms = int(time.time() * 1000)
        atomic_summary(
            state_path,
            {
                "schema": "steel.flow-algorithm-state.v1",
                "flowNo": int(material_id),
                "flowId": material_id,
                "state": "processing",
                "mode": "history-upgrade",
                "startedAtUnixMs": started_at_unix_ms,
            },
        )
        try:
            if changed:
                atomic_summary(surface_file, surface)
            _write_surface_measurement(storage_root, material_id, surface)
        except Exception as error:
            atomic_summary(
                state_path,
                {
                    "schema": "steel.flow-algorithm-state.v1",
                    "flowNo": int(material_id),
                    "flowId": material_id,
                    "state": "failed",
                    "mode": "history-upgrade",
                    "startedAtUnixMs": started_at_unix_ms,
                    "failedAtUnixMs": int(time.time() * 1000),
                    "error": f"{type(error).__name__}: {error}",
                },
            )
            raise
        atomic_summary(
            state_path,
            {
                "schema": "steel.flow-algorithm-state.v1",
                "flowNo": int(material_id),
                "flowId": material_id,
                "state": "derived-ready",
                "mode": "history-upgrade",
                "startedAtUnixMs": started_at_unix_ms,
                "completedAtUnixMs": int(time.time() * 1000),
                "surfacePath": str(surface_file),
                "measurementPath": str(measurement_file),
            },
        )
        return {
            "ready": True,
            "upgraded": changed,
            "measurementRestored": True,
        }


def _rebuild_one(
    camera_roots: dict[str, Path],
    storage_root: Path,
    calibration_path: Path | None,
    alignment_config: AlignmentConfig,
    measurement_config: MeasurementConfig,
    material_id: str,
) -> dict[str, Any]:
    started = time.monotonic()
    region_map: dict[str, Any] | None = None
    region_manifest_path = ""
    ready, reason = _source_ready(camera_roots, material_id)
    if not ready:
        return {
            "materialId": material_id,
            "state": "skipped",
            "reason": reason,
            "regionManifestPath": "",
            "regionMapSource": "none",
            "elapsedSeconds": round(time.monotonic() - started, 3),
        }
    try:
        with exclusive_material_job(
            storage_root,
            material_id,
            purpose="jet-history-rebuild",
        ):
            region_map, region_manifest_path = _flow_region_map(
                storage_root, material_id
            )
            state_path = algorithm_state_path(storage_root, material_id)
            started_at_unix_ms = int(time.time() * 1000)
            atomic_summary(
                state_path,
                {
                    "schema": "steel.flow-algorithm-state.v1",
                    "flowNo": int(material_id),
                    "flowId": material_id,
                    "state": "processing",
                    "mode": "history-rebuild",
                    "startedAtUnixMs": started_at_unix_ms,
                },
            )
            try:
                alignment_path, alignment = build_and_write_flow_alignment(
                    camera_roots,
                    storage_root,
                    material_id,
                    config=alignment_config,
                )
                rebuilt_surface_path, surface = build_and_write_flow_surface(
                    camera_roots,
                    storage_root,
                    material_id,
                    alignment,
                    calibration_path=calibration_path,
                    config=measurement_config,
                    region_map=region_map,
                )
                diameter_path = _write_surface_measurement(
                    storage_root, material_id, surface
                )
                if calibration_path is None:
                    raise ValueError("approved array calibration path is required")
                source_frame_count = 0
                camera_jet_count = 0
                for camera_id, camera_root in sorted(camera_roots.items()):
                    flow = capture_root(camera_root, material_id, camera_id)
                    sources = sorted(
                        (
                            path
                            for path in (flow / "2d").glob("*.png")
                            if path.is_file() and path.stem.isdecimal()
                        ),
                        key=lambda path: int(path.stem),
                    )
                    source_frame_count += len(sources)
                    for source in sources:
                        build_gray_rendition(source)
                        build_jet_rendition(
                            source,
                            camera_id=camera_id,
                            camera_roots=camera_roots,
                            storage_root=storage_root,
                            calibration_path=calibration_path,
                            config=measurement_config,
                        )
                        camera_jet_count += 1
                available = bool(
                    source_frame_count > 0
                    and camera_jet_count == source_frame_count
                )
                completed_state = "derived-ready" if available else "failed"
                atomic_summary(
                    state_path,
                    {
                        "schema": "steel.flow-algorithm-state.v1",
                        "flowNo": int(material_id),
                        "flowId": material_id,
                        "state": completed_state,
                        "mode": "history-rebuild",
                        "startedAtUnixMs": started_at_unix_ms,
                        "completedAtUnixMs": int(time.time() * 1000),
                        "alignmentPath": str(alignment_path),
                        "measurementPath": str(diameter_path),
                        "surfacePath": str(rebuilt_surface_path),
                        "jetRenditionCount": camera_jet_count,
                        "sourceFrameCount": source_frame_count,
                        "error": "" if available else "per-frame-jet-not-produced",
                    },
                )
            except Exception as error:
                atomic_summary(
                    state_path,
                    {
                        "schema": "steel.flow-algorithm-state.v1",
                        "flowNo": int(material_id),
                        "flowId": material_id,
                        "state": "failed",
                        "mode": "history-rebuild",
                        "startedAtUnixMs": started_at_unix_ms,
                        "failedAtUnixMs": int(time.time() * 1000),
                        "error": f"{type(error).__name__}: {error}",
                    },
                )
                raise
        return {
            "materialId": material_id,
            "state": "ready" if available else "unavailable",
            "reason": "" if available else "per-frame-jet-not-produced",
            "regionManifestPath": region_manifest_path,
            "regionMapSource": "flow-local" if region_map else "none",
            "elapsedSeconds": round(time.monotonic() - started, 3),
            "alignmentPath": str(alignment_path),
            "surfacePath": str(rebuilt_surface_path),
            "measurementPath": str(diameter_path),
            "cameraJetCount": camera_jet_count,
            "sourceFrameCount": source_frame_count,
            "displayAligned": bool(
                surface.get("headAlignment", {}).get("displayAligned")
            ),
            "synchronized": bool(
                surface.get("quality", {}).get("geometrySynchronized")
            ),
            "sectionCount": int(surface.get("summary", {}).get("sectionCount", 0)),
            "acceptedSectionCount": int(
                surface.get("summary", {}).get("acceptedSectionCount", 0)
            ),
        }
    except MaterialJobLockedError as error:
        return {
            "materialId": material_id,
            "state": "skipped",
            "reason": f"derived-artifacts-locked: {error}",
            "regionManifestPath": "",
            "regionMapSource": "none",
            "elapsedSeconds": round(time.monotonic() - started, 3),
        }
    except Exception as error:  # Keep the archive batch moving and report the exact flow.
        return {
            "materialId": material_id,
            "state": "failed",
            "reason": str(error),
            "regionManifestPath": region_manifest_path,
            "regionMapSource": "flow-local" if region_map else "none",
            "elapsedSeconds": round(time.monotonic() - started, 3),
        }


def _run(
    args: argparse.Namespace,
    camera_roots: dict[str, Path],
    storage_root: Path,
    calibration_path: Path | None,
    alignment: AlignmentConfig,
    measurement: MeasurementConfig,
    status_path: Path,
    job_owner: dict[str, Any],
) -> int:
    material_ids, incomplete_ids = _material_ids(camera_roots)
    if args.minimum_material > 0:
        material_ids = [
            value for value in material_ids if int(value) >= args.minimum_material
        ]
    if args.maximum_material > 0:
        material_ids = [
            value for value in material_ids if int(value) <= args.maximum_material
        ]
    if not args.oldest_first:
        material_ids.reverse()
    if args.limit > 0:
        material_ids = material_ids[: args.limit]
    started_at = time.time()
    existing_ready = 0
    restored_measurements = 0
    upgraded_surfaces = 0
    upgrade_errors = 0
    if args.skip_ready:
        pending: list[str] = []
        archive_total = len(material_ids)
        for scan_index, material_id in enumerate(material_ids, start=1):
            try:
                upgrade = _upgrade_existing_surface(
                    camera_roots, storage_root, material_id
                )
            except MaterialJobLockedError:
                # _upgrade_existing_surface acquires the material lock only
                # after its authoritative per-frame gray/JET audit succeeds.
                # A managed realtime worker owning the same flow therefore
                # means the rendition set is already complete and is being
                # finalized, not that this resumable job must rebuild it.
                upgrade = {
                    "ready": True,
                    "upgraded": False,
                    "measurementRestored": False,
                    "finalizedByConcurrentWorker": True,
                }
            except (OSError, TypeError, ValueError, IndexError):
                # Keep a malformed historical artifact in the full rebuild
                # queue instead of terminating the archive run.
                upgrade = {"ready": False}
                upgrade_errors += 1
            if upgrade.get("ready"):
                existing_ready += 1
                upgraded_surfaces += int(bool(upgrade.get("upgraded")))
                restored_measurements += int(
                    bool(upgrade.get("measurementRestored"))
                )
            else:
                pending.append(material_id)
            if scan_index == archive_total or scan_index % 25 == 0:
                atomic_summary(
                    status_path,
                    {
                        "schema": "steel.jet-history-rebuild.v1",
                        "state": "running",
                        "phase": "upgrade-existing-surfaces",
                        "owner": job_owner,
                        "profile": str(args.profile.resolve()),
                        "cameraCount": len(camera_roots),
                        "workers": max(1, min(12, int(args.workers))),
                        "archiveTotal": archive_total,
                        "archiveScanned": scan_index,
                        "archiveRemaining": archive_total - scan_index,
                        "existingReady": existing_ready,
                        "upgradedSurfaces": upgraded_surfaces,
                        "restoredMeasurements": restored_measurements,
                        "upgradeErrors": upgrade_errors,
                        "pendingDiscovered": len(pending),
                        "startedAtUnixMs": round(started_at * 1000),
                        "updatedAtUnixMs": round(time.time() * 1000),
                        "elapsedSeconds": round(time.time() - started_at, 3),
                    },
                )
        material_ids = pending
    results: list[dict[str, Any]] = []

    def publish(state: str) -> None:
        counts = {
            name: sum(result.get("state") == name for result in results)
            for name in ("ready", "unavailable", "skipped", "failed")
        }
        atomic_summary(
            status_path,
            {
                "schema": "steel.jet-history-rebuild.v1",
                "state": state,
                "phase": (
                    "complete"
                    if state in {"complete", "complete-with-errors"}
                    else "rebuild-pending-surfaces"
                ),
                "owner": job_owner,
                "profile": str(args.profile.resolve()),
                "cameraCount": len(camera_roots),
                "workers": max(1, min(12, int(args.workers))),
                "total": len(material_ids),
                "completed": len(results),
                "remaining": max(0, len(material_ids) - len(results)),
                "existingReady": existing_ready,
                "restoredMeasurements": restored_measurements,
                "upgradedSurfaces": upgraded_surfaces,
                "upgradeErrors": upgrade_errors,
                "counts": counts,
                "incompleteMaterialIds": incomplete_ids,
                "startedAtUnixMs": round(started_at * 1000),
                "updatedAtUnixMs": round(time.time() * 1000),
                "elapsedSeconds": round(time.time() - started_at, 3),
                "recentResults": results[-100:],
            },
        )

    publish("running")
    workers = max(1, min(12, int(args.workers)))
    with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(
                _rebuild_one,
                camera_roots,
                storage_root,
                calibration_path,
                alignment,
                measurement,
                material_id,
            ): material_id
            for material_id in material_ids
        }
        for future in concurrent.futures.as_completed(futures):
            material_id = futures[future]
            try:
                result = future.result()
            except Exception as error:
                result = {
                    "materialId": material_id,
                    "state": "failed",
                    "reason": str(error),
                    "elapsedSeconds": 0.0,
                }
            results.append(result)
            publish("running")
            print(
                json.dumps(
                    {
                        "event": "jet-history-progress",
                        "completed": len(results),
                        "total": len(material_ids),
                        **result,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

    failed = sum(result.get("state") == "failed" for result in results)
    publish("complete-with-errors" if failed else "complete")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--minimum-material", type=int, default=0)
    parser.add_argument("--maximum-material", type=int, default=0)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--oldest-first", action="store_true")
    parser.add_argument(
        "--skip-ready",
        action="store_true",
        help="Resume without rebuilding materials that already have every per-frame gray/JET rendition.",
    )
    args = parser.parse_args()
    camera_roots, storage_root, calibration_path, alignment, measurement = _configs(
        args.profile
    )
    status_path = storage_root / "system" / "jobs" / "jet-rebuild" / "status.json"
    try:
        with _job_lock(status_path, args.profile) as owner:
            _recover_stale_status(status_path, owner)
            return _run(
                args,
                camera_roots,
                storage_root,
                calibration_path,
                alignment,
                measurement,
                status_path,
                owner,
            )
    except JetHistoryLockError as error:
        print(
            json.dumps(
                {
                    "event": "jet-history-lock-rejected",
                    "error": str(error),
                    "statusPath": str(status_path),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
            flush=True,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
