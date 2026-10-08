# PRR - AI-Powered Pull Request Reviews

PRR runs two independent reviews of a GitHub pull request, compares their evidence in a separate arbiter context, and walks you through the findings before anything is posted.

The OpenCode plugin uses:

- OpenCode's active model for a native review.
- Codex CLI as an independent second review harness, using `gpt-6-sol` by default.
- OpenCode's active model in a separate arbiter context for synthesis and follow-up questions.

## Requirements

The OpenCode plugin currently supports macOS on Apple Silicon and Intel.

- [OpenCode 2](https://opencode.ai) for the installation commands below
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

Install PRR directly from GitHub without an npm account, npm publication, manual clone, or Rust toolchain. The repository includes the plugin assets and a universal macOS binary. OpenCode installs its JavaScript dependencies automatically from the npm registry, so registry access is still needed, but an npm login is not.

### 1. Check Prerequisites

Install the tools listed under [Requirements](#requirements), authenticate `gh` and Codex, and select a working model in OpenCode for the native reviewer and arbiter. Confirm the executables are available in your terminal:

```bash
opencode --version
git --version
gh auth status
codex --version
codex login status
```

If the PRR repository is private, your Git credentials must have access to it. GitHub CLI authentication alone does not configure SSH access. Use one of the authenticated installation options in the next step if needed; never put a token in a plugin URL or OpenCode configuration.

### 2. Install From GitHub

Run this in your terminal from any directory to install PRR globally from the `main` branch:

```bash
opencode plugin add 'github:cfactolerin/prr#main'
opencode plugin list
```

For a private repository, choose **one** of these alternatives instead of the shortcut above.

**SSH:** configure your GitHub SSH key, verify repository access, then install:

```bash
git ls-remote git@github.com:cfactolerin/prr.git HEAD
opencode plugin add 'git+ssh://git@github.com/cfactolerin/prr.git#main'
```

**HTTPS:** use your GitHub CLI login as Git's credential helper:

```bash
gh auth setup-git
git ls-remote https://github.com/cfactolerin/prr.git HEAD
opencode plugin add 'git+https://github.com/cfactolerin/prr.git#main'
```

These commands install the same plugin. Do not register several URLs for PRR or keep an older `opencode-prr` npm entry alongside the GitHub entry. Remove the old entry from its configuration file when switching installation methods.

### Manual Configuration Alternative

Instead of `opencode plugin add`, add the GitHub package to `~/.config/opencode/opencode.json` or `opencode.jsonc` for every project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:cfactolerin/prr#main"]
}
```

Preserve existing settings and unrelated plugin entries. For a private repository, use the SSH or HTTPS package specification above as the array entry. To install only for one project, put the same `plugins` entry in that project's `opencode.json(c)` instead of the global file.

### 3. Load The Plugin

OpenCode watches configuration changes and installs missing packages in the background. Restart the service to ensure the plugin is loaded, then open OpenCode:

```bash
opencode service restart
opencode
```

### 4. Configure PRR

Inside OpenCode, run:

```text
/prr-setup
```

Setup verifies `gh`, `git`, and Codex, then configures the review workspace. It defaults to `~/.prr/workspace` and stores settings in `~/.prr/config.yml`.

Jira is optional. Setup can preserve or remove existing Jira settings. Add new credentials outside the model session.

After setup succeeds, use [Start A Review](#start-a-review). PRR supplies its own binary path; you do not need to install `prr` separately or set `PRR_BIN` yourself.

### Installation Troubleshooting

- **`opencode plugin add` is unavailable:** the CLI instructions require OpenCode 2. Upgrade OpenCode before following this guide. The plugin also retains compatibility with OpenCode 1.18.29+, but its configuration differs.
- **Repository not found or permission denied:** verify the matching `git ls-remote` command succeeds with an account or SSH key that can access the repository. Use the explicit SSH or HTTPS installation URL rather than the hosted shortcut.
- **`/prr-setup` is missing:** check `opencode plugin list`, ensure there is only one PRR entry, and run `opencode service restart`. Check that your current project's configuration has not disabled the plugin.

See the [OpenCode plugin guide](https://opencode.ai/v2/docs/plugins) for package installation and configuration details.

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

PRR gathers the context and shows it before dispatching either reviewer. You can add focus areas, ask the session to consult another OpenCode agent for additional context at any point, investigate the final findings, edit or reject proposed comments, and choose whether to approve, comment, request changes, or post nothing. User-requested context agents run in the foreground, so their answers remain in the active session context.

## OpenCode Commands

| Command | Description |
|---|---|
| `/prr-setup` | Configure the workspace, verify prerequisites, and preserve or remove existing Jira context |
| `/prr-start <pr>` | Run native OpenCode and Codex reviews, arbitration, findings review, and optional posting |
| `/prr-cleanup` | Remove review workspaces whose pull requests are closed or merged |

The OpenCode reviewer and arbiter inherit the model selected in the current OpenCode session and need no separate model setting.

## How It Works

1. **Context gathering:** the Rust engine clones the pull request, computes the diff, fetches linked Jira and Confluence context, and indexes repository guidance such as `AGENTS.md` and `README.md`.
2. **Independent review:** a native OpenCode subagent and Codex CLI receive the same prompt in separate contexts. Neither receives the other's output.
3. **Arbitration:** a separate OpenCode subagent compares both reviews and may ask either reviewer for path, line, test, or documentation evidence.
4. **Interactive review:** PRR presents each finding individually so it can be accepted, edited, challenged, or rejected.
5. **GitHub posting:** PRR builds a review only from the accepted findings and posts it with `prr post-review` after explicit confirmation and OpenCode's approval prompt for that command.

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

To choose the Codex model for OpenCode reviews, add or edit this setting in `~/.prr/config.yml`:

```yaml
codex_model: gpt-6-sol
```

Use a model ID supported by your Codex account. PRR reads the setting for each review, follow-up answer, and health check, so no restart is needed. Omitting it keeps `gpt-6-sol`; `/prr-setup` preserves an existing choice. PRR ignores Codex's own user configuration for isolated reviews, so set the model here rather than in `~/.codex/config.toml`.

Jira tokens are stored as plaintext in `~/.prr/config.yml`, which PRR writes with owner-only permissions. Add or replace credentials in a local editor rather than through an OpenCode chat, and do not commit the file.

## Updating

To update a GitHub installation tracking `main`, run:

```bash
opencode plugin check
opencode plugin update 'github:cfactolerin/prr#main'
opencode service restart
```

If you installed with SSH or HTTPS, replace the update target with the exact package entry shown by `opencode plugin list`. Startup checks can report new commits without installing them; restarting alone does not update the cached package.

For a reproducible installation, replace `main` in the configured entry with a full 40-character Git commit SHA:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:cfactolerin/prr#<full-40-character-commit-sha>"]
}
```

Replace the placeholder with an actual commit from this repository. Exact commit pins are skipped by `opencode plugin update`; change the SHA in your configuration when you want a newer revision. Existing PRR settings and review workspaces are preserved across updates.

## Uninstall From OpenCode

Remove the global GitHub installation with:

```bash
opencode plugin remove 'github:cfactolerin/prr#main'
opencode service restart
```

For SSH, HTTPS, or a pinned revision, use the exact configured package entry instead. If you added PRR manually or in project configuration, remove its entry from the corresponding `plugins` array. Removing the plugin leaves your PRR configuration and review workspaces intact.

To also permanently delete PRR configuration, optional Jira credentials, clones, and saved reviews:

```bash
rm -rf ~/.prr
```

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

The plugin package includes the OpenCode Markdown assets and `bin/prr-darwin-universal`, so users do not need a manual checkout or a Rust toolchain.
