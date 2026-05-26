---
name: prr-start
description: Start an AI-powered PR review with parallel multi-agent review and arbiter synthesis. Takes a PR URL or owner/repo#N as argument.
argument-hint: <pr-url-or-ref>
allowed-tools: ["Bash(*)", Read, Write, Grep, Glob, Agent, TaskCreate, TaskUpdate, TaskList, AskUserQuestion]
---

# PRR Start — Full Review Workflow

You are orchestrating a multi-agent PR review. Follow each phase sequentially. Use task tracking to report progress.

The PR reference is available as `$ARGUMENTS`. The PRR binary is at `${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal`.

Throughout this skill, use these shorthands:
- **PRR** = `${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal`
- **PR_REF** = the value of `$ARGUMENTS`

## Preflight: Check Setup

Before anything else, check if `~/.prr/config.yml` exists by reading it.

- **If it exists:** proceed to Phase 0.
- **If it does not exist:** tell the user:
  > "PRR has not been set up yet. Run `/prr:setup` first to configure your workspace, GitHub username, and Jira credentials. Config will be saved to `~/.prr/config.yml`."
  
  Then **stop** — do not proceed with the review.

---

## Phase 0: Setup Tasks

Create task tracking items so the user can see progress through the review pipeline:

1. "Cleanup stale reviews" (pending)
2. "Gather context" (pending)
3. "Review context with user" (pending)
4. "Run agent reviews" (pending)
5. "Run arbiter synthesis" (pending)
6. "Interactive investigation" (pending)

Mark each task `in_progress` when you start it and `completed` when you finish it.

Phases 7 and 8 (line comment review, posting to GitHub) are interactive flows that do not use task tracking.

---

## Phase 1: Cleanup

**Update task 1 to in_progress.**

1. Read `~/.prr/config.yml` to get the `workspace_path` value.
   - If the file does not exist, use the default: `~/.prr/workspace`
2. Run:
   ```
   ${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal cleanup --workspace <workspace_path>
   ```
3. Report to the user what was cleaned (merged/closed PRs removed) and what was kept.

**Update task 1 to completed.**

---

## Phase 2: Context Gathering

**Update task 2 to in_progress.**

1. Run:
   ```
   ${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal context "$ARGUMENTS" --workspace <workspace_path>
   ```
   - If the user provided a `--ticket` flag in their original message, pass it: `--ticket <TICKET_ID>`
2. Capture the **last line of stdout** — this is the round directory path. Save it as `ROUND_DIR` for all subsequent phases.
   - Example: `/Users/me/.prr/workspace/owner-repo-pr-42/r1`
3. Read `<ROUND_DIR>/context-manifest.md` and store its contents for the next phase.

**Update task 2 to completed.**

---

## Phase 3: User Review

**Update task 3 to in_progress.**

1. Present the full context manifest to the user. Include **every row** from the manifest table exactly as generated (including the PRR version row). Format it clearly.
2. Ask the user:
   > Context gathered. You can:
   > - Say **"go"** to start the review
   > - Provide **review tasks** (specific things you want reviewers to focus on)
   > - Add **extra context** (links, notes, things to watch for)
   >
   > What would you like to do?

3. Wait for user input via AskUserQuestion.
4. Handle the response:
   - If the user says "go", "start", "proceed", "yes", "lgtm", or similar: move to Phase 4 with no extra tasks.
   - If the user provides review tasks or instructions:
     - Parse them into a JSON array of strings. Example: if the user says "check auth flow and verify the migration is reversible", produce `["Check auth flow", "Verify the migration is reversible"]`.
     - Save this as `REVIEW_TASKS_JSON` for Phase 4.
     - Confirm back to the user what tasks you captured and proceed.
   - If the user provides links or extra context, note them for inclusion in your investigation phase (Phase 6).

**Update task 3 to completed.**

---

## Phase 4: Parallel Agent Review

**Update task 4 to in_progress.**

### Step 4a: Read config for active agents

