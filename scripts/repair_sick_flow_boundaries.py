#!/usr/bin/env python3
"""Split a historically merged SICK flow without modifying its raw archive.

The repair is deliberately conservative:

* boundaries are replayed from one configured reference camera;
* the first no-steel round closes the old bar (one-round decision);
* depth/intensity payloads are hard-linked, never rewritten;
* frame metadata and committed events are rebuilt for the new flow ids;
* the live SQLite database is backed up before any row is changed;
* the source flow remains on disk and is only hidden from normal record lists.

Dry-run is the default.  Pass ``--apply`` only after inspecting the printed
segment table.
"""

from __future__ import annotations

import argparse
import copy
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import time
from typing import Any, Iterable

from sick_capture.events import (
    publish_committed_round,
    publish_flow_handoff,
    write_flow_manifest,
)
from sick_capture.paths import capture_root, flow_root, frame_event_root
from sick_capture.playback import remove_material_from_playback_catalog
from sick_capture.profile import SickCaptureProfile, load_profile
from sick_capture.storage import atomic_summary


REPAIR_SCHEMA = "steel.capture-boundary-repair.v1"
REPAIR_SOURCE = "grayscale-boundary-repair"


@dataclass(frozen=True)
class ReferenceObservation:
    capture_round: int
    storage_index: int
    bright_pixel_ratio: float
    steel_present: bool


@dataclass(frozen=True)
class BoundarySegment:
    ordinal: int
    start_round: int
    end_round: int
    start_storage_index: int
    end_storage_index: int


@dataclass
class PreparedFlow:
    flow_no: int
    session_id: str
    inspection_id: str
    segment: BoundarySegment
    image_rows: list[tuple[Any, ...]]
    capture_rows: list[tuple[Any, ...]]
    started_at: str
    finished_at: str
    latest_round: int

    @property
    def image_count(self) -> int:
        return len(self.image_rows)


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError(f"JSON object required: {path}")
    return payload


def load_committed_events(storage_root: Path, source_flow: int) -> list[dict[str, Any]]:
    root = frame_event_root(storage_root, source_flow)
    if not root.is_dir():
        raise FileNotFoundError(root)
    events: list[dict[str, Any]] = []
    seen_rounds: set[int] = set()
    for path in sorted(root.glob("*.json")):
        if not path.stem.isdecimal():
            continue
        event = _read_json(path)
        if event.get("schema") != "steel.capture-frame-committed.v1":
            raise ValueError(f"invalid committed event schema: {path}")
        if int(event.get("flowNo", -1)) != source_flow:
            raise ValueError(f"event belongs to another flow: {path}")
        capture_round = int(event.get("captureRound", -1))
        if capture_round < 0 or capture_round in seen_rounds:
            raise ValueError(f"duplicate/invalid capture round: {path}")
        frames = event.get("frames")
        if not isinstance(frames, list):
            raise ValueError(f"event frames must be an array: {path}")
        seen_rounds.add(capture_round)
        events.append(event)
    if not events:
        raise ValueError(f"no committed events found for flow {source_flow}")
    events.sort(key=lambda item: int(item["captureRound"]))
    return events


def reference_observations(
    events: Iterable[dict[str, Any]],
    reference_camera: str,
    bright_ratio_threshold: float,
) -> list[ReferenceObservation]:
    observations: list[ReferenceObservation] = []
    for event in events:
        matching = [
            frame
            for frame in event.get("frames", [])
            if str(frame.get("cameraId", "")).casefold()
            == reference_camera.casefold()
        ]
        if not matching:
            # Missing/offline reference frames are unknown, not steel-out.
            continue
        if len(matching) != 1:
            raise ValueError(
                f"round {event.get('captureRound')} contains duplicate "
                f"reference camera {reference_camera}"
            )
        frame = matching[0]
        ratio = float(frame.get("brightPixelRatio", 0.0) or 0.0)
        observations.append(
            ReferenceObservation(
                capture_round=int(event["captureRound"]),
                storage_index=int(frame.get("storageIndex", -1)),
                bright_pixel_ratio=ratio,
                steel_present=ratio >= bright_ratio_threshold,
            )
        )
    if not observations:
        raise ValueError(f"reference camera {reference_camera} has no committed frames")
    return observations


