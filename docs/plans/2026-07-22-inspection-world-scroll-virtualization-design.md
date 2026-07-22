# Inspection World Scroll Virtualization Design

## Goal

Make the long line-scan image world behave like a native scrollable document while retaining bounded tile rendering: normal wheel input scrolls, Ctrl+wheel zooms around the pointer, and switching pipe/record resets to the six-camera fit-width view at the top.

## Confirmed interaction

- The initial view and every record change fit all configured cameras across the viewport width.
- The vertical position resets to the first frame when the record changes.
- A native vertical scrollbar is visible whenever the scaled world is taller than the viewport.
- A horizontal scrollbar appears only when zoom makes the scaled world wider than the viewport.
- Normal mouse-wheel input follows browser scrolling and does not zoom.
- Ctrl+wheel prevents browser page zoom, changes world scale, and preserves the world point beneath the pointer.
- Pointer dragging remains available as an alternate pan gesture and updates the same scroll position.
- Defect focus scrolls the native viewport to the selected defect and applies an appropriate zoom without allocating a world-sized bitmap.

## Architecture

`InspectionWorldCanvas` becomes a native scroll viewport. A lightweight spacer represents the scaled world dimensions and provides browser scroll ranges. A viewport-sized Canvas is sticky inside the scroll container and draws only the current viewport. The Canvas backing store never grows to the full inspection world.

The component keeps `scale`, `scrollLeft`, and `scrollTop` as its view transform. Scroll events are coalesced through `requestAnimationFrame` before React state is updated. The tile selector receives the resulting world-space viewport and returns only intersecting tiles plus one prefetch ring. Requests that leave that set are aborted and cached Blob URLs outside that set are revoked.

The camera labels, defect overlays, and tile positions use the same scroll-derived world origin. View coordinates are clamped through the browser's scroll ranges, so it is impossible to pan into arbitrarily distant empty space.

## Component structure

```text
.inspection-world-viewport       overflow: auto
  .inspection-world-scroll-space scaled world width/height
    .inspection-world-stage      sticky viewport-sized overlay
      canvas                     viewport backing store only
      camera labels
      tile status
```

The stage remains aligned to the scroll viewport by translating it to the current scroll offset. The spacer has no image content and therefore has negligible rendering cost.

## Data flow

1. Measure the viewport excluding visible scrollbar gutters.
2. Compute fit-width scale from `viewportWidth / world.width`.
3. Set spacer dimensions to `world.width * scale` and `world.height * scale`, never smaller than the viewport.
4. Read native `scrollLeft/scrollTop`; convert them to world origin by dividing by scale.
5. Select visible tiles using that world origin and viewport dimensions.
6. Fetch and draw only the selected set.
7. On record change, restore fit-width scale and scroll to `(0, 0)`.
8. On Ctrl+wheel, calculate the pointer's world coordinate, update scale, then set scroll offsets so that coordinate remains beneath the pointer.

## Rendering and performance boundaries

- Canvas pixel dimensions equal the viewport dimensions times the existing device-independent sizing policy, not world dimensions.
- Tile prefetch remains exactly one ring around the visible range.
- Scroll state updates are limited to one per animation frame.
- Obsolete in-flight tile requests are aborted by effect cleanup.
- Tiles outside the active visible/prefetch key set are immediately revoked and removed.
- Camera labels outside the viewport may remain as inexpensive DOM nodes, but are clipped by the viewport; no offscreen source images are decoded or drawn.

## Error and edge handling

- Invalid or zero measurements fall back to the current 1000×600 defaults.
- Scale stays between fit-width and the existing maximum of 8.
- At fit-width, horizontal scroll is reset to zero.
- If a record has a shorter world than the viewport, the spacer fills the viewport without producing negative scroll ranges.
- Failed tiles retain the existing visible error state and retry behavior.
- Record changes abort old requests, revoke old Blob URLs, reset scroll position, and start with the new record's fit-width scale.

## Test strategy

Component tests will first fail against the current implementation and prove:

1. A scroll spacer exposes scaled world dimensions and a native scroll viewport.
2. Plain wheel input does not call `preventDefault` and does not change scale.
3. Ctrl+wheel calls `preventDefault`, changes scale, and preserves the pointer anchor through scroll offsets.
4. Native scroll events update the world origin and request a different bounded tile set.
5. Switching `recordId` restores fit-width scale and zero scroll position.
6. Far-off tiles are aborted/revoked and the active cache stays bounded.

Browser smoke verification will assert visible scroll overflow, simulate plain scrolling and Ctrl+wheel zoom, verify scale/origin changes separately, and confirm tile requests remain below total source-frame count.
