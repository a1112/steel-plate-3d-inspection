#!/usr/bin/env python3
"""Flow-scoped algorithm loop driven by durable committed-frame events."""

from __future__ import annotations

import argparse
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import replace
import json
import os
import queue
import signal
import threading
import time
import hashlib
from pathlib import Path
from typing import Callable
from urllib import request

from sick_capture.alignment import AlignmentConfig, build_and_write_flow_alignment
from sick_capture.calibration_pointer import resolve_active_array_calibration
from sick_capture.defect_detection import (
    DefectDetectionConfig,
    ExecutionGateInterrupted,
    _capture_is_idle,
    build_and_write_flow_defect_detection,
    configured_legacy_model_hash,
    defect_detection_manifest_path,
)
from sick_capture.depth_geometry_runtime import (
    DepthGeometryConfigChanged,
    backfill_is_paused,
    load_depth_geometry_config_snapshot,
)
from sick_capture.measurement import MeasurementConfig, build_and_write_flow_measurement
from sick_capture.material_lock import exclusive_material_job
from sick_capture.paths import (
    LAYOUT_SCHEMA,
    alignment_path as canonical_alignment_path,
    acquisition_manifest_path,
    algorithm_state_path,
    capture_flow_handoff_path,
    defect_report_path,
    frame_event_root,
    frame_event_path,
    flow_manifest_path,
    image_result_path,
    measurement_path as canonical_measurement_path,
    playback_index_path as canonical_playback_index_path,
    region_path as canonical_region_path,
    surface_path as canonical_surface_path,
)
from sick_capture.playback import build_and_write_playback_index
from sick_capture.profile import load_profile
from sick_capture.regions import build_and_write_flow_region_map
from sick_capture.storage import atomic_summary
from sick_capture.surface import (
    build_and_write_flow_surface,
    measurement_artifact_from_surface,
)


HISTORY_CURSOR_SCHEMA = "steel.flow-analysis-history-cursor.v1"
HISTORY_CURSOR_FILENAME = "history-cursor.json"
DEPTH_HISTORY_CURSOR_SCHEMA = "steel.depth-geometry-history-cursor.v1"
DEPTH_HISTORY_CURSOR_FILENAME = "depth-geometry-history-cursor.json"
DEFAULT_MAXIMUM_DEFECT_BACKLOG = 64
CAPTURE_FLOW_HANDOFF_SCHEMA = "steel.capture-flow-handoff.v1"
_COMMITTED_SIGNATURE_CACHE_LOCK = threading.Lock()
_COMMITTED_SIGNATURE_CACHE: dict[
    tuple[str, str], tuple[int, tuple[int, int, int]]
] = {}


def _remember_committed_signature(
    cache_key: tuple[str, str],
    manifest_round: int,
    signature: tuple[int, int, int],
) -> tuple[int, int, int]:
    with _COMMITTED_SIGNATURE_CACHE_LOCK:
        _COMMITTED_SIGNATURE_CACHE[cache_key] = (manifest_round, signature)
    return signature


def _recorded_checkpoint_for_event(
    storage_root: Path,
    material_id: str,
    capture_round: int,
    event_mtime_ns: int,
) -> tuple[int, int, int] | None:
    """Preserve checkpoint identity across old and new event-count strategies."""
    try:
        state = json.loads(
            algorithm_state_path(storage_root, material_id).read_text(
                encoding="utf-8-sig"
            )
        )
        recorded = (
            int(state.get("committedEventCount", -1)),
            int(state.get("latestCommittedRound", -1)),
            int(state.get("latestCommittedEventMtimeNs", -1)),
        )
        if (
            recorded[0] > 0
            and recorded[1] == capture_round
            and recorded[2] == event_mtime_ns
        ):
            return recorded
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    return None


def lower_process_priority() -> str:
    """Keep all derived work below the AboveNormal GenTL capture process."""
    try:
        if os.name == "nt":
            import ctypes

            below_normal_priority_class = 0x00004000
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.GetCurrentProcess.restype = ctypes.c_void_p
            kernel32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            kernel32.SetPriorityClass.restype = ctypes.c_int
            if not kernel32.SetPriorityClass(
                kernel32.GetCurrentProcess(), below_normal_priority_class
            ):
                raise OSError(ctypes.get_last_error(), "SetPriorityClass failed")
            return "below-normal"
        os.nice(10)
        return "nice+10"
    except (AttributeError, OSError, ValueError):
        return "unchanged"


def _per_camera_routed_signature(
    root: Path,
) -> tuple[int, int, int] | None:
    """Checkpoint an intentional set of partial per-camera round events.

    A free-running array cannot require six cameras to cross a material edge
    in the same capture round. These events are partial by design, but every
    persisted frame must carry the positive local material signal and the
    camera-routing phase. Any ordinary/legacy partial event still fails this
    contract and remains excluded from algorithm input.
    """

    events = sorted(
        (path for path in root.glob("*.json") if path.stem.isdecimal()),
        key=lambda path: int(path.stem),
    )
    if not events:
        return None
    for path in events:
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
            capture_round = int(payload.get("captureRound", -1))
            frames = payload.get("frames")
            if (
                payload.get("schema") != "steel.capture-frame-committed.v1"
                or capture_round != int(path.stem)
                or not str(payload.get("boundaryPhase", "")).startswith("camera-")
                or not isinstance(frames, list)
                or not frames
                or any(
                    not isinstance(frame, dict)
                    or frame.get("materialSignal") is not True
                    for frame in frames
                )
            ):
                return None
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return None
    latest = events[-1]
    return len(events), int(latest.stem), latest.stat().st_mtime_ns


