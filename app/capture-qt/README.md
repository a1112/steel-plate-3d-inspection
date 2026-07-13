# Qt Capture Terminal

Optional development diagnostic viewer for the steel inspection capture API. Tauri is the formal operator UI.

The current compatibility binary still links `steel_capture_core`, but the formal runtime starts `steel_capture_service.exe` first and launches Qt with `CAPTURE_QT_API_AUTOSTART=0`. In that mode Qt is an HTTP client and must not start a second capture API or SDK session.

## Current Capabilities

- Can start the embedded capture API on `127.0.0.1:4317` only for legacy isolated diagnostics; formal startup disables it.
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
- Provides a separate automatic calibration workspace with original/corrected cross-section rendering, fit metrics, per-camera X/Z corrections, active calibration version tracking, and a confirmed global apply action.
- Renders calibration cross-sections directly from `cross_section_points.csv`; generated PNG previews remain file artifacts but are not used as the in-app calibration preview.
- Applies per-camera calibration files through `/api/calibration/load`, tracks array-calibration profile pointers through `/api/calibration/active`, applies global calibration versions through `/api/calibration/apply-all`, and saves current camera parameters when requested.
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

## Run as an Optional Diagnostic Viewer

Start the formal headless stack and request the viewer explicitly:

```powershell
scripts/start-capture-stack.ps1 -WithQtViewer
```

The script sets `CAPTURE_QT_API_AUTOSTART=0`; the headless C++ process remains the only formal camera SDK/API owner. The legacy `qt-terminal` provider mode is compatibility-only and is not part of production startup.
