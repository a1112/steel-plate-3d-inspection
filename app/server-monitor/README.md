# Independent server task monitor

This Tauri application is the standalone process-level lifecycle owner for the
registered inspection services. Its Rust worker probes every service, starts
services in `normal` mode, automatically relaunches a normal-mode process after
an unexpected exit, and keeps running when the window is hidden to the tray.
It does not supervise the operator client itself.

The service registry is loaded from `config/service-registry.json` (or
`STEEL_SERVICE_REGISTRY_PATH`). Each `process` entry declares command
candidates, environment, output files, and the default startup mode. Persisted
mode overrides and lifecycle audit logs are stored below
`target/run/server-monitor` by default.

The Rust worker refreshes every second. Service cards come from live HTTP
health probes, including the capture provider's internal readiness. The lower
panel is the supervisor's lifecycle audit: startup, stop, restart, unexpected
exit, automatic relaunch, and startup-mode changes.

The monitor exposes a loopback-only control API at `http://127.0.0.1:4899` so
the main application footer can display the same real snapshot and request
start, stop, restart, or startup-mode changes. Mutation requests require the
expected local-client header and accepted local/Tauri origins; the listener is
never bound to a LAN interface.

In development the independent monitor frontend binds `1433`; the operator
client remains on `1432`. The ports and executable processes are intentionally
separate.

Build the shared monitor frontend first, then build this executable:

```powershell
npm.cmd --prefix app/client run build
cargo build --manifest-path app/server-monitor/Cargo.toml --release --locked --offline --features custom-protocol
```

From the repository root, `scripts/build-server-monitor.ps1` performs both
steps and writes `target/cargo/release/steel-inspection-server-monitor.exe`.
Exit an already running monitor from its tray menu before rebuilding because
Windows locks the running executable.

Start the compiled monitor in the interactive server session:

```powershell
Start-Process .\target\cargo\release\steel-inspection-server-monitor.exe
```

The default service origin is `http://127.0.0.1:4873`. Set
`INSPECTION_SERVICE_ORIGIN` before starting the process to use another port on
`127.0.0.1` or `localhost`. Remote clear-text endpoints are rejected. The
executable must run in an interactive Windows user session; a process in
service Session 0 cannot display a desktop tray icon.

The tray reports service health and worker/queue state. The right-side service
panel provides start, stop, restart, and `normal` / `manual` / `disabled`
startup-mode controls. `normal` means desired-running plus automatic relaunch;
an explicit stop changes a normal service to manual so it stays stopped. The
monitor does not mutate production tasks and does not store an administrator
token.
