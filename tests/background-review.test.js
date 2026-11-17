import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { createInboxStore, prReference, reconcile } from "../review-inbox.js"
import { backgroundPermissions, createBackgroundReviews, inboxCommand } from "../background-review.js"
import { createReviewState } from "../review-state.js"

const head = "a".repeat(40)
const other = "b".repeat(40)
const binary = fileURLToPath(new URL("../bin/prr-darwin-universal", import.meta.url))
const pr = (number = 1) => ({
  ...prReference(`acme/repo#${number}`), title: `Example ${number}`, url: `https://github.com/acme/repo/pull/${number}`,
  head, requestedAt: "2026-11-17T01:00:00Z", eligible: true,
})

test("enable and disable are deterministic command operations, not model decisions", async () => {
  const calls = []
  const background = { operation: async (...input) => { calls.push(input); return { enabled: input[0].operation === "enable" } } }
  assert.equal(await inboxCommand(background, "", "session"), null)
  assert.deepEqual(await inboxCommand(background, " enable ", "session"), { enabled: true })
  assert.deepEqual(await inboxCommand(background, "disable", "session"), { enabled: false })
  assert.deepEqual(calls, [[{ operation: "enable" }, "session"], [{ operation: "disable" }, "session"]])
  await assert.rejects(inboxCommand(background, "enable later", "session"), /Use \/prr-review-list/)
  await assert.rejects(inboxCommand(null, "enable", "session"), /requires OpenCode 2/)
})

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prr-background-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = createInboxStore(join(root, ".prr"))
  const values = new Map()
  const state = createReviewState({
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => values.set(key, structuredClone(value)),
  }, async () => {})
  const calls = []
  const active = {}
  const sessions = new Map()
  let clock = Date.parse("2026-11-17T10:00:00Z")
  let remote = [pr(), pr(2)]
  let forms = []
  const ctx = {
    location: { directory: root },
    model: { default: async () => ({ location: { directory: root }, data: { providerID: "example", id: "default", privateExtra: "not saved" } }) },
    session: {
      active: async () => ({ ...active }),
      create: async (input) => {
        calls.push(["create", input])
        const session = { id: `session-${sessions.size + 1}`, ...input }
        sessions.set(session.id, session)
        return session
      },
      get: async ({ sessionID }) => {
        if (!sessions.has(sessionID)) throw new Error("Missing session")
        return sessions.get(sessionID)
      },
      update: async (input) => { calls.push(["update", input]); Object.assign(sessions.get(input.sessionID), input) },
      prompt: async (input) => { calls.push(["prompt", input]); active[input.sessionID] = { type: "running" } },
      interrupt: async ({ sessionID }) => { calls.push(["interrupt", sessionID]); delete active[sessionID] },
      wait: async () => {},
      form: {
        list: async () => forms,
        cancel: async (input) => { calls.push(["cancelForm", input]); forms = forms.filter((form) => form.id !== input.formID) },
      },
    },
  }
  const github = {
    discover: async () => { calls.push(["discover"]); return structuredClone(remote) },
    get: async (entry) => structuredClone(remote.find((item) => item.key === entry.key) ?? { ...entry, eligible: false }),
    head: async (entry) => ({ head: remote.find((item) => item.key === entry.key)?.head, open: remote.some((item) => item.key === entry.key && item.eligible) }),
  }
  const manager = () => createBackgroundReviews({
    ctx, store, reviewState: state, binary, resolveRound: (round) => round,
    emit: async (...args) => calls.push(["emit", ...args]),
    install: async (input) => calls.push(["install", input]),
    executable: () => "/bin/opencode",
    github, now: () => clock,
  })
  const worker = manager()
  t.after(() => worker.stop())
  async function enable() {
    store.enable({ directory: root }, { providerID: "example", id: "chosen" })
    await worker.tick()
  }
  async function finish(entry = store.read().entries[0], { codex = true, stage = true } = {}) {
    const round = join(root, `${entry.number}`, "r1")
    mkdirSync(join(round, "results"), { recursive: true })
    const files = {
      "final-report.md": "## Final Report\n\n## Verdict\nAPPROVE\n\n## Confidence\nHIGH\n\n## Findings\n\nNone.\n",
      "diff.txt": "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n",
      "pr-metadata.json": JSON.stringify({ headRefOid: entry.runHead, title: entry.title, url: entry.url }),
      "opencode-review.md": "Native review",
      ...(codex ? { "codex-review.md": "Codex review" } : {}),
    }
    for (const [name, text] of Object.entries(files)) writeFileSync(join(round, "results", name), text)
    await state.context(entry.sessionID, round, "")
    if (stage) {
      for (let step = 1; step < 6; step++) await state.update(entry.sessionID, step, "completed")
      await state.update(entry.sessionID, 6, "in_progress")
    }
    delete active[entry.sessionID]
    return round
  }
  return { root, store, worker, manager, state, calls, active, sessions, ctx, github, enable, finish,
    advance: (minutes) => { clock += minutes * 60_000 },
    remote: (value) => { remote = value },
    forms: (value) => { forms = value },
  }
}

