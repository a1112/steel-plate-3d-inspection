# Capture Service

Local C++ service for Capture 6.7.0.4 LVM 3D camera control.

## Build

```powershell
cmake -S app/capture -B app/capture/build -A x64
cmake --build app/capture/build --config Release
```

The build links against:

`C:\Program Files (x86)\Capture 6.7.0.4\LVM_NVT_SDK\LVM_C++_SDK\x64`

## Run

```powershell
app/capture/build/Release/steel_capture_service.exe --port 4317
```

## API

- `GET /health`
- `GET /api/cameras`
- `POST /api/camera/connect` with `{"ip":"192.168.10.13","devType":-1}`
- `POST /api/camera/disconnect`
- `GET /api/camera/status`
- `GET /api/param?key=ExposureTime&type=int`
- `POST /api/param` with `{"key":"ExposureTime","type":"int","value":50}`
- `POST /api/capture/depth-map` with optional `{"lines":1280,"width":4096,"timeoutMs":5000,"dataMode":1,"output":"capture-depth.png"}`
