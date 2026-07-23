# Inspection World Zoom Stability Design

## Problem

The persisted inspection-world canvas receives the currently selected defect as a
continuous focus instruction. A focused defect chooses a large scale (currently
`4.0` for BKV record `1893700`). Ctrl+wheel zoom changes the scroll extent and can
change the measured viewport when scrollbars appear or disappear. The resize
effect then re-runs defect focus and forces the scale back to the focus scale.
This creates the visible zoom jump and repeated tile redraws perceived as severe
flicker.

The same coupling also means a record with an automatically selected first defect
opens at defect focus instead of the previously agreed fit-width overview.

## Selected Design

Separate defect selection from an explicit image-world focus request.

- Keep `selectedDefectId` unchanged for the defect list and analysis footer.
- Add a small focus request `{ defectId, revision }` owned by `App`.
- Clear the request when the selected record changes.
- Increment `revision` whenever the user explicitly selects a defect, including
  clicking the same defect again.
- Pass the request through `PlateMap` to `InspectionWorldCanvas`.
- Let `InspectionWorldCanvas` consume a request once, after the viewport has been
  measured. Do not make later viewport resizes a reason to repeat the request.
- Ctrl+wheel updates remain authoritative until another explicit focus request or
  record change.

This preserves all selection-dependent UI while restoring fit-width on record
switch and allowing the user to take over the viewport after an automatic focus.

## Alternatives Considered

1. Clear the selected defect on manual zoom. This avoids refocus but incorrectly
   clears the right-hand selection and lower defect analysis.
2. Debounce or ignore some `ResizeObserver` callbacks. This masks the trigger but
   leaves a persistent focus instruction that can fire again for another layout
   change.
3. One-shot focus requests with a revision token. This directly models the user
   intent and supports re-focusing the same defect. This is the selected option.

## Rendering Behavior

- Record load/switch: fit the full world width.
- Explicit defect selection: focus once using the existing padded defect scale.
- Ctrl+wheel: zoom around the pointer and remain at the user-selected scale.
- Native wheel: scroll normally.
- Resize after manual zoom: preserve the user's scale.
- Re-click the same defect: issue a new revision and focus it again.
- LOD fallback tiles remain cached and visible while replacement tiles load.

## Verification

Add regression coverage at two boundaries:

1. `InspectionWorldCanvas`: after a focus request, Ctrl+wheel zoom followed by a
   resize callback must retain the manual zoom; a higher request revision must
   focus again.
2. `App`: initial BKV record and record switches must not pass an automatic focus
   request, while clicking a defect must issue one.

Run the focused Vitest suites, the full client test suite, and the production
client build. Finally verify the running BKV page by checking scale progression
through repeated Ctrl+wheel input and re-click focus.
