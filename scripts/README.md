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

For the current six-camera hardware setup, use the stack starter to launch the headless provider, apply the active `current-6-soft-trigger` profile, load the saved per-camera `.nccfg` parameters, and open the Qt viewer:

```powershell
scripts/start-capture-stack.ps1 -StopExisting
```

It defaults to `E:\steel-capture-data`, `E:\steel-capture-data\config`, port `4317`, and six expected cameras. Pass `-NoQt` when only the API provider should be started. By default it preserves the saved device/profile parameters, including the vendor-side time-trigger setup; pass `-ApplyPreset` only when you intentionally want to force the generic 1000-line preset from the API.

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

The API smoke script checks endpoint shape and expected error handling. The continuous test discovers cameras through `/api/cameras`, connects them, then starts the provider-side parallel continuous capture endpoint `/api/capture/continuous-test`.

## Production database and trigger gateway

The Rust service defaults to the local SQLite file for development. For the production MySQL database on this machine, set:

```powershell
$env:STEEL_DATABASE_URL = "mysql://root:nercar@127.0.0.1:3306/steel_inspection"
```

The service appends `ssl-mode=disabled` for local MySQL connections when the URL does not specify an SSL mode. Production APIs added for the capture loop are:

```text
GET  /api/production/status
POST /api/production/steel-info
POST /api/production/steel-in
POST /api/production/steel-out
POST /api/production/secondary-data
POST /api/production/capture-once
POST /api/production/capture-summary
POST /api/production/defect
```

The standalone trigger gateway is a separate executable for L2/PLC/API integration:

```powershell
scripts/run-trigger-gateway.ps1 -EnvFile config/env/trigger-gateway.env.example
```

It forwards `/api/trigger/*`, `/api/plc/*`, and `/api/l2/*` requests to the Rust production API. Use `-Mode api` for direct API-controlled in/out steel and `-Mode gray` when an external grayscale/sensor-side trigger owns the in/out decision but the event still needs to be recorded.

To estimate conservative X/Z translation corrections from a static round-steel cross-section and write a reviewable calibration XML copy:

```powershell
python scripts/fit_array_calibration_cross_section.py `
  --calibration E:\steel-capture-data\config\camera-params\current-6-soft-trigger\ArrayCalibration.xml `
  --data-dir E:\steel-capture-data\continuous-test\calibration-retake-20260707-142028 `
  --rows 250,500,750
```

The fitter writes `ArrayCalibration.corrected.xml`, before/after cross-section previews, `fit_report.json`, `camera_corrections.csv`, and `cross_section_points.csv` under `E:\steel-capture-data\analysis\array-calibration-fit-*`. Qt uses the point CSV to render the cross-section directly in the calibration workspace instead of displaying a static preview image. The fitter never overwrites the production calibration file.

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
