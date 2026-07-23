# Camera-local tiles and head alignment design

## Goal

Render BKV and online line-scan imagery as camera-local tiles, place camera columns by their real source widths, automatically align the first valid steel row at the top of the inspection world, and remove visible flashes during zoom and LOD transitions.

## Confirmed scope

- Camera columns use the real width reported for the selected record. They are not normalized to equal widths.
- A tile belongs to exactly one camera and never contains pixels from an adjacent camera.
- Automatic alignment is vertical head alignment only. Horizontal texture registration and calibration are out of scope.
- Original BKV and online source images remain read-only.
- The same metadata and tile contract serves BKV offline replay and persisted online intensity frames.

## World and coordinate model

Each camera retains its raw frame dimensions and ordered frame numbers. The service detects `headOffsetY`, the first reliable steel-content row in the concatenated raw camera stream. Display coordinates are:

```text
displayX = camera.offsetX + localX
displayY = rawY - camera.headOffsetY
```

`camera.offsetX` is the cumulative sum of the real widths of preceding cameras. The displayed camera height is `rawHeight - headOffsetY`; world height is the maximum displayed camera height. Defect rectangles use the same transformation, so overlays remain attached to their source pixels.

Metadata exposes the detected offset, confidence and alignment state. If detection is unreliable, the service uses offset zero and marks that camera as unaligned instead of guessing.

## Head detection

The service examines the first frames needed to find content. For each row it estimates background from dark border pixels and calculates foreground occupancy plus luminance/texture separation. The head is the first row in a stable consecutive run that exceeds the foreground threshold. Short isolated noise runs are ignored.

Detection is computed once when the inspection world is built and then reused through the existing BKV manager or online world cache. Synthetic fixtures cover different brightness levels, leading blank spans and the no-reliable-head fallback.

## Camera-local tile contract

Tile requests add `cameraId`; `x` and `y` are camera-local display-tile coordinates at the requested LOD. The service maps local display Y back to raw Y by adding `headOffsetY`, reads only that camera's intersecting frames, and returns transparent/dark fill outside its valid extent.

The client calculates visible tiles independently for every visible camera, requests them with `cameraId`, and places them at `camera.offsetX`. Divider and label positions therefore share the exact same metadata used to position pixels.

## Stable zoom and LOD rendering

Zoom scale and pointer-anchored scroll offsets are committed as one view state. The DOM scroll position is synchronized in the same layout commit, preventing a frame rendered with a new scale and stale offsets.

The cache keeps the previous drawable LOD generation until all replacement tiles covering the viewport have decoded. Undecoded entries never evict the only visible fallback. LOD selection uses a small hysteresis band so wheel input near a threshold cannot alternate rapidly between adjacent levels.

## Failure handling

- Unreliable head detection: preserve raw Y, expose `aligned: false`.
- Missing source frame: retain its spatial slot and draw the existing missing-tile color.
- Tile fetch/decode failure: keep the previous LOD fallback and show the existing failed-tile status.
- Unknown camera or out-of-range local tile: return a bounded request error.

## Verification

- Rust unit tests verify nonuniform camera widths, head detection, aligned defect coordinates and camera-isolated tile reads.
- Client tests verify exact divider placement, `cameraId` tile requests, atomic zoom state, LOD hysteresis and fallback retention at a full cache.
- Full Rust and client test suites plus the production client build run before completion.
- Browser verification on record `1893700` checks real-width columns, aligned heads, continuous Ctrl+wheel zoom and absence of blank LOD frames.
