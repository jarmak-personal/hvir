import { expect, it, vi } from 'vitest'
import { registerExtensionsIpc } from '../src/main/ipc/features/extensions'
import {
  IpcAuthorityRouter,
  type IpcMainRegistrationPort,
} from '../src/main/ipc/authority-router'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import type { ExtensionApplicationRuntime } from '../src/main/extensions/extension-application'

it('retires prepared source tokens only from a current trusted main frame', async () => {
  const scopes = new RendererResourceScopes(),
    owner = scopes.activateOwner(7)
  const invokes = new Map<string, Parameters<IpcMainRegistrationPort['handle']>[1]>()
  const router = new IpcAuthorityRouter(
    {
      rendererResources: scopes,
      getProject: () => {
        throw new Error('Unused project port')
      },
      getProjectState: () => {
        throw new Error('Unused project port')
      },
      getRegisteredWorkspaceRoot: () => undefined,
      recordIpcContractDiagnostic: () => {},
    },
    {
      handle: (channel, handler) => {
        invokes.set(channel, handler)
      },
      removeHandler: (channel) => {
        invokes.delete(channel)
      },
      on: () => {},
      removeListener: () => {},
    },
  )
  const cancelPrepared = vi.fn()
  registerExtensionsIpc(router, {
    sources: { approvals: { cancelPrepared } },
  } as unknown as ExtensionApplicationRuntime)
  const frame = {},
    event = {
      sender: { id: owner.id, mainFrame: frame },
      senderFrame: frame,
    } as unknown as Electron.IpcMainInvokeEvent
  try {
    const invoke = invokes.get('extensions:source-cancel-prepared')!
    expect(invoke).toBeDefined()
    expect(() =>
      invoke({ ...event, senderFrame: {} } as Electron.IpcMainInvokeEvent, {
        token: 'prepared',
      }),
    ).toThrow(/main frame/)
    expect(() => invoke(event, { token: 'x'.repeat(81) })).toThrow()
    expect(cancelPrepared).not.toHaveBeenCalled()
    invoke(event, { token: 'prepared' })
    expect(cancelPrepared).toHaveBeenCalledExactlyOnceWith('prepared')
    await scopes.revokeOwner(owner.id)
    expect(() => invoke(event, { token: 'prepared' })).toThrow(/not active/)
    expect(cancelPrepared).toHaveBeenCalledOnce()
  } finally {
    router.dispose()
    await scopes.dispose()
  }
})
