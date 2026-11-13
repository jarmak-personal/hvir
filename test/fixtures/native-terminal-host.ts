import { vi } from 'vitest'
import { hostPath, LOCAL_HOST_ID } from '../../src/shared/host-path'
import type {
  NativeTerminalCommand,
  NativeTerminalSession,
  NativeTerminalStatus,
} from '../../src/shared/native-terminal'
import { NativeTerminalHost } from '../../src/main/terminal/native-terminal-host'

/** Actual main authority backed only by its immediate native process port.
 * This fixture makes no Ghostty/GPU or cross-process execution claim. */
export function nativeTerminalStatus(serial = 1): NativeTerminalStatus {
  return {
    appliedSequence: 0,
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
      backingScale: 1,
      columns: 4,
      rows: 4,
      width: 32,
      height: 32,
      cellWidth: 8,
      cellHeight: 8,
      contentWidth: 32,
      contentHeight: 32,
      paddingLeft: 0,
      paddingTop: 0,
    },
  }
}
export function nativeTerminalHostFixture(exitEvidence?: (epoch: string) => boolean) {
  const sessions = new Map<string, NativeTerminalSession>()
  const live = {
    renderer: true,
    owner: 1,
    generation: 1,
    available: true,
    status: nativeTerminalStatus(),
  }
  let nextState = 0
  let nextLease = 0
  const held = new Set<string>()
  const request = vi.fn(
    (command: NativeTerminalCommand, _signal?: AbortSignal): Promise<unknown> => {
      switch (command.kind) {
        case 'create':
          return Promise.resolve({
            state: String(++nextState),
            status: nativeTerminalStatus(),
          })
        case 'inspect':
          return Promise.resolve(live.status)
        case 'read':
          return Promise.resolve(new Uint8Array([1]))
        case 'frame':
          held.add(command.state)
          return Promise.resolve({
            lease: String(++nextLease),
            streamSequence: 0,
            geometrySerial: 1,
            kind: 1,
            width: 32,
            height: 32,
            colorSpace: 2,
            origin: 1,
            premultiplied: true,
          })
        case 'release':
          held.delete(command.state)
          return Promise.resolve({ result: 0 })
        case 'destroy':
          return Promise.resolve({ result: held.has(command.state) ? 6 : 0 })
        default:
          return Promise.resolve({ result: 0 })
      }
    },
  )
  const process = {
    epoch: 'host-1',
    ...(exitEvidence ? { hasExited: vi.fn(exitEvidence) } : {}),
    get available() {
      return live.available
    },
    request,
    idle: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => {
      live.available = false
    }),
  }
  const authority = {
    resolve: (id: string) => sessions.get(id),
    isRendererCurrent: (owner: number, generation: number) =>
      live.renderer && owner === live.owner && generation === live.generation,
  }
  const session = (id = 0): NativeTerminalSession => {
    const value = {
      sessionId: `session-${id}`,
      instanceId: `instance-${id}`,
      ownerId: live.owner,
      ownerGeneration: live.generation,
      workspaceRoot: hostPath(LOCAL_HOST_ID, '/native-proof'),
    }
    sessions.set(value.sessionId, value)
    return value
  }
  return {
    host: new NativeTerminalHost(process, authority),
    process,
    request,
    sessions,
    live,
    session,
  }
}
