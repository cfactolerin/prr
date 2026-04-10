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
    let verdict = extract_section_value(content, "Verdict")
        .map(|v| {
            // Take just the first word (APPROVE, REQUEST_CHANGES, COMMENT)
            v.split_whitespace().next().unwrap_or("UNKNOWN").to_string()
        })
        .or_else(|| extract_inline_field(content, "Verdict"))
        .unwrap_or_else(|| "UNKNOWN".into());

    let confidence = extract_section_value(content, "Confidence")
        .map(|v| v.split_whitespace().next().unwrap_or("UNKNOWN").to_string())
        .or_else(|| extract_inline_field(content, "Verdict Confidence"))
        .or_else(|| extract_inline_field(content, "Confidence"))
        .unwrap_or_else(|| "UNKNOWN".into());

    let review_action = extract_review_action(content).or_else(|| {
        // Derive from verdict if no explicit action section
        match verdict.as_str() {
            "APPROVE" => Some("Approve".into()),
            "REQUEST_CHANGES" => Some("Request Changes".into()),
            "COMMENT" => Some("Comment".into()),
            _ => None,
        }
    });

    let review_body = extract_review_body(content)
        .or_else(|| extract_verdict_body(content));

    ParsedReport {
        verdict,
        confidence,
        line_comments: extract_line_comments(content),
        review_action,
        review_body,
    }
}

/// Extract the first non-empty, non-heading line after a `## Heading` or `### Heading`.
fn extract_section_value(content: &str, heading: &str) -> Option<String> {
    let re = Regex::new(&format!(r"(?m)^#{{2,3}}\s+{}\s*$", regex::escape(heading))).ok()?;
    let m = re.find(content)?;
    for line in content[m.end()..].lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            break;
        }
        return Some(trimmed.to_string());
    }
    None
}

/// Extract the paragraph body from the Verdict section (skipping the verdict word line).
fn extract_verdict_body(content: &str) -> Option<String> {
    let re = Regex::new(r"(?m)^#{2,3}\s+Verdict\s*$").ok()?;
    let m = re.find(content)?;
    let mut lines = Vec::new();
    let mut skipped_value = false;
    for line in content[m.end()..].lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() && !skipped_value {
            continue;
        }
        if !skipped_value {
            // This is the verdict word line (e.g. "COMMENT"), skip it
            skipped_value = true;
            continue;
        }
        if trimmed.starts_with('#') {
            break;
        }
        lines.push(line);
    }
    let body = lines.join("\n").trim().to_string();
    if body.is_empty() { None } else { Some(body) }
}

/// Old format: `## Field: VALUE` on same line.
fn extract_inline_field(content: &str, name: &str) -> Option<String> {
    let pattern = format!(r"##\s*{}:\s*(.+)", regex::escape(name));
    Regex::new(&pattern).ok()?.captures(content).map(|c| c[1].trim().to_string())
}

