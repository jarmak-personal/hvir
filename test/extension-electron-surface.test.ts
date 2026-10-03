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
async function fixture(
  send?: (method: string, params?: { state?: string }) => Promise<unknown>,
  admittedDuringBind = false,
  loading = false,
  committed = true,
) {
  const surface = new ElectronExtensionGuestSurface()
  const view = viewFor(),
    session = sessionFor(view)
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
afterEach(() => {
  electron.sessions.clear()
  electron.guests.clear()
  vi.restoreAllMocks()
})

describe('Electron extension response, native teardown and closing capacity', () => {
  it('commit barrier releases observed bytes first, then activates only the exact committed main frame', async () => {
    let nativeCommitted = false
    const data = await fixture(
      (method) =>
        method === 'Page.setWebLifecycleState' && !nativeCommitted
          ? Promise.reject(new Error('Not attached to an active page'))
          : Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } }),
      false,
      true,
      false,
    )
    data.surface.visibility(data.guest.id, true)
    await turn()
    expect(await (await data.response()).text()).toBe('captured')
    expect(data.debuggerPort.sendCommand.mock.calls.some(([method]) => method === 'Page.enable')).toBe(true)
    expect(data.states()).toEqual([])
    data.guest.emit('did-frame-navigate', {}, data.view.url, 200, 'OK', false)
    data.commit('hvir-extension://foreign/index.html')
    await turn()
    expect(data.states()).toEqual([])
    nativeCommitted = true
    data.commit()
    await turn()
    expect(data.states()).toEqual(['active'])
    expect(data.guest.isLoading()).toBe(true)
    expect(data.failed).not.toHaveBeenCalled()
    expect(data.guest.listenerCount('did-navigate')).toBe(0)
    await data.surface.destroy(data.view.id)
  })

  it('commit barrier does not suppress an active native refusal after commit', async () => {
    const data = await fixture(
      (method) =>
        method === 'Page.setWebLifecycleState'
          ? Promise.reject(new Error('Not attached to an active page'))
          : Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } }),
      true,
      true,
      false,
    )
    await turn()
    expect(data.failed).not.toHaveBeenCalled()
    data.commit()
    await turn()
    expect(data.states()).toEqual(['active'])
    expect(data.failed).toHaveBeenCalledWith(
      data.guest.id,
      'Extension engine lifecycle control is unavailable. Close and reopen the view.',
    )
    expect((await data.response()).status).toBe(404)
    await data.surface.destroy(data.view.id)
    expect(data.guest.listenerCount('did-navigate')).toBe(0)
    expect(data.session.clearCache).toHaveBeenCalledTimes(1)
  })

  it('commit barrier at nine seconds retains the original ten-second native command deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = deferred<unknown>()
    const report = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const data = await fixture(
      (method) =>
        method === 'Page.setWebLifecycleState'
          ? pending.promise
          : Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } }),
      true,
      true,
      false,
    )
    try {
      await turn()
      await vi.advanceTimersByTimeAsync(9000)
      expect(data.states()).toEqual([])
      data.commit()
      await turn()
      expect(data.states()).toEqual(['active'])
      await vi.advanceTimersByTimeAsync(999)
      expect(data.failed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(report).toHaveBeenCalledTimes(1)
      expect(JSON.parse(report.mock.calls[0]![1] as string)).toMatchObject({
        stage: 'state-command',
        category: 'timeout',
        attemptedState: 'active',
      })
      expect(JSON.parse(report.mock.calls[0]![1] as string)).not.toHaveProperty('nativeRefusal')
      pending.resolve({})
      await turn()
      expect(data.states()).toEqual(['active'])
      await data.surface.destroy(data.view.id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('commit barrier close removes its listener and ignores late commit/load events', async () => {
    const data = await fixture(undefined, true, true, false)
    await turn()
    expect(data.states()).toEqual([])
    await data.surface.destroy(data.view.id)
    expect(data.guest.listenerCount('did-navigate')).toBe(0)
    data.commit()
    data.finishLoad()
    await turn()
    expect(data.states()).toEqual([])
    expect((await data.response()).status).toBe(404)
    expect(data.session.clearCache).toHaveBeenCalledTimes(1)
  })

  it('commit barrier without a matching commit fails closed at the original deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const report = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const data = await fixture(undefined, true, true, false)
    try {
      await turn()
      expect(await (await data.response()).text()).toBe('captured')
      await vi.advanceTimersByTimeAsync(EXTENSION_LIMITS.requestTimeoutMs - 1)
      expect(data.failed).not.toHaveBeenCalled()
      expect(data.states()).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(report).toHaveBeenCalledTimes(1)
      expect(JSON.parse(report.mock.calls[0]![1] as string)).toEqual({
        stage: 'initial-commit',
        category: 'timeout',
        role: 'view',
        visible: false,
        admittedWork: true,
        loading: true,
        urlMatches: false,
        debuggerAttached: true,
      })
      expect(data.failed).toHaveBeenCalledWith(
        data.guest.id,
        'Extension engine lifecycle control is unavailable. Close and reopen the view.',
      )
      await data.surface.destroy(data.view.id)
      expect(data.guest.listenerCount('did-navigate')).toBe(0)
      data.commit()
      data.finishLoad()
      await turn()
      expect(data.states()).toEqual([])
      expect((await data.response()).status).toBe(404)
      expect(data.session.clearCache).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('commit barrier keeps observer refusal ahead of commit and captured code', async () => {
    const data = await fixture(
      (method) =>
        method === 'Page.enable'
          ? Promise.reject(new Error('Observer refused'))
          : Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } }),
      true,
      true,
      false,
    )
    await turn()
    expect((await data.response()).status).toBe(404)
    expect(data.states()).toEqual([])
    await data.surface.destroy(data.view.id)
    data.commit()
    await turn()
    expect(data.states()).toEqual([])
    expect(data.guest.listenerCount('did-navigate')).toBe(0)
  })

  it.each(['visible', 'finite-work'] as const)(
    'bootstrap renewal by %s retires only a pre-load freeze and preserves later hidden freezing',
    async (demand) => {
      const data = await fixture(undefined, false, true)
      try {
        expect(await (await data.response()).text()).toBe('captured')
        await turn()
        expect(data.states()).toEqual([])
        if (demand === 'visible') data.surface.visibility(data.guest.id, true)
        else data.surface.runnable(data.guest.id, true)
        await turn()
        expect(data.states()).toEqual(['active'])
        expect(data.failed).not.toHaveBeenCalled()
        if (demand === 'visible') data.surface.visibility(data.guest.id, false)
        else data.surface.runnable(data.guest.id, false)
        await turn()
        expect(data.states()).toEqual(['active'])
        data.finishLoad()
        await turn()
        expect(data.states().at(-1)).toBe('frozen')
        expect(data.failed).not.toHaveBeenCalled()
      } finally {
        await data.surface.destroy(data.view.id)
      }
    },
  )

  it('bootstrap renewal at nine seconds keeps the original ten-second deadline for its native command', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const report = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const pending = deferred<unknown>()
    const data = await fixture(
      (method) =>
        method === 'Page.setWebLifecycleState'
          ? pending.promise
          : Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } }),
      false,
      true,
    )
    try {
      await turn()
      await vi.advanceTimersByTimeAsync(9000)
      data.surface.visibility(data.guest.id, true)
      await turn()
      expect(data.states()).toEqual(['active'])
      await vi.advanceTimersByTimeAsync(999)
      expect(report).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(report).toHaveBeenCalledTimes(1)
      expect(JSON.parse(report.mock.calls[0]![1] as string)).toMatchObject({
        stage: 'state-command',
        category: 'timeout',
        visible: true,
        loading: true,
      })
      const commands = data.debuggerPort.sendCommand.mock.calls.length
      pending.resolve(undefined)
      data.finishLoad()
      await turn()
      expect(data.debuggerPort.sendCommand.mock.calls).toHaveLength(commands)
      expect((await data.response()).status).toBe(404)
    } finally {
      vi.useRealTimers()
      await data.surface.destroy(data.view.id)
    }
  })

  it('coalesces bootstrap renewals that return to hidden without premature freeze or deadline reset', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const report = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const data = await fixture(undefined, false, true)
    try {
      await turn()
      await vi.advanceTimersByTimeAsync(9000)
      for (let index = 0; index < 100; index++) {
        data.surface.visibility(data.guest.id, true)
        data.surface.visibility(data.guest.id, false)
      }
      await turn()
      expect(data.states()).toEqual([])
      await vi.advanceTimersByTimeAsync(1000)
      expect(report).toHaveBeenCalledTimes(1)
      expect(JSON.parse(report.mock.calls[0]![1] as string)).toMatchObject({
        stage: 'load-before-freeze',
        category: 'timeout',
        visible: false,
      })
      data.finishLoad()
      await turn()
      expect(data.states()).toEqual([])
      expect((await data.response()).status).toBe(404)
    } finally {
      vi.useRealTimers()
      await data.surface.destroy(data.view.id)
    }
  })

  it('observer refusal wins over bootstrap renewal and releases no captured bytes', async () => {
    const report = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const pending = deferred<unknown>()
    const data = await fixture(
      (method) =>
        method === 'Page.enable'
          ? pending.promise
          : Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } }),
      false,
      true,
    )
    data.surface.visibility(data.guest.id, true)
    pending.resolve(Promise.reject(new Error('Observer refused after demand renewal')))
    await turn()
    expect(JSON.parse(report.mock.calls[0]![1] as string)).toMatchObject({
      stage: 'observer-command',
      category: 'refusal',
    })
    expect(data.states()).toEqual([])
    expect((await data.response()).status).toBe(404)
    await data.surface.destroy(data.view.id)
    expect(data.guest.isDestroyed()).toBe(true)
  })

  it.each(['target', 'state'] as const)(
    'does not retire an issued frozen %s command when visible demand returns',
    async (held) => {
      const pending = deferred<unknown>()
      let targets = 0
      const data = await fixture((method, params) => {
        if (method === 'Target.getTargetInfo') targets++
        if (
          (held === 'target' && method === 'Target.getTargetInfo' && targets === 2) ||
          (held === 'state' &&
            method === 'Page.setWebLifecycleState' &&
            params?.state === 'frozen')
        )
          return pending.promise
        return Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } })
      })
      await turn()
      const commands = data.debuggerPort.sendCommand.mock.calls.length
      data.surface.visibility(data.guest.id, true)
      await turn()
      expect(data.debuggerPort.sendCommand.mock.calls).toHaveLength(commands)
      expect(data.states()).toEqual(held === 'state' ? ['frozen'] : [])
      pending.resolve({ targetInfo: { targetId: 'target', type: 'webview' } })
      await turn()
      expect(data.states()).toEqual(['frozen', 'active'])
      expect(data.failed).not.toHaveBeenCalled()
      await data.surface.destroy(data.view.id)
    },
  )

  it('close after bootstrap renewal rejects late loading without any successor native command', async () => {
    const data = await fixture(undefined, false, true)
    expect(await (await data.response()).text()).toBe('captured')
    await turn()
    data.surface.visibility(data.guest.id, true)
    const receipt = data.surface.destroy(data.view.id)
    const commands = data.debuggerPort.sendCommand.mock.calls.length
    await receipt
    data.finishLoad()
    await turn()
    expect(data.debuggerPort.sendCommand.mock.calls).toHaveLength(commands)
    expect(data.states()).toEqual([])
    expect((await data.response()).status).toBe(404)
    expect(data.session.clearCache).toHaveBeenCalledTimes(1)
  })

  it.each(['observer-command', 'load-before-freeze', 'state-command'] as const)(
    'reports the stalled %s stage at the unchanged lifecycle deadline',
    async (stage) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const report = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const pending = deferred<unknown>()
      const data = await fixture(
        (method) =>
          (stage === 'observer-command' && method === 'Page.enable') ||
          (stage === 'state-command' && method === 'Page.setWebLifecycleState')
            ? pending.promise
            : Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } }),
        false,
        stage === 'load-before-freeze',
      )
      try {
        await turn()
        await vi.advanceTimersByTimeAsync(EXTENSION_LIMITS.requestTimeoutMs - 1)
        expect(report).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(report).toHaveBeenCalledTimes(1)
        expect(JSON.parse(report.mock.calls[0]![1] as string)).toEqual({
          stage,
          category: 'timeout',
          ...(stage === 'state-command' ? { attemptedState: 'frozen' } : {}),
          role: 'view',
          visible: false,
          admittedWork: false,
          loading: stage === 'load-before-freeze',
          urlMatches: true,
          debuggerAttached: true,
        })
        expect((await data.response()).status).toBe(404)
        const commands = data.debuggerPort.sendCommand.mock.calls.length
        pending.resolve({ targetInfo: { targetId: 'target', type: 'webview' } })
        data.guest.emit('did-finish-load')
        await vi.advanceTimersByTimeAsync(0)
        expect(data.debuggerPort.sendCommand.mock.calls).toHaveLength(commands)
        expect(report).toHaveBeenCalledTimes(1)
        await data.surface.destroy(data.view.id)
        expect(data.guest.isDestroyed()).toBe(true)
        expect(data.session.clearCache).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each([
    'bootstrap-target',
    'observer-command',
    'transition-target',
    'state-command',
  ] as const)(
    'reports one closed %s refusal without exception or package data',
    async (stage) => {
      const report = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      let targets = 0
      const data = await fixture((method) => {
        if (method === 'Target.getTargetInfo') targets++
        if (
          (stage === 'bootstrap-target' && targets === 1) ||
          (stage === 'observer-command' && method === 'Page.enable') ||
          (stage === 'transition-target' && targets === 2) ||
          (stage === 'state-command' && method === 'Page.setWebLifecycleState')
        )
          return Promise.reject(new Error('Unreviewed package/URL/exception data'))
        return Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } })
      })
      await turn()
      expect(report).toHaveBeenCalledTimes(1)
      expect(report.mock.calls[0]?.[0]).toBe('[extensions:engine-lifecycle-failure]')
      expect(JSON.parse(report.mock.calls[0]![1] as string)).toEqual({
        stage,
        category: 'refusal',
        ...(stage === 'state-command'
          ? { attemptedState: 'frozen', nativeRefusal: 'other' }
          : {}),
        role: 'view',
        visible: false,
        admittedWork: false,
        loading: false,
        urlMatches: true,
        debuggerAttached: true,
      })
      expect(data.failed).toHaveBeenCalledWith(
        data.guest.id,
        'Extension engine lifecycle control is unavailable. Close and reopen the view.',
      )
      expect((await data.response()).status).toBe(404)
      await data.surface.destroy(data.view.id)
      expect(data.guest.isDestroyed()).toBe(true)
      expect(data.session.clearCache).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    ['Not attached to a page', 'no-frame'],
    ['Not attached to an active page', 'inactive-frame'],
    ['Command can only be executed on top-level targets', 'not-top-level'],
  ] as const)(
    'reports only the closed native state-command reason for %s',
    async (message, reason) => {
      const report = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const data = await fixture(
        (method) =>
          method === 'Page.setWebLifecycleState'
            ? Promise.reject(new Error(message))
            : Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } }),
        true,
        true,
      )
      await turn()
      expect(report).toHaveBeenCalledTimes(1)
      expect(JSON.parse(report.mock.calls[0]![1] as string)).toEqual({
        stage: 'state-command',
        category: 'refusal',
        attemptedState: 'active',
        nativeRefusal: reason,
        role: 'view',
        visible: false,
        admittedWork: true,
        loading: true,
        urlMatches: true,
        debuggerAttached: true,
      })
      expect(report.mock.calls[0]![1]).not.toContain(message)
      expect((await data.response()).status).toBe(404)
      await data.surface.destroy(data.view.id)
      expect(data.guest.isDestroyed()).toBe(true)
      expect(data.session.clearCache).toHaveBeenCalledTimes(1)
    },
  )

  it('an unreadable native error preserves refusal and cleanup without invented details', async () => {
    const report = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = new Error()
    Object.defineProperty(error, 'message', {
      get: () => {
        throw new Error('Unreviewed package/URL/exception data')
      },
    })
    const data = await fixture((method) =>
      method === 'Page.setWebLifecycleState'
        ? Promise.reject(error)
        : Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } }),
    )
    await turn()
    expect(report).toHaveBeenCalledTimes(1)
    expect(JSON.parse(report.mock.calls[0]![1] as string)).toMatchObject({
      stage: 'state-command',
      category: 'refusal',
      attemptedState: 'frozen',
      nativeRefusal: 'other',
    })
    expect(report.mock.calls[0]![1]).not.toContain('Unreviewed')
    expect(data.failed).toHaveBeenCalledWith(
      data.guest.id,
      'Extension engine lifecycle control is unavailable. Close and reopen the view.',
    )
    expect((await data.response()).status).toBe(404)
    await data.surface.destroy(data.view.id)
    expect(data.guest.isDestroyed()).toBe(true)
    expect(data.session.clearCache).toHaveBeenCalledTimes(1)
  })

  it.each(['collection', 'logging'] as const)(
    'diagnostic %s failure preserves engine refusal and native cleanup',
    async (failure) => {
      const pending = deferred<unknown>()
      const report = vi.spyOn(console, 'warn').mockImplementation(() => {
        if (failure === 'logging') throw new Error('Diagnostic logger unavailable')
      })
      const data = await fixture((method) =>
        method === 'Page.enable'
          ? pending.promise
          : Promise.resolve({ targetInfo: { targetId: 'target', type: 'webview' } }),
      )
      if (failure === 'collection')
        vi.spyOn(data.guest, 'isLoading').mockImplementation(() => {
          throw new Error('Diagnostic native getter unavailable')
        })
      pending.resolve(Promise.reject(new Error('Observer setup refused')))
      await turn()
      expect(data.failed).toHaveBeenCalledWith(
        data.guest.id,
        'Extension engine lifecycle control is unavailable. Close and reopen the view.',
      )
      expect(report).toHaveBeenCalledTimes(failure === 'logging' ? 1 : 0)
      expect((await data.response()).status).toBe(404)
      await data.surface.destroy(data.view.id)
      expect(data.guest.isDestroyed()).toBe(true)
      expect(data.session.clearCache).toHaveBeenCalledTimes(1)
    },
  )

  it('preserves finite work admitted during native bind before lifecycle creation and freezes when it ends', async () => {
    const data = await fixture(undefined, true)
    try {
      await turn()
      const states = () =>
        data.debuggerPort.sendCommand.mock.calls
          .filter(([method]) => method === 'Page.setWebLifecycleState')
          .map((call) => (call[1] as { state: string }).state)
      expect(states().length).toBeGreaterThan(0)
      expect(states().every((state) => state === 'active')).toBe(true)
      data.surface.runnable(data.guest.id, false)
      await turn()
      expect(states().at(-1)).toBe('frozen')
      expect(data.failed).not.toHaveBeenCalled()
    } finally {
      await data.surface.destroy(data.view.id)
    }
  })

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