def committed_signature(
    storage_root: Path, material_id: str
) -> tuple[int, int, int] | None:
    """Read only the durable capture-to-algorithm hand-off contract."""
    root = frame_event_root(storage_root, material_id)
    if not root.is_dir():
        return None

    # Capture publishes the latest committed round in flow.json.  Resolve that
    # event directly before falling back to a directory scan: a production
    # flow contains thousands of event files, and enumerating 128 completed
    # flows on every poll can delay a newly closed bar by several minutes.
    cache_key = (str(Path(storage_root).resolve()), material_id)
    explicit_complete_round = False
    manifest: dict[str, object] = {}
    try:
        manifest = json.loads(
            flow_manifest_path(storage_root, material_id).read_text(
                encoding="utf-8-sig"
            )
        )
        manifest_round = int(manifest.get("latestCommittedRound", -1))
        explicit_value = manifest.get("latestCompleteCommittedRound")
        explicit_complete_round = explicit_value is not None
        latest_round = int(explicit_value) if explicit_complete_round else manifest_round
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        manifest_round = -1
        latest_round = -1
    with _COMMITTED_SIGNATURE_CACHE_LOCK:
        cached_row = _COMMITTED_SIGNATURE_CACHE.get(cache_key)
    if cached_row is not None and manifest_round < cached_row[0]:
        cached_row = None
    routed_policy = (
        str(manifest.get("boundaryPolicy", ""))
        == "global-reference-id+per-camera-one-round-boundary"
    )
    if not routed_policy and str(manifest.get("state", "")).lower() == "closed":
        try:
            latest_payload = json.loads(
                frame_event_path(
                    storage_root, material_id, manifest_round
                ).read_text(encoding="utf-8-sig")
            )
            routed_policy = str(
                latest_payload.get("boundaryPhase", "")
            ).startswith("camera-")
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            routed_policy = False
    if routed_policy:
        if cached_row is not None and cached_row[0] == manifest_round:
            return cached_row[1]
        routed_signature = _per_camera_routed_signature(root)
        if routed_signature is not None:
            return _remember_committed_signature(
                cache_key, manifest_round, routed_signature
            )
    if latest_round >= 0:
        latest = frame_event_path(storage_root, material_id, latest_round)
        try:
            payload = json.loads(latest.read_text(encoding="utf-8-sig"))
            frames = payload.get("frames")
            expected_count = int(payload.get("expectedCameraCount", 0) or 0)
            committed_count = int(payload.get("committedCameraCount", 0) or 0)
            if (
                payload.get("schema") == "steel.capture-frame-committed.v1"
                and int(payload.get("captureRound", -1)) == latest_round
                and payload.get("complete") is True
                and isinstance(frames, list)
                and frames
                and expected_count > 0
                and committed_count == expected_count
                and len(frames) == expected_count
                and not payload.get("missingCameraIds")
            ):
                latest_mtime_ns = latest.stat().st_mtime_ns
                # A completed algorithm checkpoint carries the exact event
                # count. Reuse it when it names this immutable latest event.
                recorded = _recorded_checkpoint_for_event(
                    storage_root,
                    material_id,
                    latest_round,
                    latest_mtime_ns,
                )
                if recorded is not None:
                    return _remember_committed_signature(
                        cache_key, manifest_round, recorded
                    )

                # Per-camera sequence numbers are flow-local and start at one;
                # their maximum is therefore the committed event count.  This
                # lets a brand-new flow take the same constant-time path.
                sequence_counts = []
                for frame in frames:
                    if not isinstance(frame, dict):
                        continue
                    try:
                        sequence = int(frame.get("sequenceNo", 0) or 0)
                        storage_count = int(frame.get("storageIndex", -1)) + 1
                    except (ValueError, TypeError):
                        continue
                    sequence_counts.extend(
                        value for value in (sequence, storage_count) if value > 0
                    )
                if sequence_counts:
                    return _remember_committed_signature(
                        cache_key,
                        manifest_round,
                        (max(sequence_counts), latest_round, latest_mtime_ns),
                    )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass

        # Rolling-upgrade compatibility: old flow manifests name a partial
        # latest tail without preserving the newest complete round. Probe by
        # numeric path for a bounded distance before using the expensive full
        # directory enumeration recovery path.
        cached_manifest_round = cached_row[0] if cached_row is not None else -1
        cache_covers_gap = bool(
            cached_row is not None
            and not explicit_complete_round
            and 0 <= manifest_round - cached_manifest_round <= 4096
        )
        lower_round = (
            cached_manifest_round
            if cache_covers_gap
            else max(-1, latest_round - 4096)
        )
        for candidate_round in range(latest_round - 1, lower_round, -1):
            candidate = frame_event_path(storage_root, material_id, candidate_round)
            if not candidate.is_file():
                continue
            try:
                payload = json.loads(candidate.read_text(encoding="utf-8-sig"))
                frames = payload.get("frames")
                expected_count = int(payload.get("expectedCameraCount", 0) or 0)
                committed_count = int(payload.get("committedCameraCount", 0) or 0)
                if (
                    payload.get("schema") != "steel.capture-frame-committed.v1"
                    or int(payload.get("captureRound", -1)) != candidate_round
                    or payload.get("complete") is not True
                    or not isinstance(frames, list)
                    or not frames
                    or expected_count <= 0
                    or committed_count != expected_count
                    or len(frames) != expected_count
                    or payload.get("missingCameraIds")
                ):
                    continue
                candidate_mtime_ns = candidate.stat().st_mtime_ns
                recorded = _recorded_checkpoint_for_event(
                    storage_root,
                    material_id,
                    candidate_round,
                    candidate_mtime_ns,
                )
                if recorded is not None:
                    return _remember_committed_signature(
                        cache_key, manifest_round, recorded
                    )
                sequence_counts = []
                for frame in frames:
                    if not isinstance(frame, dict):
                        continue
                    try:
                        sequence = int(frame.get("sequenceNo", 0) or 0)
                        storage_count = int(frame.get("storageIndex", -1)) + 1
                    except (ValueError, TypeError):
                        continue
                    sequence_counts.extend(
                        value for value in (sequence, storage_count) if value > 0
                    )
                if sequence_counts:
                    return _remember_committed_signature(
                        cache_key,
                        manifest_round,
                        (
                            max(sequence_counts),
                            candidate_round,
                            candidate_mtime_ns,
                        ),
                    )
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                continue
        if cache_covers_gap and cached_row is not None:
            cached_signature = cached_row[1]
            # The image worker may publish its checkpoint after another worker
            # cached this immutable event. Reconcile the cached count with the
            # durable checkpoint before returning it, otherwise workers can
            # disagree about event counts while naming the same round/mtime.
            recorded = _recorded_checkpoint_for_event(
                storage_root,
                material_id,
                cached_signature[1],
                cached_signature[2],
            )
            if recorded is not None:
                cached_signature = recorded
            return _remember_committed_signature(
                cache_key,
                manifest_round,
                cached_signature,
            )

    # Compatibility/recovery path for incomplete manifests and partial tail
    # events.  It deliberately finds the newest complete event, so an
    # auditable partial write can never advance the algorithm checkpoint.
    events = sorted(
        (path for path in root.glob("*.json") if path.stem.isdecimal()),
        key=lambda path: int(path.stem),
    )
    if not events:
        return None
    # A storage round can be published as partial so its failure is auditable,
    # but it must not advance a six-camera algorithm pass. Find the newest
    # complete event; later partial events therefore leave the signature
    # unchanged and cannot make derived data look synchronized when it is not.
    for event_index in range(len(events) - 1, -1, -1):
        latest = events[event_index]
        try:
            payload = json.loads(latest.read_text(encoding="utf-8-sig"))
            if payload.get("schema") != "steel.capture-frame-committed.v1":
                continue
            capture_round = int(payload.get("captureRound", latest.stem))
            if capture_round != int(latest.stem) or payload.get("complete") is not True:
                continue
            frames = payload.get("frames")
            expected_count = int(payload.get("expectedCameraCount", 0) or 0)
            committed_count = int(payload.get("committedCameraCount", 0) or 0)
            if (
                not isinstance(frames, list)
                or not frames
                or expected_count <= 0
                or committed_count != expected_count
                or len(frames) != expected_count
                or payload.get("missingCameraIds")
            ):
                continue
            latest_mtime_ns = latest.stat().st_mtime_ns
            recorded = _recorded_checkpoint_for_event(
                storage_root,
                material_id,
                capture_round,
                latest_mtime_ns,
            )
            if recorded is not None:
                return _remember_committed_signature(
                    cache_key, manifest_round, recorded
                )
            sequence_counts = []
            for frame in frames:
                if not isinstance(frame, dict):
                    continue
                try:
                    sequence = int(frame.get("sequenceNo", 0) or 0)
                    storage_count = int(frame.get("storageIndex", -1)) + 1
                except (ValueError, TypeError):
                    continue
                sequence_counts.extend(
                    value for value in (sequence, storage_count) if value > 0
                )
            event_count = max(sequence_counts) if sequence_counts else event_index + 1
            return _remember_committed_signature(
                cache_key,
                manifest_round,
                (event_count, capture_round, latest_mtime_ns),
            )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            continue
    return None


def _signature_fields(signature: tuple[int, int, int] | None) -> dict[str, int]:
    if signature is None:
        return {}
    return {
        "committedEventCount": int(signature[0]),
        "latestCommittedRound": int(signature[1]),
        "latestCommittedEventMtimeNs": int(signature[2]),
    }


