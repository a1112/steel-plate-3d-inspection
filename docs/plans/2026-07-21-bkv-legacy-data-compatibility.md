# BKV Legacy Data Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Safely migrate only legacy SeqNo 1893700-1893710, attempt evidence-based `.d3img` decoding, and add an explicit six-camera BKV offline replay mode without weakening real eight-camera production gates.

**Architecture:** A Python staging tool treats the ZIP/RAR inputs as untrusted, emits a content-addressed batch manifest beneath a configured BKV root, and never writes the service database. The Rust service validates and transactionally imports that manifest with deterministic IDs into existing tables, stores provenance in existing JSON/config fields, and exposes BKV replay as a distinct in-process capture provider. The React client renders BKV as offline six-channel data, never as physical-camera or simulated success.

**Tech Stack:** Python 3 standard library plus the existing Pillow/NumPy runtime, WinRAR/UnRAR CLI, Rust/SeaORM/Serde, React/TypeScript/Vitest.

---

Implementation must use @superpowers:test-driven-development for every behavior change, @superpowers:systematic-debugging for any unexpected archive/build result, and @superpowers:verification-before-completion before completion claims. Because D: is full, set `CARGO_TARGET_DIR=E:\Temp\codex\steel-bkv-target` for Rust builds and tests; do not share the live repository PDB directory.

### Task 1: Build a fail-closed archive inventory and path boundary

**Files:**
- Create: `scripts/bkv_legacy_import.py`
- Create: `scripts/test_bkv_legacy_import.py`
- Modify: `scripts/README.md`

**Step 1: Write the failing inventory tests**

Add tests that create a temporary ZIP plus mocked UnRAR listing and assert:

```python
TARGET_SEQ_NOS = tuple(range(1_893_700, 1_893_711))

assert normalize_member("image_copy/CamImageSource1/1893700/2D/a.jpg")
assert not normalize_member("../escape.jpg")
assert not wanted_image_member("image_copy/CamImageSource1/1893699/2D/a.jpg")
assert wanted_image_member("image_copy/CamImageSource6/1893710/3D/a.d3img")
```

Also require SHA-256, size, archive part, member path, camera number, SeqNo, kind, extension, and integrity status in every manifest entry.

**Step 2: Run the test to verify it fails**

Run: `python scripts/test_bkv_legacy_import.py`

Expected: FAIL because `bkv_legacy_import.py` does not exist.

**Step 3: Implement the minimal inventory CLI**

Implement subcommand `inventory` with required arguments `--database-zip`, `--image-part1`, `--image-part2`, `--output-root`, and `--batch-id`. Resolve every input/output path, reject overlap with an input archive, reject traversal/absolute/reparse output members, locate `UnRAR.exe` explicitly, and write `manifest.inventory.json` atomically.

Use one canonical predicate:

```python
def wanted_seq_no(value: int) -> bool:
    return value in TARGET_SEQ_NOS
```

Do not extract yet. Record the ZIP CRC failure as evidence instead of converting partial reads into an `ok` status.

**Step 4: Run the tests and inventory help**

Run: `python scripts/test_bkv_legacy_import.py`

Expected: PASS.

Run: `python scripts/bkv_legacy_import.py inventory --help`

Expected: exit 0 and list all five required path/batch arguments.

**Step 5: Commit**

```powershell
git add scripts/bkv_legacy_import.py scripts/test_bkv_legacy_import.py scripts/README.md
git commit -m "feat: inventory BKV legacy archives safely"
```

### Task 2: Stream and filter the legacy SQL dump

**Files:**
- Modify: `scripts/bkv_legacy_import.py`
- Modify: `scripts/test_bkv_legacy_import.py`

**Step 1: Add failing SQL parser tests**

Use a small fixture string containing MySQL `CREATE TABLE`, escaped strings, `NULL`, multi-row `INSERT`, target/non-target SeqNo, malformed rows, and a simulated CRC exception. Assert that only the target set survives and that corruption remains visible:

