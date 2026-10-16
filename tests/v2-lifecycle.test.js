import assert from "node:assert/strict"
import { test } from "node:test"
import { createReviewLifecycle } from "../v2-lifecycle.js"

test("refuses missing return agents and duplicate starts", () => {
  const lifecycle = createReviewLifecycle()
  assert.throws(() => lifecycle.begin("one"), /return agent/)
  const lease = lifecycle.begin("one", "coding")
  assert.throws(() => lifecycle.begin("one", "other"), /already active/)
  assert.equal(lifecycle.release("one", lease), "coding")
})

test("stale leases cannot release replacement or other-session reviews", () => {
  const lifecycle = createReviewLifecycle()
  const first = lifecycle.begin("one", "coding")
  const other = lifecycle.begin("two", "planner")
  assert.equal(lifecycle.release("two", first), undefined)
  assert.equal(lifecycle.release("one", first), "coding")
  const replacement = lifecycle.begin("one", "custom")
  assert.notEqual(first, replacement)
  assert.equal(lifecycle.release("one", first), undefined)
  assert.equal(lifecycle.release("one", replacement), "custom")
  assert.equal(lifecycle.release("two", other), "planner")
  assert.equal(lifecycle.release("one", replacement), undefined)
})

test("exit requests share one operation and retain ownership until completion", async () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.begin("one", "coding")
  let completeExit
  const pending = new Promise((resolve) => { completeExit = resolve })
  const targets = []
  const finish = (agent) => { targets.push(agent); return pending }
  const first = lifecycle.exit("one", lease, finish)
  assert.equal(lifecycle.exit("one", lease, finish), first)
  await Promise.resolve()
  assert.deepEqual(targets, ["coding"])
  assert.equal(lifecycle.current("one").stopping, true)
  assert.equal(lifecycle.release("one", lease), undefined)
  assert.throws(() => lifecycle.begin("one", "other"), /already active/)
  completeExit("coding")
  assert.equal(await first, "coding")
  assert.equal(lifecycle.current("one"), undefined)
})

test("failed exit preserves the return target for retry", async () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.begin("one", "coding")
  const failure = new Error("Exit failed")
  await assert.rejects(
    lifecycle.exit("one", lease, () => { throw failure }),
    (error) => error === failure,
  )
  const saved = lifecycle.current("one")
  assert.deepEqual(saved, { lease, returnAgent: "coding", stopping: true })
  assert.ok(Object.isFrozen(saved))
  assert.equal(lifecycle.release("one", lease), undefined)
  assert.equal(await lifecycle.exit("one", lease, (agent) => { assert.equal(agent, "coding"); return agent }), "coding")
})

test("asynchronously failed exit retains recovery state and permits retry", async () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.begin("one", "coding")
  const failure = new Error("Async exit failed")
  await assert.rejects(lifecycle.exit("one", lease, async () => { throw failure }), (error) => error === failure)
  assert.deepEqual(lifecycle.current("one"), { lease, returnAgent: "coding", stopping: true })
  assert.equal(await lifecycle.exit("one", lease, async (agent) => { assert.equal(agent, "coding"); return agent }), "coding")
})

test("an abort listener shares the original exit instead of starting another", async () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.begin("one", "coding")
  const signal = await lifecycle.run("one", lease, (signal) => signal)
  let reentered
  signal.addEventListener("abort", () => {
    reentered = lifecycle.exit("one", lease, () => assert.fail("Duplicate finish"))
  }, { once: true })
  let finishes = 0
  const exit = lifecycle.exit("one", lease, () => { finishes++; return "coding" })
  assert.equal(reentered, exit)
  assert.equal(await exit, "coding")
  assert.equal(finishes, 1)
})

test("exit returns the verified handback outcome rather than the originally saved target", async () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.begin("one", "coding")
  const outcome = { agent: "plan", restored: false }
  assert.equal(await lifecycle.exit("one", lease, () => outcome), outcome)
})

