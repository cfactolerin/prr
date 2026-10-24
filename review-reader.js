import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import { diffFiles, findingRows, referencePatch, safeRepoPath } from "./review-diff.js"
import { investigationReady } from "./review-state.js"

const execute = promisify(execFile)
const limit = 32 * 1024 * 1024

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

export function createReviewReader({ state, resolveRound, binary }) {
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
    const result = { snapshot, round, report, files, metadata: metadataText ? JSON.parse(metadataText) : {}, warnings: stderr.trim() }
    if (cache.size >= 32) cache.delete(cache.keys().next().value)
    cache.set(sessionID, result)
    return result
  }

  return {
    async investigation({ sessionID }) {
      const result = await load(sessionID)
      return {
        snapshot: result.snapshot, round: basename(result.round), verdict: result.report.verdict, confidence: result.report.confidence,
        findings: result.report.findings.map((finding) => ({ ...finding, fileID: result.files.find((file) => file.path === finding.path)?.id })),
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
