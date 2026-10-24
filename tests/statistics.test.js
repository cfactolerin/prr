import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { createStatistics, summarizeStatistics, validateReviewStatistics } from "../statistics.js"

const binary = fileURLToPath(new URL("../bin/prr-darwin-universal", import.meta.url))
const source = (ids) => ({ findings: ids.map((id) => ({ id })) })
const sources = { opencode: source(["F-01", "F-02", "F-03", "F-04", "F-05"]), codex: source(["F-01", "F-02", "F-03"]) }
const findings = ["F-01", "F-02", "F-03", "F-04"].map((id) => ({ id, severity: "MED", origin: "introduced" }))
const assessment = (reviewer, finding_id, outcome, final_finding_ids = []) => ({ reviewer, finding_id, outcome, final_finding_ids, reason: "Saved evidence supports this disposition." })
const metrics = {
  version: 1,
  agreement: { status: "not_reached", round: null, reason: "The arbiter resolved an outstanding reviewer disagreement." },
  assessments: [
    assessment("opencode", "F-01", "validated", ["F-01"]), assessment("opencode", "F-02", "validated", ["F-02"]),
    assessment("opencode", "F-03", "invalid"), assessment("opencode", "F-04", "out_of_scope"), { ...assessment("opencode", "F-05", "duplicate", ["F-01"]), duplicate_of: "F-01" },
    assessment("codex", "F-01", "validated", ["F-01"]), assessment("codex", "F-02", "validated", ["F-03"]), assessment("codex", "F-03", "unresolved"),
  ],
}

test("attribution validates original identities, dispositions, final mappings, and agreement bounds", () => {
  assert.deepEqual(validateReviewStatistics(metrics, sources, findings, 2), metrics)
  for (const change of [
    (value) => { value.assessments.pop() },
    (value) => { value.assessments.push(value.assessments[0]) },
    (value) => { value.assessments[0].finding_id = "invented" },
    (value) => { value.assessments[0].final_finding_ids = ["F-99"] },
    (value) => { value.assessments[0].final_finding_ids = [] },
    (value) => { value.assessments[2].final_finding_ids = ["F-01"] },
    (value) => { value.assessments[0].reason = "" },
    (value) => { value.assessments[4].duplicate_of = "F-05" },
    (value) => { value.agreement = { status: "reached", round: 3, reason: "No saved round 3" } },
    (value) => { value.agreement.round = 0 },
  ]) {
    const changed = structuredClone(metrics)
    change(changed)
    assert.throws(() => validateReviewStatistics(changed, sources, findings, 2))
  }
  const agreed = { ...metrics, agreement: { status: "reached", round: 0, reason: "Initial reviews explicitly agree." } }
  assert.equal(validateReviewStatistics(agreed, sources, findings, 0).agreement.round, 0)
  assert.throws(() => validateReviewStatistics(agreed, { opencode: sources.opencode }, findings, 0))
})

function baseEvents() {
  return [
    { type: "run_started", run_id: "run" },
    { type: "round_started", run_id: "run", round_id: "round", round: "r1", pr: "https://github.com/acme/repo/pull/1", models: { opencode: { id: "native", providerID: "host" }, codex: { id: "codex" } } },
    { type: "review_completed", run_id: "run", round_id: "round", snapshot: "snapshot", verdict: "COMMENT", qa_rounds: 2,
      findings, sources: Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, value.findings.map((finding) => finding.id)])), metrics },
  ]
}

test("human correctness, rejection counts, unique catches and arbiter precision remain separate", () => {
  const decision = (finding_id, status, correctness = "unassessed", reason = "not_assessed") => ({ type: "decision", run_id: "run", round_id: "round", snapshot: "snapshot", finding_id, status, correctness, reason })
  const result = summarizeStatistics([...baseEvents(),
    decision("F-01", "accepted"), decision("F-02", "rejected", "confirmed", "not_worth_raising"), decision("F-03", "rejected", "incorrect", "incorrect"),
    decision("USER-1", "added"), { type: "finished", run_id: "run", round_id: "round", status: "skipped" },
  ])
  assert.equal(result.tracked_runs, 1)
  assert.equal(result.completed_review_rounds, 1)
  assert.equal(result.totals.found, 4)
  assert.equal(result.totals.rejected, 2)
  assert.equal(result.totals.pending, 1)
  assert.equal(result.totals.human_added, 1)
  assert.deepEqual(result.agreement_rounds, { not_reached: 1 })
  const native = result.harnesses.find((item) => item.reviewer === "opencode")
  const codex = result.harnesses.find((item) => item.reviewer === "codex")
  assert.equal(native.proposed, 5)
  assert.equal(native.unique_validated, 1)
  assert.equal(native.arbiter_precision, 2 / 3)
  assert.equal(native.human_precision, 1)
  assert.equal(codex.arbiter_precision, 1)
  assert.equal(codex.human_precision, 0)
  assert.equal(codex.unique_validated, 1)
  assert.equal(result.reviews[0].finish, "skipped")
})