test("stale or cross-session exits cannot affect a replacement review", async () => {
  const lifecycle = createReviewLifecycle()
  const old = lifecycle.begin("one", "coding")
  lifecycle.release("one", old)
  const current = lifecycle.begin("one", "custom")
  const unexpected = () => assert.fail("Invalid exit must not run")
  assert.equal(await lifecycle.exit("one", old, unexpected), undefined)
  assert.equal(await lifecycle.exit("other", current, unexpected), undefined)
  assert.equal(lifecycle.current("one").lease, current)
})

test("exit cancels tracked work and waits for its cleanup", async () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.begin("one", "coding")
  let started
  const ready = new Promise((resolve) => { started = resolve })
  let finishCleanup
  const cleanup = new Promise((resolve) => { finishCleanup = resolve })
  const work = lifecycle.run("one", lease, async (signal) => {
    started(signal)
    await cleanup
    signal.throwIfAborted()
  })
  const cancelled = assert.rejects(work, { name: "AbortError" })
  const signal = await ready
  let finished = false
  const exit = lifecycle.exit("one", lease, () => { finished = true; return "coding" })
  assert.equal(signal.aborted, true)
  await assert.rejects(lifecycle.run("one", lease, () => assert.fail("Late work")), /not active/)
  assert.equal(finished, false)
  assert.equal(lifecycle.release("one", lease), undefined)
  finishCleanup()
  await cancelled
  assert.equal(await exit, "coding")
  assert.equal(finished, true)
})

test("queued work cannot start after exit or use another session's lease", async () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.begin("one", "coding")
  const unexpected = () => assert.fail("Work must not start")
  await assert.rejects(lifecycle.run("other", lease, unexpected), /not active/)
  const work = lifecycle.run("one", lease, unexpected)
  const cancelled = assert.rejects(work, { name: "AbortError" })
  const exit = lifecycle.exit("one", lease, () => "coding")
  await cancelled
  assert.equal(await exit, "coding")
})

test("completed work returns its result and permits release", async () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.begin("one", "coding")
  assert.equal(await lifecycle.run("one", lease, () => 42), 42)
  assert.equal(lifecycle.release("one", lease), "coding")
})

test("pending startup reserves the session and captures its return agent once", () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.reserve("one")
  assert.equal(lifecycle.current("one").returnAgent, undefined)
  assert.throws(() => lifecycle.begin("one", "other"), /already active/)
  lifecycle.capture("one", lease, "custom")
  assert.equal(lifecycle.current("one").returnAgent, "custom")
  assert.throws(() => lifecycle.capture("one", lease, "other"), /already captured/)
  assert.equal(lifecycle.release("one", lease), "custom")
})

test("exit during pending startup prevents late return-agent capture", async () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.reserve("one")
  const exit = lifecycle.exit("one", lease, (agent) => assert.equal(agent, undefined))
  assert.throws(() => lifecycle.capture("one", lease, "coding"), /not active/)
  await exit
  const replacement = lifecycle.begin("one", "custom")
  assert.throws(() => lifecycle.capture("one", lease, "coding"), /not active/)
  assert.equal(lifecycle.current("one").lease, replacement)
})

test("pending capture rejects invalid targets and foreign leases", () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.reserve("one")
  assert.throws(() => lifecycle.capture("other", lease, "coding"), /not active/)
  assert.throws(() => lifecycle.capture("one", "stale", "coding"), /not active/)
  for (const agent of [undefined, null, "", " ", 42]) {
    assert.throws(() => lifecycle.capture("one", lease, agent), /return agent/)
  }
  assert.equal(lifecycle.current("one").returnAgent, undefined)
  lifecycle.capture("one", lease, "coding")
  assert.equal(lifecycle.release("one", lease), "coding")
})

test("pending and captured startups grant no dispatch lease until activation", () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.reserve("one")
  const before = lifecycle.leaseSnapshot()
  assert.equal(before("one"), undefined)
  lifecycle.capture("one", lease, "coding")
  assert.equal(lifecycle.leaseSnapshot()("one"), undefined)
  lifecycle.activate("one", lease)
  assert.equal(lifecycle.leaseSnapshot()("one"), lease)
  assert.equal(before("one"), undefined)
})

