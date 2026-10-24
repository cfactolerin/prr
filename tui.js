import { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { createElement, spread } from "@opentui/solid"
import { createComponent, createResource, onCleanup, Show } from "solid-js"
import { reviewRpc } from "./review-rpc.js"
import { httpLink, investigationReady } from "./review-state.js"
import { investigationPanel, reviewPanel } from "./review-panel.js"

function element(tag, props) {
  const node = createElement(tag)
  spread(node, props)
  return node
}

export function watchDiffRequests(context, rpc) {
  const [memory, updateMemory] = context.storage.memory("diff-requests", { initial: { seen: {} } })
  let disposed = false
  const location = () => context.location ?? context.data.location.default()
  const session = () => {
    const route = context.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  const stop = rpc.events.on("openDiff", async (event) => {
    const { sessionID, diffRequest } = event.data
    const scope = location()
    if (!diffRequest || session() !== sessionID || event.location.directory !== scope.directory
      || event.location.workspaceID !== scope.workspaceID) return
    const key = JSON.stringify([scope.directory, scope.workspaceID, sessionID])
    if (memory.seen[key] === diffRequest) return
    try {
      const request = await rpc.pendingDiff({ sessionID }, { location: scope })
      if (disposed || session() !== sessionID || location().directory !== scope.directory
        || location().workspaceID !== scope.workspaceID || memory.seen[key] === diffRequest
        || request?.diffRequest !== diffRequest) return
      updateMemory((draft) => { draft.seen[key] = diffRequest })
      context.ui.panel.open(investigationPanel, { presentation: "fullscreen" })
    } catch {
      if (!disposed && session() === sessionID) context.ui.toast.show({
        message: "Could not open diff investigation automatically. Use /prr-diff to open it.", variant: "error",
      })
    }
  })
  onCleanup(() => { disposed = true; stop() })
}

export function reviewSidebar(context, props, rpc) {
  const [review, { refetch }] = createResource(
    () => props.sessionID,
    async (sessionID, { value }) => {
      try {
        const state = await rpc.get({ sessionID }, { location: context.location ?? context.data.location.default() })
        return { sessionID, state }
      } catch {
        return value?.sessionID === sessionID ? value : null
      }
    },
  )
  const stop = rpc.events.on("updated", (event) => {
    const location = context.location ?? context.data.location.default()
    if (event.data.sessionID === props.sessionID && event.location.directory === location.directory
      && event.location.workspaceID === location.workspaceID) void refetch()
  })
  onCleanup(stop)
  const timer = setInterval(() => void refetch(), 5_000)
  onCleanup(() => clearInterval(timer))

  return element("box", {
    flexDirection: "column",
    flexShrink: 0,
    get children() {
      const result = review()
      const state = result?.sessionID === props.sessionID ? result.state : null
      if (!state) return []
      const theme = context.theme
      const rows = [element("text", { fg: theme.text.base, children: "PRR progress" })]
      const markers = { pending: "○", in_progress: "◉", completed: "✓", blocked: "!" }
      for (const step of state.steps) {
        rows.push(element("text", {
          fg: step.status === "in_progress" ? theme.text.action.primary.base : theme.text.muted,
          children: `${markers[step.status] ?? "○"} ${step.label}`,
        }))
      }
      if (investigationReady(state) && context.ui?.panel) {
        rows.push(element("text", {
          marginTop: 1, fg: theme.text.action.primary.base, children: "Open diff investigation",
          attributes: TextAttributes.UNDERLINE,
          onMouseDown: () => context.ui.panel.open(investigationPanel, { presentation: "fullscreen" }),
        }))
      }
      if (state.summary.length) {
        rows.push(element("text", { marginTop: 1, fg: theme.text.base, children: "Context manifest" }))
        for (const field of state.summary) {
          const url = httpLink(field.url)
          rows.push(element("text", {
            fg: theme.text.base,
            wrapMode: "word",
            children: [
              `${field.label}: `,
              url ? element("a", { href: url, children: field.text }) : field.text,
            ],
          }))
        }
      }
      return rows
    },
  })
}

export default Plugin.define({
  id: "prr.sidebar",
  setup(context) {
    const rpc = context.client.rpc(reviewRpc)
    const stops = [context.ui.slot({
      prepend: "sidebar.content",
      render: (props) => reviewSidebar(context, props, rpc),
    })]
    if (context.ui.panel) {
      stops.push(context.ui.slot({
        append: "session.panel",
        render: (panel) => createComponent(Show, {
          get when() { return panel.name === investigationPanel },
          children: () => reviewPanel(context, panel, rpc),
        }),
      }))
      stops.push(context.ui.slot({
        append: "app",
        render: () => {
          watchDiffRequests(context, rpc)
          context.keymap.layer(() => ({ mode: "global", commands: [{
            id: "prr.diff.open", title: "PRR: Open diff investigation", group: "PRR", palette: true,
            slash: { name: "prr-diff" },
            run: () => context.ui.panel.open(investigationPanel, { presentation: "fullscreen" }),
          }] }))
          return null
        },
      }))
    }
    return () => stops.forEach((stop) => stop())
  },
})
