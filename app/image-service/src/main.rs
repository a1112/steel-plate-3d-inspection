use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::io::{Cursor, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const TILE_SIZE: u32 = 128;

struct State {
    result_root: PathBuf,
    catalog: PathBuf,
    cache: Mutex<HashMap<String, Arc<Vec<u8>>>>,
    shutdown: AtomicBool,
}

fn main() -> std::io::Result<()> {
    let port = env::var("STEEL_IMAGE_SERVICE_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4874);
    let result_root = env::var("STEEL_RESULT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root().join("target/data/inspection-results"));
    std::fs::create_dir_all(&result_root)?;
    let state = Arc::new(State {
        catalog: result_root.join("catalog.db"),
        result_root,
        cache: Mutex::new(HashMap::new()),
        shutdown: AtomicBool::new(false),
    });
    let signal_state = Arc::clone(&state);
    ctrlc::set_handler(move || signal_state.shutdown.store(true, Ordering::Release))
        .map_err(io_error)?;
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
                thread::sleep(Duration::from_millis(5))
            }
            Err(error) => eprintln!("image listener error: {error}"),
        }
    }
    Ok(())
}

fn io_error(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, error.to_string())
}
fn workspace_root() -> PathBuf {
    env::var("STEEL_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

fn handle_client(mut stream: TcpStream, state: Arc<State>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(8)));
    let bytes = read_http_request(&mut stream);
    let request = String::from_utf8_lossy(&bytes);
    let first = request.lines().next().unwrap_or_default();
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let if_none_match = request
        .lines()
        .find_map(|line| line.strip_prefix("If-None-Match:").map(str::trim))
        .unwrap_or_default();
    let (path, query) = split_target(target);
    let result = match (method, path) {
        ("GET", "/api/health/live") | ("GET", "/health") => ok_json("{\"status\":\"live\",\"service\":\"steel-image-service\",\"schema\":\"steel.image-service.health.v1\"}"),
        ("GET", "/internal/v1/status") => ok_json(&serde_json::json!({"schema":"steel.image-service.status.v1","service":"steel-image-service","ready":state.catalog.is_file(),"resultRoot":state.result_root}).to_string()),
        ("GET", "/api/tile") | ("GET", "/internal/v1/tile") => serve_tile(&state, query, if_none_match),
        ("GET", "/api/preview") | ("GET", "/internal/v1/preview") => serve_preview(&state, query, if_none_match),
        _ => error_json(404, "not_found"),
    };
    let _ = stream.write_all(&result);
}

fn read_http_request(stream: &mut TcpStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                bytes.extend_from_slice(&buffer[..size]);
                if let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let header = String::from_utf8_lossy(&bytes[..header_end]);
                    let content_length = header
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("Content-Length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= header_end + 4 + content_length {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
    bytes
}

fn serve_tile(state: &State, query: &str, if_none_match: &str) -> Vec<u8> {
    let params = parse_query(query);
    let Some(record_id) = params
        .get("recordId")
        .or_else(|| params.get("inspectionId"))
    else {
        return error_json(400, "recordId_required");
    };
    let camera_id = params
        .get("camera")
        .or_else(|| params.get("cameraId"))
        .map(String::as_str)
        .unwrap_or("C1");
    let sequence = params
        .get("sequenceNo")
        .or_else(|| params.get("sequence"))
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let kind = params
        .get("kind")
        .map(String::as_str)
        .unwrap_or("intensity");
    let level = params
        .get("level")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0)
        .min(8);
    let x = params
        .get("x")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    let y = params
        .get("y")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    let Some(path_hash) = find_artifact(state, record_id, camera_id, sequence, kind) else {
        return error_json(404, "artifact_not_found");
    };
    let cache_key = format!("{path_hash}:{level}:{x}:{y}");
    if let Some(bytes) = state
        .cache
        .lock()
        .ok()
        .and_then(|cache| cache.get(&cache_key).cloned())
    {
        return binary_response(200, "image/jpeg", &bytes, &etag(&cache_key), if_none_match);
    }
    let path = state.result_root.join("blobs").join(&path_hash);
    let Ok(reader) = ImageReader::open(&path) else {
        return error_json(422, "image_decode_failed");
    };
    let Ok(reader) = reader.with_guessed_format() else {
        return error_json(422, "image_decode_failed");
    };
    let Ok(image) = reader.decode() else {
        return error_json(422, "image_decode_failed");
    };
    let resized = resize_for_level(image, level);
    let left = x.saturating_mul(TILE_SIZE);
    let top = y.saturating_mul(TILE_SIZE);
    if left >= resized.width() || top >= resized.height() {
        return error_json(404, "tile_not_found");
    }
    let tile = resized.crop_imm(
        left,
        top,
        TILE_SIZE.min(resized.width() - left),
        TILE_SIZE.min(resized.height() - top),
    );
    let bytes = encode_jpeg(tile).unwrap_or_default();
    if bytes.is_empty() {
        return error_json(422, "tile_encode_failed");
    }
    let bytes = Arc::new(bytes);
    if let Ok(mut cache) = state.cache.lock() {
        if cache.len() >= 256 {
            if let Some(key) = cache.keys().next().cloned() {
                cache.remove(&key);
            }
        }
        cache.insert(cache_key.clone(), Arc::clone(&bytes));
    }
    binary_response(200, "image/jpeg", &bytes, &etag(&cache_key), if_none_match)
}

