# Qt to Tauri Migration Status

## Target Runtime

```text
Tauri/React operator client
  -> Rust inspection service
    -> headless C++ capture service
      -> LVM/NVT camera SDK

Tauri trigger status/mode/manual controls
  -> Rust /api/trigger/* allowlist
    -> trigger gateway

L2 / PLC / external trigger
  -> trigger gateway
    -> Rust durable production-task APIs

optional Qt diagnostic viewer/source
  -> existing headless capture HTTP API
```

The formal runtime consists of Tauri, Rust, the trigger gateway, and the headless C++ capture service. Qt is not started, packaged, monitored, or required by the formal runtime. The remaining Qt source may be retained temporarily as an opt-in development diagnostic tool (`CAPTURE_QT_API_AUTOSTART=0`) or deleted without changing the production process graph.

## Migrated Operator Capabilities

- Online overview, current material, defect map/list/statistics, inspection records, report filters, and CSV export.
- Capture overview, six-camera status, connect/disconnect, exposure/gain write, production steel-info/steel-in/capture/steel-out controls, and trigger gateway status/modes/manual controls. All formal operator calls terminate at Rust; the browser never calls the capture or trigger ports directly.
- Latest saved depth, intensity, metadata JSON, and explicitly enabled SDK-derived preview through Rust, refreshed every three seconds. The desktop client can save the current preview and reveal the provider-returned file in the native file manager.
- Selected-camera realtime depth/intensity stream start/stop and frame reads through Rust, including operator controls and validation for `width`, `dataMode`, `fpsLimit`, and high-speed (`hs`) mode.
- Native Tauri file/folder selection, preview save-as, and reveal/open actions cover the former Qt storage root, current material directory, latest summary, latest capture file, profile, parameter file, calibration, ROI, and calibration-version paths.
- Online inspection snapshot refresh every eight seconds with explicit `follow latest` and `hold history` modes.
- Service/capture/calibration-reconciliation/storage/trigger health visibility in the Tauri header, including the failed readiness check, unresolved operation IDs, and stable reason code.
- Rust exposes separate `/api/health/live`, `/api/health/ready`, `/api/health/ready/details`, and `/api/health/details` endpoints. Readiness performs a real database ping, checks the persistent-task worker, requires the calibration-reconciliation ledger to be clear, probes the configured non-simulated capture provider and its bounded writer queue, and checks the standalone trigger gateway without leaking origins, paths, IP addresses, or provider response bodies.
- Bar-surface reconstruction and the complete automatic array-calibration review workflow: enqueue a durable task, capture one real round from exactly six unique cameras, require six complete frames and six metadata commits, fit only from that returned capture directory, generate or import `fit_report.json`, show before/after cross-section previews and per-camera correction/residual comparison, refresh the provider's active version, open the version directory, reconstruct with the reviewed XML, and explicitly activate the reviewed reconstruction version without writing camera devices.
- Admin configuration, users/roles, audit, diagnostics, database maintenance, and record retention.
- Formal startup and packaging default to the headless C++ provider; Qt requires an explicit diagnostic flag.
- Steel-in/out commands are serialized and reject missing, conflicting, or mismatched active sessions before calling the capture provider.
- `steel-info`, `steel-in`, `capture-once`, `algorithm-run`, `steel-out`, and generic `trigger-event` now use a bounded, database-backed production task queue. Tauri and the trigger gateway enqueue work with stable request IDs, poll persisted status, and can request cancellation; queue state, results, errors, attempts, and audit events survive client disconnects.
- Durable tasks now publish persisted `waiting-command-lane`, operation-specific `dispatching-*`, and `finalizing-result` checkpoints in addition to queued/terminal state, so Tauri can show the real operation phase instead of a generic spinner.
- Task enqueue supports idempotency keys. Reusing a key with the same task kind and payload returns the existing task, while reusing it with different work returns a conflict.
- A service restart marks an in-flight task `interrupted` (or `cancelled` when cancellation was already requested) and never silently replays provider or algorithm side effects. Failed, cancelled, and interrupted tasks require an explicit retry request.
- Admin record list, detail, CSV export, delete, and retention now use `production_inspection`, `material_session`, `production_defect`, and `capture_file`. Record deletion is transactional for inspection-owned database rows and deliberately retains the material session and files on disk.
- Severe and review defect ingest creates a persistent alarm in the same database transaction. Tauri has a server-backed alarm center with active/history filters, paging, acknowledge and resolve actions, authenticated actors, mandatory notes, and audit history. Minor defects do not create alarms.
- Demo inspection rows are disabled by default. They are seeded only when `STEEL_SEED_DEMO_DATA=1` (or `true`, `yes`, or `on`) is explicitly set.
- The headless provider holds a Windows global SDK-owner mutex, rejects a second SDK process, and drains routes/camera workers before safe SDK deinitialization on console stop.
- C++ storage work now runs through item/byte/ticket-bounded frame transactions with backpressure, queue metrics, error propagation, cross-round overlap, metadata-last commit, and a deadline-bound drain before SDK deinitialization. SDK format 0 is deep-copied before buffer release and encoded in the writer; format 2 keeps an explicit synchronous online-save fallback because the vendor offline encoder corrupts float depth.
- A capture worker that exceeds its hard deadline is never detached. C++ retains the thread handle, marks real-SDK capture `49007/restartRequired`, rejects new device operations, and joins the worker before device/SDK destruction; if the common shutdown deadline expires, the existing process-level `_Exit` path skips unsafe teardown.
- Capture/latest/stream file reads canonicalize the existing regular file and allow it only below the configured global or per-camera storage roots. The process working directory is no longer an implicit read root, and `..`, prefix, symlink, and junction escapes are rejected.
- Tauri now exposes provider profile read/create/save/provider-local-path import/apply, six-camera connect-all, complete SDK parameter readback, camera parameter-file save/load/recovery, global and per-camera storage roots, continuous-test parameters/run/results, and writer-queue metrics. The structured profile editor synchronizes online camera IP/model/SN and current SDK exposure/gain/trigger-frequency readback. Device-persistent writes remain disabled by default and risky operations require exact typed confirmation.
- The overview has a real stop-all-preview action that attempts every running stream and reports partial failures instead of stopping only the first selected stream. Disconnect-all likewise returns aggregate counts plus one IP/code/error/hint result per camera, and Tauri surfaces partial failures.
- Capture logs are a bounded merge of provider snapshots, system events, and real client operations; periodic provider refreshes no longer overwrite or hide operator actions.
- Continuous capture supports both all-enabled-camera and selected-single-camera scopes with the same bounded parameters and structured per-round/per-camera result evidence.
- Controlled Tauri maintenance now covers arbitrary SDK parameter read/write, `.nccfg` runtime load/save, separately confirmed device persistence, single-camera calibration/ROI/validation, and the dangerous line-continuous preset. These calls remain behind Rust's authenticated `admin.config` allowlist and server-side confirmation validation; the frontend never calls C++ directly.
- Six-camera SDK calibration deployment now requires six unique IPs, six expected serial numbers, and six per-camera SDK calibration files. It rejects array-reconstruction XML as a camera SDK artifact, requires a successful unchanged dry-run before apply, defaults to `saveToDevice=false`, supports atomic rollback, exposes per-camera preflight/apply/persist/rollback codes, and returns an explicit rollback token. Array XML remains reconstruction-only.
- C++ appends calibration load, ROI load, validation capture, set apply, and rollback outcomes to `<storageRoot>/maintenance/calibration-records.jsonl`; Tauri exposes the maintenance record path and current calibration/ROI/validation/rollback status.
- Real six-camera apply and rollback now require a caller-owned stable `operationId`. Rust stores the normalized request hash, actor, parent/reconciliation fields, row version, dispatch state, provider response, error, and timestamps in `calibration_operation`; the same ID/request is single-flight and replay-safe, conflicting reuse returns 409, and interruption or incomplete rollback becomes `needs-reconciliation` without automatic replay. While unresolved, Rust readiness is false and calibration/device mutations return HTTP 423. Tauri can only issue a recovery rollback bound by `parentOperationId`; Rust marks the parent `reconciled` only after C++ returns `complete:true` with the same `applyOperationId`. C++ echoes IDs in top-level/per-camera evidence, status, active metadata, the maintenance JSONL, and its durable rollback manifest.
- Before the first SDK write, C++ copies every formal mapping's known-good `rollbackPath` beneath the config root, verifies SHA-256+size, marks the copy read-only, and atomically publishes a write-ahead manifest. Tokens and file-only rollback survive a clean process restart; `lvm_calib_param_t` remains process-local and is never serialized. Non-terminal or invalid manifests close provider readiness and all new writes until an explicit staged rollback succeeds; unconsumed recovery assets are never evicted by the old in-memory record limit.
- Production 3D surface and point-cloud panels now load the mesh bound to the selected inspection's `summaryPath`; history records use their own persisted summary path. Production mode shows an explicit no-artifact state and never falls back to the bundled demo surface or simulated point cloud. Record capture images are likewise labelled as record originals rather than defect ROI crops.

