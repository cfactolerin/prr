# PRR — AI-Powered PR Review Tool

## Overview

`prr` is a Ruby CLI tool that uses Claude and Codex as parallel code reviewers with a Claude-powered arbiter. It helps a team lead review PRs faster and more thoroughly by pre-digesting changes, tracing integration flows, and surfacing risks before human review.

The tool does not automate approval — it assists human judgment by giving structured findings, open questions, and the ability to post line comments directly to GitHub.

## Problem

AI-assisted development is increasing PR volume. Code often has AI slop (unnecessary abstractions, hallucinated APIs), missing pieces (error handling, tests, logging), and logic bugs. Context switching between repos makes it easy to miss issues. A pre-review agent reduces that risk.

## CLI Interface

### Main entry point: `bin/tools`

A top-level script that dispatches to individual tools in the repo.

```
$ tools --help
Usage: tools <command> [options]

Commands:
  prr    AI-powered PR review using Claude + Codex

Run 'tools <command> --help' for command-specific options.
```

### PR Review: `bin/prr`

```
$ prr --help
Usage: prr [PR_URL] [options]

Arguments:
  PR_URL                     GitHub PR URL (e.g., https://github.com/fuga/core/pull/123)
                             If omitted, lists PRs pending your review.

Options:
  --ticket TICKET            Jira ticket ID (e.g., PROJ-456). Auto-detected if omitted.
  --arbiter-only             Re-run arbiter on existing review results. Skip agent phase.
  --comments                 Post line comments from the latest review to GitHub.
  --claude-timeout SECONDS   Timeout for Claude agent (default: 600)
  --codex-timeout SECONDS    Timeout for Codex agent (default: 900)
  --arbiter-rounds N         Max arbiter Q&A rounds (default: 3)
  --help                     Show this help message.

Examples:
  prr                                              # List PRs pending your review
  prr https://github.com/fuga/core/pull/123        # Review a specific PR
  prr https://github.com/fuga/core/pull/123 --ticket PROJ-456
  prr https://github.com/fuga/core/pull/123 --arbiter-only
  prr https://github.com/fuga/core/pull/123 --comments
```

## Configuration

`config/prr.yml`:

```yaml
base_repo_path: ~/fuga/git
tmp_path: tmp/reviews           # relative to tools repo root
claude_timeout: 600             # 10 minutes
codex_timeout: 900              # 15 minutes
arbiter_rounds: 3
min_disk_space_gb: 10
github_user: <gh-handle>
```

CLI flags override config file values.

## Execution Flow

### Phase 0 — Pre-flight

1. **Disk check:** Query available disk space. If < `min_disk_space_gb`, abort with message: "Only XGB free. Need at least 10GB. Free up space and retry."
2. **PR resolution:**
   - If PR URL provided, parse `owner/repo` and PR number.
   - If no URL, query GitHub via `gh pr list --search "review-requested:@me"` filtered to unreviewed. Present numbered list, let user pick.
3. **PR metadata:** Use `gh pr view` to get title, description, branch, base branch, author, changed files, diff.
4. **Jira ticket inference:** Regex match against PR title, description, and branch name for patterns like `PROJ-123`, `[PROJ-123]`, `PROJ_123`. If not found, prompt user.
5. **Jira ticket details:** Fetch ticket summary, description, and acceptance criteria via Jira REST API (using `Net::HTTP` with API token from config). Gaffer integration is out of scope for v1 — can be added later if useful.

### Phase 1 — Sandbox Setup

1. Locate repo at `~/fuga/git/<repo>`. Abort if not found locally.
2. `cp -r ~/fuga/git/<repo> tmp/reviews/<repo>-pr-<number>/repo/`.
3. In the copy:
   ```
   git fetch origin pull/<number>/head:pr-review
   git checkout pr-review
   ```
4. Create timestamped results directory: `tmp/reviews/<repo>-pr-<number>/results/<YYYY-MM-DD-HHMMSS>/`.

### Phase 2 — Parallel Agent Review

1. **Gather context from the repo copy:**
   - Read `CLAUDE.md`, `AGENTS.md`, `README.md` (whichever exist).
   - Get the PR diff (`git diff <base>..pr-review`).
   - Jira ticket details from Phase 0.
   - Previous review's `final-report.md` if this is a re-review.

2. **Build prompt files** — both agents get the same structured prompt (see Prompt Structure section). Written to the results directory as `claude-prompt.md` and `codex-prompt.md` for traceability.

