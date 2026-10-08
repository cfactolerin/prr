import assert from "node:assert/strict"
import { test } from "node:test"
import { fetchAtlassianContext } from "../atlassian.js"

function fixture({ connected = true, sites, ticket, pageFailure = false, pageTool = true } = {}) {
  const calls = []
  const tool = (name, properties, value) => ({
    id: `company_atlassian_${name}`, input: { properties },
    execute: async (input, context) => {
      calls.push({ name, input, context })
      if (value instanceof Error) throw value
      return { content: [{ type: "text", text: JSON.stringify(value) }] }
    },
  })
  const tools = [
    tool("getAccessibleAtlassianResources", {}, sites ?? [{ id: "site-1", url: "https://company.atlassian.net" }]),
    tool("getJiraIssue", { view: {}, responseContentFormat: {} }, ticket ?? {
      key: "DI-123", fields: {
        summary: "A change", description: "Requirements: https://company.atlassian.net/wiki/x/abc",
        customFields: { "Acceptance criteria": "Preserve ordering" },
      },
    }),
    tool("deleteJiraIssue", {}, new Error("A write tool must never be called")),
  ]
  if (pageTool) tools.push(tool("getConfluenceContent", { content_url: {} },
    pageFailure ? new Error("Read failed") : { title: "Requirements", body: { value: "Full page content" } }))
  const host = {
    mcp: { list: async () => ({ data: [{ name: "company.atlassian", status: { status: connected ? "connected" : "needs_auth" } }] }) },
    tool: { list: async () => tools },
  }
  const context = { sessionID: "session-1", agent: "prr-orchestrator", signal: new AbortController().signal }
  return { host, context, calls, ticketId: "DI-123", metadata: {} }
}

test("connected Atlassian MCP fetches full ticket fields and linked short URLs read-only", async () => {
  const input = fixture()
  const snapshot = await fetchAtlassianContext(input)
  assert.equal(snapshot.source, "mcp")
  assert.equal(snapshot.ticket.fields.customFields["Acceptance criteria"], "Preserve ordering")
  assert.equal(snapshot.pages[0].content.body.value, "Full page content")
  assert.deepEqual(input.calls.map((call) => call.name), ["getAccessibleAtlassianResources", "getJiraIssue", "getConfluenceContent"])
  assert.deepEqual(input.calls[1].input, { cloudId: "site-1", issueIdOrKey: "DI-123", view: "full", responseContentFormat: "markdown" })
  assert.deepEqual(input.calls[2].input, { cloudId: "site-1", content_url: "https://company.atlassian.net/wiki/x/abc", detail: "full", content_format: "markdown" })
  assert.equal(input.calls[1].context.sessionID, "session-1")
})

test("configured but unauthenticated servers are not used", async () => {
  const input = fixture({ connected: false })
  assert.equal((await fetchAtlassianContext(input)).source, "unavailable")
  assert.equal(input.calls.length, 0)
})

test("missing bridge, no ticket, and failed reads request REST fallback", async () => {
  assert.equal((await fetchAtlassianContext({ ticketId: "DI-123", context: {} })).source, "unavailable")
  const input = fixture({ ticket: new Error("Authentication expired") })
  assert.equal((await fetchAtlassianContext(input)).source, "unavailable")
  const noTicket = fixture()
  assert.equal((await fetchAtlassianContext({ ...noTicket, ticketId: "none" })).source, "unavailable")
  assert.equal(noTicket.calls.length, 0)
})

test("multiple sites require a matching PR link or configured site", async () => {
  const input = fixture({ sites: [
    { id: "site-2", url: "https://other.atlassian.net" },
    { id: "site-1", url: "https://company.atlassian.net" },
  ] })
  assert.equal((await fetchAtlassianContext(input)).source, "unavailable")
  assert.equal(input.calls.filter((call) => call.name === "getJiraIssue").length, 0)
  const selected = await fetchAtlassianContext({ ...input, metadata: { body: "https://company.atlassian.net/browse/DI-123" } })
  assert.equal(selected.source, "mcp")
  assert.equal(input.calls.find((call) => call.name === "getJiraIssue").input.cloudId, "site-1")
})

