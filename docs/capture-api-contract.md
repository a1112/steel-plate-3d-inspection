# Capture API Contract

The headless C++ capture service is the sole camera-SDK owner and exposes this HTTP API. Tauri calls it only through the Rust service; the removed Qt compatibility runtime is not supported.

Default origin:

```text
http://127.0.0.1:4317
```

The Rust service reads the provider origin from:

```powershell
$env:CAPTURE_SERVICE_ORIGIN='http://127.0.0.1:4317'
```

The Tauri client must not consume this API directly. It calls the Rust service, and the Rust service proxies only an explicit allowlist while preserving provider status codes, content types, and error bodies. Provider failure must never be reported as simulated success unless `STEEL_CAPTURE_PROVIDER=simulated` was explicitly selected.

## Runtime profile and capability fencing

The Rust service loads `config/project.json` and its selected
`steel.runtime-profile.v1` document at startup. Configuration changes are
validated when saved but become active only after the service restarts. The
configured profile provider must match `STEEL_CAPTURE_PROVIDER`; a mismatch is a
startup error rather than an implicit fallback.

```http
GET /api/runtime-profile
```

Returns `steel.runtime-profile.public.v1` with the active profile identity,
provider, data-source type, ordered camera identities, configuration hash, and
the `directCamera`, `captureManagement`, `reconstruction`, and `offlineReplay`
capability flags. This response is public operational metadata. It never
contains filesystem roots, converter origins, capture-profile paths, camera
source directories, credentials, or secrets.

Mutation routes that require an unavailable capability fail closed before they
reach a provider or reconstruction process:

```json
{
  "code": 409,
  "error": "runtime_capability_unavailable",
  "capability": "captureManagement",
  "profileId": "bkv-6"
}
```

In particular, the non-direct BKV profile cannot mutate camera, stream, ROI,
calibration, capture-service, capture-configuration, production-capture, or
reconstruction state. Read-only status endpoints and BKV offline replay remain
available.

Administrators with `admin.config` can inspect, validate, and save the selected
profile through:

```http
GET  /api/admin/runtime-profile
POST /api/admin/runtime-profile/validate
POST /api/admin/runtime-profile
```

The POST body is `{ "profile": <steel.runtime-profile.v1> }`. Saving is atomic,
creates a `runtime-profile` configuration revision and a
`runtime-profile.update` audit event, and returns both active and saved
configuration hashes. It never changes the in-memory runtime profile; a
successful change reports `restartRequired:true` until the service restarts.
Invalid topology, duplicate mappings, escaping paths, incompatible capabilities,
and non-loopback converter origins are rejected before writing.

The same permission protects the converter-management proxy:

```http
GET  /api/admin/bkv-import/jobs
POST /api/admin/bkv-import/jobs
POST /api/admin/bkv-import/jobs/retry
```

These routes map only to the configured loopback converter's `/status`, `/start`,
and `/retry/<job-id>` endpoints with bounded timeouts. The Rust service rejects
remote origins, arbitrary converter paths, and unsafe retry identifiers; it does
not proxy converter file or business-record endpoints.

## Health

```http
GET /health
GET /api/capture/health
```

Returns SDK status and provider identity. `ready` and `sdkReady` are operational
readiness fields, not process-liveness fields. When a real SDK worker exceeds its
hard timeout, `sdkCaptureState.restartRequired` becomes `true`, `sdkCode` becomes
`49007`, and both readiness fields become `false` until the provider process is
restarted. Rust also reads the nested restart flag so an older provider that
incorrectly leaves `sdkReady:true` is still rejected by layered readiness.

For a real provider, `ready` additionally requires `cameraSetReady:true` and an
exact match between `cameraCount` and `expectedCameras`. More cameras are not
treated as a valid configured set. At startup the provider reads the active
profile; when `autoConnect` is enabled it discovers and connects that profile,
starts continuous acquisition only after the exact set is present, and otherwise
stays live but not ready. Connecting or disconnecting a single camera recomputes
this gate.

The production recovery sequence is: stop admitting new steel, preserve the
failed material/session evidence, restart the capture provider through the
managed service, reconnect exactly eight cameras, verify parameter readback,
then run a fresh 8/8 capture round. This restart path must not be used to bypass
`recoveryRequired:true` calibration reconciliation or an invalid rollback
manifest; those states follow their explicit reconciliation workflow.

The Windows runtime supervisor polls the provider while the child group is
running. It requests a managed whole-group restart only after two consecutive
successful health responses containing `restartRequired:true`, `sdkCode:49007`,
`recoveryRequired:false`, and `invalidManifest:false`. A healthy observation
resets confirmation. Restart attempts consume the existing supervisor restart
budget; calibration recovery and invalid-manifest states remain fail-closed and
must be reconciled explicitly.

## Provider Capture Logs

```http
GET /api/capture/logs
```

Returns the bounded, newest-first event stream from the capture provider. Entries are produced by the provider when it receives real capture-management operations (connection, acquisition, parameter, storage, and calibration routes). The Rust service proxies this endpoint so the UI never reads provider logs directly.

Required fields:

- `service`
- `time`
- `ready`
- `sdkReady`
- `sdkCode`
- `recoveryRequired`
- `invalidManifest`
- `pendingRecoveryCount`
- `driverMode`
- `driverId`
- `driverName`
- `storageRoot`
- `configRoot`
- `cameraCount`
- `sdkCaptureState.poisoned`
- `sdkCaptureState.restartRequired`
- `sdkCaptureState.reason`

## Storage

Data is stored under the provider storage root. The default is `CAPTURE_STORAGE_ROOT` when set, otherwise `E:\steel-capture-data` when drive `E:` exists, otherwise a local `captures` directory.

```http
GET /api/storage/status
```

Both `/health.storageQueue` and `/api/storage/status.queue` expose the bounded writer state: worker count, item/byte capacities, pending/queued/active counts and bytes, high-water marks, completed/failed/rejected totals, enqueue timeout, finite pending-ticket limit, and whether the queue is still accepting work. Defaults are 24 pending tasks/tickets, 512 MiB pending bytes, a two-second enqueue deadline, and 2..8 automatically selected workers. They can be bounded explicitly with `CAPTURE_STORAGE_WORKERS`, `CAPTURE_STORAGE_QUEUE_ITEMS`, `CAPTURE_STORAGE_QUEUE_BYTES`, `CAPTURE_STORAGE_PENDING_TICKETS`, and `CAPTURE_STORAGE_ENQUEUE_TIMEOUT_MS`.

