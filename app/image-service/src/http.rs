use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;

pub struct Response {
    head: Vec<u8>,
    body: ResponseBody,
}

enum ResponseBody {
    Empty,
    Owned(Vec<u8>),
    Shared(Arc<Vec<u8>>),
}

impl Response {
    pub fn write_to(self, stream: &mut TcpStream, connection_close: bool) -> std::io::Result<()> {
        stream.write_all(&self.head)?;
        if connection_close {
            stream.write_all(b"Connection: close\r\n\r\n")?;
        } else {
            stream
                .write_all(b"Connection: keep-alive\r\nKeep-Alive: timeout=2, max=256\r\n\r\n")?;
        }
        match self.body {
            ResponseBody::Empty => Ok(()),
            ResponseBody::Owned(bytes) => stream.write_all(&bytes),
            ResponseBody::Shared(bytes) => stream.write_all(bytes.as_slice()),
        }
    }

    #[cfg(test)]
    pub fn into_bytes(self) -> Vec<u8> {
        let mut bytes = self.head;
        bytes.extend_from_slice(b"Connection: close\r\n\r\n");
        match self.body {
            ResponseBody::Empty => {}
            ResponseBody::Owned(body) => bytes.extend_from_slice(&body),
            ResponseBody::Shared(body) => bytes.extend_from_slice(body.as_slice()),
        }
        bytes
    }
}

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub if_none_match: String,
    pub connection_close: bool,
}

pub fn read_request(stream: &mut TcpStream) -> Result<Option<Request>, &'static str> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) if bytes.is_empty() => return Ok(None),
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
            Err(error)
                if bytes.is_empty()
                    && matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::ConnectionAborted
                            | std::io::ErrorKind::ConnectionReset
                    ) =>
            {
                return Ok(None)
            }
            Err(_) => return Err("request_read_failed"),
        }
    }
    parse_request(&bytes).map(Some)
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
    let http_version = first.next().unwrap_or_default();
    let (path, raw_query) = target.split_once('?').unwrap_or((target, ""));
    let mut if_none_match = String::new();
    let mut connection_close = http_version != "HTTP/1.1";
    for (name, value) in lines.filter_map(|line| line.split_once(':')) {
        if name.eq_ignore_ascii_case("if-none-match") {
            if_none_match = value.trim().to_string();
        } else if name.eq_ignore_ascii_case("connection") {
            connection_close = value.trim().eq_ignore_ascii_case("close");
        }
    }
    Ok(Request {
        method,
        path: path.to_string(),
        query: parse_query(raw_query),
        if_none_match,
        connection_close,
    })
}

pub fn ok_json(value: &Value) -> Response {
    json_response(200, value)
}

pub fn error_json(code: u16, error: &str) -> Response {
    json_response(code, &serde_json::json!({"error": error}))
}

fn json_response(code: u16, value: &Value) -> Response {
    let body = value.to_string().into_bytes();
    let head = format!(
        "HTTP/1.1 {code} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\n",
        reason(code),
        body.len()
    )
    .into_bytes();
    Response {
        head,
        body: ResponseBody::Owned(body),
    }
}

pub fn binary_response(
    bytes: Arc<Vec<u8>>,
    tag: &str,
    if_none_match: &str,
    cache_control: &str,
    headers: &[(&str, String)],
) -> Response {
    let extra_headers = headers
        .iter()
        .map(|(name, value)| format!("{name}: {}\r\n", safe_header_value(value)))
        .collect::<String>();
    if if_none_match == tag {
        return Response {
            head: format!(
                "HTTP/1.1 304 Not Modified\r\nETag: {tag}\r\nCache-Control: {cache_control}\r\n{extra_headers}"
            )
            .into_bytes(),
            body: ResponseBody::Empty,
        };
    }
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nETag: {tag}\r\nCache-Control: {cache_control}\r\n{extra_headers}",
        bytes.len()
    )
    .into_bytes();
    Response {
        head,
        body: ResponseBody::Shared(bytes),
    }
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
    use super::{parse_query, parse_request};

    #[test]
    fn decodes_query_values() {
        let query = parse_query("recordId=coil%2F2026+08&camera=C1");
        assert_eq!(
            query.get("recordId").map(String::as_str),
            Some("coil/2026 08")
        );
        assert_eq!(query.get("camera").map(String::as_str), Some("C1"));
    }

    #[test]
    fn parses_conditional_and_connection_headers() {
        let request = parse_request(
            b"GET /api/preview?recordId=coil HTTP/1.1\r\nIf-None-Match: \"hash\"\r\nConnection: close\r\n\r\n",
        )
        .expect("parse request");
        assert_eq!(request.path, "/api/preview");
        assert_eq!(request.if_none_match, "\"hash\"");
        assert!(request.connection_close);
    }
}
