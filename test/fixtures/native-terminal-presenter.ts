import type { WebFrameMain } from 'electron'
import type {
  NativeTerminalPixelFrame,
  NativeTerminalViewGrant,
} from '../../src/shared/native-terminal-presentation'
import { vi } from 'vitest'
import { localPath } from '../../src/shared/host-path'
import type {
  NativeTerminalSession,
  NativeTerminalStatus,
} from '../../src/shared/native-terminal'
import {
  NativeTerminalPresenter,
  type NativeTerminalPresentationTarget,
} from '../../src/main/terminal/native-terminal-presenter'
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (value: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
export function nativeTerminalPresenterFixture(linuxMode?: 'auto' | 'pixels') {
  let serial = 1,
    attachment = 0,
    width = 64,
    height = 32,
    backingScale = 1
  const live = {
    current: true,
    dead: false,
    epoch: '11111111-1111-4111-8111-111111111111',
  }
  const session: NativeTerminalSession = {
    sessionId: 'session',
    instanceId: 'instance',
    ownerId: 1,
    ownerGeneration: 1,
    workspaceRoot: localPath('/project'),
  }
  const status = (): NativeTerminalStatus => ({
    ioAppliedSequence: 0,
    ioAppliedMutation: 0,
    inputFailure: 0,
    appliedSequence: 1,
    replySequence: 0,
    queuedReplyBytes: 0,
    failure: 0,
    closing: false,
    rendererHealth: 0,
    presentationFailure: 0,
    frameCopies: 0,
    geometryFailureSerial: 0,
    geometry: {
      serial,
      width,
      height,
      backingScale,
      columns: 8,
      rows: 2,
      cellWidth: 8,
      cellHeight: 16,
      contentWidth: width,
      contentHeight: height,
      paddingLeft: 0,
      paddingTop: 0,
    },
  })
  const sources: ReturnType<typeof source>[] = []
  function source() {
    return {
      metadata: {
        lease: '1',
        snapshotMutation: 0,
        screen: 0 as const,
        streamSequence: 1,
        geometrySerial: serial,
        kind: 1,
        width,
        height,
        colorSpace: 2,
        origin: 1,
        premultiplied: true,
        resource: { fourcc: 0x42475241, modifier: '0', planes: [] },
      },
      assertCurrent: vi.fn(),
      transfer: vi.fn(() => Promise.resolve()),
      release: vi.fn(() => Promise.resolve()),
      copyPixels: vi.fn(() =>
        Promise.resolve({ bytes: new Uint8Array(width * height * 4), stride: width * 4 }),
      ),
    }
  }
  const host = {
    attach: vi.fn(() => ++attachment),
    detach: vi.fn(),
    nativeEpoch: vi.fn(() => live.epoch),
    inspect: vi.fn(() => Promise.resolve(status())),
    resize: vi.fn(
      (
        _handle: string,
        _owner: number,
        _generation: number,
        _attachment: number,
        next: number,
        w: number,
        h: number,
        scale: number = 1,
      ) => {
        serial = next
        width = w
        height = h
        backingScale = scale
        return Promise.resolve(status())
      },
    ),
    setVisible: vi.fn(
      (
        _handle: string,
        _owner: number,
        _generation: number,
        _attachment: number,
        _visible: boolean,
      ) => Promise.resolve(),
    ),
    presentationMode: vi.fn(() => Promise.resolve()),
    takeFrame: vi.fn((): Promise<ReturnType<typeof source> | undefined> => {
      const value = source()
      sources.push(value)
      return Promise.resolve(value)
    }),
  }
  const consumed = deferred<void>()
  const imported = {
    metadata: { ...source().metadata, ticket: 'ticket' },
    send: vi.fn(() => Promise.resolve()),
    release: vi.fn(),
    released: consumed.promise,
  }
  const imports = { acquire: vi.fn(() => Promise.resolve(imported)) }
  const unavailableCallbacks: ((grant: NativeTerminalViewGrant) => void)[] = []
  const unbindUnavailable = vi.fn()
  const target = {
    onUnavailable: vi.fn((callback: (grant: NativeTerminalViewGrant) => void) => {
      unavailableCallbacks.push(callback)
      return unbindUnavailable
    }),
    frame: { isDestroyed: () => live.dead } as WebFrameMain,
    ready: true,
    isCurrent: () => live.current,
    publishGrant: vi.fn(),
    publishStatus: vi.fn(),
    sendPixels: vi.fn((_frame: NativeTerminalPixelFrame) => Promise.resolve()),
  } satisfies NativeTerminalPresentationTarget
  const owner = new NativeTerminalPresenter(host, imports, linuxMode)
  return {
    owner,
    host,
    imports,
    imported,
    consumed,
    sources,
    target,
    unavailableCallbacks,
    unbindUnavailable,
    live,
    session,
    source,
    status,
  }
}
