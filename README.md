# Steel Plate 3D Inspection

Steel plate 3D inspection workspace with independent runtime boundaries:

```text
LVM/NVT cameras
  -> C++ capture provider: app/capture or app/capture-qt
  -> Rust service: app/service
  -> Tauri/React client: app/client
```

## Runtime Boundaries

- `app/capture`: C++ SDK capture core plus headless local API executable.
- `app/capture-qt`: standalone Qt capture terminal that links the capture core and owns camera SDK handles.
- `app/service`: Rust backend for business APIs, configuration, records, auth, and capture provider proxying.
- `app/client`: Tauri/React client. It calls Rust only and does not link or ship the camera SDK.

The capture API contract is documented in [docs/capture-api-contract.md](docs/capture-api-contract.md). The full architecture notes are in [docs/independent-architecture.md](docs/independent-architecture.md).

## Quick Start

Choose an environment template from [config/env](config/env), or pass values on the command line.

Build the headless capture provider:

```powershell
scripts/build-capture-headless.ps1
```

Build the Rust service and client independently:

```powershell
scripts/build-service.ps1
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

## Qt Capture Terminal

The Qt capture terminal requires a Qt kit matching the camera SDK import library. With the current LVM SDK, use Qt `msvc*_64`. The local `mingw_64` Qt kit cannot link the MSVC SDK.

```powershell
scripts/list-qt-kits.ps1 -QtRoot C:/Qt
scripts/build-capture-qt.ps1 -QtPrefixPath C:/Qt
```

Then run the Rust service against the Qt provider:

```powershell
scripts/run-service.ps1 -Provider qt-terminal -CaptureOrigin http://127.0.0.1:4317
```

## Verification

Run the architecture verification suite:

```powershell
scripts/verify-independent-architecture.ps1
```

This checks the client/service/capture boundaries, runs tests, builds the service, builds the frontend, builds the headless capture provider, verifies Rust can proxy to an independently started external capture provider, and creates the runtime package folders. Add `-CheckQt` after installing a matching Qt MSVC kit.

Stop local runtime processes:

```powershell
scripts/stop-runtime.ps1
```

Create deployable runtime folders:

```powershell
scripts/package-runtime.ps1
```

The package is written to `target/packages/steel-inspection-runtime` and includes root-level launch scripts for capture, service, simulated service, and process shutdown.
It also includes `run-client-static.ps1` for serving the packaged frontend independently.

Package the Qt capture terminal too:

```powershell
scripts/package-runtime.ps1 -IncludeQt -QtPrefixPath C:/Qt
```
