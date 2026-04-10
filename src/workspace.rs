// Workspace management module

use std::path::{Path, PathBuf};

pub fn next_round_number(pr_dir: &Path) -> u64 {
    if !pr_dir.exists() { return 1; }
    let mut max = 0u64;
    if let Ok(entries) = std::fs::read_dir(pr_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(n) = name.strip_prefix('r').and_then(|s| s.parse::<u64>().ok()) {
                max = max.max(n);
            }
        }
    }
    max + 1
}

pub fn latest_round_dir(pr_dir: &Path) -> Option<PathBuf> {
    let n = next_round_number(pr_dir);
    if n <= 1 { return None; }
    Some(pr_dir.join(format!("r{}", n - 1)))
}

pub fn create_round_dirs(round_dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    std::fs::create_dir_all(round_dir.join("repo"))?;
    std::fs::create_dir_all(round_dir.join("context/attachments"))?;
    std::fs::create_dir_all(round_dir.join("context/confluence"))?;
    std::fs::create_dir_all(round_dir.join("results"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_next_round_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let pr_dir = dir.path().join("acme-repo-pr-1");
        std::fs::create_dir_all(&pr_dir).unwrap();
        assert_eq!(next_round_number(&pr_dir), 1);
    }

    #[test]
    fn test_next_round_existing() {
        let dir = tempfile::tempdir().unwrap();
        let pr_dir = dir.path().join("acme-repo-pr-1");
        std::fs::create_dir_all(pr_dir.join("r1")).unwrap();
        std::fs::create_dir_all(pr_dir.join("r2")).unwrap();
        assert_eq!(next_round_number(&pr_dir), 3);
    }

    #[test]
    fn test_latest_round() {
        let dir = tempfile::tempdir().unwrap();
        let pr_dir = dir.path().join("acme-repo-pr-1");
        std::fs::create_dir_all(pr_dir.join("r1")).unwrap();
        std::fs::create_dir_all(pr_dir.join("r2")).unwrap();
        let latest = latest_round_dir(&pr_dir).unwrap();
        assert!(latest.ends_with("r2"));
    }

    #[test]
    fn test_create_round_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let round = dir.path().join("r1");
        create_round_dirs(&round).unwrap();
        assert!(round.join("repo").exists());
        assert!(round.join("context").exists());
        assert!(round.join("context/attachments").exists());
        assert!(round.join("context/confluence").exists());
        assert!(round.join("results").exists());
    }
}