```python
result = filter_sql_dump(io.BytesIO(fixture), TARGET_SEQ_NOS)
assert set(result.rows_by_seq) == {1_893_700, 1_893_710}
assert result.integrity == "partial-crc-error"
assert result.rejected_rows[0]["reason"] == "malformed_insert"
```

Cover `allexcel`, `checkrecord`, `defect`, `defectclass`, and `diameter`. The parser must learn column order from each `CREATE TABLE`; it must not rely on guessed offsets.

**Step 2: Run the focused test and verify failure**

Run: `python scripts/test_bkv_legacy_import.py SqlDumpTests`

Expected: FAIL because `filter_sql_dump` is absent.

**Step 3: Implement bounded streaming extraction**

Read `database.sql` through `zipfile.ZipFile.open`, parse statements incrementally without loading the dump into memory, and emit normalized JSONL by table. Enforce maximum statement/field lengths, target SeqNo allowlisting, finite numeric values, non-negative physical dimensions, stable original-row hash, and per-table accepted/rejected counts.

For `diameter`, accept a row only when its schema-derived SeqNo/foreign key proves association to the target set. If the CRC error occurs before all target relationships are proven, set `diameterComplete=false`; never backfill zeroes.

**Step 4: Run tests**

Run: `python scripts/test_bkv_legacy_import.py SqlDumpTests`

Expected: PASS, including CRC and malformed-row cases.

**Step 5: Commit**

```powershell
git add scripts/bkv_legacy_import.py scripts/test_bkv_legacy_import.py
git commit -m "feat: filter target BKV SQL records"
```

### Task 3: Extract selected RAR members and produce an immutable batch

**Files:**
- Modify: `scripts/bkv_legacy_import.py`
- Modify: `scripts/test_bkv_legacy_import.py`

**Step 1: Add failing extraction tests**

Mock UnRAR process output and assert extraction uses an explicit member allowlist, refuses overwrite, hashes files after extraction, detects a changed file, and publishes the batch only after validation. The expected layout is:

```text
<output-root>/<batch-id>/
  manifest.json
  source/inventory.json
  normalized/{allexcel,checkrecord,defect,defectclass,diameter}.jsonl
  artifacts/camera-1..camera-6/<seq-no>/{2d,3d,metadata}/...
  quarantine.jsonl
```

**Step 2: Run the focused test and verify failure**

Run: `python scripts/test_bkv_legacy_import.py ExtractionTests`

Expected: FAIL because `stage` is absent.

**Step 3: Implement `stage`**

Extract into `<batch-id>.incoming-*`, validate every resolved path remains inside that directory, then atomically rename to `<batch-id>`. The final `steel.bkv-import-manifest.v1` must include source archive hashes, exact SeqNo list, six camera inventories, database integrity flags, accepted/rejected counts, every artifact hash, and `status=ready|partial|failed`.

Only `ready` and operator-reviewed `partial` batches may be imported. A second identical run returns the existing batch after re-verifying hashes; a changed batch ID collision fails.

**Step 4: Run tests**

Run: `python scripts/test_bkv_legacy_import.py ExtractionTests`

Expected: PASS.

**Step 5: Commit**

```powershell
git add scripts/bkv_legacy_import.py scripts/test_bkv_legacy_import.py
git commit -m "feat: stage immutable BKV migration batches"
```

### Task 4: Probe and decode `.d3img` without format guessing

**Files:**
- Create: `scripts/bkv_d3img.py`
- Create: `scripts/test_bkv_d3img.py`
- Create: `docs/bkv-d3img-format-evidence.md`
- Modify: `scripts/bkv_legacy_import.py`

**Step 1: Add failing detector and bounds tests**

Test truncated headers, absurd dimensions, multiplication overflow, unsupported magic/version, NaN/Inf statistics, and a synthetic valid file built only after the real header contract is documented. The API must distinguish detection from decoding:

