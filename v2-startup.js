export async function registerStartupObservation(host, lifecycle) {
  const observe = (event) => {
    if (!lifecycle.current(event.sessionID)) return
    for (const message of event.messages) {
      if (message.role === "user") {
        lifecycle.observeStartupDelivery(event.sessionID, message.id)
      }
    }
  }
  await host.session.hook("context", observe)
  await host.session.hook("compaction", observe)
}
