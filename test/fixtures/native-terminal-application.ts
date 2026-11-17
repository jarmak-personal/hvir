import { vi } from 'vitest'
import type { WebFrameMain } from 'electron'
import type { NativeTerminalInputOperation } from '../../src/shared/native-terminal-input'
import type { NativeTerminalHost } from '../../src/main/terminal/native-terminal-host'
import { NativeTerminalApplication } from '../../src/main/terminal/native-terminal-application'
import { nativeTerminalStatus } from './native-terminal-host'
import { hostPath, LOCAL_HOST_ID } from '../../src/shared/host-path'

export function nativeTerminalApplicationFixture() {
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
    retiring: false,
    applicationRemoval: undefined as Promise<void> | undefined,
    inputSettlement: undefined as Promise<void> | undefined,
    title: undefined as { title: string; eventSerial: number } | undefined,
  }
  function currentSession(id: string, instance: string): typeof state {
    const record = sessions.get(id)
    if (!record || record.session.instanceId !== instance)
      throw new Error('native-session-instance-stale')
    return record
  }
  const sessions = {
    get: vi.fn((_id?: string): typeof state | undefined => state),
    resolve: vi.fn(() => session),
    prepare: vi.fn(),
    remove: vi.fn(() => Promise.resolve(undefined)),
    retire: vi.fn((id: string, instance: string, remove: () => Promise<void>) => {
      const record = sessions.get(id)
      if (!record || record.session.instanceId !== instance)
        return Promise.reject(new Error('native-session-instance-stale'))
      record.retiring = true
      record.applicationRemoval ??= Promise.resolve().then(remove)
      return record.applicationRemoval
    }),
    transferOwner: vi.fn(),
    blockInput: vi.fn(() => {
      state.inputUnavailable = true
    }),
    inputSettled: vi.fn(
      (id: string, instance: string) => currentSession(id, instance).inputSettlement,
    ),
    retainInput: vi.fn(
      (id: string, instance: string, pending: Promise<unknown>): void => {
        const record = currentSession(id, instance)
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
    controlApplied: vi.fn(() => Promise.resolve()),
  }
  const encodeKey = vi.fn((_operation?: NativeTerminalInputOperation) =>
    Promise.resolve(new Uint8Array([0, 128, 255])),
  )
  const host = {
    query: vi.fn(() => Promise.resolve({ result: 0 })),
    rendererInfo: vi.fn(),
    selection: vi.fn<NativeTerminalHost['selection']>(
      async (_handle, _instance, operation, signal, eligible) => {
        await eligible?.(signal ?? new AbortController().signal)
        if (operation.kind === 'close') return { result: 0 }
        if (operation.kind === 'next')
          return {
            cursor: operation.cursor,
            selectionSerial: 7,
            data: new TextEncoder().encode('selected'),
            done: true,
            visited: 8,
            work: 8,
          }
        return {
          hasSelection: true,
          selectionSerial: 7,
          screen: 0,
          geometrySerial: 1,
          requestedMutation: 0,
          ...(operation.kind === 'begin' ? { cursor: '19' } : {}),
        }
      },
    ),
    readLinkProducer: vi.fn<NativeTerminalHost['readLinkProducer']>(() =>
      Promise.resolve(undefined),
    ),
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
  const frameSend = vi.fn<WebFrameMain['send']>()
  const framePort: Pick<WebFrameMain, 'isDestroyed' | 'send'> = {
    isDestroyed: () => false,
    send: frameSend,
  }
  const frame = framePort as WebFrameMain
  const target = {
    frame,
    ready: true,
    isCurrent: () => true,
    onUnavailable: vi.fn(() => () => undefined),
    publishGrant: vi.fn(),
    publishStatus: vi.fn(),
    sendPixels: vi.fn(() => Promise.resolve(undefined)),
  }
  const targets = {
    create: vi.fn(() => target),
    dispose: vi.fn(),
    acknowledge: vi.fn(),
    drawn: vi.fn<
      (
        id: string,
        frame: WebFrameMain,
      ) =>
        | {
            screen: 0 | 1
            geometrySerial: number
            nativeEpoch: string
            attachment: number
          }
        | undefined
    >(() => ({
      screen: 0,
      geometrySerial: grant.geometrySerial,
      nativeEpoch: grant.nativeEpoch,
      attachment: grant.attachment,
    })),
  }
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
    withdraw: vi.fn(),
    appearance: vi.fn(() => Promise.resolve(false)),
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
  const appliedPrefix = (signal: AbortSignal) => {
    signal.throwIfAborted()
    return Promise.resolve()
  }
  const ptys = {
    get: vi.fn((_id?: string): typeof managed | undefined => managed),
    list: vi.fn(() => [managed]),
    observe: vi.fn((listener: () => void) => {
      observePtys = listener
      return stopObserving
    }),
    inputPrefix: vi.fn(() => ({
      parsed: appliedPrefix,
      replies: appliedPrefix,
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
    frameSend,
    owner,
    layout,
    grant,
    targets,
  }
}