def detect_one_round_segments(
    observations: Iterable[ReferenceObservation],
) -> list[BoundarySegment]:
    """Return closed signal runs, including one no-signal post-roll frame.

    When steel-out was observed but its business callback failed, the capture
    sidecar intentionally did not commit the no-steel rounds.  The next bar is
    therefore adjacent in camera storage while its global capture round jumps.
    Such a missing committed round is also a one-round boundary observation.
    """
    start: ReferenceObservation | None = None
    previous: ReferenceObservation | None = None
    segments: list[BoundarySegment] = []
    for observation in observations:
        if (
            start is not None
            and previous is not None
            and observation.capture_round > previous.capture_round + 1
        ):
            segments.append(
                BoundarySegment(
                    ordinal=len(segments) + 1,
                    start_round=start.capture_round,
                    end_round=previous.capture_round,
                    start_storage_index=start.storage_index,
                    end_storage_index=previous.storage_index,
                )
            )
            start = observation if observation.steel_present else None
            previous = observation
            continue
        if start is None:
            if observation.steel_present:
                start = observation
            previous = observation
            continue
        if observation.steel_present:
            previous = observation
            continue
        segments.append(
            BoundarySegment(
                ordinal=len(segments) + 1,
                start_round=start.capture_round,
                end_round=observation.capture_round,
                start_storage_index=start.storage_index,
                end_storage_index=observation.storage_index,
            )
        )
        start = None
        previous = observation
    # An unterminated final signal run is deliberately excluded.  Historical
    # repair must never fabricate a tail boundary that was not observed.
    return segments


def split_segments_before_storage_indices(
    segments: Iterable[BoundarySegment],
    observations: Iterable[ReferenceObservation],
    storage_indices: Iterable[int],
) -> list[BoundarySegment]:
    """Apply audited operator boundaries that fall inside a continuous run.

    Very short inter-bar gaps can occur inside one camera round, leaving no
    all-dark reference frame for the ordinary one-round detector.  An
    operator-confirmed index names the first reference-camera frame belonging
    to the following bar.  The immutable frame is never divided or rewritten;
    the split is made immediately before that frame.
    """
    result = list(segments)
    observation_rows = list(observations)
    observation_by_index: dict[int, ReferenceObservation] = {}
    for observation in observation_rows:
        if observation.storage_index in observation_by_index:
            raise ValueError(
                "duplicate reference-camera storage index: "
                f"{observation.storage_index}"
            )
        observation_by_index[observation.storage_index] = observation

    requested = sorted({int(value) for value in storage_indices})
    for storage_index in requested:
        split_observation = observation_by_index.get(storage_index)
        if split_observation is None:
            raise ValueError(
                "forced boundary does not name a committed reference frame: "
                f"{storage_index}"
            )
        if not split_observation.steel_present:
            raise ValueError(
                "forced boundary must name the first steel-present frame: "
                f"{storage_index}"
            )

        # Repeating an already detected boundary is harmless and keeps the CLI
        # deterministic when a reviewed annotation later becomes detectable.
        if any(item.start_storage_index == storage_index for item in result):
            continue

        matches = [
            (index, item)
            for index, item in enumerate(result)
            if item.start_storage_index < storage_index <= item.end_storage_index
        ]
        if len(matches) != 1:
            raise ValueError(
                "forced boundary is outside a detected closed bar segment: "
                f"{storage_index}"
            )
        segment_index, segment = matches[0]
        preceding = [
            item
            for item in observation_rows
            if segment.start_round <= item.capture_round < split_observation.capture_round
            and segment.start_storage_index <= item.storage_index < storage_index
        ]
        if not preceding:
            raise ValueError(
                "forced boundary has no preceding frame in its bar segment: "
                f"{storage_index}"
            )
        previous = max(preceding, key=lambda item: item.capture_round)
        left = BoundarySegment(
            ordinal=0,
            start_round=segment.start_round,
            end_round=previous.capture_round,
            start_storage_index=segment.start_storage_index,
            end_storage_index=previous.storage_index,
        )
        right = BoundarySegment(
            ordinal=0,
            start_round=split_observation.capture_round,
            end_round=segment.end_round,
            start_storage_index=split_observation.storage_index,
            end_storage_index=segment.end_storage_index,
        )
        result[segment_index : segment_index + 1] = [left, right]

    return [
        BoundarySegment(
            ordinal=index,
            start_round=item.start_round,
            end_round=item.end_round,
            start_storage_index=item.start_storage_index,
            end_storage_index=item.end_storage_index,
        )
        for index, item in enumerate(result, start=1)
    ]


def segment_report(
    segments: list[BoundarySegment], observations: list[ReferenceObservation]
) -> list[dict[str, Any]]:
    next_starts = {
        segments[index].ordinal: segments[index + 1].start_storage_index
        for index in range(len(segments) - 1)
    }
    next_start_rounds = {
        segments[index].ordinal: segments[index + 1].start_round
        for index in range(len(segments) - 1)
    }
    ratios = {item.storage_index: item.bright_pixel_ratio for item in observations}
    return [
        {
            **asdict(segment),
            "endBrightPixelRatio": ratios.get(segment.end_storage_index),
            "nextStartStorageIndex": next_starts.get(segment.ordinal),
            "gapFramesBeforeNext": (
                next_starts[segment.ordinal] - segment.end_storage_index - 1
                if segment.ordinal in next_starts
                else None
            ),
            "missingCaptureRoundsBeforeNext": (
                next_start_rounds[segment.ordinal] - segment.end_round - 1
                if segment.ordinal in next_start_rounds
                else None
            ),
        }
        for segment in segments
    ]