3. **Spawn agents in parallel:**
   - Claude and Codex are invoked via their CLIs in the repo copy directory. Exact flags to be validated during implementation (e.g., `claude -p` for print mode, `codex -q` for quiet mode, prompt via stdin or file).
   - Both run with the repo copy as working directory so they can read/modify any file.
   - Output is captured and written to the results directory.
   - Each has its own timeout. On timeout, kill process and save partial output.

4. **Completion:** Both agents write their results in the structured output format.

### Phase 3 — Arbiter Rounds

The arbiter is Claude, invoked separately with access to both review files and the repo copy.

**Round loop (up to N rounds, default 3):**

1. Arbiter reads both reviews (and any prior round responses).
2. Identifies gaps, conflicts, unclear findings, or claims that need proof.
3. Formulates questions for each agent. May have questions for one, both, or neither.
   - If no questions for either agent, skip remaining rounds.
4. Questions sent to each agent in parallel. Agents can read/modify the sandbox to answer.
5. Responses saved to `round-<n>-claude.md` and `round-<n>-codex.md`.
6. All questions and responses logged in `arbiter-log.md`.

**Last round (forced choice):**
- The final round is always a forced choice round.
- Arbiter presents specific options/choices to each agent on any remaining disagreements.
- Agents must pick from the given options.

**Early exit:** If the arbiter has no questions after any round, it skips to final report generation.

### Phase 4 — Final Report

The arbiter produces `final-report.md` — a self-contained document designed to be usable as direct input to Claude or Codex for follow-up work.

**Report contents:**

```markdown
# PR Review: <PR title>
PR: <URL>
Ticket: <JIRA-ID> — <ticket summary>
Author: <author>
Branch: <branch> → <base>
Reviewed: <timestamp>
Previous Review: <path or "none">

## Verdict: [APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION]
## Confidence: [HIGH | MEDIUM | LOW]

<1-3 sentence summary of the overall assessment>

## Ticket Alignment
Did the code achieve the Jira ticket goals and acceptance criteria?

## Flow Analysis
Trace of execution through modified files. Integration risks, event flow issues,
side effects on other services/repos.

## Code Quality
Convention violations, linting issues, AI slop detected (unnecessary abstractions,
over-engineering, dead code, suspiciously generic patterns).

## Missing Things
Error handling, tests, logging, migrations, documentation gaps.

## Logic Issues
Wrong conditions, edge cases, off-by-one, race conditions.

## Security
Injection, auth issues, exposed secrets, unsafe deserialization.

## Memory
Leaks, unbounded growth, unclosed resources.

## Hallucination Check
APIs, methods, gems, or library calls that don't exist in the project or dependencies.

## Proof of Findings
Test files or debug output created by agents, with paths and explanation.

## Line Comments
- `path/to/file.rb:42` — Description of issue
- `path/to/file.rb:108` — Description of issue

## Open Questions
Things that need human judgment. Each question includes enough context
that you can open Claude/Codex with this report and continue from here.

## Agent Agreement
Where Claude and Codex agreed and disagreed, and how disagreements were resolved.
```

### Phase 5 — Comment Posting

Interactive flow after report generation:

```
5 line comments ready.

  1. app/services/webhook_sender.rb:42 — Unbounded retry loop
  2. app/services/webhook_sender.rb:108 — Exception swallowed
  3. app/models/webhook.rb:23 — Missing index on status
  4. lib/tasks/webhook.rake:15 — Hardcoded URL, likely hallucinated
  5. spec/services/webhook_sender_spec.rb:67 — Missing failure assertion

Post to GitHub? (a)ll / (s)elect / (e)dit / (n)one:
```

- **all** — posts as a single PR review via `gh api` with appropriate review status.
- **select** — pick by number (e.g., `1,3,5`).
- **edit** — opens each selected comment in `$EDITOR` before posting.
- **none** — skip.

Comments are posted as a single GitHub PR review (one notification to developer).

The `--comments` flag re-enters this flow from the latest results without re-running review.

### Phase 6 — Cleanup

1. Delete `tmp/reviews/<repo>-pr-<number>/repo/` (the sandbox copy).
2. Keep `tmp/reviews/<repo>-pr-<number>/results/` (all timestamped reviews).
3. Print final summary and path to report.

## Re-review Flow

When running `prr` on a PR that has previous results:

1. Script detects existing timestamped results in `tmp/reviews/<repo>-pr-<number>/results/`.
2. Prompts: "Previous review found from 2026-04-04-143022. Use as context for re-review? (Y/n)"
3. If yes, the latest `final-report.md` is included in both agent prompts.
4. Agents focus on:
   - Were previous comments addressed?
   - Did fixes introduce new issues?
   - Any remaining concerns from previous review?
