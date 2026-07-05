# Runtime Scripts

These scripts keep the four runtime boundaries independent.

Environment templates live in `config/env`.

## Headless Capture Provider

```powershell
scripts/build-capture-headless.ps1
scripts/run-capture-headless.ps1 -Port 4317
```

In another terminal:

```powershell
scripts/run-service.ps1 -Provider external-api -CaptureOrigin http://127.0.0.1:4317
```

Equivalent env-file mode:

```powershell
scripts/run-service.ps1 -EnvFile config/env/external-api.env.example
```

## Qt Capture Provider

```powershell
scripts/list-qt-kits.ps1 -QtRoot C:/Qt
scripts/build-capture-qt.ps1 -QtPrefixPath C:/Qt
target/capture-qt/Release/steel_capture_qt_terminal.exe
```

In another terminal:

```powershell
scripts/run-service.ps1 -Provider qt-terminal -CaptureOrigin http://127.0.0.1:4317
```

Equivalent env-file mode:

```powershell
scripts/run-service.ps1 -EnvFile config/env/qt-terminal.env.example
```

To run an operator-style auto-connect and continuous capture test against the active provider:

```powershell
scripts/test-capture-api.ps1 -Origin http://127.0.0.1:4317 -ExpectedCameras 6
```

```powershell
scripts/test-capture-continuous.ps1 -Origin http://127.0.0.1:4317 -ExpectedCameras 6 -Rounds 3 -IntervalMs 500
```

The API smoke script checks endpoint shape and expected error handling. The continuous test discovers cameras through `/api/cameras`, connects them one by one through `/api/camera/connect`, then captures depth maps sequentially through `/api/capture/depth-map`.

## Rust Service Only

```powershell
scripts/build-service.ps1
scripts/run-service.ps1 -Provider simulated
```

Equivalent env-file mode:

```powershell
scripts/run-service.ps1 -EnvFile config/env/simulated.env.example
```

## Client Only

```powershell
scripts/build-client.ps1
scripts/run-client-dev.ps1 -ServicePort 4873 -VitePort 1432
```

Equivalent env-file mode:

```powershell
scripts/run-client-dev.ps1 -EnvFile config/env/client.env.example
```

The client talks to the Rust service. It does not start, link, or own the camera SDK.

To serve a built frontend without Vite:

```powershell
scripts/run-client-static.ps1 -Port 1432
```

## Tauri Desktop Only

Start the Rust service separately, then run:

```powershell
scripts/run-tauri-dev.ps1 -ServicePort 4873
```

Equivalent env-file mode:

```powershell
scripts/run-tauri-dev.ps1 -EnvFile config/env/client.env.example
```

Tauri dev starts only the Vite frontend through `app/client/src-tauri/tauri.conf.json`; it does not start the Rust service.

## Verification

```powershell
scripts/verify-independent-architecture.ps1
```

Use `-CheckQt` after installing a Qt MSVC x64 kit.

To verify only the Rust-to-external-capture-provider boundary:

```powershell
scripts/verify-external-provider.ps1
```

## Package Runtime

```powershell
scripts/package-runtime.ps1
```

This creates independent deployable folders under `target/packages/steel-inspection-runtime`.
Add `-IncludeQt` after building/installing the Qt MSVC kit to package the Qt capture terminal with its Qt runtime DLLs:

```powershell
scripts/package-runtime.ps1 -IncludeQt -QtPrefixPath C:/Qt
```

The package includes root-level launch scripts:

```powershell
target/packages/steel-inspection-runtime/run-capture-headless.ps1
target/packages/steel-inspection-runtime/run-capture-qt.ps1
target/packages/steel-inspection-runtime/run-service-external.ps1
target/packages/steel-inspection-runtime/run-service-simulated.ps1
target/packages/steel-inspection-runtime/run-client-static.ps1
target/packages/steel-inspection-runtime/stop-runtime.ps1
```

## Stop Runtime Processes

```powershell
scripts/stop-runtime.ps1
```

Add `-IncludeNode` to stop local Node/Vite processes too.
