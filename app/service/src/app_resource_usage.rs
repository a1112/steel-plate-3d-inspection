use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::{get_current_pid, Pid, ProcessesToUpdate, System};

static RESOURCE_SYSTEM: OnceLock<Mutex<System>> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppResourceUsage {
    pub(crate) code: u8,
    pub(crate) cpu_usage: f32,
    pub(crate) memory_used: u64,
    pub(crate) memory_total: u64,
    pub(crate) memory_percent: f32,
    pub(crate) process_count: usize,
    pub(crate) python_memory_used: u64,
    pub(crate) rust_memory_used: u64,
    pub(crate) webview_memory_used: u64,
    pub(crate) node_memory_used: u64,
    pub(crate) tauri_memory_used: u64,
    pub(crate) other_memory_used: u64,
    pub(crate) largest_process_name: String,
    pub(crate) largest_process_memory_used: u64,
    pub(crate) sampled_at_ms: u128,
    pub(crate) source: &'static str,
    pub(crate) precision: &'static str,
}

#[derive(Default)]
struct ProcessMemoryBreakdown {
    python_memory_used: u64,
    rust_memory_used: u64,
    webview_memory_used: u64,
    node_memory_used: u64,
    tauri_memory_used: u64,
    other_memory_used: u64,
    largest_process_name: String,
    largest_process_memory_used: u64,
}

fn normalize_process_group_cpu_usage(raw_cpu_usage: f32, logical_cpu_count: usize) -> f32 {
    if !raw_cpu_usage.is_finite() || raw_cpu_usage <= 0.0 {
        return 0.0;
    }
    if logical_cpu_count == 0 {
        return raw_cpu_usage.clamp(0.0, 100.0);
    }
    (raw_cpu_usage / logical_cpu_count as f32).clamp(0.0, 100.0)
}

fn add_process_memory_to_breakdown(
    breakdown: &mut ProcessMemoryBreakdown,
    process_name: &str,
    memory_used: u64,
) {
    let lower_name = process_name.to_ascii_lowercase();
    if lower_name.contains("python") {
        breakdown.python_memory_used = breakdown.python_memory_used.saturating_add(memory_used);
    } else if lower_name.contains("steel-inspection-service")
        || lower_name.contains("rust_hot_path_service")
    {
        breakdown.rust_memory_used = breakdown.rust_memory_used.saturating_add(memory_used);
    } else if lower_name.contains("msedgewebview2") || lower_name.contains("webview") {
        breakdown.webview_memory_used = breakdown.webview_memory_used.saturating_add(memory_used);
    } else if lower_name.contains("node") {
        breakdown.node_memory_used = breakdown.node_memory_used.saturating_add(memory_used);
    } else if lower_name.contains("steel-plate-3d-inspection-tauri") || lower_name.contains("tauri")
    {
        breakdown.tauri_memory_used = breakdown.tauri_memory_used.saturating_add(memory_used);
    } else {
        breakdown.other_memory_used = breakdown.other_memory_used.saturating_add(memory_used);
    }

    if memory_used > breakdown.largest_process_memory_used {
        breakdown.largest_process_name = process_name.to_string();
        breakdown.largest_process_memory_used = memory_used;
    }
}

#[cfg(windows)]
fn platform_working_set_bytes(pid: Pid) -> Option<u64> {
    use std::ffi::c_void;
    use std::mem::{size_of, zeroed};

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const PROCESS_VM_READ: u32 = 0x0010;

    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    #[link(name = "psapi")]
    unsafe extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut c_void,
            counters: *mut ProcessMemoryCounters,
            size: u32,
        ) -> i32;
    }

    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
            0,
            pid.as_u32(),
        )
    };
    if handle.is_null() {
        return None;
    }
    let mut counters: ProcessMemoryCounters = unsafe { zeroed() };
    counters.cb = size_of::<ProcessMemoryCounters>() as u32;
    let ok = unsafe {
        GetProcessMemoryInfo(
            handle,
            &mut counters,
            size_of::<ProcessMemoryCounters>() as u32,
        )
    };
    unsafe {
        CloseHandle(handle);
    }
    (ok != 0).then_some(counters.working_set_size as u64)
}

#[cfg(not(windows))]
fn platform_working_set_bytes(_pid: Pid) -> Option<u64> {
    None
}

