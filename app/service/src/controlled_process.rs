use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const POLL_INTERVAL: Duration = Duration::from_millis(200);
pub(super) const OUTPUT_RETAINED_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ControlledProcessError {
    Spawn(String),
    Containment(String),
    Wait(String),
    Cancelled,
    TimedOut,
}

#[cfg(windows)]
mod process_tree {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub(super) struct ProcessTree {
        job: HANDLE,
    }

    impl ProcessTree {
        pub(super) fn attach(child: &Child) -> Result<Self, String> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(format!(
                        "CreateJobObjectW failed: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) == 0
                {
                    let error = std::io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(format!("SetInformationJobObject failed: {error}"));
                }
                if AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) == 0 {
                    let error = std::io::Error::last_os_error();
                    CloseHandle(job);
                    return Err(format!("AssignProcessToJobObject failed: {error}"));
                }
                Ok(Self { job })
            }
        }

        pub(super) fn terminate(&self) {
            unsafe {
                let _ = TerminateJobObject(self.job, 1);
            }
        }
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.job);
            }
        }
    }
}

#[cfg(not(windows))]
mod process_tree {
    use std::process::Child;

    pub(super) struct ProcessTree;

    impl ProcessTree {
        pub(super) fn attach(_child: &Child) -> Result<Self, String> {
            Ok(Self)
        }

        pub(super) fn terminate(&self) {}
    }
}

#[derive(Debug)]
pub(super) struct ControlledProcessOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_total_bytes: u64,
    pub stderr_total_bytes: u64,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug, Default)]
struct BoundedRead {
    bytes: Vec<u8>,
    total_bytes: u64,
    truncated: bool,
}

fn read_bounded_tail(reader: &mut dyn Read, limit: usize) -> BoundedRead {
    if limit == 0 {
        let mut chunk = [0_u8; 16 * 1024];
        let mut total_bytes = 0_u64;
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(count) => total_bytes = total_bytes.saturating_add(count as u64),
            }
        }
        return BoundedRead {
            bytes: Vec::new(),
            total_bytes,
            truncated: total_bytes > 0,
        };
    }

    let mut ring = vec![0_u8; limit];
    let mut total_bytes = 0_u64;
    let mut write_index = 0_usize;
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        let count = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        total_bytes = total_bytes.saturating_add(count as u64);
        for byte in &chunk[..count] {
            ring[write_index] = *byte;
            write_index = (write_index + 1) % limit;
        }
    }

    let retained = usize::try_from(total_bytes.min(limit as u64)).unwrap_or(limit);
    if retained < limit {
        ring.truncate(retained);
    } else if total_bytes > limit as u64 && write_index != 0 {
        ring.rotate_left(write_index);
    }
    BoundedRead {
        bytes: ring,
        total_bytes,
        truncated: total_bytes > limit as u64,
    }
}

fn join_reader(reader: thread::JoinHandle<BoundedRead>) -> BoundedRead {
    reader.join().unwrap_or_default()
}

