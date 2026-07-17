# Integrated Capture Management Acceptance Matrix

This matrix defines what must be true before the integrated capture-management goal can be treated as accepted on the current eight-camera round-steel system.

This is an integration acceptance matrix, not the complete production Go/No-Go decision. Even a new, unskipped `24/24` result does not close algorithm qualification, signed/offline installation, Windows-service lifecycle, ACL, disaster-recovery, OT, soak, or responsible-owner approval gates. Those separate gates are defined in [the release, deployment, and operations SOP](release-deployment-and-operations.md).

## Scope

The accepted system is the integrated runtime made of:

- Headless C++ capture provider as the only formal process owning LVM/NVT SDK handles.
- Rust inspection service as the production API, database, provider proxy, and orchestration layer.
- Standalone trigger gateway as the API/gray/secondary/manual trigger adapter.
- Tauri/React client as the operator UI for terminal, capture management, configuration, and 3D reconstruction.
- H-drive production storage under `H:\camera1` through `H:\camera8`.
- Bar-surface 3D reconstruction using the corrected calibration and calibrated 3D contour crop.

## Full Coverage Command

Use this command after the real stack and client are already running:

```powershell
scripts/test-integrated-capture-management-full.ps1 `
  -RunShortStability `
  -StabilityUseTriggerGateway `
  -RunBarSurface `
  -RequireFullCoverage `
  -StabilityDurationSec 45 `
  -StabilityIntervalSec 0
```

For a ten-minute soak, change `-StabilityDurationSec 45` to `-StabilityDurationSec 600` and keep `-RequireFullCoverage`.

After the full coverage report exists, run the itemized audit:

```powershell
scripts/test-integrated-acceptance-audit.ps1
```

Before packaging or synchronizing a runtime, the source-only migration contract can be checked without starting any service:

```powershell
scripts/test-architecture-migration-contract.ps1
```

The source-only contract is accepted at `9/9`. Its checks are:

1. six-kind durable production tasks;
2. trigger/Tauri durable dispatch with caller idempotency;
3. production HTTP/TCP/UDP trigger HMAC authentication, timestamp/nonce replay protection, IP/CIDR source policy, operator authorization, mode locking, status redaction, no wildcard CORS, and a shipped live security gate;
4. layered readiness, including the persistent calibration-reconciliation fence;
5. persistent alarm lifecycle;
6. persistent production-data lifecycle, including allowed-root/hash-frozen cleanup, file-before-index ordering, retryable progress, retained sessions, online SQLite snapshots, and verified server-side MySQL backup/restore;
7. one Windows SCM runtime supervisor source boundary declaring ordered readiness, reverse shutdown, bounded restart, log handling, process-tree containment, and fail-closed secret/config preflight; this static check is not target-machine SCM/drain/rotation/recovery evidence;
8. former Qt operation coverage through the Tauri -> Rust -> headless C++ chain, including parameterized realtime preview, merged real logs, per-camera disconnect evidence, target-gated capture-before-fit automatic calibration, four latest artifact kinds, safe eight-camera calibration/rollback, and maintenance JSONL;
9. persistent calibration-operation single-flight/idempotency, 423/readiness fencing, parent-bound reconciliation without replay, Tauri resolution evidence, and C++ staged cross-restart rollback.

The sixth through ninth checks read only explicitly named source and runtime-configuration files. They do not scan `target`, packaged/minified frontend output, object files, or executables.

Packaging records the verified contract in `manifest.json`; `test-runtime-layout.ps1` validates that structured contract again without scanning minified JavaScript or compiled executable strings.

The integration audit report is accepted only when `code=0` and `summary.passed=24`.

The report is accepted only when:

- `code` is `0`.
- `coverage.full` is `true`.
- `coverage.covered` equals `coverage.required`.
- `coverage.uncovered` is empty.
- No required check is skipped.

## Additional Production Release Gates

The following evidence is deliberately outside the `24/24` integration count and remains mandatory for production:

