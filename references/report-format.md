# PRR Review Output Format

All review agents produce their output in this format. The arbiter consolidates these into a Final Report with the same Findings shape (heading levels shifted to nest under `## Final Report`).

## Verdict

APPROVE | REQUEST_CHANGES | COMMENT

## Confidence

HIGH | MEDIUM | LOW

Base confidence on assessment coverage, understanding of intent, ticket alignment, applicable
language and repository standards, and unresolved material questions. Trust relevant passing CI
in the saved context; not rerunning tests locally is not a confidence penalty. Distinguish observed
checks from author-reported claims. Do not penalize hypothetical future contract changes or unavailable
out-of-scope cross-service tests. Agreement is not proof.

## Change Summary

Purpose and changed behavior in plain language. Resolve review questions in the assessment or findings.

## Overall Assessment

Candid implementation assessment, including justified strengths, weaknesses, and remaining risks.

## Code Quality

Assess human readability and scoped modernization in new and changed code. Existing patterns are
evidence, not an obligation to repeat poor practices. Recommendations must work with the configured
runtime and dependencies and explain a concrete comprehension cost, alternative, and tradeoff.
Leave unrelated legacy code alone. Optional LOW suggestions do not block approval. Include supported
issues in Findings and reference their IDs here; do not manufacture suggestions when none are justified.

## Backwards Compatibility

Classify meaningful changes as Intended, Unintended, or Unclear, with base/head evidence, affected
consumers, migration needs, and unverified boundaries. Intentional changes are not automatically safe;
refactoring does not authorize silent contract changes. Reference supported findings by ID.

The arbiter nests these assessment headings under `## Final Report` at level 3, like Verdict and
Confidence. `parse-report` exposes them as optional `change_summary`, `overall_assessment`,
`code_quality`, and `backwards_compatibility` strings, with `confidence_reasoning` separate from
the confidence label. Older reports omit absent assessments. With `--diff`, `change_stats` counts
changed/added/deleted/renamed files, binary files, and added/deleted text lines from the saved diff;
binary content has no text line count. These counts do not imply execution or test coverage.

## Behavioral Examples And Rendering

Behavioral findings include a short concrete example scenario within the existing `What's wrong`
or `What's missing` problem slot: triggering input/state, code path, and actual versus expected
result. Examples must follow reachable conditions supported by available evidence. Illustrative
values are not observed incidents or executed tests; unverified prerequisites stay explicit.
Purely stylistic findings do not need a forced scenario. Finding fields remain Markdown for chat
and GitHub; the visual sidebar renders that Markdown rather than displaying its formatting markers.

## Review Statistics Metadata

Final arbiter reports also end with `### Review Statistics` and a JSON block used only for local
measurement. The block has `version: 1`, `agreement: {status, round, reason}`, and `assessments`, each
with `reviewer`, original `finding_id`, `outcome`, `final_finding_ids`, and an evidence-based `reason`.

Agreement status is `reached`, `not_reached`, or `unassessed`; a reached round is 0 for initial reviews
or a saved Q&A round, otherwise null. Candidate outcomes are `validated`, `invalid`, `out_of_scope`,
`duplicate`, or `unresolved`. Every original reviewer candidate must be covered exactly once.

Validated candidates map to existing final IDs; refuted and out-of-scope candidates map to none.
Duplicates include `duplicate_of`, a non-duplicate original ID in the same review, and repeat its
final-ID mapping. An arbiter override is not reviewer agreement, and missing evidence is unresolved, not false.
This metadata is not a finding, is not part of the posted body, and is not inferred for older reports.

## Ticket Alignment

| # | Criterion | Met | Evidence |
|---|-----------|-----|----------|
| 1 | <criterion> | Yes / No / Partial | `path:line` |

## Findings

Each finding carries:

- **Trigger** — one of: `Acceptance Criteria`, `Code Change`, `Code Quality`, `Logic Bug`, `Security`, `Performance`, `Missing Test`, `Missing Doc / Error Handling`.
- **Severity** — HIGH | MED | LOW.
- **Anchor** — `diff` (postable as inline comment), `reference` (anchored on unchanged code, report-only), or `none` (cross-cutting, no anchor).
- **Origin** — `introduced` (the diff wrote the faulty logic) or `pre-existing` (the fault is in unchanged code the base branch already had). Pre-existing findings never justify `REQUEST_CHANGES` on their own; the reviewer decides whether to raise them or leave them for a follow-up.
- **Location** — `path:line` or `path:start-end`. Required when Anchor is `diff` or `reference`; omitted when `none`.
- **Why this matters** — labelled sub-bullets, two slots (see below).
- **Suggested fix** — what to change and why that change rather than another. Read by the reviewer.
- **Suggested comment** — the problem, then the fix as an instruction. Posted to the PR as-is. Read by the author.

Use exactly one primary location per finding. Put other file/line citations in `Why this matters`
or `Suggested fix`, not in `Location`. A `diff` location must include an added line; a range may
include unchanged context only within the same diff hunk. Prefer the smallest useful range.
For older reports with semicolon-separated locations, the first remains the navigation and inline
comment anchor; the remaining citations are preserved in the location text.

The last three are prose in short paragraphs: 1-3 sentences and 50-100 words each, broken with a blank line when a value needs more. Bullets inside them are for genuinely parallel items only — an argument stays sentences. The agent prompts carry the full writing rules.

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
- **Origin:** introduced
- **Location:** `lib/resources/asset.rb:97`
- **Why this matters:**
  - **What this adds:** `RightsClaimParser#call` runs unconditionally in
    `Asset#sync`, before the feature flag is checked.
  - **What's wrong:** It raises `ClientResponsibilityError` on assets with
    no org, so flag-off tenants fail a sync that used to succeed.

    Orgless assets are reachable on every tier, not only during onboarding
    (`app/models/asset.rb:214`). No spec covers the combination, so the
    failure ships silently.
- **Suggested fix:** Guard the call with `cp_supports_rights_claim_feature?`.

  Checking the org inside the parser would also work, but it spreads the
  flag's meaning across two files.
- **Suggested comment:** This runs before the flag check, so flag-off
  tenants with orgless assets now fail a sync that used to succeed.

  Fix: guard the call with `cp_supports_rights_claim_feature?`.
```

If there are zero findings, write `## Findings\n\nNone identified.`

## Scope

A finding may appear only if it is caused/exposed by the diff or required by the ticket Acceptance Criteria. Findings about unchanged code unrelated to both are out of scope.

## Open Questions

- Question 1
- Question 2

(Or "None." if no open questions.)
