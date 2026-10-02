import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'
import type { ExtensionView } from '../src/shared/extensions/workbench'
import { validateCapturedExtension } from '../src/main/extensions/package-store'
import { exampleManifest } from './fixtures/extension-package'

const electron = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  guests: new Map<number, unknown>(),
}))
vi.mock('electron', () => ({
  app: { getAppPath: () => '/owned-app' },
  session: { fromPartition: (partition: string) => electron.sessions.get(partition) },
  webContents: {
    fromDevToolsTargetId: () => electron.guests.get(1),
    fromId: (id: number) => electron.guests.get(id),
  },
}))
import { ElectronExtensionGuestSurface } from '../src/main/extensions/electron-guest-surface'
import type { ExtensionGuestOwner } from '../src/main/extensions/guest-owner'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
const owner = { id: 1, generation: 1 }
const revision = validateCapturedExtension({
  sourceIdentity: '1:1',
  files: new Map([
    ['hvir-extension.json', Buffer.from(JSON.stringify(exampleManifest()))],
    ['index.html', Buffer.from('captured')],
    ['detail.html', Buffer.from('detail')],
  ]),
})

function sessionFor(view: ExtensionView) {
  const session = Object.assign(new EventEmitter(), {
    protocol: {
      handle:
        vi.fn<
          (scheme: string, handler: (request: Request) => Promise<Response>) => void
        >(),
      unhandle: vi.fn(),
    },
    webRequest: { onBeforeRequest: vi.fn() },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    closeAllConnections: vi.fn(() => Promise.resolve()),
    clearStorageData: vi.fn(() => Promise.resolve()),
    clearCache: vi.fn(() => Promise.resolve()),
  })
  electron.sessions.set(view.partition, session)
  return session
}
function viewFor(index = 0): ExtensionView {
  return {
    id: `view-${index}`,
    installationId: 'installation',
    contributionId: 'reference',
    extensionName: 'Reference',
    title: 'Reference',
    partition: `partition-${index}`,
    url: `hvir-extension://view-${index}/index.html`,
  }
}
async function fixture(send?: (method: string) => Promise<unknown>) {
  const surface = new ElectronExtensionGuestSurface()
  const view = viewFor(),
    session = sessionFor(view)
  const debuggerPort = Object.assign(new EventEmitter(), {
    attach: vi.fn(),
    isAttached: vi.fn(() => true),
    detach: vi.fn(),
    sendCommand: vi.fn((method: string) =>
      send
        ? send(method)
        : Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } }),
    ),
  })
  let destroyed = false
  let dispatching = false
  const guestEvents = new EventEmitter()
  const guest = Object.assign(guestEvents, {
    id: 1,
    session,
    debugger: debuggerPort,
    isDestroyed: () => destroyed,
    getURL: () => view.url,
    isLoading: () => false,
    close: vi.fn(() => {
      if (dispatching)
        throw new Error('Native guest deletion reentered debugger dispatch')
      destroyed = true
      guestEvents.emit('destroyed')
    }),
    send: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    closeDevTools: vi.fn(),
  })
  electron.guests.set(1, guest)
  const failed = vi.fn(() => {
    void surface.destroy(view.id)
  })
  surface.connect({
    claim: () => view,
    bind: () => view,
    failed,
  } as unknown as ExtensionGuestOwner)
  await surface.prepare(view, revision)
  surface.claim(owner, {}, { src: view.url, partition: view.partition, name: view.id })
  surface.attached(owner, guest as unknown as Electron.WebContents, () => undefined)
  const response = async () => {
    const handler = session.protocol.handle.mock.calls[0]![1]
    return handler(new Request(view.url))
  }
  return {
    surface,
    view,
    session,
    guest,
    debuggerPort,
    response,
    failed,
    replace: () => {
      dispatching = true
      try {
        debuggerPort.emit('message', {}, 'Page.documentOpened', { frame: { id: 'main' } })
      } finally {
        dispatching = false
      }
    },
  }
}
afterEach(() => {
  electron.sessions.clear()
  electron.guests.clear()
})

