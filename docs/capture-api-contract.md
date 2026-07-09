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

```http
POST /api/storage/camera-roots
Content-Type: application/json

{
  "replace": true,
  "cameraRoots": [
    {"ip":"192.168.101.100","root":"H:/camera1"},
    {"ip":"192.168.102.100","root":"H:/camera2"},
    {"ip":"192.168.103.100","root":"H:/camera3"},
    {"ip":"192.168.104.100","root":"H:/camera4"},
    {"ip":"192.168.105.13","root":"H:/camera5"},
    {"ip":"192.168.106.100","root":"H:/camera6"}
  ]
}
```

Relative capture outputs are resolved under the current storage root. Production-layout captures without an explicit output use the configured per-camera root first, then fall back to `<storageRoot>/<camera-id>`. Absolute outputs must stay inside the configured storage root or one of the configured camera roots.

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

For the six-camera production profile `current-6-soft-trigger`, startup defaults to `loadCameraParams:false` and `changeStorage:false`. This preserves the vendor/device-side time-trigger configuration that has already been verified on the cameras. Packaged `.nccfg` files are still included for explicit operator/API loading, backup, and comparison, but default startup must not depend on `lvm_load_dev_param` succeeding.

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

The response includes per-camera `code`, `errorName`, `operatorHint`, `file`, and SDK sub-codes such as `loadCode`, `applyCode`, and `saveDeviceCode`. A non-zero SDK code from explicit `.nccfg` loading must be reported to the operator, but it does not change the default production strategy of using the camera's current built-in/device parameters.

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
  "inspectionId": "",
  "acquisitionMode": "external-trigger",
  "captureSaveState": "discard",
  "algorithmPhase": "pending",
  "saveEnabled": false,
  "discardBlackFrames": true,
  "blackFrameThreshold": 8,
  "captureDir": "",
  "summaryOutput": "",
  "captureCount": 0,
  "captureSuccessCount": 0,
  "captureFailureCount": 0,
  "discardFrameCount": 0,
  "blackFrameCount": 0,
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

{
  "cmd": "steelIn",
  "value": 1,
  "steelId": "STEEL-001",
  "sessionId": "STEEL-001-20260707-001",
  "inspectionId": "INSP-STEEL-001-20260707-001",
  "acquisitionMode": "external-trigger",
  "captureSaveState": "save",
  "saveEnabled": true,
  "discardBlackFrames": true,
  "algorithmPhase": "pending"
}
```

`steelIn` with `value:1` means entry-steel and moves the provider state to a saving state. External-trigger operation reports `steel-in-waiting-images`; internal/time-trigger operation may report `steel-in-saving`. It also opens a production session when none is active. The session directory is:

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
It also sets `saveEnabled:false` and `captureSaveState:"discard"`, so internally triggered frames can keep flowing but are not saved as production data.

```http
POST /api/steel/event
Content-Type: application/json

{"cmd":"reset"}
```

`reset` clears the production state back to `idle`. The command names intentionally match the legacy/reference line-control messages: `steelIn` and `rcvSteelInfo`.

When a production session is active and `/api/capture/depth-map` is called without an explicit `output`, or `/api/capture/continuous-test` is called without an explicit `outputDir`, raw capture artifacts are stored by camera and material:

```text
<camera-root>/<material-id>/<data-name>/<sequence>.<extension>
```

The provider uses per-camera roots from the active profile or `POST /api/storage/camera-roots`; the current six-camera default maps the known IPs to `H:/camera1` through `H:/camera6` when drive `H:` exists. If a camera root is not configured, it falls back to `<storageRoot>/<camera-id>`, where `<camera-id>` is the camera SN when available or the IP. The default data-name directories are `depth`, `intensity`, and `metadata`; `sdk-derived` is written only when a capture request explicitly sends `saveSdkDerived:true` or `save_sdk_derived:true`. The production session summary still lives under `<storageRoot>/production/<safe-steel-id>/<sessionId>/summary.json`. Explicit `output` and `outputDir` values still take precedence unless `productionLayout:true` is sent to `/api/capture/continuous-test`.

Production capture calls may send `steelStateAware:true` or `requireSteelPresent:true`. When the provider has not received entry-steel/save state, it returns code `49000` (`CAPTURE_DISCARDED_NOT_ARMED`) and does not write frame images. When `discardBlackFrames:true`, a frame whose intensity image is below `blackFrameThreshold` returns code `49001` (`BLACK_FRAME_DISCARDED`); depth, intensity, and optional SDK-derived images are removed, while metadata records `discarded:true` and `discardReason:"black-frame"`.

Example:

```text
H:/camera1/MAT-20260707-001/depth/000001.png
H:/camera1/MAT-20260707-001/intensity/000001.png
H:/camera1/MAT-20260707-001/metadata/000001.json
```

Qt uses the latest-file endpoint to preview only the newest saved artifact for a selected camera:

```http
GET /api/capture/latest?ip=192.168.101.100&kind=depth
GET /api/capture/latest?ip=192.168.101.100&kind=intensity
GET /api/capture/latest?ip=192.168.101.100&kind=metadata
GET /api/capture/latest?ip=192.168.101.100&kind=sdk-derived
```

Add `meta=1` to receive a JSON wrapper with the file path and `/api/capture/file` URL instead of the file body.

The Rust business service adds the production database loop on top of the provider:

```http
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

