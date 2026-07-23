# Configured Runtime Modes and BKV Import Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make runtime camera topology and feature availability configuration-driven, import six-camera BKV source data through an independent conversion service into the current standard record store, expose configuration and conversion status in backend management, hide direct-camera tools in non-direct modes, and use same-tab navigation in browsers.

**Architecture:** `config/project.json` selects a validated runtime profile. A direct profile references the existing eight-camera capture profile; a BKV profile declares six source cameras and a converted local standard store. An independent Python conversion service publishes normalized records and a local catalog atomically. Rust reads the same normalized record contract for BKV that online MySQL/capture records expose, while a sanitized runtime-profile endpoint supplies explicit capabilities to every frontend surface.

**Tech Stack:** Rust, SeaORM/SQLite/MySQL, Python 3, Pillow, NumPy/NPZ, React 18, TypeScript, Vitest, Testing Library, PowerShell, existing BKV conversion utilities.

**Execution note:** The user explicitly requested subsequent work directly on `main`; do not create a feature branch or worktree. Preserve the untracked `image_copy/`, `tmp/`, and `tmp_bkv_extract_test/` directories.

---

### Task 1: Define and validate project/runtime profiles

**Files:**

- Create: `config/project.json`
- Create: `config/runtime-modes/direct-8.json`
- Create: `config/runtime-modes/bkv-6.json`
- Create: `app/service/src/runtime_profile.rs`
- Modify: `app/service/src/main.rs`
- Test: `app/service/src/runtime_profile.rs`

**Step 1: Write failing Rust tests**

Add tests for a wished-for `RuntimeProfile::load(project_path, config_root)` API:

```rust
#[test]
fn loads_six_camera_bkv_profile_with_non_direct_capabilities() {
    let fixture = profile_fixture("bkv-6", 6, "none");
    let loaded = RuntimeProfile::load(&fixture.project, &fixture.config_root).unwrap();
    assert_eq!(loaded.camera_count(), 6);
    assert!(!loaded.capabilities.direct_camera);
    assert!(!loaded.capabilities.capture_management);
    assert!(!loaded.capabilities.reconstruction);
    assert!(loaded.capabilities.offline_replay);
}

#[test]
fn loads_eight_camera_direct_profile_and_capture_reference() {
    let fixture = profile_fixture("direct-8", 8, "headless-cpp");
    let loaded = RuntimeProfile::load(&fixture.project, &fixture.config_root).unwrap();
    assert_eq!(loaded.camera_count(), 8);
    assert!(loaded.capabilities.direct_camera);
    assert_eq!(loaded.capture_profile.as_deref(), Some("current-8-time-trigger"));
}

#[test]
fn rejects_camera_count_mismatch_duplicate_ids_and_path_escape() {
    for invalid in invalid_profile_fixtures() {
        assert!(RuntimeProfile::load(&invalid.project, &invalid.config_root).is_err());
    }
}
```

The fixture must use real temporary JSON files and exercise path containment rather than mocking the parser.

**Step 2: Run tests and verify RED**

Run:

```powershell
cargo test runtime_profile::tests -- --nocapture
```

Expected: compilation fails because `runtime_profile` and `RuntimeProfile::load` do not exist.

**Step 3: Implement the parser and committed profiles**

Implement serde-backed types:

```rust
pub struct RuntimeProfile {
    pub id: String,
    pub display_name: String,
    pub data_source: DataSource,
    pub camera_connection: CameraConnection,
    pub cameras: Vec<RuntimeCamera>,
    pub storage: RuntimeStorage,
    pub capabilities: RuntimeCapabilities,
    pub capture_profile: Option<String>,
    pub config_hash: String,
}
```

Validation rules:

- both schemas must match exactly;
- selected profile and referenced files remain beneath the config root;
- `cameraCount == cameras.len()`;
- camera IDs and order are unique;
- display order is contiguous from 1;
- BKV source paths and target paths are nonblank and contained beneath their configured allowed roots;
- `cameraConnection=none` forbids `directCamera`, `captureManagement`, and `reconstruction`;
- `cameraConnection=headless-cpp` requires the capture profile camera count and camera identities to match;
- invalid configuration fails startup; no fallback to another profile.

Committed profiles:

- `direct-8.json` references `current-8-time-trigger` and C1-C8;
- `bkv-6.json` declares C1-C6, current legacy source locations, converted store location, and non-direct capabilities;
- `project.json` selects `bkv-6.json` for the current development workspace.

Do not place secrets or machine database credentials in the profiles.

