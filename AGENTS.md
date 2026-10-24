# PRR Developer Reference

## Project Overview

PRR performs independent AI pull request reviews and synthesizes their findings into a report that can be posted to GitHub. The repository ships an OpenCode integration over a Rust engine:

- **OpenCode plugin** (`index.js`, `package.json`, `.opencode/`) - distributed directly from GitHub. OpenCode orchestrates a native review and arbitration while Codex supplies an independent second review.
- **Rust binary** (`src/`) - config management, PR resolution, cloning, Jira and Confluence fetching, prompt assembly, report parsing, and cleanup.

The Claude Code distribution is no longer maintained or packaged. Its metadata remains in Git history; legacy definitions under `skills/` and `agents/` remain in the working tree.

## Repository Structure

```text
prr/
|-- .opencode/
|   |-- commands/              # OpenCode slash-command entry points
|   |-- skills/                # OpenCode orchestration instructions
|   `-- agents/                # Restricted setup/review orchestrators and isolated roles
|-- agents/                    # Retained legacy agent definitions
|-- skills/                    # Retained legacy skills
|-- bin/
|   `-- prr-darwin-universal   # Committed universal macOS binary
|-- references/
|   `-- prompts/               # Templates compiled into the Rust binary
|-- src/                       # Rust source
|-- index.js                   # OpenCode plugin entry point
|-- tui.js                     # OpenCode 2 sidebar entry point
|-- package.json               # OpenCode package metadata
|-- Cargo.toml
`-- README.md
```

The OpenCode plugin registers commands and agents from `.opencode/`, adds the packaged skills directory, and injects `PRR_BIN` into shell environments. `index.js` default-exports one object that serves both OpenCode generations: OpenCode 1 (1.18.29+) calls `server()` and applies the V1 `config` hook, while OpenCode 2 calls `setup(ctx)`, which registers the same assets through domain transforms and converts V1 agent permissions to V2 rules (`bash` becomes `shell`, `task` becomes `subagent`).

OpenCode 2 does not evaluate permissions for plugin tools and gives plugins no way to raise an approval prompt. Each PRR tool therefore checks the calling agent's own rule itself, and any action that needs user approval must go through a shell command with an `ask` rule. That is why GitHub posting is `"$PRR_BIN" post-review`, not a plugin tool.

OpenCode assets must use quoted `"$PRR_BIN"`; retained legacy assets use `${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal`.

The OpenCode 2 sidebar reads session-scoped review progress and the manifest header through the read-only RPC in `review-rpc.js`. `review-state.js` persists that state in plugin storage; only the orchestrator can update stages through `prr_progress`. The sidebar receives neither private reviewer artifacts nor workspace paths.

After explicit briefing continuation, `prr_progress` with `step: 7`, `status: "in_progress"`, and `view: "diff"` emits a one-shot diff request. The app-level TUI listener opens `review-panel.js` only for that request's active session and location, independently of sidebar visibility. `/prr-diff` remains a manual entry point.

`review-reader.js` serves the saved final report and individual file diffs only for the session's bound round; clients supply snapshot and file/finding IDs, never filesystem paths. Unchanged references use the saved head commit, not the mutable clone. File links use semantic status colors and plain underlines; dashed underlines are not exposed by OpenTUI.

Navigation is read-only, and discussion returns to the existing chat workflow without accepting findings. OpenCode 1 keeps its native `todowrite` list and chat investigation.

The visual view's **Continue review** action (`c`) sends a request to resume the investigation menu, including for reviews without findings. Escape and **Back to discussion / Back to chat** only close the panel; they never send a prompt or replace a pending chat question. Neither action accepts findings, completes investigation, or authorizes posting.

**Discuss in chat** enters or resumes the existing one-at-a-time findings review at the selected ID without a popup. It shows the full 8b/8c rich block (focused code, location/origin, why it matters, fix, comment) and Accept/Reject/Edit/Add finding/Finish findings menu, not a brief summary or generic question. Prior decisions and edits survive view switches. Questions investigate the same finding and return to its menu without deciding it; reopening the diff never repeats the briefing or mode chooser.

