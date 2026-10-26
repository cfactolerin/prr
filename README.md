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

Jira is optional. PRR uses a connected Atlassian MCP server first, with configured Jira API credentials as a fallback. Setup can preserve or remove existing Jira settings. Add new credentials outside the model session.

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

In the OpenCode 2 terminal, the sidebar keeps seven review stages and the context manifest summary visible: PRR version, PR, title, author, branches, ticket, and round. After arbitration, **Review briefing** shows what changed, the implementation assessment, and findings needing attention. It pauses for an explicit next step, even when no findings were identified. You can ask for an explanation or stop without posting.

With an **APPROVE** verdict, **Continue to review action** skips investigation and the findings walk.
It goes directly to the approval/comment/request-changes choice and posting preview, including any
non-blocking suggestions. Rejected findings and approved edits are preserved; pending suggestions
are not accepted until you confirm the action, exact body, and proposed comments. Skipping or
cancelling posting leaves them pending. Other verdicts retain the diff/chat investigation choices.

Choosing **Investigate in diff view** opens the full-screen side-by-side diff directly in the active terminal. The sidebar action and `/prr-diff` remain available to reopen it. Select a finding to jump to its code and replace the findings list with its details.

File links are underlined and colored by status: added and deleted files use the theme's diff colors, modified files use its warning color, and renamed files use its information color. Status labels remain visible without color, and the selected file is bold. OpenTUI supports plain underlines, not dashed ones.

Unchanged references outside the diff open context from the saved PR commit; non-code findings show details without inventing an anchor. Automatic opening applies only to a fresh explicit choice in the active session; progress refreshes, returning to chat, and plugin reloads do not reopen a closed panel.

**Continue review** (`c`) returns to chat and resumes the investigation menu, including **Post review** when there are no findings. It does not accept findings or authorize posting. **Discuss in chat** instead switches directly to interactive investigation of the selected finding; Escape returns to that conversation without opening a menu.

Returning to chat preserves the selected finding and vertical scroll position; a new round or changed report resets them. Browsing files and findings requires no model calls; continuing or discussing sends a request to the review session.

**Accept** (`a`) and **Reject** (`x`) work directly in the diff sidebar without closing it. Decisions
and approved chat edits are shared with the findings walk and survive view switches. **Accept original**
replaces an approved edit with the original saved comment. Neither action authorizes posting or
classifies factual correctness; posting still requires confirmation in chat. Conflicting or stale
decisions must be refreshed instead of overwriting a newer choice.
Decision buttons and the `a`/`x` hint appear only for a selected finding. Browsing files without
selecting a finding hides those controls and disables their shortcuts.

The chat walk records its active finding before showing the full finding and menu. Reopening the
diff follows that finding, including report-only findings, instead of the last browsed file. An
unchanged focus does not interrupt manual file browsing while the panel stays open.

Use the single **Files [o]** chooser, `h`/`l` for previous/next file, `b` for the findings list, and `p`/`n` for previous/next finding. Arrow or Page Up/Down keys scroll vertically. Escape returns to the existing chat without sending a message; `c` explicitly opens the next-step review menu. Horizontal mouse scrolling stays synchronized between the before/after panes.

**Discuss in chat** opens the selected finding's full one-at-a-time review in the existing
conversation, without a popup. It shows focused code, why it matters, the suggested fix and comment,
then **Accept**, **Reject**, **Edit**, **Add finding**, and **Finish findings**. Questions investigate
that same finding and return to its menu without deciding it. Prior decisions and edits are preserved.
Reopen the diff to
keep browsing, then use **Back to discussion** or Escape to return without replacing the discussion
with another menu. **Discuss** always opens the selected finding's full view, even if the chat has
since advanced to another finding. The selected finding and diff position are retained.

**↑ Previous file** and **↓ Next file** cycle from the current file and wrap at either end. Choosing
another file leaves finding details and restores that file's saved vertical position; arrow keys
remain available for scrolling the diff.

Finding details render Markdown with colored section headings. Selected issue lines use blue
backgrounds: light blue with dark text, darker blue with light text. Behavioral findings include
code-grounded example scenarios in new reports; existing saved reports are not rewritten.

All changed files remain browsable, including binary and metadata-only changes. The viewer requires an OpenCode 2 client with session-panel support; other clients retain chat investigation. Artifacts over 32 MiB are rejected explicitly rather than truncated; chat investigation remains available.

