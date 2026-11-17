import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import { createReviewReader, relatedConversations } from "../review-reader.js"
import { reviewRpc } from "../review-rpc.js"
import { createReviewState, reviewSteps } from "../review-state.js"

const binary = fileURLToPath(new URL("../bin/prr-darwin-universal", import.meta.url))
const report = `## Final Report

### Verdict

COMMENT

### Confidence

HIGH

### Findings

#### Trigger: Logic Bug

##### F-01 — Code concern

- **Severity:** MED
- **Anchor:** diff
- **Origin:** introduced
- **Location:** a.rb:2
- **Why this matters:** The new value is wrong.
- **Suggested fix:** Correct the value.
- **Suggested comment:** Please correct this value.

##### F-02 — Unchanged reference

- **Severity:** LOW
- **Anchor:** reference
- **Origin:** pre-existing
- **Location:** reference.rb:20
- **Why this matters:** A relevant unchanged caller.
- **Suggested fix:** Follow up separately.
- **Suggested comment:** Consider a follow-up.

#### Trigger: Acceptance Criteria

##### F-03 — Partner check

- **Severity:** MED
- **Anchor:** none
- **Origin:** introduced
- **Why this matters:** Acceptance is incomplete.
- **Suggested fix:** Record results.
- **Suggested comment:** Record acceptance results.
`
const patch = "diff --git a/a.rb b/a.rb\n--- a/a.rb\n+++ b/a.rb\n@@ -1,2 +1,2 @@\n first\n-old\n+new\n"
const investigationSchema = SchemaRepresentation.toSchema(SchemaRepresentation.fromJsonSchemaDocument(
  JsonSchema.fromSchemaDraft2020_12(reviewRpc.methods.investigation.output),
))

function fixture(t, onDecision) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prr-view-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const round = join(root, "acme-repo-pr-1/r1")
  mkdirSync(join(round, "results"), { recursive: true })
  writeFileSync(join(round, "results/final-report.md"), report)
  writeFileSync(join(round, "results/diff.txt"), patch)
  let saved = { round, steps: reviewSteps.map((label) => ({ label, status: "completed" })) }
  const state = createReviewState({
    get: async (key) => key === "review/review" ? structuredClone(saved) : null,
    set: async (_key, value) => { saved = structuredClone(value) },
  }, async () => {})
  const reader = createReviewReader({ state, resolveRound: realpathSync, binary, onDecision })
  return { root, round, reader, state, setState: (value) => { saved = value }, getState: () => saved }
}

test("viewer uses only the explicitly continued session's saved report and file IDs", async (t) => {
  const { reader } = fixture(t)
  await assert.rejects(reader.investigation({ sessionID: "other" }), /Continue from the review briefing/)
  const result = await reader.investigation({ sessionID: "review" })
  Schema.decodeUnknownSync(investigationSchema)(result)
  assert.equal(result.files.length, 1)
  assert.equal(result.findings.length, 3)
  assert.equal(result.findings[0].fileID, "0")
  assert.equal(Object.hasOwn(result.findings[1], "fileID"), false)
  assert.equal(Object.hasOwn(result.findings[2], "fileID"), false)
  assert.ok(!JSON.stringify(result).includes("/.prr/"))
  const request = { sessionID: "review", snapshot: result.snapshot }
  assert.equal((await reader.diff({ ...request, fileID: "0" })).patch, patch)
  assert.equal((await reader.diff({ ...request, findingID: "F-01" })).patch, patch)
  assert.equal((await reader.diff({ ...request, findingID: "F-03" })).mode, "none")
  await assert.rejects(reader.diff({ ...request, fileID: "../../secret" }), /not in the saved diff/)
  await assert.rejects(reader.diff({ ...request, findingID: "fake" }), /not in the saved report/)
})

test("briefing gates, changed snapshots, and new rounds invalidate navigation", async (t) => {
  const { reader, round, setState, getState } = fixture(t)
  const result = await reader.investigation({ sessionID: "review" })
  setState({ ...getState(), steps: reviewSteps.map((label) => ({ label, status: "pending" })) })
  await assert.rejects(reader.diff({ sessionID: "review", snapshot: result.snapshot, fileID: "0" }), /Continue from the review briefing/)
  setState({ ...getState(), steps: reviewSteps.map((label) => ({ label, status: "completed" })) })
  writeFileSync(join(round, "results/final-report.md"), report.replace("Code concern", "Changed concern"))
  await assert.rejects(reader.diff({ sessionID: "review", snapshot: result.snapshot, fileID: "0" }), /changed; refresh/)
  const next = await reader.investigation({ sessionID: "review" })
  assert.notEqual(next.snapshot, result.snapshot)
  const round2 = join(round, "../r2")
  mkdirSync(join(round2, "results"), { recursive: true })
  writeFileSync(join(round2, "results/final-report.md"), report)
  writeFileSync(join(round2, "results/diff.txt"), patch)
  setState({ ...getState(), round: realpathSync(round2) })
  await assert.rejects(reader.diff({ sessionID: "review", snapshot: next.snapshot, fileID: "0" }), /changed; refresh/)
})

