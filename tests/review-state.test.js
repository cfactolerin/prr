import assert from "node:assert/strict"
import { test } from "node:test"
import { createReviewState, httpLink, manifestSummary, reviewSteps } from "../review-state.js"

const manifest = `# Context Manifest

- **PRR**: v0.24.0
- **PR**: https://github.com/IndependentIP/delivery/pull/2606
- **Title**: DI-1364: Bound aggregated-delivery Slack alerts and summarize large histories
- **Author**: pegasusflyhigh
- **Branch**: \`fix/aggregated-slack-alert-size\` -> \`master\`
- **Ticket**: [DI-1364](https://company.atlassian.net/browse/DI-1364)
- **Round**: r1

## Gathered Context

- **Ticket**: must not replace the header
`

test("sidebar summary preserves all seven manifest fields and HTTP links", () => {
  const summary = manifestSummary(manifest)
  assert.equal(summary.length, 7)
  assert.equal(summary.find((field) => field.label === "PR").url, "https://github.com/IndependentIP/delivery/pull/2606")
  assert.deepEqual(summary.find((field) => field.label === "Ticket"), {
    label: "Ticket", text: "DI-1364", url: "https://company.atlassian.net/browse/DI-1364",
  })
  assert.equal(summary.find((field) => field.label === "Branch").text, "fix/aggregated-slack-alert-size -> master")
  assert.equal(manifestSummary("# Context Manifest\n\n- **Ticket**: none")[0].url, undefined)
})

test("sidebar links reject executable schemes and embedded credentials", () => {
  for (const url of [undefined, "javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.com"]) {
    assert.equal(httpLink(url), undefined)
  }
  assert.equal(httpLink("http://localhost:8080/browse/DI-1364"), "http://localhost:8080/browse/DI-1364")
})

test("review state is durable, session-scoped, resettable, and preserves concurrent updates", async () => {
  const values = new Map()
  const events = []
  const storage = {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)) },
  }
  const state = createReviewState(storage, async (data) => { events.push(data) })
  assert.equal(await state.get("s1"), null)
  await state.reset("s1")
  assert.deepEqual((await state.get("s1")).steps.map((step) => step.label), reviewSteps)
  await Promise.all([
    state.update("s1", 1, "completed"),
    state.update("s1", 2, "in_progress"),
    state.context("s1", "/round/r1", manifest),
  ])
  assert.deepEqual((await state.get("s1")).steps.map((step) => step.status), [
    "completed", "in_progress", "pending", "pending", "pending", "pending", "pending",
  ])
  const reloaded = createReviewState(storage, async () => {})
  assert.equal((await reloaded.get("s1")).summary.length, 7)
  assert.equal(await reloaded.get("s2"), null)
  assert.equal(events.length, 4)
  await state.update("s1", 1, "blocked")
  await state.update("s1", 6, "completed")
  await state.update("s1", 7, "completed")
  await state.context("s1", "/round/r2", manifest.replace("r1", "r2"))
  assert.equal((await state.get("s1")).steps[0].status, "blocked")
  assert.equal((await state.get("s1")).steps[5].status, "pending")
  assert.equal((await state.get("s1")).steps[6].status, "pending")
  await state.reset("s1")
  assert.equal((await state.get("s1")).summary.length, 0)
  assert.ok((await state.get("s1")).steps.every((step) => step.status === "pending"))
  for (const [step, status] of [[0, "completed"], [8, "pending"], [1, "bogus"]]) {
    await assert.rejects(state.update("s1", step, status), /Invalid PRR progress/)
  }
})

test("old six-stage sessions keep investigation status when the briefing is inserted", async () => {
  let saved = {
    steps: reviewSteps.filter((label) => label !== "Review briefing").map((label) => ({ label, status: "completed" })),
    summary: [{ label: "Round", text: "r1" }],
    round: "/round/r1",
  }
  const state = createReviewState({
    get: async () => structuredClone(saved),
    set: async (_key, value) => { saved = structuredClone(value) },
  }, async () => {})
  const loaded = await state.get("s")
  assert.equal(loaded.steps.length, 7)
  assert.deepEqual(loaded.steps[5], { label: "Review briefing", status: "pending" })
  assert.deepEqual(loaded.steps[6], { label: "Interactive investigation", status: "completed" })
  assert.equal(loaded.round, "/round/r1")
  assert.deepEqual(loaded.summary, saved.summary)
  await state.update("s", 6, "in_progress")
  assert.equal(saved.steps[5].status, "in_progress")
  assert.equal(saved.steps[6].status, "completed")
})

test("briefing and investigation have independent progress states", async () => {
  let saved
  const state = createReviewState({
    get: async () => structuredClone(saved),
    set: async (_key, value) => { saved = structuredClone(value) },
  }, async () => {})
  await state.update("s", 5, "completed")
  await state.update("s", 6, "in_progress")
  assert.deepEqual(saved.steps.slice(4), [
    { label: "Run arbiter synthesis", status: "completed" },
    { label: "Review briefing", status: "in_progress" },
    { label: "Interactive investigation", status: "pending" },
  ])
  await state.update("s", 6, "completed")
  await state.update("s", 7, "in_progress")
  assert.equal(saved.steps[5].status, "completed")
  assert.equal(saved.steps[6].status, "in_progress")
})
