# Inspection World Scroll Virtualization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace free internal panning with a native scrollable, viewport-virtualized inspection world where plain wheel scrolls, Ctrl+wheel zooms, and record changes restore fit-width at the top.

**Architecture:** Keep the Canvas fixed to the visible viewport and use a lightweight scaled spacer to create native browser scroll ranges. Convert native scroll offsets into world coordinates for tile selection; request one prefetch ring and revoke everything outside it. Centralize zoom-anchor and scroll-extent math in pure helpers so interaction behavior is testable without relying on browser layout.

**Tech Stack:** React 18, TypeScript, HTML Canvas, Vitest, Testing Library, Vite, PowerShell CDP smoke test.

---

### Task 1: Define native-scroll world math

**Files:**
- Modify: `app/client/src/lib/inspection-world.ts`
- Modify: `app/client/src/lib/inspection-world.test.ts`

**Step 1: Write the failing tests**

Add focused tests for scaled scroll extents and pointer-anchored zoom:

```ts
import { scaledWorldExtent, scrollPositionForZoom } from './inspection-world';

it('uses the scaled world as native scroll extent without shrinking below the viewport', () => {
  expect(scaledWorldExtent(600, 21504, 1000 / 600, 1000, 600)).toEqual({
    width: 1000,
    height: 35840,
  });
  expect(scaledWorldExtent(600, 100, 1, 1000, 600)).toEqual({ width: 1000, height: 600 });
});

it('keeps the world point below the pointer when zoom changes', () => {
  expect(scrollPositionForZoom({
    scrollLeft: 0, scrollTop: 400, pointerX: 250, pointerY: 200,
    oldScale: 1, newScale: 2,
  })).toEqual({ scrollLeft: 250, scrollTop: 1000 });
});
```

**Step 2: Run tests and verify RED**

Run:

```powershell
cd app/client
npm test -- --run src/lib/inspection-world.test.ts
```

Expected: FAIL because `scaledWorldExtent` and `scrollPositionForZoom` are not exported.

**Step 3: Implement the minimum pure helpers**

Add functions that clamp dimensions to the viewport and compute pointer-anchored scroll offsets:

```ts
export function scaledWorldExtent(
  worldWidth: number, worldHeight: number, scale: number,
  viewportWidth: number, viewportHeight: number,
) {
  return {
    width: Math.max(viewportWidth, worldWidth * scale),
    height: Math.max(viewportHeight, worldHeight * scale),
  };
}

export function scrollPositionForZoom(input: {
  scrollLeft: number; scrollTop: number;
  pointerX: number; pointerY: number;
  oldScale: number; newScale: number;
}) {
  const worldX = (input.scrollLeft + input.pointerX) / input.oldScale;
  const worldY = (input.scrollTop + input.pointerY) / input.oldScale;
  return {
    scrollLeft: worldX * input.newScale - input.pointerX,
    scrollTop: worldY * input.newScale - input.pointerY,
  };
}
```

**Step 4: Run tests and verify GREEN**

Run the same focused command. Expected: all `inspection-world` tests pass.

**Step 5: Commit**

```powershell
git add app/client/src/lib/inspection-world.ts app/client/src/lib/inspection-world.test.ts
git commit -m "test: define inspection world scroll math"
```

### Task 2: Lock native scroll and Ctrl+wheel behavior with component tests

**Files:**
- Modify: `app/client/src/components/InspectionWorldCanvas.test.tsx`

**Step 1: Add a viewport/spacer test**

Render the component and assert:

```ts
expect(screen.getByTestId('inspection-world-viewport')).toHaveAttribute('data-scroll-mode', 'native');
expect(screen.getByTestId('inspection-world-scroll-space')).toHaveStyle({
  width: '1000px',
  height: '35840px',
});
```

**Step 2: Add separate plain-wheel and Ctrl+wheel tests**

Dispatch cancelable `WheelEvent` instances:

```ts
const plain = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
canvas.dispatchEvent(plain);
expect(plain.defaultPrevented).toBe(false);
expect(canvas).toHaveAttribute('data-view-scale', initialScale);

const zoom = new WheelEvent('wheel', {
  deltaY: -400, ctrlKey: true, clientX: 500, clientY: 300,
  bubbles: true, cancelable: true,
});
canvas.dispatchEvent(zoom);
expect(zoom.defaultPrevented).toBe(true);
await waitFor(() => expect(canvas.getAttribute('data-view-scale')).not.toBe(initialScale));
```

**Step 3: Add native scroll virtualization test**

Set `viewport.scrollTop`, emit `scroll`, flush the animation frame, and assert `data-view-y` changes and requested tile Y values move away from the initial range while total requests remain bounded.

**Step 4: Add record-switch reset test**

Scroll and zoom the first record, rerender with a second `recordId`, then assert:

```ts
expect(viewport.scrollLeft).toBe(0);
expect(viewport.scrollTop).toBe(0);
expect(canvas).toHaveAttribute('data-view-y', '0.000');
expect(Number(canvas.getAttribute('data-view-scale'))).toBeCloseTo(1000 / 600, 3);
```

**Step 5: Run tests and verify RED**

Run:

```powershell
cd app/client
npm test -- --run src/components/InspectionWorldCanvas.test.tsx
```

Expected: the new tests fail because no native scroll viewport/spacer exists and all wheel input currently zooms.

**Step 6: Commit test-only RED state only after preserving the failure output in the task log**

Do not commit production changes yet. The test commit is optional; if committed, keep it clearly marked:

```powershell
git add app/client/src/components/InspectionWorldCanvas.test.tsx
git commit -m "test: specify native inspection world scrolling"
```

### Task 3: Implement the scroll viewport and viewport-sized stage

