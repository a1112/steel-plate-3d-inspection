# Online Detection Compact Layout Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the online detection page denser, center the title after navigation, remove the duplicate defect-count panel, and align severity selection styling with category filters.

**Architecture:** Keep the existing React component boundaries and data flow. Reorder only the header markup, remove the redundant `StatisticsPanel` composition from `App`, and apply narrowly scoped CSS changes to the header and online workspace; protect the layout with DOM and CSS contract tests.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Vite, CSS

---

### Task 1: Lock the header content order with a failing component test

**Files:**
- Modify: `app/client/src/components/BrandHeader.test.tsx`
- Modify: `app/client/src/components/BrandHeader.tsx:781`

**Step 1: Write the failing test**

Add a test that compares the DOM order of the embedded navigation and system title:

```tsx
it('places navigation before the centered system title', () => {
  const { container } = renderHeader();
  const navigation = screen.getByRole('navigation');
  const title = screen.getByText('钢管3D表面检测系统');

  expect(
    navigation.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(container.querySelector('.title-meta-group')).toContainElement(title);
});
```

If `TopNav` has no navigation role, query `.top-nav` from the container while preserving the same ordering assertion.

**Step 2: Run the test to verify it fails**

Run:

```powershell
Set-Location app/client
npm test -- --run src/components/BrandHeader.test.tsx
```

Expected: FAIL because the title currently precedes the navigation.

**Step 3: Write the minimal implementation**

Reorder the contents of `.title-meta-group`:

```tsx
<div className="title-meta-group">
  <TopNav active={activeNav} onChange={onNavChange} embedded />
  <div className="system-title">钢管3D表面检测系统</div>
</div>
```

**Step 4: Run the test to verify it passes**

Run:

```powershell
Set-Location app/client
npm test -- --run src/components/BrandHeader.test.tsx
```

Expected: all `BrandHeader` tests PASS.

**Step 5: Commit**

```powershell
git add app/client/src/components/BrandHeader.tsx app/client/src/components/BrandHeader.test.tsx
git commit -m "ui: place navigation before centered title"
```

### Task 2: Remove the redundant online defect-count panel

**Files:**
- Modify: `app/client/src/App.test.tsx:92`
- Modify: `app/client/src/App.tsx:77`
- Modify: `app/client/src/App.tsx:1131`

**Step 1: Write the failing test**

Update the online right-panel test so the duplicate heading is absent while filters remain:

```tsx
it('places defect filters before the list without a duplicate counts panel', async () => {
  render(<App />);

  const filterHeading = await screen.findByRole('heading', { name: '缺陷过滤' });
  const listHeading = screen.getByRole('heading', { name: '缺陷检测列表' });
  expect(
    filterHeading.compareDocumentPosition(listHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByRole('heading', { name: '缺陷数量' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '凹坑类别过滤，当前3项' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '严重等级过滤，当前4项' })).toBeInTheDocument();
});
```

**Step 2: Run the test to verify it fails**

Run:

```powershell
Set-Location app/client
npm test -- --run src/App.test.tsx
```

Expected: FAIL because `缺陷数量` is still rendered.

**Step 3: Write the minimal implementation**

- Change the import to `import { DefectFilterPanel } from './components/StatisticsPanel';`.
- Remove the `<StatisticsPanel ... />` block from the online right column.
- Keep `StatisticsPanel` itself and its focused component tests because it may remain reusable outside this composition.

**Step 4: Run the test to verify it passes**

Run:

```powershell
Set-Location app/client
npm test -- --run src/App.test.tsx src/components/StatisticsPanel.test.tsx
```

Expected: all selected tests PASS.

**Step 5: Commit**

```powershell
git add app/client/src/App.tsx app/client/src/App.test.tsx
git commit -m "ui: remove duplicate online defect counts"
```

### Task 3: Add CSS contracts for compact layout and selected filters

**Files:**
- Create: `app/client/src/styles/online-compact-layout.test.js`
- Modify: `app/client/src/styles.css:461`
- Modify: `app/client/src/styles.css:1478`
- Modify: `app/client/src/styles.css:1802`
- Modify: `app/client/src/styles.css:1824`
- Modify: `app/client/src/styles.css:4284`
- Modify: `app/client/src/styles.css:4354`
- Modify: `app/client/src/styles.css:4399`
- Modify: `app/client/src/styles.css:9559`

**Step 1: Write the failing CSS contract tests**

Create a test that reads `src/styles.css` and checks the named layout tokens:

