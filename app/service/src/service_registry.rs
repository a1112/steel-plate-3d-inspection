use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

pub const REGISTRY_SCHEMA: &str = "steel.service-registry.v1";
const MAX_SERVICES: usize = 32;
const MAX_TEXT_LEN: usize = 160;
const MAX_LOG_PATTERNS: usize = 16;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRegistration {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub default_origin: String,
    #[serde(default)]
    pub origin_env: Option<String>,
    #[serde(default)]
    pub port_env: Option<String>,
    #[serde(default = "default_health_path")]
    pub health_path: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub required_when: Option<String>,
    #[serde(default)]
    pub enabled_when_modes: Vec<String>,
    #[serde(default)]
    pub required_when_modes: Vec<String>,
    #[serde(default = "default_lifecycle")]
    pub lifecycle: String,
    #[serde(default)]
    pub log_files: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRegistryFile {
    pub schema: String,
    pub version: u32,
    pub services: Vec<ServiceRegistration>,
}

#[derive(Clone, Debug)]
pub struct ServiceRegistry {
    pub schema: String,
    pub version: u32,
    pub services: Vec<ServiceRegistration>,
    pub path: PathBuf,
}

fn default_kind() -> String {
    "probe".to_string()
}

fn default_health_path() -> String {
    "/api/health/live".to_string()
}

fn default_lifecycle() -> String {
    "health-probe".to_string()
}

fn valid_short_text(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.chars().count() <= MAX_TEXT_LEN
        && !trimmed.chars().any(|character| character.is_control())
}

fn valid_env_name(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= MAX_TEXT_LEN
        && trimmed
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn normalize_origin(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    let authority = trimmed.strip_prefix("http://")?;
    if authority.is_empty()
        || authority.contains(['/', '\\', '@', '?', '#', '\r', '\n'])
        || authority.chars().any(char::is_whitespace)
    {
        return None;
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => {
            let port = port.parse::<u16>().ok().filter(|value| *value > 0)?;
            (host, port)
        }
        None => (authority, 80),
    };
    if host.is_empty()
        || !host
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '-' | '[' | ']'))
    {
        return None;
    }
    Some(format!("http://{}:{}", host.to_ascii_lowercase(), port))
}

fn origin_port(origin: &str) -> Option<u16> {
    normalize_origin(origin)?.rsplit_once(':')?.1.parse().ok()
}

fn origin_with_env_port(origin: &str, port: u16) -> String {
    let normalized = normalize_origin(origin).unwrap_or_else(|| "http://127.0.0.1:0".to_string());
    let authority = normalized.strip_prefix("http://").unwrap_or("127.0.0.1:0");
    let host = authority
        .rsplit_once(':')
        .map(|(host, _)| host)
        .unwrap_or(authority);
    format!("http://{host}:{port}")
}

impl ServiceRegistration {
    pub fn resolved_origin(&self) -> String {
        if let Some(name) = self.origin_env.as_deref().filter(|value| !value.is_empty()) {
            if let Ok(value) = env::var(name) {
                if let Some(origin) = normalize_origin(&value) {
                    return origin;
                }
            }
        }
        if let Some(name) = self.port_env.as_deref().filter(|value| !value.is_empty()) {
            if let Ok(value) = env::var(name) {
                if let Ok(port) = value.parse::<u16>() {
                    if port > 0 {
                        return origin_with_env_port(&self.default_origin, port);
                    }
                }
            }
        }
        normalize_origin(&self.default_origin).unwrap_or_else(|| "http://127.0.0.1:80".to_string())
    }

    pub fn port(&self) -> u16 {
        origin_port(&self.resolved_origin()).unwrap_or(80)
    }

    pub fn required_for_provider(&self, provider: &str) -> bool {
        if !self.required {
            return false;
        }
        match self
            .required_when
            .as_deref()
            .unwrap_or("always")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "bkv" | "bkv-only" => provider.eq_ignore_ascii_case("bkv"),
            "non-bkv" | "non-bkv-only" => !provider.eq_ignore_ascii_case("bkv"),
            _ => true,
        }
    }

    pub fn enabled_for_mode(&self, acquisition_mode: &str) -> bool {
        self.enabled_when_modes.is_empty()
            || self
                .enabled_when_modes
                .iter()
                .any(|mode| mode.eq_ignore_ascii_case(acquisition_mode))
    }

    pub fn required_for_mode(&self, provider: &str, acquisition_mode: &str) -> bool {
        self.required_for_provider(provider)
            && self.enabled_for_mode(acquisition_mode)
            && (self.required_when_modes.is_empty()
                || self
                    .required_when_modes
                    .iter()
                    .any(|mode| mode.eq_ignore_ascii_case(acquisition_mode)))
    }

    pub fn matches_log_file(&self, name: &str) -> bool {
        self.log_files
            .iter()
            .any(|pattern| wildcard_match(pattern, name))
    }
}

