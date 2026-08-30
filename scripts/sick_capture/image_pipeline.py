"""Image/geometry pipeline owned by ``steel-image-worker``.

This module deliberately has no camera SDK or provider imports. It consumes
only committed capture artifacts and writes derived, replaceable results.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

from .alignment import AlignmentConfig, _atomic_json, build_and_write_flow_alignment
from .measurement import MeasurementConfig, build_and_write_flow_measurement
from .playback import build_and_write_playback_index
from .regions import build_and_write_flow_region_map
from .surface import build_and_write_flow_surface, measurement_artifact_from_surface


def build_flow_image_artifacts(
    camera_roots: dict[str, Path],
    storage_root: Path,
    material_id: str,
    alignment_config: AlignmentConfig,
    calibration_path: Path | None,
    measurement_config: MeasurementConfig,
) -> tuple[Path, dict[str, Any], Path, dict[str, Any]]:
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
        # This pass only supplies camera crops/audit profiles to the region
        # builder. The authoritative all-anchor diameter pass is the surface
        # calculation below.
        config=replace(measurement_config, maximum_sections=1),
    )
    region_path, region_map = build_and_write_flow_region_map(
        camera_roots,
        storage_root,
        material_id,
        measurement,
    )
    stable_crops = {
        camera_id: row.get("stableCrop")
        for camera_id, row in region_map.get("cameras", {}).items()
        if isinstance(row, dict) and row.get("stableCrop")
    }
    measurement["twoDimensionalCrop"] = stable_crops
    measurement["regions"] = {
        "manifestPath": str(region_path),
        "schema": region_map.get("schema"),
        "state": region_map.get("state"),
        "backgroundReady": region_map.get("backgroundReady"),
        "defectDetectionAllowed": region_map.get("defectDetectionAllowed"),
        "qualityGate": region_map.get("qualityGate"),
        "ownership": region_map.get("ownership"),
    }
    surface_path, surface = build_and_write_flow_surface(
        camera_roots,
        storage_root,
        material_id,
        alignment,
        calibration_path=calibration_path,
        config=measurement_config,
        region_map=region_map,
    )
    measurement = measurement_artifact_from_surface(surface, measurement)
    measurement["surface"] = {
        "path": str(surface_path),
        "state": surface.get("state"),
        "quality": surface.get("quality"),
        "summary": surface.get("summary"),
    }
    _atomic_json(measurement_path, measurement)
    build_and_write_playback_index(camera_roots, storage_root, material_id)
    return alignment_path, alignment, measurement_path, measurement
