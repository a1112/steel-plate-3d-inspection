# Machine-Local Default Site Configuration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a machine-local default site selector with environment override, self-contained site packages, safe import/export, and global-configuration UI controls.

**Architecture:** The Rust service will resolve a site ID through `STEEL_SITE_CONFIG_ID`, a machine-scoped Windows registry store, then the repository fallback in `config/project.json`. Site packages become complete configuration boundaries; startup, clone, import, and export validate that every configuration-file reference remains inside the selected package. The administration API exposes selection status and mutates only the machine registry, while the current process keeps its startup profile until restart.

**Tech Stack:** Rust standard library, `windows-sys`, `serde_json`, `zip`, existing HTTP/auth/audit infrastructure, React/TypeScript, Vitest, PowerShell acceptance scripts.

---

### Task 1: Add the pure machine-site selection model

**Files:**
- Create: `app/service/src/machine_site_config.rs`
- Modify: `app/service/src/main.rs`
- Test: `app/service/src/machine_site_config.rs`

**Step 1: Write the failing precedence tests**

Add tests using an in-memory `MachineSiteStore`:

```rust
#[test]
fn environment_override_wins_over_registry_and_repository() {
    let input = SiteSelectionInput {
        environment_site_id: Some("env-site".into()),
        machine_default_site_id: Some("registry-site".into()),
        repository_default_site_id: "repo-site".into(),
    };

    assert_eq!(
        select_site(input).unwrap(),
        EffectiveSiteSelection {
            site_id: "env-site".into(),
            source: SiteSelectionSource::Environment,
        }
    );
}

#[test]
fn registry_default_wins_when_environment_is_absent() {
    let input = SiteSelectionInput {
        environment_site_id: None,
        machine_default_site_id: Some("registry-site".into()),
        repository_default_site_id: "repo-site".into(),
    };

    assert_eq!(select_site(input).unwrap().site_id, "registry-site");
}

#[test]
fn repository_default_is_the_final_fallback() {
    let input = SiteSelectionInput {
        environment_site_id: None,
        machine_default_site_id: None,
        repository_default_site_id: "repo-site".into(),
    };

    assert_eq!(select_site(input).unwrap().site_id, "repo-site");
}

#[test]
fn empty_explicit_identifiers_are_rejected_instead_of_falling_back() {
    let input = SiteSelectionInput {
        environment_site_id: Some(" ".into()),
        machine_default_site_id: Some("registry-site".into()),
        repository_default_site_id: "repo-site".into(),
    };

    assert!(select_site(input).unwrap_err().contains("environment"));
}
```

Also test `restart_required` by comparing effective and running IDs.

