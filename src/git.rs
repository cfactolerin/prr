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
/// Ensures enough history exists to compute a merge-base for diff.
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
    // Shallow clone uses --single-branch, which limits the refspec to the default branch.
    // Widen it so fetches of other branches create proper remote tracking refs.
    git(dest, &["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"])?;
    git(dest, &["fetch", "origin", &format!("pull/{pr_number}/head:pr-review")])?;
    git(dest, &["fetch", "origin", base_branch])?;

    // Ensure sufficient shared history to compute merge-base.
    // Shallow clones often lack enough history when the base is a feature branch.
    let base_ref = format!("origin/{base_branch}");
    if git_silent(dest, &["merge-base", &base_ref, "pr-review"]).is_none() {
        eprintln!("Shallow history insufficient for diff — deepening...");
        let _ = git_silent(dest, &["fetch", "--deepen=200", "origin", base_branch]);
        let _ = git_silent(dest, &["fetch", "--deepen=200", "origin", &format!("pull/{pr_number}/head:pr-review")]);

        if git_silent(dest, &["merge-base", &base_ref, "pr-review"]).is_none() {
            eprintln!("Still insufficient — fetching full history...");
            let _ = git_silent(dest, &["fetch", "--unshallow", "origin"]);
        }
    }

    git(dest, &["checkout", "pr-review"])?;
    Ok(())
}

/// Compute diff of PR branch against base.
///
/// Three-dot, so the diff starts at the merge-base rather than the base tip.
/// Two-dot would render every commit that landed on the base after the branch
/// point as a reversal, which reviewers read as deletions the PR never made.
/// Three-dot is also what GitHub shows under "Files changed".
pub fn diff(repo: &Path, base_branch: &str) -> Result<String, Box<dyn std::error::Error>> {
    let candidates = [base_branch.to_string(), format!("origin/{base_branch}")];
    for ref_name in &candidates {
        if let Some(output) = git_silent(repo, &["diff", &format!("{ref_name}...pr-review"), "--"]) {
            return Ok(output);
        }
    }
    eprintln!("warning: could not compute diff against {base_branch}");
    Ok(String::new())
}

/// List changed files in the PR branch vs base. Three-dot, matching `diff`.
pub fn changed_files(repo: &Path, base_branch: &str) -> Result<String, Box<dyn std::error::Error>> {
    let candidates = [base_branch.to_string(), format!("origin/{base_branch}")];
    for ref_name in &candidates {
        if let Some(output) = git_silent(repo, &["diff", "--name-only", &format!("{ref_name}...pr-review"), "--"]) {
            return Ok(output);
        }
    }
    Ok(String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(repo: &Path, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(repo).args(args).output().unwrap();
        assert!(
            out.status.success(),
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A PR branch whose base has moved on since the branch was cut — the
    /// shape that exposes the difference between two-dot and three-dot.
    fn repo_with_diverged_base() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();

        let init = Command::new("git").args(["init", "-b", "master"]).arg(repo).output().unwrap();
        assert!(init.status.success(), "{}", String::from_utf8_lossy(&init.stderr));
        run(repo, &["config", "user.email", "test@example.com"]);
        run(repo, &["config", "user.name", "Test"]);
        run(repo, &["config", "commit.gpgsign", "false"]);

        std::fs::write(repo.join("shared.txt"), "base\n").unwrap();
        run(repo, &["add", "."]);
        run(repo, &["commit", "-m", "initial"]);

        run(repo, &["checkout", "-b", "pr-review"]);
        std::fs::write(repo.join("branch-only.txt"), "from the pr\n").unwrap();
        run(repo, &["add", "."]);
        run(repo, &["commit", "-m", "pr change"]);

        run(repo, &["checkout", "master"]);
        std::fs::write(repo.join("master-only.txt"), "landed after the branch point\n").unwrap();
        run(repo, &["add", "."]);
        run(repo, &["commit", "-m", "master moves on"]);

        run(repo, &["checkout", "pr-review"]);
        dir
    }

    #[test]
    fn test_diff_excludes_commits_landed_on_base_after_branch_point() {
        let dir = repo_with_diverged_base();
        let out = diff(dir.path(), "master").unwrap();
        assert!(out.contains("branch-only.txt"), "diff was:\n{out}");
        assert!(!out.contains("master-only.txt"), "diff was:\n{out}");
    }

    #[test]
    fn test_changed_files_excludes_commits_landed_on_base_after_branch_point() {
        let dir = repo_with_diverged_base();
        let out = changed_files(dir.path(), "master").unwrap();
        assert_eq!(out.lines().collect::<Vec<_>>(), vec!["branch-only.txt"]);
    }
}