test("worker is inert until enabled and starts only one review", async (t) => {
  const f = fixture(t)
  await f.worker.tick()
  assert.equal(f.calls.length, 0)
  await f.enable()
  await Promise.all([f.worker.tick(), f.worker.tick()])
  const queue = f.store.read()
  assert.equal(queue.entries.filter((entry) => entry.status === "running").length, 1)
  assert.equal(queue.entries.filter((entry) => entry.status === "queued").length, 1)
  assert.equal(f.calls.filter(([name]) => name === "create").length, 1)
  const created = f.calls.find(([name]) => name === "create")[1]
  assert.deepEqual(created.permissions, backgroundPermissions)
  assert.equal(created.model.id, "chosen")
  assert.match(f.calls.find(([name]) => name === "prompt")[1].text, /FULL independent OpenCode and Codex/)
})

test("enable initializes defaults, resolves the model envelope and installs the wake service", async (t) => {
  const f = fixture(t)
  await f.worker.operation({ operation: "enable" }, "inbox")
  await f.worker.tick()
  assert.deepEqual(f.store.config().model, { providerID: "example", id: "default" })
  assert.equal(f.calls.find(([name]) => name === "install")[1].executable, "/bin/opencode")
  assert.equal(f.store.config().poll_minutes, 5)
})

test("disable lets the running review finish but does not fetch or start queued reviews", async (t) => {
  const f = fixture(t)
  await f.enable()
  await f.worker.operation({ operation: "disable" }, "inbox")
  const fetches = f.calls.filter(([name]) => name === "discover").length
  await f.finish()
  f.advance(30)
  await f.worker.tick()
  const result = await f.worker.operation({ operation: "list" }, "inbox")
  assert.equal(result.enabled, false)
  assert.equal(result.rows[0].status, "ready")
  assert.equal(result.rows[0].verdict, "APPROVE")
  assert.equal(result.rows[0].findingsCount, 0)
  assert.equal(result.rows[1].status, "queued")
  assert.equal(f.calls.filter(([name]) => name === "discover").length, fetches)
  assert.equal(f.calls.filter(([name]) => name === "create").length, 1)
  await f.worker.operation({ operation: "enable" }, "inbox")
  await f.worker.tick()
  assert.equal(f.calls.filter(([name]) => name === "create").length, 2)
})

test("poll interval defaults to five minutes and is configurable", async (t) => {
  const f = fixture(t)
  await f.enable()
  f.advance(4)
  await f.worker.tick()
  assert.equal(f.calls.filter(([name]) => name === "discover").length, 1)
  f.advance(1)
  await f.worker.tick()
  assert.equal(f.calls.filter(([name]) => name === "discover").length, 2)
})

test("restart retains checkpoints and retries the same session rather than creating another round", async (t) => {
  const f = fixture(t)
  f.remote([pr()])
  await f.enable()
  const original = f.store.read().entries[0]
  await f.state.update(original.sessionID, 1, "completed")
  await f.state.update(original.sessionID, 2, "completed")
  delete f.active[original.sessionID]
  const restarted = f.manager()
  await restarted.tick()
  assert.equal(f.store.read().entries[0].status, "queued")
  f.advance(5)
  await restarted.tick()
  assert.equal(f.store.read().entries[0].sessionID, original.sessionID)
  assert.equal(f.calls.filter(([name]) => name === "create").length, 1)
  assert.equal((await f.state.get(original.sessionID)).steps[1].status, "completed")
  restarted.stop()
})