**Step 2: Run the tests to verify RED**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml machine_site_config -- --test-threads=1
```

Expected: FAIL because the module and selection types do not exist.

**Step 3: Implement the minimal pure model**

Define:

```rust
pub const SITE_ID_ENV: &str = "STEEL_SITE_CONFIG_ID";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SiteSelectionSource {
    Environment,
    Registry,
    Repository,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectiveSiteSelection {
    pub site_id: String,
    pub source: SiteSelectionSource,
}

pub trait MachineSiteStore: Send + Sync {
    fn read_default_site_id(&self) -> Result<Option<String>, String>;
    fn write_default_site_id(&self, id: &str) -> Result<(), String>;
    fn clear_default_site_id(&self) -> Result<(), String>;
    fn writable(&self) -> Result<bool, String>;
}
```

Keep selection pure: a present but empty environment or registry value is an
error. Validate IDs with the same identifier contract used by `SiteConfigStore`.

**Step 4: Run the tests to verify GREEN**

Run the Task 1 command and expect all `machine_site_config` tests to pass.

**Step 5: Commit**

```powershell
git add app/service/src/machine_site_config.rs app/service/src/main.rs
git commit -m "feat: add machine site selection model"
```

### Task 2: Implement Windows registry and host identity adapters

**Files:**
- Modify: `app/service/Cargo.toml`
- Modify: `app/service/Cargo.lock`
- Modify: `app/service/src/machine_site_config.rs`
- Test: `app/service/src/machine_site_config.rs`

**Step 1: Write failing adapter-contract tests**

Test a `MemoryMachineSiteStore` shared by all platforms:

```rust
#[test]
fn machine_store_write_read_and_clear_round_trip() {
    let store = MemoryMachineSiteStore::default();
    store.write_default_site_id("bkv-offline-lcx-ace").unwrap();
    assert_eq!(
        store.read_default_site_id().unwrap().as_deref(),
        Some("bkv-offline-lcx-ace")
    );
    store.clear_default_site_id().unwrap();
    assert_eq!(store.read_default_site_id().unwrap(), None);
}
```

Add host-name normalization tests:

```rust
#[test]
fn suggested_bkv_identity_uses_normalized_host_name() {
    assert_eq!(
        suggested_bkv_site("LCX_ACE"),
        ("bkv-offline-lcx-ace".into(), "BKV 离线 - LCX_ACE".into())
    );
}
```

**Step 2: Run and verify RED**

Run the Task 1 test command. Expected: FAIL for missing adapters and helper.

**Step 3: Implement adapters**

Add the `Win32_System_Registry` feature to `windows-sys`. Under `cfg(windows)`,
implement `WindowsMachineSiteStore` against:

```text
HKLM\SOFTWARE\SteelInspectionRuntime\Configuration
DefaultSiteConfigId (REG_SZ)
```

Use `KEY_READ` for status, `KEY_SET_VALUE` for mutation, UTF-16 conversion, and
close every opened key. Distinguish “key/value missing” from access and data
errors. After write/delete, read back and verify the result.

For non-Windows builds, provide `UnsupportedMachineSiteStore`: read returns
`None`, write/delete return a stable “machine registry unavailable” error.

Read the computer name with `GetComputerNameExW(ComputerNamePhysicalDnsHostname)`
on Windows. Use `HOSTNAME` only as the non-Windows/development fallback.

**Step 4: Run and verify GREEN**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml machine_site_config -- --test-threads=1
cargo check --manifest-path app/service/Cargo.toml
```

Expected: all tests and compilation pass.

**Step 5: Commit**

```powershell
git add app/service/Cargo.toml app/service/Cargo.lock app/service/src/machine_site_config.rs
git commit -m "feat: persist machine site default in registry"
```

### Task 3: Resolve the selected site during startup

**Files:**
- Modify: `app/service/src/site_config.rs`
- Modify: `app/service/src/runtime_profile.rs`
- Modify: `app/service/src/main.rs`
- Test: `app/service/src/site_config.rs`
- Test: `app/service/src/runtime_profile.rs`
- Test: `app/service/src/main.rs`

**Step 1: Write failing startup-resolution tests**

Create fixtures with `repo-site`, `registry-site`, and `env-site` directories.
Test:

```rust
#[test]
fn explicit_site_id_resolves_inside_the_project_site_root() {
    let resolved = resolve_site_by_id(
        &fixture.project,
        &fixture.root,
        "registry-site",
    ).unwrap();
    assert_eq!(resolved.site_id, "registry-site");
}

#[test]
fn explicit_missing_site_id_does_not_fall_back_to_project() {
    let error = resolve_site_by_id(
        &fixture.project,
        &fixture.root,
        "missing-site",
    ).unwrap_err();
    assert!(error.contains("missing-site"));
}
```

Add a startup test proving that the effective ID is loaded and its source is
retained in the public runtime value.

**Step 2: Run and verify RED**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml explicit_site_id -- --test-threads=1
```

Expected: FAIL because explicit site resolution does not exist.

**Step 3: Implement explicit resolution**

Add `resolve_site_by_id(project_path, allowed_root, id)` in `site_config.rs`.
It must:

- validate the ID;
- derive `config/sites/<id>/site.json` from the canonical project parent;
- enforce allowed-root containment;
- require directory ID and document ID equality;
- load no repository fallback after an explicit ID is present.

Add `RuntimeProfile::load_for_startup_selection` accepting the effective
selection. Keep the existing loader as a compatibility wrapper using the
repository selection.

In `main`, build the machine store, read `STEEL_SITE_CONFIG_ID`, compute the
selection, and load that exact site. Store immutable startup metadata in
`ServiceState`.

**Step 4: Run and verify GREEN**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml site_config -- --test-threads=1
cargo test --manifest-path app/service/Cargo.toml runtime_profile -- --test-threads=1
```

Expected: all site and runtime tests pass.

**Step 5: Commit**

```powershell
git add app/service/src/site_config.rs app/service/src/runtime_profile.rs app/service/src/main.rs
git commit -m "feat: load site selected for current machine"
```

### Task 4: Expose and mutate machine-default status through the admin API

**Files:**
- Modify: `app/service/src/main.rs`
- Test: `app/service/src/main.rs`

**Step 1: Write failing route and response tests**

Extend the admin-route fixture with:

```rust
("GET", "/api/admin/site-configs/machine-default"),
("PUT", "/api/admin/site-configs/machine-default"),
("DELETE", "/api/admin/site-configs/machine-default"),
```

Assert that all require `admin-config`. Add response tests for:

- environment, registry and repository values;
- running/effective IDs;
- `selectionSource`;
- `restartRequired`;
- writable/error state;
- environment override disabling mutation;
- unavailable target blocking a write;
- write/read-back and clear/read-back;
- audit actions `site-config.machine-default.set` and
  `site-config.machine-default.clear`.

**Step 2: Run and verify RED**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml machine_default -- --test-threads=1
```

Expected: FAIL because routes and handlers are missing.

**Step 3: Implement handlers**

Add:

```rust
#[derive(Deserialize)]
struct SetMachineDefaultRequest {
    id: String,
}
```

Return `steel.machine-site-selection.v1` with every field from the design.
Before writing, run the default site availability check. Reject an environment
override with HTTP 409 and `site_config_environment_override_active`.

Do not modify `config/project.json`. Compute `restartRequired` by comparing the
post-write effective ID with `state.runtime_config.site_id`.

Include the new routes in permission documentation and route tests.

**Step 4: Run and verify GREEN**

Run the Task 4 command and the complete `main` test subset. Expected: pass.

**Step 5: Commit**

```powershell
git add app/service/src/main.rs
git commit -m "feat: manage machine default site through admin API"
```

### Task 5: Make site packages fully self-contained

**Files:**
- Modify: `app/service/src/site_config.rs`
- Modify: `app/service/src/runtime_profile.rs`
- Modify: `config/sites/bkv-default/site.json`
- Modify: `config/sites/bkv-default/runtime.json`
- Modify: `config/sites/bkv-default/connection.json`
- Modify: `config/sites/bkv-default/capture.json`
- Create: `config/sites/bkv-default/algorithm.json`
- Create: `config/sites/bkv-default/mapping.json`
- Test: `app/service/src/site_config.rs`
- Test: `app/service/src/runtime_profile.rs`

**Step 1: Write failing package-isolation tests**

Test that new BKV and direct sites create all six standard files. Test that
runtime, algorithm, mapping, connection, and capture references cannot escape
the site root:

```rust
#[test]
fn created_bkv_package_is_complete_and_self_contained() {
    let package = fixture.store.create(CreateSiteConfig {
        id: "bkv-offline-host".into(),
        display_name: "BKV 离线 - HOST".into(),
        mode: SiteMode::Bkv,
    }).unwrap();

    for name in [
        "site.json",
        "runtime.json",
        "connection.json",
        "capture.json",
        "algorithm.json",
        "mapping.json",
    ] {
        assert!(package.root.join(name).is_file(), "{name}");
    }
}

#[test]
fn package_rejects_an_algorithm_reference_outside_its_directory() {
    // Write "../shared/algorithm.json" and expect a blocking isolation check.
}
```

Add a clone test that edits the source after cloning and proves the clone files
do not change.

**Step 2: Run and verify RED**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml self_contained -- --test-threads=1
cargo test --manifest-path app/service/Cargo.toml package_rejects -- --test-threads=1
```

Expected: FAIL because the standard files and isolation checks are incomplete.

**Step 3: Implement the package manifest and templates**

Extend `SiteConfigDocument` with:

```rust
pub algorithm_config: String,
pub mapping_config: String,
```

Create mode-specific JSON templates for all standard files. BKV `capture.json`
must explicitly disable acquisition. Store plaintext connection fields in
`connection.json`; do not include password values in summaries or audits.

For site packages, resolve algorithm and mapping references relative to the
site root. Keep legacy `activeRuntimeProfile` resolution relative to the
allowed workspace root only for compatibility mode.

Update the checked-in `bkv-default` package so no runtime configuration-file
reference leaves `config/sites/bkv-default`.

**Step 4: Run and verify GREEN**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml site_config -- --test-threads=1
cargo test --manifest-path app/service/Cargo.toml runtime_profile -- --test-threads=1
```

Expected: all tests pass and the checked-in package loads as BKV six-camera.

**Step 5: Commit**

```powershell
git add app/service/src/site_config.rs app/service/src/runtime_profile.rs config/sites/bkv-default
git commit -m "feat: isolate every site configuration package"
```

### Task 6: Add safe ZIP import and export

**Files:**
- Modify: `app/service/Cargo.toml`
- Modify: `app/service/Cargo.lock`
- Modify: `app/service/src/site_config.rs`
- Modify: `app/service/src/main.rs`
- Test: `app/service/src/site_config.rs`
- Test: `app/service/src/main.rs`

**Step 1: Write failing archive tests**

Add tests that:

- export all standard files including the plaintext password in
  `connection.json`;
- never include a file outside the package;
- import a valid archive;
- reject `../escape`, absolute paths, duplicate entries, symlinks, reparse
  metadata, unexpected top-level directories, ID mismatch, excessive file
  count/size, and an existing destination ID;
- remove the temporary directory after failure;
- produce audit details with no password value.

Use a ZIP fixture generated entirely in memory.

**Step 2: Run and verify RED**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml site_archive -- --test-threads=1
```

Expected: FAIL because archive methods do not exist.

**Step 3: Implement bounded archive support**

Add `zip` with only required deflate support. Implement:

```rust
pub fn export_archive(&self, id: &str) -> Result<Vec<u8>, String>;
pub fn import_archive(&self, bytes: &[u8]) -> Result<SiteConfigPackage, String>;
```

Set explicit limits for compressed bytes, uncompressed bytes, entry count and
path length. Extract into `.site-import-<stamp>.tmp` under the site root, call
the same package checker used by activation, then atomically rename.

Extend the HTTP request parser to preserve binary bodies. Add:

- `POST /api/admin/site-configs/import` with `application/zip`;
- `GET /api/admin/site-configs/export?id=<id>` with ZIP attachment headers.

Both routes require `admin-config` and audit the operation without file content
or credentials.

**Step 4: Run and verify GREEN**

Run:

```powershell
cargo test --manifest-path app/service/Cargo.toml site_archive -- --test-threads=1
cargo test --manifest-path app/service/Cargo.toml site_config_export -- --test-threads=1
```

Expected: pass.

**Step 5: Commit**

```powershell
git add app/service/Cargo.toml app/service/Cargo.lock app/service/src/site_config.rs app/service/src/main.rs
git commit -m "feat: import and export isolated site packages"
```

### Task 7: Add client API support

**Files:**
- Modify: `app/client/src/services/site-config-api.ts`
- Modify: `app/client/src/services/site-config-api.test.ts`

**Step 1: Write failing API tests**

Test exact methods, paths and payloads for machine status, set, clear, import
and export. Verify export creates a Blob without JSON parsing and import sends
`application/zip`.

**Step 2: Run and verify RED**

Run:

```powershell
npm --prefix app/client test -- --run src/services/site-config-api.test.ts
```

Expected: FAIL because the functions do not exist.

**Step 3: Implement typed API functions**

Add `MachineSiteSelection` and:

```ts
fetchMachineSiteSelection()
setMachineDefaultSite(id)
clearMachineDefaultSite()
importSiteConfig(file)
exportSiteConfig(id)
```

Keep admin headers, error parsing and abort behavior consistent with existing
requests.

**Step 4: Run and verify GREEN**

Run the Task 7 command. Expected: pass.

**Step 5: Commit**

```powershell
git add app/client/src/services/site-config-api.ts app/client/src/services/site-config-api.test.ts
git commit -m "feat: add machine site configuration client API"
```

### Task 8: Update the global-configuration interface

**Files:**
- Modify: `app/client/src/components/GlobalConfigurationPanel.tsx`
- Modify: `app/client/src/components/GlobalConfigurationPanel.test.tsx`
- Modify: `app/client/src/styles.css`
- Test: `app/client/src/components/GlobalConfigurationPanel.test.tsx`

**Step 1: Write failing UI tests**

Add tests for:

- computer name and repository/registry/running badges;
- default BKV new-site values derived from `LCX_ACE`;
- environment override disabling set/clear controls;
- registry-not-writable explanation;
- setting and clearing the machine default;
- restart-required message;
- import file picker and credential confirmation;
- ZIP export and credential warning;
- mode remains immutable.

Use accessible role/name queries instead of CSS selectors.

**Step 2: Run and verify RED**

Run:

```powershell
npm --prefix app/client test -- --run src/components/GlobalConfigurationPanel.test.tsx
```

Expected: FAIL for missing status and actions.

**Step 3: Implement the UI**

Load machine selection with the catalog. Add a “当前电脑” block in the right
detail pane. Show separate badges for:

- 仓库默认
- 当前电脑默认
- 当前运行
- 环境变量覆盖
- 重启后生效

Replace the current repository activation action in normal UI with
“设为当前电脑默认”. Retain repository activation only as a clearly labelled
compatibility/admin operation if existing API compatibility requires it.

When creating a BKV site, initialize the draft from the API-provided computer
name. Use a hidden file input for import and a browser download for export.
Require confirmation text that the ZIP contains plaintext connection
credentials.

Keep list and detail panes independently scrollable at 1366×768.

**Step 4: Run and verify GREEN**

Run:

```powershell
npm --prefix app/client test -- --run src/components/GlobalConfigurationPanel.test.tsx
npm --prefix app/client test -- --run src/styles/global-configuration-layout.test.js
```

Expected: pass.

**Step 5: Commit**

```powershell
git add app/client/src/components/GlobalConfigurationPanel.tsx app/client/src/components/GlobalConfigurationPanel.test.tsx app/client/src/styles.css
git commit -m "feat: manage current computer default site"
```

### Task 9: Provision the machine registry key during installation

**Files:**
- Modify: `scripts/install-runtime-service.ps1`
- Modify: `scripts/uninstall-runtime-service.ps1`
- Create: `scripts/test-machine-site-registry.ps1`
- Modify: the applicable installer static/transaction test under `scripts/test-*.ps1`
- Test: `scripts/test-machine-site-registry.ps1`

**Step 1: Write the failing PowerShell contract test**

The test must verify that the installer:

- creates the exact HKLM configuration key;
- grants only Administrators, SYSTEM and the configured service identity the
  required access;
- preserves `DefaultSiteConfigId` during upgrade;
- preserves it during normal uninstall;
- removes it only under the existing explicit purge confirmation boundary.

The live registry test must default to dry-run and require an exact mutation
phrase plus a temporary subkey.

**Step 2: Run and verify RED**

Run the applicable static test and:

```powershell
pwsh -NoProfile -File scripts/test-machine-site-registry.ps1
```

Expected: static test FAIL before installer support; live test reports dry-run.

**Step 3: Implement installer and uninstaller policy**

Create the configuration key transactionally with the existing deployment
journal. Add registry state to rollback evidence. Never overwrite an existing
`DefaultSiteConfigId` during installation or upgrade.

Normal uninstall preserves the machine selection. Purge removes it only after
the existing protected-root and exact-confirmation gates pass.

**Step 4: Run and verify GREEN**

Run the static deployment, uninstall-policy, PowerShell AST and dry-run
registry tests. Expected: pass.

**Step 5: Commit**

```powershell
git add scripts/install-runtime-service.ps1 scripts/uninstall-runtime-service.ps1 scripts/test-machine-site-registry.ps1 scripts/test-*.ps1
git commit -m "feat: provision machine site registry state"
```

### Task 10: Document and verify the complete workflow

**Files:**
- Modify: `README.md`
- Modify: `config/env/README.md`
- Modify: `docs/release-deployment-and-operations.md`
- Modify: `docs/capture-api-contract.md`

**Step 1: Update documentation**

Document:

- the three-level precedence;
- exact registry key/value;
- environment override behavior;
- startup failure semantics;
- self-contained package layout;
- plaintext credential inclusion;
- setting/clearing through 全局配置;
- restart requirement;
- import/export warnings and audit.

Remove outdated instructions that tell operators to switch site configuration
by editing `project.json` directly.

**Step 2: Run full Rust verification**

Run:

```powershell
cargo fmt --manifest-path app/service/Cargo.toml -- --check
cargo test --manifest-path app/service/Cargo.toml -- --test-threads=1
```

Expected: formatting clean and all Rust tests pass.

**Step 3: Run full client verification**

Run:

```powershell
npm --prefix app/client test -- --run
npm --prefix app/client run build
```

Expected: all Vitest tests pass and the production bundle builds.

**Step 4: Run API acceptance**

Start the service with a temporary project/config root. Verify:

1. repository fallback is selected without registry or environment override;
2. setting a machine default reports restart required without changing the
   running ID or temporary `project.json`;
3. restart loads the registry ID;
4. environment ID wins over the registry ID;
5. clearing the registry returns to repository fallback after restart;
6. invalid explicit IDs fail startup;
7. import/export round-trip preserves all files and credentials;
8. audit contains set/clear/import/export actions but no password.

Use an injected temporary machine store for automated API acceptance. Do not
write the production HKLM value.

**Step 5: Run browser acceptance**

Using the in-app browser, verify the global configuration page at 1787×1272
and 1366×768:

- badges and computer name are visible;
- environment override disables mutation;
- set/clear shows restart messaging;
- import/export warnings are explicit;
- list/detail scrolling remains usable;
- BKV mode still hides direct-camera, capture and reconstruction modules.

**Step 6: Verify Git scope and commit**

Run:

```powershell
git diff --check
git status --short
```

Do not stage `image_copy/`, `tmp/`, or `tmp_bkv_extract_test/`.

Commit:

```powershell
git add README.md config/env/README.md docs/release-deployment-and-operations.md docs/capture-api-contract.md
git commit -m "docs: explain machine-local site configuration"
```

**Step 7: Final evidence**

Record exact Rust test count, frontend test count, build result, API acceptance
result, browser resolutions, commit hashes, active branch and untracked
user-data directories. Do not push unless the user asks.
