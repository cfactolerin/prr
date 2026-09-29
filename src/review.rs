// Posting a validated PRR review to GitHub

use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde_json::Value;

use crate::git;
use crate::pr::PrRef;

const MAX_PAYLOAD_BYTES: u64 = 1024 * 1024;

pub fn run(workspace: &Path, pr: &str, payload: &str) -> Result<(), Box<dyn std::error::Error>> {
    let target = PrRef::parse(pr)?;
    let round = payload_round(workspace, Path::new(payload))?;
    let payload_path = std::fs::canonicalize(payload)?;
    check_round_target(&round, &target)?;

    let payload: Value = serde_json::from_str(&std::fs::read_to_string(&payload_path)?)?;
    validate_payload(&payload)?;

    let reviewed_head = git::git(&round.join("repo"), &["rev-parse", "HEAD"])?.trim().to_string();
    if !is_commit(&reviewed_head) || payload["commit_id"].as_str() != Some(reviewed_head.as_str()) {
        return Err("review payload commit does not match the PRR clone".into());
    }
    let current_head = gh(&[
        "pr", "view", &target.number.to_string(), "--repo", &target.gh_repo(),
        "--json", "headRefOid", "--jq", ".headRefOid",
    ])?;
    if current_head.trim() != reviewed_head {
        return Err("pull request head changed after this review; start a new PRR round before posting".into());
    }

    let endpoint = format!("repos/{}/pulls/{}/reviews", target.gh_repo(), target.number);
    let response = gh(&["api", &endpoint, "--method", "POST", "--input", &payload_path.to_string_lossy()])?;
    let response = response.trim();
    println!("{}", if response.is_empty() { "GitHub review posted" } else { response });
    Ok(())
}

