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

For the current six-camera hardware setup, use the stack starter to launch the headless provider, apply the active `current-6-soft-trigger` profile, preserve the vendor/device-side time-trigger parameters, and open the Qt viewer:

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
POST /api/production/algorithm/run
POST /api/production/defect
```

The standalone trigger gateway is a separate executable for L2/PLC/API integration:

```powershell
scripts/run-trigger-gateway.ps1 -EnvFile config/env/trigger-gateway.env.example
```

The source project lives in `app/trigger` and communicates with the Rust service only through HTTP APIs. It forwards `/api/trigger/*`, `/api/plc/*`, and `/api/l2/*` requests to the Rust production API. Use `-Mode api` for direct API-controlled in/out steel, `-Mode gray` when an external grayscale/sensor-side trigger owns the in/out decision, `-Mode secondary` for L2/二级 tagging, and `-Mode manual` to enable the local manual steel-in/out page at `http://127.0.0.1:4881/manual`.

For a local integrated run that starts the capture provider, Rust service, trigger gateway, and static client from existing `target` build outputs:

```powershell
scripts/start-integrated-capture-management.ps1 -TriggerMode manual -OpenBrowser
```

This waits for `http://127.0.0.1:4317/health`, `http://127.0.0.1:4873/api/production/status`, `http://127.0.0.1:4881/api/trigger/status`, and the built client page at `http://127.0.0.1:1432/?app=terminal`. Use `-NoQt` to skip the Qt viewer or `-StopExisting` to first stop known project executables and listeners on the selected ports.

To verify the integrated management flow without cameras, run the simulated smoke test:

```powershell
scripts/test-integrated-management-smoke.ps1
```

It starts the Rust service in simulated provider mode, starts the standalone trigger gateway, serves the built terminal client, checks the service-side network monitor API, checks that manual steel-in is rejected outside manual mode, then verifies steel-info, steel-in, record-before-capture, steel-out, and final session status.

To verify only the generated runtime folder layout without starting services:

```powershell
scripts/test-runtime-layout.ps1
```

To run the folder acceptance check against `target/runtime`, including layout plus the simulated service/trigger/client smoke flow:

```powershell
scripts/test-runtime-acceptance.ps1
```

After the real stack is already running, verify the live endpoints without starting or stopping any process:

```powershell
scripts/test-integrated-runtime-ready.ps1
```

For real six-camera hardware acceptance, start the capture provider, Rust service, trigger gateway, and terminal client first. The default command is read-only and checks live APIs, camera discovery, camera config readback, `H:\camera1..camera6` storage mapping, network monitoring, and latest-artifact metadata:

```powershell
scripts/test-real-hardware-acceptance.ps1
```

For a single combined live-stack report that runs runtime layout, live readiness, real-hardware read-only checks, and UI smoke:

```powershell
scripts/test-integrated-capture-management-full.ps1
```

Add `-RunCapture`, `-RunBarSurface`, or `-RunShortStability` to include one production capture, the 3D reconstruction acceptance loop, or a production stability loop in the same report. Use `-RequireFullCoverage` when the report must fail if any required live-stack, hardware, UI, trigger-route, storage, or 3D reconstruction coverage item is skipped. By default `-RunShortStability` runs `-StabilityCycles 1`; use `-StabilityUseTriggerGateway` when the same report must prove the production cycle enters through the trigger gateway, and use a duration when the same combined report should include a soak test:

```powershell
scripts/test-integrated-capture-management-full.ps1 -RunShortStability -StabilityUseTriggerGateway -RunBarSurface -RequireFullCoverage -StabilityDurationSec 600 -StabilityIntervalSec 2
```

For a shorter full-coverage live acceptance run, keep the same switches and reduce the duration, for example `-StabilityDurationSec 45 -StabilityIntervalSec 0`. The generated JSON includes `coverage.full`, `coverage.covered`, `coverage.required`, and per-item skipped/uncovered reasons.

To run one real production capture round through the Rust service and verify `H:\camera1..camera6\<material>\{depth,intensity,metadata}` with `sdk-derived` disabled:

```powershell
scripts/test-real-hardware-acceptance.ps1 -RunCapture
```

The capture mode also checks that provider capture is parallel, that the Rust service writes the production summary to `H:\production\<material>\<session>\summary.json`, that `summaryOutput` and `latestInspection.summaryPath` both point to that production summary, that the final `steel.production.summary.v1` file lists depth/intensity/metadata files for all six cameras with `sdk-derived` disabled, and that `activeSession` is cleared after steel-out.

For repeated in/out steel stability checks, use:

```powershell
scripts/test-production-stability.ps1 -MaxCycles 2
scripts/test-production-stability.ps1 -DurationSec 600 -RunAlgorithmEvery 10
```

Each cycle creates a unique material id, records steel-in before capture, runs parallel production capture, writes `H:\camera1..camera6\<material>\{depth,intensity,metadata}`, verifies the final `steel.production.summary.v1`, clears `activeSession` through steel-out, and optionally runs 3D reconstruction every N cycles.

The packaged `current-6-soft-trigger` profile defaults to `loadCameraParams:false` and `changeStorage:false`. Startup therefore uses the camera's current built-in/device parameters and the already verified time-trigger setup. The bundled `.nccfg` files are kept under `config\capture\camera-params\current-6-soft-trigger` for explicit operator/API loading, backup, or comparison; they are not a startup prerequisite.

The terminal header reads realtime network counters from the Rust service:

```http
GET /api/system/network
```

The service derives upload and download Mbps from consecutive byte-counter samples, and the frontend shows those values in the `报级器网口` popover as monitoring-only fields. The UI must not expose upload, download, QoS, or bandwidth limit controls.

After the real stack and client are running, use the UI smoke test to verify that the terminal page shows realtime upload, realtime download, and bandwidth monitoring in the receiver network popover:

```powershell
scripts/test-runtime-ui-smoke.ps1 -ClientOrigin http://127.0.0.1:1432/?app=terminal
```

The script launches headless Edge/Chrome through DevTools, checks the terminal, capture, and 3D reconstruction pages, then writes screenshots and `ui-smoke-report.json` under `target\logs\ui-smoke`.

To estimate conservative X/Z translation corrections from a static round-steel cross-section and write a reviewable calibration XML copy:

```powershell
python scripts/fit_array_calibration_cross_section.py `
  --calibration E:\steel-capture-data\config\camera-params\current-6-soft-trigger\ArrayCalibration.xml `
  --data-dir E:\steel-capture-data\continuous-test\calibration-retake-20260707-142028 `
  --rows 250,500,750
```

For the production six-camera layout on `H:\camera1..camera6\<material>\{depth,intensity,metadata}`, use:

```powershell
python scripts/fit_array_calibration_cross_section.py `
  --capture-root H:\ `
  --material-id BAR-E2E-20260708-013823 `
  --calibration E:\steel-capture-data\config\calibrations\current-6-soft-trigger\array-calibration-fit-20260707-151317\ArrayCalibration.corrected.xml `
  --rows 250,500,750
```

The fitter writes `ArrayCalibration.corrected.xml`, before/after cross-section previews, `fit_report.json`, `camera_corrections.csv`, and `cross_section_points.csv` under `E:\steel-capture-data\analysis\array-calibration-fit-*`. Qt uses the point CSV to render the cross-section directly in the calibration workspace instead of displaying a static preview image. The fitter never overwrites the production calibration file.

## Rust Service Only

```powershell
scripts/build-service.ps1
scripts/build-trigger-gateway.ps1
scripts/run-service.ps1 -Provider simulated
```

Equivalent env-file mode:

```powershell
scripts/run-service.ps1 -EnvFile config/env/simulated.env.example
```

## Bar Surface Algorithm Core

The Python prototype writes reconstruction runs under `G:\bar-surface-algorithm`.
Build the C++ core and convert a prototype mesh into the compact binary model:

```powershell
scripts/build-algorithm-core.ps1

$latest = Get-Content -Raw G:\bar-surface-algorithm\latest.json | ConvertFrom-Json
target/algorithm-core/Release/steel_bar_surface_core.exe --manifest $latest.manifestPath
```

The core writes `mesh/bar_surface.bsmesh` and `mesh/bar_surface_core_summary.json`
beside the Python `bar_surface_mesh.json`.

The prototype crops in two stages by default. It first uses the active
`ArrayCalibration.xml` to project sampled depth pixels into 3D, fits the round
bar X/Z contour, and derives per-camera 2D crop boxes from that calibrated 3D
contour. It then clips the final mesh against the fitted 3D contour before
writing JSON/OBJ/bsmesh. The manifest and acceptance report expose
`inputCrop`, `mesh.contourCrop`, `quality.contourCrop`, and the frontend shows
`2D裁剪` plus `轮廓裁剪` status. Tunables include
`--contour-radius-tolerance-mm`, `--contour-min-keep-ratio`,
`--contour-min-row-coverage`, `--contour-auto-percentile`, and
`--no-contour-crop`.

To run the full bar-surface acceptance loop through the Rust API:

```powershell
scripts/test-bar-surface-e2e.ps1
```

The script performs manual steel-in, one 6-camera capture round, steel-out, Python
prototype reconstruction, C++ core conversion, and H:/G: artifact checks. To reuse
an existing capture material without writing a new H: sample:

```powershell
scripts/test-bar-surface-e2e.ps1 -MaterialId BAR-E2E-20260708-010650 -SkipCapture
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
target/packages/steel-inspection-runtime/test-integrated-management-smoke.ps1
target/packages/steel-inspection-runtime/test-integrated-runtime-ready.ps1
target/packages/steel-inspection-runtime/test-integrated-capture-management-full.ps1
target/packages/steel-inspection-runtime/test-runtime-acceptance.ps1
target/packages/steel-inspection-runtime/test-real-hardware-acceptance.ps1
target/packages/steel-inspection-runtime/test-runtime-layout.ps1
target/packages/steel-inspection-runtime/stop-runtime.ps1
```

## Target-Local Runtime

For local hardware acceptance, synchronize all compiled executables and DLLs into `target/runtime`:

```powershell
scripts/build-capture-headless.ps1
scripts/build-capture-qt.ps1 -QtPrefixPath C:\Qt
scripts/build-service.ps1
scripts/build-trigger-gateway.ps1
scripts/sync-target-runtime.ps1 -IncludeQt
```

This creates:

```text
target/runtime/capture-headless/
target/runtime/capture-qt/
target/runtime/service/
target/runtime/trigger/
target/runtime/client/
target/runtime/config/
```

The generated run scripts keep temporary runtime config under `target/runtime/config`.
The service SQLite database is `target/runtime/config/service/steel-inspection.sqlite`, and the Qt/capture provider config root is `target/runtime/config/capture`.
The target runtime also includes `test-integrated-management-smoke.ps1`, which can be run from inside `target/runtime` to validate the simulated service + trigger gateway + static client flow without touching cameras.
Use `test-runtime-layout.ps1` from inside `target/runtime` for a static folder-layout check.
Use `test-runtime-acceptance.ps1` from inside `target/runtime` for a one-command folder acceptance check. It uses temporary ports `4973`, `4981`, and `1494` by default and only cleans listeners on those ports.
Use `test-integrated-runtime-ready.ps1` from inside `target/runtime` after starting the real stack to check capture, service, trigger gateway, network monitor, and client page readiness.
Use `test-integrated-capture-management-full.ps1` from inside `target/runtime` after starting the real stack for a combined layout/live-ready/hardware/UI acceptance report; add `-RunCapture`, `-RunBarSurface`, or `-RunShortStability` for deeper live acceptance. Use `-RequireFullCoverage` with `-RunShortStability -StabilityUseTriggerGateway -RunBarSurface` when skipped coverage must fail the report, and use `-StabilityDurationSec 600` when the integrated report should include a ten-minute stability soak.
Use `test-runtime-ui-smoke.ps1` from inside `target/runtime` after starting the real stack and client to screenshot-check terminal/capture/3D pages and the receiver network popover's realtime upload/download monitor.
Use `test-real-hardware-acceptance.ps1` from inside `target/runtime` for read-only six-camera hardware checks, or add `-RunCapture` to run one real production capture round and verify the H-drive production layout.

## Stop Runtime Processes

```powershell
scripts/stop-runtime.ps1
```

By default this stops the known C++/Rust executables and listeners on ports `4317`, `4873`, `4881`, and `1432`, including the PowerShell static client server. Pass `-Ports` when you started the stack on custom ports. Add `-IncludeNode` only when you intentionally want to stop local Node/Vite processes too.
