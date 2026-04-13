# Edit Review Body Before Posting — Design

## Problem

In the current `/prr:start` flow, **Phase 8b (Present review for confirmation)** asks the user to choose a GitHub action (Approve / Comment / Request Changes / Skip). The review body is shown above the prompt, and the user can replace it by typing free text instead of picking an option.

This is undiscoverable. Users who want to lightly edit the auto-generated summary (e.g., to remove a verdict paragraph they disagree with) don't realize they can. The free-text path also conflates two decisions — "what action" and "what body text" — into a single ambiguous response.

## Goal

Make body editing an explicit, discoverable step that runs **after** the user picks an action, without changing how the action choice itself works.

## Non-Goals

- No changes to Phase 7 (line comment review) — that flow already has explicit per-comment Accept/Reject/Edit.
- No changes to the Rust binary. Body generation in Phase 8a remains unchanged.
- No `$EDITOR` integration, no temp-file edit dance. Editing happens inline in the chat prompt.
- No version bump or binary rebuild — the change is purely in the skill markdown.

## Design

Replace the current single-prompt Phase 8b with a **two-step interaction**:

### Step 1 — Pick action

Show the rich text output (review body + suggested action) exactly as today, then ask:

```
Post review?
```

Options (unchanged from today, except the free-text body fallback is removed):
- **Approve** (Recommended if verdict is APPROVE) — Post as APPROVE
- **Comment only** — Post as COMMENT (no approval)
- **Request Changes** — Post as REQUEST_CHANGES
- **Skip** — Don't post anything to GitHub

If the user picks **Skip**, exit immediately — no body edit step.

### Step 2 — Confirm or edit body

After any non-Skip choice, ask:

```
Use this body, or edit it first?
```

Options:
- **Post as-is** — Use the generated body unchanged
- **Edit body** — Provide replacement body text inline

No free-text fallback in either step. The explicit **Edit body** option is the only path to editing; this is the whole point of the redesign.

If the user picks **Edit body**, prompt:

```
Paste or type the new review body. The original is shown above for reference.
```

Then take the user's next message verbatim as the new `REVIEW_BODY`. Show the new body once for confirmation:

```
## Updated Review Body

> <new body>

**Action:** <chosen action>

Posting now...
```

Then proceed to Step 8c (PR metadata fetch) and post.

## Interaction Examples

**Example 1 — Approve as-is (most common):**
1. Rich text shows body + "Suggested action: APPROVE"
2. User picks **Approve**
3. Prompt: "Use this body, or edit it first?"
4. User picks **Post as-is**
5. Posted.

**Example 2 — Request changes with edit:**
1. Rich text shows body + "Suggested action: REQUEST_CHANGES"
2. User picks **Request Changes**
3. Prompt: "Use this body, or edit it first?"
4. User picks **Edit body**
5. Prompt: "Paste or type the new review body..."
6. User pastes a shorter body without the verdict paragraph.
7. Updated body shown for confirmation, then posted as REQUEST_CHANGES.

**Example 3 — Skip:**
1. User picks **Skip** in Step 1
2. Nothing posted. Flow ends.

## Files Changed

Only `skills/prr-start/SKILL.md`, Phase 8b section.

No Rust changes. No `Cargo.toml` / `marketplace.json` version bump. No binary rebuild.

## Testing

Manual end-to-end test of `/prr:start` against a real PR:
1. Verify Step 1 shows 4 options with the body rendered above.
2. Verify picking **Skip** exits without posting.
3. Verify picking **Approve / Comment / Request Changes** then **Post as-is** posts the unchanged body with the correct event.
4. Verify picking **Approve / Comment / Request Changes** then **Edit body**, pasting new text, and confirming posts the new body with the correct event.
5. Verify the line comments from Phase 7 are still attached to the review payload.

No unit tests — this is skill orchestration, not Rust logic.
