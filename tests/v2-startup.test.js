import assert from "node:assert/strict"
import { test } from "node:test"
import { createReviewLifecycle } from "../v2-lifecycle.js"
import { registerStartupObservation } from "../v2-startup.js"

async function fakeStartupObservation() {
  const lifecycle = createReviewLifecycle()
  const hooks = new Map()
  await registerStartupObservation({ session: {
    hook: async (name, callback) => { hooks.set(name, callback) },
  } }, lifecycle)
  return { lifecycle, hooks }
}

for (const name of ["context", "compaction"]) {
  test(`${name} observes the owned user input without changing the request`, async () => {
    const { lifecycle, hooks } = await fakeStartupObservation()
    const lease = lifecycle.reserve("one")
    const id = lifecycle.startupInputID("one", lease)
    const event = {
      sessionID: "one", messages: [{ role: "user", id, content: [{ type: "text", text: "Review this PR" }] }],
      system: [{ type: "text", text: "Review rules" }], tools: {}, options: {},
    }
    const before = structuredClone(event)
    await hooks.get(name)(event)
    assert.equal(lifecycle.startupDelivered("one", lease), true)
    assert.deepEqual(event, before)
    await hooks.get(name)({ ...event, messages: [] })
    assert.equal(lifecycle.startupDelivered("one", lease), true)
  })
}

test("startup observation rejects unrelated sessions, roles and history-shaped messages", async () => {
  const { lifecycle, hooks } = await fakeStartupObservation()
  const lease = lifecycle.reserve("one")
  const id = lifecycle.startupInputID("one", lease)
  for (const observe of hooks.values()) {
    await observe({ sessionID: "other", messages: [{ role: "user", id }] })
    await observe({ sessionID: "one", messages: [
      { role: "assistant", id }, { type: "user", id }, { role: "user", id: "msg_unrelated" },
    ] })
    assert.equal(lifecycle.startupDelivered("one", lease), false)
  }
})

test("startup observation cannot carry an old input into a replacement review", async () => {
  const { lifecycle, hooks } = await fakeStartupObservation()
  const old = lifecycle.reserve("one")
  const oldID = lifecycle.startupInputID("one", old)
  lifecycle.release("one", old)
  const lease = lifecycle.reserve("one")
  lifecycle.startupInputID("one", lease)
  for (const observe of hooks.values()) {
    await observe({ sessionID: "one", messages: [{ role: "user", id: oldID }] })
  }
  assert.equal(lifecycle.startupDelivered("one", lease), false)
})
