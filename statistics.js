import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
const reviewers = ["opencode", "codex"]
const hash = (value) => createHash("sha256").update(value).digest("hex")
const outcomes = ["validated", "invalid", "out_of_scope", "duplicate", "unresolved"]

function normalizeReference(value) {
  const match = value.match(/^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:#|\/pull\/)(\d+)\/?$/)
  return match ? `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}` : value
}

function savedFile(round, name, optional = false) {
  const path = join(round, "results", name)
  if (optional && !existsSync(path)) return ""
  if (realpathSync(path) !== path || !statSync(path).isFile() || statSync(path).size > 8 * 1024 * 1024) {
    throw new Error(`Invalid statistics input: ${name}`)
  }
  return readFileSync(path, "utf8")
}

export function validateReviewStatistics(value, sources, findings, qaRounds) {
  if (!value || value.version !== 1 || !Array.isArray(value.assessments) || !value.agreement) throw new Error("Missing review statistics v1")
  const expected = new Set(Object.entries(sources).flatMap(([reviewer, report]) => report.findings.map((finding) => `${reviewer}/${finding.id}`)))
  const finalIDs = new Set(findings.map((finding) => finding.id))
  if (expected.size !== Object.values(sources).reduce((sum, report) => sum + report.findings.length, 0) || finalIDs.size !== findings.length) {
    throw new Error("Statistics require unique finding IDs within each report")
  }
  const seen = new Set()
  const assessments = value.assessments.map((item) => {
    const key = `${item.reviewer}/${item.finding_id}`
    if (!expected.has(key) || seen.has(key) || !outcomes.includes(item.outcome)
      || !Array.isArray(item.final_finding_ids) || new Set(item.final_finding_ids).size !== item.final_finding_ids.length
      || item.final_finding_ids.some((id) => !finalIDs.has(id)) || typeof item.reason !== "string" || !item.reason.trim()
      || item.reason.length > 2000) throw new Error(`Invalid reviewer attribution: ${key}`)
    if (item.outcome === "validated" && !item.final_finding_ids.length) throw new Error(`Missing final finding for ${key}`)
    if (["invalid", "out_of_scope"].includes(item.outcome) && item.final_finding_ids.length) throw new Error(`Rejected candidate maps to a final finding: ${key}`)
    if (item.outcome === "duplicate") {
      const original = value.assessments.find((other) => other.reviewer === item.reviewer && other.finding_id === item.duplicate_of)
      if (!original || original === item || original.outcome === "duplicate" || !expected.has(`${item.reviewer}/${item.duplicate_of}`)
        || JSON.stringify([...item.final_finding_ids].sort()) !== JSON.stringify([...(original.final_finding_ids ?? [])].sort())) throw new Error(`Invalid duplicate source: ${key}`)
    }
    seen.add(key)
    return { reviewer: item.reviewer, finding_id: item.finding_id, outcome: item.outcome, final_finding_ids: item.final_finding_ids, reason: item.reason, ...(item.outcome === "duplicate" ? { duplicate_of: item.duplicate_of } : {}) }
  })
  if (seen.size !== expected.size) throw new Error("Reviewer attribution does not cover every source finding")
  const agreement = value.agreement
  if (!["reached", "not_reached", "unassessed"].includes(agreement.status) || typeof agreement.reason !== "string"
    || !agreement.reason.trim() || agreement.reason.length > 2000) throw new Error("Invalid agreement assessment")
  if (agreement.status === "reached") {
    if (Object.keys(sources).length !== 2 || !Number.isInteger(agreement.round) || agreement.round < 0 || agreement.round > qaRounds) {
      throw new Error("Agreement round is not supported by the saved review history")
    }
  } else if (agreement.round !== null) throw new Error("An unresolved agreement cannot have a round")
  return { version: 1, agreement: { status: agreement.status, round: agreement.round, reason: agreement.reason }, assessments }
}

function statisticsSection(report) {
  const section = report.match(/^### Review Statistics\s*\n([\s\S]*?)(?=^### |$(?![\s\S]))/m)?.[1]
  const json = section?.match(/^```json\s*\n([\s\S]*?)\n```\s*$/m)?.[1]
  if (!json) throw new Error("Saved report has no structured reviewer attribution")
  return JSON.parse(json)
}

function modelKey(model) {
  if (!model?.id) return "unknown"
  return `${model.providerID ? `${model.providerID}/` : ""}${model.id}${model.variant ? `#${model.variant}` : ""}`
}

export function summarizeStatistics(events, { query = "", limit = 20 } = {}) {
  const starts = new Map()
  const rounds = new Map()
  const key = (event) => event.round_id
  for (const event of events) {
    if (event.type === "run_started") starts.set(event.run_id, event)
    if (event.type === "round_started") rounds.set(key(event), { ...event, models: event.models ?? {}, modelBasis: {}, actualModels: {}, decisions: {}, added: new Set() })
    const round = rounds.get(key(event))
    if (!round) continue
    if (event.type === "review_completed" && round.snapshot !== event.snapshot) Object.assign(round, event, { decisions: {}, added: new Set(), finish: undefined })
    if (event.type === "reviewer_model") {
      const known = round.actualModels[event.reviewer] ??= new Set()
      known.add(modelKey(event.model))
      round.models[event.reviewer] = known.size === 1 ? event.model : { id: "mixed" }
      round.modelBasis[event.reviewer] = event.basis ?? "not_recorded"
    }
    if (event.type === "decision" && event.snapshot === round.snapshot) {
      if (event.status === "added") round.added.add(event.finding_id)
      const previous = round.decisions[event.finding_id]
      round.decisions[event.finding_id] = { ...previous, ...event, correctness: event.correctness ?? previous?.correctness ?? "unassessed" }
    }
    if (event.type === "finished") round.finish = event.status
  }
  const normalized = normalizeReference(query).toLowerCase()
  const exactPR = normalized.startsWith("https://github.com/") && /\/pull\/\d+$/.test(normalized)
  const selected = [...rounds.values()].filter((round) => !query || (exactPR ? round.pr?.toLowerCase() === normalized : round.pr?.toLowerCase().includes(normalized)) || round.run_id.includes(query))
  const selectedRuns = new Set(selected.map((round) => round.run_id))
  const runs = [...starts.values()].filter((run) => !query || selectedRuns.has(run.run_id)
    || (exactPR ? run.reference?.toLowerCase() === normalized : run.reference?.toLowerCase().includes(normalized)) || run.run_id.includes(query))
  const completed = selected.filter((round) => round.type === "review_completed")
  const harnesses = new Map()
  const agreementRounds = {}
  const reviews = completed.map((round) => {
    const counts = { found: round.findings.length, accepted: 0, edited: 0, rejected: 0, pending: 0, confirmed: 0, incorrect: 0, human_added: round.added.size }
    for (const finding of round.findings) {
      const decision = round.decisions[finding.id]
      counts[decision?.status ?? "pending"]++
      if (decision?.correctness === "confirmed") counts.confirmed++
      if (decision?.correctness === "incorrect") counts.incorrect++
    }
    const agreement = round.metrics?.agreement ?? { status: "unassessed", round: null }
    const band = agreement.status === "reached" ? String(agreement.round) : agreement.status
    agreementRounds[band] = (agreementRounds[band] ?? 0) + 1
    for (const reviewer of Object.keys(round.sources)) {
      const model = modelKey(round.models[reviewer])
      const bucketKey = `${reviewer}:${model}`
      const bucket = harnesses.get(bucketKey) ?? {
        reviewer, model, model_basis: round.modelBasis[reviewer] ?? "round_start_snapshot", reviews: 0, proposed: 0, validated: 0, invalid: 0, out_of_scope: 0, duplicate: 0, unresolved: 0,
        unassessed: 0, unique_validated: 0, human_confirmed: 0, human_incorrect: 0,
      }
      const basis = round.modelBasis[reviewer] ?? "round_start_snapshot"
      if (bucket.model_basis !== basis) bucket.model_basis = "mixed"
      bucket.reviews++
      bucket.proposed += round.sources[reviewer].length
      if (!round.metrics) bucket.unassessed += round.sources[reviewer].length
      const attributed = round.metrics?.assessments ?? []
      for (const item of attributed.filter((item) => item.reviewer === reviewer)) bucket[item.outcome]++
      const mapped = new Set(attributed.filter((item) => item.reviewer === reviewer).flatMap((item) => item.final_finding_ids))
      for (const id of mapped) {
        const valid = attributed.some((item) => item.reviewer === reviewer && item.outcome === "validated" && item.final_finding_ids.includes(id))
        const otherCaught = attributed.some((item) => item.reviewer !== reviewer && item.final_finding_ids.includes(id))
        if (valid && !otherCaught && Object.keys(round.sources).length === 2) bucket.unique_validated++
        const correctness = round.decisions[id]?.correctness
        if (correctness === "confirmed") bucket.human_confirmed++
        if (correctness === "incorrect") bucket.human_incorrect++
      }
      harnesses.set(bucketKey, bucket)
    }
    return {
      run_id: round.run_id, round_id: round.round_id, pr: round.pr, round: round.round, verdict: round.verdict,
      qa_rounds: round.qa_rounds, agreement, attribution: round.metrics ? "assessed" : "unassessed", statistics_warning: round.warning,
      ...counts, finish: round.finish ?? "not_recorded", reviewers: round.sources, assessments: round.metrics?.assessments ?? [],
      findings: round.findings, source_titles: round.source_titles,
      decisions: Object.values(round.decisions).map(({ finding_id, status, correctness, reason }) => ({ finding_id, status, correctness, reason })),
    }
  })
  const totals = Object.fromEntries(["found", "accepted", "edited", "rejected", "pending", "confirmed", "incorrect", "human_added"].map((field) => [field, reviews.reduce((sum, review) => sum + review[field], 0)]))
  return {
    tracked_runs: runs.length, review_rounds: selected.length, completed_review_rounds: reviews.length,
    runs_without_completed_review: runs.filter((run) => !completed.some((round) => round.run_id === run.run_id)).length,
    distinct_prs: new Set(selected.map((round) => round.pr).filter(Boolean)).size,
    agreement_rounds: agreementRounds, totals,
    harnesses: [...harnesses.values()].map((bucket) => ({
      ...bucket,
      arbiter_precision: bucket.validated + bucket.invalid ? bucket.validated / (bucket.validated + bucket.invalid) : null,
      human_precision: bucket.human_confirmed + bucket.human_incorrect ? bucket.human_confirmed / (bucket.human_confirmed + bucket.human_incorrect) : null,
    })),
    reviews: reviews.slice(-limit).reverse(), reviews_shown: Math.min(limit, reviews.length),
    limitations: [
      "Counts cover instrumented OpenCode 2 runs since statistics were enabled, not all historical PRR usage.",
      "Arbiter validation and explicit human correctness judgments are separate signals, not objective ground truth.",
      "Accept/reject/edit alone does not establish correctness; scope, preference, and already-fixed rejections are not false positives.",
      "Precision excludes unresolved, out-of-scope, duplicate, and unassessed candidates; denominators differ between arbiter and human assessments.",
      "Unique validated findings are not recall: unknown bugs and unreviewed code are not measurable from these records.",
      "Compare like-for-like models and PRs. Re-review rounds are correlated samples, not independent experiments.",
      "Reviewer attribution covers original independent-review candidates. Later Q&A/arbiter discoveries without original source IDs are not credited to a harness.",
      "Model identities use observed native requests and requested Codex invocation models when available, otherwise round-start snapshots; provider-side model aliases are not independently fingerprinted.",
    ],
  }
}

export function createStatistics({ directory, binary }) {
  function append(type, data) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Statistics directory must not be a symbolic link")
    const order = `${Date.now()}-${process.hrtime.bigint().toString().padStart(24, "0")}-${randomUUID()}`
    const path = join(directory, `${order}.json`)
    const temporary = `${path}.tmp`
    const payload = JSON.stringify({ version: 1, time: new Date().toISOString(), type, ...data })
    if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error("Statistics event exceeds the 1 MiB storage limit; tracking is incomplete")
    writeFileSync(temporary, payload, { flag: "wx", mode: 0o600 })
    renameSync(temporary, path)
  }
  function read() {
    if (!existsSync(directory)) return { events: [], unreadable_events: 0 }
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Statistics directory must not be a symbolic link")
    const events = []
    let unreadable_events = 0
    for (const name of readdirSync(directory).filter((name) => /^\d+-\d+-[\da-f-]+\.json$/.test(name)).sort()) {
      try {
        const path = join(directory, name)
        if (lstatSync(path).isSymbolicLink() || statSync(path).size > 1024 * 1024) throw new Error("Invalid event")
        const event = JSON.parse(readFileSync(path, "utf8"))
        if (event.version !== 1 || !["run_started", "round_started", "review_completed", "reviewer_model", "decision", "finished"].includes(event.type)
          || typeof event.run_id !== "string" || event.type !== "run_started" && typeof event.round_id !== "string") throw new Error("Unknown statistics event")
        if (event.type === "review_completed") {
          if (!Array.isArray(event.findings) || !event.sources || typeof event.sources !== "object" || typeof event.snapshot !== "string"
            || Object.entries(event.sources).some(([key, ids]) => !reviewers.includes(key) || !Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) throw new Error("Invalid saved review statistics")
          if (event.metrics) {
            try {
              event.metrics = validateReviewStatistics(event.metrics, Object.fromEntries(Object.entries(event.sources).map(([key, ids]) => [key, { findings: ids.map((id) => ({ id })) }])), event.findings, event.qa_rounds)
            } catch {
              event.metrics = null
              event.warning = "Stored reviewer attribution is invalid; accuracy is unassessed."
            }
          }
        }
        if (event.type === "decision" && (!["pending", "accepted", "rejected", "edited", "added"].includes(event.status)
          || event.correctness !== undefined && !["confirmed", "incorrect", "unassessed"].includes(event.correctness) || typeof event.finding_id !== "string")) throw new Error("Invalid decision event")
        if (event.type === "reviewer_model" && !reviewers.includes(event.reviewer)) throw new Error("Invalid reviewer identity")
        events.push(event)
      } catch { unreadable_events++ }
    }
    return { events, unreadable_events }
  }
  const roundID = (runID, round) => hash(`${runID}\0${round}`)
  async function parse(round, name) {
    const text = savedFile(round, name)
    const { stdout, stderr } = await execute(binary, ["parse-report", join(round, "results", name)], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" })
    if (savedFile(round, name) !== text) throw new Error("Review changed during statistics collection")
    return { ...JSON.parse(stdout), content_hash: hash(text), warning: stderr.trim() }
  }
  return {
    start(runID, reference) {
      const match = reference.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|[\w.-]+\/[\w.-]+#\d+/)?.[0]
      append("run_started", { run_id: runID, reference: normalizeReference(match ?? "unknown") })
    },
    bind(runID, round, models = {}) {
      const id = roundID(runID, round)
      if (read().events.some((event) => event.type === "round_started" && event.round_id === id)) return
      const meta = JSON.parse(savedFile(round, "pr-metadata.json", true) || "{}")
      const pr = typeof meta.url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(meta.url) ? meta.url : "unknown"
      const cleanModels = Object.fromEntries(Object.entries(models).filter(([, model]) => model?.id).map(([reviewer, model]) => [reviewer, {
        id: String(model.id), ...(model.providerID ? { providerID: String(model.providerID) } : {}), ...(model.variant ? { variant: String(model.variant) } : {}),
      }]))
      append("round_started", { run_id: runID, round_id: id, round: basename(round), pr, models: cleanModels })
    },
    model(round, reviewer, model, basis = "not_recorded") {
      const events = read().events
      const start = [...events].reverse().find((event) => event.type === "round_started" && event.round_id === roundID(event.run_id, round))
      if (!start || !reviewers.includes(reviewer) || !model?.id) return
      const last = [...events].reverse().find((event) => event.type === "reviewer_model" && event.round_id === start.round_id && event.reviewer === reviewer)
      const clean = { id: String(model.id), ...(model.providerID ? { providerID: String(model.providerID) } : {}), ...(model.variant ? { variant: String(model.variant) } : {}) }
      if (last && modelKey(last.model) === modelKey(clean) && last.basis === basis) return
      append("reviewer_model", { run_id: start.run_id, round_id: start.round_id, reviewer, model: clean, basis })
    },
    async collect(runID, round) {
      const text = savedFile(round, "final-report.md")
      const final = await parse(round, "final-report.md")
      const sources = {}
      const warnings = [final.warning]
      for (const reviewer of reviewers) {
        if (!savedFile(round, `${reviewer}-review.md`, true).trim()) continue
        sources[reviewer] = await parse(round, `${reviewer}-review.md`)
        warnings.push(sources[reviewer].warning)
      }
      const qa = readdirSync(join(round, "results")).flatMap((name) => name.match(/^questions-round-(\d+)\.json$/)?.[1] ?? [])
      const qaRounds = qa.reduce((max, value) => Math.max(max, Number(value)), 0)
      let metrics
      try {
        if (warnings.some(Boolean)) throw new Error("Report parser warnings make candidate counts incomplete")
        metrics = validateReviewStatistics(statisticsSection(text), sources, final.findings, qaRounds)
        if (metrics.agreement.status === "reached" && metrics.agreement.round > 0) {
          const questions = JSON.parse(savedFile(round, `questions-round-${metrics.agreement.round}.json`))
          for (const [reviewer, values] of Object.entries(questions)) {
            if (values.length && (!reviewers.includes(reviewer) || !savedFile(round, `round-${metrics.agreement.round}-${reviewer}-answer.md`, true).trim())) {
              throw new Error("Claimed agreement round has unanswered questions")
            }
          }
        }
      } catch (error) { warnings.push(error.message); metrics = null }
      const snapshot = hash(JSON.stringify([text, Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, value.findings]))]))
      if (hash(savedFile(round, "final-report.md")) !== hash(text)
        || Object.entries(sources).some(([key, value]) => hash(savedFile(round, `${key}-review.md`)) !== value.content_hash)) throw new Error("Review changed during statistics collection")
      const id = roundID(runID, round)
      if (read().events.findLast((event) => event.type === "review_completed" && event.round_id === id)?.snapshot === snapshot) return
      append("review_completed", {
        run_id: runID, round_id: id, snapshot, report_hash: hash(text), verdict: final.verdict, qa_rounds: qaRounds,
        findings: final.findings.map(({ id, title, severity, origin }) => ({ id, title, severity, origin })),
        sources: Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, value.findings.map((finding) => finding.id)])),
        source_titles: Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, Object.fromEntries(value.findings.map(({ id, title }) => [id, title]))])),
        metrics, warning: warnings.filter(Boolean).join("\n"),
      })
    },
    decision(runID, round, { finding_id, status, correctness, reason = "not_assessed" }) {
      const id = roundID(runID, round)
      const events = read().events
      const review = events.filter((event) => event.type === "review_completed" && event.round_id === id).at(-1)
      if (!review) throw new Error("No completed review statistics for this round")
      if (hash(savedFile(round, "final-report.md")) !== review.report_hash) throw new Error("Saved report changed; collect statistics again before recording decisions")
      if (!["pending", "accepted", "rejected", "edited", "added"].includes(status) || correctness !== undefined && !["confirmed", "incorrect", "unassessed"].includes(correctness)
        || !["incorrect", "out_of_scope", "already_fixed", "not_worth_raising", "duplicate", "other", "not_assessed"].includes(reason)) throw new Error("Invalid human review decision")
      const userAdded = /^USER-\d+$/.test(finding_id) && events.some((event) => event.type === "decision" && event.round_id === id && event.snapshot === review.snapshot && event.status === "added" && event.finding_id === finding_id)
      if (status === "added" ? !/^USER-\d+$/.test(finding_id) : !review.findings.some((finding) => finding.id === finding_id) && !userAdded && finding_id !== "*") throw new Error("Finding is not in this review")
      if (reason === "incorrect" && correctness !== "incorrect") throw new Error("An incorrect rejection requires an explicit correctness judgment")
      if (finding_id === "*" && (status !== "accepted" || correctness !== undefined && correctness !== "unassessed" || reason !== "not_assessed")) throw new Error("Bulk acceptance cannot classify correctness")
      const targets = finding_id === "*" ? review.findings.map((finding) => finding.id) : [finding_id]
      for (const target of targets) {
        append("decision", { run_id: runID, round_id: id, snapshot: review.snapshot, finding_id: target, status,
          ...(finding_id !== "*" && correctness !== undefined ? { correctness } : {}), reason })
      }
    },
    finish(runID, round, status) {
      if (!["posted", "skipped", "aborted"].includes(status)) throw new Error("Invalid review outcome")
      append("finished", { run_id: runID, round_id: roundID(runID, round), status })
    },
    summary(options) {
      const { events, unreadable_events } = read()
      return { ...summarizeStatistics(events, options), unreadable_events }
    },
  }
}