Depth, intensity, and metadata are one `FrameWriteRequest` transaction represented by a `StorageTicket`. Metadata is written last and is the durable complete-frame marker. Queue saturation, shutdown rejection, an oversized storage task, missing intensity, and unsupported depth representation propagate as capture errors `49002` through `49006`. Any artifact or queue failure makes `completeFrame:false` and must not increment the production success count or create a successful inspection capture row. Production sequence numbers are reserved before submission; a failed frame may leave a gap but can never overwrite an earlier frame.

For SDK depth `data_format=0`, the provider deep-copies unsigned-short samples before freeing the camera buffer and the writer calls the vendor offline encoder under one serialized SDK-encoder mutex. For `data_format=2`, Capture 6.7's offline encoder is unsafe because it interprets float bytes as unsigned-short samples, so the provider deliberately retains `lvm_save_depth_map` in the capture thread and queues the completed file plus owned intensity data. Responses and metadata expose `depthDataFormat` plus `depthPersistenceMode` (`owned-offline-format0`, `sdk-online-format2-fallback`, or the simulated mode). No other representation is claimed safe.

Continuous and production capture retain only a bounded number of pending tickets and can start the next capture round while earlier writer transactions finish. Shutdown blocks new routes, lets accepted producers reach their submission boundary, stops queue acceptance, drains against the same five-second deadline, and only then disconnects devices and deinitializes the SDK. `CAPTURE_SIMULATED_STORAGE_DELAY_MS` is a bounded, default-zero simulated-driver test hook used only to make overlap tests deterministic; it must remain zero in production.

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
    {"ip":"192.168.105.100","root":"H:/camera5"},
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

Profiles are ordinary JSON files. They capture startup mode, storage root, expected camera count, default capture parameters, trigger settings, and the camera parameter-file directory. Tauri reaches these operations through Rust's authenticated operator facade; provider-level automation is limited to explicit diagnostic/integration scope.

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
  "expectedCameras": 8
}
```

Applying a profile can connect discovered cameras, apply trigger/exposure/gain defaults, optionally load camera parameter files, and set the active profile name. `changeStorage` must be true to let a profile switch the provider storage root.

For the eight-camera production profile `current-8-time-trigger`, startup defaults to `loadCameraParams:false` and `changeStorage:false`. This preserves the vendor/device-side time-trigger configuration already verified on the cameras. Parameter files remain available for explicit operator/API maintenance, but default startup does not depend on `lvm_load_dev_param` succeeding.

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
  "expectedCameras": 8,
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

`save-all` writes files named `<camera-ip-with-underscores>.nccfg`. `load-all` can either load explicit per-camera files through `cameraFiles[]` or fall back to the selected directory by safe IP, then model and serial number. Cameras omitted from `ips` are not touched, which lets the Tauri configuration page mix "use camera built-in/current parameters" with "load this `.nccfg` file" per camera. External absolute files require `allowExternal:true`.

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
      "ip": "192.168.101.100",
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

{"ip":"192.168.101.100","devType":-1}
```

```http
POST /api/cameras/connect-all
Content-Type: application/json

{"expectedCameras":8,"devType":-1}
```

`/api/camera/connect-all` is accepted as an alias. The provider discovers cameras, connects them sequentially, and keeps software trigger mode enabled.

```http
POST /api/camera/disconnect
Content-Type: application/json

{"ip":"192.168.101.100"}
```

The provider should force software trigger mode during connect.

## Camera Status

```http
GET /api/camera/status?ip=192.168.101.100
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
GET /api/param?ip=192.168.101.100&key=TriggerMode&type=int
```

```http
POST /api/param
Content-Type: application/json

{"ip":"192.168.101.100","key":"ExposureTime","type":"int","value":850}
```

Trigger mode must remain software-triggered for this deployment.

## Production Steel State

The provider keeps a lightweight production state model so API-only callers and the Tauri overview can use the same entry/exit-steel state. This state does not directly open SDK streams; it records the business phase that should drive higher-level line logic.

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
  "connectedCameras": 8,
  "streamingCameras": 0,
  "expectedCameras": 8
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

The provider uses per-camera roots from the active profile or `POST /api/storage/camera-roots`; the current eight-camera default maps the known IPs to `H:/camera1` through `H:/camera8` when drive `H:` exists. If a camera root is not configured, it falls back to `<storageRoot>/<camera-id>`, where `<camera-id>` is the camera SN when available or the IP. The default data-name directories are `depth`, `intensity`, and `metadata`; `sdk-derived` is written only when a capture request explicitly sends `saveSdkDerived:true` or `save_sdk_derived:true`. The production session summary still lives under `<storageRoot>/production/<safe-steel-id>/<sessionId>/summary.json`. Explicit `output` and `outputDir` values still take precedence unless `productionLayout:true` is sent to `/api/capture/continuous-test`.

Production capture calls may send `steelStateAware:true` or `requireSteelPresent:true`. When the provider has not received entry-steel/save state, it returns code `49000` (`CAPTURE_DISCARDED_NOT_ARMED`) and does not write frame images. When `discardBlackFrames:true`, a frame whose intensity image is below `blackFrameThreshold` returns code `49001` (`BLACK_FRAME_DISCARDED`); depth, intensity, and optional SDK-derived images are removed, while metadata records `discarded:true` and `discardReason:"black-frame"`.

Example:

```text
H:/camera1/MAT-20260707-001/depth/000001.png
H:/camera1/MAT-20260707-001/intensity/000001.png
H:/camera1/MAT-20260707-001/metadata/000001.json
```

The diagnostic viewer and Tauri capture page use the latest-file endpoint to preview only the newest saved artifact for a selected camera:

```http
GET /api/capture/latest?ip=192.168.101.100&kind=depth
GET /api/capture/latest?ip=192.168.101.100&kind=intensity
GET /api/capture/latest?ip=192.168.101.100&kind=metadata
GET /api/capture/latest?ip=192.168.101.100&kind=sdk-derived
```

Add `meta=1` to receive a JSON wrapper with the file path and `/api/capture/file` URL instead of the file body.

