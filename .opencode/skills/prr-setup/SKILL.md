---
name: prr-setup
description: Use when the user runs /prr-setup or asks to configure PRR for OpenCode.
compatibility: OpenCode with the PRR npm plugin installed.
---

# PRR Setup

Configure PRR interactively. The npm plugin supplies `PRR_BIN` at runtime; setup must not discover or persist a binary path.

## Fixed Settings

Use these values for every OpenCode installation:

| Field | Value |
|---|---|
| `agents` | `opencode`, `codex` |
| `workspace_path` | `~/.prr/workspace` by default |
| `codex_timeout` | `900` |
| `arbiter_rounds` | `3` |

Only the workspace and optional Jira fields are interactive. Do not offer different reviewers, models, timeouts, or arbitration rounds.

## 1. Read Existing Settings

Run `"$PRR_BIN" config runtime` and parse its JSON output. It exposes only non-secret runtime settings. Never read `~/.prr/config.yml` directly.

Preserve the current workspace and whether Jira is configured as choices. If no config exists, use `~/.prr/workspace` and no Jira integration.

## 2. Verify Prerequisites

Use bash to check each executable separately with `command -v`:

- `gh`
- `git`
- `codex`

Then verify authentication:

```bash
gh auth status
codex login status
```

Finally, call `prr_codex_health` with no arguments. It uses the same isolated permission profile as reviews, strips process secrets while preserving Codex authentication state, and rejects Codex versions that do not support the required policy.

Treat a nonzero exit, timeout, authentication error, or missing recognizable response as a failure. If any check fails, report the exact failing prerequisite and use the question tool with explicit options:

- **Retry checks** - rerun all prerequisite and authentication checks.
- **Stop setup** - leave the existing config unchanged.

Do not save a new config while a prerequisite is failing. The native reviewer and arbiter inherit the host model and need no separate health check.

## 3. Choose Workspace

Use the question tool. Always provide explicit options rather than treating an empty response as a default:

- **Use default workspace** - select `~/.prr/workspace`.
- **Keep current workspace** - show this only when an existing config has a different value.
- **Choose custom workspace** - collect a non-empty path in a follow-up question.

For a custom path, expand `~` when creating or checking the directory, but store the user's path in a readable form. Ask again if the response is empty.

## 4. Configure Jira

Use the question tool with these explicit options:

- **Skip Jira** - omit all Jira fields.
- **Keep current Jira settings** - show this only when `jira_configured` is true.
- **Configure Jira later** - keep Jira disabled and explain that credentials must be added outside the model session.

Never collect, display, or accept a Jira token through chat or a tool argument. **Keep current Jira settings** preserves the existing values inside the binary without returning them. Both **Skip Jira** and **Configure Jira later** clear existing Jira settings. For later configuration, tell the user to edit `~/.prr/config.yml` in a local editor after setup and restart OpenCode.

## 5. Write Configuration

Apply the selected workspace and fixed settings with:

```bash
"$PRR_BIN" config configure-open-code --workspace "<workspace_path>"
```

Add `--clear-jira` when the user selected **Skip Jira** or **Configure Jira later**. The binary preserves existing Jira credentials otherwise, writes the config with owner-only permissions, creates the workspace, and prints only non-secret status. Run `"$PRR_BIN" config runtime` afterward and verify the returned settings.

## 6. Confirm

Report the config path, selected workspace, fixed reviewers, Codex timeout, arbitration rounds, Jira status, and successful prerequisite checks.

Repeat the plaintext-token warning when Jira is configured. Explain that review clones and artifacts are stored under the workspace.

If the selected workspace is not `~/.prr/workspace`, tell the user to quit and restart OpenCode now. The npm plugin loads configuration at startup and must refresh external-directory permissions for a custom workspace before `/prr-start` can use it.
