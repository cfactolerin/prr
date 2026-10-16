import assert from "node:assert/strict"
import { test } from "node:test"
import { requestReviewExit } from "../v2-exit.js"
import { createReviewLifecycle } from "../v2-lifecycle.js"

function fakeExitHost({ pending = false, hasStartupInput = true, delivered = true } = {}) {
  const calls = []
  const lifecycle = createReviewLifecycle()
  const lease = pending ? lifecycle.reserve("current") : lifecycle.begin("current", "coding")
  const inputID = hasStartupInput ? lifecycle.startupInputID("current", lease) : undefined
  if (inputID && delivered) lifecycle.observeStartupDelivery("current", inputID)
  let selected = "prr-orchestrator"
  const host = {
    session: {
      interrupt: async (input) => { calls.push(["interrupt", input]); return { interrupted: true } },
      wait: async (input) => { calls.push(["wait", input]) },
      get: async (input) => { calls.push(["get", input]); return { agent: selected } },
      switchAgent: async (input) => { calls.push(["switchAgent", input]); selected = input.agent },
    },
  }
  const options = {
    settleOwned: async () => { calls.push(["settleOwned"]) },
    requireReturnAgent: async (agent) => { calls.push(["requireReturnAgent", agent]) },
  }
  const exit = () => requestReviewExit(host, lifecycle, { sessionID: "current", lease }, options)
  return { host, calls, options, lifecycle, lease, inputID, exit, select: (agent) => { selected = agent } }
}

test("exit stops the current session, verifies cleanup and restores the saved agent", async () => {
  const { calls, exit } = fakeExitHost()
  assert.deepEqual(await exit(), { agent: "coding", restored: true })
  assert.deepEqual(calls.map(([name]) => name), [
    "interrupt", "wait", "settleOwned", "get", "requireReturnAgent", "get", "switchAgent", "get",
  ])
  assert.deepEqual(calls[0][1], { sessionID: "current", resume: false })
  assert.deepEqual(calls[1][1], { sessionID: "current" })
  assert.deepEqual(calls[6][1], { sessionID: "current", agent: "coding" })
})

test("exit preserves an agent already selected manually", async () => {
  const { calls, select, exit } = fakeExitHost()
  select("plan")
  assert.deepEqual(await exit(), { agent: "plan", restored: false })
  assert.equal(calls.some(([name]) => name === "requireReturnAgent" || name === "switchAgent"), false)
})

test("exit preserves a manual selection made during return-agent validation", async () => {
  const { calls, options, select, exit } = fakeExitHost()
  options.requireReturnAgent = async () => { select("plan") }
  assert.deepEqual(await exit(), { agent: "plan", restored: false })
  assert.equal(calls.some(([name]) => name === "switchAgent"), false)
})

test("session idle does not permit restoration before owned cleanup is verified", async () => {
  const { calls, options, exit: requestExit } = fakeExitHost()
  let reachedCleanup
  const reached = new Promise((resolve) => { reachedCleanup = resolve })
  let finishCleanup
  const pending = new Promise((resolve) => { finishCleanup = resolve })
  options.settleOwned = async () => { reachedCleanup(); await pending }
  const exit = requestExit()
  await reached
  assert.deepEqual(calls.map(([name]) => name), ["interrupt", "wait"])
  finishCleanup()
  assert.deepEqual(await exit, { agent: "coding", restored: true })
})

test("native stop is requested before draining work that depends on interruption", async () => {
  const { host, calls, lifecycle, lease, exit: requestExit } = fakeExitHost()
  let started
  const ready = new Promise((resolve) => { started = resolve })
  let finishWork
  const pending = new Promise((resolve) => { finishWork = resolve })
  const work = lifecycle.run("current", lease, () => { started(); return pending })
  await ready
  const interrupt = host.session.interrupt
  host.session.interrupt = async (input) => { finishWork(); return interrupt(input) }
  const exit = requestExit()
  try {
    await Promise.resolve()
    assert.equal(calls.some(([name]) => name === "interrupt"), true)
  } finally {
    finishWork()
    await work
    await exit
  }
})

