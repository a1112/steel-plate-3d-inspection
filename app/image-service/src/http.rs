use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::net::TcpStream;

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub if_none_match: String,
}

pub fn read_request(stream: &mut TcpStream) -> Result<Request, &'static str> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(size) => {
                bytes.extend_from_slice(&buffer[..size]);
                if request_is_complete(&bytes) {
                    break;
                }
                if bytes.len() > 1024 * 1024 {
                    return Err("request_too_large");
                }
            }
            Err(_) => return Err("request_read_failed"),
        }
    }
    parse_request(&bytes)
}

fn request_is_complete(bytes: &[u8]) -> bool {
    let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let header = String::from_utf8_lossy(&bytes[..header_end]);
    let content_length = header
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    bytes.len() >= header_end + 4 + content_length
}

fn parse_request(bytes: &[u8]) -> Result<Request, &'static str> {
    let request = String::from_utf8_lossy(bytes);
    let mut lines = request.lines();
    let mut first = lines.next().unwrap_or_default().split_whitespace();
    let method = first.next().ok_or("invalid_request")?.to_string();
    let target = first.next().ok_or("invalid_request")?;
    let (path, raw_query) = target.split_once('?').unwrap_or((target, ""));
    let if_none_match = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("if-none-match"))
        .map(|(_, value)| value.trim().to_string())
        .unwrap_or_default();
    Ok(Request {
        method,
        path: path.to_string(),
        query: parse_query(raw_query),
        if_none_match,
    })
}

pub fn ok_json(value: &Value) -> Vec<u8> {
    json_response(200, value)
}

pub fn error_json(code: u16, error: &str) -> Vec<u8> {
    json_response(code, &serde_json::json!({"error": error}))
}

fn json_response(code: u16, value: &Value) -> Vec<u8> {
    let body = value.to_string();
    format!(
        "HTTP/1.1 {code} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        reason(code),
        body.len()
    )
    .into_bytes()
}

pub fn binary_response(
    bytes: &[u8],
    tag: &str,
    if_none_match: &str,
    cache_control: &str,
    headers: &[(&str, String)],
) -> Vec<u8> {
    let extra_headers = headers
        .iter()
        .map(|(name, value)| format!("{name}: {}\r\n", safe_header_value(value)))
        .collect::<String>();
    if if_none_match == tag {
        return format!(
            "HTTP/1.1 304 Not Modified\r\nETag: {tag}\r\nCache-Control: {cache_control}\r\n{extra_headers}Connection: close\r\n\r\n"
        )
        .into_bytes();
    }
    let mut response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nETag: {tag}\r\nCache-Control: {cache_control}\r\n{extra_headers}Connection: close\r\n\r\n",
        bytes.len()
    )
    .into_bytes();
    response.extend_from_slice(bytes);
    response
}

fn safe_header_value(value: &str) -> String {
    value
        .chars()
        .filter(|character| !matches!(character, '\r' | '\n'))
        .collect()
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|part| !part.is_empty())
        .map(|part| part.split_once('=').unwrap_or((part, "")))
        .map(|(key, value)| (percent_decode(key), percent_decode(value)))
        .collect()
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let pair = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(pair, 16) {
                    decoded.push(byte);
                    index += 3;
                } else {
                    decoded.push(bytes[index]);
                    index += 1;
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        503 => "Service Unavailable",
        _ => "Error",
    }
}

#[cfg(test)]
mod tests {
    use super::parse_query;

    #[test]
    fn decodes_query_values() {
        let query = parse_query("recordId=coil%2F2026+08&camera=C1");
        assert_eq!(
            query.get("recordId").map(String::as_str),
            Some("coil/2026 08")
        );
        assert_eq!(query.get("camera").map(String::as_str), Some("C1"));
    }
}
