use serde_json::{json, Value};
use std::env;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::time::Duration;

fn http_response(status: &str, content_type: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Accept, Authorization\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    )
    .into_bytes()
}

fn split_path_and_query(raw_path: &str) -> (&str, &str) {
    if let Some(index) = raw_path.find('?') {
        (&raw_path[..index], &raw_path[index + 1..])
    } else {
        (raw_path, "")
    }
}

fn request_header(request: &str, name: &str) -> Option<String> {
    request
        .lines()
        .skip(1)
        .take_while(|line| !line.trim().is_empty())
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_string())
        })
}

fn content_length_from_headers(request: &str) -> usize {
    request_header(request, "Content-Length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0)
}

fn header_end_index(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

fn read_http_request(stream: &mut TcpStream) -> Option<String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let read = stream.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        let Some(header_end) = header_end_index(&bytes) else {
            if bytes.len() > 1024 * 1024 {
                return None;
            }
            continue;
        };
        let header_text = String::from_utf8_lossy(&bytes[..header_end]);
        let total_length = header_end + content_length_from_headers(&header_text);
        if bytes.len() >= total_length {
            bytes.truncate(total_length);
            break;
        }
        if total_length > 1024 * 1024 {
            return None;
        }
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn origin_host_port(origin: &str) -> Option<(String, u16)> {
    let rest = origin.trim().strip_prefix("http://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let (host, port) = authority.rsplit_once(':')?;
    Some((host.to_string(), port.parse::<u16>().ok()?))
}

fn service_origin() -> String {
    env::var("INSPECTION_SERVICE_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:4873".to_string())
}

fn gateway_host() -> String {
    env::var("TRIGGER_GATEWAY_HOST").unwrap_or_else(|_| "127.0.0.1".to_string())
}

fn gateway_mode() -> String {
    env::var("TRIGGER_MODE")
        .unwrap_or_else(|_| "api".to_string())
        .trim()
        .to_ascii_lowercase()
}

fn gateway_source(path: &str) -> &'static str {
    if path.contains("/plc/") {
        "plc"
    } else if path.contains("/l2/") {
        "l2"
    } else {
        "trigger-gateway"
    }
}

fn service_path_for(path: &str) -> Option<&'static str> {
    match path {
        "/api/trigger/steel-info" | "/api/l2/steel-info" => Some("/api/production/steel-info"),
        "/api/trigger/steel-in" | "/api/plc/steel-in" => Some("/api/production/steel-in"),
        "/api/trigger/steel-out" | "/api/plc/steel-out" => Some("/api/production/steel-out"),
        "/api/trigger/secondary-data" | "/api/l2/secondary-data" => {
            Some("/api/production/secondary-data")
        }
        "/api/trigger/capture-summary" => Some("/api/production/capture-summary"),
        "/api/trigger/capture-once" => Some("/api/production/capture-once"),
        "/api/trigger/defect" => Some("/api/production/defect"),
        "/api/trigger/event" | "/api/plc/event" => Some("/api/production/trigger-event"),
        _ => None,
    }
}

fn enrich_payload(body: &str, source: &str) -> String {
    let mut payload = serde_json::from_str::<Value>(body.trim()).unwrap_or_else(|_| json!({}));
    if !payload.is_object() {
        payload = json!({ "raw": payload });
    }
    let object = payload.as_object_mut().expect("object payload");
    object
        .entry("source".to_string())
        .or_insert_with(|| Value::String(source.to_string()));
    object
        .entry("mode".to_string())
        .or_insert_with(|| Value::String(gateway_mode()));
    payload.to_string()
}

fn post_json(origin: &str, path: &str, body: &str) -> Option<Value> {
    let (host, port) = origin_host_port(origin)?;
    let address = (host.as_str(), port)
        .to_socket_addrs()
        .ok()?
        .find(|addr| TcpStream::connect_timeout(addr, Duration::from_millis(200)).is_ok())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    let marker = b"\r\n\r\n";
    let body_start = response
        .windows(marker.len())
        .position(|window| window == marker)
        .map(|index| index + marker.len())?;
    serde_json::from_slice::<Value>(&response[body_start..]).ok()
}

fn get_json(origin: &str, path: &str) -> Option<Value> {
    let (host, port) = origin_host_port(origin)?;
    let address = (host.as_str(), port)
        .to_socket_addrs()
        .ok()?
        .find(|addr| TcpStream::connect_timeout(addr, Duration::from_millis(200)).is_ok())?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).ok()?;
    let marker = b"\r\n\r\n";
    let body_start = response
        .windows(marker.len())
        .position(|window| window == marker)
        .map(|index| index + marker.len())?;
    serde_json::from_slice::<Value>(&response[body_start..]).ok()
}

fn handle_client(mut stream: TcpStream, origin: &str) {
    let Some(request) = read_http_request(&mut stream) else {
        return;
    };
    let mut parts = request
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    let method = parts.next().unwrap_or_default();
    let raw_path = parts.next().unwrap_or_default();
    let (path, _) = split_path_and_query(raw_path);
    let body = request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body)
        .unwrap_or_default();

    let response = match (method, path) {
        ("OPTIONS", _) => http_response("204 No Content", "application/json; charset=utf-8", ""),
        ("GET", "/health") | ("GET", "/api/trigger/status") => {
            let service = get_json(origin, "/api/production/status")
                .unwrap_or_else(|| json!({ "code": 503, "error": "inspection_service_offline" }));
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &json!({
                    "code": 0,
                    "service": "steel-trigger-gateway",
                    "mode": gateway_mode(),
                    "inspectionServiceOrigin": origin,
                    "production": service
                })
                .to_string(),
            )
        }
        ("POST", _) => {
            if let Some(target) = service_path_for(path) {
                let payload = enrich_payload(body, gateway_source(path));
                let service = post_json(origin, target, &payload)
                    .unwrap_or_else(|| json!({ "code": 503, "error": "inspection_service_offline" }));
                http_response(
                    "200 OK",
                    "application/json; charset=utf-8",
                    &json!({
                        "code": service.get("code").and_then(Value::as_i64).unwrap_or(503),
                        "gateway": "steel-trigger-gateway",
                        "target": target,
                        "service": service
                    })
                    .to_string(),
                )
            } else {
                http_response(
                    "404 Not Found",
                    "application/json; charset=utf-8",
                    "{\"code\":404,\"error\":\"not_found\"}",
                )
            }
        }
        _ => http_response(
            "404 Not Found",
            "application/json; charset=utf-8",
            "{\"code\":404,\"error\":\"not_found\"}",
        ),
    };
    let _ = stream.write_all(&response);
}

fn main() -> std::io::Result<()> {
    let port = env::var("TRIGGER_GATEWAY_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(4881);
    let host = gateway_host();
    let origin = service_origin();
    let listener = TcpListener::bind((host.as_str(), port))?;
    println!("steel trigger gateway listening on http://{host}:{port}");
    println!("inspection service origin {origin}");
    println!("trigger mode {}", gateway_mode());
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => handle_client(stream, &origin),
            Err(error) => eprintln!("failed to accept trigger request: {error}"),
        }
    }
    Ok(())
}
