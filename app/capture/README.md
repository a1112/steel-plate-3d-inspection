# Capture Core And Headless Service

Local C++ capture implementation for Capture 6.7 LVM 3D camera control and offline simulated cameras.

This project now builds:

- `steel_capture_core`: reusable C++ SDK/API core.
- `steel_capture_service`: headless local API executable.

The standalone Qt terminal in `app/capture-qt` links the same core so the SDK logic is not duplicated.

## Build

```powershell
scripts/build-capture-headless.ps1
```

The build auto-detects the installed SDK under common Capture 6.7.0.8 and 6.7.0.4 paths, or uses `CAPTURE_SDK_ROOT` when passed to CMake. It links against:

`C:\Program Files (x86)\Capture <version>\LVM_NVT_SDK\LVM_C++_SDK\x64`

## Run

```powershell
scripts/run-capture-headless.ps1 -Port 4317
```

For the current six-camera hardware profile, prefer the stack starter:

```powershell
scripts/start-capture-stack.ps1 -StopExisting
```

It starts the provider on port `4317`, uses `E:\steel-capture-data`, applies `current-6-soft-trigger`, loads the saved per-camera `.nccfg` parameters, and opens the Qt viewer. By default it preserves the vendor-side time-trigger setup; pass `-ApplyPreset` only when you intentionally want to force the generic 1000-line preset from the API.

Run without cameras:

```powershell
target/capture/Release/steel_capture_service.exe --port 4317 --driver simulated
```

When Rust runs with `STEEL_CAPTURE_PROVIDER=headless-cpp`, it can start this executable automatically. When Rust runs with `STEEL_CAPTURE_PROVIDER=qt-terminal`, start the Qt terminal instead and do not run this headless executable at the same time.

The Tauri client no longer builds or links this project. Build this capture runtime explicitly from `app/capture`, then point the Rust service at it.

## API

- `GET /health`
- `GET /api/storage/status`
- `POST /api/storage/config` with `{"root":"E:/steel-capture-data"}`
- `GET /api/config/status`
- `GET /api/config/profile?name=default`
- `POST /api/config/profile/save` with `{"name":"default","profileJson":"{...}","makeActive":true}`
- `POST /api/config/profile/apply` with `{"name":"default","autoConnect":true,"expectedCameras":6}`
- `POST /api/config/profile/import` with `{"path":"D:/configs/offline","overwrite":false}`
- `POST /api/config/camera-params/save-all` with `{"name":"default","cameraParamDir":"config/camera-params/default"}`
- `POST /api/config/camera-params/load-all` with `{"name":"default","cameraParamDir":"config/camera-params/default"}`
- `GET /api/cameras`
- `POST /api/camera/connect` with `{"ip":"192.168.10.13","devType":-1}`
- `POST /api/cameras/connect-all` with `{"expectedCameras":6,"devType":-1}`
- `POST /api/camera/disconnect`
- `GET /api/camera/status`
- `GET /api/param?key=ExposureTime&type=int`
- `POST /api/param` with `{"key":"ExposureTime","type":"int","value":50}`
- `POST /api/preview/capture` with optional `{"ip":"192.168.10.13","lines":1280,"width":0,"timeoutMs":5000,"dataMode":3}`
- `POST /api/capture/depth-map` with optional `{"lines":1280,"width":4096,"timeoutMs":5000,"dataMode":3,"output":"capture-depth.png"}`
- `POST /api/capture/continuous-test` with optional `{"expectedCameras":6,"rounds":3,"lines":1280,"intervalMs":500,"dataMode":3,"outputDir":"continuous-test","connectFirst":true}`
- `GET /api/capture/file?path=E%3A%5Csteel-capture-data%5CCAM-01%5Cdepth.png`
- `GET /api/steel/status`
- `POST /api/steel/event` with `{"cmd":"rcvSteelInfo","id":"STEEL-001","steelType":"Q235","length":12000,"width":1800,"thick":12.5}`
- `POST /api/steel/event` with `{"cmd":"steelIn","value":1}` for entry-steel and `{"cmd":"steelIn","value":0}` for exit-steel
- `POST /api/stream/start` with `{"ip":"192.168.10.13","lines":1280,"width":4096,"dataMode":1,"hs":false,"fpsLimit":5}`
- `POST /api/stream/stop` with `{"ip":"192.168.10.13"}`
- `GET /api/stream/status?ip=192.168.10.13`
- `GET /api/stream/latest?ip=192.168.10.13&kind=depth`
- `POST /api/calibration/load` with `{"ip":"192.168.10.13","path":"D:/calibration/CAM-01.xml"}`
- `GET /api/calibration/active?profile=current-6-soft-trigger`
- `POST /api/calibration/active` with `{"name":"current-6-soft-trigger","path":"config/calibrations/current-6-soft-trigger/<version>/ArrayCalibration.corrected.xml"}`
- `POST /api/calibration/apply-all` with `{"name":"current-6-soft-trigger","path":"config/calibrations/current-6-soft-trigger/<version>/ArrayCalibration.corrected.xml","saveCameraParams":true,"saveToDevice":true,"applySoftTrigger":false}`
- `POST /api/roi/load` with `{"ip":"192.168.10.13","path":"D:/calibration/CAM-01-roi.xml"}`
- `GET /api/calibration/status?ip=192.168.10.13`

Relative output paths are stored under `CAPTURE_STORAGE_ROOT`, or `E:\steel-capture-data` by default when drive `E:` exists. Realtime stream start uses the LVM async path and keeps only one stream active in the provider process. Blocking depth capture rejects requests while a realtime stream is running for the same camera. Continuous-test capture runs one worker thread per camera in each round and releases the workers through a shared start gate; the response includes `parallel`, `syncMode`, `workerCount`, and per-frame worker timestamps. Frame files are grouped under each camera directory by peer artifact folders: `depth/`, `intensity/`, `metadata/`, and `sdk-derived/`.

The current six-camera production baseline is continuous line capture with software control, vendor time trigger source, 1000 lines, and depth + intensity output: `controlMode=0`, `triggerInputType=4`, `lines=1000`, `dataMode=3`. Qt exposes operator tests only through the top `测试` dialog; the overview page is for runtime state and conservative global control.

`steelIn:value=1` opens a production session under `<storageRoot>/production/<steel-id>/<session-id>/` and writes `summary.json`. If a capture request omits `output`, or a continuous-test request omits `outputDir`, raw capture artifacts use the production raw-data layout:

```text
<storageRoot>/<camera-id>/<material-id>/<data-name>/<sequence>.<extension>
```

For example:

```text
E:\steel-capture-data\3G506401BE08818\MAT-20260707-001\depth\000001.png
E:\steel-capture-data\3G506401BE08818\MAT-20260707-001\intensity\000001.png
E:\steel-capture-data\3G506401BE08818\MAT-20260707-001\metadata\000001.json
```

The session summary remains under the `production/<steel-id>/<session-id>/` directory.
