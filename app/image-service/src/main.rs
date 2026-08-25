mod cache;
mod catalog;
mod http;
mod image_codec;
mod rendition;
mod server;
mod state;
mod tile;

use state::AppState;
use std::env;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;

fn main() -> std::io::Result<()> {
    let port = env::var("STEEL_IMAGE_SERVICE_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4874);
    let result_root = env::var("STEEL_RESULT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root().join("target/data/inspection-results"));
    let cache_bytes = env::var("STEEL_IMAGE_RAM_CACHE_BYTES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(128 * 1024 * 1024);

    let state = Arc::new(AppState::new(result_root, cache_bytes)?);
    let signal_state = Arc::clone(&state);
    ctrlc::set_handler(move || signal_state.shutdown.store(true, Ordering::Release))
        .map_err(io_error)?;

    server::run(port, state)
}

fn workspace_root() -> PathBuf {
    env::var("STEEL_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn io_error(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}
