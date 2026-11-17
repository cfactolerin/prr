import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createGitHubInbox, createInboxStore, inboxRows, prReference, reconcile, requestSnapshot } from "../review-inbox.js"
import { backgroundServicePlist, createOpenCodeControl } from "../background-service.js"

const head = "a".repeat(40)
const day = (hour) => `2026-11-17T${String(hour).padStart(2, "0")}:00:00Z`
const snapshot = (number = 1, extra = {}) => ({
  ...prReference(`acme/repo#${number}`), title: `PR ${number}`, url: `https://github.com/acme/repo/pull/${number}`,
  head, requestedAt: day(1), eligible: true, ...extra,
})
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "prr-inbox-"))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return createInboxStore(directory)
}

test("inbox viewing is read-only and disabled by default", (t) => {
  const store = fixture(t)
  assert.equal(store.config().enabled, false)
  assert.equal(store.config().poll_minutes, 5)
  assert.deepEqual(store.read().entries, [])
  assert.equal(existsSync(store.queuePath), false)
  assert.equal(existsSync(store.configPath), false)
})

test("first enable writes private readable defaults and preserves existing runtime configuration", (t) => {
  const store = fixture(t)
  const path = join(store.directory, "config.yml")
  writeFileSync(path, "codex_model: custom-model\nworkspace_path: /custom/path\n")
  const existing = readFileSync(path, "utf8")
  store.enable({ directory: "/repo" }, { providerID: "example", id: "model" })
  assert.equal(readFileSync(path, "utf8"), existing)
  assert.equal(store.config().enabled, true)
  assert.equal(store.config().max_attempts, 3)
  assert.deepEqual(store.config().model, { providerID: "example", id: "model" })
  assert.equal(statSync(store.queuePath).mode & 0o777, 0o600)
  assert.equal(statSync(store.configPath).mode & 0o777, 0o600)
  writeFileSync(store.configPath, "enabled: false\npoll_minutes: 12\nmax_attempts: 2\nmodel:\n  providerID: custom\n  id: chosen\n")
  store.enable({ directory: "/repo" }, { providerID: "other", id: "ignored" })
  assert.equal(store.config().poll_minutes, 12)
  assert.equal(store.config().model.id, "chosen")
  store.disable()
  assert.equal(store.config().enabled, false)
  assert.equal(store.config().poll_minutes, 12)
})

test("first enable needs no preexisting PRR runtime settings", (t) => {
  const store = fixture(t)
  store.enable({ directory: "/repo" }, null)
  assert.match(readFileSync(join(store.directory, "config.yml"), "utf8"), /agents:\n  - opencode\n  - codex/)
  assert.equal(store.config().model, null)
})

test("queue refuses corrupt versions and symlinks instead of overwriting them", (t) => {
  const store = fixture(t)
  writeFileSync(store.queuePath, '{"version":77,"entries":[]}')
  assert.throws(() => store.transaction(() => {}), /Unsupported/)
  assert.equal(readFileSync(store.queuePath, "utf8"), '{"version":77,"entries":[]}')
  rmSync(store.queuePath)
  const other = join(store.directory, "other")
  writeFileSync(other, "{}")
  symlinkSync(other, store.queuePath)
  assert.throws(() => store.read(), /regular files/)
  assert.equal(readFileSync(other, "utf8"), "{}")
})

test("live queue locks are respected", (t) => {
  const store = fixture(t)
  const lock = join(store.directory, "review-queue.lock")
  mkdirSync(lock)
  writeFileSync(join(lock, "pid"), String(process.pid))
  assert.throws(() => store.transaction(() => {}), /busy/)
  assert.equal(existsSync(store.queuePath), false)
})

test("references are strict and normalize personal/team duplicates", () => {
  assert.equal(prReference("https://github.com/Acme/Repo/pull/12").key, prReference("acme/repo#12").key)
  for (const value of ["owner/repo#0", "owner/repo#1 --ticket X", "https://other.test/a/b/pull/1", "../../file#1", "a/b#1\nrun command"]) {
    assert.equal(prReference(value), null, value)
  }
})

