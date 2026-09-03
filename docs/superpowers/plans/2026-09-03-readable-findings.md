# Readable Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PRR findings readable in a terminal — `Why this matters`
becomes labelled slots instead of a paragraph, and the parser stops
flattening every line break into a space.

**Architecture:** Three layers, in dependency order. The parser
(`src/report.rs`) preserves newlines and indentation inside bullet
values, so structure written upstream survives to the reader. The
prompts (`references/prompts/`) tell reviewers and the arbiter to write
`Why this matters` as labelled sub-bullets with situation-dependent
labels. The skill (`skills/prr-start/SKILL.md`) prints the captured
value verbatim instead of stuffing it into one `**Label:** value` line.
The JSON contract does not change — `why_it_matters`,
`suggested_comment` and `suggested_fix` keep their names and types, and
only gain the ability to contain newlines.

**Tech Stack:** Rust 2021 (`regex`, `serde`), markdown skill and prompt
files, `cargo test`, `./scripts/build-universal.sh` (lipo universal
macOS binary).

**Spec:** `docs/superpowers/specs/2026-09-03-readable-findings-design.md`

## Global Constraints

- Rust edition 2021. Error handling is `Box<dyn Error>`; no custom error
  types.
- No `unwrap()` in production paths. (Existing `Regex::new(...).unwrap()`
  on compile-time-constant patterns in `report.rs` is established
  practice — match it, don't extend it to runtime input.)
- **The JSON contract is frozen.** Do not rename, add, or remove fields
  on `Finding`. Values may now contain `\n`; nothing else changes.
- **The whole feature lands as one bump: `0.6.0` to `0.7.0`.** Tasks 1
  and 2 commit their work without touching the version files or the
  binary. Task 3 bumps `Cargo.toml`, `.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json`, rebuilds, and commits
  `bin/prr-darwin-universal` alongside the rest. This is an agreed
  exception to `CLAUDE.md`'s "every commit bumps" rule: the first two
  commits are steps inside one change, and no version is ever published
  against a stale binary.
- **`references/prompts/*.md` are `include_str!`'d into the binary**
  (`src/prompt.rs:5-7`), so editing them is a binary-affecting change and
  takes a **minor** bump, not a patch. `CLAUDE.md`'s bump rule currently
  says only "files under `src/`" — Task 3 fixes that wording.
- Baseline before any change: `cargo test` → 105 passed, 0 failed. Every
  task must end with that count or higher, 0 failed.
- **Line numbers in this plan are pre-edit anchors**, correct against the
  tree at `af67732`. The moment a step inserts lines into a file, every
  later line number for that same file is stale. Locate each subsequent
  target in that file by the quoted content the step shows, not by
  number. This bites Task 2 (Step 3 inserts ~55 lines above the Step 4
  targets) and Task 3 (Step 1 inserts above the Step 2 and Step 3
  targets).
- Voice rules from `~/.claude/CLAUDE.md` apply to commit messages and any
  prose added to docs: imperative subjects, no AI-tells, no
  co-authorship footers.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/report.rs` | `parse_finding_bullets` capture semantics + its tests | 1 |
| `src/prompt.rs` | Guard test that both templates carry the label vocabulary | 2 |
| `references/prompts/review-prompt.md` | Per-agent reviewer instructions and output template | 2 |
| `references/prompts/arbiter-prompt.md` | Arbiter instructions and final-report template | 2 |
| `skills/prr-start/SKILL.md` | Phase 7 terminal rendering, Phase 7d drafting, Phase 8 summary | 3 |
| `references/report-format.md` | Authoritative format reference | 3 |
| `CLAUDE.md` | Developer reference: findings format, versioning rule | 3 |

No new files. No file splits — `src/report.rs` is large (1416 lines) but
the change is confined to one 35-line function plus tests, and
restructuring it is out of scope.

---

## Task 1: Parser preserves structure inside bullet values

**Files:**
- Modify: `src/report.rs:413-447` (`parse_finding_bullets`)
- Test: `src/report.rs` — `mod tests` starting at line 702

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parse_finding_bullets(block: &str) -> HashMap<String, String>`
  — unchanged signature. Values may now contain `\n` and leading spaces.
  `parse_findings_section(content: &str) -> Vec<Finding>` is unchanged and
  is what the tests below call.

### Why this is first

`parse_finding_bullets` currently joins a bullet's lines with `" "` and
flushes the current key on any blank line. Every downstream change in
Tasks 2 and 3 is invisible until this is fixed — structure written by an
agent is destroyed before the renderer ever sees it.

- [ ] **Step 1: Write the four failing tests**

Add to `mod tests` in `src/report.rs`, after
`test_parse_finding_bullets_full` (ends line 1083):

```rust
    #[test]
    fn test_bullet_value_keeps_indented_sublabels() {
        let content = r#"## Findings

### Trigger: Missing Test

#### F-01 — Retry path is untested

- **Severity:** MED
- **Anchor:** diff
- **Location:** `lib/deliverable.rb:57`
- **Why this matters:**
  - **What this adds:** A `retry_on_conflict` branch in `Deliverable#push`.
  - **What's missing:** No spec covers the conflict path, so a regression
    in the retry ceiling would ship silently.
- **Suggested fix:** Add a spec driving two conflicting pushes.
- **Suggested comment:** The conflict branch has no coverage.
"#;
        let findings = parse_findings_section(content);
        assert_eq!(findings.len(), 1);
        let why = &findings[0].why_it_matters;
        assert!(
            why.contains("- **What this adds:**"),
            "sub-labels must survive: {why}"
        );
        assert!(
            why.contains("- **What's missing:**"),
            "sub-labels must survive: {why}"
        );
        assert_eq!(
            why.lines().count(),
            3,
            "line breaks must survive: {why}"
        );
        assert!(
            why.lines().next().unwrap().starts_with("  - **What this adds:**"),
            "indentation must survive: {why}"
        );
    }

    #[test]
    fn test_blank_line_inside_bullet_value_does_not_truncate() {
        let content = r#"## Findings

### Trigger: Code Change

#### F-01 — Title

- **Severity:** LOW
- **Anchor:** none
- **Why this matters:** First paragraph.

  Second paragraph after a blank line.
- **Suggested fix:** f
- **Suggested comment:** c
"#;
        let findings = parse_findings_section(content);
        assert_eq!(findings.len(), 1);
        let why = &findings[0].why_it_matters;
        assert!(why.contains("First paragraph."), "{why}");
        assert!(
            why.contains("Second paragraph after a blank line."),
            "a blank line must not truncate the value: {why}"
        );
        assert!(why.contains("\n\n"), "the blank line itself is kept: {why}");
    }

    #[test]
    fn test_next_top_level_bullet_still_flushes_previous_value() {
        let content = r#"## Findings

### Trigger: Code Change

#### F-01 — Title

- **Severity:** LOW
- **Anchor:** none
- **Why this matters:** w
- **Suggested fix:** f
- **Suggested comment:** c
"#;
        let findings = parse_findings_section(content);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].why_it_matters, "w");
        assert_eq!(findings[0].suggested_fix, "f");
        assert_eq!(findings[0].suggested_comment, "c");
    }

    #[test]
    fn test_bullet_value_trailing_blank_lines_stripped() {
        let content = "## Findings\n\n### Trigger: Code Change\n\n#### F-01 — Title\n\n- **Severity:** LOW\n- **Anchor:** none\n- **Why this matters:** w\n- **Suggested fix:** f\n- **Suggested comment:** Only line.\n\n\n";
        let findings = parse_findings_section(content);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].suggested_comment, "Only line.");
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

