"""Durable capture-to-algorithm event publication."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

from .paths import (
    LAYOUT_SCHEMA,
    acquisition_manifest_path,
    capture_flow_handoff_path,
    flow_manifest_path,
    frame_event_path,
)
from .storage import atomic_summary


CAPTURE_FLOW_HANDOFF_SCHEMA = "steel.capture-flow-handoff.v1"
CAPTURE_FLOW_HANDOFF_LIMIT = 32
LATEST_COMPLETE_ROUND_PROBE_LIMIT = 4096


def _event_is_complete(path: Path, capture_round: int) -> bool:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
        frames = payload.get("frames")
        expected_count = int(payload.get("expectedCameraCount", 0) or 0)
        return bool(
            payload.get("schema") == "steel.capture-frame-committed.v1"
            and int(payload.get("captureRound", -1)) == capture_round
            and payload.get("complete") is True
            and expected_count > 0
            and int(payload.get("committedCameraCount", 0) or 0)
            == expected_count
            and isinstance(frames, list)
            and len(frames) == expected_count
            and not payload.get("missingCameraIds")
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False


def _latest_complete_round(
    storage_root: Path,
    flow_no: str | int,
    latest_round: int,
) -> int | None:
    lower = max(-1, latest_round - LATEST_COMPLETE_ROUND_PROBE_LIMIT)
    for capture_round in range(latest_round, lower, -1):
        path = frame_event_path(storage_root, flow_no, capture_round)
        if path.is_file() and _event_is_complete(path, capture_round):
            return capture_round
    return None


def publish_flow_handoff(
    storage_root: Path,
    flow_no: str | int,
    *,
    session_id: str,
    state: str,
    latest_round: int | None = None,
) -> Path:
    """Publish a bounded, durable hint without assuming flow ids are monotonic."""
    material_id = str(int(flow_no))
    normalized_state = str(state).strip().lower()
    if normalized_state not in {"capturing", "closed"}:
        raise ValueError(f"invalid capture flow hand-off state: {state!r}")
    path = capture_flow_handoff_path(storage_root)
    now_ns = time.time_ns()
    existing_rows: list[dict[str, Any]] = []
    try:
        existing = json.loads(path.read_text(encoding="utf-8-sig"))
        if existing.get("schema") == CAPTURE_FLOW_HANDOFF_SCHEMA:
            rows = existing.get("flows", [])
            if isinstance(rows, list):
                existing_rows = [row for row in rows if isinstance(row, dict)]
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass

    previous = next(
        (
            row
            for row in existing_rows
            if str(row.get("materialId", "")).strip() == material_id
        ),
        None,
    )
    first_published_ns = now_ns
    if previous is not None:
        try:
            first_published_ns = int(previous.get("firstPublishedAtUnixNs", now_ns))
        except (TypeError, ValueError):
            first_published_ns = now_ns
    row: dict[str, Any] = {
        "materialId": material_id,
        "flowNo": int(material_id),
        "sessionId": str(session_id),
        "state": normalized_state,
        "firstPublishedAtUnixNs": first_published_ns,
        "updatedAtUnixNs": now_ns,
    }
    previous_latest_round = -1
    if previous is not None and previous.get("latestCommittedRound") is not None:
        try:
            previous_latest_round = int(previous["latestCommittedRound"])
        except (TypeError, ValueError):
            pass
    if latest_round is not None:
        # A process-local capture counter from an older build can restart at
        # zero. Never let that rolling-upgrade defect lower the durable hint.
        row["latestCommittedRound"] = max(
            int(latest_round),
            previous_latest_round,
        )
    elif previous_latest_round >= 0:
        row["latestCommittedRound"] = previous_latest_round

    merged = [
        candidate
        for candidate in existing_rows
        if str(candidate.get("materialId", "")).strip() != material_id
    ]
    merged.append(row)

    def published_order(candidate: dict[str, Any]) -> int:
        try:
            return int(candidate.get("firstPublishedAtUnixNs", 0) or 0)
        except (TypeError, ValueError):
            return 0

    merged.sort(key=published_order, reverse=True)
    payload = {
        "schema": CAPTURE_FLOW_HANDOFF_SCHEMA,
        "updatedAtUnixMs": now_ns // 1_000_000,
        "flows": merged[:CAPTURE_FLOW_HANDOFF_LIMIT],
    }
    atomic_summary(path, payload)
    return path


def publish_committed_round(
    storage_root: Path,
    flow_no: str | int,
    session_id: str,
    rows: list[dict[str, Any]],
    *,
    boundary_phase: str,
    expected_camera_ids: list[str] | tuple[str, ...] | set[str] | None = None,
    artifacts_verified: bool = False,
) -> Path:
    """Publish one round only after every listed frame transaction committed."""
    if not rows:
        raise ValueError("a committed round event requires at least one frame")
    rounds = {int(row.get("round", -1)) for row in rows}
    if len(rounds) != 1 or next(iter(rounds)) < 0:
        raise ValueError("committed rows must share one non-negative capture round")
    capture_round = next(iter(rounds))
    frames = []
    committed_camera_ids: set[str] = set()
    for row in sorted(rows, key=lambda item: str(item.get("cameraId", ""))):
        camera_id = str(row.get("cameraId", "")).strip()
        if not camera_id:
            raise ValueError("committed frame requires cameraId")
        if camera_id in committed_camera_ids:
            raise ValueError(f"duplicate committed camera in round: {camera_id}")
        committed_camera_ids.add(camera_id)
        depth_path = Path(str(row.get("depthOutput", "")))
        intensity_path = Path(str(row.get("intensityOutput", "")))
        metadata_path = Path(str(row.get("metadataOutput", "")))
        if not artifacts_verified:
            for artifact_path in (depth_path, intensity_path, metadata_path):
                if not artifact_path.is_file():
                    raise FileNotFoundError(artifact_path)
        frames.append(
            {
                "cameraId": camera_id,
                "cameraKey": str(row.get("cameraKey", "")),
                "sequenceNo": int(row.get("sequenceNo", 0)),
                "storageIndex": int(row.get("sequenceNo", 1)) - 1,
                "captureRound": capture_round,
                "capturedAt": str(row.get("capturedAt", "")),
                "hostUtcNs": int(row.get("hostUtcNs", 0) or 0),
                "deviceTimestamp": int(row.get("deviceTimestamp", 0) or 0),
                "depthPath": str(depth_path),
                "intensityPath": str(intensity_path),
                "metadataPath": str(metadata_path),
                "meanIntensity": float(row.get("meanIntensity", 0.0)),
                "brightPixelRatio": float(row.get("brightPixelRatio", 0.0)),
                "steelSignal": bool(row.get("steelSignal")),
                "materialSignal": bool(row.get("materialSignal")),
                "materialSignalRatio": float(
                    row.get("materialSignalRatio", 0.0)
                ),
                "boundaryPhase": str(row.get("boundaryPhase", boundary_phase)),
                "imageQuality": dict(row.get("imageQuality", {})),
                "checksums": dict(row.get("checksums", {})),
            }
        )
    expected = {
        str(camera_id).strip()
        for camera_id in (expected_camera_ids or committed_camera_ids)
        if str(camera_id).strip()
    }
    unexpected = committed_camera_ids - expected
    if unexpected:
        raise ValueError(
            f"committed round contains unexpected cameras: {sorted(unexpected)}"
        )
    missing = sorted(expected - committed_camera_ids)
    payload: dict[str, Any] = {
        "schema": "steel.capture-frame-committed.v1",
        "storageSchema": LAYOUT_SCHEMA,
        "flowNo": int(flow_no),
        "flowId": str(int(flow_no)),
        "sessionId": session_id,
        "captureRound": capture_round,
        "boundaryPhase": boundary_phase,
        "complete": not missing,
        "expectedCameraCount": len(expected),
        "committedCameraCount": len(committed_camera_ids),
        "missingCameraIds": missing,
        "frames": frames,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    payload["eventHash"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    path = frame_event_path(storage_root, flow_no, capture_round)
    atomic_summary(path, payload)
    return path


def write_flow_manifest(
    storage_root: Path,
    flow_no: str | int,
    *,
    session_id: str,
    state: str,
    camera_roots: dict[str, Path],
    latest_round: int | None = None,
    latest_round_complete: bool | None = None,
    recover_latest_complete: bool = False,
    boundary_policy: str | None = None,
) -> Path:
    path = flow_manifest_path(storage_root, flow_no)
    previous: dict[str, Any] = {}
    try:
        candidate = json.loads(path.read_text(encoding="utf-8-sig"))
        if candidate.get("schema") == LAYOUT_SCHEMA:
            previous = candidate
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    payload: dict[str, Any] = {
        "schema": LAYOUT_SCHEMA,
        "flowNo": int(flow_no),
        "flowId": str(int(flow_no)),
        "sessionId": session_id,
        "state": state,
        "captureRoots": {
            camera_id: str(root)
            for camera_id, root in sorted(camera_roots.items())
        },
    }
    resolved_boundary_policy = str(
        boundary_policy or previous.get("boundaryPolicy", "")
    ).strip()
    if resolved_boundary_policy:
        payload["boundaryPolicy"] = resolved_boundary_policy
    latest_complete_round: int | None = None
    if latest_round is not None:
        latest_round = int(latest_round)
        payload["latestCommittedRound"] = latest_round
        if latest_round_complete is None:
            latest_round_complete = _event_is_complete(
                frame_event_path(storage_root, flow_no, latest_round),
                latest_round,
            )
        if latest_round_complete:
            latest_complete_round = latest_round
        else:
            try:
                previous_complete = int(
                    previous.get("latestCompleteCommittedRound", -1)
                )
            except (TypeError, ValueError):
                previous_complete = -1
            if (
                not recover_latest_complete
                and 0 <= previous_complete <= latest_round
            ):
                latest_complete_round = previous_complete
            else:
                latest_complete_round = _latest_complete_round(
                    storage_root,
                    flow_no,
                    latest_round,
                )
        if latest_complete_round is not None:
            payload["latestCompleteCommittedRound"] = latest_complete_round
    atomic_summary(path, payload)
    if (
        state == "closed"
        and latest_complete_round is not None
        and frame_event_path(
            storage_root, flow_no, latest_complete_round
        ).is_file()
    ):
        _write_acquisition_manifest(
            storage_root,
            flow_no,
            session_id=session_id,
            latest_round=latest_complete_round,
        )
    return path


def _artifact(kind: str, raw_path: str, checksum: str = "") -> dict[str, Any]:
    path = Path(raw_path)
    if not path.is_file():
        raise FileNotFoundError(path)
    digest = checksum.strip().lower()
    if len(digest) != 64:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return {
        "kind": kind,
        "uri": path.resolve().as_uri(),
        "path": str(path),
        "size": path.stat().st_size,
        "sha256": digest,
    }


def _write_acquisition_manifest(
    storage_root: Path,
    flow_no: str | int,
    *,
    session_id: str,
    latest_round: int,
) -> Path:
    event_path = frame_event_path(storage_root, flow_no, latest_round)
    event = json.loads(event_path.read_text(encoding="utf-8-sig"))
    if event.get("complete") is not True:
        raise ValueError("closed flow cannot publish an incomplete acquisition manifest")
    cameras = []
    for frame in event.get("frames", []):
        checksums = frame.get("checksums", {})
        if not isinstance(checksums, dict):
            checksums = {}
        cameras.append(
            {
                "cameraId": frame.get("cameraId"),
                "cameraKey": frame.get("cameraKey"),
                "sequenceNo": frame.get("sequenceNo"),
                "captureRound": frame.get("captureRound"),
                "capturedAt": frame.get("capturedAt"),
                "artifacts": [
                    _artifact("depth", str(frame.get("depthPath", "")), str(checksums.get("depth", ""))),
                    _artifact("intensity", str(frame.get("intensityPath", "")), str(checksums.get("intensity", ""))),
                    _artifact("metadata", str(frame.get("metadataPath", "")), str(checksums.get("metadata", ""))),
                ],
            }
        )
    material_id = str(int(flow_no))
    payload = {
        "schema": "steel.acquisition-manifest.v1",
        "inspectionId": material_id,
        "captureId": f"{session_id}:{material_id}",
        "sessionId": session_id,
        "sourceType": "sick-gentl",
        "complete": True,
        "expectedCameraCount": int(event.get("expectedCameraCount", len(cameras))),
        "actualCameraCount": len(cameras),
        "latestCommittedRound": latest_round,
        "committedEvent": _artifact("frame-committed-event", str(event_path)),
        "cameras": cameras,
    }
    path = acquisition_manifest_path(storage_root, flow_no)
    atomic_summary(path, payload)
    return path