test("dispatch snapshots retain their original generation after replacement", async () => {
  const lifecycle = createReviewLifecycle()
  const old = lifecycle.begin("one", "coding")
  lifecycle.activate("one", old)
  const original = lifecycle.leaseSnapshot()
  lifecycle.release("one", old)
  const replacement = lifecycle.begin("one", "plan")
  lifecycle.activate("one", replacement)
  assert.equal(original("one"), old)
  assert.equal(lifecycle.leaseSnapshot()("one"), replacement)
  await assert.rejects(lifecycle.run("one", original("one"), () => assert.fail("Stale work")), /not active/)
})

test("stopping removes dispatch authority without mutating captured snapshots", async () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.begin("one", "coding")
  lifecycle.activate("one", lease)
  const original = lifecycle.leaseSnapshot()
  const exit = lifecycle.exit("one", lease, () => {})
  assert.equal(lifecycle.leaseSnapshot()("one"), undefined)
  assert.equal(original("one"), lease)
  assert.throws(() => lifecycle.activate("one", lease), /not active/)
  await exit
})

test("activation requires the owned lease and a captured return target", () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.reserve("one")
  assert.throws(() => lifecycle.activate("one", lease), /return agent/)
  lifecycle.capture("one", lease, "coding")
  assert.throws(() => lifecycle.activate("other", lease), /not active/)
  assert.throws(() => lifecycle.activate("one", "stale"), /not active/)
  assert.equal(lifecycle.leaseSnapshot()("one"), undefined)
})

test("revocation preserves recovery ownership without retaining dispatch authority", async () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.begin("one", "coding")
  lifecycle.activate("one", lease)
  const before = lifecycle.leaseSnapshot()
  const signal = await lifecycle.run("one", lease, (signal) => signal)
  lifecycle.revoke("one", lease)
  assert.equal(signal.aborted, true)
  assert.deepEqual(lifecycle.current("one"), { lease, returnAgent: "coding", stopping: true })
  assert.equal(lifecycle.leaseSnapshot()("one"), undefined)
  assert.equal(before("one"), lease)
  await assert.rejects(lifecycle.run("one", before("one"), () => assert.fail("Revoked work")), /not active/)
  assert.throws(() => lifecycle.activate("one", lease), /not active/)
  assert.equal(lifecycle.release("one", lease), undefined)
  assert.throws(() => lifecycle.reserve("one"), /already active/)
  assert.equal(await lifecycle.exit("one", lease, (agent) => agent), "coding")
  assert.equal(lifecycle.current("one"), undefined)
})

test("revocation ignores stale leases and other sessions", async () => {
  const lifecycle = createReviewLifecycle()
  const old = lifecycle.begin("one", "coding")
  lifecycle.release("one", old)
  const lease = lifecycle.begin("one", "custom")
  lifecycle.activate("one", lease)
  lifecycle.revoke("one", old)
  lifecycle.revoke("other", lease)
  assert.equal(lifecycle.leaseSnapshot()("one"), lease)
  assert.equal(await lifecycle.run("one", lease, () => "current work"), "current work")
})

test("startup input identity is stable without granting dispatch or claiming delivery", () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.reserve("one")
  const inputID = lifecycle.startupInputID("one", lease)
  assert.match(inputID, /^msg_[0-9a-f-]{36}$/)
  assert.equal(lifecycle.startupInputID("one", lease), inputID)
  assert.equal(lifecycle.startupDelivered("one", lease), false)
  assert.equal(lifecycle.leaseSnapshot()("one"), undefined)
  assert.throws(() => lifecycle.startupInputID("one", "stale"), /not active/)
  assert.throws(() => lifecycle.startupInputID("other", lease), /not active/)
})

