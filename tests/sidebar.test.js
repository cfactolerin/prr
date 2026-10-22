import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

test("sidebar renders progress, context and links, refreshes live, and isolates sessions", () => {
  const result = spawnSync(process.execPath, ["--conditions=browser", "--input-type=module", "-e", `
    import assert from "node:assert/strict"
    import { testRender } from "@opentui/solid"
    import { createSignal } from "solid-js"
    import { reviewSidebar } from "./tui.js"
    import { reviewSteps } from "./review-state.js"
    const [session, setSession] = createSignal("s1")
    let handler
    let stopped = false
    const ticketUrl = "https://company.atlassian.net/browse/DI-1364"
    const state = {
      steps: reviewSteps.map((label, index) => ({label, status: index === 0 ? "completed" : index === 1 ? "in_progress" : "pending"})),
      summary: [
        {label: "PRR", text: "v0.24.0"},
        {label: "PR", text: "https://github.com/IndependentIP/delivery/pull/2606", url: "https://github.com/IndependentIP/delivery/pull/2606"},
        {label: "Title", text: "DI-1364: Bound aggregated-delivery Slack alerts and summarize large histories"},
        {label: "Author", text: "pegasusflyhigh"},
        {label: "Branch", text: "fix/aggregated-slack-alert-size -> master"},
        {label: "Ticket", text: "DI-1364", url: ticketUrl},
        {label: "Round", text: "r1"},
      ],
    }
    const rpc = {
      get: async ({sessionID}) => sessionID === "s1" ? structuredClone(state) : null,
      events: {on: (_name, callback) => { handler = callback; return () => { stopped = true } }},
    }
    const context = {
      location: {directory: "/repo"},
      theme: {text: {base: "#ffffff", muted: "#aaaaaa", action: {primary: {base: "#00ffff"}}}},
    }
    const view = await testRender(() => reviewSidebar(context, {get sessionID() {return session()}}, rpc), {width: 36, height: 35})
    try {
      let frame = await view.waitForFrame(frame => frame.includes("DI-1364"))
      assert.ok(frame.includes("✓ Cleanup stale reviews"))
       assert.ok(frame.includes("◉ Gather context"))
      assert.ok(frame.includes("Review briefing"))
      assert.ok(frame.includes("Interactive investigation"))
      assert.ok(frame.includes("Context manifest"))
      for (const label of ["PRR:", "PR:", "Title:", "Author:", "Branch:", "Ticket:", "Round:"]) assert.ok(frame.includes(label))
      const text = view.renderer.root.getChildren()[0].getChildren().find(node => node.plainText?.includes("Ticket:"))
      assert.ok(text)
      assert.ok(text.textNode.gatherWithInheritedStyle().some(chunk => chunk.text === "DI-1364" && chunk.link?.url === ticketUrl))
      state.steps[1].status = "completed"
      handler({data: {sessionID: "other"}, location: context.location})
      await view.flush()
      assert.ok(view.captureCharFrame().includes("◉ Gather context"))
      handler({data: {sessionID: "s1"}, location: context.location})
      await view.waitForFrame(frame => frame.includes("✓ Gather context"))
      setSession("s2")
      await view.waitForFrame(frame => !frame.includes("DI-1364"))
      setSession("s1")
      await view.waitForFrame(frame => frame.includes("DI-1364"))
    } finally {
      await view.dispose()
    }
    assert.equal(stopped, true)
  `], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000 })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