The four new tests share no single substring, so run them by name:

```bash
cargo test --bin prr test_bullet_value_keeps_indented_sublabels
cargo test --bin prr test_blank_line_inside_bullet_value_does_not_truncate
cargo test --bin prr test_next_top_level_bullet_still_flushes_previous_value
cargo test --bin prr test_bullet_value_trailing_blank_lines_stripped
```

Expected: `test_bullet_value_keeps_indented_sublabels` FAILS on the
`why.lines().count()` assertion (it will be 1 — everything joined with
spaces). `test_blank_line_inside_bullet_value_does_not_truncate` FAILS
on the "Second paragraph" assertion (the blank line flushed the key, so
the text was discarded). The other two PASS already — they are
regression guards for behavior that must not change.

- [ ] **Step 3: Rewrite `parse_finding_bullets`**

Replace `src/report.rs:413-447` in full:

```rust
/// Parse the `- **Key:** value` bullets of a finding block.
///
/// A value runs until the next top-level bullet, a markdown heading, or
/// the end of the block. Line breaks and leading indentation are kept:
/// `Why this matters` nests labelled sub-bullets, and the skill prints
/// the captured value verbatim. Because a blank line no longer ends a
/// value, stray prose after the last bullet is absorbed into it — the
/// format does not allow trailing prose, and a lookahead to catch it
/// would cost more than it saves.
fn parse_finding_bullets(block: &str) -> std::collections::HashMap<String, String> {
    let bullet_re = Regex::new(r"^-\s*\*\*([^:*]+):\*\*\s*(.*)$").unwrap();
    let mut out: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut current_key: Option<String> = None;
    let mut current_val: Vec<String> = Vec::new();

    let flush = |key: &mut Option<String>,
                 val: &mut Vec<String>,
                 out: &mut std::collections::HashMap<String, String>| {
        if let Some(k) = key.take() {
            out.insert(k, val.join("\n").trim_matches('\n').to_string());
        }
        val.clear();
    };

    for line in block.lines() {
        let trimmed = line.trim_end();
        if let Some(caps) = bullet_re.captures(trimmed) {
            flush(&mut current_key, &mut current_val, &mut out);
            current_key = Some(caps[1].trim().to_lowercase());
            let initial = caps[2].trim().to_string();
            if !initial.is_empty() {
                current_val.push(initial);
            }
        } else if trimmed.trim_start().starts_with('#') {
            flush(&mut current_key, &mut current_val, &mut out);
        } else if current_key.is_some() {
            current_val.push(trimmed.to_string());
        }
        // Lines outside any bullet are ignored.
    }
    flush(&mut current_key, &mut current_val, &mut out);
    out
}
```

