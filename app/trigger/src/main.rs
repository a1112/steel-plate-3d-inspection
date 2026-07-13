use serde_json::{json, Value};
use std::env;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
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

#[derive(Debug)]
struct GatewayState {
    mode: String,
}

fn normalize_gateway_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "manual" | "手动" => "manual".to_string(),
        "gray" | "grey" | "grayscale" | "灰度" => "gray".to_string(),
        "secondary" | "level2" | "l2" | "二级" => "secondary".to_string(),
        "api" | "direct" | "" => "api".to_string(),
        _ => "api".to_string(),
    }
}

fn gateway_mode_from_env() -> String {
    normalize_gateway_mode(
        &env::var("TRIGGER_MODE").unwrap_or_else(|_| "api".to_string()),
    )
}

fn current_mode(state: &Arc<Mutex<GatewayState>>) -> String {
    state
        .lock()
        .map(|state| state.mode.clone())
        .unwrap_or_else(|_| "api".to_string())
}

fn set_current_mode(state: &Arc<Mutex<GatewayState>>, mode: &str) -> String {
    let normalized = normalize_gateway_mode(mode);
    if let Ok(mut state) = state.lock() {
        state.mode = normalized.clone();
    }
    normalized
}

fn mode_label(mode: &str) -> &'static str {
    match mode {
        "manual" => "手动",
        "gray" => "灰度",
        "secondary" => "二级",
        _ => "API",
    }
}

fn mode_json(mode: &str) -> Value {
    json!({
        "code": 0,
        "mode": mode,
        "modeLabel": mode_label(mode),
        "manualAllowed": mode == "manual",
        "allowedModes": ["api", "gray", "secondary", "manual"]
    })
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
        "/api/trigger/steel-info" | "/api/l2/steel-info" => {
            Some("/api/production/tasks/steel-info")
        }
        "/api/trigger/steel-in" | "/api/plc/steel-in" => {
            Some("/api/production/tasks/steel-in")
        }
        "/api/trigger/steel-out" | "/api/plc/steel-out" => {
            Some("/api/production/tasks/steel-out")
        }
        "/api/trigger/secondary-data" | "/api/l2/secondary-data" => {
            Some("/api/production/secondary-data")
        }
        "/api/trigger/capture-summary" => Some("/api/production/capture-summary"),
        "/api/trigger/capture-once" => Some("/api/production/capture-once"),
        "/api/trigger/defect" => Some("/api/production/defect"),
        "/api/trigger/event" | "/api/plc/event" => {
            Some("/api/production/tasks/trigger-event")
        }
        _ => None,
    }
}

fn manual_service_path_for(path: &str) -> Option<&'static str> {
    match path {
        "/api/trigger/manual/steel-info" | "/api/manual/steel-info" => {
            Some("/api/production/tasks/steel-info")
        }
        "/api/trigger/manual/steel-in" | "/api/manual/steel-in" => {
            Some("/api/production/tasks/steel-in")
        }
        "/api/trigger/manual/steel-out" | "/api/manual/steel-out" => {
            Some("/api/production/tasks/steel-out")
        }
        _ => None,
    }
}

fn manual_mode_required_response(mode: &str) -> Vec<u8> {
    http_response(
        "409 Conflict",
        "application/json; charset=utf-8",
        &json!({
            "code": 409,
            "error": "manual_mode_required",
            "mode": mode,
            "manualAllowed": false,
            "message": "manual steel-in/out controls are only available when trigger mode is manual"
        })
        .to_string(),
    )
}

fn enrich_payload(body: &str, source: &str, mode: &str) -> String {
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
        .or_insert_with(|| Value::String(mode.to_string()));
    payload.to_string()
}

