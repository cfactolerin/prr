//! Prompt assembly — reads context artifacts and interpolates templates.

use std::path::Path;

const REVIEW_TEMPLATE: &str = include_str!("../references/prompts/review-prompt.md");
const ARBITER_TEMPLATE: &str = include_str!("../references/prompts/arbiter-prompt.md");
const QUESTION_TEMPLATE: &str = include_str!("../references/prompts/arbiter-question-prompt.md");

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Assemble a review prompt for a single agent.
///
/// Reads artifacts produced by `prr context` from `context_dir` and writes
/// the assembled prompt to `results/review-prompt.md`.
pub fn build_review(
    context_dir: &str,
    tasks_json: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let base = Path::new(context_dir);
    let results = base.join("results");

    let meta = load_pr_metadata(&results)?;
    let pr_number = meta["number"].as_u64().unwrap_or(0).to_string();
    let pr_title = str_field(&meta, "title");
    let pr_url = str_field(&meta, "url");
    let pr_author = meta
        .pointer("/author/login")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let head_branch = str_field(&meta, "headRefName");
    let base_branch = str_field(&meta, "baseRefName");
    let repo = repo_from_url(&pr_url);

    // Infer ticket_id from head branch / title (stored in metadata body field)
    let pr_body = str_field(&meta, "body");
    let ticket_id = crate::pr::detect_ticket(&format!("{pr_title} {pr_body} {head_branch}"))
        .unwrap_or_else(|| "none".to_string());

    // Optional context files
    let diff = read_if_exists(&results.join("diff.txt"));
    let changed_files = read_if_exists(&results.join("changed-files.txt"));
    let repo_docs_raw = read_if_exists(&results.join("repo-docs.md"));
    let previous_review_raw = read_if_exists(&results.join("previous-review.md"));
    let ticket_context_raw = read_if_exists(&base.join("context/ticket-context.md"));

    // Conditional section handling
    let repo_docs = if repo_docs_raw.trim().is_empty() {
        "No docs found.".to_string()
    } else {
        repo_docs_raw
    };

    let ticket_context = if ticket_context_raw.trim().is_empty() {
        "No ticket details available.".to_string()
    } else {
        ticket_context_raw
    };

    let previous_review = if previous_review_raw.trim().is_empty() {
        "N/A — this is a first review.".to_string()
    } else {
        previous_review_raw
    };

    // Parse tasks JSON (array of strings)
    let reviewer_tasks = parse_tasks(tasks_json);

    let prompt = interpolate(
        REVIEW_TEMPLATE,
        &[
            ("{{pr_number}}", &pr_number),
            ("{{pr_title}}", &pr_title),
            ("{{pr_url}}", &pr_url),
            ("{{pr_author}}", &pr_author),
            ("{{head_branch}}", &head_branch),
            ("{{base_branch}}", &base_branch),
            ("{{ticket_id}}", &ticket_id),
            ("{{ticket_context}}", &ticket_context),
            ("{{repo_docs}}", &repo_docs),
            ("{{previous_review}}", &previous_review),
            ("{{changed_files}}", &changed_files),
            ("{{diff}}", &diff),
            ("{{reviewer_tasks}}", &reviewer_tasks),
            ("{{repo}}", &repo),
        ],
    );

    let out_path = results.join("review-prompt.md");
    std::fs::write(&out_path, &prompt)?;
    println!("{}", out_path.display());
    Ok(())
}

