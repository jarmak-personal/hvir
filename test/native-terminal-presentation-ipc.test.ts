import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebFrameMain } from 'electron'
import {
  IpcAuthorityRouter,
  type IpcMainRegistrationPort,
} from '../src/main/ipc/authority-router'
import { registerNativeTerminalPresentationIpc } from '../src/main/ipc/features/native-terminal-presentation'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { NativeTerminalPresentationTargets } from '../src/main/terminal/native-terminal-presentation-target'
import type { IpcSendPayload } from '../src/shared'

const channel = 'native-terminal:presentation-ack' as const
type Listener = (event: Electron.IpcMainEvent, payload: unknown) => void
const routers: IpcAuthorityRouter[] = []
const targets: NativeTerminalPresentationTargets[] = []
function fixture(dormant = false) {
  const listeners = new Map<string, Listener>()
  const removed: string[] = []
  const transport: IpcMainRegistrationPort = {
    handle: () => {
      throw new Error('Unexpected invoke registration')
    },
    removeHandler: vi.fn(),
    on: (name, handler) => listeners.set(name, handler),
    removeListener: (name, handler) => {
      if (listeners.get(name) === handler) listeners.delete(name)
      removed.push(name)
    },
  }
  const scopes = new RendererResourceScopes()
  const record = vi.fn()
  const router = new IpcAuthorityRouter(
    {
      rendererResources: scopes,
      recordIpcContractDiagnostic: record,
      getProject: () => {
        throw new Error('Presentation acknowledgement has no project authority')
      },
      getProjectState: () => {
        throw new Error('Presentation acknowledgement has no project state')
      },
      getRegisteredWorkspaceRoot: () => {
        throw new Error('Presentation acknowledgement cannot register paths')
      },
    },
    transport,
  )
  routers.push(router)
  const owner = new NativeTerminalPresentationTargets()
  targets.push(owner)
  const acknowledge = vi.spyOn(owner, 'acknowledge')
  registerNativeTerminalPresentationIpc(router, dormant ? undefined : owner)
  const frame = { isDestroyed: () => false, send: vi.fn() } as unknown as WebFrameMain
  const event = {
    senderFrame: frame,
    sender: { id: 7, mainFrame: frame },
  } as Electron.IpcMainEvent
  const send = (payload: IpcSendPayload<typeof channel>, actual = event) =>
    listeners.get(channel)?.(actual, payload)
  return {
    router,
    scopes,
    owner,
    acknowledge,
    frame,
    event,
    listeners,
    removed,
    record,
    send,
  }
}
afterEach(() => {
  for (const router of routers.splice(0)) router.dispose()
  for (const owner of targets.splice(0)) owner.dispose()
  vi.restoreAllMocks()
})
describe('native presentation acknowledgement authority', () => {
  it('uses the live owner and actual main frame through the production router before Targets', () => {
    const f = fixture(),
      owner = f.scopes.activateOwner(7)
    const asserted = vi.spyOn(f.scopes, 'assertCurrent')
    const payload: IpcSendPayload<typeof channel> = {
      kind: 'pixels',
      ticket: 'copied-frame',
      accepted: true,
    }
    f.send(payload)
    expect(asserted).toHaveBeenCalledWith(owner)
    expect(f.acknowledge).toHaveBeenCalledWith(f.frame, payload)
    expect(asserted.mock.invocationCallOrder[0]).toBeLessThan(
      f.acknowledge.mock.invocationCallOrder[0]!,
    )
  })
  it('rejects revoked and subframe senders before forwarding any acknowledgement', async () => {
    const f = fixture()
    f.scopes.activateOwner(7)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const payload: IpcSendPayload<typeof channel> = {
      kind: 'pixels',
      ticket: 'copied-frame',
      accepted: true,
    }
    f.send(payload, { ...f.event, senderFrame: {} as WebFrameMain })
    expect(f.acknowledge).not.toHaveBeenCalled()
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({ channel, outcome: 'non-main-frame' }),
    )
    await f.scopes.revokeOwner(7)
    f.send(payload)
    expect(f.acknowledge).not.toHaveBeenCalled()
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({ channel, outcome: 'renderer-revoked' }),
    )
    expect(warning).toHaveBeenCalledTimes(2)
  })
  it('keeps dormant registration inert without manufacturing renderer authority or native state', () => {
    const f = fixture(true)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    f.send({ kind: 'pixels', ticket: 'copied-frame', accepted: true })
    expect(f.acknowledge).not.toHaveBeenCalled()
    expect(() => f.scopes.currentOwner(7)).toThrow('not active')
    f.scopes.activateOwner(7)
    f.send({ kind: 'pixels', ticket: 'copied-frame', accepted: true })
    expect(f.acknowledge).not.toHaveBeenCalled()
  })
  it('unregisters its production SEND listener on router disposal', () => {
    const f = fixture()
    f.scopes.activateOwner(7)
    expect(f.listeners.has(channel)).toBe(true)
    f.router.dispose()
    expect(f.listeners.has(channel)).toBe(false)
    expect(f.removed).toEqual([channel])
    f.send({ kind: 'pixels', ticket: 'late-frame', accepted: true })
    expect(f.acknowledge).not.toHaveBeenCalled()
  })
})