describe('Electron extension response, native teardown and closing capacity', () => {
  it('revokes captured responses on the debugger callback stack and closes outside it with a true session receipt', async () => {
    const data = await fixture()
    await turn()
    expect(await (await data.response()).text()).toBe('captured')
    const cache = deferred<void>()
    data.session.clearCache.mockImplementation(() => cache.promise)
    data.replace()
    const receipt = data.surface.destroy(data.view.id)
    expect(data.surface.destroy(data.view.id)).toBe(receipt)
    expect(data.failed).toHaveBeenCalledTimes(1)
    expect(data.guest.close).not.toHaveBeenCalled()
    expect((await data.response()).status).toBe(404)
    await turn()
    expect(data.guest.close).toHaveBeenCalledTimes(1)
    expect(data.debuggerPort.detach).toHaveBeenCalledTimes(1)
    let complete = false
    void receipt.then(() => {
      complete = true
    })
    await Promise.resolve()
    expect(complete).toBe(false)
    cache.resolve()
    await receipt
    expect(complete).toBe(true)
    expect(data.session.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null)
  })
  it.each([
    'Target.getTargetInfo',
    'Page.enable',
    'lifecycle-target',
    'Page.setWebLifecycleState',
  ])(
    'revoke during pending %s sends no successor command or captured response',
    async (held) => {
      const pending = deferred<unknown>()
      const started = deferred<void>()
      let targets = 0
      const data = await fixture((method) => {
        if (method === 'Target.getTargetInfo') targets++
        if (
          method === held ||
          (held === 'lifecycle-target' &&
            method === 'Target.getTargetInfo' &&
            targets === 2)
        ) {
          started.resolve()
          return pending.promise
        }
        return Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } })
      })
      await started.promise
      const receipt = data.surface.destroy(data.view.id)
      const commands = data.debuggerPort.sendCommand.mock.calls.map((args) => args[0])
      expect((await data.response()).status).toBe(404)
      await receipt
      pending.resolve({ targetInfo: { targetId: 'target', type: 'webview' } })
      await turn()
      expect(data.debuggerPort.sendCommand.mock.calls.map((args) => args[0])).toEqual(
        commands,
      )
      expect((await data.response()).status).toBe(404)
      expect(data.guest.close).toHaveBeenCalledTimes(1)
    },
  )
  it('keeps a closing slot until session cleanup finishes and recovers capacity only afterward', async () => {
    const data = await fixture()
    await turn()
    for (let index = 1; index < EXTENSION_LIMITS.views; index++) {
      const view = viewFor(index)
      sessionFor(view)
      await data.surface.prepare(view, revision)
    }
    const cache = deferred<void>()
    data.session.clearCache.mockImplementation(() => cache.promise)
    const receipt = data.surface.destroy(data.view.id)
    await turn()
    const candidate = viewFor(EXTENSION_LIMITS.views)
    sessionFor(candidate)
    await expect(data.surface.prepare(candidate, revision)).rejects.toThrow(
      'still closing',
    )
    cache.resolve()
    await receipt
    await data.surface.prepare(candidate, revision)
    await data.surface.dispose()
  })
  it('detach refusal still closes the revoked guest and completes its actual cleanup', async () => {
    const data = await fixture()
    await turn()
    data.debuggerPort.detach.mockImplementation(() => {
      throw new Error('detach refused')
    })
    await data.surface.destroy(data.view.id)
    expect(data.guest.close).toHaveBeenCalledTimes(1)
    expect(data.guest.isDestroyed()).toBe(true)
    expect(data.session.clearCache).toHaveBeenCalledTimes(1)
  })
  it.each(['close', 'session'] as const)(
    'keeps uncertain %s cleanup occupied with its exact rejected receipt',
    async (failure) => {
      const data = await fixture()
      await turn()
      for (let index = 1; index < EXTENSION_LIMITS.views; index++) {
        const view = viewFor(index)
        sessionFor(view)
        await data.surface.prepare(view, revision)
      }
      const refusal = new Error(`${failure} cleanup refused`)
      if (failure === 'close')
        data.guest.close.mockImplementation(() => {
          throw refusal
        })
      else data.session.clearCache.mockRejectedValue(refusal)
      const receipt = data.surface.destroy(data.view.id)
      await expect(receipt).rejects.toThrow('refused')
      expect(data.surface.destroy(data.view.id)).toBe(receipt)
      expect((await data.response()).status).toBe(404)
      if (failure === 'close') {
        expect(data.guest.isDestroyed()).toBe(false)
        expect(data.session.clearCache).not.toHaveBeenCalled()
      }
      const candidate = viewFor(EXTENSION_LIMITS.views)
      sessionFor(candidate)
      await expect(data.surface.prepare(candidate, revision)).rejects.toThrow(
        'restart hvir',
      )
      await expect(data.surface.dispose()).rejects.toMatchObject({ errors: [refusal] })
      await turn()
    },
  )
  it('application surface drain reports failure after its other session cleanup finishes', async () => {
    const data = await fixture()
    await turn()
    const second = viewFor(1),
      otherSession = sessionFor(second)
    await data.surface.prepare(second, revision)
    const failure = new Error('session cleanup refused'),
      held = deferred<void>()
    data.session.clearCache.mockRejectedValue(failure)
    otherSession.clearCache.mockImplementation(() => held.promise)
    const draining = data.surface.dispose()
    let complete = false
    void draining.then(
      () => {
        complete = true
      },
      () => {
        complete = true
      },
    )
    await turn()
    expect(complete).toBe(false)
    held.resolve()
    await expect(draining).rejects.toMatchObject({ errors: [failure] })
    expect(complete).toBe(true)
  })
})
