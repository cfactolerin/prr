use crate::{config::Config, html, jira};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
struct Snapshot {
    source: String,
    #[serde(default)]
    site_url: Option<String>,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    ticket: Value,
    #[serde(default)]
    pages: Vec<Page>,
    #[serde(default)]
    links: Vec<String>,
    #[serde(default)]
    notes: Vec<String>,
    #[serde(default)]
    incomplete: bool,
}

#[derive(Deserialize)]
struct Page {
    url: String,
    content: Value,
}

pub fn run(round: &str) -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::load()?;
    run_with_config(&config, Path::new(round))
}

fn run_with_config(config: &Config, requested: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let round = validated_round(&config.expanded_workspace_path(), requested)?;
    let results = round.join("results");
    let context = round.join("context");
    let manifest_path = round.join("context-manifest.md");
    let manifest = std::fs::read_to_string(&manifest_path)?;
    if let Some((_, saved)) = manifest.split_once("\n## Atlassian Context\n") {
        println!("{}", saved.trim());
        return Ok(());
    }
    let snapshot_path = results.join("atlassian-context.json");
    reject_symlink(&snapshot_path)?;
    if std::fs::metadata(&snapshot_path)?.len() > 24 * 1024 * 1024 {
        return Err("Atlassian context snapshot exceeds 24 MiB".into());
    }
    let snapshot: Snapshot = serde_json::from_str(&std::fs::read_to_string(snapshot_path)?)?;
    let ticket_id = std::fs::read_to_string(results.join("ticket-id.txt"))?;
    let ticket_id = ticket_id.trim();
    let mut notes = snapshot.notes.clone();
    let mut source = "none";

    if ticket_id != "none" && !ticket_id.is_empty() {
        if snapshot.source == "mcp" {
            write_mcp_context(&snapshot, ticket_id, &context)?;
            source = "Atlassian MCP";
        } else if snapshot.source != "unavailable" {
            return Err("Unknown Atlassian context source".into());
        }
        if source == "none" || snapshot.incomplete {
            if !snapshot.reason.is_empty() {
                notes.push(snapshot.reason.clone());
            }
            let fallback_matches = snapshot.site_url.as_deref().map(|site| same_site(site, &config.jira_base_url)).unwrap_or(true);
            if !fallback_matches && !config.jira_base_url.is_empty() {
                notes.push("Jira API token fallback belongs to a different Atlassian site".into());
            } else if let Some(client) = jira::JiraClient::new(config) {
                let staging = tempfile::tempdir_in(&results)?;
                match client.fetch_ticket(ticket_id, staging.path()) {
                    Ok(()) => {
                        let links: Vec<_> = snapshot.links.iter().take(20)
                            .filter(|url| same_site(url, &config.jira_base_url)).cloned().collect();
                        if !links.is_empty() {
                            client.fetch_confluence_pages(&links.join("\n"), staging.path())?;
                        }
                        merge_rest_context(staging.path(), &context, source != "none")?;
                        source = if source == "none" { "Jira API token" } else { "Atlassian MCP + Jira API token fallback" };
                    }
                    Err(_) => notes.push("Jira API token fallback could not fetch the ticket".into()),
                }
            } else {
                notes.push("Jira API token fallback is not configured".into());
            }
        }
    }

    let mut summary = format!("- Source: {source}\n");
    if context.join("ticket-context.md").is_file() {
        summary.push_str("- Jira ticket: fetched\n");
    } else if ticket_id != "none" && !ticket_id.is_empty() {
        summary.push_str("- Jira ticket: unavailable\n");
    } else {
        summary.push_str("- Jira ticket: none detected\n");
    }
    for (label, directory) in [("Confluence pages", "confluence"), ("Attachments", "attachments")] {
        let count = std::fs::read_dir(context.join(directory)).map(|items| items.count()).unwrap_or(0);
        summary.push_str(&format!("- {label}: {count}\n"));
    }
    for note in notes {
        summary.push_str(&format!("- Note: {}\n", note.replace(['\n', '\r'], " ")));
    }
    std::fs::write(manifest_path, format!("{manifest}\n## Atlassian Context\n\n{summary}"))?;
    println!("{summary}");
    Ok(())
}