test("retry exhaustion flags the PR and lets the next one run", async (t) => {
  const f = fixture(t)
  f.remote([pr()])
  await f.enable()
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt === 3) { f.remote([pr(), pr(2)]); f.advance(5) }
    const entry = f.store.read().entries[0]
    delete f.active[entry.sessionID]
    await f.worker.tick()
    f.advance(30)
    if (attempt < 3) await f.worker.tick()
  }
  assert.equal(f.store.read().entries[0].status, "attention")
  assert.equal(f.store.read().entries[1].status, "running")
})

test("an incomplete two-reviewer result is never ready", async (t) => {
  const f = fixture(t)
  await f.enable()
  await f.finish(undefined, { codex: false })
  await f.worker.tick()
  assert.equal(f.store.read().entries[0].status, "queued")
  assert.equal(f.store.read().entries[0].verdict, undefined)
})

test("new commits invalidate results without changing the original waiting time", async (t) => {
  const f = fixture(t)
  await f.enable()
  await f.finish()
  f.remote([{ ...pr(), head: other }, pr(2)])
  await f.worker.tick()
  const entry = f.store.read().entries[0]
  assert.equal(entry.status, "queued")
  assert.equal(entry.head, other)
  assert.equal(entry.sessionID, null)
  assert.equal(entry.requestedAt, pr().requestedAt)
})

test("opening a running review only navigates; it does not launch or interrupt work", async (t) => {
  const f = fixture(t)
  await f.enable()
  const entry = f.store.read().entries[0]
  assert.equal(await f.worker.reuse("acme/repo#1", "source"), true)
  assert.equal(f.calls.filter(([name]) => name === "prompt").length, 1)
  assert.equal(f.calls.filter(([name]) => name === "interrupt").length, 0)
  assert.equal(f.calls.at(-1)[1], "openSession")
  assert.equal(f.calls.at(-1)[2].sessionID, entry.sessionID)
})

test("unchanged ready reviews resume at briefing and retain unrelated permission rules", async (t) => {
  const f = fixture(t)
  await f.enable()
  const entry = f.store.read().entries[0]
  await f.finish()
  await f.worker.operation({ operation: "disable" }, "inbox")
  await f.worker.tick()
  const extra = { action: "edit", resource: "/private/**", effect: "deny" }
  f.sessions.get(entry.sessionID).permissions = [...backgroundPermissions, extra]
  assert.equal(await f.worker.reuse("acme/repo#1", "source"), true)
  assert.equal(f.calls.filter(([name]) => name === "create").length, 1)
  assert.deepEqual(f.calls.find(([name]) => name === "update")[1].permissions, [extra])
  assert.match(f.calls.filter(([name]) => name === "prompt").at(-1)[1].text, /Phase 6 Review Briefing/)
})

test("approval goes through the existing session and confirmation, never directly to GitHub", async (t) => {
  const f = fixture(t)
  await f.enable()
  await f.finish()
  f.store.disable()
  await f.worker.tick()
  await f.worker.operation({ operation: "approve", key: pr().key }, "inbox")
  const text = f.calls.filter(([name]) => name === "prompt").at(-1)[1].text
  assert.match(text, /INBOX_APPROVAL/)
  assert.equal(f.worker.approval(f.store.read().entries[0].sessionID), true)
  assert.match(text, /LGTM!/)
  assert.match(text, /Ask explicit confirmation/)
  assert.match(text, /no inline comments/)
})

test("stale approvals are blocked even when polling is disabled", async (t) => {
  const f = fixture(t)
  await f.enable()
  await f.finish()
  f.store.disable()
  await f.worker.tick()
  f.remote([{ ...pr(), head: other }])
  await assert.rejects(f.worker.operation({ operation: "approve", key: pr().key }, "inbox"), /changed/)
  assert.equal(f.calls.filter(([name]) => name === "prompt").length, 1)
})

test("a manual start for a changed ready PR requests a fresh review", async (t) => {
  const f = fixture(t)
  await f.enable()
  await f.finish()
  f.store.disable()
  await f.worker.tick()
  f.remote([{ ...pr(), head: other }])
  assert.equal(await f.worker.reuse("acme/repo#1", "manual"), false)
  f.worker.reserve("acme/repo#1", "manual")
  assert.equal(f.store.read().entries[0].sessionID, "manual")
})

