use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const KNOWN_AGENTS: &[&str] = &["claude", "codex", "gemini", "opencode"];

// ── default helpers for serde ──────────────────────────────────────────────

fn default_workspace_path() -> String {
    "~/.prr/workspace".into()
}

fn default_agents() -> Vec<String> {
    vec!["claude".into()]
}

fn default_claude_timeout() -> u64 {
    600
}

fn default_codex_timeout() -> u64 {
    900
}

fn default_gemini_timeout() -> u64 {
    300
}

fn default_opencode_timeout() -> u64 {
    900
}

fn default_gemini_model() -> String {
    "gemini-2.5-flash".into()
}

fn default_arbiter_rounds() -> u64 {
    3
}

fn default_google_cloud_project() -> String {
    "fuga-prod".into()
}

fn default_google_cloud_location() -> String {
    "europe-west4".into()
}

fn default_empty() -> String {
    String::new()
}

// ── Config struct ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_workspace_path")]
    pub workspace_path: String,

    #[serde(default = "default_agents")]
    pub agents: Vec<String>,

    #[serde(default = "default_claude_timeout")]
    pub claude_timeout: u64,

    #[serde(default = "default_codex_timeout")]
    pub codex_timeout: u64,

    #[serde(default = "default_gemini_timeout")]
    pub gemini_timeout: u64,

    #[serde(default = "default_opencode_timeout")]
    pub opencode_timeout: u64,

    #[serde(default = "default_gemini_model")]
    pub gemini_model: String,

    #[serde(default = "default_arbiter_rounds")]
    pub arbiter_rounds: u64,

    #[serde(default = "default_google_cloud_project")]
    pub google_cloud_project: String,

    #[serde(default = "default_google_cloud_location")]
    pub google_cloud_location: String,

    #[serde(default = "default_empty")]
    pub jira_base_url: String,

    #[serde(default = "default_empty")]
    pub jira_email: String,

    #[serde(default = "default_empty")]
    pub jira_api_token: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            workspace_path: default_workspace_path(),
            agents: default_agents(),
            claude_timeout: default_claude_timeout(),
            codex_timeout: default_codex_timeout(),
            gemini_timeout: default_gemini_timeout(),
            opencode_timeout: default_opencode_timeout(),
            gemini_model: default_gemini_model(),
            arbiter_rounds: default_arbiter_rounds(),
            google_cloud_project: default_google_cloud_project(),
            google_cloud_location: default_google_cloud_location(),
            jira_base_url: default_empty(),
            jira_email: default_empty(),
            jira_api_token: default_empty(),
        }
    }
}

impl Config {
    // ── paths ──────────────────────────────────────────────────────────────

    pub fn config_dir() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".prr")
    }

    pub fn config_path() -> PathBuf {
        Self::config_dir().join("config.yml")
    }

    // ── load ───────────────────────────────────────────────────────────────

    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        let path = Self::config_path();
        if path.exists() {
            Self::load_from_path(&path)
        } else {
            Ok(Self::default())
        }
    }

    pub fn load_from_path(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let text = std::fs::read_to_string(path)?;
        let cfg: Self = serde_yaml::from_str(&text)?;
        Ok(cfg)
    }

    // ── save ───────────────────────────────────────────────────────────────

    pub fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        self.save_to_path(&Self::config_path())
    }

    pub fn save_to_path(&self, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_yaml::to_string(self)?;
        std::fs::write(path, text)?;
        Ok(())
    }

    // ── agent helpers ──────────────────────────────────────────────────────

    pub fn agent_timeout(&self, name: &str) -> u64 {
        match name {
            "claude" => self.claude_timeout,
            "codex" => self.codex_timeout,
            "gemini" => self.gemini_timeout,
            "opencode" => self.opencode_timeout,
            _ => self.claude_timeout, // default fallback
        }
    }

    pub fn expanded_workspace_path(&self) -> PathBuf {
        let expanded = shellexpand::tilde(&self.workspace_path);
        PathBuf::from(expanded.as_ref())
    }

    pub fn add_agent(&mut self, name: &str) -> Result<(), Box<dyn std::error::Error>> {
        if !KNOWN_AGENTS.contains(&name) {
            return Err(format!("unknown agent '{name}'; valid: {}", KNOWN_AGENTS.join(", ")).into());
        }
        if !self.agents.iter().any(|a| a == name) {
            self.agents.push(name.to_string());
        }
        Ok(())
    }

    pub fn delete_agent(&mut self, name: &str) -> Result<(), Box<dyn std::error::Error>> {
        let before = self.agents.len();
        self.agents.retain(|a| a != name);
        if self.agents.len() == before {
            return Err(format!("agent '{name}' not found in config").into());
        }
        Ok(())
    }
}

