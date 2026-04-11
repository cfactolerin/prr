---
name: prr-setup
description: First-time setup wizard for PRR. Configures workspace path, Jira credentials, and agent defaults.
argument-hint: ""
allowed-tools: ["Bash(mkdir *)", Read, Write, AskUserQuestion]
---

# PRR Setup

Run the PRR setup wizard to configure your environment interactively.

## Instructions

### Step 1 — Load existing config (if any)

Read `~/.prr/config.yml` if it exists. Note the current values — they will be shown as defaults in each prompt. If the file does not exist, use these defaults:

| Field | Default |
|---|---|
| `workspace_path` | `~/.prr/workspace` |
| `agents` | `["claude"]` |
| `claude_timeout` | `600` |
| `codex_timeout` | `900` |
| `gemini_timeout` | `300` |
| `gemini_model` | `gemini-2.5-flash` |
| `arbiter_rounds` | `3` |
| `google_cloud_project` | `fuga-prod` |
| `google_cloud_location` | `europe-west4` |
| `jira_base_url` | _(empty)_ |
| `jira_email` | _(empty)_ |
| `jira_api_token` | _(empty)_ |

### Step 2 — Ask the user for each value

Use the `AskUserQuestion` tool to ask for each of the following, **one at a time**. Show the current/default value so the user can press Enter to keep it.

Ask in this order:

1. **Workspace path** — "Where should PRR store cloned repos and review data?" (default: current `workspace_path`)
2. **Agents** — "Which agents should run reviews? Options: claude, codex, gemini (comma-separated)" (default: current agents joined by comma)
3. **Google Cloud Project** — Only ask if "gemini" is in the agents list. "What is your Google Cloud project ID for Vertex AI?" (default: current `google_cloud_project`)
4. **Google Cloud Location** — Only ask if "gemini" is in the agents list. "What is your Google Cloud location for Vertex AI?" (default: current `google_cloud_location`)
5. **Jira base URL** — "What is your Jira base URL? (e.g. https://yourorg.atlassian.net) Leave blank to skip Jira integration." (default: current `jira_base_url`)
6. **Jira email** — Only ask if a Jira base URL was provided. "What email do you use for Jira?" (default: current `jira_email`)
7. **Jira API token** — Only ask if a Jira base URL was provided. "What is your Jira API token?" (default: current `jira_api_token`)

For each answer:
- If the user responds with an empty string or says "keep" / "default", retain the current value.
- For agents, split the response by commas, trim whitespace, and filter empties.

### Step 3 — Write the config

Create the directory `~/.prr` if needed (via `mkdir -p ~/.prr`), then write the YAML config to `~/.prr/config.yml` using the Write tool. The format must be:

```yaml
workspace_path: <value>
agents:
  - <agent1>
  - <agent2>
claude_timeout: 600
codex_timeout: 900
gemini_timeout: 300
gemini_model: gemini-2.5-flash
arbiter_rounds: 3
google_cloud_project: <value>
google_cloud_location: <value>
jira_base_url: <value>
jira_email: <value>
jira_api_token: <value>
```

Omit jira fields if the user left them blank (do not write empty strings).

### Step 4 — Configure permissions

PRR subagents need `Write` and `Bash` permissions to the workspace. Add these to the user's Claude Code settings so they're auto-approved during reviews.

1. Determine the settings file path: use `$CLAUDE_CONFIG_DIR/settings.json` if `CLAUDE_CONFIG_DIR` is set, otherwise `~/.claude/settings.json`.
2. Read the current settings file (create `{"permissions":{"allow":[]}}` if it doesn't exist).
3. Add these patterns to `permissions.allow` if not already present:
   - `"Write(~/.prr/**)"` — allows agents to write review files
   - `"Bash(*)"` — allows agents to run codex/gemini CLIs, git commands, and tests
4. Write the updated settings back.
5. Tell the user what was added and which settings file was updated.

### Step 5 — Confirm

Read back `~/.prr/config.yml` and show the user a summary, then inform them:

> Config saved to `~/.prr/config.yml`. This file contains your workspace path, agent list, timeouts, and Jira credentials (including your API token in plaintext). Keep this file private — do not commit it to any repository.
>
> Review data (cloned repos, diffs, agent reviews, reports) is stored under your workspace path.
