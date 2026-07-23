# Mode-Specific Main Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the main dashboard strictly follow the configured direct-camera or BKV runtime mode, and move BKV records and the camera-local image world from the legacy replay data path to the converted standard store.

**Architecture:** The Rust standard-record store becomes the only BKV business-data source for the main dashboard. A client-side runtime dashboard model selects health semantics, requests, header content, capabilities, and record/image behavior before rendering shared UI components. Converted inspection worlds are immutable-by-source-hash and cached server-side; the client keeps the last painted world visible until the newly selected record has painted its first tile.

**Tech Stack:** Rust, rusqlite, React, TypeScript, Vitest, Testing Library, Canvas, Vite, PowerShell.

**Execution note:** The user explicitly requested subsequent work directly on `main`; do not create a worktree or feature branch. Preserve the existing untracked user data directories.

---

### Task 1: Complete the standard BKV record contract

**Files:**

- Modify: `app/service/src/standard_record_store.rs`
- Modify: `app/service/src/main.rs`
- Modify: `app/client/src/services/inspection-world-api.ts`
- Modify: `app/client/src/services/inspection-world-api.test.ts`

**Step 1: Write failing Rust tests**

Extend the converted-store fixture metadata with:

```json
{
  "steelType": "37Mn/2",
  "lengthMm": 12096,
  "outerDiameterLegacyValue": 233.664,
  "wallThicknessMm": 12.5
}
```

Assert that `InspectionRecordDto` and `/api/inspection-world/records` return:

```rust
assert_eq!(record.legacy_seq_no, Some(10));
assert_eq!(record.outer_diameter_mm, Some(233.664));
assert_eq!(record.wall_thickness_mm, Some(12.5));
assert_eq!(record.source_hash, "fixture-source-hash");

assert_eq!(records["cameraCount"], 6);
assert_eq!(records["batchId"], "legacy-10-10");
assert_eq!(records["ready"], true);
assert_eq!(records["records"][0]["outerDiameterMm"], 233.664);
```

Also add an empty-store response test:

```rust
assert_eq!(records["ready"], false);
assert_eq!(records["batchId"], "无离线批次");
```

**Step 2: Run the tests to verify RED**

Run:

```powershell
cd app/service
cargo test standard_record_store::tests -- --nocapture
cargo test inspection_world_http_reads_converted_store_without_legacy_manager -- --nocapture
```

Expected: compilation or assertions fail because the fields and top-level source status do not exist.

**Step 3: Implement the record fields**

Extend `InspectionRecordDto`:

```rust
pub struct InspectionRecordDto {
    pub record_id: String,
    pub legacy_seq_no: Option<u64>,
    pub steel_id: String,
    pub steel_type: Option<String>,
    pub length_mm: Option<f64>,
    pub outer_diameter_mm: Option<f64>,
    pub wall_thickness_mm: Option<f64>,
    pub inspection_time: Option<String>,
    pub defect_count: i64,
    pub camera_count: usize,
    pub source_hash: String,
}
```

Read `source_hash` from the existing catalog column and read physical fields from
`metadata_json`. Parse a numeric record ID as `legacy_seq_no`.

For converted-local records, return a top-level source summary:

```json
{
  "schema": "steel.inspection-world.records.v1",
  "provider": "bkv",
  "ready": true,
  "cameraCount": 6,
  "batchId": "legacy-1893700-1893710",
  "records": []
}
```

Derive the batch range only from numeric `legacySeqNo` values. Do not query the
legacy BKV manager.

**Step 4: Update and test the TypeScript contract**

Add the same optional fields to `InspectionWorldRecord` and add:

```ts
export type InspectionWorldRecords = {
  schema: 'steel.inspection-world.records.v1';
  provider: InspectionWorldProvider;
  ready?: boolean;
  cameraCount?: number;
  batchId?: string;
  records: InspectionWorldRecord[];
};
```

Update `inspection-world-api.test.ts` to assert exact parsing and request routing.

Run:

```powershell
cd app/client
npm test -- src/services/inspection-world-api.test.ts
```

Expected: all selected tests pass.

