# Readable Findings

Status: approved, not yet implemented
Amends: `docs/superpowers/specs/2026-05-21-trigger-based-findings-design.md`

## Problem

Findings are unreadable in a terminal. A representative `Why this
matters` from a real review:

> ambiguous_names bails out entirely when one reported file name
> matches more than one remove="true" node, and the PR's own spec
> documents this as reachable via DELIVER_ORIGINAL_FILENAMES
> (itunes_upload_helper_spec.rb:621-637). But Apple reports one 4086
> per track with a distinct location, and the parser already captures
> it — itms_4xxx_parser.rb:72-75 has params_keys: %i[file_name
> location], and cancellations survive as separate array entries
> (validation_messages_parser.rb:47-67). So for a product where two
> tracks share an Atmos file name, file_names collapses two
> cancellations to one name, removable_nodes finds two nodes, and the
> heal refuses forever...

Three separate causes:

1. **The parser flattens structure.** `parse_finding_bullets`
   (`src/report.rs:413-447`) joins a bullet's lines with a space, so
   every line break becomes a space. A blank line inside a value
   flushes the key, silently dropping the rest. Whatever shape an
   agent writes, the reader gets one paragraph.

2. **The prompts ask for a paragraph.** `Why this matters` is
   specified as "2-4 sentences" with no rule against chaining them
   into one, and no rule about where citations go.

3. **The three fields overlap.** `Why this matters` and `Suggested
   comment` restate each other, and `Suggested fix` restates the tail
   of both. The same finding is read three times.

Underneath (3) is an audience confusion. `Why this matters` is read by
the reviewer, who may be cold on the codebase and needs orientation
before the point lands. `Suggested comment` is read by the author, who
wrote the diff and needs none of that. Written as one voice, both are
wrong: too thin for the reviewer, too padded for the author.

## Design

### `Why this matters` — labelled slots

`Why this matters` becomes a small labelled block instead of a
paragraph. Labels swap by situation so every label describes real
content — no `N/A` filler.

**Slot 1 — orientation.** Always present.

| Situation | Label(s) |
|---|---|
| The diff changed code that already existed | `Previous behavior` + `On this branch` |
| The diff added the code | `What this adds` |
| The diff did not touch the code | `Existing behavior` |

**Slot 2 — the problem.** Always present.

| Trigger | Label |
|---|---|
| `Missing Test`, `Missing Doc / Error Handling` | `What's missing` |
| All other triggers | `What's wrong` |

Slot 1 is chosen by what the diff did to the code the finding is about
— never by the Anchor. The two are independent: a `Missing Test`
finding about a newly added endpoint takes `What this adds` even though
its Anchor is `none`, because the code it is about is new. `Existing
behavior` is for code the diff left alone, which is the usual case for
Anchor `reference` but is not implied by it.

### `Suggested fix` and `Suggested comment`

`Suggested fix` stays a top-level bullet, reviewer-facing. It argues
the fix: what to change, and why that change rather than another one.
Where a more exact approach was available and rejected, name it and
say what it cost. The reviewer is deciding whether to put this in
front of the author, and cannot make that call from a bare
instruction.

`Suggested comment` is author-facing and self-contained. It states the
problem, then the fix as an instruction — what to change, with no
justification and no alternatives weighed. By the time the author
reaches the fix they have read the problem and accepted the premise;
the reasoning is the reviewer's work, already done. It does not recap
the ticket, re-explain the diff, or repeat the orientation from `Why
this matters`.

The fix therefore appears twice, and the two are not interchangeable.
Reviewer: why this is the fix. Author: what the fix is. If one could
be pasted into the other's place without loss, both are wrong.

### Worked examples

Changed existing behavior:

```
- **Severity:** MED
- **Anchor:** diff
- **Location:** `lib/itunes_upload_helper.rb:88`
- **Why this matters:**
  - **Previous behavior:** `ambiguous_names` refused to heal whenever
    one reported file name matched two or more `remove="true"` nodes.
  - **On this branch:** Unchanged. `strip!` still receives names only.
  - **What's wrong:** Apple sends one 4086 per track, each with its own
    `location`. Two tracks sharing an Atmos file name collapse to one
    name but two nodes, so the heal refuses permanently. The PR's spec
    documents this path as reachable (itunes_upload_helper_spec.rb:621-637).
- **Suggested fix:** Pass name and location into `strip!` rather than
  names alone. Resolving each node by its reported location would be
  exact, but it ties the heal to Apple's location format and breaks
  when that format shifts. Comparing counts needs no format knowledge:
  when the distinct location count equals the matching node count the
  names are unambiguous in practice, so strip. Keep the refusal for the
  case where the counts disagree — that is the ambiguity the guard
  exists for.
- **Suggested comment:** `location` is parsed into the cancellation
  params but never used here. Two tracks sharing an Atmos filename give
  two cancellations with distinct locations, `file_names` collapses them
  to one name, and `ambiguous_names` then refuses — so that product can
  never self-heal.

  Fix: pass the full params into `strip!` and treat a name as
  unambiguous when the distinct location count matches the node count.
```

