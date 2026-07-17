use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type HmacSha256 = Hmac<Sha256>;

const DEFAULT_AUTH_WINDOW_SECONDS: i64 = 30;
const MAX_REPLAY_ENTRIES: usize = 10_000;

fn http_response(status: &str, content_type: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
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

fn gateway_port(name: &str, default: u16) -> u16 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(default)
}

fn env_flag(name: &str) -> Option<bool> {
    env::var(name)
        .ok()
        .and_then(|value| match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16)?;
            let low = (pair[1] as char).to_digit(16)?;
            Some(((high << 4) | low) as u8)
        })
        .collect()
}

fn signature_message(timestamp: &str, nonce: &str, transport: &str, body: &str) -> String {
    format!("steel-trigger-v1\n{timestamp}\n{nonce}\n{transport}\n{body}")
}

#[derive(Debug, PartialEq, Eq)]
struct AuthError {
    code: u16,
    error: &'static str,
}

impl AuthError {
    fn response(&self) -> Value {
        json!({ "code": self.code, "error": self.error })
    }
}

fn valid_nonce(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
}

fn authenticate_message(
    state: &Arc<Mutex<GatewayState>>,
    timestamp: &str,
    nonce: &str,
    signature: &str,
    transport: &str,
    body: &str,
    now: i64,
) -> Result<(), AuthError> {
    let mut state = state.lock().map_err(|_| AuthError {
        code: 503,
        error: "security_state_unavailable",
    })?;
    if !state.security.auth_required {
        return Ok(());
    }
    let timestamp_value = timestamp.parse::<i64>().map_err(|_| AuthError {
        code: 401,
        error: "invalid_trigger_timestamp",
    })?;
    if now.abs_diff(timestamp_value) > state.security.auth_window_seconds as u64 {
        return Err(AuthError {
            code: 401,
            error: "trigger_timestamp_out_of_window",
        });
    }
    if !valid_nonce(nonce) {
        return Err(AuthError {
            code: 401,
            error: "invalid_trigger_nonce",
        });
    }
    let signature = decode_hex(signature).ok_or(AuthError {
        code: 401,
        error: "invalid_trigger_signature",
    })?;
    let mut mac =
        HmacSha256::new_from_slice(&state.security.shared_secret).map_err(|_| AuthError {
            code: 503,
            error: "trigger_auth_unavailable",
        })?;
    mac.update(signature_message(timestamp, nonce, transport, body).as_bytes());
    mac.verify_slice(&signature).map_err(|_| AuthError {
        code: 401,
        error: "invalid_trigger_signature",
    })?;
    let cutoff = now - state.security.auth_window_seconds;
    state.replay_nonces.retain(|_, seen_at| *seen_at >= cutoff);
    if state.replay_nonces.contains_key(nonce) {
        return Err(AuthError {
            code: 409,
            error: "trigger_replay_detected",
        });
    }
    if state.replay_nonces.len() >= MAX_REPLAY_ENTRIES {
        return Err(AuthError {
            code: 503,
            error: "trigger_replay_cache_full",
        });
    }
    state.replay_nonces.insert(nonce.to_string(), now);
    Ok(())
}

fn source_allowed(state: &Arc<Mutex<GatewayState>>, peer: SocketAddr) -> bool {
    state
        .lock()
        .map(|state| state.security.source_allowed(peer.ip()))
        .unwrap_or(false)
}

fn security_snapshot(state: &Arc<Mutex<GatewayState>>) -> Value {
    state
        .lock()
        .map(|state| {
            json!({
                "profile": if state.security.production { "production" } else { "development" },
                "authenticationRequired": state.security.auth_required,
                "operatorAuthenticationRequired": state.security.production,
                "sourceAllowlistConfigured": !state.security.allowed_sources.is_empty(),
                "authWindowSeconds": state.security.auth_window_seconds,
                "modeMutationAllowed": state.security.allow_mode_mutation
            })
        })
        .unwrap_or_else(|_| json!({ "error": "security_state_unavailable" }))
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum SourceRule {
    Address(IpAddr),
    Cidr(IpAddr, u8),
}

impl SourceRule {
    fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        if let Some((address, prefix)) = value.split_once('/') {
            let address = address.parse::<IpAddr>().ok()?;
            let prefix = prefix.parse::<u8>().ok()?;
            let valid = match address {
                IpAddr::V4(_) => prefix <= 32,
                IpAddr::V6(_) => prefix <= 128,
            };
            return valid.then_some(Self::Cidr(address, prefix));
        }
        value.parse::<IpAddr>().ok().map(Self::Address)
    }

    fn contains(&self, candidate: IpAddr) -> bool {
        match (self, candidate) {
            (Self::Address(expected), actual) => *expected == actual,
            (Self::Cidr(IpAddr::V4(network), prefix), IpAddr::V4(actual)) => {
                let mask = if *prefix == 0 {
                    0
                } else {
                    u32::MAX << (32 - *prefix)
                };
                (u32::from(*network) & mask) == (u32::from(actual) & mask)
            }
            (Self::Cidr(IpAddr::V6(network), prefix), IpAddr::V6(actual)) => {
                let mask = if *prefix == 0 {
                    0
                } else {
                    u128::MAX << (128 - *prefix)
                };
                (u128::from(*network) & mask) == (u128::from(actual) & mask)
            }
            _ => false,
        }
    }
}

#[derive(Clone, Debug)]
struct SecurityConfig {
    production: bool,
    auth_required: bool,
    shared_secret: Vec<u8>,
    operator_token: Vec<u8>,
    allowed_sources: Vec<SourceRule>,
    auth_window_seconds: i64,
    allow_mode_mutation: bool,
}

