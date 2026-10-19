import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
const bundle = buildSync({
  entryPoints: ['packages/skillager-extension/src/management-action-reply.mjs'],
  bundle: true,
  format: 'iife',
  globalName: 'Module',
  write: false,
})
const sandbox = { Module: undefined as unknown }
runInNewContext(bundle.outputFiles[0]!.text, sandbox)
const { replyManagement } = sandbox.Module as {
  replyManagement(this: void, client: unknown, value: unknown): unknown
}
it.each(['refused', 'partial', 'uncertain', 'verified'])(
  'uses the existing error channel only for definite %s',
  (outcome) => {
    const reply = vi.fn(),
      value = {
        outcome,
        message: 'Connect project-cli for this project.',
        operationId: 'op',
        recovery: '/owned/recovery',
      }
    replyManagement({ alive: true, reply }, value)
    expect(reply.mock.calls).toEqual(
      outcome === 'refused' ? [[undefined, value.message]] : [[value]],
    )
  },
)
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
