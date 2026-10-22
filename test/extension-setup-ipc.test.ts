import { expect, it, vi } from 'vitest'
import { registerExtensionsIpc } from '../src/main/ipc/features/extensions'
import {
  IpcAuthorityRouter,
  type IpcMainRegistrationPort,
} from '../src/main/ipc/authority-router'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import type { ExtensionApplicationRuntime } from '../src/main/extensions/extension-application'

it('requires a current workbench renderer for every trusted setup entry and refuses guest frames and retired owners before dispatch', async () => {
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
  const setup = {
    template: vi.fn(),
    import: vi.fn(),
    select: vi.fn(),
    apply: vi.fn(),
    cancel: vi.fn(),
  }
  // Only the immediate feature owner is substituted; routing and renderer generations are real.
  registerExtensionsIpc(router, { setup } as unknown as ExtensionApplicationRuntime)
  const frame = {},
    event = {
      sender: { id: owner.id, mainFrame: frame },
      senderFrame: frame,
    } as unknown as Electron.IpcMainInvokeEvent
  const request = { installationId: 'installation', request: 'request', rows: [] }
  try {
    for (const method of ['template', 'import', 'select', 'apply', 'cancel'] as const) {
      setup[method].mockReturnValue('accepted')
      const invoke = invokes.get(`extensions:setup-${method}`)!
      expect(() =>
        invoke({ ...event, senderFrame: {} } as Electron.IpcMainInvokeEvent, request),
      ).toThrow(/main frame/)
      invoke(event, request)
      expect(setup[method].mock.calls[0]?.[0]).toEqual(owner)
    }
    await scopes.revokeOwner(owner.id)
    for (const method of ['template', 'import', 'select', 'apply', 'cancel'] as const) {
      expect(() => invokes.get(`extensions:setup-${method}`)!(event, request)).toThrow(
        /not active/,
      )
      expect(setup[method]).toHaveBeenCalledOnce()
    }
  } finally {
    router.dispose()
    await scopes.dispose()
  }
})
