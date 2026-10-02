/* global window */
const bridge = window.hvirExtension
let serial = 0
let context = { visible: false, sessions: [] }
let nativePending = false
let nativeAvailable = false
function update() {
  if (!context.visible) return
  if (nativeAvailable) {
    void updateNative()
    return
  }
  void checkNative()
  bridge.send({
    kind: 'request',
    id: `pulse-${++serial}`,
    capability: 'contributions.publish',
    input: {
      item: 'pulse',
      label: `Live ${context.sessions.length}`,
      tooltip: 'Reference observation updated without a popup',
      availability: 'current',
      observedAt: Date.now(),
    },
  })
}
bridge.onMessage((message) => {
  if (message.kind === 'context') {
    context = message.context
    update()
  }
})
bridge.send({ kind: 'hello', contract: '1.0' })
window.setInterval(update, 1000)

function request(capability, input) {
  const id = `native-${++serial}`
  return new Promise((resolve, reject) => {
    const unsubscribe = bridge.onMessage((message) => {
      if (message.kind !== 'result' || message.id !== id) return
      unsubscribe()
      if (message.ok) resolve(message.value)
      else reject(new Error(message.error))
    })
    bridge.send({ kind: 'request', id, capability, input })
  })
}
async function checkNative() {
  if (nativePending) return
  nativePending = true
  try {
    nativeAvailable = (await request('connector.status')).some(
      (entry) =>
        entry.connector === 'installed-tool' && entry.availability === 'supported',
    )
  } catch {
    nativeAvailable = false
  } finally {
    nativePending = false
  }
}
async function updateNative() {
  if (nativePending || !context.visible) return
  nativePending = true
  try {
    const result = await request('connector.execute', {
      connector: 'installed-tool',
      host: 'local',
      args: ['--version'],
    })
    if (result.receipt)
      await request('connector.output', { receipt: result.receipt, release: true })
    if (!context.visible) return
    await request('contributions.publish', {
      item: 'pulse',
      label:
        result.outcome === 'completed' ? `Tool exit ${result.code}` : 'Tool unavailable',
      tooltip:
        'Approved connector observation; exit status alone does not prove domain success',
      availability:
        result.outcome === 'completed'
          ? 'current'
          : result.reason === 'disconnected'
            ? 'disconnected'
            : 'failed',
      ...(result.outcome === 'completed' ? { observedAt: Date.now() } : {}),
    })
    if (result.outcome !== 'completed') nativeAvailable = false
  } catch {
    nativeAvailable = false
    if (context.visible)
      void request('contributions.publish', {
        item: 'pulse',
        label: 'Tool unavailable',
        tooltip: 'Approve or repair the connector in Settings',
        availability: 'failed',
      }).catch(() => {})
  } finally {
    nativePending = false
  }
}