Three changes to note while editing: `flush` now takes `&mut Option<String>`
and calls `.take()`, so the old `current_key = None;` line after the
blank-line flush is gone; the blank-line branch is gone entirely (a blank
line now falls through to the continuation branch and is pushed as an
empty string); and continuation lines are pushed as `trimmed.to_string()`
rather than `trimmed.trim().to_string()`, which is what preserves
indentation.

- [ ] **Step 4: Run the new tests to verify they pass**

```bash
cargo test --bin prr test_bullet_value_keeps_indented_sublabels
cargo test --bin prr test_blank_line_inside_bullet_value_does_not_truncate
cargo test --bin prr test_next_top_level_bullet_still_flushes_previous_value
cargo test --bin prr test_bullet_value_trailing_blank_lines_stripped
```

Expected: all four PASS.

- [ ] **Step 5: Run the whole suite for regressions**

Run: `cargo test`
Expected: `test result: ok. 109 passed; 0 failed`.

`test_parse_finding_bullets_full` (line 1054) uses `starts_with` and
`contains` on multi-line values, so it survives the switch from `" "` to
`"\n"` joining. If it fails, the rewrite dropped the first line's inline
value — re-check the `caps[2]` push.

- [ ] **Step 6: Commit**

No bump and no rebuild here — Task 3 does both once for the whole
feature.

```bash
git add src/report.rs
git commit -m "Preserve line breaks inside finding bullet values

parse_finding_bullets joined a bullet's lines with a space and ended
the value at the first blank line, so any structure a reviewer wrote
inside 'Why this matters' arrived as one paragraph. Values now keep
their line breaks and indentation, which is what lets findings nest
labelled sub-bullets.

A blank line no longer terminates a value, so trailing prose after the
last bullet is absorbed into it. The format does not permit trailing
prose and the lookahead to catch it is not worth its cost."
```

---

## Task 2: Prompts emit labelled slots

**Files:**
- Modify: `references/prompts/review-prompt.md:72-92` (add rules), `:120-122` and `:129-131` (template bullets)
- Modify: `references/prompts/arbiter-prompt.md:135-137` (add rules), `:148-150` and `:157-159` (template bullets)
- Test: `src/prompt.rs` — `mod tests` starting at line 458

**Interfaces:**
- Consumes: Task 1's newline-preserving parser. Without it the sub-bullets
  this task introduces are flattened back into a paragraph.
