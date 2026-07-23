# Independent Runtime Architecture

The inspection system is split into five runtime boundaries:

```text
LVM 3D cameras
  -> C++ capture core
    -> headless capture service
      -> Rust inspection service
        -> Tauri client (formal operator UI)

L2 / PLC / external trigger API
  -> standalone trigger gateway
    -> Rust inspection service
```

## Components

### `app/capture`

Shared C++ capture implementation.

- `steel_capture_core`: reusable SDK/API core linked by other capture runtimes.
- `steel_capture_service`: headless executable for service-only deployments.
- Owns LVM SDK calls, camera sessions, parameter reads/writes, parallel trigger/callback capture, bounded frame-write transactions, calibration loading, staged cross-restart rollback manifests, recovery fencing, and the local capture HTTP API.
- Commits depth and intensity before metadata, overlaps a finite number of writer tickets across rounds, and drains accepted transactions before SDK teardown. Unsigned-short depth is deep-copied for offline writer encoding; float depth keeps an explicit synchronous SDK fallback.

### `app/service`

Rust inspection backend.

- Owns business APIs, desired configuration, admin/auth, database state, inspection records, persistent production tasks and layered service readiness.
- Uses one SeaORM persistence boundary. Development/test profiles expose SQLite, MySQL, and PostgreSQL adapters and may explicitly fall back from an unreachable remote database to the local SQLite state file. The selected and active engines remain observable; schema/version failures never trigger fallback. Production remains fail-closed and limited to the formal SQLite/MySQL release contract.
- Owns production database writes for material sessions, secondary data, trigger events, inspection records, capture files, defect records, persistent alarms and their audit trail. In production mode a bounded monitor reconciles storage, capture, task-worker, calibration, trigger, algorithm and production-policy health into `system-health` alarm episodes: one open row is refreshed while the condition persists, recovery closes it with a server-owned actor, and recurrence creates a new ID.
- Serializes durable `steel-info`, `steel-in`, capture, algorithm, `steel-out`, and generic trigger-event work through a bounded database-backed FIFO-ready worker. Stable request IDs make upstream retries idempotent; persisted chain dependencies prevent failed prerequisites from releasing safety-critical downstream work.
- Owns the persistent `calibration_operation` ledger for real apply/rollback. Caller-owned operation IDs are single-flight; ambiguous provider outcomes and interrupted dispatch become `needs-reconciliation`, close readiness/device mutations with HTTP 423, and are never replayed automatically. Only provider-confirmed parent-bound rollback changes the parent to `reconciled`.
- Owns the persistent `record_cleanup` ledger. Production artifacts are frozen by canonical path, size, and SHA-256 beneath explicitly allowed roots; physical deletion progress is durable and retryable, and inspection-owned database indexes are removed only after every file is confirmed deleted or missing. Material sessions and trigger/secondary history remain retained.
- Talks to the configured capture provider through the local capture API.
- In `headless-cpp` mode, owns the capture executable as a contained child process. The lifecycle supervisor publishes `starting`, `ready`, `collecting`, `degraded`, `stopping`, and `stopped`, confirms provider-requested restarts, applies bounded exponential backoff and a restart budget, and drains the child before Rust exits.
- Should not call the LVM SDK directly.

### `app/trigger`

Standalone trigger gateway.

- Runs as its own process outside the capture provider, Rust service, and Tauri client.
- Accepts L2/PLC/API events for steel info, steel-in, steel-out, secondary data, one-shot capture, capture summary, and defect results.
- Accepts HTTP API, newline-delimited TCP JSON, and UDP JSON datagram triggers. It tags events with `TRIGGER_MODE=api`, `tcp`, `udp`, `gray`, `secondary`, or `manual`, then forwards steel-info/in/out and generic events to Rust's durable task endpoints. Manual steel-in/out endpoints are blocked unless the gateway mode is `manual`.
- Does not call camera SDK functions and does not write capture files directly.

### `app/client`

Tauri/React client.

- Owns the user-facing desktop interface.
- Calls the Rust service only.
- Does not call the capture SDK or the capture terminal directly.
- Does not link `nvt_lvm_sdk.lib` or ship `nvt_lvm_sdk.dll`; camera SDK files belong to the capture provider runtime.

### BKV conversion service

`scripts/bkv_import_service.py` is the independent adapter for old BKV files. It
loads `config/project.json`, follows `activeRuntimeProfile`, and accepts only a
non-direct `converted-local` six-camera profile. The legacy root is read-only:
each JPEG/NPZ path, size, hash, camera identity, material identity, frame number,
and defect association is verified before publication.

The converter writes to the profile's `storage.convertedRoot` through
same-volume staging and atomic directory rename. Its `catalog.db` indexes the
standard record contract and `records/<inspectionId>` contains `record.json`,
source provenance, C1-C6 camera-local JPEG/NPZ frames, and defects. A bounded
retry covers transient Windows locks at the atomic publish boundary; invalid
records remain quarantined and interrupted jobs can be retried. Re-importing an
unchanged source/configuration skips already published records.

