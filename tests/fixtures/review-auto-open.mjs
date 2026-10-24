import assert from "node:assert/strict"
import { createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { watchDiffRequests } from "../../tui.js"
import { investigationReady, reviewSteps } from "../../review-state.js"

const [memory, setMemory] = createStore({ seen: {} })
const opens = []
const errors = []
let handler
let stopped = false
let route = { type: "session", sessionID: "active" }
let saved = { diffRequest: "one", steps: reviewSteps.map((label) => ({ label, status: "completed" })) }
saved.steps[6].status = "in_progress"
let pending
const context = {
  location: { directory: "/repo" },
  storage: { memory: () => [memory, (update) => setMemory(produce(update))] },
  ui: {
    router: { current: () => route },
    panel: { open: (...args) => { opens.push(args) } },
    toast: { show: (input) => { errors.push(input.message) } },
  },
}
const rpc = {
  pendingDiff: async () => {
    if (pending) await pending
    return investigationReady(saved) && saved.steps[6].status === "in_progress" && saved.diffRequest ? { diffRequest: saved.diffRequest } : null
  },
  events: { on: (name, callback) => { assert.equal(name, "openDiff"); handler = callback; return () => { stopped = true } } },
}
const mount = () => createRoot((dispose) => { watchDiffRequests(context, rpc); return dispose })
const event = (diffRequest, overrides = {}) => ({ data: { sessionID: "active", ...(diffRequest ? { diffRequest } : {}) }, location: context.location, ...overrides })
let dispose = mount()
assert.equal(opens.length, 0)
await handler(event())
await handler(event("one", { location: { directory: "/other" } }))
await handler(event("one", { data: { sessionID: "background", diffRequest: "one" } }))
assert.equal(opens.length, 0)
await handler(event("one"))
assert.deepEqual(opens, [["prr.investigation", { presentation: "fullscreen" }]])
await handler(event("one"))
await handler(event())
assert.equal(opens.length, 1)
dispose()
dispose = mount()
await handler(event("one"))
assert.equal(opens.length, 1)
saved.diffRequest = "two"
await handler(event("one"))
assert.equal(opens.length, 1)
await handler(event("two"))
assert.equal(opens.length, 2)
saved.diffRequest = "chat"
delete saved.diffRequest
await handler(event("three"))
assert.equal(opens.length, 2)
saved.diffRequest = "three"
saved.steps[5].status = "pending"
await handler(event("three"))
assert.equal(opens.length, 2)
saved.steps[5].status = "completed"
saved.steps[6].status = "completed"
await handler(event("three"))
assert.equal(opens.length, 2)
saved.steps[6].status = "in_progress"
let release
pending = new Promise((resolve) => { release = resolve })
const request = handler(event("three"))
route = { type: "session", sessionID: "another" }
release()
await request
assert.equal(opens.length, 2)
route = { type: "home" }
await handler(event("three"))
assert.equal(opens.length, 2)
route = { type: "session", sessionID: "active" }
pending = new Promise((resolve) => { release = resolve })
const disposedRequest = handler(event("three"))
dispose()
release()
await disposedRequest
assert.equal(opens.length, 2)
assert.equal(stopped, true)
assert.deepEqual(errors, [])