## Capability Ownership After Migration

| Former Qt-facing capability | Formal owner now | Disposition |
| --- | --- | --- |
| Overview, current material, six-camera cards, realtime SDK/readback status, health, queue state, logs, and refresh | Tauri UI through Rust read APIs | Migrated; logs merge bounded provider/system/operator evidence and readiness includes calibration reconciliation |
| Connect/disconnect selected camera, connect/disconnect all, start parameterized selected preview, and stop all previews | Tauri UI through Rust's authenticated capture allowlist; C++ owns SDK sessions | Migrated, including per-camera partial-result reporting and `width/dataMode/fpsLimit/hs` preview controls |
| Latest depth/intensity image, metadata JSON, optional SDK-derived image, realtime depth/intensity stream, save current preview, and reveal latest provider file | Tauri UI plus native Tauri dialogs through Rust file APIs | Migrated |
| Open storage root, current material directory, latest summary, latest frame, and calibration version directory | Tauri native path commands using provider-returned absolute paths | Migrated |
| Profile list/read/new/import/save/apply and active-pointer control | Tauri configuration UI through Rust `admin.config`; C++ persists provider profiles | Migrated; save/apply defaults cannot silently persist to devices |
| Structured per-camera profile fields: enable, IP, model, SN, parameter source/file, storage root, exposure, gain, and trigger frequency | Tauri structured editor; online status/readback comes through Rust | Migrated, including online IP/model/SN/SDK-value synchronization and editable `H:/camera1..camera6` mappings |
| Global/per-camera storage configuration, writer queue metrics, parameter snapshot save/load/recovery, and single/all device persistence | Tauri controlled maintenance through Rust; C++ performs filesystem/SDK work | Migrated; device persistence requires a separate exact confirmation |
| Arbitrary SDK parameter reads/writes and software-trigger/line-continuous tuning | Tauri controlled diagnostic panel through Rust validation | Migrated as an admin-only maintenance surface, not a normal production shortcut |
| One-round capture, all-camera continuous stability test, selected-single-camera continuous test, output selection, retries, and structured results | Tauri capture operations through Rust; C++ performs parallel capture and bounded persistence | Migrated |
| Steel-info, steel-in, capture, algorithm, steel-out, task status, retry, and cancellation | Tauri UI plus Rust persistent FIFO worker | Migrated |
| Automatic calibration capture/fit, `fit_report` import, before/after review, correction comparison, active refresh, version-directory open, reviewed reconstruction, and reconstruction-version activation | Tauri bar-surface UI plus Rust durable tasks/algorithm services | Migrated; fit is gated on one complete frame and metadata commit from each of six unique cameras, and reconstruction activation never writes camera devices |
| Single-camera calibration, ROI, validation frame/status, and maintenance JSONL | Tauri controlled diagnostic UI through Rust; C++ owns SDK calls and the append-only record | Migrated |
| Six-camera per-device calibration preflight/apply/result/rollback and optional parameter/device persistence | Tauri controlled diagnostic UI through Rust's persistent operation ledger; C++ validates artifact identity, SN binding, staged previous files, SHA-256, generation, and rollback | Migrated with safer semantics than the former Qt action; every formal mapping needs a known-good rollback file, array XML cannot be reused as six per-camera files, and ambiguous operations remain fenced until a parent-bound rollback is verified |
| Inspection records, exports, retention, defects, alarms, acknowledge/resolve, and audit history | Tauri UI plus Rust database services | Migrated |
| Provider `/ui` status console | Tauri overview, API capability page, and controlled diagnostics | Safely replaced; the formal client does not open or depend on the C++ web UI |
| Parallel trigger/callback capture, frame ownership, producer-consumer persistence, device lifetime, and SDK teardown | Headless C++ capture service | Removed from the formal UI process boundary |