impl ServiceRegistry {
    pub fn load(workspace_root: &Path, config_dir: &Path) -> Result<Self, String> {
        let path = registry_path(workspace_root, config_dir);
        let text = fs::read_to_string(&path).map_err(|error| {
            format!("service registry read failed ({}): {error}", path.display())
        })?;
        Self::from_json(&text, path)
    }

    pub fn from_json(text: &str, path: PathBuf) -> Result<Self, String> {
        if text.len() > 128 * 1024 {
            return Err("service registry is too large".to_string());
        }
        let file = serde_json::from_str::<ServiceRegistryFile>(text)
            .map_err(|error| format!("service registry JSON invalid: {error}"))?;
        if file.schema != REGISTRY_SCHEMA {
            return Err(format!("service registry schema must be {REGISTRY_SCHEMA}"));
        }
        if file.version != 1 {
            return Err("service registry version is unsupported".to_string());
        }
        if file.services.is_empty() || file.services.len() > MAX_SERVICES {
            return Err("service registry must contain 1-32 services".to_string());
        }
        let mut ids = HashSet::new();
        for service in &file.services {
            if !valid_short_text(&service.id)
                || !service
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            {
                return Err(format!("service registry id is invalid: {}", service.id));
            }
            if !ids.insert(service.id.clone()) {
                return Err(format!(
                    "service registry contains duplicate id: {}",
                    service.id
                ));
            }
            if !valid_short_text(&service.name)
                || !valid_short_text(&service.role)
                || !valid_short_text(&service.kind)
                || !valid_short_text(&service.lifecycle)
            {
                return Err(format!(
                    "service registry metadata is invalid: {}",
                    service.id
                ));
            }
            if normalize_origin(&service.default_origin).is_none() {
                return Err(format!(
                    "service registry origin is invalid: {}",
                    service.id
                ));
            }
            if !service.health_path.starts_with('/')
                || service.health_path.contains(['?', '#', '\r', '\n'])
                || service.health_path.chars().any(char::is_whitespace)
                || service.health_path.chars().count() > MAX_TEXT_LEN
            {
                return Err(format!(
                    "service registry health path is invalid: {}",
                    service.id
                ));
            }
            if let Some(name) = service.origin_env.as_deref() {
                if !valid_env_name(name) {
                    return Err(format!(
                        "service registry origin env is invalid: {}",
                        service.id
                    ));
                }
            }
            if let Some(name) = service.port_env.as_deref() {
                if !valid_env_name(name) {
                    return Err(format!(
                        "service registry port env is invalid: {}",
                        service.id
                    ));
                }
            }
            if service
                .enabled_when_modes
                .iter()
                .chain(service.required_when_modes.iter())
                .any(|mode| {
                    !matches!(
                        mode.trim().to_ascii_lowercase().as_str(),
                        "online" | "offline" | "simulation"
                    )
                })
            {
                return Err(format!(
                    "service registry acquisition mode condition is invalid: {}",
                    service.id
                ));
            }
            if service.log_files.len() > MAX_LOG_PATTERNS
                || service.log_files.iter().any(|pattern| {
                    pattern.is_empty()
                        || pattern.len() > MAX_TEXT_LEN
                        || pattern.contains(['/', '\\', ':'])
                        || pattern.chars().any(char::is_control)
                })
            {
                return Err(format!(
                    "service registry log file pattern is invalid: {}",
                    service.id
                ));
            }
        }
        Ok(Self {
            schema: file.schema,
            version: file.version,
            services: file.services,
            path,
        })
    }

