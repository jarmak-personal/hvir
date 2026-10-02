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
    status.textContent = !message.ok
      ? message.error
      : message.id.startsWith('open-')
        ? 'Detail view opened.'
        : message.id.startsWith('mark-')
          ? 'Session marked.'
          : 'Request completed.'
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

let context
const observation = document.getElementById('observation')
bridge.onMessage((message) => {
  if (message.kind === 'context') {
    context = message.context
    const title = document.getElementById('session-title')
    if (title) title.textContent = context.session?.title ?? 'No session context'
  }
  if (message.kind === 'contributions' && observation)
    observation.textContent = message.values
      .map((value) => `${value.label ?? ''} ${value.availability ?? ''}`)
      .join(' · ')
  if (message.kind === 'action') {
    const invocation = message.invocation
    status.textContent = `Action for ${invocation.context.session?.title ?? 'application'} · ${invocation.caller}`
    window.setTimeout(
      () => {
        bridge.send({
          kind: 'action-result',
          id: invocation.id,
          value: {
            session: invocation.context.session?.id ?? null,
            caller: invocation.caller,
          },
        })
        status.textContent = `Action completed · ${invocation.id}`
      },
      Math.max(500, Math.min(5000, Number(invocation.input?.delayMs) || 500)),
    )
  }
})
document.getElementById('mark-session')?.addEventListener('click', () => {
  if (!context?.session) return
  bridge.send({
    kind: 'request',
    id: `mark-${++serial}`,
    capability: 'contributions.publish',
    input: {
      item: 'session',
      session: context.session.id,
      icon: '◆',
      label: 'Marked',
      tooltip: 'This exact session was marked',
    },
  })
})

// Native results have explicit process status; output pages remain caller-bound.
const nativeRun = document.getElementById('native-run')
const nativeNext = document.getElementById('native-next')
const nativeStatus = document.getElementById('native-status')
const nativeOutput = document.getElementById('native-output')
let nativeReceipt,
  nativeOffset = 0
function nativeRequest(capability, input) {
  const id = `native-${++serial}`
  return new Promise((resolve, reject) => {
    const dispose = bridge.onMessage((message) => {
      if (message.kind !== 'result' || message.id !== id) return
      dispose()
      if (message.ok) resolve(message.value)
      else reject(new Error(message.error))
    })
    bridge.send({ kind: 'request', id, capability, input })
  })
}
async function releaseNativeReceipt() {
  const receipt = nativeReceipt
  nativeReceipt = undefined
  if (receipt)
    await nativeRequest('connector.output', { receipt, release: true }).catch(() => {})
}
async function nativePage() {
  const page = await nativeRequest('connector.output', {
    receipt: nativeReceipt,
    stream: 'stdout',
    offset: nativeOffset,
  })
  nativeOutput.textContent = page.data
  nativeOffset = page.nextOffset
  nativeNext.disabled = nativeOffset === null
  if (nativeOffset === null) {
    await releaseNativeReceipt()
  }
}
bridge.onMessage((message) => {
  if (message.kind === 'hello' && nativeRun)
    nativeRun.disabled = !['connector.execute', 'connector.output'].every((capability) =>
      message.capabilities.includes(capability),
    )
})
nativeRun?.addEventListener('click', async () => {
  nativeRun.disabled = true
  try {
    await releaseNativeReceipt()
    const result = await nativeRequest('connector.execute', {
      connector: 'installed-tool',
      host: 'local',
      args: JSON.parse(document.getElementById('native-args').value),
    })
    nativeStatus.textContent = `${result.outcome} · ${result.host || 'no approved host'} · exit ${result.code ?? 'unknown'}${result.truncated ? ' · truncated' : ''}${result.reason ? ` · ${result.reason}` : ''}`
    nativeOutput.textContent = ''
    nativeReceipt = result.receipt
    nativeOffset = 0
    nativeNext.disabled = true
    if (nativeReceipt) await nativePage()
  } catch (error) {
    nativeStatus.textContent = error.message
  } finally {
    nativeRun.disabled = false
  }
})
nativeNext?.addEventListener('click', () => {
  void nativePage().catch((error) => {
    nativeStatus.textContent = error.message
    nativeNext.disabled = true
  })
})
