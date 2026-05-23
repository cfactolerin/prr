# Trigger-Based Findings — Design

## Problem

PRR reviews currently produce findings that are sometimes unrelated to
the diff under review. The motivating case was PR #1301 in
`IndependentIP/bulk`: the only diff hunk in `asset_rights_claim_saver.rb`
was `require "configurable_per_org"`, but the review still flagged
`SUPPRESSIBLE_ERRORS = [...]` on line 10 as a HIGH-severity issue. In
that specific case the flag was defensible (the ticket's Acceptance
Criteria required errors on those codes), but the user reports the same
class of off-topic comments has appeared on other PRs.

The underlying causes:

- **`references/prompts/review-prompt.md`** does not explicitly require
  findings to be traceable to the diff or the ticket. Its
  "Hallucination Check" only asks reviewers to verify findings are real
  — "real but unrelated" still passes.
- **Findings are unclassified.** A reviewer can flag a piece of
  pre-existing code without saying *why* it's relevant (was it caused
  by the diff? required by AC? a security concern that happens to
  appear in this file?). Without a stated trigger, off-topic comments
  are easy to make and hard to filter out.
- **Per-finding format is inconsistent.** The arbiter emits a
  `Line Comments` table where each row is one free-form `Issue` cell.
  Rendering of "Why this matters / Suggested comment" is synthesized at
  display time by `skills/prr-start/SKILL.md` Phase 7, not by the
  reviewer or arbiter. There is no "Suggested fix" anywhere.

## Goal

- Constrain findings to those traceable to the diff or the ticket's
  Acceptance Criteria, so unrelated pre-existing code does not generate
  comments.
- Force every finding to carry a `Trigger` label, classifying why it
  was raised. A finding that cannot be assigned a valid Trigger is
  dropped.
- Standardize per-finding output: `Severity`, `Anchor`, `Location`,
  `Why this matters`, `Suggested comment`, `Suggested fix`. The
  reviewer/arbiter fills these in directly so the skill no longer
  has to synthesize them.
- Distinguish findings that can be posted as GitHub inline comments
  (anchored on diff lines) from report-only findings (anchored on
  unchanged code or cross-cutting), so the GitHub API doesn't reject
  the review.

## Non-Goals

- No change to how PRR ingests context (`prr context`), clones repos,
  or runs Q&A rounds.
- No change to verdict, confidence, ticket-alignment table, agreements,
  or disagreement-resolution sections — those are cross-cutting
  summaries, not per-finding artifacts.
- No migration of cached workspaces. Old reports keep parsing via the
  existing fallback paths in `report.rs`.
- No new agent. The scope rule and format apply uniformly to every
  reviewer currently supported (Claude, Codex, Gemini, opencode).

## Design

### Scope rule (new)

A finding may appear in the report **only if** at least one of:

1. It is caused by, exposed by, or directly affected by a line in the
   diff.
2. It is required by the ticket's Acceptance Criteria but missing or
   violated by the diff (or by code the diff relies on).

If neither holds, the reviewer drops the finding. Specifically:

- A complaint about unchanged code with no connection to the diff or
  the AC is **not allowed**.
- A complaint about unchanged code that the diff *now relies on* (e.g.,
  the new code calls an existing method and the method has a nil
  return the new call site doesn't handle) **is allowed**, but the
  finding's `Location` should anchor on the **new call site** (the
  line that is in the diff), not on the unchanged method body. This
  keeps the finding postable as an inline GitHub comment.
- An AC requirement that an existing piece of unchanged code violates
  **is allowed**, with Trigger `Acceptance Criteria`. The Location may
  anchor on the unchanged line — the AC itself is the justification.
  This finding is **report-only** (see "Postability classification"
  below): it won't be posted as an inline comment but will appear in
  the report and the regenerated review body.

The scope rule appears in three places:

1. `references/prompts/review-prompt.md` — under a new "Scope" section
   immediately above the existing "Instructions" block.
2. `references/prompts/arbiter-prompt.md` — restated when describing
   the Final Report's `Findings` section, so the arbiter enforces it
   when synthesizing.
3. Each `agents/*-reviewer.md` persona — a one-line reinforcement so
   every dispatched reviewer carries the rule even if a future prompt
   change drops it.

### Trigger list (closed)

A finding's Trigger must be **exactly one** of:

1. `Acceptance Criteria`
2. `Code Change`
3. `Code Quality`
4. `Logic Bug`
5. `Security`
6. `Performance`
7. `Missing Test`
8. `Missing Doc / Error Handling`

If a finding plausibly fits two triggers (e.g., a security bug
*introduced* by the diff), pick the one that best explains *why the
issue matters most* — typically `Security` over `Code Change`, but the
reviewer's judgement.

#### Trigger mapping guide

To keep classification consistent across reviewers, the prompt
includes this guide:

| Symptom | Trigger |
|---------|---------|
| Diff violates a ticket Acceptance Criterion (or unchanged code that the AC requires violates it) | `Acceptance Criteria` |
| Diff is functionally wrong: off-by-one, race condition, wrong assumption, wrong data transformation | `Logic Bug` |
| Diff exposes injection / auth bypass / secret leak / unsafe deserialization | `Security` |
| Diff introduces a memory leak, unbounded growth, missing cleanup, slow query, or expensive loop | `Performance` |
| Diff has naming / duplication / readability / structural issues | `Code Quality` |
| Diff adds new behaviour without a corresponding test | `Missing Test` |
| Diff adds new behaviour without docs, comments, or error handling | `Missing Doc / Error Handling` |
| Diff looks suspicious but fits none of the above (e.g., dependency choice, unusual pattern) | `Code Change` |

`Code Change` is the catch-all of last resort — if a finding fits any
other trigger, use that instead. (The previous "Memory / Resource"
category folds into `Performance`.)

### Per-finding format

Each finding renders as:

```markdown
#### F-01 — <short title>

- **Severity:** HIGH | MED | LOW
- **Anchor:** diff | reference | none
- **Location:** `path/to/file:line` or `path/to/file:start-end`
- **Why this matters:** 2-4 sentences. State the consequence and how
  the diff or AC makes it relevant.
- **Suggested comment:** Text the author would post on the PR, as-is.
- **Suggested fix:** Concrete remediation.
```

#### Required vs optional fields

**Required (every finding):** `Severity`, `Anchor`, `Why this matters`,
`Suggested comment`, `Suggested fix`.

**Conditional:** `Location` is required when `Anchor` is `diff` or
`reference`; it is **omitted** when `Anchor` is `none`. A finding with
`Anchor: diff` or `Anchor: reference` but no `Location` is malformed.

#### Notes

- The heading carries a globally sequential ID (`F-01`, `F-02`, …)
  across all triggers — this matches the existing "Comment N/M" UX in
  Phase 7 and keeps cross-references stable.
- `Severity` is a bullet, not part of the heading. Bullets are
  unambiguous to parse with a single regex; heading parens would
  collide with title text that contains parentheses.
- `Anchor` is required so the report itself classifies postability —
  the parser doesn't have to guess, and a downstream reader can tell
  why a finding did or didn't get posted inline.

### Postability classification

GitHub's pull-request review API rejects inline comments whose `line`
isn't part of the unified diff (HTTP 422). The report therefore
distinguishes three kinds of finding:

| `Anchor` value | Has Location? | Posted as inline comment? | Included in regenerated review body? |
|----------------|---------------|---------------------------|--------------------------------------|
| `diff`         | Yes, on a diff line | Yes                 | Summarized in the body               |
| `reference`    | Yes, on an unchanged line | No (would 422)  | Summarized in the body (with file:line for reader navigation) |
| `none`         | No                  | No                  | Summarized in the body               |

The reviewer (and arbiter) labels each finding's `Anchor` value. The
parser verifies the label against the actual diff:

- If a finding claims `Anchor: diff` but the `Location` line is not in
  the diff, the parser **downgrades** it to `reference` and emits a
  stderr warning. The finding is still included; only its postability
  is corrected.
- If a finding claims `Anchor: reference` but the `Location` line *is*
  in the diff, the parser **upgrades** it to `diff` (no warning;
  harmless — the reviewer was just being conservative).
- If no diff is available to the parser (no `--diff` flag passed),
  labels are trusted as-is.