Tauri calls the same paths through Rust. The capture page polls metadata every three seconds, keeps all file reads on the Rust origin, and switches among depth, intensity, metadata JSON, and explicitly enabled SDK-derived artifacts. Live preview uses the proxied `/api/stream/start`, `/api/stream/stop`, `/api/stream/status`, and `/api/stream/latest` routes; it does not create an SDK session in the client.

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
POST /api/production/tasks
POST /api/production/tasks/steel-info
POST /api/production/tasks/steel-in
POST /api/production/tasks/steel-out
POST /api/production/tasks/trigger-event
GET  /api/production/tasks
GET  /api/production/tasks/detail?id=TASK-ID
POST /api/production/tasks/cancel
POST /api/production/tasks/retry
```

`/api/production/steel-in` writes `material_session` and `production_inspection` before forwarding `steelIn` to the provider. `/api/production/capture-once` triggers provider `/api/capture/continuous-test` with `productionLayout:true`, `steelStateAware:true`, `requireSteelPresent:true`, and `discardBlackFrames:true`; it records only returned artifacts whose `*Exists` flag is true. The Rust service uses a production-aware provider read timeout derived from `rounds`, `timeoutMs`, `intervalMs`, and `retries`, clamped between 60 seconds and 3600 seconds, so a long production capture can keep running without being failed by the normal short HTTP proxy timeout. After the provider returns, the Rust service points `summaryOutput` and `latestInspection.summaryPath` to `<storageRoot>/production/<safe-material-id>/<sessionId>/summary.json`; after `steel-out`, it rewrites that file as `steel.production.summary.v1`, including the session, inspection, provider response, and every recorded `capture_file` row. `/api/production/algorithm/run` runs the bar-surface reconstruction for the current or specified `materialId`, writes Python prototype outputs under `G:/bar-surface-algorithm`, runs the C++ core by default, and updates `production_inspection.status` to `algorithm-complete` or `algorithm-failed`. The algorithm request accepts contour crop controls (`contourCrop`, `contourRadiusToleranceMm`, `contourMinKeepRatio`, `contourMinRowCoverage`, `contourAutoPercentile`); by default the Python prototype derives per-camera 2D crop boxes from calibrated 3D round-bar contour fitting and clips the final 3D mesh to that contour.

### Persistent production tasks

Tauri and the standalone trigger gateway use the task API for durable production commands instead of holding the original command request open. The persistent worker supports `steel-info`, `steel-in`, `capture-once`, `algorithm-run`, `steel-out`, and `trigger-event`. The four steel/event kinds have the explicit enqueue routes listed above; capture and algorithm use the generic task endpoint. Secondary-data, capture-summary, and defect ingest remain synchronous record-ingest routes.

Every persisted task exposes `chainId`, `dependsOnTaskId`, `dependencyPolicy`, and `blockedReason`. If callers omit dependency metadata, Rust reuses the session's stable chain and links the new task to the latest task in that chain. A material/session cannot fork into a different chain. `require-success` tasks wait until their direct predecessor succeeds; a failed, cancelled, interrupted, missing, or blocked predecessor recursively moves queued descendants to terminal `blocked` without calling the provider or algorithm. Retrying the failed parent requeues its blocked descendants. Safety-critical kinds reject `always-run`; only an explicitly safe `trigger-event` cleanup may use it.

Tauri does not call the gateway origin directly. Rust exposes an explicit operator proxy allowlist for `GET /api/trigger/status`, `GET|POST /api/trigger/mode`, and `POST /api/trigger/manual/steel-info|steel-in|steel-out`. Proxy status, content type, and body are preserved; an unreachable gateway returns a bounded 503 and a timeout returns 504 without exposing the configured gateway origin. The gateway forwards manual steel commands back to the event-specific durable Rust routes.

### HTTP API, TCP, and UDP trigger transports

The standalone trigger gateway listens on HTTP `4881`, TCP `4882`, and UDP
`4883` by default. Set `TRIGGER_TCP_PORT=0` or `TRIGGER_UDP_PORT=0` to disable a
network listener. The active trigger mode accepts `api`, `tcp`, `udp`, `gray`,
`secondary`, or `manual`; the status response includes the configured listener
addresses.

TCP is newline-delimited UTF-8 JSON (one request and one response per line).
UDP is one UTF-8 JSON object per datagram, with one response datagram returned
to the sender. Development loopback may explicitly disable authentication. Production always requires HMAC-SHA256 authentication and refuses to start without `TRIGGER_SHARED_SECRET` containing at least 32 bytes. A non-loopback production bind also requires `TRIGGER_SOURCE_ALLOWLIST` containing exact IP and/or CIDR rules.

The canonical signature input is the UTF-8 byte sequence below, with LF separators and no trailing newline:

```text
steel-trigger-v1
<unix timestamp seconds>
<unique nonce>
<transport: http|tcp|udp>
<body>
```

For HTTP, `<body>` is the exact request body and clients send its lowercase hexadecimal HMAC-SHA256 in `X-Trigger-Signature`, alongside `X-Trigger-Timestamp` and `X-Trigger-Nonce`. For TCP/UDP, `<body>` is the compact, key-sorted JSON serialization of `payload`, and both transports use this envelope:

```json
{
  "auth": {
    "timestamp": "1784116800",
    "nonce": "plc-a-cycle-1042-in",
    "signature": "lowercase-hex-hmac-sha256"
  },
  "payload": {
    "event": "steel-in",
    "requestId": "plc-cycle-1042-in",
    "materialId": "BAR-20260714-001",
    "present": true,
    "value": 1
  }
}
```

The default acceptance window is 30 seconds (`TRIGGER_AUTH_WINDOW_SECONDS`, allowed range 5–300). Nonces are 16–128 ASCII letters, digits, `-`, `_`, `.`, or `:` and are single-use across every transport during the replay window. Invalid signatures/timestamps return 401, a reused nonce returns 409 `trigger_replay_detected`, and a disallowed source returns 403 `trigger_source_forbidden`. Gateway status exposes only boolean listener/security state, never internal origins, hosts, ports, secrets, signatures, or nonces. Responses do not emit wildcard CORS.

Operator mutations use a separate trust boundary. Production also requires `TRIGGER_OPERATOR_TOKEN` with at least 32 bytes, different from the upstream HMAC secret. Tauri sends its administrator session only to Rust; Rust requires `admin.services`, writes an audit record, and forwards `X-Trigger-Operator-Token` over the local Rust-to-gateway hop. The gateway accepts that token only from loopback and compares it without data-dependent early exit. Direct production manual requests without the token return 401 `trigger_operator_auth_required`; the local HTML manual page is disabled in production. `POST /api/trigger/capture-once` is included in this authenticated operator proxy so formal stability tests do not bypass the Rust authorization boundary.

`event` may be `steel-info`, `steel-in`, `steel-out`, `secondary-data`,
`capture-once`, `capture-summary`, `defect`, or `event`. `type` and `action` are
accepted as aliases for `event`; underscore event names are normalized to
hyphens. Every response contains `code`, `transport`, `mode`, `target`, and the
inspection service response. PLC/L2 clients should reuse a stable `requestId`
when retrying the same command.

Run the English standard-library demo for a complete info/in/wait/out cycle:

```powershell
python scripts/trigger_demo.py --transport api
python scripts/trigger_demo.py --transport tcp --hold-seconds 10
python scripts/trigger_demo.py --transport udp --material-id BAR-DEMO-001
```

The original synchronous steel routes remain compatibility APIs. They cannot overtake accepted durable work: while a production task is queued or running, a synchronous steel event returns HTTP 409 `production_tasks_in_progress`. The formal Tauri and trigger-gateway paths enqueue instead.

```http
POST /api/production/tasks
Content-Type: application/json

