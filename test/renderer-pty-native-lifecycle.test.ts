import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { localPath } from '../src/shared'
import type { NativeTerminalSession } from '../src/shared/native-terminal'
import type { ManagedPty, PtyStreamHandlers } from '../src/main/pty/pty-contract'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import {
  attachRendererPty,
  registerRendererPty,
} from '../src/main/terminal/renderer-pty-lifecycle'

/** Production lifetime policy and resource registry; only immediate PTY/native
 * and Electron delivery ports are replaced. No process or native-ABI claim. */
function fixture(native: boolean) {
  const resources = new RendererResourceScopes()
  const owner = resources.activateOwner(7)
  const root = localPath('/project')
  let managed: ManagedPty | undefined = {
    id: 'terminal',
    instanceId: 'instance',
    ownerId: owner.id,
    ownerGeneration: owner.generation,
    hostId: root.hostId,
    workspaceRoot: root,
    cwd: root,
  } as ManagedPty
  let record: { session: NativeTerminalSession; readonly: boolean } | undefined = native
    ? {
        session: {
          sessionId: 'terminal',
          instanceId: 'instance',
          ownerId: owner.id,
          ownerGeneration: owner.generation,
          workspaceRoot: root,
        },
        readonly: false,
      }
    : undefined
  let stream: PtyStreamHandlers | undefined
  const detached = vi.fn()
  const supervisor = {
    attach: vi.fn((_id: string, _owner: number, handlers: PtyStreamHandlers) => {
      stream = handlers
      return detached
    }),
    get: vi.fn(() => managed),
    disposeSession: vi.fn(() => {
      managed = undefined
    }),
    transferRendererSession: vi.fn(
      (
        id: string,
        fromId: number,
        fromGeneration: number,
        toId: number,
        toGeneration: number,
      ) => {
        if (
          !managed ||
          managed.id !== id ||
          managed.ownerId !== fromId ||
          managed.ownerGeneration !== fromGeneration
        )
          return false
        managed = { ...managed, ownerId: toId, ownerGeneration: toGeneration }
        return true
      },
    ),
  }
  const nativeApplication = {
    sessions: {
      get: vi.fn(() => record),
      transferOwner: vi.fn(
        (
          id: string,
          instance: string,
          ownerId: number,
          ownerGeneration: number,
          workspaceRoot: NativeTerminalSession['workspaceRoot'],
        ) => {
          if (
            !record ||
            id !== record.session.sessionId ||
            instance !== record.session.instanceId
          )
            throw new Error('stale native instance')
          record = {
            ...record,
            session: { ...record.session, ownerId, ownerGeneration, workspaceRoot },
          }
        },
      ),
    },
    remove: vi.fn((_id: string, _instance: string) => {
      record = undefined
      return Promise.resolve()
    }),
  }
  const deps = {
    rendererResources: resources,
    ptySupervisor: supervisor,
    nativeTerminals: native ? nativeApplication : undefined,
  } as unknown as Parameters<typeof registerRendererPty>[0]
  const sender = {
    isDestroyed: () => false,
    mainFrame: { isDestroyed: () => false, postMessage: vi.fn() },
  }
  const lease = registerRendererPty(deps, owner, root, 'terminal')
  attachRendererPty(deps, managed, lease, owner, sender as unknown as WebContents)
  const exit = () => {
    managed = undefined
    if (record) record = { ...record, readonly: true }
    stream?.onExit?.({ exitCode: 0, signal: undefined })
  }
  return {
    resources,
    owner,
    root,
    supervisor,
    nativeApplication,
    lease,
    exit,
    sender,
    detached,
    managed: () => managed,
    record: () => record,
    exitWithNativeTailPending: () => {
      managed = undefined
    },
    failNative: () => {
      if (record) record = { ...record, readonly: true }
    },
    moveNative: (workspaceRoot: NativeTerminalSession['workspaceRoot']) => {
      if (record) record = { ...record, session: { ...record.session, workspaceRoot } }
    },
  }
}