test("zero findings and unknown attribution do not fabricate perfect or zero accuracy", () => {
  const events = baseEvents()
  events[2] = { ...events[2], findings: [], sources: { opencode: [], codex: [] }, metrics: null }
  const result = summarizeStatistics(events)
  assert.equal(result.totals.found, 0)
  assert.deepEqual(result.agreement_rounds, { unassessed: 1 })
  assert.ok(result.harnesses.every((item) => item.arbiter_precision === null && item.human_precision === null))
  events[2].sources = { opencode: ["F-01"], codex: [] }
  const missing = summarizeStatistics(events)
  assert.equal(missing.harnesses[0].unassessed, 1)
  assert.equal(missing.harnesses[0].arbiter_precision, null)
})

test("re-review is a new correlated round, decisions are latest-per-snapshot, and models can be mixed", () => {
  const events = baseEvents()
  events.push({ type: "decision", run_id: "run", round_id: "round", snapshot: "obsolete", finding_id: "F-01", status: "rejected" })
  events.push({ type: "reviewer_model", run_id: "run", round_id: "round", reviewer: "opencode", model: { id: "one" } })
  events.push({ type: "reviewer_model", run_id: "run", round_id: "round", reviewer: "opencode", model: { id: "two" } })
  events.push({ ...events[1], round_id: "round2", round: "r2" })
  events.push({ ...events[2], round_id: "round2", metrics: { ...metrics, agreement: { status: "reached", round: 2, reason: "Saved answers converge." } } })
  const result = summarizeStatistics(events)
  assert.equal(result.tracked_runs, 1)
  assert.equal(result.review_rounds, 2)
  assert.equal(result.totals.rejected, 0)
  assert.ok(result.harnesses.some((item) => item.model === "mixed"))
  assert.deepEqual(result.agreement_rounds, { "2": 1, not_reached: 1 })
  assert.equal(summarizeStatistics(events, { query: "missing" }).tracked_runs, 0)
})

function report(ids, statistics) {
  return `## Final Report\n\n### Verdict\n\nCOMMENT\n\nOnly the implementation concern matters.\n\n### Confidence\n\nHIGH\n\n### Findings\n\n#### Trigger: Logic Bug\n\n${ids.map((id) => `##### ${id} — A code concern\n\n- **Severity:** MED\n- **Anchor:** none\n- **Origin:** introduced\n- **Why this matters:** The claim needs checking.\n- **Suggested fix:** Correct the behavior.\n- **Suggested comment:** Please correct it.\n`).join("\n")}${statistics ? `\n### Review Statistics\n\n\x60\x60\x60json\n${JSON.stringify(statistics)}\n\x60\x60\x60\n` : ""}`
}

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prr-statistics-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const round = join(root, "workspace/acme-repo-pr-1/r1")
  mkdirSync(join(round, "results"), { recursive: true })
  writeFileSync(join(round, "results/pr-metadata.json"), JSON.stringify({ url: "https://github.com/acme/repo/pull/1" }))
  const directory = join(root, "statistics")
  const statistics = createStatistics({ directory, binary })
  return { root, round, directory, statistics }
}