impl SecurityConfig {
    fn from_env(host: &str) -> Result<Self, String> {
        let profile = env::var("STEEL_RUNTIME_PROFILE")
            .unwrap_or_else(|_| "development".to_string())
            .trim()
            .to_ascii_lowercase();
        let production = profile == "production";
        let explicit_auth = env_flag("TRIGGER_AUTH_REQUIRED").unwrap_or(false);
        let auth_required = production || explicit_auth;
        let shared_secret = env::var("TRIGGER_SHARED_SECRET")
            .unwrap_or_default()
            .into_bytes();
        if auth_required && shared_secret.len() < 32 {
            return Err(
                "TRIGGER_SHARED_SECRET must contain at least 32 bytes when trigger authentication is required"
                    .to_string(),
            );
        }
        let operator_token = env::var("TRIGGER_OPERATOR_TOKEN")
            .unwrap_or_default()
            .into_bytes();
        if production && operator_token.len() < 32 {
            return Err(
                "TRIGGER_OPERATOR_TOKEN must contain at least 32 bytes in production".to_string(),
            );
        }
        let allowed_sources = env::var("TRIGGER_SOURCE_ALLOWLIST")
            .unwrap_or_default()
            .split(',')
            .filter(|value| !value.trim().is_empty())
            .map(|value| {
                SourceRule::parse(value)
                    .ok_or_else(|| format!("invalid TRIGGER_SOURCE_ALLOWLIST entry: {value}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let host_ip = host.parse::<IpAddr>().ok();
        let exposes_remote = host_ip.is_none_or(|address| !address.is_loopback());
        if production && exposes_remote && allowed_sources.is_empty() {
            return Err(
                "production trigger gateway bound beyond loopback requires TRIGGER_SOURCE_ALLOWLIST"
                    .to_string(),
            );
        }
        let auth_window_seconds = env::var("TRIGGER_AUTH_WINDOW_SECONDS")
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(DEFAULT_AUTH_WINDOW_SECONDS);
        if !(5..=300).contains(&auth_window_seconds) {
            return Err("TRIGGER_AUTH_WINDOW_SECONDS must be between 5 and 300".to_string());
        }
        let allow_mode_mutation = env_flag("TRIGGER_ALLOW_MODE_MUTATION").unwrap_or(!production);
        Ok(Self {
            production,
            auth_required,
            shared_secret,
            operator_token,
            allowed_sources,
            auth_window_seconds,
            allow_mode_mutation,
        })
    }

    fn source_allowed(&self, address: IpAddr) -> bool {
        address.is_loopback()
            || (self.allowed_sources.is_empty() && !self.production)
            || self
                .allowed_sources
                .iter()
                .any(|rule| rule.contains(address))
    }
}

fn constant_time_token_matches(expected: &[u8], supplied: &[u8]) -> bool {
    let expected_hash = Sha256::digest(expected);
    let supplied_hash = Sha256::digest(supplied);
    let mut difference = expected.len() ^ supplied.len();
    for (left, right) in expected_hash.iter().zip(supplied_hash.iter()) {
        difference |= (*left ^ *right) as usize;
    }
    difference == 0
}

fn authorize_operator_request(
    request: &str,
    peer: SocketAddr,
    state: &Arc<Mutex<GatewayState>>,
) -> Result<(), Vec<u8>> {
    if !peer.ip().is_loopback() {
        return Err(http_response(
            "403 Forbidden",
            "application/json; charset=utf-8",
            &json!({ "code": 403, "error": "local_operator_only" }).to_string(),
        ));
    }
    let state = state.lock().map_err(|_| {
        http_response(
            "503 Service Unavailable",
            "application/json; charset=utf-8",
            &json!({ "code": 503, "error": "security_state_unavailable" }).to_string(),
        )
    })?;
    if !state.security.production {
        return Ok(());
    }
    let supplied = request_header(request, "X-Trigger-Operator-Token").unwrap_or_default();
    if supplied.is_empty()
        || !constant_time_token_matches(&state.security.operator_token, supplied.as_bytes())
    {
        return Err(http_response(
            "401 Unauthorized",
            "application/json; charset=utf-8",
            &json!({ "code": 401, "error": "trigger_operator_auth_required" }).to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug)]
struct GatewayState {
    mode: String,
    accepting: bool,
    in_flight: u64,
    security: SecurityConfig,
    replay_nonces: HashMap<String, i64>,
    listeners: ListenerStatus,
}

#[derive(Debug)]
struct TriggerAdmissionGuard {
    state: Arc<Mutex<GatewayState>>,
}

impl Drop for TriggerAdmissionGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.in_flight = state.in_flight.saturating_sub(1);
        }
    }
}

fn trigger_draining_json() -> Value {
    json!({ "code": 503, "error": "trigger_draining" })
}

fn gateway_state_unavailable_json() -> Value {
    json!({ "code": 503, "error": "gateway_state_unavailable" })
}

fn admit_trigger(
    state: &Arc<Mutex<GatewayState>>,
    completion: bool,
) -> Result<TriggerAdmissionGuard, Value> {
    let mut gateway = state.lock().map_err(|_| gateway_state_unavailable_json())?;
    if !gateway.accepting && !completion {
        return Err(trigger_draining_json());
    }
    gateway.in_flight = gateway
        .in_flight
        .checked_add(1)
        .ok_or_else(gateway_state_unavailable_json)?;
    drop(gateway);
    Ok(TriggerAdmissionGuard {
        state: Arc::clone(state),
    })
}

fn completion_target(target: &str) -> bool {
    target == "/api/production/tasks/steel-out"
}

fn admission_status_json(state: &Arc<Mutex<GatewayState>>) -> Value {
    state
        .lock()
        .map(|state| {
            json!({
                "accepting": state.accepting,
                "inFlight": state.in_flight,
                "drained": !state.accepting && state.in_flight == 0
            })
        })
        .unwrap_or_else(|_| {
            json!({
                "accepting": false,
                "inFlight": Value::Null,
                "drained": false,
                "error": "gateway_state_unavailable"
            })
        })
}

fn enter_drain(state: &Arc<Mutex<GatewayState>>) -> Result<Value, Vec<u8>> {
    let mut state = state.lock().map_err(|_| {
        http_response(
            "503 Service Unavailable",
            "application/json; charset=utf-8",
            &json!({ "code": 503, "error": "gateway_state_unavailable" }).to_string(),
        )
    })?;
    state.accepting = false;
    Ok(json!({
        "code": 0,
        "accepting": false,
        "inFlight": state.in_flight,
        "drained": state.in_flight == 0
    }))
}

fn trigger_admission_http_response(error: Value) -> Vec<u8> {
    http_response(
        "503 Service Unavailable",
        "application/json; charset=utf-8",
        &error.to_string(),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ListenerStatus {
    http_enabled: bool,
    http_bound: bool,
    tcp_enabled: bool,
    tcp_bound: bool,
    udp_enabled: bool,
    udp_bound: bool,
}

impl ListenerStatus {
    fn ready(self) -> bool {
        (!self.http_enabled || self.http_bound)
            && (!self.tcp_enabled || self.tcp_bound)
            && (!self.udp_enabled || self.udp_bound)
    }

    fn to_json(self) -> Value {
        json!({
            "http": { "enabled": self.http_enabled, "bound": self.http_bound },
            "tcp": { "enabled": self.tcp_enabled, "bound": self.tcp_bound },
            "udp": { "enabled": self.udp_enabled, "bound": self.udp_bound }
        })
    }
}

fn normalize_gateway_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "manual" | "手动" => "manual".to_string(),
        "gray" | "grey" | "grayscale" | "灰度" => "gray".to_string(),
        "secondary" | "level2" | "l2" | "二级" => "secondary".to_string(),
        "tcp" => "tcp".to_string(),
        "udp" => "udp".to_string(),
        "api" | "direct" | "" => "api".to_string(),
        _ => "api".to_string(),
    }
}

fn gateway_mode_from_env() -> String {
    normalize_gateway_mode(&env::var("TRIGGER_MODE").unwrap_or_else(|_| "api".to_string()))
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
        "tcp" => "TCP",
        "udp" => "UDP",
        _ => "API",
    }
}

fn mode_json(mode: &str) -> Value {
    json!({
        "code": 0,
        "mode": mode,
        "modeLabel": mode_label(mode),
        "manualAllowed": mode == "manual",
        "allowedModes": ["api", "tcp", "udp", "gray", "secondary", "manual"]
    })
}

fn event_service_path(event: &str) -> Option<&'static str> {
    match event.trim().to_ascii_lowercase().replace('_', "-").as_str() {
        "steel-info" | "info" | "material-info" => Some("/api/production/tasks/steel-info"),
        "steel-in" | "in" | "enter" => Some("/api/production/tasks/steel-in"),
        "steel-out" | "out" | "leave" => Some("/api/production/tasks/steel-out"),
        "secondary-data" | "l2-data" => Some("/api/production/secondary-data"),
        "capture-summary" => Some("/api/production/capture-summary"),
        "capture-once" => Some("/api/production/capture-once"),
        "defect" => Some("/api/production/defect"),
        "event" | "trigger-event" => Some("/api/production/tasks/trigger-event"),
        _ => None,
    }
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
        "/api/trigger/steel-in" | "/api/plc/steel-in" => Some("/api/production/tasks/steel-in"),
        "/api/trigger/steel-out" | "/api/plc/steel-out" => Some("/api/production/tasks/steel-out"),
        "/api/trigger/secondary-data" | "/api/l2/secondary-data" => {
            Some("/api/production/secondary-data")
        }
        "/api/trigger/capture-summary" => Some("/api/production/capture-summary"),
        "/api/trigger/capture-once" => Some("/api/production/capture-once"),
        "/api/trigger/defect" => Some("/api/production/defect"),
        "/api/trigger/event" | "/api/plc/event" => Some("/api/production/tasks/trigger-event"),
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
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
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

fn authenticated_network_payload(
    body: &str,
    transport: &str,
    state: &Arc<Mutex<GatewayState>>,
    now: i64,
) -> Result<Value, Value> {
    let envelope = match serde_json::from_str::<Value>(body.trim()) {
        Ok(Value::Object(object)) => Value::Object(object),
        Ok(_) => {
            return Err(json!({
                "code": 400,
                "error": "invalid_payload",
                "message": "trigger payload must be a JSON object"
            }))
        }
        Err(error) => {
            return Err(json!({
                "code": 400,
                "error": "invalid_json",
                "message": error.to_string()
            }))
        }
    };
    let auth_required = state
        .lock()
        .map(|state| state.security.auth_required)
        .unwrap_or(true);
    let Some(payload) = envelope.get("payload") else {
        if auth_required {
            return Err(json!({ "code": 401, "error": "trigger_auth_required" }));
        }
        return Ok(envelope);
    };
    if !payload.is_object() {
        return Err(json!({ "code": 400, "error": "invalid_trigger_payload" }));
    }
    let Some(auth) = envelope.get("auth").and_then(Value::as_object) else {
        return Err(json!({ "code": 401, "error": "trigger_auth_required" }));
    };
    let timestamp = auth
        .get("timestamp")
        .map(|value| match value {
            Value::String(value) => value.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    let nonce = auth
        .get("nonce")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let signature = auth
        .get("signature")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let canonical_payload = payload.to_string();
    authenticate_message(
        state,
        &timestamp,
        nonce,
        signature,
        transport,
        &canonical_payload,
        now,
    )
    .map_err(|error| error.response())?;
    Ok(payload.clone())
}

fn network_trigger_response(
    body: &str,
    transport: &str,
    peer: SocketAddr,
    origin: &str,
    state: &Arc<Mutex<GatewayState>>,
) -> Value {
    if !source_allowed(state, peer) {
        return json!({ "code": 403, "error": "trigger_source_forbidden" });
    }
    let payload = match authenticated_network_payload(body, transport, state, unix_seconds()) {
        Ok(payload) => payload,
        Err(error) => return error,
    };
    let event = payload
        .get("event")
        .or_else(|| payload.get("type"))
        .or_else(|| payload.get("action"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(target) = event_service_path(event) else {
        return json!({
            "code": 400,
            "error": "unsupported_event",
            "event": event,
            "supportedEvents": ["steel-info", "steel-in", "steel-out", "secondary-data", "capture-once", "capture-summary", "defect", "event"]
        });
    };
    let _admission_guard = match admit_trigger(state, completion_target(target)) {
        Ok(guard) => guard,
        Err(error) => return error,
    };
    let mode = current_mode(state);
    let enriched = enrich_payload(&payload.to_string(), transport, &mode);
    let service = post_json(origin, target, &enriched)
        .unwrap_or_else(|| json!({ "code": 503, "error": "inspection_service_offline" }));
    json!({
        "code": service.get("code").and_then(Value::as_i64).unwrap_or(503),
        "gateway": "steel-trigger-gateway",
        "transport": transport,
        "mode": mode,
        "event": event,
        "target": target,
        "service": service
    })
}

fn handle_tcp_trigger(mut stream: TcpStream, origin: &str, state: Arc<Mutex<GatewayState>>) {
    let peer = match stream.peer_addr() {
        Ok(peer) => peer,
        Err(_) => return,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let reader_stream = match stream.try_clone() {
        Ok(stream) => stream,
        Err(_) => return,
    };
    let mut reader = BufReader::new(reader_stream);
    loop {
        let mut line = String::new();
        let read = match reader.read_line(&mut line) {
            Ok(read) => read,
            Err(_) => break,
        };
        if read == 0 {
            break;
        }
        let response = if line.len() > 65_536 {
            json!({ "code": 413, "error": "payload_too_large" })
        } else if line.trim().is_empty() {
            continue;
        } else {
            network_trigger_response(&line, "tcp", peer, origin, &state)
        };
        let mut encoded = response.to_string();
        encoded.push('\n');
        if stream.write_all(encoded.as_bytes()).is_err() {
            break;
        }
    }
}

fn bind_tcp_trigger_listener(host: &str, port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind((host, port)).map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!("failed to bind TCP trigger listener {host}:{port}: {error}"),
        )
    })
}

fn run_tcp_trigger_listener(
    listener: TcpListener,
    host: String,
    port: u16,
    origin: String,
    state: Arc<Mutex<GatewayState>>,
) -> std::io::Result<()> {
    println!("TCP trigger listener tcp://{host}:{port} (newline-delimited JSON)");
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let origin = origin.clone();
                let state = state.clone();
                thread::spawn(move || handle_tcp_trigger(stream, &origin, state));
            }
            Err(error) => eprintln!("failed to accept TCP trigger: {error}"),
        }
    }
    Ok(())
}

fn bind_udp_trigger_listener(host: &str, port: u16) -> std::io::Result<UdpSocket> {
    UdpSocket::bind((host, port)).map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!("failed to bind UDP trigger listener {host}:{port}: {error}"),
        )
    })
}