test("multiple citations and ranges containing context keep findings on their changed file", async (t) => {
  const { reader, round } = fixture(t)
  writeFileSync(join(round, "results/final-report.md"), report
    .replace("a.rb:2", "`a.rb:2`; `reference.rb:20`")
    .replace("- **Anchor:** reference", "- **Anchor:** diff")
    .replace("reference.rb:20\n", "a.rb:3-5\n"))
  const sidebar = "diff --git a/docs/_sidebar.md b/docs/_sidebar.md\n--- a/docs/_sidebar.md\n+++ b/docs/_sidebar.md\n@@ -1 +1 @@\n-old link\n+new link\n"
  const changed = "diff --git a/a.rb b/a.rb\n--- a/a.rb\n+++ b/a.rb\n@@ -1,2 +1,5 @@\n first\n+new\n+heading\n \n+instructions\n"
  writeFileSync(join(round, "results/diff.txt"), sidebar + changed)
  const result = await reader.investigation({ sessionID: "review" })
  Schema.decodeUnknownSync(investigationSchema)(result)
  assert.equal(result.warnings, "")
  assert.deepEqual(result.findings.slice(0, 2).map(({ anchor, path, fileID }) => ({ anchor, path, fileID })), [
    { anchor: "diff", path: "a.rb", fileID: "1" },
    { anchor: "diff", path: "a.rb", fileID: "1" },
  ])
  for (const findingID of ["F-01", "F-02"]) {
    const diff = await reader.diff({ sessionID: "review", snapshot: result.snapshot, findingID })
    assert.equal(diff.mode, "diff")
    assert.equal(diff.path, "a.rb")
    assert.equal(diff.patch, changed)
  }
})

test("viewer rejects symlinked artifacts instead of exposing arbitrary files", async (t) => {
  const { reader, root, round } = fixture(t)
  const path = join(round, "results/final-report.md")
  rmSync(path)
  writeFileSync(join(root, "private.md"), report)
  symlinkSync(join(root, "private.md"), path)
  await assert.rejects(reader.investigation({ sessionID: "review" }), /Invalid saved review artifact/)
})

test("all changed files remain available, with explicit binary and metadata-only messages", async (t) => {
  const { reader, round } = fixture(t)
  writeFileSync(join(round, "results/diff.txt"), patch + "diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\ndiff --git a/script b/script\nold mode 100644\nnew mode 100755\n")
  const result = await reader.investigation({ sessionID: "review" })
  assert.equal(result.files.length, 3)
  const request = { sessionID: "review", snapshot: result.snapshot }
  assert.match((await reader.diff({ ...request, fileID: "1" })).message, /Binary change/)
  assert.match((await reader.diff({ ...request, fileID: "2" })).message, /Metadata-only change/)
  await assert.rejects(reader.diff({ ...request, fileID: "1", findingID: "F-01" }), /does not belong/)
})

test("reference locations use the saved commit, never the mutable working tree", async (t) => {
  const { reader, round } = fixture(t)
  const repo = join(round, "repo")
  mkdirSync(repo)
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init")
  writeFileSync(join(repo, "reference.rb"), Array.from({ length: 30 }, (_, index) => `saved ${index + 1}`).join("\n"))
  git("add", "reference.rb")
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
  writeFileSync(join(round, "results/pr-metadata.json"), JSON.stringify({ headRefOid: git("rev-parse", "HEAD") }))
  writeFileSync(join(repo, "reference.rb"), "mutable content")
  const { snapshot } = await reader.investigation({ sessionID: "review" })
  const result = await reader.diff({ sessionID: "review", snapshot, findingID: "F-02" })
  assert.equal(result.mode, "reference")
  assert.ok(result.patch.includes("saved 20"))
  assert.ok(!result.patch.includes("mutable content"))
})