```python
probe = probe_d3img(path)
assert probe.schema == "steel.bkv-d3img-probe.v1"
decoded = decode_d3img(path, evidence_contract)
assert decoded.depth.dtype == np.uint16
assert decoded.valid_count > 0
```

**Step 2: Run the detector test and verify failure**

Run: `python scripts/test_bkv_d3img.py`

Expected: FAIL because the module does not exist.

**Step 3: Collect real format evidence before writing a decoder**

Run the staging tool against one selected `.d3img`, then record file hashes, repeated header bytes, size groupings, candidate dimensions/data types, related `.dat` fields, and results of searching Capture 6.7 headers for a documented offline reader. Write only verified facts to `docs/bkv-d3img-format-evidence.md`.

Hard gate: if no documented SDK reader or repeatable binary layout proves header/data boundaries, implement probe-only `unsupported_format` output and stop custom decoding. Do not infer coordinates from a visually plausible image.

**Step 4: Implement the evidenced adapter**

When the evidence gate passes, decode with exact magic/version/offset checks, clamp neither invalid source values nor dimensions, and emit:

- lossless 16-bit depth PNG for the existing reconstruction reader;
- `steel.bkv-depth-metadata.v1` JSON with original hash, parser version, dimensions, data type, byte order, valid/invalid counts, min/max/percentiles, and `coordinateFrame=raw-camera` unless `.dat` semantics are proven;
- a bounded preview PNG for review.

The migration manifest records `decoded`, `unsupported`, or `invalid` per file.

**Step 5: Run tests and inspect one real conversion**

Run: `python scripts/test_bkv_d3img.py`

Expected: PASS.

Run: `python scripts/bkv_d3img.py probe --input <staged-sample.d3img> --json <probe.json>`

Expected: exit 0 with a structured probe, or exit 2 with a stable unsupported/invalid reason; never an unhandled exception.

**Step 6: Commit**

```powershell
git add scripts/bkv_d3img.py scripts/test_bkv_d3img.py scripts/bkv_legacy_import.py docs/bkv-d3img-format-evidence.md
git commit -m "feat: probe and decode evidenced BKV depth data"
```

### Task 5: Validate and transactionally import a BKV manifest

**Files:**
- Modify: `app/service/src/db/mod.rs`
- Modify: `app/service/src/main.rs`
- Modify: `app/service/src/production_tasks.rs`

**Step 1: Write failing Rust tests**

Add tests proving root-bound canonical paths, manifest schema/hash verification, exact target SeqNo set, deterministic IDs, idempotent re-import, rollback on one invalid row, and rejection of `failed` or unreviewed `partial` batches.

Use existing tables only:

- `steel_plate`, `inspection_record`, `material_session`, and `production_inspection` for imported history;
- `capture_file` for 2D/depth/metadata artifacts;
- `production_defect` for normalized defects;
- `app_config` keys `bkv.batch.<batch-id>`, `bkv.replay.<batch-id>`, and `bkv.active-batch` for manifest/replay state.

Put legacy table/key/hash/source provenance in `production_inspection.raw_payload`, `production_defect.geometry_json`, and per-artifact metadata JSON. Generate target IDs from `SHA-256(batch-id|kind|legacy-table|legacy-id|source-path)` so retries are stable.

**Step 2: Run the focused tests and verify failure**

Run: `$env:CARGO_TARGET_DIR='E:\Temp\codex\steel-bkv-target'; cargo test bkv_import --manifest-path app/service/Cargo.toml`

Expected: FAIL because BKV import functions/routes are absent.

**Step 3: Implement import functions and admin routes**

Add:

```text
GET  /api/bkv/status
POST /api/bkv/import
POST /api/bkv/replay/reset
```

Require `admin.services` for mutations. Read manifests only below canonical `STEEL_BKV_DATA_ROOT`; cap JSON/JSONL size and row count; verify every referenced file hash immediately before the DB transaction. Persist the whole logical import atomically, audit actor/batch/counts, and return stable machine-readable rejection codes.

