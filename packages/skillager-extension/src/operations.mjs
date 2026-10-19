/* global window, document */
import { guestClient } from './bridge.mjs'
import { replyManagement, managementActionError } from './management-action-reply.mjs'
import { executeManagement } from './management-operation.mjs'
import { bindManagementView } from './management-view.mjs'

const bridge = window.hvirExtension,
  client = guestClient(bridge)
const releasePresentation = window.hvirUI.bindPresentation(bridge)
const view = bindManagementView(document, client)
client.listen((message) => {
  if (message.kind !== 'action') return
  const invocation = message.invocation,
    scoped = client.forAction(invocation)
  void executeManagement(scoped, invocation)
    .then(
      (value) => {
        return replyManagement(scoped, value)
      },
      (error) => {
        if (scoped.alive)
          return scoped.reply(undefined, managementActionError(error.message))
      },
    )
    .finally(() => scoped.dispose())
})
function dispose() {
  view.dispose()
  releasePresentation()
  client.dispose()
}
window.addEventListener('pagehide', dispose, { once: true })
client.signal.addEventListener(
  'abort',
  () => {
    view.dispose()
    releasePresentation()
  },
  { once: true },
)
client.hello()