Read `~/.prr/config.yml` and extract the `agents` list. This determines which agents to dispatch. Possible values: `claude`, `codex`, `gemini`, `opencode` — in any combination.

Also read `gemini_model` (default: `gemini-2.5-flash`), `google_cloud_project` (default: `fuga-prod`), `google_cloud_location` (default: `europe-west4`), and `arbiter_rounds` (default: 3) for later use.

### Step 4b: Preflight agent health check

Before building the prompt or dispatching agents, verify that each external CLI agent is actually working. Run a quick smoke test for each non-claude agent in the list. **Run all checks in parallel** (single message, multiple Bash calls).

#### Codex check (if "codex" is in the agents list)
```bash
echo "Say hello" | timeout 30 codex -a never exec -s read-only --ephemeral --color never -p "Reply with exactly: HELLO" 2>&1 | head -5
```
- **Pass:** output contains recognizable text (not an error/auth failure)
- **Fail:** command errors, times out, or returns an auth/config error

#### Gemini check (if "gemini" is in the agents list)
```bash
export GOOGLE_CLOUD_PROJECT="<GOOGLE_CLOUD_PROJECT>" GOOGLE_CLOUD_LOCATION="<GOOGLE_CLOUD_LOCATION>" && echo "Reply with exactly: HELLO" | timeout 30 gemini -p "" -m "<GEMINI_MODEL>" -o text --approval-mode yolo 2>&1 | head -5
```
- **Pass:** output contains recognizable text (not an error/auth failure)
- **Fail:** command errors, times out, or returns an auth/config error

#### Opencode check (if "opencode" is in the agents list)
```bash
printf 'Reply with exactly: HELLO\n' | timeout 30 opencode run --model openai/gpt-5.5 --format json 2>&1 | jq -r 'select(.type == "text") | .part.text' | head -5
```
- **Pass:** output contains recognizable text (not an error/auth failure)
- **Fail:** command errors, times out, or returns an auth error

If opencode fails, also check whether `OPENAI_API_KEY` is set in the environment. If it is missing, tell the user:
> opencode requires `OPENAI_API_KEY` to be exported in your shell (e.g., add `export OPENAI_API_KEY=sk-...` to `~/.zshrc`), or run `opencode auth` to authenticate. Skipping opencode for this review.

**Claude does not need a health check** — it runs as a native Claude Code sub-agent and is always available.

After all checks complete:
1. Remove any failing agents from the active agents list for this run.
2. Report the results to the user, e.g.:
   > Agent health check:
   > - claude: ok (native)
   > - gemini: FAILED — `<first line of error>`
   > - codex: ok
   > - opencode: ok
   >
   > Skipping gemini for this review.
3. If **all** agents failed (and claude is not in the list), stop and tell the user no agents are available.
4. Proceed with only the healthy agents.

### Step 4c: Build the review prompt

Run:
```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal prompt --review <ROUND_DIR>
```

If the user provided review tasks in Phase 3, include them:
```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal prompt --review <ROUND_DIR> --tasks '<REVIEW_TASKS_JSON>'
```

The command writes the prompt to `<ROUND_DIR>/results/review-prompt.md` and prints its path to stdout.

### Step 4d: Dispatch agents in parallel

Set these path variables:
- `PROMPT_PATH` = `<ROUND_DIR>/results/review-prompt.md`
- `REPO_PATH` = `<ROUND_DIR>/repo`
- `RESULTS_PATH` = `<ROUND_DIR>/results`

For each active agent, dispatch a sub-agent using the Agent tool. **Dispatch ALL agents in a single message so they run in parallel.**

#### Claude agent (if "claude" is in the agents list)

Dispatch with agent definition: `claude-reviewer`

Instructions to pass:
```
Review this PR. Here are your paths:
- Review prompt: <PROMPT_PATH>
- Cloned repo: <REPO_PATH>
- Write your review to: <RESULTS_PATH>/claude-review.md

Read the review prompt first, then explore the repo as needed. Write your complete review to the output path.
```

