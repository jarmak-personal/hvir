import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
const bundle = buildSync({
  stdin: {
    contents: `export { replyManagement } from './packages/skillager-extension/src/management-action-reply.mjs'; export { guestClient } from './src/shared/extensions/guest-client.mjs';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'iife',
  globalName: 'Module',
  write: false,
})
const sandbox = {
  Module: undefined as unknown,
  AbortController,
  performance,
  setTimeout,
  clearTimeout,
}
runInNewContext(bundle.outputFiles[0]!.text, sandbox)
type Value = Record<string, unknown>
const { replyManagement, guestClient } = sandbox.Module as {
  replyManagement(this: void, client: unknown, value: unknown): unknown
  guestClient(
    this: void,
    bridge: {
      send(message: Value): void
      onMessage(listener: (message: Value) => void): () => void
    },
  ): { forAction(invocation: { id: string }): unknown; dispose(): void }
}
it.each(['refused', 'partial', 'uncertain', 'verified'])(
  'uses the existing error channel only for definite %s',
  (outcome) => {
    const reply = vi.fn(),
      value = {
        outcome,
        message: 'Connect project-cli for this project.',
      }
    replyManagement({ alive: true, reply }, value)
    expect(reply.mock.calls).toEqual(
      outcome === 'refused' ? [[undefined, value.message]] : [[value]],
    )
  },
)

it.each([
  {
    action: 'change-exposure',
    results: [
      {
        target: { hostId: 'local', path: '/owned/target' },
        reason: 'modified',
        recoveryPath: null,
      },
    ],
  },
  {
    action: 'add-copy',
    reason: 'foreign-target',
    target: { hostId: 'local', path: '/owned/foreign' },
    mode: 'native',
    exposureId: 'owned-exposure',
  },
  {
    action: 'remove-copy',
    operation: 'owned-delivery',
    metadata: 'Tracking remains pending; observe again before another delivery',
  },
])(
  'preserves structured $action refusal facts through the actual guest reply',
  async (facts) => {
    const sent: Value[] = []
    let receive: ((message: Value) => void) | undefined
    const client = guestClient({
      send: (message) => sent.push(message),
      onMessage: (listener) => {
        receive = listener
        return () => {}
      },
    })
    const invocation = { id: 'owned-action' }
    receive!({ kind: 'action', invocation })
    const value = { outcome: 'refused', message: 'Inspect the reported facts.', ...facts }
    await replyManagement(client.forAction(invocation), value)
    expect(sent).toEqual([{ kind: 'action-result', id: invocation.id, value }])
    client.dispose()
  },
)

it('sends a complete message-only refusal through the actual guest error channel', async () => {
  const sent: Value[] = []
  let receive: ((message: Value) => void) | undefined
  const client = guestClient({
    send: (message) => sent.push(message),
    onMessage: (listener) => {
      receive = listener
      return () => {}
    },
  })
  const invocation = { id: 'owned-action' }
  receive!({ kind: 'action', invocation })
  await replyManagement(client.forAction(invocation), {
    outcome: 'refused',
    action: 'sync-library',
    message: 'Connect project-cli for this project.',
  })
  expect(sent).toEqual([
    {
      kind: 'action-result',
      id: invocation.id,
      error: 'Connect project-cli for this project.',
    },
  ])
  client.dispose()
})
it.each(['🙂'.repeat(500), '路'.repeat(500), 'Connect project-cli. ' + 'x'.repeat(1000)])(
  'bounds long/multibyte refusal without invalid surrogates',
  (message) => {
    const reply = vi.fn()
    replyManagement({ alive: true, reply }, { outcome: 'refused', message })
    const error = reply.mock.calls[0]![1] as string
    expect(error.length).toBeLessThanOrEqual(240)
    expect(Buffer.from(error).toString('utf8')).toBe(error)
  },
)
it('revocation never sends a late action reply', () => {
  const reply = vi.fn()
  replyManagement({ alive: false, reply }, { outcome: 'refused', message: 'late' })
  expect(reply).not.toHaveBeenCalled()
})
