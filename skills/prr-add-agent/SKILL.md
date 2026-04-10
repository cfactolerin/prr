---
name: prr-add-agent
description: Add a review agent to the active agent list. Supported agents are claude, codex, and gemini.
argument-hint: <agent-name>
allowed-tools: [Bash, AskUserQuestion]
---

# Add Agent

Agent name: $ARGUMENTS

Supported agents: `claude`, `codex`, `gemini`

## Instructions

### Step 0: Check setup

Read `~/.prr/config.yml`. If it does not exist, tell the user: "PRR has not been set up yet. Run `/prr:setup` first." Then stop.

### Step 1: Verify the agent CLI is installed

Before adding the agent, run a quick smoke test to confirm the CLI tool is available and working.

**If agent is `claude`:**
Claude is already running (you are Claude). Skip the smoke test — just add it.

**If agent is `codex`:**
Run:
```bash
echo "Say hello" | codex -a never exec -s read-only --ephemeral --color never -
```

**If agent is `gemini`:**
Read `~/.prr/config.yml` to get `gemini_model` (default: `gemini-2.5-flash`), then run:
```bash
echo "Say hello" | gemini -p "" -m <model> -o text --approval-mode yolo
```

### Step 2: Handle smoke test result

**If the smoke test succeeded** (exit code 0 and produced output):
Proceed to Step 3.

**If the command was not found or failed:**
Tell the user the agent CLI is not installed or not working. Provide install instructions:

- **codex**: "Codex CLI is not installed. Install it with: `npm install -g @openai/codex`. Then try running `codex --version` to verify."
- **gemini**: "Gemini CLI is not installed. Install it with: `npm install -g @anthropic-ai/gemini-cli`. Then try running `gemini --version` to verify."

Ask the user if they want to proceed with adding the agent anyway (they may plan to install it later), or cancel.

### Step 3: Add the agent

```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal agents add $ARGUMENTS
```

### Step 4: Confirm

List active agents:

```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal agents list
```