{
  "kind": "capture-once",
  "idempotencyKey": "operator-request-20260711-001",
  "chainId": "SESSION-001",
  "dependsOnTaskId": "TASK-STEEL-IN-001",
  "dependencyPolicy": "require-success",
  "maxAttempts": 1,
  "payload": {
    "materialId": "MAT-001",
    "sessionId": "SESSION-001",
    "rounds": 1,
    "lines": 1000,
    "productionLayout": true,
    "requireSteelPresent": true
  }
}
```

`chainId`, `dependsOnTaskId`, and `dependencyPolicy` may be omitted for the normal sequential flow; the service derives the stable chain and direct predecessor. Clients must treat `blocked` as terminal and display the persisted `error`/`blockedReason`. A retry is accepted only after the dependency is ready.

The first accepted enqueue returns HTTP 202 with `duplicate:false`. The task is stored before the worker is notified. `idempotencyKey` (or `requestId` on the event-specific routes) is scoped by normalized task kind: the same key and byte-equivalent normalized JSON payload returns the existing task with HTTP 200 and `duplicate:true`; different work under the same compound key returns HTTP 409 `idempotency_conflict`. When no key is supplied, Rust generates a task-specific stored key, but PLC/L2 retrying the same command must supply a stable request ID.

Task IDs include a fixed-width monotonic sequence, so commands accepted in the same millisecond retain FIFO order. Pending steel-info/steel-in/capture/algorithm/steel-out work reuses the material/session identity already reserved by the earlier task instead of creating a new session for each queue item. A failed predecessor does not currently auto-cancel its dependants; each later task reaches its own terminal validation result.

The queue capacity is controlled by `STEEL_PRODUCTION_TASK_QUEUE_CAPACITY`, defaults to 128, and is clamped to 1..4096. A full queue returns HTTP 429. Tasks expose:

- `taskId`, `idempotencyKey`, `kind`, `materialId`, and `sessionId`
- `status`: `queued`, `running`, `succeeded`, `failed`, `cancelled`, or `interrupted`
- `phase`, `progress`, `attempts`, `maxAttempts`, and `cancelRequested`
- persisted `result`, `error`, and lifecycle timestamps

```http
GET /api/production/tasks?status=failed&kind=algorithm-run&limit=50&offset=0
GET /api/production/tasks/detail?id=TASK-1783771200000-0
```

List responses include worker heartbeat, active task ID, recovered-task count, queue capacity, and pagination. `GET /api/production/status` also includes task worker and queue-depth status.

```http
POST /api/production/tasks/cancel
Content-Type: application/json

{"taskId":"TASK-1783771200000-0"}
```

A queued task becomes `cancelled` immediately. A running task returns HTTP 202 with `cancelRequested:true`; cancellation is observed at the synchronous provider boundary. If dispatch has not happened, the worker records `cancelled`. Once the provider call is in progress, Rust cannot interrupt it or undo device/file side effects, so the provider's real success/failure remains the terminal status; the late cancel intent stays visible and is audited instead of falsely reporting that completed work was cancelled.

```http
POST /api/production/tasks/retry
Content-Type: application/json

{"taskId":"TASK-1783771200000-0"}
```

Only `failed`, `cancelled`, and `interrupted` tasks can be explicitly requeued. `maxAttempts` is persisted and bounded, but failure does not trigger automatic replay. On service startup, a task left `running` becomes `interrupted`; if it already had `cancelRequested:true`, it becomes `cancelled`. Restart recovery never silently repeats a provider or algorithm call, and an interrupted task reports that explicit retry is required.

### Production record read model

Administrator record list, detail, CSV export, delete, and retention APIs use the same production tables as the operator snapshot: `production_inspection` is the record, `material_session` supplies material dimensions, `production_defect` supplies defect detail/severity counts, and `capture_file` supplies captured artifacts. The legacy `inspection_record`, `steel_plate`, and `defect` demo tables are not the administrator read model.

Single-record delete and retention use a persistent mark-clean-confirm lifecycle. `record_cleanup` freezes a `steel.record-artifact-cleanup.v1` manifest containing canonical paths, sizes, and SHA-256 values. `STEEL_ARTIFACT_ALLOWED_ROOTS` must enumerate narrow production capture, summary, and reconstruction roots. Execution revalidates the root, regular-file type, size, and hash before each delete and records per-file progress. Only after all artifacts are deleted or verifiably missing does one database transaction delete the selected `production_inspection` plus its `production_defect` and `capture_file` rows and mark the cleanup completed. It retains `material_session` and trigger/secondary-data history. Active sessions and records with unresolved production tasks are excluded; a hash/path/delete failure preserves database indexes and returns a retryable cleanup ID.

```http
GET  /api/admin/records/cleanup?id=CLEANUP-ID
POST /api/admin/records/cleanup/retry
Content-Type: application/json

