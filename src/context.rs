use crate::{config::Config, git, jira, pr, workspace};
use regex::Regex;
use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;

pub fn run(
    pr_input: &str,
    workspace_path: &str,
    ticket_override: Option<&str>,
) -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::load()?;
    let pr_ref = pr::PrRef::parse(pr_input)?;

    // Fetch PR metadata via gh
    let pr_data = fetch_pr_metadata(&pr_ref)?;
    let pr_title = pr_data["title"].as_str().unwrap_or("");
    let pr_author = pr_data.pointer("/author/login").and_then(|a| a.as_str()).unwrap_or("");
    let head_branch = pr_data["headRefName"].as_str().unwrap_or("");
    let base_branch = pr_data["baseRefName"].as_str().unwrap_or("main");
    let pr_body = pr_data["body"].as_str().unwrap_or("");
    let pr_url = pr_data["url"].as_str().unwrap_or("");

    // Determine workspace paths
    let ws = PathBuf::from(shellexpand::tilde(workspace_path).as_ref());
    std::fs::create_dir_all(&ws)?;
    let pr_dir = ws.join(pr_ref.dir_name());
    let round_num = workspace::next_round_number(&pr_dir);
    let round_dir = pr_dir.join(format!("r{round_num}"));
    workspace::create_round_dirs(&round_dir)?;

    eprintln!("Round: r{round_num}");
    eprintln!("Directory: {}", round_dir.display());

    // Clone repo and checkout PR branch
    eprintln!("Cloning repository...");
    let repo_dir = round_dir.join("repo");
    // Remove the empty dir created by create_round_dirs so git clone can create it
    std::fs::remove_dir(&repo_dir)?;
    git::clone_and_checkout_pr(&pr_ref.owner, &pr_ref.repo, pr_ref.number, &repo_dir)?;

    // Detect or use ticket ID
    let ticket_id = ticket_override
        .map(|t| t.to_string())
        .or_else(|| pr::detect_ticket(&format!("{pr_title} {pr_body} {head_branch}")));

    // Fetch Jira ticket if configured and ticket found
    let context_dir = round_dir.join("context");
    if let Some(ref tid) = ticket_id {
        if let Some(client) = jira::JiraClient::new(&config) {
            eprintln!("Fetching Jira ticket {tid}...");
            if let Err(e) = client.fetch_ticket(tid, &context_dir) {
                eprintln!("warning: Jira fetch failed: {e}");
            }
        }
    }

    // Compute diff and changed files
    eprintln!("Computing diff...");
    let diff_text = git::diff(&repo_dir, base_branch)?;
    let changed = git::changed_files(&repo_dir, base_branch)?;
    std::fs::write(round_dir.join("results/diff.txt"), &diff_text)?;
    std::fs::write(round_dir.join("results/changed-files.txt"), &changed)?;

    // Read repo docs
    let repo_docs = read_repo_docs(&repo_dir);

    // Check for previous review
    let previous_review = if round_num > 1 {
        let prev_report = pr_dir.join(format!("r{}/results/final-report.md", round_num - 1));
        if prev_report.exists() {
            Some(std::fs::read_to_string(&prev_report)?)
        } else {
            None
        }
    } else {
        None
    };

    // Write context manifest
    let mut manifest = String::from("# Context Manifest\n\n");
    manifest.push_str("| Field | Value |\n|-------|-------|\n");
    manifest.push_str(&format!("| **PR** | {} |\n", pr_url));
    manifest.push_str(&format!("| **Title** | {} |\n", pr_title));
    manifest.push_str(&format!("| **Author** | {} |\n", pr_author));
    manifest.push_str(&format!("| **Branch** | `{head_branch}` -> `{base_branch}` |\n"));
    manifest.push_str(&format!("| **Ticket** | {} |\n", ticket_id.as_deref().unwrap_or("none")));
    manifest.push_str(&format!("| **Round** | r{round_num} |\n"));
    manifest.push_str("\n## Gathered Context\n\n");
    manifest.push_str(&format!("- Repo cloned: `{}`\n", repo_dir.display()));
    manifest.push_str(&format!("- Changed files: {}\n", changed.lines().count()));
    manifest.push_str(&format!("- Diff size: {} bytes\n", diff_text.len()));

    if context_dir.join("ticket-context.md").exists() {
        manifest.push_str("- Jira ticket: fetched\n");
    }
    let att_count = std::fs::read_dir(context_dir.join("attachments"))
        .map(|d| d.count()).unwrap_or(0);
    if att_count > 0 {
        manifest.push_str(&format!("- Attachments: {att_count}\n"));
    }
    let conf_count = std::fs::read_dir(context_dir.join("confluence"))
        .map(|d| d.count()).unwrap_or(0);
    if conf_count > 0 {
        manifest.push_str(&format!("- Confluence pages: {conf_count}\n"));
    }
    if previous_review.is_some() {
        manifest.push_str(&format!("- Previous review: r{}\n", round_num - 1));
    }
    if !repo_docs.is_empty() {
        manifest.push_str("- Repo docs: found (CLAUDE.md / AGENTS.md / README.md)\n");
    }
    manifest.push_str("\n## Review Tasks\n\n(none yet)\n");

    std::fs::write(round_dir.join("context-manifest.md"), &manifest)?;

    // Save PR metadata as JSON for prompt assembly
    std::fs::write(
        round_dir.join("results/pr-metadata.json"),
        serde_json::to_string_pretty(&pr_data)?,
    )?;
    if !repo_docs.is_empty() {
        std::fs::write(round_dir.join("results/repo-docs.md"), &repo_docs)?;
    }
    if let Some(prev) = &previous_review {
        std::fs::write(round_dir.join("results/previous-review.md"), prev)?;
    }

    // Write PR info at PR dir level (used by cleanup to identify owner/repo/number)
    let pr_meta = serde_json::json!({
        "owner": pr_ref.owner,
        "repo": pr_ref.repo,
        "number": pr_ref.number,
    });
    std::fs::write(pr_dir.join("pr-info.json"), serde_json::to_string_pretty(&pr_meta)?)?;

    // Print the round directory path (skills read this from stdout)
    println!("{}", round_dir.display());

    Ok(())
}

fn fetch_pr_metadata(pr_ref: &pr::PrRef) -> Result<Value, Box<dyn std::error::Error>> {
    let output = Command::new("gh")
        .args([
            "pr", "view", &pr_ref.number.to_string(),
            "--repo", &pr_ref.gh_repo(),
            "--json", "number,title,body,headRefName,baseRefName,author,files,url,commits",
        ])
        .env("NO_COLOR", "1")
        .output()?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr view failed: {err}").into());
    }

    let json_str = String::from_utf8_lossy(&output.stdout);
    let clean = Regex::new(r"\x1b\[[0-9;]*m")?.replace_all(&json_str, "");
    Ok(serde_json::from_str(&clean)?)
}

fn read_repo_docs(repo_dir: &std::path::Path) -> String {
    let mut docs = String::new();
    for filename in &["CLAUDE.md", "AGENTS.md", "README.md"] {
        let path = repo_dir.join(filename);
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                docs.push_str(&format!("## {filename}\n\n{content}\n\n"));
            }
        }
    }
    docs
}
