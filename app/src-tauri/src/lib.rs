use std::{
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

use serde::Serialize;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

mod capture_driver;

const CAPTURE_PORT: u16 = 4317;
const CAPTURE_MANAGEMENT_WINDOW: &str = "capture-management";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowCommandResult {
    opened: bool,
    label: String,
    error: Option<String>,
}

struct CaptureServiceProcess(Mutex<Option<Child>>);

impl Drop for CaptureServiceProcess {
    fn drop(&mut self) {
        if let Ok(mut child) = self.0.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
            }
        }
    }
}

fn capture_service_listening() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], CAPTURE_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn find_capture_service_exe() -> Option<PathBuf> {
    if let Ok(explicit_path) = std::env::var("STEEL_CAPTURE_SERVICE_EXE") {
        let path = PathBuf::from(explicit_path);
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(exe_dir.join("steel_capture_service.exe"));
            candidates.push(exe_dir.join("capture").join("steel_capture_service.exe"));
            candidates.push(
                exe_dir
                    .join("..")
                    .join("..")
                    .join("..")
                    .join("capture")
                    .join("build")
                    .join("Release")
                    .join("steel_capture_service.exe"),
            );
        }
    }
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(
            current_dir
                .join("capture")
                .join("build")
                .join("Release")
                .join("steel_capture_service.exe"),
        );
        candidates.push(
            current_dir
                .join("..")
                .join("capture")
                .join("build")
                .join("Release")
                .join("steel_capture_service.exe"),
        );
    }

    candidates.into_iter().find(|path| normalize_path(path).is_file())
}

fn normalize_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn start_capture_service() -> Option<Child> {
    if capture_service_listening() {
        return None;
    }
    let exe = find_capture_service_exe()?;
    let mut command = Command::new(&exe);
    command
        .arg("--port")
        .arg(CAPTURE_PORT.to_string())
        .current_dir(exe.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }

    command.spawn().ok()
}

#[tauri::command]
fn open_capture_management_window(app: tauri::AppHandle) -> Result<WindowCommandResult, String> {
    if let Some(window) = app.get_webview_window(CAPTURE_MANAGEMENT_WINDOW) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(WindowCommandResult {
            opened: true,
            label: CAPTURE_MANAGEMENT_WINDOW.to_string(),
            error: None,
        });
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        CAPTURE_MANAGEMENT_WINDOW,
        tauri::WebviewUrl::App("index.html?app=capture".into()),
    )
    .title("采集管理")
    .inner_size(1480.0, 900.0)
    .min_inner_size(1180.0, 720.0)
    .resizable(true)
    .maximizable(true)
    .minimizable(true)
    .center()
    .build()
    .map_err(|error| error.to_string())?;

    Ok(WindowCommandResult {
        opened: true,
        label: CAPTURE_MANAGEMENT_WINDOW.to_string(),
        error: None,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(capture_driver::CaptureDriver::new())
        .invoke_handler(tauri::generate_handler![
            open_capture_management_window,
            capture_driver::capture_driver_snapshot,
            capture_driver::capture_driver_health,
            capture_driver::capture_driver_cameras,
            capture_driver::capture_driver_statuses,
            capture_driver::capture_driver_connect,
            capture_driver::capture_driver_disconnect,
            capture_driver::capture_driver_status,
            capture_driver::capture_driver_set_param,
            capture_driver::capture_driver_capture_depth_map,
            capture_driver::capture_driver_apply_config,
            capture_driver::capture_driver_capabilities,
            capture_driver::capture_driver_logs
        ])
        .setup(|app| {
            let capture_process = if std::env::var("STEEL_CAPTURE_HTTP_AUTOSTART").as_deref() == Ok("1") {
                start_capture_service()
            } else {
                None
            };
            app.manage(CaptureServiceProcess(Mutex::new(capture_process)));
            if let Some(window) = app.get_webview_window("main") {
                window.center()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