**Step 5: Commit**

```powershell
git add app/service/src/standard_record_store.rs app/service/src/main.rs app/client/src/services/inspection-world-api.ts app/client/src/services/inspection-world-api.test.ts
git commit -m "feat: complete standard BKV record contract"
```

---

### Task 2: Cache converted inspection worlds by source revision

**Files:**

- Modify: `app/service/src/main.rs`

**Step 1: Write a failing cache test**

Make `load_converted_inspection_world` return `Arc<ConvertedInspectionWorld>`.
Load the same converted record twice and assert:

```rust
let first = load_converted_inspection_world(&state, "10").expect("first load");
let second = load_converted_inspection_world(&state, "10").expect("cached load");
assert!(Arc::ptr_eq(&first, &second));
```

Then update the fixture record `source_hash`, load again, and assert:

```rust
assert!(!Arc::ptr_eq(&second, &refreshed));
```

**Step 2: Run the test to verify RED**

Run:

```powershell
cd app/service
cargo test converted_inspection_world_cache_reuses_immutable_source_revision -- --nocapture
```

Expected: compilation fails because converted worlds are rebuilt and no cache exists.

**Step 3: Implement a bounded converted cache**

Add:

```rust
struct ConvertedInspectionWorldCacheEntry {
    source_hash: String,
    world: Arc<ConvertedInspectionWorld>,
}
```

Add a separate mutex to `ServiceState`:

```rust
converted_inspection_world_cache:
    Mutex<HashMap<String, ConvertedInspectionWorldCacheEntry>>,
```

On every lookup:

1. read the standard record and its `source_hash`;
2. return the cached `Arc` when the hash matches;
3. otherwise verify capture files, detect heads, build the world, and cache it;
4. clear the map before inserting a seventeenth record.

Do not share this cache with mutable online inspections.

**Step 4: Verify cache and HTTP behavior**

Run:

```powershell
cargo test converted_inspection_world_cache_reuses_immutable_source_revision -- --nocapture
cargo test inspection_world_http_reads_converted_store_without_legacy_manager -- --nocapture
```

Expected: both tests pass. The second meta request must not repeat file hashing or
head alignment for an unchanged source hash.

**Step 5: Commit**

```powershell
git add app/service/src/main.rs
git commit -m "perf: cache converted inspection worlds"
```

---

### Task 3: Build BKV dashboard snapshots from the standard world contract

**Files:**

- Modify: `app/client/src/lib/bkv-inspection-adapter.ts`
- Modify: `app/client/src/lib/bkv-inspection-adapter.test.ts`
- Modify: `app/client/src/services/inspection-world-api.ts`

**Step 1: Write failing adapter tests**

Replace legacy-material fixtures with `InspectionWorldRecords` and
`InspectionWorldDefects` fixtures.

Assert that:

```ts
const snapshot = buildStandardBkvInspectionSnapshot(records);
expect(snapshot.records).toHaveLength(11);
expect(snapshot.currentPlate).toMatchObject({
  plateNo: '253B09401250925A12004328',
  widthMm: 233.664,
  lengthMm: 12096,
  thicknessMm: 12.5,
  steelGrade: '37Mn/2',
});

const merged = mergeStandardBkvDefects(snapshot, '1893700', defects);
expect(merged.inspections[0].defects[0]).toMatchObject({
  typeLabel: '轧折',
  cameraIndex: 1,
  synthetic: false,
});
```

Assert that a record with `defectCount > 0` retains the table count before its
detail defects are loaded.

**Step 2: Run the adapter test to verify RED**

Run:

```powershell
cd app/client
npm test -- src/lib/bkv-inspection-adapter.test.ts
```

Expected: tests fail because the adapter accepts `BkvMaterial[]`.

**Step 3: Implement the standard adapter**

Export:

```ts
export function buildStandardBkvInspectionSnapshot(
  payload: InspectionWorldRecords,
): InspectionSnapshot;

export function mergeStandardBkvDefects(
  snapshot: InspectionSnapshot,
  recordId: string,
  payload: InspectionWorldDefects,
): InspectionSnapshot;
```

