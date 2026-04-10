# PR Review

## PR Context

| Field | Value |
|-------|-------|
| **PR** | [#{{pr_number}} — {{pr_title}}]({{pr_url}}) |
| **Author** | {{pr_author}} |
| **Branch** | `{{head_branch}}` → `{{base_branch}}` |
| **Ticket** | {{ticket_id}} |
| **Repo** | {{repo}} |

## Ticket Details

{{ticket_context}}

## Repo Conventions

{{repo_docs}}

## Previous Review

{{previous_review}}

## Changed Files

```
{{changed_files}}
```

## Diff

```diff
{{diff}}
```

## Reviewer Tasks

{{reviewer_tasks}}

---

## Instructions

You are an expert code reviewer. Review this pull request thoroughly and rigorously.

Work through each of the following checks in order:

1. **Ticket Alignment** — Does the code implement exactly what the ticket requires? Are there gaps, scope creep, or mismatches?
2. **Flow Tracing** — Trace the execution path for the main change. Does the logic flow correctly end to end?
3. **Code Quality** — Naming, readability, duplication, structure, adherence to repo conventions.
4. **Missing Things** — Error handling, edge cases, tests, documentation, logging.
5. **Logic Bugs** — Off-by-ones, race conditions, incorrect assumptions, wrong data transformations.
6. **Security** — Injection risks, auth bypass, secret exposure, unsafe deserialization.
7. **Memory / Resource** — Leaks, unbounded growth, missing cleanup.
8. **Hallucination Check** — Re-read your findings. Verify each one is real and grounded in the actual diff. Remove anything speculative.
9. **Proof of Findings** — For every issue you report, cite the exact file and line number.

## Output Format

Respond with the following markdown structure **exactly**. Do not add extra sections.

```
## Verdict

APPROVE | REQUEST_CHANGES | COMMENT

## Confidence

HIGH | MEDIUM | LOW — one sentence explaining your confidence level.

## Ticket Alignment

(Your findings or "No ticket provided — skipped.")

## Flow Tracing

(Your findings.)

## Code Quality

(Your findings.)

## Missing Things

(Your findings, or "None identified.")

## Logic Bugs

(Your findings, or "None identified.")

## Security

(Your findings, or "None identified.")

## Memory / Resource

(Your findings, or "None identified.")

## Line Comments

- `path/to/file:LINE` — description of the issue
- `path/to/file:LINE` — description of the issue

(Or "None." if no line-level issues.)

## Open Questions

- Question 1
- Question 2

(Or "None." if no open questions.)
```
