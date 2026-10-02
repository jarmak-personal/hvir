/* global window, document */
const bridge = window.hvirExtension
const status = document.getElementById('status')
const button = document.getElementById('open-detail')
let serial = 0
if (button) button.disabled = true
const presentation = (value) => {
  const style = document.documentElement.style
  for (const [name, color] of Object.entries(value.colors))
    style.setProperty(`--extension-${name}`, color)
  style.setProperty('--extension-font', value.fontFamily)
  style.setProperty('--extension-font-size', `${value.fontSize}px`)
  style.colorScheme = value.appearance
}
bridge.onMessage((message) => {
  if (message.kind === 'hello') {
    presentation(message.presentation)
    if (button) button.disabled = !message.capabilities.includes('viewer.open-own')
    status.textContent = `Connected · contract ${message.contract}`
  } else if (message.kind === 'presentation') presentation(message.presentation)
  else if (message.kind === 'result')
    status.textContent = message.ok ? 'Detail view opened.' : message.error
  else if (message.kind === 'revoked') {
    status.textContent = 'This view has closed.'
    if (button) button.disabled = true
  }
})
bridge.send({ kind: 'hello', contract: '1.0' })
button?.addEventListener('click', () =>
  bridge.send({
    kind: 'request',
    id: `open-${++serial}`,
    capability: 'viewer.open-own',
    input: { contributionId: 'detail' },
  }),
)
