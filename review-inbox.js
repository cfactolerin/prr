import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { parse, stringify } from "yaml"
import { parseCliJson } from "./cli-json.js"

const execute = promisify(execFile)
const defaults = { enabled: false, poll_minutes: 5, max_attempts: 3, settle_seconds: 60, model: null }
const statuses = ["ready", "running", "queued", "attention"]

export function prReference(text) {
  const match = text.trim().match(/^(?:https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/|([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#)([1-9]\d*)(?:\/)?$/)
  if (!match) return null
  const repository = `${match[1] ?? match[3]}/${match[2] ?? match[4]}`
  if (repository.split("/").some((part) => part === "." || part === "..") || !Number.isSafeInteger(Number(match[5]))) return null
  return { key: `${repository}#${match[5]}`.toLowerCase(), repository, number: Number(match[5]) }
}

function regular(path) {
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("PRR inbox files must be regular files")
}

function atomic(path, value) {
  regular(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, value, { mode: 0o600, flag: "wx" })
    renameSync(temporary, path)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function createInboxStore(directory) {
  const configPath = join(directory, "background.yml")
  const queuePath = join(directory, "review-queue.json")
  const lock = join(directory, "review-queue.lock")
  function config() {
    regular(configPath)
    const value = { ...defaults, ...(existsSync(configPath) ? parse(readFileSync(configPath, "utf8")) : {}) }
    if (typeof value.enabled !== "boolean" || !Number.isFinite(value.poll_minutes) || value.poll_minutes < 1
      || !Number.isInteger(value.max_attempts) || value.max_attempts < 1 || value.max_attempts > 10
      || !Number.isInteger(value.settle_seconds) || value.settle_seconds < 0 || value.settle_seconds > 3600
      || value.model !== null && (!value.model?.providerID || !value.model?.id)) {
      throw new Error("Invalid PRR background configuration; check background.yml")
    }
    return value
  }
  function read() {
    regular(queuePath)
    const value = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, "utf8")) : { version: 1, entries: [] }
    if (value.version !== 1 || !Array.isArray(value.entries)) throw new Error("Unsupported PRR review queue; the saved file was left unchanged")
    return value
  }
  function transaction(change) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    try {
      mkdirSync(lock)
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      if (!lstatSync(lock).isDirectory() || lstatSync(lock).isSymbolicLink()) throw new Error("Invalid PRR inbox lock directory")
      let owner
      try { owner = Number(readFileSync(join(lock, "pid"), "utf8")) } catch { /* Check the short creation window below. */ }
      let alive = true
      if (owner) {
        try { process.kill(owner, 0) } catch (error) { alive = error.code !== "ESRCH" }
      } else if (Date.now() - lstatSync(lock).mtimeMs > 10_000) alive = false
      if (alive) throw new Error("PRR inbox is busy; retry shortly")
      rmSync(join(lock, "pid"), { force: true })
      rmdirSync(lock)
      mkdirSync(lock)
    }
    try {
      writeFileSync(join(lock, "pid"), String(process.pid), { mode: 0o600, flag: "wx" })
      const value = read()
      const result = change(value)
      atomic(queuePath, JSON.stringify(value, null, 2) + "\n")
      return result
    } finally {
      rmSync(join(lock, "pid"), { force: true })
      rmdirSync(lock)
    }
  }
  return {
    directory, configPath, queuePath, config, read, transaction,
    enable(owner, model) {
      return transaction((queue) => {
        const current = config()
        atomic(configPath, stringify({ ...current, enabled: true, model: current.model ?? model }))
        queue.owner = owner
        queue.lastPoll = null
        const runtimePath = join(directory, "config.yml")
        if (!existsSync(runtimePath)) writeFileSync(runtimePath, "workspace_path: ~/.prr/workspace\nagents:\n  - opencode\n  - codex\n", { flag: "wx", mode: 0o600 })
      })
    },
    disable() {
      return transaction(() => atomic(configPath, stringify({ ...config(), enabled: false })))
    },
  }
}

export function inboxRows(queue, now = Date.now()) {
  return queue.entries.filter((entry) => statuses.includes(entry.status)).sort((a, b) =>
    statuses.indexOf(a.status) - statuses.indexOf(b.status)
      || Date.parse(a.requestedAt) - Date.parse(b.requestedAt)
      || a.key.localeCompare(b.key),
  ).map((entry, index, entries) => ({
    ...entry,
    waitingHours: entry.waitingUnknown ? null : Math.max(0, (now - Date.parse(entry.requestedAt)) / 3_600_000),
    ...(entry.status === "queued" ? { position: entries.slice(0, index + 1).filter((row) => row.status === "queued").length } : {}),
  }))
}

export function reconcile(queue, snapshots, now = Date.now(), settleSeconds = 60) {
  for (const pr of snapshots) {
    let entry = queue.entries.find((candidate) => candidate.key === pr.key)
    if (pr.discoveryError) {
      if (!entry) {
        entry = { ...pr, requestedAt: new Date(now).toISOString(), waitingUnknown: true, status: "attention", attempts: 0 }
        queue.entries.push(entry)
      }
      if (entry.status !== "running") entry.status = "attention"
      entry.discoveryError = true
      entry.reason = "Could not check this PR's request history. Check GitHub access or open it manually; other reviews can continue."
      continue
    }
    if (!entry && !pr.eligible) continue
    if (!entry) {
      entry = { key: pr.key, status: "queued", attempts: 0, requestedAt: pr.requestedAt }
      queue.entries.push(entry)
    }
    if (entry.discoveryError) {
      delete entry.discoveryError
      delete entry.reason
      if (entry.waitingUnknown) entry.requestedAt = pr.requestedAt
      delete entry.waitingUnknown
      if (entry.status === "attention" && pr.eligible) entry.status = "queued"
    }
    const newCycle = pr.reviewedAt && pr.requestedAt > pr.reviewedAt && entry.requestedAt <= pr.reviewedAt
    if (newCycle) {
      entry.requestedAt = pr.requestedAt
      entry.completedAt = pr.reviewedAt
      if (entry.status !== "running") {
        entry.status = "queued"
        entry.sessionID = null
        entry.attempts = 0
        entry.retryAt = null
      }
      delete entry.verdict
      delete entry.findingsCount
    }
    if (pr.eligible && entry.waitingUnknown) {
      entry.requestedAt = pr.requestedAt
      delete entry.waitingUnknown
    }
    const changed = entry.head && entry.head !== pr.head || entry.baseBranch && pr.baseBranch && entry.baseBranch !== pr.baseBranch
    const requestedAgain = pr.requestedAt > (entry.completedAt ?? pr.requestedAt)
    Object.assign(entry, { repository: pr.repository, number: pr.number, title: pr.title, url: pr.url, head: pr.head, baseBranch: pr.baseBranch })
    if (entry.mode === "manual" && !pr.eligible && !pr.reviewedAt) continue
    if (!pr.eligible) {
      if (entry.status !== "running") entry.status = pr.reviewedAt ? "completed" : "inactive"
      entry.eligible = false
      if (pr.reviewedAt) entry.completedAt = pr.reviewedAt
      continue
    }
    entry.eligible = true
    if (entry.status === "completed" && !requestedAgain) continue
    if (["completed", "inactive"].includes(entry.status)) {
      entry.requestedAt = pr.requestedAt
      entry.status = "queued"
      entry.attempts = 0
      entry.retryAt = null
      entry.sessionID = null
    } else if (changed && entry.status !== "running") {
      // Keep the previous session as history; never replace a human's investigation.
      entry.status = "queued"
      entry.attempts = 0
      entry.retryAt = now + settleSeconds * 1000
      entry.sessionID = null
    }
    if (changed) {
      entry.changedAt = new Date(now).toISOString()
      delete entry.verdict
      delete entry.findingsCount
    }
  }
}

export function requestSnapshot(pr, timeline, reviews, login, teamIDs) {
  const repository = pr.base.repo.full_name
  const reference = prReference(`${repository}#${pr.number}`)
  if (!reference || !/^[0-9a-f]{40}$/i.test(pr.head.sha)) throw new Error("GitHub returned an invalid PR identity")
  const reviewedAt = reviews.filter((review) => review.user?.login?.toLowerCase() === login.toLowerCase() && review.submitted_at)
    .map((review) => review.submitted_at).sort().at(-1)
  const outstanding = new Map()
  let readyAt = pr.created_at
  for (const event of timeline) {
    if (event.event === "ready_for_review") readyAt = event.created_at
    const reviewer = event.requested_reviewer?.login
    const team = event.requested_team?.id
    const target = reviewer?.toLowerCase() === login.toLowerCase() ? `user:${login.toLowerCase()}`
      : teamIDs.has(team) ? `team:${team}` : null
    if (!target) continue
    if (event.event === "review_requested") outstanding.set(target, event.created_at)
    if (event.event === "review_request_removed") outstanding.delete(target)
  }
  const requested = pr.requested_reviewers?.some((user) => user.login.toLowerCase() === login.toLowerCase())
    || pr.requested_teams?.some((team) => teamIDs.has(team.id))
  const times = [...outstanding.values()].filter((time) => !reviewedAt || time > reviewedAt)
  const requestTime = times.sort()[0]
  // Missing history after a submitted review must not reopen a lingering team request.
  const eligible = pr.state === "open" && !pr.draft && pr.user.login.toLowerCase() !== login.toLowerCase()
    && requested && (!reviewedAt || !!requestTime)
  return {
    ...reference, title: pr.title, url: pr.html_url, head: pr.head.sha, baseBranch: pr.base.ref, eligible, reviewedAt,
    requestedAt: [requestTime ?? pr.created_at, readyAt].sort().at(-1),
  }
}

export function createGitHubInbox(run = async (args) => {
  try {
    const { stdout } = await execute("gh", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 32 * 1024 * 1024 })
    return parseCliJson(stdout)
  } catch {
    throw new Error("GitHub review discovery failed. Check gh authentication, team access, connectivity, and rate limits.")
  }
}) {
  async function identity() {
    const user = await run(["api", "user"])
    const teams = (await run(["api", "user/teams?per_page=100", "--paginate", "--slurp"])).flat()
    return { login: user.login, teams, teamIDs: new Set(teams.map((team) => team.id)) }
  }
  async function snapshot(reference, who) {
    const root = `repos/${reference.repository}`
    const pr = await run(["api", `${root}/pulls/${reference.number}`])
    const timeline = (await run(["api", `${root}/issues/${reference.number}/timeline?per_page=100`, "--paginate", "--slurp"])).flat()
    const reviews = (await run(["api", `${root}/pulls/${reference.number}/reviews?per_page=100`, "--paginate", "--slurp"])).flat()
    return requestSnapshot(pr, timeline, reviews, who.login, who.teamIDs)
  }
  return {
    identity,
    async head(reference) {
      const pr = await run(["api", `repos/${reference.repository}/pulls/${reference.number}`])
      return { head: pr.head.sha, baseBranch: pr.base.ref, open: pr.state === "open" && !pr.draft }
    },
    async get(reference) { return snapshot(reference, await identity()) },
    async discover(existing = []) {
      const who = await identity()
      const refs = new Map(existing.map((entry) => [entry.key, entry]))
      const queries = [`user-review-requested:${who.login}`, ...who.teams.map((team) => `team-review-requested:${team.organization.login}/${team.slug}`)]
      for (const qualifier of queries) {
        const pages = await run(["api", "--method", "GET", "search/issues", "-f", `q=is:pr is:open draft:false ${qualifier} -author:${who.login}`, "-f", "per_page=100", "--paginate", "--slurp"])
        if (pages.some((page) => page.incomplete_results || page.total_count > 1000)) throw new Error("GitHub returned an incomplete review-request search; narrow access or retry before continuing.")
        for (const issue of pages.flatMap((page) => page.items)) {
          const ref = prReference(issue.html_url)
          if (ref) refs.set(ref.key, { ...ref, title: issue.title, url: issue.html_url })
        }
      }
      const snapshots = []
      for (const reference of refs.values()) {
        try { snapshots.push(await snapshot(reference, who)) }
        catch { snapshots.push({ ...reference, discoveryError: true }) }
      }
      return snapshots
    },
  }
}
