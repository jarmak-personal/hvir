/* global window, document */
/** Uses only the public bridge and the package's captured guest UI. */
const bridge = window.hvirExtension
const clock = document.getElementById('clock')
const status = document.getElementById('status')
const unbind = window.hvirUI.bindPresentation(bridge)
let contextReceived = false
let disposed = false,
  timer,
  unsubscribe = () => {}
function stop() {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
}
function refresh() {
  if (disposed) return
  const now = new Date()
  clock.dateTime = now.toISOString()
  clock.textContent = now.toLocaleTimeString()
}
function visibility(visible) {
  stop()
  if (!visible || disposed) return
  refresh()
  timer = window.setInterval(refresh, 1000)
}
function dispose() {
  if (disposed) return
  disposed = true
  stop()
  unsubscribe()
  unbind()
  window.removeEventListener('pagehide', dispose)
}
unsubscribe = bridge.onMessage((message) => {
  if (disposed) return
  if (message.kind === 'hello') {
    status.textContent = `Connected · contract ${message.contract}`
    bridge.send({ kind: 'request', id: 'clock-context', capability: 'context.read' })
  } else if (message.kind === 'context') {
    contextReceived = true
    visibility(message.context.visible)
  } else if (
    message.kind === 'result' &&
    message.id === 'clock-context' &&
    message.ok &&
    !contextReceived
  )
    visibility(message.value.visible)
  else if (message.kind === 'revoked') dispose()
})
window.addEventListener('pagehide', dispose)
bridge.send({ kind: 'hello', contract: '1.0' })
