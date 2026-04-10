use std::path::Path;
use std::process::Command;
use serde_json::Value;

pub fn run(workspace: &str) -> Result<(), Box<dyn std::error::Error>> {
    let ws = Path::new(workspace);
    if !ws.exists() {
        println!("Workspace does not exist: {workspace}");
        return Ok(());
    }

    let mut cleaned = 0;
    let mut kept = 0;

    for entry in std::fs::read_dir(ws)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();

        // Read pr-info.json (written by context command)
        let info_path = entry.path().join("pr-info.json");
        if !info_path.exists() { kept += 1; continue; }

        let info: Value = match std::fs::read_to_string(&info_path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => { kept += 1; continue; }
        };
        let owner = info["owner"].as_str().unwrap_or("");
        let repo = info["repo"].as_str().unwrap_or("");
        let pr_num = info["number"].as_u64().unwrap_or(0);
        if owner.is_empty() || pr_num == 0 { kept += 1; continue; }

        let output = Command::new("gh")
            .args(["pr", "view", &pr_num.to_string(), "--repo", &format!("{owner}/{repo}"), "--json", "state", "--jq", ".state"])
            .env("NO_COLOR", "1")
            .output();

        match output {
            Ok(o) if o.status.success() => {
                let state = String::from_utf8_lossy(&o.stdout).trim().to_string();
                if state == "MERGED" || state == "CLOSED" {
                    eprintln!("Removing {name} (PR is {state})");
                    std::fs::remove_dir_all(entry.path())?;
                    cleaned += 1;
                } else {
                    kept += 1;
                }
            }
            _ => {
                eprintln!("warning: could not check PR status for {name}, skipping");
                kept += 1;
            }
        }
    }

    println!("Cleanup: removed {cleaned}, kept {kept}");
    Ok(())
}