**Step 4: Integrate startup loading**

Add `STEEL_PROJECT_CONFIG_PATH` as an optional override. Otherwise load `<repo>/config/project.json` in development and the deployed config root equivalent in packaged runtime.

Store an `Arc<RuntimeProfile>` in application state and use it to validate the configured provider:

```rust
if provider_name != runtime_profile.expected_provider() {
    return Err("runtime_profile_provider_mismatch".to_string());
}
```

**Step 5: Run tests and verify GREEN**

Run:

```powershell
cargo test runtime_profile::tests -- --nocapture
cargo test capture_config_validation -- --nocapture
```

Expected: all selected tests pass.

**Step 6: Commit**

```powershell
git add config/project.json config/runtime-modes app/service/src/runtime_profile.rs app/service/src/main.rs
git commit -m "feat: load configured runtime profiles"
```

---

### Task 2: Expose sanitized runtime capabilities and enforce them server-side

**Files:**

- Modify: `app/service/src/runtime_profile.rs`
- Modify: `app/service/src/main.rs`
- Test: `app/service/src/main.rs`
- Modify: `docs/capture-api-contract.md`

**Step 1: Write failing HTTP and authorization tests**

Add tests proving:

```rust
#[test]
fn runtime_profile_endpoint_exposes_only_sanitized_capabilities() {
    let response = dispatch_get("/api/runtime-profile", bkv_state());
    assert_eq!(response.status, 200);
    let json = response.json();
    assert_eq!(json["cameraCount"], 6);
    assert_eq!(json["capabilities"]["directCamera"], false);
    assert!(json.get("databasePassword").is_none());
    assert!(json.pointer("/storage/sourceRoot").is_none());
}

#[test]
fn non_direct_profile_rejects_capture_and_reconstruction_mutations() {
    for route in direct_only_mutation_routes() {
        let response = dispatch(route.method, route.path, route.body, bkv_state());
        assert_eq!(response.status, 409);
        assert_eq!(response.json()["error"], "runtime_capability_unavailable");
    }
}
```

Cover capture lifecycle, connect-all, device writes, calibration writes, direct reconstruction starts, and storage-root mutation. Read-only historic standard artifacts remain allowed.

**Step 2: Verify RED**

Run:

```powershell
cargo test runtime_profile_endpoint -- --nocapture
cargo test non_direct_profile_rejects -- --nocapture
```

Expected: routes or guards are missing.

**Step 3: Implement the endpoint and guard**

Add:

- `GET /api/runtime-profile`;
- stable DTO schema `steel.runtime-profile.public.v1`;
- `require_runtime_capability(state, capability)` before direct-only actions;
- stable 409 response containing capability and active profile ID;
- API manifest entries and contract documentation.

Do not infer capability from the provider string after startup validation.

**Step 4: Verify GREEN**

Run:

```powershell
cargo test runtime_profile -- --nocapture
cargo test bkv_mode_fences_hardware_mutations -- --nocapture
```

Expected: all selected tests pass.

**Step 5: Commit**

```powershell
git add app/service/src/runtime_profile.rs app/service/src/main.rs docs/capture-api-contract.md
git commit -m "feat: enforce configured runtime capabilities"
```

---

### Task 3: Build the independent BKV conversion service and standard store

**Files:**

- Create: `scripts/bkv_import_service.py`
- Create: `scripts/test_bkv_import_service.py`
- Modify: `scripts/build_bkv_runtime_manifest.py`
- Modify: `scripts/convert_bkv_d3img.py`
- Modify: `scripts/README.md`

**Step 1: Write failing converter tests**

Create temporary two-material, six-camera fixtures using small JPEGs, `.d3img`/NPZ fixtures, and CSV rows. Test the wished-for API:

```python
service = BkvImportService(profile_path=profile, project_path=project)
result = service.run_once()

self.assertEqual(result.status, "completed")
self.assertEqual(result.converted_records, 2)
self.assertTrue((target / "records" / "10" / "record.json").is_file())
self.assertTrue((target / "records" / "10" / "cameras" / "C6" / "frames" / "000004" / "depth.npz").is_file())
self.assertCatalogRecord(target / "catalog.db", "10", camera_count=6)
```

Separate tests must prove:

- source JPEG/NPZ bytes and timestamps do not change;
- a second run with the same source/config hash reports skipped and produces byte-identical catalog rows;
- a missing frame or unknown camera is quarantined;
- a forced interruption leaves only `.staging` content and no queryable catalog row;
- resume completes the interrupted job;
- C7/C8 are never synthesized;
- job ledger records hashes, progress, timestamps, and failure details.