## Persistent Task Boundary

The persistent queue accepts six task kinds: `steel-info`, `steel-in`, `capture-once`, `algorithm-run`, `steel-out`, and `trigger-event`. The queue is bounded by `STEEL_PRODUCTION_TASK_QUEUE_CAPACITY` (default 128, clamped to 1..4096), executes through one worker and the existing serial production-command lock, and exposes enqueue, list, detail, cancel, and explicit retry APIs.

The formal event-specific enqueue endpoints are:

- `POST /api/production/tasks/steel-info`
- `POST /api/production/tasks/steel-in`
- `POST /api/production/tasks/steel-out`
- `POST /api/production/tasks/trigger-event`

`capture-once` and `algorithm-run` use `POST /api/production/tasks` with their task kind. Accepted commands are ordered by a fixed-width task sequence, and a queued steel-info -> steel-in -> capture -> algorithm -> steel-out chain reuses the same material/session identity. A stable upstream `requestId` is required for safe retry; the same kind and payload returns the existing task, while conflicting reuse returns HTTP 409.

Cancellation is cooperative at the Rust/provider boundary. A queued task is cancelled before dispatch. For a running task, Rust records `cancelRequested:true`; if the worker has not dispatched yet it cancels the task, otherwise it lets the current synchronous provider or algorithm call return and keeps that real success/failure result authoritative. A late cancellation is audited and remains visible through `cancelRequested`; it does not abort an SDK call in progress, kill the capture process, hide completed side effects, or roll back files/device effects already produced.

