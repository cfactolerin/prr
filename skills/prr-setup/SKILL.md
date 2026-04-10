---
name: prr-setup
description: First-time setup wizard for PRR. Configures workspace path, Jira credentials, and agent defaults.
argument-hint: ""
allowed-tools: [Bash, Read, Write, AskUserQuestion]
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
| `jira_base_url` | _(empty)_ |
| `jira_email` | _(empty)_ |
| `jira_api_token` | _(empty)_ |

### Step 2 — Ask the user for each value

Use the `AskUserQuestion` tool to ask for each of the following, **one at a time**. Show the current/default value so the user can press Enter to keep it.

Ask in this order:

1. **Workspace path** — "Where should PRR store cloned repos and review data?" (default: current `workspace_path`)
2. **Agents** — "Which agents should run reviews? Options: claude, codex, gemini (comma-separated)" (default: current agents joined by comma)
3. **Jira base URL** — "What is your Jira base URL? (e.g. https://yourorg.atlassian.net) Leave blank to skip Jira integration." (default: current `jira_base_url`)
4. **Jira email** — Only ask if a Jira base URL was provided. "What email do you use for Jira?" (default: current `jira_email`)
5. **Jira API token** — Only ask if a Jira base URL was provided. "What is your Jira API token?" (default: current `jira_api_token`)

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
jira_base_url: <value>
jira_email: <value>
jira_api_token: <value>
```

Omit jira fields if the user left them blank (do not write empty strings).

### Step 4 — Confirm

Read back `~/.prr/config.yml` and show the user a summary, then inform them:

> Config saved to `~/.prr/config.yml`. This file contains your workspace path, agent list, timeouts, and Jira credentials (including your API token in plaintext). Keep this file private — do not commit it to any repository.
>
> Review data (cloned repos, diffs, agent reviews, reports) is stored under your workspace path.
