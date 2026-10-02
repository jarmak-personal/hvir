/* global window */
const bridge = window.hvirExtension
let serial = 0
let context = { visible: false, sessions: [] }
function update() {
  if (!context.visible) return
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