/// Assemble the arbiter synthesis prompt.
///
/// Collects all `*-review.md` files from `results/` and builds the arbiter
/// prompt, writing it to `results/arbiter-prompt.md`.
pub fn build_arbiter(context_dir: &str) -> Result<(), Box<dyn std::error::Error>> {
    let base = Path::new(context_dir);
    let results = base.join("results");

    let meta = load_pr_metadata(&results)?;
    let pr_number = meta["number"].as_u64().unwrap_or(0).to_string();
    let pr_title = str_field(&meta, "title");
    let pr_url = str_field(&meta, "url");
    let pr_author = meta
        .pointer("/author/login")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let head_branch = str_field(&meta, "headRefName");
    let base_branch = str_field(&meta, "baseRefName");
    let repo = repo_from_url(&pr_url);

    let pr_body = str_field(&meta, "body");
    let ticket_id = crate::pr::detect_ticket(&format!("{pr_title} {pr_body} {head_branch}"))
        .unwrap_or_else(|| "none".to_string());

    // Collect agent reviews
    let reviews = collect_reviews(&results);

    // Q&A round history
    let round_history = collect_round_history(&results);

    // Reviewer tasks — re-use from context manifest if present
    let reviewer_tasks = read_if_exists(&base.join("context-manifest.md"));
    let reviewer_tasks_section = extract_tasks_from_manifest(&reviewer_tasks);

    let prompt = interpolate(
        ARBITER_TEMPLATE,
        &[
            ("{{pr_number}}", &pr_number),
            ("{{pr_title}}", &pr_title),
            ("{{pr_url}}", &pr_url),
            ("{{pr_author}}", &pr_author),
            ("{{head_branch}}", &head_branch),
            ("{{base_branch}}", &base_branch),
            ("{{ticket_id}}", &ticket_id),
            ("{{reviews}}", &reviews),
            ("{{round_history}}", &round_history),
            ("{{reviewer_tasks}}", &reviewer_tasks_section),
            ("{{repo}}", &repo),
        ],
    );

    let out_path = results.join("arbiter-prompt.md");
    std::fs::write(&out_path, &prompt)?;
    println!("{}", out_path.display());
    Ok(())
}