// ── public dispatch functions used by main.rs ──────────────────────────────

pub fn agents_list() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = Config::load()?;
    if cfg.agents.is_empty() {
        println!("No agents configured.");
    } else {
        for agent in &cfg.agents {
            println!("{agent}");
        }
    }
    Ok(())
}

pub fn agents_add(name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut cfg = Config::load()?;
    cfg.add_agent(name)?;
    cfg.save()?;
    println!("Added agent '{name}'");
    Ok(())
}

pub fn agents_delete(name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut cfg = Config::load()?;
    cfg.delete_agent(name)?;
    cfg.save()?;
    println!("Removed agent '{name}'");
    Ok(())
}

// ── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_default_config() {
        let cfg = Config::default();
        assert_eq!(cfg.agents, vec!["claude".to_string()]);
        assert_eq!(cfg.claude_timeout, 600);
        assert_eq!(cfg.codex_timeout, 900);
        assert_eq!(cfg.gemini_timeout, 300);
        assert_eq!(cfg.opencode_timeout, 900);
        assert_eq!(cfg.gemini_model, "gemini-2.5-flash");
        assert_eq!(cfg.arbiter_rounds, 3);
    }

    #[test]
    fn test_load_from_yaml() {
        let mut f = NamedTempFile::new().unwrap();
        writeln!(f, "agents:\n  - claude\n  - codex\nclaude_timeout: 900").unwrap();
        let cfg = Config::load_from_path(f.path()).unwrap();
        assert_eq!(cfg.agents, vec!["claude", "codex"]);
        assert_eq!(cfg.claude_timeout, 900);
        assert_eq!(cfg.codex_timeout, 900);
    }

    #[test]
    fn test_agent_timeout() {
        let cfg = Config::default();
        assert_eq!(cfg.agent_timeout("claude"), 600);
        assert_eq!(cfg.agent_timeout("codex"), 900);
        assert_eq!(cfg.agent_timeout("gemini"), 300);
        assert_eq!(cfg.agent_timeout("opencode"), 900);
        assert_eq!(cfg.agent_timeout("unknown"), 600);
    }

    #[test]
    fn test_add_opencode_agent() {
        let mut cfg = Config::default();
        assert!(cfg.add_agent("opencode").is_ok());
        assert_eq!(cfg.agents, vec!["claude", "opencode"]);
    }

    #[test]
    fn test_add_agent() {
        let mut cfg = Config::default();
        assert!(cfg.add_agent("codex").is_ok());
        assert_eq!(cfg.agents, vec!["claude", "codex"]);
        assert!(cfg.add_agent("codex").is_ok());
        assert_eq!(cfg.agents, vec!["claude", "codex"]);
    }

    #[test]
    fn test_add_invalid_agent() {
        let mut cfg = Config::default();
        assert!(cfg.add_agent("gpt4").is_err());
    }

    #[test]
    fn test_delete_agent() {
        let mut cfg = Config::default();
        cfg.agents = vec!["claude".into(), "codex".into()];
        assert!(cfg.delete_agent("codex").is_ok());
        assert_eq!(cfg.agents, vec!["claude"]);
    }

    #[test]
    fn test_save_and_reload() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yml");
        let mut cfg = Config::default();
        cfg.jira_base_url = "https://test.atlassian.net/".into();
        cfg.save_to_path(&path).unwrap();
        let loaded = Config::load_from_path(&path).unwrap();
        assert_eq!(loaded.jira_base_url, "https://test.atlassian.net/");
        assert_eq!(loaded.agents, vec!["claude"]);
    }
}