describe('renderer PTY resource lifetime with retained native state', () => {
  it('retains the lease after natural native exit until exact instance cleanup on owner close', async () => {
    const f = fixture(true)
    f.exit()
    expect(f.detached).toHaveBeenCalledTimes(1)
    expect(f.sender.mainFrame.postMessage).toHaveBeenCalledWith('pty:exit', {
      id: 'terminal',
      exitCode: 0,
      signal: undefined,
    })
    expect(f.record()?.readonly).toBe(true)
    expect(f.nativeApplication.remove).not.toHaveBeenCalled()
    await f.resources.revokeOwner(f.owner.id)
    expect(f.supervisor.disposeSession).toHaveBeenCalledExactlyOnceWith('terminal', 7, 1)
    expect(f.nativeApplication.remove).toHaveBeenCalledExactlyOnceWith(
      'terminal',
      'instance',
    )
    expect(f.record()).toBeUndefined()
    await f.lease.dispose()
    expect(f.nativeApplication.remove).toHaveBeenCalledTimes(1)
  })

  it('keeps the web exit path released without a later supervisor disposal', async () => {
    const f = fixture(false)
    f.exit()
    await f.resources.revokeOwner(f.owner.id)
    expect(f.supervisor.disposeSession).not.toHaveBeenCalled()
    expect(f.nativeApplication.remove).not.toHaveBeenCalled()
  })

  it('transfers exited readonly native history without a live supervisor session', async () => {
    const f = fixture(true)
    f.exit()
    const rollover = f.resources.rolloverOwner(f.owner.id)
    await rollover.cleanup
    expect(f.supervisor.transferRendererSession).toHaveBeenCalledExactlyOnceWith(
      'terminal',
      7,
      1,
      7,
      2,
    )
    expect(f.nativeApplication.sessions.transferOwner).toHaveBeenCalledExactlyOnceWith(
      'terminal',
      'instance',
      7,
      2,
      f.root,
    )
    expect(f.record()?.session.ownerGeneration).toBe(2)
    expect(f.nativeApplication.remove).not.toHaveBeenCalled()
    await f.resources.revokeOwner(7)
    expect(f.supervisor.disposeSession).toHaveBeenCalledExactlyOnceWith('terminal', 7, 2)
    expect(f.record()).toBeUndefined()
  })

  it('transfers retained native authority while final admitted output is still draining after PTY exit', async () => {
    const f = fixture(true)
    f.exitWithNativeTailPending()
    expect(f.managed()).toBeUndefined()
    expect(f.record()?.readonly).toBe(false)
    const rollover = f.resources.rolloverOwner(7)
    await rollover.cleanup
    expect(f.nativeApplication.sessions.transferOwner).toHaveBeenCalledExactlyOnceWith(
      'terminal',
      'instance',
      7,
      2,
      f.root,
    )
    expect(f.record()?.session.ownerGeneration).toBe(2)
    expect(f.supervisor.disposeSession).not.toHaveBeenCalled()
    expect(f.nativeApplication.remove).not.toHaveBeenCalled()
    await f.resources.revokeOwner(7)
    expect(f.nativeApplication.remove).toHaveBeenCalledExactlyOnceWith(
      'terminal',
      'instance',
    )
  })

  it('transfers the live PTY first even when failed native presentation is readonly', async () => {
    const f = fixture(true)
    f.failNative()
    expect(f.record()?.readonly).toBe(true)
    expect(f.managed()).toBeDefined()
    const rollover = f.resources.rolloverOwner(7)
    await rollover.cleanup
    expect(f.supervisor.transferRendererSession).toHaveBeenCalledExactlyOnceWith(
      'terminal',
      7,
      1,
      7,
      2,
    )
    expect(f.managed()?.ownerGeneration).toBe(2)
    expect(f.record()?.session.ownerGeneration).toBe(2)
    expect(f.supervisor.transferRendererSession.mock.invocationCallOrder[0]).toBeLessThan(
      f.nativeApplication.sessions.transferOwner.mock.invocationCallOrder[0]!,
    )
    expect(f.nativeApplication.remove).not.toHaveBeenCalled()
    await f.resources.revokeOwner(7)
    expect(f.supervisor.disposeSession).toHaveBeenCalledExactlyOnceWith('terminal', 7, 2)
  })

  it('cleans exited native history when its workspace closes', async () => {
    const f = fixture(true)
    f.exit()
    await f.resources.revokeWorkspace(f.root)
    expect(f.nativeApplication.remove).toHaveBeenCalledExactlyOnceWith(
      'terminal',
      'instance',
    )
    expect(f.record()).toBeUndefined()
    await f.resources.revokeOwner(7)
    expect(f.nativeApplication.remove).toHaveBeenCalledTimes(1)
  })

  it('preserves the current workspace across readonly rollover and closes only with that workspace', async () => {
    const f = fixture(true)
    const moved = localPath('/project-feature')
    f.resources.reassignWorkspaceResource(
      f.owner,
      'pty-session',
      'terminal',
      f.root,
      moved,
    )
    f.moveNative(moved)
    f.exit()
    const rollover = f.resources.rolloverOwner(7)
    await rollover.cleanup
    expect(f.nativeApplication.sessions.transferOwner).toHaveBeenCalledExactlyOnceWith(
      'terminal',
      'instance',
      7,
      2,
      moved,
    )
    await f.resources.revokeWorkspace(f.root)
    expect(f.nativeApplication.remove).not.toHaveBeenCalled()
    await f.resources.revokeWorkspace(moved)
    expect(f.nativeApplication.remove).toHaveBeenCalledExactlyOnceWith(
      'terminal',
      'instance',
    )
  })
})