fn same_site(left: &str, right: &str) -> bool {
    match (reqwest::Url::parse(left), reqwest::Url::parse(right)) {
        (Ok(left), Ok(right)) => left.origin() == right.origin(),
        _ => false,
    }
}

fn merge_rest_context(staging: &Path, context: &Path, preserve_mcp: bool) -> Result<(), Box<dyn std::error::Error>> {
    for directory in ["confluence", "attachments"] {
        let from = staging.join(directory);
        if !from.is_dir() {
            continue;
        }
        let to = context.join(directory);
        reject_symlink(&to)?;
        std::fs::create_dir_all(&to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let destination = to.join(entry.file_name());
            if !entry.file_type()?.is_file() {
                return Err("Unexpected Jira API context artifact".into());
            }
            reject_symlink(&destination)?;
            std::fs::copy(entry.path(), destination)?;
        }
    }
    let destination = context.join("ticket-context.md");
    reject_symlink(&destination)?;
    let rest = std::fs::read_to_string(staging.join("ticket-context.md"))?;
    let text = if preserve_mcp {
        format!("{}\n## Jira API Fallback Context\n\n{rest}", std::fs::read_to_string(&destination)?)
    } else {
        rest
    };
    std::fs::write(destination, text)?;
    Ok(())
}

fn validated_round(workspace: &Path, requested: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let workspace = workspace.canonicalize()?;
    let round = requested.canonicalize()?;
    let relative = round.strip_prefix(&workspace).map_err(|_| "Round is outside the PRR workspace")?;
    let parts: Vec<_> = relative.components().collect();
    let name = round.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if parts.len() != 2 || !name.starts_with('r') || name[1..].is_empty() || !name[1..].chars().all(|c| c.is_ascii_digit()) {
        return Err("Not a PRR round directory".into());
    }
    for path in ["results", "context", "results/ticket-id.txt", "context-manifest.md", "context/confluence", "context/attachments", "context/ticket-context.md"] {
        reject_symlink(&round.join(path))?;
    }
    if round.join("results/review-prompt.md").exists() {
        return Err("Atlassian context must be gathered before reviewer prompts are built".into());
    }
    Ok(round)
}

fn reject_symlink(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    if std::fs::symlink_metadata(path).map(|meta| meta.file_type().is_symlink()).unwrap_or(false) {
        return Err("Atlassian context paths must not be symbolic links".into());
    }
    Ok(())
}

fn rich_text(value: &Value) -> String {
    if jira::is_adf(value) {
        jira::adf_to_text(value)
    } else if let Some(text) = value.as_str() {
        if text.contains("<p") || text.contains("<h") || text.contains("<div") {
            html::html_to_markdown(text)
        } else {
            text.to_string()
        }
    } else {
        String::new()
    }
}