- If `--diff` is passed but the file is missing or unreadable, the
  parser emits a stderr warning ("diff unreadable — verification
  skipped") and trusts labels. The intent is to never hard-fail
  because a sibling file disappeared; an operator running
  `parse-report` against a damaged round directory should still get
  the report contents back.

The skill always passes `--diff <ROUND_DIR>/results/diff.txt` when
invoking `parse-report`, so verification is on in normal production
use; the warning path only fires when the workspace is corrupt or
the operator invokes the binary manually with a bad path.

### Report structure

The Final Report Template in
`references/prompts/arbiter-prompt.md` replaces the existing
`Code Quality Findings`, `Logic & Bug Findings`, `Security Findings`,
and `Missing Things` sections, *and* the standalone `Line Comments`
table, with a single `Findings` section grouped by Trigger.

Heading levels follow the existing arbiter template, which uses
`## Final Report` as the top-level section and `###` for its
subsections (Metadata, Verdict, Confidence, etc.). The new section
slots in at the `###` level, with Trigger groups at `####` and
individual findings at `#####`:

```markdown
## Final Report

### Metadata
...

### Verdict
...

### Findings

#### Trigger: Acceptance Criteria

##### F-01 — <short title>

- **Severity:** HIGH
- **Anchor:** reference
- **Location:** `path/to/file:line`
- **Why this matters:** ...
- **Suggested comment:** ...
- **Suggested fix:** ...

##### F-02 — <short title>

- **Severity:** MED
- **Anchor:** none
- **Why this matters:** ...
- **Suggested comment:** ...
- **Suggested fix:** ...

#### Trigger: Code Change

##### F-03 — <short title>

- **Severity:** HIGH
- **Anchor:** diff
- **Location:** `path/to/file:start-end`
- **Why this matters:** ...
- **Suggested comment:** ...
- **Suggested fix:** ...

### Review Action
...
```

Per-agent reviews (`{agent}-review.md`) use the same shape but at one
level shallower since they don't nest under `## Final Report`:
`## Findings` / `### Trigger:` / `#### F-NN`. The arbiter
re-emits the agent findings under the `### Findings` heading when
synthesizing.

Empty trigger groups are omitted (no `#### Trigger: Performance`
block if there are no Performance findings). If there are zero
findings total, the section renders as
`### Findings\n\nNone identified.`

Sections retained unchanged:

- `Metadata`
- `Verdict`
- `Confidence`
- `Ticket Alignment` (the requirements table)
- `Agreements`
- `Disagreements & Resolution`
- `Review Action`

Sections removed:

- `Ticket Alignment Findings` — folded into `Findings` under Trigger
  `Acceptance Criteria`.
- `Code Quality Findings`, `Logic & Bug Findings`, `Security Findings`,
  `Missing Things` — folded into `Findings` under their respective
  Triggers.
- `Line Comments` table — every line-anchored finding now appears in
  `Findings` with its `Location` bullet.

### Parser changes (`src/report.rs`)

The `ParsedReport` struct gains a `findings` field:

```rust
#[derive(Debug, Serialize)]
pub struct ParsedReport {
    pub verdict: String,
    pub confidence: String,
    pub findings: Vec<Finding>,         // new
    pub line_comments: Vec<LineComment>, // kept (derived; postable subset)
    pub review_action: Option<String>,
    pub review_body: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Anchor {
    Diff,       // Location is on a diff line — postable as inline comment
    Reference,  // Location is on an unchanged line — report-only
    None,       // No location — cross-cutting; report-only
}

#[derive(Debug, Serialize)]
pub struct Finding {
    pub id: String,             // "F-01"
    pub title: String,
    pub trigger: String,        // one of the 8
    pub severity: String,       // HIGH | MED | LOW
    pub anchor: Anchor,
    pub location: Option<String>, // "path:line" or "path:start-end"
    pub path: Option<String>,
    pub line: Option<u64>,
    pub start_line: Option<u64>,
    pub why_it_matters: String,
    pub suggested_comment: String,
    pub suggested_fix: String,
}
```

`line_comments` is derived from findings where `anchor == Anchor::Diff`
only — these are the comments safe to post inline. The derivation
sets `body` to `suggested_comment` and fills `path`, `line`, and
`start_line` from the Location string via the existing
`parse_line_ref` helper.

#### CLI signature

```
prr parse-report <report_path> [--diff <diff_path>]
```

If `--diff` is given, the parser verifies each finding's `Anchor`
against the diff (per "Postability classification" above), downgrading
`diff` → `reference` when the line isn't in the diff (with stderr
warning) and upgrading `reference` → `diff` when the line is in the
diff (no warning). If `--diff` is omitted, labels are trusted as-is.

