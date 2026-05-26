use regex::Regex;
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Anchor {
    Diff,
    Reference,
    None,
}

#[derive(Debug, Serialize)]
pub struct Finding {
    pub id: String,
    pub title: String,
    pub trigger: String,
    pub severity: String,
    pub anchor: Anchor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
    pub why_it_matters: String,
    pub suggested_comment: String,
    pub suggested_fix: String,
    /// Internal flag — true when synthesized from a legacy Line
    /// Comments table. Not serialized; used by the diff verifier
    /// to skip these findings.
    #[serde(skip)]
    pub from_legacy: bool,
}

#[derive(Debug, Serialize)]
pub struct ParsedReport {
    pub verdict: String,
    pub confidence: String,
    pub findings: Vec<Finding>,
    pub line_comments: Vec<LineComment>,
    pub review_action: Option<String>,
    pub review_body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LineComment {
    pub checked: bool,
    pub path: String,
    pub line: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
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
        findings: Vec::new(),
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

/// Parse a line reference like "42", "600-601", or "610, 623" into (line, start_line).
/// Returns (end_line, Some(start_line)) for ranges/multi, or (line, None) for single.
/// Follows GitHub convention: `line` = end/last, `start_line` = beginning.
fn parse_line_ref(s: &str) -> (u64, Option<u64>) {
    let s = s.trim();

    // Comma-separated: "610, 623"
    if s.contains(',') {
        let nums: Vec<u64> = s.split(',')
            .filter_map(|p| p.trim().parse::<u64>().ok())
            .collect();
        if nums.len() >= 2 {
            return (*nums.last().unwrap(), Some(nums[0]));
        } else if nums.len() == 1 {
            return (nums[0], None);
        }
    }

    // Range: "600-601" or "600–601" (en-dash)
    for sep in ['-', '\u{2013}'] {
        if let Some((a, b)) = s.split_once(sep) {
            if let (Ok(first), Ok(last)) = (a.trim().parse::<u64>(), b.trim().parse::<u64>()) {
                return (last, Some(first));
            }
        }
    }

    // Single number
    (s.parse::<u64>().unwrap_or(0), None)
}

fn extract_line_comments(content: &str) -> Vec<LineComment> {
    // Line ref pattern: single (42), range (600-601), or comma-separated (610, 623)
    let line_ref = r#"\d+(?:\s*[,\-–]\s*\d+)*"#;

    // New table format: | `path/to/file` | 42 | Description | MED |
    //                   | `path/to/file` | 600-601 | Description | MED |
    //                   | `path/to/file` | 610, 623 | Description | MED |
    let new_table_re = Regex::new(
        &format!(r#"^\|\s*`([^`]+)`\s*\|\s*({})\s*\|\s*(.+?)\s*\|\s*(\w+)\s*\|$"#, line_ref)
    ).unwrap();

    // Old table format: | [x] | [path#L42](url) | body |
    let old_table_re = Regex::new(
        r#"^\|\s*\[([xX ])\]\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.+?)\s*\|$"#
    ).unwrap();

    // Bullet format: - `path:42` — body  or  - `path:600-601` — body
    let bullet_re = Regex::new(
        &format!(r#"^-\s*`([^`]+?):({})`\s*[—–\-]\s*(.+)$"#, line_ref)
    ).unwrap();

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
            let (line_num, start_line) = parse_line_ref(&caps[2]);
            comments.push(LineComment {
                checked: true,
                path: caps[1].to_string(),
                line: line_num,
                start_line,
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
                start_line: None,
                url: Some(url),
                body,
            });
        }
        // Try bullet format
        else if let Some(caps) = bullet_re.captures(line) {
            let (line_num, start_line) = parse_line_ref(&caps[2]);
            comments.push(LineComment {
                checked: true,
                path: caps[1].to_string(),
                line: line_num,
                start_line,
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

/// Find the Findings section heading and its level.
/// Returns (start_byte_after_heading, heading_level) where heading_level
/// is 2 or 3. `None` if no Findings section.
fn find_findings_section(content: &str) -> Option<(usize, u32)> {
    let re = Regex::new(r"(?m)^(##|###)\s+Findings\s*$").ok()?;
    let m = re.captures(content)?;
    let level = m.get(1).unwrap().as_str().len() as u32;
    let end = m.get(0).unwrap().end();
    Some((end, level))
}

/// Top-level: parse the Findings section and return its findings.
/// Returns an empty Vec if no Findings section is present.
pub fn parse_findings_section(content: &str) -> Vec<Finding> {
    let Some((_start, _level)) = find_findings_section(content) else {
        return Vec::new();
    };
    // Population happens in Task 3+.
    Vec::new()
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

    // ── Multi-line reference tests ─────────────────────────────────────────

    #[test]
    fn test_parse_line_ref_single() {
        assert_eq!(parse_line_ref("42"), (42, None));
    }

    #[test]
    fn test_parse_line_ref_range() {
        assert_eq!(parse_line_ref("600-601"), (601, Some(600)));
        assert_eq!(parse_line_ref("14-16"), (16, Some(14)));
        assert_eq!(parse_line_ref("604-628"), (628, Some(604)));
    }

    #[test]
    fn test_parse_line_ref_comma_separated() {
        assert_eq!(parse_line_ref("610, 623"), (623, Some(610)));
        assert_eq!(parse_line_ref("607, 620"), (620, Some(607)));
    }

    #[test]
    fn test_new_format_table_with_ranges() {
        let content = r#"### Line Comments

| File | Line | Issue | Severity |
|------|------|-------|----------|
| `merge.rb` | 610, 623 | role.name may return enum keys | HIGH |
| `merge.rb` | 600-601 | product_contributors not serialized | MED |
| `product_contributors_interface.rb` | 14-16 | Only NOT_FOUND rescued | MED |
| `merge.rb` | 595 | release.id vs release.original_product_id | MED |
| `transformation_utils.rb` | 144-145 | ipn/ipi added — verify XSD | MED |
| `merge.rb` | 604-628 | No test coverage for expansion methods | MED |
| `merge.rb` | 607, 620 | Defensive Entity.new guard | LOW |

### Review Action
"#;
        let report = parse_report(content);
        assert_eq!(report.line_comments.len(), 7);

        // Comma-separated: 610, 623
        assert_eq!(report.line_comments[0].path, "merge.rb");
        assert_eq!(report.line_comments[0].line, 623);
        assert_eq!(report.line_comments[0].start_line, Some(610));

        // Range: 600-601
        assert_eq!(report.line_comments[1].line, 601);
        assert_eq!(report.line_comments[1].start_line, Some(600));

        // Range: 14-16
        assert_eq!(report.line_comments[2].line, 16);
        assert_eq!(report.line_comments[2].start_line, Some(14));

        // Single: 595
        assert_eq!(report.line_comments[3].line, 595);
        assert_eq!(report.line_comments[3].start_line, None);

        // Range: 144-145
        assert_eq!(report.line_comments[4].line, 145);
        assert_eq!(report.line_comments[4].start_line, Some(144));

        // Range: 604-628
        assert_eq!(report.line_comments[5].line, 628);
        assert_eq!(report.line_comments[5].start_line, Some(604));

        // Comma-separated: 607, 620
        assert_eq!(report.line_comments[6].line, 620);
        assert_eq!(report.line_comments[6].start_line, Some(607));
    }

    #[test]
    fn test_bullet_format_with_range() {
        let content = "## Line Comments\n\n- `src/main.rs:600-601` — Fix serialization\n- `lib/foo.rb:42` — Single line\n";
        let report = parse_report(content);
        assert_eq!(report.line_comments.len(), 2);
        assert_eq!(report.line_comments[0].path, "src/main.rs");
        assert_eq!(report.line_comments[0].line, 601);
        assert_eq!(report.line_comments[0].start_line, Some(600));
        assert_eq!(report.line_comments[1].line, 42);
        assert_eq!(report.line_comments[1].start_line, None);
    }

    #[test]
    fn test_start_line_omitted_in_json_when_none() {
        let content = r#"### Line Comments

| File | Line | Issue | Severity |
|------|------|-------|----------|
| `src/main.rs` | 42 | Fix null check | HIGH |
"#;
        let report = parse_report(content);
        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains("start_line"), "start_line should be omitted when None");
    }

    #[test]
    fn test_start_line_present_in_json_when_some() {
        let content = r#"### Line Comments

| File | Line | Issue | Severity |
|------|------|-------|----------|
| `merge.rb` | 600-601 | Fix serialization | MED |
"#;
        let report = parse_report(content);
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"start_line\":600"), "start_line should be in JSON for ranges");
        assert!(json.contains("\"line\":601"), "line should be the end of range");
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

    // ── Findings section tests ────────────────────────────────────────

    #[test]
    fn test_locate_findings_section_h3() {
        let content = "## Final Report\n\n### Verdict\n\nAPPROVE\n\n### Findings\n\n#### Trigger: Code Change\n";
        let findings = parse_findings_section(content);
        assert_eq!(findings.len(), 0); // section located but no finding bodies yet
    }

    #[test]
    fn test_locate_findings_section_h2() {
        let content = "## Verdict\n\nAPPROVE\n\n## Findings\n\n### Trigger: Code Change\n";
        let findings = parse_findings_section(content);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn test_no_findings_section_returns_empty() {
        let content = "## Verdict\n\nAPPROVE\n";
        let findings = parse_findings_section(content);
        assert_eq!(findings.len(), 0);
    }

    #[test]
    fn test_finding_serializes_anchor_lowercase() {
        let finding = Finding {
            id: "F-01".into(),
            title: "Test".into(),
            trigger: "Code Change".into(),
            severity: "HIGH".into(),
            anchor: Anchor::Diff,
            location: Some("src/main.rs:42".into()),
            path: Some("src/main.rs".into()),
            line: Some(42),
            start_line: None,
            why_it_matters: "Why".into(),
            suggested_comment: "Comment".into(),
            suggested_fix: "Fix".into(),
            from_legacy: false,
        };
        let json = serde_json::to_string(&finding).unwrap();
        assert!(json.contains("\"anchor\":\"diff\""), "json was: {json}");
        assert!(!json.contains("from_legacy"), "from_legacy must not be in JSON");
    }
}
