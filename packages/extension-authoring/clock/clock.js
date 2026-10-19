/* global window, document */
import { guestClient } from './guest-client.mjs'
/** Uses only the public bridge and the package's captured guest UI. */
const bridge = window.hvirExtension
const client = guestClient(bridge)
const clock = document.getElementById('clock')
const status = document.getElementById('status')
const unbind = window.hvirUI.bindPresentation(bridge)
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
  client.dispose()
  unbind()
  window.removeEventListener('pagehide', dispose)
}
unsubscribe = client.listen((message) => {
  if (disposed) return
  if (message.kind === 'hello') {
    status.textContent = `Connected · contract ${message.contract}`
  } else if (message.kind === 'context') {
    visibility(message.context.visible)
  } else if (message.kind === 'revoked') dispose()
})
window.addEventListener('pagehide', dispose)
client.hello()