**Step 2: Verify RED**

Run:

```powershell
python -m unittest scripts.test_bkv_import_service -v
```

Expected: import fails because `BkvImportService` does not exist.

**Step 3: Implement normalized output**

Implement:

```python
class BkvImportService:
    def __init__(self, *, project_path: Path, profile_path: Path): ...
    def run_once(self) -> ImportResult: ...
    def status(self) -> dict[str, object]: ...
    def retry_failed(self, job_id: str) -> ImportResult: ...
```

Use only profile-declared C1-C6 mappings. Reuse parsing/conversion helpers from the existing BKV scripts rather than shelling out per frame.

Publish:

```text
records/<inspectionId>/record.json
records/<inspectionId>/source-provenance.json
records/<inspectionId>/cameras/C<n>/frames/<sequence>/intensity.jpg
records/<inspectionId>/cameras/C<n>/frames/<sequence>/depth.npz
records/<inspectionId>/defects/defects.json
```

Create a local SQLite catalog with current business identities and file index semantics. The converter may use a compact import schema initially, but table/column names and DTO fields must map one-to-one to `material_session`, `production_inspection`, `production_defect`, and `capture_file`.

Use:

- `imports/.staging/<job>/<record>`;
- SHA-256 source/config identity;
- `import_job` and `import_record` ledger tables;
- atomic directory rename;
- one SQLite transaction per published record;
- quarantine metadata outside the queryable record directory.

Add CLI modes:

```text
--once
--status
--retry <job-id>
--serve --host 127.0.0.1 --port <configured>
```

The local service endpoint only needs health, status, start, and retry; it must not serve business records or arbitrary files.

**Step 4: Verify GREEN**

Run:

```powershell
python -m unittest scripts.test_bkv_import_service -v
python -m unittest scripts.test_bkv_runtime_manifest scripts.test_bkv_d3img_conversion -v
```

Expected: converter and existing conversion tests pass.

**Step 5: Commit**

```powershell
git add scripts/bkv_import_service.py scripts/test_bkv_import_service.py scripts/build_bkv_runtime_manifest.py scripts/convert_bkv_d3img.py scripts/README.md
git commit -m "feat: convert BKV sources into standard storage"
```

---

### Task 4: Read converted BKV records through the unified inspection repository

**Files:**

- Create: `app/service/src/standard_record_store.rs`
- Modify: `app/service/src/main.rs`
- Modify: `app/service/src/bkv.rs`
- Modify: `app/service/src/inspection_world.rs`
- Test: `app/service/src/standard_record_store.rs`
- Test: `app/service/src/main.rs`

**Step 1: Write failing repository contract tests**

Create the same logical record twice: once in a temporary converted SQLite/file store and once through an online database fixture. Assert identical public DTOs:

```rust
assert_eq!(
    normalize(records_from(converted_store)),
    normalize(records_from(online_store))
);
assert_eq!(
    normalize(defects_from(converted_store, "10")),
    normalize(defects_from(online_store, "10"))
);
```

Also prove:

- converted store exposes exactly six configured cameras;
- tile sources resolve only through indexed `capture_file` paths;
- incomplete staging records are invisible;
- converted mode never queries the online database adapter;
- online mode never opens the BKV converted root;
- invalid hashes or paths outside the standard root fail closed.

**Step 2: Verify RED**

Run:

```powershell
cargo test standard_record_store::tests -- --nocapture
```

Expected: module and adapter are missing.

**Step 3: Implement the standard store**

Create a repository abstraction used by inspection-world endpoints:

```rust
pub trait InspectionRecordStore {
    fn records(&self) -> Result<Vec<InspectionRecordDto>, StoreError>;
    fn record(&self, id: &str) -> Result<Option<InspectionRecordDto>, StoreError>;
    fn defects(&self, id: &str) -> Result<Vec<InspectionDefectDto>, StoreError>;
    fn capture_files(&self, id: &str) -> Result<Vec<CaptureFileDto>, StoreError>;
}
```

Implement:

- `ConvertedLocalStore` backed by the converter catalog and standard root;
- an adapter around current online production queries.

Move world construction to consume `CaptureFileDto` and configured camera topology. Keep camera-local tiles and head alignment unchanged.

Retain `/api/bkv/status` for mode/compatibility/import status, but route records, defects, metadata, and tiles through the unified repository. Remove the requirement that runtime business requests read `bkv-runtime-manifest.json`.

