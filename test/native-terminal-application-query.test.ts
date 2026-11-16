import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebFrameMain } from 'electron'
import { NativeTerminalApplication } from '../src/main/terminal/native-terminal-application'
import { NativeTerminalSessions } from '../src/main/terminal/native-terminal-sessions'
import { NativeTerminalQuery } from '../src/main/terminal/native-terminal-query'
import type { NativeTerminalHost } from '../src/main/terminal/native-terminal-host'
import type { NativeTerminalEffectBatch } from '../src/shared/native-terminal-effects'
import { localPath } from '../src/shared/host-path'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'
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
const viewId = '00000000-0000-4000-8000-000000000001'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
const semantic = (serial = 5, token = '9'): NativeTerminalEffectBatch => ({
  effects: [
    {
      kind: 'semantic',
      action: 3,
      options: '',
      boundary: token,
      screen: 'normal',
      row: 0,
      column: 0,
      eventSerial: serial,
      sequence: 1,
    },
  ],
  droppedEffects: 0,
  semanticGeneration: 0,
})

/** Real Application/Query/Sessions; only their immediate Host/PTY/Electron ports are fake. */
async function fixture() {
  const owner = { id: 1, generation: 1 }
  const reservation = {
    sessionId: 'session',
    instanceId: 'instance',
    ownerId: 1,
    ownerGeneration: 1,
    workspaceRoot: localPath('/fixture'),
  }
  let managed: (typeof reservation & { id: string }) | undefined = {
    ...reservation,
    id: 'session',
  }
  let observer = () => undefined as void
  let endGate: ReturnType<typeof deferred<void>> | undefined
  let prefixGate: ReturnType<typeof deferred<void>> | undefined
  let screen: 0 | 1 = 0
  let cursor: { occurrence?: string; boundary?: string; reveal?: boolean } = {}
  const original = nativeTerminalStatus()
  let status = {
    ...original,
    geometry: { ...original.geometry, width: 32, height: 32, columns: 4, rows: 2 },
  }
  const executed: string[] = []
  const host = {
    prepare: vi.fn(() => Promise.resolve('handle')),
    appearanceProducer: () => Promise.resolve(status),
    resizeProducer: vi.fn(() => Promise.resolve(status)),
    feed: vi.fn(() => Promise.resolve()),
    drainReplies: vi.fn(() => Promise.resolve(new Uint8Array())),
    drainEffectsProducer: vi.fn(() =>
      Promise.resolve<NativeTerminalEffectBatch>({
        effects: [],
        droppedEffects: 0,
        semanticGeneration: 0,
      }),
    ),
    end: vi.fn(() => endGate?.promise ?? Promise.resolve()),
    inspectProducer: vi.fn(() => Promise.resolve(status)),
    rendererInfo: vi.fn(),
    readProducer: vi.fn(() => Promise.resolve(new Uint8Array())),
    readLinkProducer: vi.fn(() => Promise.resolve(undefined)),
    selection: vi.fn(() =>
      Promise.resolve({
        hasSelection: false,
        selectionSerial: 0,
        screen: 0,
        geometrySerial: 1,
        requestedMutation: 0,
      }),
    ),
    input: vi.fn(() =>
      Promise.resolve({
        bytes: new Uint8Array(),
        capacity: 0,
        requestedMutation: 0,
        source: 'terminal-response' as const,
      }),
    ),
    query: vi.fn<NativeTerminalHost['query']>(
      async (_handle, _instance, operation, signal, eligible) => {
        await eligible?.(signal ?? new AbortController().signal)
        executed.push(operation.kind)
        switch (operation.kind) {
          case 'query-context':
            return { screen, geometrySerial: status.geometry.serial }
          case 'query-begin':
            return { query: '101' }
          case 'query-step':
            return {
              query: operation.query,
              revision: '1',
              count: 2,
              status: 2,
              visited: 2,
              work: 2,
            }
          case 'query-page':
            return {
              revision: '1',
              count: 2,
              results: [{ occurrence: '103', index: operation.offset }],
            }
          case 'resolve-begin':
            cursor = { occurrence: operation.occurrence, reveal: operation.reveal }
            return { cursor: '203' }
          case 'boundary-resolve-begin':
            cursor = { boundary: operation.boundary, reveal: operation.reveal }
            return { cursor: '203' }
          case 'range-begin':
            cursor = {}
            return { cursor: '203' }
          case 'next':
            return {
              cursor: operation.cursor,
              selectionSerial: 0,
              data: new TextEncoder().encode('fixture🙂'),
              done: true,
              visited: 8,
              work: 8,
            }
          case 'finish':
            return {
              resolved: true,
              revealed: cursor.reveal === true,
              requestedMutation: 0,
              ...(cursor.occurrence
                ? { match: { occurrence: cursor.occurrence, index: 1 } }
                : {}),
              ...(cursor.boundary
                ? {
                    boundary: { boundary: cursor.boundary, screen: 0, row: 0, column: 0 },
                  }
                : {}),
            }
          default:
            return { result: 0 }
        }
      },
    ),
    dispose: vi.fn(),
  }
  const sessions: NativeTerminalSessions = new NativeTerminalSessions(
    host,
    () => true,
    (id, instance) => app.unavailable(id, instance),
    undefined,
    (session, handle, batch) => app.parsed(session, handle, batch),
  )
  const prepared = await sessions.prepare(reservation, new AbortController().signal, {
    width: 32,
    height: 32,
    backingScale: 1,
  })
  const writer = {
    live: true,
    parsed: vi.fn(),
    repliesDispatched: vi.fn(),
    writeReply: vi.fn(() => Promise.resolve()),
    writeControl: vi.fn(() => Promise.resolve()),
  }
  prepared.connect(writer)
  const send = vi.fn<WebFrameMain['send']>()
  const frame = { isDestroyed: () => false, send } as Pick<
    WebFrameMain,
    'isDestroyed' | 'send'
  > as WebFrameMain
  const presenter = {
    withdraw: vi.fn(),
    appearance: vi.fn(() => Promise.resolve(false)),
    attach: vi.fn(() => Promise.resolve(viewId)),
    update: vi.fn(() =>
      Promise.resolve({
        viewId,
        attachment: 1,
        nativeEpoch: 'epoch',
        geometrySerial: status.geometry.serial,
        width: 32,
        height: 32,
        backingScale: 1,
      }),
    ),
    detach: vi.fn(() => Promise.resolve()),
    suspend: vi.fn(() => Promise.resolve()),
    demand: vi.fn(() => Promise.resolve(true)),
    isInputCurrent: vi.fn(() => true),
  }
  const drawn = vi.fn<() => { screen: 0 | 1; geometrySerial: number } | undefined>(
    () => ({ screen: 0, geometrySerial: status.geometry.serial }),
  )
  const targets = { create: vi.fn(), dispose: vi.fn(), acknowledge: vi.fn(), drawn }
  const ptys = {
    get: vi.fn(() => managed),
    list: () => (managed ? [managed] : []),
    observe: (listener: () => void) => {
      observer = listener
      return () => undefined
    },
    resize: vi.fn(),
    writeConfirmed: vi.fn(() => Promise.resolve()),
    inputPolicy: () => ({
      composerSubmitMode: 'enter' as const,
      modifiedKeyProtocol: 'none' as const,
      metaEnterAliasesControl: false,
    }),
    inputPrefix: () => ({
      parsed: async (signal: AbortSignal) => {
        signal.throwIfAborted()
        await prefixGate?.promise
        signal.throwIfAborted()
      },
      replies: () => Promise.resolve(),
    }),
  }
  const current = vi.fn(() => true)
  const app: NativeTerminalApplication = new NativeTerminalApplication(
    sessions,
    host,
    presenter,
    targets,
    ptys,
    current,
  )
  await app.attach('session', owner, frame)
  const layout = { width: 32, height: 32, backingScale: 1, visible: true }
  await app.update(viewId, owner, layout)
  cleanups.push(async () => {
    endGate?.resolve()
    prefixGate?.resolve()
    await app.remove('session', 'instance').catch(() => undefined)
    app.dispose()
  })
  return {
    app,
    executed,
    host,
    sessions,
    prepared,
    writer,
    owner,
    frame,
    send,
    drawn,
    presenter,
    ptys,
    layout,
    current,
    contextScreen: (value: 0 | 1) => {
      screen = value
    },
    resized: () => {
      status = {
        ...status,
        geometry: { ...status.geometry, serial: status.geometry.serial + 1 },
      }
    },
    holdPrefix: () => (prefixGate = deferred<void>()),
    holdEnd: () => (endGate = deferred<void>()),
    transfer: () => {
      managed = { ...reservation, id: 'session', ownerId: 2, ownerGeneration: 2 }
      observer()
      return { id: 2, generation: 2 }
    },
    exit: async () => {
      managed = undefined
      writer.live = false
      await prepared.exited({ exitCode: 0, signal: undefined })
    },
    request: (kind: 'active-screen' | 'begin') =>
      app.query(
        kind === 'begin'
          ? {
              kind,
              viewId,
              requestId: randomUUID(),
              text: 'fixture',
              caseSensitive: true,
            }
          : { kind, viewId, requestId: randomUUID() },
        owner,
      ),
  }
}

