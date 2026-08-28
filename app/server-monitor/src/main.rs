#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod background_monitor;
mod service_supervisor;

use background_monitor::{
    configure_background_monitor, control_background_service, read_background_monitor,
    refresh_background_monitor, set_background_service_startup_mode, BackgroundMonitorState,
    MONITOR_WINDOW,
};
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .manage(BackgroundMonitorState::default())
        .invoke_handler(tauri::generate_handler![
            configure_background_monitor,
            read_background_monitor,
            refresh_background_monitor,
            control_background_service,
            set_background_service_startup_mode
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window(MONITOR_WINDOW) {
                window.center()?;
            }
            background_monitor::install(app)?;
            background_monitor::start_worker(app.handle().clone());
            background_monitor::start_control_server(app.handle().clone())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let exiting = background_monitor::is_exiting(window.state());
                if background_monitor::should_hide_monitor_window(window.label(), exiting) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running independent server task monitor");
}
