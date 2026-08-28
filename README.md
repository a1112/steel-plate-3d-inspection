# Steel Inspection Runtime and Bar Surface 3D Reconstruction

Bar surface 3D reconstruction workspace with independent runtime boundaries:

> Release status (2026-07-16): **No-Go for formal production.** Release packaging and verification now distinguish `formal-release` from `engineering`, fail closed on source/build/version/signature/catalog violations, and verify the package again before service installation. The current workspace is still dirty, all synchronized product manifests still use the blocked placeholder version `0.1.0`, and there is no matching release tag, real release certificate, signed catalog, signed MSI/NSIS pair, or approved vendor-signature evidence. Existing outputs therefore remain engineering evidence only; algorithm approval, target-machine service acceptance, and current eight-camera/OT/recovery evidence are also still required.

```text
Tauri/React operator client: app/client
  -> Rust inspection service: app/service
    -> headless C++ capture provider: app/capture
      -> LVM/NVT cameras

Tauri trigger status/mode/manual controls
  -> Rust /api/trigger/* allowlist
    -> standalone trigger gateway: app/trigger

L2 / PLC / external trigger
  -> standalone trigger gateway
    -> Rust durable production-task APIs
```

## Runtime Boundaries

- `app/capture`: C++ SDK capture core plus headless local API executable. It exclusively owns the camera SDK and commits frames through bounded asynchronous transactions with backpressure, metadata-last publication, error propagation, and shutdown drain.
- `app/service`: Rust backend for business APIs, configuration, records, auth, alarms, layered health, capture-provider proxying, and the persistent FIFO production-task worker. In managed headless mode it is also the capture-process supervisor: it owns the child process tree, lifecycle state, readiness gate, bounded restart/backoff policy, logs, and shutdown ordering.
- `app/trigger`: standalone external-event gateway. PLC/L2/gray/manual events enqueue durable Rust tasks; Rust also proxies the formal operator trigger allowlist to this process.
- `app/client`: Tauri/React client. It calls Rust only, including trigger status/mode/manual controls, and does not link or ship the camera SDK.

The capture API contract is documented in [docs/capture-api-contract.md](docs/capture-api-contract.md). The full architecture notes are in [docs/independent-architecture.md](docs/independent-architecture.md).
The integrated capture-management acceptance matrix is in [docs/integrated-capture-management-acceptance.md](docs/integrated-capture-management-acceptance.md).
The Qt-to-Tauri capability matrix, production gates, and diagnostic-retirement decisions are in [docs/qt-to-tauri-migration.md](docs/qt-to-tauri-migration.md).
The production readiness gap assessment, closure design, and Go/No-Go checklist are in [docs/production-readiness-gap-and-closure-design.md](docs/production-readiness-gap-and-closure-design.md).
The versioned payload, schema ledger, persistent upgrade journal, crash recovery, and fault-injection contract is in [docs/atomic-upgrade-and-database-migration-design.md](docs/atomic-upgrade-and-database-migration-design.md); it remains a P0 No-Go until its target-machine evidence is complete.
The release, two-stage installation, offline prerequisites, supervisor acceptance, operations, and evidence SOP is in [docs/release-deployment-and-operations.md](docs/release-deployment-and-operations.md).
The real SICK GenTL bring-up, single-camera sidecar integration, LG_3D-compatible storage contract, and FAT checklist are in [docs/sick-gentl-capture.md](docs/sick-gentl-capture.md).
The current `10.50.111.141` handoff state and the safe six-camera continuation procedure are in [docs/10.50.111.141-server-continuation.md](docs/10.50.111.141-server-continuation.md).
The independent server-side FRP HTTP tunnel setup, local-only credential handling, and startup verification are in [docs/frp-server-http-tunnel.md](docs/frp-server-http-tunnel.md).

## Migration Status