fn write_mcp_context(snapshot: &Snapshot, ticket_id: &str, context: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let ticket = &snapshot.ticket;
    let key = ticket["key"].as_str().or_else(|| ticket["issueKey"].as_str()).unwrap_or("");
    if !key.eq_ignore_ascii_case(ticket_id) || snapshot.pages.len() > 20 {
        return Err("Atlassian snapshot does not match the detected ticket".into());
    }
    let fields = ticket.get("fields").unwrap_or(ticket);
    let summary = fields["summary"].as_str().ok_or("MCP ticket summary is missing")?;
    let mut text = format!("# {ticket_id}: {summary}\n\n## Description\n\n{}\n", rich_text(&fields["description"]));
    let pages_path = context.join("confluence");
    reject_symlink(&pages_path)?;
    if !snapshot.pages.is_empty() {
        std::fs::create_dir_all(&pages_path)?;
        text.push_str("\n## Linked Confluence Pages\n\n");
    }
    for (index, page) in snapshot.pages.iter().enumerate() {
        let title = page.content["title"].as_str().unwrap_or("Untitled");
        let body = &page.content["body"];
        let content = page.content.get("content").filter(|v| v.is_string())
            .or_else(|| body.get("value"))
            .or_else(|| body.pointer("/markdown/value"))
            .or_else(|| body.pointer("/storage/value"))
            .unwrap_or(body);
        let content = rich_text(content);
        if content.trim().is_empty() {
            return Err("MCP Confluence page body is missing".into());
        }
        let filename = format!("mcp-page-{}.md", index + 1);
        let destination = pages_path.join(&filename);
        reject_symlink(&destination)?;
        std::fs::write(destination, format!("# {title}\n\nSource: {}\n\n{content}", page.url))?;
        text.push_str(&format!("- [{title}](confluence/{filename}) — {}\n", page.url));
    }
    let attachments = fields.get("attachment").or_else(|| fields.get("attachments"));
    if attachments.and_then(|value| value.as_array()).is_some_and(|items| !items.is_empty()) {
        text.push_str("\n## Attachments\n\nAttachment metadata is included below. Attachment files are not downloaded through MCP.\n");
    }
    text.push_str("\n## Full Ticket Details\n\n```json\n");
    text.push_str(&serde_json::to_string_pretty(ticket)?);
    text.push_str("\n```\n");
    let destination = context.join("ticket-context.md");
    reject_symlink(&destination)?;
    std::fs::write(destination, text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn round_fixture(root: &Path, snapshot: Value) -> (Config, PathBuf) {
        let round = root.join("acme-repo-pr-1/r1");
        std::fs::create_dir_all(round.join("results")).unwrap();
        std::fs::create_dir_all(round.join("context")).unwrap();
        std::fs::write(round.join("results/ticket-id.txt"), "DI-123").unwrap();
        std::fs::write(round.join("results/pr-metadata.json"), r#"{"number":1,"title":"DI-123","url":"https://github.com/acme/repo/pull/1"}"#).unwrap();
        std::fs::write(round.join("results/atlassian-context.json"), serde_json::to_string(&snapshot).unwrap()).unwrap();
        std::fs::write(round.join("context-manifest.md"), "# Context Manifest\n").unwrap();
        let mut config = Config::default();
        config.workspace_path = root.display().to_string();
        (config, round)
    }

    #[test]
    fn imported_context_reaches_review_and_arbiter_prompts_without_api_credentials() {
        let root = tempfile::tempdir().unwrap();
        let (config, round) = round_fixture(root.path(), json!({
            "source": "mcp", "ticket": {"key":"DI-123", "fields":{"summary":"A change", "customFields":{"Acceptance Criteria":"Preserve ordering"}}}
        }));
        run_with_config(&config, &round).unwrap();
        assert!(std::fs::read_to_string(round.join("context-manifest.md")).unwrap().contains("Source: Atlassian MCP"));
        crate::prompt::build_review(&round.display().to_string(), None).unwrap();
        crate::prompt::build_arbiter(&round.display().to_string()).unwrap();
        for file in ["review-prompt.md", "arbiter-prompt.md"] {
            assert!(std::fs::read_to_string(round.join("results").join(file)).unwrap().contains("Preserve ordering"));
        }
        assert!(run_with_config(&config, &round).is_err());
    }

    #[test]
    fn missing_mcp_and_token_are_reported_without_claiming_a_fetched_ticket() {
        let root = tempfile::tempdir().unwrap();
        let (config, round) = round_fixture(root.path(), json!({"source":"unavailable", "reason":"MCP is not connected"}));
        run_with_config(&config, &round).unwrap();
        let manifest = std::fs::read_to_string(round.join("context-manifest.md")).unwrap();
        assert!(manifest.contains("Jira ticket: unavailable"));
        assert!(manifest.contains("MCP is not connected"));
        assert!(manifest.contains("fallback is not configured"));
        assert!(!round.join("context/ticket-context.md").exists());
    }

    #[test]
    fn context_import_rejects_rounds_outside_workspace() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        assert!(validated_round(root.path(), outside.path()).is_err());
    }

    #[test]
    fn rest_supplement_preserves_mcp_fields_and_pages() {
        let context = tempfile::tempdir().unwrap();
        let staging = tempfile::tempdir().unwrap();
        std::fs::write(context.path().join("ticket-context.md"), "MCP acceptance criteria").unwrap();
        std::fs::create_dir(context.path().join("confluence")).unwrap();
        std::fs::write(context.path().join("confluence/mcp-page-1.md"), "MCP requirements").unwrap();
        std::fs::create_dir(staging.path().join("confluence")).unwrap();
        std::fs::write(staging.path().join("confluence/page-2.md"), "REST requirements").unwrap();
        std::fs::write(staging.path().join("ticket-context.md"), "REST ticket").unwrap();
        merge_rest_context(staging.path(), context.path(), true).unwrap();
        let text = std::fs::read_to_string(context.path().join("ticket-context.md")).unwrap();
        assert!(text.contains("MCP acceptance criteria"));
        assert!(text.contains("REST ticket"));
        assert!(context.path().join("confluence/mcp-page-1.md").is_file());
        assert!(context.path().join("confluence/page-2.md").is_file());
    }

    #[test]
    fn rest_fallback_does_not_use_credentials_for_a_different_site() {
        assert!(same_site("https://company.atlassian.net/browse/DI-123", "https://company.atlassian.net/"));
        assert!(!same_site("https://company.atlassian.net", "https://other.atlassian.net"));
        let root = tempfile::tempdir().unwrap();
        let (mut config, round) = round_fixture(root.path(), json!({"source":"unavailable", "site_url":"https://company.atlassian.net"}));
        config.jira_base_url = "https://other.atlassian.net".into();
        config.jira_api_token = "test-token".into();
        run_with_config(&config, &round).unwrap();
        assert!(std::fs::read_to_string(round.join("context-manifest.md")).unwrap().contains("different Atlassian site"));
    }

    #[test]
    fn unavailable_mcp_uses_configured_api_token() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let response = json!({"key":"DI-123", "fields":{"summary":"REST ticket", "description":"REST requirements"}}).to_string();
        let request = std::thread::spawn(move || {
            let (mut connection, _) = server.accept().unwrap();
            connection.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut buffer = [0; 8192];
            let size = connection.read(&mut buffer).unwrap();
            let request = String::from_utf8_lossy(&buffer[..size]).to_string();
            write!(connection, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
            request
        });
        let root = tempfile::tempdir().unwrap();
        let (mut config, round) = round_fixture(root.path(), json!({"source":"unavailable", "reason":"MCP is not connected"}));
        config.jira_base_url = format!("http://{address}");
        config.jira_email = "reviewer@example.com".into();
        config.jira_api_token = "test-token".into();
        run_with_config(&config, &round).unwrap();
        let request = request.join().unwrap();
        assert!(request.starts_with("GET /rest/api/3/issue/DI-123?expand=renderedFields"));
        assert!(request.to_lowercase().contains("authorization: basic "));
        assert!(std::fs::read_to_string(round.join("context/ticket-context.md")).unwrap().contains("REST requirements"));
        assert!(std::fs::read_to_string(round.join("context-manifest.md")).unwrap().contains("Source: Jira API token"));
    }

    #[test]
    fn snapshot_preserves_custom_fields_and_linked_page_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot: Snapshot = serde_json::from_value(json!({
            "source": "mcp",
            "ticket": {"key": "DI-123", "fields": {"summary": "A ticket", "description": "Description", "customFields": {"Acceptance Criteria": "Must work"}}},
            "pages": [{"url": "https://example.atlassian.net/wiki/x/abc", "content": {"title": "Requirements", "body": {"value": "Full requirements", "representation": "markdown"}}}]
        })).unwrap();
        write_mcp_context(&snapshot, "DI-123", dir.path()).unwrap();
        let text = std::fs::read_to_string(dir.path().join("ticket-context.md")).unwrap();
        assert!(text.contains("Must work"));
        assert!(text.contains("confluence/mcp-page-1.md"));
        assert!(std::fs::read_to_string(dir.path().join("confluence/mcp-page-1.md")).unwrap().contains("Full requirements"));
    }

    #[test]
    fn snapshot_rejects_wrong_ticket() {
        let dir = tempfile::tempdir().unwrap();
        let snapshot: Snapshot = serde_json::from_value(json!({"source": "mcp", "ticket": {"key": "OTHER-1"}})).unwrap();
        assert!(write_mcp_context(&snapshot, "DI-123", dir.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_rejects_symlinked_context_output() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("ticket-context.md")).unwrap();
        let snapshot: Snapshot = serde_json::from_value(json!({"source": "mcp", "ticket": {"key": "DI-123", "summary": "Summary"}})).unwrap();
        assert!(write_mcp_context(&snapshot, "DI-123", dir.path()).is_err());
        assert_eq!(std::fs::read_to_string(outside.path()).unwrap(), "");
    }
}