Do not add an untracked schema version: provenance and replay state intentionally use current JSON/config fields.

**Step 4: Run tests**

Run: `$env:CARGO_TARGET_DIR='E:\Temp\codex\steel-bkv-target'; cargo test bkv_import --manifest-path app/service/Cargo.toml`

Expected: PASS.

**Step 5: Commit**

```powershell
git add app/service/src/db/mod.rs app/service/src/main.rs app/service/src/production_tasks.rs
git commit -m "feat: import BKV batches transactionally"
```

### Task 6: Add the explicit BKV replay provider and health contract

**Files:**
- Modify: `app/service/src/main.rs`
- Modify: `app/service/src/production_tasks.rs`
- Modify: `docs/capture-api-contract.md`

**Step 1: Write failing provider tests**

Add tests for `CaptureProvider::from_env_value("bkv")`, `as_str() == "bkv"`, no managed child/API probe, six offline channels, no SDK requirement, valid batch/root health, missing/tampered artifact failure, ordered 11-item advancement, completed state, reset, and unchanged real-provider eight-camera behavior.

Assert BKV `capture-once` returns provider-shaped evidence with `source=bkv`, `offline=true`, `cameraCount=6`, exact artifact paths/hashes, and selected `legacySeqNo`.

**Step 2: Run tests and verify failure**

Run: `$env:CARGO_TARGET_DIR='E:\Temp\codex\steel-bkv-target'; cargo test bkv_ --manifest-path app/service/Cargo.toml`

Expected: FAIL because provider/replay branches do not exist.

**Step 3: Implement BKV runtime behavior**

Add `CaptureProvider::Bkv`. In `capture_health_component`, validate the active batch and report `status=bkv-offline`, `sdkRequired=false`, `sdkReady=null`, and six manifest channels. In `storage_health_component`, validate the BKV root without pretending the capture writer queue exists.

Branch `write_production_capture_once_response` before physical-provider dispatch. Under the existing production command lock, load and compare replay version, select the next SeqNo, verify artifacts, atomically update `bkv.replay.<batch-id>`, and return the imported inspection/capture/defect result. When index 11 is consumed, set `status=completed`; the next call returns 409 `bkv_replay_completed` until reset.

Make `build_production_snapshot_json` and the production status response prefer the selected imported inspection only when provider is BKV. Do not alter non-BKV query ordering.

**Step 4: Run focused and regression tests**

Run: `$env:CARGO_TARGET_DIR='E:\Temp\codex\steel-bkv-target'; cargo test bkv_ --manifest-path app/service/Cargo.toml`

Expected: PASS.

Run: `$env:CARGO_TARGET_DIR='E:\Temp\codex\steel-bkv-target'; cargo test readiness_ --manifest-path app/service/Cargo.toml`

Expected: PASS, including real/simulated readiness tests.

**Step 5: Commit**

```powershell
git add app/service/src/main.rs app/service/src/production_tasks.rs docs/capture-api-contract.md
git commit -m "feat: add BKV offline replay provider"
```

### Task 7: Expose BKV state and artifacts safely to the client

**Files:**
- Modify: `app/client/src/services/inspection-api.ts`
- Modify: `app/client/src/services/inspection-api.production.test.ts`
- Modify: `app/client/src/lib/capture-api.ts`
- Modify: `app/service/src/main.rs`

**Step 1: Add failing API contract tests**

Test typed `provider: 'bkv'`, batch/replay fields, `legacySeqNo`, source badges, six offline channel statuses, and root-bound file URLs. Add Rust tests that a BKV artifact beneath the configured root is readable through the existing authenticated file route while traversal, symlink/reparse escape, hash mismatch, and non-active roots are rejected.

**Step 2: Run tests and verify failure**

Run: `npm test -- src/services/inspection-api.production.test.ts src/lib/capture-api.test.ts`

Expected: FAIL on missing BKV fields.

**Step 3: Implement typed client/service responses**