- Produces: the label vocabulary that Task 3's renderer and docs describe —
  `Previous behavior`, `On this branch`, `What this adds`,
  `Existing behavior`, `What's wrong`, `What's missing`. Spell them
  exactly; Task 3's docs and the guard test both match on these strings.

- [ ] **Step 1: Write the failing guard test**

Both templates must carry the same label vocabulary, and they drift
easily because they are edited separately. Add to `mod tests` in
`src/prompt.rs`:

```rust
    #[test]
    fn test_templates_share_the_label_vocabulary() {
        const LABELS: [&str; 6] = [
            "Previous behavior",
            "On this branch",
            "What this adds",
            "Existing behavior",
            "What's wrong",
            "What's missing",
        ];
        for label in LABELS {
            assert!(
                REVIEW_TEMPLATE.contains(label),
                "review-prompt.md is missing the `{label}` slot label"
            );
            assert!(
                ARBITER_TEMPLATE.contains(label),
                "arbiter-prompt.md is missing the `{label}` slot label"
            );
        }
    }
```

`REVIEW_TEMPLATE` and `ARBITER_TEMPLATE` are module-level consts at
`src/prompt.rs:5-6`, so `use super::*;` in the test module already brings
them into scope.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --bin prr label_vocabulary -- --nocapture`
Expected: FAIL — `review-prompt.md is missing the `Previous behavior` slot label`.

- [ ] **Step 3: Add the slot rules to `review-prompt.md`**

Insert immediately before `## Output Format` (currently line 93):

```markdown
### `Why this matters` — labelled slots

Write `Why this matters` as a block of labelled sub-bullets, never as a
paragraph. Two slots, both required — slot 1 can carry two labels, so a
block has two or three sub-bullets. Pick each label from the tables
below. Never emit a label whose value is `N/A` or `None` — pick the
label that has real content instead.

**Slot 1 — orientation.** Choose by what the diff did to the code this
finding is about, never by the Anchor. The two are independent: a
`Missing Test` finding about a newly added endpoint takes `What this
adds` even though its Anchor is `none`.

| Situation | Label(s) |
|---|---|
| The diff changed code that already existed | `Previous behavior` **and** `On this branch` |
| The diff added the code | `What this adds` |
| The diff did not touch the code | `Existing behavior` |

**Slot 2 — the problem.**

| Trigger | Label |
|---|---|
| `Missing Test`, `Missing Doc / Error Handling` | `What's missing` |
| Every other trigger | `What's wrong` |

Indent the sub-bullets two spaces under `- **Why this matters:**`.

### Who reads what

`Why this matters` and `Suggested fix` are read by the reviewer, who may
be cold on this codebase and is deciding whether to send the finding to
the author. `Suggested comment` is read by the author, who wrote the diff
and already has that context.

- `Suggested fix` argues the fix: what to change, and why that change
  rather than another one. Where a more exact approach was available and
  rejected, name it and say what it cost.
- The fix line inside `Suggested comment` instructs: what to change. No
  justification, no alternatives weighed.
- If the two could be swapped without loss, both are wrong.

### Writing rules

- One idea per sentence. A sentence held together by `and ... but ...
  so ...` is three sentences.
- Put citations at the end of a sentence, never mid-clause.
- No review-process narration. "Both reviewers confirmed this" says
  nothing about the code, and confidence has its own section.
- No rhetorical questions in `Suggested comment`. State the problem.
- `Suggested comment` must not repeat orientation already given in
  `Why this matters`.
```

- [ ] **Step 4: Replace the `review-prompt.md` template bullets**

Replace lines 120-122 (the `F-01` bullets, currently the three lines
starting `- **Why this matters:** 2-4 sentences.`) with:

```markdown
- **Why this matters:**
  - **Previous behavior:** What the code did before this diff.
  - **On this branch:** What it does now.
  - **What's wrong:** Why the new state is a problem, and for whom.
- **Suggested fix:** What to change, and why that change rather than another.
- **Suggested comment:** The problem, then the fix as an instruction.
```

Replace lines 129-131 (the `F-02` bullets, currently
`- **Why this matters:** ...` / `- **Suggested comment:** ...` /
`- **Suggested fix:** ...`) with:

```markdown
- **Why this matters:**
  - **What this adds:** ...
  - **What's missing:** ...
