# Formal BKV Offline Replay Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a first-class `bkv` capture provider that boots without camera hardware, serves the validated 11-material legacy batch, replays it once in order, and presents clearly isolated 2D/unwrapped/3D legacy data in the desktop UI.

**Architecture:** A deterministic Python batch builder combines the filtered legacy CSV evidence, converted NPZ manifest, six-camera JPEG inventory, and per-material preview artifacts into one `bkv-runtime-v1` manifest. The Rust service owns manifest validation, a persisted replay cursor, whitelisted artifact serving, BKV-aware health and capture-once behavior. React detects the provider through `/api/bkv/status` and renders a dedicated compatibility workspace; real and simulated provider behavior remains unchanged.

**Tech Stack:** Python 3/NumPy/Pillow/unittest, Rust/serde_json/cargo test, React/TypeScript/Vitest/Three.js

---

### Task 1: Build the authoritative BKV runtime batch

**Files:**
- Create: `scripts/build_bkv_runtime_manifest.py`
- Create: `scripts/test_bkv_runtime_manifest.py`
- Modify: `scripts/README.md`

**Steps:**
1. Write failing tests using synthetic `checkrecord`, `defect`, `defectclass`, image, NPZ, and preview fixtures.
2. Prove the test fails because the builder is absent.
3. Implement strict range selection, `checkrecord.ID` material identity, `defect.SeqNo -> checkrecord.SeqNo` association, category mapping, invalid-size nulling, six-camera inventory, source hashes, quarantine records, and atomic manifest output.
4. Prove idempotence and rejection of missing cameras, missing preview artifacts, duplicate identities, path escapes, and mismatched NPZ coverage.
5. Generate all missing sequence previews and the real `tmp/legacy-bkv/bkv-runtime-manifest.json`.

### Task 2: Add the Rust BKV domain and provider

**Files:**
- Create: `app/service/src/bkv.rs`
- Modify: `app/service/src/main.rs`

**Steps:**
1. Write failing Rust tests for `CaptureProvider::Bkv`, manifest loading, exact 11-material validation, whitelisted artifact resolution, status output, cursor next/completed/reset semantics, and durable cursor reload.
2. Implement `BkvManager` with canonical-root containment, manifest/schema checks, hash/size verification, atomic cursor persistence, and JSON response helpers.
3. Add `CaptureProvider::Bkv`; mark it embedded/unmanaged/no-local-capture-API so no SDK process or endpoint probe is attempted.
4. Add authenticated routes: `GET /api/bkv/status`, `GET /api/bkv/materials`, `GET /api/bkv/material`, `GET /api/bkv/file`, `POST /api/bkv/replay/next`, and `POST /api/bkv/replay/reset`.
5. Include BKV readiness in service health without claiming physical cameras online.

### Task 3: Integrate BKV with production capture semantics

**Files:**
- Modify: `app/service/src/main.rs`
- Modify: `app/service/src/production_tasks.rs`

**Steps:**
1. Write failing tests proving BKV `capture-once` consumes exactly one material, stops after item 11, and reset restarts at item 1.
2. Route BKV capture-once directly to the manager instead of the camera proxy and persist a capture summary with `provider=bkv`, `legacySeqNo`, six offline camera rows, and artifact references.
3. Reject camera lifecycle mutations, camera parameter changes, calibration writes, and continuous capture in BKV mode with stable `bkv_hardware_operation_forbidden` errors.
4. Prove the eight-camera production readiness gates remain unchanged for headless/external providers.

### Task 4: Add the typed BKV client and workspace

**Files:**
- Create: `app/client/src/services/bkv-api.ts`
- Create: `app/client/src/services/bkv-api.test.ts`
- Create: `app/client/src/components/BkvCompatibilityApp.tsx`
- Create: `app/client/src/components/BkvCompatibilityApp.test.tsx`
- Modify: `app/client/src/App.tsx`
- Modify: `app/client/src/styles.css`

**Steps:**
1. Write failing API tests for status, materials, detail, artifact URLs, next, and reset.
2. Implement typed API calls using the configured inspection service origin.
3. Write failing component tests for explicit “BKV 离线回放”, 6/6 offline-data status, material selector, source tag, defect list, JPEG tiles, unfolded view, 3D view, completed state, reset, and disabled hardware controls.
4. Implement the workspace and a compact canvas/Three.js-compatible cylinder renderer from `cylinder-preview.json`.
5. Make `App` select the BKV workspace only when the backend explicitly reports `provider=bkv`; a missing/404 BKV endpoint must preserve the existing application.

### Task 5: End-to-end verification and operations

**Files:**
- Create: `config/env/bkv.env.example`
- Modify: `scripts/README.md`
- Modify: `scripts/test-runtime-ui-smoke.ps1`

**Steps:**
1. Document `STEEL_CAPTURE_PROVIDER=bkv`, `STEEL_BKV_DATA_ROOT`, manifest and cursor paths, batch build, startup, reset, and exit behavior.
2. Start the Rust service with no capture process and the client on `main`.
3. Verify health, 11 materials, 6/6 file inventory, JPEG/unwrapped/cylinder responses, two associated legacy defects, sequential 11-item capture-once, completed state, and reset.
4. Verify the browser visibly labels BKV mode and renders 2D/unwrapped/3D content without reporting real cameras online.
5. Run Python tests, targeted Rust tests, client tests/build, runtime UI smoke, and regression checks for real/simulated provider isolation.