fn sampled_at_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn collect_app_resource_usage() -> Result<AppResourceUsage, String> {
    let current_pid = get_current_pid().map_err(|error| error.to_string())?;
    // The service fallback only promises degraded, service-process-only metrics.
    // Refreshing every process on the machine once per UI poll is both misleading
    // (the capture and Tauri processes are siblings, not children) and very costly
    // on high-core Windows hosts.  It can also leave sysinfo's parallel workers
    // consuming CPU after the request has completed.  Keep this endpoint bounded
    // to the current service PID; the native Tauri command remains the precise path.
    let system = RESOURCE_SYSTEM.get_or_init(|| Mutex::new(System::new()));
    let mut system = system
        .lock()
        .map_err(|_| "resource monitor lock poisoned".to_string())?;

    system.refresh_memory();
    system.refresh_processes(ProcessesToUpdate::Some(&[current_pid]), true);

    let mut raw_cpu_usage = 0.0f32;
    let mut memory_used = 0u64;
    let mut process_count = 0usize;
    let mut breakdown = ProcessMemoryBreakdown::default();

    if let Some(process) = system.process(current_pid) {
        raw_cpu_usage = process.cpu_usage();
        let process_memory =
            platform_working_set_bytes(current_pid).unwrap_or_else(|| process.memory());
        memory_used = process_memory;
        process_count = 1;
        add_process_memory_to_breakdown(
            &mut breakdown,
            &process.name().to_string_lossy(),
            process_memory,
        );
    }

    let memory_total = system.total_memory();
    Ok(AppResourceUsage {
        code: 0,
        cpu_usage: normalize_process_group_cpu_usage(raw_cpu_usage, system.cpus().len()),
        memory_used,
        memory_total,
        memory_percent: if memory_total > 0 {
            (memory_used as f32 / memory_total as f32) * 100.0
        } else {
            0.0
        },
        process_count,
        python_memory_used: breakdown.python_memory_used,
        rust_memory_used: breakdown.rust_memory_used,
        webview_memory_used: breakdown.webview_memory_used,
        node_memory_used: breakdown.node_memory_used,
        tauri_memory_used: breakdown.tauri_memory_used,
        other_memory_used: breakdown.other_memory_used,
        largest_process_name: breakdown.largest_process_name,
        largest_process_memory_used: breakdown.largest_process_memory_used,
        sampled_at_ms: sampled_at_ms(),
        source: "service",
        precision: "degraded",
    })
}

pub(crate) fn app_resource_usage_response() -> Vec<u8> {
    match collect_app_resource_usage() {
        Ok(usage) => crate::http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &serde_json::to_string(&usage).unwrap_or_else(|_| "{}".to_string()),
        ),
        Err(error) => crate::http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &serde_json::json!({
                "code": 1,
                "source": "service",
                "precision": "degraded",
                "sampledAtMs": sampled_at_ms(),
                "error": error,
            })
            .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_process_group_cpu_usage_to_system_percent() {
        let normalized = normalize_process_group_cpu_usage(153.0, 16);
        assert!((normalized - 9.5625).abs() < 0.0001);
        assert_eq!(normalize_process_group_cpu_usage(142.0, 0), 100.0);
    }

    #[test]
    fn groups_process_memory_by_runtime_and_tracks_the_largest() {
        let mut breakdown = ProcessMemoryBreakdown::default();

        add_process_memory_to_breakdown(&mut breakdown, "python.exe", 10);
        add_process_memory_to_breakdown(&mut breakdown, "steel-inspection-service.exe", 8);
        add_process_memory_to_breakdown(&mut breakdown, "msedgewebview2.exe", 7);
        add_process_memory_to_breakdown(&mut breakdown, "node.exe", 6);
        add_process_memory_to_breakdown(&mut breakdown, "steel-plate-3d-inspection-tauri.exe", 5);
        add_process_memory_to_breakdown(&mut breakdown, "helper.exe", 4);

        assert_eq!(breakdown.python_memory_used, 10);
        assert_eq!(breakdown.rust_memory_used, 8);
        assert_eq!(breakdown.webview_memory_used, 7);
        assert_eq!(breakdown.node_memory_used, 6);
        assert_eq!(breakdown.tauri_memory_used, 5);
        assert_eq!(breakdown.other_memory_used, 4);
        assert_eq!(breakdown.largest_process_name, "python.exe");
        assert_eq!(breakdown.largest_process_memory_used, 10);
    }

    #[test]
    fn service_response_uses_the_degraded_client_contract() {
        let response =
            collect_app_resource_usage().expect("current service process should be visible");

        assert_eq!(response.code, 0);
        assert_eq!(response.source, "service");
        assert_eq!(response.precision, "degraded");
        assert!(response.cpu_usage.is_finite());
        assert!(response.process_count >= 1);
    }
}