test("local ledger survives workspace cleanup, deduplicates resume and collection, and rejects stale decisions", async (t) => {
  const { round, directory, statistics } = fixture(t)
  const small = { version: 1, agreement: { status: "reached", round: 0, reason: "Both initial reviews agree." }, assessments: [assessment("opencode", "F-01", "validated", ["F-01"]), assessment("codex", "F-01", "validated", ["F-01"])] }
  for (const reviewer of ["opencode", "codex"]) writeFileSync(join(round, `results/${reviewer}-review.md`), report(["F-01"]))
  writeFileSync(join(round, "results/final-report.md"), report(["F-01"], small))
  statistics.start("run", "acme/repo#1 --ticket DI-123")
  statistics.bind("run", round)
  statistics.bind("run", round)
  await statistics.collect("run", round)
  await statistics.collect("run", round)
  statistics.decision("run", round, { finding_id: "*", status: "accepted" })
  let summary = statistics.summary()
  assert.equal(summary.review_rounds, 1)
  assert.equal(summary.totals.accepted, 1)
  assert.equal(summary.totals.confirmed, 0)
  assert.equal(statistics.summary({ query: "acme/repo#1" }).completed_review_rounds, 1)
  assert.equal(summary.harnesses[0].human_precision, null)
  assert.deepEqual(summary.agreement_rounds, { "0": 1 })
  assert.throws(() => statistics.decision("run", round, { finding_id: "*", status: "accepted", correctness: "confirmed" }), /Bulk acceptance/)
  statistics.decision("run", round, { finding_id: "F-01", status: "rejected", reason: "out_of_scope" })
  assert.equal(statistics.summary().totals.incorrect, 0)
  statistics.decision("run", round, { finding_id: "F-01", status: "pending", correctness: "confirmed" })
  statistics.decision("run", round, { finding_id: "F-01", status: "rejected", reason: "not_worth_raising" })
  assert.equal(statistics.summary().totals.confirmed, 1)
  statistics.decision("run", round, { finding_id: "*", status: "accepted" })
  assert.equal(statistics.summary().totals.confirmed, 1)
  statistics.decision("run", round, { finding_id: "F-01", status: "accepted", correctness: "unassessed" })
  assert.equal(statistics.summary().totals.confirmed, 0)
  statistics.decision("run", round, { finding_id: "F-01", status: "rejected", correctness: "incorrect", reason: "incorrect" })
  assert.equal(statistics.summary().harnesses[0].human_precision, 0)
  assert.throws(() => statistics.decision("run", round, { finding_id: "invented", status: "rejected" }), /not in this review/)
  writeFileSync(join(round, "results/final-report.md"), report(["F-01"], small) + "\nChanged report.\n")
  assert.throws(() => statistics.decision("run", round, { finding_id: "F-01", status: "accepted" }), /Saved report changed/)
  rmSync(join(round, "..", ".."), { recursive: true, force: true })
  summary = statistics.summary()
  assert.equal(summary.tracked_runs, 1)
  assert.equal(summary.totals.rejected, 1)
  assert.ok(readdirSync(directory).every((name) => statSync(join(directory, name)).mode % 0o1000 === 0o600))
  assert.ok(!readFileSync(join(directory, readdirSync(directory)[0]), "utf8").includes("--ticket"))
})

test("missing or invented agreement is stored as unassessed rather than converted to a score", async (t) => {
  const { round, statistics } = fixture(t)
  statistics.start("run", "acme/repo#1")
  statistics.bind("run", round)
  writeFileSync(join(round, "results/opencode-review.md"), report(["F-01"]))
  writeFileSync(join(round, "results/final-report.md"), report(["F-01"]))
  await statistics.collect("run", round)
  let result = statistics.summary()
  assert.equal(result.totals.found, 1)
  assert.equal(result.harnesses[0].unassessed, 1)
  assert.equal(result.harnesses[0].arbiter_precision, null)
  assert.match(result.reviews[0].statistics_warning, /no structured reviewer attribution/)
  const forged = { version: 1, agreement: { status: "reached", round: 1, reason: "Invented agreement" }, assessments: [assessment("opencode", "F-01", "validated", ["F-01"])] }
  writeFileSync(join(round, "results/final-report.md"), report(["F-01"], forged))
  await statistics.collect("run", round)
  result = statistics.summary()
  assert.equal(result.completed_review_rounds, 1)
  assert.equal(result.harnesses[0].arbiter_precision, null)
  assert.match(result.reviews[0].statistics_warning, /Agreement round/)
  writeFileSync(join(round, "results/final-report.md"), report(["F-01"]))
  await statistics.collect("run", round)
  statistics.decision("run", round, { finding_id: "F-01", status: "accepted" })
  assert.equal(statistics.summary().totals.accepted, 1)
  assert.match(statistics.summary().reviews[0].statistics_warning, /no structured reviewer attribution/)
})

test("corrupt events are reported and symlinks cannot redirect statistics writes", (t) => {
  const { root, directory, statistics } = fixture(t)
  statistics.start("run", "acme/repo#1")
  writeFileSync(join(directory, "999-999-deadbeef.json"), "not json")
  assert.equal(statistics.summary().unreadable_events, 1)
  const target = join(root, "elsewhere")
  mkdirSync(target)
  const link = join(root, "link")
  symlinkSync(target, link)
  const redirected = createStatistics({ directory: link, binary })
  assert.throws(() => redirected.start("run", "acme/repo#1"), /symbolic link/)
  assert.deepEqual(readdirSync(target), [])
})