fn run_udp_trigger_listener(
    socket: UdpSocket,
    host: String,
    port: u16,
    origin: String,
    state: Arc<Mutex<GatewayState>>,
) -> std::io::Result<()> {
    println!("UDP trigger listener udp://{host}:{port} (one JSON object per datagram)");
    let mut buffer = [0_u8; 65_507];
    loop {
        match socket.recv_from(&mut buffer) {
            Ok((size, peer)) => {
                let response = match std::str::from_utf8(&buffer[..size]) {
                    Ok(body) => network_trigger_response(body, "udp", peer, &origin, &state),
                    Err(error) => json!({
                        "code": 400,
                        "error": "invalid_utf8",
                        "message": error.to_string()
                    }),
                };
                let _ = socket.send_to(response.to_string().as_bytes(), peer);
            }
            Err(error) => eprintln!("failed to receive UDP trigger: {error}"),
        }
    }
}

fn http_auth_error(error: AuthError) -> Vec<u8> {
    let status = match error.code {
        409 => "409 Conflict",
        503 => "503 Service Unavailable",
        _ => "401 Unauthorized",
    };
    http_response(
        status,
        "application/json; charset=utf-8",
        &error.response().to_string(),
    )
}

fn authorize_http_trigger(
    request: &str,
    body: &str,
    peer: SocketAddr,
    state: &Arc<Mutex<GatewayState>>,
) -> Result<(), Vec<u8>> {
    if !source_allowed(state, peer) {
        return Err(http_response(
            "403 Forbidden",
            "application/json; charset=utf-8",
            &json!({ "code": 403, "error": "trigger_source_forbidden" }).to_string(),
        ));
    }
    if request_header(request, "X-Trigger-Operator-Token").is_some() {
        return authorize_operator_request(request, peer, state);
    }
    let timestamp = request_header(request, "X-Trigger-Timestamp").unwrap_or_default();
    let nonce = request_header(request, "X-Trigger-Nonce").unwrap_or_default();
    let signature = request_header(request, "X-Trigger-Signature").unwrap_or_default();
    let auth_required = state
        .lock()
        .map(|state| state.security.auth_required)
        .unwrap_or(true);
    if auth_required && (timestamp.is_empty() || nonce.is_empty() || signature.is_empty()) {
        return Err(http_auth_error(AuthError {
            code: 401,
            error: "trigger_auth_required",
        }));
    }
    authenticate_message(
        state,
        &timestamp,
        &nonce,
        &signature,
        "http",
        body,
        unix_seconds(),
    )
    .map_err(http_auth_error)
}