- The Tauri operator surface covers overview, camera configuration and readback, parameterized realtime preview (`width/dataMode/fpsLimit/hs`), merged provider/operation logs, per-camera batch results, target-gated automatic eight-camera calibration, durable production controls, inspection records, and persistent alarms.
- Rust persists and serializes `steel-info -> steel-in -> capture-once -> steel-out` work (plus algorithm and generic trigger tasks), while the headless C++ process owns all SDK and frame-storage work.
- Real eight-camera calibration apply/rollback uses a persistent Rust `operationId` ledger and a C++ write-ahead rollback manifest. Every formal mapping requires an expected camera SN and a known-good `rollbackPath`; C++ stages immutable copies with SHA-256 before the first SDK write. Interrupted or undecidable work closes Rust readiness and device writes with an HTTP 423 fence, and only a provider-confirmed parent-bound rollback can move the parent row to `reconciled`—there is no manual “mark successful” shortcut.
- Durable tasks expose operation-specific persisted progress. Hard-timeout SDK workers remain process-owned, poison capture with `49007/restartRequired`, and cannot outlive camera/SDK teardown.
- Managed capture now exposes `starting / ready / collecting / degraded / stopping / stopped` lifecycle semantics through `GET /api/capture/lifecycle`. Rust confirms SDK restart requests twice, restarts only the capture child with bounded exponential backoff, and stops automatic recovery after the configured restart budget is exhausted. Administrative start/stop/restart remains permission-gated.
- Online production 3D and point-cloud views are bound to the selected inspection's persisted algorithm artifact; only explicit demo/test data may use bundled surfaces or simulated point clouds.
- Qt source, build paths, provider compatibility switches, and package branches have been removed. The operator runtime is Tauri/React -> Rust -> headless C++.
- The simulated runtime acceptance has passed. A fresh eight-camera capture/calibration stability run is still required for production sign-off after these changes.
- `test-real-calibration-acceptance.ps1` defaults to dry-run; real apply/rollback requires a reviewed eight-camera plan, an `admin.config` token, an explicit mutation switch, and an exact safety phrase.
- Controlled process-crash recovery is available through `test-real-calibration-crash-recovery.ps1`. Its failpoint is disabled by default and bound to an exact confirmation, apply operation ID, phase, and camera index. Full live coverage requires successful ApplyCrash and RollbackCrash Resume reports; interrupted rollback reconciliation preserves the original apply correlation explicitly.
- `test-real-calibration-integrity-generation.ps1` completes the remaining rollback-safety evidence by proving stale-generation and staged-hash rejection are zero-write decisions before restoring the staged bytes and validating all eight cameras.

## Quick Start

Choose an environment template from [config/env](config/env), or pass values on the command line.

### Site configuration

The active installation is selected by `config/project.json`. Its
`activeSiteConfig` points to a package under `config/sites/<site-id>`:

- `site.json` identifies the site and fixes its mode (`bkv` or `direct-camera`);
- `runtime.json` defines the provider, camera count and capabilities;
- `connection.json` contains non-secret connection settings;
- `capture.json` contains capture-side settings used by direct-camera sites.

Create, clone, check and switch packages from **后台管理 -> 全局配置**. The mode is
chosen when a package is created and is immutable afterwards because it changes
which configuration modules and runtime services are available. BKV sites hide
direct-camera capture and 3D-reconstruction management; direct-camera sites
expose only the capabilities enabled by their runtime profile.

Run the availability check before activation. It validates package structure,
referenced files, mode/capability consistency, camera mapping and required
connection fields. Activation updates the project pointer and sets
`pendingRestart`; it does not hot-swap the running service. Restart the Rust
service to load the selected package. The administration overview shows both
the running package and any pending restart so operators can confirm whether
the switch has taken effect.

Files under `config/runtime-modes` remain compatibility/import templates for
older deployments. New site selection and editing start from `config/project.json`
and the selected `config/sites` package.

For local macOS/Linux development without cameras, start the Rust service,
independent trigger gateway, and operator client together in explicit
eight-camera simulation mode:

```bash
scripts/run-simulated-dev.sh
```

To run the same simulated stack inside the Tauri desktop shell:

```bash
scripts/run-simulated-dev.sh --tauri
```

The Tauri command keeps its Cargo build directory under the local simulation
state root by default, which avoids AppleDouble metadata generated by some
external macOS volumes. Set `TAURI_CARGO_TARGET_DIR` to override it.

The client is available at `http://127.0.0.1:1432`, the service at
`http://127.0.0.1:4873`, the trigger gateway at `http://127.0.0.1:4881`, and
local state plus logs are written below
`${XDG_STATE_HOME:-$HOME/.local/state}/steel-plate-3d-inspection/simulated-dev`.
Set `STEEL_SIM_STATE_DIR` to override that location. Press `Ctrl+C` to stop both
the backend processes and client.

Service registration is configuration-driven from
[`config/service-registry.json`](config/service-registry.json). The Rust
service resolves each service origin/port and lifecycle policy from that file,
and exposes a loopback-only `GET /api/runtime/status` snapshot containing
service readiness, supervisor/task-worker runtime state, and bounded log tails.
The independent Tauri server monitor consumes this snapshot; it does not own
or mutate the service process.

Development and test profiles support SQLite, MySQL, and PostgreSQL through
SeaORM. Remote development databases can opt into an explicit SQLite fallback:

```bash
STEEL_DATABASE_ENGINE=postgres \
STEEL_DATABASE_FALLBACK=sqlite \
scripts/run-simulated-dev.sh
```

