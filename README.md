# Steel Inspection Runtime and Bar Surface 3D Reconstruction

Bar surface 3D reconstruction workspace with independent runtime boundaries:

```text
Tauri/React operator client: app/client
  -> Rust inspection service: app/service
    -> headless C++ capture provider: app/capture
      -> LVM/NVT cameras

Tauri trigger status/mode/manual controls
  -> Rust /api/trigger/* allowlist
    -> standalone trigger gateway: app/trigger

L2 / PLC / external trigger
  -> standalone trigger gateway
    -> Rust durable production-task APIs

optional Qt diagnostic viewer -> headless C++ capture API
```

## Runtime Boundaries

- `app/capture`: C++ SDK capture core plus headless local API executable. It exclusively owns the camera SDK and commits frames through bounded asynchronous transactions with backpressure, metadata-last publication, error propagation, and shutdown drain.
- `app/capture-qt`: optional development diagnostic viewer. In the formal runtime its embedded API is disabled and it consumes the already-running headless provider API.
- `app/service`: Rust backend for business APIs, configuration, records, auth, alarms, layered health, capture-provider proxying, and the persistent FIFO production-task worker.
- `app/trigger`: standalone external-event gateway. PLC/L2/gray/manual events enqueue durable Rust tasks; Rust also proxies the formal operator trigger allowlist to this process.
- `app/client`: Tauri/React client. It calls Rust only, including trigger status/mode/manual controls, and does not link or ship the camera SDK.

The capture API contract is documented in [docs/capture-api-contract.md](docs/capture-api-contract.md). The full architecture notes are in [docs/independent-architecture.md](docs/independent-architecture.md).
The integrated capture-management acceptance matrix is in [docs/integrated-capture-management-acceptance.md](docs/integrated-capture-management-acceptance.md).
The Qt-to-Tauri capability matrix, production gates, and diagnostic-retirement decisions are in [docs/qt-to-tauri-migration.md](docs/qt-to-tauri-migration.md).

## Migration Status

- The formal Tauri operator surface now covers overview, camera configuration and readback, parameterized realtime preview (`width/dataMode/fpsLimit/hs`), merged provider/operation logs, per-camera batch results, automatic six-camera capture-and-fit calibration review/activation, durable production controls, inspection records, and persistent alarms.
- Rust persists and serializes `steel-info -> steel-in -> capture-once -> steel-out` work (plus algorithm and generic trigger tasks), while the headless C++ process owns all SDK and frame-storage work.
- Real six-camera calibration apply/rollback uses a persistent Rust `operationId` ledger and a C++ write-ahead rollback manifest. Every formal mapping requires an expected camera SN and a known-good `rollbackPath`; C++ stages immutable copies with SHA-256 before the first SDK write. Interrupted or undecidable work closes Rust readiness and device writes with an HTTP 423 fence, and only a provider-confirmed parent-bound rollback can move the parent row to `reconciled`—there is no manual “mark successful” shortcut.
- Durable tasks expose operation-specific persisted progress. Hard-timeout SDK workers remain process-owned, poison capture with `49007/restartRequired`, and cannot outlive camera/SDK teardown.
- Online production 3D and point-cloud views are bound to the selected inspection's persisted algorithm artifact; only explicit demo/test data may use bundled surfaces or simulated point clouds.
- Formal runtime and package layouts are Qt-free. Qt is an optional development diagnostic viewer only.
- The Qt-free simulated runtime acceptance has passed. The final six-camera hardware regression for the asynchronous frame-transaction writer, durable device rollback, and vendor SDK persistence is still outstanding and remains a production sign-off gate.
- The live acceptance bundle now ships `test-real-calibration-acceptance.ps1`: dry-run is the default, while real apply/rollback requires a reviewed six-camera plan, an `admin.config` token, an explicit mutation switch, and an exact safety phrase. Integrated `-RequireFullCoverage` cannot pass when this real calibration stage is omitted.
- Controlled process-crash recovery is available through `test-real-calibration-crash-recovery.ps1`. Its failpoint is disabled by default and bound to an exact confirmation, apply operation ID, phase, and camera index. Full live coverage requires successful ApplyCrash and RollbackCrash Resume reports; interrupted rollback reconciliation preserves the original apply correlation explicitly.
- `test-real-calibration-integrity-generation.ps1` completes the remaining rollback-safety evidence by proving stale-generation and staged-hash rejection are zero-write decisions before restoring the staged bytes and validating all six cameras.