- an approved `steel.algorithm-acceptance.v1` report with `status=pass`, exact production-config hash, frozen dataset/evaluator evidence, script/core/release/calibration binding, signed owners, and a real per-run traceability audit;
- a `packageClass=formal-release` candidate built from a clean, tagged commit with locked Release profiles and a canonical stable `x.y.z` version (no numeric leading zeros and not `0.1.0`). Formal packaging must reject `SkipBuild`, clear the known build roots, run `npm ci`, rebuild every deliverable in that invocation, recheck the exact HEAD/clean state twice, and bind one `releaseVersion` to the source commit, exact Git tag, desktop/runtime versions, four dependency lockfiles, the exact Tauri configuration/Cargo manifest, the reviewed desktop release policy, resolved Tauri feature evidence, reproducible dependencies, and SBOM;
- valid Authenticode signatures and trusted timestamps for installers, desktop EXE, every first-party background EXE and the vendor SDK DLL. The automatic formal-package gate now covers them, but current artifacts are unsigned and real certificate/timestamp/vendor evidence remains absent;
- a two-way complete `checksums.sha256` inventory plus a timestamp-signed SHA-256 Windows catalog. Formal checksums exclude exactly themselves and the catalog; the catalog covers the checksum file and every payload, while the catalog itself is Authenticode-signed. Generation, package-only verification, install-time full-catalog verification, deployment-side signer allowlists, and tamper rejection are implemented, but no real signed catalog/formal package/certificate evidence exists yet;
- offline target-machine installation of the configured WebView2 offline installer, Microsoft-signed `VC_redist.x64.exe`, camera SDK/driver, database and algorithm runtime prerequisites;
- elevated target-machine evidence for service install/start/stop, application readiness, child process-tree recovery, business drain, restart budget, log rotation, ACL, upgrade/rollback and uninstall. Evidence must prove an immutable signed `RuntimeRoot`, a separate mutable `StateRoot` (default `%ProgramData%\SteelInspectionRuntime`), full catalog verification before state writes, and an approved migration path for any legacy in-tree mutable state;
- backup/new-machine restore, real OT protocol/network, current eight-camera soak, quality metrics, and cross-functional signoff.

The example algorithm acceptance report is intentionally pending and cannot satisfy this gate.

## Requirement Matrix

