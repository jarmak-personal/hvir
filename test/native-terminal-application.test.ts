import { describe, expect, it, vi } from 'vitest'
import type { WebFrameMain } from 'electron'
import { NativeTerminalApplication } from '../src/main/terminal/native-terminal-application'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'
import { hostPath, LOCAL_HOST_ID } from '../src/shared/host-path'
vi.mock('electron', () => ({ app: { isPackaged: false }, sharedTexture: {} }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
function fixture() {
  const session = {
    sessionId: 'session',
    instanceId: 'instance',
    ownerId: 1,
    ownerGeneration: 1,
    workspaceRoot: hostPath(LOCAL_HOST_ID, '/project'),
  }
  const state = { handle: 'handle', session, readonly: false, unavailable: false }
  const sessions = {
    get: vi.fn((): typeof state | undefined => state),
    resolve: vi.fn(() => session),
    prepare: vi.fn(),
    remove: vi.fn(() => Promise.resolve(undefined)),
    transferOwner: vi.fn(),
  }
  const host = {
    rendererInfo: vi.fn(),
    inspectProducer: vi.fn(() => Promise.resolve(nativeTerminalStatus())),
    readProducer: vi.fn(() => Promise.resolve(new Uint8Array())),
    encodeKey: vi.fn(() => Promise.resolve(new Uint8Array([0, 128, 255]))),
    dispose: vi.fn(),
  }
  const frame = { isDestroyed: () => false } as WebFrameMain
  const target = {
    frame,
    ready: true,
    isCurrent: () => true,
    onUnavailable: vi.fn(() => () => undefined),
    publishGrant: vi.fn(),
    publishStatus: vi.fn(),
    sendPixels: vi.fn(() => Promise.resolve(undefined)),
  }
  const targets = { create: vi.fn(() => target), dispose: vi.fn(), acknowledge: vi.fn() }
  const grant = {
    viewId: 'view',
    attachment: 1,
    nativeEpoch: 'epoch',
    geometrySerial: 1,
    width: 32,
    height: 32,
    backingScale: 1,
  }
  const presenter = {
    isInputCurrent: vi.fn(() => true),
    attach: vi.fn(() => Promise.resolve('view')),
    update: vi.fn(() => Promise.resolve(grant)),
    demand: vi.fn(() => Promise.resolve(true)),
    detach: vi.fn((): Promise<void> => Promise.resolve()),
    suspend: vi.fn(() => Promise.resolve(undefined)),
  }
  let observePtys = () => undefined as void
  const stopObserving = vi.fn()
  const managed = { id: 'session', ...session }
  const ptys = {
    get: vi.fn((): typeof managed | undefined => managed),
    list: vi.fn(() => [managed]),
    observe: vi.fn((listener: () => void) => {
      observePtys = listener
      return stopObserving
    }),
    resize: vi.fn(),
    writeConfirmed: vi.fn(() => Promise.resolve()),
  }
  const current = vi.fn(() => true)
  const app = new NativeTerminalApplication(
    sessions,
    host,
    presenter,
    targets,
    ptys,
    current,
  )
  const owner = { id: 1, generation: 1 }
  const layout = { width: 32, height: 32, backingScale: 1, visible: true }
  return {
    app,
    observePtys: () => observePtys(),
    stopObserving,
    managed,
    sessions,
    state,
    host,
    presenter,
    ptys,
    current,
    frame,
    owner,
    layout,
    grant,
    targets,
  }
}

describe('native workbench application ownership', () => {
  it('refreshes moved live workspace authority before exit without interpreting absence as removal', () => {
    const f = fixture()
    const target = hostPath(LOCAL_HOST_ID, '/other-worktree')
    f.ptys.list.mockReturnValue([{ ...f.managed, workspaceRoot: target }])
    f.observePtys()
    expect(f.sessions.transferOwner).toHaveBeenCalledWith(
      'session',
      'instance',
      1,
      1,
      target,
    )
    f.ptys.list.mockReturnValue([])
    f.observePtys()
    expect(f.sessions.remove).not.toHaveBeenCalled()
    f.app.dispose()
    expect(f.stopObserving).toHaveBeenCalledTimes(1)
  })
  it('notifies PTY only after matching acknowledged native geometry', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    expect(f.ptys.resize).toHaveBeenCalledWith('session', 1, 4, 4, 1)
    f.state.readonly = true
    await f.app.update('view', f.owner, f.layout)
    expect(f.ptys.resize).toHaveBeenCalledTimes(1)
  })
  it('rejects stale inverted geometry completion even for equal extents', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    const old = deferred<ReturnType<typeof nativeTerminalStatus>>()
    f.host.inspectProducer.mockImplementationOnce(() => old.promise)
    const a = f.app.update('view', f.owner, f.layout)
    await vi.waitFor(() => expect(f.host.inspectProducer).toHaveBeenCalledTimes(1))
    f.presenter.update.mockResolvedValue({ ...f.grant, geometrySerial: 2 })
    f.host.inspectProducer.mockResolvedValue({
      ...nativeTerminalStatus(2),
      geometry: { ...nativeTerminalStatus(2).geometry, columns: 8 },
    })
    await f.app.update('view', f.owner, f.layout)
    old.resolve(nativeTerminalStatus())
    await a
    expect(f.ptys.resize).toHaveBeenCalledTimes(1)
    expect(f.ptys.resize).toHaveBeenLastCalledWith('session', 1, 8, 4, 1)
  })
  it('does not notify an exited PTY when its admitted native tail has not reached readonly yet', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    const inspected = deferred<ReturnType<typeof nativeTerminalStatus>>()
    f.host.inspectProducer.mockReturnValue(inspected.promise)
    const updating = f.app.update('view', f.owner, f.layout)
    await vi.waitFor(() => expect(f.host.inspectProducer).toHaveBeenCalled())
    f.ptys.get.mockReturnValue(undefined)
    inspected.resolve(nativeTerminalStatus())
    await updating
    expect(f.ptys.resize).not.toHaveBeenCalled()
    expect(f.presenter.suspend).not.toHaveBeenCalled()
  })
  it('always removes native state despite a detached renderer failure', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    f.presenter.detach.mockRejectedValue(new Error('gone'))
    await expect(f.app.remove('session', 'instance')).rejects.toThrow('gone')
    expect(f.sessions.remove).toHaveBeenCalledWith('session', 'instance')
    await expect(f.app.demand('view', f.owner)).rejects.toThrow('native-view-foreign')
  })
  it('settles presentation detach before native state destruction while still cleaning after failure', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    const detached = deferred<void>()
    f.presenter.detach.mockReturnValue(detached.promise)
    const removing = f.app.remove('session', 'instance')
    expect(f.sessions.remove).not.toHaveBeenCalled()
    detached.resolve()
    await removing
    expect(f.sessions.remove).toHaveBeenCalledExactlyOnceWith('session', 'instance')
  })
  it('does not resurrect a view when explicit removal settles during attachment', async () => {
    const f = fixture()
    const attached = deferred<string>()
    f.presenter.attach.mockReturnValue(attached.promise)
    const attaching = f.app.attach('session', f.owner, f.frame)
    await f.app.remove('session', 'instance')
    f.sessions.get.mockReturnValue(undefined)
    attached.resolve('late-view')
    await expect(attaching).rejects.toThrow('native-session-foreign')
    expect(f.presenter.detach).toHaveBeenCalledWith('late-view')
    await expect(f.app.demand('late-view', f.owner)).rejects.toThrow(
      'native-view-foreign',
    )
  })
  it('writes exact native encoded user bytes and refuses exited/stale input', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    const input = { key: 0, modifiers: 0, action: 1, text: 'é' }
    await f.app.key('view', f.owner, input)
    expect(f.ptys.writeConfirmed).toHaveBeenCalledWith(
      'session',
      1,
      new Uint8Array([0, 128, 255]),
      1,
      'user',
    )
    f.state.readonly = true
    await expect(f.app.key('view', f.owner, input)).rejects.toThrow(
      'native-session-readonly',
    )
    f.current.mockReturnValue(false)
    await expect(f.app.update('view', f.owner, f.layout)).rejects.toThrow(
      'native-session-foreign',
    )
  })
  it('rejects input after presentation grant loss without destroying the parser or PTY', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    f.presenter.isInputCurrent.mockReturnValue(false)
    await expect(
      f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'x' }),
    ).rejects.toThrow('native-presentation-unavailable')
    expect(f.host.encodeKey).not.toHaveBeenCalled()
    expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
    expect(f.sessions.remove).not.toHaveBeenCalled()
    await expect(f.app.readRetained('session', f.owner)).resolves.toEqual(
      new Uint8Array(),
    )
  })
  it('rejects a key encoded before presentation suspension without writing or retiring the parser', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    const encoded = deferred<Uint8Array<ArrayBuffer>>()
    f.host.encodeKey.mockReturnValue(encoded.promise)
    const key = f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'x' })
    f.presenter.isInputCurrent.mockReturnValue(false)
    encoded.resolve(new Uint8Array([120]))
    await expect(key).rejects.toThrow('native-presentation-unavailable')
    expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
    expect(f.sessions.remove).not.toHaveBeenCalled()
  })
  it('revokes an encoded key when the current view hides before physical write', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    const encoded = deferred<Uint8Array<ArrayBuffer>>()
    f.host.encodeKey.mockReturnValue(encoded.promise)
    const key = f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'x' })
    await f.app.update('view', f.owner, { ...f.layout, visible: false })
    encoded.resolve(new Uint8Array([120]))
    await expect(key).rejects.toThrow('native-view-hidden')
    expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
  })
  it('revokes replaced input views before encoding and after an in-flight encode', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    const encoded = deferred<Uint8Array<ArrayBuffer>>()
    f.host.encodeKey.mockImplementationOnce(() => encoded.promise)
    const old = f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'x' })
    f.presenter.attach.mockResolvedValue('replacement')
    await f.app.attach('session', f.owner, f.frame)
    await expect(
      f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'y' }),
    ).rejects.toThrow('native-view-foreign')
    expect(f.host.encodeKey).toHaveBeenCalledTimes(1)
    encoded.resolve(new Uint8Array([120]))
    await expect(old).rejects.toThrow('native-view-foreign')
    expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
  })
  it('revokes failed native output presentation while retaining the PTY/session record', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    f.state.unavailable = true
    f.app.unavailable('session', 'other')
    expect(f.presenter.suspend).not.toHaveBeenCalled()
    f.app.unavailable('session', 'instance')
    expect(f.presenter.suspend).toHaveBeenCalledWith('view')
    expect(f.sessions.remove).not.toHaveBeenCalled()
    await expect(
      f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'x' }),
    ).rejects.toThrow('native-session-foreign')
  })
})
