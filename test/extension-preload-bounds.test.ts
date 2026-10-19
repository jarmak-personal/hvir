import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionGuestBridge } from '../src/shared/extensions/contract'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'
const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  executeInMainWorld: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
}))
vi.mock('electron', () => ({ contextBridge: electron, ipcRenderer: electron }))
vi.mock('../src/preload/extension-guest-visibility', () => ({
  observeExtensionGuestVisibility: vi.fn(),
}))
afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
  vi.clearAllMocks()
})
async function bridge() {
  await import('../src/preload/extension-guest')
  return electron.exposeInMainWorld.mock.calls[0]![1] as ExtensionGuestBridge
}
it('keeps the preload thirty-message guard independent, including raw output reads and control messages', async () => {
  vi.useFakeTimers()
  const guest = await bridge()
  for (let n = 0; n < 30; n++)
    guest.send({
      kind: 'request',
      id: `output-${n}`,
      capability: 'connector.output',
      input: { receipt: 'owned', stream: 'stdout', offset: 0 },
    })
  expect(() => guest.send({ kind: 'cancel', id: 'output-0' })).toThrow('rate limit')
  expect(electron.send).toHaveBeenCalledTimes(30)
  await vi.advanceTimersByTimeAsync(1000)
  expect(() => guest.send({ kind: 'cancel', id: 'output-0' })).not.toThrow()
})
it.each(['connector.output', 'presentation.read', 'actions.invoke'] as const)(
  'never enlarges a %s request based on its capability or forged result fields',
  async (capability) => {
    const guest = await bridge()
    expect(() =>
      guest.send({
        kind: 'request',
        id: 'forged',
        capability,
        input: {
          data: 'x'.repeat(EXTENSION_LIMITS.messageBytes),
          kind: 'connector.output',
          result: { receipt: 'owned' },
        },
      }),
    ).toThrow('byte limit')
    expect(electron.send).not.toHaveBeenCalled()
  },
)
