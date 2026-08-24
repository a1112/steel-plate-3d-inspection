"""Post-capture head/tail detection and bounded soft synchronization.

The camera clocks do not share an epoch.  Alignment therefore uses each
camera's detected bar head as time zero, retains transport gaps explicitly,
and emits periodic nearest-time anchors without modifying source artifacts.
"""

from __future__ import annotations

import bisect
import datetime as dt
import json
import math
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np

from .paths import alignment_path, capture_root
from .storage import replace_file
from PIL import Image


ALIGNMENT_SCHEMA = "steel.capture-alignment.v1"


@dataclass(frozen=True)
class AlignmentConfig:
    search_frames: int = 8
    stable_rows: int = 8
    sample_step: int = 4
    depth_valid_ratio: float = 0.005
    intensity_threshold: float = 8.0
    intensity_ratio: float = 0.02
    anchor_interval_frames: int = 16
    maximum_anchor_residual_ms: float = 40.0

    def bounded(self) -> "AlignmentConfig":
        return AlignmentConfig(
            search_frames=max(1, min(32, int(self.search_frames))),
            stable_rows=max(1, min(128, int(self.stable_rows))),
            sample_step=max(1, min(32, int(self.sample_step))),
            depth_valid_ratio=max(0.0001, min(1.0, float(self.depth_valid_ratio))),
            intensity_threshold=max(0.0, min(255.0, float(self.intensity_threshold))),
            intensity_ratio=max(0.0001, min(1.0, float(self.intensity_ratio))),
            anchor_interval_frames=max(1, min(512, int(self.anchor_interval_frames))),
            maximum_anchor_residual_ms=max(
                0.1, min(10_000.0, float(self.maximum_anchor_residual_ms))
            ),
        )


def _utc_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _read_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(payload, dict):
        raise ValueError(f"alignment metadata must be an object: {path}")
    return payload


def _numeric_files(
    directory: Path,
    suffix: str,
    *,
    execution_gate: Callable[[str], None] | None = None,
    gate_phase: str = "numeric-file-scan",
) -> dict[int, Path]:
    result: dict[int, Path] = {}
    if execution_gate is not None:
        execution_gate(gate_phase)
    if not directory.is_dir():
        return result
    paths = iter(directory.glob(f"*{suffix}"))
    while True:
        if execution_gate is not None:
            execution_gate(gate_phase)
        try:
            path = next(paths)
        except StopIteration:
            break
        try:
            index = int(path.stem)
        except ValueError:
            continue
        result[index] = path
    return result


def _row_signal(
    intensity: np.ndarray,
    config: AlignmentConfig,
) -> tuple[np.ndarray, np.ndarray]:
    if intensity.ndim != 2:
        raise ValueError(f"alignment intensity plane must be 2D: {intensity.shape}")
    sampled_intensity = intensity[:, :: config.sample_step]
    intensity_ratio = np.mean(
        sampled_intensity > config.intensity_threshold,
        axis=1,
    )
    # Steel-in/out is intentionally a grayscale decision.  A Ranger can keep
    # returning valid range samples from fixtures, scale or dust after the bar
    # has left; OR-ing those samples with intensity makes a sparse, stationary
    # background look like steel across every scan line and clips both ends.
    # Depth belongs to the later measurement stage and is deliberately not
    # decoded here. Avoiding hundreds of large compressed NPZ reads keeps
    # post-flow boundary analysis away from the real-time acquisition budget.
    signal = intensity_ratio >= config.intensity_ratio
    strength = intensity_ratio / config.intensity_ratio
    return signal, strength


def _first_stable_start(signal: np.ndarray, stable_rows: int) -> int | None:
    if signal.size < stable_rows:
        return None
    run = np.convolve(
        signal.astype(np.int16, copy=False),
        np.ones(stable_rows, dtype=np.int16),
        mode="valid",
    )
    matches = np.flatnonzero(run == stable_rows)
    return int(matches[0]) if matches.size else None