fn handle_client(mut stream: TcpStream, origin: &str, state: Arc<Mutex<GatewayState>>) {
    let peer = match stream.peer_addr() {
        Ok(peer) => peer,
        Err(_) => return,
    };
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
            let production = state
                .lock()
                .map(|state| state.security.production)
                .unwrap_or(true);
            if peer.ip().is_loopback() && !production {
                http_response("200 OK", "text/html; charset=utf-8", manual_page_html())
            } else {
                http_response(
                    "403 Forbidden",
                    "application/json; charset=utf-8",
                    &json!({ "code": 403, "error": "local_operator_only" }).to_string(),
                )
            }
        }
        ("GET", "/api/trigger/mode") => http_response(
            "200 OK",
            "application/json; charset=utf-8",
            &mode_json(&mode).to_string(),
        ),
        ("POST", "/api/trigger/mode") => {
            let mutation_allowed = state
                .lock()
                .map(|state| state.security.allow_mode_mutation)
                .unwrap_or(false);
            if !mutation_allowed {
                http_response(
                    "423 Locked",
                    "application/json; charset=utf-8",
                    &json!({ "code": 423, "error": "trigger_mode_locked" }).to_string(),
                )
            } else if let Err(response) = authorize_operator_request(&request, peer, &state) {
                response
            } else {
                let requested = serde_json::from_str::<Value>(body)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("mode")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| "api".to_string());
                let mode = set_current_mode(&state, &requested);
                http_response(
                    "200 OK",
                    "application/json; charset=utf-8",
                    &mode_json(&mode).to_string(),
                )
            }
        }
        ("POST", "/api/trigger/drain") => {
            if let Err(response) = authorize_operator_request(&request, peer, &state) {
                response
            } else {
                match enter_drain(&state) {
                    Ok(status) => http_response(
                        "200 OK",
                        "application/json; charset=utf-8",
                        &status.to_string(),
                    ),
                    Err(response) => response,
                }
            }
        }
        ("GET", "/health") | ("GET", "/api/trigger/status") => {
            let service = get_json(origin, "/api/production/status")
                .unwrap_or_else(|| json!({ "code": 503, "error": "inspection_service_offline" }));
            let mut status = mode_json(&mode);
            if let Some(object) = status.as_object_mut() {
                let listener_status =
                    state
                        .lock()
                        .map(|state| state.listeners)
                        .unwrap_or(ListenerStatus {
                            http_enabled: true,
                            http_bound: false,
                            tcp_enabled: true,
                            tcp_bound: false,
                            udp_enabled: true,
                            udp_bound: false,
                        });
                object.insert(
                    "service".to_string(),
                    Value::String("steel-trigger-gateway".to_string()),
                );
                object.insert(
                    "gatewayReady".to_string(),
                    Value::Bool(listener_status.ready()),
                );
                object.insert("listeners".to_string(), listener_status.to_json());
                object.insert("security".to_string(), security_snapshot(&state));
                let admission = admission_status_json(&state);
                object.insert(
                    "accepting".to_string(),
                    admission
                        .get("accepting")
                        .cloned()
                        .unwrap_or(Value::Bool(false)),
                );
                object.insert(
                    "inFlight".to_string(),
                    admission.get("inFlight").cloned().unwrap_or(Value::Null),
                );
                object.insert("drained".to_string(), admission["drained"].clone());
                object.insert(
                    "inspectionServiceHealthy".to_string(),
                    Value::Bool(service.get("code").and_then(Value::as_i64) == Some(0)),
                );
            }
            http_response(
                "200 OK",
                "application/json; charset=utf-8",
                &status.to_string(),
            )
        }
        ("POST", _) => {
            if let Some(target) = manual_service_path_for(path) {
                if let Err(response) = authorize_operator_request(&request, peer, &state) {
                    response
                } else if mode != "manual" {
                    manual_mode_required_response(&mode)
                } else {
                    match admit_trigger(&state, completion_target(target)) {
                        Err(error) => trigger_admission_http_response(error),
                        Ok(_admission_guard) => {
                            let payload = enrich_payload(body, "manual", &mode);
                            let service = post_json(origin, target, &payload).unwrap_or_else(
                                || json!({ "code": 503, "error": "inspection_service_offline" }),
                            );
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
                    }
                }
            } else if let Some(target) = service_path_for(path) {
                match authorize_http_trigger(&request, body, peer, &state) {
                    Err(response) => response,
                    Ok(()) => match admit_trigger(&state, completion_target(target)) {
                        Err(error) => trigger_admission_http_response(error),
                        Ok(_admission_guard) => {
                            let payload = enrich_payload(body, gateway_source(path), &mode);
                            let service = post_json(origin, target, &payload).unwrap_or_else(
                                || json!({ "code": 503, "error": "inspection_service_offline" }),
                            );
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
                    },
                }
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
    let port = gateway_port("TRIGGER_GATEWAY_PORT", 4881);
    let tcp_port = gateway_port("TRIGGER_TCP_PORT", 4882);
    let udp_port = gateway_port("TRIGGER_UDP_PORT", 4883);
    let host = gateway_host();
    let origin = service_origin();
    let security = SecurityConfig::from_env(&host)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    // Bind every configured transport before exposing the HTTP readiness endpoint.  A
    // TCP/UDP collision must fail the process synchronously instead of being hidden in
    // a detached listener thread while SCM reports the gateway as running.
    let tcp_listener = if tcp_port == 0 {
        None
    } else {
        Some(bind_tcp_trigger_listener(&host, tcp_port)?)
    };
    let udp_socket = if udp_port == 0 {
        None
    } else {
        Some(bind_udp_trigger_listener(&host, udp_port)?)
    };
    let listener = TcpListener::bind((host.as_str(), port)).map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!("failed to bind HTTP trigger listener {host}:{port}: {error}"),
        )
    })?;
    let listeners = ListenerStatus {
        http_enabled: port != 0,
        http_bound: true,
        tcp_enabled: tcp_port != 0,
        tcp_bound: tcp_listener.is_some(),
        udp_enabled: udp_port != 0,
        udp_bound: udp_socket.is_some(),
    };
    let state = Arc::new(Mutex::new(GatewayState {
        mode: gateway_mode_from_env(),
        accepting: true,
        in_flight: 0,
        security,
        replay_nonces: HashMap::new(),
        listeners,
    }));
    if let Some(tcp_listener) = tcp_listener {
        let tcp_host = host.clone();
        let tcp_origin = origin.clone();
        let tcp_state = state.clone();
        thread::spawn(move || {
            if let Err(error) =
                run_tcp_trigger_listener(tcp_listener, tcp_host, tcp_port, tcp_origin, tcp_state)
            {
                eprintln!("TCP trigger listener stopped: {error}");
            }
        });
    }
    if let Some(udp_socket) = udp_socket {
        let udp_host = host.clone();
        let udp_origin = origin.clone();
        let udp_state = state.clone();
        thread::spawn(move || {
            if let Err(error) =
                run_udp_trigger_listener(udp_socket, udp_host, udp_port, udp_origin, udp_state)
            {
                eprintln!("UDP trigger listener stopped: {error}");
            }
        });
    }
    println!("steel trigger gateway listening on http://{host}:{port}");
    println!("inspection service origin {origin}");
    println!("trigger mode {}", current_mode(&state));
    let security = security_snapshot(&state);
    println!(
        "trigger security authenticationRequired={} sourceAllowlistConfigured={} modeMutationAllowed={}",
        security["authenticationRequired"],
        security["sourceAllowlistConfigured"],
        security["modeMutationAllowed"]
    );
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
    use std::sync::{mpsc, Barrier, Condvar};

    fn sign_message(
        secret: &[u8],
        timestamp: &str,
        nonce: &str,
        transport: &str,
        body: &str,
    ) -> String {
        let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
        mac.update(signature_message(timestamp, nonce, transport, body).as_bytes());
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn secured_state() -> Arc<Mutex<GatewayState>> {
        Arc::new(Mutex::new(GatewayState {
            mode: "api".to_string(),
            accepting: true,
            in_flight: 0,
            security: SecurityConfig {
                production: true,
                auth_required: true,
                shared_secret: b"0123456789abcdef0123456789abcdef".to_vec(),
                operator_token: b"operator-0123456789abcdef-ABCDEF!".to_vec(),
                allowed_sources: vec![SourceRule::parse("10.20.0.0/16").unwrap()],
                auth_window_seconds: 30,
                allow_mode_mutation: false,
            },
            replay_nonces: HashMap::new(),
            listeners: ListenerStatus {
                http_enabled: true,
                http_bound: true,
                tcp_enabled: true,
                tcp_bound: true,
                udp_enabled: true,
                udp_bound: true,
            },
        }))
    }

    fn response_body(response: &[u8]) -> Value {
        let text = String::from_utf8(response.to_vec()).expect("response is utf-8");
        let (_, body) = text
            .split_once("\r\n\r\n")
            .expect("response contains header separator");
        serde_json::from_str(body).expect("response body is json")
    }

    fn invoke_http(state: Arc<Mutex<GatewayState>>, request: &str) -> Vec<u8> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test HTTP listener");
        let address = listener.local_addr().expect("test HTTP address");
        let request = request.to_string();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).expect("connect test HTTP client");
            stream
                .write_all(request.as_bytes())
                .expect("write test HTTP request");
            stream
                .shutdown(std::net::Shutdown::Write)
                .expect("finish test HTTP request");
            let mut response = Vec::new();
            stream
                .read_to_end(&mut response)
                .expect("read test HTTP response");
            response
        });
        let (stream, _) = listener.accept().expect("accept test HTTP client");
        handle_client(stream, "http://127.0.0.1:9", state);
        client.join().expect("test HTTP client joins")
    }

    #[test]
    fn normalizes_gateway_modes_from_external_labels() {
        assert_eq!(normalize_gateway_mode("manual"), "manual");
        assert_eq!(normalize_gateway_mode("grey"), "gray");
        assert_eq!(normalize_gateway_mode("level2"), "secondary");
        assert_eq!(normalize_gateway_mode("direct"), "api");
        assert_eq!(normalize_gateway_mode("tcp"), "tcp");
        assert_eq!(normalize_gateway_mode("UDP"), "udp");
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
        assert_eq!(manual["allowedModes"].as_array().map(Vec::len), Some(6));
    }

    #[test]
    fn drain_is_idempotent_and_fails_trigger_admission_closed() {
        let state = secured_state();

        let guard = admit_trigger(&state, false).expect("work admitted before drain");
        assert_eq!(admission_status_json(&state)["inFlight"], 1);
        let first_drain = enter_drain(&state).unwrap();
        assert_eq!(first_drain["accepting"], false);
        assert_eq!(first_drain["inFlight"], 1);
        assert_eq!(first_drain["drained"], false);
        assert_eq!(enter_drain(&state).unwrap()["inFlight"], 1);
        assert_eq!(
            admit_trigger(&state, false).unwrap_err()["error"],
            "trigger_draining"
        );
        drop(guard);
        assert_eq!(admission_status_json(&state)["inFlight"], 0);
        assert_eq!(admission_status_json(&state)["drained"], true);

        let http = trigger_admission_http_response(trigger_draining_json());
        let http_text = String::from_utf8(http.clone()).expect("response is utf-8");
        assert!(http_text.starts_with("HTTP/1.1 503 Service Unavailable"));
        assert_eq!(response_body(&http)["error"], "trigger_draining");
    }

    #[test]
    fn concurrent_drain_and_admission_have_no_check_increment_window() {
        const WORKERS: usize = 32;
        let state = secured_state();
        let start = Arc::new(Barrier::new(WORKERS + 2));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let (result_tx, result_rx) = mpsc::channel();
        let mut workers = Vec::new();

        for _ in 0..WORKERS {
            let state = Arc::clone(&state);
            let start = Arc::clone(&start);
            let release = Arc::clone(&release);
            let result_tx = result_tx.clone();
            workers.push(thread::spawn(move || {
                start.wait();
                let admission = admit_trigger(&state, false);
                result_tx
                    .send(admission.is_ok())
                    .expect("report admission result");
                if let Ok(_guard) = admission {
                    let (lock, changed) = &*release;
                    let released = lock.lock().expect("lock release gate");
                    let _released = changed
                        .wait_while(released, |released| !*released)
                        .expect("wait for guard release");
                }
            }));
        }

        let drain_state = Arc::clone(&state);
        let drain_start = Arc::clone(&start);
        let drain = thread::spawn(move || {
            drain_start.wait();
            enter_drain(&drain_state).expect("enter concurrent drain")
        });
        start.wait();

        let drain_status = drain.join().expect("drain thread joins");
        let admitted = (0..WORKERS)
            .map(|_| {
                result_rx
                    .recv_timeout(Duration::from_secs(2))
                    .expect("receive admission result")
            })
            .filter(|admitted| *admitted)
            .count() as u64;
        assert_eq!(drain_status["inFlight"].as_u64(), Some(admitted));
        assert_eq!(
            admit_trigger(&state, false).unwrap_err()["error"],
            "trigger_draining"
        );
        let completion =
            admit_trigger(&state, true).expect("steel-out completion remains admitted");
        assert_eq!(
            admission_status_json(&state)["inFlight"].as_u64(),
            Some(admitted + 1)
        );
        assert_eq!(admission_status_json(&state)["drained"], false);
        drop(completion);
        assert_eq!(
            admission_status_json(&state)["inFlight"].as_u64(),
            Some(admitted)
        );

        let (lock, changed) = &*release;
        *lock.lock().expect("lock release gate") = true;
        changed.notify_all();
        for worker in workers {
            worker.join().expect("admission worker joins");
        }
        let final_status = admission_status_json(&state);
        assert_eq!(final_status["inFlight"], 0);
        assert_eq!(final_status["drained"], true);
    }

    #[test]
    fn operator_can_drain_http_gateway_while_status_remains_available() {
        let state = secured_state();
        state.lock().expect("set manual mode").mode = "manual".to_string();
        let drain = invoke_http(
            state.clone(),
            concat!(
                "POST /api/trigger/drain HTTP/1.1\r\n",
                "Host: localhost\r\n",
                "X-Trigger-Operator-Token: operator-0123456789abcdef-ABCDEF!\r\n",
                "Content-Length: 0\r\n\r\n"
            ),
        );
        assert!(String::from_utf8_lossy(&drain).starts_with("HTTP/1.1 200 OK"));
        assert_eq!(response_body(&drain)["accepting"], false);

        let status = invoke_http(
            state.clone(),
            "GET /api/trigger/status HTTP/1.1\r\nHost: localhost\r\n\r\n",
        );
        assert!(String::from_utf8_lossy(&status).starts_with("HTTP/1.1 200 OK"));
        assert_eq!(response_body(&status)["accepting"], false);

        assert_eq!(response_body(&status)["inFlight"], 0);
        assert_eq!(response_body(&status)["drained"], true);

        let body = "{}";
        let timestamp = unix_seconds().to_string();
        let nonce = "http-drain-cycle-0001";
        let signature = sign_message(
            b"0123456789abcdef0123456789abcdef",
            &timestamp,
            nonce,
            "http",
            body,
        );
        let request = format!(
            "POST /api/trigger/steel-in HTTP/1.1\r\nHost: localhost\r\nX-Trigger-Timestamp: {timestamp}\r\nX-Trigger-Nonce: {nonce}\r\nX-Trigger-Signature: {signature}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let trigger = invoke_http(Arc::clone(&state), &request);
        assert!(String::from_utf8_lossy(&trigger).starts_with("HTTP/1.1 503 Service Unavailable"));
        assert_eq!(response_body(&trigger)["error"], "trigger_draining");

        let manual_completion = invoke_http(
            Arc::clone(&state),
            concat!(
                "POST /api/trigger/manual/steel-out HTTP/1.1\r\n",
                "Host: localhost\r\n",
                "X-Trigger-Operator-Token: operator-0123456789abcdef-ABCDEF!\r\n",
                "Content-Length: 2\r\n\r\n{}"
            ),
        );
        assert!(String::from_utf8_lossy(&manual_completion).starts_with("HTTP/1.1 200 OK"));
        assert_eq!(
            response_body(&manual_completion)["service"]["error"],
            "inspection_service_offline"
        );

        let completion_nonce = "http-drain-cycle-0002";
        let completion_signature = sign_message(
            b"0123456789abcdef0123456789abcdef",
            &timestamp,
            completion_nonce,
            "http",
            body,
        );
        let completion_request = format!(
            "POST /api/trigger/steel-out HTTP/1.1\r\nHost: localhost\r\nX-Trigger-Timestamp: {timestamp}\r\nX-Trigger-Nonce: {completion_nonce}\r\nX-Trigger-Signature: {completion_signature}\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let machine_completion = invoke_http(Arc::clone(&state), &completion_request);
        assert!(String::from_utf8_lossy(&machine_completion).starts_with("HTTP/1.1 200 OK"));
        assert_eq!(
            response_body(&machine_completion)["service"]["error"],
            "inspection_service_offline"
        );
        assert_eq!(admission_status_json(&state)["inFlight"], 0);
    }

    #[test]
    fn drain_rejects_authenticated_tcp_and_udp_before_forwarding() {
        let state = secured_state();
        enter_drain(&state).unwrap();
        let peer: SocketAddr = "10.20.7.9:49152".parse().unwrap();
        let timestamp = unix_seconds().to_string();

        for (index, transport) in ["tcp", "udp"].into_iter().enumerate() {
            let payload = json!({ "event": "steel-in" });
            let nonce = format!("{transport}-drain-cycle-{index:04}");
            let signature = sign_message(
                b"0123456789abcdef0123456789abcdef",
                &timestamp,
                &nonce,
                transport,
                &payload.to_string(),
            );
            let envelope = json!({
                "auth": {
                    "timestamp": timestamp.clone(),
                    "nonce": nonce,
                    "signature": signature
                },
                "payload": payload
            });
            let response = network_trigger_response(
                &envelope.to_string(),
                transport,
                peer,
                "http://127.0.0.1:9",
                &state,
            );
            assert_eq!(response["code"], 503);
            assert_eq!(response["error"], "trigger_draining");

            let completion_payload = json!({ "event": "steel-out" });
            let completion_nonce = format!("{transport}-completion-cycle-{index:04}");
            let completion_signature = sign_message(
                b"0123456789abcdef0123456789abcdef",
                &timestamp,
                &completion_nonce,
                transport,
                &completion_payload.to_string(),
            );
            let completion_envelope = json!({
                "auth": {
                    "timestamp": timestamp.clone(),
                    "nonce": completion_nonce,
                    "signature": completion_signature
                },
                "payload": completion_payload
            });
            let completion_response = network_trigger_response(
                &completion_envelope.to_string(),
                transport,
                peer,
                "http://127.0.0.1:9",
                &state,
            );
            assert_eq!(
                completion_response["service"]["error"],
                "inspection_service_offline"
            );
            assert_eq!(admission_status_json(&state)["inFlight"], 0);
        }
    }

    #[test]
    fn listener_readiness_requires_every_enabled_transport_to_be_bound() {
        let ready = ListenerStatus {
            http_enabled: true,
            http_bound: true,
            tcp_enabled: true,
            tcp_bound: true,
            udp_enabled: true,
            udp_bound: true,
        };
        assert!(ready.ready());
        let tcp_failed = ListenerStatus {
            tcp_bound: false,
            ..ready
        };
        assert!(!tcp_failed.ready());
        let tcp_disabled = ListenerStatus {
            tcp_enabled: false,
            tcp_bound: false,
            ..ready
        };
        assert!(tcp_disabled.ready());
        assert_eq!(ready.to_json()["udp"]["bound"], true);
    }

    #[test]
    fn configured_trigger_transport_bind_collisions_fail_synchronously() {
        let tcp_owner = TcpListener::bind(("127.0.0.1", 0)).expect("reserve TCP port");
        let tcp_port = tcp_owner.local_addr().expect("TCP local address").port();
        let tcp_error = bind_tcp_trigger_listener("127.0.0.1", tcp_port)
            .expect_err("second TCP bind must fail");
        assert!(tcp_error.to_string().contains("TCP trigger listener"));

        let udp_owner = UdpSocket::bind(("127.0.0.1", 0)).expect("reserve UDP port");
        let udp_port = udp_owner.local_addr().expect("UDP local address").port();
        let udp_error = bind_udp_trigger_listener("127.0.0.1", udp_port)
            .expect_err("second UDP bind must fail");
        assert!(udp_error.to_string().contains("UDP trigger listener"));
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
        assert_eq!(
            event_service_path("steel_info"),
            Some("/api/production/tasks/steel-info")
        );
        assert_eq!(
            event_service_path("enter"),
            Some("/api/production/tasks/steel-in")
        );
        assert_eq!(
            event_service_path("OUT"),
            Some("/api/production/tasks/steel-out")
        );
        assert_eq!(event_service_path("not-supported"), None);
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

    #[test]
    fn production_http_responses_do_not_emit_wildcard_cors_and_disable_caching() {
        let response =
            String::from_utf8(http_response("200 OK", "application/json", "{}")).unwrap();

        assert!(!response.contains("Access-Control-Allow-Origin"));
        assert!(response.contains("X-Content-Type-Options: nosniff"));
        assert!(response.contains("Cache-Control: no-store"));
    }

    #[test]
    fn source_allowlist_supports_exact_ipv4_ipv6_and_cidr_rules() {
        assert!(SourceRule::parse("10.20.0.0/16")
            .unwrap()
            .contains("10.20.7.9".parse().unwrap()));
        assert!(!SourceRule::parse("10.20.0.0/16")
            .unwrap()
            .contains("10.21.7.9".parse().unwrap()));
        assert!(SourceRule::parse("192.0.2.12")
            .unwrap()
            .contains("192.0.2.12".parse().unwrap()));
        assert!(SourceRule::parse("2001:db8::/32")
            .unwrap()
            .contains("2001:db8::1234".parse().unwrap()));
        assert!(SourceRule::parse("10.0.0.0/33").is_none());
    }

    #[test]
    fn production_operator_routes_require_the_separate_loopback_token() {
        let state = secured_state();
        let loopback: SocketAddr = "127.0.0.1:49152".parse().unwrap();
        let remote: SocketAddr = "10.20.7.9:49152".parse().unwrap();
        let without_token = "POST /api/trigger/manual/steel-in HTTP/1.1\r\n\r\n{}";
        let with_token = concat!(
            "POST /api/trigger/manual/steel-in HTTP/1.1\r\n",
            "X-Trigger-Operator-Token: operator-0123456789abcdef-ABCDEF!\r\n\r\n{}"
        );

        let missing = authorize_operator_request(without_token, loopback, &state).unwrap_err();
        assert_eq!(
            response_body(&missing)["error"],
            "trigger_operator_auth_required"
        );
        assert_eq!(
            authorize_operator_request(with_token, loopback, &state),
            Ok(())
        );

        let forbidden = authorize_operator_request(with_token, remote, &state).unwrap_err();
        assert_eq!(response_body(&forbidden)["error"], "local_operator_only");
    }

    #[test]
    fn hmac_authentication_accepts_once_then_rejects_replay_and_stale_time() {
        let state = secured_state();
        let timestamp = "1000";
        let nonce = "plc-a-cycle-0001";
        let body = r#"{"event":"steel-in","requestId":"cycle-1"}"#;
        let signature = sign_message(
            b"0123456789abcdef0123456789abcdef",
            timestamp,
            nonce,
            "http",
            body,
        );

        assert_eq!(
            authenticate_message(&state, timestamp, nonce, &signature, "http", body, 1000),
            Ok(())
        );
        assert_eq!(
            authenticate_message(&state, timestamp, nonce, &signature, "http", body, 1000),
            Err(AuthError {
                code: 409,
                error: "trigger_replay_detected"
            })
        );

        let stale_nonce = "plc-a-cycle-0002";
        let stale_signature = sign_message(
            b"0123456789abcdef0123456789abcdef",
            "900",
            stale_nonce,
            "http",
            body,
        );
        assert_eq!(
            authenticate_message(
                &state,
                "900",
                stale_nonce,
                &stale_signature,
                "http",
                body,
                1000
            ),
            Err(AuthError {
                code: 401,
                error: "trigger_timestamp_out_of_window"
            })
        );
    }

    #[test]
    fn tcp_and_udp_envelope_authenticates_only_the_canonical_payload() {
        let state = secured_state();
        let payload = json!({ "event": "steel-out", "requestId": "cycle-9-out" });
        let timestamp = "2000";
        let nonce = "plc-b-cycle-0009";
        let signature = sign_message(
            b"0123456789abcdef0123456789abcdef",
            timestamp,
            nonce,
            "tcp",
            &payload.to_string(),
        );
        let envelope = json!({
            "auth": { "timestamp": timestamp, "nonce": nonce, "signature": signature },
            "payload": payload
        });

        assert_eq!(
            authenticated_network_payload(&envelope.to_string(), "tcp", &state, 2000).unwrap(),
            payload
        );
        let missing_auth = json!({ "event": "steel-out" });
        assert_eq!(
            authenticated_network_payload(&missing_auth.to_string(), "udp", &state, 2000)
                .unwrap_err()["error"],
            "trigger_auth_required"
        );
    }
}