test("startup delivery requires an exact privately recorded input and session", () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.reserve("one")
  for (const inputID of [undefined, null, "", "msg_unknown"]) {
    lifecycle.observeStartupDelivery("one", inputID)
    assert.equal(lifecycle.startupDelivered("one", lease), false)
  }
  const inputID = lifecycle.startupInputID("one", lease)
  const other = lifecycle.reserve("two")
  lifecycle.startupInputID("two", other)
  lifecycle.observeStartupDelivery("two", inputID)
  lifecycle.observeStartupDelivery("one", "msg_unknown")
  assert.equal(lifecycle.startupDelivered("one", lease), false)
  assert.equal(lifecycle.startupDelivered("two", other), false)
  lifecycle.observeStartupDelivery("one", inputID)
  assert.equal(lifecycle.startupDelivered("one", lease), true)
  assert.equal(lifecycle.startupDelivered("one", "stale"), false)
})

test("late startup delivery cannot confirm a replacement generation", () => {
  const lifecycle = createReviewLifecycle()
  const old = lifecycle.reserve("one")
  const oldID = lifecycle.startupInputID("one", old)
  lifecycle.release("one", old)
  const replacement = lifecycle.reserve("one")
  const inputID = lifecycle.startupInputID("one", replacement)
  assert.notEqual(inputID, oldID)
  lifecycle.observeStartupDelivery("one", oldID)
  assert.equal(lifecycle.startupDelivered("one", replacement), false)
  lifecycle.observeStartupDelivery("one", inputID)
  assert.equal(lifecycle.startupDelivered("one", replacement), true)
  assert.equal(lifecycle.startupDelivered("one", old), false)
})

test("positive startup delivery stays latched without reviving revoked dispatch", () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.begin("one", "coding")
  const inputID = lifecycle.startupInputID("one", lease)
  lifecycle.activate("one", lease)
  lifecycle.revoke("one", lease)
  lifecycle.observeStartupDelivery("one", inputID)
  lifecycle.observeStartupDelivery("one", "msg_unrelated")
  assert.equal(lifecycle.startupDelivered("one", lease), true)
  assert.equal(lifecycle.leaseSnapshot()("one"), undefined)
  assert.throws(() => lifecycle.activate("one", lease), /not active/)
  assert.throws(() => lifecycle.startupInputID("one", lease), /not active/)
})

function childReview() {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.begin("parent", "coding")
  lifecycle.activate("parent", lease)
  return { lifecycle, lease, observe: lifecycle.childObserver("parent", lease) }
}

test("child observation requires an activated owner and valid child identities", () => {
  const lifecycle = createReviewLifecycle()
  const lease = lifecycle.reserve("parent")
  assert.throws(() => lifecycle.childObserver("parent", lease), /not active/)
  lifecycle.capture("parent", lease, "coding")
  lifecycle.activate("parent", lease)
  assert.throws(() => lifecycle.childObserver("other", lease), /not active/)
  assert.throws(() => lifecycle.childObserver("parent", "stale"), /not active/)
  const observe = lifecycle.childObserver("parent", lease)
  for (const childID of [undefined, null, "", " ", 42, "parent"]) {
    assert.throws(() => observe(childID), /Invalid PRR child/)
  }
  assert.deepEqual(lifecycle.children("parent", lease), [])
  assert.throws(() => lifecycle.children("other", lease), /not active/)
  assert.throws(() => lifecycle.children("parent", "stale"), /not active/)
})

test("child ownership stays provisional until the exact host identity is confirmed", () => {
  const { lifecycle, lease, observe } = childReview()
  const confirm = observe("child-one")
  const before = lifecycle.children("parent", lease)
  assert.deepEqual(before, [{ sessionID: "child-one", verified: false }])
  for (const session of [undefined, {}, { id: "child-two", parentID: "parent" }, { id: "child-one", parentID: "other" }]) {
    assert.throws(() => confirm(session), /verify PRR child/)
    assert.deepEqual(lifecycle.children("parent", lease), before)
  }
  confirm({ id: "child-one", parentID: "parent" })
  assert.deepEqual(lifecycle.children("parent", lease), [{ sessionID: "child-one", verified: true }])
  assert.equal(before[0].verified, false)
  assert.throws(() => before.push({ sessionID: "forged", verified: true }), TypeError)
  assert.throws(() => { before[0].verified = true }, TypeError)
})

