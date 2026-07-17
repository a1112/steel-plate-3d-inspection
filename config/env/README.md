# Runtime Environment Templates

Copy one of these files to a local `.env` file or pass it directly with `-EnvFile`.

## Rust Service

- `headless-cpp.env.example`: Rust starts and supervises the headless C++ capture provider.
- `external-api.env.example`: Rust connects to an already running capture API process.
- `simulated.env.example`: Rust uses the eight-camera simulation fallback.
- `trigger-gateway.env.example`: standalone trigger gateway from `app/trigger` forwards L2/PLC/API steel events to the Rust production API.
- `runtime-service.env.example`: non-secret baseline for the unified `SteelInspectionRuntime` Windows service. The installer writes the active `runtime-service.env` beside this template.

Formal readiness requires the gateway at `TRIGGER_GATEWAY_ORIGIN` by default. Set `STEEL_TRIGGER_HEALTH_REQUIRED=0` only for an explicit development/service-only run.

For non-simulated capture, readiness also requires capacity telemetry from the global and every camera storage root. `STEEL_STORAGE_MIN_FREE_BYTES` and `STEEL_STORAGE_MIN_FREE_PERCENT` are independent hard watermarks; crossing either one returns `storage_capacity_below_watermark` and blocks admission of a new steel session while preserving retries and steel-out for an existing session. A soft warning is derived as twice the hard byte watermark and five percentage points above the hard percentage watermark. The warning publishes `level=warning` and `storage_capacity_near_watermark` without closing readiness, so operators have time to release capacity before the hard admission gate is reached. The templates use hard values of 20 GiB and 10%; replace these values with the approved site capacity calculation.

Record deletion and retention require `STEEL_ARTIFACT_ALLOWED_ROOTS`. Enumerate the narrow production capture, summary, and reconstruction directories using the platform path-list separator (`;` on Windows). Drive roots and configuration, calibration, maintenance, or profile directories must not be included. The service freezes file size and SHA-256 in a persistent cleanup manifest, deletes files with per-file progress, and removes database indexes only after physical cleanup succeeds; failed operations retain both the inspection indexes and a retryable cleanup ID.

The installer also derives `STEEL_REPORT_ARCHIVE_ROOT` as `StateRoot\reports\inspection`. Formal inspection report snapshots are content-addressed JSON archives under this root; repeated issuance of unchanged business data is idempotent, while changed record content creates a new immutable report ID and preserves earlier versions.

Production security is fail-closed:

- The unified service fixes `STEEL_RUNTIME_PROFILE=production`, `STEEL_ALGORITHM_MODE=production`, and `BAR_SURFACE_MOCK_DEFECT_COUNT=0`. The Supervisor sets `STEEL_ALGORITHM_CONFIG` to the packaged `config\algorithm\bar-surface-production.json`; the installer writes `STEEL_BAR_CAPTURE_ROOT` from the reviewed camera storage root, derives and creates `STEEL_ALGORITHM_DATA_ROOT` as `<StorageRoot>\reconstruction`, writes `STEEL_REPORT_ARCHIVE_ROOT`, and automatically includes the data roots in `STEEL_ARTIFACT_ALLOWED_ROOTS`. `STEEL_ALGORITHM_PROCESS_TIMEOUT_SEC` bounds Python/core calculation to 10–7200 seconds (default 1800). The Supervisor public-environment allowlist mirrors these installer-generated keys, and its regression fixture loads the same set. Runtime readiness and production algorithm admission require the active capture/config/output paths to exist with the expected file type, and production requests cannot replace those active paths. It also requires `STEEL_ALGORITHM_ACCEPTANCE_REPORT` to reference a separately approved `steel.algorithm-acceptance.v1` report. The example report remains `pending-site-approval` and is not a production credential.
- An empty database requires one strong `STEEL_BOOTSTRAP_ADMIN_PASSWORD`; production creates only the initial `admin` account. Its first session is restricted to changing that password or logging out. Add named engineer/operator accounts only after completing the forced change.
- Never place the bootstrap password or database password in a committed env file. Inject them through the Windows service account or the approved secret store.
- The unified service reads secrets from the absolute path in `STEEL_RUNTIME_SECRET_ENV_FILE`. Its installer only accepts `TRIGGER_SHARED_SECRET`, `TRIGGER_OPERATOR_TOKEN`, `STEEL_DATABASE_URL`, and `STEEL_BOOTSTRAP_ADMIN_PASSWORD` in that file, rejects duplicate/unknown keys, and applies SYSTEM/Administrators-only ACLs. Keep storage roots, ports, allowlists, and production mode in the generated non-secret `runtime-service.env` so a secret rotation cannot override safety policy.
- Production MySQL requires a dedicated non-`root` account and rejects the legacy `nercar` password.
- Remote MySQL URLs must use `ssl-mode=verify-ca` or `verify-identity`; encryption without certificate verification is not sufficient. Loopback is the only production host allowed to run without TLS.
- The development profile may still seed local demo accounts with `admin123`; those accounts cause production startup to fail until their passwords are changed.