| ID | Requirement | Required evidence |
| --- | --- | --- |
| ICM-01 | Runtime package contains the headless C++ capture provider, Rust service, trigger gateway, frontend client, config, launch scripts, and acceptance scripts. | `test-runtime-layout.ps1` passes in `target/runtime` and `target/packages/steel-inspection-runtime`. |
| ICM-02 | Runtime boundaries remain independent: client calls Rust only, trigger gateway forwards to Rust only, Rust does not link camera SDK, and exactly one headless capture provider owns SDK handles. | `verify-independent-architecture.ps1` passes. |
| ICM-03 | Live stack is reachable: capture provider, Rust production API, trigger gateway, network monitor, and terminal client. | `test-integrated-runtime-ready.ps1` passes inside the full coverage report. |
| ICM-04 | Eight real cameras are discovered/connected through the LVM/NVT provider and `H:\camera1..camera8` roots are mapped and writable. | `test-real-hardware-acceptance.ps1` passes inside the full coverage report with exactly eight unique camera IP/SN mappings and no skipped hardware item. |
| ICM-05 | Current camera configuration is read back from hardware without silently overwriting the operator's device configuration. | Real-hardware acceptance confirms camera config readback and current profile state. |
| ICM-06 | Trigger flow can enter through the standalone trigger gateway in manual mode and reach Rust production APIs. | Full coverage report includes `trigger-gateway-route` covered by `test-production-stability.ps1 -UseTriggerGateway`. |
| ICM-07 | Production steel-in writes the inspection/session record before capture starts. | Production stability report shows steel-in and record-before-capture for every cycle. |
| ICM-08 | Capture uses parallel eight-camera execution and produces complete frames for all cameras. | Production stability cycles report `parallel=true`, `workerCount=8`, `successes=8`, `completeFrames=8`. |
| ICM-09 | Production storage writes `depth`, `intensity`, and `metadata` under `H:\camera1..camera8\<material>` and keeps `sdk-derived` disabled by default. | Production stability layout for every cycle and the H-drive folder counts. |
| ICM-10 | Production summary is written under `H:\production\<material>\<session>\summary.json` and references all eight-camera files. | Production stability `summary` reports schema `steel.production.summary.v1`, 24 files, eight depth, eight intensity, eight metadata. |
| ICM-11 | Steel-out ends the session and clears active capture/save state. | Production stability post-status shows no active session after every cycle. |
| ICM-12 | Terminal UI, capture management UI, and 3D reconstruction UI render and expose key controls. | `test-runtime-ui-smoke.ps1` passes inside the full coverage report. |
| ICM-13 | Receiver network popover shows monitoring-only realtime upload, realtime download, and bandwidth fields, with no limiting controls or estimated-speed fallback. | UI smoke checks the receiver popover, `/api/system/network` rate fields, and verifies that `estimated-speed fallback` is absent. |
| ICM-14 | Latest eight-camera production capture can be consumed by the bar-surface reconstruction API. | `test-bar-surface-e2e.ps1 -SkipCapture -MaterialId <latest>` passes inside the full coverage report. |
| ICM-15 | 3D reconstruction outputs mesh, texture, artifact index, acceptance report, and C++ core binary output. | Bar-surface e2e report includes manifest, artifact index, acceptance report, and nonzero core bytes. |
| ICM-16 | 3D contour crop is applied from calibrated 3D data, not a static image-only preview. | Bar-surface e2e manifest reports `contourCrop.applied=true` and `contourCrop.source=calibrated-3d`. |
| ICM-17 | The headless C++ provider is declared as the sole SDK owner; Qt source and runtime artifacts are absent, and former Qt operations are reachable through Tauri -> Rust -> C++. | The package manifest declares `formalCapture=headless-cpp` and `capture.role=formal-sdk-owner`. The fifth source migration check verifies four latest artifact kinds, safe eight-camera calibration/rollback, maintenance JSONL, and the formal chain. |
| ICM-18 | The full coverage acceptance command is shipped in the package and cannot silently lose coverage checks. | `test-runtime-layout.ps1` and `verify-independent-architecture.ps1` require `RequireFullCoverage`, `coverage`, and `trigger-gateway-route` text in packaged scripts. |
| ICM-19 | Rust exposes a persistent dependency-gated production task worker for `capture-once`, `algorithm-run`, `steel-info`, `steel-in`, `steel-out`, and `trigger-event`. | `test-architecture-migration-contract.ps1` verifies the SeaORM task table, six canonical kinds, durable route dispatch, FIFO-ready claim, stable single-chain identity, `require-success` propagation to terminal `blocked`, restart recovery, descendant requeue on retry, and safety-critical rejection of `always-run`; the runtime manifest records the exact kinds, routes, fields, policies, and behavior flags. |
| ICM-20 | Trigger gateway and Tauri dispatch production commands to durable Rust task routes while preserving a stable caller `requestId` for idempotency. | The migration contract verifies the four trigger mappings, Tauri durable task routes, caller-ID preservation, Rust idempotency lookup/conflict behavior, and focused Trigger/Tauri tests. |
| ICM-21 | Layered Rust readiness gates on database, task worker, capture, persistent calibration reconciliation, storage, required-by-default trigger health, algorithm qualification, and production policy. | The migration contract verifies `/api/health/details`, `/api/storage/status`, `/api/trigger/status`, bounded health tests, the database-backed reconciliation fence, default-required trigger policy, and production algorithm fail-closed policy; `test-integrated-runtime-ready.ps1` must require all eight components to be healthy. |
| ICM-22 | Persistent alarms expose open/history queries and an audited `active -> acknowledged -> resolved` state machine through the Tauri alarm center. | The migration contract verifies the SeaORM alarm table, transactional defect/alarm ingest, list/acknowledge/resolve APIs, server-owned actor/audit notes, frontend `AlarmCenter` entry, and focused Rust/Tauri tests. |
| ICM-23 | Real eight-camera calibration apply/rollback uses a persistent caller-correlated ledger, a readiness/device-write fence, nested parent-bound recovery, and staged cross-restart rollback without automatically replaying an interrupted SDK mutation. | The live audit requires real apply/rollback, successful `ApplyCrash` and `RollbackCrash` Resume reports, and `test-real-calibration-integrity-generation.ps1`. Evidence must prove the unresolved Rust row, original `applyOperationId`, exact reconciliation parent, staged rollback, stale-generation and staged-hash rejection with `attempted:false/sideEffects:false`, unchanged camera/maintenance evidence, reopened readiness, and eight validation frames. |
| ICM-24 | Production HTTP/TCP/UDP trigger ingress is fail-closed, HMAC-authenticated, replay-protected, source-restricted, mode-locked, status-redacted, and free of wildcard CORS. Manual mutations require an authenticated `admin.services` session and are audited. | `test-trigger-gateway-security.ps1` must pass from the packaged binary and its report must prove missing-secret startup failure, signed acceptance plus replay rejection for all three transports, configured source policy, locked mode mutation, redacted status, and `wildcardCors:false`. The architecture manifest records the exact trigger-security contract. |