**Step 4: Verify GREEN**

Run:

```powershell
cargo test standard_record_store::tests -- --nocapture
cargo test inspection_world::tests -- --nocapture
cargo test inspection_world_http -- --nocapture
cargo test bkv::tests -- --nocapture
```

Expected: all selected tests pass.

**Step 5: Commit**

```powershell
git add app/service/src/standard_record_store.rs app/service/src/main.rs app/service/src/bkv.rs app/service/src/inspection_world.rs
git commit -m "feat: read converted BKV records from standard storage"
```

---

### Task 5: Add runtime profile and converter management APIs

**Files:**

- Modify: `app/service/src/main.rs`
- Modify: `app/service/src/db/mod.rs`
- Modify: `app/service/src/db/entities.rs`
- Test: `app/service/src/main.rs`
- Modify: `docs/capture-api-contract.md`

**Step 1: Write failing admin API tests**

Cover:

- `GET /api/admin/runtime-profile`;
- `POST /api/admin/runtime-profile/validate`;
- `POST /api/admin/runtime-profile`;
- `GET /api/admin/bkv-import/jobs`;
- `POST /api/admin/bkv-import/jobs`;
- `POST /api/admin/bkv-import/jobs/retry`.

Assertions:

```rust
assert_eq!(save.status, 200);
assert_eq!(save.json()["restartRequired"], true);
assert!(config_revision_exists("runtime-profile"));
assert!(audit_event_exists("runtime-profile.update"));
```

Invalid camera count, duplicate mapping, path escape, a direct-only capability in BKV, and non-loopback converter origins must be rejected. Reads/writes require `admin.config`; ordinary public runtime status remains read-only.

**Step 2: Verify RED**

Run:

```powershell
cargo test admin_runtime_profile -- --nocapture
cargo test admin_bkv_import -- --nocapture
```

Expected: route tests fail with not found.

**Step 3: Implement APIs**

Use existing config revision and audit infrastructure. Save profile files atomically and do not mutate the in-memory active profile. Proxy converter health/jobs only to the configured loopback origin with bounded timeouts and sanitized errors.

Return:

```json
{
  "saved": true,
  "profileId": "bkv-6",
  "restartRequired": true,
  "activeConfigHash": "...",
  "savedConfigHash": "..."
}
```

**Step 4: Verify GREEN**

Run:

```powershell
cargo test admin_runtime_profile -- --nocapture
cargo test admin_bkv_import -- --nocapture
cargo test config_revision -- --nocapture
```

Expected: all selected tests pass.

**Step 5: Commit**

```powershell
git add app/service/src/main.rs app/service/src/db/mod.rs app/service/src/db/entities.rs docs/capture-api-contract.md
git commit -m "feat: manage runtime profiles and BKV imports"
```

---

### Task 6: Add runtime mode and BKV conversion management to the backend UI

**Files:**

- Create: `app/client/src/services/runtime-profile-api.ts`
- Create: `app/client/src/services/runtime-profile-api.test.ts`
- Modify: `app/client/src/components/ParameterManagementApp.tsx`
- Modify: `app/client/src/components/ParameterManagementApp.test.tsx`
- Modify: `app/client/src/styles.css`

**Step 1: Write failing client and component tests**

Add API tests for typed public/admin profile reads, validate/save, job list/start/retry.

Add backend UI tests proving:

- “运行模式与数据转换” renders in system configuration;
- active profile is BKV six-camera;
- C1-C6 mappings render, C7/C8 do not;
- validation errors display without saving;
- save displays “重启后生效”;
- converter job progress and counts render;
- start/retry actions call protected APIs;
- users without `admin.config` cannot mutate configuration.

**Step 2: Verify RED**

Run:

```powershell
npm test -- src/services/runtime-profile-api.test.ts src/components/ParameterManagementApp.test.tsx
```

Expected: tests fail because API and panel do not exist.

**Step 3: Implement the API and panel**

Use typed models:

```ts
type RuntimeCapabilities = {
  directCamera: boolean;
  captureManagement: boolean;
  reconstruction: boolean;
  offlineReplay: boolean;
};
```

The panel must offer:

- active and saved profile/hash;
- mode, camera count and capability summary;
- six ordered BKV camera mappings;
- source/target configuration editor;
- validate and save buttons;
- persistent restart-required banner;
- converter health and job table;
- start and retry actions.

Do not expose secrets or allow a browser-selected arbitrary path to bypass server validation.

**Step 4: Verify GREEN**

Run:

