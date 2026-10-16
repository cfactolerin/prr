async function selectedAgent(host, sessionID) {
  const { agent } = await host.session.get({ sessionID })
  if (typeof agent !== "string" || !agent.trim()) {
    throw new Error("Could not identify the current agent")
  }
  return agent
}

async function finishReviewExit(host, { sessionID, returnAgent }, { settleOwned, requireReturnAgent }) {
  await host.session.wait({ sessionID })
  // A session can be idle while its child work is still settling.
  await settleOwned()
  let agent = await selectedAgent(host, sessionID)
  if (agent !== "prr-orchestrator") return { agent, restored: false }
  if (typeof returnAgent !== "string" || !returnAgent.trim()) {
    throw new Error("Select a coding agent before completing PRR exit")
  }
  await requireReturnAgent(returnAgent)
  agent = await selectedAgent(host, sessionID)
  if (agent !== "prr-orchestrator") return { agent, restored: false }
  await host.session.switchAgent({ sessionID, agent: returnAgent })
  agent = await selectedAgent(host, sessionID)
  if (agent === "prr-orchestrator") {
    throw new Error("Could not confirm restoration of the previous agent")
  }
  return { agent, restored: agent === returnAgent }
}

export function requestReviewExit(host, lifecycle, { sessionID, lease }, { settleOwned, requireReturnAgent } = {}) {
  if (typeof settleOwned !== "function" || typeof requireReturnAgent !== "function") {
    return Promise.reject(new Error("PRR exit requires verified cleanup and return-agent validation"))
  }
  const review = lifecycle.current(sessionID)
  if (!review || review.lease !== lease) return Promise.resolve()
  if (!lifecycle.startupExitAllowed(sessionID, lease)) {
    return Promise.reject(new Error("PRR startup delivery is unconfirmed; wait for the review menu before exiting"))
  }
  return lifecycle.exit(
    sessionID,
    lease,
    (returnAgent) => finishReviewExit(host, { sessionID, returnAgent }, { settleOwned, requireReturnAgent }),
    () => host.session.interrupt({ sessionID, resume: false }),
  )
}