PR and ticket links are clickable in terminals that support hyperlinks. The ticket links to the Jira site selected through MCP or configured for the API fallback. Sidebar state belongs to the review session and survives restarts; older six-stage sessions retain their progress with the new briefing pending. OpenCode 1 retains its built-in todo list with the same seven stages and briefing pause.

## OpenCode Commands

| Command | Description |
|---|---|
| `/prr-setup` | Configure the workspace, verify prerequisites, and preserve or remove existing Jira context |
| `/prr-start <pr>` | Run native OpenCode and Codex reviews, arbitration, findings review, and optional posting |
| `/prr-diff` | Open visual investigation of the saved review after continuing from its briefing (OpenCode 2 terminal) |
| `/prr-cleanup` | Remove review workspaces whose pull requests are closed or merged |
| `/prr-stats [PR or run ID]` | Show local usage, agreement rounds, reviewer effectiveness, and human decisions |

The OpenCode reviewer and arbiter inherit the model selected in the current OpenCode session and need no separate model setting.

## How It Works

1. **Context gathering:** PRR clones the pull request, computes the diff, fetches linked Jira and Confluence context through Atlassian MCP or the Jira API fallback, and indexes repository guidance such as `AGENTS.md` and `README.md`.
2. **Independent review:** a native OpenCode subagent and Codex CLI receive the same prompt in separate contexts. Neither receives the other's output.
3. **Arbitration:** a separate OpenCode subagent compares both reviews and may ask either reviewer for path, line, test, or documentation evidence.
4. **Review briefing:** read what changed, the assessment, and actionable concerns before explicitly continuing to diff or chat investigation.
5. **Interactive review:** browse side-by-side diffs and linked findings, or investigate in chat. **Discuss** carries a selected finding into the full findings walk, where you can accept, edit, challenge, or reject it before posting.
6. **GitHub posting:** PRR builds a review only from the accepted findings and posts it with `prr post-review` after explicit confirmation and OpenCode's approval prompt for that command. The briefing is not automatically published.

### Review Policy

Reviewers assess human readability rather than treating line length, method size, or disabled lint rules as automatic defects. New code should use clear practices supported by the configured runtime and dependencies, not repeat a poor legacy pattern for consistency. Improvements to existing code stay within the changed behavior; unrelated code is not modernized for its own sake. Bounded pre-PR commit history helps identify earlier decisions, but dates alone do not establish quality. Optional readability suggestions are low-severity and non-blocking, and must explain a concrete cost, compatible alternative, and tradeoff.

Backwards-compatibility checks distinguish intended behavior changes from unintended regressions and unclear requirements. They cover affected callers, consumers, data contracts, and deployment or migration needs. An intentional break still needs appropriate handling; a refactor does not authorize silent contract changes. Supported unintended changes become findings rather than a routine briefing section.

Confidence reflects coverage of affected areas, understanding of intent, ticket alignment, language and repository standards, and unresolved material questions. PRR captures GitHub CI results with the PR context and trusts relevant passing checks without requiring a local rerun. Missing local execution or hypothetical future cross-service changes do not lower confidence by themselves. Older saved reports retain their original verdict and confidence; missing assessments are unassessed rather than inferred.

## Review Statistics

Run `/prr-stats` for tracked runs, completed review rounds, findings found and rejected, and the
Q&A round where reviewers agreed. Round 0 means agreement in the initial reviews; unresolved
disagreements and missing assessments are shown separately. Use `/prr-stats owner/repo#42` or a
run ID for the per-review breakdown.

The harness/model table separates arbiter-validated candidates, refuted candidates, out-of-scope
concerns, duplicates, unresolved claims, and findings uniquely validated from one original reviewer.
Arbiter precision is validated / (validated + refuted). This is an arbiter judgment, not objective
ground truth or measured recall; unknown bugs and unattributed later discoveries cannot be counted.

Human decisions are a separate layer. Accept/reject/edit alone does not classify correctness;
explicit correctness judgments produce a separate human precision figure with its sample count.
Valid-but-not-worth-raising, already-fixed, and scope rejections are not false positives.

During final findings confirmation, **Classify accuracy** can record an optional correctness
assessment without changing the posting decision. New user-added findings are counted separately,
not credited to a reviewer. Findings rejected during the normal walk are counted immediately.

Local records live under `~/.prr/statistics/v1/`, outside the review workspace, and survive cleanup.
They contain PR references, finding IDs/titles, model identities, classification reasons, and decisions;
they do not copy diffs, prompts, credentials, or full review bodies, and are never uploaded or posted.

