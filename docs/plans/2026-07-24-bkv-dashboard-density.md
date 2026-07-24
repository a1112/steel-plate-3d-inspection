# BKV Dashboard Density Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the BKV online dashboard denser while reserving a real black gutter above inspection-world imagery.

**Architecture:** Keep the existing shared `PlateMap`, `InspectionWorldCanvas`, `Panel`, and `LeftSidebar` components. Add the top gutter to the canvas coordinate conversion and scroll extent, then use BKV/integrated-mode CSS selectors for layout-only changes.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, CSS Grid, Canvas 2D.

---

### Task 1: Move the record match count into the records header

**Files:**
- Modify: `app/client/src/components/LeftSidebar.test.tsx`
- Modify: `app/client/src/components/LeftSidebar.tsx`

**Step 1: Write the failing test**

Update the search test to assert that the `匹配 1 / 2` element is inside the `.records-panel .panel-header`, and that `.record-search-form` does not contain it.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/components/LeftSidebar.test.tsx`

Expected: FAIL because the match count remains inside the search form.

**Step 3: Write minimal implementation**

Remove `.record-search-count` from the form and pass it as the `action` prop of the “检测记录” `Panel`.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/components/LeftSidebar.test.tsx`

Expected: PASS.

### Task 2: Add a real inspection-world top gutter

**Files:**
- Modify: `app/client/src/components/InspectionWorldCanvas.test.tsx`
- Modify: `app/client/src/components/InspectionWorldCanvas.tsx`

**Step 1: Write the failing test**

Assert that the viewport exposes a `data-top-gutter` of `28` and that the initial scroll-space height is the scaled world height plus 28px.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/components/InspectionWorldCanvas.test.tsx`

Expected: FAIL because no top gutter is represented.

**Step 3: Write minimal implementation**

Introduce a 28px constant and apply it to:

- scroll-space height;
- visible world Y conversion;
- tile and defect Y drawing;
- camera separator start position;
- defect-focus scroll target;
- viewport diagnostics.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/components/InspectionWorldCanvas.test.tsx`

Expected: PASS.

### Task 3: Compact the BKV layout and style the integrated toolbar

**Files:**
- Modify: `app/client/src/styles.css`
- Test: `app/client/src/App.test.tsx`

**Step 1: Write the failing structure assertion**

In the BKV app test, assert the presence of `.runtime-bkv`, `.integrated-map-tools`, and a records-header match count. This confirms the selectors required by the layout CSS.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/App.test.tsx`

Expected: FAIL until the match count is moved into the records header.

**Step 3: Write minimal styles**

- Set `.left-column.runtime-bkv` to five explicit rows ending in `minmax(0, 1fr)`.
- Reduce the search form to two compact rows.
- Keep `.records-panel` at `min-height: 0`.
- Style `.integrated-map-tools` as a 34px panel-header-like strip with edge-to-edge placement.
- Remove the integrated panel body padding/gap around the toolbar and world stack.

**Step 4: Run tests and build**

Run:

```powershell
npm test -- src/components/LeftSidebar.test.tsx src/components/InspectionWorldCanvas.test.tsx src/App.test.tsx
npm run build
```

Expected: all selected tests pass and the build exits with code 0.

### Task 4: Browser verification

**Files:**
- No source changes expected.

**Step 1: Open BKV mode**

Use `http://127.0.0.1:5174/?view=bkv`.

**Step 2: Verify layout**

Confirm:

- a black strip separates camera labels from image data;
- the integrated toolbar matches the right filter header and touches the top;
- the search panel is compact;
- `匹配 11 / 11` appears next to “检测记录”;
- the records table fills and scrolls within the remaining left-column height.

**Step 3: Check runtime errors**

Confirm the browser console has no new errors.

