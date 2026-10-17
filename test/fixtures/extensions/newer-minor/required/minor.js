/* global window */
const bridge = window.hvirExtension
bridge.send({ kind: 'hello', contract: '1.1' })
bridge.send({ kind: 'request', id: 'known', capability: 'context.read', input: null })
bridge.send({
  kind: 'request',
  id: 'future',
  capability: 'future.optional-observation',
  input: null,
})