#### Codex agent (if "codex" is in the agents list)

Dispatch with agent definition: `codex-reviewer`

Instructions to pass:
```
Run the Codex CLI to review this PR. Here are your paths:
- Review prompt: <PROMPT_PATH>
- Cloned repo: <REPO_PATH>
- Results directory: <RESULTS_PATH>
- Write output to: <RESULTS_PATH>/codex-review.md

Run this exact command:
cat "<PROMPT_PATH>" | codex -a never exec -C "<REPO_PATH>" -s workspace-write --add-dir "<RESULTS_PATH>" --ephemeral --color never --output-last-message "<RESULTS_PATH>/codex-review.md" -
```

#### Gemini agent (if "gemini" is in the agents list)

Dispatch with agent definition: `gemini-reviewer`

Instructions to pass:
```
Run the Gemini CLI to review this PR. Here are your paths:
- Review prompt: <PROMPT_PATH>
- Cloned repo: <REPO_PATH>
- Gemini model: <GEMINI_MODEL>
- Google Cloud Project: <GOOGLE_CLOUD_PROJECT>
- Google Cloud Location: <GOOGLE_CLOUD_LOCATION>
- Write output to: <RESULTS_PATH>/gemini-review.md

Run this exact command:
export GOOGLE_CLOUD_PROJECT="<GOOGLE_CLOUD_PROJECT>" GOOGLE_CLOUD_LOCATION="<GOOGLE_CLOUD_LOCATION>" && cat "<PROMPT_PATH>" | gemini -p "" -m "<GEMINI_MODEL>" -o text --approval-mode yolo --include-directories "<REPO_PATH>" > "<RESULTS_PATH>/gemini-review.md"
```

#### Opencode agent (if "opencode" is in the agents list)

Dispatch with agent definition: `opencode-reviewer`

Instructions to pass:
```
Run the opencode CLI to review this PR. Here are your paths:
- Review prompt: <PROMPT_PATH>
- Cloned repo: <REPO_PATH>
- Results directory: <RESULTS_PATH>
- Write output to: <RESULTS_PATH>/opencode-review.md

Run this exact command:
cat "<PROMPT_PATH>" | opencode run --model openai/gpt-5.5 --dir "<REPO_PATH>" --format json --dangerously-skip-permissions | jq -r 'select(.type == "text") | .part.text' > "<RESULTS_PATH>/opencode-review.md"
```

### Step 4e: Wait and verify

After all agents complete, verify each expected output file exists and is non-empty:
- `<RESULTS_PATH>/claude-review.md` (if claude was dispatched)
- `<RESULTS_PATH>/codex-review.md` (if codex was dispatched)
- `<RESULTS_PATH>/gemini-review.md` (if gemini was dispatched)
- `<RESULTS_PATH>/opencode-review.md` (if opencode was dispatched)

If any agent failed (empty or missing output), report the failure to the user but continue with whatever reviews succeeded. At least one review must succeed to proceed.

Tell the user which agents completed successfully.

**Update task 4 to completed.**

---

## Phase 5: Arbiter Synthesis

**Update task 5 to in_progress.**

This phase runs in a loop. The arbiter may ask questions of the agents (up to `arbiter_rounds` rounds, default 3), or it may produce a final report immediately.

### Step 5a: Build the arbiter prompt

Run:
```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal prompt --arbiter <ROUND_DIR>
```

This reads all `*-review.md` files from results, plus any Q&A history from `arbiter-log.md`, and writes `<ROUND_DIR>/results/arbiter-prompt.md`.

### Step 5b: Dispatch the arbiter

Dispatch with agent definition: `arbiter`

Instructions to pass:
```
Synthesize the agent reviews for this PR. Here are your paths:
- Arbiter prompt: <ROUND_DIR>/results/arbiter-prompt.md
- Write your output to: <ROUND_DIR>/results/arbiter-output.md

Read the arbiter prompt and follow its instructions exactly. Either produce a JSON questions block or the final report.
```

