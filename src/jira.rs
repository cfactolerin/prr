// Jira integration module

use std::path::Path;
use serde_json::Value;
use regex::Regex;
use base64::Engine;

use crate::config::Config;
use crate::html;

pub const MAX_ATTACHMENT_SIZE: u64 = 10_000_000; // 10 MB

// ── ADF helpers ───────────────────────────────────────────────────────────────

/// Returns true if the JSON value looks like an Atlassian Document Format doc.
pub fn is_adf(val: &Value) -> bool {
    val.is_object() && val.get("type").and_then(|t| t.as_str()) == Some("doc")
}

/// Recursively convert an ADF node to plain text / markdown.
pub fn adf_to_text(node: &Value) -> String {
    let node_type = node.get("type").and_then(|t| t.as_str()).unwrap_or("");

    match node_type {
        "text" => node.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),

        "hardBreak" => "\n".to_string(),

        "paragraph" => {
            let inner = adf_children_text(node);
            format!("{inner}\n\n")
        }

        "heading" => {
            let level = node
                .get("attrs")
                .and_then(|a| a.get("level"))
                .and_then(|l| l.as_u64())
                .unwrap_or(1) as usize;
            let hashes = "#".repeat(level);
            let inner = adf_children_text(node);
            format!("{hashes} {inner}\n\n")
        }

        "bulletList" => {
            let mut out = String::new();
            if let Some(items) = node.get("content").and_then(|c| c.as_array()) {
                for item in items {
                    // Each listItem may contain paragraphs; strip trailing \n\n
                    let text = adf_children_text(item).trim_end().to_string();
                    out.push_str(&format!("- {text}\n"));
                }
            }
            out
        }

        "orderedList" => {
            let mut out = String::new();
            if let Some(items) = node.get("content").and_then(|c| c.as_array()) {
                for (i, item) in items.iter().enumerate() {
                    let text = adf_children_text(item).trim_end().to_string();
                    out.push_str(&format!("{}. {text}\n", i + 1));
                }
            }
            out
        }

        "listItem" => adf_children_text(node),

        "codeBlock" => {
            let lang = node
                .get("attrs")
                .and_then(|a| a.get("language"))
                .and_then(|l| l.as_str())
                .unwrap_or("");
            let inner = adf_children_text(node);
            format!("```{lang}\n{inner}\n```\n\n")
        }

        "inlineCard" | "blockCard" => {
            node.get("attrs")
                .and_then(|a| a.get("url"))
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string()
        }

        // Default: recurse into children
        _ => adf_children_text(node),
    }
}

/// Map `adf_to_text` over the `content` array of a node.
pub fn adf_children_text(node: &Value) -> String {
    node.get("content")
        .and_then(|c| c.as_array())
        .map(|arr| arr.iter().map(adf_to_text).collect::<String>())
        .unwrap_or_default()
}

// ── Confluence URL helpers ────────────────────────────────────────────────────

/// Extract all Confluence page URLs from arbitrary text.
/// Matches both standard URLs (`/wiki/spaces/…/pages/…`) and short links (`/wiki/x/…`).
pub fn extract_confluence_urls(text: &str) -> Vec<String> {
    let re = Regex::new(r"https?://[^/]*atlassian\.net/wiki/(?:spaces/[^\s)\]]+|x/[^\s)\]]+)").unwrap();
    re.find_iter(text)
        .map(|m| m.as_str().to_string())
        .collect()
}

/// Returns true if the URL is a Confluence short link (`/wiki/x/…`).
pub fn is_confluence_short_link(url: &str) -> bool {
    url.contains("/wiki/x/")
}

/// Extract the numeric page ID from a Confluence URL.
pub fn extract_confluence_page_id(url: &str) -> Option<String> {
    let re = Regex::new(r"/pages/(\d+)").unwrap();
    re.captures(url)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().to_string())
}

// ── JiraClient ────────────────────────────────────────────────────────────────

pub struct JiraClient {
    base_url: String,
    auth_header: String,
    http: reqwest::blocking::Client,
}

impl JiraClient {
    /// Build a new client. Returns `None` if Jira credentials are missing.
    pub fn new(config: &Config) -> Option<Self> {
        if config.jira_base_url.is_empty() || config.jira_api_token.is_empty() {
            return None;
        }

        let credentials = format!("{}:{}", config.jira_email, config.jira_api_token);
        let encoded = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());
        let auth_header = format!("Basic {encoded}");

        let http = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .ok()?;

