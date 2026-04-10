use std::path::Path;
use std::process::Command;

/// Run a git command in a given repo directory. Returns stdout on success.
pub fn git(repo: &Path, args: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git {}: {}", args.join(" "), stderr.trim()).into())
    }
}

/// Run git, return None on failure instead of error.
pub fn git_silent(repo: &Path, args: &[&str]) -> Option<String> {
    git(repo, args).ok().filter(|s| !s.trim().is_empty())
}

/// Clone a repo using gh CLI, then fetch the PR branch and base branch.
pub fn clone_and_checkout_pr(
    owner: &str,
    repo: &str,
    pr_number: u64,
    base_branch: &str,
    dest: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let status = Command::new("gh")
        .args(["repo", "clone", &format!("{owner}/{repo}"), &dest.to_string_lossy()])
        .arg("--")
        .args(["--depth", "50"])
        .status()?;
    if !status.success() {
        return Err("gh repo clone failed".into());
    }
    git(dest, &["fetch", "origin", &format!("pull/{pr_number}/head:pr-review")])?;
    git(dest, &["fetch", "origin", base_branch])?;
    git(dest, &["checkout", "pr-review"])?;
    Ok(())
}

/// Compute diff of PR branch against base. Tries multiple strategies.
pub fn diff(repo: &Path, base_branch: &str) -> Result<String, Box<dyn std::error::Error>> {
    let candidates = [base_branch.to_string(), format!("origin/{base_branch}")];
    for ref_name in &candidates {
        if let Some(output) = git_silent(repo, &["diff", &format!("{ref_name}..pr-review"), "--"]) {
            return Ok(output);
        }
        if let Some(mb) = git_silent(repo, &["merge-base", ref_name, "pr-review"]) {
            let mb = mb.trim();
            if let Some(output) = git_silent(repo, &["diff", &format!("{mb}..pr-review"), "--"]) {
                return Ok(output);
            }
        }
    }
    eprintln!("warning: could not compute diff against {base_branch}");
    Ok(String::new())
}

/// List changed files in the PR branch vs base.
pub fn changed_files(repo: &Path, base_branch: &str) -> Result<String, Box<dyn std::error::Error>> {
    let candidates = [base_branch.to_string(), format!("origin/{base_branch}")];
    for ref_name in &candidates {
        if let Some(output) = git_silent(repo, &["diff", "--name-only", &format!("{ref_name}..pr-review"), "--"]) {
            return Ok(output);
        }
    }
    Ok(String::new())
}
