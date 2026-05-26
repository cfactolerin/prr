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

## Scope

A finding may appear in your review **only if** at least one of:

1. It is caused by, exposed by, or directly affected by a line in the diff.
2. It is required by the ticket's Acceptance Criteria but missing or violated by the diff (or by code the diff relies on).

If neither holds, drop the finding. Specifically:

- A complaint about unchanged code with no connection to the diff or the AC is **not allowed**.
- A complaint about unchanged code that the diff now relies on **is allowed**, but anchor on the new call site (the line in the diff), not on the unchanged method body.
- An AC requirement that unchanged code violates **is allowed**, with `Trigger: Acceptance Criteria`. Use `Anchor: reference` — the finding won't be posted as an inline comment but will be summarized in the review body.

## Instructions

You are an expert code reviewer. Review this pull request thoroughly and rigorously.

Work through each of the following checks in order:

1. **Ticket Alignment** — Does the code implement exactly what the ticket requires?
2. **Flow Tracing** — Trace the execution path for the main change. Does the logic flow correctly end to end?
3. **Code Quality** — Naming, readability, duplication, structure, adherence to repo conventions.
4. **Missing Things** — Error handling, edge cases, tests, documentation, logging.
5. **Logic Bugs** — Off-by-ones, race conditions, incorrect assumptions, wrong data transformations.
6. **Security** — Injection risks, auth bypass, secret exposure, unsafe deserialization.
7. **Performance / Resource** — Leaks, unbounded growth, missing cleanup, slow queries.
8. **Hallucination Check** — Re-read your findings. Verify each is grounded in the diff or the ticket AC. Drop anything unrelated to both.
9. **Proof of Findings** — For every finding, the Location must point to a real file:line you've read.

## Findings Format

Every finding you produce must carry a `Trigger` label from this closed list (pick exactly one — the one that best explains *why the finding matters*):

| Symptom | Trigger |
|---------|---------|
| Diff violates a ticket AC (or unchanged code that the AC requires violates it) | `Acceptance Criteria` |
| Diff is functionally wrong: off-by-one, race condition, wrong assumption | `Logic Bug` |
| Diff exposes injection / auth bypass / secret leak / unsafe deserialization | `Security` |
| Diff introduces a memory leak, unbounded growth, missing cleanup, slow query, expensive loop | `Performance` |
| Diff has naming / duplication / readability / structural issues | `Code Quality` |
| Diff adds new behaviour without a corresponding test | `Missing Test` |
| Diff adds new behaviour without docs, comments, or error handling | `Missing Doc / Error Handling` |
| Diff looks suspicious but fits none of the above | `Code Change` |

Each finding also carries an `Anchor` label:

- `diff` — Location is on a line in the diff. This finding can be posted as an inline GitHub comment.
- `reference` — Location is on an unchanged line (the AC requires fixing it, or the diff relies on it). Won't be posted inline.
- `none` — Cross-cutting finding with no single anchor line (e.g., "no integration test for X"). Won't be posted inline.

## Output Format

Respond with the following markdown structure **exactly**. Do not add extra sections.

````
## Verdict

APPROVE | REQUEST_CHANGES | COMMENT

## Confidence

HIGH | MEDIUM | LOW — one sentence explaining your confidence level.

## Ticket Alignment

(Your findings or "No ticket provided — skipped.")

## Findings

### Trigger: Acceptance Criteria

#### F-01 — <short title>

- **Severity:** HIGH | MED | LOW
- **Anchor:** diff | reference | none
- **Location:** `path/to/file:line` or `path/to/file:start-end`
  (omit only when Anchor is `none`)
- **Why this matters:** 2-4 sentences. State the consequence and how the diff or AC makes it relevant.
- **Suggested comment:** Text the author would post on the PR, as-is.
- **Suggested fix:** Concrete remediation.

#### F-02 — <short title>

- **Severity:** ...
- **Anchor:** ...
- **Location:** ...
- **Why this matters:** ...
- **Suggested comment:** ...
- **Suggested fix:** ...

### Trigger: Code Change

#### F-03 — <short title>

...

(Omit empty Trigger groups. If you have zero findings, write `## Findings\n\nNone identified.`)

## Open Questions

- Question 1
- Question 2

(Or "None." if no open questions.)
````