test("a changed running automatic review is stopped before a manual replacement starts", async (t) => {
  const f = fixture(t)
  await f.enable()
  f.remote([{ ...pr(), head: other }])
  assert.equal(await f.worker.reuse("acme/repo#1", "manual"), false)
  assert.equal(f.calls.filter(([name]) => name === "interrupt").length, 1)
  f.worker.reserve("acme/repo#1", "manual")
  assert.equal(f.store.read().entries[0].mode, "manual")
})

test("manual reviews remain available while disabled and do not alter unrelated sessions", async (t) => {
  const f = fixture(t)
  f.worker.reserve("acme/repo#8", "manual-a")
  f.worker.reserve("acme/repo#9", "manual-b")
  assert.equal(f.store.config().enabled, false)
  assert.equal(f.store.read().entries.length, 2)
  assert.equal(f.calls.length, 0)
  assert.throws(() => f.worker.reserve("acme/repo#8", "duplicate"), /already has an active/)
})

test("navigation leaves an existing unanswered manual form alone", async (t) => {
  const f = fixture(t)
  await f.enable()
  await f.finish()
  f.store.disable()
  await f.worker.tick()
  f.forms([{ id: "existing" }])
  await f.worker.operation({ operation: "open", key: pr().key }, "inbox")
  assert.equal(f.calls.filter(([name]) => name === "prompt").length, 1)
  assert.equal(f.calls.at(-1)[1], "openSession")
})

test("following a running review reaches the interactive briefing when it finishes", async (t) => {
  const f = fixture(t)
  await f.enable()
  const entry = f.store.read().entries[0]
  await f.worker.operation({ operation: "open", key: entry.key }, "inbox")
  await f.finish()
  f.store.disable()
  await f.worker.tick()
  assert.equal(f.store.read().entries[0].mode, "interactive")
  const prompts = f.calls.filter(([name, input]) => name === "prompt" && input.sessionID === entry.sessionID)
  assert.equal(prompts.length, 2)
  assert.match(prompts.at(-1)[1].text, /Phase 6 Review Briefing/)
  assert.equal(f.calls.at(-1)[2].sourceSessionID, entry.sessionID)
})

test("inbox approval supersedes only the exact briefing menu and queues the handoff before cancellation", async (t) => {
  const f = fixture(t)
  await f.enable()
  const entry = f.store.read().entries[0]
  await f.finish()
  f.store.disable()
  await f.worker.tick()
  f.forms([{
    id: "briefing", sessionID: entry.sessionID, metadata: { kind: "question", tool: { id: "tool-1" } },
    fields: [{ type: "string", description: "Ready to continue from the review briefing?",
      options: ["Continue to review action", "Investigate in diff view", "Investigate in chat", "Explain this briefing", "Stop here"].map((value) => ({ value })) }],
  }])
  await f.worker.operation({ operation: "approve", key: entry.key }, "inbox")
  const promptIndex = f.calls.findIndex(([name, input]) => name === "prompt" && input.text.includes("INBOX_APPROVAL"))
  const cancelIndex = f.calls.findIndex(([name]) => name === "cancelForm")
  assert.ok(promptIndex >= 0 && cancelIndex > promptIndex)
  assert.match(f.calls[cancelIndex][1].message, /does not confirm posting/)
})

test("approval never replaces an unrelated pending question", async (t) => {
  const f = fixture(t)
  await f.enable()
  await f.finish()
  f.store.disable()
  await f.worker.tick()
  f.forms([{ id: "unrelated" }])
  await assert.rejects(f.worker.operation({ operation: "approve", key: pr().key }, "inbox"), /Resolve the pending question/)
  assert.equal(f.calls.filter(([name]) => name === "cancelForm").length, 0)
})

test("successful GitHub submission completes the inbox task immediately", async (t) => {
  const f = fixture(t)
  await f.enable()
  const entry = f.store.read().entries[0]
  f.remote([{ ...pr(), eligible: false, reviewedAt: "2026-11-17T09:00:00Z" }])
  await f.worker.finished(entry.sessionID)
  assert.equal(f.store.read().entries[0].status, "completed")
})
