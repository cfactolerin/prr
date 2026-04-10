# PRR — AI-Powered PR Review Plugin

PRR is a Claude Code plugin that runs parallel AI code reviews using Claude, Codex, and Gemini as independent reviewers, then synthesizes their findings through a Claude-powered arbiter that cross-examines each reviewer with follow-up questions before producing a final verdict, confidence score, and inline line comments ready to post to GitHub.

## Prerequisites

**Required:**
- [Claude Code CLI](https://claude.ai/code) — runs the plugin skills
- [GitHub CLI (`gh`)](https://cli.github.com/) — fetches PR metadata and posts reviews
- `git` — clones and manages sandboxed repo copies

**Optional (enable additional reviewers):**
- [Codex CLI](https://github.com/openai/codex) — for the `codex` agent
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) — for the `gemini` agent

## Installation

Inside a Claude Code session:

```
/plugin marketplace add cfactolerin/prr
/plugin install prr@cfactolerin-prr
```

## Quick Start

```
/prr:setup
```
Run once to configure your workspace path, GitHub username, and Jira credentials.

```
/prr:start https://github.com/owner/repo/pull/42
```
Start a full review. PRR gathers context, runs all configured agents in parallel, runs the arbiter, and walks you through posting comments.

## Skills

| Skill | Description |
|---|---|
| `/prr:setup` | First-time setup wizard — configures workspace, GitHub user, and Jira credentials |
| `/prr:start <pr>` | Full review workflow: context, parallel agents, arbiter synthesis, comment posting |
| `/prr:add-agent <name>` | Enable an agent (`claude`, `codex`, `gemini`) in your config |
| `/prr:delete-agent <name>` | Remove an agent from your config |
| `/prr:cleanup` | Remove workspace entries for merged or closed PRs |

## How It Works

1. **Context gathering** — PRR clones the repo, checks out the PR branch, fetches the diff, and downloads any linked Jira ticket and Confluence pages into a local context directory.
2. **Parallel review** — All configured agents (Claude, Codex, Gemini) receive the same review prompt and run simultaneously, each writing an independent `*-review.md` to the results directory.
3. **Arbiter synthesis** — A Claude arbiter reads all reviews, asks targeted follow-up questions of individual agents (up to N configurable rounds), then produces a final report with a verdict, confidence level, and checked line comments.
4. **Interactive investigation** — You can ask questions about findings, read code, run git blame, or trigger a re-review with additional guidance before proceeding.
5. **Comment posting** — PRR presents each proposed line comment for your review (accept, edit, clarify, or reject), then posts the approved set as a GitHub PR review via `gh api`.

## Agent Management

Add an agent:
```
/prr:add-agent codex
/prr:add-agent gemini
```

Remove an agent:
```
/prr:delete-agent gemini
```

The `agents` list in `~/.prr/config.yml` controls which agents run on every review.

## Configuration

Config lives at `~/.prr/config.yml`. All keys are optional — defaults are shown below.

| Key | Default | Description |
|---|---|---|
| `workspace_path` | `~/.prr/workspace` | Where repos are cloned and results are stored |
| `agents` | `["claude"]` | Active reviewer agents |
| `claude_timeout` | `600` | Seconds before Claude reviewer times out |
| `codex_timeout` | `900` | Seconds before Codex reviewer times out |
| `gemini_timeout` | `300` | Seconds before Gemini reviewer times out |
| `gemini_model` | `gemini-2.5-flash` | Gemini model name passed to the CLI |
| `arbiter_rounds` | `3` | Maximum Q&A rounds before the arbiter is forced to finalize |
| `jira_base_url` | _(empty)_ | Your Jira instance URL (e.g. `https://yourorg.atlassian.net`) |
| `jira_email` | _(empty)_ | Jira account email for Basic auth |
| `jira_api_token` | _(empty)_ | Jira API token |
| `github_user` | _(empty)_ | Your GitHub username |

## Data Storage

PRR stores all configuration and review data locally:

| What | Where |
|------|-------|
| Config (settings, Jira creds) | `~/.prr/config.yml` |
| Cloned repos, diffs, reviews | `~/.prr/workspace/` (configurable) |

**Note:** `~/.prr/config.yml` contains your Jira API token in plaintext. Do not commit this file to any repository. It is created per-user by `/prr:setup` and should stay in your home directory.

## Building from Source

A universal macOS binary is included at `bin/prr-darwin-universal`. To rebuild it yourself:

```bash
./scripts/build-universal.sh
```

Or manually:

```bash
export MACOSX_DEPLOYMENT_TARGET=12.0
cargo build --release --target x86_64-apple-darwin
cargo build --release --target aarch64-apple-darwin
lipo -create \
  target/x86_64-apple-darwin/release/prr \
  target/aarch64-apple-darwin/release/prr \
  -output bin/prr-darwin-universal
```

Requires Rust with both targets installed:
```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
```