    pub fn default_for_tests() -> Self {
        let text = r#"{
            "schema":"steel.service-registry.v1",
            "version":1,
            "services":[{
                "id":"inspection",
                "name":"业务服务",
                "role":"api-config-capture-orchestrator",
                "kind":"inspection",
                "defaultOrigin":"http://127.0.0.1:4873",
                "portEnv":"INSPECTION_SERVICE_PORT",
                "healthPath":"/api/health/live",
                "required":true,
                "lifecycle":"service",
                "logFiles":["inspection-service-*.out.log","inspection-service-*.err.log"]
            }]
        }"#;
        Self::from_json(text, PathBuf::from("<test-service-registry>"))
            .expect("test service registry")
    }

    pub fn public_value(&self) -> serde_json::Value {
        serde_json::json!({
            "schema": self.schema,
            "version": self.version,
            "path": self.path,
            "services": self.services
        })
    }
}

fn registry_path(workspace_root: &Path, config_dir: &Path) -> PathBuf {
    if let Ok(explicit) = env::var("STEEL_SERVICE_REGISTRY_PATH") {
        let explicit = explicit.trim();
        if !explicit.is_empty() {
            return PathBuf::from(explicit);
        }
    }
    let packaged = config_dir.join("service-registry.json");
    if packaged.is_file() {
        return packaged;
    }
    workspace_root.join("config").join("service-registry.json")
}

pub fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let mut pattern_index = 0;
    let mut value_index = 0;
    let mut star = None;
    let mut star_value = 0;
    while value_index < value.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == b'?' || pattern[pattern_index] == value[value_index])
        {
            pattern_index += 1;
            value_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star = Some(pattern_index);
            pattern_index += 1;
            star_value = value_index;
        } else if let Some(star_index) = star {
            pattern_index = star_index + 1;
            star_value += 1;
            value_index = star_value;
        } else {
            return false;
        }
    }
    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_loads_and_resolves_environment_port() {
        let registry = ServiceRegistry::default_for_tests();
        let service = &registry.services[0];
        assert_eq!(service.resolved_origin(), "http://127.0.0.1:4873");
        assert!(service.required_for_provider("simulated"));
    }

    #[test]
    fn registry_rejects_duplicate_ids_and_unsafe_log_paths() {
        let duplicate = r#"{
            "schema":"steel.service-registry.v1", "version":1,
            "services":[
              {"id":"a","name":"a","role":"a","defaultOrigin":"http://127.0.0.1:1"},
              {"id":"a","name":"b","role":"b","defaultOrigin":"http://127.0.0.1:2"}
            ]
        }"#;
        assert!(ServiceRegistry::from_json(duplicate, PathBuf::from("test")).is_err());
        let unsafe_log = r#"{
            "schema":"steel.service-registry.v1", "version":1,
            "services":[{"id":"a","name":"a","role":"a","defaultOrigin":"http://127.0.0.1:1","logFiles":["..\\secret.log"]}]
        }"#;
        assert!(ServiceRegistry::from_json(unsafe_log, PathBuf::from("test")).is_err());
    }

    #[test]
    fn registry_applies_acquisition_mode_enablement_and_requirement_conditions() {
        let text = r#"{
            "schema":"steel.service-registry.v1", "version":1,
            "services":[{
              "id":"capture", "name":"capture", "role":"capture", "kind":"capture",
              "defaultOrigin":"http://127.0.0.1:4317", "required":true,
              "enabledWhenModes":["online","simulation"],
              "requiredWhenModes":["online"]
            }]
        }"#;
        let registry =
            ServiceRegistry::from_json(text, PathBuf::from("test")).expect("mode registry");
        let service = &registry.services[0];

        assert!(service.enabled_for_mode("online"));
        assert!(service.required_for_mode("external-api", "online"));
        assert!(service.enabled_for_mode("simulation"));
        assert!(!service.required_for_mode("external-api", "simulation"));
        assert!(!service.enabled_for_mode("offline"));
        assert!(!service.required_for_mode("external-api", "offline"));

        let invalid = text.replace("\"simulation\"", "\"replay\"");
        assert!(ServiceRegistry::from_json(&invalid, PathBuf::from("test")).is_err());
    }

    #[test]
    fn wildcard_matching_is_bounded_and_filename_only() {
        assert!(wildcard_match("inspection-*.log", "inspection-service.log"));
        assert!(wildcard_match("capture-?.log", "capture-1.log"));
        assert!(!wildcard_match("capture-?.log", "capture-12.log"));
    }
}