`statistics.js` keeps a private, append-only local event ledger under `~/.prr/statistics/v1/`, outside cleaned workspaces. OpenCode 2 records command starts, bound rounds, original reviewer candidates, arbiter attribution, and explicit human decisions. `/prr-stats` uses a read-only role; it does not replace an active review orchestrator.

The arbiter's final report includes a structured `Review Statistics` section, validated against original and final finding IDs and saved Q&A bounds. Arbiter precision and explicit human correctness judgments are separate measures; accept/reject/edit alone never proves true/false. Missing attribution, unverified claims, and old reviews remain unassessed, and statistics never enter GitHub review bodies.

The seven stages include a user-gated Review briefing between arbiter synthesis and interactive investigation. Its concise change summary, assessment, and actionable concerns come from the arbiter report; statistics and routine compatibility/testing disclaimers stay out of the briefing. Context gathering supplies GitHub CI status and bounded pre-PR file history.

Confidence measures assessment coverage, intent and ticket alignment, language/repository standards, and unresolved material questions; not rerunning passing CI locally is not a penalty. New and changed code should use clear supported practices without unrelated legacy modernization. Reviewers assess backwards compatibility and flag supported unintended changes as findings.

## OpenCode Architecture

The OpenCode workflow has a restricted setup agent plus two review harnesses and four isolated review roles:

1. `prr-setup-orchestrator` runs `/prr-setup` without review-workspace access.
2. `prr-orchestrator` runs `/prr-start` in the primary thread with access limited to PRR artifacts and required commands.
3. `prr-opencode-reviewer` performs a native review with the active host model.
4. `prr-codex-reviewer` invokes Codex CLI for an independent review.
5. `prr-arbiter` uses the active host model in a separate context to compare reviews and request evidence.

Do not replace the native reviewer with a nested `opencode run`. Keep reviewer and arbiter contexts separate. The OpenCode distribution uses reviewer keys `opencode` and `codex`; legacy configuration still supports a configurable reviewer list.

## Rust Binary Subcommands

| Subcommand | Description |
|---|---|
| `context <pr> --workspace <path>` | Fetch PR metadata, clone the repo, fetch ticket context, and write a context manifest |
| `context-open-code <pr>` | Gather context in the configured OpenCode workspace |
| `context-atlassian <round>` | Import the saved MCP snapshot and supplement missing context with REST |
| `prompt --review <dir>` | Write `results/review-prompt.md` |
| `prompt --arbiter <dir>` | Assemble reviews and Q&A history into `results/arbiter-prompt.md` |
| `prompt --question <dir> --agent <name> --questions-file <path> [--round <N>]` | Write a reviewer question prompt; inline `--questions` remains for legacy compatibility |
| `parse-report <path>` | Parse a final report into structured JSON |
| `post-review <pr> --payload <path>` | Validate a round's review payload against its clone and the live PR head, then post it through `gh api` |
| `cleanup --workspace <path>` | Remove workspace entries for closed or merged PRs |
| `cleanup-open-code` | Clean the configured OpenCode workspace |
| `config runtime` | Print non-secret OpenCode runtime settings as JSON |
| `config configure-open-code --workspace <path> [--clear-jira]` | Apply fixed OpenCode settings without exposing preserved credentials |
| `agents list/add/delete` | Manage the legacy configurable reviewer list |
| `opencode check/set-model` | Manage the legacy nested OpenCode reviewer |

## Build And Test

Run Rust and npm tests:

```bash
cargo test
npm test
npm pack --dry-run
```

Build the universal macOS binary:

```bash
./scripts/build-universal.sh
```

