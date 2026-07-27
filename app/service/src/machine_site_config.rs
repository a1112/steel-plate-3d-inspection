use serde::Serialize;
use std::sync::Mutex;

pub const SITE_ID_ENV: &str = "STEEL_SITE_CONFIG_ID";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SiteSelectionSource {
    Environment,
    Registry,
    Repository,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectiveSiteSelection {
    pub site_id: String,
    pub source: SiteSelectionSource,
}

pub struct SiteSelectionInput {
    pub environment_site_id: Option<String>,
    pub machine_default_site_id: Option<String>,
    pub repository_default_site_id: String,
}

pub trait MachineSiteStore: Send + Sync {
    fn read_default_site_id(&self) -> Result<Option<String>, String>;
    fn write_default_site_id(&self, id: &str) -> Result<(), String>;
    fn clear_default_site_id(&self) -> Result<(), String>;
    fn writable(&self) -> Result<bool, String>;
}

#[derive(Default)]
pub struct MemoryMachineSiteStore {
    value: Mutex<Option<String>>,
}

impl MachineSiteStore for MemoryMachineSiteStore {
    fn read_default_site_id(&self) -> Result<Option<String>, String> {
        self.value
            .lock()
            .map(|value| value.clone())
            .map_err(|_| "machine site memory store lock is poisoned".to_string())
    }

    fn write_default_site_id(&self, id: &str) -> Result<(), String> {
        validate_site_id(id)?;
        *self
            .value
            .lock()
            .map_err(|_| "machine site memory store lock is poisoned".to_string())? =
            Some(id.to_string());
        Ok(())
    }

    fn clear_default_site_id(&self) -> Result<(), String> {
        *self
            .value
            .lock()
            .map_err(|_| "machine site memory store lock is poisoned".to_string())? = None;
        Ok(())
    }

    fn writable(&self) -> Result<bool, String> {
        Ok(true)
    }
}

pub fn suggested_bkv_site(machine_name: &str) -> (String, String) {
    let display_machine = machine_name.trim();
    let display_machine = if display_machine.is_empty() {
        "UNKNOWN"
    } else {
        display_machine
    };
    let mut normalized = String::new();
    let mut separator_pending = false;
    for character in display_machine.chars() {
        if character.is_ascii_alphanumeric() {
            if separator_pending && !normalized.is_empty() {
                normalized.push('-');
            }
            normalized.push(character.to_ascii_lowercase());
            separator_pending = false;
        } else if !normalized.is_empty() {
            separator_pending = true;
        }
    }
    if normalized.is_empty() {
        normalized.push_str("computer");
    }
    (
        format!("bkv-offline-{normalized}"),
        format!("BKV 离线 - {display_machine}"),
    )
}

#[cfg(windows)]
pub struct WindowsMachineSiteStore;

#[cfg(windows)]
impl MachineSiteStore for WindowsMachineSiteStore {
    fn read_default_site_id(&self) -> Result<Option<String>, String> {
        windows_registry::read_default_site_id()
    }

    fn write_default_site_id(&self, id: &str) -> Result<(), String> {
        validate_site_id(id)?;
        windows_registry::write_default_site_id(id)?;
        match self.read_default_site_id()? {
            Some(value) if value == id => Ok(()),
            Some(value) => Err(format!(
                "machine registry write verification failed: expected {id}, read {value}"
            )),
            None => Err("machine registry write verification failed: value is missing".to_string()),
        }
    }

    fn clear_default_site_id(&self) -> Result<(), String> {
        windows_registry::clear_default_site_id()?;
        if self.read_default_site_id()?.is_none() {
            Ok(())
        } else {
            Err("machine registry clear verification failed".to_string())
        }
    }

    fn writable(&self) -> Result<bool, String> {
        windows_registry::writable()
    }
}

#[cfg(not(windows))]
pub struct UnsupportedMachineSiteStore;

#[cfg(not(windows))]
impl MachineSiteStore for UnsupportedMachineSiteStore {
    fn read_default_site_id(&self) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn write_default_site_id(&self, _id: &str) -> Result<(), String> {
        Err("machine registry is unavailable on this platform".to_string())
    }

    fn clear_default_site_id(&self) -> Result<(), String> {
        Err("machine registry is unavailable on this platform".to_string())
    }

    fn writable(&self) -> Result<bool, String> {
        Ok(false)
    }
}

pub fn machine_name() -> String {
    platform_machine_name()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "UNKNOWN".to_string())
}

