# PRR Plugin — Developer Reference

## Project Overview

PRR is a Claude Code plugin that delivers AI-powered PR reviews. It consists of:

- **Rust binary** (`src/`) — heavy lifting: config management, PR resolution, repo cloning, Jira/Confluence fetching, prompt assembly, report parsing, and workspace cleanup.
- **Claude Code skills** (`skills/`) — orchestration layer: each skill is a markdown file that instructs Claude Code how to drive the binary and dispatch sub-agents.
- **Agent definitions** (`agents/`) — markdown persona files for each reviewer role (claude-reviewer, codex-reviewer, gemini-reviewer, arbiter).

## Repository Structure

```
prr/
├── bin/
│   └── prr-darwin-universal    # Pre-built universal macOS binary (committed)
├── src/                        # Rust source
│   ├── main.rs                 # CLI entry point and subcommand dispatch
│   ├── config.rs               # Config struct, load/save, agent CRUD
│   ├── context.rs              # Context gathering: PR fetch, clone, Jira, prompt setup
│   ├── pr.rs                   # PR URL/ref parsing → owner, repo, number
│   ├── workspace.rs            # Workspace directory layout and round management
│   ├── git.rs                  # Git clone, fetch, checkout operations
│   ├── jira.rs                 # Jira REST API client and Confluence fetcher
│   ├── html.rs                 # HTML-to-markdown conversion (html2text wrapper)
│   ├── prompt.rs               # Prompt assembly for review, arbiter, and Q&A
│   ├── report.rs               # Final-report parser → structured JSON
│   └── cleanup.rs              # Workspace cleanup (removes merged/closed PR dirs)
├── skills/
│   ├── prr-setup/SKILL.md      # /prr:setup — interactive setup via AskUserQuestion
│   ├── prr-start/SKILL.md      # /prr:start — full review orchestration
│   ├── prr-add-agent/SKILL.md  # /prr:add-agent — enables an agent in config
│   ├── prr-delete-agent/SKILL.md  # /prr:delete-agent — removes an agent from config
│   └── prr-cleanup/SKILL.md    # /prr:cleanup — removes stale workspace entries
├── agents/
│   ├── claude-reviewer.md      # Claude sub-agent persona for PR review
│   ├── codex-reviewer.md       # Codex sub-agent persona for PR review
│   ├── gemini-reviewer.md      # Gemini sub-agent persona for PR review
│   └── arbiter.md              # Arbiter persona for synthesis and Q&A
├── scripts/
│   └── build-universal.sh      # Builds universal macOS binary via lipo
├── Cargo.toml
├── Cargo.lock
├── README.md
└── CLAUDE.md                   # This file
```

## Rust Binary Subcommands

| Subcommand | Description |
|---|---|
| `context <pr> --workspace <path>` | Fetch PR metadata, clone repo, download Jira ticket, write context manifest |
| `prompt --review <dir>` | Assemble review prompt from context dir; write to `results/review-prompt.md` |
| `prompt --arbiter <dir>` | Assemble arbiter prompt (all reviews + Q&A log); write to `results/arbiter-prompt.md` |
| `prompt --question <dir> --agent <name> --questions <json>` | Assemble per-agent question prompt for a Q&A round |
| `parse-report <path>` | Parse `final-report.md` into structured JSON (verdict, comments, review body) |
| `cleanup --workspace <path>` | Remove workspace subdirectories for PRs that are merged or closed |
| `agents list` | Print configured agents from `~/.prr/config.yml` |
| `agents add <name>` | Add an agent to config (validates against `KNOWN_AGENTS`) |
| `agents delete <name>` | Remove an agent from config |

The binary path in skills is `${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal`.

## Build Instructions

Build the universal macOS binary:

```bash
./scripts/build-universal.sh
```

Manual steps:

```bash
export MACOSX_DEPLOYMENT_TARGET=12.0
cargo build --release --target x86_64-apple-darwin
cargo build --release --target aarch64-apple-darwin
lipo -create \
  target/x86_64-apple-darwin/release/prr \
  target/aarch64-apple-darwin/release/prr \
  -output bin/prr-darwin-universal
chmod +x bin/prr-darwin-universal
```

Rust targets must be installed:

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
```

The `bin/prr-darwin-universal` binary is committed to the repository so users do not need a Rust toolchain.

## Versioning

The version must be kept in sync across **three files**:

1. `Cargo.toml` — `version` field (baked into the binary at compile time via `env!("CARGO_PKG_VERSION")`)
2. `.claude-plugin/marketplace.json` — `version` field (used by Claude Code plugin cache)
3. `bin/prr-darwin-universal` — must be rebuilt whenever `Cargo.toml` version changes

**When bumping the version:** update both `Cargo.toml` and `marketplace.json` to the same value, then rebuild the binary with `./scripts/build-universal.sh`. Commit all three changes together. Never bump `marketplace.json` without rebuilding if `Cargo.toml` also changed.

## Conventions

- **Rust edition:** 2021
- **Error handling:** `Box<dyn Error>` throughout — no custom error types unless the complexity warrants it
- **No `unwrap()` in production paths** — use `?` or explicit error messages
- **Config precedence:** CLI flags > `~/.prr/config.yml` > compiled defaults
- **Workspace layout:** `<workspace_path>/<owner>-<repo>-pr-<N>/r<round>/` — each re-review creates a new round directory; context and results live under it
- **Skills reference the binary** via `${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal` — never hardcode paths
- **Agent timeout fallback:** unknown agent names fall back to `claude_timeout`

## Adding a New Agent

1. **Add the agent name** to `KNOWN_AGENTS` in `src/config.rs`.
2. **Add a timeout field** to the `Config` struct (e.g., `my_agent_timeout: u64`) with a `default_*` helper and include it in `agent_timeout()` match arm and `Default` impl.
3. **Create an agent definition** at `agents/my-agent-reviewer.md` — describe the agent's persona, how to invoke the CLI, and expected output format.
4. **Update `skills/prr-start/SKILL.md`** — add a dispatch block in Phase 4c for the new agent, including the exact CLI invocation and output path.
5. **Document** the new agent in `README.md` under Prerequisites and Agent Management.
6. **Rebuild** the binary and commit the updated `bin/prr-darwin-universal`.
