# Online Analysis Collapse Control Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the online defect-analysis collapse control to the top-right window controls and reduce the expanded analysis area height.

**Architecture:** `InspectionDashboard` remains the owner of `analysisCollapsed`. It passes an optional collapse-control descriptor through `BrandHeader` to `WindowControls`; the footer keeps analysis-view selection but no longer renders a duplicate collapse button. CSS grid row sizing defines the shorter expanded state while the existing collapsed class removes the analysis row.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, CSS Grid, Lucide React.

---

### Task 1: Add an optional analysis control to the window controls

**Files:**
- Modify: `app/client/src/components/WindowControls.tsx`
- Modify: `app/client/src/components/BrandHeader.tsx`
- Test: `app/client/src/components/BrandHeader.test.tsx`

**Step 1: Write the failing tests**

Add tests which render `BrandHeader` with and without an `analysisCollapse` prop. With the prop, assert that the button named `收起缺陷分析区` appears immediately before the button titled `最小化`, exposes `aria-expanded="true"`, and invokes `onToggle`. Without the prop, assert that neither analysis collapse label exists.

```tsx
const onToggle = vi.fn();
renderHeader({ analysisCollapse: { collapsed: false, onToggle } });
const collapse = screen.getByRole('button', { name: '收起缺陷分析区' });
expect(collapse.nextElementSibling).toBe(screen.getByTitle('最小化'));
fireEvent.click(collapse);
expect(onToggle).toHaveBeenCalledOnce();
```

**Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/components/BrandHeader.test.tsx`

Expected: FAIL because `analysisCollapse` is not a `BrandHeader` prop and no header button exists.

**Step 3: Implement the minimal component contract**

Define an optional `{ collapsed: boolean; onToggle: () => void }` prop on `BrandHeader`, pass it to `WindowControls`, and render a Lucide chevron button before minimize:

```tsx
{analysisCollapse ? (
  <button
    type="button"
    className="window-analysis-collapse"
    aria-label={analysisCollapse.collapsed ? '展开缺陷分析区' : '收起缺陷分析区'}
    aria-expanded={!analysisCollapse.collapsed}
    onClick={analysisCollapse.onToggle}
  >
    {analysisCollapse.collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
  </button>
) : null}
```

**Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --run src/components/BrandHeader.test.tsx`

Expected: all `BrandHeader` tests pass.

**Step 5: Commit**

```bash
git add app/client/src/components/WindowControls.tsx app/client/src/components/BrandHeader.tsx app/client/src/components/BrandHeader.test.tsx
git commit -m "feat: add analysis collapse to window controls"
```

### Task 2: Connect online state and remove the footer duplicate

**Files:**
- Modify: `app/client/src/App.tsx`
- Modify: `app/client/src/App.test.tsx`
- Modify: `app/client/src/components/AppFooter.tsx`
- Modify: `app/client/src/components/AppFooter.test.tsx`

**Step 1: Write the failing integration tests**

In the online App test, assert that clicking the header control adds `analysis-collapsed` to the center column, changes the label to `展开缺陷分析区`, and clicking again removes the class. Assert that only one collapse control exists and the footer no longer contains `.app-footer-collapse`.

Update the footer unit test to verify analysis view selection still calls `onCollapsedChange(false)` when currently collapsed, but no footer collapse button is rendered.

**Step 2: Run focused tests and verify RED**

Run: `npm test -- --run src/App.test.tsx src/components/AppFooter.test.tsx`

Expected: FAIL because App does not pass the header control and the footer still renders the old button.

**Step 3: Implement the state wiring**

Pass this optional prop to `BrandHeader` only when `uiState.activeNav === 'online'`:

```tsx
analysisCollapse={uiState.activeNav === 'online' ? {
  collapsed: analysisCollapsed,
  onToggle: () => setAnalysisCollapsed((current) => !current),
} : undefined}
```

Remove the `app-footer-collapse` button and its chevron imports. Preserve `changeAnalysisView`, which expands a collapsed analysis panel before changing view.

**Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --run src/App.test.tsx src/components/AppFooter.test.tsx`

Expected: all focused tests pass.

**Step 5: Commit**

```bash
git add app/client/src/App.tsx app/client/src/App.test.tsx app/client/src/components/AppFooter.tsx app/client/src/components/AppFooter.test.tsx
git commit -m "feat: control online analysis from header"
```

### Task 3: Reduce expanded analysis height and style the header control

**Files:**
- Modify: `app/client/src/styles.css`
- Modify: `app/client/src/styles/online-compact-layout.test.js`

**Step 1: Write the failing style assertions**

Add assertions that the default center-column row uses a bottom `minmax` no larger than `160px`, compact/dense variants do not restore the old `240px` minimum, the collapsed class remains one row, and `.window-analysis-collapse` is included in the window-control button styling.

**Step 2: Run the style test and verify RED**

Run: `npm test -- --run src/styles/online-compact-layout.test.js`

Expected: FAIL because the default CSS still contains `minmax(240px, 0.85fr)` and no window analysis class exists.

**Step 3: Implement the layout and visual changes**

Change the default online center grid to:

```css
.center-column {
  grid-template-rows: minmax(0, 1fr) minmax(160px, 0.5fr);
}
```

Use equal or smaller analysis-row minimums for compact/dense/short-height rules. Extend the existing `.window-controls button` styling to the new control, with a separator on its right so it remains visually distinct from native window operations. Remove obsolete `.app-footer-collapse` CSS.

**Step 4: Run the style test and focused component tests**

Run: `npm test -- --run src/styles/online-compact-layout.test.js src/components/BrandHeader.test.tsx src/components/AppFooter.test.tsx src/App.test.tsx`

Expected: all focused tests pass.

**Step 5: Commit**

```bash
git add app/client/src/styles.css app/client/src/styles/online-compact-layout.test.js
git commit -m "style: compact online analysis area"
```

### Task 4: Full verification

**Files:**
- Verify: all changed files

**Step 1: Run all frontend tests**

Run: `npm test -- --run`

Expected: all test files and tests pass with zero failures.

**Step 2: Build production assets**

Run: `npm run build`

Expected: TypeScript and Vite build exit with code 0.

**Step 3: Inspect the browser UI**

Start the feature Vite server against the local inspection service. Verify in online mode that the control is immediately left of minimize, the expanded lower area is shorter, collapse gives the main map all remaining height, and clicking an analysis view expands it. Verify BKV mode does not render the control.

**Step 4: Review the diff**

Run: `git diff --check main...HEAD`

Expected: no whitespace errors and no unrelated files changed.
