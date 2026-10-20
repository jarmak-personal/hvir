import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import type { ExtensionView } from '../../src/shared/extensions/workbench'
import { validateCapturedExtension } from '../../src/main/extensions/package-store'
import { exampleManifest } from './extension-package'

const electronPorts = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  guests: new Map<number, unknown>(),
  windows: new Map<number, unknown>(),
}))
export const electron = electronPorts
vi.mock('electron', () => ({
  app: { getAppPath: () => '/owned-app' },
  BrowserWindow: {
    fromWebContents: (contents: { id: number }) => electronPorts.windows.get(contents.id),
  },
  session: { fromPartition: (partition: string) => electronPorts.sessions.get(partition) },
  webContents: {
    fromDevToolsTargetId: () => electronPorts.guests.get(1),
    fromId: (id: number) => electronPorts.guests.get(id),
  },
}))
import { ElectronExtensionGuestSurface } from '../../src/main/extensions/electron-guest-surface'
import type { ExtensionGuestOwner } from '../../src/main/extensions/guest-owner'

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
export const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
export const owner = { id: 1, generation: 1 }
export const revision = validateCapturedExtension({
  sourceIdentity: '1:1',
  files: new Map([
    ['hvir-extension.json', Buffer.from(JSON.stringify(exampleManifest()))],
    ['index.html', Buffer.from('captured')],
    ['detail.html', Buffer.from('detail')],
  ]),
})

export function sessionFor(view: ExtensionView) {
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
export function viewFor(index = 0): ExtensionView {
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
export async function fixture(
  send?: (method: string, params?: { state?: string }) => Promise<unknown>,
  admittedDuringBind = false,
  loading = false,
  committed = true,
  view = viewFor(),
) {
  const surface = new ElectronExtensionGuestSurface()
  const session = sessionFor(view)
  const debuggerPort = Object.assign(new EventEmitter(), {
    attach: vi.fn(),
    isAttached: vi.fn(() => true),
    detach: vi.fn(),
    sendCommand: vi.fn<(method: string, params?: { state?: string }) => Promise<unknown>>(
      (method, params) =>
        send
          ? send(method, params)
          : Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } }),
    ),
  })
  let destroyed = false
  let dispatching = false
  let backgroundThrottling = true
  const guestEvents = new EventEmitter()
  const guest = Object.assign(guestEvents, {
    id: 1,
    session,
    debugger: debuggerPort,
    isDestroyed: () => destroyed,
    getURL: () => (committed ? view.url : 'about:blank'),
    isLoading: () => loading,
    close: vi.fn(() => {
      if (dispatching)
        throw new Error('Native guest deletion reentered debugger dispatch')
      destroyed = true
      guestEvents.emit('destroyed')
    }),
    send: vi.fn(),
    getBackgroundThrottling: vi.fn(() => backgroundThrottling),
    setBackgroundThrottling: vi.fn((allowed: boolean) => {
      backgroundThrottling = allowed
    }),
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
    bind: () => {
      surface.runnable(guest.id, admittedDuringBind)
      return view
    },
    failed,
    foregroundChanged: vi.fn(),
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
    states: () =>
      debuggerPort.sendCommand.mock.calls
        .filter(([method]) => method === 'Page.setWebLifecycleState')
        .map((call) => (call[1] as { state: string }).state),
    finishLoad: () => {
      loading = false
      guest.emit('did-finish-load')
    },
    commit: (url = view.url) => {
      if (url === view.url) committed = true
      guest.emit('did-navigate', {}, url)
    },
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