The same configuration is available in
`config/env/simulated-mysql.env.example` and
`config/env/simulated-postgres.env.example`. Fallback is used only when the
primary connection cannot be established. Schema corruption, dirty migrations,
and incompatible versions still fail startup, and production rejects fallback
and the PostgreSQL development adapter. Data written while fallback is active
stays in that SQLite file and is not automatically merged into the primary.

Build the headless capture provider:

```powershell
scripts/build-capture-headless.ps1
```

Build the Rust service and client independently:

```powershell
scripts/build-service.ps1
scripts/build-trigger-gateway.ps1
scripts/build-client.ps1
```

Run the Rust service with the headless provider:

```powershell
scripts/run-service.ps1 -Provider headless-cpp -CaptureExe target\capture\Release\steel_capture_service.exe
```

Or with an env file:

```powershell
scripts/run-service.ps1 -EnvFile config/env/headless-cpp.env.example
```

Start a standalone browser-based administration surface without starting any
capture provider, trigger gateway, or production workflow:

```powershell
scripts/start-background-management.ps1
```

The launcher binds the business API to loopback, builds and serves the admin UI,
and verifies through `/api/capture/lifecycle` that capture autostart, capture PID,
and capture control are all disabled before opening the browser. Press `Ctrl+C`
to stop it. Use `-SkipBuild` after a successful build, `-NoBrowser` for console-only
operation, or `-Detach` to leave the business API running in the background. Its
service build is isolated under `target/cargo-background-management`, so a running
development service cannot lock the executable being rebuilt.

Run the standalone trigger gateway in another terminal. Rust readiness remains false until the required gateway is reachable:

```powershell
scripts/run-trigger-gateway.ps1 -EnvFile config/env/trigger-gateway.env.example
```

Run the web client in another terminal:

```powershell
scripts/run-client-dev.ps1 -ServicePort 4873 -VitePort 1432
```

Or with the client env template:

```powershell
scripts/run-client-dev.ps1 -EnvFile config/env/client.env.example
```

Serve the already built frontend without Vite:

```powershell
scripts/run-client-static.ps1 -Port 1432
```

Run the Tauri desktop shell in another terminal:

```powershell
scripts/run-tauri-dev.ps1 -ServicePort 4873
```

For a BKV online debug session, pass an ignored local environment file so the
algorithm service receives the production source credentials while the
inspection service remains a result-store proxy:

```powershell
scripts/run-tauri-dev.ps1 -EnvFile config/env/bkv-online.env.local
```

The launcher writes debug service output below `target/run/tauri-dev/logs`,
requests an initial algorithm rescan, and keeps the Tauri client on the local
4873 API. The operator client uses frontend port `1432`. The independent
`steel-inspection-server-monitor.exe` uses frontend port `1433` in development
and is built with `scripts/build-server-monitor.ps1`; it does not share the
operator process, start production tasks, or control the Windows service. See
[`app/server-monitor/README.md`](app/server-monitor/README.md) for its build and
runtime boundary.

To start the already-built headless capture, Rust, trigger, and static-client processes together, use:

```powershell
scripts/start-integrated-capture-management.ps1 -ArtifactAllowedRoots "H:\camera1;H:\camera2;H:\camera3;H:\camera4;H:\camera5;H:\camera6;H:\camera7;H:\camera8;H:\production;H:\reconstruction" -TriggerMode manual -OpenBrowser
```

## Versioned sample data

