/* global window, document, AbortController, performance, requestAnimationFrame, TextEncoder */
import { guestClient } from '../../../../src/shared/extensions/guest-client.mjs'
import { readConnectorOutput } from '../../../../src/shared/extensions/connector-output.mjs'
const wire = window.hvirExtension
const facts = (window.outputTransfer = {
  visible: false,
  state: 'connecting',
  reads: 0,
  released: 0,
  receipts: 0,
  bytes: 0,
  peakRate: 0,
  frames: 0,
  inputs: 0,
  paintedInputs: 0,
  cancelled: 0,
  actionPending: false,
  lastDuration: 0,
  maxReceiptMs: 0,
})
const sent = []
const client = guestClient({
  onMessage: (callback) => wire.onMessage(callback),
  send(message) {
    const now = performance.now()
    while (sent.length && sent[0] <= now - 1000) sent.shift()
    sent.push(now)
    facts.peakRate = Math.max(facts.peakRate, sent.length)
    wire.send(message)
  },
})
const unbind = window.hvirUI.bindPresentation(wire)
let invocation,
  running = false,
  generation = 0
const state = (value) => {
  facts.state = value
  document.getElementById('state').textContent = value
}
async function drain(caller, mode, count) {
  const started = performance.now(),
    current = ++generation
  running = true
  facts.reads = 0
  facts.released = 0
  facts.receipts = 0
  facts.bytes = 0
  facts.maxReceiptMs = 0
  facts.frames = 0
  state('running')
  const paint = () => {
    if (running && current === generation) {
      facts.frames++
      requestAnimationFrame(paint)
    }
  }
  requestAnimationFrame(paint)
  const measured = {
    request: async (capability, input, signal) => {
      const value = await caller.request(capability, input, signal)
      if (capability === 'connector.output' && !input.release) facts.reads++
      return value
    },
  }
  try {
    const ordinary = (async () => {
      for (let n = 0; n < (count === 4 ? 40 : 0) && current === generation; n++)
        await caller.request('presentation.read')
    })()
    await Promise.all([
      ordinary,
      ...Array.from({ length: count }, async (_, index) => {
        const result = await caller.request('connector.execute', {
          connector: 'tool',
          host: 'local',
          args: [mode, String(index)],
        })
        if (
          result.outcome !== 'completed' ||
          result.code !== 0 ||
          result.truncated ||
          !result.receipt
        )
          throw new Error('native-result')
        const received = performance.now()
        facts.receipts++
        try {
          for (const stream of ['stdout', 'stderr']) {
            const text = await readConnectorOutput(measured, result, { stream })
            const expected =
              mode === 'small'
                ? stream === 'stdout'
                  ? 'a'.repeat(650 * 1024)
                  : ''
                : stream === 'stdout'
                  ? '\u0001'.repeat(2 * 1024 * 1024 - 1)
                  : '\u0002'.repeat(2 * 1024 * 1024 + 1)
            if (text !== expected) throw new Error('byte-mismatch')
            facts.bytes += new TextEncoder().encode(text).byteLength
          }
        } finally {
          await caller.request('connector.output', {
            receipt: result.receipt,
            release: true,
          })
          facts.released++
          facts.maxReceiptMs = Math.max(facts.maxReceiptMs, performance.now() - received)
        }
      }),
    ])
    if (current === generation) {
      facts.lastDuration = performance.now() - started
      state('complete')
    }
  } finally {
    if (current === generation) running = false
  }
}
client.listen((message) => {
  if (message.kind === 'context') facts.visible = message.context.visible
  if (message.kind === 'hello') state('ready')
  if (message.kind === 'action-cancelled') {
    facts.cancelled++
    generation++
    running = false
    state('cancelled')
  }
  if (message.kind === 'action') {
    const action = client.forAction(message.invocation)
    void drain(action, 'large', 4)
      .then(
        () => action.reply({ complete: true }),
        () => (action.alive ? action.reply(undefined, 'Output transfer ended') : false),
      )
      .finally(() => action.dispose())
  }
})
for (const [id, mode, count] of [
  ['small', 'small', 1],
  ['large', 'large', 4],
])
  document.getElementById(id).addEventListener('click', () => {
    void drain(client, mode, count).catch(() => state('failed'))
  })
document.getElementById('action').addEventListener('click', () => {
  invocation = new AbortController()
  facts.actionPending = true
  void client
    .request('actions.invoke', { action: 'drain' }, invocation.signal)
    .catch(() => {})
    .finally(() => {
      facts.actionPending = false
    })
})
document.getElementById('withdraw').addEventListener('click', () => invocation?.abort())
document.getElementById('probe').addEventListener('click', () => {
  facts.inputs++
  document.getElementById('paint').textContent = 'Input received'
  requestAnimationFrame(() => {
    facts.paintedInputs = facts.inputs
  })
})
window.addEventListener(
  'pagehide',
  () => {
    generation++
    running = false
    client.dispose()
    unbind()
  },
  { once: true },
)
client.hello()
