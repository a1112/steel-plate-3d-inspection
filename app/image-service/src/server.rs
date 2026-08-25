use crate::http::{error_json, ok_json, read_request};
use crate::rendition;
use crate::state::AppState;
use crate::tile;
use std::io::Write;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

pub fn run(port: u16, state: Arc<AppState>) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;
    println!("steel image service listening on http://127.0.0.1:{port}");
    while !state.shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                let state = Arc::clone(&state);
                thread::spawn(move || handle_client(stream, state));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => eprintln!("image listener error: {error}"),
        }
    }
    Ok(())
}

fn handle_client(mut stream: TcpStream, state: Arc<AppState>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(8)));
    let response = match read_request(&mut stream) {
        Ok(request) => route(&state, request),
        Err(error) => error_json(400, error),
    };
    let _ = stream.write_all(&response);
}

fn route(state: &AppState, request: crate::http::Request) -> Vec<u8> {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/health/live") | ("GET", "/health") => ok_json(&serde_json::json!({
            "status": "live",
            "service": "steel-image-service",
            "schema": "steel.image-service.health.v1"
        })),
        ("GET", "/internal/v1/status") => ok_json(&serde_json::json!({
            "schema": "steel.image-service.status.v2",
            "service": "steel-image-service",
            "role": "media-artifact-rendition",
            "ready": state.catalog.is_ready(),
            "resultRoot": state.result_root,
            "previewContract": "steel.thumbnail.v1",
            "legacyTileCompatibility": true
        })),
        ("GET", "/api/preview") | ("GET", "/internal/v1/preview") => {
            rendition::serve(state, &request.query, &request.if_none_match)
        }
        ("GET", "/api/tile") | ("GET", "/internal/v1/tile") => {
            tile::serve(state, &request.query, &request.if_none_match)
        }
        _ => error_json(404, "not_found"),
    }
}
