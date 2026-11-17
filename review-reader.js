import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import { diffFiles, findingRows, referencePatch, safeRepoPath } from "./review-diff.js"
import { investigationReady } from "./review-state.js"

const execute = promisify(execFile)
const limit = 32 * 1024 * 1024
const hash = (text) => createHash("sha256").update(text).digest("hex")

export function relatedConversations(threads, finding, head, overriddenBody) {
  const normalize = (text) => (text ?? "").replace(/^\*\*Pre-existing:\*\* this predates the PR, so fixing it here is optional\.\s*/, "").trim().replace(/\s+/g, " ")
  const bodies = [finding.suggested_comment, overriddenBody].filter((body) => body?.trim()).map(normalize)
  return threads.flatMap((thread) => {
    if (!Number.isSafeInteger(thread.id) || thread.id < 1 || thread.file !== `github-discussions/thread-${thread.id}.md`) return []
    const exact = bodies.includes(normalize(thread.root_body)) && thread.path === finding.path
    const location = thread.path === finding.path && thread.side === "RIGHT" && head && thread.commit_id === head
      && Number.isSafeInteger(thread.line) && thread.line >= 1 && Number.isSafeInteger(finding.line)
      && (thread.start_line ?? thread.line) <= finding.line && (finding.start_line ?? finding.line) <= thread.line
    if (!exact && !location) return []
    return [{ id: thread.id, file: thread.file, match: exact ? "comment" : "possible_location" }]
  })
}

function saveDecisions(result, saved) {
  const target = join(result.round, "results/finding-decisions.json")
  try {
    if (!lstatSync(target).isFile()) throw new Error("Saved decisions must be a regular file")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  const content = JSON.stringify({ version: 1, ...result.history, revision: saved.revision, decisions: saved.decisions })
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("Saved decisions exceed the 2 MiB round-history limit")
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 })
    renameSync(temporary, target)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function artifact(round, name, optional = false) {
  const path = join(round, "results", name)
  try {
    if (realpathSync(path) !== path || !statSync(path).isFile() || statSync(path).size > limit) {
      throw new Error("Invalid saved review artifact or artifact exceeds the 32 MiB viewer limit")
    }
    return readFileSync(path, "utf8")
  } catch (error) {
    if (optional && error.code === "ENOENT") return ""
    throw new Error(`Cannot load saved ${name}: ${error.message}`)
  }
}

