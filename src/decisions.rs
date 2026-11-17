use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

pub fn previous(round: &Path, report: &str) -> String {
    match load(round, report) {
        Ok(Some(decisions)) => decisions,
        Ok(None) => "No saved local decisions are available for this round. Do not infer acceptance or rejection from its report.".into(),
        Err(_) => "Saved local decisions are unavailable or do not match the previous report snapshot. Do not infer acceptance or rejection.".into(),
    }
}

fn load(round: &Path, report: &str) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let results = round.join("results");
    let path = results.join("finding-decisions.json");
    match path.symlink_metadata() {
        Ok(meta) if meta.is_file() && meta.len() <= 2 * 1024 * 1024 => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        _ => return Err("Invalid saved decisions".into()),
    };
    let data: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let hash = |text: &str| format!("{:x}", Sha256::digest(text.as_bytes()));
    let diff = std::fs::read_to_string(results.join("diff.txt"))?;
    let metadata = match std::fs::read_to_string(results.join("pr-metadata.json")) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    if data["version"] != 1 || data["report_sha256"].as_str() != Some(hash(report).as_str())
        || data["diff_sha256"].as_str() != Some(hash(&diff).as_str())
        || data["metadata_sha256"].as_str() != Some(hash(&metadata).as_str()) {
        return Err("Stale saved decisions".into());
    }
    let decisions = data["decisions"].as_object().ok_or("Invalid decision map")?;
    let findings = crate::report::parse_report(report).findings;
    let mut out = String::from("These are explicit local choices from the previous round, not correctness judgments. Finding IDs belong only to that round; match the underlying claim, not the ID. A rejection is not proof that a finding is false. Reassess against the current code and explain new evidence if raising a rejected claim again.\n\n");
    for finding in &findings {
        let Some(decision) = decisions.get(&finding.id) else { continue };
        let Some(status @ ("pending" | "accepted" | "rejected" | "edited")) = decision["status"].as_str() else {
            return Err("Invalid saved decision status".into());
        };
        out.push_str(&format!("- **{}: {}** — {}{}\n", finding.id, status, finding.title,
            finding.location.as_ref().map(|location| format!(" ({location})")).unwrap_or_default()));
        if status == "edited" {
            if let Some(body) = decision["overridden_body"].as_str() {
                out.push_str(&format!("\n  Approved replacement comment:\n\n{}\n\n",
                    body.lines().map(|line| format!("  > {line}")).collect::<Vec<_>>().join("\n")));
            }
        }
    }
    if decisions.is_empty() { out.push_str("No explicit local decisions were saved.\n"); }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_matching_snapshots_supply_prior_decisions() {
        let round = tempfile::tempdir().unwrap();
        let results = round.path().join("results");
        std::fs::create_dir(&results).unwrap();
        let report = "## Final Report\n\n### Findings\n\n#### Trigger: Logic Bug\n\n##### F-01 — Wrong value\n\n- **Severity:** MED\n- **Anchor:** none\n- **Why this matters:** Wrong.\n- **Suggested fix:** Fix.\n- **Suggested comment:** Fix it.\n";
        assert!(previous(round.path(), report).contains("No saved local decisions"));
        std::fs::write(results.join("diff.txt"), "diff").unwrap();
        let hash = |text: &str| format!("{:x}", Sha256::digest(text.as_bytes()));
        std::fs::write(results.join("finding-decisions.json"), json!({
            "version": 1, "report_sha256": hash(report), "diff_sha256": hash("diff"),
            "metadata_sha256": hash(""), "decisions": {"F-01": {"status": "rejected"}}
        }).to_string()).unwrap();
        assert!(previous(round.path(), report).contains("F-01: rejected"));
        assert!(previous(round.path(), report).contains("not proof"));
        assert!(previous(round.path(), &format!("{report}\nchanged")).contains("do not match"));
        std::fs::write(results.join("finding-decisions.json"), "{").unwrap();
        assert!(previous(round.path(), report).contains("unavailable"));
    }
}