Extend response types without weakening existing physical camera types. The service should return relative artifact references plus authenticated service URLs, not raw unrestricted local paths. Include decode status and diagnostic reason for each `.d3img` artifact.

**Step 4: Run tests**

Run: `npm test -- src/services/inspection-api.production.test.ts src/lib/capture-api.test.ts`

Expected: PASS.

**Step 5: Commit**

```powershell
git add app/client/src/services/inspection-api.ts app/client/src/services/inspection-api.production.test.ts app/client/src/lib/capture-api.ts app/service/src/main.rs
git commit -m "feat: expose BKV replay data safely"
```

### Task 8: Render BKV as six-channel offline replay in the UI

**Files:**
- Modify: `app/client/src/App.tsx`
- Modify: `app/client/src/App.test.tsx`
- Modify: `app/client/src/components/BrandHeader.tsx`
- Modify: `app/client/src/components/BrandHeader.test.tsx`
- Modify: `app/client/src/components/SystemStatusPage.tsx`
- Modify: `app/client/src/components/SystemStatusPage.test.tsx`
- Modify: `app/client/src/components/BarSurfaceApp.tsx`
- Modify: `app/client/src/services/bar-surface-api.ts`

**Step 1: Add failing UI tests**

Assert:

- header shows `BKV 离线回放` and `离线数据 6/6`;
- no BKV channel is labelled physical “在线”;
- system status displays batch, current SeqNo, progress `n/11`, completed state, missing channels, and decode diagnostics;
- connect/calibration/device-write controls are disabled in BKV mode;
- a decoded depth/mesh loads from the selected inspection;
- unsupported `.d3img` shows `旧格式暂不可预览` with no demo/point-cloud fallback.

**Step 2: Run the focused tests and verify failure**

Run: `npm test -- src/App.test.tsx src/components/BrandHeader.test.tsx src/components/SystemStatusPage.test.tsx`

Expected: FAIL because BKV rendering is absent.

**Step 3: Implement minimal BKV presentation**

Treat `bkv-offline` as service-reachable but not SDK-ready. Add the explicit banner/status badge, six channel cards, replay/reset status, provenance badge, and decode error state. Keep real/simulated branches unchanged. Never use bundled demo surface when a BKV inspection lacks a decoded artifact.

**Step 4: Run focused tests and build**

Run: `npm test -- src/App.test.tsx src/components/BrandHeader.test.tsx src/components/SystemStatusPage.test.tsx`

Expected: PASS.

Run: `npm run build`

Expected: TypeScript and Vite build exit 0.

**Step 5: Commit**

```powershell
git add app/client/src/App.tsx app/client/src/App.test.tsx app/client/src/components/BrandHeader.tsx app/client/src/components/BrandHeader.test.tsx app/client/src/components/SystemStatusPage.tsx app/client/src/components/SystemStatusPage.test.tsx app/client/src/components/BarSurfaceApp.tsx app/client/src/services/bar-surface-api.ts
git commit -m "feat: show BKV offline replay mode"
```

### Task 9: Add launch configuration and end-to-end compatibility coverage

**Files:**
- Create: `config/env/bkv.env.example`
- Create: `scripts/test-bkv-compatibility.ps1`
- Modify: `scripts/run-service.ps1`
- Modify: `scripts/README.md`
- Modify: `docs/capture-api-contract.md`

**Step 1: Write the failing PowerShell contract test**

The test must start the service with `STEEL_CAPTURE_PROVIDER=bkv`, no capture service on port 4317, a temporary SQLite DB, and a synthetic 11-item manifest. Assert health ready, provider BKV, six offline channels, ordered capture responses, completion conflict, reset, and real-provider configuration still expecting eight cameras.

**Step 2: Run and verify failure**

Run: `powershell -ExecutionPolicy Bypass -File scripts/test-bkv-compatibility.ps1`

Expected: FAIL because launcher/config support is absent.

**Step 3: Implement launcher and documentation**