export function createReviewReader({ state, resolveRound, binary, onDecision = async () => {} }) {
  const cache = new Map()
  async function load(sessionID) {
    const saved = await state.get(sessionID)
    if (!investigationReady(saved)) throw new Error("Continue from the review briefing before opening diff investigation")
    if (!saved.round) throw new Error("No saved review round is bound to this session")
    const round = resolveRound(saved.round)
    const reportText = artifact(round, "final-report.md")
    const diff = artifact(round, "diff.txt")
    const metadataText = artifact(round, "pr-metadata.json", true)
    const snapshot = createHash("sha256").update(JSON.stringify([round, reportText, diff, metadataText])).digest("hex")
    if (cache.get(sessionID)?.snapshot === snapshot) return cache.get(sessionID)
    const { stdout, stderr } = await execute(binary, ["parse-report", join(round, "results/final-report.md"), "--diff", join(round, "results/diff.txt")], {
      timeout: 30_000, maxBuffer: limit, encoding: "utf8",
    })
    if (artifact(round, "final-report.md") !== reportText || artifact(round, "diff.txt") !== diff) {
      throw new Error("The saved review changed while loading; reopen diff investigation")
    }
    const latest = await state.get(sessionID)
    if (latest?.round !== saved.round || !investigationReady(latest)) throw new Error("The review round changed; reopen diff investigation")
    const report = JSON.parse(stdout)
    const files = diffFiles(diff)
    const result = {
      snapshot, round, report, files, metadata: metadataText ? JSON.parse(metadataText) : {}, warnings: stderr.trim(),
      history: { report_sha256: hash(reportText), diff_sha256: hash(diff), metadata_sha256: hash(metadataText) },
    }
    if (cache.size >= 32) cache.delete(cache.keys().next().value)
    cache.set(sessionID, result)
    return result
  }

  async function findingState(sessionID, result, update, onSaved) {
    const saved = await state.findings(sessionID, result.round, result.snapshot, update, () => {
      const snapshot = createHash("sha256").update(JSON.stringify([result.round, artifact(result.round, "final-report.md"), artifact(result.round, "diff.txt"), artifact(result.round, "pr-metadata.json", true)])).digest("hex")
      if (snapshot !== result.snapshot) throw new Error("The saved report changed; refresh findings")
    }, onSaved)
    return {
      snapshot: saved.snapshot, revision: saved.revision,
      decisions: Object.entries(saved.decisions).map(([finding_id, value]) => ({ finding_id, ...value })),
      ...(saved.warning ? { warning: saved.warning } : {}),
      ...(saved.activeFindingID ? { active_finding_id: saved.activeFindingID, focus_request: saved.focusRequest } : {}),
    }
  }
  async function findings({ sessionID, operation = "get", snapshot, findingID, status, overriddenBody, revision }) {
    const result = await load(sessionID)
    if (!["get", "focus", "decision"].includes(operation)) throw new Error("Invalid findings operation")
    if (operation !== "get" && result.snapshot !== snapshot) throw new Error("The saved report changed; refresh findings")
    if (operation !== "get" && !result.report.findings.some((finding) => finding.id === findingID)) throw new Error("Finding is not in the saved report")
    if (operation !== "get" && result.report.findings.filter((finding) => finding.id === findingID).length !== 1) throw new Error("Finding ID is ambiguous in the saved report")
    if (operation === "decision" && (!["pending", "accepted", "rejected", "edited"].includes(status)
      || !Number.isInteger(revision) || revision < 0
      || status === "edited" && (typeof overriddenBody !== "string" || !overriddenBody.trim() || overriddenBody.length > 64 * 1024)
      || status !== "edited" && overriddenBody !== undefined)) throw new Error("Invalid finding decision")
    const saved = await findingState(sessionID, result, operation === "get" ? undefined : (value) => {
      if (operation === "focus") {
        value.activeFindingID = findingID
        value.focusRequest = crypto.randomUUID()
      } else {
        if (value.revision !== revision) throw new Error("Finding decisions changed; reload them before deciding")
        value.decisions = { ...value.decisions, [findingID]: { status, ...(status === "edited" ? { overridden_body: overriddenBody } : {}) } }
        value.revision++
      }
    }, operation === "focus" ? undefined : async (value) => {
      const warnings = []
      try { if (Object.keys(value.decisions).length) saveDecisions(result, value) }
      catch (error) { warnings.push(`Round history warning: ${error.message}. This decision may be missing from the next round.`) }
      try { if (operation === "decision") await onDecision({ sessionID, round: result.round, finding_id: findingID, status }) }
      catch (error) { warnings.push(`Statistics warning: ${error.message}`) }
      if (warnings.length) return `${operation === "decision" ? "Decision saved." : "Shared decisions retained."} ${warnings.join(" ")}`
    })
    if (operation === "focus") {
      const source = join(result.round, "results/github-discussions.md")
      try {
        const discussion = artifact(result.round, "github-discussions.json", true)
        const data = discussion ? JSON.parse(discussion) : null
        const finding = result.report.findings.find((item) => item.id === findingID)
        saved.github_conversations = {
          source,
          matches: relatedConversations(data?.threads ?? [], finding, result.metadata.headRefOid,
            saved.decisions.find((item) => item.finding_id === findingID)?.overridden_body)
            .map(({ file, ...match }) => ({ ...match, filePath: join(result.round, "results", file) })),
          ...(data ? { unavailable: data.unavailable ?? [] } : { warning: "No GitHub discussion snapshot is available for this saved round." }),
        }
      } catch {
        saved.github_conversations = { source, matches: [], warning: "GitHub discussion matching is unavailable; inspect the saved discussion with bounded reads." }
      }
    }
    return saved
  }
  return {
    findings,
    async decide(input) {
      if (!["accepted", "rejected"].includes(input.status)) throw new Error("The diff view can only accept or reject findings")
      return findings({ ...input, operation: "decision" })
    },
    async investigation({ sessionID }) {
      const result = await load(sessionID)
      const saved = await findingState(sessionID, result)
      return {
        ...saved,
        snapshot: result.snapshot, round: basename(result.round), verdict: result.report.verdict, confidence: result.report.confidence,
        findings: result.report.findings.map((finding) => {
          const file = result.files.find((file) => file.path === finding.path)
          return { ...finding, ...(file ? { fileID: file.id } : {}) }
        }),
        files: result.files.map(({ patch: _patch, ...file }) => file), warnings: result.warnings,
      }
    },
    async diff({ sessionID, snapshot, fileID, findingID }) {
      const result = await load(sessionID)
      if (result.snapshot !== snapshot) throw new Error("The review round or report changed; refresh diff investigation")
      const finding = findingID === undefined ? null : result.report.findings.find((item) => item.id === findingID)
      if (findingID !== undefined && !finding) throw new Error("Finding is not in the saved report")
      const file = fileID === undefined ? null : result.files.find((item) => item.id === fileID)
      if (fileID !== undefined && !file) throw new Error("File is not in the saved diff")
      if (!file && !finding) return { patch: "", path: "", mode: "none", message: "No changed file selected." }
      if (finding && file && finding.path !== file.path) throw new Error("Finding does not belong to this file")
      if (finding?.anchor === "none") return { patch: "", path: "", mode: "none", message: "This finding has no code location." }
      const selected = file ?? result.files.find((item) => item.path === finding?.path)
      if (selected && (!finding || findingRows(selected.patch, finding).length)) {
        return {
          patch: selected.patch, path: selected.path, mode: "diff",
          message: selected.binary ? "Binary change — no text diff is available."
            : !/^@@ /m.test(selected.patch) ? "Metadata-only change — no text hunks." : "",
        }
      }
      if (finding?.anchor === "reference" && safeRepoPath(finding.path) && /^[a-f\d]{40,64}$/i.test(result.metadata.headRefOid ?? "")) {
        const repo = join(result.round, "repo")
        if (realpathSync(repo) !== repo) throw new Error("Invalid saved repository")
        try {
          const { stdout } = await execute("git", ["--no-pager", "show", `${result.metadata.headRefOid}:${finding.path}`], {
            cwd: repo, timeout: 10_000, maxBuffer: limit, encoding: "utf8", env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
          })
          if ((await load(sessionID)).snapshot !== snapshot) throw new Error("The review changed; refresh diff investigation")
          const patch = referencePatch(finding.path, stdout, finding.line, finding.start_line)
          if (patch) return { patch, path: finding.path, mode: "reference", message: "Unchanged reference context at the saved PR head — not a changed hunk." }
        } catch {
          return { patch: "", path: finding.path, mode: "none", message: "Reference context is unavailable in the saved PR head. Return to chat to investigate." }
        }
      }
      return { patch: "", path: finding?.path ?? "", mode: "none", message: "The finding's code location is unavailable in this snapshot. Return to chat to investigate." }
    },
  }
}
