# PRR Review Output Format

All review agents must produce their output in this exact markdown format.

## Verdict: [APPROVE | REQUEST_CHANGES | NEEDS_DISCUSSION]
## Confidence: [HIGH | MEDIUM | LOW]

<1-3 sentence summary>

## Ticket Alignment

| # | Criteria | Achieved | Evidence |
|---|----------|----------|---------|
| 0 | **Goal:** <goal> | Yes/No | `path/to/file:LINE` |
| 1 | <criterion> | Yes/No | evidence |

## Flow Analysis
<findings or "No issues found.">

## Code Quality
<findings or "No issues found.">

## Missing Things
<findings or "No issues found.">

## Logic Issues
<findings or "No issues found.">

## Security
<findings or "No issues found.">

## Memory
<findings or "No issues found.">

## Hallucination Check
<findings or "No issues found.">

## Proof of Findings
<list of test files or debug output, or "No proofs created.">

## Line Comments
- `path/to/file:LINE` — description

## Open Questions
<things needing human judgment>
