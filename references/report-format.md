# PRR Review Output Format

All review agents produce their output in this format. The arbiter consolidates these into a Final Report with the same Findings shape (heading levels shifted to nest under `## Final Report`).

## Verdict

APPROVE | REQUEST_CHANGES | COMMENT

## Confidence

HIGH | MEDIUM | LOW

## Ticket Alignment

| # | Criterion | Met | Evidence |
|---|-----------|-----|----------|
| 1 | <criterion> | Yes / No / Partial | `path:line` |

## Findings

Each finding carries:

- **Trigger** — one of: `Acceptance Criteria`, `Code Change`, `Code Quality`, `Logic Bug`, `Security`, `Performance`, `Missing Test`, `Missing Doc / Error Handling`.
- **Severity** — HIGH | MED | LOW.
- **Anchor** — `diff` (postable as inline comment), `reference` (anchored on unchanged code, report-only), or `none` (cross-cutting, no anchor).
- **Location** — `path:line` or `path:start-end`. Required when Anchor is `diff` or `reference`; omitted when `none`.
- **Why this matters** — 2-4 sentences.
- **Suggested comment** — text to post on the PR, as-is.
- **Suggested fix** — concrete remediation.

Findings are grouped by Trigger. Per-agent reviews use `## Findings` / `### Trigger: X` / `#### F-NN — <title>`. The arbiter's Final Report uses one level deeper: `### Findings` / `#### Trigger: X` / `##### F-NN — <title>`.

Example finding (per-agent):

```
## Findings

### Trigger: Code Change

#### F-01 — Parser invocation may raise when feature disabled

- **Severity:** MED
- **Anchor:** diff
- **Location:** `lib/resources/asset.rb:97`
- **Why this matters:** The parser now runs unconditionally, raising
  ClientResponsibilityError on missing orgs even when the feature
  flag is off.
- **Suggested comment:** Gate this call behind cp_supports_rights_claim_feature?
- **Suggested fix:** Wrap the parser invocation in an if guard.
```

If there are zero findings, write `## Findings\n\nNone identified.`

## Scope

A finding may appear only if it is caused/exposed by the diff or required by the ticket Acceptance Criteria. Findings about unchanged code unrelated to both are out of scope.

## Open Questions

- Question 1
- Question 2

(Or "None." if no open questions.)
