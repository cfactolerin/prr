use regex::Regex;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ParsedReport {
    pub verdict: String,
    pub confidence: String,
    pub line_comments: Vec<LineComment>,
    pub review_action: Option<String>,
    pub review_body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LineComment {
    pub checked: bool,
    pub path: String,
    pub line: u64,
    pub url: Option<String>,
    pub body: String,
}

pub fn parse_report(content: &str) -> ParsedReport {
    ParsedReport {
        verdict: extract_field(content, "Verdict").unwrap_or_else(|| "UNKNOWN".into()),
        confidence: extract_field(content, "Verdict Confidence")
            .or_else(|| extract_field(content, "Confidence"))
            .unwrap_or_else(|| "UNKNOWN".into()),
        line_comments: extract_line_comments(content),
        review_action: extract_review_action(content),
        review_body: extract_review_body(content),
    }
}

fn extract_field(content: &str, name: &str) -> Option<String> {
    let pattern = format!(r"##\s*{}:\s*(.+)", regex::escape(name));
    Regex::new(&pattern).ok()?.captures(content).map(|c| c[1].trim().to_string())
}

fn extract_line_comments(content: &str) -> Vec<LineComment> {
    let table_re = Regex::new(r#"^\|\s*\[([xX ])\]\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.+?)\s*\|$"#).unwrap();
    let old_re = Regex::new(r#"^-\s*`([^`]+?):(\d+)`\s*[—–\-]\s*(.+)$"#).unwrap();
    let path_line_re = Regex::new(r"(.+)#L(\d+)").unwrap();

    let mut comments = Vec::new();
    let mut in_section = false;

    for line in content.lines() {
        if line.contains("## Line Comments") {
            in_section = true;
            continue;
        }
        if in_section && line.starts_with("## ") {
            break;
        }
        if !in_section {
            continue;
        }

        if let Some(caps) = table_re.captures(line) {
            let checked = caps[1].trim().eq_ignore_ascii_case("x");
            let display = &caps[2];
            let url = caps[3].to_string();
            let body = caps[4].trim().to_string();
            let (path, line_num) = if let Some(pl) = path_line_re.captures(display) {
                (pl[1].replace('`', ""), pl[2].parse::<u64>().unwrap_or(0))
            } else {
                (display.replace('`', ""), 0)
            };
            comments.push(LineComment {
                checked,
                path,
                line: line_num,
                url: Some(url),
                body,
            });
        } else if let Some(caps) = old_re.captures(line) {
            comments.push(LineComment {
                checked: true,
                path: caps[1].to_string(),
                line: caps[2].parse().unwrap_or(0),
                url: None,
                body: caps[3].trim().to_string(),
            });
        }
    }
    comments
}

fn extract_review_action(content: &str) -> Option<String> {
    let re = Regex::new(r"(?i)^-\s*\[([xX])\]\s*(Comment|Approve|Request Changes)\s*$").unwrap();
    let mut in_section = false;
    for line in content.lines() {
        if line.contains("### Review Action") {
            in_section = true;
            continue;
        }
        if in_section && line.starts_with("##") {
            break;
        }
        if in_section {
            if let Some(caps) = re.captures(line) {
                return Some(caps[2].trim().to_string());
            }
        }
    }
    None
}

fn extract_review_body(content: &str) -> Option<String> {
    let mut in_body = false;
    let mut lines = Vec::new();
    for line in content.lines() {
        if line.contains("### Comment Body") {
            in_body = true;
            continue;
        }
        if in_body && line.starts_with("##") {
            break;
        }
        if in_body {
            lines.push(line);
        }
    }
    let body = lines.join("\n").trim().to_string();
    if body.is_empty() {
        None
    } else {
        Some(body)
    }
}

pub fn parse_and_print(report_path: &str) -> Result<(), Box<dyn std::error::Error>> {
    let content = std::fs::read_to_string(report_path)?;
    let report = parse_report(&content);
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_verdict() {
        let content = "## Verdict: REQUEST_CHANGES\n## Confidence: HIGH\n";
        let report = parse_report(content);
        assert_eq!(report.verdict, "REQUEST_CHANGES");
        assert_eq!(report.confidence, "HIGH");
    }

    #[test]
    fn test_extract_verdict_confidence_format() {
        let content = "## Verdict: APPROVE\n## Verdict Confidence: MEDIUM\n";
        let report = parse_report(content);
        assert_eq!(report.verdict, "APPROVE");
        assert_eq!(report.confidence, "MEDIUM");
    }

    #[test]
    fn test_extract_table_comments() {
        let content = r#"## Line Comments

| Post | Location | Comment |
|------|----------|---------|
| [x] | [src/main.rs#L42](https://github.com/a/b/blob/c/src/main.rs#L42) | Fix null check |
| [ ] | [lib/foo.rs#L10](https://github.com/a/b/blob/c/lib/foo.rs#L10) | Consider logging |
"#;
        let report = parse_report(content);
        assert_eq!(report.line_comments.len(), 2);
        assert!(report.line_comments[0].checked);
        assert_eq!(report.line_comments[0].path, "src/main.rs");
        assert_eq!(report.line_comments[0].line, 42);
        assert_eq!(report.line_comments[0].body, "Fix null check");
        assert!(!report.line_comments[1].checked);
    }

    #[test]
    fn test_extract_old_format() {
        let content = "## Line Comments\n\n- `src/main.rs:42` — Fix null check\n";
        let report = parse_report(content);
        assert_eq!(report.line_comments.len(), 1);
        assert_eq!(report.line_comments[0].path, "src/main.rs");
        assert_eq!(report.line_comments[0].line, 42);
    }

    #[test]
    fn test_extract_review_action() {
        let content = "### Review Action\n- [ ] Comment\n- [x] Request Changes\n- [ ] Approve\n";
        let report = parse_report(content);
        assert_eq!(report.review_action.as_deref(), Some("Request Changes"));
    }

    #[test]
    fn test_extract_review_body() {
        let content = "### Comment Body\n\nThis PR needs work on error handling.\n\n## Next Section\n";
        let report = parse_report(content);
        assert_eq!(report.review_body.as_deref(), Some("This PR needs work on error handling."));
    }

    #[test]
    fn test_json_output() {
        let content = "## Verdict: APPROVE\n## Confidence: HIGH\n### Review Action\n- [x] Approve\n";
        let report = parse_report(content);
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("APPROVE"));
    }
}
