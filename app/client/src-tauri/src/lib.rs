use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;

mod app_resource_usage;
use app_resource_usage::app_resource_usage;

const CAPTURE_MANAGEMENT_WINDOW: &str = "capture-management";
const PARAMETER_MANAGEMENT_WINDOW: &str = "parameter-management";
const BAR_SURFACE_WINDOW: &str = "bar-surface";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowCommandResult {
    opened: bool,
    label: String,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPathResult {
    selected: bool,
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFileWriteResult {
    saved: bool,
    path: Option<String>,
    bytes: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalTextFileResult {
    path: String,
    text: String,
    bytes: usize,
}

fn local_path_result(path: Option<PathBuf>) -> LocalPathResult {
    LocalPathResult {
        selected: path.is_some(),
        path: path.map(|value| value.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
async fn choose_local_file(
    title: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<LocalPathResult, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        dialog = dialog.set_title(title);
    }
    if let Some(extensions) = extensions {
        let cleaned: Vec<String> = extensions
            .into_iter()
            .map(|value| value.trim().trim_start_matches('.').to_string())
            .filter(|value| !value.is_empty() && value.chars().all(|ch| ch.is_ascii_alphanumeric()))
            .collect();
        if !cleaned.is_empty() {
            let extension_refs: Vec<&str> = cleaned.iter().map(String::as_str).collect();
            dialog = dialog.add_filter("允许的文件", &extension_refs);
        }
    }
    Ok(local_path_result(
        dialog
            .pick_file()
            .await
            .map(|handle| handle.path().to_path_buf()),
    ))
}

#[tauri::command]
async fn choose_local_directory(title: Option<String>) -> Result<LocalPathResult, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        dialog = dialog.set_title(title);
    }
    Ok(local_path_result(
        dialog
            .pick_folder()
            .await
            .map(|handle| handle.path().to_path_buf()),
    ))
}

#[tauri::command]
async fn save_binary_file_with_dialog(
    suggested_name: String,
    bytes: Vec<u8>,
) -> Result<LocalFileWriteResult, String> {
    if bytes.is_empty() {
        return Err("refusing to save an empty preview".to_string());
    }
    let safe_name = PathBuf::from(suggested_name.trim())
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("capture-preview.png")
        .to_string();
    let is_json = safe_name.to_ascii_lowercase().ends_with(".json");
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("保存当前预览")
        .set_file_name(safe_name);
    dialog = if is_json {
        dialog.add_filter("JSON 元数据", &["json"])
    } else {
        dialog.add_filter("PNG 图像", &["png"])
    };
    let selected = dialog.save_file().await;
    let Some(handle) = selected else {
        return Ok(LocalFileWriteResult {
            saved: false,
            path: None,
            bytes: 0,
        });
    };
    std::fs::write(handle.path(), &bytes).map_err(|error| error.to_string())?;
    Ok(LocalFileWriteResult {
        saved: true,
        path: Some(handle.path().to_string_lossy().into_owned()),
        bytes: bytes.len(),
    })
}

#[tauri::command]
fn open_local_path(path: String) -> Result<LocalPathResult, String> {
    let requested = PathBuf::from(path.trim());
    if !requested.is_absolute() {
        return Err("local path must be absolute".to_string());
    }
    let canonical = requested
        .canonicalize()
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer.exe");
        if canonical.is_file() {
            command.arg(format!("/select,{}", canonical.to_string_lossy()));
        } else {
            command.arg(&canonical);
        }
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        if canonical.is_file() {
            command.arg("-R");
        }
        command.arg(&canonical);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(if canonical.is_file() {
            canonical.parent().unwrap_or(&canonical)
        } else {
            &canonical
        });
        command
    };

    command.spawn().map_err(|error| error.to_string())?;
    Ok(local_path_result(Some(canonical)))
}

#[tauri::command]
fn read_local_text_file(path: String) -> Result<LocalTextFileResult, String> {
    let requested = PathBuf::from(path.trim());
    if !requested.is_absolute() {
        return Err("local text path must be absolute".to_string());
    }
    let canonical = requested
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical.is_file() {
        return Err("local text path must be a regular file".to_string());
    }
    const MAX_TEXT_BYTES: u64 = 10 * 1024 * 1024;
    let metadata = std::fs::metadata(&canonical).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_TEXT_BYTES {
        return Err("local text file exceeds 10 MiB".to_string());
    }
    let text = std::fs::read_to_string(&canonical).map_err(|error| error.to_string())?;
    Ok(LocalTextFileResult {
        path: canonical.to_string_lossy().into_owned(),
        bytes: text.len(),
        text,
    })
}

fn open_app_window(
    app: tauri::AppHandle,
    label: &str,
    title: &str,
    route: &str,
) -> Result<WindowCommandResult, String> {
    if let Some(window) = app.get_webview_window(label) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(WindowCommandResult {
            opened: true,
            label: label.to_string(),
            error: None,
        });
    }

    let url = if cfg!(debug_assertions) {
        tauri::WebviewUrl::External(
            format!("http://localhost:1432/#app={route}")
                .parse()
                .map_err(|error| format!("invalid development tool window URL: {error}"))?,
        )
    } else {
        tauri::WebviewUrl::App(format!("index.html#app={route}").into())
    };

    tauri::WebviewWindowBuilder::new(&app, label, url)
        .title(title)
        .inner_size(1480.0, 900.0)
        .min_inner_size(1180.0, 720.0)
        .resizable(true)
        .maximizable(true)
        .minimizable(true)
        .closable(true)
        .decorations(false)
        .shadow(true)
        .center()
        .build()
        .map_err(|error| error.to_string())?;

    Ok(WindowCommandResult {
        opened: true,
        label: label.to_string(),
        error: None,
    })
}

#[tauri::command]
fn open_capture_management_window(app: tauri::AppHandle) -> Result<WindowCommandResult, String> {
    open_app_window(app, CAPTURE_MANAGEMENT_WINDOW, "采集管理", "capture")
}

#[tauri::command]
fn open_parameter_management_window(app: tauri::AppHandle) -> Result<WindowCommandResult, String> {
    open_app_window(app, PARAMETER_MANAGEMENT_WINDOW, "后台管理", "parameters")
}

#[tauri::command]
fn open_bar_surface_window(app: tauri::AppHandle) -> Result<WindowCommandResult, String> {
    open_app_window(app, BAR_SURFACE_WINDOW, "3D 重建工作台", "bar-surface")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_capture_management_window,
            open_parameter_management_window,
            open_bar_surface_window,
            choose_local_file,
            choose_local_directory,
            save_binary_file_with_dialog,
            open_local_path,
            read_local_text_file,
            app_resource_usage
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window.center()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
