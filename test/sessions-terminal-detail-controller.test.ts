// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'

import {
  SessionsTerminalDetailController,
  type SessionsTerminalResolutionPort,
} from '../src/renderer/src/sessions/sessions-terminal-detail-controller'
import type {
  SessionsTerminalSurfaceLease,
  SessionsTerminalSurfacePort,
} from '../src/renderer/src/sessions/sessions-terminal-surface'
import {
  SESSIONS_PROJECTION_VERSION,
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsProjectHandle,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  sessionsWorkspaceQualifier,
  type SessionsProjectionRow,
  type SessionsProjectionSnapshot,
  type SessionsTerminalResolutionResponse,
} from '../src/shared'

describe('SessionsTerminalDetailController', () => {
  it('resolves exact opaque qualifiers, attaches one lease, and focuses only its current container', async () => {
    const pending = deferred<SessionsTerminalResolutionResponse>()
    const resolve = vi.fn(() => pending.promise)
    const lease = fakeLease()
    const acquire = vi.fn<SessionsTerminalSurfacePort['acquire']>(() => lease.value)
    const frames = fakeFrames()
    const controller = new SessionsTerminalDetailController(
      { resolve },
      { acquire },
      frames.value,
    )
    const current = snapshot(3, 7, row('terminal-1', 'pty-1'))
    const container = document.createElement('div')

    controller.open(current.rows[0]!, current, true)
    controller.setContainer(container)
    expect(controller.snapshot().status).toBe('resolving')
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      demandGeneration: 3,
      sourceRevision: 7,
      handle: 'terminal-1',
      projectId: 'project-opaque',
      workspaceId: 'workspace-opaque',
      workspaceQualifier: '2:0:0',
      livePty: {
        handle: 'pty-1',
        rendererOwnerId: 12,
        rendererGeneration: 4,
      },
    })

    pending.resolve(resolved(current.rows[0]!))
    await pending.promise
    await Promise.resolve()
    expect(acquire).toHaveBeenCalledExactlyOnceWith({
      handle: 'terminal-1',
      workspaceQualifier: '2:0:0',
      livePty: {
        handle: 'pty-1',
        rendererOwnerId: 12,
        rendererGeneration: 4,
      },
      demandGeneration: 3,
      projectionRevision: 3,
      sourceRevision: 7,
    })
    expect(lease.attach).toHaveBeenCalledExactlyOnceWith(container)
    expect(lease.focus).not.toHaveBeenCalled()
    frames.run()
    expect(lease.setVisible).toHaveBeenCalledExactlyOnceWith(container, true)
    expect(lease.focus).toHaveBeenCalledExactlyOnceWith(container)
    expect(controller.snapshot().status).toBe('ready')

    controller.close()
    expect(lease.setVisible).toHaveBeenLastCalledWith(container, false)
    expect(lease.release).toHaveBeenCalledOnce()
    expect(controller.snapshot()).toEqual({ status: 'inactive' })
  })

  it('renews freshness-only revisions without releasing, resolving, or refocusing the unchanged target', async () => {
    const firstLease = fakeLease()
    const secondLease = fakeLease()
    const resolve = vi
      .fn<SessionsTerminalResolutionPort['resolve']>()
      .mockResolvedValueOnce(resolved(row('terminal-1', 'pty-1')))
      .mockResolvedValueOnce(resolved(row('terminal-1', 'pty-2')))
    const acquire = vi
      .fn<SessionsTerminalSurfacePort['acquire']>()
      .mockReturnValueOnce(firstLease.value)
      .mockReturnValueOnce(secondLease.value)
    const frames = fakeFrames()
    const controller = new SessionsTerminalDetailController(
      { resolve },
      { acquire },
      frames.value,
    )
    const initial = snapshot(1, 4, row('terminal-1', 'pty-1'))
    controller.open(initial.rows[0]!, initial, true)
    await settle()

    const newer = { ...initial, revision: 2, sourceRevision: 6 }
    controller.synchronize(newer, true)
    expect(resolve).toHaveBeenCalledOnce()
    expect(firstLease.release).not.toHaveBeenCalled()
    expect(firstLease.renew).toHaveBeenCalledWith(
      expect.objectContaining({
        demandGeneration: 1,
        projectionRevision: 2,
        sourceRevision: 6,
      }),
    )
    expect(firstLease.attach).not.toHaveBeenCalled()
    expect(firstLease.setVisible).not.toHaveBeenCalled()
    expect(firstLease.focus).not.toHaveBeenCalled()

    const replaced = snapshot(3, 5, row('terminal-1', 'pty-2'))
    controller.synchronize(replaced, true)
    expect(firstLease.release).toHaveBeenCalledOnce()
    expect(controller.snapshot().status).toBe('resolving')
    await settle()
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(controller.snapshot().status).toBe('ready')
  })

  it('re-resolves an unchanged terminal when its Sessions demand generation changes', async () => {
    const firstLease = fakeLease()
    const secondLease = fakeLease()
    const resolve = vi
      .fn<SessionsTerminalResolutionPort['resolve']>()
      .mockResolvedValue(resolved(row('terminal-1', 'pty-1')))
    const acquire = vi
      .fn<SessionsTerminalSurfacePort['acquire']>()
      .mockReturnValueOnce(firstLease.value)
      .mockReturnValueOnce(secondLease.value)
    const controller = new SessionsTerminalDetailController(
      { resolve },
      { acquire },
      fakeFrames().value,
    )
    const initial = snapshot(1, 4, row('terminal-1', 'pty-1'))
    controller.open(initial.rows[0]!, initial, true)
    await settle()

    controller.synchronize(
      { ...initial, demandGeneration: 2, revision: 2, sourceRevision: 5 },
      true,
    )

    expect(firstLease.release).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledTimes(2)
    await settle()
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(controller.snapshot().status).toBe('ready')
  })

  it('releases on blur, rejects a late authorization, and revalidates a fresh demand on focus', async () => {
    const first = deferred<SessionsTerminalResolutionResponse>()
    const second = deferred<SessionsTerminalResolutionResponse>()
    const resolve = vi
      .fn<SessionsTerminalResolutionPort['resolve']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const lease = fakeLease()
    const controller = new SessionsTerminalDetailController(
      { resolve },
      { acquire: () => lease.value },
      fakeFrames().value,
    )
    const initial = snapshot(1, 2, row('terminal-1', 'pty-1'))
    controller.open(initial.rows[0]!, initial, true)
    controller.synchronize(
      {
        ...initial,
        status: 'inactive',
        demandGeneration: 0,
        sourceRevision: 0,
        rows: [],
      },
      false,
    )
    expect(controller.snapshot().status).toBe('paused')

    first.resolve(resolved(initial.rows[0]!))
    await settle()
    expect(lease.attach).not.toHaveBeenCalled()

    const reopened = snapshot(5, 9, row('terminal-1', 'pty-1'))
    controller.synchronize(reopened, true)
    second.resolve(resolved(reopened.rows[0]!))
    await settle()
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(controller.snapshot().status).toBe('ready')
  })

  it('fails closed when the runtime revokes the surface or the projected row stops qualifying', async () => {
    const lease = fakeLease()
    const resolution: SessionsTerminalResolutionPort = {
      resolve: (request) =>
        Promise.resolve({
          outcome: 'resolved',
          handle: request.handle,
          workspaceQualifier: request.workspaceQualifier,
          livePty: request.livePty!,
        }),
    }
    const controller = new SessionsTerminalDetailController(
      resolution,
      { acquire: () => lease.value },
      fakeFrames().value,
    )
    const initial = snapshot(1, 2, row('terminal-1', 'pty-1'))
    controller.open(initial.rows[0]!, initial, true)
    await settle()

    lease.revoke('terminal-unavailable')
    expect(controller.snapshot()).toMatchObject({
      status: 'unavailable',
      message: 'The live terminal ended or was replaced.',
    })

    controller.synchronize(
      {
        ...initial,
        revision: 2,
        rows: [{ ...initial.rows[0]!, lifecycle: 'stopped', livePty: undefined }],
      },
      true,
    )
    expect(controller.snapshot()).toMatchObject({
      status: 'unavailable',
      message: 'This session no longer has an exact live terminal available.',
    })
  })
})