5. New results get a new timestamp directory.

## Prompt Structure

Both agents receive the same structured prompt so output is comparable.

### Context Block
- PR metadata (title, description, author, branch, base, URL)
- Jira ticket summary, description, acceptance criteria
- Repo conventions from `CLAUDE.md` / `AGENTS.md` / `README.md`
- Previous `final-report.md` (if re-review)
- List of changed files

### Diff Block
- Full PR diff

### Review Instructions
You are reviewing PR #<number> for <repo>. Your goal is to help a senior engineer catch issues before merge. Be thorough but precise — flag real problems, not style nitpicks already covered by linters.

1. **Ticket alignment** — Does the code achieve the Jira ticket goals and acceptance criteria?
2. **Flow tracing** — Trace the execution path through modified files. Check how changes interact with callers, downstream services, events, and side effects. Flag integration risks.
3. **Code quality** — Run any available linters (check the repo docs for which ones). Check for convention violations. Flag AI slop: unnecessary abstractions, over-engineering, dead code, suspiciously generic patterns.
4. **Missing things** — Error handling, tests, logging, migrations, documentation.
5. **Logic bugs** — Wrong conditions, edge cases, off-by-one, race conditions.
6. **Security** — Injection, auth issues, exposed secrets, unsafe deserialization.
7. **Memory** — Leaks, unbounded growth, unclosed resources.
8. **Hallucination check** — Verify that every API, method, gem, or library call actually exists in the project or its dependencies. Flag anything suspicious.
9. **Proof of findings** — If you find a bug or issue, write a test case or add debug output in the sandbox to prove it. Show, don't just tell.

### Output Format
(See the structured markdown format defined in Phase 4 — Final Report)

## Live Progress Output

The script prints timestamped status throughout:

```
[14:30:22] Checking disk space... 45GB free ✓
[14:30:23] Fetching PR #123 metadata...
[14:30:24] Jira ticket: PROJ-456 — "Add webhook retry logic"
[14:30:25] Copying fuga/core to sandbox...
[14:30:30] Checking out PR branch...
[14:30:31] Starting parallel review...
[14:30:31]   Claude: running (timeout: 10m)
[14:30:31]   Codex:  running (timeout: 15m)
[14:32:15]   Claude: completed (1m44s)
[14:34:08]   Codex:  completed (3m37s)
[14:34:09] Arbiter round 1/3...
[14:34:09]   Asking Claude 2 questions, Codex 1 question...
[14:34:45]   Responses received.
[14:34:46] Arbiter round 2/3...
[14:34:46]   No questions. Skipping remaining rounds.
[14:34:47] Generating final report...
[14:35:02] ✓ Done.

Report: tmp/reviews/core-pr-123/results/2026-04-04-143022/final-report.md
Verdict: REQUEST_CHANGES (High Confidence)
3 issues found, 2 open questions.
```

## Project Structure

```
tools/
  bin/
    tools                     # main entry point, dispatches to subcommands
    prr                       # PR review tool
  lib/
    prr/
      cli.rb                  # argument parsing, --help
      config.rb               # config file loading + CLI overrides
      preflight.rb            # disk check, PR resolution, Jira inference
      sandbox.rb              # repo copy, branch checkout, cleanup
      prompt_builder.rb       # builds structured prompts for agents
      agent_runner.rb         # spawns claude/codex with timeouts
      arbiter.rb              # arbiter round logic
      report.rb               # final report generation
      github_commenter.rb     # interactive comment posting via gh
      progress.rb             # timestamped console output
  config/
    prr.yml                   # default configuration
    prompts/
      review.md.erb           # review prompt template
      arbiter.md.erb          # arbiter prompt template
      arbiter_question.md.erb # arbiter follow-up prompt template
  tmp/                        # gitignored
    reviews/
  docs/
    superpowers/
      specs/
  .gitignore
```

## Dependencies

- **Ruby** (system Ruby or rbenv — no gems required initially, use stdlib only)
- **claude** CLI (already installed)
- **codex** CLI (already installed)
- **gh** CLI (GitHub CLI for PR metadata and comment posting)
- **Jira API access** (or Gaffer for ticket details)

## Out of Scope

- Auto-approval or auto-merge
- Webhook/CI integration (manual CLI invocation only)
- Support for non-GitHub platforms
- Custom model selection (uses whatever claude/codex default to)