**Files:**
- Modify: `app/client/src/components/InspectionWorldCanvas.tsx`
- Modify: `app/client/src/styles.css`

**Step 1: Replace free view origin with native scroll state**

Keep `scale` in React state and derive world origin from coalesced native scroll offsets:

```ts
type ScrollView = { scrollLeft: number; scrollTop: number; scale: number };

const onScroll = () => {
  if (scrollFrame.current != null) return;
  scrollFrame.current = requestAnimationFrame(() => {
    scrollFrame.current = null;
    const host = hostRef.current;
    if (!host) return;
    setView((current) => ({
      ...current,
      scrollLeft: host.scrollLeft,
      scrollTop: host.scrollTop,
    }));
  });
};
```

Convert tile viewport to world coordinates:

```ts
viewport: {
  x: view.scrollLeft / view.scale,
  y: view.scrollTop / view.scale,
  width: size.width / view.scale,
  height: size.height / view.scale,
}
```

**Step 2: Add the lightweight world spacer and sticky stage**

Render:

```tsx
<div ref={hostRef} data-testid="inspection-world-viewport" data-scroll-mode="native" onScroll={onScroll}>
  <div
    data-testid="inspection-world-scroll-space"
    className="inspection-world-scroll-space"
    style={{ width: extent.width, height: extent.height }}
  >
    <div className="inspection-world-stage" style={{ transform: `translate(${view.scrollLeft}px, ${view.scrollTop}px)` }}>
      <canvas ... />
      {/* labels and status */}
    </div>
  </div>
</div>
```

The Canvas width and height remain `size.width`/`size.height`.

**Step 3: Make wheel behavior conditional**

Return immediately for plain wheel input. For Ctrl+wheel, prevent default, calculate the new scale, calculate anchored scroll offsets with `scrollPositionForZoom`, update scale, and apply scroll offsets after React lays out the new spacer.

**Step 4: Route drag and defect focus through scroll offsets**

- Pointer drag assigns `host.scrollLeft` and `host.scrollTop` instead of mutating an unconstrained world origin.
- Defect focus chooses the zoom level, then scrolls the defect center into the viewport.
- Record change revokes cache, aborts requests through normal effect cleanup, restores fit-width, and calls `host.scrollTo({ left: 0, top: 0 })`.

**Step 5: Add native overflow CSS**

```css
.inspection-world-viewport {
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.inspection-world-scroll-space { position: relative; }
.inspection-world-stage {
  position: absolute;
  inset: 0 auto auto 0;
  overflow: hidden;
}
```

Remove `touch-action: none`; use `touch-action: pan-x pan-y` unless dragging specifically owns the pointer.

**Step 6: Run component and library tests and verify GREEN**

```powershell
cd app/client
npm test -- --run src/lib/inspection-world.test.ts src/components/InspectionWorldCanvas.test.tsx src/components/BkvCompatibilityApp.test.tsx src/components/PlateMap.test.tsx
```

Expected: all focused tests pass with no unhandled timer or Canvas errors.

**Step 7: Commit**

```powershell
git add app/client/src/components/InspectionWorldCanvas.tsx app/client/src/components/InspectionWorldCanvas.test.tsx app/client/src/styles.css
git commit -m "feat: add virtualized inspection world scrolling"
```

### Task 4: Extend runtime browser smoke coverage

**Files:**
- Modify: `scripts/test-runtime-ui-smoke.ps1`

**Step 1: Add failing interaction checks**

For the BKV 2D page, assert through CDP evaluation:

- viewport `scrollHeight > clientHeight`;
- initial horizontal scroll is zero and all six cameras fit width;
- plain wheel changes `scrollTop` but not `data-view-scale`;
- Ctrl+wheel changes `data-view-scale` and keeps the world loaded;
- scrolling deep changes `data-view-y` and active tile requests remain well below 126;
- selecting another legacy record restores `scrollTop=0` and fit-width scale.

**Step 2: Run smoke and verify RED before production behavior exists**

```powershell
scripts/test-runtime-ui-smoke.ps1 `
  -ClientOrigin 'http://127.0.0.1:5176/?app=terminal' `
  -ExpectBkv `
  -TimeoutSec 45
```

Expected: new native-scroll/Ctrl+wheel expressions fail against the pre-change component.

**Step 3: Adjust only test timing/selectors needed for stable CDP interaction**

Use scroll/wheel dispatch plus existing wait loops; do not weaken pixel or bounded-request checks.

**Step 4: Commit**

```powershell
git add scripts/test-runtime-ui-smoke.ps1
git commit -m "test: cover inspection world scroll interactions"
```

### Task 5: Full verification and integration readiness

**Files:**
- Verify all changed files

**Step 1: Run full client tests**

```powershell
cd app/client
npm test -- --run
```

Expected: all test files and tests pass.

**Step 2: Run production build**

```powershell
cd app/client
npm run build
```

Expected: TypeScript and Vite build exit 0; existing chunk-size warning may remain.

**Step 3: Run formatting/diff checks**

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional files are modified.

**Step 4: Start isolated client and run browser smoke**

Start the worktree client on port 5176 with `VITE_INSPECTION_SERVICE_ORIGIN=http://127.0.0.1:4874`, then run the updated BKV smoke. Inspect screenshots for native scrollbar, fit-width C1-C6, deep scroll, defect focus, JIT, and cylinder views.

**Step 5: Request code review**

Use `superpowers:requesting-code-review`; resolve all Critical/Important findings and repeat affected verification.

**Step 6: Final commit if verification caused adjustments**

```powershell
git add <intentional-files>
git commit -m "fix: finalize inspection world scroll behavior"
```

**Step 7: Hand off for local main integration**

Use `superpowers:finishing-a-development-branch`; preserve the user's untracked legacy image/data directories.
