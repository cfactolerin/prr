import { randomUUID } from "node:crypto"

function requireReturnAgent(returnAgent) {
  if (typeof returnAgent !== "string" || !returnAgent.trim()) {
    throw new Error("Select a return agent before starting PRR")
  }
}

export function createReviewLifecycle() {
  const reviews = new Map()

  const createReview = (sessionID, returnAgent) => {
    if (reviews.has(sessionID)) throw new Error("A PRR review is already active in this session")
    const lease = randomUUID()
    reviews.set(sessionID, {
      lease, returnAgent, stopping: false, dispatchReady: false,
      controller: new AbortController(), operations: new Set(),
    })
    return lease
  }

  const activeReview = (sessionID, lease) => {
    const review = reviews.get(sessionID)
    if (!review || review.lease !== lease || review.stopping) {
      throw new Error("PRR review is not active")
    }
    return review
  }

  const lifecycle = {
    begin(sessionID, returnAgent) {
      requireReturnAgent(returnAgent)
      return createReview(sessionID, returnAgent)
    },
    reserve(sessionID) {
      return createReview(sessionID)
    },
    capture(sessionID, lease, returnAgent) {
      const review = activeReview(sessionID, lease)
      if (review.returnAgent !== undefined) throw new Error("PRR return agent is already captured")
      requireReturnAgent(returnAgent)
      review.returnAgent = returnAgent
    },
    startupInputID(sessionID, lease) {
      const review = activeReview(sessionID, lease)
      return review.startupInputID ??= `msg_${randomUUID()}`
    },
    observeStartupDelivery(sessionID, inputID) {
      const review = reviews.get(sessionID)
      if (review?.startupInputID && review.startupInputID === inputID) {
        review.startupDelivered = true
      }
    },
    startupDelivered(sessionID, lease) {
      const review = reviews.get(sessionID)
      return review?.lease === lease && review?.startupDelivered === true
    },
    startupExitAllowed(sessionID, lease) {
      const review = reviews.get(sessionID)
      if (!review || review.lease !== lease) return false
      return review.startupDelivered === true || (review.stopping && !review.startupInputID)
    },
    activate(sessionID, lease) {
      const review = activeReview(sessionID, lease)
      requireReturnAgent(review.returnAgent)
      review.dispatchReady = true
    },
    leaseSnapshot() {
      const leases = new Map()
      for (const [sessionID, review] of reviews) {
        if (review.dispatchReady && !review.stopping) leases.set(sessionID, review.lease)
      }
      return (sessionID) => leases.get(sessionID)
    },
    current(sessionID) {
      const review = reviews.get(sessionID)
      if (!review) return undefined
      const { lease, returnAgent, stopping } = review
      return Object.freeze({ lease, returnAgent, stopping })
    },
    async run(sessionID, lease, operation) {
      const review = activeReview(sessionID, lease)
      const work = Promise.resolve().then(() => {
        review.controller.signal.throwIfAborted()
        return operation(review.controller.signal)
      })
      review.operations.add(work)
      return work.finally(() => review.operations.delete(work))
    },
    revoke(sessionID, lease) {
      const review = reviews.get(sessionID)
      if (!review || review.lease !== lease) return
      review.stopping = true
      review.controller.abort()
    },
    exit(sessionID, lease, finish, requestStop) {
      const review = reviews.get(sessionID)
      if (!review || review.lease !== lease) return Promise.resolve()
      if (review.exit) return review.exit
      review.exit = Promise.resolve()
        .then(async () => {
          if (requestStop) await requestStop()
          if (review.operations.size) await Promise.allSettled([...review.operations])
          return finish(review.returnAgent)
        })
        .then((outcome) => {
          review.stopping = false
          lifecycle.release(sessionID, lease)
          return outcome
        })
        .catch((error) => {
          review.exit = undefined
          throw error
        })
      lifecycle.revoke(sessionID, lease)
      return review.exit
    },
    release(sessionID, lease) {
      const review = reviews.get(sessionID)
      if (!review || review.lease !== lease || review.stopping || review.operations.size) return undefined
      reviews.delete(sessionID)
      return review.returnAgent
    },
  }
  return lifecycle
}