test("one child observer retains multiple children and repeated progress is idempotent", () => {
  const { lifecycle, lease, observe } = childReview()
  const first = observe("child-one")
  const second = observe("child-two")
  first({ id: "child-one", parentID: "parent" })
  observe("child-one")({ id: "child-one", parentID: "parent" })
  second({ id: "child-two", parentID: "parent" })
  assert.deepEqual(lifecycle.children("parent", lease), [
    { sessionID: "child-one", verified: true }, { sessionID: "child-two", verified: true },
  ])
})

test("an authorized dispatch can retain and verify a child reported during Stop", () => {
  const { lifecycle, lease, observe } = childReview()
  lifecycle.revoke("parent", lease)
  assert.throws(() => lifecycle.childObserver("parent", lease), /not active/)
  const confirm = observe("late-child")
  assert.deepEqual(lifecycle.children("parent", lease), [{ sessionID: "late-child", verified: false }])
  confirm({ id: "late-child", parentID: "parent" })
  assert.deepEqual(lifecycle.children("parent", lease), [{ sessionID: "late-child", verified: true }])
  assert.equal(lifecycle.leaseSnapshot()("parent"), undefined)
  assert.equal(lifecycle.current("parent").stopping, true)
})

test("another active parent cannot claim a provisional or confirmed child", () => {
  const { lifecycle, lease, observe } = childReview()
  const other = lifecycle.begin("other", "plan")
  lifecycle.activate("other", other)
  const foreign = lifecycle.childObserver("other", other)
  const confirm = observe("child-one")
  assert.throws(() => foreign("child-one"), /already owned/)
  assert.deepEqual(lifecycle.children("other", other), [])
  confirm({ id: "child-one", parentID: "parent" })
  assert.throws(() => foreign("child-one"), /already owned/)
  assert.deepEqual(lifecycle.children("parent", lease), [{ sessionID: "child-one", verified: true }])
})

test("continuations and old callbacks cannot borrow a replacement generation", async () => {
  const { lifecycle, lease, observe } = childReview()
  assert.throws(() => lifecycle.childObserver("parent", lease, "unknown"), /not owned/)
  const confirm = observe("child-one")
  assert.throws(() => lifecycle.childObserver("parent", lease, "child-one"), /not owned/)
  confirm({ id: "child-one", parentID: "parent" })
  assert.equal(typeof lifecycle.childObserver("parent", lease, "child-one"), "function")
  await lifecycle.exit("parent", lease, (agent) => agent)
  const replacement = lifecycle.begin("parent", "plan")
  lifecycle.activate("parent", replacement)
  assert.throws(() => observe("late-child"), /not active/)
  assert.throws(() => confirm({ id: "child-one", parentID: "parent" }), /not active/)
  assert.throws(() => lifecycle.children("parent", lease), /not active/)
  assert.throws(() => lifecycle.childObserver("parent", replacement, "child-one"), /not owned/)
  assert.deepEqual(lifecycle.children("parent", replacement), [])
})

test("only successful finish retires children; release and failed finish preserve recovery", async () => {
  const { lifecycle, lease, observe } = childReview()
  const confirm = observe("child-one")
  assert.equal(lifecycle.release("parent", lease), undefined)
  const failure = new Error("Child cleanup failed")
  await assert.rejects(lifecycle.exit("parent", lease, () => { throw failure }), (error) => error === failure)
  assert.deepEqual(lifecycle.current("parent"), { lease, returnAgent: "coding", stopping: true })
  assert.deepEqual(lifecycle.children("parent", lease), [{ sessionID: "child-one", verified: false }])
  confirm({ id: "child-one", parentID: "parent" })
  assert.equal(lifecycle.release("parent", lease), undefined)
  assert.equal(await lifecycle.exit("parent", lease, (agent) => agent), "coding")
  assert.equal(lifecycle.current("parent"), undefined)
})