fn gh(args: &[&str]) -> Result<String, Box<dyn std::error::Error>> {
    let output = Command::new("gh").args(args).env("NO_COLOR", "1").output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh {}: {}", args[0], stderr.trim()).into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Returns the round directory that owns a payload under `<workspace>/<pr-dir>/r<N>/results/`.
fn payload_round(workspace: &Path, payload: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let workspace = std::fs::canonicalize(workspace)?;
    let metadata = std::fs::symlink_metadata(payload)
        .map_err(|_| format!("review payload does not exist: {}", payload.display()))?;
    if !metadata.is_file() {
        return Err("review payload must be a regular file".into());
    }
    if metadata.len() > MAX_PAYLOAD_BYTES {
        return Err("review payload exceeds 1 MiB".into());
    }
    let resolved = std::fs::canonicalize(payload)?;
    let relative = resolved
        .strip_prefix(&workspace)
        .map_err(|_| "review payload is outside the configured PRR workspace")?;
    let parts: Vec<_> = relative.components().collect();
    let in_results = parts.len() >= 4
        && parts.iter().all(|part| matches!(part, Component::Normal(_)))
        && is_round_name(&parts[1].as_os_str().to_string_lossy())
        && parts[2].as_os_str() == "results";
    if !in_results {
        return Err("review payload must be a file in a PRR round results directory".into());
    }
    Ok(workspace.join(parts[0]).join(parts[1]))
}

fn is_round_name(name: &str) -> bool {
    name.strip_prefix('r').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

fn check_round_target(round: &Path, target: &PrRef) -> Result<(), Box<dyn std::error::Error>> {
    let pr_dir = round.parent().ok_or("PRR round has no pull request directory")?;
    let info: Value = serde_json::from_str(&std::fs::read_to_string(pr_dir.join("pr-info.json"))?)?;
    let matches = info["owner"].as_str() == Some(target.owner.as_str())
        && info["repo"].as_str() == Some(target.repo.as_str())
        && info["number"].as_u64() == Some(target.number);
    if !matches {
        return Err("GitHub target does not match the PRR round".into());
    }
    Ok(())
}

fn is_commit(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_positive_int(value: &Value) -> bool {
    value.as_u64().is_some_and(|n| n >= 1)
}

fn validate_payload(payload: &Value) -> Result<(), Box<dyn std::error::Error>> {
    let object = payload.as_object().ok_or("review payload has an invalid shape")?;
    let valid = object.keys().all(|key| ["commit_id", "event", "body", "comments"].contains(&key.as_str()))
        && matches!(object.get("event").and_then(Value::as_str), Some("APPROVE" | "COMMENT" | "REQUEST_CHANGES"))
        && object.get("body").is_some_and(Value::is_string)
        && object.get("commit_id").and_then(Value::as_str).is_some_and(is_commit)
        && object.get("comments").is_none_or(Value::is_array);
    if !valid {
        return Err("review payload has an invalid shape".into());
    }
    let comments = object.get("comments").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    if !comments.iter().all(valid_comment) {
        return Err("review payload contains an invalid inline comment".into());
    }
    Ok(())
}

fn valid_comment(comment: &Value) -> bool {
    let Some(object) = comment.as_object() else { return false };
    let path_ok = object.get("path").and_then(Value::as_str).is_some_and(|path| {
        !path.starts_with('/') && !path.split('/').any(|part| part == "..")
    });
    let range_ok = match object.get("start_line") {
        Some(start) => is_positive_int(start) && object.get("start_side").and_then(Value::as_str) == Some("RIGHT"),
        None => !object.contains_key("start_side"),
    };
    object.keys().all(|key| ["path", "line", "start_line", "side", "start_side", "body"].contains(&key.as_str()))
        && path_ok
        && object.get("line").is_some_and(is_positive_int)
        && object.get("side").and_then(Value::as_str) == Some("RIGHT")
        && range_ok
        && object.get("body").is_some_and(Value::is_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    fn round_fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let pr_dir = dir.path().join("acme-widgets-pr-7");
        std::fs::create_dir_all(pr_dir.join("r2/results")).unwrap();
        std::fs::write(
            pr_dir.join("pr-info.json"),
            json!({"owner": "acme", "repo": "widgets", "number": 7}).to_string(),
        )
        .unwrap();
        let payload = pr_dir.join("r2/results/review-payload.json");
        std::fs::write(&payload, "{}").unwrap();
        (dir, payload)
    }

    #[test]
    fn test_payload_round_accepts_results_file() {
        let (dir, payload) = round_fixture();
        let round = payload_round(dir.path(), &payload).unwrap();
        assert!(round.ends_with("acme-widgets-pr-7/r2"));
    }

    #[test]
    fn test_payload_round_rejects_paths_outside_results() {
        let (dir, _) = round_fixture();
        let outside = dir.path().join("acme-widgets-pr-7/pr-info.json");
        assert!(payload_round(dir.path(), &outside).is_err());
        let elsewhere = tempfile::NamedTempFile::new().unwrap();
        assert!(payload_round(dir.path(), elsewhere.path()).is_err());
    }

    #[test]
    fn test_payload_round_rejects_symlinked_payload() {
        let (dir, payload) = round_fixture();
        let link = payload.with_file_name("linked.json");
        std::os::unix::fs::symlink(&payload, &link).unwrap();
        assert!(payload_round(dir.path(), &link).is_err());
    }

    #[test]
    fn test_check_round_target_requires_matching_pr() {
        let (dir, payload) = round_fixture();
        let round = payload_round(dir.path(), &payload).unwrap();
        assert!(check_round_target(&round, &PrRef::parse("acme/widgets#7").unwrap()).is_ok());
        assert!(check_round_target(&round, &PrRef::parse("acme/widgets#8").unwrap()).is_err());
        assert!(check_round_target(&round, &PrRef::parse("other/widgets#7").unwrap()).is_err());
    }

    #[test]
    fn test_validate_payload_accepts_review_with_range_comment() {
        let payload = json!({
            "commit_id": SHA,
            "event": "COMMENT",
            "body": "Summary",
            "comments": [
                {"path": "src/lib.rs", "line": 4, "side": "RIGHT", "body": "One"},
                {"path": "src/lib.rs", "line": 9, "start_line": 7, "side": "RIGHT", "start_side": "RIGHT", "body": "Two"}
            ]
        });
        assert!(validate_payload(&payload).is_ok());
    }

    #[test]
    fn test_validate_payload_rejects_bad_shapes() {
        let base = json!({"commit_id": SHA, "event": "COMMENT", "body": "Summary"});
        assert!(validate_payload(&base).is_ok());
        for (key, value) in [
            ("event", json!("DISMISS")),
            ("commit_id", json!("abc")),
            ("body", json!(3)),
            ("comments", json!({})),
            ("extra", json!(true)),
        ] {
            let mut payload = base.clone();
            payload[key] = value;
            assert!(validate_payload(&payload).is_err(), "{key} should be rejected");
        }
    }

    #[test]
    fn test_validate_payload_rejects_bad_comments() {
        for comment in [
            json!({"path": "/etc/passwd", "line": 1, "side": "RIGHT", "body": "x"}),
            json!({"path": "a/../b", "line": 1, "side": "RIGHT", "body": "x"}),
            json!({"path": "a", "line": 0, "side": "RIGHT", "body": "x"}),
            json!({"path": "a", "line": 1, "side": "LEFT", "body": "x"}),
            json!({"path": "a", "line": 2, "start_line": 1, "side": "RIGHT", "body": "x"}),
            json!({"path": "a", "line": 2, "start_side": "RIGHT", "side": "RIGHT", "body": "x"}),
            json!({"path": "a", "line": 1, "side": "RIGHT", "body": "x", "position": 3}),
        ] {
            let payload = json!({"commit_id": SHA, "event": "COMMENT", "body": "", "comments": [comment]});
            assert!(validate_payload(&payload).is_err(), "{payload} should be rejected");
        }
    }
}