#[cfg(not(windows))]
fn platform_machine_name() -> Option<String> {
    None
}

#[cfg(windows)]
fn platform_machine_name() -> Option<String> {
    use std::ptr;
    use windows_sys::Win32::System::SystemInformation::{
        GetComputerNameExW, ComputerNamePhysicalDnsHostname,
    };

    let mut size = 0_u32;
    unsafe {
        GetComputerNameExW(
            ComputerNamePhysicalDnsHostname,
            ptr::null_mut(),
            &mut size,
        );
    }
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0_u16; size as usize];
    let ok = unsafe {
        GetComputerNameExW(
            ComputerNamePhysicalDnsHostname,
            buffer.as_mut_ptr(),
            &mut size,
        )
    };
    if ok == 0 {
        return None;
    }
    buffer.truncate(size as usize);
    Some(String::from_utf16_lossy(&buffer))
}

#[cfg(windows)]
mod windows_registry {
    use std::ptr;
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
    };
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY,
        HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_SZ,
    };

    const KEY_PATH: &str = r"SOFTWARE\SteelInspectionRuntime\Configuration";
    const VALUE_NAME: &str = "DefaultSiteConfigId";

    struct OwnedKey(HKEY);

    impl Drop for OwnedKey {
        fn drop(&mut self) {
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }

    pub fn read_default_site_id() -> Result<Option<String>, String> {
        let Some(key) = open_key(KEY_READ, true)? else {
            return Ok(None);
        };
        let name = wide(VALUE_NAME);
        let mut value_type = 0_u32;
        let mut byte_count = 0_u32;
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                ptr::null(),
                &mut value_type,
                ptr::null_mut(),
                &mut byte_count,
            )
        };
        if is_missing(status) {
            return Ok(None);
        }
        ensure_success(status, "read machine default site size")?;
        if value_type != REG_SZ {
            return Err("machine default site registry value must be REG_SZ".to_string());
        }
        if byte_count == 0 || byte_count % 2 != 0 {
            return Err("machine default site registry value has invalid size".to_string());
        }
        let mut buffer = vec![0_u16; (byte_count as usize) / 2];
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                ptr::null(),
                &mut value_type,
                buffer.as_mut_ptr().cast(),
                &mut byte_count,
            )
        };
        ensure_success(status, "read machine default site")?;
        while buffer.last() == Some(&0) {
            buffer.pop();
        }
        let value = String::from_utf16(&buffer)
            .map_err(|_| "machine default site registry value is not valid UTF-16".to_string())?;
        if value.trim().is_empty() {
            return Err("machine default site registry value is empty".to_string());
        }
        Ok(Some(value))
    }

    pub fn write_default_site_id(id: &str) -> Result<(), String> {
        let key = open_key(KEY_SET_VALUE, false)?
            .ok_or_else(|| "machine configuration registry key is missing".to_string())?;
        let name = wide(VALUE_NAME);
        let value = wide(id);
        let status = unsafe {
            RegSetValueExW(
                key.0,
                name.as_ptr(),
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * std::mem::size_of::<u16>()) as u32,
            )
        };
        ensure_success(status, "write machine default site")
    }

    pub fn clear_default_site_id() -> Result<(), String> {
        let Some(key) = open_key(KEY_SET_VALUE, true)? else {
            return Ok(());
        };
        let name = wide(VALUE_NAME);
        let status = unsafe { RegDeleteValueW(key.0, name.as_ptr()) };
        if is_missing(status) {
            Ok(())
        } else {
            ensure_success(status, "clear machine default site")
        }
    }

    pub fn writable() -> Result<bool, String> {
        match open_key(KEY_SET_VALUE, true) {
            Ok(Some(_)) => Ok(true),
            Ok(None) => Ok(false),
            Err(error) if error.contains("access is denied") => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn open_key(access: u32, missing_ok: bool) -> Result<Option<OwnedKey>, String> {
        let path = wide(KEY_PATH);
        let mut key = ptr::null_mut();
        let status =
            unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, access, &mut key) };
        if missing_ok && is_missing(status) {
            return Ok(None);
        }
        ensure_success(status, "open machine configuration registry key")?;
        Ok(Some(OwnedKey(key)))
    }

    fn ensure_success(status: u32, action: &str) -> Result<(), String> {
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!(
                "{action} failed: {}",
                std::io::Error::from_raw_os_error(status as i32)
            ))
        }
    }

    fn is_missing(status: u32) -> bool {
        status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

pub fn select_site(input: SiteSelectionInput) -> Result<EffectiveSiteSelection, String> {
    if let Some(site_id) = input.environment_site_id {
        return selected(site_id, SiteSelectionSource::Environment, "environment");
    }
    if let Some(site_id) = input.machine_default_site_id {
        return selected(site_id, SiteSelectionSource::Registry, "registry");
    }
    selected(
        input.repository_default_site_id,
        SiteSelectionSource::Repository,
        "repository",
    )
}

pub fn restart_required(effective_site_id: &str, running_site_id: &str) -> bool {
    effective_site_id != running_site_id
}

fn selected(
    site_id: String,
    source: SiteSelectionSource,
    source_label: &str,
) -> Result<EffectiveSiteSelection, String> {
    validate_site_id(&site_id)
        .map_err(|error| format!("{source_label} site configuration is invalid: {error}"))?;
    Ok(EffectiveSiteSelection { site_id, source })
}

fn validate_site_id(value: &str) -> Result<(), String> {
    if !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        Ok(())
    } else {
        Err("site ID must contain only letters, numbers, '-' or '_'".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_override_wins_over_registry_and_repository() {
        let input = SiteSelectionInput {
            environment_site_id: Some("env-site".into()),
            machine_default_site_id: Some("registry-site".into()),
            repository_default_site_id: "repo-site".into(),
        };

        assert_eq!(
            select_site(input).unwrap(),
            EffectiveSiteSelection {
                site_id: "env-site".into(),
                source: SiteSelectionSource::Environment,
            }
        );
    }

    #[test]
    fn registry_default_wins_when_environment_is_absent() {
        let input = SiteSelectionInput {
            environment_site_id: None,
            machine_default_site_id: Some("registry-site".into()),
            repository_default_site_id: "repo-site".into(),
        };

        assert_eq!(select_site(input).unwrap().site_id, "registry-site");
    }

    #[test]
    fn repository_default_is_the_final_fallback() {
        let input = SiteSelectionInput {
            environment_site_id: None,
            machine_default_site_id: None,
            repository_default_site_id: "repo-site".into(),
        };

        assert_eq!(select_site(input).unwrap().site_id, "repo-site");
    }

    #[test]
    fn empty_explicit_identifiers_are_rejected_instead_of_falling_back() {
        let input = SiteSelectionInput {
            environment_site_id: Some(" ".into()),
            machine_default_site_id: Some("registry-site".into()),
            repository_default_site_id: "repo-site".into(),
        };

        assert!(select_site(input).unwrap_err().contains("environment"));
    }

    #[test]
    fn restart_is_required_only_when_effective_and_running_sites_differ() {
        assert!(!restart_required("site-a", "site-a"));
        assert!(restart_required("site-a", "site-b"));
    }

    #[test]
    fn machine_store_write_read_and_clear_round_trip() {
        let store = MemoryMachineSiteStore::default();
        store
            .write_default_site_id("bkv-offline-lcx-ace")
            .unwrap();
        assert_eq!(
            store.read_default_site_id().unwrap().as_deref(),
            Some("bkv-offline-lcx-ace")
        );
        assert!(store.writable().unwrap());
        store.clear_default_site_id().unwrap();
        assert_eq!(store.read_default_site_id().unwrap(), None);
    }

    #[test]
    fn suggested_bkv_identity_uses_normalized_host_name() {
        assert_eq!(
            suggested_bkv_site("LCX_ACE"),
            (
                "bkv-offline-lcx-ace".to_string(),
                "BKV 离线 - LCX_ACE".to_string()
            )
        );
    }

    #[test]
    fn suggested_bkv_identity_collapses_unsupported_host_characters() {
        assert_eq!(
            suggested_bkv_site("  Line 01 / 北科  "),
            (
                "bkv-offline-line-01".to_string(),
                "BKV 离线 - Line 01 / 北科".to_string()
            )
        );
    }
}
