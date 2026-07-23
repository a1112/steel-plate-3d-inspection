# Terminal View Switch Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restore access to the original online inspection interface while retaining BKV offline replay in the shared footer menu.

**Architecture:** `App` owns an explicit `auto | online | bkv` terminal-view state synchronized to the URL `view` query parameter. `AppFooter` renders both view entries from a small mode model, while existing online and BKV components continue to own their current data paths.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Vite, PowerShell CDP smoke tests

---

### Task 1: Generalize the footer mode menu

**Files:**
- Modify: `app/client/src/components/AppFooter.test.tsx`
- Modify: `app/client/src/components/AppFooter.tsx`

**Step 1: Write the failing tests**

Add tests that require `在线检测` and `离线回放` menu items, verify `aria-current` on the active item, verify callbacks, and keep BKV disabled when unavailable.

**Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/components/AppFooter.test.tsx`

Expected: FAIL because the online entry and generalized mode model do not exist.

**Step 3: Implement the minimal footer model**

Replace the single BKV-only entry prop with two view entries containing `available`, `active`, and `onOpen`. Render both items and close the popup after enabled selections.

**Step 4: Run the focused test and verify GREEN**

Run: `npm test -- --run src/components/AppFooter.test.tsx`

Expected: all footer tests pass.

**Step 5: Commit**

```powershell
git add app/client/src/components/AppFooter.tsx app/client/src/components/AppFooter.test.tsx
git commit -m "feat: add online and BKV footer modes"
```

### Task 2: Add explicit terminal view routing

**Files:**
- Modify: `app/client/src/App.test.tsx`
- Modify: `app/client/src/App.tsx`

**Step 1: Write the failing application test**

Extend the ready-BKV test to open the footer menu, select `在线检测`, observe the original system heading, confirm `view=online`, then select `离线回放` and return to BKV.

**Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/App.test.tsx`

Expected: FAIL because the online entry and explicit view override are missing.

**Step 3: Implement URL-backed view state**

Add a parser for `view`, a state setter that preserves other query parameters with `history.replaceState`, and rendering rules for `auto`, `online`, and `bkv`. Pass the shared mode model to both footer instances.

**Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --run src/App.test.tsx src/components/AppFooter.test.tsx`

Expected: all targeted tests pass.

**Step 5: Commit**

```powershell
git add app/client/src/App.tsx app/client/src/App.test.tsx
git commit -m "feat: switch terminal between online and BKV views"
```

### Task 3: Extend browser regression coverage

**Files:**
- Modify: `scripts/test-runtime-ui-smoke.ps1`

**Step 1: Add the BKV-to-online-to-BKV smoke interaction**

Open “更多”, choose `在线检测`, assert the original main heading and `view=online`, then reopen the menu, choose `离线回放`, and assert the BKV heading and `view=bkv`.

**Step 2: Verify the smoke test detects the old behavior**

Run the updated smoke against a build without the routing change and confirm the interaction fails at the missing online entry.

**Step 3: Run the updated smoke against the feature build**

Run: `scripts/test-runtime-ui-smoke.ps1 -ClientOrigin 'http://127.0.0.1:<feature-port>/?app=terminal' -ExpectBkv`

Expected: all BKV page and interaction checks pass.

**Step 4: Commit**

```powershell
git add scripts/test-runtime-ui-smoke.ps1
git commit -m "test: cover terminal view switching in UI smoke"
```

### Task 4: Full verification and local integration

**Files:**
- Verify all changed files

**Step 1: Run full frontend verification**

Run: `npm test -- --run; npm run build`

Expected: all tests and production build pass.

**Step 2: Run BKV runtime verification**

Run the BKV UI smoke against the feature client and inspect the screenshot.

**Step 3: Validate the patch**

Run: `git diff --check` and inspect `git diff main...HEAD`.

**Step 4: Merge locally and verify again**

Fast-forward the feature branch into `main`, rerun the full frontend test/build and the `5174` BKV UI smoke, then remove the temporary worktree and branch.