function fakeLease() {
  const listeners = new Set<
    (
      reason:
        | 'terminal-unavailable'
        | 'connection-unavailable'
        | 'workspace-unavailable'
        | 'owner-disposed',
    ) => void
  >()
  const attach = vi.fn(() => true)
  const renew = vi.fn(() => true)
  const detach = vi.fn()
  const setVisible = vi.fn(() => true)
  const focus = vi.fn(() => true)
  const release = vi.fn()
  const value: SessionsTerminalSurfaceLease = {
    renew,
    attach,
    detach,
    setVisible,
    focus,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    release,
  }
  return {
    value,
    renew,
    attach,
    detach,
    setVisible,
    focus,
    release,
    revoke: (
      reason:
        | 'terminal-unavailable'
        | 'connection-unavailable'
        | 'workspace-unavailable'
        | 'owner-disposed',
    ) => {
      for (const listener of listeners) listener(reason)
    },
  }
}

function fakeFrames() {
  let callback: FrameRequestCallback | undefined
  return {
    value: {
      requestAnimationFrame: vi.fn((next: FrameRequestCallback) => {
        callback = next
        return 1
      }),
      cancelAnimationFrame: vi.fn(() => {
        callback = undefined
      }),
    },
    run: () => {
      const current = callback
      callback = undefined
      current?.(0)
    },
  }
}

function snapshot(
  revision: number,
  sourceRevision: number,
  projected: SessionsProjectionRow,
): SessionsProjectionSnapshot {
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration: revision,
    revision,
    sourceRevision,
    status: 'available',
    rows: [projected],
  }
}

function row(id: string, pty: string): SessionsProjectionRow {
  const unsupported = { status: 'unsupported' as const }
  return {
    handle: asSessionsTerminalHandle(id),
    project: { id: asSessionsProjectHandle('project-opaque'), name: 'Project' },
    workspace: {
      id: asSessionsWorkspaceHandle('workspace-opaque'),
      name: 'main',
      main: true,
      qualifier: sessionsWorkspaceQualifier(2, 0, 0),
    },
    host: {
      id: 'local',
      label: 'Local',
      kind: 'local',
      connectionState: 'connected',
    },
    provider: {
      id: asHarnessProviderId('plain-shell'),
      name: 'Shell',
      kind: 'shell',
    },
    profile: {
      status: 'available',
      value: { id: asHarnessProfileId('plain-shell-default') },
    },
    title: 'Exact shell',
    lifecycle: 'live',
    connectionState: 'connected',
    attention: { status: 'available', value: 'none' },
    working: { status: 'available', value: false },
    model: unsupported,
    context: unsupported,
    turn: unsupported,
    telemetryFreshness: unsupported,
    usage: { status: 'unsupported' },
    livePty: {
      handle: asSessionsPtyHandle(pty),
      rendererOwnerId: 12,
      rendererGeneration: 4,
    },
  }
}

function resolved(row: SessionsProjectionRow): SessionsTerminalResolutionResponse {
  return {
    outcome: 'resolved',
    handle: row.handle,
    workspaceQualifier: row.workspace.qualifier,
    livePty: row.livePty!,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
