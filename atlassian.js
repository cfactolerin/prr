const maxContentBytes = 1024 * 1024
const maxPages = 20

function normalizeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function unwrap(value) {
  for (let i = 0; i < 4; i++) {
    if (value?.data !== undefined) value = value.data
    else if (value?.result !== undefined) value = value.result
    else break
  }
  return value
}

function decode(result) {
  if (result?.metadata?.isError || result?.isError) throw new Error("Atlassian MCP read failed")
  if (result?.output !== undefined) return unwrap(result.output)
  const content = result?.content
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((item) => item.type === "text").map((item) => item.text).join("\n") : ""
  if (!text || Buffer.byteLength(text) > maxContentBytes) throw new Error("Invalid Atlassian MCP response")
  return unwrap(JSON.parse(text))
}

function siteHost(url) {
  try { return new URL(url).hostname.toLowerCase() } catch { return undefined }
}

function strings(value) {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === "object") return Object.values(value).flatMap(strings)
  return []
}

function confluenceLinks(ticket) {
  return [...new Set(strings(ticket).flatMap((text) =>
    text.match(/https:\/\/[^\s/"<>]+\.atlassian\.net\/wiki\/(?:spaces\/[^\s"<>\\]+|x\/[^\s"<>\\]+)/g) ?? [],
  ).map((url) => url.replace(/[)\],.;]+$/, "")))]
}

function selectSite(resources, hint) {
  const sites = [...new Map(resources.filter((site) => site?.id && siteHost(site.url))
    .map((site) => [siteHost(site.url), site])).values()]
  if (hint) return sites.find((site) => siteHost(site.url) === siteHost(hint))
  return sites.length === 1 ? sites[0] : undefined
}

function issueHint(metadata, ticketId, baseUrl) {
  const urls = strings(metadata).flatMap((text) => text.match(/https:\/\/[^\s/"<>]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9]+-\d+/g) ?? [])
  return urls.find((url) => url.endsWith(`/browse/${ticketId}`)) ?? (baseUrl || undefined)
}

function pageHasBody(page) {
  const body = page?.body
  return typeof page?.content === "string" && page.content.trim()
    || typeof body === "string" && body.trim()
    || typeof body?.value === "string" && body.value.trim()
    || typeof body?.storage?.value === "string" && body.storage.value.trim()
    || typeof body?.markdown?.value === "string" && body.markdown.value.trim()
}

async function cancellable(operation, signal) {
  signal.throwIfAborted()
  let abort
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      }),
    ])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

async function read(tool, input, context, signal) {
  const result = await cancellable(() => tool.execute(input, { ...context, signal }), signal)
  const value = decode(result)
  if (Buffer.byteLength(JSON.stringify(value)) > maxContentBytes) throw new Error("Atlassian MCP response is too large")
  return value
}

