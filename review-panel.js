import { RGBA, SyntaxStyle, TextAttributes } from "@opentui/core"
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
  const [deciding, setDeciding] = createSignal(false)
  const [decisions, setDecisions] = createSignal()
  const [report, { refetch }] = createResource(
    () => [panel.sessionID, revision()],
    async ([sessionID]) => ({ sessionID, report: await rpc.investigation({ sessionID }, { location: location() }) }),
  )
  const stop = rpc.events.on("updated", (event) => {
    if (event.data.sessionID === panel.sessionID && event.location.directory === location().directory
      && event.location.workspaceID === location().workspaceID) setRevision((value) => value + 1)
  })
  onCleanup(stop)
  const latest = () => !report.error && report()?.sessionID === panel.sessionID ? report().report : null
  const data = createMemo(latest, undefined, { equals: (a, b) => a === b || !!a && !!b && a.snapshot === b.snapshot })
  const view = () => memory.sessions[panel.sessionID]
  const current = () => view()?.snapshot === data()?.snapshot ? view() : null
  let scroll
  let scrollSelection
  let initializedFocus = false
  const headingColor = context.theme.text.feedback?.info?.base ?? context.theme.text.action.primary.base
  const fixColor = context.theme.text.feedback?.success?.base ?? context.theme.text.action.primary.base
  const style = SyntaxStyle.fromStyles({
    default: { fg: context.theme.text.base },
    "markup.heading": { fg: headingColor, bold: true },
    "markup.strong": { fg: headingColor, bold: true },
    "markup.italic": { italic: true },
    "markup.raw": { fg: context.theme.text.action.primary.base },
    "markup.link": { fg: context.theme.text.action.primary.base, underline: true },
  }, context.renderer.nativeScene)
  const foreground = typeof context.theme.text.base === "string" ? RGBA.fromHex(context.theme.text.base) : context.theme.text.base
  const luminance = [foreground.r, foreground.g, foreground.b].map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  const issueBackground = luminance > 0.179 ? "#174b73" : "#b9ddff"
  onCleanup(() => {
    saveScroll()
    void context.renderer.idle().then(() => style.destroy())
  })
  createEffect(() => {
    const value = latest()
    if (!value) return
    const opening = !initializedFocus
    initializedFocus = true
    const previous = untrack(view)
    const known = untrack(decisions)
    if (known?.snapshot !== value.snapshot || (value.revision ?? 0) >= (known.revision ?? 0)) setDecisions(value)
    if (previous?.snapshot === value.snapshot && previous.focusRequest === value.focus_request && !(opening && value.active_finding_id)) return
    if (previous?.snapshot === value.snapshot) untrack(saveScroll)
    const focused = value.findings.find((item) => item.id === value.active_finding_id)
    updateMemory((draft) => {
      const sameSnapshot = previous?.snapshot === value.snapshot
      draft.sessions[panel.sessionID] = {
        ...(sameSnapshot ? previous : { snapshot: value.snapshot, fileID: value.files[0]?.id, findingID: null, offsets: {} }),
        focusRequest: value.focus_request,
        ...(focused ? { findingID: focused.id, ...(focused.fileID !== undefined ? { fileID: focused.fileID } : {}) } : {}),
      }
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
  const sendToChat = async (text, discussionFindingID) => {
    if (submitting()) return
    saveScroll()
    const snapshot = data()?.snapshot
    setSubmitting(true)
    try {
      await context.client.session.prompt({ sessionID: panel.sessionID, text }, { location: location() })
      panel.close()
      if (discussionFindingID && view()?.snapshot === snapshot) updateMemory((draft) => {
        draft.sessions[panel.sessionID].discussionFindingID = discussionFindingID
      })
    } catch (error) {
      context.ui.toast.show({ message: displayText(error.message), variant: "error" })
    } finally {
      setSubmitting(false)
    }
  }
  const continueReview = () => {
    if (!data()) return close()
    return sendToChat("Return from the PRR diff view to the interactive investigation menu for the current saved review. Read prr_findings with operation=get and preserve all shared decisions and approved edits before continuing. Show the next-step choices using the question tool, including Post review when there are no findings. Do not reopen the diff view or repeat the briefing. This only resumes the menu; it does not accept or reject findings, complete investigation, or authorize posting. If the review has already advanced beyond investigation, preserve its current stage rather than restarting it.")
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
  const adjacentFile = (step) => {
    const files = data()?.files ?? []
    if (!files.length) return
    const index = files.findIndex((file) => file.id === current()?.fileID)
    selectFile(files[index < 0 ? step > 0 ? 0 : files.length - 1 : (index + step + files.length) % files.length].id)
  }
  const discuss = async () => {
    if (submitting()) return
    const selected = finding()
    if (!selected) return
    await sendToChat(`Open the existing one-at-a-time findings review at finding ${JSON.stringify(selected.id)} in the current saved PRR review. Use Phase 8a to parse and verify the saved report without resetting any prior decisions or edits. Show the full Phase 8b/8c finding presentation: focused code with the target marked when anchored, location, origin, Why this matters, Suggested fix, and Suggested comment. Mark reference code as unchanged; for anchor=none show no anchor line without inventing code. Preserve the saved finding text; do not replace this view with a brief summary or an open-ended question. Restore the per-finding question-tool menu: Accept, Reject, Edit, Add finding, Finish findings. Questions and challenges investigate this same finding without deciding or advancing it. The briefing has already been continued; enter or resume the findings review directly, completing step 7 only if this is its first transition from investigation. Do not repeat the briefing, show the investigation-mode chooser, reopen the diff automatically, or reset the review. This opens the finding for discussion, not acceptance, rejection, or permission to post.`, selected.id)
  }
  const decide = async (status) => {
    const selected = finding()
    if (!selected || deciding() || submitting()) return
    saveScroll()
    setDeciding(true)
    try {
      const result = await rpc.decide({ sessionID: panel.sessionID, snapshot: data().snapshot, revision: decisions()?.revision ?? 0, findingID: selected.id, status }, { location: location() })
      if (result.snapshot === data()?.snapshot && result.revision >= (decisions()?.revision ?? 0)) setDecisions(result)
      if (result.warning) context.ui.toast.show({ message: displayText(result.warning), variant: "warning" })
    } catch (error) {
      context.ui.toast.show({ message: displayText(error.message), variant: "error" })
      void refetch()
    } finally { setDeciding(false) }
  }
  context.keymap.layer(() => ({ priority: 10, commands: [
    { id: "prr.diff.close", bind: "escape", run: close },
    { id: "prr.diff.continue", bind: "c", run: continueReview },
    { id: "prr.diff.findings", bind: "b", run: () => selectFinding(null) },
    { id: "prr.diff.next", bind: "n", run: () => adjacent(1) },
    { id: "prr.diff.previous", bind: "p", run: () => adjacent(-1) },
    { id: "prr.diff.file.previous", bind: "h", run: () => adjacentFile(-1) },
    { id: "prr.diff.file.next", bind: "l", run: () => adjacentFile(1) },
    { id: "prr.diff.accept", bind: "a", run: () => decide("accepted") },
    { id: "prr.diff.reject", bind: "x", run: () => decide("rejected") },
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
  const heading = (value, color = headingColor, props = {}) => text(value, { fg: color, attributes: TextAttributes.BOLD, flexShrink: 0, ...props })
  const decision = (id) => decisions()?.decisions?.find((item) => item.finding_id === id)
  const decisionLabel = (id) => element("text", {
    fg: context.theme.text.muted, flexShrink: 0,
    get children() { return `Decision: ${displayText(decision(id)?.status ?? "pending")}${deciding() && finding()?.id === id ? " · saving…" : ""}` },
  })
  const markdown = (value) => element("markdown", {
    content: displayText(value), syntaxStyle: style, fg: context.theme.text.base, conceal: true, concealCode: true, internalBlockMode: "top-level", width: "100%", flexShrink: 0,
  })
  const button = (label, action, props = {}) => text(label, {
    fg: context.theme.text.action.primary.base, attributes: TextAttributes.UNDERLINE, flexShrink: 0, onMouseDown: action, ...props,
  })
  const fileColor = (status) => {
    const theme = context.theme
    const feedback = theme.text.feedback
    return ({
      added: theme.diff?.text.added ?? feedback?.success?.base,
      deleted: theme.diff?.text.removed ?? feedback?.error?.base,
      modified: feedback?.warning?.base,
      renamed: feedback?.info?.base,
    })[status] ?? theme.text.action.primary.base
  }
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
      fg: context.theme.text.base, lineNumberFg: context.theme.text.base,
      get width() { return Math.max(20, panel.width - (panel.width < 100 ? 30 : 40)) },
      flexShrink: 0,
      renderAfter() {
        if (positioned || !scroll || !node.height) return
        positioned = true
        for (const row of rows) node.setLineColor(row, { gutter: issueBackground, content: issueBackground })
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
        heading(`PRR investigation · ${value.round} · ${value.verdict} · ${value.confidence}`),
        element("box", { flexDirection: "row", flexShrink: 0, gap: 2, children: [
          button("Files [o]", () => context.keymap.dispatch("prr.diff.files")),
          text("[h/l] Cycle files  [b] List  [p/n] Findings  [a/x] Accept/reject  [d] Discuss  [r] Refresh  [Esc] Chat  [c] Continue", { fg: context.theme.text.muted }),
        ] }),
        ...(value.warnings ? [text(value.warnings, { fg: context.theme.text.action.primary.base })] : []),
        element("box", {
          flexDirection: "row", flexGrow: 1, minHeight: 0,
          children: [
            element("box", {
              flexDirection: "column", flexGrow: 1, minWidth: 20,
              children: [
                ...(value.files.length ? [element("box", { flexDirection: "row", flexShrink: 0, height: 1, gap: 2, children: [
                  button("↑ Previous file", () => adjacentFile(-1)),
                  button("↓ Next file", () => adjacentFile(1)),
                ] })] : []),
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
                heading(`${finding().id} · ${finding().severity} · ${finding().trigger}`, context.theme.text.feedback?.[finding().severity === "HIGH" ? "error" : "warning"]?.base ?? headingColor, { marginTop: 1 }),
                heading(finding().title),
                decisionLabel(finding().id),
                element("box", { flexDirection: "row", flexShrink: 0, gap: 2, children: [
                  element("text", {
                    fg: context.theme.text.action.primary.base, attributes: TextAttributes.UNDERLINE, flexShrink: 0, onMouseDown: () => decide("accepted"),
                    get children() { return decision(finding()?.id)?.status === "edited" ? "Accept original [a]" : "Accept [a]" },
                  }), button("Reject [x]", () => decide("rejected")),
                ] }),
                ...(finding().origin === "pre-existing" ? [text("Pre-existing — not caused by this PR; non-blocking.", { marginTop: 1 })] : []),
                text(finding().anchor === "none" ? "No code location" : `${finding().path}:${finding().start_line ?? finding().line}${finding().start_line ? `–${finding().line}` : ""}`),
                heading("Why this matters", headingColor, { marginTop: 1 }), markdown(finding().why_it_matters),
                heading("Suggested fix", fixColor, { marginTop: 1 }), markdown(finding().suggested_fix),
                heading("Suggested comment", context.theme.text.action.primary.base, { marginTop: 1 }), markdown(finding().suggested_comment),
                element("box", { flexDirection: "column", flexShrink: 0, get children() {
                  const approved = decision(finding()?.id)?.overridden_body
                  return approved ? [heading("Approved edit", fixColor, { marginTop: 1 }), markdown(approved)] : []
                } }),
                button("Previous [p]", () => adjacent(-1)), button("Next [n]", () => adjacent(1)),
                button("Discuss in chat [d]", discuss),
              ] : [
                heading("Findings"),
                ...(!value.findings.length ? [text("No findings. Browse any changed file, then Continue review to choose the next step.")] : value.findings.map((item) => element("box", { flexDirection: "column", flexShrink: 0, children: [button(
                  `${item.severity} · ${item.id} · ${item.title}${item.origin === "pre-existing" ? " (pre-existing)" : ""}${item.anchor === "none" ? " (no code location)" : ""}`,
                  () => selectFinding(item.id),
                ), decisionLabel(item.id)] }))),
                heading("Changed files", headingColor, { marginTop: 1 }),
                ...value.files.map((file) => button(`${file.status} · ${file.path}`, () => selectFile(file.id), {
                  fg: fileColor(file.status),
                  attributes: TextAttributes.UNDERLINE | (current()?.fileID === file.id ? TextAttributes.BOLD : 0),
                })),
              ],
            }),
          ],
        }),
        button(current()?.discussionFindingID ? `Back to discussion ${current().discussionFindingID} [Esc]` : "Back to chat [Esc]", close),
        element("text", {
          fg: context.theme.text.action.primary.base, attributes: TextAttributes.UNDERLINE, flexShrink: 0, onMouseDown: continueReview,
          get children() { return submitting() ? "Returning to chat…" : "Continue review [c] — choose the next review action" },
        }),
      ]
    },
  })
}