## Engineering Evidence Snapshot

The following snapshot was rechecked against the uncommitted workspace on 2026-07-15, before the latest algorithm-traceability and Supervisor hardening changes. It is useful for engineering comparison only; all counts and builds must be rerun on the final clean commit:

- frontend: `25` files and `171/171` tests pass; production build passes
- Rust service: `117/117` tests pass; trigger gateway: `11/11` tests pass
- source migration contract: `9/9`; `production-trigger-security` covers HMAC, replay/source controls, operator authorization and status/CORS boundaries, `persistent-data-lifecycle` covers durable cleanup ordering, SQLite/MySQL database recovery, and immutable report-archive validation/backup/offline-restore boundaries, and `windows-runtime-supervisor` checks the declared SCM host/recovery source boundary without replacing live lifecycle evidence
- C++ `steel_runtime_supervisor` Release build and its earlier source/packaged preflight passed; that preflight accepts UTF-8 BOM configuration while rejecting duplicate keys, secret-policy override, and incomplete runtime layout. It does not prove child-log inheritance, process-tree containment, all trigger listeners, application-level readiness, SCM state, drain, live rotation, ACL, recovery, or upgrade behavior; current hardening and an elevated target-machine acceptance window remain required
- subsequent 2026-07-16 hardening added inherited-stdio handle restriction, suspended-start Job Object containment, whole-tree termination, synchronous HTTP/TCP/UDP trigger binding, and application-level readiness probes. The Supervisor Release build, trigger 13/13, Release security smoke, explicit TCP/UDP port-conflict checks and supervisor check passed. Final clean-commit reruns plus elevated SCM/drain/rotation/ACL/recovery/upgrade acceptance remain required
- installer hardening now requires elevation and deployment-side first-party/vendor signer thumbprints; protects the complete signed RuntimeRoot as read/execute; validates the timestamped catalog and all required PE/DLL signers before writing state; and separates RuntimeRoot, mutable StateRoot, external secret/report policy paths, and the production-data write domain before ACL/SCM/file writes (storage/camera/artifact roots may overlap only within their own data domain). All three install-related PowerShell files parse, the freshly selected Supervisor Release target compiles, the static install contract passes, and `test-runtime-supervisor.ps1` exits 0. That regression proves the four-domain separation and rejects a stale Supervisor binary, duplicate env, secret override, invalid production policy, overlapping roots, external SQLite, and incomplete layout; the static contract also checks no catalog skip list, out-of-band signers, release version, ACL/order/rollback/uninstall paths. Actual elevated signed-package install, legacy-state migration, upgrade-failure rollback/uninstall, effective ACLs, SCM, and port timing remain target-machine evidence
- isolated package-verifier fixtures pass a valid engineering package, reject an unlisted extra file and a hash-modified listed file, and prove that a checksum-adjusted malicious packaged migration script is not executed without `-AllowPackageCodeExecution` (no external marker is created). Default-formal verification rejects the old engineering package and leaves its complete directory hash unchanged. These are engineering trust-boundary tests, not signed formal catalog evidence
- C++ headless provider: five of six CTest entries complete successfully; the simulated frame-pipeline entry is environment-blocked because a live `steel_capture_service` owns the global SDK-owner mutex and must be rerun on an isolated agent or in a maintenance window
- `target/packages/steel-inspection-runtime` has been fully rebuilt from the dirty workspace as an engineering package. It passes 33 required-layout checks, carries 28 PowerShell scripts, and passes both static no-code-execution verification and explicitly trusted local package-code verification. It has no desktop bundle or signed catalog and is not a signed release candidate. `target/runtime` remains absent, and both outputs must be regenerated from the eventual clean, tagged, non-placeholder Release commit
- on 2026-07-16, the locked Tauri no-bundle Release build completed in 56.64 seconds and produced `target/cargo/release/steel-plate-3d-inspection-tauri.exe` at 23,113,728 bytes with production devtools feature count zero. The bundle download reached/extracted WixTools314, then network I/O stalled and the diagnostic was terminated; `target/cargo/release/bundle` does not exist, MSI=0 and NSIS=0. This is not a Rust source-build failure. The EXE is `NotSigned` and depends on `VCRUNTIME140.dll`
- formal acceptance scripts now require exact eight-camera counts, unique IP/SN evidence, and the packaged trigger-security smoke; they still must be executed against the live eight-camera profile before a new `24/24` report can certify the current release

