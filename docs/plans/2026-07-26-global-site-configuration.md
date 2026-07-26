# Global Site Configuration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add mode-immutable site configuration packages, safe restart-required switching, availability checks, a new global configuration page, overview status, and mode-aware backend-management layouts.

**Architecture:** Introduce a Rust `site_config` domain module that owns site package discovery, validation, checking, cloning, deletion, and atomic activation beneath `config/sites`. Keep `RuntimeProfile` as the runtime projection loaded from the active site package, expose the new model through authenticated admin APIs, and render it through focused React panels instead of the current all-in-one configuration grid.

**Tech Stack:** Rust 2021, serde/serde_json, existing HTTP service and audit store, React 18, TypeScript, Vitest, Testing Library, CSS.

---

### Task 1: Build the site configuration domain and file store

**Files:**
- Create: `app/service/src/site_config.rs`
- Modify: `app/service/src/main.rs:32`
- Test: `app/service/src/site_config.rs`

**Step 1: Write the failing domain tests**

Add unit tests covering:

```rust
#[test]
fn creates_a_bkv_site_package_with_an_immutable_mode() {
    let fixture = SiteConfigFixture::new();
    let created = fixture.store.create(CreateSiteConfig {
        id: "bkv-east".into(),
        display_name: "BKV 东线".into(),
        mode: SiteMode::Bkv,
    }).unwrap();

    assert_eq!(created.document.mode, SiteMode::Bkv);
    assert!(created.root.join("runtime.json").is_file());
}

#[test]
fn rejects_mode_changes_for_an_existing_site() {
    let fixture = SiteConfigFixture::with_bkv_site("bkv-east");
    let error = fixture.store.update_metadata(
        "bkv-east",
        UpdateSiteMetadata {
            display_name: Some("东线".into()),
            mode: Some(SiteMode::Direct),
        },
    ).unwrap_err();

    assert!(error.contains("mode cannot change"));
}

#[test]
fn rejects_ids_and_paths_that_escape_the_sites_root() {
    let fixture = SiteConfigFixture::new();
    assert!(fixture.store.get("../outside").is_err());
}
```

Also cover listing, duplicate IDs, cloning, deleting, and rejecting symlink/canonicalized paths outside the allowed root.

**Step 2: Run the tests to verify they fail**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml site_config -- --nocapture
```

Expected: FAIL because `site_config` and its types do not exist.

**Step 3: Implement the minimal domain**

Create serializable types:

```rust
#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SiteMode {
    Bkv,
    DirectCamera,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteConfigDocument {
    pub schema: String,
    pub id: String,
    pub display_name: String,
    pub mode: SiteMode,
    pub runtime_profile: String,
    pub connection_config: String,
    pub capture_config: String,
}
```

Add `SiteConfigStore` with:

- `list`
- `get`
- `create`
- `clone_site`
- `update_metadata`
- `delete`
- normalized ID validation
- canonical containment checks rooted at `config/sites`
- mode-specific minimal templates
- atomic JSON writes using the existing write-through replacement behavior

Keep all file mutations inside the new module; do not duplicate path-validation logic in the HTTP layer.

**Step 4: Run the focused tests**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml site_config -- --nocapture
```

Expected: PASS for all site store tests.

**Step 5: Commit**

```powershell
git add app/service/src/site_config.rs app/service/src/main.rs
git commit -m "feat: add site configuration store"
```

### Task 2: Add default and deep availability checks

**Files:**
- Modify: `app/service/src/site_config.rs`
- Test: `app/service/src/site_config.rs`

**Step 1: Write failing check tests**

Add tests for:

```rust
#[test]
fn default_bkv_check_reports_required_data_source_and_storage() {
    let fixture = SiteConfigFixture::with_bkv_site("bkv-east");
    let report = fixture.store.check("bkv-east", CheckDepth::Default).unwrap();

    assert!(report.checks.iter().any(|item| item.id == "bkv.dataSource"));
    assert!(report.checks.iter().any(|item| item.id == "storage.convertedRoot"));
    assert!(!report.checks.iter().any(|item| item.id == "camera.devices"));
}

#[test]
fn direct_check_requires_capture_and_camera_mapping() {
    let fixture = SiteConfigFixture::with_direct_site("line-eight");
    fixture.break_capture_mapping();
    let report = fixture.store.check("line-eight", CheckDepth::Default).unwrap();

    assert!(report.has_blocking_errors());
}

#[test]
fn default_checks_do_not_run_deep_probes() {
    let fixture = SiteConfigFixture::with_probe_spy();
    fixture.store.check("bkv-east", CheckDepth::Default).unwrap();
    assert_eq!(fixture.deep_probe_calls(), 0);
}
```