fn extract_line_comments(content: &str) -> Vec<LineComment> {
    // New table format: | `path/to/file` | 42 | Description | MED |
    let new_table_re = Regex::new(
        r#"^\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(\w+)\s*\|$"#
    ).unwrap();

    // Old table format: | [x] | [path#L42](url) | body |
    let old_table_re = Regex::new(
        r#"^\|\s*\[([xX ])\]\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.+?)\s*\|$"#
    ).unwrap();

    // Bullet format: - `path:42` — body
    let bullet_re = Regex::new(r#"^-\s*`([^`]+?):(\d+)`\s*[—–\-]\s*(.+)$"#).unwrap();

    let path_line_re = Regex::new(r"(.+)#L(\d+)").unwrap();

    let mut comments = Vec::new();
    let mut in_section = false;

    for line in content.lines() {
        if line.contains("## Line Comments") {
            in_section = true;
            continue;
        }
        if in_section && line.starts_with("## ") && !line.contains("Line Comments") {
            break;
        }
        if !in_section {
            continue;
        }

        // Try new table format first
        if let Some(caps) = new_table_re.captures(line) {
            comments.push(LineComment {
                checked: true,
                path: caps[1].to_string(),
                line: caps[2].parse::<u64>().unwrap_or(0),
                url: None,
                body: caps[3].trim().to_string(),
            });
        }
        // Try old table format
        else if let Some(caps) = old_table_re.captures(line) {
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
        }
        // Try bullet format
        else if let Some(caps) = bullet_re.captures(line) {
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

    // ── New format tests ──────────────────────────────────────────────────

    #[test]
    fn test_new_format_verdict() {
        let content = "### Verdict\n\nCOMMENT\n\nThe PR delivers well-structured code.\n\n### Confidence\n\nHIGH\n";
        let report = parse_report(content);
        assert_eq!(report.verdict, "COMMENT");
        assert_eq!(report.confidence, "HIGH");
    }

    #[test]
    fn test_new_format_verdict_derives_action() {
        let content = "### Verdict\n\nAPPROVE\n\nLooks good.\n";
        let report = parse_report(content);
        assert_eq!(report.verdict, "APPROVE");
        assert_eq!(report.review_action.as_deref(), Some("Approve"));
    }

    #[test]
    fn test_new_format_verdict_body() {
        let content = "### Verdict\n\nREQUEST_CHANGES\n\nThis PR needs fixes.\n\n### Confidence\n\nMEDIUM\n";
        let report = parse_report(content);
        assert_eq!(report.review_body.as_deref(), Some("This PR needs fixes."));
    }

    #[test]
    fn test_new_format_line_comments() {
        let content = r#"### Line Comments

| File | Line | Issue | Severity |
|------|------|-------|----------|
| `src/main.rs` | 42 | Fix null check | HIGH |
| `lib/foo.rb` | 10 | Consider logging here | LOW |

### Review Action
"#;
        let report = parse_report(content);
        assert_eq!(report.line_comments.len(), 2);
        assert!(report.line_comments[0].checked);
        assert_eq!(report.line_comments[0].path, "src/main.rs");
        assert_eq!(report.line_comments[0].line, 42);
        assert_eq!(report.line_comments[0].body, "Fix null check");
        assert!(report.line_comments[0].url.is_none());
        assert_eq!(report.line_comments[1].path, "lib/foo.rb");
        assert_eq!(report.line_comments[1].line, 10);
    }

    #[test]
    fn test_new_format_multiword_body() {
        let content = r#"### Line Comments

| File | Line | Issue | Severity |
|------|------|-------|----------|
| `delivery/lib/registries/base_registry.rb` | 29 | `raise(KeyError)` instead of passthrough deviates from ticket acceptance criteria. Must be documented. | MED |
"#;
        let report = parse_report(content);
        assert_eq!(report.line_comments.len(), 1);
        assert_eq!(report.line_comments[0].path, "delivery/lib/registries/base_registry.rb");
        assert_eq!(report.line_comments[0].line, 29);
        assert!(report.line_comments[0].body.contains("raise(KeyError)"));
    }

    // ── Old format backward compatibility ─────────────────────────────────

    #[test]
    fn test_old_format_inline_verdict() {
        let content = "## Verdict: REQUEST_CHANGES\n## Confidence: HIGH\n";
        let report = parse_report(content);
        assert_eq!(report.verdict, "REQUEST_CHANGES");
        assert_eq!(report.confidence, "HIGH");
    }

    #[test]
    fn test_old_format_verdict_confidence() {
        let content = "## Verdict: APPROVE\n## Verdict Confidence: MEDIUM\n";
        let report = parse_report(content);
        assert_eq!(report.verdict, "APPROVE");
        assert_eq!(report.confidence, "MEDIUM");
    }

    #[test]
    fn test_old_format_table_comments() {
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
    fn test_old_format_bullet_comments() {
        let content = "## Line Comments\n\n- `src/main.rs:42` — Fix null check\n";
        let report = parse_report(content);
        assert_eq!(report.line_comments.len(), 1);
        assert_eq!(report.line_comments[0].path, "src/main.rs");
        assert_eq!(report.line_comments[0].line, 42);
    }

    #[test]
    fn test_old_format_review_action() {
        let content = "### Review Action\n- [ ] Comment\n- [x] Request Changes\n- [ ] Approve\n";
        let report = parse_report(content);
        assert_eq!(report.review_action.as_deref(), Some("Request Changes"));
    }

    #[test]
    fn test_old_format_comment_body() {
        let content = "### Comment Body\n\nThis PR needs work on error handling.\n\n## Next Section\n";
        let report = parse_report(content);
        assert_eq!(report.review_body.as_deref(), Some("This PR needs work on error handling."));
    }

    // ── Edge cases ────────────────────────────────────────────────────────

    #[test]
    fn test_unknown_verdict() {
        let content = "No structured content here.";
        let report = parse_report(content);
        assert_eq!(report.verdict, "UNKNOWN");
        assert_eq!(report.confidence, "UNKNOWN");
    }

    #[test]
    fn test_json_output() {
        let content = "### Verdict\n\nAPPROVE\n\nLooks good.\n### Confidence\n\nHIGH\n";
        let report = parse_report(content);
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("APPROVE"));
        assert!(json.contains("HIGH"));
    }
}
