use serde::Serialize;

pub const SITE_ID_ENV: &str = "STEEL_SITE_CONFIG_ID";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SiteSelectionSource {
    Environment,
    Registry,
    Repository,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectiveSiteSelection {
    pub site_id: String,
    pub source: SiteSelectionSource,
}

pub struct SiteSelectionInput {
    pub environment_site_id: Option<String>,
    pub machine_default_site_id: Option<String>,
    pub repository_default_site_id: String,
}

pub trait MachineSiteStore: Send + Sync {
    fn read_default_site_id(&self) -> Result<Option<String>, String>;
    fn write_default_site_id(&self, id: &str) -> Result<(), String>;
    fn clear_default_site_id(&self) -> Result<(), String>;
    fn writable(&self) -> Result<bool, String>;
}

pub fn select_site(input: SiteSelectionInput) -> Result<EffectiveSiteSelection, String> {
    if let Some(site_id) = input.environment_site_id {
        return selected(site_id, SiteSelectionSource::Environment, "environment");
    }
    if let Some(site_id) = input.machine_default_site_id {
        return selected(site_id, SiteSelectionSource::Registry, "registry");
    }
    selected(
        input.repository_default_site_id,
        SiteSelectionSource::Repository,
        "repository",
    )
}

pub fn restart_required(effective_site_id: &str, running_site_id: &str) -> bool {
    effective_site_id != running_site_id
}

fn selected(
    site_id: String,
    source: SiteSelectionSource,
    source_label: &str,
) -> Result<EffectiveSiteSelection, String> {
    validate_site_id(&site_id)
        .map_err(|error| format!("{source_label} site configuration is invalid: {error}"))?;
    Ok(EffectiveSiteSelection { site_id, source })
}

fn validate_site_id(value: &str) -> Result<(), String> {
    if !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        Ok(())
    } else {
        Err("site ID must contain only letters, numbers, '-' or '_'".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_override_wins_over_registry_and_repository() {
        let input = SiteSelectionInput {
            environment_site_id: Some("env-site".into()),
            machine_default_site_id: Some("registry-site".into()),
            repository_default_site_id: "repo-site".into(),
        };

        assert_eq!(
            select_site(input).unwrap(),
            EffectiveSiteSelection {
                site_id: "env-site".into(),
                source: SiteSelectionSource::Environment,
            }
        );
    }

    #[test]
    fn registry_default_wins_when_environment_is_absent() {
        let input = SiteSelectionInput {
            environment_site_id: None,
            machine_default_site_id: Some("registry-site".into()),
            repository_default_site_id: "repo-site".into(),
        };

        assert_eq!(select_site(input).unwrap().site_id, "registry-site");
    }

    #[test]
    fn repository_default_is_the_final_fallback() {
        let input = SiteSelectionInput {
            environment_site_id: None,
            machine_default_site_id: None,
            repository_default_site_id: "repo-site".into(),
        };

        assert_eq!(select_site(input).unwrap().site_id, "repo-site");
    }

    #[test]
    fn empty_explicit_identifiers_are_rejected_instead_of_falling_back() {
        let input = SiteSelectionInput {
            environment_site_id: Some(" ".into()),
            machine_default_site_id: Some("registry-site".into()),
            repository_default_site_id: "repo-site".into(),
        };

        assert!(select_site(input).unwrap_err().contains("environment"));
    }

    #[test]
    fn restart_is_required_only_when_effective_and_running_sites_differ() {
        assert!(!restart_required("site-a", "site-a"));
        assert!(restart_required("site-a", "site-b"));
    }
}
