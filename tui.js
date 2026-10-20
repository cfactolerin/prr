import { Plugin } from "@opencode/plugin/tui"
import { createElement, spread } from "@opentui/solid"
import { createResource, onCleanup } from "solid-js"
import { reviewRpc } from "./review-rpc.js"
import { httpLink } from "./review-state.js"

function element(tag, props) {
  const node = createElement(tag)
  spread(node, props)
  return node
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
    return context.ui.slot({
      prepend: "sidebar.content",
      render: (props) => reviewSidebar(context, props, rpc),
    })
  },
})