### Step 5c: Check arbiter output

After the arbiter completes, read `<ROUND_DIR>/results/arbiter-output.md`.

**Determine if it contains questions or a final report:**

Search the output for a fenced JSON code block (` ```json `) whose content is an object with agent name keys (e.g., `"claude"`, `"codex"`, `"gemini"`, `"opencode"`). Each key maps to an array of question strings.

**If questions are found:**

1. Parse the JSON questions object. Example:
   ```json
   {
     "claude": ["What about the race condition on line 42?"],
     "codex": [],
     "gemini": ["Did you verify the SQL injection fix?"],
     "opencode": []
   }
   ```

2. For each agent with a non-empty questions array, build a question prompt:
   ```
   ${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal prompt --question <ROUND_DIR> --agent <AGENT_NAME> --questions '<QUESTIONS_JSON>'
   ```
   Where `<QUESTIONS_JSON>` is the full JSON object (not just that agent's array).

3. The command writes the question prompt to `<ROUND_DIR>/results/round-<N>-<agent>-question.md`.

4. Dispatch the appropriate agent to answer:
   - For **claude**: dispatch `claude-reviewer` with instructions to read the question prompt and write the answer to `<ROUND_DIR>/results/round-<N>-claude-answer.md`
   - For **codex**: dispatch `codex-reviewer` with instructions to run:
     ```
     cat "<question_prompt_path>" | codex -a never exec -C "<REPO_PATH>" -s read-only --add-dir "<RESULTS_PATH>" --ephemeral --color never --output-last-message "<answer_path>" -
     ```
     Note: use `-s read-only` for Q&A (not `workspace-write`).
   - For **gemini**: dispatch `gemini-reviewer` with the question prompt piped to gemini, output to the answer path.
   - For **opencode**: dispatch `opencode-reviewer` with instructions to run:
     ```
     cat "<question_prompt_path>" | opencode run --model openai/gpt-5.5 --dir "<REPO_PATH>" --format json --dangerously-skip-permissions | jq -r 'select(.type == "text") | .part.text' > "<answer_path>"
     ```

   Dispatch all agent answers in parallel.

5. After all answers are collected, append the Q&A round to `<ROUND_DIR>/results/arbiter-log.md`:
   ```
   ## Round <N>

   ### <Agent> Questions
   <questions>

   ### <Agent> Answers
   <answers>

   ---
   ```

6. Increment the round counter. If rounds < `arbiter_rounds` (from config), go back to Step 5a (rebuild arbiter prompt with updated history). Otherwise, force the arbiter to produce a final report by telling it this is the last round.

**If NO questions (final report):**

1. Copy the arbiter output to `<ROUND_DIR>/results/final-report.md`.
2. Tell the user: "Arbiter produced the final report after N round(s)."

**Update task 5 to completed.**

---

## Phase 6: Interactive Investigation

**Update task 6 to in_progress.**

1. Read `<ROUND_DIR>/results/final-report.md`.
2. Present a summary to the user using this format:

```
---

## Review Summary

**Verdict:** `[<VERDICT>]` | **Confidence:** <CONFIDENCE> | **Line comments:** N (severity breakdown)

## Key Findings
- finding 1
- finding 2
- ...

## Low-Severity Items
1. item 1
2. item 2
3. ...

---
```

Use these exact strings for the verdict (no emojis — they don't render in the terminal):
- APPROVE → `[APPROVE]`
- REQUEST_CHANGES → `[REQUEST_CHANGES]`
- COMMENT → `[COMMENT]`

3. Tell the user:
   > Review complete. You can:
   > - Ask questions about any finding
   > - Ask me to read code, check git blame, run tests in the repo at `<REPO_PATH>`
   > - Say **"re-review"** to run another round with additional guidance
   > - Say **"continue"** or **"comments"** to proceed to line comment review

4. Enter an interactive loop using AskUserQuestion:
   - If the user asks a question: investigate using the repo at `<REPO_PATH>`. Read files, run git commands, grep for patterns, etc. Present findings and ask if they have more questions.
     - **Important:** Always use `git -C <REPO_PATH> <command>` instead of `cd <REPO_PATH> && git <command>` to avoid security prompts.
   - If the user says "re-review": run `prr context "$ARGUMENTS" --workspace <workspace_path>` again (this creates rN+1), then re-run Phases 4-5 with the new round dir. Include any guidance the user provides.
   - If the user says "continue", "next", "comments", "done", or similar: exit the loop and proceed to Phase 7.

**Update task 6 to completed.**

---

## Phase 7: Findings Review

### Step 7a — Parse the report (with diff verification)

Run:
```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal parse-report <ROUND_DIR>/results/final-report.md --diff <ROUND_DIR>/results/diff.txt
```

This outputs JSON to stdout. Parse it. The structure is:

```json
{
  "verdict": "REQUEST_CHANGES",
  "confidence": "HIGH",
  "findings": [
    {
      "id": "F-01",
      "title": "...",
      "trigger": "Acceptance Criteria",
      "severity": "HIGH",
      "anchor": "diff",
      "location": "path/to/file:line",
      "path": "path/to/file",
      "line": 42,
      "start_line": null,
      "why_it_matters": "...",
      "suggested_comment": "...",
      "suggested_fix": "..."
    }
  ],
  "line_comments": [ /* derived: diff-anchored findings only */ ],
  "review_action": "Request Changes",
  "review_body": "..."
}
```

`anchor` is one of `"diff"`, `"reference"`, `"none"`. `location`, `path`, `line`, `start_line` are null when the anchor is `"none"`. The parser may have emitted stderr warnings (e.g., downgraded mislabels, malformed findings, unreadable diff) — surface those to the user before the interactive review.

Maintain an in-memory list of `CommentState` entries, one per `Finding`:

```
CommentState {
  finding: Finding          // straight from the JSON
  status: Pending | Accepted | Rejected | Edited
  overridden_body: string | null  // populated when status == Edited
}
```

Initialize every entry with `status = Pending`. New findings the user adds in Step 7d are appended with `status = Accepted`. The list survives across 7b / 7c / 7d and is consumed by Phase 8.

### Step 7b — Diff-anchored findings (inline-postable)

Walk `findings` where `anchor == "diff"`. For each, present in **two parts**: rich context as regular text, then a minimal AskUserQuestion.

#### Rich text output

```
## Comment N/M — <Trigger> — <title> (<Severity>)

📄 [path#L<line>](url) (lines start–end)

<code context in a language-specific fenced block; target line marked with # <-->

**Why this matters:** <why_it_matters>

**Suggested comment:**
> <suggested_comment>

**Suggested fix:** <suggested_fix>
```

`N/M` counts only diff-anchored findings. Code context is read from `<ROUND_DIR>/repo/<path>`, ~5 lines before/after the target line, language-hinted fence (e.g., ` ```ruby `), target line marked with a trailing `# <--` comment. The clickable link uses the `url` field if present, else plain text `path#L<line>`.

#### AskUserQuestion

```
Comment N/M — <one-line summary>
```

Options:
- **Accept** — keep as-is
- **Reject** — drop this comment
- **Edit** — provide replacement text

Free-text input is accepted as a clarification or edit (rewrite the comment incorporating the input, show for confirmation, then move on).

Special commands: `add`/`new`/`+` switches to Step 7d; `done`/`stop`/`enough` exits Phase 7.

#### Update CommentState

- Accept → `status = Accepted`
- Reject → `status = Rejected`
- Edit → `status = Edited`, `overridden_body = <new text>`

### Step 7c — Reference / unanchored findings (report-only)

After diff-anchored findings, walk `findings` where `anchor` is `"reference"` or `"none"`. These cannot be posted as inline comments but must still be reviewed for inclusion in the regenerated review body.

#### Rich text output

```
## Report-Only Finding N/M — <Trigger> — <title> (<Severity>)

(Report-only — won't be posted as an inline comment; will be summarized in the review body.)

📄 <path:line if anchor == reference; else "(no anchor line)">

**Why this matters:** <why_it_matters>

**Suggested comment:**
> <suggested_comment>

**Suggested fix:** <suggested_fix>
```

For `anchor: reference`, render the code context the same way as 7b but note "(unchanged code — for reference only)" above the fence.

#### AskUserQuestion

```
Report-Only Finding N/M — <one-line summary>
```

Options:
- **Accept** — include this finding in the regenerated review body
- **Reject** — drop it from the body
- **Edit** — provide replacement text for the body summary

CommentState updates as in 7b.

### Step 7d — Add new finding

Triggered by `add`/`new`/`+` at any point in 7b or 7c. Collect:

1. **Trigger** — AskUserQuestion with the 8 options (Acceptance Criteria, Code Change, Code Quality, Logic Bug, Security, Performance, Missing Test, Missing Doc / Error Handling).
2. **Severity** — AskUserQuestion: HIGH / MED / LOW.
3. **Anchor** — AskUserQuestion: "Is this anchored on a changed line, on existing code, or no specific line?" → `diff` / `reference` / `none`.
4. If Anchor ≠ `none`: ask for `path:line`. Validate against `<ROUND_DIR>/results/diff.txt` — if the user picked `diff` but the line isn't in the diff, ask whether to downgrade to `reference`.
5. Draft `Why this matters`, `Suggested comment`, `Suggested fix` with the user; confirm.
6. Append a synthetic CommentState with `status = Accepted` and continue the review.

### After Phase 7

Show the final list (accepted + edited entries from both 7b and 7c):

```
---

## Final Findings (N total)

**Inline comments (P):**

1. `path:line` — <Trigger> — <one-line summary>
...

**Report-only findings (Q):**

1. `path:line` (or no anchor) — <Trigger> — <one-line summary>
...

---
```

Confirm: "Ready to post? [yes / edit more]"

## Phase 8: Post to GitHub

### Step 8a: Generate review body from accepted comments

Do NOT use the arbiter's original `review_body` directly. Instead, regenerate it based on the comments the user actually accepted in Phase 7:

1. Take the list of **accepted** line comments from Phase 7 (rejected comments are excluded).
2. Write a concise review body that summarizes only the accepted findings. Structure it as:
   - One opening sentence with the overall assessment (e.g., "Well-structured PR that delivers the core requirements. N items to address:")
   - A brief bullet for each accepted comment (file, line, one-line summary)
   - A closing note if the verdict suggests approval with comments vs. requesting changes
3. If no comments were accepted, use a short body appropriate to the action (e.g., "LGTM" for approve, or a brief summary for comment-only).

Save the generated body as `REVIEW_BODY`.

### Step 8b: Present review for confirmation

Present the review body and action as rich text output, then use a two-step AskUserQuestion flow: first pick the action, then optionally edit the body.

**Rich text output:**

```
## Post Review

**Suggested action:** <review_action>

**Review body:**
> <REVIEW_BODY>
```

#### Step 1 — Pick action

**AskUserQuestion** (minimal):

```
Post review?
```

Provide these options:
- **Approve** (Recommended if verdict is APPROVE) — Post as APPROVE
- **Comment only** — Post as COMMENT (no approval)
- **Request Changes** — Post as REQUEST_CHANGES
- **Skip** — Don't post anything to GitHub

Handle the response:
- **Approve** (a, approve, ok, yes, option 1): set `EVENT` to `APPROVE`, proceed to Step 2
- **Comment** (c, comment, option 2): set `EVENT` to `COMMENT`, proceed to Step 2
- **Request Changes** (r, request, option 3): set `EVENT` to `REQUEST_CHANGES`, proceed to Step 2
- **Skip** (skip, no, nothing, done, option 4): **stop** — do not post anything to GitHub

Do NOT accept free-text input here. If the user types something other than picking an option, re-ask the question. Body editing happens in Step 2, not here.

#### Step 2 — Confirm or edit body

Only run this step if the user picked Approve, Comment, or Request Changes in Step 1.

**AskUserQuestion** (minimal):

```
Use this body, or edit it first?
```

Provide these options:
- **Post as-is** — Use the generated body unchanged
- **Edit body** — Provide replacement body text inline

Handle the response:
- **Post as-is** (a, as-is, keep, ok, option 1): keep `REVIEW_BODY` unchanged, proceed to Step 8c
- **Edit body** (e, edit, option 2): prompt the user with:
  > Paste or type the new review body. The original is shown above for reference.

  Take the user's next message verbatim as the new `REVIEW_BODY`. Then show it once for confirmation as rich text:

  ```
  ## Updated Review Body

  > <new REVIEW_BODY>

  **Action:** <EVENT>

  Posting now...
  ```

  Then proceed to Step 8c.

Do not accept free-text input on the menu itself — the user must pick **Edit body** explicitly to enter edit mode.

### Step 8c: Get PR metadata for posting

Parse the PR reference from `$ARGUMENTS` to extract owner, repo, and number.

Run:
```bash
gh pr view <NUMBER> --repo <OWNER>/<REPO> --json headRefOid --jq .headRefOid
```
Save the result as `COMMIT_SHA`.

Run:
```bash
gh pr view <NUMBER> --repo <OWNER>/<REPO> --json files --jq '.files[].path'
```
Save the result as the list of PR file paths.

### Step 8d: Resolve comment paths

For each line comment, resolve its `path` against the PR file list:
1. Try exact match first.
2. If no exact match, try suffix match (the comment path might be relative while PR paths are from repo root, or vice versa). Use the longest suffix match.
3. If still no match, warn the user and skip that comment.

### Step 8e: Build and post the review

Build a JSON payload:
```json
{
  "commit_id": "<COMMIT_SHA>",
  "event": "<EVENT>",
  "body": "<REVIEW_BODY>",
  "comments": [
    {
      "path": "<resolved_path>",
      "line": <line_number>,
      "start_line": <start_line_or_omit>,
      "side": "RIGHT",
      "body": "<comment_body>"
    }
  ]
}
```

For each comment: if `start_line` is present in the parsed JSON, include it in the payload (GitHub highlights the range). If `start_line` is absent, omit it (single-line comment).
```

If there are no comments, omit the `comments` array (just post the review body with the event).

Write the JSON to a temp file and post:
```bash
TMPFILE=$(mktemp)
cat > "$TMPFILE" << 'PAYLOAD'
<json payload>
PAYLOAD
gh api repos/<OWNER>/<REPO>/pulls/<NUMBER>/reviews --input "$TMPFILE"
rm "$TMPFILE"
```

### Step 8f: Report result

If the API call succeeds, report:
```
Review posted successfully!
  Action: <EVENT>
  Comments: <N>
  PR: https://github.com/<OWNER>/<REPO>/pull/<NUMBER>
```

If it fails, show the error and suggest the user check:
- That they have write access to the repo
- That the PR is still open
- That the commit SHA is still the head of the PR

---

## Error Handling

Throughout all phases:
- If a binary command fails, show the stderr output to the user and ask how to proceed.
- If an agent dispatch fails, report which agent failed and continue with the others.
- If the user wants to abort at any point, respect that immediately.
- Never silently swallow errors. Always inform the user.

## Key Reminders

- All file paths must be absolute. Use the paths returned by the PRR binary.
- The `context` command prints the round directory path as the last line of stdout. Capture it accurately.
- The `prompt` commands print the output file path to stdout. You can use these to verify the files were written.
- Agent dispatches for review use the Agent tool. Dispatch ALL agents in a single message for parallelism.
- The arbiter loop can run up to `arbiter_rounds` iterations. Track the count.
- For Q&A dispatches to codex, use `-s read-only` (not `workspace-write`).
- The `parse-report` command outputs JSON to stdout. Parse it directly.
