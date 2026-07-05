# Runtime Environment Templates

Copy one of these files to a local `.env` file or pass it directly with `-EnvFile`.

## Rust Service

- `headless-cpp.env.example`: Rust starts and supervises the headless C++ capture provider.
- `external-api.env.example`: Rust connects to an already running capture API process.
- `qt-terminal.env.example`: Rust connects to the standalone Qt capture terminal.
- `simulated.env.example`: Rust uses the six-camera simulation fallback.

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