New code:

```
- **Why this matters:**
  - **What this adds:** `RightsClaimParser#call` runs unconditionally in
    `Asset#sync`, before the feature flag is checked.
  - **What's wrong:** It raises `ClientResponsibilityError` on assets
    with no org, so flag-off tenants fail a sync that used to succeed.
```

Missing test:

```
- **Why this matters:**
  - **What this adds:** A `retry_on_conflict` branch in `Deliverable#push`.
  - **What's missing:** No spec covers the conflict path, so a regression
    in the retry ceiling would ship silently.
```

## Parser change

`parse_finding_bullets` (`src/report.rs:413-447`) currently:

- joins captured lines with `" "`;
- calls `.trim()` on each continuation line, destroying indentation;
- flushes the current key on any blank line.

New semantics:

- join captured lines with `"\n"`;
- preserve each continuation line's leading whitespace, trimming only
  trailing whitespace;
- a blank line does not flush — it becomes a blank line in the value;
- flush on the next top-level `- **Key:**` bullet, or at end of block;
- trim leading and trailing blank lines on flush.

No heading flush. An earlier draft also flushed on a line starting with
`#`, to stop a stray markdown heading from being swallowed into a bullet
value. It cannot be made safe: `# Use exponential backoff` is both a
shell comment and a well-formed h1, so any pattern that catches real
headings also truncates the code snippets that `Suggested fix` routinely
carries — silently, with no warning. The caller already delimits each
block at the surrounding trigger and finding headings, so the guard
bought nothing it was not already getting.

Known behavior change: because a blank line no longer flushes, any
non-bullet prose sitting after the last bullet in a finding block is
absorbed into that bullet's value instead of being discarded. Findings
are not supposed to carry trailing prose, and the alternative — a
lookahead for "is the next non-blank line a bullet?" — buys little for
the complexity.

The sub-labels are indented bullets. The top-level bullet regex is
anchored at `^-`, so indented lines never match it and are captured as
continuation text. `why_it_matters` therefore carries the labelled
markdown verbatim, and the renderer prints it unchanged. The parser
needs no knowledge of the label vocabulary.

**No JSON schema change.** `why_it_matters`, `suggested_comment` and
`suggested_fix` keep their names and types. What changes is that their
values may now contain newlines.

### Downstream consequences

- `derive_line_comments` (`src/report.rs:146-161`) posts
  `suggested_comment` as the GitHub comment body. Multi-paragraph
  bodies render correctly on GitHub; no change needed.
- Phase 8 of `skills/prr-start/SKILL.md` builds a one-line summary from
  `suggested_comment`. It must take the first line, not the whole
  value.
- The Phase 7 render blocks print `why_it_matters` verbatim rather than
  as a single `**Why this matters:** <value>` line.

## Writing rules

Added to both agent prompts as prohibitions, not preferences:

- One idea per sentence. A sentence held together by `and ... but ...
  so ...` is three sentences.
- Citations go at the end of a sentence, never mid-clause.
- No review-process meta-narration. "Both reviewers independently
  confirmed the reachability" says nothing about the code, and
  confidence has its own section.
- No rhetorical questions in `Suggested comment`. State the problem.
- `Suggested comment` must not repeat orientation already given in
  `Why this matters`.
- `Suggested fix` argues the fix; the fix line in `Suggested comment`
  instructs. If the two could be swapped without loss, both are wrong.

## Scope

Changed: `src/report.rs`, `references/prompts/review-prompt.md`,
`references/prompts/arbiter-prompt.md`, `references/report-format.md`,
`skills/prr-start/SKILL.md`, `CLAUDE.md`. The version-bump wording in
`CLAUDE.md` changes too, per the note below.

Unchanged: the trigger list, severity values, anchor semantics, the
scope rule, and the JSON contract. Reports already on disk are not
regenerated — the old flattened shape still parses, since the parser
change only affects how line breaks are preserved.

`references/prompts/*.md` are `include_str!`'d into the binary
(`src/prompt.rs:5-7`), so editing them is a binary-affecting change even
though they sit outside `src/`. `CLAUDE.md`'s bump rule does not
currently say so; this change corrects that wording.

Version: the feature is one minor bump, 0.6.0 to 0.7.0, across
`Cargo.toml`, `.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json`, with the binary rebuilt. If the work
lands as more than one commit, `CLAUDE.md` requires a bump and a rebuild
per commit; the implementation plan takes that literally and ends at
0.8.1. Landing it as a single commit at 0.7.0 is tidier in `git log`.

## Testing

Parser unit tests in `src/report.rs`:

- a `Why this matters` value with indented sub-label bullets round-trips
  with newlines and indentation intact;
- a blank line inside a bullet value no longer truncates it;
- a value's trailing blank lines are stripped;
- the next top-level bullet still flushes the previous key;
- existing multi-line continuation tests still pass under `\n` joining.