/// Assemble a question prompt for a specific agent.
///
/// Reads the agent's prior review, interpolates it with the arbiter's
/// questions, and writes to `results/round-{N}-{agent}-question.md`.
pub fn build_question(
    context_dir: &str,
    agent: &str,
    questions_json: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let base = Path::new(context_dir);
    let results = base.join("results");

    let meta = load_pr_metadata(&results)?;
    let pr_number = meta["number"].as_u64().unwrap_or(0).to_string();
    let pr_title = str_field(&meta, "title");
    let repo = repo_from_url(&str_field(&meta, "url"));

    let review_path = results.join(format!("{agent}-review.md"));
    let previous_review = if review_path.exists() {
        std::fs::read_to_string(&review_path)?
    } else {
        format!("(no prior review found for agent '{agent}')")
    };

    // Parse questions from JSON (array of strings keyed by agent name, or plain array)
    let questions = parse_questions_for_agent(questions_json, agent);

    // Determine round number
    let round_num = next_round_number(&results, agent);

    let prompt = interpolate(
        QUESTION_TEMPLATE,
        &[
            ("{{pr_number}}", &pr_number),
            ("{{pr_title}}", &pr_title),
            ("{{repo}}", &repo),
            ("{{previous_review}}", &previous_review),
            ("{{questions}}", &questions),
        ],
    );

    let out_path = results.join(format!("round-{round_num}-{agent}-question.md"));
    std::fs::write(&out_path, &prompt)?;
    println!("{}", out_path.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/// Returns file contents as a String, or empty string if file doesn't exist.
fn read_if_exists(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// Capitalizes the first ASCII letter of a string.
fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

/// Load and parse `results/pr-metadata.json`.
fn load_pr_metadata(
    results: &Path,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let path = results.join("pr-metadata.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    Ok(serde_json::from_str(&text)?)
}

/// Convenience: extract a top-level string field from JSON, defaulting to "".
fn str_field(meta: &serde_json::Value, key: &str) -> String {
    meta[key].as_str().unwrap_or("").to_string()
}

/// Simple string interpolation — replace each `(placeholder, value)` pair.
fn interpolate(template: &str, pairs: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (placeholder, value) in pairs {
        out = out.replace(placeholder, value);
    }
    out
}

/// Parse a JSON array of task strings into a numbered markdown list.
fn parse_tasks(tasks_json: Option<&str>) -> String {
    let Some(json) = tasks_json else {
        return "No specific tasks assigned — perform a full review.".to_string();
    };
    let Ok(arr) = serde_json::from_str::<Vec<String>>(json) else {
        // Treat as plain text if not valid JSON
        return json.to_string();
    };
    if arr.is_empty() {
        return "No specific tasks assigned — perform a full review.".to_string();
    }
    arr.iter()
        .enumerate()
        .map(|(i, t)| format!("{}. {t}", i + 1))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Collect all agent reviews from the results directory.
///
/// Looks for `*-review.md` files and builds a concatenated section.
fn collect_reviews(results: &Path) -> String {
    let known_agents = ["claude", "codex", "gemini", "opencode"];
    let mut out = String::new();
    for agent in &known_agents {
        let path = results.join(format!("{agent}-review.md"));
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                out.push_str(&format!("### {} Review\n\n", capitalize(agent)));
                out.push_str(&content);
                out.push_str("\n\n---\n\n");
            }
        }
    }

    // Also pick up any other *-review.md files not in the known list
    if let Ok(entries) = std::fs::read_dir(results) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.ends_with("-review.md") {
                let agent_name = name_str.trim_end_matches("-review.md");
                if !known_agents.contains(&agent_name) {
                    if let Ok(content) = std::fs::read_to_string(entry.path()) {
                        out.push_str(&format!("### {} Review\n\n", capitalize(agent_name)));
                        out.push_str(&content);
                        out.push_str("\n\n---\n\n");
                    }
                }
            }
        }
    }

    if out.is_empty() {
        "(No agent reviews found.)".to_string()
    } else {
        out
    }
}

/// Collect Q&A round history from `arbiter-log.md` or individual round files.
fn collect_round_history(results: &Path) -> String {
    // Prefer an explicit log file
    let log_path = results.join("arbiter-log.md");
    if log_path.exists() {
        return read_if_exists(&log_path);
    }

    // Otherwise accumulate round question/answer pairs
    let mut history = String::new();
    let mut round = 1u32;
    loop {
        let mut found_any = false;
        for agent in &["claude", "codex", "gemini", "opencode"] {
            let q_path = results.join(format!("round-{round}-{agent}-question.md"));
            let a_path = results.join(format!("round-{round}-{agent}-answer.md"));
            if q_path.exists() || a_path.exists() {
                found_any = true;
                history.push_str(&format!("### Round {round} — {}\n\n", capitalize(agent)));
                if q_path.exists() {
                    history.push_str("**Questions:**\n\n");
                    history.push_str(&read_if_exists(&q_path));
                    history.push('\n');
                }
                if a_path.exists() {
                    history.push_str("**Answers:**\n\n");
                    history.push_str(&read_if_exists(&a_path));
                    history.push('\n');
                }
                history.push_str("\n---\n\n");
            }
        }
        if !found_any {
            break;
        }
        round += 1;
    }

    if history.is_empty() {
        "(No Q&A rounds yet.)".to_string()
    } else {
        history
    }
}

/// Extract the "Review Tasks" section from a context-manifest.md, if present.
fn extract_tasks_from_manifest(manifest: &str) -> String {
    if manifest.is_empty() {
        return "No specific tasks assigned — perform a full review.".to_string();
    }
    // Find "## Review Tasks" section and return its content
    if let Some(start) = manifest.find("## Review Tasks") {
        let section = &manifest[start..];
        // Find the next `##` heading (if any) to bound the section
        let content = if let Some(next) = section[3..].find("\n## ") {
            &section[..next + 3]
        } else {
            section
        };
        // Strip the heading line itself
        let body = content
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string();
        if body.is_empty() || body == "(none yet)" {
            return "No specific tasks assigned — perform a full review.".to_string();
        }
        return body;
    }
    "No specific tasks assigned — perform a full review.".to_string()
}

/// Determine the next round number for an agent by scanning existing files.
fn next_round_number(results: &Path, agent: &str) -> u32 {
    let mut n = 1u32;
    loop {
        let path = results.join(format!("round-{n}-{agent}-question.md"));
        if !path.exists() {
            return n;
        }
        n += 1;
    }
}

/// Parse arbiter questions JSON for a specific agent.
///
/// Accepts two shapes:
/// - `{"claude": ["q1", "q2"], "codex": [...]}` — keyed by agent name
/// - `["q1", "q2"]` — plain array (assumed to be for this agent)
fn parse_questions_for_agent(json: &str, agent: &str) -> String {
    // Try keyed object first
    if let Ok(obj) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(json) {
        if let Some(arr) = obj.get(agent).and_then(|v| v.as_array()) {
            return format_question_list(arr);
        }
        // Return all questions concatenated if agent key not found
        let all: Vec<_> = obj
            .values()
            .filter_map(|v| v.as_array())
            .flatten()
            .collect();
        if !all.is_empty() {
            return format_question_list(&all.into_iter().cloned().collect::<Vec<_>>());
        }
    }

    // Try plain array
    if let Ok(arr) = serde_json::from_str::<Vec<String>>(json) {
        return arr
            .iter()
            .enumerate()
            .map(|(i, q)| format!("{}. {q}", i + 1))
            .collect::<Vec<_>>()
            .join("\n");
    }

    // Fallback: treat as plain text
    json.to_string()
}

fn format_question_list(arr: &[serde_json::Value]) -> String {
    arr.iter()
        .enumerate()
        .map(|(i, q)| format!("{}. {}", i + 1, q.as_str().unwrap_or("")))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Extract a `owner/repo` slug from a GitHub PR URL.
///
/// `https://github.com/owner/repo/pull/N` → `owner/repo`
fn repo_from_url(url: &str) -> String {
    // Strip https://github.com/ prefix and take first two path segments
    let stripped = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("github.com/");
    let parts: Vec<&str> = stripped.splitn(3, '/').collect();
    if parts.len() >= 2 {
        format!("{}/{}", parts[0], parts[1])
    } else {
        url.to_string()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_capitalize() {
        assert_eq!(capitalize("claude"), "Claude");
        assert_eq!(capitalize(""), "");
        assert_eq!(capitalize("x"), "X");
        assert_eq!(capitalize("already"), "Already");
    }

    #[test]
    fn test_interpolate() {
        let tmpl = "Hello {{name}}, you have {{count}} messages.";
        let result = interpolate(tmpl, &[("{{name}}", "Alice"), ("{{count}}", "3")]);
        assert_eq!(result, "Hello Alice, you have 3 messages.");
    }

    #[test]
    fn test_parse_tasks_none() {
        let t = parse_tasks(None);
        assert!(t.contains("full review"));
    }

    #[test]
    fn test_parse_tasks_json_array() {
        let t = parse_tasks(Some(r#"["Check auth", "Verify migrations"]"#));
        assert!(t.contains("1. Check auth"));
        assert!(t.contains("2. Verify migrations"));
    }

    #[test]
    fn test_parse_tasks_empty_array() {
        let t = parse_tasks(Some("[]"));
        assert!(t.contains("full review"));
    }

    #[test]
    fn test_repo_from_url() {
        assert_eq!(
            repo_from_url("https://github.com/owner/myrepo/pull/42"),
            "owner/myrepo"
        );
        assert_eq!(repo_from_url("https://github.com/a/b"), "a/b");
    }

    #[test]
    fn test_parse_questions_keyed() {
        let json = r#"{"claude": ["What about line 10?", "Did you check auth?"]}"#;
        let q = parse_questions_for_agent(json, "claude");
        assert!(q.contains("1. What about line 10?"));
        assert!(q.contains("2. Did you check auth?"));
    }

    #[test]
    fn test_parse_questions_plain_array() {
        let json = r#"["Q one", "Q two"]"#;
        let q = parse_questions_for_agent(json, "codex");
        assert!(q.contains("1. Q one"));
        assert!(q.contains("2. Q two"));
    }

    #[test]
    fn test_read_if_exists_missing() {
        let p = Path::new("/tmp/does-not-exist-prr-test-12345.txt");
        assert_eq!(read_if_exists(p), "");
    }

    #[test]
    fn test_extract_tasks_from_manifest_empty() {
        let t = extract_tasks_from_manifest("");
        assert!(t.contains("full review"));
    }

    #[test]
    fn test_extract_tasks_from_manifest_with_tasks() {
        let manifest = "# Context\n\n## Review Tasks\n\n1. Check migrations\n2. Verify auth\n";
        let t = extract_tasks_from_manifest(manifest);
        assert!(t.contains("Check migrations"));
        assert!(t.contains("Verify auth"));
    }

    #[test]
    fn test_next_round_number_no_files() {
        let dir = std::env::temp_dir();
        assert_eq!(next_round_number(&dir, "claude-nonexistent"), 1);
    }

    #[test]
    fn test_collect_reviews_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let reviews = collect_reviews(dir.path());
        assert!(reviews.contains("No agent reviews found"));
    }

    #[test]
    fn test_collect_reviews_with_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("claude-review.md"), "## Verdict\n\nAPPROVE\n").unwrap();
        let reviews = collect_reviews(dir.path());
        assert!(reviews.contains("Claude Review"));
        assert!(reviews.contains("APPROVE"));
    }

    #[test]
    fn test_build_review_writes_output() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        std::fs::create_dir_all(base.join("results")).unwrap();
        std::fs::create_dir_all(base.join("context")).unwrap();

        let meta = serde_json::json!({
            "number": 99,
            "title": "Test PR",
            "url": "https://github.com/owner/repo/pull/99",
            "author": {"login": "testuser"},
            "headRefName": "feat/test",
            "baseRefName": "main",
            "body": "PROJ-123 test body"
        });
        std::fs::write(
            base.join("results/pr-metadata.json"),
            serde_json::to_string(&meta).unwrap(),
        )
        .unwrap();
        std::fs::write(base.join("results/diff.txt"), "diff content").unwrap();
        std::fs::write(base.join("results/changed-files.txt"), "src/main.rs").unwrap();

        build_review(base.to_str().unwrap(), None).unwrap();

        let out = std::fs::read_to_string(base.join("results/review-prompt.md")).unwrap();
        assert!(out.contains("Test PR"));
        assert!(out.contains("testuser"));
        assert!(out.contains("feat/test"));
        assert!(out.contains("diff content"));
    }

    #[test]
    fn test_build_arbiter_writes_output() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        std::fs::create_dir_all(base.join("results")).unwrap();

        let meta = serde_json::json!({
            "number": 7,
            "title": "Arbiter Test",
            "url": "https://github.com/acme/proj/pull/7",
            "author": {"login": "dev"},
            "headRefName": "fix/bug",
            "baseRefName": "main",
            "body": ""
        });
        std::fs::write(
            base.join("results/pr-metadata.json"),
            serde_json::to_string(&meta).unwrap(),
        )
        .unwrap();
        std::fs::write(
            base.join("results/claude-review.md"),
            "## Verdict\n\nAPPROVE\n",
        )
        .unwrap();

        build_arbiter(base.to_str().unwrap()).unwrap();

        let out = std::fs::read_to_string(base.join("results/arbiter-prompt.md")).unwrap();
        assert!(out.contains("Arbiter Test"));
        assert!(out.contains("Claude Review"));
        assert!(out.contains("APPROVE"));
    }

    #[test]
    fn test_build_question_writes_output() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        std::fs::create_dir_all(base.join("results")).unwrap();

        let meta = serde_json::json!({
            "number": 3,
            "title": "Question Test",
            "url": "https://github.com/x/y/pull/3",
            "author": {"login": "qa"},
            "headRefName": "feat/q",
            "baseRefName": "main",
            "body": ""
        });
        std::fs::write(
            base.join("results/pr-metadata.json"),
            serde_json::to_string(&meta).unwrap(),
        )
        .unwrap();
        std::fs::write(
            base.join("results/claude-review.md"),
            "My prior review text.",
        )
        .unwrap();

        let questions = r#"{"claude": ["Did you check line 42?"]}"#;
        build_question(base.to_str().unwrap(), "claude", questions).unwrap();

        let out_path = base.join("results/round-1-claude-question.md");
        assert!(out_path.exists());
        let out = std::fs::read_to_string(&out_path).unwrap();
        assert!(out.contains("Did you check line 42?"));
        assert!(out.contains("My prior review text."));
    }
}
