export const reviewSteps = [
  "Cleanup stale reviews",
  "Gather context",
  "Review context with user",
  "Run independent reviews",
  "Run arbiter synthesis",
  "Review briefing",
  "Interactive investigation",
]

export function investigationReady(state) {
  return state?.steps.find((step) => step.label === "Review briefing")?.status === "completed"
    && ["in_progress", "completed"].includes(state?.steps.find((step) => step.label === "Interactive investigation")?.status)
}

export function httpLink(value) {
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

export function manifestSummary(manifest) {
  const header = manifest.split(/\n## /, 1)[0]
  return ["PRR", "PR", "Title", "Author", "Branch", "Ticket", "Round"].flatMap((label) => {
    const value = header.match(new RegExp(`^- \\*\\*${label}\\*\\*: (.*)$`, "m"))?.[1]
    if (value === undefined) return []
    const linkField = label === "PR" || label === "Ticket"
    const link = linkField ? value.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/) : undefined
    const text = (label === "Branch" ? value.replaceAll("`", "") : link?.[1] ?? value)
      .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    const url = linkField ? httpLink(link?.[2] ?? value) : undefined
    return [{ label, text, ...(url ? { url } : {}) }]
  })
}

export function createReviewState(storage, emit) {
  const pending = new Map()
  const key = (sessionID) => `review/${sessionID}`
  const initial = () => ({ steps: reviewSteps.map((label) => ({ label, status: "pending" })), summary: [] })
  const get = async (sessionID) => {
    const state = await storage.get(key(sessionID))
    if (!state) return null
    return {
      ...state,
      steps: reviewSteps.map((label) => state.steps.find((step) => step.label === label) ?? { label, status: "pending" }),
    }
  }
  const save = async (sessionID, state, diffRequest) => {
    await storage.set(key(sessionID), state)
    await emit({ sessionID, ...(diffRequest ? { diffRequest } : {}) })
  }
  const change = (sessionID, update) => {
    const next = (pending.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(update)
    pending.set(sessionID, next)
    void next.finally(() => {
      if (pending.get(sessionID) === next) pending.delete(sessionID)
    }).catch(() => {})
    return next
  }
  return {
    get,
    reset(sessionID) {
      return change(sessionID, () => save(sessionID, initial()))
    },
    async update(sessionID, step, status, view) {
      if (!Number.isInteger(step) || step < 1 || step > reviewSteps.length
        || !["pending", "in_progress", "completed", "blocked"].includes(status)) {
        throw new Error("Invalid PRR progress update")
      }
      if (view !== undefined && (step !== 7 || status !== "in_progress" || !["diff", "chat"].includes(view))) {
        throw new Error("Investigation view can only be chosen when starting step 7")
      }
      await change(sessionID, async () => {
        const state = await get(sessionID) ?? initial()
        if (view !== undefined && state.steps[5].status !== "completed") {
          throw new Error("Continue from the review briefing before choosing an investigation view")
        }
        state.steps[step - 1].status = status
        if (view === "diff") state.diffRequest = crypto.randomUUID()
        if (view === "chat" || !investigationReady(state) || state.steps[6].status !== "in_progress") delete state.diffRequest
        await save(sessionID, state, view === "diff" ? state.diffRequest : undefined)
      })
    },
    async context(sessionID, round, manifest) {
      await change(sessionID, async () => {
        const state = await get(sessionID) ?? initial()
        if (state.round && state.round !== round) {
          const cleanup = state.steps[0]
          state.steps = initial().steps
          state.steps[0] = cleanup
          state.steps[1].status = "in_progress"
          delete state.diffRequest
        }
        state.round = round
        state.summary = manifestSummary(manifest)
        await save(sessionID, state)
      })
    },
  }
}
