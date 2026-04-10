// PR resolution module

use regex::Regex;

#[derive(Debug, Clone)]
pub struct PrRef {
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

impl PrRef {
    pub fn parse(input: &str) -> Result<Self, Box<dyn std::error::Error>> {
        // Full URL: https://github.com/owner/repo/pull/123
        let url_re = Regex::new(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)")?;
        if let Some(caps) = url_re.captures(input) {
            return Ok(Self {
                owner: caps[1].to_string(),
                repo: caps[2].to_string(),
                number: caps[3].parse()?,
            });
        }
        // Short: owner/repo#123
        let short_re = Regex::new(r"^([^/]+)/([^#]+)#(\d+)$")?;
        if let Some(caps) = short_re.captures(input) {
            return Ok(Self {
                owner: caps[1].to_string(),
                repo: caps[2].to_string(),
                number: caps[3].parse()?,
            });
        }
        Err(format!("Cannot parse PR reference: {input}").into())
    }

    pub fn dir_name(&self) -> String {
        format!("{}-{}-pr-{}", self.owner, self.repo, self.number)
    }

    pub fn gh_repo(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

/// Detect Jira ticket ID from text. Pattern: [A-Z][A-Z0-9]+-\d+
pub fn detect_ticket(text: &str) -> Option<String> {
    let re = Regex::new(r"([A-Z][A-Z0-9]+-\d+)").unwrap();
    re.captures(text).map(|c| c[1].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_full_url() {
        let pr = PrRef::parse("https://github.com/acme/widgets/pull/123").unwrap();
        assert_eq!(pr.owner, "acme");
        assert_eq!(pr.repo, "widgets");
        assert_eq!(pr.number, 123);
    }

    #[test]
    fn test_parse_short_format() {
        let pr = PrRef::parse("acme/widgets#123").unwrap();
        assert_eq!(pr.owner, "acme");
        assert_eq!(pr.repo, "widgets");
        assert_eq!(pr.number, 123);
    }

    #[test]
    fn test_parse_invalid() {
        assert!(PrRef::parse("not-a-pr").is_err());
    }

    #[test]
    fn test_dir_name() {
        let pr = PrRef::parse("acme/widgets#42").unwrap();
        assert_eq!(pr.dir_name(), "acme-widgets-pr-42");
    }

    #[test]
    fn test_detect_ticket_from_branch() {
        assert_eq!(detect_ticket("feature/PROJ-456-add-auth"), Some("PROJ-456".into()));
        assert_eq!(detect_ticket("TEAM-1/fix-thing"), Some("TEAM-1".into()));
        assert_eq!(detect_ticket("main"), None);
    }
}