def _utc_ms() -> str:
    return str(time.time_ns() // 1_000_000)


def _safe_payload(raw: str) -> dict[str, Any]:
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError, json.JSONDecodeError):
        payload = {"originalRawPayload": str(raw)}
    return payload if isinstance(payload, dict) else {"originalRawPayload": payload}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _artifact_digest(checksums: dict[str, Any], kind: str) -> str:
    aliases = (
        ("depth", "steelDepth", "lg3d3d")
        if kind == "depth"
        else ("intensity", "steelIntensity", "lg3d2d")
    )
    for alias in aliases:
        value = str(checksums.get(alias, "")).strip().lower()
        if len(value) == 64:
            return value
    return ""


def _hardlink(source: Path, target: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise FileExistsError(target)
    os.link(source, target)


def rewrite_frame_metadata(
    source: dict[str, Any],
    *,
    source_flow: int,
    target_flow: int,
    session_id: str,
    inspection_id: str,
    reference_camera: str,
    sequence_no: int,
    capture_round: int,
    depth_path: Path,
    intensity_path: Path,
    metadata_path: Path,
    camera_config_path: Path,
) -> dict[str, Any]:
    payload = copy.deepcopy(source)
    storage_index = sequence_no - 1
    production_event_id = f"FLOW-{target_flow:010d}"
    sync_group_id = f"{production_event_id}:round-{capture_round:012d}"
    replacements = {
        "coilId": str(target_flow),
        "sessionId": session_id,
        "inspectionId": inspection_id,
        "productionEventId": production_event_id,
        "syncGroupId": sync_group_id,
        "captureRound": capture_round,
        "save_index": storage_index,
        "sequenceNo": sequence_no,
        "depthOutput": str(depth_path),
        "intensityOutput": str(intensity_path),
        "metadataOutput": str(metadata_path),
    }
    payload.update(replacements)
    payload["lg3d"] = {
        "depthOutput": str(depth_path),
        "intensityOutput": str(intensity_path),
        "metadataOutput": str(metadata_path),
    }
    provenance = {
        "schema": REPAIR_SCHEMA,
        "sourceFlowNo": source_flow,
        "sourceMetadataPath": str(source.get("metadataOutput", "")),
        "boundaryDecisionRounds": 1,
        "referenceCamera": reference_camera,
    }
    payload["boundaryRepair"] = provenance

    artifact = payload.get("frameArtifact")
    if isinstance(artifact, dict):
        artifact.update(
            {
                "inspectionId": inspection_id,
                "materialId": str(target_flow),
                "sessionId": session_id,
                "productionEventId": production_event_id,
                "syncGroupId": sync_group_id,
                "captureRound": capture_round,
                "boundaryRepair": provenance,
            }
        )
        sequence = artifact.get("sequence")
        if isinstance(sequence, dict):
            sequence["storageIndex"] = storage_index
            sequence["sequenceNo"] = sequence_no
        artifacts = artifact.get("artifacts")
        if isinstance(artifacts, dict):
            artifacts.update(
                {
                    "depth": str(depth_path),
                    "intensity": str(intensity_path),
                    "metadata": str(metadata_path),
                    "cameraConfig": str(camera_config_path),
                }
            )
    return payload


def _frame_time_ms(frame: dict[str, Any]) -> int:
    host_ns = int(frame.get("hostUtcNs", 0) or 0)
    if host_ns > 0:
        return host_ns // 1_000_000
    text = str(frame.get("capturedAt", "")).strip()
    if text:
        return int(
            datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000
        )
    return time.time_ns() // 1_000_000


def _camera_map(profile: SickCaptureProfile) -> dict[str, Any]:
    return {camera.camera_id: camera for camera in profile.enabled_cameras}


def _ensure_target_roots_absent(
    profile: SickCaptureProfile, flow_numbers: Iterable[int]
) -> None:
    cameras = _camera_map(profile)
    for flow_no in flow_numbers:
        paths = [flow_root(profile.storage_root, flow_no)] + [
            capture_root(camera.storage_root, flow_no, camera.camera_id)
            for camera in cameras.values()
        ]
        existing = [str(path) for path in paths if path.exists()]
        if existing:
            raise FileExistsError(
                f"repair target {flow_no} already exists: {', '.join(existing)}"
            )


def _copy_camera_configs(
    profile: SickCaptureProfile, source_flow: int, target_flow: int
) -> None:
    for camera in profile.enabled_cameras:
        source = capture_root(
            camera.storage_root, source_flow, camera.camera_id
        ) / "camera_config.json"
        target = capture_root(
            camera.storage_root, target_flow, camera.camera_id
        ) / "camera_config.json"
        if not source.is_file():
            raise FileNotFoundError(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def prepare_segment(
    profile: SickCaptureProfile,
    source_flow: int,
    target_flow: int,
    segment: BoundarySegment,
    events: list[dict[str, Any]],
    reference_camera: str,
) -> PreparedFlow:
    cameras = _camera_map(profile)
    selected = [
        event
        for event in events
        if segment.start_round <= int(event["captureRound"]) <= segment.end_round
    ]
    if not selected:
        raise ValueError(f"segment {segment.ordinal} contains no events")
    session_id = f"boundary-repair-{source_flow}-{segment.ordinal:02d}-{target_flow}"
    inspection_id = f"INSP-{session_id}"
    _copy_camera_configs(profile, source_flow, target_flow)

    sequence_by_camera = {camera_id: 0 for camera_id in cameras}
    image_rows: list[tuple[Any, ...]] = []
    capture_rows: list[tuple[Any, ...]] = []
    frame_times: list[int] = []
    image_no = 0
    expected_camera_ids = list(cameras)

    for event_index, event in enumerate(selected):
        capture_round = int(event["captureRound"])
        committed_rows: list[dict[str, Any]] = []
        frames = sorted(event.get("frames", []), key=lambda row: str(row.get("cameraId", "")))
        for frame in frames:
            camera_id = str(frame.get("cameraId", "")).strip()
            if camera_id not in cameras:
                raise ValueError(f"unknown camera {camera_id!r} in round {capture_round}")
            camera = cameras[camera_id]
            sequence_by_camera[camera_id] += 1
            sequence_no = sequence_by_camera[camera_id]
            storage_index = sequence_no - 1
            target_root = capture_root(camera.storage_root, target_flow, camera_id)
            depth_path = target_root / "3d" / f"{storage_index}.npz"
            intensity_path = target_root / "2d" / f"{storage_index}.png"
            metadata_path = target_root / "json" / f"{storage_index}.json"
            camera_config_path = target_root / "camera_config.json"
            source_depth = Path(str(frame.get("depthPath", "")))
            source_intensity = Path(str(frame.get("intensityPath", "")))
            source_metadata = Path(str(frame.get("metadataPath", "")))
            _hardlink(source_depth, depth_path)
            _hardlink(source_intensity, intensity_path)
            metadata = rewrite_frame_metadata(
                _read_json(source_metadata),
                source_flow=source_flow,
                target_flow=target_flow,
                session_id=session_id,
                inspection_id=inspection_id,
                reference_camera=reference_camera,
                sequence_no=sequence_no,
                capture_round=capture_round,
                depth_path=depth_path,
                intensity_path=intensity_path,
                metadata_path=metadata_path,
                camera_config_path=camera_config_path,
            )
            atomic_summary(metadata_path, metadata)
            source_checksums = frame.get("checksums", {})
            if not isinstance(source_checksums, dict):
                source_checksums = {}
            checksums = dict(source_checksums)
            depth_digest = _artifact_digest(checksums, "depth") or _sha256(depth_path)
            intensity_digest = _artifact_digest(checksums, "intensity") or _sha256(intensity_path)
            checksums.update(
                {
                    "depth": depth_digest,
                    "intensity": intensity_digest,
                    "metadata": _sha256(metadata_path),
                    "steelDepth": depth_digest,
                    "steelIntensity": intensity_digest,
                }
            )
            captured_at = str(frame.get("capturedAt", ""))
            frame_ms = _frame_time_ms(frame)
            frame_times.append(frame_ms)
            image_no += 1
            image_rows.append(
                (
                    target_flow,
                    image_no,
                    inspection_id,
                    session_id,
                    str(target_flow),
                    camera_id,
                    camera.ip,
                    sequence_no,
                    str(depth_path),
                    str(intensity_path),
                    str(metadata_path),
                    int(metadata.get("width", 0) or 0),
                    int(metadata.get("height", 0) or 0),
                    float(frame.get("meanIntensity", 0.0) or 0.0),
                    captured_at,
                    str(frame_ms),
                )
            )
            for data_name, file_type, artifact_path in (
                ("depth", "npz", depth_path),
                ("intensity", "png", intensity_path),
                ("metadata", "json", metadata_path),
            ):
                capture_rows.append(
                    (
                        f"CAP-REPAIR-{source_flow}-{target_flow}-{camera_id}-{sequence_no}-{data_name}",
                        inspection_id,
                        session_id,
                        str(target_flow),
                        camera_id,
                        camera.ip,
                        data_name,
                        sequence_no,
                        file_type,
                        str(artifact_path),
                        str(metadata_path),
                        str(frame_ms),
                    )
                )
            committed_rows.append(
                {
                    "round": capture_round,
                    "cameraId": camera_id,
                    "cameraKey": str(frame.get("cameraKey", camera.key)),
                    "sequenceNo": sequence_no,
                    "depthOutput": str(depth_path),
                    "intensityOutput": str(intensity_path),
                    "metadataOutput": str(metadata_path),
                    "capturedAt": captured_at,
                    "hostUtcNs": int(frame.get("hostUtcNs", 0) or 0),
                    "deviceTimestamp": int(frame.get("deviceTimestamp", 0) or 0),
                    "meanIntensity": float(frame.get("meanIntensity", 0.0) or 0.0),
                    "brightPixelRatio": float(frame.get("brightPixelRatio", 0.0) or 0.0),
                    "imageQuality": dict(frame.get("imageQuality", {})),
                    "checksums": checksums,
                }
            )
        if not committed_rows:
            continue
        boundary_phase = (
            "entry-trigger"
            if event_index == 0
            else "post-roll"
            if event_index == len(selected) - 1
            else "normal"
        )
        publish_committed_round(
            profile.storage_root,
            target_flow,
            session_id,
            committed_rows,
            boundary_phase=boundary_phase,
            expected_camera_ids=expected_camera_ids,
            artifacts_verified=True,
        )

    if not image_rows or not frame_times:
        raise ValueError(f"segment {segment.ordinal} contains no committed frames")
    camera_roots = {
        camera.camera_id: capture_root(
            camera.storage_root, target_flow, camera.camera_id
        )
        for camera in profile.enabled_cameras
    }
    write_flow_manifest(
        profile.storage_root,
        target_flow,
        session_id=session_id,
        state="closed",
        camera_roots=camera_roots,
        latest_round=segment.end_round,
        recover_latest_complete=True,
    )
    return PreparedFlow(
        flow_no=target_flow,
        session_id=session_id,
        inspection_id=inspection_id,
        segment=segment,
        image_rows=image_rows,
        capture_rows=capture_rows,
        started_at=str(min(frame_times)),
        finished_at=str(max(frame_times)),
        latest_round=segment.end_round,
    )


def backup_database(database_path: Path, backup_path: Path) -> None:
    if backup_path.exists():
        raise FileExistsError(backup_path)
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True, timeout=30)
    target = sqlite3.connect(backup_path, timeout=30)
    try:
        source.backup(target, pages=8192, sleep=0.01)
        result = target.execute("PRAGMA quick_check").fetchone()
        if result != ("ok",):
            raise RuntimeError(f"database backup quick_check failed: {result}")
    finally:
        target.close()
        source.close()


def _connect_database(database_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(database_path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=30000")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def reserve_flow_numbers(
    database_path: Path,
    profile: SickCaptureProfile,
    source_flow: int,
    segments: list[BoundarySegment],
) -> list[int]:
    connection = _connect_database(database_path)
    now = _utc_ms()
    try:
        connection.execute("BEGIN IMMEDIATE")
        source = connection.execute(
            "SELECT * FROM steel_flow WHERE flow_no = ?", (source_flow,)
        ).fetchone()
        if source is None:
            raise ValueError(f"source flow {source_flow} is absent from steel_flow")
        if str(source["status"]) not in {"finished", "superseded"}:
            raise ValueError(
                f"source flow {source_flow} is not closed: status={source['status']}"
            )
        maximum = int(
            connection.execute("SELECT COALESCE(MAX(flow_no), 0) FROM steel_flow").fetchone()[0]
        )
        flow_numbers = list(range(maximum + 1, maximum + 1 + len(segments)))
        for flow_no, segment in zip(flow_numbers, segments):
            session_id = f"boundary-repair-{source_flow}-{segment.ordinal:02d}-{flow_no}"
            raw_payload = json.dumps(
                {
                    "schema": REPAIR_SCHEMA,
                    "state": "staging",
                    "sourceFlowNo": source_flow,
                    "segment": asdict(segment),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            connection.execute(
                """INSERT INTO steel_flow (
                    flow_no, flow_code, session_id, material_id, source, status,
                    next_image_no, image_count, storage_root, started_at,
                    finished_at, updated_at, raw_payload
                ) VALUES (?, ?, ?, ?, ?, 'repair-staging', 1, 0, ?, ?, '', ?, ?)""",
                (
                    flow_no,
                    f"FLOW-{flow_no:010d}",
                    session_id,
                    str(flow_no),
                    REPAIR_SOURCE,
                    str(profile.storage_root),
                    now,
                    now,
                    raw_payload,
                ),
            )
        connection.commit()
        return flow_numbers
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def _merged_payload(raw: str, repair: dict[str, Any]) -> str:
    payload = _safe_payload(raw)
    payload["boundaryRepair"] = repair
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def finalize_database(
    database_path: Path,
    profile: SickCaptureProfile,
    source_flow: int,
    prepared: list[PreparedFlow],
    backup_path: Path,
) -> int:
    connection = _connect_database(database_path)
    now = _utc_ms()
    source_material = None
    source_inspection = None
    try:
        connection.execute("BEGIN IMMEDIATE")
        source = connection.execute(
            "SELECT * FROM steel_flow WHERE flow_no=?", (source_flow,)
        ).fetchone()
        if source is None:
            raise ValueError(f"source flow {source_flow} disappeared")
        source_material = connection.execute(
            "SELECT * FROM material_session WHERE material_id=?", (str(source_flow),)
        ).fetchone()
        source_inspection = connection.execute(
            "SELECT * FROM production_inspection WHERE material_id=?", (str(source_flow),)
        ).fetchone()
        if source_material is None or source_inspection is None:
            raise ValueError("source material_session/production_inspection is incomplete")

        new_flow_numbers = [item.flow_no for item in prepared]
        repair = {
            "schema": REPAIR_SCHEMA,
            "state": "complete",
            "sourceFlowNo": source_flow,
            "newFlowNos": new_flow_numbers,
            "databaseBackup": str(backup_path),
            "completedAtUnixMs": int(now),
        }
        for item in prepared:
            staged = connection.execute(
                "SELECT status FROM steel_flow WHERE flow_no=?", (item.flow_no,)
            ).fetchone()
            if staged is None or staged["status"] != "repair-staging":
                raise ValueError(f"flow {item.flow_no} is not owned repair staging")
            per_flow_repair = {
                **repair,
                "newFlowNo": item.flow_no,
                "segment": asdict(item.segment),
            }
            material_raw = _merged_payload(source_material["raw_payload"], per_flow_repair)
            inspection_raw = _merged_payload(source_inspection["raw_payload"], per_flow_repair)
            connection.execute(
                """INSERT INTO material_session (
                    id, material_id, source, status, control_mode, trigger_mode,
                    steel_type, width_mm, length_mm, thickness_mm, client, hard,
                    storage_root, started_at, finished_at, updated_at, raw_payload
                ) VALUES (?, ?, ?, 'finished', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    item.session_id,
                    str(item.flow_no),
                    REPAIR_SOURCE,
                    source_material["control_mode"],
                    source_material["trigger_mode"],
                    source_material["steel_type"],
                    source_material["width_mm"],
                    source_material["length_mm"],
                    source_material["thickness_mm"],
                    source_material["client"],
                    source_material["hard"],
                    str(profile.storage_root),
                    item.started_at,
                    item.finished_at,
                    now,
                    material_raw,
                ),
            )
            connection.execute(
                """INSERT INTO production_inspection (
                    id, material_id, session_id, status, storage_root,
                    summary_path, started_at, finished_at, capture_count,
                    defect_count, raw_payload
                ) VALUES (?, ?, ?, 'finished', ?, '', ?, ?, 0, 0, ?)""",
                (
                    item.inspection_id,
                    str(item.flow_no),
                    item.session_id,
                    str(profile.storage_root),
                    item.started_at,
                    item.finished_at,
                    inspection_raw,
                ),
            )
            connection.executemany(
                """INSERT INTO steel_flow_image (
                    flow_no, image_no, inspection_id, session_id, material_id,
                    camera_id, camera_ip, camera_sequence_no, depth_path,
                    intensity_path, metadata_path, width, height, mean_intensity,
                    captured_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                item.image_rows,
            )
            connection.executemany(
                """INSERT INTO capture_file (
                    id, inspection_id, session_id, material_id, camera_id,
                    camera_ip, data_name, sequence_no, file_type, path,
                    metadata_path, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                item.capture_rows,
            )
            for event_type, value, created_at in (
                ("steel-in", 1, item.started_at),
                ("steel-out", 0, item.finished_at),
            ):
                connection.execute(
                    """INSERT INTO trigger_event (
                        id, material_id, session_id, source, mode, event_type,
                        command, value, payload, provider_code,
                        provider_response, created_at
                    ) VALUES (?, ?, ?, ?, 'grayscale', ?, 'steelIn', ?, ?, 0, ?, ?)""",
                    (
                        f"TRG-REPAIR-{source_flow}-{item.flow_no}-{event_type}",
                        str(item.flow_no),
                        item.session_id,
                        REPAIR_SOURCE,
                        event_type,
                        value,
                        json.dumps(per_flow_repair, ensure_ascii=False, separators=(",", ":")),
                        json.dumps(
                            {
                                "code": 0,
                                "materialId": str(item.flow_no),
                                "flowNo": item.flow_no,
                                "historicalRepair": True,
                                "present": bool(value),
                            },
                            ensure_ascii=False,
                            separators=(",", ":"),
                        ),
                        created_at,
                    ),
                )
            connection.execute(
                """UPDATE steel_flow SET status='finished', next_image_no=?,
                    image_count=?, started_at=?, finished_at=?, updated_at=?,
                    raw_payload=? WHERE flow_no=? AND status='repair-staging'""",
                (
                    item.image_count + 1,
                    item.image_count,
                    item.started_at,
                    item.finished_at,
                    now,
                    json.dumps(per_flow_repair, ensure_ascii=False, separators=(",", ":")),
                    item.flow_no,
                ),
            )

        source_repair_payload = _merged_payload(source["raw_payload"], repair)
        # ``latest_open_material_session`` treats unknown status strings as
        # open.  Keep the source rows in the service's canonical terminal
        # state and carry logical supersession only in the repair provenance.
        connection.execute(
            """UPDATE steel_flow SET status='finished', updated_at=finished_at,
                raw_payload=? WHERE flow_no=?""",
            (source_repair_payload, source_flow),
        )
        connection.execute(
            """UPDATE material_session SET status='finished', updated_at=finished_at,
                raw_payload=? WHERE id=?""",
            (
                _merged_payload(source_material["raw_payload"], repair),
                source_material["id"],
            ),
        )
        connection.execute(
            "UPDATE production_inspection SET status='finished', raw_payload=? WHERE id=?",
            (
                _merged_payload(source_inspection["raw_payload"], repair),
                source_inspection["id"],
            ),
        )
        connection.execute(
            """UPDATE production_defect SET active=0, superseded_at=?, updated_at=?
                WHERE material_id=? AND active=1""",
            (now, now, str(source_flow)),
        )
        deleted_capture_files = connection.execute(
            "DELETE FROM capture_file WHERE inspection_id=?",
            (source_inspection["id"],),
        ).rowcount
        connection.commit()
        return int(deleted_capture_files)
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def cleanup_staging(
    database_path: Path, profile: SickCaptureProfile, flow_numbers: Iterable[int]
) -> None:
    numbers = [int(value) for value in flow_numbers]
    if not numbers:
        return
    connection = _connect_database(database_path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        for flow_no in numbers:
            connection.execute(
                "DELETE FROM steel_flow WHERE flow_no=? AND status='repair-staging'",
                (flow_no,),
            )
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()
    parents = [profile.storage_root] + [
        camera.storage_root for camera in profile.enabled_cameras
    ]
    for parent in parents:
        resolved_parent = parent.resolve()
        for flow_no in numbers:
            target = (parent / str(flow_no)).resolve()
            if target.parent != resolved_parent or target.name != str(flow_no):
                raise RuntimeError(f"refusing unsafe cleanup target: {target}")
            if target.is_dir():
                shutil.rmtree(target)


def _existing_completed_repair(
    database_path: Path, source_flow: int
) -> list[int] | None:
    connection = _connect_database(database_path)
    try:
        row = connection.execute(
            "SELECT status, raw_payload FROM steel_flow WHERE flow_no=?", (source_flow,)
        ).fetchone()
        if row is None or row["status"] not in {"finished", "superseded"}:
            return None
        repair = _safe_payload(row["raw_payload"]).get("boundaryRepair")
        if not isinstance(repair, dict) or repair.get("schema") != REPAIR_SCHEMA:
            return None
        numbers = [int(value) for value in repair.get("newFlowNos", [])]
        if not numbers:
            return None
        placeholders = ",".join("?" for _ in numbers)
        completed = connection.execute(
            f"SELECT COUNT(*) FROM steel_flow WHERE flow_no IN ({placeholders}) AND status='finished'",
            numbers,
        ).fetchone()[0]
        return numbers if completed == len(numbers) else None
    finally:
        connection.close()


def mark_source_manifest_superseded(
    profile: SickCaptureProfile,
    source_flow: int,
    new_flow_numbers: list[int],
    repair_root: Path,
) -> Path:
    """Keep the source evidence but remove it from algorithm work catalogs."""
    path = flow_root(profile.storage_root, source_flow) / "flow.json"
    payload = _read_json(path)
    if payload.get("schema") != "steel.camera-storage.v3":
        raise ValueError(f"invalid source flow manifest: {path}")
    backup = repair_root / "source-flow.before-supersede.json"
    if not backup.exists():
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup)
    payload["state"] = "superseded"
    payload["boundaryRepair"] = {
        "schema": REPAIR_SCHEMA,
        "state": "complete",
        "sourceFlowNo": source_flow,
        "newFlowNos": list(new_flow_numbers),
    }
    atomic_summary(path, payload)
    remove_material_from_playback_catalog(profile.storage_root, source_flow)
    return backup


def _acquire_lock(lock_path: Path) -> int:
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise RuntimeError(f"repair lock already exists: {lock_path}") from error
    os.write(descriptor, f"pid={os.getpid()}\n".encode("ascii"))
    return descriptor


def _release_lock(lock_path: Path, descriptor: int) -> None:
    os.close(descriptor)
    try:
        lock_path.unlink()
    except FileNotFoundError:
        pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--source-flow", type=int, required=True)
    parser.add_argument("--reference-camera")
    parser.add_argument("--expected-segments", type=int)
    parser.add_argument(
        "--split-before-storage-index",
        type=int,
        action="append",
        default=[],
        help=(
            "operator-confirmed first reference-camera frame of a following "
            "bar; repeat for multiple sub-frame-gap boundaries"
        ),
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--publish-handoff", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    profile = load_profile(args.profile.resolve())
    database_path = args.database.resolve()
    if not database_path.is_file():
        raise FileNotFoundError(database_path)
    defaults = profile.raw.get("captureDefaults", {})
    configured = defaults.get("steelDetectionCameraKeys", [])
    reference_camera = str(args.reference_camera or (configured[0] if configured else "")).strip()
    if not reference_camera:
        raise ValueError("a reference camera is required")
    ratio_threshold = float(defaults.get("steelBrightPixelRatio", 0.02))
    events = load_committed_events(profile.storage_root, args.source_flow)
    observations = reference_observations(events, reference_camera, ratio_threshold)
    segments = detect_one_round_segments(observations)
    forced_starts = sorted(set(args.split_before_storage_index))
    segments = split_segments_before_storage_indices(
        segments,
        observations,
        forced_starts,
    )
    report_rows = segment_report(segments, observations)
    report: dict[str, Any] = {
        "schema": REPAIR_SCHEMA,
        "mode": "apply" if args.apply else "dry-run",
        "sourceFlowNo": args.source_flow,
        "referenceCamera": reference_camera,
        "decisionRounds": 1,
        "boundaryPolicy": "one-round-signal+operator-confirmed-frame-start",
        "forcedStartStorageIndices": forced_starts,
        "brightPixelRatioThreshold": ratio_threshold,
        "committedEventCount": len(events),
        "referenceFrameCount": len(observations),
        "segmentCount": len(segments),
        "segments": report_rows,
    }
    if args.expected_segments is not None and len(segments) != args.expected_segments:
        raise ValueError(
            f"expected {args.expected_segments} segments, detected {len(segments)}"
        )
    if not segments:
        raise ValueError("no complete bar segments detected")
    if not args.apply:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    repair_root = (
        profile.storage_root
        / "system"
        / "repairs"
        / "capture-boundaries"
        / str(args.source_flow)
    )
    lock_path = repair_root / "repair.lock"
    descriptor = _acquire_lock(lock_path)
    reserved: list[int] = []
    finalized = False
    try:
        existing = _existing_completed_repair(database_path, args.source_flow)
        if existing:
            source_manifest_backup = mark_source_manifest_superseded(
                profile,
                args.source_flow,
                existing,
                repair_root,
            )
            report.update({"state": "already-complete", "newFlowNos": existing})
            report["sourceFlowManifestBackup"] = str(source_manifest_backup)
            if args.publish_handoff:
                connection = _connect_database(database_path)
                try:
                    latest_rounds = {
                        flow_no: segment.end_round
                        for flow_no, segment in zip(existing, segments)
                    }
                    for flow_no in existing:
                        row = connection.execute(
                            "SELECT session_id FROM steel_flow WHERE flow_no=?", (flow_no,)
                        ).fetchone()
                        publish_flow_handoff(
                            profile.storage_root,
                            flow_no,
                            session_id=str(row["session_id"]),
                            state="closed",
                            latest_round=latest_rounds.get(flow_no),
                        )
                finally:
                    connection.close()
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 0

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup_path = repair_root / f"steel-inspection-before-{args.source_flow}-{stamp}.sqlite"
        backup_database(database_path, backup_path)
        reserved = reserve_flow_numbers(
            database_path, profile, args.source_flow, segments
        )
        _ensure_target_roots_absent(profile, reserved)
        prepared = [
            prepare_segment(
                profile,
                args.source_flow,
                flow_no,
                segment,
                events,
                reference_camera,
            )
            for flow_no, segment in zip(reserved, segments)
        ]
        deleted_capture_files = finalize_database(
            database_path,
            profile,
            args.source_flow,
            prepared,
            backup_path,
        )
        finalized = True
        source_manifest_backup = mark_source_manifest_superseded(
            profile,
            args.source_flow,
            reserved,
            repair_root,
        )
        report.update(
            {
                "state": "complete",
                "databaseBackup": str(backup_path),
                "sourceRawArchivePreserved": True,
                "sourceFlowManifestBackup": str(source_manifest_backup),
                "sourceCaptureFilesHidden": deleted_capture_files,
                "newFlowNos": reserved,
                "newFlows": [
                    {
                        "flowNo": item.flow_no,
                        "sessionId": item.session_id,
                        "imageCount": item.image_count,
                        "captureFileCount": len(item.capture_rows),
                        "segment": asdict(item.segment),
                    }
                    for item in prepared
                ],
            }
        )
        atomic_summary(repair_root / "report.json", report)
        if args.publish_handoff:
            for item in prepared:
                publish_flow_handoff(
                    profile.storage_root,
                    item.flow_no,
                    session_id=item.session_id,
                    state="closed",
                    latest_round=item.latest_round,
                )
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except BaseException:
        if reserved and not finalized:
            cleanup_staging(database_path, profile, reserved)
        raise
    finally:
        _release_lock(lock_path, descriptor)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"repair failed: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