export async function fetchAtlassianContext({ host, ticketId, metadata, baseUrl, context, resourceCache = new Map() }) {
  const unavailable = (reason) => ({ source: "unavailable", reason, site_url: issueHint(metadata, ticketId, baseUrl), ticket: null, pages: [], notes: [] })
  if (!ticketId || ticketId === "none") return unavailable("No Jira ticket detected")
  if (!host?.mcp?.list || !host?.tool?.list) return unavailable("MCP discovery is unavailable in this host")

  const controller = new AbortController()
  const abort = () => controller.abort(context.signal.reason)
  context.signal?.addEventListener("abort", abort, { once: true })
  if (context.signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new Error("Atlassian MCP timed out")), 120_000)
  try {
    controller.signal.throwIfAborted()
    const listed = await cancellable(() => host.mcp.list(undefined, { signal: controller.signal }), controller.signal)
    const servers = listed.data ?? listed
    const tools = await cancellable(() => host.tool.list(), controller.signal)
    const candidates = servers.filter((server) => server.status?.status === "connected").map((server) => {
      const prefix = `${normalizeName(server.name)}_`
      const find = (name) => tools.find((item) => item.id === `${prefix}${name}`)
      return { server, resources: find("getAccessibleAtlassianResources"), issue: find("getJiraIssue"), page: find("getConfluenceContent") ?? find("getConfluencePage") }
    }).filter((item) => item.resources && item.issue)
    if (candidates.length === 0) return unavailable("No connected Atlassian MCP with supported read tools")

    const hint = issueHint(metadata, ticketId, baseUrl)
    const choices = []
    for (const candidate of candidates) {
      try {
        const cacheKey = `${context.sessionID}:${candidate.server.name}`
        let resources = resourceCache.get(cacheKey)
        if (!resources) {
          const value = await read(candidate.resources, {}, context, controller.signal)
          resources = Array.isArray(value) ? value : value?.resources
          if (!Array.isArray(resources)) throw new Error("Invalid Atlassian site list")
          resourceCache.set(cacheKey, resources)
          if (resourceCache.size > 1000) resourceCache.delete(resourceCache.keys().next().value)
        }
        const site = selectSite(resources, hint)
        if (site) choices.push({ ...candidate, site, resources })
      } catch {
        controller.signal.throwIfAborted()
      }
    }
    if (choices.length !== 1) return unavailable("Atlassian MCP site is missing or ambiguous; include a Jira ticket URL in the PR")
    const selected = choices[0]
    const properties = selected.issue.input?.properties ?? {}
    const input = { cloudId: selected.site.id, issueIdOrKey: ticketId }
    if (properties.view) input.view = "full"
    else if (properties.fields) input.fields = ["*all"]
    if (properties.responseContentFormat) input.responseContentFormat = "markdown"
    const ticket = await read(selected.issue, input, context, controller.signal)
    if (String(ticket?.key ?? ticket?.issueKey ?? "").toUpperCase() !== ticketId.toUpperCase()
      || !(ticket.fields?.summary ?? ticket.summary)) throw new Error("MCP returned an unexpected Jira ticket")

    const snapshot = { source: "mcp", server: selected.server.name, site_url: selected.site.url, ticket, pages: [], notes: [], incomplete: false }
    const attachments = ticket.fields?.attachment ?? ticket.fields?.attachments ?? ticket.attachments
    if (Array.isArray(attachments) && attachments.length) {
      snapshot.incomplete = true
      snapshot.notes.push("MCP includes attachment metadata, but attachment files are not downloaded")
    }
    const links = confluenceLinks(ticket)
    snapshot.links = links.slice(0, maxPages)
    if (links.length > maxPages) {
      snapshot.incomplete = true
      snapshot.notes.push(`Only the first ${maxPages} linked Confluence pages were requested`)
    }
    for (const url of links.slice(0, maxPages)) {
      try {
        if (!selected.page) throw new Error("No supported Confluence read tool")
        const site = selectSite(selected.resources, url)
        if (!site) throw new Error("Linked Confluence site is unavailable")
        const properties = selected.page.input?.properties ?? {}
        const input = { cloudId: site.id }
        if (properties.content_url) {
          Object.assign(input, { content_url: url, detail: "full", content_format: "markdown" })
        } else {
          const pageId = url.match(/\/pages\/(\d+)/)?.[1]
          if (!pageId) throw new Error("Confluence short links require getConfluenceContent")
          input.pageId = pageId
          if (properties.contentFormat) input.contentFormat = "markdown"
        }
        const page = await read(selected.page, input, context, controller.signal)
        if (!pageHasBody(page)) throw new Error("Confluence page body is missing")
        snapshot.pages.push({ url, content: page })
      } catch {
        if (context.signal?.aborted) throw context.signal.reason
        snapshot.incomplete = true
        snapshot.notes.push(`Confluence page unavailable through MCP: ${url}`)
      }
    }
    return snapshot
  } catch {
    if (context.signal?.aborted) throw context.signal.reason
    return unavailable("Atlassian MCP could not fetch the ticket; trying the Jira API token")
  } finally {
    clearTimeout(timer)
    context.signal?.removeEventListener("abort", abort)
  }
}