These current-workspace results supersede the software counts below. The older reports remain useful historical evidence only.

## Historical Evidence Snapshot

Latest Qt-free post-migration simulated evidence (Release, 2026-07-12):

```text
D:\project\steel-plate-3d-inspection\target\packages\steel-inspection-runtime\logs\integrated-smoke\reports\integrated-smoke-20260712-060652-437.json
D:\project\steel-plate-3d-inspection\target\runtime\logs\integrated-smoke\reports\integrated-smoke-20260712-060810-551.json
D:\project\steel-plate-3d-inspection\target\runtime\logs\ui-smoke\20260712-060933-011\ui-smoke-report.json
```

Observed result:

- source migration contract: `6/6`, including `qt-capability-formal-chain` and `persistent-calibration-operation-ledger`
- frontend: `24` files and `156/156` tests pass; production build passes
- Rust service: `99/99` tests pass; trigger gateway: `6/6` tests pass
- C++ headless provider: `5/5` CTest suites pass
- package and `target/runtime` layouts both report `qtRemoved:true`
- package and runtime smoke both complete the durable steel-info -> steel-in -> eight-camera capture -> steel-out chain
- each smoke capture reports `workerCount:6`, `parallel:true`, `completeFrames:6`, `metadataFrames:6`, and `captureFileRows:18`
- browser UI smoke passes the terminal, capture-management, and 3D-reconstruction pages on the formal `1432/4873` ports
- calibration apply/rollback now uses a database-backed `operationId` ledger plus staged C++ rollback manifests; tests prove same-ID single-flight, rejection of a distinct queued operation, duplicate-key-safe dry-run routing, terminal replay, conflict rejection, 423/readiness fencing, nested interrupted-rollback reconciliation, provider restart recovery, an actual operation/phase/camera-bound provider process exit, hash/SN/generation validation, and fail-closed invalid manifests

These results certify the Qt-free software/runtime boundary with the simulated driver. They do not supersede the real-camera evidence or close the post-writer/post-calibration hardware gate below.

Latest full coverage report:

```text
D:\project\steel-plate-3d-inspection\target\logs\integrated-capture-management\integrated-capture-management-20260709-111851-322.json
D:\project\steel-plate-3d-inspection\target\logs\integrated-capture-management\integrated-capture-management-20260709-121522-831.json
```

Observed result:

- `code=0`
- `coverage.full=true`
- `coverage.covered=7`
- `coverage.required=7`
- short stability material: `BAR-STABILITY-20260709-121618-010`
- short stability cycles: `10/10`, failures `0`
- short capture frames: `60`
- short metadata frames: `60`
- historical itemized audit: `18/18` requirements passed before ICM-19 through ICM-23 and the real-calibration live check were added
- historical source migration-contract audit: `6/6` static architecture checks passed before `production-trigger-security` was added
- latest source audit report: `D:\project\steel-plate-3d-inspection\target\logs\integrated-capture-management\acceptance-audit-20260709-125503-276.json`
- latest runtime audit report: `D:\project\steel-plate-3d-inspection\target\runtime\logs\integrated-capture-management\acceptance-audit-20260709-125850-744.json`
- latest package audit report: `D:\project\steel-plate-3d-inspection\target\packages\steel-inspection-runtime\logs\integrated-capture-management\acceptance-audit-20260709-130111-474.json`
- UI smoke: terminal/capture/3D reconstruction pages pass, receiver network popover shows realtime upload/download/bandwidth and rejects `estimated-speed fallback`
- latest UI smoke report: `D:\project\steel-plate-3d-inspection\target\runtime\logs\ui-smoke\20260709-125221-272\ui-smoke-report.json`
- 3D acceptance: `pass`
- contour crop source: `calibrated-3d`
- mesh: `20736` vertices, `37648` triangles

