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

It starts the provider on port `4317`, uses the configured storage root, applies `current-6-soft-trigger`, and preserves the camera's current built-in/device parameters. Qt is not started unless `-WithQtViewer` is explicitly supplied. The bundled `.nccfg` files are available for explicit operator/API loading but are not loaded during default startup. Pass `-ApplyPreset` only when you intentionally want to force the generic 1000-line preset from the API.

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
- `POST /api/storage/camera-roots` with `{"replace":true,"cameraRoots":[{"ip":"192.168.101.100","root":"H:/camera1"}]}`
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
- `GET /api/capture/latest?ip=192.168.101.100&kind=depth|intensity|metadata|sdk-derived`
- `GET /api/steel/status`
- `POST /api/steel/event` with `{"cmd":"rcvSteelInfo","id":"STEEL-001","steelType":"Q235","length":12000,"width":1800,"thick":12.5}`
- `POST /api/steel/event` with `{"cmd":"steelIn","value":1}` for entry-steel and `{"cmd":"steelIn","value":0}` for exit-steel
- `POST /api/stream/start` with `{"ip":"192.168.10.13","lines":1280,"width":4096,"dataMode":1,"hs":false,"fpsLimit":5}`
- `POST /api/stream/stop` with `{"ip":"192.168.10.13"}`
- `GET /api/stream/status?ip=192.168.10.13`
- `GET /api/stream/latest?ip=192.168.10.13&kind=depth`
- `POST /api/capture/preset/line-continuous` is a Rust-gated maintenance-only preset; see the gate below
- `POST /api/calibration/load` with one per-camera SDK XML, `dryRun:true`, or `confirmation:"APPLY CAMERA CALIBRATION"`
- `GET /api/calibration/active?profile=current-6-soft-trigger`
- `POST /api/calibration/active` with `{"name":"current-6-soft-trigger","path":"config/calibrations/current-6-soft-trigger/<version>/ArrayCalibration.corrected.xml"}`
- `POST /api/calibration/apply-all` with an array reconstruction reference plus an explicit per-camera SDK file mapping; see the safety contract below
- `POST /api/calibration/rollback` with `{"operationId":"calibration-rollback-20260712-001","rollbackToken":"calrb-...","confirmation":"ROLLBACK CAMERA CALIBRATION"}`
- `POST /api/roi/load` with `{"ip":"192.168.10.13","path":"D:/calibration/CAM-01-roi.xml","confirmation":"APPLY CAMERA ROI"}`
- `GET /api/calibration/status?ip=192.168.10.13`

### Calibration safety contract

`ArrayCalibration.corrected.xml` is an array reconstruction/stitching artifact. It may be selected through `/api/calibration/active`, but it is never passed to `lvm_load_calib_param`. Camera application requires a distinct SDK XML mapping for every target camera.

The formal Rust `/api/calibration/apply-all` route is deliberately narrower than the provider's diagnostic contract. It requires exactly six unique target IPs and exactly six matching `cameraCalibrations`. Every mapping must contain a non-empty, set-unique `expectedSn` and a distinct normalized SDK calibration path, and the request must set `expectedCameras:6`, `atomic:true`, `rollbackOnFailure:true`, `requireAllMapped:true`, and `stopStreams:true`. A real apply also requires a caller-owned stable `operationId`. Rust rejects `allowBestEffortDeviceRollback:true` and rejects `saveCameraParams:true`; camera-parameter snapshot saving is a separate maintenance operation and is not part of the formal atomic calibration transaction.

```json
{
  "operationId": "calibration-apply-20260712-001",
  "name": "current-6-soft-trigger",
  "path": "config/calibrations/current-6-soft-trigger/<version>/ArrayCalibration.corrected.xml",
  "ips": [
    "192.168.101.100",
    "192.168.102.100",
    "192.168.103.100",
    "192.168.104.100",
    "192.168.105.13",
    "192.168.106.100"
  ],
  "expectedCameras": 6,
  "requireAllMapped": true,
  "cameraCalibrations": [
    {
      "ip": "192.168.101.100",
      "expectedSn": "3G506401BE08818",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/<version>/camera-101.xml",
      "rollbackPath": "config/calibrations/known-good/camera-101.xml"
    },
    {
      "ip": "192.168.102.100",
      "expectedSn": "3G506501CA09165",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/<version>/camera-102.xml",
      "rollbackPath": "config/calibrations/known-good/camera-102.xml"
    },
    {
      "ip": "192.168.103.100",
      "expectedSn": "3G506401RE08993",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/<version>/camera-103.xml",
      "rollbackPath": "config/calibrations/known-good/camera-103.xml"
    },
    {
      "ip": "192.168.104.100",
      "expectedSn": "3G506401BE08819",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/<version>/camera-104.xml",
      "rollbackPath": "config/calibrations/known-good/camera-104.xml"
    },
    {
      "ip": "192.168.105.13",
      "expectedSn": "YF-0263",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/<version>/camera-105.xml",
      "rollbackPath": "config/calibrations/known-good/camera-105.xml"
    },
    {
      "ip": "192.168.106.100",
      "expectedSn": "3G506401RE08991",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/<version>/camera-106.xml",
      "rollbackPath": "config/calibrations/known-good/camera-106.xml"
    }
  ],
  "dryRun": false,
  "atomic": true,
  "rollbackOnFailure": true,
  "persistActive": true,
  "saveCameraParams": false,
  "saveToDevice": false,
  "allowBestEffortDeviceRollback": false,
  "stopStreams": true,
  "confirmation": "APPLY CAMERA CALIBRATION SET"
}
```