`/api/production/steel-in` writes `material_session` and `production_inspection` before forwarding `steelIn` to the provider. `/api/production/capture-once` triggers provider `/api/capture/continuous-test` with `productionLayout:true`, `steelStateAware:true`, `requireSteelPresent:true`, and `discardBlackFrames:true`; it records only returned artifacts whose `*Exists` flag is true. The Rust service uses a production-aware provider read timeout derived from `rounds`, `timeoutMs`, `intervalMs`, and `retries`, clamped between 60 seconds and 3600 seconds, so a long production capture can keep running without being failed by the normal short HTTP proxy timeout. After the provider returns, the Rust service points `summaryOutput` and `latestInspection.summaryPath` to `<storageRoot>/production/<safe-material-id>/<sessionId>/summary.json`; after `steel-out`, it rewrites that file as `steel.production.summary.v1`, including the session, inspection, provider response, and every recorded `capture_file` row. `/api/production/algorithm/run` runs the bar-surface reconstruction for the current or specified `materialId`, writes Python prototype outputs under `G:/bar-surface-algorithm`, runs the C++ core by default, and updates `production_inspection.status` to `algorithm-complete` or `algorithm-failed`. The algorithm request accepts contour crop controls (`contourCrop`, `contourRadiusToleranceMm`, `contourMinKeepRatio`, `contourMinRowCoverage`, `contourAutoPercentile`); by default the Python prototype derives per-camera 2D crop boxes from calibrated 3D round-bar contour fitting and clips the final 3D mesh to that contour.

The Rust service also exposes a review-only bar-surface calibration fit endpoint:

```http
POST /api/algorithm/bar-surface/calibration/fit
Content-Type: application/json

{
  "materialId": "BAR-E2E-20260708-013823",
  "captureRoot": "H:/",
  "calibrationPath": "E:/steel-capture-data/config/calibrations/current-6-soft-trigger/array-calibration-fit-20260707-151317/ArrayCalibration.corrected.xml",
  "rows": "250,500,750",
  "maxPointsPerCamera": 2400,
  "maxShiftMm": 5
}
```

It reads the production layout `H:/camera1..camera6/<materialId>/metadata`, uses each camera's latest metadata/depth frame, runs the X/Z cross-section fitter, and returns `fitBefore`, `fitAfter`, per-camera `dx/dz`, `fit_report.json`, and `ArrayCalibration.corrected.xml`. This endpoint does not write the provider active profile and does not save parameters to camera devices; the UI can pass the returned `correctedXml` back to `/api/production/algorithm/run` as `calibrationPath` for reconstruction preview.

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
```

When `saveSdkDerived:true` is sent, an additional `sdk-derived/` directory is created beside these folders. `depthOutput`, `intensityOutput`, and `metadataOutput` point to the normalized files used by downstream code. `sdkDepthOutput`, `sdkIntensityOutput`, and `sdkOutput` point to files emitted directly by `lvm_save_depth_map` only when SDK-derived saving is enabled.

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

## Rust Service Network Monitor

The Rust service exposes a read-only Windows network monitor for the terminal header and hardware status popover:

```http
GET /api/system/network
```

The endpoint samples `Get-NetAdapter` and `Get-NetAdapterStatistics`, returns cumulative byte counters, and derives realtime upload/download Mbps from the previous service-side sample. It never sets upload, download, QoS, or bandwidth limits.

Required response shape:

```json
{
  "code": 0,
  "source": "windows-get-netadapter",
  "sampledAtMs": 1783543783881,
  "interfaces": [
    {
      "index": 1,
      "name": "SLOT 3 port 1",
      "description": "Intel I350",
      "status": "Up",
      "linkSpeed": "1 Gbps",
      "linkSpeedBitsPerSecond": 1000000000,
      "receivedBytes": 123456789,
      "transmittedBytes": 456789123,
      "packetsReceived": 1000,
      "packetsTransmitted": 900,
      "uploadMbps": 0.03,
      "downloadMbps": 0.21,
      "bandwidthMbps": 1000,
      "online": true
    }
  ],
  "totalReceivedBytes": 123456789,
  "totalTransmittedBytes": 456789123,
  "totalUploadMbps": 0.03,
  "totalDownloadMbps": 0.21,
  "totalBandwidthMbps": 8000
}
```

The service computes realtime upload and download Mbps from consecutive samples. The client keeps the same calculation as a compatibility fallback when connected to an older service:

```text
uploadMbps = delta(transmittedBytes) * 8 / elapsedSeconds / 1_000_000
downloadMbps = delta(receivedBytes) * 8 / elapsedSeconds / 1_000_000
```

The UI must present upload, download, link bandwidth, and utilization as monitoring values only. No network limit or adapter configuration control belongs in this popover.

## Runtime Ownership Rule

Only one provider process may own the LVM SDK camera handles:

- `headless-cpp`: Rust may start `steel_capture_service.exe`.
- `qt-terminal`: the Qt terminal owns the SDK and Rust only proxies to it.
- `external-api`: another compatible process owns the SDK and Rust only proxies to it.
- `simulated`: Rust does not call a provider.
