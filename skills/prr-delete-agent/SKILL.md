---
name: prr-delete-agent
description: Remove a review agent from the active agent list.
argument-hint: <agent-name>
allowed-tools: [Bash]
---

# Delete Agent

Agent name: $ARGUMENTS

## Instructions

First, read `~/.prr/config.yml`. If it does not exist, tell the user: "PRR has not been set up yet. Run `/prr:setup` first." Then stop.

```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal agents delete $ARGUMENTS
```

Confirm by listing:

```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal agents list
```