test("deduplication and new heads preserve waiting age, decisions and previous sessions", () => {
  const queue = { entries: [] }
  reconcile(queue, [snapshot(), snapshot()])
  assert.equal(queue.entries.length, 1)
  Object.assign(queue.entries[0], { status: "ready", sessionID: "old", verdict: "APPROVE", findingsCount: 0 })
  reconcile(queue, [snapshot(1, { head: "b".repeat(40), requestedAt: day(5) })])
  assert.equal(queue.entries[0].status, "queued")
  assert.equal(queue.entries[0].requestedAt, day(1))
  assert.equal(queue.entries[0].sessionID, null)
  assert.equal(queue.entries[0].verdict, undefined)
})

test("new pushes do not replace running review sessions", () => {
  const queue = { entries: [{ ...snapshot(), status: "running", runHead: head, sessionID: "running" }] }
  reconcile(queue, [snapshot(1, { head: "b".repeat(40) })])
  assert.equal(queue.entries[0].sessionID, "running")
  assert.equal(queue.entries[0].runHead, head)
  assert.equal(queue.entries[0].head, "b".repeat(40))
})

test("completed reviews reopen only for a fresh request", () => {
  const queue = { entries: [{ ...snapshot(), status: "completed", completedAt: day(4), sessionID: "old" }] }
  reconcile(queue, [snapshot(1, { head: "b".repeat(40) })])
  assert.equal(queue.entries[0].status, "completed")
  reconcile(queue, [snapshot(1, { requestedAt: day(6) })])
  assert.equal(queue.entries[0].status, "queued")
  assert.equal(queue.entries[0].requestedAt, day(6))
  assert.equal(queue.entries[0].sessionID, null)
})

test("a review submitted and re-requested between polls starts a new waiting period", () => {
  const queue = { entries: [{ ...snapshot(), status: "ready", sessionID: "old", verdict: "APPROVE", findingsCount: 0 }] }
  reconcile(queue, [snapshot(1, { reviewedAt: day(4), requestedAt: day(6) })])
  assert.equal(queue.entries[0].status, "queued")
  assert.equal(queue.entries[0].requestedAt, day(6))
  assert.equal(queue.entries[0].sessionID, null)
  assert.equal(queue.entries[0].verdict, undefined)
})

test("one inaccessible PR does not block other requests and its unknown age is not invented", () => {
  const queue = { entries: [] }
  reconcile(queue, [{ ...snapshot(), discoveryError: true }, snapshot(2)])
  assert.equal(queue.entries[0].status, "attention")
  assert.equal(inboxRows(queue).find((row) => row.number === 1).waitingHours, null)
  assert.equal(queue.entries[1].status, "queued")
  reconcile(queue, [snapshot()])
  assert.equal(queue.entries[0].status, "queued")
  assert.equal(queue.entries[0].requestedAt, day(1))
})

test("retargeting the base branch invalidates an otherwise unchanged review", () => {
  const queue = { entries: [{ ...snapshot(), baseBranch: "main", status: "ready", sessionID: "old" }] }
  reconcile(queue, [{ ...snapshot(), baseBranch: "release" }])
  assert.equal(queue.entries[0].status, "queued")
  assert.equal(queue.entries[0].sessionID, null)
})

test("display order is ready, running, queued, attention with waiting hours and queue positions", () => {
  const queue = { entries: [
    { ...snapshot(1), status: "queued", requestedAt: day(2) },
    { ...snapshot(2), status: "attention" },
    { ...snapshot(3), status: "ready", requestedAt: day(5) },
    { ...snapshot(4), status: "running" },
    { ...snapshot(5), status: "ready" },
    { ...snapshot(6), status: "queued" },
    { ...snapshot(7), status: "completed" },
  ] }
  const rows = inboxRows(queue, Date.parse(day(10)))
  assert.deepEqual(rows.map((row) => row.number), [5, 3, 4, 6, 1, 2])
  assert.equal(rows[0].waitingHours, 9)
  assert.deepEqual(rows.filter((row) => row.status === "queued").map((row) => row.position), [1, 2])
})

const pr = () => ({
  number: 1, base: { repo: { full_name: "acme/repo" } }, title: "Example", head: { sha: head },
  state: "open", draft: false, user: { login: "author" }, created_at: day(0),
  requested_reviewers: [{ login: "me" }], requested_teams: [{ id: 3 }],
  html_url: "https://github.com/acme/repo/pull/1",
})
const event = (hour, target = { requested_reviewer: { login: "me" } }) => ({ event: "review_requested", created_at: day(hour), ...target })

