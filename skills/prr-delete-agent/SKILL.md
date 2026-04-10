---
name: prr-delete-agent
description: Remove a review agent from the active agent list.
argument-hint: <agent-name>
allowed-tools: [Bash]
---

# Delete Agent

Agent name: $ARGUMENTS

## Instructions

```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal agents delete $ARGUMENTS
```

Confirm by listing:

```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal agents list
```