`maxAttempts` is persisted, but a failed task is not automatically replayed. This is intentional because capture and algorithm work can have external side effects; an operator or client must explicitly call retry after reviewing the terminal error.

The original synchronous steel routes remain only as compatibility APIs. Secondary-data, capture-summary, and defect-ingest still use their synchronous production routes and serialized mutation lane because they are record-ingest operations rather than long-running provider work.

## Remaining Production Gates and Diagnostic Retirement Decisions

Qt has already been removed from the formal runtime and package. The items below gate production rollout of the migrated architecture or the eventual deletion of the optional diagnostic source; they do not make Qt a formal runtime dependency.

### P0 - Real six-camera hardware acceptance

- Rerun the complete workflow against six real LVM/NVT cameras. The current green acceptance uses the simulated provider and proves process/API/storage behavior, not vendor SDK or device persistence behavior.
- For the frame-transaction pipeline, verify live cameras report the expected depth persistence mode, compare online/offline depth images from the same frame, measure pending-byte backpressure, exercise any format-2 camera's synchronous fallback, force one SDK hard timeout to verify `49007/restartRequired`, and send CTRL_BREAK while accepted frames are draining.
- For calibration, bind every target to the real camera SN, prove dry-run performs no SDK mutation, apply six distinct per-camera files with six known-good rollback files, inject a middle-camera failure and verify rollback on every earlier camera, kill/restart during applying and rolling-back phases, prove provider/Rust readiness and the 423 fence close, complete the parent-bound staged rollback, test `saveToDevice=false` and the separately confirmed `saveToDevice=true` path, reconnect the devices, and capture a validation frame plus manifest/maintenance JSONL evidence.
- `test-real-calibration-acceptance.ps1` automates local SHA-256/file/SN/mapping preflight, Rust/C++ dry-run, explicitly authorized real apply, persisted ledger verification, explicit six-camera rollback, readiness reopening, and a six-frame validation capture. `test-real-calibration-crash-recovery.ps1` adds operation/phase/camera-bound process termination and two-phase recovery for both interrupted apply and interrupted rollback. `test-real-calibration-integrity-generation.ps1` creates two real generations, proves a stale token and a tampered staged file are rejected with decisive zero-write evidence, restores the exact staged bytes, rolls back, and validates six frames. Integrated full coverage requires all three hardware reports.
- Exercise selected/all preview stop and selected/all continuous tests while real streams and producer-consumer storage are active. Stream-preview publication remains independent from the production frame transaction.

### P1 - Durable provider rollback software complete; hardware proof pending

- The Rust-side idempotency and reconciliation gap is closed: `calibration_operation` persists the normalized request/hash, actor, parent/reconciliation fields, row version, provider HTTP/body, error, and timestamps. Same-ID/same-request retries never redispatch; changed requests conflict; a different active ID is rejected instead of queued; duplicate JSON keys are rejected before dry-run routing; and startup converts orphaned `dispatching` rows to `needs-reconciliation` without replay only after the service owns its formal listen port.
- An unresolved row is a database-backed fence: readiness is false, device mutations return HTTP 423, and the only closure is a fresh rollback operation carrying `parentOperationId`. The parent becomes `reconciled` only when the provider explicitly returns `complete:true` and the same original `applyOperationId`; there is no API for manually asserting success or failure.
- C++ now stages immutable previous SDK files below `<CAPTURE_CONFIG_ROOT>/calibration-rollbacks/<token>/<operationId>/previous`, verifies SHA-256+size, and atomically flushes `steel.capture.calibration-rollback-manifest.v1` before SDK writes. File-only rollback tokens survive restart; prepared/applying/rolling-back/rollback-failed phases close provider readiness and new writes until explicit rollback, while a corrupt manifest stays fail-closed. Runtime `lvm_calib_param_t` snapshots remain process-local and are never serialized.
- The remaining work is real-device proof: exercise restart during apply and rollback, verify SN/generation/hash rejection performs zero writes, verify `saveToDevice=true` restores known-good files on all six cameras, and record validation-frame plus maintenance evidence after reconciliation.