test("wrong-ticket responses never reach the review snapshot", async () => {
  const input = fixture({ ticket: { key: "OTHER-1", fields: { summary: "Wrong issue" } } })
  assert.equal((await fetchAtlassianContext(input)).source, "unavailable")
})

test("failed linked-page reads preserve the ticket and request supplemental REST fallback", async () => {
  const snapshot = await fetchAtlassianContext(fixture({ pageFailure: true }))
  assert.equal(snapshot.source, "mcp")
  assert.equal(snapshot.incomplete, true)
  assert.equal(snapshot.pages.length, 0)
  assert.match(snapshot.notes[0], /Confluence page unavailable/)
  const missing = await fetchAtlassianContext(fixture({ pageTool: false }))
  assert.equal(missing.incomplete, true)
})

test("site discovery is cached per session and server, not globally across accounts", async () => {
  const input = fixture()
  const resourceCache = new Map()
  await fetchAtlassianContext({ ...input, resourceCache })
  await fetchAtlassianContext({ ...input, resourceCache })
  assert.equal(input.calls.filter((call) => call.name === "getAccessibleAtlassianResources").length, 1)
  await fetchAtlassianContext({ ...input, resourceCache, context: { ...input.context, sessionID: "session-2" } })
  assert.equal(input.calls.filter((call) => call.name === "getAccessibleAtlassianResources").length, 2)
})

test("cancellation stops context gathering rather than starting token fallback", async () => {
  const input = fixture()
  const controller = new AbortController()
  controller.abort(new Error("Cancelled"))
  await assert.rejects(fetchAtlassianContext({ ...input, context: { ...input.context, signal: controller.signal } }), /Cancelled/)
  assert.equal(input.calls.length, 0)
})

test("attachment metadata requests REST supplementation instead of implying files were downloaded", async () => {
  const input = fixture({ ticket: {
    key: "DI-123", fields: { summary: "Ticket with attachments", attachment: [{ filename: "requirements.pdf" }] },
  } })
  const snapshot = await fetchAtlassianContext(input)
  assert.equal(snapshot.source, "mcp")
  assert.equal(snapshot.incomplete, true)
  assert.match(snapshot.notes[0], /attachment files are not downloaded/)
})

test("page reads are bounded and skipped links are reported", async () => {
  const description = Array.from({ length: 21 }, (_, index) => `https://company.atlassian.net/wiki/spaces/DI/pages/${index + 1}/Requirements`).join("\n")
  const input = fixture({ ticket: { key: "DI-123", fields: { summary: "Many links", description } } })
  const snapshot = await fetchAtlassianContext(input)
  assert.equal(snapshot.pages.length, 20)
  assert.equal(snapshot.links.length, 20)
  assert.equal(snapshot.incomplete, true)
  assert.match(snapshot.notes[0], /first 20/)
})

test("older Atlassian schemas request all Jira fields and numeric Confluence page IDs", async () => {
  const input = fixture({ ticket: {
    key: "DI-123", fields: { summary: "Older schema", description: "https://company.atlassian.net/wiki/spaces/DI/pages/123/Requirements" },
  } })
  const tools = await input.host.tool.list()
  tools.find((tool) => tool.id.endsWith("getJiraIssue")).input = { properties: { fields: {} } }
  const page = tools.find((tool) => tool.id.endsWith("getConfluenceContent"))
  page.id = "company_atlassian_getConfluencePage"
  page.input = { properties: { pageId: {}, contentFormat: {} } }
  input.host.tool.list = async () => tools
  assert.equal((await fetchAtlassianContext(input)).source, "mcp")
  assert.deepEqual(input.calls[1].input, { cloudId: "site-1", issueIdOrKey: "DI-123", fields: ["*all"] })
  assert.deepEqual(input.calls[2].input, { cloudId: "site-1", pageId: "123", contentFormat: "markdown" })
})
