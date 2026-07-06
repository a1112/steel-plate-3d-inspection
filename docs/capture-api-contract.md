# Capture API Contract

The Qt capture terminal and the headless C++ capture service must expose the same HTTP API. The Rust service treats either process as a capture provider.

Default origin:

```text
http://127.0.0.1:4317
```

The Rust service reads the provider origin from:

```powershell
$env:CAPTURE_SERVICE_ORIGIN='http://127.0.0.1:4317'
```

The Tauri client must not consume this API directly. It calls the Rust service, and the Rust service proxies to the configured provider.

## Health

```http
GET /health
GET /api/capture/health
```

Returns SDK status and provider identity.

Required fields:

- `service`
- `time`
- `sdkReady`
- `sdkCode`
- `driverMode`
- `driverId`
- `driverName`
- `storageRoot`
- `configRoot`
- `cameraCount`

## Storage

Data is stored under the provider storage root. The default is `CAPTURE_STORAGE_ROOT` when set, otherwise `E:\steel-capture-data` when drive `E:` exists, otherwise a local `captures` directory.

```http
GET /api/storage/status
```

```http
POST /api/storage/config
Content-Type: application/json

{"root":"E:/steel-capture-data"}
```

Relative capture outputs are resolved under the current storage root. Absolute outputs must also stay inside the configured storage root.

## Global Configuration Profiles

Provider-level configuration is stored under `CAPTURE_CONFIG_ROOT` when set, otherwise under `%LOCALAPPDATA%/SteelCapture/config`. Legacy profiles under the storage root remain readable:

```text
<configRoot>/profiles/<name>/profile.json
<configRoot>/profiles/<name>/camera-params/<camera-ip>.nccfg
<configRoot>/profiles/<name>/sim-images/
<configRoot>/profiles/<name>/captures/
<configRoot>/active-profile.txt
```

Profiles are ordinary JSON files. They are intended to capture startup mode, storage root, expected camera count, default capture parameters, trigger settings, and the camera parameter-file directory. The Qt viewer uses these APIs, and automation scripts may call the same APIs directly.

```http
GET /api/config/status
GET /api/config/profiles
GET /api/config/profile?name=default
```

```http
POST /api/config/profile/save
Content-Type: application/json

{
  "name": "default",
  "makeActive": true,
  "profileJson": "{\"schema\":\"steel.capture.profile.v1\",\"name\":\"default\"}"
}
```

`profileJson` is saved as the profile body. If `profileJson` is omitted, the request body itself is saved as the profile. New saves use the folder-backed profile layout above; legacy `<name>.json` files remain readable.

```http
POST /api/config/profile/import
Content-Type: application/json

{
  "path": "D:/capture-configs/offline-sim",
  "name": "offline-sim",
  "overwrite": false,
  "makeActive": true
}
```

The import path may be a folder containing `profile.json` or a legacy `.json` profile file.

```http
POST /api/config/profile/apply
Content-Type: application/json

{
  "name": "default",
  "autoConnect": true,
  "loadCameraParams": false,
  "saveToDevice": false,
  "expectedCameras": 6
}
```

Applying a profile can connect discovered cameras, apply trigger/exposure/gain defaults, optionally load camera parameter files, and set the active profile name. `changeStorage` must be true to let a profile switch the provider storage root.

Recommended profile fields:

```json
{
  "schema": "steel.capture.profile.v1",
  "name": "default",
  "driverMode": "lvm",
  "storageRoot": "E:/steel-capture-data",
  "cameraParamDir": "config/camera-params/default",
  "startupMode": "manual",
  "autoConnect": true,
  "expectedCameras": 6,
  "applySoftTrigger": true,
  "loadCameraParams": false,
  "saveToDevice": false,
  "lines": 1000,
  "width": 0,
  "timeoutMs": 8000,
  "dataMode": 1,
  "fpsLimit": 5,
  "controlMode": 2,
  "triggerInputType": 4,
  "divRatio": 4,
  "timeTriggerFreq": 300,
  "exposureTime": 50,
  "gainK": 1.0,
  "simulated": {
    "imageSourceDir": ""
  },
  "cameras": []
}
```

## Camera Parameter Files

The provider exposes batch wrappers around the vendor SDK parameter-file APIs. These are useful for saving one parameter file per connected camera and then switching configurations by profile.

```http
POST /api/config/camera-params/save-all
Content-Type: application/json

{
  "name": "default",
  "cameraParamDir": "config/camera-params/default",
  "applySoftTrigger": true,
  "saveToDevice": false
}
```

```http
POST /api/config/camera-params/load-all
Content-Type: application/json

{
  "name": "default",
  "cameraParamDir": "config/camera-params/default",
  "applySoftTrigger": true,
  "saveToDevice": false
}
```

`save-all` writes files named `<camera-ip-with-underscores>.nccfg`. `load-all` looks for files by safe IP first, then model and serial number. The per-camera low-level APIs remain available:

```http
POST /api/param/save-file
POST /api/param/load-file
POST /api/param/save-device
POST /api/param/recovery
```

## Camera Discovery

```http
GET /api/cameras
```

Returns:

```json
{
  "cameras": [
    {
      "ip": "192.168.105.13",
      "model": "LVM3450CA",
      "sn": "YF-0263",
      "driverId": "lvm-nvt"
    }
  ]
}
```

## Camera Lifecycle

