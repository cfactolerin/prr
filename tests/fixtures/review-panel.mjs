import assert from "node:assert/strict"
import { render } from "@opentui/solid"
import { createTestRenderer } from "@opentui/core/testing"
import { RGBA, TextAttributes } from "@opentui/core"
import { createStore, produce } from "solid-js/store"
import { createComponent, createSignal, Show } from "solid-js"
import { reviewPanel } from "../../review-panel.js"

const [memory, setMemory] = createStore({ sessions: {} })
const updateMemory = (update) => setMemory(produce(update))
const commands = new Map()
const calls = []
const errors = []
let failPrompt = false
let promptWait
let eventHandler
let stopped = false
let closed = false
const [open, setOpen] = createSignal(true)
const patch = "diff --git a/a.rb b/a.rb\n--- a/a.rb\n+++ b/a.rb\n@@ -1,50 +1,50 @@\n"
  + Array.from({ length: 50 }, (_, index) => index === 0 ? `-BEFORE_START_${"a".repeat(120)}_TAIL\n+AFTER_START_${"a".repeat(120)}_TAIL`
    : index === 44 ? "-before value\n+after value" : ` line ${index + 1}`).join("\n") + "\n"
const findings = [
  { id: "F-01", title: "Code issue", severity: "MED", trigger: "Logic Bug", anchor: "diff", origin: "introduced", path: "a.rb", line: 45, fileID: "0", why_it_matters: "The value is wrong.", suggested_fix: "Correct it.", suggested_comment: "Please correct the value." },
  { id: "F-02", title: "Acceptance check", severity: "MED", trigger: "Acceptance Criteria", anchor: "none", origin: "introduced", why_it_matters: "Partner check missing.", suggested_fix: "Record results.", suggested_comment: "Please record results." },
]
const report = { snapshot: "one", round: "r1", verdict: "COMMENT", confidence: "HIGH", warnings: "", findings, files: [
  { id: "0", path: "a.rb", status: "modified", binary: false },
  { id: "1", path: "added.rb", status: "added", binary: false },
  { id: "2", path: "deleted.rb", status: "deleted", binary: false },
  { id: "3", path: "renamed.rb", status: "renamed", binary: false },
] }
const rpc = {
  investigation: async () => structuredClone(report),
  diff: async (input) => {
    calls.push(input)
    return input.findingID === "F-02" ? { patch: "", path: "", mode: "none", message: "This finding has no code location." }
      : { patch, path: "a.rb", mode: "diff", message: "" }
  },
  events: { on: (_name, callback) => { eventHandler = callback; return () => { stopped = true } } },
}
const context = {
  location: { directory: "/repo" },
  storage: { memory: () => [memory, updateMemory] },
  theme: {
    text: { base: "#ffffff", muted: "#aaaaaa", action: { primary: { base: "#00ffff" } }, feedback: { warning: { base: "#ffff00" }, info: { base: "#0088ff" } } },
    diff: { text: { added: "#00ff00", removed: "#ff0000" } },
  },
  keymap: {
    layer: (factory) => { for (const command of factory().commands) commands.set(command.id, command) },
    dispatch: (id) => commands.get(id).run(),
  },
  ui: {
    dialog: { prompt: async () => "Does the caller rely on this value?", select: async () => "0" },
    toast: { show: (input) => { errors.push(input.message) } },
  },
  client: { session: { prompt: async (input) => {
    calls.push({ prompt: input })
    if (failPrompt) throw new Error("Cannot reach the review session")
    await promptWait
  } } },
}
const panel = { name: "prr.investigation", sessionID: "session", width: 140, focused: true, close: () => { closed = true; setOpen(false) } }
const view = await createTestRenderer({ width: 140, height: 32 })
context.renderer = view.renderer
await render(() => createComponent(Show, { get when() { return open() }, children: () => reviewPanel(context, panel, rpc) }), view.renderer)
try {
  const initial = await view.waitForFrame((frame) => frame.includes("Code issue") && frame.includes("BEFORE_START") && frame.includes("AFTER_START"))
  assert.equal(calls.length, 1)
  const nodes = (node) => [node, ...(node.getChildren?.() ?? []).flatMap(nodes)]
  const rendered = nodes(view.renderer.root)
  for (const [status, path, color] of [["modified", "a.rb", "#ffff00"], ["added", "added.rb", "#00ff00"], ["deleted", "deleted.rb", "#ff0000"], ["renamed", "renamed.rb", "#0088ff"]]) {
    const node = rendered.find((item) => item.plainText === `${status} · ${path}`)
    assert.ok(node, path)
    assert.ok(node.fg.equals(RGBA.fromHex(color)), `${status} color`)
    assert.ok(node.attributes & TextAttributes.UNDERLINE, `${path} is clickable`)
  }
  assert.ok(!(rendered.find((item) => item.plainText === "Changed files").attributes & TextAttributes.UNDERLINE))
  const rows = initial.split("\n")
  const codeY = rows.findIndex((row) => row.includes("BEFORE_START"))
  for (let index = 0; index < 6; index++) await view.mockMouse.scroll(20, codeY, "right")
  await view.waitForFrame((frame) => !frame.includes("BEFORE_START") && !frame.includes("AFTER_START"))
  const y = rows.findIndex((row) => row.includes("MED · F-01"))
  await view.mockMouse.click(rows[y].indexOf("MED · F-01") + 3, y)
  let frame = await view.waitForFrame((frame) => frame.includes("Why this matters") && frame.includes("after value"))
  assert.ok(frame.includes("before value"))
  assert.equal(memory.sessions.session.findingID, "F-01")
  assert.ok(!frame.includes("BEFORE_START"))
  await commands.get("prr.diff.next").run()
  frame = await view.waitForFrame((frame) => frame.includes("Partner check missing.") && frame.includes("no code location"))
  assert.ok(!frame.includes("before value"))
  await commands.get("prr.diff.previous").run()
  await view.waitForFrame((frame) => frame.includes("Please correct the value."))
  await commands.get("prr.diff.discuss").run()
  assert.equal(closed, true)
  assert.match(calls.find((call) => call.prompt).prompt.text, /not acceptance, rejection, or permission to post/)
  assert.match(calls.find((call) => call.prompt).prompt.text, /Does the caller rely/)
  assert.ok(memory.sessions.session.offsets["finding:F-01"].y > 0)
  setOpen(true)
  await view.waitForFrame((frame) => frame.includes("Please correct the value.") && frame.includes("after value"))
  assert.equal(memory.sessions.session.findingID, "F-01")
  closed = false
  frame = view.captureCharFrame()
  const continueY = frame.split("\n").findIndex((row) => row.includes("Continue review [c / Esc]"))
  await view.mockMouse.click(3, continueY)
  await view.waitFor(() => closed)
  const withFindings = calls.filter((call) => call.prompt).at(-1).prompt
  assert.match(withFindings.text, /Show the next-step choices using the question tool/)
  assert.match(withFindings.text, /does not accept or reject findings/)
  assert.equal(memory.sessions.session.findingID, "F-01")
  setOpen(true)
  await view.waitForFrame((frame) => frame.includes("Please correct the value."))
  report.snapshot = "two"
  report.findings = []
  report.verdict = "APPROVE"
  eventHandler({ data: { sessionID: "session" }, location: context.location })
  await view.waitForFrame((frame) => frame.includes("No findings."))
  assert.equal(memory.sessions.session.findingID, null)
  await commands.get("prr.diff.scroll.down").run()
  await view.waitForFrame((frame) => !frame.includes("BEFORE_START"))
  view.resize(70, 24)
  await view.flush()
  assert.ok(view.captureCharFrame().includes("Before"))
  assert.deepEqual(errors, [])
  closed = false
  failPrompt = true
  await commands.get("prr.diff.continue").run()
  assert.equal(closed, false)
  assert.deepEqual(errors, ["Cannot reach the review session"])
  await view.waitForFrame((frame) => frame.includes("Continue review [c / Esc]"))
  failPrompt = false
  let releasePrompt
  promptWait = new Promise((resolve) => { releasePrompt = resolve })
  const beforeContinue = calls.filter((call) => call.prompt).length
  const continuing = commands.get("prr.diff.close").run()
  await commands.get("prr.diff.continue").run()
  assert.equal(calls.filter((call) => call.prompt).length, beforeContinue + 1)
  const withoutFindings = calls.filter((call) => call.prompt).at(-1).prompt
  assert.equal(withoutFindings.sessionID, "session")
  assert.match(withoutFindings.text, /Post review when there are no findings/)
  assert.match(withoutFindings.text, /does not accept or reject findings, complete investigation, or authorize posting/)
  releasePrompt()
  await continuing
  assert.equal(closed, true)
} catch (error) {
  console.error(JSON.stringify({ memory, calls }))
  throw error
} finally {
  await view.dispose()
}
assert.equal(stopped, true)