`dryRun:true` performs mapping, file-kind, serial-number, connection, stream, and durable rollback-file checks without allocating a rollback token or calling the SDK; it does not require the apply confirmation. Every camera on the formal Rust route requires a valid known-good `rollbackPath`, including `saveToDevice:false`, so C++ can stage cross-restart recovery material. A real apply requires the exact typed phrase `confirmation:"APPLY CAMERA CALIBRATION SET"`. `saveToDevice` defaults to `false`; setting it to `true` additionally requires `deviceConfirmation:"PERSIST CAMERA PARAMETERS"`. The formal route never permits best-effort-only rollback.

The single-camera `/api/calibration/load` endpoint uses the shorter direct-maintenance confirmation `APPLY CAMERA CALIBRATION`; internally it enters the same preflight, snapshot, and rollback-token workflow. `/api/roi/load` requires `APPLY CAMERA ROI`. These phrases are enforced by the C++ provider itself, including callers that bypass the Rust proxy.

The apply response uses schema `steel.capture.calibration-apply.v2`. It returns `operationId`, `arrayCalibrationPath`, `arrayArtifactKind`, `rollbackToken`, aggregate `applied/failed/skipped/rolledBack`, `rollbackPerformed`, `rollbackComplete`, capability flags, and one result per camera with the same operation ID plus separate `preflightCode`, `applyCode`, `persistCode`, `rollbackCode`, `rollbackMode`, `attempted`, `applied`, `rolledBack`, `skipped`, and artifact paths. Atomic application stops after the first failure and rolls every attempted camera back in reverse order.

`POST /api/calibration/rollback` requires `{"operationId":"calibration-rollback-20260712-001","rollbackToken":"calrb-...","stopStreams":true,"confirmation":"ROLLBACK CAMERA CALIBRATION"}` on the formal Rust route. Schema `steel.capture.calibration-rollback.v1` returns top-level `operationId`, `applyOperationId`, `complete`, `consumed`, `failed`, `skipped`, `rolledBack`, `profileChanged`, `profileRestored`, and `profileCode`; each camera result returns the rollback operation ID, `code`, `rollbackCode`, `rollbackMode`, `rollbackPath`, `attempted`, `rolledBack`, `skipped`, and a message.

The C++ provider call remains synchronous, but rollback tokens and file-only recovery now survive restart. Before the first SDK write, C++ stages the known-good files as read-only config-root copies, verifies SHA-256+size, and flushes an atomic write-ahead manifest. Non-terminal or invalid manifests close provider readiness and new writes with HTTP 423; prepared/applying/rolling-back/rollback-failed work can be explicitly rolled back from the staged copies, while corrupt manifests remain fail-closed. Exact runtime `lvm_calib_param_t` snapshots are still process-memory-only and are never serialized. The formal Rust facade adds the persistent `calibration_operation` ledger: same-ID/same-request calls are single-flight and replay-safe, changed reuse conflicts, and timeout, restart, or incomplete rollback becomes `needs-reconciliation` without automatic SDK replay. Only a rollback bound to the unresolved apply's `parentOperationId` can reconcile that row after the provider returns `complete:true` and the same `applyOperationId`.

Calibration apply, calibration rollback, and ROI apply append best-effort JSON Lines records to `<CAPTURE_STORAGE_ROOT>/maintenance/calibration-records.jsonl`. A validation capture does the same when it sends `calibrationMaintenanceRecord:true`; the Tauri validation helper sets that flag. Each `steel.capture.calibration-maintenance.v1` record contains `recordedAt`, `action`, camera `ip`/`sn`, artifact `path`, `rollbackToken`, `operationId`, and `code`. `/api/calibration/status` exposes the most recent operation ID and resolved `maintenanceRecordPath`.

`/api/roi/load` requires the exact phrase `confirmation:"APPLY CAMERA ROI"`. With the default `allowExternal:false`, the canonical target must be a regular file below the provider storage or config root; traversal, symlink/junction escape, directories, and other external paths are rejected. `allowExternal:true` is an explicit admin maintenance opt-in and still requires a canonical regular file.

