# Independent server task monitor

This Tauri application is a standalone server-side process. It does not start,
stop, or supervise the operator client or the `SteelInspectionRuntime` Windows
service. Its Rust worker polls the local inspection service every five seconds
and keeps running when the monitor window is hidden to the system tray.

The service registry is loaded from `config/service-registry.json` (or the
configured `STEEL_SERVICE_REGISTRY_PATH`). The monitor consumes the
loopback-only `GET /api/runtime/status` snapshot, which includes registered
service health, lifecycle state, runtime roots, and bounded log tails.

In development the independent monitor frontend binds `1433`; the operator
client remains on `1432`. The ports and executable processes are intentionally
separate.

Build the shared read-only monitor frontend first, then build this executable:

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

The tray is read-only. It reports service health, worker/queue state, registered
service lifecycle, runtime roots, bounded log tails, and recent tasks. It never
stores an administrator token or mutates production tasks. The monitor process
and the inspection service remain separate executables and separate lifecycle
owners.
