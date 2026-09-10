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
    git::clone_and_checkout_pr(&pr_ref.owner, &pr_ref.repo, pr_ref.number, base_branch, &repo_dir)?;

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

    let repo_docs = gather_repo_docs(&repo_dir, &changed);
    for doc in &repo_docs.excluded {
        eprintln!("warning: withheld {} — points at {}", doc.path, doc.links.join(", "));
    }
    if !repo_docs.excluded.is_empty() {
        eprintln!(
            "warning: those paths only exist on the machine that committed them; \
             remove the links to get the docs back into the review"
        );
    }

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
    manifest.push_str(&format!("| **PRR** | v{} |\n", env!("CARGO_PKG_VERSION")));
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
    if !repo_docs.rendered.is_empty() {
        let mut summary = Vec::new();
        if !repo_docs.root_files.is_empty() {
            summary.push(repo_docs.root_files.join(", "));
        }
        if repo_docs.guide_count > 0 {
            summary.push(format!(
                "{} area guides ({} covering changed files)",
                repo_docs.guide_count, repo_docs.covering_count
            ));
        }
        manifest.push_str(&format!("- Repo docs: {}\n", summary.join(" + ")));
    }
    if !repo_docs.excluded.is_empty() {
        manifest.push_str(&format!("- Docs withheld: {}\n", repo_docs.excluded.len()));
    }

    if !repo_docs.excluded.is_empty() {
        manifest.push_str("\n## Docs Withheld\n\n");
        manifest.push_str(
            "These committed docs point at paths that only exist on the machine that wrote \
             them, so nothing running against this clone can follow them. They were left out \
             of every prompt. Removing the links puts them back in the review.\n\n",
        );
        for doc in &repo_docs.excluded {
            manifest.push_str(&format!("- `{}` -> {}\n", doc.path, doc.links.join(", ")));
        }
    }
    manifest.push_str("\n## Review Tasks\n\n(none yet)\n");

    std::fs::write(round_dir.join("context-manifest.md"), &manifest)?;

    // Save PR metadata as JSON for prompt assembly
    std::fs::write(
        round_dir.join("results/pr-metadata.json"),
        serde_json::to_string_pretty(&pr_data)?,
    )?;
    if !repo_docs.rendered.is_empty() {
        std::fs::write(round_dir.join("results/repo-docs.md"), &repo_docs.rendered)?;
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

/// Agent-facing docs found in the clone.
///
/// Root docs are inlined; subdirectory guides are listed by path only. A large
/// repo can carry a dozen area guides of a hundred-plus lines each, which would
/// dwarf the diff in every prompt, so agents read the ones they need from the
/// clone instead.
struct RepoDocs {
    rendered: String,
    root_files: Vec<String>,
    guide_count: usize,
    covering_count: usize,
    excluded: Vec<ExcludedDoc>,
}

/// A committed doc withheld from every prompt, and the paths that cost it its
/// place.
struct ExcludedDoc {
    path: String,
    links: Vec<String>,
}

/// Directories never worth walking for agent docs.
const SKIPPED_DIRS: &[&str] = &["node_modules", "vendor", "target", "build", "dist"];

const MAX_GUIDE_DEPTH: usize = 12;
const MAX_GUIDES: usize = 100;

/// Absolute-path prefixes that only resolve on the machine that wrote them.
const LOCAL_ROOTS: &[&str] = &["/Users/", "/home/"];

const LINK_TERMINATORS: &[char] =
    &[' ', '\t', '\n', '\r', '`', '\'', '"', '(', ')', '[', ']', '{', '}', '<', '>', ',', ';'];

/// Machine-local absolute paths in `content`, deduplicated, in document order.
///
/// Reviewers run against a fresh clone, so a doc pointing at the author's own
/// checkout sends every agent outside its sandbox. The sandboxed CLIs handle
/// that badly: `opencode run` rejects the read and then abandons the turn
/// without emitting an error, which reads downstream as an empty review.
fn local_links(content: &str) -> Vec<String> {
    let mut starts: Vec<usize> = Vec::new();
    for root in LOCAL_ROOTS {
        starts.extend(content.match_indices(root).map(|(i, _)| i));
    }
    starts.sort_unstable();

    let mut links: Vec<String> = Vec::new();
    for start in starts {
        let rest = &content[start..];
        let end = rest.find(|c| LINK_TERMINATORS.contains(&c)).unwrap_or(rest.len());
        let link = rest[..end].trim_end_matches(|c| c == '.' || c == ':');

        // A bare home root is prose ("your home directory"); a path below one
        // is a pointer an agent will try to follow.
        if link.matches('/').count() < 3 {
            continue;
        }
        if !links.iter().any(|l| l == link) {
            links.push(link.to_string());
        }
    }
    links
}

fn gather_repo_docs(repo_dir: &std::path::Path, changed_files: &str) -> RepoDocs {
    let mut rendered = String::new();
    let mut root_files = Vec::new();
    let mut excluded = Vec::new();

    for filename in &["CLAUDE.md", "AGENTS.md", "README.md"] {
        let path = repo_dir.join(filename);
        if !path.exists() {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            let links = local_links(&content);
            if !links.is_empty() {
                excluded.push(ExcludedDoc { path: filename.to_string(), links });
                continue;
            }
            rendered.push_str(&format!("### {filename}\n\n{content}\n\n"));
            root_files.push(filename.to_string());
        }
    }

    let changed: Vec<&str> =
        changed_files.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let mut found = Vec::new();
    collect_area_guides(repo_dir, repo_dir, 0, &mut found);
    found.sort();

    let mut guides = Vec::new();
    for guide in found {
        let links = std::fs::read_to_string(repo_dir.join(&guide))
            .map(|c| local_links(&c))
            .unwrap_or_default();
        if links.is_empty() {
            guides.push(guide);
        } else {
            excluded.push(ExcludedDoc { path: guide, links });
        }
    }

    let covering: Vec<bool> = guides.iter().map(|g| guide_covers_changed(g, &changed)).collect();
    let covering_count = covering.iter().filter(|c| **c).count();

    if !guides.is_empty() {
        rendered.push_str("### Area guides\n\n");
        rendered.push_str(
            "This repo uses progressive disclosure: the guides below carry the domain rules, \
             pitfalls and architectural decisions for their own directory. Read them from the \
             clone — start with the ones marked **covers changed files**, whose directory holds \
             a file this PR touches.\n\n",
        );
        for (guide, covers) in guides.iter().zip(&covering) {
            let mark = if *covers { " — **covers changed files**" } else { "" };
            rendered.push_str(&format!("- `{guide}`{mark}\n"));
        }
        rendered.push('\n');
    }

    // Withholding a doc is not enough on its own: repos cross-reference their
    // own guides, so a pointer table in an inlined root doc still sends agents
    // to a guide prr left out of the index.
    if !rendered.is_empty() {
        rendered.insert_str(0, STAY_IN_THE_CLONE);
    }

    RepoDocs { rendered, root_files, guide_count: guides.len(), covering_count, excluded }
}

/// Prepended to every rendered doc set, and so to every prompt carrying one.
const STAY_IN_THE_CLONE: &str = "\
### Reading these docs

Everything here lives in the clone. A doc may still point at an absolute path outside it — a \
checkout on the machine that wrote the doc, most often. Nothing outside the clone is readable \
during a review, so don't try to open one: note that the reference was unavailable and answer \
from what the clone holds.

";

/// Walk `dir` for `CLAUDE.md` / `AGENTS.md` outside the repo root, pushing
/// repo-relative paths into `out`.
fn collect_area_guides(
    repo_root: &std::path::Path,
    dir: &std::path::Path,
    depth: usize,
    out: &mut Vec<String>,
) {
    if depth > MAX_GUIDE_DEPTH || out.len() >= MAX_GUIDES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if path.is_dir() {
            if name.starts_with('.') || SKIPPED_DIRS.contains(&name.as_str()) {
                continue;
            }
            subdirs.push(path);
        } else if depth > 0 && (name == "CLAUDE.md" || name == "AGENTS.md") {
            if let Ok(rel) = path.strip_prefix(repo_root) {
                out.push(rel.to_string_lossy().to_string());
            }
        }
    }
    subdirs.sort();
    for subdir in subdirs {
        collect_area_guides(repo_root, &subdir, depth + 1, out);
    }
}