{"cleanupId":"CLEANUP-ID"}
```

Both routes require `admin.records`. Batch retention returns planned/deleted/missing file and byte totals. A partial batch returns HTTP 207 with per-record `recordId`, optional `cleanupId`, and error; successful records remain committed and failed records remain retryable.

SQLite `GET /api/admin/database/backup` creates an online consistent snapshot with `VACUUM INTO`; it never copies the live database file. MySQL returns a server-side-job requirement and is backed up with `scripts/backup-database.ps1`, which uses a single-transaction `mysqldump` and emits a SHA-256 manifest. `scripts/restore-database.ps1` verifies that manifest and requires an exact confirmation phrase before an offline SQLite or controlled MySQL restore.

Demo inspection data is disabled by default. Set `STEEL_SEED_DEMO_DATA=1` (also accepts `true`, `yes`, or `on`) only for an explicit development fixture; defect-type defaults remain available without enabling demo records.

### Persistent production alarms

Severe and review defect ingest creates a `production_alarm` in the same database transaction as the defect. The alarm ID is a stable fingerprint of the upstream defect/idempotency key and normalized defect facts, so retrying the same defect does not create a duplicate alarm. Minor defects do not create alarms.

```http
GET  /api/alarms?status=open&severity=severe&source=production-defect&keyword=MAT-001&limit=20&offset=0
POST /api/alarms/acknowledge
POST /api/alarms/resolve
```

List status accepts `open`, `active`, `acknowledged`, `resolved`, `history`, or `all` and returns global active/acknowledged/resolved counts. State changes require `admin.records`; the actor is derived from the authenticated Bearer session and is never trusted from the request body. Both actions require a non-empty note of at most 1000 characters. The only valid transition is `active -> acknowledged -> resolved`; same-state retry returns HTTP 200 with `changed:false`, an invalid transition returns HTTP 409, and the first actor/note is retained. Creation and both transitions are written to the audit log.

The task queue makes Rust command ownership durable, and the C++ service has a bounded item/byte writer queue with backpressure, metrics, failure propagation, and shutdown drain. Current task cancellation must not be described as immediate SDK cancellation. The final cross-round/frame-transaction behavior and the real-SDK format-specific storage boundary are described in the storage section and still require a fresh eight-camera hardware regression after writer changes.

### Rust service health

The Rust boundary exposes layered health endpoints:

```http
GET /api/health/live
GET /api/health/ready
GET /api/health/ready/details
GET /api/health/details
GET /api/health
```

`/live` is a fast process liveness probe and does not touch dependencies. `/ready` performs a real database ping, checks the persistent-task worker, requires the persistent calibration-reconciliation ledger to have no `dispatching` or `needs-reconciliation` rows, probes `/health` and `/api/storage/status` on a configured non-simulated capture provider, and probes the standalone trigger gateway. It returns HTTP 503 if a required component is unavailable. Capture storage must exist, be writable, and have a writer queue accepting work. A worker inside a long synchronous provider call is reported as `busy` instead of being rejected solely because its idle heartbeat is paused. Explicit capture simulation is reported as `simulated` without pretending that a physical SDK is present; trigger readiness can be disabled only by the explicit development setting `STEEL_TRIGGER_HEALTH_REQUIRED=0`.

`/details` and `/ready/details` return the same readiness decision plus bounded database, worker, capture, `calibrationReconciliation`, storage, trigger, latency, and uptime fields. The reconciliation check exposes only the unresolved count plus operation ID/kind/status/error/time needed by Tauri; it does not expose request bodies or artifact paths. These endpoints do not include the database URL/path, capture or trigger origin, executable path, IP address, raw provider response, or raw worker errors. The legacy `/api/health` path remains available but now follows the readiness result instead of returning unconditional success. Each HTTP probe has a bounded deadline and a one-MiB response cap.

In production runtime profile Rust also evaluates the same bounded checks every ten seconds after a five-second startup grace period. Storage warning/critical, capture unavailability or restart requirements, task-worker failure, unresolved calibration operations, required trigger failure, missing algorithm qualification, invalid production policy, Supervisor restart-budget exhaustion, and an invalid Supervisor status contract become persistent `source=system-health` alarms. Supervisor state is read from the atomic `StateRoot/service/supervisor-status.json` contract; an exhausted budget remains visible across Supervisor exit and is cleared only after a stable runtime recovery. A continuing condition refreshes the original open alarm instead of inserting duplicates. Recovery automatically records server-owned acknowledgement/resolution fields; a later recurrence creates a new alarm ID, preserving incident history. Development runtime profiles do not start this background monitor. A simulated provider under the production profile is intentionally monitored and produces algorithm/policy alarms because that combination is not production-qualified.

The Rust service also exposes a review-only bar-surface calibration fit endpoint:

```http
POST /api/algorithm/bar-surface/calibration/fit
Content-Type: application/json

{
  "materialId": "BAR-E2E-20260708-013823",
  "captureRoot": "H:/",
  "calibrationPath": "config/capture/calibrations/current-8-time-trigger/ArrayCalibration.xml",
  "rows": "250,500,750",
  "maxPointsPerCamera": 2400,
  "maxShiftMm": 5
}
```

For direct review calls, it can read the production layout `H:/camera1..camera8/<materialId>/metadata`; it also accepts `dataDir` to fit one provider-returned continuous-test directory. It runs the X/Z cross-section fitter and returns target-detection evidence, `fitBefore`, `fitAfter`, per-camera `dx/dz`, `fit_report.json`, and—only after the gates pass—`ArrayCalibration.corrected.xml`. The capture-fit route may activate the corrected reconstruction pointer automatically, but it never saves parameters to camera devices.

The Tauri automatic-calibration button does not fit arbitrary old material. It enqueues a durable `algorithm-run` task with `operation:"calibration-capture-fit"`. Rust captures one round and requires exactly eight unique successful results, eight complete frames, eight metadata commits, a real on-disk summary, and no simulated URI. The fitter then requires an actual round target to pass point-count, diameter, angular-coverage, robust-inlier, and residual gates. A corrected XML is generated and automatically activated only when the correction-quality gate passes; no step writes per-camera devices.

## Depth Capture

```http
POST /api/capture/depth-map
Content-Type: application/json

