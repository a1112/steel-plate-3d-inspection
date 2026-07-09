# Integrated Capture Management Acceptance Matrix

This matrix defines what must be true before the integrated capture-management goal can be treated as accepted on the current six-camera round-steel system.

## Scope

The accepted system is the integrated runtime made of:

- C++ capture provider, either headless or Qt-hosted, as the only process owning LVM/NVT SDK handles.
- Rust inspection service as the production API, database, provider proxy, and orchestration layer.
- Standalone trigger gateway as the API/gray/secondary/manual trigger adapter.
- Tauri/React client as the operator UI for terminal, capture management, configuration, and 3D reconstruction.
- H-drive production storage under `H:\camera1` through `H:\camera6`.
- Bar-surface 3D reconstruction using the corrected calibration and calibrated 3D contour crop.

## Full Coverage Command

Use this command after the real stack and client are already running:

```powershell
scripts/test-integrated-capture-management-full.ps1 `
  -RunShortStability `
  -StabilityUseTriggerGateway `
  -RunBarSurface `
  -RequireFullCoverage `
  -StabilityDurationSec 45 `
  -StabilityIntervalSec 0
```

For a ten-minute soak, change `-StabilityDurationSec 45` to `-StabilityDurationSec 600` and keep `-RequireFullCoverage`.

After the full coverage report exists, run the itemized audit:

```powershell
scripts/test-integrated-acceptance-audit.ps1
```

The audit report is accepted only when `code=0` and `summary.passed=18`.

The report is accepted only when:

- `code` is `0`.
- `coverage.full` is `true`.
- `coverage.covered` equals `coverage.required`.
- `coverage.uncovered` is empty.
- No required check is skipped.

## Requirement Matrix

| ID | Requirement | Required evidence |
| --- | --- | --- |
| ICM-01 | Runtime package contains capture provider, Qt viewer, Rust service, trigger gateway, frontend client, config, launch scripts, and acceptance scripts. | `test-runtime-layout.ps1` passes in `target/runtime` and `target/packages/steel-inspection-runtime`. |
| ICM-02 | Runtime boundaries remain independent: client calls Rust only, trigger gateway forwards to Rust only, Rust does not link camera SDK, and exactly one capture provider owns SDK handles. | `verify-independent-architecture.ps1 -CheckQt` passes. |
| ICM-03 | Live stack is reachable: capture provider, Rust production API, trigger gateway, network monitor, and terminal client. | `test-integrated-runtime-ready.ps1` passes inside the full coverage report. |
| ICM-04 | Six real cameras are discovered/connected through the LVM/NVT provider and H-drive camera roots are mapped and writable. | `test-real-hardware-acceptance.ps1` passes inside the full coverage report. |
| ICM-05 | Current camera configuration is read back from hardware without silently overwriting the operator's device configuration. | Real-hardware acceptance confirms camera config readback and current profile state. |
| ICM-06 | Trigger flow can enter through the standalone trigger gateway in manual mode and reach Rust production APIs. | Full coverage report includes `trigger-gateway-route` covered by `test-production-stability.ps1 -UseTriggerGateway`. |
| ICM-07 | Production steel-in writes the inspection/session record before capture starts. | Production stability report shows steel-in and record-before-capture for every cycle. |
| ICM-08 | Capture uses parallel six-camera execution and produces complete frames for all cameras. | Production stability cycles report `parallel=true`, `workerCount=6`, `successes=6`, `completeFrames=6`. |
| ICM-09 | Production storage writes `depth`, `intensity`, and `metadata` under `H:\camera1..camera6\<material>` and keeps `sdk-derived` disabled by default. | Production stability layout for every cycle and the H-drive folder counts. |
| ICM-10 | Production summary is written under `H:\production\<material>\<session>\summary.json` and references all six-camera files. | Production stability `summary` reports schema `steel.production.summary.v1`, 18 files, six depth, six intensity, six metadata. |
| ICM-11 | Steel-out ends the session and clears active capture/save state. | Production stability post-status shows no active session after every cycle. |
| ICM-12 | Terminal UI, capture management UI, and 3D reconstruction UI render and expose key controls. | `test-runtime-ui-smoke.ps1` passes inside the full coverage report. |
| ICM-13 | Receiver network popover shows monitoring-only realtime upload, realtime download, and bandwidth fields, with no limiting controls or estimated-speed fallback. | UI smoke checks the receiver popover, `/api/system/network` rate fields, and verifies that `estimated-speed fallback` is absent. |
| ICM-14 | Latest six-camera production capture can be consumed by the bar-surface reconstruction API. | `test-bar-surface-e2e.ps1 -SkipCapture -MaterialId <latest>` passes inside the full coverage report. |
| ICM-15 | 3D reconstruction outputs mesh, texture, artifact index, acceptance report, and C++ core binary output. | Bar-surface e2e report includes manifest, artifact index, acceptance report, and nonzero core bytes. |
| ICM-16 | 3D contour crop is applied from calibrated 3D data, not a static image-only preview. | Bar-surface e2e manifest reports `contourCrop.applied=true` and `contourCrop.source=calibrated-3d`. |
| ICM-17 | Qt capture viewer builds and packages with the required Qt DLLs and SDK DLL. | `build-capture-qt.ps1 -QtPrefixPath C:\Qt`, `package-runtime.ps1 -IncludeQt`, and package layout pass. |
| ICM-18 | The full coverage acceptance command is shipped in the package and cannot silently lose coverage checks. | `test-runtime-layout.ps1` and `verify-independent-architecture.ps1` require `RequireFullCoverage`, `coverage`, and `trigger-gateway-route` text in packaged scripts. |