/// Runs a calculation child without allowing full stdout/stderr pipes to
/// deadlock it. Cancellation is intended only for computation that has no
/// device-side mutation boundary; callers retain that policy decision.
pub(super) fn run(
    command: &mut Command,
    timeout: Duration,
    cancellation_requested: Option<&dyn Fn() -> bool>,
) -> Result<ControlledProcessOutput, ControlledProcessError> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| ControlledProcessError::Spawn(error.to_string()))?;
    let process_tree = match process_tree::ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(ControlledProcessError::Containment(error));
        }
    };
    let mut stdout = child
        .stdout
        .take()
        .expect("piped child stdout must be available");
    let mut stderr = child
        .stderr
        .take()
        .expect("piped child stderr must be available");
    let stdout_reader =
        thread::spawn(move || read_bounded_tail(&mut stdout, OUTPUT_RETAINED_BYTES));
    let stderr_reader =
        thread::spawn(move || read_bounded_tail(&mut stderr, OUTPUT_RETAINED_BYTES));
    let started = Instant::now();

    let terminal = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(error) => break Err(ControlledProcessError::Wait(error.to_string())),
        }
        if cancellation_requested.map(|check| check()).unwrap_or(false) {
            break Err(ControlledProcessError::Cancelled);
        }
        if started.elapsed() >= timeout {
            break Err(ControlledProcessError::TimedOut);
        }
        thread::sleep(POLL_INTERVAL);
    };

    if terminal.is_err() {
        process_tree.terminate();
        let _ = child.kill();
    }
    let waited = child.wait();
    // A direct child may exit after launching a helper that inherited one of
    // the output pipes. Reap the entire job before joining reader threads so
    // such a helper cannot keep the pipe open and deadlock finalization.
    process_tree.terminate();
    let stdout = join_reader(stdout_reader);
    let stderr = join_reader(stderr_reader);
    match terminal {
        Ok(status) => Ok(ControlledProcessOutput {
            status,
            stdout: stdout.bytes,
            stderr: stderr.bytes,
            stdout_total_bytes: stdout.total_bytes,
            stderr_total_bytes: stderr.total_bytes,
            stdout_truncated: stdout.truncated,
            stderr_truncated: stderr.truncated,
        }),
        Err(error) => {
            // Preserve a wait failure if process cleanup itself is the only
            // failure. Cancellation/timeout remain the authoritative reason.
            if matches!(error, ControlledProcessError::Wait(_)) {
                if let Err(wait_error) = waited {
                    return Err(ControlledProcessError::Wait(wait_error.to_string()));
                }
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn powershell(script: &str) -> Command {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-Command", script]);
        command
    }

    #[cfg(windows)]
    fn process_exists(pid: u32) -> bool {
        powershell(&format!(
            "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"
        ))
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
    }

    #[cfg(windows)]
    fn wait_for_process_exit(pid: u32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if !process_exists(pid) {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let _ = powershell(&format!(
            "Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue"
        ))
        .status();
        false
    }

    #[test]
    fn captures_output_without_pipe_deadlock() {
        let mut command = powershell("[Console]::Out.Write('ok'); [Console]::Error.Write('warn')");
        let output = run(&mut command, Duration::from_secs(5), None).expect("controlled output");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "ok");
        assert_eq!(String::from_utf8_lossy(&output.stderr), "warn");
        assert_eq!(output.stdout_total_bytes, 2);
        assert_eq!(output.stderr_total_bytes, 4);
        assert!(!output.stdout_truncated);
        assert!(!output.stderr_truncated);
    }

    #[test]
    fn retains_only_the_tail_after_the_output_limit() {
        let input = b"0123456789";
        let mut cursor = std::io::Cursor::new(input);
        let output = read_bounded_tail(&mut cursor, 4);
        assert_eq!(output.bytes, b"6789");
        assert_eq!(output.total_bytes, 10);
        assert!(output.truncated);

        let mut exact_cursor = std::io::Cursor::new(b"1234");
        let exact = read_bounded_tail(&mut exact_cursor, 4);
        assert_eq!(exact.bytes, b"1234");
        assert_eq!(exact.total_bytes, 4);
        assert!(!exact.truncated);
    }

    #[test]
    fn terminates_a_cancelled_calculation() {
        let cancellation = Arc::new(AtomicBool::new(false));
        let cancellation_signal = Arc::clone(&cancellation);
        let setter = thread::spawn(move || {
            thread::sleep(Duration::from_millis(250));
            cancellation_signal.store(true, Ordering::Release);
        });
        let check = || cancellation.load(Ordering::Acquire);
        let mut command = powershell("Start-Sleep -Seconds 30");
        let started = Instant::now();
        let result = run(&mut command, Duration::from_secs(10), Some(&check));
        setter.join().expect("cancellation setter");
        assert_eq!(result.unwrap_err(), ControlledProcessError::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(windows)]
    #[test]
    fn cancellation_terminates_the_entire_descendant_tree() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let pid_file = std::env::temp_dir().join(format!(
            "steel-controlled-process-descendant-{}-{unique}.pid",
            std::process::id()
        ));
        let escaped_pid_file = pid_file.display().to_string().replace('\'', "''");
        let script = format!(
            "$child = Start-Process powershell.exe -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 30') -PassThru; Set-Content -LiteralPath '{escaped_pid_file}' -Value $child.Id -NoNewline; Start-Sleep -Seconds 30"
        );
        let cancellation_file = pid_file.clone();
        let check = move || cancellation_file.is_file();
        let mut command = powershell(&script);
        let result = run(&mut command, Duration::from_secs(10), Some(&check));
        assert_eq!(result.unwrap_err(), ControlledProcessError::Cancelled);

        let descendant_pid = std::fs::read_to_string(&pid_file)
            .expect("descendant pid file")
            .trim()
            .parse::<u32>()
            .expect("descendant pid");
        let descendant_exited = wait_for_process_exit(descendant_pid);
        let _ = std::fs::remove_file(&pid_file);
        assert!(
            descendant_exited,
            "descendant process survived cancellation"
        );
    }

    #[cfg(windows)]
    #[test]
    fn direct_child_success_still_reaps_background_descendants() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        let pid_file = std::env::temp_dir().join(format!(
            "steel-controlled-process-success-descendant-{}-{unique}.pid",
            std::process::id()
        ));
        let escaped_pid_file = pid_file.display().to_string().replace('\'', "''");
        let script = format!(
            "$child = Start-Process powershell.exe -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 30') -PassThru; Set-Content -LiteralPath '{escaped_pid_file}' -Value $child.Id -NoNewline"
        );
        let mut command = powershell(&script);
        let started = Instant::now();
        let result = run(&mut command, Duration::from_secs(10), None).expect("parent success");
        assert!(result.status.success());
        assert!(started.elapsed() < Duration::from_secs(5));
        let descendant_pid = std::fs::read_to_string(&pid_file)
            .expect("descendant pid file")
            .trim()
            .parse::<u32>()
            .expect("descendant pid");
        let descendant_exited = wait_for_process_exit(descendant_pid);
        let _ = std::fs::remove_file(&pid_file);
        assert!(
            descendant_exited,
            "background descendant survived successful parent completion"
        );
    }

    #[test]
    fn terminates_a_timed_out_calculation() {
        let mut command = powershell("Start-Sleep -Seconds 30");
        let started = Instant::now();
        let result = run(&mut command, Duration::from_millis(300), None);
        assert_eq!(result.unwrap_err(), ControlledProcessError::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