fn manual_page_html() -> &'static str {
    r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>进出钢触发手动模式</title>
  <style>
    :root { color-scheme: dark; font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif; }
    body { margin: 0; background: #11181c; color: #edf4f6; }
    main { max-width: 980px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 18px; font-size: 24px; }
    section { border: 1px solid #2a3c44; border-radius: 8px; padding: 16px; margin: 14px 0; background: #0b1114; }
    label { display: grid; gap: 6px; margin: 10px 0; color: #cfe3e7; }
    input, select, textarea { background: #071013; color: #edf4f6; border: 1px solid #2a3c44; border-radius: 5px; padding: 9px; }
    button { background: #155b68; color: #effcff; border: 1px solid #2e8798; border-radius: 5px; padding: 9px 14px; font-weight: 700; margin: 6px 8px 6px 0; cursor: pointer; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .danger { background: #7a2f22; border-color: #c65c43; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .mode { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; }
    .pill { display: inline-flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 999px; background: #162229; border: 1px solid #2a3c44; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #d6a238; }
    .dot.ok { background: #34d399; }
    pre { min-height: 160px; white-space: pre-wrap; background: #071013; border: 1px solid #2a3c44; border-radius: 6px; padding: 12px; }
    @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <h1>进出钢触发手动模式</h1>
  <section>
    <div class="mode">
      <span class="pill"><span id="dot" class="dot"></span><span id="modeText">读取中</span></span>
      <label>进出钢模式
        <select id="mode">
          <option value="api">API</option>
          <option value="gray">灰度</option>
          <option value="secondary">二级</option>
          <option value="manual">手动</option>
        </select>
      </label>
      <button onclick="setMode()">切换模式</button>
      <button onclick="refresh()">刷新</button>
    </div>
  </section>
  <section>
    <div class="grid">
      <label>钢管号<input id="steelId" value="MANUAL-TEST"></label>
      <label>钢种<input id="steelType" value=""></label>
      <label>长度 mm<input id="lengthMm" type="number" value="0"></label>
      <label>宽度 mm<input id="widthMm" type="number" value="0"></label>
      <label>厚度 mm<input id="thicknessMm" type="number" value="0"></label>
      <label>来源<input id="source" value="manual"></label>
    </div>
    <button class="manual" onclick="sendInfo()">写入钢管信息</button>
    <button class="manual" onclick="steelIn()">手动进钢</button>
    <button class="manual danger" onclick="steelOut()">手动出钢</button>
  </section>
  <section>
    <pre id="out">等待操作</pre>
  </section>
</main>
<script>
let manualAllowed = false;
function payload() {
  return {
    steelId: document.getElementById('steelId').value,
    steelType: document.getElementById('steelType').value,
    lengthMm: Number(document.getElementById('lengthMm').value || 0),
    widthMm: Number(document.getElementById('widthMm').value || 0),
    thicknessMm: Number(document.getElementById('thicknessMm').value || 0),
    source: document.getElementById('source').value || 'manual'
  };
}
function render(json) {
  document.getElementById('out').textContent = JSON.stringify(json, null, 2);
}
function updateMode(json) {
  const mode = json.mode || 'api';
  manualAllowed = !!json.manualAllowed;
  document.getElementById('mode').value = mode;
  document.getElementById('modeText').textContent = `当前模式：${json.modeLabel || mode}`;
  document.getElementById('dot').className = manualAllowed ? 'dot ok' : 'dot';
  document.querySelectorAll('.manual').forEach(button => button.disabled = !manualAllowed);
}
async function refresh() {
  const res = await fetch('/api/trigger/status');
  const json = await res.json();
  updateMode(json);
  render(json);
}
async function setMode() {
  const mode = document.getElementById('mode').value;
  const res = await fetch('/api/trigger/mode', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({mode}) });
  const json = await res.json();
  updateMode(json);
  render(json);
}
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
  const json = await res.json();
  render(json);
  await refresh();
}
function sendInfo() { post('/api/trigger/manual/steel-info', payload()); }
function steelIn() { const body = payload(); body.present = true; body.value = 1; post('/api/trigger/manual/steel-in', body); }
function steelOut() { const body = payload(); body.present = false; body.value = 0; post('/api/trigger/manual/steel-out', body); }
refresh();
</script>
</body>
</html>"#
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

fn handle_client(mut stream: TcpStream, origin: &str, state: Arc<Mutex<GatewayState>>) {
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

    let mode = current_mode(&state);
    let response = match (method, path) {
        ("OPTIONS", _) => http_response("204 No Content", "application/json; charset=utf-8", ""),
        ("GET", "/") | ("GET", "/manual") => {
            http_response("200 OK", "text/html; charset=utf-8", manual_page_html())
        }
        ("GET", "/api/trigger/mode") => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &mode_json(&mode).to_string(),
        ),
        ("POST", "/api/trigger/mode") => {
            let requested = serde_json::from_str::<Value>(body)
                .ok()
                .and_then(|value| value.get("mode").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_else(|| "api".to_string());
            let mode = set_current_mode(&state, &requested);
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &mode_json(&mode).to_string(),
            )
        }
        ("GET", "/health") | ("GET", "/api/trigger/status") => {
            let service = get_json(origin, "/api/production/status")
                .unwrap_or_else(|| json!({ "code": 503, "error": "inspection_service_offline" }));
            let mut status = mode_json(&mode);
            if let Some(object) = status.as_object_mut() {
                object.insert(
                    "service".to_string(),
                    Value::String("steel-trigger-gateway".to_string()),
                );
                object.insert(
                    "inspectionServiceOrigin".to_string(),
                    Value::String(origin.to_string()),
                );
                object.insert("production".to_string(), service);
            }
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &status.to_string(),
            )
        }
        ("POST", _) => {
            if let Some(target) = manual_service_path_for(path) {
                if mode != "manual" {
                    manual_mode_required_response(&mode)
                } else {
                    let payload = enrich_payload(body, "manual", &mode);
                    let service = post_json(origin, target, &payload).unwrap_or_else(|| {
                        json!({ "code": 503, "error": "inspection_service_offline" })
                    });
                    http_response(
                        "200 OK",
                        "application/json; charset=utf-8",
                        &json!({
                            "code": service.get("code").and_then(Value::as_i64).unwrap_or(503),
                            "gateway": "steel-trigger-gateway",
                            "mode": mode,
                            "target": target,
                            "service": service
                        })
                        .to_string(),
                    )
                }
            } else if let Some(target) = service_path_for(path) {
                let payload = enrich_payload(body, gateway_source(path), &mode);
                let service = post_json(origin, target, &payload)
                    .unwrap_or_else(|| json!({ "code": 503, "error": "inspection_service_offline" }));
                http_response(
                    "200 OK",
                    "application/json; charset=utf-8",
                    &json!({
                        "code": service.get("code").and_then(Value::as_i64).unwrap_or(503),
                        "gateway": "steel-trigger-gateway",
                        "mode": mode,
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
    let state = Arc::new(Mutex::new(GatewayState {
        mode: gateway_mode_from_env(),
    }));
    let listener = TcpListener::bind((host.as_str(), port))?;
    println!("steel trigger gateway listening on http://{host}:{port}");
    println!("inspection service origin {origin}");
    println!("trigger mode {}", current_mode(&state));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => handle_client(stream, &origin, state.clone()),
            Err(error) => eprintln!("failed to accept trigger request: {error}"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response_body(response: &[u8]) -> Value {
        let text = String::from_utf8(response.to_vec()).expect("response is utf-8");
        let (_, body) = text
            .split_once("\r\n\r\n")
            .expect("response contains header separator");
        serde_json::from_str(body).expect("response body is json")
    }

    #[test]
    fn normalizes_gateway_modes_from_external_labels() {
        assert_eq!(normalize_gateway_mode("manual"), "manual");
        assert_eq!(normalize_gateway_mode("grey"), "gray");
        assert_eq!(normalize_gateway_mode("level2"), "secondary");
        assert_eq!(normalize_gateway_mode("direct"), "api");
        assert_eq!(normalize_gateway_mode("unknown"), "api");
    }

    #[test]
    fn status_json_only_allows_manual_controls_in_manual_mode() {
        let manual = mode_json("manual");
        let api = mode_json("api");
        let gray = mode_json("gray");
        let secondary = mode_json("secondary");

        assert_eq!(manual["manualAllowed"], true);
        assert_eq!(api["manualAllowed"], false);
        assert_eq!(gray["manualAllowed"], false);
        assert_eq!(secondary["manualAllowed"], false);
        assert_eq!(manual["allowedModes"].as_array().map(Vec::len), Some(4));
    }

    #[test]
    fn routes_trigger_and_manual_paths_to_production_api() {
        assert_eq!(
            service_path_for("/api/trigger/steel-info"),
            Some("/api/production/tasks/steel-info")
        );
        assert_eq!(
            service_path_for("/api/plc/steel-in"),
            Some("/api/production/tasks/steel-in")
        );
        assert_eq!(
            service_path_for("/api/l2/secondary-data"),
            Some("/api/production/secondary-data")
        );
        assert_eq!(
            manual_service_path_for("/api/trigger/manual/steel-out"),
            Some("/api/production/tasks/steel-out")
        );
        assert_eq!(manual_service_path_for("/api/trigger/steel-out"), None);
    }

    #[test]
    fn enrich_payload_adds_gateway_metadata_without_overwriting_existing_fields() {
        let enriched = enrich_payload(
            r#"{"materialId":"COIL-001","source":"plc-a","mode":"secondary"}"#,
            "manual",
            "manual",
        );
        let payload: Value = serde_json::from_str(&enriched).expect("enriched json");

        assert_eq!(payload["materialId"], "COIL-001");
        assert_eq!(payload["source"], "plc-a");
        assert_eq!(payload["mode"], "secondary");
    }

    #[test]
    fn enrich_payload_wraps_scalar_payloads_for_forwarding() {
        let enriched = enrich_payload("42", "manual", "manual");
        let payload: Value = serde_json::from_str(&enriched).expect("enriched json");

        assert_eq!(payload["raw"], 42);
        assert_eq!(payload["source"], "manual");
        assert_eq!(payload["mode"], "manual");
    }

    #[test]
    fn manual_mode_required_response_is_a_conflict_with_machine_readable_body() {
        for mode in ["api", "gray", "secondary"] {
            let response = manual_mode_required_response(mode);
            let response_text = String::from_utf8(response.clone()).expect("response is utf-8");
            let body = response_body(&response);

            assert!(response_text.starts_with("HTTP/1.1 409 Conflict"));
            assert_eq!(body["code"], 409);
            assert_eq!(body["error"], "manual_mode_required");
            assert_eq!(body["mode"], mode);
            assert_eq!(body["manualAllowed"], false);
        }
    }
}
