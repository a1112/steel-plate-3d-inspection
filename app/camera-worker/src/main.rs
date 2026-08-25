use std::env;
use std::io;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const DEFAULT_PORT: u16 = 4317;

fn main() -> io::Result<()> {
    let shutdown = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&shutdown);
    ctrlc::set_handler(move || signal.store(true, Ordering::Release))
        .map_err(io_error)?;

    let mut child = capture_command()?.spawn()?;
    println!(
        "steel-capture-service started SICK camera provider pid={} on 127.0.0.1:{}",
        child.id(),
        configured_port()
    );
    monitor_child(&mut child, &shutdown)
}

fn capture_command() -> io::Result<Command> {
    let profile = required_file("STEEL_SICK_CAPTURE_PROFILE")?;
    let script = env::var("STEEL_SICK_CAPTURE_SCRIPT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root().join("scripts/sick_capture_service.py"));
    if !script.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("SICK capture script is missing: {}", script.display()),
        ));
    }
    let python = env::var("STEEL_PYTHON_EXECUTABLE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("python"));
    if python.is_absolute() && !python.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("Python executable is missing: {}", python.display()),
        ));
    }

    let mut command = Command::new(python);
    command
        .arg(script)
        .arg("--profile")
        .arg(profile)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(configured_port().to_string())
        .current_dir(workspace_root())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    Ok(command)
}

fn monitor_child(child: &mut Child, shutdown: &AtomicBool) -> io::Result<()> {
    loop {
        if shutdown.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        match child.try_wait()? {
            Some(status) => return child_exit(status),
            None => thread::sleep(Duration::from_millis(200)),
        }
    }
}

fn child_exit(status: ExitStatus) -> io::Result<()> {
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "SICK capture provider exited with {status}"
        )))
    }
}

fn configured_port() -> u16 {
    env::var("STEEL_CAPTURE_SERVICE_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn required_file(name: &str) -> io::Result<PathBuf> {
    let path = env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("{name} is required")))?;
    if !path.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{name} is missing: {}", path.display()),
        ));
    }
    Ok(path)
}

fn workspace_root() -> PathBuf {
    let current = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for candidate in current.ancestors() {
        if candidate.join("scripts/sick_capture_service.py").is_file() {
            return candidate.to_path_buf();
        }
    }
    current
}

fn io_error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_port_is_stable() {
        assert_eq!(DEFAULT_PORT, 4317);
    }

    #[test]
    fn successful_child_exit_is_accepted() {
        let status = Command::new("cmd")
            .args(["/C", "exit", "0"])
            .status()
            .expect("cmd should run");
        assert!(child_exit(status).is_ok());
    }
}
