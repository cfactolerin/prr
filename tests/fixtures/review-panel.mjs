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
  { id: "F-01", title: "Code issue", severity: "MED", trigger: "Logic Bug", anchor: "diff", origin: "introduced", path: "a.rb", line: 45, fileID: "0", why_it_matters: "- **Previous behavior:** Kept `value`.\n- **What's wrong:** The value is wrong.", suggested_fix: "Correct **the value**.", suggested_comment: "Please correct the value." },
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
    const path = report.files.find((file) => file.id === input.fileID)?.path ?? "a.rb"
    return input.findingID === "F-02" ? { patch: "", path: "", mode: "none", message: "This finding has no code location." }
      : { patch: patch.replaceAll("a.rb", path), path, mode: "diff", message: "" }
  },
  events: { on: (_name, callback) => { eventHandler = callback; return () => { stopped = true } } },
}
const context = {
  location: { directory: "/repo" },
  storage: { memory: () => [memory, updateMemory] },
  theme: {
    text: { base: process.env.PRR_LIGHT_THEME ? "#172b4d" : "#ffffff", muted: "#aaaaaa", action: { primary: { base: "#00ffff" } }, feedback: { success: { base: "#00ff00" }, warning: { base: "#ffff00" }, info: { base: "#0088ff" } } },
    diff: { text: { added: "#00ff00", removed: "#ff0000" } },
  },
  keymap: {
    layer: (factory) => { for (const command of factory().commands) commands.set(command.id, command) },
    dispatch: (id) => commands.get(id).run(),
  },
  ui: {
    dialog: { prompt: async () => { assert.fail("Discuss must switch to chat without a popup") }, select: async () => "0" },
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
const waitForContent = async (predicate) => {
  for (let attempt = 0; attempt < 250; attempt++) {
    await view.flush()
    const frame = view.captureCharFrame()
    if (predicate(frame)) return frame
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail("Timed out waiting for Markdown content")
}
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
  const clickText = async (label) => {
    const frame = view.captureCharFrame().split("\n")
    const y = frame.findIndex((row) => row.includes(label))
    assert.ok(y >= 0, label)
    await view.mockMouse.click(frame[y].indexOf(label) + 2, y)
  }
  await clickText("↓ Next file")
  await view.waitForFrame((frame) => frame.includes("added.rb") && memory.sessions.session.fileID === "1")
  assert.equal(memory.sessions.session.findingID, null)
  await clickText("↑ Previous file")
  await view.waitFor(() => memory.sessions.session.fileID === "0")
  await view.waitForFrame((frame) => frame.includes("BEFORE_START"))
  await clickText("↑ Previous file")
  await view.waitFor(() => memory.sessions.session.fileID === "3")
  await clickText("↓ Next file")
  await view.waitFor(() => memory.sessions.session.fileID === "0")
  await view.waitForFrame((frame) => frame.includes("BEFORE_START"))
  const rows = initial.split("\n")
  const codeY = rows.findIndex((row) => row.includes("BEFORE_START"))
  for (let index = 0; index < 6; index++) await view.mockMouse.scroll(20, codeY, "right")
  await view.waitForFrame((frame) => !frame.includes("BEFORE_START") && !frame.includes("AFTER_START"))
  const y = rows.findIndex((row) => row.includes("MED · F-01"))
  await view.mockMouse.click(rows[y].indexOf("MED · F-01") + 3, y)
  let frame = await waitForContent((frame) => frame.includes("Previous behavior:") && frame.includes("Please correct the value.") && frame.includes("after value"))
  assert.ok(frame.includes("before value"))
  assert.ok(frame.includes("Previous behavior:"))
  assert.ok(!frame.includes("**"))
  assert.ok(!frame.includes("`value`"))
  const details = nodes(view.renderer.root)
  for (const [label, color] of [["F-01 · MED · Logic Bug", "#ffff00"], ["Why this matters", "#0088ff"], ["Suggested fix", "#00ff00"], ["Suggested comment", "#00ffff"]]) {
    const node = details.find((item) => item.plainText === label)
    assert.ok(node.fg.equals(RGBA.fromHex(color)), label)
    assert.ok(node.attributes & TextAttributes.BOLD, label)
  }
  const gutters = details.filter((node) => node.getLineColors)
  const highlight = process.env.PRR_LIGHT_THEME ? "#b9ddff" : "#174b73"
  assert.ok(gutters.some((node) => [...node.getLineColors().content.values()].some((color) => color.equals(RGBA.fromHex(highlight)))))
  const spans = view.captureSpans().lines.flatMap((line) => line.spans)
  const issue = spans.find((span) => span.text.includes("after value"))
  assert.ok(issue.bg.equals(RGBA.fromHex(highlight)))
  const luminance = (color) => [color.r, color.g, color.b].map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  const lightness = [luminance(issue.fg), luminance(issue.bg)].sort((a, b) => a - b)
  assert.ok((lightness[1] + 0.05) / (lightness[0] + 0.05) >= 4.5, "issue text contrast")
  const orientation = spans.find((span) => span.text.includes("Previous behavior:"))
  assert.ok(orientation.attributes & TextAttributes.BOLD)
  assert.ok(orientation.fg.equals(RGBA.fromHex("#0088ff")))
  assert.equal(memory.sessions.session.findingID, "F-01")
  assert.ok(!frame.includes("BEFORE_START"))
  await commands.get("prr.diff.next").run()
  frame = await waitForContent((frame) => frame.includes("Partner check missing.") && frame.includes("no code location"))
  assert.ok(!frame.includes("before value"))
  await commands.get("prr.diff.previous").run()
  await waitForContent((frame) => frame.includes("Please correct the value."))
  failPrompt = true
  await commands.get("prr.diff.discuss").run()
  assert.equal(closed, false)
  assert.equal(memory.sessions.session.discussionFindingID, undefined)
  assert.deepEqual(errors, ["Cannot reach the review session"])
  errors.length = 0
  failPrompt = false
  const beforeDiscuss = calls.filter((call) => call.prompt).length
  await commands.get("prr.diff.discuss").run()
  assert.equal(closed, true)
  assert.equal(calls.filter((call) => call.prompt).length, beforeDiscuss + 1)
  assert.match(calls.find((call) => call.prompt).prompt.text, /not acceptance, rejection, or permission to post/)
  const handoff = calls.find((call) => call.prompt).prompt.text
  assert.match(handoff, /one-at-a-time findings review at finding "F-01"/)
  assert.match(handoff, /full Phase 8b\/8c finding presentation/)
  assert.match(handoff, /focused code with the target marked/)
  assert.match(handoff, /Why this matters, Suggested fix, and Suggested comment/)
  assert.match(handoff, /Accept, Reject, Edit, Add finding, Finish findings/)
  assert.match(handoff, /without resetting any prior decisions or edits/)
  assert.match(handoff, /Questions and challenges investigate this same finding without deciding or advancing it/)
  assert.ok(memory.sessions.session.offsets["finding:F-01"].y > 0)
  const discussionOffset = memory.sessions.session.offsets["finding:F-01"].y
  setOpen(true)
  await waitForContent((frame) => frame.includes("Please correct the value.") && frame.includes("after value"))
  assert.equal(memory.sessions.session.findingID, "F-01")
  closed = false
  const beforeRedisplay = calls.filter((call) => call.prompt).length
  assert.ok(view.captureCharFrame().includes("Discuss in chat [d]"))
  await commands.get("prr.diff.discuss").run()
  assert.equal(closed, true)
  assert.equal(calls.filter((call) => call.prompt).length, beforeRedisplay + 1)
  assert.match(calls.filter((call) => call.prompt).at(-1).prompt.text, /one-at-a-time findings review at finding "F-01"/)
  setOpen(true)
  await waitForContent((frame) => frame.includes("Please correct the value."))
  closed = false
  const beforeReturn = calls.filter((call) => call.prompt).length
  assert.equal(commands.get("prr.diff.close").bind, "escape")
  await commands.get("prr.diff.close").run()
  assert.equal(closed, true)
  assert.equal(calls.filter((call) => call.prompt).length, beforeReturn)
  assert.equal(memory.sessions.session.discussionFindingID, "F-01")
  assert.equal(memory.sessions.session.offsets["finding:F-01"].y, discussionOffset)
  setOpen(true)
  await waitForContent((frame) => frame.includes("Please correct the value.") && frame.includes("Back to discussion F-01 [Esc]"))
  closed = false
  await clickText("Back to discussion F-01 [Esc]")
  await view.waitFor(() => closed)
  assert.equal(calls.filter((call) => call.prompt).length, beforeReturn)
  setOpen(true)
  await waitForContent((frame) => frame.includes("Please correct the value."))
  closed = false
  frame = view.captureCharFrame()
  const continueY = frame.split("\n").findIndex((row) => row.includes("Continue review [c]"))
  await view.mockMouse.click(3, continueY)
  await view.waitFor(() => closed)
  const withFindings = calls.filter((call) => call.prompt).at(-1).prompt
  assert.match(withFindings.text, /Show the next-step choices using the question tool/)
  assert.match(withFindings.text, /does not accept or reject findings/)
  assert.equal(memory.sessions.session.findingID, "F-01")
  setOpen(true)
  await waitForContent((frame) => frame.includes("Please correct the value."))
  await commands.get("prr.diff.next").run()
  await waitForContent((frame) => frame.includes("Partner check missing."))
  await commands.get("prr.diff.discuss").run()
  const unanchored = calls.filter((call) => call.prompt).at(-1).prompt.text
  assert.match(unanchored, /one-at-a-time findings review at finding "F-02"/)
  assert.match(unanchored, /for anchor=none show no anchor line without inventing code/)
  assert.equal(closed, true)
  setOpen(true)
  await waitForContent((frame) => frame.includes("Partner check missing."))
  report.snapshot = "two"
  report.findings = []
  report.verdict = "APPROVE"
  eventHandler({ data: { sessionID: "session" }, location: context.location })
  await view.waitForFrame((frame) => frame.includes("No findings."))
  assert.equal(memory.sessions.session.findingID, null)
  assert.equal(memory.sessions.session.discussionFindingID, undefined)
  assert.ok(view.captureCharFrame().includes("Back to chat [Esc]"))
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
  await view.waitForFrame((frame) => frame.includes("Continue review [c]"))
  failPrompt = false
  let releasePrompt
  promptWait = new Promise((resolve) => { releasePrompt = resolve })
  const beforeContinue = calls.filter((call) => call.prompt).length
  const continuing = commands.get("prr.diff.continue").run()
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
  console.error(view.captureCharFrame())
  console.error(JSON.stringify({ memory, calls }))
  throw error
} finally {
  await view.dispose()
}
assert.equal(stopped, true)