Use record DTO fields for plate and record metadata. Build defect type IDs from
the traced legacy class number when present, otherwise from a normalized class
name. Treat imported BKV classifications as `review` unless a future normalized
severity contract explicitly maps them.

Do not import `BkvMaterial` or call `/api/bkv/materials`.

**Step 4: Verify GREEN**

Run:

```powershell
npm test -- src/lib/bkv-inspection-adapter.test.ts src/services/inspection-world-api.test.ts
```

Expected: all selected tests pass.

**Step 5: Commit**

```powershell
git add app/client/src/lib/bkv-inspection-adapter.ts app/client/src/lib/bkv-inspection-adapter.test.ts app/client/src/services/inspection-world-api.ts
git commit -m "feat: adapt standard BKV records for the dashboard"
```

---

### Task 4: Make runtime mode the single source of dashboard behavior

**Files:**

- Create: `app/client/src/lib/runtime-dashboard-mode.ts`
- Create: `app/client/src/lib/runtime-dashboard-mode.test.ts`
- Modify: `app/client/src/App.tsx`
- Modify: `app/client/src/App.test.tsx`
- Modify: `app/client/src/components/BrandHeader.tsx`
- Modify: `app/client/src/components/BrandHeader.test.tsx`
- Modify: `app/client/src/components/AppFooter.tsx`
- Modify: `app/client/src/components/AppFooter.test.tsx`

**Step 1: Write failing mode-model tests**

Define the expected API:

```ts
const bkv = createRuntimeDashboardMode(bkvRuntimeProfile);
expect(bkv).toMatchObject({
  kind: 'bkv',
  requestsOnlineServices: false,
  requestsStandardRecords: true,
  showsHardwareStatus: false,
  showsCaptureManagement: false,
  showsReconstruction: false,
});

const direct = createRuntimeDashboardMode(directRuntimeProfile);
expect(direct).toMatchObject({
  kind: 'direct',
  requestsOnlineServices: true,
  requestsStandardRecords: false,
  showsHardwareStatus: true,
  showsCaptureManagement: true,
  showsReconstruction: true,
});
```

Add App tests proving:

- BKV calls `/api/inspection-world/records`, selected-record defects/meta/tiles;
- BKV never calls `/api/bkv/materials`, `/api/inspection/snapshot`,
  `/api/capture/health`, network, or trigger endpoints;
- direct mode never calls `/api/bkv/status`, `/api/bkv/materials`, or the
  converted record list;
- BKV `view=online`, capture, and reconstruction deep links return to the BKV
  terminal without starting online polling.

**Step 2: Run tests to verify RED**

Run:

```powershell
cd app/client
npm test -- src/lib/runtime-dashboard-mode.test.ts src/App.test.tsx
```

Expected: the new module is missing and the current App still probes
`/api/bkv/status` in every runtime.

**Step 3: Implement the mode model and App data flow**

Create an immutable model derived only from `PublicRuntimeProfile`.

For BKV:

1. fetch `/api/inspection-world/records`;
2. build the initial standard BKV snapshot;
3. fetch defects only for the selected record;
4. merge them into the snapshot;
5. derive header `cameraCount`, `batchId`, and `dataReady` from the record
   response plus current meta state.

For direct:

1. fetch the online inspection snapshot;
2. start capture, network, service, and trigger polling;
3. never invoke BKV APIs.

Remove the main-dashboard dependency on `fetchBkvStatus`,
`fetchBkvMaterials`, and `BkvStatus`. Keep those APIs only in
`BkvCompatibilityApp`.

**Step 4: Enforce header and footer separation**

Make `BrandHeader` accept the mode model instead of inferring from optional
hardware data. Its BKV branch must render only:

```text
BKV 模式 | 离线数据 | 批次 | 检测数据
```

Its direct branch renders trigger, receiver, camera, control, services, and the
run indicator.

The footer must hide capture management and reconstruction in BKV and restore
them in direct mode.

**Step 5: Verify GREEN**

Run:

```powershell
npm test -- src/lib/runtime-dashboard-mode.test.ts src/App.test.tsx src/components/BrandHeader.test.tsx src/components/AppFooter.test.tsx
```

Expected: all selected tests pass with no unexpected BKV online-service calls.

**Step 6: Commit**

```powershell
git add app/client/src/lib/runtime-dashboard-mode.ts app/client/src/lib/runtime-dashboard-mode.test.ts app/client/src/App.tsx app/client/src/App.test.tsx app/client/src/components/BrandHeader.tsx app/client/src/components/BrandHeader.test.tsx app/client/src/components/AppFooter.tsx app/client/src/components/AppFooter.test.tsx
git commit -m "feat: separate BKV and direct dashboard modes"
```

---

### Task 5: Keep the main image stable while records change

**Files:**

- Modify: `app/client/src/components/PlateMap.tsx`
- Modify: `app/client/src/components/PlateMap.test.tsx`
- Modify: `app/client/src/components/InspectionWorldCanvas.tsx`
- Modify: `app/client/src/components/InspectionWorldCanvas.test.tsx`
- Modify: `app/client/src/styles.css`

**Step 1: Write failing transition tests**

Add a `requireInspectionWorld` prop to `PlateMap`.

Test initial BKV loading:

```tsx
expect(screen.getByRole('status', {
  name: '正在加载 BKV 检测图像世界',
})).toBeInTheDocument();
expect(screen.queryByTestId('bar-unfolded-map')).not.toBeInTheDocument();
```

Test record switching:

1. render record 1893700 and signal first paint;
2. rerender for 1893701;
3. assert the 1893700 canvas remains visible with a loading overlay;
4. signal the 1893701 canvas first paint;
5. assert only 1893701 remains.

Add an `onFirstPaint` test to `InspectionWorldCanvas` that fires once after the
first successfully decoded tile is drawn, not merely after metadata is received.

**Step 2: Run tests to verify RED**

Run:

```powershell
cd app/client
npm test -- src/components/PlateMap.test.tsx src/components/InspectionWorldCanvas.test.tsx
```

Expected: initial BKV loading falls back to `BarUnfoldedMap`, and no first-paint
transition contract exists.

**Step 3: Implement a two-stage world transition**

`PlateMap` maintains:

```ts
type DisplayWorld = {
  recordId: string;
  meta: InspectionWorldMeta;
  defects: InspectionWorldDefect[];
};

const [displayedWorld, setDisplayedWorld] = useState<DisplayWorld | null>(null);
const [pendingWorld, setPendingWorld] = useState<DisplayWorld | null>(null);
```

When required-world metadata arrives:

- keep `displayedWorld`;
- mount `pendingWorld` in a preparing layer;
- promote it only when `onFirstPaint` fires;
- on failure, keep the previous world and show a record-local error overlay;
- on the first record, show a skeleton until promotion.

Never render `BarUnfoldedMap` when `requireInspectionWorld` is true.

**Step 4: Add compact transition styles**

Add classes for:

- stable world stack;
- hidden preparing canvas;
- loading skeleton;
- non-blocking record-switch overlay;
- record-local error overlay.

Do not animate canvas opacity during wheel zoom.

**Step 5: Verify GREEN**

Run:

```powershell
npm test -- src/components/PlateMap.test.tsx src/components/InspectionWorldCanvas.test.tsx
```

Expected: all transition, zoom, culling, scrollbar, and first-paint tests pass.

**Step 6: Commit**

```powershell
git add app/client/src/components/PlateMap.tsx app/client/src/components/PlateMap.test.tsx app/client/src/components/InspectionWorldCanvas.tsx app/client/src/components/InspectionWorldCanvas.test.tsx app/client/src/styles.css
git commit -m "fix: keep BKV image world stable across records"
```

---

### Task 6: Surface BKV data health without online service alarms

**Files:**

- Modify: `app/client/src/App.tsx`
- Modify: `app/client/src/App.test.tsx`
- Modify: `app/client/src/components/BrandHeader.tsx`
- Modify: `app/client/src/components/BrandHeader.test.tsx`
- Modify: `app/client/src/components/LeftSidebar.tsx`
- Modify: `app/client/src/components/LeftSidebar.test.tsx`