test("request age uses first matching request and ready-for-review time, not creation", () => {
  const timeline = [event(1, { requested_team: { id: 3 } }), { event: "ready_for_review", created_at: day(3) }, event(5)]
  const value = requestSnapshot(pr(), timeline, [], "me", new Set([3]))
  assert.equal(value.requestedAt, day(3))
  assert.equal(value.eligible, true)
})

test("drafts, own PRs, closed PRs and unrequested PRs are not eligible", () => {
  for (const extra of [{ draft: true }, { state: "closed" }, { user: { login: "ME" } }, { requested_reviewers: [], requested_teams: [] }]) {
    assert.equal(requestSnapshot({ ...pr(), ...extra }, [event(1)], [], "me", new Set([3])).eligible, false)
  }
})

test("lingering team requests and commits do not reopen a submitted review, explicit re-requests do", () => {
  const review = { user: { login: "me" }, submitted_at: day(4) }
  const teamEvent = event(1, { requested_team: { id: 3 } })
  assert.equal(requestSnapshot(pr(), [teamEvent], [review], "me", new Set([3])).eligible, false)
  const again = requestSnapshot(pr(), [teamEvent, event(6)], [review], "me", new Set([3]))
  assert.equal(again.eligible, true)
  assert.equal(again.requestedAt, day(6))
})

test("discovery watches every team, paginates and fetches a duplicate PR once", async () => {
  const calls = []
  const github = createGitHubInbox(async (args) => {
    calls.push(args)
    const endpoint = args.find((arg) => arg === "user" || arg.startsWith("user/") || arg.startsWith("repos/") || arg === "search/issues")
    if (endpoint === "user") return { login: "me" }
    if (endpoint?.startsWith("user/teams")) return [[{ id: 3, slug: "team", organization: { login: "acme" } }], [{ id: 4, slug: "other", organization: { login: "other" } }]]
    if (endpoint === "search/issues") return [{ total_count: 1, incomplete_results: false, items: [{ html_url: pr().html_url }] }]
    if (endpoint?.includes("/timeline")) return [[event(1)], [event(3)]]
    if (endpoint?.endsWith("/reviews?per_page=100")) return [[]]
    return pr()
  })
  const values = await github.discover()
  assert.equal(values.length, 1)
  assert.equal(calls.filter((args) => args.includes("repos/acme/repo/pulls/1")).length, 1)
  assert.ok(calls.some((args) => args.some((arg) => arg.includes("team-review-requested:acme/team"))))
  assert.ok(calls.some((args) => args.some((arg) => arg.includes("team-review-requested:other/other"))))
  assert.ok(calls.filter((args) => args.includes("search/issues")).every((args) => args.includes("--paginate")))
})

test("macOS scheduler uses authenticated CLI discovery, encoded location and safe XML arguments", () => {
  const content = backgroundServicePlist({ executable: "/Apps/OpenCode & tools/opencode", directory: "/repo & stuff", path: "/usr/bin:/bin" })
  assert.match(content, /OpenCode &amp; tools/)
  assert.match(content, /\/api\/rpc\/prr\.review\/wake/)
  assert.match(content, /location%5Bdirectory%5D=%2Frepo%20%26%20stuff/)
  assert.match(content, /\{&quot;input&quot;:\{\}\}/)
  assert.match(content, /<integer>60<\/integer>/)
  assert.doesNotMatch(content, /bash|zsh|TOKEN|PASSWORD/)
})

test("missing plugin session APIs use the authenticated CLI with the published HTTP contract", async () => {
  const calls = []
  const control = createOpenCodeControl({
    executable: () => "/bin/opencode",
    run: async (file, args) => {
      calls.push([file, args])
      if (args[2] === "/api/session/active") return { stdout: '{"data":{"session-1":{"type":"running"}}}' }
      if (args[1] === "delete") return { stdout: "" }
      return { stdout: '{"data":[{"id":"form-1"}]}' }
    },
  })
  assert.deepEqual(await control.active(), { "session-1": { type: "running" } })
  assert.deepEqual(await control.forms({ sessionID: "session-1" }), [{ id: "form-1" }])
  await control.cancel({ sessionID: "session-1", formID: "form-1", message: "Navigate without a decision" })
  assert.deepEqual(calls[2], ["/bin/opencode", ["api", "delete", "/api/session/session-1/form/form-1", "--data", '{"message":"Navigate without a decision"}']])
})
