import { PtyWriteConfirmedRevokedError } from '../src/main/project-host/project-host'
import type { NativeTerminalInputOperation } from '../src/shared/native-terminal-input'
import type { NativeTerminalHost } from '../src/main/terminal/native-terminal-host'
import { describe, expect, it, vi } from 'vitest'
import type { WebFrameMain } from 'electron'
import { NativeTerminalApplication } from '../src/main/terminal/native-terminal-application'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'
import { hostPath, LOCAL_HOST_ID } from '../src/shared/host-path'
vi.mock('electron', () => ({ app: { isPackaged: false }, sharedTexture: {} }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function watched<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined)
  return promise
}
function fixture() {
  const session = {
    sessionId: 'session',
    instanceId: 'instance',
    ownerId: 1,
    ownerGeneration: 1,
    workspaceRoot: hostPath(LOCAL_HOST_ID, '/project'),
  }
  const state = {
    handle: 'handle',
    session,
    readonly: false,
    inputClosed: false,
    inputUnavailable: false,
    unavailable: false,
    inputSettlement: undefined as Promise<void> | undefined,
  }
  const sessions = {
    get: vi.fn((_id?: string): typeof state | undefined => state),
    resolve: vi.fn(() => session),
    prepare: vi.fn(),
    remove: vi.fn(() => Promise.resolve(undefined)),
    transferOwner: vi.fn(),
    blockInput: vi.fn(() => {
      state.inputUnavailable = true
    }),
    inputSettled: vi.fn((id: string, instance: string): Promise<void> | undefined => {
      const record = sessions.get(id)
      if (!record || record.session.instanceId !== instance)
        throw new Error('native-session-instance-stale')
      return record.inputSettlement
    }),
    retainInput: vi.fn(
      (id: string, instance: string, pending: Promise<unknown>): void => {
        const record = sessions.get(id)
        if (!record || record.session.instanceId !== instance)
          throw new Error('native-session-instance-stale')
        const settlement = Promise.allSettled([record.inputSettlement, pending]).then(
          () => undefined,
        )
        record.inputSettlement = settlement
        void settlement.then(() => {
          if (record.inputSettlement === settlement) record.inputSettlement = undefined
        })
      },
    ),
    writeControl: vi.fn(() => Promise.resolve()),
  }
  const encodeKey = vi.fn((_operation?: NativeTerminalInputOperation) =>
    Promise.resolve(new Uint8Array([0, 128, 255])),
  )
  const host = {
    rendererInfo: vi.fn(),
    inspectProducer: vi.fn(() => Promise.resolve(nativeTerminalStatus())),
    readProducer: vi.fn(() => Promise.resolve(new Uint8Array())),
    encodeKey,
    input: vi.fn<NativeTerminalHost['input']>(
      async (_handle, _instance, operation, eligible) => {
        await eligible?.(new AbortController().signal)
        const bytes =
          operation.kind === 'key' ? await encodeKey(operation) : new Uint8Array()
        return {
          bytes,
          capacity: bytes.byteLength,
          source: operation.kind === 'focus' ? 'terminal-response' : 'user',
          requestedMutation: 0,
        }
      },
    ),
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
    get: vi.fn((_id?: string): typeof managed | undefined => managed),
    list: vi.fn(() => [managed]),
    observe: vi.fn((listener: () => void) => {
      observePtys = listener
      return stopObserving
    }),
    inputPrefix: vi.fn(() => ({
      parsed: (signal: AbortSignal) => {
        signal.throwIfAborted()
        return Promise.resolve()
      },
      replies: (signal: AbortSignal) => {
        signal.throwIfAborted()
        return Promise.resolve()
      },
    })),
    inputPolicy: vi.fn(() => ({
      composerSubmitMode: 'enter' as const,
      modifiedKeyProtocol: 'none' as const,
      metaEnterAliasesControl: false,
    })),
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
  it.each(['keyEncodingFallback', 'policy', 'readOnly', 'source'])(
    'rejects renderer-selected private %s before native work',
    async (field) => {
      const f = fixture()
      await f.app.attach('session', f.owner, f.frame)
      await f.app.update('view', f.owner, f.layout)
      const forged = {
        kind: 'key',
        key: 58,
        modifiers: 2,
        consumedModifiers: 0,
        action: 1,
        text: '',
        unshiftedCodepoint: 0,
        composing: false,
        optionAsAlt: false,
        [field]: field === 'keyEncodingFallback' ? 'csi-u' : true,
      }
      expect(() =>
        f.app.input(
          'view',
          f.owner,
          forged as import('../src/shared/native-terminal-input').NativeTerminalInputOperation,
        ),
      ).toThrow('native-input-invalid')
      expect(f.host.input).not.toHaveBeenCalled()
      expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
    },
  )
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
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
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
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
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
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    const encoded = deferred<Uint8Array<ArrayBuffer>>()
    f.host.encodeKey.mockReturnValue(encoded.promise)
    const key = watched(
      f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'x' }),
    )
    await vi.waitFor(() => expect(f.host.encodeKey).toHaveBeenCalledTimes(1))
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
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    const encoded = deferred<Uint8Array<ArrayBuffer>>()
    f.host.encodeKey.mockReturnValue(encoded.promise)
    const key = watched(
      f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'x' }),
    )
    await vi.waitFor(() => expect(f.host.encodeKey).toHaveBeenCalledTimes(1))
    const hiding = f.app.update('view', f.owner, { ...f.layout, visible: false })
    encoded.resolve(new Uint8Array([120]))
    await expect(key).rejects.toThrow('native-view-hidden')
    await hiding
    expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
  })
  it('revokes replaced input views before encoding and after an in-flight encode', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    const encoded = deferred<Uint8Array<ArrayBuffer>>()
    f.host.encodeKey.mockImplementationOnce(() => encoded.promise)
    const old = watched(
      f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'x' }),
    )
    await vi.waitFor(() => expect(f.host.encodeKey).toHaveBeenCalledTimes(1))
    f.presenter.attach.mockResolvedValue('replacement')
    const replacing = f.app.attach('session', f.owner, f.frame)
    await expect(
      f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'y' }),
    ).rejects.toThrow('native-view-foreign')
    expect(f.host.encodeKey).toHaveBeenCalledTimes(1)
    encoded.resolve(new Uint8Array([120]))
    await expect(old).rejects.toThrow('native-view-foreign')
    await replacing
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
  it('keeps focus through native preedit clear, committing IME once before following typing', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    // Controlled native-port result bodies; this test does not implement/prove a codec.
    f.host.encodeKey.mockResolvedValueOnce(Uint8Array.of(230, 151, 165, 230, 156, 172))
    f.host.encodeKey.mockResolvedValueOnce(Uint8Array.of(120))
    await f.app.input('view', f.owner, { kind: 'preedit', text: '' })
    await f.app.input('view', f.owner, { kind: 'preedit', text: 'に' })
    await f.app.input('view', f.owner, { kind: 'preedit', text: null })
    await f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: '日本' })
    await f.app.key('view', f.owner, { key: 43, modifiers: 0, action: 1, text: 'x' })
    expect(f.host.input.mock.calls.map(([, , operation]) => operation)).toEqual([
      { kind: 'focus', focused: true },
      { kind: 'preedit', text: '' },
      { kind: 'preedit', text: 'に' },
      { kind: 'preedit', text: null },
      expect.objectContaining({ kind: 'key', text: '日本' }),
      expect.objectContaining({ kind: 'key', text: 'x' }),
    ])
    expect(f.ptys.writeConfirmed.mock.calls).toEqual([
      ['session', 1, Uint8Array.of(230, 151, 165, 230, 156, 172), 1, 'user'],
      ['session', 1, Uint8Array.of(120), 1, 'user'],
    ])
    expect(f.sessions.writeControl).not.toHaveBeenCalled()
  })

  it('uses trusted readonly native navigation without user/control PTY writes or captured button requests', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    f.state.readonly = true
    f.state.inputClosed = true
    f.ptys.get.mockReturnValue(undefined)
    const wheel: NativeTerminalInputOperation = {
      kind: 'wheel',
      x: 10,
      y: 15,
      deltaX: 0,
      deltaY: -24,
      precision: true,
      modifiers: 0,
    }
    await f.app.input('view', f.owner, wheel)
    await f.app.input('view', f.owner, { kind: 'pointer', x: 10, y: 15, modifiers: 0 })
    expect(f.host.input).toHaveBeenCalledWith(
      'handle',
      'instance',
      wheel,
      expect.any(Function),
      true,
      undefined,
    )
    expect(f.host.input.mock.calls.every((call) => call[4] === true)).toBe(true)
    expect(() =>
      f.app.input('view', f.owner, {
        kind: 'pointer',
        x: 10,
        y: 15,
        modifiers: 0,
        button: 1,
        action: 1,
      }),
    ).toThrow('native-session-readonly')
    await expect(
      f.app.key('view', f.owner, { key: 20, text: 'a', modifiers: 0, action: 1 }),
    ).rejects.toThrow('native-session-readonly')
    expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
    expect(f.sessions.writeControl).not.toHaveBeenCalled()
    expect(f.host.encodeKey).not.toHaveBeenCalled()
    f.state.session = { ...f.state.session, instanceId: 'replacement' }
    expect(() => f.app.input('view', f.owner, wheel)).toThrow('native-view-stale')
  })
  it('writes captured-wheel bytes to its visible unfocused pane while keyboard focus belongs to another pane', async () => {
    const f = fixture()
    const other = {
      ...f.state,
      handle: 'other-handle',
      session: { ...f.state.session, sessionId: 'other', instanceId: 'other-instance' },
    }
    f.sessions.get.mockImplementation((id) => (id === 'other' ? other : f.state))
    f.ptys.get.mockImplementation((id) =>
      id === 'other'
        ? { ...f.managed, id: 'other', instanceId: 'other-instance' }
        : f.managed,
    )
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    f.presenter.attach.mockResolvedValue('other-view')
    await f.app.attach('other', f.owner, f.frame)
    await f.app.update('other-view', f.owner, f.layout)
    await f.app.input('other-view', f.owner, { kind: 'focus', focused: true })
    await f.app.input('view', f.owner, { kind: 'focus', focused: false })
    const bytes = Uint8Array.of(27, 91, 77, 96, 33, 33)
    f.host.input.mockResolvedValueOnce({
      bytes,
      capacity: bytes.byteLength,
      source: 'user',
      requestedMutation: 0,
      captured: true,
    })
    await f.app.input('view', f.owner, {
      kind: 'wheel',
      x: 1,
      y: 2,
      deltaX: 0,
      deltaY: -24,
      precision: true,
      modifiers: 0,
    })
    expect(f.ptys.writeConfirmed).toHaveBeenCalledExactlyOnceWith(
      'session',
      1,
      bytes,
      1,
      'user',
    )
    expect(f.sessions.writeControl).not.toHaveBeenCalled()
  })
  it('retains A write settlement across independent B focus and later A view replacement', async () => {
    const f = fixture()
    const other = {
      ...f.state,
      handle: 'b-handle',
      session: {
        ...f.state.session,
        sessionId: 'b-session',
        instanceId: 'b-instance',
      },
    }
    f.sessions.get.mockImplementation((id) => (id === 'b-session' ? other : f.state))
    f.ptys.get.mockImplementation((id) =>
      id === 'b-session'
        ? {
            ...f.managed,
            id: 'b-session',
            instanceId: 'b-instance',
          }
        : f.managed,
    )
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    const transport = deferred<void>()
    f.ptys.writeConfirmed.mockReturnValueOnce(transport.promise)
    const oldA = watched(
      f.app.key('view', f.owner, {
        key: 0,
        modifiers: 0,
        action: 1,
        text: 'a',
      }),
    )
    await vi.waitFor(() => expect(f.ptys.writeConfirmed).toHaveBeenCalledOnce())
    f.presenter.attach.mockResolvedValueOnce('b-view')
    await f.app.attach('b-session', f.owner, f.frame)
    await f.app.update('b-view', f.owner, f.layout)
    await f.app.input('b-view', f.owner, { kind: 'focus', focused: true })
    await f.app.key('b-view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'b' })
    expect(f.ptys.writeConfirmed).toHaveBeenCalledTimes(2)
    f.presenter.attach.mockResolvedValueOnce('replacement-a')
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('replacement-a', f.owner, f.layout)
    const focusingA = watched(
      f.app.input('replacement-a', f.owner, { kind: 'focus', focused: true }),
    )
    try {
      await f.app.readRetained('b-session', f.owner)
      expect(
        f.host.input.mock.calls.filter(
          (call) => call[2].kind === 'focus' && call[2].focused,
        ),
      ).toHaveLength(2)
      // B can regain focus while A's transport remains unresolved. A's eventual
      // completion must not revoke this newer independent focus decision.
      await f.app.input('b-view', f.owner, { kind: 'focus', focused: true })
      await f.app.key('b-view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'c' })
    } finally {
      transport.resolve()
      await Promise.allSettled([oldA, focusingA])
    }
    await expect(oldA).rejects.toThrow('native-view-foreign')
    await expect(focusingA).rejects.toThrow('native-focus-stale')
    await f.app.input('replacement-a', f.owner, { kind: 'focus', focused: false })
    await f.app.key('b-view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'd' })
    expect(f.ptys.writeConfirmed).toHaveBeenCalledTimes(4)
    expect(f.sessions.blockInput).not.toHaveBeenCalled()
    await f.app.input('replacement-a', f.owner, { kind: 'focus', focused: true })
    await f.app.key('replacement-a', f.owner, {
      key: 0,
      modifiers: 0,
      action: 1,
      text: 'e',
    })
    expect(f.ptys.writeConfirmed).toHaveBeenCalledTimes(5)
  })

  it('keeps replacement focus behind a same-instance physical write after detach cleanup has finished', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    const transport = deferred<void>()
    f.ptys.writeConfirmed.mockReturnValueOnce(transport.promise)
    const oldWrite = watched(
      f.app.key('view', f.owner, {
        key: 0,
        modifiers: 0,
        action: 1,
        text: 'x',
      }),
    )
    await vi.waitFor(() => expect(f.ptys.writeConfirmed).toHaveBeenCalledOnce())
    f.presenter.attach.mockResolvedValueOnce('replacement')
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('replacement', f.owner, f.layout)
    expect(f.presenter.detach).toHaveBeenCalledWith('view')
    expect(
      f.host.input.mock.calls.some(
        (call) => call[2].kind === 'focus' && !call[2].focused,
      ),
    ).toBe(true)
    const focusing = watched(
      f.app.input('replacement', f.owner, { kind: 'focus', focused: true }),
    )
    try {
      const blockedKey = await f.app.input('replacement', f.owner, {
        kind: 'key',
        key: 0,
        modifiers: 0,
        consumedModifiers: 0,
        action: 1,
        text: 'y',
        unshiftedCodepoint: 0,
        composing: false,
        optionAsAlt: false,
      })
      expect(blockedKey).toEqual({ requestedMutation: 0, refused: 'capacity' })
      expect(
        f.host.input.mock.calls.filter(
          (call) => call[2].kind === 'focus' && call[2].focused,
        ),
      ).toHaveLength(1)
      expect(f.host.encodeKey).toHaveBeenCalledOnce()
      expect(f.ptys.writeConfirmed).toHaveBeenCalledOnce()
    } finally {
      transport.resolve()
      await Promise.allSettled([oldWrite, focusing])
    }
    await expect(oldWrite).rejects.toThrow('native-view-foreign')
    await expect(focusing).resolves.toMatchObject({ requestedMutation: 0 })
    await f.app.key('replacement', f.owner, {
      key: 0,
      modifiers: 0,
      action: 1,
      text: 'z',
    })
    expect(f.ptys.writeConfirmed).toHaveBeenCalledTimes(2)
    expect(f.sessions.blockInput).not.toHaveBeenCalled()
    expect(f.state.inputUnavailable).toBe(false)
  })

  it('blocks a fresh view of the same live instance after an indeterminate write while preserving readonly navigation', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    const transport = deferred<void>()
    f.ptys.writeConfirmed.mockReturnValueOnce(transport.promise)
    const oldWrite = watched(
      f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'x' }),
    )
    await vi.waitFor(() => expect(f.ptys.writeConfirmed).toHaveBeenCalledOnce())
    f.presenter.attach.mockResolvedValueOnce('replacement')
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('replacement', f.owner, f.layout)
    transport.reject(new Error('indeterminate-live-write'))
    await expect(oldWrite).rejects.toThrow('indeterminate-live-write')
    expect(f.sessions.blockInput).toHaveBeenCalledExactlyOnceWith('session', 'instance')
    await expect(
      f.app.key('replacement', f.owner, { key: 0, modifiers: 0, action: 1, text: 'y' }),
    ).rejects.toThrow('native-input-unavailable')
    await f.app.input('replacement', f.owner, {
      kind: 'wheel',
      x: 1,
      y: 2,
      deltaX: 0,
      deltaY: -1,
      precision: true,
      modifiers: 0,
    })
    expect(f.host.input.mock.lastCall?.[4]).toBe(true)
    expect(f.ptys.writeConfirmed).toHaveBeenCalledOnce()
    await expect(f.app.readRetained('session', f.owner)).resolves.toEqual(
      new Uint8Array(),
    )
    expect(f.sessions.remove).not.toHaveBeenCalled()
    expect(f.state.inputUnavailable).toBe(true)
  })

  it('does not poison the instance for a confirmed ACK followed by owner revocation', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    f.ptys.writeConfirmed.mockRejectedValueOnce(
      new PtyWriteConfirmedRevokedError('confirmed-old-owner'),
    )
    await expect(
      f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'x' }),
    ).rejects.toBeInstanceOf(PtyWriteConfirmedRevokedError)
    expect(f.sessions.blockInput).not.toHaveBeenCalled()
    expect(f.state.inputUnavailable).toBe(false)
    await f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'y' })
  })

  it('refuses known-closed input after encoding without marking the retained parser indeterminate', async () => {
    const f = fixture()
    await f.app.attach('session', f.owner, f.frame)
    await f.app.update('view', f.owner, f.layout)
    await f.app.input('view', f.owner, { kind: 'focus', focused: true })
    const encoded = deferred<Uint8Array<ArrayBuffer>>()
    f.host.encodeKey.mockReturnValueOnce(encoded.promise)
    const typing = watched(
      f.app.key('view', f.owner, { key: 0, modifiers: 0, action: 1, text: 'x' }),
    )
    await vi.waitFor(() => expect(f.host.encodeKey).toHaveBeenCalledOnce())
    f.state.inputClosed = true
    encoded.resolve(new Uint8Array([1]))
    await expect(typing).rejects.toThrow('native-session-readonly')
    expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
    expect(f.sessions.blockInput).not.toHaveBeenCalled()
    await expect(f.app.readRetained('session', f.owner)).resolves.toEqual(
      new Uint8Array(),
    )
  })
})