The service installer accepts the algorithm report through its mandatory `-AlgorithmAcceptanceReport` parameter and validates its status, configuration hash, dataset/evaluator evidence, metrics, criteria, approvals, script/core hashes, calibration hash, and exact package-manifest release commit before registering the service. It requires elevation, protects the runtime tree and both external policy files for SYSTEM/Administrators, rejects reparse points, and audits the ancestor chain for untrusted delete/replace rights. Place secrets and the acceptance report only under a directory owned by SYSTEM, Administrators, or TrustedInstaller; an ordinary-user-writable parent causes installation to fail closed. Production readiness exposes separate `algorithm` and `productionPolicy` components, and either one being unhealthy is a No-Go condition.

Example:

```powershell
scripts/run-service.ps1 -EnvFile config/env/external-api.env.example
```

## Client

- `client.env.example`: Web/Tauri client points to the Rust service.

Example:

```powershell
scripts/run-client-dev.ps1 -EnvFile config/env/client.env.example
```

## Trigger Gateway

```powershell
scripts/run-trigger-gateway.ps1 -EnvFile config/env/trigger-gateway.env.example
```

The gateway listens for HTTP on `TRIGGER_GATEWAY_PORT`, newline-delimited JSON
on `TRIGGER_TCP_PORT`, and JSON datagrams on `TRIGGER_UDP_PORT`. Set either
network port to `0` to disable that listener. HTTP forwards:

- `POST /api/trigger/steel-info`
- `POST /api/trigger/steel-in`
- `POST /api/trigger/steel-out`
- `POST /api/trigger/secondary-data`
- `POST /api/trigger/capture-summary`
- `POST /api/trigger/capture-once`
- `POST /api/trigger/defect`
- `POST /api/trigger/event`
- `POST /api/plc/steel-in`
- `POST /api/plc/steel-out`
- `POST /api/l2/steel-info`
- `POST /api/l2/secondary-data`

When `TRIGGER_MODE=manual`, the local operator page is available at `http://127.0.0.1:4881/manual` and enables:

- `POST /api/trigger/manual/steel-info`
- `POST /api/trigger/manual/steel-in`
- `POST /api/trigger/manual/steel-out`

These manual endpoints return `409 manual_mode_required` unless the gateway mode is `manual`.

Steel-info, steel-in, steel-out, and generic trigger events are forwarded to Rust's durable production-task endpoints. Upstream PLC/L2 clients should provide a stable `requestId` when retrying the same command so Rust can return the existing idempotent task.

Production trigger ingress is fail-closed. `STEEL_RUNTIME_PROFILE=production` requires both a PLC/L2 `TRIGGER_SHARED_SECRET` and a different internal `TRIGGER_OPERATOR_TOKEN`, each at least 32 bytes. When binding beyond loopback it also requires `TRIGGER_SOURCE_ALLOWLIST` with exact IP and/or CIDR entries. HTTP clients send `X-Trigger-Timestamp`, `X-Trigger-Nonce`, and `X-Trigger-Signature`; TCP/UDP clients send the authenticated envelope documented in `docs/capture-api-contract.md`. The signature is HMAC-SHA256 over `steel-trigger-v1`, timestamp, nonce, transport, and the exact canonical body. The default time window is 30 seconds and every nonce is single-use. Production mode mutation is locked by default; manual mutations routed through Rust additionally require an authenticated `admin.services` session, are audited, and use `X-Trigger-Operator-Token` only on the local Rust-to-gateway hop. Secrets must be injected by the service manager, never committed to an env file.

Run the isolated production security gate after building the gateway:

```powershell
scripts/test-trigger-gateway-security.ps1
```