## Current Evidence Snapshot

Latest full coverage report:

```text
D:\project\steel-plate-3d-inspection\target\logs\integrated-capture-management\integrated-capture-management-20260709-111851-322.json
D:\project\steel-plate-3d-inspection\target\logs\integrated-capture-management\integrated-capture-management-20260709-121522-831.json
```

Observed result:

- `code=0`
- `coverage.full=true`
- `coverage.covered=7`
- `coverage.required=7`
- short stability material: `BAR-STABILITY-20260709-121618-010`
- short stability cycles: `10/10`, failures `0`
- short capture frames: `60`
- short metadata frames: `60`
- itemized audit: `18/18` requirements pass
- latest source audit report: `D:\project\steel-plate-3d-inspection\target\logs\integrated-capture-management\acceptance-audit-20260709-125503-276.json`
- latest runtime audit report: `D:\project\steel-plate-3d-inspection\target\runtime\logs\integrated-capture-management\acceptance-audit-20260709-125850-744.json`
- latest package audit report: `D:\project\steel-plate-3d-inspection\target\packages\steel-inspection-runtime\logs\integrated-capture-management\acceptance-audit-20260709-130111-474.json`
- UI smoke: terminal/capture/3D reconstruction pages pass, receiver network popover shows realtime upload/download/bandwidth and rejects `estimated-speed fallback`
- latest UI smoke report: `D:\project\steel-plate-3d-inspection\target\runtime\logs\ui-smoke\20260709-125221-272\ui-smoke-report.json`
- 3D acceptance: `pass`
- contour crop source: `calibrated-3d`
- mesh: `20736` vertices, `37648` triangles

Latest ten-minute stability evidence:

```text
D:\project\steel-plate-3d-inspection\target\logs\production-stability\production-stability-20260709-114934-134.json
```

Observed result:

- `code=0`
- trigger gateway route: manual mode through `/api/trigger/manual/steel-in`
- latest material: `BAR-STABILITY-20260709-114929-127`
- stability cycles: `127/127`, failures `0`
- capture frames: `762`
- metadata frames: `762`
- parallel capture: `workerCount=6`, `parallel=true`
- per-camera latest layout: one `depth`, one `intensity`, one `metadata`
- `sdk-derived`: disabled
- latest production summary: `H:\production\BAR-STABILITY-20260709-114929-127\BAR-STABILITY-20260709-114929-127-1783568969382\summary.json`

Latest 3D reconstruction evidence:

```text
G:\bar-surface-algorithm\runs\BAR-STABILITY-20260709-114929-127\BAR-STABILITY-20260709-114929-127-20260709-115115\manifest.json
```

Observed result:

- acceptance: `pass`
- corrected calibration: `E:\steel-capture-data\config\calibrations\current-6-soft-trigger\array-calibration-fit-20260707-151317\ArrayCalibration.corrected.xml`
- calibrated cameras: `6/6`
- contour crop source: `calibrated-3d`
- input crop source: `calibrated-3d-contour`
- mesh: `20736` vertices, `38198` triangles
- texture: `3072 x 96`

Ten-minute H-drive evidence:

```text
H:\camera1\BAR-STABILITY-20260709-114929-127
H:\camera2\BAR-STABILITY-20260709-114929-127
H:\camera3\BAR-STABILITY-20260709-114929-127
H:\camera4\BAR-STABILITY-20260709-114929-127
H:\camera5\BAR-STABILITY-20260709-114929-127
H:\camera6\BAR-STABILITY-20260709-114929-127
```

Each camera folder contains one `depth`, one `intensity`, and one `metadata` file for the accepted ten-minute stability material, and no `sdk-derived` folder.

## Remaining Acceptance Notes

- The ten-minute stability run above is the current endurance evidence. Longer production soaks can reuse the same command with a larger `-StabilityDurationSec`.
- The current goal excludes downstream defect algorithm implementation beyond bar-surface reconstruction acceptance.
- Qt deployment warnings about `dxcompiler.dll`, `dxil.dll`, or `VCINSTALLDIR` are acceptable for the current Qt Widgets viewer unless Direct3D 12-specific features are introduced.