        Some(Self {
            base_url: config.jira_base_url.trim_end_matches('/').to_string(),
            auth_header,
            http,
        })
    }

    /// Fetch a Jira ticket and write `ticket-context.md` to `context_dir`.
    pub fn fetch_ticket(
        &self,
        ticket_id: &str,
        context_dir: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let url = format!(
            "{}/rest/api/3/issue/{}?expand=renderedFields",
            self.base_url, ticket_id
        );

        let resp = self
            .http
            .get(&url)
            .header("Authorization", &self.auth_header)
            .header("Accept", "application/json")
            .send()?;

        if !resp.status().is_success() {
            return Err(format!(
                "Jira API returned {} for {ticket_id}",
                resp.status()
            )
            .into());
        }

        let body: Value = resp.json()?;
        let fields = &body["fields"];

        // ── Basic metadata ────────────────────────────────────────────────
        let summary = fields["summary"].as_str().unwrap_or("(no summary)");
        let issue_type = fields["issuetype"]["name"].as_str().unwrap_or("Unknown");
        let status = fields["status"]["name"].as_str().unwrap_or("Unknown");
        let priority = fields["priority"]["name"].as_str().unwrap_or("Unknown");
        let assignee = fields["assignee"]["displayName"]
            .as_str()
            .unwrap_or("Unassigned");
        let labels: Vec<&str> = fields["labels"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        let labels_str = if labels.is_empty() {
            "none".to_string()
        } else {
            labels.join(", ")
        };

        // ── Description ───────────────────────────────────────────────────
        let description = self.extract_description(fields, &body);

        // ── Acceptance criteria ───────────────────────────────────────────
        let acceptance_criteria = self.extract_acceptance_criteria(fields);

        // ── Attachments ───────────────────────────────────────────────────
        let attachments_section = self.download_attachments(fields, context_dir)?;

        // ── Confluence pages ──────────────────────────────────────────────
        let all_text = format!("{description}\n{acceptance_criteria}\n{attachments_section}");
        let confluence_section = self.fetch_confluence_pages(&all_text, context_dir)?;

        // ── Comments ──────────────────────────────────────────────────────
        let comments_section = self.extract_comments(fields);

        // ── Build ticket-context.md ───────────────────────────────────────
        let mut md = String::new();
        md.push_str(&format!("# {ticket_id}: {summary}\n\n"));
        md.push_str(&format!("- **Type:** {issue_type}\n"));
        md.push_str(&format!("- **Status:** {status}\n"));
        md.push_str(&format!("- **Priority:** {priority}\n"));
        md.push_str(&format!("- **Assignee:** {assignee}\n"));
        md.push_str(&format!("- **Labels:** {labels_str}\n"));
        md.push('\n');

        md.push_str("## Description\n");
        md.push_str(&description);
        md.push('\n');

        if !acceptance_criteria.is_empty() {
            md.push_str("## Acceptance Criteria\n");
            md.push_str(&acceptance_criteria);
            md.push('\n');
        }

        if !attachments_section.is_empty() {
            md.push_str("## Attachments\n");
            md.push_str(&attachments_section);
            md.push('\n');
        }

        if !confluence_section.is_empty() {
            md.push_str("## Linked Confluence Pages\n");
            md.push_str(&confluence_section);
            md.push('\n');
        }

        if !comments_section.is_empty() {
            md.push_str("## Comments\n");
            md.push_str(&comments_section);
        }

        std::fs::create_dir_all(context_dir)?;
        let out_path = context_dir.join("ticket-context.md");
        std::fs::write(&out_path, md)?;

        Ok(())
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    fn extract_description(&self, fields: &Value, body: &Value) -> String {
        let desc_field = &fields["description"];
        if is_adf(desc_field) {
            adf_to_text(desc_field)
        } else if let Some(rendered) = body["renderedFields"]["description"].as_str() {
            html::html_to_markdown(rendered)
        } else if let Some(plain) = desc_field.as_str() {
            plain.to_string()
        } else {
            String::new()
        }
    }

    pub fn extract_acceptance_criteria(&self, fields: &Value) -> String {
        // Jira uses different custom field IDs across instances; try common ones.
        for field_key in &["customfield_10020", "customfield_10024"] {
            let val = &fields[field_key];
            if val.is_null() {
                continue;
            }
            if is_adf(val) {
                return adf_to_text(val);
            }
            if let Some(s) = val.as_str() {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
        String::new()
    }

    pub fn download_attachments(
        &self,
        fields: &Value,
        context_dir: &Path,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let attachments = match fields["attachment"].as_array() {
            Some(arr) => arr,
            None => return Ok(String::new()),
        };

        let attach_dir = context_dir.join("attachments");
        std::fs::create_dir_all(&attach_dir)?;

        let mut lines = String::new();

        for att in attachments {
            let filename = att["filename"].as_str().unwrap_or("attachment");
            let content_url = match att["content"].as_str() {
                Some(u) => u,
                None => continue,
            };
            let size = att["size"].as_u64().unwrap_or(0);

            if size > MAX_ATTACHMENT_SIZE {
                lines.push_str(&format!("- {filename} (skipped — too large)\n"));
                continue;
            }

            let dest = attach_dir.join(filename);
            match self.download_file(content_url, &dest) {
                Ok(()) => {
                    lines.push_str(&format!("- [{filename}](attachments/{filename})\n"));
                }
                Err(e) => {
                    lines.push_str(&format!("- {filename} (download failed: {e})\n"));
                }
            }
        }

        Ok(lines)
    }

    fn download_file(&self, url: &str, dest: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let bytes = self
            .http
            .get(url)
            .header("Authorization", &self.auth_header)
            .send()?
            .bytes()?;
        std::fs::write(dest, &bytes)?;
        Ok(())
    }

    pub fn fetch_confluence_pages(
        &self,
        text: &str,
        context_dir: &Path,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let urls = extract_confluence_urls(text);
        if urls.is_empty() {
            return Ok(String::new());
        }

        let conf_dir = context_dir.join("confluence");
        std::fs::create_dir_all(&conf_dir)?;

        let mut lines = String::new();

        for url in &urls {
            // Try to extract page ID directly; fall back to resolving short links
            let page_id = if let Some(id) = extract_confluence_page_id(url) {
                id
            } else if is_confluence_short_link(url) {
                match self.resolve_confluence_short_link(url) {
                    Ok(id) => id,
                    Err(e) => {
                        lines.push_str(&format!(
                            "- {url} (failed to resolve short link: {e})\n"
                        ));
                        continue;
                    }
                }
            } else {
                continue;
            };

            match self.fetch_confluence_page(&page_id, &conf_dir) {
                Ok(title) => {
                    lines.push_str(&format!(
                        "- [{title}](confluence/page-{page_id}.md)\n"
                    ));
                }
                Err(e) => {
                    lines.push_str(&format!("- page {page_id} (fetch failed: {e})\n"));
                }
            }
        }

        Ok(lines)
    }

    /// Resolve a Confluence short link (`/wiki/x/…`) by following the redirect
    /// and extracting the page ID from the final URL.
    fn resolve_confluence_short_link(
        &self,
        short_url: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        // Build a non-redirect-following client to capture the Location header,
        // or just follow redirects and inspect the final URL.
        let resp = self
            .http
            .get(short_url)
            .header("Authorization", &self.auth_header)
            .send()?;

        let final_url = resp.url().to_string();

        extract_confluence_page_id(&final_url).ok_or_else(|| {
            format!("Could not extract page ID from resolved URL: {final_url}").into()
        })
    }

    fn fetch_confluence_page(
        &self,
        page_id: &str,
        conf_dir: &Path,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let api_url = format!(
            "{}/wiki/rest/api/content/{}?expand=body.storage,title",
            self.base_url, page_id
        );

        let resp = self
            .http
            .get(&api_url)
            .header("Authorization", &self.auth_header)
            .header("Accept", "application/json")
            .send()?;

        if !resp.status().is_success() {
            return Err(format!("Confluence API returned {}", resp.status()).into());
        }

        let body: Value = resp.json()?;
        let title = body["title"].as_str().unwrap_or("Untitled").to_string();
        let html_content = body["body"]["storage"]["value"]
            .as_str()
            .unwrap_or("");

        let md_content = html::html_to_markdown(html_content);

        let out_path = conf_dir.join(format!("page-{page_id}.md"));
        let md = format!("# {title}\n\n{md_content}");
        std::fs::write(out_path, md)?;

        Ok(title)
    }

    pub fn extract_comments(&self, fields: &Value) -> String {
        let comments = match fields["comment"]["comments"].as_array() {
            Some(arr) => arr,
            None => return String::new(),
        };

        let mut out = String::new();

        for comment in comments {
            let author = comment["author"]["displayName"]
                .as_str()
                .unwrap_or("Unknown");
            let created = comment["created"].as_str().unwrap_or("");
            // Date portion only (ISO 8601 starts with YYYY-MM-DD)
            let date = &created[..created.len().min(10)];

            let body_val = &comment["body"];
            let body_text = if is_adf(body_val) {
                adf_to_text(body_val)
            } else if let Some(s) = body_val.as_str() {
                s.to_string()
            } else {
                String::new()
            };

            out.push_str(&format!("### {author} ({date})\n{body_text}\n"));
        }

        out
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_adf_text_node() {
        let node = json!({"type": "text", "text": "hello"});
        assert_eq!(adf_to_text(&node), "hello");
    }

    #[test]
    fn test_adf_paragraph() {
        let node = json!({
            "type": "paragraph",
            "content": [{"type": "text", "text": "hello world"}]
        });
        assert_eq!(adf_to_text(&node), "hello world\n\n");
    }

    #[test]
    fn test_adf_heading() {
        let node = json!({
            "type": "heading",
            "attrs": {"level": 2},
            "content": [{"type": "text", "text": "Title"}]
        });
        assert_eq!(adf_to_text(&node), "## Title\n\n");
    }

    #[test]
    fn test_adf_bullet_list() {
        let node = json!({
            "type": "bulletList",
            "content": [
                {"type": "listItem", "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "item one"}]}
                ]},
                {"type": "listItem", "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "item two"}]}
                ]}
            ]
        });
        let result = adf_to_text(&node);
        assert!(result.contains("- item one"));
        assert!(result.contains("- item two"));
    }

    #[test]
    fn test_adf_code_block() {
        let node = json!({
            "type": "codeBlock",
            "attrs": {"language": "python"},
            "content": [{"type": "text", "text": "print('hi')"}]
        });
        assert!(adf_to_text(&node).contains("```python"));
        assert!(adf_to_text(&node).contains("print('hi')"));
    }

    #[test]
    fn test_adf_inline_card() {
        let node = json!({"type": "inlineCard", "attrs": {"url": "https://example.com"}});
        assert_eq!(adf_to_text(&node), "https://example.com");
    }

    #[test]
    fn test_adf_hard_break() {
        let node = json!({"type": "hardBreak"});
        assert_eq!(adf_to_text(&node), "\n");
    }

    #[test]
    fn test_is_adf() {
        let adf = json!({"type": "doc", "content": []});
        let plain = json!("plain string");
        assert!(is_adf(&adf));
        assert!(!is_adf(&plain));
    }

    #[test]
    fn test_detect_confluence_urls() {
        let text = "See https://myco.atlassian.net/wiki/spaces/ENG/pages/12345 for details";
        let urls = extract_confluence_urls(text);
        assert_eq!(urls.len(), 1);
        assert!(urls[0].contains("pages/12345"));
    }

    #[test]
    fn test_extract_page_id() {
        assert_eq!(
            extract_confluence_page_id(
                "https://myco.atlassian.net/wiki/spaces/ENG/pages/12345/Title"
            ),
            Some("12345".into())
        );
    }

    // ── Additional coverage ───────────────────────────────────────────────────

    #[test]
    fn test_adf_ordered_list() {
        let node = json!({
            "type": "orderedList",
            "content": [
                {"type": "listItem", "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "first"}]}
                ]},
                {"type": "listItem", "content": [
                    {"type": "paragraph", "content": [{"type": "text", "text": "second"}]}
                ]}
            ]
        });
        let result = adf_to_text(&node);
        assert!(result.contains("1. first"));
        assert!(result.contains("2. second"));
    }

    #[test]
    fn test_adf_block_card() {
        let node = json!({"type": "blockCard", "attrs": {"url": "https://jira.example.com/browse/FOO-1"}});
        assert_eq!(
            adf_to_text(&node),
            "https://jira.example.com/browse/FOO-1"
        );
    }

    #[test]
    fn test_adf_doc_recurses() {
        let node = json!({
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [{"type": "text", "text": "body text"}]}
            ]
        });
        let result = adf_to_text(&node);
        assert!(result.contains("body text"));
    }

    #[test]
    fn test_extract_confluence_urls_multiple() {
        let text = "See https://co.atlassian.net/wiki/spaces/A/pages/1 and https://co.atlassian.net/wiki/spaces/B/pages/2 for more";
        let urls = extract_confluence_urls(text);
        assert_eq!(urls.len(), 2);
    }

    #[test]
    fn test_extract_page_id_none() {
        assert_eq!(
            extract_confluence_page_id("https://myco.atlassian.net/wiki/spaces/ENG"),
            None
        );
    }

    #[test]
    fn test_max_attachment_size() {
        assert_eq!(MAX_ATTACHMENT_SIZE, 10_000_000);
    }

    #[test]
    fn test_detect_confluence_short_links() {
        let text = "Full refinement: https://myco.atlassian.net/wiki/x/BQAWUgE";
        let urls = extract_confluence_urls(text);
        assert_eq!(urls.len(), 1);
        assert!(urls[0].contains("/wiki/x/BQAWUgE"));
    }

    #[test]
    fn test_detect_mixed_confluence_urls() {
        let text = "See https://co.atlassian.net/wiki/spaces/ENG/pages/12345 and https://co.atlassian.net/wiki/x/AbCdEf for more";
        let urls = extract_confluence_urls(text);
        assert_eq!(urls.len(), 2);
    }

    #[test]
    fn test_is_confluence_short_link() {
        assert!(is_confluence_short_link(
            "https://myco.atlassian.net/wiki/x/BQAWUgE"
        ));
        assert!(!is_confluence_short_link(
            "https://myco.atlassian.net/wiki/spaces/ENG/pages/12345"
        ));
    }
}
