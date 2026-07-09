# Independent Runtime Architecture

The inspection system is split into five runtime boundaries:

```text
LVM 3D cameras
  -> C++ capture core
    -> Qt capture terminal or headless capture service
      -> Rust inspection service
        -> Tauri client

L2 / PLC / external trigger API
  -> standalone trigger gateway
    -> Rust inspection service
```

## Components

### `app/capture`

Shared C++ capture implementation.

- `steel_capture_core`: reusable SDK/API core linked by other capture runtimes.
- `steel_capture_service`: headless executable for service-only deployments.
- Owns LVM SDK calls, camera sessions, parameter reads/writes, software trigger capture, and the local capture HTTP API.

### `app/capture-qt`

Standalone Qt capture terminal.

- Links `steel_capture_core`.
- Starts the same local capture API inside the Qt process.
- Intended for operator-side camera diagnostics, local preview, calibration, and hardware-near workflows.
- Provides its own camera list, health polling, connect/disconnect controls, and selected-camera software trigger capture.
- In this mode the Qt process is the only process that owns camera SDK handles.

### `app/service`

Rust inspection backend.

- Owns business APIs, configuration, admin/auth, database state, inspection records, and service monitoring.
- Owns production database writes for material sessions, secondary data, trigger events, inspection records, capture files, and defect records.
- Talks to the configured capture provider through the local capture API.
- Should not call the LVM SDK directly.

### `app/trigger`

Standalone trigger gateway.

- Runs as its own process outside the capture provider, Rust service, Qt terminal, and Tauri client.
- Accepts L2/PLC/API events for steel info, steel-in, steel-out, secondary data, one-shot capture, capture summary, and defect results.
- Tags events with `TRIGGER_MODE=api`, `gray`, `secondary`, or `manual`, then forwards them to the Rust production API. Manual steel-in/out endpoints are blocked unless the gateway mode is `manual`.
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
  Rust connects to a separately started Qt capture terminal.

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

- Exactly one process may own camera SDK handles.
- The Rust service is the API gateway and business orchestrator, not a camera driver.
- The standalone trigger gateway is the integration adapter for L2/PLC/gray-sensor events; it forwards to Rust instead of touching SDK handles.
- The Tauri client is a UI shell and must keep using Rust APIs.
- Qt and headless C++ modes expose the same local capture API contract.
- If Qt mode is enabled, Rust must not autostart another headless C++ capture process.

The API boundary is documented in [capture-api-contract.md](capture-api-contract.md).

## Recommended Startup

Headless service mode:

```powershell
scripts/build-capture-headless.ps1
scripts/run-service.ps1 -Provider headless-cpp
```

Qt terminal mode:

```powershell
scripts/build-capture-qt.ps1 -QtPrefixPath C:/Qt
target/capture-qt/Release/steel_capture_qt_terminal.exe
scripts/run-service.ps1 -Provider qt-terminal -CaptureOrigin http://127.0.0.1:4317
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
