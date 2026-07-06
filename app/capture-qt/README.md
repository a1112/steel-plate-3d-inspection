# Qt Capture Terminal

Standalone operator-facing capture terminal for the steel plate 3D inspection system.

This app links the shared `steel_capture_core` library from `app/capture` and starts the same local capture API inside the Qt process. The Rust service should connect to it as an external provider instead of starting another headless capture process.

## Current Capabilities

- Starts the embedded capture API on `127.0.0.1:4317` by default.
- Can switch the embedded capture provider between the real LVM SDK driver and the offline simulated driver.
- Provides a three-column acquisition workstation: camera list, selected-camera preview, and status/control/calibration/log tabs.
- Provides a configuration management page for creating folder-backed profiles, importing profiles, and setting the active/default profile.
- Lists the six expected cameras returned by `/api/cameras` and polls `/api/camera/statuses`.
- Connects, auto-connects, disconnects, and disconnects all cameras while keeping all camera control in software trigger mode.
- Starts and stops selected-camera realtime preview through `/api/stream/start` and `/api/stream/stop`.
- Shows latest depth heatmap or intensity PNG from `/api/stream/latest`.
- Controls exposure, gain, acquisition lines, width, timeout, high-speed mode, trigger frequency, and arbitrary SDK params.
- Captures validation frames through `/api/capture/depth-map`.
- Runs continuous capture tests for all discovered cameras or the selected camera, with configurable rounds, interval, and output directory.
- Applies calibration files through `/api/calibration/load`, ROI files through `/api/roi/load`, and saves local calibration records.
- Opens `/ui` in the system browser for low-level API diagnostics.

## Build

Use a Qt kit that matches the Capture SDK toolchain. The LVM SDK import library is MSVC x64, so the Qt terminal should be built with a Qt `msvc*_64` kit, not `mingw_64`.

```powershell
scripts/list-qt-kits.ps1 -QtRoot C:/Qt
scripts/build-capture-qt.ps1 -QtPrefixPath C:/Qt
```

The local machine should use a Qt MSVC x64 kit such as `C:/Qt/6.11.1/msvc2022_64`. A MinGW kit cannot link the MSVC LVM SDK import library.

## Offline Simulation

Set `CAPTURE_DRIVER=simulated` before launching, or create/apply a simulated profile from the configuration management page. Simulated profiles can set the camera count, image storage root, and an optional PNG replay folder.

## Run With Rust Service

Start the Qt terminal first, then run the Rust service with:

```powershell
scripts/run-service.ps1 -Provider qt-terminal -CaptureOrigin http://127.0.0.1:4317
```

Only the Qt terminal owns the camera SDK handles in this mode.