Rust reads BKV records, defects, metadata, and tiles from this converted store.
The old manifest is not the business-query repository. BKV runtime state uses
its own SQLite files and must not connect to the online MySQL production
adapter; conversely, a direct profile does not open the converted BKV catalog.

### Production algorithm qualification boundary

The reconstruction implementation is not trusted merely because the process exits successfully. Production trust is split across four immutable inputs:

- the packaged `steel.algorithm-config.v1` configuration and its SHA-256;
- an externally approved `steel.algorithm-acceptance.v1` report binding the exact release commit, Python script, C++ core, frozen dataset/evaluator, and calibration;
- the exact eight-camera input artifacts and their per-file hashes;
- the per-run manifest containing algorithm/config/calibration identities, thresholds, quality-gate result, and real/synthetic defect counts.

Rust readiness exposes separate `algorithm` and `productionPolicy` checks. Missing or mismatched qualification evidence, an invalid production profile, an incomplete eight-camera run, a failed quality gate, or any synthetic output closes readiness and must prevent a production quality conclusion. The pending example acceptance report is documentation only and is never a production input.

## Capture Provider Modes

The Rust service reads these environment variables:

- `STEEL_CAPTURE_PROVIDER=headless-cpp`
  Rust starts and supervises `steel_capture_service.exe`.

- `STEEL_CAPTURE_PROVIDER=external-api`
  Rust connects to another compatible capture API process.

- `STEEL_CAPTURE_PROVIDER=simulated`
  Rust does not connect to a local capture API and uses the simulated eight-camera fallback.

- `STEEL_CAPTURE_PROVIDER=bkv`
  Rust starts no camera SDK process. `config/project.json` must select the
  six-camera BKV profile, and the converter must have published its standard
  store before records are available. Capture management and 3D reconstruction
  capabilities remain unavailable; offline replay and backend configuration
  remain available.

Runtime profile saves are validated and written atomically, but the active
in-memory profile never changes mid-process. `restartRequired:true` means the
Rust service must be restarted before the new topology, storage roots, or
capability set is active.

The capture API address is configured with:

```powershell
$env:CAPTURE_SERVICE_ORIGIN='http://127.0.0.1:4317'
```

For headless mode, `CAPTURE_SERVICE_PORT` can still be used and defaults to `4317`.

## Deployment Boundaries

Production delivery has two independent installation lifecycles:

1. The background runtime package is placed in a protected machine directory and registered as the `SteelInspectionRuntime` Windows service. The SCM supervisor owns the Rust and trigger processes; Rust owns the nested capture child lifecycle.
2. The signed Tauri MSI/NSIS installs the operator desktop client. Closing or uninstalling it does not stop or uninstall the background service.

The desktop installer does not currently install the service, and the service installer does not currently install the desktop client. Tauri now selects the offline WebView2 installer and per-machine NSIS mode; formal packaging requires a Microsoft-signed `VC_redist.x64.exe`, one MSI, one NSIS, valid timestamped signatures, and the desktop EXE. Camera SDK/driver, database client, signature, and target-machine prerequisites still belong to the release/deployment boundary rather than to the application runtime graph. See [release-deployment-and-operations.md](release-deployment-and-operations.md).

## Runtime Rules