The skill in `skills/prr-start/SKILL.md` always passes `--diff`.

#### Parsing strategy

- Locate the Findings section. The parser accepts both heading levels:
  `### Findings` (used in `final-report.md` under `## Final Report`)
  and `## Findings` (used in per-agent `{agent}-review.md` files,
  which don't nest under a top-level "Final Report").
- Walk forward, tracking the current Trigger heading. Trigger headings
  are at one level deeper than the Findings heading:
  - `### Findings` → `#### Trigger: <name>` → `##### F-NN — <title>`
  - `## Findings`  → `### Trigger: <name>`  → `#### F-NN — <title>`
- For each finding heading, capture bullets until the next finding
  heading, Trigger heading, or any heading at the Findings level or
  shallower.
- Each bullet starts with `- **Key:**`. **Continuation lines** (lines
  that don't start with `- **` and aren't a heading or blank line)
  belong to the current bullet's value — they're joined with a single
  space when capturing the value. This lets `Why this matters` /
  `Suggested comment` / `Suggested fix` span multiple wrapped lines.
- A blank line between bullets ends the current bullet's value (no
  more continuation). The next non-blank `- **Key:**` line starts a
  new bullet.
- Each bullet is a `**Key:**` prefix → value mapping. Keys are matched
  case-insensitively (`Anchor`, `anchor`, `ANCHOR` are equivalent),
  but the canonical form (title-case) is used in output and in
  warnings.
- `Anchor` values are parsed case-insensitively and stored lowercase
  (`diff` / `reference` / `none`). Any other value → malformed.
- Missing **required** bullets fail validation: the finding is skipped
  and a warning is emitted to stderr (the `skill` surfaces stderr so
  the operator can see when reviewer output is out of spec). Required
  bullets: `Severity`, `Anchor`, `Why this matters`,
  `Suggested comment`, `Suggested fix`.
- `Location` is required only when `Anchor` is `diff` or `reference`.
  If `Anchor` is `none` and `Location` is present (or vice versa), the
  finding is malformed → skipped + warning.
- Trigger values outside the closed 8 → malformed → skipped + warning.

#### Diff verification

The parser uses a minimal unified-diff scanner: for each hunk
header `@@ -a,b +c,d @@` in the diff, the additive line range on the
new file is `[c, c + d - 1]`. A `Location: path:line` is considered
"in the diff" if the path appears in the diff (matching the diff's
`+++ b/<path>` header) **and** `line` falls inside one of the additive
ranges for that path. Range Locations (`path:start-end`) require every
line in `[start, end]` to be in the diff; if any line is outside, the
finding is downgraded.

#### Backward compatibility

If no Findings section is present, the parser falls back to the
existing `## Line Comments` table extractor. Each legacy
`LineComment` is **synthesized into a Finding** so downstream code
sees a uniform `findings` array (see the "Backward Compatibility"
section below for the synthesis rules and the verification carve-out).
Cached workspaces continue to work without dual code paths in the
skill.

### Skill changes (`skills/prr-start/SKILL.md`)

Phase 7 today walks the `line_comments` array and synthesizes
"Why this matters" / "Suggested comment" at render time from the body.
After this change, Phase 7 reads `findings` directly and handles the
three Anchor classes distinctly. It is restructured into three
sub-phases.

#### Phase 7 — in-memory state

The skill maintains an ordered list of `CommentState` entries, one
per `Finding`:

```
CommentState {
    finding: Finding              // straight from parse-report JSON
    status: Pending | Accepted | Rejected | Edited
    overridden_body: Option<str>  // populated when status == Edited
}
```

New findings added by the user in the "Add new" flow are appended to
this list with `status = Accepted`. The list survives across the three
sub-phases below, then is consumed by Phase 8.

#### Phase 7a — diff-anchored findings (postable inline comments)

For each `finding` with `anchor == "diff"`, in order:

1. Render the rich context block (already specified in the existing
   skill) but with the new fields:
   - Heading: `Comment N/M — <Trigger> — <title> (<Severity>)`
     where `N/M` counts only diff-anchored findings.
   - Three labelled blocks: `Why this matters`, `Suggested comment`,
     `Suggested fix`.