```powershell
npm test -- src/services/runtime-profile-api.test.ts src/components/ParameterManagementApp.test.tsx
```

Expected: selected tests pass.

**Step 5: Commit**

```powershell
git add app/client/src/services/runtime-profile-api.ts app/client/src/services/runtime-profile-api.test.ts app/client/src/components/ParameterManagementApp.tsx app/client/src/components/ParameterManagementApp.test.tsx app/client/src/styles.css
git commit -m "feat: manage BKV runtime configuration in backend"
```

---

### Task 7: Drive all frontend capabilities and camera counts from the runtime profile

**Files:**

- Modify: `app/client/src/App.tsx`
- Modify: `app/client/src/App.test.tsx`
- Modify: `app/client/src/components/AppFooter.tsx`
- Modify: `app/client/src/components/AppFooter.test.tsx`
- Modify: `app/client/src/components/SystemStatusPage.tsx`
- Modify: `app/client/src/components/SystemStatusPage.test.tsx`
- Modify: `app/client/src/components/BrandHeader.tsx`
- Modify: `app/client/src/components/BrandHeader.test.tsx`
- Modify: `app/client/src/components/BkvCompatibilityApp.tsx`
- Modify: `app/client/src/components/BkvCompatibilityApp.test.tsx`
- Modify: `app/client/src/components/BarSurfaceApp.tsx`
- Modify: `app/client/src/components/CaptureAdvancedOperations.tsx`
- Modify: `app/client/src/components/CaptureOperationsPanel.tsx`

**Step 1: Write failing capability tests**

Tests must prove:

- BKV profile displays C1-C6 based on config;
- direct profile displays C1-C8;
- BKV footer and system status do not contain “采集管理” or “3D 重建”;
- backend management remains visible;
- a deep link to `?app=capture` or `?app=bar-surface` under BKV redirects to `?app=terminal` and shows a capability message;
- direct mode keeps both tools;
- status fractions and camera lists use `runtimeProfile.cameraCount`, not literal 6/8 fallbacks.

**Step 2: Verify RED**

Run:

```powershell
npm test -- src/App.test.tsx src/components/AppFooter.test.tsx src/components/SystemStatusPage.test.tsx src/components/BkvCompatibilityApp.test.tsx
```

Expected: BKV still renders direct-only entries and literals.

**Step 3: Implement a runtime profile context**

Fetch `/api/runtime-profile` before deciding standalone application mode. Fail closed for direct-only tools when capabilities are unavailable.

Pass capabilities and camera count explicitly to affected components. Remove UI fallbacks such as:

```ts
bkvStatus?.cameraCount ?? 6
expectedCameras: 8
`${manifest.cameraCount}/8`
```

Use a configuration-derived value or the record manifest count according to the component’s semantic context.

Hide direct-only entries rather than rendering disabled buttons, as requested.

**Step 4: Verify GREEN**

Run the command from Step 2 and the focused camera display tests:

```powershell
npm test -- src/lib/camera-display.test.ts src/components/InspectionWorldCanvas.test.tsx
```

Expected: selected tests pass.

**Step 5: Commit**

```powershell
git add app/client/src/App.tsx app/client/src/App.test.tsx app/client/src/components/AppFooter.tsx app/client/src/components/AppFooter.test.tsx app/client/src/components/SystemStatusPage.tsx app/client/src/components/SystemStatusPage.test.tsx app/client/src/components/BrandHeader.tsx app/client/src/components/BrandHeader.test.tsx app/client/src/components/BkvCompatibilityApp.tsx app/client/src/components/BkvCompatibilityApp.test.tsx app/client/src/components/BarSurfaceApp.tsx app/client/src/components/CaptureAdvancedOperations.tsx app/client/src/components/CaptureOperationsPanel.tsx
git commit -m "feat: adapt interfaces to runtime capabilities"
```

---

### Task 8: Use same-tab browser navigation and keep Tauri windows

**Files:**

- Modify: `app/client/src/lib/app-windows.ts`
- Create or modify: `app/client/src/lib/app-windows.test.ts`
- Modify: `app/client/src/components/SettingsPage.tsx`
- Modify: `app/client/src/components/AppFooter.tsx`
- Modify: `app/client/src/components/SystemStatusPage.tsx`

**Step 1: Write failing environment-specific tests**

Browser assertion:

```ts
await openAppWindow('parameters');
expect(window.location.assign).toHaveBeenCalledWith('/?app=parameters');
expect(window.open).not.toHaveBeenCalled();
```

Tauri assertion:

