use crate::http::{error_json, ok_json, read_request, Response};
use crate::rendition;
use crate::state::AppState;
use crate::tile;
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::Ordering;
use std::sync::mpsc::{sync_channel, Receiver, TrySendError};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

pub fn run(port: u16, state: Arc<AppState>) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    listener.set_nonblocking(true)?;
    let worker_count = configured_worker_count();
    let (sender, receiver) = sync_channel::<TcpStream>(worker_count * 16);
    let receiver = Arc::new(Mutex::new(receiver));
    let workers = (0..worker_count)
        .map(|_| {
            let receiver = Arc::clone(&receiver);
            let state = Arc::clone(&state);
            thread::spawn(move || worker_loop(receiver, state))
        })
        .collect::<Vec<_>>();
    println!(
        "steel image service listening on http://127.0.0.1:{port} with {worker_count} workers"
    );
    while !state.shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => match sender.try_send(stream) {
                Ok(()) => {}
                Err(TrySendError::Full(mut stream)) => {
                    let _ = error_json(503, "image_worker_queue_full").write_to(&mut stream, true);
                }
                Err(TrySendError::Disconnected(_)) => break,
            },
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(1));
            }
            Err(error) => eprintln!("image listener error: {error}"),
        }
    }
    drop(sender);
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
}

fn configured_worker_count() -> usize {
    std::env::var("STEEL_IMAGE_SERVICE_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| {
            thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(4)
                .saturating_mul(2)
                .clamp(4, 32)
        })
}

fn worker_loop(receiver: Arc<Mutex<Receiver<TcpStream>>>, state: Arc<AppState>) {
    loop {
        let stream = receiver
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .recv();
        let Ok(stream) = stream else {
            break;
        };
        handle_client(stream, Arc::clone(&state));
    }
}

fn handle_client(mut stream: TcpStream, state: Arc<AppState>) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(8)));
    for request_index in 0..256 {
        let request = match read_request(&mut stream) {
            Ok(Some(request)) => request,
            Ok(None) => break,
            Err(error) => {
                let _ = error_json(400, error).write_to(&mut stream, true);
                break;
            }
        };
        let connection_close = request.connection_close || request_index == 255;
        if route(&state, request)
            .write_to(&mut stream, connection_close)
            .is_err()
            || connection_close
        {
            break;
        }
    }
}

fn route(state: &AppState, request: crate::http::Request) -> Response {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/health/live") | ("GET", "/health") => ok_json(&serde_json::json!({
            "status": "live",
            "service": "steel-image-service",
            "schema": "steel.image-service.health.v1"
        })),
        ("GET", "/internal/v1/status") => {
            let catalog = state.catalog.stats();
            let encoded = state.cache.stats();
            let decoded = state.decoded_cache.stats();
            ok_json(&serde_json::json!({
                "schema": "steel.image-service.status.v3",
                "service": "steel-image-service",
                "role": "media-artifact-rendition",
                "ready": state.catalog.is_ready(),
                "resultRoot": state.result_root,
                "previewContract": "steel.thumbnail.v1",
                "legacyTileCompatibility": true,
                "cacheLimits": {
                    "encodedBytes": state.encoded_cache_bytes,
                    "decodedBytes": state.decoded_cache_bytes,
                    "catalogEntries": state.catalog_cache_entries
                },
                "cacheCounters": {
                    "encodedMemoryHits": encoded.memory_hits,
                    "encodedDiskHits": encoded.disk_hits,
                    "encodedMisses": encoded.misses,
                    "decodedHits": decoded.hits,
                    "decodedMisses": decoded.misses,
                    "catalogHits": catalog.cache_hits,
                    "catalogDatabaseQueries": catalog.database_queries
                }
            }))
        }
        ("GET", "/api/preview") | ("GET", "/internal/v1/preview") => {
            rendition::serve(state, &request.query, &request.if_none_match)
        }
        ("GET", "/api/tile") | ("GET", "/internal/v1/tile") => {
            tile::serve(state, &request.query, &request.if_none_match)
        }
        _ => error_json(404, "not_found"),
    }
}