def _boundary_detection(
    flow_root: Path,
    frame_indices: list[int],
    config: AlignmentConfig,
    *,
    from_start: bool,
    execution_gate: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    intensity_files = _numeric_files(
        flow_root / "2d",
        ".png",
        execution_gate=execution_gate,
        gate_phase="alignment-boundary-file-scan",
    )
    selected = (
        frame_indices[: config.search_frames]
        if from_start
        else frame_indices[-config.search_frames :]
    )
    row_blocks: list[np.ndarray] = []
    strength_blocks: list[np.ndarray] = []
    heights: list[tuple[int, int]] = []
    for index in selected:
        if execution_gate is not None:
            execution_gate("alignment-boundary-frame-read")
        intensity_path = intensity_files.get(index)
        if intensity_path is None:
            continue
        with Image.open(intensity_path) as image:
            intensity = np.asarray(image.convert("L"))
        signal, strength = _row_signal(intensity, config)
        row_blocks.append(signal)
        strength_blocks.append(strength)
        heights.append((index, int(signal.size)))

    if not row_blocks:
        return {
            "detected": False,
            "reason": "boundary-source-frames-unavailable",
            "clipped": True,
        }

    combined = np.concatenate(row_blocks)
    combined_strength = np.concatenate(strength_blocks)
    if from_start:
        boundary = _first_stable_start(combined, config.stable_rows)
    else:
        reverse_start = _first_stable_start(combined[::-1], config.stable_rows)
        boundary = (
            combined.size - 1 - reverse_start
            if reverse_start is not None
            else None
        )
    if boundary is None:
        return {
            "detected": False,
            "reason": "stable-foreground-not-found",
            "clipped": True,
            "searchedFrames": [index for index, _ in heights],
        }

    local_offset = boundary
    frame_index = heights[0][0]
    row = 0
    global_row = 0
    full_frame_height = heights[0][1]
    for index, height in heights:
        if local_offset < height:
            frame_index = index
            row = int(local_offset)
            global_row = frame_indices.index(index) * full_frame_height + row
            break
        local_offset -= height
    clipped = bool(boundary == 0 if from_start else boundary == combined.size - 1)
    sample_left = max(0, boundary - config.stable_rows + 1)
    sample_right = min(combined_strength.size, boundary + config.stable_rows)
    confidence = float(
        np.clip(np.median(combined_strength[sample_left:sample_right]) / 4.0, 0.0, 1.0)
    )
    return {
        "detected": True,
        "frameIndex": frame_index,
        "row": row,
        "globalRow": int(global_row),
        "clipped": clipped,
        "confidence": round(confidence, 6),
        "source": "grayscale-intensity",
        "searchedFrames": [index for index, _ in heights],
    }


def _frame_records(
    flow_root: Path,
    *,
    execution_gate: Callable[[str], None] | None = None,
) -> list[dict[str, Any]]:
    metadata_files = _numeric_files(
        flow_root / "json",
        ".json",
        execution_gate=execution_gate,
        gate_phase="alignment-metadata-file-scan",
    )
    records: list[dict[str, Any]] = []
    for storage_index, path in sorted(metadata_files.items()):
        if execution_gate is not None:
            execution_gate("alignment-metadata-read")
        payload = _read_json(path)
        timestamp = int(payload.get("timestamp", payload.get("deviceTimestamp", 0)) or 0)
        frequency = int(
            payload.get("timestamp_frequency", payload.get("timestampFrequency", 0)) or 0
        )
        records.append(
            {
                "storageIndex": storage_index,
                "captureRound": int(payload.get("captureRound", 0) or 0),
                "deviceTimestamp": timestamp,
                "timestampFrequency": frequency,
                "hostUtcNs": int(payload.get("hostUtcNs", 0) or 0),
                "transportFrameId": int(payload.get("transportFrameId", 0) or 0),
                "transportFrameGap": int(payload.get("transportFrameGap", 0) or 0),
                "transportFrameGapExplicit": "transportFrameGap" in payload,
                "height": int(payload.get("height", 0) or 0),
                "width": int(payload.get("width", 0) or 0),
                "metadataPath": str(path),
            }
        )
    return records


def _line_rate(flow_root: Path) -> float | None:
    path = flow_root / "camera_config.json"
    if not path.is_file():
        return None
    value = _read_json(path).get("AcquisitionLineRate")
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return None
    return rate if math.isfinite(rate) and rate > 0 else None


def _device_seconds(record: dict[str, Any]) -> float | None:
    timestamp = int(record.get("deviceTimestamp", 0) or 0)
    frequency = int(record.get("timestampFrequency", 0) or 0)
    if timestamp <= 0 or frequency <= 0:
        return None
    return timestamp / frequency


def _boundary_time(
    records: list[dict[str, Any]],
    boundary: dict[str, Any],
    line_rate: float | None,
) -> float | None:
    if not boundary.get("detected"):
        return None
    target = int(boundary.get("frameIndex", -1))
    record = next((item for item in records if item["storageIndex"] == target), None)
    if record is None:
        return None
    seconds = _device_seconds(record)
    if seconds is None:
        return None
    if line_rate:
        seconds += int(boundary.get("row", 0)) / line_rate
    return seconds


def _transport_gaps(records: list[dict[str, Any]]) -> list[dict[str, int]]:
    gaps: list[dict[str, int]] = []
    for previous, current in zip(records, records[1:]):
        before = int(previous.get("transportFrameId", 0) or 0)
        after = int(current.get("transportFrameId", 0) or 0)
        if current.get("transportFrameGapExplicit"):
            missing = int(current.get("transportFrameGap", 0) or 0)
        else:
            capture_before = int(previous.get("captureRound", 0) or 0)
            capture_after = int(current.get("captureRound", 0) or 0)
            expected_delta = (
                max(1, capture_after - capture_before)
                if capture_before > 0 and capture_after > capture_before
                else 1
            )
            missing = (
                max(0, after - before - expected_delta)
                if before > 0 and after > before
                else 0
            )
        if missing:
            gaps.append(
                {
                    "afterStorageIndex": int(previous["storageIndex"]),
                    "beforeStorageIndex": int(current["storageIndex"]),
                    "missingFrames": missing,
                }
            )
    return gaps


def _storage_omissions(records: list[dict[str, Any]]) -> int:
    return sum(
        max(
            0,
            int(current.get("captureRound", 0) or 0)
            - int(previous.get("captureRound", 0) or 0)
            - 1,
        )
        for previous, current in zip(records, records[1:])
    )


def _nearest_record(
    records: list[dict[str, Any]],
    elapsed: list[float],
    target: float,
) -> tuple[dict[str, Any], float] | None:
    if not elapsed:
        return None
    # Device timestamps identify the beginning of a Ranger3 frame block.  Use
    # the block at or immediately before the requested time, then resolve the
    # exact scan line inside it.  Choosing an absolute nearest frame can select
    # the next block and incorrectly clamp a valid section to row zero.
    index = bisect.bisect_right(elapsed, target) - 1
    if index < 0:
        index = 0
    return records[index], elapsed[index] - target


def _percentile(values: Iterable[float], percentile: float) -> float | None:
    samples = list(values)
    if not samples:
        return None
    return float(np.percentile(np.asarray(samples, dtype=np.float64), percentile))


def build_flow_alignment(
    camera_roots: dict[str, Path],
    material_id: str,
    *,
    config: AlignmentConfig | None = None,
    execution_gate: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    settings = (config or AlignmentConfig()).bounded()
    cameras: dict[str, dict[str, Any]] = {}
    for camera_id, camera_root in sorted(camera_roots.items()):
        if execution_gate is not None:
            execution_gate(f"alignment-camera:{camera_id}")
        flow_root = capture_root(camera_root, material_id, camera_id)
        records = _frame_records(flow_root, execution_gate=execution_gate)
        frame_indices = [int(item["storageIndex"]) for item in records]
        if not records:
            cameras[camera_id] = {
                "cameraId": camera_id,
                "flowRoot": str(flow_root),
                "complete": False,
                "reason": "metadata-unavailable",
                "frames": 0,
            }
            continue
        rate = _line_rate(flow_root)
        head = _boundary_detection(
            flow_root,
            frame_indices,
            settings,
            from_start=True,
            execution_gate=execution_gate,
        )
        tail = _boundary_detection(
            flow_root,
            frame_indices,
            settings,
            from_start=False,
            execution_gate=execution_gate,
        )
        head_time = _boundary_time(records, head, rate)
        tail_time = _boundary_time(records, tail, rate)
        elapsed: list[float] = []
        elapsed_records: list[dict[str, Any]] = []
        if head_time is not None:
            for record in records:
                if execution_gate is not None:
                    execution_gate("alignment-elapsed-record")
                seconds = _device_seconds(record)
                if seconds is not None:
                    elapsed.append(seconds - head_time)
                    elapsed_records.append(record)
        gaps = _transport_gaps(records)
        cameras[camera_id] = {
            "cameraId": camera_id,
            "flowRoot": str(flow_root),
            "complete": True,
            "frames": len(records),
            "frameHeight": int(records[0].get("height", 0) or 0),
            "frameWidth": int(records[0].get("width", 0) or 0),
            "lineRateHz": rate,
            "head": head,
            "tail": tail,
            "headDeviceTime": head_time,
            "tailDeviceTime": tail_time,
            "steelDurationMs": round((tail_time - head_time) * 1000.0, 6)
            if head_time is not None and tail_time is not None and tail_time >= head_time
            else None,
            "transportGaps": gaps,
            "transportGapCount": sum(item["missingFrames"] for item in gaps),
            "storageOmittedRounds": _storage_omissions(records),
            "_records": elapsed_records,
            "_elapsed": elapsed,
        }

    usable = [
        row
        for row in cameras.values()
        if row.get("complete")
        and row.get("head", {}).get("detected")
        and row.get("_elapsed")
    ]
    reference = next(
        (row for row in usable if not row.get("head", {}).get("clipped")),
        usable[0] if usable else None,
    )
    anchors: list[dict[str, Any]] = []
    residuals_ms: list[float] = []
    clipped_anchor_mappings = 0
    common_overlap_ms: float | None = None
    if reference is not None:
        reference_records = reference["_records"]
        reference_elapsed = reference["_elapsed"]
        steel_durations = [
            float(row["steelDurationMs"]) / 1000.0
            for row in usable
            if row.get("steelDurationMs") is not None
            and float(row["steelDurationMs"]) >= 0.0
        ]
        common_end = min(steel_durations) if len(steel_durations) == len(usable) else None
        common_overlap_ms = common_end * 1000.0 if common_end is not None else None
        anchor_targets: list[float] = []
        if common_end is not None:
            anchor_targets.append(0.0)
            nonnegative_indices = [
                index for index, value in enumerate(reference_elapsed) if value >= 0.0
            ]
            for reference_index in nonnegative_indices[:: settings.anchor_interval_frames]:
                target = reference_elapsed[reference_index]
                if 0.0 < target < common_end:
                    anchor_targets.append(target)
            if common_end > 0.0 and (
                not anchor_targets or abs(anchor_targets[-1] - common_end) > 1e-9
            ):
                anchor_targets.append(common_end)
        for ordinal, target in enumerate(anchor_targets):
            if execution_gate is not None:
                execution_gate("alignment-anchor")
            reference_index = max(0, bisect.bisect_right(reference_elapsed, target) - 1)
            mapped: dict[str, Any] = {}
            for camera_id, row in cameras.items():
                nearest = _nearest_record(row.get("_records", []), row.get("_elapsed", []), target)
                if nearest is None:
                    mapped[camera_id] = {"available": False}
                    continue
                record, residual = nearest
                residual_ms = residual * 1000.0
                frame_height = int(record.get("height", 0) or 0)
                line_rate = row.get("lineRateHz")
                target_row = (
                    int(round(-residual * float(line_rate)))
                    if line_rate and frame_height > 0
                    else 0
                )
                row_clipped = bool(
                    frame_height <= 0 or target_row < 0 or target_row >= frame_height
                )
                if row_clipped:
                    clipped_anchor_mappings += 1
                interpolation_residual_ms = (
                    (residual + target_row / float(line_rate)) * 1000.0
                    if line_rate and not row_clipped
                    else residual_ms
                )
                residuals_ms.append(abs(interpolation_residual_ms))
                mapped[camera_id] = {
                    "available": True,
                    "storageIndex": record["storageIndex"],
                    "captureRound": record["captureRound"],
                    "transportFrameId": record["transportFrameId"],
                    "timeResidualMs": round(residual_ms, 6),
                    "interpolationResidualMs": round(interpolation_residual_ms, 6),
                    "rowIndex": max(0, min(frame_height - 1, target_row))
                    if frame_height > 0
                    else None,
                    "rowClipped": row_clipped,
                }
            anchors.append(
                {
                    "ordinal": ordinal,
                    "referenceStorageIndex": reference_records[reference_index]["storageIndex"],
                    "elapsedFromHeadMs": round(target * 1000.0, 6),
                    "cameras": mapped,
                }
            )

    head_rows = [
        int(row["head"]["globalRow"])
        for row in usable
        if row.get("head", {}).get("detected")
    ]
    all_complete = len(cameras) == len(camera_roots) and all(
        bool(row.get("complete")) for row in cameras.values()
    )
    all_heads = len(usable) == len(camera_roots)
    no_clipped_heads = all_heads and all(
        not bool(row.get("head", {}).get("clipped")) for row in usable
    )
    all_tails = len(usable) == len(camera_roots) and all(
        bool(row.get("tail", {}).get("detected")) for row in usable
    )
    no_clipped_tails = all_tails and all(
        not bool(row.get("tail", {}).get("clipped")) for row in usable
    )
    p95_residual = _percentile(residuals_ms, 95.0)
    maximum_residual = max(residuals_ms, default=None)
    synchronized = bool(
        all_complete
        and no_clipped_heads
        and no_clipped_tails
        and anchors
        and maximum_residual is not None
        and maximum_residual <= settings.maximum_anchor_residual_ms
        and clipped_anchor_mappings == 0
        and sum(int(row.get("transportGapCount", 0)) for row in cameras.values()) == 0
    )

    for row in cameras.values():
        row.pop("_records", None)
        row.pop("_elapsed", None)
        head = row.get("head", {})
        if head.get("detected") and reference is not None:
            head["offsetRowsFromReference"] = int(head["globalRow"]) - int(
                reference["head"]["globalRow"]
            )

    return {
        "schema": ALIGNMENT_SCHEMA,
        "generatedAt": _utc_text(),
        "materialId": material_id,
        "referenceCameraId": reference.get("cameraId") if reference else None,
        "settings": {
            "searchFrames": settings.search_frames,
            "stableRows": settings.stable_rows,
            "sampleStep": settings.sample_step,
            "depthValidRatio": settings.depth_valid_ratio,
            "intensityThreshold": settings.intensity_threshold,
            "intensityRatio": settings.intensity_ratio,
            "anchorIntervalFrames": settings.anchor_interval_frames,
            "maximumAnchorResidualMs": settings.maximum_anchor_residual_ms,
        },
        "quality": {
            "state": "synchronized" if synchronized else "degraded",
            "synchronized": synchronized,
            "expectedCameras": len(camera_roots),
            "completeCameras": sum(bool(row.get("complete")) for row in cameras.values()),
            "headsDetected": len(usable),
            "clippedHeadCameras": [
                camera_id
                for camera_id, row in cameras.items()
                if bool(row.get("head", {}).get("clipped"))
            ],
            "clippedTailCameras": [
                camera_id
                for camera_id, row in cameras.items()
                if bool(row.get("tail", {}).get("clipped"))
            ],
            "headSpreadRows": max(head_rows) - min(head_rows) if head_rows else None,
            "commonSteelOverlapMs": round(common_overlap_ms, 6)
            if common_overlap_ms is not None
            else None,
            "transportFrameGaps": sum(
                int(row.get("transportGapCount", 0)) for row in cameras.values()
            ),
            "anchorCount": len(anchors),
            "clippedAnchorMappings": clipped_anchor_mappings,
            "anchorResidualP95Ms": round(p95_residual, 6) if p95_residual is not None else None,
            "anchorResidualMaxMs": round(maximum_residual, 6)
            if maximum_residual is not None
            else None,
        },
        "cameras": cameras,
        "softSyncAnchors": anchors,
    }


def alignment_manifest_path(storage_root: Path, material_id: str) -> Path:
    return alignment_path(storage_root, material_id)


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        replace_file(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def build_and_write_flow_alignment(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    *,
    config: AlignmentConfig | None = None,
    execution_gate: Callable[[str], None] | None = None,
) -> tuple[Path, dict[str, Any]]:
    manifest = build_flow_alignment(
        camera_roots,
        material_id,
        config=config,
        execution_gate=execution_gate,
    )
    canonical = alignment_manifest_path(storage_root, material_id)
    if execution_gate is not None:
        execution_gate("alignment-manifest-write")
    _atomic_json(canonical, manifest)
    return canonical, manifest
