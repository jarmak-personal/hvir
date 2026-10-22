import { describe, expect, it, vi } from 'vitest'
import { registerExtensionsIpc } from '../src/main/ipc/features/extensions'
import type { ExtensionApplicationRuntime } from '../src/main/extensions/extension-application'
import type {
  IpcInvokeContext,
  IpcInvokeHandler,
  IpcRegistrar,
} from '../src/main/ipc/authority-router'

function fixture() {
  const owner = { id: 7, generation: 3 }
  const foreground = vi.fn(() => true)
  const guestForeground = vi.fn(() => false)
  const runtime = {
    surface: { foreground },
    guests: undefined,
  } as unknown as ExtensionApplicationRuntime
  let query!: IpcInvokeHandler<'extensions:foreground'>
  const handle: IpcRegistrar['handle'] = (channel, handler) => {
    if (channel === 'extensions:foreground')
      query = handler as unknown as IpcInvokeHandler<'extensions:foreground'>
  }
  registerExtensionsIpc(
    { handle, handleSend: vi.fn() } as unknown as IpcRegistrar,
    runtime,
  )
  const context = { owner: vi.fn(() => owner) } as unknown as IpcInvokeContext
  return { owner, runtime, foreground, guestForeground, context, query }
}

describe('extension native foreground IPC during cold startup', () => {
  it('reads the already installed native surface before guest initialization and stays truthful without another focus event', async () => {
    const data = fixture()
    let initialize!: () => void
    const initialized = new Promise<void>((resolve) => {
      initialize = resolve
    }).then(() => {
      data.runtime.guests = {
        ownerForeground: data.guestForeground,
      } as unknown as NonNullable<ExtensionApplicationRuntime['guests']>
    })
    expect(data.runtime.guests).toBeUndefined()
    expect(await data.query(undefined, data.context)).toBe(true)
    expect(data.foreground).toHaveBeenLastCalledWith(data.owner)
    initialize()
    await initialized
    expect(await data.query(undefined, data.context)).toBe(true)
    expect(data.guestForeground).not.toHaveBeenCalled()
    data.foreground.mockReturnValue(false)
    expect(await data.query(undefined, data.context)).toBe(false)
  })

  it('rejects a revoked renderer before observing native foreground, including while guests are absent', () => {
    const data = fixture()
    vi.spyOn(data.context, 'owner').mockImplementation(() => {
      throw new Error('Renderer generation ended')
    })
    expect(() => data.query(undefined, data.context)).toThrow('Renderer generation ended')
    expect(data.foreground).not.toHaveBeenCalled()
  })
})
