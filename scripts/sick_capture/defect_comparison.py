"""Deterministic comparison and composition for geometry and legacy candidates."""

from __future__ import annotations

from typing import Any, Iterable


def _rect(defect: dict[str, Any]) -> tuple[float, float, float, float] | None:
    value = defect.get("imageRect2d")
    if not isinstance(value, dict):
        return None
    try:
        left = float(value["left"])
        top = float(value["top"])
        right = float(value["right"])
        bottom = float(value["bottom"])
    except (KeyError, TypeError, ValueError):
        return None
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def rectangle_iou(left: dict[str, Any], right: dict[str, Any]) -> float:
    """Return source-image IoU, treating malformed rectangles as non-matches."""
    first = _rect(left)
    second = _rect(right)
    if first is None or second is None:
        return 0.0
    intersection_width = max(0.0, min(first[2], second[2]) - max(first[0], second[0]))
    intersection_height = max(0.0, min(first[3], second[3]) - max(first[1], second[1]))
    intersection = intersection_width * intersection_height
    first_area = (first[2] - first[0]) * (first[3] - first[1])
    second_area = (second[2] - second[0]) * (second[3] - second[1])
    return intersection / max(first_area + second_area - intersection, 1e-12)


def compare_candidate_groups(
    geometry: Iterable[dict[str, Any]],
    legacy: Iterable[dict[str, Any]],
    *,
    minimum_iou: float = 0.20,
) -> dict[str, Any]:
    """Greedily pair candidates from the same camera and source frame."""
    geometry_rows = [row for row in geometry if isinstance(row, dict)]
    legacy_rows = [row for row in legacy if isinstance(row, dict)]
    possible: list[tuple[float, str, str, int, int]] = []
    for geometry_index, geometry_row in enumerate(geometry_rows):
        for legacy_index, legacy_row in enumerate(legacy_rows):
            if str(geometry_row.get("cameraId", "")) != str(
                legacy_row.get("cameraId", "")
            ):
                continue
            if geometry_row.get("storageIndex") != legacy_row.get("storageIndex"):
                continue
            overlap = rectangle_iou(geometry_row, legacy_row)
            if overlap < minimum_iou:
                continue
            possible.append(
                (
                    overlap,
                    str(geometry_row.get("id", "")),
                    str(legacy_row.get("id", "")),
                    geometry_index,
                    legacy_index,
                )
            )
    # The ids make equal-IoU assignment stable across platforms and runs.
    possible.sort(key=lambda row: (-row[0], row[1], row[2]))
    used_geometry: set[int] = set()
    used_legacy: set[int] = set()
    matches: list[dict[str, Any]] = []
    for overlap, _geometry_id, _legacy_id, geometry_index, legacy_index in possible:
        if geometry_index in used_geometry or legacy_index in used_legacy:
            continue
        used_geometry.add(geometry_index)
        used_legacy.add(legacy_index)
        matches.append(
            {
                "geometryId": geometry_rows[geometry_index].get("id"),
                "legacyId": legacy_rows[legacy_index].get("id"),
                "cameraId": geometry_rows[geometry_index].get("cameraId"),
                "storageIndex": geometry_rows[geometry_index].get("storageIndex"),
                "iou": round(overlap, 8),
            }
        )
    geometry_only = [
        row.get("id") for index, row in enumerate(geometry_rows) if index not in used_geometry
    ]
    legacy_only = [
        row.get("id") for index, row in enumerate(legacy_rows) if index not in used_legacy
    ]
    return {
        "schema": "steel.sick-defect-group-comparison.v1",
        "minimumIoU": minimum_iou,
        "iouThreshold": minimum_iou,
        "matched": len(matches),
        "geometryOnly": len(geometry_only),
        "legacyOnly": len(legacy_only),
        "matches": matches,
        "geometryOnlyIds": geometry_only,
        "legacyOnlyIds": legacy_only,
        "matchedCount": len(matches),
        "geometryOnlyCount": len(geometry_only),
        "legacyOnlyCount": len(legacy_only),
        "estimatedUniqueCount": len(matches) + len(geometry_only) + len(legacy_only),
    }


def _group(manifest: dict[str, Any], source: str) -> dict[str, Any]:
    defects = manifest.get("defects", [])
    rows = defects if isinstance(defects, list) else []
    return {
        "schema": manifest.get("schema"),
        "source": source,
        "state": manifest.get("state", "unavailable"),
        "algorithmRevision": manifest.get("algorithmRevision"),
        "configHash": manifest.get("configHash"),
        "modelHash": manifest.get("modelHash"),
        "globalPositionAvailable": manifest.get("globalPositionAvailable"),
        "riskTags": manifest.get("riskTags", []),
        "error": manifest.get("error"),
        "quality": manifest.get("quality", {}),
        "statistics": manifest.get("statistics", {"defectCount": len(rows)}),
        "defects": rows,
    }


def compose_dual_manifest(
    legacy_manifest: dict[str, Any],
    geometry_manifest: dict[str, Any],
    *,
    minimum_iou: float = 0.20,
) -> dict[str, Any]:
    """Create the backward-compatible aggregate manifest used by APIs and UI."""
    legacy = _group(legacy_manifest, "sick-temporary-defect-model")
    geometry = _group(geometry_manifest, "sick-depth-geometry")
    comparison = compare_candidate_groups(
        geometry["defects"], legacy["defects"], minimum_iou=minimum_iou
    )
    comparison["cameraLocal"] = not bool(
        geometry_manifest.get("globalPositionAvailable")
    )
    comparison["riskTags"] = geometry_manifest.get("riskTags", [])
    comparison["warning"] = (
        "Matched pairs are a same-camera/same-frame estimate; both original candidates are retained."
    )
    union = [*geometry["defects"], *legacy["defects"]]
    states = {str(geometry["state"]), str(legacy["state"])}
    if states <= {"complete", "ready"}:
        state = "complete"
    elif "database-write-failed" in states or "failed" in states:
        state = "degraded"
    elif states == {"disabled"}:
        state = "disabled"
    else:
        state = "degraded"
    base = dict(legacy_manifest)
    base.update(
        {
            "schema": "steel.sick-flow-defect-detection.v1",
            "state": state,
            "temporaryModel": True,
            "algorithmRevision": geometry.get("algorithmRevision"),
            "configHash": geometry.get("configHash"),
            "algorithmConfigHash": geometry.get("configHash"),
            "defectGroups": {"geometry": geometry, "legacy": legacy},
            "comparison": comparison,
            # Deliberately retain a union for old clients. It is a sum, not a
            # deduplicated semantic defect count.
            "defects": union,
            "statistics": {
                **(
                    legacy_manifest.get("statistics", {})
                    if isinstance(legacy_manifest.get("statistics"), dict)
                    else {}
                ),
                "geometryDefectCount": len(geometry["defects"]),
                "legacyDefectCount": len(legacy["defects"]),
                "defectCount": len(union),
                "estimatedUniqueCount": comparison["estimatedUniqueCount"],
            },
        }
    )
    return base