**Step 2: Run the tests to verify they fail**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml site_config::tests -- --nocapture
```

Expected: FAIL because `CheckDepth` and report generation are missing.

**Step 3: Implement check result types and default checks**

Implement:

```rust
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteConfigCheck {
    pub id: String,
    pub label: String,
    pub status: CheckStatus,
    pub message: String,
    pub blocking: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteConfigCheckReport {
    pub site_id: String,
    pub depth: CheckDepth,
    pub checked_at: String,
    pub checks: Vec<SiteConfigCheck>,
}
```

Default checks must cover schema, required mode files, path containment, read/write access, database or HTTP endpoint syntax/connectivity, camera count/mapping consistency, storage path existence, and available space. Deep checks must be injected behind a probe trait so unit tests never touch production hardware.

**Step 4: Run focused tests**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml site_config::tests -- --nocapture
```

Expected: PASS, including proof that default checks do not invoke deep probes.

**Step 5: Commit**

```powershell
git add app/service/src/site_config.rs
git commit -m "feat: validate site configuration availability"
```

### Task 3: Load runtime profiles through the active site package

**Files:**
- Modify: `app/service/src/runtime_profile.rs:1-360`
- Modify: `app/service/src/main.rs:199-280`
- Modify: `config/project.json`
- Create: `config/sites/bkv-default/site.json`
- Create: `config/sites/bkv-default/runtime.json`
- Create: `config/sites/bkv-default/connection.json`
- Create: `config/sites/bkv-default/capture.json`
- Test: `app/service/src/runtime_profile.rs`
- Test: `app/service/src/site_config.rs`

**Step 1: Write failing loader and compatibility tests**

Cover:

```rust
#[test]
fn loads_runtime_profile_relative_to_the_active_site_manifest() {
    let fixture = SiteConfigFixture::with_bkv_site("bkv-default");
    let runtime = RuntimeProfile::load(&fixture.project, &fixture.config_root).unwrap();
    assert_eq!(runtime.id, "bkv-default");
    assert_eq!(runtime.camera_count(), 6);
}

#[test]
fn old_active_runtime_profile_is_exposed_as_legacy_compatibility_site() {
    let fixture = LegacyProjectFixture::new("config/runtime-modes/bkv-6.json");
    let resolved = resolve_active_site(&fixture.project, &fixture.root).unwrap();
    assert!(resolved.compatibility);
}

#[test]
fn config_root_relative_paths_do_not_raise_false_escape_errors() {
    let fixture = SiteConfigFixture::with_project_relative_pointer();
    assert!(RuntimeProfile::load(&fixture.project, &fixture.root).is_ok());
}
```

**Step 2: Run the tests to verify they fail**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml runtime_profile -- --nocapture
```

Expected: FAIL because the loader only understands `activeRuntimeProfile`.

**Step 3: Implement site-aware loading**

- Extend project config parsing with `activeSiteConfig` and `pendingRestart`.
- Resolve site-relative files against the site manifest directory.
- Canonicalize the allowed config root once and enforce containment after joining.
- Keep read-only support for legacy `activeRuntimeProfile`.
- Add active site ID, display name, mode, project path, site path, and config hash to the loaded runtime projection.
- Clear a persisted pending-restart flag only after a successful startup load.

Do not allow an admin save to change the running `Arc<RuntimeProfile>`; activation remains restart-only.

**Step 4: Create the checked-in BKV six-camera package**

Move the current BKV-online six-camera semantics into `config/sites/bkv-default`. Keep the source runtime-mode files temporarily for compatibility tests, but update `config/project.json` to point at the new site manifest.

**Step 5: Run focused and full service tests**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml runtime_profile -- --nocapture
cargo test --manifest-path app/service/Cargo.toml
```

Expected: PASS with the active BKV package reporting six cameras and no false allowed-root error.

**Step 6: Commit**

```powershell
git add app/service/src/runtime_profile.rs app/service/src/main.rs config/project.json config/sites
git commit -m "feat: load runtime from active site configuration"
```

### Task 4: Expose authenticated site configuration APIs and overview status

**Files:**
- Modify: `app/service/src/main.rs:6257-6395`
- Modify: `app/service/src/main.rs:13659-13910`
- Modify: `app/service/src/main.rs:19600-19780`
- Modify: `app/service/src/main.rs:20019-20140`
- Test: `app/service/src/main.rs`

**Step 1: Write failing route and response tests**

Add tests for:

- all site-config routes require `admin.config`
- list and detail responses
- create and clone
- mode-changing patch returns `400`
- deleting current or pending site returns `409`
- blocking checks prevent activation
- activation atomically updates `project.json` and returns `restartRequired: true`
- overview contains active site and check summary
- every mutation appends an audit log

Use query parameters for IDs to fit the existing exact-path router:

```text
GET    /api/admin/site-configs
GET    /api/admin/site-configs/detail?id=bkv-default
POST   /api/admin/site-configs
POST   /api/admin/site-configs/clone
PATCH  /api/admin/site-configs
DELETE /api/admin/site-configs?id=bkv-default
POST   /api/admin/site-configs/check
POST   /api/admin/site-configs/activate
```

**Step 2: Run tests to verify they fail**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml admin_site_config -- --nocapture
```

Expected: FAIL because routes and handlers are missing.

**Step 3: Add state and handlers**

- Add `SiteConfigStore` to `ServiceState`.
- Add `permission_for_route` entries for every new endpoint.
- Parse small typed request bodies rather than raw `Value`.
- Return stable schemas such as `steel.site-config-list.v1` and `steel.site-config-check.v1`.
- Record create, clone, update, delete, check, and activate operations in the audit log.
- Use the domain module for every filesystem mutation.

**Step 4: Extend `/api/admin/overview`**

Return:

```json
{
  "siteConfiguration": {
    "active": {},
    "pending": null,
    "restartRequired": false,
    "checkSummary": {
      "normal": 8,
      "warning": 0,
      "error": 0,
      "blocking": 0,
      "checkedAt": "..."
    }
  }
}
```

The overview endpoint runs only the default, non-invasive check.

**Step 5: Run route and complete service tests**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml admin_site_config -- --nocapture
cargo test --manifest-path app/service/Cargo.toml
```

Expected: PASS.

**Step 6: Commit**

```powershell
git add app/service/src/main.rs app/service/src/site_config.rs
git commit -m "feat: expose site configuration admin APIs"
```

### Task 5: Add the typed React API client

**Files:**
- Create: `app/client/src/services/site-config-api.ts`
- Create: `app/client/src/services/site-config-api.test.ts`
- Modify: `app/client/src/services/inspection-api.ts:240-275`

**Step 1: Write failing client tests**

Test URL, HTTP method, admin headers, request payload, error messages, and response typing for:

```ts
fetchSiteConfigs()
fetchSiteConfig('bkv-default')
createSiteConfig({ id: 'bkv-east', displayName: 'BKV 东线', mode: 'bkv' })
cloneSiteConfig('bkv-default', { id: 'bkv-east', displayName: 'BKV 东线' })
updateSiteConfig('bkv-east', { displayName: '东线' })
deleteSiteConfig('bkv-east')
checkSiteConfig('bkv-east', 'default')
activateSiteConfig('bkv-east')
```

**Step 2: Run the test to verify it fails**

Run:

```powershell
npm --prefix app/client test -- site-config-api.test.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Implement the API client**

Export typed models:

```ts
export type SiteMode = 'bkv' | 'direct-camera';
export type SiteConfigCheckStatus = 'normal' | 'warning' | 'error';

export type SiteConfigSummary = {
  id: string;
  displayName: string;
  mode: SiteMode;
  cameraCount: number;
  active: boolean;
  pending: boolean;
  restartRequired: boolean;
};
```

Use the existing inspection service origin and admin authorization helpers. Keep UI labels out of the service layer.

Extend `AdminOverview` with the optional `siteConfiguration` block so older service responses remain readable during migration.

**Step 4: Run client API tests**

Run:

```powershell
npm --prefix app/client test -- site-config-api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```powershell
git add app/client/src/services/site-config-api.ts app/client/src/services/site-config-api.test.ts app/client/src/services/inspection-api.ts
git commit -m "feat: add site configuration API client"
```

### Task 6: Build the Global Configuration page

**Files:**
- Create: `app/client/src/components/GlobalConfigurationPanel.tsx`
- Create: `app/client/src/components/GlobalConfigurationPanel.test.tsx`
- Modify: `app/client/src/components/ParameterManagementApp.tsx:498-520`
- Modify: `app/client/src/components/ParameterManagementApp.tsx:1430-1470`
- Modify: `app/client/src/components/ParameterManagementApp.tsx:2184-2190`
- Modify: `app/client/src/styles.css:5868-6115`

**Step 1: Write failing component tests**

Cover:

- configuration list and active/pending badges
- new dialog exposes mode selection
- existing detail renders mode as read-only text
- clone inherits source mode
- blocking check disables activation
- activation success shows restart-required notice
- active and pending configurations cannot be deleted
- narrow layout keeps actions reachable

Example:

```tsx
it('allows mode selection only while creating', async () => {
  render(<GlobalConfigurationPanel canEdit />);
  await user.click(await screen.findByRole('button', { name: '新建配置' }));
  expect(screen.getByRole('combobox', { name: '运行模式' })).toBeEnabled();

  await user.click(screen.getByRole('button', { name: '取消' }));
  await user.click(screen.getByRole('button', { name: 'BKV 六相机现场' }));
  expect(screen.queryByRole('combobox', { name: '运行模式' })).not.toBeInTheDocument();
  expect(screen.getByText('BKV 模式')).toBeInTheDocument();
});
```

**Step 2: Run the tests to verify they fail**

Run:

```powershell
npm --prefix app/client test -- GlobalConfigurationPanel.test.tsx
```

Expected: FAIL because the component does not exist.

**Step 3: Implement the panel**

- Fetch site list on mount.
- Select active site by default.
- Use a fixed top status bar, `minmax(240px, 320px) minmax(0, 1fr)` content grid, and independently scrollable list/detail regions.
- Keep create/clone forms separate from the detail view.
- Render checks grouped by blocking errors, warnings, and normal results.
- Require explicit confirmation before activation or deletion.
- Never send a `mode` field from the edit flow.

**Step 4: Add the navigation section**

Extend:

```ts
type ParameterSection =
  | 'overview'
  | 'services'
  | 'data'
  | 'global-config'
  | 'config'
  | 'rules'
  | 'users'
  | 'permissions'
  | 'audit'
  | 'security';
```

Label it “全局配置” and gate it with `admin.config`. Move `RuntimeProfileManagementPanel` out of the existing `config` section; keep it only as a temporary compatibility detail inside the new page until the site-detail editor replaces every field.

**Step 5: Run focused tests**

Run:

```powershell
npm --prefix app/client test -- GlobalConfigurationPanel.test.tsx ParameterManagementApp.test.tsx
```

Expected: PASS.

**Step 6: Commit**

```powershell
git add app/client/src/components/GlobalConfigurationPanel.tsx app/client/src/components/GlobalConfigurationPanel.test.tsx app/client/src/components/ParameterManagementApp.tsx app/client/src/styles.css
git commit -m "feat: add global site configuration page"
```

### Task 7: Add overview checks and mode-aware module layout

**Files:**
- Modify: `app/client/src/components/ParameterManagementApp.tsx:1638-1810`
- Modify: `app/client/src/components/ParameterManagementApp.tsx:2184-2415`
- Modify: `app/client/src/components/ParameterManagementApp.test.tsx:2080-2165`
- Modify: `app/client/src/styles.css:5868-6115`

**Step 1: Write failing UI tests**

Add tests proving:

- overview shows site name, mode, source, camera count, check counts, and restart state
- overview offers “检查配置” and “进入全局配置”
- BKV mode does not render camera-direct, capture-management, or reconstruction modules
- direct mode renders those modules
- only the selected configuration module and its JSON editor are mounted
- the old runtime-profile panel is absent from the general configuration grid

**Step 2: Run tests to verify they fail**

Run:

```powershell
npm --prefix app/client test -- ParameterManagementApp.test.tsx
```

Expected: FAIL on missing overview and mode-aware layout assertions.

**Step 3: Implement overview cards**

Render `adminOverview.siteConfiguration` as two compact cards:

- current/pending site identity and restart state
- availability summary and last checked timestamp

Make “进入全局配置” set `activeSection` to `global-config`. Default checks may refresh overview data, but must not call the deep-check endpoint.

**Step 4: Replace the configuration mega-grid**

Use a module navigation list and one detail region. Derive visible modules from the active site mode/capabilities returned by the server:

```ts
const visibleModules = site.mode === 'bkv'
  ? ['conversion', 'data-source', 'storage', 'camera-map', 'algorithm']
  : ['cameras', 'capture', 'trigger', 'plc', 'storage', 'algorithm', 'reconstruction'];
```

Do not infer BKV from the browser query string. Do not render direct-camera controls when the server does not advertise the capability.

**Step 5: Fix responsive layout**

- Keep app header and section navigation fixed.
- Make only the section body scroll.
- Give JSON editors a stable height and render one at a time.
- Collapse global-config and module-detail grids at 900 px.
- Allow action bars to wrap without overlapping inputs.

**Step 6: Run focused and full client tests**

Run:

```powershell
npm --prefix app/client test -- ParameterManagementApp.test.tsx GlobalConfigurationPanel.test.tsx
npm --prefix app/client test
npm --prefix app/client run build
```

Expected: all tests PASS and TypeScript/Vite build succeeds.

**Step 7: Commit**

```powershell
git add app/client/src/components/ParameterManagementApp.tsx app/client/src/components/ParameterManagementApp.test.tsx app/client/src/styles.css
git commit -m "feat: show site configuration status in administration"
```

### Task 8: Run integrated migration and browser acceptance

**Files:**
- Modify if necessary: `README.md`
- Modify if necessary: `docs/plans/2026-07-26-global-site-configuration-design.md`

**Step 1: Run complete automated verification**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml
npm --prefix app/client test
npm --prefix app/client run build
git diff --check
```

Expected: every command succeeds with no whitespace errors.

**Step 2: Start the service with the checked-in project config**

Run the repository’s documented local service command, then verify:

```powershell
Invoke-RestMethod http://127.0.0.1:4873/api/runtime-profile
```

Expected: BKV provider, six cameras, no allowed-root error.

**Step 3: Exercise site configuration APIs**

Using an authenticated admin session:

- create a temporary BKV site
- run default check
- clone it
- verify mode cannot be changed
- activate the clone
- verify `restartRequired: true`
- verify active running profile remains unchanged before restart
- restore the original site pointer and remove temporary sites

Expected: all operations are audited and no production data is written.

**Step 4: Perform browser layout acceptance**

Use the in-app browser to inspect:

- 1787×1272
- 1366×768
- a narrow window below 900 px

Verify:

- navigation contains “全局配置”
- list/detail layout is readable and independently scrollable
- mode is selectable only when creating
- total overview exposes availability checks
- BKV hides direct-camera/capture/reconstruction configuration
- direct mode shows them
- activation shows a restart-required state
- no oversized blank areas, overlapping buttons, or simultaneous giant JSON editors

**Step 5: Document operational behavior**

Update `README.md` only if the existing run/configuration section needs the new `config/sites` layout, restart requirement, and legacy compatibility behavior.

**Step 6: Final verification and commit**

Run:

```powershell
git status --short
git diff --check
```

Commit only intended source, config, test, and documentation changes; do not add `image_copy/`, `tmp/`, or `tmp_bkv_extract_test/`.

```powershell
git add README.md docs app config
git commit -m "docs: explain global site configuration workflow"
```

Skip the final documentation commit when no documentation changes are needed.

