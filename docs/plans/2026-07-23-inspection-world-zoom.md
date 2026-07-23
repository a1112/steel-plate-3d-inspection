# Inspection World Zoom Stability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop BKV inspection-world zoom from flickering or jumping back to maximum while preserving one-shot defect focus and fit-width record loading.

**Architecture:** Represent image-world focus as an explicit revisioned request rather than deriving it continuously from selected defect state. `App` owns the request, `PlateMap` forwards it, and `InspectionWorldCanvas` consumes each revision once after measurement; wheel zoom then owns the view until another request arrives.

**Tech Stack:** React 18, TypeScript, HTML Canvas, ResizeObserver, Vitest, Testing Library

---

### Task 1: Prove the focus/resize zoom regression

**Files:**
- Modify: `app/client/src/components/InspectionWorldCanvas.test.tsx`
- Modify: `app/client/src/components/InspectionWorldCanvas.tsx`

**Step 1: Write the failing canvas test**

Add a test that renders a measured viewport with a revisioned focus request,
records the focused scale, performs Ctrl+wheel zoom out, invokes the captured
`ResizeObserver`, and expects the manual scale to remain below the focused scale.
Rerender with the same defect and a higher revision and expect the focus scale to
be restored.

**Step 2: Run the focused test to verify it fails**

Run:

```powershell
npm test -- --run app/client/src/components/InspectionWorldCanvas.test.tsx
```

Expected: FAIL because viewport resize re-applies the persistent focused defect.

**Step 3: Implement one-shot focus consumption**

Add a typed `focusRequest` prop containing `defectId` and `revision`. Guard the
focus effect until the viewport is measured, track the last consumed revision,
and remove viewport-size changes from the repeat-trigger contract. Keep size
values available for calculating the initial request.

**Step 4: Run the focused test**

Run:

```powershell
npm test -- --run app/client/src/components/InspectionWorldCanvas.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add app/client/src/components/InspectionWorldCanvas.tsx app/client/src/components/InspectionWorldCanvas.test.tsx
git commit -m "fix: make inspection world focus one shot"
```

### Task 2: Separate App selection from focus intent

**Files:**
- Modify: `app/client/src/App.tsx`
- Modify: `app/client/src/App.test.tsx`
- Modify: `app/client/src/components/PlateMap.tsx`
- Modify: `app/client/src/components/PlateMap.test.tsx`
- Modify: `app/client/src/components/BkvCompatibilityApp.tsx`

**Step 1: Write failing integration tests**

Cover three behaviors:

- the automatically selected first defect does not issue a focus request;
- record selection clears any prior focus request;
- explicit selection, including the same defect twice, advances the focus
  revision.

Add a `PlateMap` forwarding assertion if needed to keep the prop boundary
explicit.

**Step 2: Run the focused tests to verify they fail**

Run:

```powershell
npm test -- --run app/client/src/App.test.tsx app/client/src/components/PlateMap.test.tsx
```

Expected: FAIL because `selectedDefectId` is still passed directly as a persistent
focus instruction.

**Step 3: Implement the focus request owner and forwarding**

Create App state `{ defectId: string | null; revision: number }`. Update explicit
defect selection to advance it and record selection to clear it. Add an optional
`worldFocusRequest` prop to `PlateMap` and forward only the active request to
`InspectionWorldCanvas`. Adapt the standalone BKV compatibility view to emit the
same request shape.

**Step 4: Run the focused tests**

Run:

```powershell
npm test -- --run app/client/src/App.test.tsx app/client/src/components/PlateMap.test.tsx app/client/src/components/InspectionWorldCanvas.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add app/client/src/App.tsx app/client/src/App.test.tsx app/client/src/components/PlateMap.tsx app/client/src/components/PlateMap.test.tsx app/client/src/components/BkvCompatibilityApp.tsx
git commit -m "fix: separate defect selection from world focus"
```

### Task 3: Verify zoom stability end to end

**Files:**
- Modify only if verification exposes a regression.

**Step 1: Run the full client suite**

Run:

```powershell
npm test
```

Expected: all tests pass.

**Step 2: Build the production client**

Run:

```powershell
npm run build
```

Expected: TypeScript and Vite build complete successfully.

**Step 3: Verify the local BKV interface**

Open `http://127.0.0.1:5174/`, switch records, and confirm fit-width. Click a
defect, then repeatedly Ctrl+wheel out through LOD transitions and confirm that
scale decreases monotonically until the fit-width minimum without jumping to the
focus scale. Resize the viewport and confirm the manual scale remains stable.
Click the same defect again and confirm one deliberate refocus.

**Step 4: Commit any test-only verification updates**

```powershell
git add app/client
git commit -m "test: cover stable inspection world zoom"
```

Skip this commit when no files changed.