test("chat focus and diff decisions share durable snapshot-bound state without posting", async (t) => {
  const recorded = []
  const { reader, state } = fixture(t, async (value) => { recorded.push(value) })
  const initial = await reader.findings({ sessionID: "review" })
  assert.deepEqual(initial.decisions, [])
  const request = { sessionID: "review", snapshot: initial.snapshot }
  const focused = await reader.findings({ ...request, operation: "focus", findingID: "F-02" })
  assert.equal(focused.active_finding_id, "F-02")
  assert.equal((await reader.investigation({ sessionID: "review" })).focus_request, focused.focus_request)
  const accepted = await reader.decide({ ...request, revision: 0, findingID: "F-01", status: "accepted" })
  assert.equal(accepted.revision, 1)
  assert.deepEqual(accepted.decisions, [{ finding_id: "F-01", status: "accepted" }])
  assert.equal(accepted.active_finding_id, "F-02", "deciding never changes the active chat finding")
  const reloaded = createReviewReader({ state, resolveRound: realpathSync, binary })
  assert.deepEqual((await reloaded.investigation({ sessionID: "review" })).decisions, accepted.decisions)
  const edited = await reader.findings({ ...request, operation: "decision", revision: 1, findingID: "F-02", status: "edited", overriddenBody: "Approved replacement.\n\nFix: Keep exact text." })
  assert.equal(edited.decisions.find((item) => item.finding_id === "F-02").overridden_body, "Approved replacement.\n\nFix: Keep exact text.")
  const nextFocus = await reader.findings({ ...request, operation: "focus", findingID: "F-02" })
  assert.notEqual(nextFocus.focus_request, focused.focus_request)
  assert.deepEqual(nextFocus.decisions, edited.decisions)
  assert.deepEqual(recorded.map(({ finding_id, status }) => ({ finding_id, status })), [{ finding_id: "F-01", status: "accepted" }, { finding_id: "F-02", status: "edited" }])
  const rejected = await reader.decide({ ...request, revision: 2, findingID: "F-03", status: "rejected" })
  assert.equal(rejected.decisions.find((item) => item.finding_id === "F-03").status, "rejected")
  assert.equal((await state.get("review")).steps[6].status, "completed")
})

test("stale, concurrent, unknown, and unsupported decisions cannot overwrite current choices", async (t) => {
  const { reader, round } = fixture(t)
  const { snapshot } = await reader.investigation({ sessionID: "review" })
  const request = { sessionID: "review", snapshot, revision: 0, findingID: "F-01", status: "accepted" }
  const settled = await Promise.allSettled([reader.decide(request), reader.decide({ ...request, status: "rejected" })])
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1)
  assert.match(settled.find((item) => item.status === "rejected").reason.message, /decisions changed/)
  await assert.rejects(reader.decide({ ...request, revision: 1, findingID: "F-99" }), /not in the saved report/)
  await assert.rejects(reader.decide({ ...request, revision: 1, status: "posted" }), /only accept or reject/)
  await assert.rejects(reader.decide({ ...request, revision: 1, status: "edited" }), /only accept or reject/)
  await assert.rejects(reader.findings({ ...request, operation: "decision", revision: 1, status: "edited", overriddenBody: "" }), /Invalid finding decision/)
  writeFileSync(join(round, "results/final-report.md"), report.replace("Code concern", "New concern"))
  await assert.rejects(reader.decide({ ...request, revision: 1 }), /report changed/)
  const changed = await reader.investigation({ sessionID: "review" })
  assert.deepEqual(changed.decisions, [])
  assert.equal(changed.active_finding_id, undefined)
  writeFileSync(join(round, "results/final-report.md"), report.replace("##### F-02", "##### F-01"))
  const ambiguous = await reader.investigation({ sessionID: "review" })
  await assert.rejects(reader.decide({ ...request, snapshot: ambiguous.snapshot, revision: 0 }), /ambiguous/)
})

test("statistics failure never undoes an explicit saved decision", async (t) => {
  const { reader } = fixture(t, async () => { throw new Error("Local ledger unavailable") })
  const { snapshot } = await reader.investigation({ sessionID: "review" })
  const result = await reader.decide({ sessionID: "review", snapshot, revision: 0, findingID: "F-01", status: "rejected" })
  assert.match(result.warning, /Decision saved.*Local ledger unavailable/)
  assert.equal((await reader.findings({ sessionID: "review" })).decisions[0].status, "rejected")
})

