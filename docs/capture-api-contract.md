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
  "startupMode": "auto-connect",
  "autoConnect": true,
  "expectedCameras": 6,
  "applySoftTrigger": true,
  "loadCameraParams": false,
  "saveToDevice": false,
  "lines": 1000,
  "width": 0,
  "timeoutMs": 8000,
  "dataMode": 3,
  "fpsLimit": 5,
  "controlMode": 0,
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
  "ips": ["192.168.101.100"],
  "cameraFiles": [
    {"ip": "192.168.101.100", "path": "config/camera-params/default/192_168_101_100.nccfg"}
  ],
  "applySoftTrigger": true,
  "saveToDevice": false,
  "allowExternal": false
}
```

`save-all` writes files named `<camera-ip-with-underscores>.nccfg`. `load-all` can either load explicit per-camera files through `cameraFiles[]` or fall back to the selected directory by safe IP, then model and serial number. Cameras omitted from `ips` are not touched, which lets the Qt configuration page mix "use camera built-in/current parameters" with "load this `.nccfg` file" per camera. External absolute files require `allowExternal:true`.

The per-camera low-level APIs remain available:

```http
POST /api/param/save-file
POST /api/param/load-file
POST /api/param/save-device
POST /api/param/recovery
```

`/api/param/load-file` accepts files under the provider storage/config roots by default. Loading an absolute file from another folder, such as a vendor-exported file on the desktop, requires `allowExternal: true` because incompatible `.nccfg` files can destabilize the vendor SDK process.

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
- `captureConfig`: readback of key SDK settings, including `controlMode`, `triggerInputType`, `captureDataType`, `triggerLines`, `timeTriggerFreq`, exposure/gain, laser enable, array enable, laser power, and laser line selection.

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

## Production Steel State

The provider keeps a lightweight production state model so API-only callers and the Qt overview can use the same entry/exit-steel state. This state does not directly open SDK streams; it records the business phase that should drive higher-level line logic.

```http
GET /api/steel/status
```

Returns the current steel phase, steel identity/specification, camera readiness counters, and timestamps:

```json
{
  "code": 0,
  "phase": "idle",
  "phaseLabel": "idle",
  "present": false,
  "steelId": "",
  "steelType": "",
  "sessionId": "",
  "captureDir": "",
  "summaryOutput": "",
  "captureCount": 0,
  "captureSuccessCount": 0,
  "captureFailureCount": 0,
  "lastCaptureOutput": "",
  "length": 0,
  "width": 0,
  "thickness": 0,
  "inTime": "",
  "outTime": "",
  "updatedAt": "2026-07-06T17:00:00.000",
  "connectedCameras": 6,
  "streamingCameras": 0,
  "expectedCameras": 6
}
```

```http
POST /api/steel/event
Content-Type: application/json

{"cmd":"rcvSteelInfo","id":"STEEL-001","steelType":"Q235","length":12000,"width":1800,"thick":12.5}
```

`rcvSteelInfo` updates the current steel identity and sets `phase` to `info-ready` when the line is otherwise idle.

```http
POST /api/steel/event
Content-Type: application/json

{"cmd":"steelIn","value":1}
```

`steelIn` with `value:1` means entry-steel and moves the provider state to `steel-in` / `present:true`. It also opens a production session when none is active. The session directory is:

```text
<storageRoot>/production/<safe-steel-id>/<sessionId>/
```

The provider writes `<session-dir>/summary.json` after steel events and after capture calls during that session.

```http
POST /api/steel/event
Content-Type: application/json

{"cmd":"steelIn","value":0}
```

`steelIn` with `value:0` means exit-steel and moves the provider state to `steel-out` / `present:false`.

```http
POST /api/steel/event
Content-Type: application/json

{"cmd":"reset"}
```

`reset` clears the production state back to `idle`. The command names intentionally match the legacy/reference line-control messages: `steelIn` and `rcvSteelInfo`.

When a production session is active and `/api/capture/depth-map` is called without an explicit `output`, or `/api/capture/continuous-test` is called without an explicit `outputDir`, raw capture artifacts are stored by camera and material:

```text
<storageRoot>/<camera-id>/<material-id>/<data-name>/<sequence>.<extension>
```

The provider uses the camera SN as `<camera-id>` when available and falls back to the camera IP. The data-name directories currently include `depth`, `intensity`, `metadata`, and `sdk-derived`. The production session summary still lives under `<storageRoot>/production/<safe-steel-id>/<sessionId>/summary.json`. Explicit `output` and `outputDir` values still take precedence unless `productionLayout:true` is sent to `/api/capture/continuous-test`.

Example:

```text
E:/steel-capture-data/3G506401BE08818/MAT-20260707-001/depth/000001.png
E:/steel-capture-data/3G506401BE08818/MAT-20260707-001/intensity/000001.png
E:/steel-capture-data/3G506401BE08818/MAT-20260707-001/metadata/000001.json
```

The Rust business service adds the production database loop on top of the provider:

```http
GET  /api/production/status
POST /api/production/steel-info
POST /api/production/steel-in
POST /api/production/steel-out
POST /api/production/secondary-data
POST /api/production/capture-once
POST /api/production/capture-summary
POST /api/production/defect
```

`/api/production/capture-once` triggers provider `/api/capture/continuous-test` with `productionLayout:true`, then records the returned depth, intensity, metadata, and SDK-derived file paths in the production database tables.

## Depth Capture

```http
POST /api/capture/depth-map
Content-Type: application/json

