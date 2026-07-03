use serde::Serialize;
use tauri::Manager;

const CAPTURE_MANAGEMENT_WINDOW: &str = "capture-management";
const PARAMETER_MANAGEMENT_WINDOW: &str = "parameter-management";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowCommandResult {
    opened: bool,
    label: String,
    error: Option<String>,
}

fn open_app_window(
    app: tauri::AppHandle,
    label: &str,
    title: &str,
    url: &str,
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

    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::App(url.into()))
        .title(title)
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
        label: label.to_string(),
        error: None,
    })
}

#[tauri::command]
fn open_capture_management_window(app: tauri::AppHandle) -> Result<WindowCommandResult, String> {
    open_app_window(
        app,
        CAPTURE_MANAGEMENT_WINDOW,
        "采集管理",
        "index.html?app=capture",
    )
}

#[tauri::command]
fn open_parameter_management_window(app: tauri::AppHandle) -> Result<WindowCommandResult, String> {
    open_app_window(
        app,
        PARAMETER_MANAGEMENT_WINDOW,
        "参数管理",
        "index.html?app=parameters",
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_capture_management_window,
            open_parameter_management_window
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