test("explicit decisions are exported with snapshot provenance for the next review round", async (t) => {
  const { reader, round } = fixture(t)
  const initial = await reader.findings({ sessionID: "review" })
  const request = { sessionID: "review", snapshot: initial.snapshot, findingID: "F-01" }
  await reader.decide({ ...request, revision: 0, status: "rejected" })
  const saved = () => JSON.parse(readFileSync(join(round, "results/finding-decisions.json"), "utf8"))
  assert.equal(saved().decisions["F-01"].status, "rejected")
  assert.equal(saved().report_sha256, createHash("sha256").update(report).digest("hex"))
  assert.equal(saved().diff_sha256, createHash("sha256").update(patch).digest("hex"))
  await reader.decide({ ...request, revision: 1, status: "accepted" })
  assert.equal(saved().decisions["F-01"].status, "accepted", "revisiting a rejection replaces the historical choice")
  await reader.findings({ ...request, operation: "decision", revision: 2, status: "edited", overriddenBody: "Exact approved edit" })
  assert.equal(saved().decisions["F-01"].overridden_body, "Exact approved edit")
})

test("reading an older session exports its existing choices without recording new decisions", async (t) => {
  const recorded = []
  const { reader, round, getState, setState } = fixture(t, async (decision) => { recorded.push(decision) })
  const { snapshot } = await reader.findings({ sessionID: "review" })
  setState({ ...getState(), findings: { snapshot, revision: 3, decisions: { "F-01": { status: "rejected" } } } })
  const saved = await reader.findings({ sessionID: "review" })
  assert.equal(saved.revision, 3)
  assert.equal(JSON.parse(readFileSync(join(round, "results/finding-decisions.json"), "utf8")).decisions["F-01"].status, "rejected")
  assert.deepEqual(recorded, [])
})

test("a history export failure preserves the choice and does not follow a symlink", async (t) => {
  const { reader, round, root } = fixture(t)
  const outside = join(root, "outside.json")
  writeFileSync(outside, "untouched")
  symlinkSync(outside, join(round, "results/finding-decisions.json"))
  const { snapshot } = await reader.findings({ sessionID: "review" })
  const result = await reader.decide({ sessionID: "review", snapshot, revision: 0, findingID: "F-01", status: "rejected" })
  assert.match(result.warning, /Round history warning/)
  assert.equal(result.decisions[0].status, "rejected")
  assert.equal(readFileSync(outside, "utf8"), "untouched")
})

test("conversation matching distinguishes exact comments from current-head location candidates", () => {
  const finding = { path: "a.rb", line: 5, start_line: 3, suggested_comment: "Correct the value." }
  const thread = { id: 1, file: "github-discussions/thread-1.md", path: "a.rb", line: 4, side: "RIGHT", commit_id: "head", root_body: "A different concern." }
  assert.equal(relatedConversations([thread], finding, "head")[0].match, "possible_location")
  assert.deepEqual(relatedConversations([thread], finding, "new-head"), [])
  assert.deepEqual(relatedConversations([{ ...thread, line: null }], finding, "head"), [])
  assert.deepEqual(relatedConversations([{ ...thread, side: "LEFT" }], finding, "head"), [])
  assert.deepEqual(relatedConversations([{ ...thread, path: "other.rb" }], finding, "head"), [])
  assert.equal(relatedConversations([{ ...thread, line: null, root_body: "**Pre-existing:** this predates the PR, so fixing it here is optional.\n\nCorrect the value." }], finding, "new-head")[0].match, "comment")
  assert.equal(relatedConversations([{ ...thread, root_body: "Approved edit" }], finding, "new-head", "Approved edit")[0].match, "comment")
  assert.deepEqual(relatedConversations([{ ...thread, file: "../../outside" }], finding, "head"), [])
})

test("chat focus exposes only matching saved thread paths and reports missing discussion context", async (t) => {
  const { reader, round } = fixture(t)
  const { snapshot } = await reader.findings({ sessionID: "review" })
  const request = { sessionID: "review", operation: "focus", snapshot, findingID: "F-01" }
  assert.match((await reader.findings(request)).github_conversations.warning, /No GitHub discussion snapshot/)
  writeFileSync(join(round, "results/github-discussions.json"), JSON.stringify({
    threads: [{ id: 7, file: "github-discussions/thread-7.md", path: "a.rb", root_body: "Please correct this value." }],
    unavailable: ["reviews"],
  }))
  const result = await reader.findings(request)
  assert.deepEqual(result.github_conversations.matches, [{ id: 7, match: "comment", filePath: join(round, "results/github-discussions/thread-7.md") }])
  assert.deepEqual(result.github_conversations.unavailable, ["reviews"])
  writeFileSync(join(round, "results/github-discussions.json"), "{")
  assert.match((await reader.findings(request)).github_conversations.warning, /matching is unavailable/)
})
