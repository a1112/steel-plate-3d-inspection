# App Performance Footer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a compact footer monitor for the current application process group's CPU, memory, and process count in both Tauri desktop and browser development modes.

**Architecture:** A shared client contract selects the full Tauri command when available and otherwise calls a degraded Rust-service endpoint. Both Rust binaries independently collect their own process tree with `sysinfo`; a React hook owns five-second polling and passes stable snapshots to the existing footer.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Tauri 2, Rust, `sysinfo`, `windows-sys`, CSS.

---

### Task 1: Define and verify the client resource-usage contract

**Files:**
- Create: `app/client/src/lib/app-resource-usage.test.ts`
- Create: `app/client/src/lib/app-resource-usage.ts`

**Step 1: Write the failing formatter and source-selection tests**

Cover these behaviors:

- `formatResourceBytes(1_572_864)` returns `1.5 MB`;
- invalid and missing values return `--`;
- CPU percent is clamped to `0–100%`;
- runtime memory breakdown omits zero categories;
- a Tauri environment invokes `app_resource_usage`;
- a browser environment reads `/api/system/resources`;
- malformed values are normalized to finite non-negative values;
- the browser response is labeled `source: "service"` and `precision: "degraded"`.

Use dependency injection in the exported fetch function:

```ts
export interface ResourceUsageTransport {
  isTauri: () => boolean;
  invoke: <T>(command: string) => Promise<T>;
  fetchJson: <T>(path: string, signal?: AbortSignal) => Promise<T>;
}
```

The public `fetchAppResourceUsage(signal?)` supplies production defaults; tests call `fetchAppResourceUsageWithTransport`.

**Step 2: Run the test and verify RED**

Run:

```powershell
cd app/client
npm test -- src/lib/app-resource-usage.test.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Implement the minimum contract**

Define `AppResourceUsage` with the agreed camelCase fields plus:

```ts
source: 'tauri' | 'service';
precision: 'full' | 'degraded';
sampledAtMs: number;
```

Implement:

- `normalizeAppResourceUsage`;
- `formatResourceBytes`;
- `formatResourcePercent`;
- `formatResourceBreakdown`;
- `formatResourceMemorySummary`;
- `fetchAppResourceUsageWithTransport`;
- `fetchAppResourceUsage`.

Use `isTauri()` and `invoke()` from `@tauri-apps/api/core`; use the existing inspection service origin through the same JSON-fetch convention as `capture-api.ts`.

**Step 4: Run the test and verify GREEN**

Run:

```powershell
cd app/client
npm test -- src/lib/app-resource-usage.test.ts
```

Expected: PASS.

### Task 2: Add visibility-aware stable polling

**Files:**
- Create: `app/client/src/hooks/use-app-resource-usage.test.tsx`
- Create: `app/client/src/hooks/use-app-resource-usage.ts`

**Step 1: Write failing hook tests**

With fake timers and an injected loader, verify:

- the first request starts immediately;
- another request starts after 5 seconds;
- overlapping requests are not created;
- a hidden document pauses interval samples;
- `visibilitychange` refreshes immediately when visible;
- an error preserves the last successful usage and sets `stale: true`;
- unmount removes timers and aborts the active request.

Desired hook result:

```ts
interface AppResourceUsageState {
  usage: AppResourceUsage | null;
  loading: boolean;
  stale: boolean;
}
```

**Step 2: Run the test and verify RED**

Run:

```powershell
cd app/client
npm test -- src/hooks/use-app-resource-usage.test.tsx
```

Expected: FAIL because the hook does not exist.

**Step 3: Implement the minimum hook**

Use a 5,000ms interval, one `AbortController`, an in-flight ref, and a `visibilitychange` listener. Do not clear a successful usage snapshot when a later request fails.

**Step 4: Run the test and verify GREEN**

Run:

```powershell
cd app/client
npm test -- src/hooks/use-app-resource-usage.test.tsx
```

Expected: PASS.

### Task 3: Implement the Rust service fallback

**Files:**
- Modify: `app/service/Cargo.toml`
- Modify: `app/service/Cargo.lock`
- Create: `app/service/src/app_resource_usage.rs`
- Modify: `app/service/src/main.rs`

**Step 1: Write failing Rust unit and routing tests**

Add module tests for:

- `normalize_process_group_cpu_usage(153.0, 16)` equals `9.5625`;
- zero logical CPUs clamp raw usage to `0–100`;
- process names categorize Python, the steel Rust service, WebView, Node, Tauri, and Other correctly;
- largest process tracking is correct.

Add a `main.rs` test asserting:

```rust
assert!(route_catalog_json().contains("/api/system/resources"));
```

and a response test asserting `source == "service"`, `precision == "degraded"`, and finite non-negative metrics.

**Step 2: Run tests and verify RED**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml app_resource_usage -- --nocapture
```