Tracking covers new OpenCode 2 `/prr-start` invocations after this feature is enabled, not lifetime
usage or reconstructed historical accuracy. Re-review adds a correlated round to the same run;
resuming a round does not add another run. Missing or invalid attribution remains unassessed.

Native model identities use observed session requests, and Codex identities use the requested CLI
model; round-start snapshots are the fallback. Changed models are marked mixed rather than silently
assigned to one model. Compare matching models and PRs, and use the sample denominators before
deciding which harness is more accurate.

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

### Atlassian Context

On OpenCode 2, PRR detects connected MCP servers with `getAccessibleAtlassianResources` and `getJiraIssue` read tools. Linked pages use `getConfluenceContent` or `getConfluencePage`. Authenticate your Atlassian server through OpenCode's `/mcps` interface; PRR does not read or copy its OAuth credentials or invoke write tools.

If you have access to multiple Atlassian sites, include the ticket's full URL in the PR title or description, or set `jira_base_url` in `~/.prr/config.yml`. PRR will not guess which site owns a ticket key.

When MCP is unavailable, unsupported, or cannot fetch the ticket, PRR tries the existing `jira_base_url`, `jira_email`, and `jira_api_token` settings. Partial page reads and attachments also try this fallback without discarding fetched MCP context. MCP alone saves attachment metadata, not attachment files, and fetches up to 20 linked pages. Missing context is noted in the manifest shown before reviews begin. OpenCode 1 and standalone binary context commands retain the REST integration.

Both reviewers and the arbiter consume the same saved context. They have no direct Atlassian MCP access.

## Updating

PRR updates through OpenCode's plugin manager; no manual clone, binary copy, or npm publication is needed. Check your installed source first:

```bash
opencode plugin list
opencode plugin check
```

For Git installations, the version shown by `plugin list` is the installed commit revision. The source tells you whether you track a branch such as `#main` or a full commit pin.

| Source | How updates work |
|---|---|
| `github:cfactolerin/prr#main` | OpenCode can detect newer commits; `plugin update` installs them when requested |
| `github:cfactolerin/prr#<full-40-character-commit-sha>` | Fixed revision; explicitly replace the pin to install a newer commit |

### Update A Branch-Tracking Installation

For an installation tracking `main`, run:

```bash
opencode plugin check 'github:cfactolerin/prr#main'
opencode plugin update 'github:cfactolerin/prr#main'
opencode service restart
opencode plugin list
```

For SSH or HTTPS installations, use the exact package target shown by `opencode plugin list` instead. Start a fresh review session after updating so its workflow instructions come from the new installation. Restarting the service can interrupt active work; do it between reviews.

### Update A Commit-Pinned Installation

Commit pins provide a reproducible installation. Exact revisions are skipped by normal update checks and `plugin update`, so a pinned package reported as current does not mean that `main` has no newer commits.

Choose the new full commit SHA from this repository. Replace both placeholders below with actual 40-character SHAs; the old one is in your installed source:

```bash
opencode plugin add 'github:cfactolerin/prr#<NEW_FULL_COMMIT_SHA>'
opencode plugin remove 'github:cfactolerin/prr#<OLD_FULL_COMMIT_SHA>'
opencode service restart
opencode plugin list
```

Add the new revision successfully before removing the old entry. Use the exact old source when removing it, and verify that only one PRR entry remains. Adding a new revision does not automatically replace the old package target.

### Switch From A Pin To Tracking Main

To use normal update detection instead of selecting each revision manually, replace the old pin with the branch target:

```bash
opencode plugin add 'github:cfactolerin/prr#main'
opencode plugin remove 'github:cfactolerin/prr#<OLD_FULL_COMMIT_SHA>'
opencode service restart
opencode plugin list
```

Replace the placeholder before running these commands. Future updates then use `opencode plugin update 'github:cfactolerin/prr#main'`.

### Update Detection

OpenCode's background service checks unpinned npm and Git plugins for updates at startup while loading the cached installation. Run `opencode plugin check` to check manually. Detection does not install the update: run `plugin update` explicitly. Restarting alone does not update the cached package.

Full commit pins and exact npm versions stay fixed and are skipped. To have OpenCode detect new PRR commits through its normal update checks, track `main` rather than a commit SHA. No separate PRR update checker is required. See the [OpenCode plugin documentation](https://opencode.ai/v2/docs/plugins).

These plugin-management commands modify global configuration. If PRR is configured in a project file instead, update that entry rather than adding a second global installation. Existing PRR settings and review workspaces are preserved across updates.

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
