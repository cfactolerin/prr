---
name: prr-cleanup
description: Use when the user runs /prr-cleanup or asks to remove PRR workspaces for closed or merged pull requests.
compatibility: OpenCode with the PRR npm plugin installed.
---

# PRR Cleanup

1. Run `"$PRR_BIN" config runtime` and parse its JSON output. Never read `~/.prr/config.yml`; it may contain credentials.
2. If `configured` is false, tell the user to run `/prr-setup` and stop.
3. Use the returned `workspace_path`.
4. Run:

```bash
"$PRR_BIN" cleanup-open-code
```

5. Report the command's removed and retained entries. If it fails, show the relevant error and do not claim anything was removed.

Cleanup is limited to review directories whose pull requests GitHub confirms are merged or closed.