### Dangerous line-continuous preset gate

`POST /api/capture/preset/line-continuous` is exposed only as an `admin.config` maintenance operation through Rust. It requires the exact phrase `confirmation:"APPLY LINE CONTINUOUS PRESET"`. Rust bounds `lines` to 1-100000, `timeTriggerFreq` to 0.1-100000, `laserPower` to 0-100, `laserLineSelect` to 0-2, and `controlMode` to 0-1. `connectFirst` and `saveToDevice` default to `false`; device persistence additionally requires `deviceConfirmation:"PERSIST LINE PRESET TO CAMERA DEVICES"`. Formal production profiles never invoke this preset automatically.

Relative output paths are stored under `CAPTURE_STORAGE_ROOT`, or `E:\steel-capture-data` by default when drive `E:` exists. Per-camera production roots can be configured with `/api/storage/camera-roots`; the current six-camera default maps the known camera IPs to `H:\camera1` through `H:\camera6` when drive `H:` exists. Realtime stream start uses the LVM async path and keeps only one stream active in the provider process. Blocking depth capture rejects requests while a realtime stream is running for the same camera. Continuous-test capture runs one worker thread per camera in each round and releases the workers through a shared start gate; the response includes `parallel`, `syncMode`, `workerCount`, and per-frame worker timestamps. Frame files are grouped under each camera directory by peer artifact folders: `depth/`, `intensity/`, and `metadata/`; `sdk-derived/` is saved only when the request explicitly sends `saveSdkDerived:true` or `save_sdk_derived:true`.

Depth, intensity, and metadata are committed as one bounded storage transaction. Metadata is written last and is the complete-frame marker. Unsigned-short SDK depth maps (`data_format=0`) are deep-copied before the camera buffer is released and encoded by the storage workers through the serialized SDK offline encoder. Float SDK depth maps (`data_format=2`) deliberately retain the synchronous online-save fallback because Capture 6.7's offline saver interprets their bytes as unsigned-short samples. The frame response and metadata expose `depthDataFormat` and `depthPersistenceMode` so this boundary is observable.

Storage pipeline limits can be tuned with `CAPTURE_STORAGE_WORKERS`, `CAPTURE_STORAGE_QUEUE_ITEMS`, `CAPTURE_STORAGE_QUEUE_BYTES`, `CAPTURE_STORAGE_PENDING_TICKETS`, and `CAPTURE_STORAGE_ENQUEUE_TIMEOUT_MS`. `CAPTURE_SIMULATED_STORAGE_DELAY_MS` is a bounded simulated-driver test aid (0-5000 ms, default 0) for deterministic overlap and shutdown-drain tests; it never delays real camera frames.

Parallel capture workers are never detached after a hard timeout. Their thread handles remain owned by the provider and are joined when the workers finish. If an SDK worker is still running at the deadline, `/health` exposes `sdkCaptureState.poisoned=true`, `restartRequired=true`, and owned-worker counts; new SDK/device routes return HTTP 503 with code `49007` until the provider is restarted. Shutdown waits for those owned workers before stopping the storage queue or destroying camera/SDK objects. If the common shutdown deadline expires first, the provider uses the existing process-level `_Exit` path and deliberately skips unsafe SDK teardown.

`GET /api/capture/file` resolves the requested existing file through `canonical`/`weakly_canonical` paths and serves only regular files whose resolved target is below `CAPTURE_STORAGE_ROOT` or a configured per-camera root. The process working directory is not an implicit read root, and `..`, symlink, or junction escapes are rejected. Latest-capture and stream file reads apply the same resolved-root policy.

The current six-camera production baseline is continuous line capture with software control, vendor time trigger source, 1000 lines, and depth + intensity output: `controlMode=0`, `triggerInputType=4`, `lines=1000`, `dataMode=3`. The packaged `current-6-soft-trigger` profile uses `loadCameraParams:false` and `changeStorage:false` so startup does not overwrite the verified device-side setup. Formal operator tests and maintenance are exposed by Tauri through Rust; the optional Qt viewer is development diagnostics only.

`steelIn:value=1` opens a production session under `<storageRoot>/production/<steel-id>/<session-id>/` and writes `summary.json`. If a capture request omits `output`, or a continuous-test request omits `outputDir`, raw capture artifacts use the production raw-data layout:

```text
<camera-root>/<material-id>/<data-name>/<sequence>.<extension>
```

For example:

```text
H:\camera1\MAT-20260707-001\depth\000001.png
H:\camera1\MAT-20260707-001\intensity\000001.png
H:\camera1\MAT-20260707-001\metadata\000001.json
```

The session summary remains under the `production/<steel-id>/<session-id>/` directory.
