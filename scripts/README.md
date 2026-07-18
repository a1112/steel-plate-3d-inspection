# Runtime Scripts

These scripts keep the four runtime boundaries independent.

Environment templates live in `config/env`.

## Windows production service

The Release runtime contains one SCM host, `service\steel-runtime-supervisor.exe`, for the capture provider, trigger gateway, and Rust service. Its contract is ordered application-level readiness, strict business drain, bounded whole-stack stop/restart, child-process-tree cleanup, live managed-log rotation, and atomic restart-budget state publication. The non-elevated regression proves RuntimeRoot/StateRoot isolation, source/layout/config fail-closed cases, Trigger-then-Service drain (including timeout cases), `inFlight` convergence, 50 MiB online rotation, `.1` through `.5` retention, persisted budget exhaustion, and stable-runtime recovery of `StateRoot\service\supervisor-status.json`; the install-related PowerShell files parse, the static versioned-install policy passes, and the Supervisor Release target compiles. These checks still do not prove real SCM transitions, effective target-machine ACLs, signed-package installation, power-loss recovery, or a database migration transaction.

Production deployment is two-stage: this script installs only the background runtime service. The signed Tauri MSI/NSIS desktop client is installed separately and never supervises the background processes. See [the release, deployment, and operations SOP](../docs/release-deployment-and-operations.md) before using these commands.

Run the non-elevated layout/config regression after building Release:

```powershell
scripts/test-runtime-supervisor.ps1
```

Install from an elevated PowerShell prompt after creating the storage and artifact directories and a separate secret file:

```powershell
.\install-runtime-service.ps1 `
  -RuntimeRoot 'D:\ReleaseDrop\steel-inspection-runtime' `
  -InstallRoot 'C:\Program Files\SteelInspectionRuntime' `
  -StateRoot 'C:\ProgramData\SteelInspectionRuntime' `
  -SecretEnvFile 'C:\ProgramData\SteelInspection\runtime-secrets.env' `
  -AlgorithmAcceptanceReport 'C:\ProgramData\SteelInspection\release\algorithm-acceptance.json' `
  -ExpectedFirstPartyThumbprint $env:STEEL_RELEASE_SIGNER_THUMBPRINT `
  -AllowedVendorSdkSignerThumbprints @($env:STEEL_VENDOR_SDK_SIGNER_THUMBPRINTS -split ',') `
  -StorageRoot 'H:\' `
  -CameraStorageRoot 'H:\' `
  -ArtifactAllowedRoots 'H:\production;H:\camera1;H:\camera2;H:\camera3;H:\camera4;H:\camera5;H:\camera6;H:\camera7;H:\camera8;G:\bar-surface-algorithm' `
  -Start
```

The two signer inputs are deployment-controlled trust anchors and must be supplied out of band; neither may be learned from `manifest.json`. Each value is a 40-hex SHA-1 certificate thumbprint. The installer requires the catalog and every first-party PE to match `ExpectedFirstPartyThumbprint`, while `nvt_lvm_sdk.dll` must match the vendor allowlist.

The CLI name `RuntimeRoot` is retained for compatibility, but it means the read-only source package and is never the installed SCM payload. `InstallRoot` defaults to `%ProgramFiles%\SteelInspectionRuntime`; the installer verifies the source package, copies it to same-volume `releases\.incoming-<transactionId>`, verifies and locks the staged tree, renames it to `releases\<semver>-<commit12>`, and verifies the final immutable tree again. An existing final release directory is never overwritten or silently reused. SCM points directly to that version directory. `StateRoot` is a separate absolute non-root path, defaulting to `%ProgramData%\SteelInspectionRuntime`. SourcePackageRoot, InstallRoot, StateRoot, secret/report policy paths, and the production-data write domain must be mutually disjoint in both ancestor directions. Public runtime configuration, logs, SQLite/service state, capture configuration, temporary data, deployment journal, active receipt, history, and rollback snapshots remain below `StateRoot`. Existing state is owner/DACL/reparse-checked before any write; SYSTEM and Administrators have mutable-state control, while `config\runtime-service.env` is separately protected read-only. Elevated installation, effective ACL/SCM, real signatures, and target-machine upgrade/rollback acceptance remain required.

The secret file accepts only `TRIGGER_SHARED_SECRET`, `TRIGGER_OPERATOR_TOKEN`, `STEEL_DATABASE_URL`, and `STEEL_BOOTSTRAP_ADMIN_PASSWORD`. The two trigger values are mandatory, must differ, and must each contain at least 32 UTF-8 bytes. `AlgorithmAcceptanceReport` must point to a real `steel.algorithm-acceptance.v1` report whose status is `pass` and whose config hash matches the packaged production algorithm config; the pending example is not installable. The elevated installer rejects reparse points, protects the installed runtime tree plus external secret/report files for SYSTEM and Administrators, and rejects an untrusted ancestor that could delete or replace either policy file. Use `-Upgrade` only for an intentional maintenance window. A machine-wide mutex and durable `StateRoot\deployment\upgrade.json` protect the version publication and SCM/env/registry switch. Interrupted transactions are automatically recoverable only while `database.phase=not-started` and every rollback input is intact; all other uncertain database phases fail safe with the service stopped. After the source catalog gate, the installer validates the packaged database contract/index. Because it does not yet execute migrations, it rejects a non-empty migration index before changing deployment state; any deployment that reuses an active receipt, including upgrade or reinstall into a preserved StateRoot, also requires that receipt to prove the same schema version. A signed boot-time `recover-only` tool is still absent.

The installer also requires `packageClass=formal-release`, a clean `steel.runtime-package.v1` manifest, C++ `Release`, Rust `release`, a canonical stable `x.y.z` release version without numeric leading zeros, an exact release tag/commit, same-invocation build provenance, and a valid signed catalog before it evaluates the algorithm report. `0.1.0` and any `engineering` package—including dirty, debug, `-SkipBuild`, or `-SkipDesktopBundle` output—are rejected.

```powershell
.\uninstall-runtime-service.ps1
```

Uninstall shares `Global\SteelInspectionRuntime-Deployment` with install/upgrade/backup/restore. Before changing SCM it requires the journal to be `committed` or `rolled-back` and cross-checks registry, SCM `ImagePath`, active receipt, roots, and the exact current release. It waits for the SCM object and registry key to disappear and for TCP/UDP bindings on `4317/4873/4881/4882/4883` to be released; timeout is a failure. The default then removes only that exact current immutable release and preserves every other release plus the entire `StateRoot`, external secret/report files, data, logs, deployment history/backups, and generated public environment. `-RemoveRuntimeEnvironment` removes only `StateRoot\config\runtime-service.env`; it does not remove the state root.

Run the non-elevated uninstall policy contract before an administrator drill:

```powershell
scripts/test-runtime-service-uninstall-policy.ps1
```

`-Purge` requires explicit `-InstallRoot`, explicit `-StateRoot`, trustworthy deployment evidence, and the exact path-bound confirmation `PURGE SteelInspectionRuntime|INSTALL=<absolute InstallRoot>|STATE=<absolute StateRoot>`. It rejects protected roots, overlapping roots, and reparse trees. Purge deletes both managed roots only after SCM/registry/ports are absent; it is ordered cleanup, not a cross-resource atomic transaction, and does not delete external roots.

The installer limits SCM failure actions to restart after 5 seconds, restart after 30 seconds, then no further SCM restart. This prevents the third and later failures from silently creating an unbounded outer restart loop, but the combined in-process/SCM policy still requires an elevated failure-injection drill.

## Headless Capture Provider

```powershell
scripts/build-capture-headless.ps1
scripts/run-capture-headless.ps1 -Port 4317
```

If the canonical `target\capture\Release\steel_capture_service.exe` is currently running, build and package the next engineering candidate without replacing the online executable:

```powershell
scripts/build-capture-headless.ps1 -Configuration Release -BuildDir app/capture/build
scripts/package-runtime.ps1 -SkipBuild -SkipDesktopBundle -AllowDirtyWorktree -CaptureBuildRoot app/capture/build
```

