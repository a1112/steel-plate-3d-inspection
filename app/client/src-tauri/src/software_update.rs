use serde::Serialize;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

const DEFAULT_UPDATE_ENDPOINT: &str =
    "https://github.com/a1112/steel-plate-3d-inspection/releases/latest/download/latest.json";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareUpdateStatus {
    current_version: String,
    configured: bool,
    channel: &'static str,
    reason: Option<&'static str>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareUpdateCheckResult {
    current_version: String,
    available: bool,
    version: Option<String>,
    date: Option<String>,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum SoftwareUpdateEvent {
    Started {
        content_length: Option<u64>,
    },
    Progress {
        chunk_length: usize,
        downloaded: u64,
    },
    Downloaded,
    Installing,
}

fn configured_public_key() -> Option<&'static str> {
    option_env!("STEEL_UPDATE_PUBLIC_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn configured_endpoint() -> &'static str {
    option_env!("STEEL_UPDATE_ENDPOINT")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_UPDATE_ENDPOINT)
}

fn configuration_error() -> String {
    "software_update_not_configured: 正式构建未绑定 STEEL_UPDATE_PUBLIC_KEY".to_string()
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let public_key = configured_public_key().ok_or_else(configuration_error)?;
    let endpoint = configured_endpoint()
        .parse()
        .map_err(|error| format!("software_update_endpoint_invalid: {error}"))?;
    app.updater_builder()
        .pubkey(public_key)
        .endpoints(vec![endpoint])
        .map_err(|error| format!("software_update_endpoint_invalid: {error}"))?
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("software_update_client_failed: {error}"))
}

#[tauri::command]
pub fn read_software_update_status(app: AppHandle) -> SoftwareUpdateStatus {
    SoftwareUpdateStatus {
        current_version: app.package_info().version.to_string(),
        configured: configured_public_key().is_some(),
        channel: "stable",
        reason: configured_public_key()
            .is_none()
            .then_some("正式构建尚未绑定签名更新公钥"),
    }
}

#[tauri::command]
pub async fn check_software_update(app: AppHandle) -> Result<SoftwareUpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let update = updater(&app)?
        .check()
        .await
        .map_err(|error| format!("software_update_check_failed: {error}"))?;
    Ok(match update {
        Some(update) => SoftwareUpdateCheckResult {
            current_version,
            available: true,
            version: Some(update.version),
            date: update.date.map(|value| value.to_string()),
            notes: update.body,
        },
        None => SoftwareUpdateCheckResult {
            current_version,
            available: false,
            version: None,
            date: None,
            notes: None,
        },
    })
}

#[tauri::command]
pub async fn install_software_update(
    app: AppHandle,
    on_event: Channel<SoftwareUpdateEvent>,
) -> Result<(), String> {
    let update = updater(&app)?
        .check()
        .await
        .map_err(|error| format!("software_update_check_failed: {error}"))?
        .ok_or_else(|| "software_update_not_available: 当前已经是最新版本".to_string())?;
    let mut downloaded = 0_u64;
    update
        .download_and_install(
            |chunk_length, content_length| {
                if downloaded == 0 {
                    let _ = on_event.send(SoftwareUpdateEvent::Started { content_length });
                }
                downloaded = downloaded.saturating_add(chunk_length as u64);
                let _ = on_event.send(SoftwareUpdateEvent::Progress {
                    chunk_length,
                    downloaded,
                });
            },
            || {
                let _ = on_event.send(SoftwareUpdateEvent::Downloaded);
                let _ = on_event.send(SoftwareUpdateEvent::Installing);
            },
        )
        .await
        .map_err(|error| format!("software_update_install_failed: {error}"))?;

    #[cfg(not(target_os = "windows"))]
    app.restart();

    Ok(())
}