for (const stage of ["interrupt", "wait", "settleOwned", "requireReturnAgent", "switchAgent"]) {
  test(`failed ${stage} retains the original recovery record`, async () => {
    const { host, options, lifecycle, lease, exit } = fakeExitHost()
    const failure = new Error(`${stage} failed`)
    const owner = stage in host.session ? host.session : options
    owner[stage] = async () => { throw failure }
    await assert.rejects(
      exit(),
      (error) => error === failure,
    )
    assert.deepEqual(lifecycle.current("current"), { lease, returnAgent: "coding", stopping: true })
  })
}

for (const required of ["settleOwned", "requireReturnAgent"]) {
  test(`exit refuses to stop without ${required}`, async () => {
    const { calls, options, lifecycle, exit } = fakeExitHost()
    delete options[required]
    await assert.rejects(exit(), /requires/i)
    assert.deepEqual(calls, [])
    assert.equal(lifecycle.current("current").stopping, false)
  })
}

for (const selected of [undefined, null, "", " "]) {
  test(`exit does not guess a current agent from ${JSON.stringify(selected)}`, async () => {
    const { calls, select, exit } = fakeExitHost()
    select(selected)
    await assert.rejects(exit(), /current agent/i)
    assert.equal(calls.some(([name]) => name === "switchAgent"), false)
  })
}

test("exit does not substitute a default when the saved agent is unknown", async () => {
  const { calls, exit } = fakeExitHost({ pending: true })
  await assert.rejects(exit(), /coding agent/i)
  assert.equal(calls.some(([name]) => name === "switchAgent"), false)
})

test("exit does not report restoration when the host leaves PRR selected", async () => {
  const { host, exit } = fakeExitHost()
  host.session.switchAgent = async () => {}
  await assert.rejects(exit(), /restor/i)
})

test("exit reports a later manual selection instead of claiming the saved agent was restored", async () => {
  const { host, select, exit } = fakeExitHost()
  host.session.switchAgent = async () => { select("plan") }
  assert.deepEqual(await exit(), { agent: "plan", restored: false })
})

test("stale or foreign exit requests cannot issue a native stop", async () => {
  const { host, calls, options, lifecycle, lease } = fakeExitHost()
  assert.equal(await requestReviewExit(host, lifecycle, { sessionID: "other", lease }, options), undefined)
  assert.equal(await requestReviewExit(host, lifecycle, { sessionID: "current", lease: "stale" }, options), undefined)
  assert.deepEqual(calls, [])
  assert.equal(lifecycle.current("current").lease, lease)
})

test("exit waits for positive startup delivery without stopping or revoking current work", async () => {
  const { calls, lifecycle, lease, inputID, exit } = fakeExitHost({ delivered: false })
  await assert.rejects(exit(), /startup delivery is unconfirmed/i)
  assert.deepEqual(calls, [])
  assert.equal(lifecycle.current("current").stopping, false)
  assert.equal(await lifecycle.run("current", lease, (signal) => signal.aborted), false)
  lifecycle.observeStartupDelivery("current", inputID)
  assert.deepEqual(await exit(), { agent: "coding", restored: true })
})

test("exit permits recovery without startup input only after dispatch is revoked", async () => {
  const { calls, lifecycle, lease, exit } = fakeExitHost({ hasStartupInput: false })
  await assert.rejects(exit(), /startup delivery is unconfirmed/i)
  assert.deepEqual(calls, [])
  lifecycle.revoke("current", lease)
  assert.deepEqual(await exit(), { agent: "coding", restored: true })
})

test("revocation does not bypass the gate for an unconfirmed startup input", async () => {
  const { calls, lifecycle, lease, exit } = fakeExitHost({ delivered: false })
  lifecycle.revoke("current", lease)
  await assert.rejects(exit(), /startup delivery is unconfirmed/i)
  assert.deepEqual(calls, [])
  assert.deepEqual(lifecycle.current("current"), { lease, returnAgent: "coding", stopping: true })
})
