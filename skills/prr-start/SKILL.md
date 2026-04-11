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

Read `~/.prr/config.yml` and extract the `agents` list. This determines which agents to dispatch. Common values: `["claude"]`, `["claude", "codex"]`, `["claude", "codex", "gemini"]`.

Also read `gemini_model` (default: `gemini-2.5-flash`), `google_cloud_project` (default: `fuga-prod`), `google_cloud_location` (default: `europe-west4`), and `arbiter_rounds` (default: 3) for later use.

### Step 4b: Build the review prompt

Run:
```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal prompt --review <ROUND_DIR>
```

If the user provided review tasks in Phase 3, include them:
```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal prompt --review <ROUND_DIR> --tasks '<REVIEW_TASKS_JSON>'
```

The command writes the prompt to `<ROUND_DIR>/results/review-prompt.md` and prints its path to stdout.

### Step 4c: Dispatch agents in parallel

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

### Step 4d: Wait and verify

After all agents complete, verify each expected output file exists and is non-empty:
- `<RESULTS_PATH>/claude-review.md` (if claude was dispatched)
- `<RESULTS_PATH>/codex-review.md` (if codex was dispatched)
- `<RESULTS_PATH>/gemini-review.md` (if gemini was dispatched)

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

Search the output for a fenced JSON code block (` ```json `) whose content is an object with agent name keys (e.g., `"claude"`, `"codex"`, `"gemini"`). Each key maps to an array of question strings.

**If questions are found:**

1. Parse the JSON questions object. Example:
   ```json
   {
     "claude": ["What about the race condition on line 42?"],
     "codex": [],
     "gemini": ["Did you verify the SQL injection fix?"]
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

## Phase 7: Line Comment Review

### Step 7a: Parse the report

Run:
```
${CLAUDE_PLUGIN_ROOT}/bin/prr-darwin-universal parse-report <ROUND_DIR>/results/final-report.md
```

This outputs JSON to stdout. Parse it. The structure is:
```json
{
  "verdict": "REQUEST_CHANGES",
  "confidence": "HIGH",
  "line_comments": [
    {
      "checked": true,
      "path": "src/main.rs",
      "line": 42,
      "url": "https://github.com/...",
      "body": "Fix null check"
    }
  ],
  "review_action": "Request Changes",
  "review_body": "This PR needs..."
}
```

### Step 7b: Review each comment with the user

Only present comments where `checked` is `true` (these are the ones the arbiter marked for posting).

For each comment, present it in **two parts**: rich context as regular text output, then a minimal AskUserQuestion for the user's decision. This split gives the comment details full markdown rendering (syntax-highlighted code, icons, formatting) while keeping the prompt clean.

#### Gathering context for each comment

1. **Clickable link**: Use the `url` field from the parsed JSON. If `url` is present, display the file reference as a markdown link: `[path#L<line>](url)`. If `url` is null, display `path#L<line>` as plain text.

2. **Code context**: Read the file directly from `<ROUND_DIR>/repo/<path>`. Show ~5 lines before and after the target line. Use a **language-specific fenced code block** (e.g. ` ```ruby `, ` ```python `) for proper syntax highlighting. Do NOT add line number prefixes inside the code block — they break syntax highlighting. Instead, note the line range and target line in the **File:** line above the code block. Mark the target line with a trailing `# <--` comment. Example:
   ```ruby
   def resolve_ddex(key)
     kgotla_override(key, :ddex) ||
       @overrides.dig(:connection, @connection_id, key, :ddex) || # <--
       @overrides.dig(:aggregate, @aggregate_feed_connection_id, key, :ddex) ||
       self.class.default_entries[key]&.default_ddex ||
   ```
   If the diff at `<ROUND_DIR>/results/diff.txt` provides better context (shows +/- lines), prefer it but still use a language-hinted fenced block.

3. **Explanation**: A brief explanation of **why** this is a problem — what could go wrong, what the expected behavior should be, or what the risk is. This should come from the comment body and the review findings.

#### Part 1: Rich text output (before AskUserQuestion)

Output the full comment details as regular text. This renders with proper markdown formatting, syntax-highlighted code, and icons. Use this format:

```
## Comment N/M — <one-line summary>

📄 [path#L<line>](url) (lines N–M)

<code context in language-specific fenced code block, target line marked with # <-->

**Why this matters:** <explanation>

**Suggested comment:**
> <body>
```

#### Part 2: Minimal AskUserQuestion

Immediately after the rich text output, use AskUserQuestion with **only** the comment title and options. Keep it minimal — the user has already read the details above.

Use this format for the question text:

```
Comment N/M — <one-line summary>
```

Provide these options in the AskUserQuestion:
- **Accept** — Keep this comment as-is
- **Reject** — Skip this comment, don't post it
- **Edit** — Provide replacement text for this comment

And allow free-text input for edits, clarifications, or discussion.

#### Handling responses

- **Accept** (a, accept, y, yes, ok, option 1): Keep the comment as-is. Move to the next comment.
- **Reject** (r, reject, no, skip, option 2): Remove this comment from the list. Move to the next.
- **Edit** (e, edit, option 3): Ask the user for the replacement text. Use it verbatim as the new body.
- **Free text**: If the user types something else, treat it as a clarification or edit. Rewrite the comment body incorporating their input, show it for confirmation, then move on.
- **Add new** (add, new, +): The user describes an issue. You draft a new comment:
  - Ask for the file path and line number (or help them find it by searching the diff)
  - Draft the comment body
  - Show it for confirmation
  - Add to the list
  - Then continue reviewing remaining comments
- **Done** (done, d, stop, enough): Stop reviewing individual comments. All remaining unreviewed comments are kept as-is. Proceed to Phase 8.

#### After all comments reviewed

After reviewing all comments (or user says done), show the final list:
```
---

## Final Comments (N total)

1. **File:** [path#L<line>](url) — <body preview>
2. **File:** [path#L<line>](url) — <body preview>
...

---
```

Confirm with the user: "Ready to post these comments? [yes/edit more]"

---

## Phase 8: Post to GitHub

### Step 8a: Determine review action

The parsed report may include a `review_action` and `review_body`. Present them inside a single AskUserQuestion:

```
---

## Post Review

**Suggested action:** <review_action>

**Review body:**
> <review_body>

---
```

Provide these options:
- **Approve** (Recommended if verdict is APPROVE) — Post as APPROVE with suggested body
- **Comment only** — Post as COMMENT (no approval)
- **Request Changes** — Post as REQUEST_CHANGES
- **Skip** — Don't post anything to GitHub

And allow free-text input for replacement body text.

Handle the response:
- **Approve** (a, approve, ok, yes, option 1): use `APPROVE` with the suggested body
- **Comment** (c, comment, option 2): use `COMMENT` with the suggested body
- **Request Changes** (r, request, option 3): use `REQUEST_CHANGES` with the suggested body
- **Skip** (skip, no, nothing, done, option 4): mark task 8 as completed and **stop** — do not post anything to GitHub
- **Free text**: use it as the review body, then ask for the action

### Step 8b: Get PR metadata for posting

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

### Step 8c: Resolve comment paths

For each line comment, resolve its `path` against the PR file list:
1. Try exact match first.
2. If no exact match, try suffix match (the comment path might be relative while PR paths are from repo root, or vice versa). Use the longest suffix match.
3. If still no match, warn the user and skip that comment.

### Step 8d: Build and post the review

Build a JSON payload:
```json
{
  "commit_id": "<COMMIT_SHA>",
  "event": "<EVENT>",
  "body": "<review_body>",
  "comments": [
    {
      "path": "<resolved_path>",
      "line": <line_number>,
      "side": "RIGHT",
      "body": "<comment_body>"
    }
  ]
}
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

### Step 8e: Report result

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