Latest ten-minute stability evidence:

```text
D:\project\steel-plate-3d-inspection\target\logs\production-stability\production-stability-20260709-114934-134.json
```

Observed result:

- `code=0`
- trigger gateway route: manual mode through `/api/trigger/manual/steel-in`
- latest material: `BAR-STABILITY-20260709-114929-127`
- stability cycles: `127/127`, failures `0`
- capture frames: `762`
- metadata frames: `762`
- parallel capture: `workerCount=6`, `parallel=true`
- per-camera latest layout: one `depth`, one `intensity`, one `metadata`
- `sdk-derived`: disabled
- latest production summary: `H:\production\BAR-STABILITY-20260709-114929-127\BAR-STABILITY-20260709-114929-127-1783568969382\summary.json`

Latest 3D reconstruction evidence:

```text
G:\bar-surface-algorithm\runs\BAR-STABILITY-20260709-114929-127\BAR-STABILITY-20260709-114929-127-20260709-115115\manifest.json
```

Observed result:

- acceptance: `pass`
- corrected calibration: `E:\steel-capture-data\config\calibrations\current-6-soft-trigger\array-calibration-fit-20260707-151317\ArrayCalibration.corrected.xml`
- calibrated cameras: `6/6`
- contour crop source: `calibrated-3d`
- input crop source: `calibrated-3d-contour`
- mesh: `20736` vertices, `38198` triangles
- texture: `3072 x 96`

Ten-minute H-drive evidence:

```text
H:\camera1\BAR-STABILITY-20260709-114929-127
H:\camera2\BAR-STABILITY-20260709-114929-127
H:\camera3\BAR-STABILITY-20260709-114929-127
H:\camera4\BAR-STABILITY-20260709-114929-127
H:\camera5\BAR-STABILITY-20260709-114929-127
H:\camera6\BAR-STABILITY-20260709-114929-127
```

Each camera folder contains one `depth`, one `intensity`, and one `metadata` file for the accepted ten-minute stability material, and no `sdk-derived` folder.

## Remaining Acceptance Notes

- Regenerate `target/runtime` and `target/packages/steel-inspection-runtime` from the current Release outputs, then rerun the full live-stack/itemized audit on the current eight-camera hardware with the real calibration plan, explicit apply/rollback authorization, and packaged trigger-security gate to produce a new `24/24` report; historical real-camera evidence does not certify the final writer, lifecycle, calibration, or trigger-security changes.
- Before installing the background service, create and validate a real algorithm acceptance report; bind every accepted run to the exact config, calibration, input artifacts, dataset/evaluator, script/core hashes and release commit. The pending template and a reconstruction-only `acceptance:pass` field do not satisfy production algorithm qualification.
- Run the default-formal `verify-runtime-package.ps1` with deployment-controlled first-party/vendor signer thumbprints, exact publisher, and 64-hex `ExpectedReleasePolicySha256`. It must authenticate those package-external trust inputs plus checksum/catalog evidence before executing packaged checks, then verify `build-evidence/desktop-release-policy.json` and `tauri-feature-resolution.json`; `-Engineering` is explicit and does not execute package code unless a locally trusted package also receives `-AllowPackageCodeExecution`. Then install the immutable background RuntimeRoot and mutable StateRoot separately from the Tauri desktop client. Archive the package-only report, signed catalog/tamper evidence, signed installer/PE evidence, offline WebView2 and VC++ prerequisite evidence, and target-machine Supervisor/SCM/ACL/migration/upgrade results in addition to this matrix.
- The ten-minute stability run above is the current endurance evidence. Longer production soaks can reuse the same command with a larger `-StabilityDurationSec`.
- The historical acceptance scope excluded downstream defect algorithm implementation beyond bar-surface reconstruction. Formal production release must additionally satisfy the production-algorithm and synthetic-data gates in [`production-readiness-gap-and-closure-design.md`](production-readiness-gap-and-closure-design.md).
