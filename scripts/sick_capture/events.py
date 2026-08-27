"""Durable capture-to-algorithm event publication."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .paths import (
    LAYOUT_SCHEMA,
    acquisition_manifest_path,
    flow_manifest_path,
    frame_event_path,
)
from .storage import atomic_summary


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
) -> Path:
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
    if latest_round is not None:
        payload["latestCommittedRound"] = int(latest_round)
    path = flow_manifest_path(storage_root, flow_no)
    atomic_summary(path, payload)
    if (
        state == "closed"
        and latest_round is not None
        and frame_event_path(storage_root, flow_no, latest_round).is_file()
    ):
        _write_acquisition_manifest(
            storage_root,
            flow_no,
            session_id=session_id,
            latest_round=latest_round,
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