```js
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync('src/styles.css', 'utf8');

describe('online compact layout styles', () => {
  it('uses compact header and online workspace dimensions', () => {
    expect(styles).toMatch(/\.brand-header\s*\{[\s\S]*?height:\s*50px;/);
    expect(styles).toMatch(/\.online-workspace\s*\{[\s\S]*?gap:\s*6px;[\s\S]*?padding:\s*0 8px 8px;/);
    expect(styles).toMatch(/\.dashboard-grid\.online-dashboard-grid\s*\{[\s\S]*?padding:\s*6px 0 0;/);
  });

  it('uses two right-column rows and compact filter controls', () => {
    expect(styles).toMatch(/\.right-column\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0,\s*1fr\);/);
    expect(styles).toMatch(/\.defect-filter-panel \.panel-body\s*\{[\s\S]*?padding:\s*6px 8px 8px;/);
    expect(styles).toMatch(/\.defect-type-filter\s*\{[\s\S]*?height:\s*30px;/);
    expect(styles).toMatch(/\.severity-filter-inline\s*\{[\s\S]*?height:\s*24px;/);
  });

  it('keeps selected severity controls tinted instead of solid', () => {
    expect(styles).toMatch(
      /\.severity-filter-inline\.active\s*\{[\s\S]*?color:\s*var\(--severity-color\);[\s\S]*?background:\s*color-mix\(in srgb,\s*var\(--severity-color\) 16%,\s*var\(--panel\)\);/,
    );
    expect(styles).not.toMatch(
      /\.severity-filter-inline\.active\s*\{[\s\S]*?background:\s*var\(--severity-color\);/,
    );
  });
});
```

**Step 2: Run the test to verify it fails**

Run:

```powershell
Set-Location app/client
npm test -- --run src/styles/online-compact-layout.test.js
```

Expected: FAIL against the current 58px header, wider gaps, three-panel right column, and solid selected severity background.

**Step 3: Write the minimal CSS implementation**

Implement these scoped values:

```css
.brand-header {
  height: 50px;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  gap: 8px;
  padding: 3px 6px;
}

.ustb-logo {
  width: 164px;
  height: 42px;
}

.title-meta-group {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 10px;
  width: 100%;
}

.system-title {
  justify-self: center;
  min-width: 0;
  font-size: 22px;
  text-align: center;
}

.brand-header .top-nav.top-nav-embedded,
.brand-header .top-nav.top-nav-embedded button {
  height: 30px;
}

.online-workspace {
  gap: 6px;
  padding: 0 8px 8px;
}

.dashboard-grid.online-dashboard-grid {
  gap: 6px;
  padding: 6px 0 0;
}

.right-column {
  grid-template-rows: auto minmax(0, 1fr);
  gap: 6px;
}

.defect-filter-panel .panel-body {
  padding: 6px 8px 8px;
}

.defect-type-filter {
  height: 30px;
}

.severity-filter-inline {
  height: 24px;
}

.severity-filter-inline.active {
  color: var(--severity-color);
  border-color: var(--severity-color);
  background: color-mix(in srgb, var(--severity-color) 16%, var(--panel));
}

.severity-filter-inline.active strong {
  color: var(--severity-color);
}
```

Update the light-theme active rule to use the same tinted treatment against white. Reconcile responsive and density overrides so they do not restore the old header height, gaps, padding, or right-column row count at the target desktop width.

**Step 4: Run the CSS and component tests**

Run:

```powershell
Set-Location app/client
npm test -- --run src/styles/online-compact-layout.test.js src/components/BrandHeader.test.tsx src/App.test.tsx
```

Expected: all selected tests PASS.

**Step 5: Commit**

```powershell
git add app/client/src/styles.css app/client/src/styles/online-compact-layout.test.js
git commit -m "style: compact online detection workspace"
```

### Task 4: Verify the integrated page

**Files:**
- Verify: `app/client/src/App.tsx`
- Verify: `app/client/src/components/BrandHeader.tsx`
- Verify: `app/client/src/styles.css`

**Step 1: Run the full client test suite**

Run:

```powershell
Set-Location app/client
npm test
```

Expected: all tests PASS.

**Step 2: Run a production build**

Run:

```powershell
Set-Location app/client
npm run build
```

Expected: TypeScript and Vite build complete successfully.

**Step 3: Inspect the live application in the in-app browser**

Open or claim `http://127.0.0.1:1432/` and verify at the current desktop viewport:

- The header is visibly shorter.
- The order is Logo → navigation → centered title → statuses/window controls.
- The work area and right-side cards have tighter gaps without overlap.
- The duplicate `缺陷数量` panel is absent.
- The filter panel hugs its content and the list fills the remaining height.
- Clicking a severity filter retains colored text/border with a tinted background.
- No new browser console errors appear.

**Step 4: Review the final diff**

Run:

```powershell
git diff HEAD~3 --check
git status --short
```

Expected: no whitespace errors and no unintended files.

**Step 5: Record any verification-only adjustment**

If visual verification requires a small CSS correction, first add or update the matching CSS contract, observe it fail, apply the minimal correction, rerun the focused tests and build, then commit:

```powershell
git add app/client/src/styles.css app/client/src/styles/online-compact-layout.test.js
git commit -m "style: refine compact layout verification"
```