Expected: FAIL because the module and route do not exist.

**Step 3: Implement the process-tree collector and endpoint**

Add `sysinfo` and enable Windows `Win32_System_ProcessStatus`. In `app_resource_usage.rs` implement:

- a `OnceLock<Mutex<System>>`;
- recursive child-PID collection;
- CPU normalization;
- Windows working-set lookup with a `sysinfo` fallback;
- memory categorization and largest-process tracking;
- serialized response fields with `source: "service"` and `precision: "degraded"`.

Expose `app_resource_usage_response()` and register:

```rust
("GET", "/api/system/resources") => app_resource_usage::app_resource_usage_response(),
```

Also add the endpoint to the service route catalog.

**Step 4: Run tests and verify GREEN**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml app_resource_usage -- --nocapture
```

Expected: PASS.

### Task 4: Implement the full Tauri process-group collector

**Files:**
- Modify: `app/client/src-tauri/Cargo.toml`
- Modify: `app/client/src-tauri/Cargo.lock`
- Create: `app/client/src-tauri/src/app_resource_usage.rs`
- Modify: `app/client/src-tauri/src/lib.rs`

**Step 1: Write failing collector tests**

Add tests for CPU normalization, runtime categorization, largest-process tracking, and current-process memory being greater than zero.

**Step 2: Run tests and verify RED**

Run:

```powershell
cargo test --manifest-path app/client/src-tauri/Cargo.toml app_resource_usage -- --nocapture
```

Expected: FAIL because the module and command do not exist.

**Step 3: Implement and register the Tauri command**

Port the validated StraightnessGauge process-tree algorithm into the isolated module. Return the shared fields with `source: "tauri"` and `precision: "full"`, then add `app_resource_usage` to `tauri::generate_handler!`.

**Step 4: Run tests and verify GREEN**

Run:

```powershell
cargo test --manifest-path app/client/src-tauri/Cargo.toml app_resource_usage -- --nocapture
```

Expected: PASS.

### Task 5: Render the stable snapshot in the footer

**Files:**
- Modify: `app/client/src/components/AppFooter.test.tsx`
- Modify: `app/client/src/components/AppFooter.tsx`
- Modify: `app/client/src/App.tsx`
- Modify: `app/client/src/styles.css`

**Step 1: Write failing footer tests**

Pass a full usage snapshot and assert:

- `CPU 12.4%`;
- `内存 428.0 MB`;
- `5 进程`;
- accessible hover text identifies “完整桌面应用”;
- runtime categories appear in the title.

Pass a degraded snapshot and assert “浏览器服务进程”. Pass `null` with stale state and assert `CPU --` and `内存 --`.

**Step 2: Run tests and verify RED**

Run:

```powershell
cd app/client
npm test -- src/components/AppFooter.test.tsx
```

Expected: FAIL because `AppFooter` has no performance props.

**Step 3: Implement the footer UI**

Add `resourceUsage` and `resourceUsageStale` props, render a compact `.app-footer-performance` region between context/analysis and footer actions, and construct one diagnostic `title`.

In `App.tsx`, call `useAppResourceUsage()` once and pass the same state to both footer render paths.

Add responsive CSS that keeps the footer at 42px, uses tabular numerals, and hides only the visible process-count label at narrow widths.

**Step 4: Run tests and verify GREEN**

Run:

```powershell
cd app/client
npm test -- src/components/AppFooter.test.tsx src/hooks/use-app-resource-usage.test.tsx src/lib/app-resource-usage.test.ts
```

Expected: PASS.

### Task 6: Full verification and browser acceptance

**Files:**
- No source changes expected unless verification finds a regression.

**Step 1: Run complete automated verification**

Run:

```powershell
cd app/client
npm test
npm run build
cd ../..
cargo test --manifest-path app/service/Cargo.toml
cargo test --manifest-path app/client/src-tauri/Cargo.toml
git diff --check
```

Expected: all commands exit with code 0.

**Step 2: Verify BKV browser mode**

Open `http://127.0.0.1:5174/?view=bkv` and confirm:

- footer shows CPU, memory, and process count without changing height;
- hover text labels the source as the browser service process;
- values update without layout flicker;
- footer buttons remain reachable;
- console has no new errors.

**Step 3: Verify online browser mode**

Open `http://127.0.0.1:5174/?view=online` and repeat the footer and console checks.

**Step 4: Review final scope**

Confirm the diff contains only the two plan documents, resource collectors, client monitor, footer integration, dependency locks, and tests. Preserve the existing untracked legacy-data directories.