**Step 1: Write failing health tests**

Test these distinct failures:

1. `/api/inspection-world/records` returns 503:
   header shows `BKV 数据异常` and the store detail;
2. selected record meta returns 404:
   header still reports the store ready, while the main image shows a local
   record error;
3. converter endpoint is unavailable:
   the main dashboard does not request it and remains ready;
4. trigger and capture are unavailable:
   BKV contains no `服务异常`;
5. direct mode with unavailable capture still shows `服务异常`.

**Step 2: Run tests to verify RED**

Run:

```powershell
cd app/client
npm test -- src/App.test.tsx src/components/BrandHeader.test.tsx src/components/LeftSidebar.test.tsx
```

Expected: at least the converted-store and record-local error semantics fail.

**Step 3: Implement explicit BKV health states**

Use:

```ts
type BkvDataHealth =
  | { state: 'loading'; detail: string }
  | { state: 'ready'; detail: string }
  | { state: 'store-error'; detail: string };
```

Do not derive this state from online service panels. A world error belongs to
the selected record and must not mutate `BkvDataHealth` to `store-error`.

Update BKV source text from “旧 BKV 文件” to “BKV 标准离线仓库”; retain the
source record ID and compatibility provenance in record details.

**Step 4: Verify GREEN**

Run the Step 2 command.

Expected: all selected health and mode tests pass.

**Step 5: Commit**

```powershell
git add app/client/src/App.tsx app/client/src/App.test.tsx app/client/src/components/BrandHeader.tsx app/client/src/components/BrandHeader.test.tsx app/client/src/components/LeftSidebar.tsx app/client/src/components/LeftSidebar.test.tsx
git commit -m "fix: scope BKV health to standard offline data"
```

---

### Task 7: Full verification and live acceptance

**Files:**

- Modify tests only if a verified public-contract regression requires it

**Step 1: Run all automated suites**

```powershell
cd app/service
cargo test
cargo build

cd ../client
npm test
npm run build

cd ../..
python -m unittest scripts.test_bkv_import_service scripts.test_bkv_runtime_manifest scripts.test_bkv_d3img_conversion -v
git diff --check
```

Expected: all tests and builds pass. Report jsdom canvas, chart-size, React
`act`, Rust dead-code, and chunk-size warnings accurately if still present.

**Step 2: Restart only the project-owned BKV processes**

Restart:

- Rust service on 4873;
- BKV converter on 4893 if required for backend management;
- Vite on 5174 with `VITE_INSPECTION_SERVICE_ORIGIN=http://127.0.0.1:4873`.

Do not stop unrelated legacy processes on 4874/5175.

**Step 3: Verify live APIs**

Assert:

- runtime profile is `bkv-6`;
- records are 1893700-1893710, 11 total;
- record DTO includes diameter and wall thickness;
- the first meta request succeeds;
- a repeated meta request is materially faster because it reuses the converted
  cache;
- C1-C6 widths and head offsets remain non-uniform and correct;
- defects and camera-local tiles return 200;
- no camera SDK process or MySQL socket exists.

**Step 4: Browser acceptance**

At `http://127.0.0.1:5174/`:

- inspect the header and confirm only BKV status blocks;
- inspect network requests and confirm no legacy materials or online hardware
  requests;
- confirm 11 records and C1-C6 only;
- switch 1893700 → 1893701 → 1893700 and verify no online placeholder appears;
- exercise scrollbar, normal wheel scrolling, Ctrl+wheel zoom, defect focus,
  and viewport culling;
- confirm no new console errors;
- confirm capture/reconstruction deep links return to the BKV terminal.

Start a temporary direct profile on isolated ports and confirm eight cameras,
hardware/service blocks, capture management, and reconstruction return while
all BKV record endpoints remain unused. Stop temporary processes and remove
temporary config afterward.

**Step 5: Final repository audit**

```powershell
git status --short
git log --oneline -15
```

Expected: branch `main`; only the user-owned untracked data directories remain.