The build requires both Rust targets:

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
```

The committed binary lets users install the OpenCode plugin without a Rust toolchain.

OpenCode 2 context gathering uses `context-open-code --defer-atlassian`, then the bound-round `prr_atlassian_context` tool. The tool discovers connected MCP servers and invokes only supported Atlassian read tools. The Rust importer saves reviewer context and uses configured REST credentials when needed. Reviewers and the arbiter never receive direct MCP access. OpenCode 1 and standalone context commands retain REST fetching.

MCP executors enforce permissions even when a plugin calls them internally. The V2 orchestrator therefore has narrow grants for the bridge's four read-tool names. Session hooks remove those tools from PRR model requests, so ticket and page reads still go through the bound-round bridge. Keep the grants and request filtering synchronized; do not grant Atlassian discovery or write tools.

## Versioning

Every commit bumps the version, rebuilds the binary, and keeps all metadata synchronized. The version appears in:

1. `Cargo.toml`
2. `Cargo.lock`
3. `package.json`
4. `package-lock.json`
5. `bin/prr-darwin-universal`, through its compiled Cargo version

Binary-affecting changes under `src/`, `references/prompts/`, or Rust dependency metadata bump the minor version and reset the patch. Plugin metadata, agent, skill, and documentation-only changes bump the patch version. Rebuild the binary for every version bump, including documentation-only changes.

## Distribution

The supported installation is `opencode plugin add 'github:cfactolerin/prr#main'`. Private repositories can use explicit SSH or HTTPS Git package specifications with existing Git credentials. Keep the packaged assets and rebuilt universal binary committed with each version so GitHub installations need no Rust toolchain.

Run `npm pack --dry-run --json` to confirm runtime assets before releasing. Pushing to `main` makes the revision available to GitHub installations; users install it with `opencode plugin update` using their configured package target. npm publication is optional and must only be performed when explicitly requested.

## Conventions

- Rust edition: 2021.
- Use `Box<dyn Error>` unless error complexity warrants a custom type.
- Do not use `unwrap()` in production paths.
- Config precedence is CLI flags, then `~/.prr/config.yml`, then compiled defaults.
- Workspace layout is `<workspace>/<owner>-<repo>-pr-<N>/r<round>/`.
- OpenCode plugin assets are packaged from `.opencode/`; project-local discovery alone is not a distribution mechanism.
- OpenCode agent models are omitted intentionally so the native reviewer and arbiter inherit the active host model.
- The OpenCode package currently supports macOS arm64 and x64 through the universal binary.

## Findings Format

PRR findings use one of eight triggers:

`Acceptance Criteria` | `Code Change` | `Code Quality` | `Logic Bug` | `Security` | `Performance` | `Missing Test` | `Missing Doc / Error Handling`

| Symptom | Trigger |
|---|---|
| Diff violates ticket acceptance criteria | `Acceptance Criteria` |
| Wrong assumption, transformation, race, or boundary | `Logic Bug` |
| Injection, auth bypass, secret leak, unsafe deserialization | `Security` |
| Leak, unbounded growth, missing cleanup, slow query, expensive loop | `Performance` |
| Naming, duplication, readability, structure | `Code Quality` |
| New behavior lacks a test | `Missing Test` |
| New behavior lacks docs or error handling | `Missing Doc / Error Handling` |
| Suspicious change that fits no other trigger | `Code Change` |

Every finding requires `Severity`, `Anchor`, `Origin`, `Why this matters`, `Suggested fix`, and `Suggested comment`. `Location` is required for `diff` and `reference` anchors and omitted for `none`. The authoritative shape is `references/report-format.md`.

`Why this matters`, `Suggested fix`, and `Suggested comment` use short prose with the claim first. The prompt templates under `references/prompts/` contain the complete writing rules and must remain synchronized.

Anchor semantics:

- `diff` is a changed line and may be posted inline.
- `reference` is an unchanged line required as evidence and appears only in the review body.
- `none` is cross-cutting and appears only in the review body.

A finding is in scope only when the diff causes or exposes it, or ticket acceptance criteria require it.

`Origin` is `introduced` when the diff wrote the faulty logic and `pre-existing` when the fault is in unchanged code the base branch already had. Pre-existing findings stay in the report so the reviewer can decide whether to raise them, but they never drive `REQUEST_CHANGES`, never appear in the review body's "fix before merge" list, and post with a note that the issue predates the PR. `parse-report` treats a missing or unknown Origin as `introduced`.

## Changing OpenCode Assets

When changing an OpenCode command, skill, or agent:

1. Keep command entry points in `.opencode/commands/` thin.
2. Put workflow behavior in `.opencode/skills/`.
3. Put isolated reviewer behavior and permissions in `.opencode/agents/`.
4. Keep the registration lists in `index.js` synchronized with added or removed assets.
5. Run `npm test` and inspect `npm pack --dry-run --json` to confirm every runtime asset is packaged.
6. Test from a packed installation when changing module-relative paths or binary discovery.
