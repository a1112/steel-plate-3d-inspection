# Parameterized Camera 2D Display Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Parameterize the ordered 2D camera lanes so BKV renders six independently loaded images as one UI-composed strip while production can continue to render eight lanes.

**Architecture:** Add a small pure camera-lane parameter module and pass its normalized ordered descriptors into `PlateMap` and the BKV 2D view. Keep image fetching and per-lane Canvas processing independent; the DOM/CSS performs the composition and retains empty/error slots.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, CSS Grid/Canvas.

---

### Task 1: Define and validate ordered camera display parameters

**Files:**
- Create: `app/client/src/lib/camera-display.ts`
- Create: `app/client/src/lib/camera-display.test.ts`

**Step 1: Write the failing test**

Add tests proving that six ordered identifiers become C1-C6 descriptors, custom order is preserved, empty input remains empty, and duplicate stable identifiers throw.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/lib/camera-display.test.ts`

Expected: FAIL because `camera-display.ts` does not exist.

**Step 3: Write minimal implementation**

Export `CameraDisplayLane`, `createSequentialCameraLanes(count)`, and `normalizeCameraDisplayLanes(ids)`. Reject non-positive sequential counts and duplicate/blank identifiers.

**Step 4: Run test to verify it passes**

Run: `npm test -- --run src/lib/camera-display.test.ts`

Expected: all camera parameter tests pass.

**Step 5: Commit**

```bash
git add app/client/src/lib/camera-display.ts app/client/src/lib/camera-display.test.ts
git commit -m "feat: parameterize camera display lanes"
```

### Task 2: Make the online 2D map consume camera parameters

**Files:**
- Modify: `app/client/src/components/PlateMap.tsx`
- Modify: `app/client/src/components/PlateMap.test.tsx`
- Modify: `app/client/src/App.tsx`

**Step 1: Write the failing test**

Render `PlateMap` with six lane descriptors and assert C1-C6 are present, C7/C8 are absent, the region label reports six cameras, and all six slots remain when images are missing.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/components/PlateMap.test.tsx`

Expected: FAIL because `PlateMap` still renders the fixed eight-lane constant.

**Step 3: Write minimal implementation**

Add a required-at-boundary `cameraLanes` prop with an internal eight-lane compatibility default. Replace fixed lane iteration, image count clamping, region labels, tooltip text, and defect camera bounds with the parameter length. Pass an explicit eight-lane configuration from `App`.

**Step 4: Run test to verify it passes**

Run: `npm test -- --run src/components/PlateMap.test.tsx src/App.test.tsx`

Expected: parameterized and existing online tests pass.

**Step 5: Commit**

```bash
git add app/client/src/components/PlateMap.tsx app/client/src/components/PlateMap.test.tsx app/client/src/App.tsx
git commit -m "feat: drive online 2D lanes from camera parameters"
```

### Task 3: Render BKV six-camera 2D as a UI-composed strip

**Files:**
- Modify: `app/client/src/components/BkvCompatibilityApp.tsx`
- Modify: `app/client/src/components/BkvCompatibilityApp.test.tsx`
- Modify: `app/client/src/styles.css`

**Step 1: Write the failing test**

Assert that BKV derives exactly six ordered lane elements from `selected.cameras`, exposes the configured count, keeps a missing camera slot, and does not render C7/C8.

**Step 2: Run test to verify it fails**

Run: `npm test -- --run src/components/BkvCompatibilityApp.test.tsx`

Expected: FAIL because BKV still renders card figures rather than parameterized strip lanes.

**Step 3: Write minimal implementation**

Normalize the material camera identifiers, render one independent lane per camera, retain loading/error placeholders, and apply a CSS grid whose column count comes from `--camera-count`. Keep 2D as the initial view.

**Step 4: Run test to verify it passes**

Run: `npm test -- --run src/components/BkvCompatibilityApp.test.tsx`

Expected: BKV six-lane tests pass.

**Step 5: Commit**

```bash
git add app/client/src/components/BkvCompatibilityApp.tsx app/client/src/components/BkvCompatibilityApp.test.tsx app/client/src/styles.css
git commit -m "feat: compose BKV camera frames in the interface"
```

### Task 4: Verify the complete client and browser behavior

**Files:**
- Modify: `scripts/test-runtime-ui-smoke.ps1` only if the existing BKV selectors need the new lane contract.

**Step 1: Run focused tests**

Run: `npm test -- --run src/lib/camera-display.test.ts src/components/PlateMap.test.tsx src/components/BkvCompatibilityApp.test.tsx src/App.test.tsx`

Expected: all focused tests pass.

**Step 2: Run the full client suite**

Run: `npm test -- --run`

Expected: all client tests pass.

**Step 3: Build production assets**

Run: `npm run build`

Expected: TypeScript and Vite build succeed.

**Step 4: Run BKV browser smoke**

Start the branch client against the existing BKV service, run `scripts/test-runtime-ui-smoke.ps1 -ExpectBkv`, and visually verify six ordered 2D lanes plus the unchanged unfolded and cylinder modes.

**Step 5: Commit any smoke-contract adjustment**

```bash
git add scripts/test-runtime-ui-smoke.ps1
git commit -m "test: verify parameterized BKV camera strip"
```
