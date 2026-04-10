---
name: prr-setup
description: First-time setup wizard for PRR. Configures workspace path, Jira credentials, and agent defaults.
argument-hint: ""
allowed-tools: [Bash, Read]
---

# PRR Setup

Run the PRR setup wizard to configure your environment.

## Instructions

Run the setup command:

```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal setup
```

This will interactively prompt for workspace path, GitHub username, Jira credentials, and defaults.

After setup completes, confirm the config was saved by reading `~/.prr/config.yml`.

Then inform the user:

> Config saved to `~/.prr/config.yml`. This file contains your workspace path, agent list, timeouts, and Jira credentials (including your API token in plaintext). Keep this file private — do not commit it to any repository.
>
> Review data (cloned repos, diffs, agent reviews, reports) is stored under your workspace path (default: `~/.prr/workspace/`).