2. Use AskUserQuestion: Accept / Reject / Edit (same as today). Edits
   replace the `suggested_comment` body and set `status = Edited`.
3. Update the `CommentState` for this finding.

#### Phase 7b — reference-anchored and unanchored findings (report-only)

After diff-anchored findings, walk findings with `anchor == "reference"`
or `anchor == "none"`. These cannot be posted as inline comments but
must still be reviewed:

1. Render the same rich context. For `reference`, include the
   `Location` so the user can navigate; for `none`, omit location.
   Add a one-line note: `(Report-only — won't be posted as an inline
   comment; will be summarized in the review body.)`
2. AskUserQuestion: Accept / Reject / Edit. "Accept" here means
   "include in the regenerated review body."
3. Update `CommentState`.

#### Phase 7c — Add new finding

Existing "add new" flow extended:

1. Ask for `Trigger` (AskUserQuestion with the 8 options).
2. Ask for `Severity` (HIGH / MED / LOW).
3. Ask for `Anchor`: "Is this anchored on a changed line, on existing
   code, or on no specific line?" → `diff` / `reference` / `none`.
4. If `Anchor` ≠ `none`, ask for `path:line` (or help the user find
   it).
5. Draft `Why this matters`, `Suggested comment`, `Suggested fix`
   with the user; confirm.
6. Append the synthetic Finding to the `CommentState` list with
   `status = Accepted`.

### Skill changes — Phase 8

Phase 8a regenerates the review body. The change:

- Body summary draws from **all** accepted CommentStates, not only the
  diff-anchored ones. The bullet list groups by Anchor:
  - "Inline comments (N):" — one bullet per Accepted/Edited
    diff-anchored finding (file, line, one-line summary).
  - "Other findings (M):" — one bullet per Accepted/Edited
    reference-anchored or unanchored finding (file:line if available,
    plus one-line summary). This is the section that fixes the
    "invisible HIGH cross-cutting finding" gap.

Phase 8e (build the GitHub payload) is unchanged from the operator's
point of view: only diff-anchored Accepted/Edited findings become
`comments[]` entries. The review body (built in 8a) already includes
the report-only findings.

### Output JSON shape consumed by Phase 7

The parsed JSON from `prr parse-report --diff <diff>` is:

```json
{
  "verdict": "REQUEST_CHANGES",
  "confidence": "HIGH",
  "findings": [
    {
      "id": "F-01",
      "title": "SUPPRESSIBLE_ERRORS swallows ticket-mandated errors",
      "trigger": "Acceptance Criteria",
      "severity": "HIGH",
      "anchor": "reference",
      "location": "lib/savers/asset_rights_claim_saver.rb:10",
      "path": "lib/savers/asset_rights_claim_saver.rb",
      "line": 10,
      "start_line": null,
      "why_it_matters": "...",
      "suggested_comment": "...",
      "suggested_fix": "..."
    },
    {
      "id": "F-02",
      "title": "No integration test for Release#save",
      "trigger": "Missing Test",
      "severity": "MED",
      "anchor": "none",
      "location": null,
      "path": null,
      "line": null,
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

Phase 7 iterates `findings`; `line_comments` is retained for legacy
callers and as a quick view of the postable subset.

### Agent persona changes

Each of `agents/claude-reviewer.md`, `codex-reviewer.md`,
`gemini-reviewer.md`, `opencode-reviewer.md` gets one extra
paragraph reinforcing the scope rule:

> Every finding you produce must be traceable to either a line in the
> diff or a ticket Acceptance Criterion. Findings about unchanged code
> that's unrelated to both are out of scope — drop them. When a
> finding does anchor on unchanged code (because the AC requires it),
> use `Anchor: reference` so the report makes the postability explicit
> and the GitHub API doesn't reject the inline comment.

This is duplicate-by-design — if a future prompt change accidentally
drops the scope rule, the persona still carries it.

### `CLAUDE.md`

Add a short "Findings format" subsection documenting:

- The 8 Triggers and the mapping guide.
- The per-finding bullet structure (Severity, Anchor, Location,
  Why this matters, Suggested comment, Suggested fix) and which
  bullets are required vs conditional.
- The scope rule.
- The postability classification (diff / reference / none) and how
  it maps to inline-comment posting vs review-body summary.

This is for maintainers of the prompts/agents, not end users.

## Edge Cases

- **Findings with multiple plausible Locations.** The reviewer picks
  the single most representative anchor; secondary locations go into
  `Why this matters` prose.
- **Findings with no anchor at all.** `Location` is omitted and
  `Anchor` is `none`. Phase 7b presents the finding for accept/reject
  and the Phase 8 review-body regen includes accepted ones in the
  "Other findings" section. They are never posted as inline GitHub
  comments.
- **Findings anchored on unchanged code (`Anchor: reference`).** Same
  treatment as unanchored — surfaced in Phase 7b, included in the
  review-body summary with `file:line` for reader navigation, never
  posted inline.
- **Reviewer mislabels Anchor.** The parser cross-references the
  Location against the diff and corrects (downgrade with warning, or
  upgrade silently). The corrected `Anchor` is what reaches the skill.
- **Reviewers that produce malformed bullets.** The parser skips the
  finding and emits a stderr warning. The skill surfaces this and the
  operator can ask for a re-review (the existing `re-review` interactive
  loop in Phase 6). No automatic retry — keep the binary deterministic.
- **Two findings with the same title under different Triggers.** Each
  gets its own `F-NN` ID; they're independent rows.
- **A finding whose Trigger isn't in the closed list.** The parser
  treats it as malformed (skip + warn). The reviewer/arbiter is
  prompted to reclassify.
- **A user-added finding (Phase 7c) with `Anchor: diff` but a
  Location not in the diff.** The skill validates the user's input
  against `diff.txt` and re-prompts if it doesn't match (downgrades
  to `reference` if the user confirms).
- **Deletion-only diff hunks.** GitHub inline comments anchor on a
  side; a comment about a removed line can be posted with
  `side: "LEFT"`, but PRR's Phase 8e currently posts every comment
  with `side: "RIGHT"`. For now: a finding about deleted code should
  anchor on the nearest adjacent right-side context line (the
  unchanged line before or after the deletion, which the diff
  *does* include) and explain the deletion in `Why this matters`.
  If no usable right-side context exists (e.g., entire file deleted),
  the finding uses `Anchor: reference` with the deleted file as the
  Location and is surfaced report-only. Native `side: "LEFT"` support
  is out of scope for this spec — tracked separately.

## Backward Compatibility

- Old cached reports in `~/.prr/workspace/.../r<N>/results/final-report.md`
  use the legacy `## Line Comments` table. The fallback in
  `report.rs` keeps parsing them — no migration.
