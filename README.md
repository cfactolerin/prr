# PRR - AI-Powered Pull Request Reviews

PRR runs two independent reviews of a GitHub pull request, compares their evidence in a separate arbiter context, and walks you through the findings before anything is posted.

The OpenCode plugin uses:

- OpenCode's active model for a native review.
- Codex CLI as an independent second review harness.
- OpenCode's active model in a separate arbiter context for synthesis and follow-up questions.

The existing Claude Code plugin remains available during the OpenCode migration.

## Requirements

The OpenCode plugin currently supports macOS on Apple Silicon and Intel.

- [OpenCode](https://opencode.ai)
- [Codex CLI](https://github.com/openai/codex) 0.155.0 or newer
- [GitHub CLI](https://cli.github.com/)
- `git`

Authenticate the external tools once:

```bash
gh auth login
codex login
```

Verify both sessions:

```bash
gh auth status
codex login status
```

PRR does not read or store GitHub or Codex credentials. Optional Jira credentials are stored in `~/.prr/config.yml` when configured.

PRR runs Codex with user configuration, hooks, rules, apps, web search, and subagents disabled. Its filesystem permission profile can read the cloned repository and required system runtimes, but denies other user files.

## Install For OpenCode

Add `opencode-prr` to the `plugin` array in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-prr"]
}
```

Preserve any existing settings and plugin entries in that file. OpenCode installs npm plugins automatically with Bun when it starts.

Quit and restart OpenCode after changing the configuration. Then run:

```text
/prr-setup
```

Setup verifies `gh`, `git`, and Codex, then configures the review workspace. Existing Jira settings can be preserved or removed; new credentials must be added outside the model session.

## Start A Review

```text
/prr-start https://github.com/owner/repo/pull/42
```

Short references are also accepted:

```text
/prr-start owner/repo#42
```

To override automatic ticket detection:

```text
/prr-start owner/repo#42 --ticket PROJ-123
```

PRR gathers the context and shows it before dispatching either reviewer. You can add focus areas, investigate the final findings, edit or reject proposed comments, and choose whether to approve, comment, request changes, or post nothing.

## OpenCode Commands

| Command | Description |
|---|---|
| `/prr-setup` | Configure the workspace, verify prerequisites, and preserve or remove existing Jira context |
| `/prr-start <pr>` | Run native OpenCode and Codex reviews, arbitration, findings review, and optional posting |
| `/prr-cleanup` | Remove review workspaces whose pull requests are closed or merged |

The OpenCode reviewer and arbiter inherit the model selected in the current OpenCode session. PRR does not require an Anthropic model or a separate model setting.

## How It Works

1. **Context gathering:** the Rust engine clones the pull request, computes the diff, fetches linked Jira and Confluence context, and indexes repository guidance such as `AGENTS.md`, `CLAUDE.md`, and `README.md`.
2. **Independent review:** a native OpenCode subagent and Codex CLI receive the same prompt in separate contexts. Neither receives the other's output.
3. **Arbitration:** a separate OpenCode subagent compares both reviews and may ask either reviewer for path, line, test, or documentation evidence.
4. **Interactive review:** PRR presents each finding individually so it can be accepted, edited, challenged, or rejected.
5. **GitHub posting:** PRR builds a review only from the accepted findings and posts it through `gh api` after explicit confirmation.

## Configuration And Data

PRR stores local state under `~/.prr`:

| Data | Default location |
|---|---|
| Configuration and optional Jira credentials | `~/.prr/config.yml` |
| Clones, diffs, reviews, and reports | `~/.prr/workspace/` |

The OpenCode setup writes these fixed review settings:

```yaml
agents:
  - opencode
  - codex
codex_timeout: 900
arbiter_rounds: 3
```

`workspace_path` is configurable. If setup selects a workspace outside `~/.prr/workspace`, restart OpenCode so the plugin can refresh the subagents' external-directory permissions.

Jira tokens are stored as plaintext in `~/.prr/config.yml`, which PRR writes with owner-only permissions. Add or replace credentials in a local editor rather than through an OpenCode chat, and do not commit the file.

## Updating

OpenCode resolves npm plugins when it starts. Restart OpenCode to load an updated `opencode-prr` release. Pin a version in the plugin entry when you need reproducible installations:

```json
{
  "plugin": ["opencode-prr@0.15.0"]
}
```

## Uninstall From OpenCode

Remove `opencode-prr` from the `plugin` array in `~/.config/opencode/opencode.json`, then restart OpenCode.

To also remove PRR configuration and cached review data:

```bash
rm -rf ~/.prr
```

## Claude Code Compatibility

The previous Claude Code distribution is retained during migration. Install it inside Claude Code with:

```text
/plugin marketplace add cfactolerin/prr
/plugin install prr@cfactolerin-prr
```

Its commands remain namespaced as `/prr:setup`, `/prr:start`, `/prr:add-agent`, `/prr:delete-agent`, and `/prr:cleanup`.

## Development

Install JavaScript dependencies and run both test suites:

```bash
npm install
npm test
cargo test
npm pack --dry-run
```

Build the committed universal macOS binary:

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
./scripts/build-universal.sh
```

The npm package includes the OpenCode Markdown assets and `bin/prr-darwin-universal`, so users do not need this repository or a Rust toolchain.