def fast_artifacts_ready(
    storage_root: Path,
    material_id: str,
    signature: tuple[int, int, int],
) -> bool:
    """Recognize a durable final-fast checkpoint after process restart."""
    state_path = algorithm_state_path(storage_root, material_id)
    try:
        state = json.loads(state_path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False
    if not isinstance(state, dict):
        return False
    try:
        recorded = (
            int(state.get("committedEventCount", -1)),
            int(state.get("latestCommittedRound", -1)),
            int(state.get("latestCommittedEventMtimeNs", -1)),
        )
    except (TypeError, ValueError):
        return False
    if recorded != signature:
        return False
    if str(state.get("state", "")) not in {
        "queued-for-defect",
        "processing-defects",
        "ready",
        "failed",
    }:
        return False
    return all(
        path.is_file()
        for path in (
            canonical_alignment_path(storage_root, material_id),
            canonical_measurement_path(storage_root, material_id),
            canonical_region_path(storage_root, material_id),
            canonical_surface_path(storage_root, material_id),
            canonical_playback_index_path(storage_root, material_id),
        )
    )


def defect_artifact_complete(
    storage_root: Path,
    material_id: str,
    expected_geometry_config_hash: str | None = None,
    expected_legacy_model_hash: str | None = None,
    expected_capture_signature: tuple[int, int, int] | None = None,
) -> bool:
    """A failed database import is retryable and is not a completed defect job."""
    path = defect_detection_manifest_path(storage_root, material_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False
    if not isinstance(payload, dict) or payload.get("state") in {
        "blocked",
        "database-write-failed",
        "failed",
    }:
        return False
    if expected_geometry_config_hash:
        geometry = payload.get("defectGroups", {}).get("geometry", {})
        if not isinstance(geometry, dict) or (
            str(geometry.get("configHash", "")) != expected_geometry_config_hash
        ) or str(geometry.get("state", "")).lower() in {
            "deferred",
            "failed",
            "queued",
            "unavailable",
            "database-write-failed",
        }:
            return False
    if expected_legacy_model_hash:
        legacy = payload.get("defectGroups", {}).get("legacy", {})
        if not isinstance(legacy, dict) or (
            str(legacy.get("modelHash", "")) != expected_legacy_model_hash
        ) or str(legacy.get("state", "")).lower() in {
            "failed",
            "unavailable",
            "database-write-failed",
        }:
            return False
    if expected_capture_signature is not None:
        try:
            algorithm = json.loads(
                algorithm_state_path(storage_root, material_id).read_text(
                    encoding="utf-8-sig"
                )
            )
            recorded_signature = (
                int(algorithm.get("committedEventCount", -1)),
                int(algorithm.get("latestCommittedRound", -1)),
                int(algorithm.get("latestCommittedEventMtimeNs", -1)),
            )
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return False
        if (
            recorded_signature != expected_capture_signature
            or str(algorithm.get("state", "")).lower() != "ready"
            or str(algorithm.get("mode", "")).lower() != "final"
        ):
            return False
    return payload.get("databaseImport", {}).get("state") not in {"failed", "partial"}


def flow_state(storage_root: Path, material_id: str) -> str | None:
    path = flow_manifest_path(storage_root, material_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        if payload.get("schema") != LAYOUT_SCHEMA:
            return None
        return str(payload.get("state", ""))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def prioritize_materials(
    materials: list[str], priority_material_ids: list[str], limit: int
) -> list[str]:
    """Prepend capture-owned hints without duplicating the history catalog."""
    result: list[str] = []
    seen: set[str] = set()
    for value in [*priority_material_ids, *materials]:
        material_id = str(value).strip()
        if not material_id.isdecimal() or int(material_id) <= 0:
            continue
        canonical_id = str(int(material_id))
        if canonical_id in seen:
            continue
        seen.add(canonical_id)
        result.append(canonical_id)
        if len(result) >= max(1, limit):
            break
    return result


def recent_materials(
    first_root: Path,
    limit: int,
    priority_material_ids: list[str] | None = None,
) -> list[str]:
    try:
        rows = [
            path
            for path in first_root.iterdir()
            if path.is_dir() and path.name.isdigit()
        ]
    except OSError:
        rows = []
    # Numeric order remains a compatibility fallback for old storage. The
    # capture hand-off is authoritative because production flow ids can reset.
    rows.sort(key=lambda path: int(path.name), reverse=True)
    return prioritize_materials(
        [path.name for path in rows[: max(1, limit)]],
        list(priority_material_ids or []),
        limit,
    )


def processed_snapshot_is_current(
    storage_root: Path,
    material_id: str,
    processed_row: tuple[tuple[int, int, int], str] | None,
    signature: tuple[int, int, int],
    state: str,
) -> bool:
    """Reject a process-local shortcut when another worker overwrote it.

    Image and defect roles intentionally run in parallel and share the final
    algorithm-state checkpoint. During a rolling upgrade, an older defect
    worker can publish a stale complete-round signature after the image role
    already accepted all per-camera routed events. A closed-flow cache hit is
    therefore valid only while the durable fast artifacts still name the same
    signature.
    """

    if processed_row != (signature, state):
        return False
    return state != "closed" or fast_artifacts_ready(
        storage_root,
        material_id,
        signature,
    )


def capture_flow_hints(storage_root: Path) -> list[str]:
    """Read durable hints, finalizing closed flows before live snapshots.

    The capture process publishes newest-first. Under a continuous stream,
    always taking that first row can repeatedly analyze a still-capturing bar
    while an older flow's late per-camera tail remains absent from its final
    result. Closed rows are therefore returned oldest-first (bounded FIFO),
    followed by capturing rows newest-first.
    """
    try:
        payload = json.loads(
            capture_flow_handoff_path(storage_root).read_text(encoding="utf-8-sig")
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return []
    if payload.get("schema") != CAPTURE_FLOW_HANDOFF_SCHEMA:
        return []
    raw_rows = payload.get("flows", [])
    if not isinstance(raw_rows, list):
        return []
    rows = [row for row in raw_rows if isinstance(row, dict)]
    closed = [
        str(row.get("materialId", ""))
        for row in reversed(rows)
        if str(row.get("state", "")).lower() == "closed"
    ]
    capturing = [
        str(row.get("materialId", ""))
        for row in rows
        if str(row.get("state", "")).lower() != "closed"
    ]
    return prioritize_materials(
        [],
        [*closed, *capturing],
        32,
    )


def playback_catalog_hint(storage_root: Path) -> str:
    """Bootstrap rolling upgrades from the last generated playback catalog."""
    try:
        payload = json.loads(
            (Path(storage_root) / "catalog.json").read_text(encoding="utf-8-sig")
        )
        if payload.get("schema") != "steel.capture-playback-catalog.v1":
            return ""
        rows = payload.get("materials", [])
        if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
            return ""
        material_id = str(rows[0].get("materialId", "")).strip()
        return (
            str(int(material_id))
            if material_id.isdecimal() and int(material_id) > 0
            else ""
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return ""


def capture_service_material_hint(capture_origin: str) -> str:
    """Support a capture process that has not yet been restarted after upgrade."""
    origin = str(capture_origin).strip().rstrip("/")
    if not origin:
        return ""
    try:
        with request.urlopen(f"{origin}/api/steel/status", timeout=0.5) as response:
            payload = json.loads(response.read().decode("utf-8-sig"))
        material_id = str(payload.get("materialId", "")).strip()
        return (
            str(int(material_id))
            if material_id.isdecimal() and int(material_id) > 0
            else ""
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return ""


def algorithm_lag_snapshot(storage_root: Path, material_id: str) -> dict[str, object]:
    """Measure how far the accepted algorithm input trails durable capture."""
    capture_signature = committed_signature(storage_root, material_id)
    snapshot: dict[str, object] = {
        "materialId": material_id,
        "measuredAtUnixMs": int(time.time() * 1000),
        "flowState": flow_state(storage_root, material_id),
        "captureCommittedEventCount": None,
        "latestCaptureRound": None,
        "latestCaptureEventUnixMs": None,
        "algorithmState": None,
        "algorithmMode": None,
        "algorithmCommittedEventCount": None,
        "latestAlgorithmRound": None,
        "captureToAlgorithmLagEvents": None,
        "captureToAlgorithmLagRounds": None,
        "captureToAlgorithmLagMs": None,
        "inputAccepted": False,
        "resultCaughtUp": False,
    }
    if capture_signature is None:
        return snapshot
    snapshot.update(
        {
            "captureCommittedEventCount": capture_signature[0],
            "latestCaptureRound": capture_signature[1],
            "latestCaptureEventUnixMs": capture_signature[2] // 1_000_000,
        }
    )
    try:
        state = json.loads(
            algorithm_state_path(storage_root, material_id).read_text(
                encoding="utf-8-sig"
            )
        )
        algorithm_signature = (
            int(state.get("committedEventCount", -1)),
            int(state.get("latestCommittedRound", -1)),
            int(state.get("latestCommittedEventMtimeNs", -1)),
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return snapshot
    algorithm_state = str(state.get("state", ""))
    exact = algorithm_signature == capture_signature
    snapshot.update(
        {
            "algorithmState": algorithm_state or None,
            "algorithmMode": str(state.get("mode", "")) or None,
            "algorithmCommittedEventCount": max(0, algorithm_signature[0]),
            "latestAlgorithmRound": max(0, algorithm_signature[1]),
            "captureToAlgorithmLagEvents": max(
                0, capture_signature[0] - max(0, algorithm_signature[0])
            ),
            "captureToAlgorithmLagRounds": max(
                0, capture_signature[1] - max(0, algorithm_signature[1])
            ),
            "captureToAlgorithmLagMs": max(
                0,
                (capture_signature[2] - max(0, algorithm_signature[2])) // 1_000_000,
            ),
            "inputAccepted": exact,
            "resultCaughtUp": exact
            and not algorithm_state.startswith("processing")
            and algorithm_state != "failed",
        }
    )
    return snapshot


def analysis_snapshot_accepted(
    signature: tuple[int, int, int],
    state: str,
    after_signature: tuple[int, int, int] | None,
    after_state: str | None,
) -> bool:
    """Accept a coherent live snapshot even if capture advanced while it ran."""
    if after_state != state:
        return False
    return state == "capturing" or after_signature == signature


def defect_queue_tier(*, history: bool, capture_priority: bool) -> int:
    """Keep capture hand-off flows ahead of numeric recent and history work."""
    if capture_priority:
        return -1
    return 1 if history else 0


def all_materials(first_root: Path) -> list[str]:
    """Return the numeric flow catalog in ascending durable-id order.

    The catalog is intentionally kept as a bounded list of ids, not as a
    queue of work.  A flow is inspected only when the round-robin cursor lands
    on it, so a large history cannot enqueue thousands of analyses at once.
    """
    try:
        rows = [
            path.name
            for path in first_root.iterdir()
            if path.is_dir() and path.name.isdigit()
        ]
    except OSError:
        return []
    rows.sort(key=int)
    return rows


def history_cursor_path(storage_root: Path) -> Path:
    return (
        Path(storage_root)
        / "system"
        / "jobs"
        / "flow-analysis"
        / HISTORY_CURSOR_FILENAME
    )


def load_history_cursor(storage_root: Path) -> str:
    """Load the last inspected id; a missing/corrupt cursor starts at oldest."""
    try:
        payload = json.loads(
            history_cursor_path(storage_root).read_text(encoding="utf-8-sig")
        )
        if (
            isinstance(payload, dict)
            and payload.get("schema") == HISTORY_CURSOR_SCHEMA
            and str(payload.get("lastScannedMaterialId", "")).isdigit()
        ):
            return str(int(payload["lastScannedMaterialId"]))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    return ""


def save_history_cursor(
    storage_root: Path,
    material_id: str,
    *,
    catalog_count: int,
    checked_count: int,
) -> None:
    """Persist a small checkpoint after each historical candidate inspection."""
    atomic_summary(
        history_cursor_path(storage_root),
        {
            "schema": HISTORY_CURSOR_SCHEMA,
            "updatedAtUnixMs": int(time.time() * 1000),
            "lastScannedMaterialId": str(material_id),
            "catalogCount": max(0, int(catalog_count)),
            "checkedCount": max(0, int(checked_count)),
        },
    )


def next_history_material(
    materials: list[str],
    last_scanned_material_id: str,
    excluded: set[str] | None = None,
) -> str | None:
    """Return one round-robin id after the persisted cursor.

    ``materials`` must be ascending numeric ids.  The cursor is an id rather
    than an array offset, so insertion of a newer flow cannot invalidate a
    restart checkpoint.  ``excluded`` is used for the recent realtime window.
    """
    if not materials:
        return None
    excluded_ids = excluded or set()
    try:
        cursor = int(last_scanned_material_id)
    except (TypeError, ValueError):
        cursor = -1
    start = 0
    for index, material_id in enumerate(materials):
        if int(material_id) > cursor:
            start = index
            break
    else:
        start = 0
    for offset in range(len(materials)):
        candidate = materials[(start + offset) % len(materials)]
        if candidate not in excluded_ids:
            return candidate
    return None


def depth_history_cursor_path(storage_root: Path) -> Path:
    return (
        Path(storage_root)
        / "system"
        / "jobs"
        / "depth-geometry-backfill"
        / DEPTH_HISTORY_CURSOR_FILENAME
    )


def load_depth_history_cursor(
    storage_root: Path,
    config_hash: str,
    legacy_model_hash: str = "",
) -> str:
    try:
        payload = json.loads(
            depth_history_cursor_path(storage_root).read_text(encoding="utf-8-sig")
        )
        if (
            isinstance(payload, dict)
            and payload.get("schema") == DEPTH_HISTORY_CURSOR_SCHEMA
            and payload.get("configHash") == config_hash
            and (
                not legacy_model_hash
                or payload.get("legacyModelHash") == legacy_model_hash
            )
            and str(payload.get("lastScannedMaterialId", "")).isdigit()
        ):
            return str(int(payload["lastScannedMaterialId"]))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    return ""


def save_depth_history_cursor(
    storage_root: Path,
    material_id: str,
    config_hash: str,
    *,
    revision: int,
    catalog_count: int,
    checked_count: int,
    legacy_model_hash: str = "",
) -> None:
    atomic_summary(
        depth_history_cursor_path(storage_root),
        {
            "schema": DEPTH_HISTORY_CURSOR_SCHEMA,
            "updatedAtUnixMs": int(time.time() * 1000),
            "configHash": config_hash,
            "legacyModelHash": legacy_model_hash or None,
            "algorithmRevision": revision,
            "lastScannedMaterialId": str(material_id),
            "catalogCount": max(0, int(catalog_count)),
            "checkedCount": max(0, int(checked_count)),
            "order": "newest-first",
        },
    )


def next_depth_history_material(
    materials: list[str],
    last_scanned_material_id: str,
    excluded: set[str] | None = None,
) -> str | None:
    """Return the next newest-first history id, wrapping after the oldest."""
    if not materials:
        return None
    excluded_ids = excluded or set()
    descending = sorted(materials, key=int, reverse=True)
    try:
        cursor = int(last_scanned_material_id)
    except (TypeError, ValueError):
        cursor = 2**63 - 1
    ordered = [value for value in descending if int(value) < cursor]
    ordered.extend(value for value in descending if int(value) >= cursor)
    for candidate in ordered:
        if candidate not in excluded_ids:
            return candidate
    return None


def notify_region_commit(
    database_origin: str,
    material_id: str,
    path: Path,
    regions: dict[str, object],
) -> None:
    origin = database_origin.strip().rstrip("/")
    if not origin:
        return
    payload = json.dumps(
        {
            "schema": "steel.capture-region-commit.v1",
            "materialId": material_id,
            "manifestPath": str(path),
            "manifestSha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "regions": regions,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    message = request.Request(
        f"{origin}/internal/v1/capture-regions",
        method="POST",
        data=payload,
        headers={"Content-Type": "application/json", "Connection": "close"},
    )
    with request.urlopen(message, timeout=5.0) as response:
        result = json.loads(response.read().decode("utf-8"))
    if int(result.get("code", 500)) != 0:
        raise RuntimeError(str(result.get("error", "region commit rejected")))


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _artifact(kind: str, path: Path) -> dict[str, object]:
    if not path.is_file():
        raise FileNotFoundError(f"required {kind} artifact is missing: {path}")
    return {
        "kind": kind,
        "uri": path.resolve().as_uri(),
        "path": str(path),
        "size": path.stat().st_size,
        "sha256": _sha256_file(path),
    }


def publish_image_result(
    storage_root: Path,
    material_id: str,
    source_manifest: Path,
    artifacts: list[tuple[str, Path]],
    *,
    complete: bool,
) -> tuple[Path, dict[str, object]]:
    if not source_manifest.is_file():
        raise FileNotFoundError(f"capture manifest is missing: {source_manifest}")
    path = image_result_path(storage_root, material_id)
    payload: dict[str, object] = {
        "schema": "steel.image-result.v1",
        "inspectionId": material_id,
        "sourceManifest": str(source_manifest),
        "sourceManifestSha256": _sha256_file(source_manifest),
        "artifacts": [_artifact(kind, artifact_path) for kind, artifact_path in artifacts],
        "complete": complete,
        "productionCameraPipeline": True,
    }
    atomic_summary(path, payload)
    return path, payload


def publish_defect_report(
    storage_root: Path,
    material_id: str,
    defect_manifest: Path,
    defects: dict[str, object],
) -> tuple[Path, dict[str, object]]:
    image_path = image_result_path(storage_root, material_id)
    if not image_path.is_file():
        raise FileNotFoundError(f"image result is missing: {image_path}")
    path = defect_report_path(storage_root, material_id)
    defect_rows = defects.get("defects", [])
    payload: dict[str, object] = {
        "schema": "steel.defect-report.v1",
        "inspectionId": material_id,
        "imageResult": str(image_path),
        "imageResultSha256": _sha256_file(image_path),
        "sourceDefectManifest": _artifact("defect-manifest", defect_manifest),
        "defects": defect_rows if isinstance(defect_rows, list) else [],
        "complete": defects.get("state") in {"ready", "complete", "degraded"},
        "state": defects.get("state"),
        "productionCameraPipeline": True,
    }
    atomic_summary(path, payload)
    return path, payload


def _analyze_impl(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment_config: AlignmentConfig,
    measurement_config: MeasurementConfig,
    defect_detection_config: DefectDetectionConfig,
    calibration_path: Path | None,
    database_origin: str,
    *,
    final: bool,
    include_defects: bool = True,
    committed_event_signature: tuple[int, int, int] | None = None,
) -> None:
    alignment_path, alignment = build_and_write_flow_alignment(
        camera_roots,
        storage_root,
        material_id,
        config=alignment_config,
    )
    measurement_path, measurement = build_and_write_flow_measurement(
        camera_roots,
        storage_root,
        material_id,
        alignment,
        calibration_path=calibration_path,
        # Keep the prerequisite crop pass small. The surface pass below owns
        # all-anchor fitting and replaces every diameter field atomically.
        config=replace(measurement_config, maximum_sections=1),
    )
    region_path, regions = build_and_write_flow_region_map(
        camera_roots,
        storage_root,
        material_id,
        measurement,
    )
    notify_region_commit(database_origin, material_id, region_path, regions)
    surface_path, surface = build_and_write_flow_surface(
        camera_roots,
        storage_root,
        material_id,
        alignment,
        calibration_path=calibration_path,
        config=measurement_config,
        region_map=regions,
    )
    measurement = measurement_artifact_from_surface(surface, measurement)
    measurement["surface"] = {
        "path": str(surface_path),
        "state": surface.get("state"),
        "quality": surface.get("quality"),
        "depthPrecision": surface.get("depthPrecision"),
        "calibrationAccuracy": surface.get("calibrationAccuracy"),
        "summary": surface.get("summary"),
    }
    atomic_summary(measurement_path, measurement)
    playback_path, playback = build_and_write_playback_index(
        camera_roots,
        storage_root,
        material_id,
    )
    image_artifacts = [
        ("alignment", alignment_path),
        ("measurement", measurement_path),
        ("region-map", region_path),
        ("surface", surface_path),
        ("playback-index", playback_path),
    ]
    source_manifest = acquisition_manifest_path(storage_root, material_id)
    if not source_manifest.is_file():
        # Compatibility for flows captured before acquisition-manifest.v1 was
        # enabled. New production captures always use the contract manifest.
        source_manifest = flow_manifest_path(storage_root, material_id)
    image_contract_path, _ = publish_image_result(
        storage_root,
        material_id,
        source_manifest,
        image_artifacts,
        complete=final,
    )
    defect_path: Path | None = None
    defect_contract_path: Path | None = None
    defects: dict[str, object] = {"state": "waiting-for-flow-close", "statistics": {"defectCount": 0}}
    if final and include_defects:
        defect_path, defects = build_and_write_flow_defect_detection(
            camera_roots,
            storage_root,
            material_id,
            alignment,
            config=defect_detection_config,
        )
        defect_contract_path, _ = publish_defect_report(
            storage_root, material_id, defect_path, defects
        )
    state_path = algorithm_state_path(storage_root, material_id)
    atomic_summary(
        state_path,
        {
            "schema": "steel.flow-algorithm-state.v1",
            "flowNo": int(material_id),
            "flowId": material_id,
            "state": (
                "ready"
                if final and include_defects
                else "queued-for-defect"
                if final
                else "derived-ready"
            ),
            "mode": (
                "final" if final and include_defects else "final-fast" if final else "incremental"
            ),
            "frameCount": int(playback.get("frameCount", 0)),
            "alignmentPath": str(alignment_path),
            "measurementPath": str(measurement_path),
            "regionPath": str(region_path),
            "surfacePath": str(surface_path),
            "playbackPath": str(playback_path),
            "imageResultPath": str(image_contract_path),
            "defectPath": str(defect_path) if defect_path else "",
            "defectReportPath": str(defect_contract_path) if defect_contract_path else "",
            "synchronized": alignment.get("quality", {}).get("synchronized"),
            "metricValid": measurement.get("metricValid"),
            "regionState": regions.get("state"),
            "defectState": (
                defects.get("state")
                if include_defects
                else "queued-for-defect"
            ),
            **_signature_fields(committed_event_signature),
        },
    )
    print(
        json.dumps(
            {
                "event": "flow-analysis-ready",
                "materialId": material_id,
                "alignment": str(alignment_path),
                "measurement": str(measurement_path),
                "regions": str(region_path),
                "surface": str(surface_path),
                "playback": str(playback_path),
                "imageResult": str(image_contract_path),
                "defects": str(defect_path) if defect_path else "",
                "defectReport": str(defect_contract_path) if defect_contract_path else "",
                "mode": (
                    "final"
                    if final and include_defects
                    else "final-fast"
                    if final
                    else "incremental"
                ),
                "defectState": defects.get("state"),
                "defectCount": defects.get("statistics", {}).get("defectCount", 0),
                "synchronized": alignment.get("quality", {}).get("synchronized"),
                "metricValid": measurement.get("metricValid"),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def _analyze_under_lock(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment_config: AlignmentConfig,
    measurement_config: MeasurementConfig,
    defect_detection_config: DefectDetectionConfig,
    calibration_path: Path | None,
    database_origin: str,
    *,
    final: bool,
    include_defects: bool = True,
    committed_event_signature: tuple[int, int, int] | None = None,
) -> None:
    """Run one owned analysis pass while publishing durable progress/failure state."""
    state_path = algorithm_state_path(storage_root, material_id)
    atomic_summary(
        state_path,
        {
            "schema": "steel.flow-algorithm-state.v1",
            "flowNo": int(material_id),
            "flowId": material_id,
            "state": "processing",
            "mode": (
                "final"
                if final and include_defects
                else "final-fast"
                if final
                else "incremental"
            ),
            "startedAtUnixMs": int(time.time() * 1000),
            **_signature_fields(committed_event_signature),
        },
    )
    try:
        _analyze_impl(
            camera_roots,
            storage_root,
            material_id,
            alignment_config,
            measurement_config,
            defect_detection_config,
            calibration_path,
            database_origin,
            final=final,
            include_defects=include_defects,
            committed_event_signature=committed_event_signature,
        )
    except Exception as error:
        atomic_summary(
            state_path,
            {
                "schema": "steel.flow-algorithm-state.v1",
                "flowNo": int(material_id),
                "flowId": material_id,
                "state": "failed",
                "mode": (
                    "final"
                    if final and include_defects
                    else "final-fast"
                    if final
                    else "incremental"
                ),
                "failedAtUnixMs": int(time.time() * 1000),
                "error": f"{type(error).__name__}: {error}",
                **_signature_fields(committed_event_signature),
            },
        )
        raise


def analyze(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment_config: AlignmentConfig,
    measurement_config: MeasurementConfig,
    defect_detection_config: DefectDetectionConfig,
    calibration_path: Path | None,
    database_origin: str,
    *,
    final: bool,
    include_defects: bool = True,
    committed_event_signature: tuple[int, int, int] | None = None,
) -> None:
    """Run one analysis pass with exclusive ownership of derived artifacts."""

    with exclusive_material_job(
        storage_root,
        material_id,
        purpose="flow-analysis",
    ):
        _analyze_under_lock(
            camera_roots,
            storage_root,
            material_id,
            alignment_config,
            measurement_config,
            defect_detection_config,
            calibration_path,
            database_origin,
            final=final,
            include_defects=include_defects,
            committed_event_signature=committed_event_signature,
        )


def _analyze_defects_only_under_lock(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    defect_detection_config: DefectDetectionConfig,
    execution_gate: Callable[[str], None] | None = None,
) -> None:
    """Run the heavy model stage without blocking realtime derived artifacts."""
    state_path = algorithm_state_path(storage_root, material_id)
    alignment_path = canonical_alignment_path(storage_root, material_id)
    try:
        previous = json.loads(state_path.read_text(encoding="utf-8-sig"))
        if not isinstance(previous, dict):
            previous = {}
    except (OSError, ValueError, json.JSONDecodeError):
        previous = {}
    atomic_summary(
        state_path,
        {
            **previous,
            "schema": "steel.flow-algorithm-state.v1",
            "flowNo": int(material_id),
            "flowId": material_id,
            "state": "processing-defects",
            "mode": "final-defects",
            "defectStartedAtUnixMs": int(time.time() * 1000),
        },
    )
    try:
        alignment = json.loads(alignment_path.read_text(encoding="utf-8-sig"))
        if not isinstance(alignment, dict):
            raise ValueError("alignment manifest must be a JSON object")
        defect_path, defects = build_and_write_flow_defect_detection(
            camera_roots,
            storage_root,
            material_id,
            alignment,
            config=defect_detection_config,
            execution_gate=execution_gate,
        )
        report_path, report = publish_defect_report(
            storage_root, material_id, defect_path, defects
        )
        atomic_summary(
            state_path,
            {
                **previous,
                "schema": "steel.flow-algorithm-state.v1",
                "flowNo": int(material_id),
                "flowId": material_id,
                "state": "ready",
                "mode": "final",
                "defectPath": str(defect_path),
                "defectReportPath": str(report_path),
                "defectState": defects.get("state"),
                "defectCount": int(
                    defects.get("statistics", {}).get("defectCount", 0)
                ),
                "defectCompletedAtUnixMs": int(time.time() * 1000),
            },
        )
        print(
            json.dumps(
                {
                    "event": "flow-defects-ready",
                    "materialId": material_id,
                    "path": str(defect_path),
                    "report": str(report_path),
                    "complete": report.get("complete"),
                    "state": defects.get("state"),
                    "defectCount": defects.get("statistics", {}).get(
                        "defectCount", 0
                    ),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    except (ExecutionGateInterrupted, DepthGeometryConfigChanged):
        atomic_summary(
            state_path,
            {
                **previous,
                "schema": "steel.flow-algorithm-state.v1",
                "flowNo": int(material_id),
                "flowId": material_id,
                "state": "queued-for-defect",
                "mode": "final-defects",
                "defectInterruptedAtUnixMs": int(time.time() * 1000),
            },
        )
        raise
    except Exception as error:
        atomic_summary(
            state_path,
            {
                **previous,
                "schema": "steel.flow-algorithm-state.v1",
                "flowNo": int(material_id),
                "flowId": material_id,
                "state": "failed",
                "mode": "final-defects",
                "failedAtUnixMs": int(time.time() * 1000),
                "error": f"{type(error).__name__}: {error}",
            },
        )
        raise


def analyze_defects_only(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    defect_detection_config: DefectDetectionConfig,
    execution_gate: Callable[[str], None] | None = None,
) -> None:
    """Run the defect stage without racing a fast artifact generation."""

    with exclusive_material_job(
        storage_root,
        material_id,
        purpose="flow-defect-analysis",
    ):
        _analyze_defects_only_under_lock(
            camera_roots,
            storage_root,
            material_id,
            defect_detection_config,
            execution_gate,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--role",
        choices=("combined", "image", "defect"),
        default="combined",
        help=(
            "combined preserves the legacy single-process loop; image produces "
            "alignment/measurement/region/surface artifacts; defect consumes "
            "completed image artifacts and runs model inference"
        ),
    )
    parser.add_argument("--profile", required=True)
    parser.add_argument("--capture-origin", default="http://127.0.0.1:4317")
    parser.add_argument("--database-origin", default="http://127.0.0.1:4873")
    parser.add_argument("--poll-seconds", type=float, default=0.25)
    parser.add_argument("--settle-seconds", type=float, default=0.5)
    parser.add_argument("--recent-flows", type=int, default=128)
    parser.add_argument(
        "--full-history",
        dest="full_history",
        action="store_true",
        default=True,
        help="continuously inspect all older closed flows (default: enabled)",
    )
    parser.add_argument(
        "--no-full-history",
        dest="full_history",
        action="store_false",
        help="disable the background closed-flow history backfill",
    )
    parser.add_argument(
        "--maximum-defect-backlog",
        type=int,
        default=DEFAULT_MAXIMUM_DEFECT_BACKLOG,
        help="bound queued final defect jobs (default: 64)",
    )
    parser.add_argument(
        "--maximum-storage-backlog",
        type=int,
        default=64,
        help=(
            "pause live defect I/O above this capture storage backlog; zero "
            "retains strict capture-idle scheduling (default: 64)"
        ),
    )
    parser.add_argument("--tile-frames", type=int, default=16)
    parser.add_argument("--once", default="")
    parser.add_argument("--final", action="store_true")
    args = parser.parse_args()
    process_priority = lower_process_priority()

    # This process consumes already-persisted frames and never opens a camera
    # transport. Requiring the GenTL producer here breaks offline/simulation
    # processing on hosts that intentionally do not install the vendor SDK.
    profile = load_profile(args.profile, strict_hardware=False, verify_cti=False)
    defaults = profile.raw.get("captureDefaults", {})
    camera_roots = {
        camera.camera_id: camera.storage_root for camera in profile.enabled_cameras
    }
    alignment_config = AlignmentConfig(
        search_frames=int(defaults.get("alignmentSearchFrames", 12)),
        stable_rows=int(defaults.get("alignmentStableRows", 8)),
        sample_step=int(defaults.get("alignmentSampleStep", 4)),
        depth_valid_ratio=float(defaults.get("alignmentDepthValidRatio", 0.005)),
        intensity_threshold=float(defaults.get("steelBrightPixelThreshold", 8.0)),
        intensity_ratio=float(defaults.get("steelBrightPixelRatio", 0.02)),
        anchor_interval_frames=int(defaults.get("softSyncAnchorIntervalFrames", 16)),
        maximum_anchor_residual_ms=float(defaults.get("softSyncMaximumResidualMs", 40.0)),
    ).bounded()
    measurement_config = MeasurementConfig(
        row_window=int(defaults.get("measurementRowWindow", 16)),
        maximum_profile_points=int(defaults.get("measurementMaximumProfilePoints", 320)),
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
    calibration_path = None
    if calibration_text:
        candidate = Path(calibration_text)
        calibration_path = candidate if candidate.is_absolute() else profile.source_path.parent / candidate

    def active_calibration_path() -> Path:
        return Path(
            resolve_active_array_calibration(
                profile.storage_root,
                calibration_path,
            )["path"]
        )

    def configured_path(key: str) -> Path | None:
        text = os.path.expandvars(str(defaults.get(key, "")).strip())
        if not text:
            return None
        candidate = Path(text)
        return candidate if candidate.is_absolute() else profile.source_path.parent / candidate

    defect_detection_config = DefectDetectionConfig(
        enabled=bool(defaults.get("defectDetectionEnabled", False)),
        model_2d_path=configured_path("defectModel2dPath"),
        model_3d_path=configured_path("defectModel3dPath"),
        classifier_2d_path=configured_path("defectClassifier2dPath"),
        classifier_3d_path=configured_path("defectClassifier3dPath"),
        model_manifest_path=configured_path("defectModelManifestPath"),
        image_size=int(defaults.get("defectImageSize", 640)),
        confidence_threshold=float(defaults.get("defectConfidenceThreshold", 0.25)),
        iou_threshold=float(defaults.get("defectIouThreshold", 0.25)),
        merge_iou_threshold=float(defaults.get("defectMergeIouThreshold", 0.20)),
        maximum_detections_per_frame=int(defaults.get("defectMaximumPerFrame", 100)),
        inference_batch_size=int(defaults.get("defectInferenceBatchSize", 8)),
        preprocess_workers=int(defaults.get("defectPreprocessWorkers", 2)),
        classification_confidence_threshold=float(
            defaults.get("defectClassificationConfidenceThreshold", 0.55)
        ),
        frame_stride=int(defaults.get("defectFrameStride", 1)),
        cpu_frame_stride=int(defaults.get("defectCpuFrameStride", 8)),
        gpu_device_id=int(defaults.get("defectGpuDevice", 1)),
        depth_exposure=float(defaults.get("defectDepthExposure", 300.0)),
        depth_baseline_sample_step=int(
            defaults.get("defectDepthBaselineSampleStep", 4)
        ),
        review_crop_minimum_size=int(
            defaults.get("defectReviewCropMinimumSize", 64)
        ),
        capture_origin=args.capture_origin,
        database_origin=args.database_origin,
        maximum_idle_wait_seconds=float(
            defaults.get("defectMaximumIdleWaitSeconds", 300.0)
        ),
        maximum_pending_storage_rounds=int(
            min(
                int(defaults.get("defectMaximumPendingStorageRounds", 0)),
                max(0, args.maximum_storage_backlog),
            )
        ),
        require_approved_region_map=bool(
            defaults.get("defectRequireApprovedRegionMap", True)
        ),
        depth_geometry_profile_path=(
            profile.source_path if profile.expected_cameras == 6 else None
        ),
    ).bounded()

    if args.once:
        if args.role == "defect":
            analyze_defects_only(
                camera_roots,
                profile.storage_root,
                args.once,
                defect_detection_config,
            )
        else:
            analyze(
                camera_roots,
                profile.storage_root,
                args.once,
                alignment_config,
                measurement_config,
                defect_detection_config,
                active_calibration_path(),
                args.database_origin,
                final=args.final,
                include_defects=args.role == "combined",
                committed_event_signature=committed_signature(
                    profile.storage_root, args.once
                ),
            )
        return 0

    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
    observed: dict[str, tuple[tuple[int, int, int], str, float]] = {}
    processed: dict[str, tuple[tuple[int, int, int], str]] = {}
    defect_completed: dict[str, tuple[int, int, int]] = {}
    defect_retry_after: dict[str, float] = {}
    defect_queue: queue.PriorityQueue[
        tuple[int, int, int, str, tuple[int, int, int], bool, str]
    ] = queue.PriorityQueue()
    queue_state_lock = threading.RLock()
    queued_defects: dict[str, tuple[int, int, int]] = {}
    queued_defect_history: dict[str, bool] = {}
    queue_serial = 0
    current_fast_flow = ""
    current_defect_flow = ""
    current_defect_is_history = False
    current_history_flow = ""
    fast_processed_count = 0
    defect_processed_count = 0
    history_checked_count = 0
    history_completed_count = 0
    history_skipped_count = 0
    history_failed_count = 0
    history_last_flow = ""
    history_last_error = ""
    history_catalog: list[str] = []
    history_catalog_updated_at = 0.0
    realtime_catalog: list[str] = []
    realtime_catalog_updated_at = 0.0
    cached_playback_catalog_hint = ""
    capture_hint_checked_at = 0.0
    capture_service_hint = ""
    latest_flow_status: dict[str, object] | None = None
    latest_flow_status_updated_at = 0.0
    history_cursor = load_history_cursor(profile.storage_root)
    geometry_snapshot = (
        load_depth_geometry_config_snapshot(profile.source_path)
        if defect_detection_config.depth_geometry_profile_path is not None
        else None
    )
    active_geometry_hash = geometry_snapshot.sha256 if geometry_snapshot else ""
    active_geometry_revision = geometry_snapshot.revision if geometry_snapshot else 0
    active_legacy_model_hash = configured_legacy_model_hash(
        defect_detection_config,
        None,
    )
    legacy_model_hash_checked_at = time.monotonic()
    depth_history_cursor = (
        load_depth_history_cursor(
            profile.storage_root,
            active_geometry_hash,
            active_legacy_model_hash,
        )
        if active_geometry_hash
        else ""
    )
    depth_history_checked_count = 0
    depth_history_completed_count = 0
    depth_history_preempted_count = 0
    history_future: Future[dict[str, object]] | None = None
    history_executor = ThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="sick-history-backfill",
    )
    history_refresh_seconds = max(15.0, args.poll_seconds * 8.0)
    first_root = profile.storage_root
    maximum_defect_backlog = max(
        1,
        min(1024, int(args.maximum_defect_backlog)),
    )
    defect_backlog_deferred_count = 0
    last_queue_error = ""
    status_write_error = ""
    status_owner = {
        "combined": "flow-analysis",
        "image": "image-worker",
        "defect": "defect-worker",
    }[args.role]
    realtime_status_path = (
        profile.storage_root / "system" / "jobs" / status_owner / "status.json"
    )

    def refresh_latest_flow_status(
        material_id: str = "", *, force: bool = False
    ) -> None:
        nonlocal latest_flow_status, latest_flow_status_updated_at
        now = time.monotonic()
        with queue_state_lock:
            previous_material_id = str(
                (latest_flow_status or {}).get("materialId", "")
            )
            target = material_id or current_fast_flow or previous_material_id
            if (
                not force
                and target == previous_material_id
                and now - latest_flow_status_updated_at < 1.0
            ):
                return
        snapshot = (
            algorithm_lag_snapshot(profile.storage_root, target) if target else None
        )
        with queue_state_lock:
            latest_flow_status = snapshot
            latest_flow_status_updated_at = now

    def write_queue_status() -> None:
        nonlocal status_write_error
        # Keep payload construction and replacement under the same lock.
        # Releasing it before os.replace allowed the fast and defect threads
        # to race on Windows and terminate the supervised Python worker.
        with queue_state_lock:
            queued_ids = sorted(queued_defects, key=int, reverse=True)
            payload = {
                "schema": "steel.flow-analysis-queue.v1",
                "role": args.role,
                "state": "stopping" if stop.is_set() else "running",
                "updatedAtUnixMs": int(time.time() * 1000),
                "currentFastFlow": current_fast_flow or None,
                "currentDefectFlow": current_defect_flow or None,
                "currentDefectKind": (
                    "history" if current_defect_is_history else "live"
                ) if current_defect_flow else None,
                "pendingDefectFlows": max(
                    0, len(queued_ids) - (1 if current_defect_flow else 0)
                ),
                "queuedDefectFlowIds": queued_ids[:32],
                "fastProcessedFlowCount": fast_processed_count,
                "defectProcessedFlowCount": defect_processed_count,
                "latestCaptureFlow": latest_flow_status,
                "recentFlowWindow": max(1, args.recent_flows),
                "realtimeCatalogRefreshSeconds": history_refresh_seconds,
                "maximumDefectBacklog": maximum_defect_backlog,
                "defectBacklogDeferredCount": defect_backlog_deferred_count,
                "fullHistoryEnabled": bool(args.full_history),
                "historyState": (
                    "disabled"
                    if not args.full_history
                    else "building"
                    if current_history_flow
                    else "idle"
                ),
                "currentHistoryFlow": current_history_flow or None,
                "historyLastFlow": history_last_flow or None,
                "historyCatalogCount": len(history_catalog),
                "historyCheckedFlowCount": history_checked_count,
                "historyCompletedFlowCount": history_completed_count,
                "historySkippedFlowCount": history_skipped_count,
                "historyFailedFlowCount": history_failed_count,
                "historyCursor": history_cursor or None,
                "historyLastError": history_last_error or None,
                "depthGeometryBackfill": {
                    "enabled": bool(
                        args.full_history and active_geometry_hash
                    ),
                    "state": (
                        "paused"
                        if backfill_is_paused(profile.storage_root)
                        else "running"
                        if current_defect_is_history
                        else "idle"
                    ),
                    "configHash": active_geometry_hash or None,
                    "legacyModelHash": active_legacy_model_hash or None,
                    "algorithmRevision": active_geometry_revision or None,
                    "order": "newest-first",
                    "cursor": depth_history_cursor or None,
                    "checkedFlowCount": depth_history_checked_count,
                    "completedFlowCount": depth_history_completed_count,
                    "preemptedFlowCount": depth_history_preempted_count,
                    "livePriority": True,
                    "gpuDeviceId": defect_detection_config.gpu_device_id,
                },
                "maximumStorageBacklog": max(0, args.maximum_storage_backlog),
                "processPriority": process_priority,
                "lastError": last_queue_error or status_write_error or None,
            }
            retry_delays = (0.0, 0.02, 0.05, 0.10, 0.20)
            for attempt, delay in enumerate(retry_delays):
                if delay:
                    time.sleep(delay)
                try:
                    atomic_summary(realtime_status_path, payload)
                    status_write_error = ""
                    return
                except OSError as error:
                    if attempt + 1 == len(retry_delays):
                        status_write_error = (
                            f"queue status write failed: {type(error).__name__}: {error}"
                        )
                        print(
                            json.dumps(
                                {
                                    "event": "flow-analysis-status-write-failed",
                                    "error": str(error),
                                },
                                ensure_ascii=False,
                            ),
                            flush=True,
                        )

    def enqueue_defect(
        material_id: str,
        signature: tuple[int, int, int],
        *,
        history: bool = False,
        capture_priority: bool = False,
        geometry_hash: str = "",
    ) -> None:
        nonlocal queue_serial, defect_backlog_deferred_count
        if defect_artifact_complete(
            profile.storage_root,
            material_id,
            geometry_hash or None,
            active_legacy_model_hash or None,
            signature,
        ):
            defect_completed[material_id] = signature
            return
        with queue_state_lock:
            if defect_completed.get(material_id) == signature:
                return
            if time.monotonic() < defect_retry_after.get(material_id, 0.0):
                return
            if queued_defects.get(material_id) == signature:
                return
            if (
                material_id not in queued_defects
                and len(queued_defects) >= maximum_defect_backlog
            ):
                defect_backlog_deferred_count += 1
                return
            queued_defects[material_id] = signature
            queued_defect_history[material_id] = history
            queue_serial += 1
            defect_queue.put(
                (
                    defect_queue_tier(
                        history=history,
                        capture_priority=capture_priority,
                    ),
                    -int(material_id),
                    queue_serial,
                    material_id,
                    signature,
                    history,
                    geometry_hash,
                )
            )
        write_queue_status()

    def prune_realtime_state(recent_ids: list[str]) -> None:
        """Keep long-running service bookkeeping bounded to recent flows."""
        keep = set(recent_ids)
        keep.update(queued_defects)
        if current_fast_flow:
            keep.add(current_fast_flow)
        if current_defect_flow:
            keep.add(current_defect_flow)
        limit = max(256, max(1, args.recent_flows) * 2)
        for mapping in (
            observed,
            processed,
            defect_completed,
            defect_retry_after,
        ):
            if len(mapping) <= limit:
                continue
            for material_id in list(mapping):
                if len(mapping) <= limit:
                    break
                if material_id not in keep:
                    mapping.pop(material_id, None)

    def defect_worker() -> None:
        nonlocal current_defect_flow, current_defect_is_history
        nonlocal defect_processed_count, last_queue_error
        nonlocal depth_history_completed_count, depth_history_preempted_count
        while not stop.is_set():
            try:
                (
                    _tier,
                    _priority,
                    _serial,
                    material_id,
                    signature,
                    history,
                    job_geometry_hash,
                ) = defect_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            with queue_state_lock:
                if queued_defects.get(material_id) != signature:
                    defect_queue.task_done()
                    continue
                if flow_state(profile.storage_root, material_id) != "closed":
                    queued_defects.pop(material_id, None)
                    queued_defect_history.pop(material_id, None)
                    defect_queue.task_done()
                    continue
                current_defect_flow = material_id
                current_defect_is_history = history
            write_queue_status()
            gate_state = {"lastProbe": 0.0, "captureIdle": False}
            restart_after_config_change = False

            def history_execution_gate(phase: str) -> None:
                if not history:
                    return
                if stop.is_set() or backfill_is_paused(profile.storage_root):
                    raise ExecutionGateInterrupted("geometry history backfill paused")
                with queue_state_lock:
                    live_waiting = any(
                        not is_history
                        for candidate, is_history in queued_defect_history.items()
                        if candidate != material_id
                    )
                if live_waiting:
                    raise ExecutionGateInterrupted(
                        "live defect analysis preempted geometry history backfill"
                    )
                now = time.monotonic()
                if now - float(gate_state["lastProbe"]) >= 0.2:
                    gate_state["captureIdle"] = _capture_is_idle(
                        defect_detection_config.capture_origin,
                        0,
                        None,
                    )
                    gate_state["lastProbe"] = now
                if not bool(gate_state["captureIdle"]):
                    raise ExecutionGateInterrupted(
                        f"capture active during geometry history I/O: {phase}"
                    )

            try:
                analyze_defects_only(
                    camera_roots,
                    profile.storage_root,
                    material_id,
                    replace(
                        defect_detection_config,
                        history_rebuild=history,
                    ),
                    execution_gate=history_execution_gate if history else None,
                )
                with queue_state_lock:
                    defect_completed[material_id] = signature
                    defect_processed_count += 1
                    if history:
                        depth_history_completed_count += 1
                    last_queue_error = ""
            except ExecutionGateInterrupted as error:
                with queue_state_lock:
                    if history:
                        depth_history_preempted_count += 1
                    last_queue_error = ""
                print(
                    json.dumps(
                        {
                            "event": "flow-defect-analysis-interrupted",
                            "materialId": material_id,
                            "history": history,
                            "reason": str(error),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except DepthGeometryConfigChanged as error:
                restart_after_config_change = True
                with queue_state_lock:
                    if history:
                        depth_history_preempted_count += 1
                    last_queue_error = ""
                print(
                    json.dumps(
                        {
                            "event": "flow-defect-analysis-config-restart",
                            "materialId": material_id,
                            "history": history,
                            "reason": str(error),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            except Exception as error:
                with queue_state_lock:
                    defect_retry_after[material_id] = time.monotonic() + 10.0
                    last_queue_error = f"{material_id}: {type(error).__name__}: {error}"
                print(
                    json.dumps(
                        {
                            "event": "flow-defect-analysis-failed",
                            "materialId": material_id,
                            "error": str(error),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
            finally:
                with queue_state_lock:
                    if queued_defects.get(material_id) == signature:
                        queued_defects.pop(material_id, None)
                    queued_defect_history.pop(material_id, None)
                    current_defect_flow = ""
                    current_defect_is_history = False
                defect_queue.task_done()
                write_queue_status()
            if restart_after_config_change and not stop.is_set():
                # Requeue the same whole-flow job under the newest immutable
                # snapshot. PriorityQueue still lets any waiting live flow run
                # before a restarted history job.
                try:
                    next_geometry_hash = load_depth_geometry_config_snapshot(
                        profile.source_path
                    ).sha256
                    enqueue_defect(
                        material_id,
                        signature,
                        history=history,
                        capture_priority=_tier < 0,
                        geometry_hash=next_geometry_hash,
                    )
                except Exception as error:
                    with queue_state_lock:
                        defect_retry_after[material_id] = time.monotonic() + 10.0
                        last_queue_error = (
                            f"{material_id}: config restart failed: "
                            f"{type(error).__name__}: {error}"
                        )

    defect_thread: threading.Thread | None = None
    if args.role in {"combined", "defect"}:
        defect_thread = threading.Thread(
            target=defect_worker,
            name="sick-realtime-defect-queue",
            daemon=True,
        )
        defect_thread.start()
    write_queue_status()

    def status_heartbeat() -> None:
        while not stop.wait(5.0):
            refresh_latest_flow_status(force=True)
            write_queue_status()

    heartbeat_thread = threading.Thread(
        target=status_heartbeat,
        name="sick-flow-analysis-status-heartbeat",
        daemon=True,
    )
    heartbeat_thread.start()

    def refresh_history_catalog(force: bool = False) -> None:
        nonlocal history_catalog, history_catalog_updated_at
        if not args.full_history:
            return
        now = time.monotonic()
        if (
            not force
            and history_catalog
            and now - history_catalog_updated_at < history_refresh_seconds
        ):
            return
        catalog = all_materials(first_root)
        with queue_state_lock:
            history_catalog = catalog
            history_catalog_updated_at = now

    def refresh_realtime_catalog(force: bool = False) -> None:
        nonlocal realtime_catalog, realtime_catalog_updated_at
        nonlocal cached_playback_catalog_hint
        now = time.monotonic()
        if (
            not force
            and realtime_catalog
            and now - realtime_catalog_updated_at < history_refresh_seconds
        ):
            return
        # Reuse the full-history enumeration when it was refreshed this loop.
        # Otherwise enumerate at most once every 15 seconds instead of once per
        # 250 ms realtime poll.
        if history_catalog and now - history_catalog_updated_at < history_refresh_seconds:
            limit = max(1, args.recent_flows)
            catalog = list(reversed(history_catalog[-limit:]))
        else:
            catalog = recent_materials(first_root, max(1, args.recent_flows))
        with queue_state_lock:
            realtime_catalog = catalog
            realtime_catalog_updated_at = now
            cached_playback_catalog_hint = playback_catalog_hint(
                profile.storage_root
            )

    def refresh_capture_service_hint() -> None:
        nonlocal capture_hint_checked_at, capture_service_hint
        now = time.monotonic()
        if now - capture_hint_checked_at < 1.0:
            return
        capture_hint_checked_at = now
        material_id = capture_service_material_hint(args.capture_origin)
        # Retain the last observed active id across steel-out. This is needed
        # only during a rolling upgrade before capture publishes hand-off v1.
        if material_id:
            capture_service_hint = material_id

    def run_history_analysis(
        material_id: str,
        signature: tuple[int, int, int],
    ) -> dict[str, object]:
        """Run one final-fast pass outside the realtime polling thread."""
        try:
            analyze(
                camera_roots,
                profile.storage_root,
                material_id,
                alignment_config,
                measurement_config,
                defect_detection_config,
                active_calibration_path(),
                args.database_origin,
                final=True,
                include_defects=False,
                committed_event_signature=signature,
            )
            after = committed_signature(profile.storage_root, material_id)
            after_state = flow_state(profile.storage_root, material_id)
            ready = bool(
                after == signature
                and after_state == "closed"
                and fast_artifacts_ready(
                    profile.storage_root,
                    material_id,
                    signature,
                )
            )
            return {
                "materialId": material_id,
                "signature": signature,
                "ready": ready,
                "error": "" if ready else "history-fast-artifacts-not-ready",
            }
        except Exception as error:
            return {
                "materialId": material_id,
                "signature": signature,
                "ready": False,
                "error": f"{type(error).__name__}: {error}",
            }

    def finish_history_future() -> None:
        nonlocal history_future
        nonlocal current_history_flow, history_completed_count
        nonlocal history_failed_count, history_last_flow, history_last_error
        if history_future is None or not history_future.done():
            return
        future = history_future
        history_future = None
        material_id = current_history_flow
        current_history_flow = ""
        try:
            result = future.result()
        except Exception as error:
            history_failed_count += 1
            history_last_error = f"{material_id}: {type(error).__name__}: {error}"
            history_last_flow = material_id
            return
        result_material = str(result.get("materialId", material_id))
        history_last_flow = result_material
        if bool(result.get("ready")):
            history_completed_count += 1
            history_last_error = ""
        else:
            history_failed_count += 1
            history_last_error = (
                f"{result_material}: {str(result.get('error', 'history analysis failed'))}"
            )

    def schedule_history_analysis(excluded_recent: set[str]) -> bool:
        nonlocal history_future, current_history_flow, history_cursor
        nonlocal history_checked_count, history_skipped_count
        nonlocal history_last_flow, history_last_error
        if not args.full_history or history_future is not None:
            return False
        refresh_history_catalog()
        with queue_state_lock:
            candidate = next_history_material(
                history_catalog,
                history_cursor,
                excluded_recent,
            )
        if candidate is None:
            return False

        # Advance/persist before the expensive work. If the process stops in
        # the middle of this flow, the next restart continues round-robin and
        # will revisit this still-incomplete flow after one catalog rotation.
        history_cursor = candidate
        history_checked_count += 1
        try:
            save_history_cursor(
                profile.storage_root,
                candidate,
                catalog_count=len(history_catalog),
                checked_count=history_checked_count,
            )
        except OSError as error:
            # The cursor is a recovery aid, not a reason to stop realtime
            # analysis. Keep the in-memory cursor and report the persistence
            # problem for the next status heartbeat.
            history_last_error = f"history cursor: {type(error).__name__}: {error}"
        state = flow_state(profile.storage_root, candidate)
        if state != "closed":
            history_skipped_count += 1
            history_last_flow = candidate
            return False
        signature = committed_signature(profile.storage_root, candidate)
        if signature is None:
            history_skipped_count += 1
            history_last_flow = candidate
            return False
        if fast_artifacts_ready(profile.storage_root, candidate, signature):
            history_skipped_count += 1
            history_last_flow = candidate
            return False

        current_history_flow = candidate
        history_future = history_executor.submit(
            run_history_analysis,
            candidate,
            signature,
        )
        return True

    def refresh_depth_geometry_revision() -> None:
        nonlocal geometry_snapshot, active_geometry_hash
        nonlocal active_geometry_revision, depth_history_cursor
        if defect_detection_config.depth_geometry_profile_path is None:
            return
        current = load_depth_geometry_config_snapshot(profile.source_path)
        if current.sha256 == active_geometry_hash:
            return
        with queue_state_lock:
            geometry_snapshot = current
            active_geometry_hash = current.sha256
            active_geometry_revision = current.revision
            depth_history_cursor = load_depth_history_cursor(
                profile.storage_root,
                active_geometry_hash,
                active_legacy_model_hash,
            )
            # A flow signature describes immutable capture input, not an
            # algorithm revision. Clear the in-memory shortcut so every recent
            # flow is reconsidered immediately under the new revision.
            defect_completed.clear()

    def refresh_legacy_model_revision() -> None:
        nonlocal active_legacy_model_hash, legacy_model_hash_checked_at
        nonlocal depth_history_cursor
        now = time.monotonic()
        if now - legacy_model_hash_checked_at < max(5.0, args.poll_seconds * 2.0):
            return
        legacy_model_hash_checked_at = now
        current_hash = configured_legacy_model_hash(defect_detection_config, None)
        if current_hash == active_legacy_model_hash:
            return
        with queue_state_lock:
            active_legacy_model_hash = current_hash
            # A legacy model/settings revision requires a newest-first audit,
            # even when the geometry config hash itself is unchanged.
            depth_history_cursor = ""
            defect_completed.clear()

    def schedule_depth_geometry_history(excluded_recent: set[str]) -> bool:
        nonlocal depth_history_cursor, depth_history_checked_count
        if (
            not args.full_history
            or args.role not in {"combined", "defect"}
            or not active_geometry_hash
            or backfill_is_paused(profile.storage_root)
        ):
            return False
        with queue_state_lock:
            if current_defect_flow or queued_defects:
                return False
        # Do not enumerate or probe an old material while capture owns any
        # camera disk or still has a committed round waiting for storage.
        if not _capture_is_idle(
            defect_detection_config.capture_origin,
            0,
            None,
        ):
            return False
        refresh_history_catalog()
        candidate = next_depth_history_material(
            history_catalog,
            depth_history_cursor,
            excluded_recent,
        )
        if candidate is None:
            return False
        depth_history_cursor = candidate
        depth_history_checked_count += 1
        save_depth_history_cursor(
            profile.storage_root,
            candidate,
            active_geometry_hash,
            revision=active_geometry_revision,
            catalog_count=len(history_catalog),
            checked_count=depth_history_checked_count,
            legacy_model_hash=active_legacy_model_hash,
        )
        if flow_state(profile.storage_root, candidate) != "closed":
            return False
        signature = committed_signature(profile.storage_root, candidate)
        if signature is None or not fast_artifacts_ready(
            profile.storage_root, candidate, signature
        ):
            return False
        if defect_artifact_complete(
            profile.storage_root,
            candidate,
            active_geometry_hash,
            active_legacy_model_hash,
            signature,
        ):
            return False
        enqueue_defect(
            candidate,
            signature,
            history=True,
            geometry_hash=active_geometry_hash,
        )
        return True

    while not stop.is_set():
        refresh_depth_geometry_revision()
        refresh_legacy_model_revision()
        finish_history_future()
        if args.role == "image" or _capture_is_idle(
            defect_detection_config.capture_origin,
            0,
            None,
        ):
            refresh_history_catalog()
        refresh_realtime_catalog()
        refresh_capture_service_hint()
        now = time.monotonic()
        defect_candidates: dict[str, tuple[int, int, int]] = {}
        priority_ids = prioritize_materials(
            [],
            [
                *capture_flow_hints(profile.storage_root),
                capture_service_hint,
                cached_playback_catalog_hint,
            ],
            32,
        )
        capture_priority_ids = set(priority_ids)
        recent_ids = prioritize_materials(
            realtime_catalog,
            priority_ids,
            max(1, args.recent_flows),
        )
        status_material_id = priority_ids[0] if priority_ids else (
            recent_ids[0] if recent_ids else ""
        )
        refresh_latest_flow_status(status_material_id)
        recent_expensive_pass = False
        for material_id in recent_ids:
            state = flow_state(profile.storage_root, material_id)
            if state not in {"capturing", "closed"}:
                continue
            final = state == "closed"
            processed_row = processed.get(material_id)
            signature = committed_signature(profile.storage_root, material_id)
            if signature is None:
                continue
            if args.role == "defect":
                if final and fast_artifacts_ready(
                    profile.storage_root, material_id, signature
                ):
                    defect_candidates[material_id] = signature
                continue
            if (
                final
                and processed_row is None
                and fast_artifacts_ready(
                    profile.storage_root, material_id, signature
                )
            ):
                processed[material_id] = (signature, state)
                if args.role == "combined":
                    defect_candidates[material_id] = signature
                continue
            if processed_snapshot_is_current(
                profile.storage_root,
                material_id,
                processed_row,
                signature,
                state,
            ):
                if final:
                    if args.role == "combined":
                        defect_candidates[material_id] = signature
                continue
            if processed_row == (signature, state):
                # Another role replaced the durable closed-flow checkpoint
                # after this process cached it. Re-enter settle/analyze rather
                # than leaving the UI on a stale partial-camera result.
                processed.pop(material_id, None)
                observed.pop(material_id, None)
            # Refresh the complete fitted surface and diameter artifact for
            # every committed tile. This keeps live measurement current while
            # bounding whole-flow recalculation frequency.
            previous_count = processed_row[0][0] if processed_row else 0
            if not final and signature[0] - previous_count < max(1, args.tile_frames):
                continue
            previous = observed.get(material_id)
            if previous is None or previous[:2] != (signature, state):
                observed[material_id] = (signature, state, now)
                if final:
                    continue
            if final and now - observed[material_id][2] < max(0.25, args.settle_seconds):
                continue
            try:
                with queue_state_lock:
                    current_fast_flow = material_id
                    recent_expensive_pass = True
                write_queue_status()
                analyze(
                    camera_roots,
                    profile.storage_root,
                    material_id,
                    alignment_config,
                    measurement_config,
                    defect_detection_config,
                    active_calibration_path(),
                    args.database_origin,
                    final=final,
                    include_defects=False,
                    committed_event_signature=signature,
                )
                after = committed_signature(profile.storage_root, material_id)
                after_state = flow_state(profile.storage_root, material_id)
                if analysis_snapshot_accepted(signature, state, after, after_state):
                    processed[material_id] = (signature, state)
                    with queue_state_lock:
                        fast_processed_count += 1
                    if final and args.role == "combined":
                        defect_candidates[material_id] = signature
                else:
                    observed.pop(material_id, None)
            except Exception as error:
                print(
                    json.dumps(
                        {
                            "event": "flow-analysis-failed",
                            "materialId": material_id,
                            "error": str(error),
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                observed[material_id] = (signature, state, time.monotonic())
            finally:
                with queue_state_lock:
                    current_fast_flow = ""
                write_queue_status()
            # Re-read the numeric material list after every expensive fast
            # pass so a newly closed live flow can never sit behind the rest
            # of a startup/history backlog captured by this iteration.
            break
        prune_realtime_state(recent_ids)
        if args.role in {"combined", "defect"}:
            for material_id in sorted(defect_candidates, key=int, reverse=True):
                enqueue_defect(
                    material_id,
                    defect_candidates[material_id],
                    capture_priority=material_id in capture_priority_ids,
                )
        # Realtime/current flows always get the first chance each round. The
        # history worker is asynchronous, bounded to one flow, and never adds
        # historical defect jobs to the realtime defect queue.
        if args.role in {"combined", "image"} and not recent_expensive_pass:
            schedule_history_analysis(set(recent_ids))
        if not recent_expensive_pass:
            schedule_depth_geometry_history(set(recent_ids))
        write_queue_status()
        stop.wait(max(0.25, args.poll_seconds))
    write_queue_status()
    history_executor.shutdown(wait=False, cancel_futures=True)
    if defect_thread is not None:
        defect_thread.join(timeout=2.0)
    heartbeat_thread.join(timeout=2.0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
