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

If there are zero findings, write `## Findings\n\nNone identified.`

## Scope

A finding may appear only if it is caused/exposed by the diff or required by the ticket Acceptance Criteria. Findings about unchanged code unrelated to both are out of scope.

## Open Questions

- Question 1
- Question 2

(Or "None." if no open questions.)
