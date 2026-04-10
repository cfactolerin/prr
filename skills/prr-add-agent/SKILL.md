---
name: prr-add-agent
description: Add a review agent to the active agent list. Supported agents are claude, codex, and gemini.
argument-hint: <agent-name>
allowed-tools: [Bash]
---

# Add Agent

Agent name: $ARGUMENTS

Supported agents: `claude`, `codex`, `gemini`

## Instructions

```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal agents add $ARGUMENTS
```

Confirm by listing:

```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal agents list
```
