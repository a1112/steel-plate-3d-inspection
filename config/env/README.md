# Runtime Environment Templates

Copy one of these files to a local `.env` file or pass it directly with `-EnvFile`.

## Rust Service

- `headless-cpp.env.example`: Rust starts and supervises the headless C++ capture provider.
- `external-api.env.example`: Rust connects to an already running capture API process.
- `qt-terminal.env.example`: Rust connects to the standalone Qt capture terminal.
- `simulated.env.example`: Rust uses the six-camera simulation fallback.
- `trigger-gateway.env.example`: standalone trigger gateway from `app/trigger` forwards L2/PLC/API steel events to the Rust production API.

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

The gateway listens on `TRIGGER_GATEWAY_PORT` and forwards:

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