fn serve_preview(state: &State, query: &str, if_none_match: &str) -> Vec<u8> {
    let mut params = parse_query(query);
    params.entry("level".into()).or_insert_with(|| "3".into());
    params.entry("x".into()).or_insert_with(|| "0".into());
    params.entry("y".into()).or_insert_with(|| "0".into());
    serve_tile(
        state,
        &params
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&"),
        if_none_match,
    )
}

fn find_artifact(
    state: &State,
    record_id: &str,
    camera_id: &str,
    sequence: i64,
    kind: &str,
) -> Option<String> {
    let connection = Connection::open_with_flags(
        &state.catalog,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let path: String = connection.query_row("SELECT path FROM capture_file WHERE inspection_id = ?1 AND camera_id = ?2 AND sequence_no = ?3 AND kind = ?4", rusqlite::params![record_id, camera_id, sequence, kind], |row| row.get(0)).ok()?;
    let path = path.strip_prefix("blobs/")?.to_string();
    if path.len() != 64 || !path.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(path)
}

fn resize_for_level(image: DynamicImage, level: u32) -> DynamicImage {
    if level == 0 {
        return image;
    }
    let divisor = 1u32 << level;
    let width = (image.width() / divisor).max(1);
    let height = (image.height() / divisor).max(1);
    image.resize(width, height, FilterType::Triangle)
}
fn encode_jpeg(image: DynamicImage) -> Result<Vec<u8>, image::ImageError> {
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, ImageFormat::Jpeg)?;
    Ok(bytes.into_inner())
}
fn split_target(target: &str) -> (&str, &str) {
    target.split_once('?').unwrap_or((target, ""))
}
fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|part| part.split_once('='))
        .map(|(key, value)| (key.to_string(), value.replace("%20", " ")))
        .collect()
}
fn etag(key: &str) -> String {
    format!("\"{:x}\"", Sha256::digest(key.as_bytes()))
}
fn ok_json(body: &str) -> Vec<u8> {
    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
}
fn error_json(code: u16, error: &str) -> Vec<u8> {
    let body = serde_json::json!({"error":error}).to_string();
    let reason = if code == 404 {
        "Not Found"
    } else {
        "Bad Request"
    };
    format!("HTTP/1.1 {code} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
}
fn binary_response(
    code: u16,
    content_type: &str,
    bytes: &[u8],
    tag: &str,
    if_none_match: &str,
) -> Vec<u8> {
    if if_none_match == tag {
        return format!("HTTP/1.1 304 Not Modified\r\nETag: {tag}\r\nCache-Control: public, max-age=31536000, immutable\r\nConnection: close\r\n\r\n").into_bytes();
    }
    let reason = if code == 200 { "OK" } else { "Error" };
    let mut response = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nETag: {tag}\r\nCache-Control: public, max-age=31536000, immutable\r\nConnection: close\r\n\r\n", bytes.len()).into_bytes();
    response.extend_from_slice(bytes);
    response
}
