# PRR — AI-Powered PR Review Tool

## Project Overview

Ruby CLI tool that runs Claude and Codex as parallel PR reviewers with a Claude-powered arbiter. Located at `~/fuga/git/tools`.

## Architecture

- **Entry point:** `bin/prr` — routes to setup, review, or comments
- **Orchestrator:** `lib/prr/review_runner.rb` — ties all phases together
- **Ticket fetcher:** `lib/prr/ticket_fetcher.rb` — downloads Jira ticket, Confluence pages, and attachments into `results/<ts>/ticket/` so both agents read the same context
- **Agents:** Claude CLI (`claude -p`) and Codex CLI (`codex exec`) run in parallel
- **Arbiter:** Claude synthesizes both reviews via multi-round Q&A
- **Templates:** ERB prompts in `config/prompts/`

## Key Design Decisions

- **Ruby stdlib only** — no gems, no Bundler
- **Shell-out to CLIs** — agents invoked via `Open3.popen3`, not API calls
- **Sandbox isolation** — repos copied to `tmp/reviews/` so agents can modify freely
- **Timestamped results** — each review gets `results/YYYY-MM-DD-HHMMSS/` for re-review context
- **Config precedence:** CLI flags > env vars (`PRR_*`) > `config/prr.yml` > defaults

## Agent Invocation

**Claude:** `claude -p --dangerously-skip-permissions --output-format text` (prompt via stdin, output from stdout)

**Codex (review):** `codex -a never exec -C <repo> -s workspace-write --add-dir <results> --ephemeral --color never --output-last-message <path> -` (prompt via stdin)

**Codex (arbiter Q&A):** Same but `-s read-only`

## Execution Flow

1. **Preflight:** disk check, PR resolution (gh), Jira ticket ID inference
2. **Ticket fetch:** `TicketFetcher` downloads full Jira ticket, linked Confluence pages, and attachments to `results/<ts>/ticket/`. Produces `ticket-context.md` — a self-contained markdown file with local paths to attachments. Both agents read this same file.
3. **Sandbox setup:** copy repo, checkout PR branch
4. **Parallel review:** Claude + Codex run independently with the same prompt (includes ticket context)
5. **Arbiter rounds:** Claude cross-examines both reviews, up to N rounds
6. **Final report:** arbiter synthesizes findings
7. **Comment posting:** interactive GitHub PR comment flow

## File Layout

```
bin/prr                     # executable entry point
lib/prr/                    # all Ruby modules
  ticket_fetcher.rb         # Jira + Confluence + attachment downloader
config/prompts/*.md.erb     # prompt templates
config/prr.yml              # user config (gitignored)
tmp/reviews/                # sandbox + results (gitignored)
  <repo>-pr-<n>/results/<ts>/ticket/
    ticket-context.md       # consolidated ticket markdown
    attachments/            # downloaded Jira attachments
    confluence/             # fetched Confluence pages as markdown
docs/superpowers/specs/     # design spec
docs/superpowers/plans/     # implementation plan
```

## Conventions

- Frozen string literals in all Ruby files
- `Prr::Progress` for all console output (timestamped)
- Both agents get the same prompt structure; output format must match for arbiter parsing
- Arbiter expects JSON questions (`{"claude": [...], "codex": [...]}`) or final report markdown
- Line comments format: `- \`path/to/file:LINE\` — description`
