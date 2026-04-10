---
name: prr-cleanup
description: Clean up workspace by removing review directories for merged or closed PRs. Safe operation — only removes confirmed merged/closed PRs.
argument-hint: ""
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal *)", Read]
---

# PRR Cleanup

Sweep the workspace and remove review directories for merged or closed PRs.

## Instructions

1. Read `~/.prr/config.yml` to get the workspace_path value.
   - If the file does not exist, tell the user: "PRR has not been set up yet. Run `/prr:setup` first." Then stop.
2. Run cleanup:

```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal cleanup --workspace <workspace_path>
```

3. Report what was cleaned up and what was kept.

This is safe — only removes directories where the PR is confirmed MERGED or CLOSED via GitHub.