Add `bkv` to validated provider choices, require an absolute `STEEL_BKV_DATA_ROOT`, and document that this is a compatibility/development runtime, not production camera acceptance. Keep credentials out of the example env file.

**Step 4: Run the compatibility test**

Run: `powershell -ExecutionPolicy Bypass -File scripts/test-bkv-compatibility.ps1`

Expected: PASS with no process listening on the capture-provider port.

**Step 5: Commit**

```powershell
git add config/env/bkv.env.example scripts/test-bkv-compatibility.ps1 scripts/run-service.ps1 scripts/README.md docs/capture-api-contract.md
git commit -m "test: cover BKV no-camera compatibility mode"
```

### Task 10: Migrate the supplied batch and perform final verification

**Files:**
- Create outside Git: `E:\SteelInspectionBkv\legacy-20260721\...`
- Modify only if evidence changes: `docs/bkv-d3img-format-evidence.md`

**Step 1: Preflight source hashes and destination capacity**

Run:

```powershell
Get-FileHash 'C:\Users\10428\xwechat_files\wxid_3wwbo9wfmfw522_af7a\msg\file\2026-07\database.zip' -Algorithm SHA256
Get-FileHash 'C:\Users\10428\xwechat_files\wxid_3wwbo9wfmfw522_af7a\msg\file\2026-07\image_copy.part1.rar' -Algorithm SHA256
Get-FileHash 'C:\Users\10428\xwechat_files\wxid_3wwbo9wfmfw522_af7a\msg\file\2026-07\image_copy.part2.rar' -Algorithm SHA256
Get-PSDrive E
```

Expected: all files hash successfully and destination free space exceeds archive size plus a conservative 2x extraction margin. Otherwise stop before extraction.

**Step 2: Stage the real batch**

Run:

```powershell
python scripts/bkv_legacy_import.py stage `
  --database-zip 'C:\Users\10428\xwechat_files\wxid_3wwbo9wfmfw522_af7a\msg\file\2026-07\database.zip' `
  --image-part1 'C:\Users\10428\xwechat_files\wxid_3wwbo9wfmfw522_af7a\msg\file\2026-07\image_copy.part1.rar' `
  --image-part2 'C:\Users\10428\xwechat_files\wxid_3wwbo9wfmfw522_af7a\msg\file\2026-07\image_copy.part2.rar' `
  --output-root 'E:\SteelInspectionBkv' `
  --batch-id 'legacy-20260721'
```

Expected: manifest contains exactly SeqNo 1893700-1893710, cameras 1-6, explicit ZIP CRC status, and no out-of-range accepted rows.

**Step 3: Review quarantine and 3D evidence**

Inspect accepted/rejected counts, missing channel/file matrix, database completeness flags, and at least one preview from each successfully decoded `.d3img` size/version group. Compare the preview with its paired `.jpg`; record only observations, not inferred calibration.

**Step 4: Import and replay against a disposable database first**

Start the BKV service with a temporary SQLite DB, import the manifest through the authenticated admin endpoint, replay all 11 items, reset, and replay the first item. Compare defects and counts to normalized source rows before adopting the batch into the current service DB.

Expected: idempotent second import, ordered replay, no camera process, no silent missing/invalid values, and stable provenance.

**Step 5: Run the full regression suite**

Run:

```powershell
python scripts/test_bkv_legacy_import.py
python scripts/test_bkv_d3img.py
npm test --prefix app/client
npm run build --prefix app/client
$env:CARGO_TARGET_DIR='E:\Temp\codex\steel-bkv-target'
cargo test --manifest-path app/service/Cargo.toml
cargo test --manifest-path app/trigger/Cargo.toml
powershell -ExecutionPolicy Bypass -File scripts/test-bkv-compatibility.ps1
git diff --check
git status --short
```

Expected: all commands pass; only intentional source/doc changes are present; generated batch data remains outside Git.

**Step 6: Commit evidence documentation if it changed**

```powershell
git add docs/bkv-d3img-format-evidence.md
git commit -m "docs: record BKV depth format evidence"
```