The full BKV `1908500` dataset is stored separately in the private
[`a1112/sample-data`](https://github.com/a1112/sample-data) repository and is
pinned by commit. It is not included in normal source clones.

```bash
python scripts/fetch_sample_data.py
python scripts/fetch_sample_data.py --check
scripts/run-bkv-sample-dev.sh
```

The fetcher uses a sparse Git checkout, reconstructs the versioned artifact,
validates every source file and SHA-256 digest, and publishes the cache under
`target/sample-data-cache`. See [docs/sample-data.md](docs/sample-data.md).

## Verification

Passing the simulated acceptance or the integrated 24/24 matrix alone is not a production release decision. The separate algorithm-qualification, signing, offline-installation, service-lifecycle, disaster-recovery, and site-signoff gates remain mandatory.

Run the architecture verification suite:

```powershell
scripts/verify-independent-architecture.ps1
```

This checks the client/service/capture boundaries, runs tests, builds the service, builds the frontend, builds the headless capture provider, verifies Rust can proxy to an independently started external capture provider, and creates the runtime package folders.

Run the Qt-free packaged simulated acceptance independently with:

```powershell
scripts/test-runtime-acceptance.ps1
```

This validates the runtime layout and the simulated service/trigger/client flow, including persisted durable steel tasks. Real production sign-off still requires `scripts/test-real-hardware-acceptance.ps1 -RunCapture` plus the eight-camera SDK frame-transaction checks described in [docs/qt-to-tauri-migration.md](docs/qt-to-tauri-migration.md).

Stop local runtime processes:

```powershell
scripts/stop-runtime.ps1
```

Create deployable runtime folders:

```powershell
$env:STEEL_RELEASE_POLICY_SHA256 = '<64-hex hash from release approval>'
scripts/package-runtime.ps1
```

The package is written to `target/packages/steel-inspection-runtime` and includes root-level launch scripts for capture, service, simulated service, and process shutdown. The latest engineering rebuild passed 33 required-layout checks and packaged 28 PowerShell scripts; those counts describe layout coverage, not formal-release readiness.
It also includes `run-client-static.ps1` for serving the packaged frontend independently.

The generated manifest declares either `packageClass=formal-release` or `packageClass=engineering`. A formal package refuses `-SkipBuild`, `-AllowDirtyWorktree`, `-AllowDebugPackage`, and `-SkipDesktopBundle`; requires the out-of-band approved release-policy hash; clears the known build roots; runs `npm ci`; rebuilds all deliverables in that invocation; and rechecks the exact Git HEAD and clean worktree after the builds and again before writing the manifest. It rejects automatically merged Tauri configs, unreviewed `TAURI_*`/Rust compiler and Cargo profile overrides, and unapproved Cargo config files. It builds the desktop explicitly for `x86_64-pc-windows-msvc`, requires empty Tauri Cargo features plus release `debug-assertions=false`, and verifies the PE machine of the desktop/runtime binaries. It stores SHA-256 evidence for the npm lockfile, the Tauri/service/trigger Cargo lockfiles, the policy-pinned Cargo config, and the exact Tauri configuration and Cargo manifest. Its synchronized canonical `x.y.z` `releaseVersion` must have no numeric leading zeros, match the desktop/runtime manifests, and bind an exact `v<version>` or `<version>` tag on the source commit. `0.1.0` is explicitly blocked.

For a formal package, `checksums.sha256` is a two-way complete inventory: verification rejects a missing, extra, duplicate, excluded, or hash-mismatched entry. Its only exclusions are `checksums.sha256` itself and `release-integrity.cat`. The timestamp-signed SHA-256 Windows catalog covers the checksum inventory and every payload file; the catalog itself is Authenticode-signed. Package-only verification defaults to formal and establishes trust from out-of-band first-party/vendor signers, the approved desktop publisher, the 64-hex release-policy SHA-256, and the catalog before executing packaged checks. The package carries `build-evidence/desktop-release-policy.json` and `tauri-feature-resolution.json` as objects to verify, never as trust anchors. Engineering verification is explicit and does not execute package code unless separately authorized for a locally trusted build. The implementation is present, but no signed formal package/catalog has yet been produced from this workspace.

## Production Installation Boundary

Production deployment is intentionally two-stage:

1. An administrator installs the background runtime package as the `SteelInspectionRuntime` Windows service. The signed payload remains in an immutable `RuntimeRoot`; mutable config, logs, SQLite/service state, capture configuration, temporary files, and working directories live in a separate `StateRoot` (default `%ProgramData%\SteelInspectionRuntime`). Secrets and the approved algorithm report must remain outside both roots. The install command requires a real `steel.algorithm-acceptance.v1` report with `status=pass`; the example report is intentionally pending and cannot be used.
2. The operator installs the signed Tauri MSI or NSIS desktop client separately. The desktop client does not install, start, stop, or supervise the background service.

The server can additionally run `steel-inspection-server-monitor.exe` as an independent interactive-user Tauri process. Its Rust worker reads health and durable-task summaries every five seconds; closing its window hides only that window while the monitor remains in the system tray. It does not depend on the operator client, does not control SCM, and remains separate from the privileged `steel-inspection-tray.exe` companion. See the [independent monitor build and runtime notes](app/server-monitor/README.md).

Before either stage, validate the configured offline WebView2 installer and Microsoft-signed `VC_redist.x64.exe`, then verify package signatures, the two-way checksum inventory, and the signed Windows catalog with deployment-controlled first-party and vendor signer thumbprints; follow [the deployment and operations SOP](docs/release-deployment-and-operations.md). The package-only verifier and service installer implement these fail-closed checks, including tamper rejection before mutable state is written. Current artifacts remain unsigned, no signed catalog or formal MSI/NSIS has been generated, and the immutable-runtime/state-root flow still needs elevated target-machine acceptance.