{
  "ip": "192.168.101.100",
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
  "ip": "192.168.101.100",
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

On a real provider, this blocking endpoint and the preview alias return `409`
while continuous production acquisition is running. They must never call the
vendor SDK concurrently with the background worker for the same camera. Switch
capture mode to `on-demand` (which performs the bounded continuous-worker stop)
before a maintenance/diagnostic blocking capture, then explicitly restore the
desired mode. Simulated fixtures remain able to exercise both paths together.

## Preview Capture

```http
POST /api/preview/capture
POST /api/capture/preview
Content-Type: application/json

{
  "ip": "192.168.101.100",
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

The provider resolves the existing target with `canonical` and accepts only a regular file whose resolved path is below `CAPTURE_STORAGE_ROOT` or one of the configured per-camera roots. The current working directory is not an allowed read root; lexical traversal, shared-prefix siblings, symlink, and junction escapes are rejected. The latest-capture and stream-file routes apply the same resolved-root policy.

Returns a PNG image when the output file exists and is inside the provider's allowed capture directory.

## Auto-Connect And Continuous Capture Test

Auto-connect and continuous capture are available as provider APIs and are used by the Tauri capture page and `scripts/test-capture-continuous.ps1`; they do not require additional Rust service business logic.

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
  "expectedCameras": 8,
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

The provider response includes `parallel: true`, `syncMode: "round-start-condition-variable+storage-ticket-pipeline"`, `workerCount`, aggregate `completeFrames`, `metadataFrames`, `storageAsyncFrames`, the pending-ticket limit, overlap count, and explicit `frameTransaction:true`/`metadataCommitLast:true`. Each `results[]` entry includes its storage ticket ID/timestamps, depth format/persistence mode, `parallelIndex`, round/worker timestamps, `depthExists`, `intensityExists`, `metadataExists`, and `completeFrame`.

The provider also writes its response-shaped summary to `<storageRoot>/<outputDir>/summary.json` and returns `summaryOutput` plus `summaryExists`. This gives API-only callers the same durable audit trail that the PowerShell script creates.

For the current eight-camera line configuration, `controlMode: 0` is the default continuous capture mode, matching the vendor demo's "连续采集" setting. The provider still enforces software control with the time trigger source (`triggerInputType: 4`). The SDK value for depth + intensity capture is `captureDataType: 3` (`LVM_BT_DEPTH_INTENSITY`).

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
  "ip": "192.168.101.100",
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

{"ip":"192.168.101.100"}
```

```http
GET /api/stream/status?ip=192.168.101.100
GET /api/stream/latest?ip=192.168.101.100&kind=depth
GET /api/stream/latest?ip=192.168.101.100&kind=intensity
```

`/api/stream/latest` returns the latest PNG frame when one has been saved.

## Calibration And ROI

Array reconstruction XML and per-camera SDK calibration XML are separate artifacts. `ArrayCalibration.corrected.xml` is used by reconstruction/profile activation and must never be sent to `lvm_load_calib_param`. A camera apply requires one distinct SDK XML mapping per camera.

```http
POST /api/calibration/load
Content-Type: application/json

{
  "ip": "192.168.101.100",
  "path": "config/calibrations/reviewed/camera-105.xml",
  "expectedSn": "YF-0263",
  "dryRun": false,
  "allowExternal": false,
  "confirmation": "APPLY CAMERA CALIBRATION"
}
```

`dryRun:true` performs the single-camera static preflight without calling the SDK and does not require the apply phrase. A real single-camera maintenance apply requires the exact phrase `APPLY CAMERA CALIBRATION`; it enters the same snapshot/rollback-token workflow used by the set operation.

```http
GET /api/calibration/active?profile=current-8-time-trigger
```

Returns the active array-calibration pointer recorded by the profile, the absolute path if it can be resolved, and the latest `activeCalibration` metadata. This is the stitching/profile calibration file used by the operator workflow, not necessarily a file accepted by the vendor per-camera SDK loader.

```http
POST /api/calibration/active
Content-Type: application/json

{
  "operationId": "calibration-apply-20260712-001",
  "name": "current-8-time-trigger",
  "path": "config/calibrations/current-8-time-trigger/array-calibration-fit-20260713-140000/ArrayCalibration.corrected.xml",
  "fitReport": "config/calibrations/current-8-time-trigger/array-calibration-fit-20260713-140000/fit_report.json"
}
```

Updates only the current profile pointer and `activeCalibration` metadata. It does not touch connected cameras.

The Tauri automatic-calibration review flow uses this endpoint with `saveToDevice:false`. It may activate a trusted local fitter output with `allowExternal:true`, but it must clearly report that only the array reconstruction pointer changed.

### Formal eight-camera apply

```http
POST /api/calibration/apply-all
Content-Type: application/json

{
  "name": "current-8-time-trigger",
  "path": "config/calibrations/current-8-time-trigger/array-calibration-fit-20260713-140000/ArrayCalibration.corrected.xml",
  "ips": [
    "192.168.101.100",
    "192.168.102.100",
    "192.168.103.100",
    "192.168.104.100",
    "192.168.105.100",
    "192.168.106.100",
    "192.168.107.100",
    "192.168.108.100"
  ],
  "expectedCameras": 8,
  "cameraCalibrations": [
    {
      "ip": "192.168.101.100",
      "expectedSn": "3G506601BE09220",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/reviewed/camera-101.xml",
      "rollbackPath": "config/calibrations/known-good/camera-101.xml"
    },
    {
      "ip": "192.168.102.100",
      "expectedSn": "3G506501CA09164",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/reviewed/camera-102.xml",
      "rollbackPath": "config/calibrations/known-good/camera-102.xml"
    },
    {
      "ip": "192.168.103.100",
      "expectedSn": "3G506401RE08999",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/reviewed/camera-103.xml",
      "rollbackPath": "config/calibrations/known-good/camera-103.xml"
    },
    {
      "ip": "192.168.104.100",
      "expectedSn": "YF-0270",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/reviewed/camera-104.xml",
      "rollbackPath": "config/calibrations/known-good/camera-104.xml"
    },
    {
      "ip": "192.168.105.100",
      "expectedSn": "3G506601BE09221",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/reviewed/camera-105.xml",
      "rollbackPath": "config/calibrations/known-good/camera-105.xml"
    },
    {
      "ip": "192.168.106.100",
      "expectedSn": "3G506501CA09163",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/reviewed/camera-106.xml",
      "rollbackPath": "config/calibrations/known-good/camera-106.xml"
    },
    {
      "ip": "192.168.107.100",
      "expectedSn": "3G506401RE08995",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/reviewed/camera-107.xml",
      "rollbackPath": "config/calibrations/known-good/camera-107.xml"
    },
    {
      "ip": "192.168.108.100",
      "expectedSn": "YF-0269",
      "artifactType": "camera-sdk",
      "path": "config/calibrations/reviewed/camera-108.xml",
      "rollbackPath": "config/calibrations/known-good/camera-108.xml"
    }
  ],
  "dryRun": false,
  "stopStreams": true,
  "atomic": true,
  "rollbackOnFailure": true,
  "requireAllMapped": true,
  "persistActive": true,
  "saveCameraParams": false,
  "saveToDevice": false,
  "allowBestEffortDeviceRollback": false,
  "confirmation": "APPLY CAMERA CALIBRATION SET"
}
```

The formal Rust proxy requires all of the following before forwarding either dry-run or real apply:

- exactly eight unique `ips` and eight matching `cameraCalibrations`;
- a non-empty, set-unique `expectedSn` and a distinct normalized SDK `path` for every camera; formal clients send `artifactType:"camera-sdk"` explicitly;
- `expectedCameras:8`, `stopStreams:true`, `atomic:true`, `rollbackOnFailure:true`, and `requireAllMapped:true`;
- `saveCameraParams:false` and `allowBestEffortDeviceRollback:false`.
- for a real apply, a caller-owned `operationId` of at most 128 ASCII letters/digits or `-_.:` characters; dry-run does not enter the mutation ledger.

`saveCameraParams:true` is rejected by the formal Rust route because writing `.nccfg` snapshots is not covered by the calibration atomic rollback transaction. Use the separate admin camera-parameter maintenance workflow instead.

`dryRun:true` repeats mapping, artifact-kind, SN, connection, stream, durable rollback-file, and rollback-capability checks without allocating a token or calling the SDK. Every mapping on the formal Rust route must provide a verified `rollbackPath`, regardless of `saveToDevice`, so an interrupted process can recover from staged files instead of depending on an in-memory vendor structure. A real apply requires the exact phrase `confirmation:"APPLY CAMERA CALIBRATION SET"`. `saveToDevice` defaults to `false`; if enabled, the request additionally needs `deviceConfirmation:"PERSIST CAMERA PARAMETERS"`. Best-effort-only rollback is not accepted by the formal route.

The `steel.capture.calibration-apply.v2` response contains `operationId`, aggregate `applied`, `failed`, `skipped`, and `rolledBack` counts, `rollbackToken`, `rollbackPerformed`, `rollbackComplete`, and one `results[]` entry per camera. Each entry carries the same `operationId`, separates `preflightCode`, `applyCode`, `persistCode`, and `rollbackCode`, and reports `rollbackMode`, `attempted`, `applied`, `rolledBack`, `skipped`, artifact paths, and a message. On an atomic failure, attempted cameras are restored in reverse order.

### Explicit rollback

```http
POST /api/calibration/rollback
Content-Type: application/json

{
  "operationId": "calibration-rollback-20260712-001",
  "applyOperationId": "calibration-apply-20260712-001",
  "parentOperationId": "calibration-apply-20260712-001",
  "rollbackToken": "calrb-...",
  "stopStreams": true,
  "confirmation": "ROLLBACK CAMERA CALIBRATION"
}
```

The exact phrase `ROLLBACK CAMERA CALIBRATION`, a new caller-owned `operationId`, and the original successful apply's `applyOperationId` are mandatory. The explicit apply correlation is persisted even for an ordinary rollback, so a process crash during rollback can later be reconciled safely. `parentOperationId` is omitted for an ordinary rollback; through an active Rust fence it identifies the unresolved apply or rollback row. Schema `steel.capture.calibration-rollback.v1` returns top-level `operationId`, the original `applyOperationId`, `complete`, `consumed`, `failed`, `skipped`, `rolledBack`, `profileChanged`, `profileRestored`, and `profileCode`. Rust derives the expected apply ID from the unresolved row: an interrupted apply expects its own ID, while an interrupted rollback expects the `applyOperationId` stored in that rollback request. Provider evidence must match before the unresolved parent becomes `reconciled`.

SN, generation, staged-file fingerprint, disconnected-camera, running-stream, consumed-token, and pre-write manifest failures return the rollback schema with `complete:false`, `attempted:false`, and `sideEffects:false`. Rust records this as a decisive failed preflight rather than `needs-reconciliation`; no SDK write may have occurred. Any rollback response without that explicit zero-write pair and without `complete:true` remains ambiguous and closes the reconciliation fence.

### Persistent Rust operation ledger

Real apply and every rollback enter Rust's `calibration_operation` table before the provider call. The stored row contains the operation kind, normalized JSON and stable request hash, server-owned actor, parent/reconciliation fields, row version, `dispatching/succeeded/failed/needs-reconciliation/reconciled` status, provider HTTP/body, error, and timestamps.

- The same `operationId`, kind, and normalized request is single-flight. A concurrent duplicate receives HTTP 202 with `status:"dispatching"`; a completed duplicate receives the stored provider result without another SDK call.
- `/api/calibration/apply-all` always enters the dedicated Rust calibration handler. JSON object keys must be unique at every level; a dry-run is re-serialized from the uniquely parsed value before proxying, so conflicting duplicate `dryRun` fields cannot select different Rust and C++ behavior.
- Only one distinct calibration operation may dispatch from a Rust service process at a time. A second ID receives HTTP 409 `calibration_operation_in_progress` instead of waiting in the C++ queue and risking a device write after the caller's timeout.
- Reusing the ID for different work returns HTTP 409 `calibration_operation_id_conflict`.
- Provider timeout/unavailability, an undecidable response, an incomplete automatic rollback, or `complete:false` from explicit rollback is persisted as `needs-reconciliation`.
- Rust binds its formal listen port before startup recovery; after ownership is established, any row left `dispatching` becomes `needs-reconciliation` and is never automatically replayed.
- Any unresolved row closes the `calibrationReconciliation` readiness check. New calibration and device/config parameter mutations return HTTP 423 `calibration_reconciliation_required` with the unresolved operation IDs; normal new apply/rollback cannot bypass the fence.
- The only safe closure is a rollback with a new `operationId` and the unresolved apply's `parentOperationId`. After C++ returns `complete:true` and the same `applyOperationId`, Rust conditionally changes the parent to `reconciled`, records `reconciliationOutcome:"restored-to-staged-baseline"`, the child reconciliation ID, actor, resolution time, and an incremented row version. There is no endpoint for manually marking an uncertain operation successful or failed.
- Tauri retains the same ID across timeout retries, preserves structured 423 evidence, displays all reconciliation fields, and only enables parent-bound recovery for a confirmed `needs-reconciliation` parent.

The authenticated detail API is:

```http
GET /api/calibration/operations/detail?id=calibration-apply-20260712-001
```

It requires `admin.config` and returns `operationId`, kind, request hash/body, status, `needsReconciliation`, provider result, actor, `parentOperationId`, `reconciliationOutcome`, `reconciliationId`, `resolvedBy`, `resolvedAt`, `rowVersion`, and timestamps.

Every formal eight-camera mapping must include a known-good `rollbackPath`, even when `saveToDevice:false`. Before the first SDK write, C++ copies those files below `<CAPTURE_CONFIG_ROOT>/calibration-rollbacks/<token>/<safe-operationId>/previous`, verifies SHA-256+size, marks the staged copies read-only, and flushes an atomic `steel.capture.calibration-rollback-manifest.v1`. The manifest carries token/operation/profile state, camera IP/SN, target and staged previous paths, fingerprints, attempted flags, save mode, phase, and consumed state. Original rollback files may be moved or changed after apply without changing the staged recovery bytes.

Clean restart reloads durable manifests and binds only the newest token for each IP/SN generation. `applied` is an ordinary unconsumed rollback asset; `prepared`, `applying`, `rolling-back`, and `rollback-failed` require explicit recovery. Such phases—or any corrupt/unreadable manifest—make provider `/health` report `ready:false`, `sdkReady:false`, `recoveryRequired:true`, `invalidManifest`, and `pendingRecoveryCount`; all new provider writes return HTTP 423 except camera connect/disconnect, stream stop, and explicit rollback. A successful staged rollback persists `rolled-back/consumed` and reopens readiness. A corrupt manifest has no override and remains fail-closed. Exact `lvm_calib_param_t` runtime snapshots are still process-local and are never serialized; cross-restart recovery uses only the staged SDK files.

Controlled real-hardware crash testing is disabled unless all four environment bindings are present: `CAPTURE_CALIBRATION_CRASH_CONFIRMATION=ALLOW CONTROLLED CAMERA CALIBRATION PROCESS CRASH`, an exact `CAPTURE_CALIBRATION_CRASH_OPERATION_ID`, one supported `CAPTURE_CALIBRATION_CRASH_PHASE`, and a one-based `CAPTURE_CALIBRATION_CRASH_CAMERA_INDEX`. The provider health response exposes whether this operation/phase/camera-bound failpoint is armed. Supported phases are `apply-before-sdk`, `apply-after-sdk`, `automatic-rollback-after-camera`, `rollback-before-camera`, and `rollback-after-camera`. The recovery process must be restarted with every crash variable cleared before any rollback is attempted.

### ROI and maintenance records

```http
POST /api/roi/load
Content-Type: application/json

{
  "ip": "192.168.101.100",
  "path": "config/calibrations/reviewed/CAM-01-roi.xml",
  "allowExternal": false,
  "confirmation": "APPLY CAMERA ROI"
}
```

The exact phrase `APPLY CAMERA ROI` is mandatory. With the default `allowExternal:false`, the canonical target must be an existing regular file below the provider storage root or config root. Relative paths are provider-local; traversal, symlink/junction escape, directories, and other external paths are rejected. `allowExternal:true` is an explicit admin maintenance opt-in and still requires a canonical regular file.

```http
GET /api/calibration/status?ip=192.168.101.100
```

Calibration apply, rollback, and ROI apply append best-effort JSON Lines records to the path below. Validation capture appends a record when `calibrationMaintenanceRecord:true`; the Tauri validation helper sets this flag.

```text
<CAPTURE_STORAGE_ROOT>/maintenance/calibration-records.jsonl
```

Each `steel.capture.calibration-maintenance.v1` line contains `recordedAt`, `action`, camera `ip` and `sn`, artifact `path`, `rollbackToken`, `operationId`, and `code`. `/api/calibration/status` also returns the most recent `operationId` and resolved `maintenanceRecordPath`.

### Dangerous line-continuous preset

`POST /api/capture/preset/line-continuous` is a diagnostic/maintenance route, not a production startup step. The formal Rust route requires `admin.config` and the exact phrase `confirmation:"APPLY LINE CONTINUOUS PRESET"`. It validates `lines` in 1-100000, `timeTriggerFreq` in 0.1-100000, `laserPower` in 0-100, `laserLineSelect` in 0-2, and `controlMode` in 0-1. `connectFirst` and `saveToDevice` default to `false`. Persisting this preset to devices additionally requires the exact phrase `deviceConfirmation:"PERSIST LINE PRESET TO CAMERA DEVICES"`. Formal production profiles never call this route automatically.

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
- `external-api`: another compatible process owns the SDK and Rust only proxies to it.
- `simulated`: Rust does not call a provider.

## Storage capacity contract

`GET /api/storage/status` reports capacity for the global storage root and every configured camera root. Each root includes `capacityAvailable`, `capacityBytes`, `freeBytes`, and `freePercent` in addition to existence and writability. Rust does not expose root paths through readiness; it publishes the minimum capacity/free values across all roots.

For a non-simulated provider, Rust derives a warning watermark at twice `STEEL_STORAGE_MIN_FREE_BYTES` and five percentage points above `STEEL_STORAGE_MIN_FREE_PERCENT`. Crossing either warning watermark returns `ok=true`, `status=warning`, `level=warning`, and `warningReason=storage_capacity_near_watermark`; readiness remains open and the Tauri header displays the minimum free GiB, free percentage, and estimated remaining hours. Crossing either hard watermark returns `ok=false`, `status=unavailable`, `level=critical`, and `reason=storage_capacity_below_watermark`; it closes readiness and blocks only new `steel-info`/`steel-in` admission while allowing retries and `steel-out` for the current session. Defaults are hard values of 20 GiB and 10%; deployments set both explicitly from the production retention/capacity calculation. Missing capacity fields are a contract failure, not an assumed healthy state. The writer queue also reports successful bytes completed in the last 60 seconds; Rust publishes `recentWriteBytesPerSecond` and derives `estimatedRemainingSeconds` when the rate is nonzero. Failed writes never increase that rate.
