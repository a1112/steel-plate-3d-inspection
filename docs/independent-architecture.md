# Independent Runtime Architecture

The inspection system is split into five runtime boundaries:

```text
LVM 3D cameras
  -> C++ capture core
    -> headless capture service
      -> Rust inspection service
        -> Tauri client (formal operator UI)

optional Qt diagnostic viewer
  -> headless capture service HTTP API

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

### `app/capture-qt`

Optional development diagnostic viewer.

- It is not a formal production component and is never the default capture provider.
- Formal startup sets `CAPTURE_QT_API_AUTOSTART=0`; Qt then consumes the headless provider HTTP API and does not start a second API/SDK session.
- It may be packaged only for development diagnostics; formal operator workflows live in Tauri.
- The current compatibility binary still links the shared capture core, so production packaging should omit it unless diagnostics are explicitly requested.

### `app/service`

Rust inspection backend.

- Owns business APIs, desired configuration, admin/auth, database state, inspection records, persistent production tasks and layered service readiness.
- Owns production database writes for material sessions, secondary data, trigger events, inspection records, capture files, defect records, persistent alarms and their audit trail.
- Serializes durable `steel-info`, `steel-in`, capture, algorithm, `steel-out`, and generic trigger-event work through a bounded database-backed FIFO worker. A stable request ID makes upstream retries idempotent.
- Owns the persistent `calibration_operation` ledger for real apply/rollback. Caller-owned operation IDs are single-flight; ambiguous provider outcomes and interrupted dispatch become `needs-reconciliation`, close readiness/device mutations with HTTP 423, and are never replayed automatically. Only provider-confirmed parent-bound rollback changes the parent to `reconciled`.
- Talks to the configured capture provider through the local capture API.
- Should not call the LVM SDK directly.

### `app/trigger`

Standalone trigger gateway.

- Runs as its own process outside the capture provider, Rust service, Qt terminal, and Tauri client.
- Accepts L2/PLC/API events for steel info, steel-in, steel-out, secondary data, one-shot capture, capture summary, and defect results.
- Tags events with `TRIGGER_MODE=api`, `gray`, `secondary`, or `manual`, then forwards steel-info/in/out and generic events to Rust's durable task endpoints. Manual steel-in/out endpoints are blocked unless the gateway mode is `manual`.
- Does not call camera SDK functions and does not write capture files directly.

### `app/client`

Tauri/React client.

- Owns the user-facing desktop interface.
- Calls the Rust service only.
- Does not call the capture SDK or the capture terminal directly.
- Does not link `nvt_lvm_sdk.lib` or ship `nvt_lvm_sdk.dll`; camera SDK files belong to the capture provider runtime.

## Capture Provider Modes

The Rust service reads these environment variables:

- `STEEL_CAPTURE_PROVIDER=headless-cpp`
  Rust starts and supervises `steel_capture_service.exe`.

- `STEEL_CAPTURE_PROVIDER=qt-terminal`
  Legacy compatibility mode only. It is not used by the formal runtime.

- `STEEL_CAPTURE_PROVIDER=external-api`
  Rust connects to another compatible capture API process.

- `STEEL_CAPTURE_PROVIDER=simulated`
  Rust does not connect to a local capture API and uses the simulated six-camera fallback.

The capture API address is configured with:

```powershell
$env:CAPTURE_SERVICE_ORIGIN='http://127.0.0.1:4317'
```

For headless mode, `CAPTURE_SERVICE_PORT` can still be used and defaults to `4317`.

## Runtime Rules

- Exactly one process may own camera SDK handles; the formal owner is `steel_capture_service.exe`.
- The Rust service is the API gateway and business orchestrator, not a camera driver.
- Rust persists calibration dispatch/reconciliation intent and result, while C++ remains the only process that executes SDK calibration. C++ atomically stages known-good previous files with SHA-256 before formal six-camera writes; those file-only tokens survive restart, while the vendor runtime structure stays process-local and is never serialized.
- Rust readiness is gated by database, durable-task worker, capture API/SDK, persistent calibration reconciliation, capture storage/writer queue, and the required trigger gateway. Provider readiness also fails closed on non-terminal or invalid rollback manifests. Health details expose stable reasons without leaking local paths, origins, IP addresses, or raw dependency bodies.
- The standalone trigger gateway is the integration adapter for L2/PLC/gray-sensor events; it forwards to Rust instead of touching SDK handles.
- The Tauri client is a UI shell and must keep using Rust APIs.
- Tauri reaches every operator capture workflow through Rust; it never calls the provider directly.
- Tauri trigger status/mode/manual controls use Rust's explicit `/api/trigger/*` proxy allowlist. Rust forwards those calls to the standalone gateway; the gateway then enqueues the durable production command back at Rust. The browser never targets port 4881 directly.
- Optional Qt diagnostics consume the existing headless API with embedded API autostart disabled.

The API boundary is documented in [capture-api-contract.md](capture-api-contract.md).

## Recommended Startup

Headless service mode:

```powershell
scripts/build-capture-headless.ps1
scripts/run-service.ps1 -Provider headless-cpp
```

Optional Qt diagnostics after starting the headless stack:

```powershell
scripts/build-capture-qt.ps1 -QtPrefixPath C:/Qt
scripts/start-capture-stack.ps1 -WithQtViewer
```

The Qt terminal must be built with a Qt kit that matches the C++ camera SDK toolchain. With the current LVM SDK import library, use MSVC x64 Qt (`msvc*_64`); MinGW Qt cannot link the SDK-backed capture core.

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