{
  "ip": "192.168.105.13",
  "lines": 1280,
  "width": 4096,
  "timeoutMs": 8000,
  "dataMode": 3,
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
  "output": "E:\\steel-capture-data\\CAM-01\\depth_depthMap.png",
  "depthOutput": "E:\\steel-capture-data\\CAM-01\\depth_depthMap.png",
  "intensityOutput": "E:\\steel-capture-data\\CAM-01\\depth_intensity.png",
  "metadataOutput": "E:\\steel-capture-data\\CAM-01\\depth_metadata.json",
  "depthExists": true,
  "intensityExists": true,
  "metadataExists": true,
  "completeFrame": true,
  "errorName": "CORRECT",
  "operatorHint": "ok",
  "attempts": 1,
  "imageUrl": "/api/capture/file?path=E%3A%5Csteel-capture-data%5CCAM-01%5Cdepth_depthMap.png"
}
```

`intensityOutput` is empty when the SDK frame does not include an intensity image. `depthExists`, `intensityExists`, `metadataExists`, and `completeFrame` are computed from the files actually present on disk after the SDK call. `metadataOutput` records camera identity, requested and actual dimensions, frame counters, trigger intervals, return code, `errorName`, `operatorHint`, `captureConfig`, and saved file paths. For example, `DEV_LOAD_DATA_ERROR` means the SDK accepted the camera configuration but did not return a frame before timeout.

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
  "dataMode": 3
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

The provider writes detailed `summary.json` into the selected output directory. The PowerShell script preserves that provider summary and writes its own camera-level rollup as `script-summary.json` and `script-summary.csv`. The summary records `completeFrames` per camera; a frame is complete only when depth PNG, intensity PNG, and metadata JSON all exist on disk. Failed cameras still write metadata when possible, so `metadataFrames` may be higher than `completeFrames`.

The flow is:

```text
GET /api/cameras
POST /api/camera/connect for each camera IP
POST /api/capture/continuous-test once with the camera IP list
```

The provider runs the continuous test as synchronized parallel rounds. For each round it creates one worker thread per camera, waits until all workers are ready, releases them together through a condition-variable start gate, then joins all workers before the next interval. SDK handles still live in the single provider process; each camera session has its own capture mutex so the same camera cannot be captured twice at once.

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
  "retries": 2,
  "controlMode": 0,
  "dataMode": 3,
  "outputDir": "continuous-test",
  "connectFirst": true,
  "stopStreams": true
}
```

Optional `ips` may be supplied to restrict the test to selected cameras.

The provider response includes `parallel: true`, `syncMode: "round-start-condition-variable"`, `workerCount`, aggregate `completeFrames` and `metadataFrames`, and each `results[]` entry includes `parallelIndex`, `roundStartedAt`, `workerStartedAt`, `workerFinishedAt`, `depthExists`, `intensityExists`, `metadataExists`, and `completeFrame`.

The provider also writes its response-shaped summary to `<storageRoot>/<outputDir>/summary.json` and returns `summaryOutput` plus `summaryExists`. This gives API-only callers the same durable audit trail that the PowerShell script creates.

For the current six-camera line configuration, `controlMode: 0` is the default continuous capture mode, matching the vendor demo's "连续采集" setting. The provider still enforces software control with the time trigger source (`triggerInputType: 4`). The SDK value for depth + intensity capture is `captureDataType: 3` (`LVM_BT_DEPTH_INTENSITY`).

Continuous-test frame files are grouped by camera first, then by artifact type:

```text
<outputDir>/
  <camera-ip>/
    depth/
    intensity/
    metadata/
    sdk-derived/
```

`depthOutput`, `intensityOutput`, and `metadataOutput` point to the normalized files used by downstream code. `sdkDepthOutput`, `sdkIntensityOutput`, and `sdkOutput` point to files emitted directly by `lvm_save_depth_map` when present.

## Realtime Stream

Only one selected camera should stream at a time. Starting a stream for one camera stops any existing stream for another camera in the same provider process.

```http
POST /api/stream/start
Content-Type: application/json

{
  "ip": "192.168.105.13",
  "lines": 1280,
  "width": 4096,
  "dataMode": 3,
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

`path` may be absolute or relative to the provider storage root. This endpoint calls the vendor SDK per-camera calibration loader and returns the SDK code in `calibrationCode`.

```http
GET /api/calibration/active?profile=current-6-soft-trigger
```

Returns the active array-calibration pointer recorded by the profile, the absolute path if it can be resolved, and the latest `activeCalibration` metadata. This is the stitching/profile calibration file used by the operator workflow, not necessarily a file accepted by the vendor per-camera SDK loader.

```http
POST /api/calibration/active
Content-Type: application/json

{
  "name": "current-6-soft-trigger",
  "path": "config/calibrations/current-6-soft-trigger/array-calibration-fit-20260707-142746/ArrayCalibration.corrected.xml",
  "fitReport": "config/calibrations/current-6-soft-trigger/array-calibration-fit-20260707-142746/fit_report.json"
}
```

Updates only the current profile pointer and `activeCalibration` metadata. It does not touch connected cameras.

```http
POST /api/calibration/apply-all
Content-Type: application/json

{
  "name": "current-6-soft-trigger",
  "path": "config/calibrations/current-6-soft-trigger/array-calibration-fit-20260707-142746/ArrayCalibration.corrected.xml",
  "stopStreams": true,
  "persistActive": true,
  "saveCameraParams": true,
  "saveToDevice": true,
  "applySoftTrigger": false
}
```

Attempts to load the same calibration file into all selected/connected cameras, records per-camera SDK return codes, optionally saves `.nccfg` files, and optionally writes current parameters back to devices. Six-camera `ArrayCalibration.xml` files can be valid stitching/profile files even when `lvm_load_calib_param` reports a non-zero per-camera SDK code.

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