```http
POST /api/camera/connect
Content-Type: application/json

{"ip":"192.168.105.13","devType":-1}
```

```http
POST /api/cameras/connect-all
Content-Type: application/json

{"expectedCameras":6,"devType":-1}
```

`/api/camera/connect-all` is accepted as an alias. The provider discovers cameras, connects them sequentially, and keeps software trigger mode enabled.

```http
POST /api/camera/disconnect
Content-Type: application/json

{"ip":"192.168.105.13"}
```

The provider should force software trigger mode during connect.

## Camera Status

```http
GET /api/camera/status?ip=192.168.105.13
GET /api/camera/statuses
```

`/api/camera/statuses` returns one status object per connected or configured camera when possible.

Recommended fields:

- `ip`
- `connected`
- `deviceId`
- `driverId`
- `model`
- `sn`
- `acquisitionState`
- `sdkStatus`
- `fps`
- `bufferPercent`
- `lastFrameTime`
- `linkHealth`

## Parameters

```http
GET /api/param?ip=192.168.105.13&key=TriggerMode&type=int
```

```http
POST /api/param
Content-Type: application/json

{"ip":"192.168.105.13","key":"ExposureTime","type":"int","value":850}
```

Trigger mode must remain software-triggered for this deployment.

## Depth Capture

```http
POST /api/capture/depth-map
Content-Type: application/json

{
  "ip": "192.168.105.13",
  "lines": 1280,
  "width": 4096,
  "timeoutMs": 8000,
  "dataMode": 1,
  "output": "CAM-01/depth.png"
}
```

Returns:

```json
{
  "code": 0,
  "ip": "192.168.105.13",
  "width": 4096,
  "lines": 1280,
  "output": "E:\\steel-capture-data\\CAM-01\\depth.png",
  "imageUrl": "/api/capture/file?path=E%3A%5Csteel-capture-data%5CCAM-01%5Cdepth.png"
}
```

## Preview Capture

```http
POST /api/preview/capture
POST /api/capture/preview
Content-Type: application/json

{
  "ip": "192.168.105.13",
  "lines": 1280,
  "width": 0,
  "timeoutMs": 5000,
  "dataMode": 1
}
```

The response shape is the same as `/api/capture/depth-map`, with a generated output path under `preview/` when `output` is omitted.

## Capture File

```http
GET /api/capture/file?path=E%3A%5Csteel-capture-data%5CCAM-01%5Cdepth.png
```

Returns a PNG image when the output file exists and is inside the provider's allowed capture directory.

## Auto-Connect And Continuous Capture Test

Auto-connect and continuous capture are available as provider APIs and are also used by the Qt terminal and `scripts/test-capture-continuous.ps1`; they do not require additional Rust service business logic.

The flow is:

```text
GET /api/cameras
POST /api/camera/connect for each camera IP
POST /api/capture/depth-map for each camera, repeated for the configured number of rounds
```

The flow is sequential by design so multiple cameras do not compete for blocking SDK capture resources.

The same flow is also exposed directly by the provider for API-only control:

```http
POST /api/capture/continuous-test
Content-Type: application/json

{
  "expectedCameras": 6,
  "rounds": 3,
  "lines": 1280,
  "width": 0,
  "timeoutMs": 8000,
  "intervalMs": 500,
  "dataMode": 1,
  "outputDir": "continuous-test",
  "connectFirst": true,
  "stopStreams": true
}
```

Optional `ips` may be supplied to restrict the test to selected cameras.

## Realtime Stream

Only one selected camera should stream at a time. Starting a stream for one camera stops any existing stream for another camera in the same provider process.

```http
POST /api/stream/start
Content-Type: application/json

{
  "ip": "192.168.105.13",
  "lines": 1280,
  "width": 4096,
  "dataMode": 1,
  "hs": false,
  "fpsLimit": 5
}
```

The provider uses the SDK async chain:

```text
lvm_alloc_depth_map_buf -> lvm_bind_buf -> lvm_enable_async_mode -> lvm_trigger_en_ctrl(true)
```

```http
POST /api/stream/stop
Content-Type: application/json

{"ip":"192.168.105.13"}
```

```http
GET /api/stream/status?ip=192.168.105.13
GET /api/stream/latest?ip=192.168.105.13&kind=depth
GET /api/stream/latest?ip=192.168.105.13&kind=intensity
```

`/api/stream/latest` returns the latest PNG frame when one has been saved.

## Calibration And ROI

```http
POST /api/calibration/load
Content-Type: application/json

{"ip":"192.168.105.13","path":"D:/calibration/CAM-01.xml"}
```

```http
POST /api/roi/load
Content-Type: application/json

{"ip":"192.168.105.13","path":"D:/calibration/CAM-01-roi.xml"}
```

```http
GET /api/calibration/status?ip=192.168.105.13
```

The Qt terminal saves operator calibration records locally after calibration load, ROI load, and validation capture. The provider does not solve calibration files from images; it applies files already accepted by the LVM SDK.

## Runtime Ownership Rule

Only one provider process may own the LVM SDK camera handles:

- `headless-cpp`: Rust may start `steel_capture_service.exe`.
- `qt-terminal`: the Qt terminal owns the SDK and Rust only proxies to it.
- `external-api`: another compatible process owns the SDK and Rust only proxies to it.
- `simulated`: Rust does not call a provider.