```ts
await openAppWindow('parameters');
expect(WebviewWindow).toHaveBeenCalled();
expect(window.location.assign).not.toHaveBeenCalled();
```

Also assert canonical query routes for capture and bar-surface and compatibility parsing for old `#app=` links.

**Step 2: Verify RED**

Run:

```powershell
npm test -- src/lib/app-windows.test.ts src/components/AppFooter.test.tsx
```

Expected: browser test receives `window.open`.

**Step 3: Implement navigation**

Change browser behavior to:

```ts
window.location.assign(definition.url);
```

Use canonical URLs:

- `/?app=parameters`
- `/?app=capture`
- `/?app=bar-surface`

Update notifications so browsers report navigation, not an independent window. Preserve Tauri window creation and focus behavior.

**Step 4: Verify GREEN**

Run the Step 2 tests.

**Step 5: Commit**

```powershell
git add app/client/src/lib/app-windows.ts app/client/src/lib/app-windows.test.ts app/client/src/components/SettingsPage.tsx app/client/src/components/AppFooter.tsx app/client/src/components/SystemStatusPage.tsx
git commit -m "fix: navigate browser tools in the current tab"
```

---

### Task 9: Rebuild the real BKV data into standard storage

**Files:**

- Modify generated data only beneath the configured converted target root
- Modify: `config/env/bkv.env.example`
- Modify: `docs/independent-architecture.md`
- Modify: `docs/release-deployment-and-operations.md`

**Step 1: Dry-run and inspect source coverage**

Run the converter in validation mode against `tmp/legacy-bkv` and assert:

- 11 records;
- six cameras per record;
- no C7/C8;
- all indexed JPEG/NPZ paths remain beneath the source root;
- current source hash inventory is stable.

**Step 2: Run the real import**

Run:

```powershell
python scripts/bkv_import_service.py --project config/project.json --once
```

Expected: 11 records published to the configured converted root; no source file changes.

**Step 3: Audit the output**

Verify:

- 11 catalog records;
- six camera directories and indexed file rows per record;
- records 1893700-1893710;
- source provenance hashes;
- JPEG decode and NPZ schema;
- defect associations;
- no staging record is visible;
- a second import is fully skipped/idempotent.

**Step 4: Update configuration documentation**

Document:

- project and runtime profile selection;
- BKV converter lifecycle;
- restart-required behavior;
- standard storage layout;
- SQLite/MySQL isolation;
- converter recovery and quarantine;
- direct-only capability behavior.

**Step 5: Commit only source/config/documentation**

Do not commit user data or generated converted records unless the repository already tracks an explicit small fixture.

```powershell
git add config/env/bkv.env.example docs/independent-architecture.md docs/release-deployment-and-operations.md
git commit -m "docs: operate converted BKV runtime data"
```

---

### Task 10: Full verification and browser acceptance

**Files:**

- Modify tests or smoke scripts only if required by the new public contract
- Potentially modify: `scripts/test-runtime-ui-smoke.ps1`

**Step 1: Run all automated suites**

```powershell
cd app/service
cargo test

cd ../client
npm test
npm run build

cd ../..
python -m unittest scripts.test_bkv_import_service scripts.test_bkv_runtime_manifest scripts.test_bkv_d3img_conversion -v
git diff --check
```

Expected: all tests and build pass. Record any pre-existing jsdom canvas, chart-size, React `act`, dead-code, or chunk-size warnings accurately.

**Step 2: Start the configured BKV converter and Rust service**

Start hidden background processes using the committed BKV profile, then confirm:

- converter health/job endpoints;
- Rust `/api/runtime-profile`;
- BKV status;
- unified records, defects, metadata, and camera-local tiles;
- no online MySQL access attempt;
- no camera SDK process.

**Step 3: Browser acceptance**

At the existing Vite page:

- reload the BKV mode;
- verify C1-C6 and real widths;
- verify no C7/C8;
- verify “采集管理” and “3D 重建” are absent;
- open backend management and confirm same-tab navigation;
- confirm six-camera BKV config, restart-required semantics, and import job status;
- use browser back to return to the detection page;
- verify direct-only deep links redirect safely;
- inspect console for new errors.

Switch to a direct-profile test fixture and verify:

- runtime profile reports eight cameras;
- direct-only entries reappear;
- no BKV converted-store paths are used.

**Step 4: Final repository audit**

```powershell
git status --short
git log --oneline -15
```

Expected: only the user’s pre-existing untracked data directories remain; source changes are committed directly on `main`.