fn guide_covers_changed(guide: &str, changed: &[&str]) -> bool {
    let Some((dir, _)) = guide.rsplit_once('/') else {
        return false;
    };
    let prefix = format!("{dir}/");
    changed.iter().any(|f| f.starts_with(&prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn write(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn line_for<'a>(rendered: &'a str, needle: &str) -> &'a str {
        rendered
            .lines()
            .find(|l| l.contains(needle))
            .unwrap_or_else(|| panic!("no line mentioning {needle} in:\n{rendered}"))
    }

    #[test]
    fn inlines_root_docs_and_indexes_area_guides_separately() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        write(repo, "CLAUDE.md", "root conventions");
        write(repo, "README.md", "readme body");
        write(repo, "lib/xml/CLAUDE.md", "xml area guide");

        let docs = gather_repo_docs(repo, "");

        assert!(docs.rendered.contains("root conventions"));
        assert!(docs.rendered.contains("readme body"));
        assert!(docs.rendered.contains("`lib/xml/CLAUDE.md`"));
        assert!(
            !docs.rendered.contains("xml area guide"),
            "area guides are listed by path, never inlined"
        );
        assert_eq!(docs.root_files, vec!["CLAUDE.md", "README.md"]);
        assert_eq!(docs.guide_count, 1);
        assert_eq!(docs.covering_count, 0);
    }

    #[test]
    fn marks_guides_covering_changed_files() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        write(repo, "CLAUDE.md", "root");
        write(repo, "lib/CLAUDE.md", "lib");
        write(repo, "lib/xml/apple_music/CLAUDE.md", "apple");
        write(repo, "lib/models/CLAUDE.md", "models");

        let docs = gather_repo_docs(repo, "lib/xml/apple_music/track.rb\nREADME.md\n");

        assert!(line_for(&docs.rendered, "lib/CLAUDE.md").contains("covers changed files"));
        assert!(
            line_for(&docs.rendered, "lib/xml/apple_music/CLAUDE.md").contains("covers changed files")
        );
        assert!(!line_for(&docs.rendered, "lib/models/CLAUDE.md").contains("covers changed files"));
        assert_eq!(docs.guide_count, 3);
        assert_eq!(docs.covering_count, 2);
    }

    #[test]
    fn finds_agents_md_and_skips_vendored_trees() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        write(repo, "app/AGENTS.md", "app agents");
        write(repo, ".git/CLAUDE.md", "git internals");
        write(repo, "node_modules/pkg/CLAUDE.md", "dependency");
        write(repo, "vendor/bundle/AGENTS.md", "vendored");
        write(repo, "target/debug/CLAUDE.md", "build output");

        let docs = gather_repo_docs(repo, "");

        assert!(docs.rendered.contains("`app/AGENTS.md`"));
        assert_eq!(docs.guide_count, 1, "vendored and build trees are skipped");
    }

    #[test]
    fn renders_nothing_when_repo_has_no_docs() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "src/main.rs", "fn main() {}");

        let docs = gather_repo_docs(tmp.path(), "src/main.rs\n");

        assert!(docs.rendered.is_empty(), "empty output drives the no-docs fallback");
        assert_eq!(docs.guide_count, 0);
    }

    #[test]
    fn indexes_area_guides_when_no_root_doc_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        write(repo, "lib/CLAUDE.md", "area only");

        let docs = gather_repo_docs(repo, "lib/thing.rb\n");

        assert!(docs.root_files.is_empty());
        assert!(docs.rendered.contains("`lib/CLAUDE.md`"));
        assert_eq!(docs.covering_count, 1);
    }

    #[test]
    fn drops_area_guides_pointing_outside_the_clone() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        write(repo, "CLAUDE.md", "root");
        write(repo, "lib/xml/CLAUDE.md", "see `/Users/dev/git/xml_generator` for the base class");
        write(repo, "lib/models/CLAUDE.md", "models");

        let docs = gather_repo_docs(repo, "lib/xml/album.rb\n");

        assert!(
            !docs.rendered.contains("lib/xml/CLAUDE.md"),
            "a guide agents cannot fully follow is not indexed at all"
        );
        assert!(docs.rendered.contains("`lib/models/CLAUDE.md`"));
        assert_eq!(docs.guide_count, 1, "the dropped guide is not counted as indexed");
        assert_eq!(docs.covering_count, 0);
        assert_eq!(docs.excluded.len(), 1);
        assert_eq!(docs.excluded[0].path, "lib/xml/CLAUDE.md");
        assert_eq!(docs.excluded[0].links, vec!["/Users/dev/git/xml_generator"]);
    }

    #[test]
    fn drops_root_docs_pointing_outside_the_clone() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        write(repo, "CLAUDE.md", "clone the gem to /home/dev/src/shared first");
        write(repo, "README.md", "readme body");

        let docs = gather_repo_docs(repo, "");

        assert!(!docs.rendered.contains("clone the gem"), "the local link never reaches a prompt");
        assert!(docs.rendered.contains("readme body"));
        assert_eq!(docs.root_files, vec!["README.md"]);
        assert_eq!(docs.excluded.len(), 1);
        assert_eq!(docs.excluded[0].path, "CLAUDE.md");
        assert_eq!(docs.excluded[0].links, vec!["/home/dev/src/shared"]);
    }

    #[test]
    fn keeps_docs_whose_absolute_paths_are_not_machine_local() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        write(repo, "lib/CLAUDE.md", "binaries land in /usr/local/bin; specs read /etc/hosts");

        let docs = gather_repo_docs(repo, "lib/thing.rb\n");

        assert!(docs.rendered.contains("`lib/CLAUDE.md`"));
        assert!(docs.excluded.is_empty(), "only paths under a user home are machine-local");
    }

    #[test]
    fn tells_agents_to_stay_in_the_clone_whenever_docs_render() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        // A pointer table naming a guide prr withheld: the agent can still
        // reach the guide, so the rule has to travel with the docs.
        write(repo, "CLAUDE.md", "see `lib/xml/CLAUDE.md` for the node pattern");
        write(repo, "lib/xml/CLAUDE.md", "base class lives in `/Users/dev/git/gem`");

        let docs = gather_repo_docs(repo, "lib/xml/album.rb\n");

        assert!(docs.rendered.starts_with("### Reading these docs"));
        assert!(docs.rendered.contains("Nothing outside the clone is readable"));
        assert_eq!(docs.excluded.len(), 1);
    }

    #[test]
    fn reports_each_local_link_once_in_document_order() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        write(
            repo,
            "lib/CLAUDE.md",
            "`/Users/dev/git/two` then `/Users/dev/git/one`, and /Users/dev/git/two again",
        );

        let docs = gather_repo_docs(repo, "");

        assert_eq!(
            docs.excluded[0].links,
            vec!["/Users/dev/git/two", "/Users/dev/git/one"],
            "the reviewer gets one entry per distinct link, in the order they appear"
        );
    }
}