- Production deployment uses one Windows SCM host named `SteelInspectionRuntime`. The host owns no SDK or business logic; it injects reviewed environment files, starts Rust and then the trigger gateway with loopback application-level readiness gates, stops them in reverse order, and applies a bounded outer restart policy. Rust starts and contains `steel_capture_service.exe` in a nested Job Object, owns its readiness/restart budget and capture log, and terminates it before Rust exits. The outer host still atomically publishes `StateRoot/service/supervisor-status.json`; whole-runtime restart-budget exhaustion survives process exit, while capture-only exhaustion is reported in Rust health and persistent system-health alarms. The desktop client remains independent of both lifecycles. Source/static preflight is not evidence that SCM state, business drain, continuous log rotation, ACLs, recovery, or upgrade rollback work on the target machine.
- Exactly one process may own camera SDK handles; the formal owner is `steel_capture_service.exe`.
- The Rust service is the API gateway and business orchestrator, not a camera driver.
- Rust persists calibration dispatch/reconciliation intent and result, while C++ remains the only process that executes SDK calibration. C++ atomically stages known-good previous files with SHA-256 before formal eight-camera writes; those file-only tokens survive restart, while the vendor runtime structure stays process-local and is never serialized.
- Rust persists one stable production `chainId` per material/session. Safety-critical tasks use `require-success`, are claimed only after their direct predecessor succeeds, and recursively enter terminal `blocked` state after a failed, cancelled, interrupted, or blocked prerequisite. Retrying the failed chain root requeues its blocked descendants; only explicitly safe `trigger-event` cleanup may opt into `always-run`.
- SQLite backups use an online database snapshot rather than copying the live file. MySQL backup/restore runs as a server-side single-transaction job with credentials in a restricted defaults file; both recovery paths use a versioned SHA-256 manifest and explicit restore confirmation.
- Rust readiness is gated by database, durable-task worker, capture API/SDK, persistent calibration reconciliation, capture storage/writer queue/capacity, the required trigger gateway, algorithm qualification, and the production-policy check. For non-simulated capture it takes the minimum capacity across the global and every camera root, reports a non-blocking warning at twice the hard byte watermark or five percentage points above the hard percentage watermark, fails closed below either hard watermark, reports recent successful write throughput and estimated remaining time, and rejects only new steel-info/steel-in admission so an existing session can retry or steel-out safely. Provider readiness also fails closed on non-terminal or invalid rollback manifests. Health details expose stable reasons without leaking local paths, origins, IP addresses, or raw dependency bodies.
- The standalone trigger gateway is the integration adapter for L2/PLC/gray-sensor events; it forwards to Rust instead of touching SDK handles.
- Production HTTP/TCP/UDP trigger ingress is authenticated with HMAC-SHA256 over the versioned `steel-trigger-v1` canonical message, a bounded Unix timestamp, and a single-use nonce. Non-loopback binding requires an IP/CIDR source allowlist; missing secrets fail startup, wildcard CORS is absent, status omits internal addresses, and runtime mode mutation is locked by default. Manual mutations enter through Rust, require `admin.services`, and write an audit row.
- The Tauri client is a UI shell and must keep using Rust APIs.
- Tauri reaches every operator capture workflow through Rust; it never calls the provider directly.
- Tauri trigger status/mode/manual controls use Rust's explicit `/api/trigger/*` proxy allowlist. Rust forwards those calls to the standalone gateway; the gateway then enqueues the durable production command back at Rust. The browser never targets port 4881 directly.
- Qt source, provider compatibility mode, build scripts, and package switches have been removed.

The API boundary is documented in [capture-api-contract.md](capture-api-contract.md).

## Production Boundary Verification Status

The architecture describes the required end state. As of 2026-07-16, the following boundaries still require release or site evidence:

- The locked Tauri no-bundle Release build completed in 56.64 seconds and produced `target/cargo/release/steel-plate-3d-inspection-tauri.exe` (23,113,728 bytes); production devtools feature count is zero. Two bundle diagnostics were terminated after the GitHub/proxy installer-resource chain stopped making progress; the second downloaded/extracted WixTools314, but no bundle directory, MSI or NSIS was produced. This is an installation-resource download blocker rather than a source-compilation failure. The raw EXE is `NotSigned` and depends on `VCRUNTIME140.dll`.
- Formal package mode now fail-closes on invalid/missing trusted-timestamp signatures for every first-party background EXE and requires a valid timestamped vendor signature on `nvt_lvm_sdk.dll`, in addition to the desktop/VC++ gates. The gate exists, but current artifacts are unsigned and no real release certificate, timestamp or vendor-signature evidence has been supplied.
- The current runtime folder is a dirty-worktree/no-desktop-bundle engineering package, not a release candidate.
- Supervisor source hardening now uses an explicit inherited stdio handle list, suspended child creation followed by Job Object assignment/resume, KILL_ON_JOB_CLOSE/TerminateJobObject process-tree cleanup, synchronous HTTP/TCP/UDP trigger binding, and application-level HTTP identity/health probes. The elevated installer protects runtime/policy ACLs and ancestor chains, restores its managed service/env/registry state on upgrade failure, bounds SCM failure actions, and the uninstaller waits for service/port release. Supervisor/trigger/security/port-conflict regressions, three PowerShell AST parses and the static installer contract have passed in the engineering workspace. Rust service/trigger business drain, live SCM status semantics, continuous log rotation, effective ACL/ancestor validation, external binary/database rollback, and supervisor-crash recovery remain target-machine gates.
- The algorithm configuration and acceptance-report contracts exist, but no approved `status=pass` report and frozen-data precision evidence currently close the production algorithm gate.
- The current eight-camera hardware, calibration, OT, disaster-recovery, and soak evidence remains outstanding.

Static architecture contract success must therefore be reported as source-boundary evidence, not as production deployment acceptance.

## Recommended Startup

Headless service mode:

```powershell
scripts/build-capture-headless.ps1
scripts/run-service.ps1 -Provider headless-cpp
```

Client-only development mode:

```powershell
scripts/run-client-dev.ps1 -ServicePort 4873 -VitePort 1432
```

Tauri desktop development mode:

```powershell
scripts/run-tauri-dev.ps1 -ServicePort 4873
```

Additional script details are in [../scripts/README.md](../scripts/README.md).

Deployable runtime folders can be generated with:

```powershell
scripts/package-runtime.ps1
```