### Non-Qt product backlog

- Define explicit dependency semantics for multi-step queued production chains and decide whether a failed prerequisite should automatically cancel later accepted work. Today later tasks remain FIFO and report their own validation failure.
- Add true cooperative cancellation inside provider/algorithm operations before claiming that a running task can stop immediately. Current cancellation is observed only before dispatch or after the synchronous provider boundary returns.
- Persist and expose defect-specific camera/sequence/ROI geometry if exact defect crops, local point clouds, or real local height profiles are required. The current production UI intentionally labels the selected record's full capture image as a non-ROI source and shows an empty state when no defect-bound artifact exists.
- Move remaining hard-coded storage roots and reconstruction parameters into Rust-owned desired/active/readback configuration.

## Safety Rules

- Tauri calls Rust only; it never calls the capture provider or camera SDK directly.
- Tauri also reaches trigger status/mode/manual controls through Rust's explicit `/api/trigger/*` proxy allowlist; it does not call the gateway port directly.
- Non-simulated provider failures retain their HTTP status, content type, and error body. They must never fall back to a success response.
- Synchronous compatibility mutations share a serial command lane. All six durable task kinds enter that lane from the persistent worker; health/status/task reads remain concurrent.
- A synchronous compatibility steel event returns `production_tasks_in_progress` while a task is queued or running, so it cannot overtake accepted durable work.
- Restart recovery never auto-replays a task that may already have produced external side effects. `interrupted` requires an explicit retry.
- `STEEL_CAPTURE_PROVIDER=simulated` must be selected explicitly for simulated success responses.
- `STEEL_SEED_DEMO_DATA` is off by default in formal runtime and must be explicitly enabled for development fixtures.
- Qt compatibility mode is not a production startup path.
- Array reconstruction XML is never a per-camera SDK calibration artifact. A six-camera apply requires six explicit mappings, unique IP/SN identity, an unchanged successful dry-run, and typed confirmation; device persistence has an additional confirmation and defaults off.
- The calibration maintenance JSONL is the C++ per-camera audit trail and correlation evidence; Rust's `calibration_operation` table is the idempotency/reconciliation ledger. C++ never serializes the vendor runtime struct: before apply it stages immutable known-good SDK files with SHA-256 and an atomic manifest, and only those staged files may drive cross-restart recovery. Persistent device writes remain gated on real-hardware validation of that recovery path.

## Verification Baseline

- The packaged Qt-free simulated service/trigger/client acceptance has passed, including Rust durable steel-info -> steel-in -> capture-once -> steel-out tasks, trigger controls routed through Rust, stable material/session identity, and the formal runtime/package layout.
- Older real-hardware evidence covers six-camera parallel capture and a ten-minute stability run, but it predates the final asynchronous frame-transaction writer changes and does not close the current hardware gate.
- The simulated acceptance now covers the migrated Qt parity surface at source/component/API level, including four-kind latest data, native path operations, stop-all preview, online profile readback synchronization, single/all continuous-test scope, calibration review/import/refresh/version-directory actions, controlled per-camera/set maintenance, and maintenance JSONL reporting. It cannot validate vendor SDK return codes, physical camera SN binding, device flash persistence, or real rollback behavior.
- Source-level verification must include frontend tests/build, Rust service tests, trigger tests, C++ headless build, runtime layout, and independent-architecture checks.
- C++ CTest now has five suites covering bounded queue semantics, owned hard-timeout worker lifetimes, canonical file-read boundaries, calibration artifact/path/rollback contracts, and the simulated frame pipeline (metadata-last, deterministic cross-round overlap, production success/sequence accounting, the parallel-start condition-variable regression, HTTP file denial, and CTRL_BREAK drain).
- Frontend task verification must cover enqueue/poll success, terminal failure propagation, and explicit cancellation without relying on wall-clock sleeps.
- Hardware acceptance must be rerun after SDK ownership, writer pipeline, timeout, lifecycle, or calibration changes.
