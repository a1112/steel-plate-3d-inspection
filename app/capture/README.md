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
- `POST /api/preview/capture` with optional `{"ip":"192.168.10.13","lines":1280,"width":0,"timeoutMs":5000,"dataMode":1}`
- `POST /api/capture/depth-map` with optional `{"lines":1280,"width":4096,"timeoutMs":5000,"dataMode":1,"output":"capture-depth.png"}`
- `POST /api/capture/continuous-test` with optional `{"expectedCameras":6,"rounds":3,"lines":1280,"intervalMs":500,"outputDir":"continuous-test","connectFirst":true}`
- `GET /api/capture/file?path=E%3A%5Csteel-capture-data%5CCAM-01%5Cdepth.png`
- `POST /api/stream/start` with `{"ip":"192.168.10.13","lines":1280,"width":4096,"dataMode":1,"hs":false,"fpsLimit":5}`
- `POST /api/stream/stop` with `{"ip":"192.168.10.13"}`
- `GET /api/stream/status?ip=192.168.10.13`
- `GET /api/stream/latest?ip=192.168.10.13&kind=depth`
- `POST /api/calibration/load` with `{"ip":"192.168.10.13","path":"D:/calibration/CAM-01.xml"}`
- `POST /api/roi/load` with `{"ip":"192.168.10.13","path":"D:/calibration/CAM-01-roi.xml"}`
- `GET /api/calibration/status?ip=192.168.10.13`

Relative output paths are stored under `CAPTURE_STORAGE_ROOT`, or `E:\steel-capture-data` by default when drive `E:` exists. Realtime stream start uses the LVM async path and keeps only one stream active in the provider process. Blocking depth capture rejects requests while a realtime stream is running for the same camera.
