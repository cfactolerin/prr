import { SyntaxStyle } from "@opentui/core"
import { createElement, spread } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, onCleanup, untrack } from "solid-js"
import { displayText, findingRows } from "./review-diff.js"

export const investigationPanel = "prr.investigation"

function element(tag, props) {
  const node = createElement(tag)
  spread(node, props)
  return node
}

export function reviewPanel(context, panel, rpc) {
  const [memory, updateMemory] = context.storage.memory("investigation", { initial: { sessions: {} } })
  const location = () => context.location ?? context.data.location.default()
  const [revision, setRevision] = createSignal(0)
  const [submitting, setSubmitting] = createSignal(false)
  const [report, { refetch }] = createResource(
    () => [panel.sessionID, revision()],
    async ([sessionID]) => ({ sessionID, report: await rpc.investigation({ sessionID }, { location: location() }) }),
  )
  const stop = rpc.events.on("updated", (event) => {
    if (event.data.sessionID === panel.sessionID && event.location.directory === location().directory
      && event.location.workspaceID === location().workspaceID) setRevision((value) => value + 1)
  })
  onCleanup(stop)
  const data = () => !report.error && report()?.sessionID === panel.sessionID ? report().report : null
  const view = () => memory.sessions[panel.sessionID]
  const current = () => view()?.snapshot === data()?.snapshot ? view() : null
  let scroll
  let scrollSelection
  const style = SyntaxStyle.fromStyles({ default: { fg: context.theme.text.base } }, context.renderer.nativeScene)
  onCleanup(() => {
    saveScroll()
    void context.renderer.idle().then(() => style.destroy())
  })
  createEffect(() => {
    const value = data()
    if (!value || current()) return
    updateMemory((draft) => {
      draft.sessions[panel.sessionID] = { snapshot: value.snapshot, fileID: value.files[0]?.id, findingID: null, offsets: {} }
    })
  })
  const selectionKey = () => current()?.findingID ? `finding:${current().findingID}` : `file:${current()?.fileID}`
  const saveScroll = () => {
    if (!scroll || scroll.isDestroyed || !current() || scrollSelection !== `${data()?.snapshot}:${selectionKey()}`) return
    const offset = { x: scroll.scrollLeft, y: scroll.scrollTop }
    updateMemory((draft) => { draft.sessions[panel.sessionID].offsets[selectionKey()] = offset })
  }
  const finding = () => data()?.findings.find((item) => item.id === current()?.findingID)
  const selectFinding = (id) => {
    saveScroll()
    if (!current()) return
    updateMemory((draft) => {
      draft.sessions[panel.sessionID].findingID = id
      const selected = data()?.findings.find((item) => item.id === id)
      if (selected?.fileID !== undefined) draft.sessions[panel.sessionID].fileID = selected.fileID
    })
  }
  const selectFile = (id) => {
    saveScroll()
    if (!current()) return
    updateMemory((draft) => {
      draft.sessions[panel.sessionID].fileID = id
      draft.sessions[panel.sessionID].findingID = null
    })
  }
  const close = () => { saveScroll(); panel.close() }
  const sendToChat = async (text) => {
    if (submitting()) return
    saveScroll()
    setSubmitting(true)
    try {
      await context.client.session.prompt({ sessionID: panel.sessionID, text }, { location: location() })
      panel.close()
    } catch (error) {
      context.ui.toast.show({ message: displayText(error.message), variant: "error" })
    } finally {
      setSubmitting(false)
    }
  }
  const continueReview = () => {
    if (!data()) return close()
    return sendToChat("Return from the PRR diff view to the interactive investigation menu for the current saved review. Show the next-step choices using the question tool, including Post review when there are no findings. Do not reopen the diff view or repeat the briefing. This only resumes the menu; it does not accept or reject findings, complete investigation, or authorize posting. If the review has already advanced beyond investigation, preserve its current stage rather than restarting it.")
  }
  const adjacent = (step) => {
    const findings = data()?.findings ?? []
    if (!findings.length) return
    const index = findings.findIndex((item) => item.id === current()?.findingID)
    selectFinding(findings[index < 0 ? step > 0 ? 0 : findings.length - 1 : (index + step + findings.length) % findings.length].id)
  }
  const [content] = createResource(
    () => {
      if (!data() || !current()) return false
      return { sessionID: panel.sessionID, snapshot: data().snapshot, key: selectionKey(), fileID: current().fileID, findingID: current().findingID }
    },
    async ({ sessionID, snapshot, key, fileID, findingID }) => ({
      sessionID, snapshot, key,
      value: await rpc.diff({ sessionID, snapshot, ...(findingID ? { findingID } : fileID !== undefined ? { fileID } : {}) }, { location: location() }),
    }),
  )
  const patch = () => {
    if (content.error) return null
    const result = content()
    return result?.sessionID === panel.sessionID && result.snapshot === data()?.snapshot && result.key === selectionKey() ? result.value : null
  }
  const discuss = async () => {
    if (submitting()) return
    const selected = finding()
    const snapshot = data()?.snapshot
    if (!selected) return
    const question = await context.ui.dialog.prompt({ title: `Discuss ${displayText(selected.id)}`, placeholder: "What would you like to check?" })
    if (!question?.trim() || snapshot !== data()?.snapshot) return
    await sendToChat(`Investigate finding ${JSON.stringify(selected.id)} in the current saved PRR review. This is a request for evidence, not acceptance, rejection, or permission to post.\n\n${question}`)
  }
  context.keymap.layer(() => ({ priority: 10, commands: [
    { id: "prr.diff.close", bind: "escape", run: continueReview },
    { id: "prr.diff.continue", bind: "c", run: continueReview },
    { id: "prr.diff.findings", bind: "b", run: () => selectFinding(null) },
    { id: "prr.diff.next", bind: "n", run: () => adjacent(1) },
    { id: "prr.diff.previous", bind: "p", run: () => adjacent(-1) },
    { id: "prr.diff.files", bind: "o", run: async () => {
      const snapshot = data()?.snapshot
      const id = await context.ui.dialog.select({ title: "Changed files", options: (data()?.files ?? []).map((file) => ({ title: displayText(file.path), value: file.id, description: file.status })) })
      if (snapshot === data()?.snapshot && id !== undefined && data()?.files.some((file) => file.id === id)) selectFile(id)
    } },
    { id: "prr.diff.discuss", bind: "d", run: discuss },
    { id: "prr.diff.refresh", bind: "r", run: () => { saveScroll(); void refetch() } },
    ...[["up", -3], ["down", 3], ["pageup", -20], ["pagedown", 20]].map(([bind, y]) => ({
      id: `prr.diff.scroll.${bind}`, bind, run: () => scroll?.scrollBy({ x: 0, y }),
    })),
  ] }))
  const text = (value, props = {}) => element("text", { fg: context.theme.text.base, wrapMode: "word", children: displayText(value), ...props })
  const button = (label, action) => text(label, { fg: context.theme.text.action.primary.base, onMouseDown: action })
  const diffNode = createMemo(() => {
    const value = patch()
    if (!value?.patch || !/^@@ /m.test(value.patch)) return null
    const selected = finding()
    const safePatch = displayText(value.patch)
    const rows = findingRows(value.patch, selected)
    const offset = untrack(() => current()?.offsets[selectionKey()]) ?? { x: 0, y: Math.max(0, (rows[0] ?? 0) - 5) }
    let positioned = false
    const node = element("diff", {
      diff: safePatch, view: "split", syncScroll: true, wrapMode: "none", showLineNumbers: true, syntaxStyle: style,
      get width() { return Math.max(20, panel.width - (panel.width < 100 ? 30 : 40)) },
      flexShrink: 0,
      renderAfter() {
        if (positioned || !scroll || !node.height) return
        positioned = true
        for (const row of rows) node.setLineColor(row, { gutter: context.theme.text.action.primary.base })
        scroll.scrollTo(offset)
      },
    })
    return node
  })
  return element("box", {
    flexDirection: "column", height: "100%", width: "100%",
    get children() {
      if (report.error) return [text(`Cannot open diff investigation: ${report.error.message}`), button("Retry [r]", () => void refetch()), button("Return to chat [Esc]", close)]
      if (!data()) return [text("Loading saved review…"), button("Return to chat [Esc]", close)]
      const value = data()
      return [
        text(`PRR investigation · ${value.round} · ${value.verdict} · ${value.confidence}`, { flexShrink: 0 }),
        text("[o] Files   [b] Findings   [p/n] Previous/next finding   [d] Discuss   [r] Refresh   [c/Esc] Continue review", { fg: context.theme.text.muted, flexShrink: 0 }),
        ...(value.warnings ? [text(value.warnings, { fg: context.theme.text.action.primary.base })] : []),
        element("box", {
          flexDirection: "row", flexGrow: 1, minHeight: 0,
          children: [
            element("box", {
              flexDirection: "column", flexGrow: 1, minWidth: 20,
              children: [
                button("Choose file [o]", () => context.keymap.dispatch("prr.diff.files")),
                text(patch()?.path || "No code selected", { flexShrink: 0 }),
                element("box", { flexDirection: "row", flexShrink: 0, children: [
                  text("Before", { width: "50%", fg: context.theme.text.muted }),
                  text("After", { width: "50%", fg: context.theme.text.muted }),
                ] }),
                ...(content.error ? [text(`Cannot load diff: ${content.error.message}`)]
                  : !patch() ? [text("Loading diff…")]
                  : [text(patch().message, { flexShrink: 0 }), element("scrollbox", {
                    ref: (node) => { scroll = node; scrollSelection = `${data()?.snapshot}:${selectionKey()}` },
                    scrollX: false, scrollY: true, flexGrow: 1, minHeight: 0,
                    children: diffNode(),
                  })]),
              ],
            }),
            element("scrollbox", {
              width: panel.width < 100 ? 28 : 38, flexShrink: 0, border: ["left"], paddingLeft: 1, scrollY: true,
              children: finding() ? [
                button("← All findings [b]", () => selectFinding(null)),
                text(`${finding().id} · ${finding().severity} · ${finding().trigger}`, { marginTop: 1 }),
                text(finding().title),
                ...(finding().origin === "pre-existing" ? [text("Pre-existing — not caused by this PR; non-blocking.", { marginTop: 1 })] : []),
                text(finding().anchor === "none" ? "No code location" : `${finding().path}:${finding().start_line ?? finding().line}${finding().start_line ? `–${finding().line}` : ""}`),
                text("Why this matters", { marginTop: 1 }), text(finding().why_it_matters),
                text("Suggested fix", { marginTop: 1 }), text(finding().suggested_fix),
                text("Suggested comment", { marginTop: 1 }), text(finding().suggested_comment),
                button("Previous [p]", () => adjacent(-1)), button("Next [n]", () => adjacent(1)), button("Discuss in chat [d]", discuss),
              ] : [
                text("Findings"),
                ...(!value.findings.length ? [text("No findings. Browse any changed file, then Continue review to choose the next step.")] : value.findings.map((item) => button(
                  `${item.severity} · ${item.id} · ${item.title}${item.origin === "pre-existing" ? " (pre-existing)" : ""}${item.anchor === "none" ? " (no code location)" : ""}`,
                  () => selectFinding(item.id),
                ))),
                text("Changed files", { marginTop: 1 }),
                ...value.files.map((file) => button(`${file.status} · ${file.path}`, () => selectFile(file.id))),
              ],
            }),
          ],
        }),
        element("text", {
          fg: context.theme.text.action.primary.base, flexShrink: 0, onMouseDown: continueReview,
          get children() { return submitting() ? "Returning to chat…" : "Continue review [c / Esc] — return to the investigation menu" },
        }),
      ]
    },
  })
}