- **Suggested fix:** ...
- **Suggested comment:** ...
```

The two template findings now demonstrate both slot-1 shapes and both
slot-2 labels, which is what the guard test checks. Note the field order:
`Suggested fix` before `Suggested comment` in both, matching the render
order Task 3 establishes.

- [ ] **Step 5: Apply the same edits to `arbiter-prompt.md`**

Insert the same three subsections (`### Why this matters — labelled
slots`, `### Who reads what`, `### Writing rules`) into the `### Findings`
section, immediately after the scope-rule paragraph at line 137 ("The
scope rule: a finding may appear only if..."). Demote each heading one
level (`####`) to match the arbiter template's deeper nesting.

Then replace lines 148-150 and 157-159 with the same two bullet blocks
from Step 4, verbatim.

- [ ] **Step 6: Run the guard test to verify it passes**

Run: `cargo test --bin prr label_vocabulary -- --nocapture`
Expected: PASS.

- [ ] **Step 7: Run the whole suite**

Run: `cargo test`
Expected: `test result: ok. 110 passed; 0 failed`.

- [ ] **Step 8: Commit**

Still no bump or rebuild; Task 3 verifies the prompt text actually
reaches the binary.

```bash
git add references/prompts/review-prompt.md references/prompts/arbiter-prompt.md \
  src/prompt.rs
git commit -m "Write 'Why this matters' as labelled slots

Reviewers were asked for '2-4 sentences' and delivered one long
sentence with citations wedged mid-clause. Replace the free-form
paragraph with two labelled slots whose labels swap by situation, so
no finding prints an 'N/A' line.

Also splits the two fix registers explicitly: Suggested fix argues the
fix for a reviewer who has to judge it, the fix line in Suggested
comment instructs an author who has already read the problem."
```

---

## Task 3: Renderer prints the structure, docs describe it

**Files:**
- Modify: `skills/prr-start/SKILL.md:483-500` (Step 7b render), `:527-542` (Step 7c render), `:567` (Step 7d drafting), `:609` (Step 8a summary)
- Modify: `references/report-format.md:23-51`
- Modify: `CLAUDE.md:138`, `:155`, and the versioning bump-rules section

**Interfaces:**
- Consumes: Task 1's newline-preserving values and Task 2's label
  vocabulary. The labels named in the docs must match Task 2's exactly.
- Produces: nothing consumed by a later task — this is the last one.

- [ ] **Step 1: Replace the Step 7b rich-text block**

In `skills/prr-start/SKILL.md`, replace the fenced block at lines 485-498
(under `#### Rich text output`, inside Step 7b):

```
## Comment N/M — <Trigger> — <title> (<Severity>)

📄 [path#L<line>](url) (lines start–end)

<code context in a language-specific fenced block; target line marked with # <-->

**Why this matters**

<why_it_matters, printed verbatim>

**Suggested fix:** <suggested_fix>

**Suggested comment:**

> <suggested_comment, one `>` per line, blank lines quoted as bare `>`>
```

Then add this paragraph immediately after the block, before the sentence
beginning "`N/M` counts only diff-anchored findings":

```markdown
`why_it_matters` arrives carrying its own labelled sub-bullets. Print it
verbatim — do not re-wrap it, re-indent it, collapse it onto one line, or
prefix it with `**Why this matters:**` inline. `suggested_comment` may
span several paragraphs; quote every line, including the blank ones.
```

- [ ] **Step 2: Replace the Step 7c rich-text block**

Replace the fenced block at lines 529-542 (under Step 7c's
`#### Rich text output`):

```
## Report-Only Finding N/M — <Trigger> — <title> (<Severity>)

(Report-only — won't be posted as an inline comment; will be summarized in the review body.)

📄 <path:line if anchor == reference; else "(no anchor line)">

**Why this matters**

<why_it_matters, printed verbatim>

**Suggested fix:** <suggested_fix>

**Suggested comment:**

> <suggested_comment, one `>` per line, blank lines quoted as bare `>`>
```

The verbatim-printing rule from Step 1 applies here too; the existing
sentence about rendering code context for `anchor: reference` stays as
it is.

- [ ] **Step 3: Update Step 7d drafting and Step 8a summary**

Replace line 567:

```markdown
5. Draft `Why this matters` — using the slot labels in `references/report-format.md` — then `Suggested fix` and `Suggested comment` with the user; confirm.
```

Replace line 609 (inside the Step 8a body template):

```markdown
   - `path:line` — <Trigger> — <first line of suggested_comment or overridden_body>
```

`suggested_comment` can now be multi-line, so the review-body summary
takes its first line rather than the whole value. Line 610 — the
`Other findings (Q)` bullet — reads `<one-line summary>`; change it to
`<first line of suggested_comment or overridden_body>` too.

- [ ] **Step 4: Rewrite the Findings section of `references/report-format.md`**

Replace lines 23-51 (from `Each finding carries:` through the closing
fence of the example) with:

```markdown
Each finding carries:

- **Trigger** — one of: `Acceptance Criteria`, `Code Change`, `Code Quality`, `Logic Bug`, `Security`, `Performance`, `Missing Test`, `Missing Doc / Error Handling`.
- **Severity** — HIGH | MED | LOW.
- **Anchor** — `diff` (postable as inline comment), `reference` (anchored on unchanged code, report-only), or `none` (cross-cutting, no anchor).
- **Location** — `path:line` or `path:start-end`. Required when Anchor is `diff` or `reference`; omitted when `none`.
- **Why this matters** — labelled sub-bullets, two slots (see below).
- **Suggested fix** — what to change and why that change rather than another. Read by the reviewer.
- **Suggested comment** — the problem, then the fix as an instruction. Posted to the PR as-is. Read by the author.

`Why this matters` slot 1 — orientation. Chosen by what the diff did to
the code the finding is about, not by the Anchor:

| Situation | Label(s) |
|---|---|
| The diff changed code that already existed | `Previous behavior` and `On this branch` |
| The diff added the code | `What this adds` |
| The diff did not touch the code | `Existing behavior` |

`Why this matters` slot 2 — the problem:

| Trigger | Label |
|---|---|
| `Missing Test`, `Missing Doc / Error Handling` | `What's missing` |
| Every other trigger | `What's wrong` |

Findings are grouped by Trigger. Per-agent reviews use `## Findings` / `### Trigger: X` / `#### F-NN — <title>`. The arbiter's Final Report uses one level deeper: `### Findings` / `#### Trigger: X` / `##### F-NN — <title>`.

Example finding (per-agent):

```
## Findings

### Trigger: Code Change

#### F-01 — Parser runs before the feature flag is checked

- **Severity:** MED
- **Anchor:** diff
- **Location:** `lib/resources/asset.rb:97`
- **Why this matters:**
  - **What this adds:** `RightsClaimParser#call` runs unconditionally in
    `Asset#sync`, before the feature flag is checked.
  - **What's wrong:** It raises `ClientResponsibilityError` on assets with
    no org, so flag-off tenants fail a sync that used to succeed.
- **Suggested fix:** Guard the call with `cp_supports_rights_claim_feature?`.
  Checking the org inside the parser would also work, but it spreads the
  flag's meaning across two files.
- **Suggested comment:** This runs before the flag check, so flag-off
  tenants with orgless assets now fail a sync that used to succeed.

  Fix: guard the call with `cp_supports_rights_claim_feature?`.
```
```

- [ ] **Step 5: Update `CLAUDE.md`**

Replace line 138:

```markdown
PRR reviews produce structured findings classified by `Trigger`. Every finding carries six fields (Severity, Anchor, Location, Why this matters, Suggested fix, Suggested comment) and is grouped under one of 8 Triggers:
```

Replace line 155:

```markdown
**Required bullets per finding:** `Severity`, `Anchor`, `Why this matters`, `Suggested fix`, `Suggested comment`. `Location` is required when `Anchor` is `diff` or `reference`; omitted when `none`. `Why this matters` is labelled sub-bullets, not prose — see `references/report-format.md` for the two slots and their situation-dependent labels.
```

In the **Versioning** section, replace the first bump rule so the
compiled-in prompts are covered:

```markdown
- **Binary-affecting changes** (files under `src/`, `references/prompts/` — these are `include_str!`'d into the binary — `Cargo.toml`/`Cargo.lock` deps) → bump **minor**, reset patch (e.g., `0.3.4` → `0.4.0`)
```

- [ ] **Step 6: Run the whole suite**

Run: `cargo test`
Expected: `test result: ok. 110 passed; 0 failed`.

- [ ] **Step 7: Bump version to 0.7.0 and rebuild**

One bump for the whole feature.

```bash
sed -i '' 's/^version = "0.6.0"/version = "0.7.0"/' Cargo.toml
sed -i '' 's/"version": "0.6.0"/"version": "0.7.0"/' .claude-plugin/plugin.json
sed -i '' 's/"version": "0.6.0"/"version": "0.7.0"/' .claude-plugin/marketplace.json
./scripts/build-universal.sh
```

Expected: `Built: bin/prr-darwin-universal`, then a `file` line reporting
a Mach-O universal binary with 2 architectures.

- [ ] **Step 8: Verify the binary carries the version and the new prompts**

The binary has no `--version` flag. The version reaches it through
`env!("CARGO_PKG_VERSION")` at `src/context.rs:83`, which writes it into
the context manifest, so it is present as a literal string. The prompts
are `include_str!`'d, so their text is present too.

```bash
strings bin/prr-darwin-universal | grep -c '0\.7\.0'
strings bin/prr-darwin-universal | grep -c "What this adds"
```

Expected: both counts are `1` or more. A version count of `0` means the
rebuild missed the bump. A `What this adds` count of `0` means it missed
Task 2's prompt edits — re-run `./scripts/build-universal.sh`.

- [ ] **Step 9: Verify end-to-end with a fixture report**

Parse a report written in the new shape with the binary you just built:

```bash
SCRATCH=/private/tmp/claude-502/-Users-cris-fuga-git-prr/9979667f-773a-4b9f-a5f9-7a975069c2cd/scratchpad
mkdir -p "$SCRATCH"
cat > "$SCRATCH/final-report.md" <<'EOF'
## Final Report

### Verdict

REQUEST_CHANGES

### Confidence

HIGH

### Findings

#### Trigger: Logic Bug

##### F-01 — Shared file name blocks the heal permanently

- **Severity:** MED
- **Anchor:** diff
- **Location:** `lib/itunes_upload_helper.rb:88`
- **Why this matters:**
  - **What this adds:** `strip!` removes `remove="true"` nodes so a
    cancelled product can self-heal.
  - **What's wrong:** Two tracks sharing a file name collapse to one name
    but two nodes, so the guard refuses permanently.
- **Suggested fix:** Compare distinct location counts against node counts.
- **Suggested comment:** `location` is parsed but never used here.

  Fix: pass the full params into `strip!`.
EOF
./bin/prr-darwin-universal parse-report "$SCRATCH/final-report.md" \
  | python3 -c 'import json,sys; f=json.load(sys.stdin)["findings"][0]; \
print("why lines:", len(f["why_it_matters"].splitlines())); \
print("has sublabel:", "- **What this adds:**" in f["why_it_matters"]); \
print("comment lines:", len(f["suggested_comment"].splitlines()))'
```

Expected:

```
why lines: 4
has sublabel: True
comment lines: 3
```

`why lines: 1` means Task 1's parser change is not in the binary you ran
— rebuild. `has sublabel: False` means the sub-bullet was consumed as a
top-level bullet; check that it is indented two spaces.

- [ ] **Step 10: Commit**

```bash
git add skills/prr-start/SKILL.md references/report-format.md CLAUDE.md \
  Cargo.toml Cargo.lock \
  .claude-plugin/plugin.json .claude-plugin/marketplace.json \
  bin/prr-darwin-universal
git commit -m "Print finding structure instead of flattening it

Phase 7 wrapped why_it_matters in an inline '**Why this matters:**
<value>' line, which put the labelled sub-bullets back on one line
after the parser had gone to the trouble of keeping them apart. It now
prints the captured value verbatim and quotes multi-paragraph suggested
comments line by line.

Also records that references/prompts is compiled into the binary, so
editing it takes a minor bump rather than a patch."
```

- [ ] **Step 11: Commit the spec and plan**

```bash
git add docs/superpowers/specs/2026-09-03-readable-findings-design.md \
  docs/superpowers/plans/2026-09-03-readable-findings.md
git commit -m "Add readable-findings design and implementation plan"
```

Docs-only, and the repo has committed `docs/` without a bump before
(`d05373d`, `294a14c`).