- For old reports, the parser synthesizes `Finding` entries from the
  legacy `LineComment` rows so the skill sees a uniform `findings`
  array with no fallback code path. Each synthesized finding gets:
  - `anchor: "diff"` (the only kind the old format could carry —
    old line comments were always intended to be posted inline;
    canonical lowercase as defined in the parser changes section)
  - `trigger: "Code Change"` (the catch-all used when reviewers
    didn't classify)
  - `severity` from the table's Severity column when present, else
    `MED`
  - `suggested_comment` = the legacy `body`
  - `why_it_matters` = `"(legacy report — not classified)"`
  - `suggested_fix` = `"(legacy report — no fix suggested)"`
  - `id` = `"F-NN"` numbered in table order
- **Diff verification is skipped for synthesized findings.** Even when
  `--diff` is passed, the parser does not downgrade legacy findings:
  the old diff is often not the *current* diff (cached round may be
  from days ago), and downgrading would silently strip
  previously-postable comments from `line_comments`. Synthesized
  findings carry an internal "from-legacy" flag (not exposed in JSON)
  that the verification step honors. This keeps the cache-compat
  check ("same `line_comments` array as before") meaningful.
- The skill walks `findings` uniformly: for old reports the synthesized
  findings flow through Phase 7a (diff-anchored), preserving the
  current behaviour. `line_comments` remains as the diff-anchored view
  for any consumer that hasn't been updated.

## Files Touched

| File | Change |
|------|--------|
| `references/prompts/review-prompt.md` | Add Scope section + Trigger list (with mapping guide) + new Findings structure; remove per-category sections; require `Anchor` per finding |
| `references/prompts/arbiter-prompt.md` | Update Final Report Template — drop narrative findings sections + Line Comments table; add Findings grouped by Trigger; restate scope rule; require `Anchor` per finding |
| `references/report-format.md` | Replace old `## Missing Things` / `## Line Comments` sections with the new Findings format. Currently the canonical report-format reference for downstream consumers. |
| `docs/design/prr-design.md` | Replace `## Missing Things` and `## Line Comments` blocks (lines 210, 225, 228) with the new Findings format so design doc and spec agree. |
| `src/report.rs` | Add `findings: Vec<Finding>`, `Anchor` enum, `--diff` flag, postability verification; keep `line_comments` as derived (diff-anchored only); keep old-format fallback; add tests |
| `src/main.rs` | Add `--diff` argument to `parse-report` subcommand |
| `skills/prr-start/SKILL.md` | Phase 7 split into 7a (diff-anchored), 7b (reference / unanchored), 7c (add new with Trigger + Anchor); Phase 8a body regen includes report-only findings; `parse-report` is called with `--diff` |
| `agents/claude-reviewer.md` | One-line scope-rule reinforcement |
| `agents/codex-reviewer.md` | Same |
| `agents/gemini-reviewer.md` | Same |
| `agents/opencode-reviewer.md` | Same |
| `CLAUDE.md` | Short "Findings format" subsection |
| `Cargo.toml` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` / `bin/prr-darwin-universal` | Version bump (minor, since `src/` changes) + rebuilt binary, per repo policy |

## Verification

- **Parser tests** in `src/report.rs`:
  - New format at `### Findings` (final-report): parses into the
    expected `Vec<Finding>`, with `line_comments` derived from
    diff-anchored findings only.
  - New format at `## Findings` (per-agent review file): parses
    identically — both heading levels supported.
  - Multiline bullet values: `Why this matters` / `Suggested comment`
    / `Suggested fix` wrapped across 2+ lines are captured as one
    space-joined string up to the next `- **Key:**`, heading, or
    blank-line boundary.
  - Case-insensitive bullet keys: `**anchor:**`, `**Anchor:**`,
    `**ANCHOR:**` all parse identically.
  - Case-insensitive Anchor values: `Anchor: DIFF`, `Anchor: Diff`,
    `Anchor: diff` all canonicalize to lowercase `diff`.
  - Old format only: Findings absent → falls back to Line Comments
    table; `findings` contains the synthesized entries (one per
    legacy row, `anchor=diff`, `trigger="Code Change"`, severity
    from table or `MED`); `line_comments` matches the legacy output.
  - Mixed: Findings section present + legacy Line Comments table also
    present — Findings wins; legacy table is ignored.
  - Malformed finding (missing required bullet, unknown Trigger,
    `Anchor: none` with a Location, `Anchor: diff/reference` without
    a Location, etc.) → skipped + warning on stderr.
  - Anchor mislabel on a new-format finding — claim `diff` but
    Location not in diff → downgraded to `reference`, warning
    emitted, `line_comments` does not include this finding.
  - Anchor under-label — claim `reference` but Location is in diff →
    silently upgraded to `diff`, `line_comments` includes it.
  - Range Location partially outside diff (e.g., `path:100-105` but
    diff only covers 100-103) → downgraded to `reference`.
  - **Synthesized findings bypass verification**: parse an old-format
    report with `--diff` pointing to a diff that does NOT contain the
    legacy line — confirm the synthesized finding stays `anchor=diff`
    and `line_comments` is unchanged (the cache-compat invariant).
  - `--diff` flag omitted → all labels trusted as-is.
- **End-to-end manual runs**:
  - A docs-only PR: confirm no findings appear on unchanged code
    that's not part of the diff or ticket AC.
  - A logic PR with a clear cross-cutting concern (e.g., missing
    integration test): confirm the finding appears with `Anchor: none`
    and is summarized in the regenerated review body but is not
    submitted as an inline comment.
  - A PR where the AC requires fixing unchanged code: confirm the
    finding appears with `Anchor: reference`, file:line is shown to
    the user in Phase 7b, and the GitHub API call does not include it
    as an inline comment (no 422).
- **Cache compatibility check**: run `prr parse-report` against the
  existing `IndependentIP/bulk/pr-1301/r1/results/final-report.md`
  (with and without `--diff`) and confirm it still produces the same
  `line_comments` array via the old-format fallback.