## Quick Start

Choose an environment template from [config/env](config/env), or pass values on the command line.

Build the headless capture provider:

```powershell
scripts/build-capture-headless.ps1
```

Build the Rust service and client independently:

```powershell
scripts/build-service.ps1
scripts/build-trigger-gateway.ps1
scripts/build-client.ps1
```

Run the Rust service with the headless provider:

```powershell
scripts/run-service.ps1 -Provider headless-cpp
```

Or with an env file:

```powershell
scripts/run-service.ps1 -EnvFile config/env/headless-cpp.env.example
```

Run the standalone trigger gateway in another terminal. Rust readiness remains false until the required gateway is reachable:

```powershell
scripts/run-trigger-gateway.ps1 -EnvFile config/env/trigger-gateway.env.example
```

Run the web client in another terminal:

```powershell
scripts/run-client-dev.ps1 -ServicePort 4873 -VitePort 1432
```

Or with the client env template:

```powershell
scripts/run-client-dev.ps1 -EnvFile config/env/client.env.example
```

Serve the already built frontend without Vite:

```powershell
scripts/run-client-static.ps1 -Port 1432
```

Run the Tauri desktop shell in another terminal:

```powershell
scripts/run-tauri-dev.ps1 -ServicePort 4873
```

To start the already-built headless capture, Rust, trigger, and static-client processes together, use:

```powershell
scripts/start-integrated-capture-management.ps1 -TriggerMode manual -OpenBrowser
```

## Optional Qt Diagnostic Viewer

Qt is not part of the formal production runtime. The headless C++ process owns the camera SDK; Tauri is the operator client. The current diagnostic binary still requires a Qt kit matching the camera SDK import library, so use Qt `msvc*_64` with the current LVM SDK.

```powershell
scripts/list-qt-kits.ps1 -QtRoot C:/Qt
scripts/build-capture-qt.ps1 -QtPrefixPath C:/Qt
scripts/start-capture-stack.ps1 -WithQtViewer
```

`-WithQtViewer` starts the headless provider first and sets `CAPTURE_QT_API_AUTOSTART=0` for Qt, preventing a second formal SDK/API owner.

## Verification

Run the architecture verification suite:

```powershell
scripts/verify-independent-architecture.ps1
```

This checks the client/service/capture boundaries, runs tests, builds the service, builds the frontend, builds the headless capture provider, verifies Rust can proxy to an independently started external capture provider, and creates the runtime package folders. Add `-CheckQt` after installing a matching Qt MSVC kit.

Run the Qt-free packaged simulated acceptance independently with:

```powershell
scripts/test-runtime-acceptance.ps1
```

This validates the runtime layout and the simulated service/trigger/client flow, including persisted durable steel tasks. It has passed for the migrated architecture. Real production sign-off still requires `scripts/test-real-hardware-acceptance.ps1 -RunCapture` plus the six-camera SDK frame-transaction checks described in [docs/qt-to-tauri-migration.md](docs/qt-to-tauri-migration.md).

Stop local runtime processes:

```powershell
scripts/stop-runtime.ps1
```

Create deployable runtime folders:

```powershell
scripts/package-runtime.ps1
```

The formal Qt-free package is written to `target/packages/steel-inspection-runtime` and includes root-level launch scripts for capture, service, simulated service, and process shutdown.
It also includes `run-client-static.ps1` for serving the packaged frontend independently.

Package the optional Qt diagnostic viewer too:

```powershell
scripts/package-runtime.ps1 -IncludeQt -QtPrefixPath C:/Qt
```