An alternate `-CaptureBuildRoot` is engineering-only. Formal release packaging always clears and rebuilds the canonical `target\capture` root from the clean tagged commit.

In another terminal:

```powershell
scripts/run-service.ps1 -Provider external-api -CaptureOrigin http://127.0.0.1:4317
```

Equivalent env-file mode:

```powershell
scripts/run-service.ps1 -EnvFile config/env/external-api.env.example
```

## Eight-Camera Headless Stack

For the current eight-camera hardware setup, use the stack starter to launch the headless provider, apply the active `current-8-time-trigger` profile, and preserve the vendor/device-side time-trigger parameters:

```powershell
scripts/start-capture-stack.ps1 -StopExisting
```

The stack defaults to `H:\`, a target-local configuration root, port `4317`, and eight expected cameras. Qt source, provider compatibility, build switches, and runtime packaging have been removed; the operator UI is Tauri/React. Startup preserves saved device/profile parameters; pass `-ApplyPreset` only when intentionally forcing the generic line preset.

To run an operator-style auto-connect and continuous capture test against the active provider:

```powershell
scripts/test-capture-api.ps1 -Origin http://127.0.0.1:4317 -ExpectedCameras 8
```

```powershell
scripts/test-capture-continuous.ps1 -Origin http://127.0.0.1:4317 -ExpectedCameras 8 -Rounds 3 -IntervalMs 500
```

The API smoke script checks endpoint shape and expected error handling. The continuous test discovers cameras through `/api/cameras`, connects them, then starts the provider-side parallel continuous capture endpoint `/api/capture/continuous-test`.

## Production database and trigger gateway

For development/test only, `STEEL_DATABASE_ENGINE` accepts `sqlite`, `mysql`,
or `postgres`. `STEEL_DATABASE_FALLBACK=sqlite` explicitly permits startup on
the managed SQLite file when a remote primary cannot be connected. It does not
hide schema or migration errors, and production rejects both fallback and the
PostgreSQL development adapter. Examples:

```powershell
scripts/run-service.ps1 -RuntimeProfile development -DatabaseEngine mysql -DatabaseFallback sqlite
scripts/run-service.ps1 -RuntimeProfile development -DatabaseEngine postgres -DatabaseFallback sqlite
```

The Rust service defaults to the local SQLite file. An empty production database also requires a one-time `STEEL_BOOTSTRAP_ADMIN_PASSWORD` injected by the service manager; it must be at least 12 characters and contain uppercase, lowercase, digit, and symbol characters. Do not store that secret in a checked-in env file.

For a dedicated local production MySQL account, set:

```powershell
$env:STEEL_DATABASE_URL = "mysql://steel_service:<percent-encoded-secret>@127.0.0.1:3306/steel_inspection"
```

Production rejects the MySQL `root` account and the legacy `nercar` password. Loopback MySQL may explicitly use `ssl-mode=disabled`; a remote production host must specify `ssl-mode=verify-ca` or `verify-identity` so the certificate is validated. Database status responses redact credentials. Production APIs added for the capture loop are:

```text
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
GET  /api/alarms?status=open
POST /api/alarms/acknowledge
POST /api/alarms/resolve
```

The formal Tauri and trigger-gateway steel-info/in/out/event paths use the durable task endpoints. PLC/L2 callers should retain one stable `requestId` when retrying the same command. The original synchronous steel routes remain compatibility paths. `capture-once` and `algorithm-run` use the generic task endpoint. Rust persists one `chainId` per material/session, automatically links direct predecessors, and only claims safety-critical `require-success` work after its predecessor succeeds. Failure, cancellation, interruption, or an invalid dependency recursively changes queued descendants to terminal `blocked`; retrying the failed parent requeues those descendants. `always-run` is restricted to explicitly safe `trigger-event` cleanup. Clients poll task detail until a persisted terminal state, including `blocked`; accepted work is not tied to the lifetime of the enqueue request. Persistent alarm state is `active -> acknowledged -> resolved`; state changes require an authenticated `admin.records` session and a non-empty operator note.

Real eight-camera calibration apply/rollback has a separate Rust `calibration_operation` ledger. Tauri supplies a stable `operationId`, and `GET /api/calibration/operations/detail?id=...` exposes `dispatching/succeeded/failed/needs-reconciliation`. Never generate a new ID merely because an HTTP response was lost: refresh the stored operation first. Rust startup marks interrupted dispatch for reconciliation and never automatically repeats the C++ SDK mutation.

Formal operator trigger controls are exposed by Rust, not by a browser-side gateway origin:

```text
GET  /api/trigger/status
GET  /api/trigger/mode
POST /api/trigger/mode
POST /api/trigger/manual/steel-info
POST /api/trigger/manual/steel-in
POST /api/trigger/manual/steel-out
```

The standalone trigger gateway is a separate executable for L2/PLC/API integration:

```powershell
scripts/run-trigger-gateway.ps1 -EnvFile config/env/trigger-gateway.env.example
```

The source project lives in `app/trigger` and forwards accepted events to the Rust service's durable production-task APIs. External controllers can use HTTP API on `4881`, newline-delimited TCP JSON on `4882`, or UDP JSON datagrams on `4883`; `scripts/trigger_demo.py` demonstrates the same info/in/wait/out cycle on all three transports. Production requires an injected HMAC secret of at least 32 bytes, a timestamp within the configured window, a unique nonce, and an IP/CIDR source allowlist for non-loopback binding. HTTP uses `X-Trigger-Timestamp`, `X-Trigger-Nonce`, and `X-Trigger-Signature`; TCP/UDP use the versioned authenticated envelope documented in `docs/capture-api-contract.md`. Replays are rejected across all transports. A separate `TRIGGER_OPERATOR_TOKEN` of at least 32 bytes protects the local Rust-to-gateway mutation hop and must not equal or substitute for the PLC/L2 secret. Tauri requests trigger status, mode, manual actions, and operator capture only from Rust's explicit `/api/trigger/*` proxy allowlist; mutating routes require an `admin.services` session and are audited, while the browser never targets port `4881`. Production locks runtime mode mutation and disables the direct manual page by default. Use `-Mode api`, `tcp`, or `udp` for the selected external transport, `-Mode gray` for grayscale/sensor tagging, `-Mode secondary` for L2 tagging, and `-Mode manual` for a fixed, authenticated operator flow.

Run `scripts/test-trigger-gateway-security.ps1` after building. It starts an isolated production gateway and proves missing-secret startup failure, signed HTTP/TCP/UDP acceptance up to the offline service boundary, replay rejection on all three transports, mode locking, status redaction, and absence of wildcard CORS.

For a local integrated run that starts the capture provider, Rust service, trigger gateway, and static client from existing `target` build outputs:

```powershell
scripts/start-integrated-capture-management.ps1 -ArtifactAllowedRoots "H:\camera1;H:\camera2;H:\camera3;H:\camera4;H:\camera5;H:\camera6;H:\camera7;H:\camera8;H:\production;H:\reconstruction" -TriggerMode manual -OpenBrowser
```

This waits for `http://127.0.0.1:4317/health`, `http://127.0.0.1:4873/api/production/status`, `http://127.0.0.1:4881/api/trigger/status`, and the built client page at `http://127.0.0.1:1432/?app=terminal`. The direct gateway URL here is an orchestration readiness probe, not a client route. `test-integrated-runtime-ready.ps1` requires provider `ready=true`, `sdkReady=true`, no nested `restartRequired`, and exactly eight connected cameras by default; `-ExpectedCameras` exists only for an explicitly different test fixture. Rust readiness additionally gates database, durable-task worker, capture, storage/writer queue/capacity, and the required trigger gateway. Configure the hard `STEEL_STORAGE_MIN_FREE_BYTES` and `STEEL_STORAGE_MIN_FREE_PERCENT` values from the site capacity plan. Rust warns at twice the hard byte watermark or five percentage points above the hard percentage watermark without closing readiness; crossing either hard watermark blocks new steel admission while preserving existing-session completion. Use `-StopExisting` to first stop known project executables and listeners on the selected ports.

For a direct development `run-service.ps1` launch, pass
`-AlgorithmRoot`, `-AlgorithmConfigPath`, `-AlgorithmCalibrationPath`, and
`-AlgorithmCaptureRoot` together. These map to the same four runtime variables
used by the installed service; omitting the calibration path makes automatic
bar-surface runs explicitly uncalibrated instead of silently borrowing the
capture profile.

Production record cleanup also requires `STEEL_ARTIFACT_ALLOWED_ROOTS`, or `run-service.ps1 -ArtifactAllowedRoots`, with a semicolon-separated list of narrow capture, production-summary, and reconstruction roots. Cleanup refuses drive-wide/configuration/calibration namespaces, freezes size and SHA-256, persists per-file progress, and removes database indexes only after the physical files are confirmed deleted or missing.

## Database Backup And Restore

Run these commands from the installed immutable release root or pass it explicitly. Production mode requires a matching `StateRoot\deployment\active.json`, a clean `formal-release` package, and an authenticated admin session; it never infers release identity from a local Git checkout or `Cargo.toml`. Backup and restore hold `Global\SteelInspectionRuntime-Deployment` for the complete operation and fail before database mutation if install, upgrade, restore, backup, or uninstall owns the lock. Both engines create `steel.database-backup.v2`, binding the payload to the release/commit/transaction, package and active-receipt hashes, schema contract, migration index, consistency model, byte count, SHA-256, and restorability evidence.

SQLite uses the authenticated `VACUUM INTO` endpoint, then validates the downloaded snapshot through Windows `winsqlite3.dll` with full `integrity_check`, `foreign_key_check`, a clean schema singleton, and no unresolved migration. The backup is published only after durable staging and manifest validation:

```powershell
& 'C:\Program Files\SteelInspectionRuntime\releases\1.2.3-a1b2c3d4e5f6\backup-database.ps1' `
  -Engine sqlite `
  -StateRoot 'C:\ProgramData\SteelInspectionRuntime' `
  -AdminToken $env:STEEL_BACKUP_ADMIN_TOKEN `
  -ArtifactRoots $env:STEEL_ARTIFACT_ALLOWED_ROOTS
```

MySQL is accepted only when every base table is InnoDB. The script makes a `--single-transaction` dump, restores it into an explicitly named temporary database, compares the clean schema ledger and base-table count, and removes the temporary database. `-AllowMySqlVerificationDatabaseReset` is the second confirmation that the named verification database may be dropped/recreated. The defaults file contains `[client]` credentials and must have a restricted ACL; never put a password in the command line, repository, manifest, or logs:

```powershell
& '<installed-release>\backup-database.ps1' `
  -Engine mysql `
  -StateRoot 'C:\ProgramData\SteelInspectionRuntime' `
  -AdminToken $env:STEEL_BACKUP_ADMIN_TOKEN `
  -MySqlDefaultsFile 'C:\ProgramData\SteelInspection\secrets\mysql-client.cnf' `
  -MySqlDatabase steel_inspection `
  -MySqlVerificationDatabase steel_inspection_restore_verify_20260716 `
  -AllowMySqlVerificationDatabaseReset
```

Treat the returned `manifestSha256` as an out-of-band restore authorization input. Restore is offline and requires the exact phrase `RESTORE <engine> <backupId> TO <targetReleaseId>`. The target release contract must be able to read the backup schema and cover its rollback boundary:

```powershell
& '<target-installed-release>\restore-database.ps1' `
  -BackupDir '<completed-backup-dir>' `
  -ExpectedBackupManifestSha256 '<64-lowercase-hex>' `
  -Engine sqlite `
  -TargetStateRoot 'C:\ProgramData\SteelInspectionRuntime' `
  -Confirm 'RESTORE sqlite <backup-uuid> TO <semver-commit12>'
```

SQLite checkpoints WAL, creates and verifies a durable rollback copy, stages the selected snapshot in the live database directory, uses same-volume `File.Replace`/rename, and performs the full read-only checks again. It automatically restores the prior database on a post-switch failure when that rollback can be proven; otherwise it writes a `failed-safe` receipt and keeps the service stopped. MySQL import is explicitly non-atomic: it additionally requires `-AllowNonAtomicMySqlRestore` and a distinct, hash-pinned v2 pre-restore backup of the current target database. It never claims automatic MySQL DDL rollback.

```powershell
& '<target-installed-release>\restore-database.ps1' `
  -BackupDir '<selected-mysql-backup-dir>' `
  -ExpectedBackupManifestSha256 '<selected-manifest-sha256>' `
  -Engine mysql `
  -TargetStateRoot 'C:\ProgramData\SteelInspectionRuntime' `
  -MySqlDefaultsFile 'C:\ProgramData\SteelInspection\secrets\mysql-client.cnf' `
  -MySqlDatabase steel_inspection `
  -MySqlPreRestoreBackupDir '<current-target-pre-restore-backup-dir>' `
  -ExpectedMySqlPreRestoreManifestSha256 '<pre-restore-manifest-sha256>' `
  -AllowNonAtomicMySqlRestore `
  -Confirm 'RESTORE mysql <selected-backup-uuid> TO <semver-commit12>'
```

Restore receipts are written below `StateRoot\deployment\restore-history`. A success result deliberately leaves the service stopped. Start the pinned target release, validate database plus full runtime readiness, task queue, alarms, calibration and cleanup ledgers, inspection references, and artifacts, and only then reopen production admission. Run the local SQLite positive/negative contract before packaging:

```powershell
scripts/test-database-backup-restore-contract.ps1
```

## Inspection Report Archive Backup And Restore

Database backup does not contain the immutable JSON report archive under `StateRoot\reports\inspection`. Back up and restore that tree separately with the packaged `manage-report-archives.ps1`; otherwise a database-only recovery can restore inspection rows while leaving their issued historical reports unavailable.

The tool validates every archive envelope before backup, then calls the authenticated Service history endpoint for every inspection so Rust rechecks the two report schemas, directory/file identity, inspection/material identity, `documentSha256`, and content-addressed `reportId` with the same serializer used at issuance. It records exact file byte counts and SHA-256 values, copies only a stable inventory, verifies the copied tree, then re-reads the source and refuses publication if a report was issued or changed during the copy window. `-AllowOfflineBackupWithoutServiceValidation` exists only for isolated recovery tests and must not be used for a production backup.

```powershell
& '<installed-release>\manage-report-archives.ps1' `
  -Mode Verify `
  -StateRoot 'C:\ProgramData\SteelInspectionRuntime' `
  -AdminToken $env:STEEL_BACKUP_ADMIN_TOKEN

$reportBackup = & '<installed-release>\manage-report-archives.ps1' `
  -Mode Backup `
  -StateRoot 'C:\ProgramData\SteelInspectionRuntime' `
  -AdminToken $env:STEEL_BACKUP_ADMIN_TOKEN | ConvertFrom-Json
```

Retain the returned `manifestSha256` outside the backup directory. Restore is offline, checks the manifest and every payload file, stages the complete tree next to the target, retains the prior tree under `StateRoot\deployment\restore-backups`, and publishes with directory rename. It writes a receipt under `StateRoot\deployment\restore-history` and leaves the service stopped.

Production restore rejects a backup whose manifest says `serviceValidated=false`. `-AllowRestoreFromOfflineUnvalidatedBackup` is restricted to isolated contract tests or an explicitly approved emergency recovery where no authoritative Service can be started; after such a restore, production admission must remain closed until the pinned Service performs a token-authenticated `Verify`.

```powershell
& '<target-installed-release>\manage-report-archives.ps1' `
  -Mode Restore `
  -StateRoot 'C:\ProgramData\SteelInspectionRuntime' `
  -BackupDir '<completed-report-archive-backup-dir>' `
  -ExpectedManifestSha256 '<64-lowercase-hex>' `
  -Confirm 'RESTORE REPORTS <backup-uuid>'
```

Run the positive/negative local contract before packaging:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-report-archive-recovery.ps1
```

For a full recovery, restore the database and report archive while the runtime is stopped, start the pinned release, then verify database integrity, run `manage-report-archives.ps1 -Mode Verify -AdminToken ...`, test report history/detail retrieval, printing, artifact references, and full runtime readiness before reopening production admission. Database and report restoration are intentionally separate operations; their receipts and hashes must be reviewed together.

To verify the integrated management flow without cameras, run the simulated smoke test:

```powershell
scripts/test-integrated-management-smoke.ps1
```

It starts the Rust service in explicit `development + demo` simulated-provider mode, starts the standalone trigger gateway on an isolated HTTP/TCP/UDP port group, serves the built terminal client, checks the service-side network monitor API, and checks that manual steel-in is rejected outside manual mode. It then enqueues and polls persisted `steel-info -> steel-in -> capture-once -> steel-out` tasks, verifies their exact `dependsOnTaskId` order, stable chain/material/session identity, and fail-closed `require-success` policy, checks record-before-capture behavior, and confirms the final session status. The report records all three trigger listener ports, eight complete frames, eight metadata commits, and 24 capture-file rows. This Qt-free simulated runtime acceptance does not replace the eight-camera hardware regression below.

For a packaged runtime, pass `-WorkRoot` when evidence must be retained:

```powershell
target/packages/steel-inspection-runtime/test-runtime-acceptance.ps1 `
  -RuntimeRoot target/packages/steel-inspection-runtime `
  -Profile release `
  -WorkRoot target/logs/package-immutable-smoke
```

The service working directory, SQLite database, logs, reports, and simulated URI summaries stay under that external root. Without an explicit value, packaged smoke uses the system temporary directory. RuntimeRoot must remain unchanged and should pass `verify-runtime-package.ps1` again after acceptance.

To verify only the generated runtime folder layout without starting services:

```powershell
scripts/test-runtime-layout.ps1
```

To run the folder acceptance check against `target/runtime`, including layout plus the simulated service/trigger/client smoke flow:

```powershell
scripts/test-runtime-acceptance.ps1
```

After the real stack is already running, verify the live endpoints without starting or stopping any process:

```powershell
scripts/test-integrated-runtime-ready.ps1
```

For real eight-camera hardware acceptance, start the capture provider, Rust service, trigger gateway, and terminal client first. The default command is read-only and checks live APIs, camera discovery, camera config readback, `H:\camera1..camera8` storage mapping, network monitoring, and latest-artifact metadata:

```powershell
scripts/test-real-hardware-acceptance.ps1
```

The post-migration eight-camera regression is still outstanding. In addition to the scripted API checks, production sign-off must validate the asynchronous frame-transaction writer on real SDK frames: `owned-offline-format0`, same-frame online/offline depth equivalence, pending-byte backpressure, any format-2 fallback, and CTRL_BREAK drain while accepted frames are pending.

For a single combined live-stack report that runs runtime layout, live readiness, real-hardware read-only checks, and UI smoke:

```powershell
scripts/test-integrated-capture-management-full.ps1
```

Add `-RunCapture`, `-RunBarSurface`, or `-RunShortStability` to include one production capture, the 3D reconstruction acceptance loop, or a production stability loop in the same report. Use `-RequireFullCoverage` when the report must fail if any required live-stack, hardware, UI, trigger-route, storage, or 3D reconstruction coverage item is skipped. By default `-RunShortStability` runs `-StabilityCycles 1`; use `-StabilityUseTriggerGateway` when the same report must prove the production cycle enters through the trigger gateway, and use a duration when the same combined report should include a soak test:

```powershell
scripts/test-integrated-capture-management-full.ps1 -RunShortStability -StabilityUseTriggerGateway -RunBarSurface -RequireFullCoverage -StabilityDurationSec 600 -StabilityIntervalSec 2
```

For a shorter full-coverage live acceptance run, keep the same switches and reduce the duration, for example `-StabilityDurationSec 45 -StabilityIntervalSec 0`. The generated JSON includes `coverage.full`, `coverage.covered`, `coverage.required`, and per-item skipped/uncovered reasons.

To run one real production capture round through the Rust service and verify `H:\camera1..camera8\<material>\{depth,intensity,metadata}` with `sdk-derived` disabled:

```powershell
scripts/test-real-hardware-acceptance.ps1 -RunCapture
```

The capture mode also checks that provider capture is parallel, that the Rust service writes the production summary to `H:\production\<material>\<session>\summary.json`, that `summaryOutput` and `latestInspection.summaryPath` both point to that production summary, that the final `steel.production.summary.v1` file lists depth/intensity/metadata files for all eight cameras with `sdk-derived` disabled, and that `activeSession` is cleared after steel-out.

Real eight-camera calibration has a separate, authenticated acceptance script. Its default mode performs local SHA-256/file/SN/mapping validation plus the Rust/C++ dry-run and does not call the SDK mutation path:

Copy and review `config/capture/calibration-acceptance-plan.example.json`; replace every target and known-good rollback path with provider-local regular files. `AdminToken` may be passed explicitly or supplied through `STEEL_ADMIN_TOKEN`.

```powershell
scripts/test-real-calibration-acceptance.ps1 `
  -PlanPath C:\maintenance\eight-camera-calibration-plan.json `
  -AdminToken $adminToken
```

The mutating apply -> ledger -> explicit rollback -> validation-capture path requires an additional switch and exact safety phrase:

```powershell
scripts/test-real-calibration-acceptance.ps1 `
  -PlanPath C:\maintenance\eight-camera-calibration-plan.json `
  -AdminToken $adminToken `
  -RunApplyRollback `
  -SafetyConfirmation "RUN REAL EIGHT CAMERA CALIBRATION APPLY AND ROLLBACK"
```

Add `-SaveToDevice` only for the separately approved device-flash test. The script intentionally reports that apply/rollback process-crash injection, staged-file tamper rejection, and generation rejection remain a separate controlled maintenance drill.

The process-crash drill is a two-phase command and must be completed once for `ApplyCrash` and once for `RollbackCrash`. Start the provider with the four exact `CAPTURE_CALIBRATION_CRASH_*` bindings shown in `docs/capture-api-contract.md`, verify `/health` reports the intended operation/phase/camera binding, then run `Prepare`. After the controlled exit, clear every crash variable, restart the provider, and run `Resume` with the generated state file. Resume verifies provider and Rust fences, reconnects all cameras, performs the parent-bound staged rollback, checks nested rollback correlation, and captures eight validation frames.

```powershell
scripts/test-real-calibration-crash-recovery.ps1 -Mode Prepare -Scenario ApplyCrash -PlanPath C:\maintenance\eight-camera-calibration-plan.json -AdminToken $adminToken -SafetyConfirmation "RUN CONTROLLED CALIBRATION PROCESS CRASH RECOVERY"
scripts/test-real-calibration-crash-recovery.ps1 -Mode Resume -StatePath target\logs\real-calibration-crash-recovery\active-calibration-crash-drill.json -AdminToken $adminToken -SafetyConfirmation "RUN CONTROLLED CALIBRATION PROCESS CRASH RECOVERY"
```

Run the separately confirmed integrity/generation drill after the crash scenarios. It uses `persistActive:false` and `saveToDevice:false`, creates two runtime generations, rejects the stale token, temporarily modifies one staged copy, proves both rejections are zero-write using status and maintenance evidence, restores the exact bytes in a `finally` block, rolls back, and captures eight validation frames:

```powershell
scripts/test-real-calibration-integrity-generation.ps1 -PlanPath C:\maintenance\eight-camera-calibration-plan.json -AdminToken $adminToken -SafetyConfirmation "RUN REAL CALIBRATION INTEGRITY AND GENERATION DRILL"
```

For repeated in/out steel stability checks, use:

```powershell
scripts/test-production-stability.ps1 -MaxCycles 2
scripts/test-production-stability.ps1 -DurationSec 600 -RunAlgorithmEvery 10
target/packages/steel-inspection-runtime/test-production-stability.ps1 `
  -ServiceOrigin http://127.0.0.1:5073 `
  -CaptureRoot D:\steel-evidence\runs\<run-id>\work\simulated `
  -MaxCycles 10 -IntervalSec 0 -SkipClient -SkipTrigger `
  -WorkRoot D:\steel-evidence
```

The stability report is provider-aware. It first binds the report to the exact runtime `manifest.json`, recording release version, source commit, package class, manifest path, and manifest SHA-256. A real capture provider must then expose and pass the eight-camera device configuration plus physical depth/intensity/metadata layout. The simulated provider instead uses a deterministic `simulated://<material>/...` ledger; the test validates 24 URI rows per one-round eight-camera cycle, summary totals, and namespace isolation without pretending that simulated device fields or image files exist.

Each cycle creates unique material/session/inspection identities, requires the session to belong to the current material and the inspection to belong to that session, records steel-in before capture, runs parallel production capture, writes `H:\camera1..camera8\<material>\{depth,intensity,metadata}`, and verifies that the top-level, session, and inspection identities in the final `steel.production.summary.v1` all match the cycle. It can optionally run 3D reconstruction every N cycles. After every steel-out and once again at the end, a bounded convergence gate requires `activeSession=null`, `tasks.queueDepthAvailable=true`, `tasks.queueDepth=0`, `tasks.worker.activeTaskId=null`, `tasks.worker.running=true`, and `admission.inFlight=0`. Missing convergence fields fail the run.

For a packaged script, `-WorkRoot` keeps the report outside RuntimeRoot. If neither `-ReportDir` nor `-WorkRoot` is supplied, packaged execution uses `%TEMP%\steel-runtime-package-stability`; source-tree execution continues to use `target\logs\production-stability`. Re-run `verify-runtime-package.ps1` after the soak and compare both the checksum-file hash and recursive package file count.

The stability runner treats `provider.summaryOutput` as authoritative. It uses an absolute path directly, resolves a relative path beneath `WorkRoot`, and only falls back to the legacy `CaptureRoot\production\...` layout when the provider omits the field. Simulated acceptance therefore no longer needs a matching `-CaptureRoot` override. `test-integrated-management-smoke.ps1 -KeepRunning` also returns `startedProcesses` and `startedListeners` in its success report so the exact isolated runtime can be audited and cleaned without searching unrelated machine processes.

Run the repeatable regression before accepting a runtime package:

```powershell
.\test-production-stability-workroot-contract.ps1
```

The contract reserves an isolated service/trigger port set, requires the KeepRunning launcher to return within its deadline, validates the process/listener receipt, performs one production cycle without a `CaptureRoot` override, proves the relative summary path stays under WorkRoot, checks final convergence, and releases all contract listeners in `finally`. Use alternate `-ServicePort`, `-TriggerPort`, and `-ClientPort` values when the defaults are reserved.

For the final functionality-only Go/No-Go decision, copy the templates from `config\acceptance`, replace every placeholder, and bind all evidence to the same release:

```powershell
target/packages/steel-inspection-runtime/new-functional-acceptance-workspace.ps1 `
  -ReleaseManifestPath target/packages/steel-inspection-runtime/manifest.json `
  -WorkspaceRoot D:\steel-acceptance\release-1.2.3 `
  -Line line-1 -Plc plc-1 -L2 l2-1 -TargetMachine ipc-01

target/packages/steel-inspection-runtime/test-functional-go-live-readiness.ps1 `
  -PlanPath D:\steel-acceptance\release-1.2.3\functional-go-live-plan.json `
  -ReportDir D:\steel-acceptance\release-1.2.3\10-signoff
```

The workspace initializer copies the exact candidate manifest and creates the standard `00-release` through `10-signoff` layout, the release-bound plan, an 11-scenario PLC/L2 report, and an eight-scenario target-machine report. Every scenario starts `passed=false` with no evidence. It refuses a non-empty destination and never overwrites or deletes acceptance evidence; initialize a new directory whenever the candidate package changes.

The six gates are release identity, real labeled algorithm qualification, unskipped real-camera 24/24, real PLC/L2 scenarios, an eight-hour-or-longer real-provider production shift, and clean target-machine lifecycle. The PLC/L2 template requires the normal production chain plus duplicate retry, wrong order, disconnect/reconnect, service restart, and back-to-back materials. The target-machine template requires clean install, configuration readback, service start, reboot recovery, a complete production cycle, upgrade, rollback, and uninstall with production-data preservation. Every PLC/L2 and target-machine scenario must reference at least one real `steel.functional-scenario-evidence.v1` JSON file with its lowercase SHA-256; relative paths resolve beside that scenario report. The evidence JSON must bind the same release version/commit, declare the exact scenario ID and `result=pass`, identify its source system/command/raw log, and place `observedAt` inside the report's execution window. The execution start/end window, site identifiers, responsible owners, and an approval timestamp at or after completion are mandatory. A missing, unrelated, semantically invalid, or tampered evidence file, missing scenario, simulated provider, insufficient duration/cycles, unapproved report, release version/commit/manifest-hash mismatch, queue residue, or cross-material binding makes the result `no-go`. Integrated 24/24 and production-soak evidence cannot be reused from another candidate package even when their functional counts pass. `-AllowNoGo` is only for generating a progress report without a failing process exit.

Generate each scenario evidence file from the actual raw log instead of manually copying hashes:

```powershell
.\new-functional-scenario-evidence.ps1 `
  -ReleaseManifestPath .\manifest.json `
  -ScenarioId service-restart `
  -SourceSystem PLC-L2-line-1 `
  -CommandOrProcedure "Restart SteelInspectionRuntime and verify task recovery" `
  -RawLogPath D:\steel-acceptance\03-plc-l2\raw\service-restart.log `
  -OutputPath D:\steel-acceptance\03-plc-l2\evidence\service-restart.json `
  -ObservedAt 2026-07-16T10:15:00+08:00
```

The generator writes the evidence atomically and returns the exact `{path, sha256}` reference to paste into the scenario report. It binds both the candidate manifest SHA-256 and raw-log SHA-256. The final Go/No-Go run rechecks the evidence JSON and the raw log, so moving to a different candidate or changing the original log invalidates the scenario.

The preferred workspace flow removes the paste step. First set the report's `startedAt` and `finishedAt`, place the raw log under that scope's `raw` directory, then attach it:

```powershell
.\add-functional-scenario-evidence.ps1 `
  -WorkspaceRoot D:\steel-acceptance\release-1.2.3 `
  -Scope plc-l2 `
  -ScenarioId service-restart `
  -SourceSystem PLC-L2-line-1 `
  -CommandOrProcedure "Restart SteelInspectionRuntime and verify task recovery" `
  -RawLogPath D:\steel-acceptance\release-1.2.3\03-plc-l2\raw\service-restart.log `
  -ObservedAt 2026-07-16T10:15:00+08:00
```

The attacher generates the evidence and atomically changes exactly one known scenario from fail-closed to passed with one reference. It rejects raw logs outside the scope workspace, observations outside the execution window, duplicate attachments, unknown scenarios, release mismatches, and every mutation after `approvals.approvedAt` has been set.

The packaged `current-8-time-trigger` profile defaults to `loadCameraParams:false` and `changeStorage:false`. Startup therefore uses the camera's current built-in/device parameters and the already verified time-trigger setup. Parameter files remain explicit maintenance artifacts and are not a startup prerequisite.

The terminal header reads realtime network counters from the Rust service:

```http
GET /api/system/network
```

The service derives upload and download Mbps from consecutive byte-counter samples, and the frontend shows those values in the `报级器网口` popover as monitoring-only fields. The UI must not expose upload, download, QoS, or bandwidth limit controls.

After the real stack and client are running, use the UI smoke test to verify that the terminal page shows realtime upload, realtime download, and bandwidth monitoring in the receiver network popover:

```powershell
scripts/test-runtime-ui-smoke.ps1 -ClientOrigin http://127.0.0.1:1432/?app=terminal
```

The script launches headless Edge/Chrome through DevTools, checks the terminal, capture, and 3D reconstruction pages, then writes screenshots and `ui-smoke-report.json` under `target\logs\ui-smoke`.

To estimate conservative X/Z translation corrections from a static round-steel cross-section and write a reviewable calibration XML copy:

```powershell
python scripts/fit_array_calibration_cross_section.py `
  --calibration config\capture\calibrations\current-8-time-trigger\ArrayCalibration.xml `
  --data-dir E:\steel-capture-data\continuous-test\calibration-retake-20260707-142028 `
  --rows 250,500,750
```

For the production eight-camera layout on `H:\camera1..camera8\<material>\{depth,intensity,metadata}`, use:

```powershell
python scripts/fit_array_calibration_cross_section.py `
  --capture-root H:\ `
  --material-id BAR-E2E-20260708-013823 `
  --calibration config\capture\calibrations\current-8-time-trigger\ArrayCalibration.xml `
  --rows 250,500,750
```

The fitter writes `ArrayCalibration.corrected.xml`, before/after cross-section previews, `fit_report.json`, `camera_corrections.csv`, and `cross_section_points.csv` under the configured analysis directory. Tauri runs an eight-camera capture first, verifies target geometry and fit improvement, and activates the corrected reconstruction calibration only when all gates pass. It never writes camera devices and never overwrites the source calibration file.

## Rust Service Only

```powershell
scripts/build-service.ps1
scripts/build-trigger-gateway.ps1
scripts/run-service.ps1 -Provider simulated
```

Equivalent env-file mode:

```powershell
scripts/run-service.ps1 -EnvFile config/env/simulated.env.example
```

## Bar Surface Algorithm Core

The Python prototype writes reconstruction runs under `G:\bar-surface-algorithm`.
Build the C++ core and convert a prototype mesh into the compact binary model:

```powershell
scripts/build-algorithm-core.ps1

$latest = Get-Content -Raw G:\bar-surface-algorithm\latest.json | ConvertFrom-Json
target/algorithm-core/Release/steel_bar_surface_core.exe --manifest $latest.manifestPath
```

The core writes `mesh/bar_surface.bsmesh` and `mesh/bar_surface_core_summary.json`
beside the Python `bar_surface_mesh.json`.

The prototype crops in two stages by default. It first uses the active
`ArrayCalibration.xml` to project sampled depth pixels into 3D, fits the round
bar X/Z contour, and derives per-camera 2D crop boxes from that calibrated 3D
contour. It then clips the final mesh against the fitted 3D contour before
writing JSON/OBJ/bsmesh. The manifest and acceptance report expose
`inputCrop`, `mesh.contourCrop`, `quality.contourCrop`, and the frontend shows
`2D裁剪` plus `轮廓裁剪` status. Tunables include
`--contour-radius-tolerance-mm`, `--contour-min-keep-ratio`,
`--contour-min-row-coverage`, `--contour-auto-percentile`, and
`--no-contour-crop`.

Production mode loads the versioned `config\algorithm\bar-surface-production.json` and must not rely on script defaults. The package also includes `config\algorithm\acceptance-report.example.json`, but that file is deliberately `pending-site-approval`; copy it outside the package, replace every placeholder with the frozen release/dataset/evaluator/calibration evidence, obtain algorithm and quality approval, and validate the resulting `status=pass` report:

The current production algorithm version is explicitly a radial anomaly **candidate** detector. For database compatibility its polarity IDs remain `pit` and `foreign`, but every real candidate carries `classificationState=candidate-only`, `classificationVersion=radial-polarity-candidate-v1`, `candidatePolarity`, and a null `classificationConfidence`. `confidence`/`detectionConfidence` measures candidate strength only. The Service, desktop list, and printable archive render these as `凹陷候选` or `凸起候选` and require review; they must not be reported as accepted pit/foreign material classifications until a frozen labelled dataset approves a classifier.

Algorithm reconstruction, calibration fitting, and the native core run as controlled child processes. Each run is attached to a Windows Job Object with `KILL_ON_JOB_CLOSE`; cancellation, timeout, parent completion, or Service drain therefore cleans up descendants, and containment setup failure rejects the run. `scripts/run-service.ps1 -AlgorithmProcessTimeoutSec 1800` (or `STEEL_ALGORITHM_PROCESS_TIMEOUT_SEC`, range 10–7200 seconds) sets the hard computation limit. stdout and stderr are always drained concurrently, while only the latest 4 MiB of each stream is retained; `processOutput` reports total/retained bytes and truncation. A successful calibration-fit process must still return complete valid JSON. Cancelling a queued algorithm task or draining the Service terminates only the interruptible calculation phase; drain admission is published before the production-command barrier is awaited, while camera capture and calibration device writes retain their authoritative provider result after dispatch.

```powershell
scripts/test-algorithm-acceptance-report.ps1 `
  -ReportPath C:\ProgramData\SteelInspection\release\algorithm-acceptance.json `
  -ConfigPath config\algorithm\bar-surface-production.json
```

This validation is necessary but not sufficient. The validator now requires status, algorithm/config identity and hash, dataset/evaluator, calibration, script/core hashes, exact release commit, six metrics/criteria, and two-party approval. The service installer additionally supplies the packaged calibration, Python script, C++ core, and manifest commit for exact comparison. A production run persists and validates those qualification fields plus per-input frame/artifact hashes, thresholds, quality-gate result, and real/synthetic counts. These checks prove binding and fail-closed behavior; only a real frozen dataset, valid measured values, and genuine owner approvals can create the accepted report. See [the deployment and operations SOP](../docs/release-deployment-and-operations.md#6-算法配置准入报告与运行追溯).

To run the full bar-surface acceptance loop through the Rust API:

```powershell
scripts/test-bar-surface-e2e.ps1
```

The script reads capture/output/calibration paths from the service's active runtime
configuration, then performs manual steel-in, one strict eight-camera transaction,
Python reconstruction, C++ core conversion, database/summary checks, optional formal
report issuance, and steel-out. Any failure after steel-in attempts an exact-session
steel-out in `finally`, so a failed acceptance run does not leave a stale active
session. Pass `-AdminToken <token>` to include immutable report issuance/history in
the same run. Production-strict qualification is the default.

The desktop report page can also retrieve a specific immutable archive by
`inspectionId + reportId`. The service recomputes and verifies the archived document
SHA-256 before returning the body. The **打印版** action then downloads a self-contained
UTF-8 A4-landscape HTML containing all defects, algorithm/config/calibration trace,
artifact references, and signature lines; open it in the target browser and use the
system print dialog to print or save PDF. It never renders a historical report from
the current filtered table. Report-history reads and idempotent re-issuance use the
same validation; a damaged archive or unexpected file makes the list fail explicitly
instead of silently hiding one report.

To reuse an existing complete capture material without acquiring another frame:

```powershell
scripts/test-bar-surface-e2e.ps1 -MaterialId BAR-E2E-20260708-010650 -SkipCapture
```

An explicitly development-only run may use threshold overrides and omit release
qualification fields, but reconstruction acceptance, calibration binding, eight-camera
input completeness, input hashes, seam closure and C++ output remain mandatory:

```powershell
scripts/test-bar-surface-e2e.ps1 `
  -MaterialId BAR-E2E-20260708-010650 -SkipCapture `
  -CalibrationPath config\capture\calibrations\current-8-time-trigger\ArrayCalibration.xml `
  -AllowDevelopmentThresholdOverrides -AllowDevelopmentQualificationGaps
```

## Client Only

```powershell
scripts/build-client.ps1
scripts/run-client-dev.ps1 -ServicePort 4873 -VitePort 1432
```

Equivalent env-file mode:

```powershell
scripts/run-client-dev.ps1 -EnvFile config/env/client.env.example
```

The client talks to the Rust service. It does not start, link, or own the camera SDK.

To serve a built frontend without Vite:

```powershell
scripts/run-client-static.ps1 -Port 1432
```

## Tauri Desktop Only

Start the Rust service separately, then run:

```powershell
scripts/run-tauri-dev.ps1 -ServicePort 4873
```

Equivalent env-file mode:

```powershell
scripts/run-tauri-dev.ps1 -EnvFile config/env/client.env.example
```

Tauri dev starts only the Vite frontend through `app/client/src-tauri/tauri.conf.json`; it does not start the Rust service.

Desktop development is not installation evidence. The locked no-bundle Release completed in 56.64 seconds and produced `target/cargo/release/steel-plate-3d-inspection-tauri.exe` at 23,113,728 bytes with production devtools feature count zero. Tauri selects the WebView2 offline installer, per-machine NSIS mode, no downgrades, and the formal publisher. Formal `build-client.ps1 -Tauri` requires a certificate SHA-1 thumbprint and HTTPS timestamp URL; missing signing inputs fail closed, while `-AllowUnsignedDesktopBundle` is development-only. The EXE is `NotSigned`, depends on `VCRUNTIME140.dll`, and does not close the MSI/NSIS gate.

The latest unsigned diagnostic bundle attempts were stopped after the GitHub/proxy installer-resource download stopped making progress. WixTools314 was downloaded/extracted on the second attempt, but `target/cargo/release/bundle` was not created and no MSI/NSIS was generated. Treat this as an incomplete build-resource chain, not a successful bundle or a Rust source-compilation failure.

## Verification

```powershell
scripts/verify-independent-architecture.ps1
```

To verify only the Rust-to-external-capture-provider boundary:

```powershell
scripts/verify-external-provider.ps1
```

## Package Runtime

Create and semantically verify the release SBOM without network access before formal packaging. The external policy hash is an out-of-band approval input; the checked-in example is deliberately unapproved and cannot satisfy a release:

```powershell
scripts/generate-release-sbom.ps1 `
  -ExternalComponentsPath E:\approved-build-inputs\external-components.json `
  -ExpectedExternalComponentsSha256 $env:STEEL_EXTERNAL_COMPONENTS_SHA256 `
  -ExpectedCommit (git rev-parse HEAD) `
  -OutputPath target\release\steel-release-sbom.cdx.json

scripts/verify-release-sbom.ps1 `
  -SbomPath target\release\steel-release-sbom.cdx.json `
  -ExternalComponentsPath E:\approved-build-inputs\external-components.json `
  -ExpectedExternalComponentsSha256 $env:STEEL_EXTERNAL_COMPONENTS_SHA256 `
  -ExpectedCommit (git rev-parse HEAD)
```

The CycloneDX 1.5 document binds the source commit, four lock files, generator scripts, local Git/PowerShell versions, and at least one approved component in each of the C++ toolchain, camera SDK, VC Runtime, WebView2, WiX, and NSIS categories. The category set is exactly those six, but a category may contain multiple approved components, so the external component count is not fixed at six. Generation and verification are offline and fail closed on a dirty worktree unless an explicitly non-release test opts out. `scripts/test-release-sbom.ps1` exercises the deterministic output and rejection cases.

The checked-in external policy is only a rejected example. A release owner must supply the approved file and its SHA-256 out of band. The current static packaged verifier binds the SBOM, external policy, counts, serial, lock hashes and tool evidence, but it does not independently rebuild the complete npm/Cargo component inventory from all lock files. PowerShell JSON parsing also cannot reliably reject duplicate object-member names after parsing. Pin the formal build/semantic-verification host to Windows PowerShell 5.1 or PowerShell 6.2+; PowerShell 6.0/6.1 is unsupported because `ConvertFrom-Json -Depth` is unavailable there.

```powershell
$env:STEEL_RELEASE_POLICY_SHA256 = '<64-hex hash from release approval>'
$env:TAURI_WINDOWS_CERTIFICATE_THUMBPRINT = '<40-hex release certificate SHA-1 thumbprint>'
$env:TAURI_WINDOWS_TIMESTAMP_URL = 'https://<approved-rfc3161-timestamp-service>'
$env:TAURI_WINDOWS_PUBLISHER = '<exact approved publisher string>'
$env:VC_REDIST_X64_PATH = 'E:\approved-build-inputs\VC_redist.x64.exe'
$env:TAURI_BUNDLE_TOOLCHAIN_ROOT = 'E:\approved-build-inputs\tauri-bundle-toolchain-2.10.0'
$env:STEEL_BUNDLE_TOOLCHAIN_MANIFEST_SHA256 = '<64-hex hash approved out of band>'
$env:STEEL_EXTERNAL_COMPONENTS_PATH = 'E:\approved-build-inputs\external-components.json'
$env:STEEL_EXTERNAL_COMPONENTS_SHA256 = '<64-hex hash approved out of band>'
scripts/package-runtime.ps1
```

The release certificate must be an unexpired code-signing certificate with an accessible private key in the current user or local-machine certificate store. The timestamp endpoint must be HTTPS, the publisher must exactly match both the reviewed Tauri config and release policy, and the VC++ prerequisite must carry a valid timestamped Microsoft signature. These are build-side inputs; deployment approval still supplies `STEEL_RELEASE_SIGNER_THUMBPRINT`, vendor allowlist, `STEEL_DESKTOP_PUBLISHER`, and all three approved policy/manifest hashes independently rather than learning them from the package.

Every manifest declares `packageClass=formal-release` or `packageClass=engineering`. Formal packaging requires a clean Git worktree, C++ `Release`, Rust `release`, an enabled Tauri MSI/NSIS bundle, the reviewed source-controlled `config/release/desktop-release-policy.json`, its externally approved SHA-256, an externally supplied approved publisher, the approved external-components policy plus its out-of-band SHA-256, and synchronized product versions. It rejects `-SkipBuild`, `-AllowDirtyWorktree`, `-AllowDebugPackage`, and `-SkipDesktopBundle`; clears `target/capture`, `target/cargo`, `target/trigger`, `target/algorithm-core`, and `target/client/frontend-dist`; runs a clean `npm ci`; rebuilds every deliverable in that invocation; and checks the exact HEAD plus clean worktree after the builds and again before manifest generation. It rejects automatically merged Tauri config variants, unreviewed `TAURI_*`/Rust compiler/Cargo profile overrides, and Cargo config files other than the policy-pinned repository config. The desktop is built explicitly for `x86_64-pc-windows-msvc`; Tauri build features must be explicitly empty, release debug assertions must be false, and the packaged desktop/runtime PE machine values must be x86-64. `manifest.json` binds `releaseVersion`, the source commit, its exact `v<version>` or `<version>` tag, and `built-in-this-invocation` provenance. It records SHA-256 evidence for `package-lock.json`, the Tauri/service/trigger Cargo lockfiles, exact `tauri.conf.json`, Tauri `Cargo.toml`, the Cargo config, `build-evidence/desktop-release-policy.json`, the resolved `tauri-feature-resolution.json`, the approved offline bundle-toolchain manifest, the CycloneDX SBOM/external policy, and the database contract/migration index. Placeholder `0.1.0` is rejected. Any bypass produces an `engineering` package, never a formal release.

Prepare the WiX, NSIS, and offline WebView2 build inputs outside the repository. The generator inventories every payload file with its component, size, and SHA-256; its reported hash is only an approval candidate and must be reviewed/distributed out of band:

```powershell
scripts/new-tauri-bundle-toolchain-manifest.ps1 `
  -ProvisioningRoot E:\approved-build-inputs\tauri-bundle-toolchain-2.10.0 `
  -TauriCliVersion 2.10.0 `
  -WixVersion 3.14 `
  -WixLicense MS-RL `
  -NsisVersion 3.11 `
  -NsisLicense zlib `
  -WebView2Version '<approved offline runtime version>' `
  -WebView2License Microsoft
```

The provisioning root must contain `payload/WixTools314`, `payload/NSIS`, and `payload/WebView2` (custom canonical prefixes are supported). Formal packaging validates the source against the approved manifest hash before deleting old build outputs, provisions the exact files into `target/cargo/.tauri` after cleanup, and verifies the destination again after all builds. Missing, extra, changed, reparse-point, path-escape, wrong-component, or unapproved-manifest content fails closed. The payload itself is not copied into the runtime package; `build-evidence/bundle-toolchain-manifest.json` records the signed build input inventory.

Formal package inventory now requires exactly one MSI installer, one NSIS installer, and the desktop EXE; all three must have valid Authenticode signatures and trusted timestamps. It also requires `VC_REDIST_X64_PATH` (or `-VcRedistPath`) to point to a Microsoft-signed, timestamped `VC_redist.x64.exe`, which is copied under desktop prerequisites. Tauri embeds/uses the configured WebView2 offline installer. These gates still do not replace disconnected clean-machine installation or target-machine SCM acceptance.

Formal package mode now applies the same valid Authenticode and trusted-timestamp gate to every first-party background EXE: capture provider, Supervisor, Rust service, trigger gateway, and algorithm core. They must use the approved release-certificate thumbprint. The vendor `nvt_lvm_sdk.dll` must independently have a valid timestamped vendor signature. The gate is implemented, but the current local artifacts remain unsigned and no real release certificate/timestamp or vendor-signature evidence has been archived, so formal packaging still fails closed.

`checksums.sha256` is verified as a two-way complete inventory: every listed path must exist and match SHA-256, and every actual package file not in the exact exclusion set must appear once. Engineering packages exclude only the checksum file. Formal packages exclude exactly `checksums.sha256` and `release-integrity.cat`; the checksum inventory therefore covers all payload files, while the timestamp-signed SHA-256 Windows catalog covers the checksum inventory and all payload. The catalog itself is Authenticode-signed by the approved first-party certificate. Package-only and install-time verification both reject missing/extra/tampered files, an invalid catalog, or an unapproved signer.

Verify an already-built formal package from the deployment side without rebuilding it:

```powershell
scripts/verify-runtime-package.ps1 `
  -PackageDir target/packages/steel-inspection-runtime `
  -ExpectedFirstPartyThumbprint $env:STEEL_RELEASE_SIGNER_THUMBPRINT `
  -AllowedVendorSdkSignerThumbprints @($env:STEEL_VENDOR_SDK_SIGNER_THUMBPRINTS -split ',') `
  -ExpectedPublisher $env:STEEL_DESKTOP_PUBLISHER `
  -ExpectedReleasePolicySha256 $env:STEEL_RELEASE_POLICY_SHA256 `
  -ExpectedBundleToolchainManifestSha256 $env:STEEL_BUNDLE_TOOLCHAIN_MANIFEST_SHA256 `
  -ExpectedExternalComponentsSha256 $env:STEEL_EXTERNAL_COMPONENTS_SHA256
```

Formal verification is the wrapper default. All six trust inputs are out of band: the first-party signer, vendor signer allowlist, exact publisher, a 64-hex SHA-256 of the approved release policy, a 64-hex SHA-256 of the approved offline bundle-toolchain manifest, and a 64-hex SHA-256 of the approved external-components policy. It first authenticates those inputs, the two-way checksum set, and full catalog; only after that trust boundary passes may it run packaged contract/client checks. It checks package class/provenance, `npm ci` plus lock/Tauri-config/Cargo-manifest evidence, the packaged SBOM/external policy, database contract/index, `build-evidence/desktop-release-policy.json`, resolved `tauri-feature-resolution.json` (including no `devtools`), the exact bundle-toolchain component/file inventory, release version/tag, exact MSI/NSIS inventory and versions, offline WebView2, Microsoft-signed VC++, and desktop/runtime/catalog signatures.

An engineering package must be selected explicitly and is treated as untrusted data by default:

```powershell
# Static layout/manifest/hash checks only; packaged scripts are not executed.
scripts/verify-runtime-package.ps1 `
  -PackageDir target/packages/steel-inspection-runtime `
  -Engineering

# Only for a locally produced engineering package whose code you already trust.
scripts/verify-runtime-package.ps1 `
  -PackageDir target/packages/steel-inspection-runtime `
  -Engineering `
  -AllowPackageCodeExecution
```

The integrity code path is implemented; this workspace still has no clean tagged non-`0.1.0` commit, real certificate, signed catalog, or formal MSI/NSIS pair, so only explicit engineering verification can currently succeed.

This creates independent deployable folders under `target/packages/steel-inspection-runtime`. The package contains the headless C++ provider, Rust service, trigger gateway, and Tauri/React client, with no Qt artifacts or switches.

```powershell
target/packages/steel-inspection-runtime/run-capture-headless.ps1
target/packages/steel-inspection-runtime/run-service-external.ps1
target/packages/steel-inspection-runtime/run-service-simulated.ps1
target/packages/steel-inspection-runtime/run-client-static.ps1
target/packages/steel-inspection-runtime/test-integrated-management-smoke.ps1
target/packages/steel-inspection-runtime/test-integrated-runtime-ready.ps1
target/packages/steel-inspection-runtime/test-integrated-capture-management-full.ps1
target/packages/steel-inspection-runtime/test-runtime-acceptance.ps1
target/packages/steel-inspection-runtime/test-real-hardware-acceptance.ps1
target/packages/steel-inspection-runtime/test-real-calibration-acceptance.ps1
target/packages/steel-inspection-runtime/test-runtime-layout.ps1
target/packages/steel-inspection-runtime/stop-runtime.ps1
```

## Target-Local Runtime

For the local hardware runtime, synchronize the compiled executables and DLLs into `target/runtime`:

```powershell
scripts/build-capture-headless.ps1
scripts/build-service.ps1
scripts/build-trigger-gateway.ps1
scripts/sync-target-runtime.ps1
```

This creates:

```text
target/runtime/capture-headless/
target/runtime/service/
target/runtime/trigger/
target/runtime/client/
target/runtime/config/
```

The generated run scripts keep temporary runtime config under `target/runtime/config`.
The service SQLite database is `target/runtime/config/service/steel-inspection.sqlite`, and the capture-provider configuration root is `target/runtime/config/capture`.
The target runtime also includes `test-integrated-management-smoke.ps1`, which can be run from inside `target/runtime` to validate the simulated service + trigger gateway + static client flow without touching cameras.
Use `test-runtime-layout.ps1` from inside `target/runtime` for a static folder-layout check.
Use `test-runtime-acceptance.ps1` from inside `target/runtime` for a one-command folder acceptance check. It uses temporary ports `4973`, `4981`, and `1494` by default and only cleans listeners on those ports.
Use `test-integrated-runtime-ready.ps1` from inside `target/runtime` after starting the real stack to check capture, service, trigger gateway, network monitor, and client page readiness.
Use `test-integrated-capture-management-full.ps1` from inside `target/runtime` after starting the real stack for a combined layout/live-ready/hardware/UI acceptance report. Full coverage also requires the real calibration apply/rollback arguments, both crash Resume report paths, and `-CalibrationIntegrityGenerationReportPath`. Use `-StabilityDurationSec 600` for a ten-minute soak.
Use `test-runtime-ui-smoke.ps1` from inside `target/runtime` after starting the real stack and client to screenshot-check terminal/capture/3D pages and the receiver network popover's realtime upload/download monitor.
Use `test-real-hardware-acceptance.ps1` from inside `target/runtime` for read-only eight-camera hardware checks, or add `-RunCapture` to run one real production capture round and verify the H-drive production layout.
Use `test-real-calibration-acceptance.ps1` for the separately authorized calibration dry-run or real apply/rollback acceptance described above.

## Stop Runtime Processes

```powershell
scripts/stop-runtime.ps1
```

By default this stops the known C++/Rust executables and listeners on ports `4317`, `4873`, `4881`, and `1432`, including the PowerShell static client server. Pass `-Ports` when you started the stack on custom ports. Add `-IncludeNode` only when you intentionally want to stop local Node/Vite processes too.