describe('application retained-query authority and producer plumbing', () => {
  it('retains a physically applied clear through view revoke and drains only after its actual IO token before removal', async () => {
    const f = await fixture(),
      applied = deferred<ReturnType<typeof nativeTerminalStatus>>()
    const status = await f.host.inspectProducer()
    f.host.inspectProducer.mockImplementation(() => applied.promise)
    f.host.selection.mockImplementation(() =>
      Promise.resolve({
        hasSelection: false,
        selectionSerial: 0,
        screen: 0,
        geometrySerial: status.geometry.serial,
        requestedMutation: 9,
        effectSerialCutoff: 41,
      }),
    )
    f.host.inspectProducer.mockClear()
    const control = f.app.selection({ viewId, action: 'clear' }, f.owner)
    const rejected = expect(control).rejects.toThrow()
    await vi.waitFor(() => expect(f.host.inspectProducer).toHaveBeenCalled())
    const removal = f.app.remove('session', 'instance')
    expect(f.host.drainEffectsProducer).not.toHaveBeenCalled()
    expect(f.host.end).not.toHaveBeenCalled()
    applied.resolve({ ...status, ioAppliedMutation: 9 })
    await rejected
    await removal
    expect(f.host.drainEffectsProducer).toHaveBeenCalledOnce()
    expect(f.host.end).toHaveBeenCalledOnce()
    expect(f.host.drainEffectsProducer.mock.invocationCallOrder[0]).toBeLessThan(
      f.host.end.mock.invocationCallOrder[0]!,
    )
  })
  it('serializes control effects behind the existing output consumer instead of concurrently draining', async () => {
    const f = await fixture(),
      batch = deferred<NativeTerminalEffectBatch>()
    const status = await f.host.inspectProducer()
    f.host.inspectProducer.mockResolvedValue({ ...status, ioAppliedMutation: 9 })
    f.host.selection.mockImplementation(() =>
      Promise.resolve({
        hasSelection: false,
        selectionSerial: 0,
        screen: 0,
        geometrySerial: status.geometry.serial,
        requestedMutation: 9,
        effectSerialCutoff: 41,
      }),
    )
    f.host.drainEffectsProducer.mockImplementationOnce(() => batch.promise)
    const output = f.prepared.output('fixture')
    await vi.waitFor(() => expect(f.host.drainEffectsProducer).toHaveBeenCalledOnce())
    const control = f.app.selection({ viewId, action: 'reset' }, f.owner)
    await vi.waitFor(() => expect(f.host.selection).toHaveBeenCalledOnce())
    expect(f.host.drainEffectsProducer).toHaveBeenCalledOnce()
    batch.resolve({ effects: [], droppedEffects: 0, semanticGeneration: 0 })
    await Promise.all([output, control])
    expect(f.host.drainEffectsProducer).toHaveBeenCalledTimes(2)
    expect(
      (await f.app.metadata('session', f.owner)).semanticSnapshot?.throughSerial,
    ).toBe(41)
  })

  it('captures finite parsed-prefix eligibility and reads the actual current screen, independent of an old drawn screen', async () => {
    const f = await fixture()
    const prefix = f.holdPrefix()
    const begin = f.request('begin')
    void begin.catch(() => undefined)
    expect(f.executed.includes('query-begin')).toBe(false)
    prefix.resolve()
    const query = await begin
    expect(query.kind).toBe('query')
    f.contextScreen(1)
    expect(await f.request('active-screen')).toEqual({
      kind: 'screen',
      screen: 'alternate',
    })
    expect(f.drawn).not.toHaveBeenCalled()
    expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
  })

  it('retains query identity through acknowledged layout changes and requires an actual draw only for reveal', async () => {
    const f = await fixture()
    const started = await f.request('begin')
    if (started.kind !== 'query') throw new Error('query fixture missing')
    f.resized()
    await f.app.update(viewId, f.owner, f.layout)
    f.drawn.mockReturnValue(undefined)
    const request = {
      viewId,
      queryId: started.queryId,
      requestId: randomUUID(),
      occurrenceId: '103',
    }
    expect(await f.app.query({ ...request, kind: 'resolve' }, f.owner)).toEqual({
      kind: 'resolved',
      index: 1,
    })
    await expect(
      f.app.query({ ...request, requestId: randomUUID(), kind: 'reveal' }, f.owner),
    ).rejects.toThrow('native-query-not-drawn')
    expect(
      await f.app.query({ ...request, requestId: randomUUID(), kind: 'read' }, f.owner),
    ).toEqual({ kind: 'text', text: 'fixture🙂' })
    expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
  })

  it('publishes and bootstraps parser-origin semantics after physical input closes, while bell stays live-only', async () => {
    const f = await fixture()
    f.writer.live = false
    f.host.drainEffectsProducer.mockResolvedValueOnce(semantic())
    await f.prepared.output('fixed output')
    await f.exit()
    const metadata = await f.app.metadata('session', f.owner)
    expect(metadata.semanticSnapshot?.effects).toHaveLength(1)
    expect(metadata.semanticSnapshot?.effects[0]?.effect).toMatchObject({
      kind: 'semantic',
      options: '',
      screen: 'normal',
    })
    const parsed = f.sessions.resolve('session')!
    f.app.publishEffect(parsed, {
      id: 'session',
      instanceId: 'instance',
      eventSerial: 8,
      effect: { kind: 'bell' },
    })
    expect(
      f.send.mock.calls.filter(([channel]) => channel === 'native-terminal:effect'),
    ).toHaveLength(1)
    expect((await f.request('begin')).kind).toBe('query')
    expect(f.ptys.writeConfirmed).not.toHaveBeenCalled()
    expect(f.writer.writeReply).not.toHaveBeenCalled()
  })

  it('does not wait for native retirement before subsequent PTY output or owner transfer', async () => {
    const f = await fixture()
    f.host.drainEffectsProducer.mockResolvedValueOnce(semantic())
    await f.prepared.output('first')
    const retire = deferred<unknown>()
    const original = f.host.query.getMockImplementation()!
    f.host.query.mockImplementation((...args) =>
      args[2].kind === 'boundary-close' ? retire.promise : original(...args),
    )
    f.host.drainEffectsProducer.mockResolvedValueOnce({
      effects: [],
      droppedEffects: 1,
      semanticGeneration: 1,
    })
    const output = f.prepared.output('second')
    await vi.waitFor(() =>
      expect(
        f.host.query.mock.calls.some(([, , op]) => op.kind === 'boundary-close'),
      ).toBe(true),
    )
    await output // Physical close is still held.
    f.host.drainEffectsProducer.mockResolvedValueOnce(semantic(8, '10'))
    await f.prepared.output('third')
    const ownerB = f.transfer()
    retire.resolve({ result: 0 })
    expect(f.sessions.get('session')?.unavailable).toBe(false)
    expect(
      (await f.app.metadata('session', ownerB)).semanticSnapshot?.effects,
    ).toContainEqual(expect.objectContaining({ effect: { kind: 'semantic-gap' } }))
  })

  it('isolates failed semantic retirement from PTY output and retries the retained exact token on later output', async () => {
    const f = await fixture()
    f.host.drainEffectsProducer.mockResolvedValueOnce(semantic())
    await f.prepared.output('first')
    const retire = deferred<unknown>()
    const original = f.host.query.getMockImplementation()!
    f.host.query.mockImplementation((...args) =>
      args[2].kind === 'boundary-close' ? retire.promise : original(...args),
    )
    f.host.drainEffectsProducer.mockResolvedValueOnce({
      effects: [],
      droppedEffects: 1,
      semanticGeneration: 1,
    })
    const output = f.prepared.output('second')
    await output
    await vi.waitFor(() =>
      expect(
        f.host.query.mock.calls.some(([, , op]) => op.kind === 'boundary-close'),
      ).toBe(true),
    )
    retire.reject(new Error('actual native cleanup failure'))
    await vi.waitFor(() =>
      expect(
        f.send.mock.calls.some(
          ([, event]) =>
            (event as { effect?: { kind: string } }).effect?.kind === 'semantic-gap',
        ),
      ).toBe(true),
    )
    f.host.query.mockImplementation(original)
    await f.prepared.output('third')
    await vi.waitFor(() =>
      expect(
        f.host.query.mock.calls.filter(
          ([, , op]) => op.kind === 'boundary-close' && op.boundary === '9',
        ),
      ).toHaveLength(2),
    )
    expect(f.sessions.get('session')?.unavailable).toBe(false)
    expect(f.host.feed).toHaveBeenCalledTimes(3)
  })

  it('revokes semantic authority when metadata publication throws without poisoning the output drain', async () => {
    const f = await fixture()
    vi.spyOn(f.app, 'publishEffect').mockImplementationOnce(() => {
      throw new Error('metadata publication failed')
    })
    f.host.drainEffectsProducer.mockResolvedValueOnce(semantic())
    await f.prepared.output('first')
    expect(
      (await f.app.metadata('session', f.owner)).semanticSnapshot?.effects.every(
        (event) => event.effect.kind === 'semantic-gap',
      ),
    ).toBe(true)
    await f.prepared.output('second')
    expect(f.sessions.get('session')?.unavailable).toBe(false)
    expect(f.host.feed).toHaveBeenCalledTimes(2)
  })

  it('forgets Main boundary records only after confirmed physical Surface destruction', async () => {
    const f = await fixture()
    f.host.drainEffectsProducer.mockResolvedValueOnce(semantic())
    await f.prepared.output('first')
    const forget = vi.spyOn(NativeTerminalQuery.prototype, 'forgetDestroyed')
    const end = f.holdEnd()
    const removing = f.app.remove('session', 'instance')
    await vi.waitFor(() => expect(f.host.end).toHaveBeenCalledOnce())
    expect(forget).not.toHaveBeenCalled()
    end.resolve()
    await removing
    expect(forget).toHaveBeenCalledExactlyOnceWith('instance')
  })
})
