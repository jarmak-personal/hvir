import { describe, expect, it, vi } from 'vitest'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'
import {
  boundedExtensionSessions,
  boundedExtensionContext,
} from '../src/main/extensions/context-owner'
import { localPath } from '../src/shared/host-path'
import { contextFixture } from './fixtures/extension-context'

describe('extension metadata from existing context owners', () => {
  it('resolves an exact live shell independently of Sessions observation and rejects foreign renderer or stale targets', () => {
    const data = contextFixture(),
      owner = { id: 1, generation: 1 }
    expect(data.contexts.sessions(owner)).toEqual([
      {
        id: data.contexts.sessions(owner)[0]!.id,
        title: 'Ordinary shell',
        workspace: { id: 'workspace', name: 'Workspace', host: 'local', root: data.root },
      },
    ])
    expect(data.contexts.sessions({ ...owner, generation: 2 })).toEqual([])
    expect(() =>
      data.contexts.admit(owner, { surface: 'popup', sessionId: 'terminal-1' }),
    ).toThrow('stale')
    expect(() =>
      data.contexts.admit(owner, {
        surface: 'popup',
        sessionId: data.contexts.sessions({ id: 2, generation: 1 })[0]!.id,
      }),
    ).toThrow('stale')
  })
  it.each(['close', 'disconnect', 'exit', 'move'] as const)(
    'pins old session context through %s without following replacement',
    (kind) => {
      const data = contextFixture()
      const admitted = data.contexts.admit(
        { id: 1, generation: 1 },
        {
          surface: 'viewer',
          workspaceId: 'workspace',
          sessionId: data.contexts.sessions({ id: 1, generation: 1 })[0]!.id,
        },
      )
      expect(admitted.current()).toBe(true)
      data.change(kind)
      expect(admitted.current()).toBe(false)
      expect(
        data.contexts.admit({ id: 1, generation: 1 }, { surface: 'top' }).current(),
      ).toBe(true)
    },
  )
  it('subscribes to relevant project, registry, and live PTY changes and releases every source', async () => {
    const data = contextFixture(),
      listener = vi.fn()
    const dispose = data.contexts.observe(listener)
    data.change('title')
    await Promise.resolve()
    data.change('exit')
    await Promise.resolve()
    data.change('close')
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(3)
    dispose()
    expect(data.listeners.flat()).toHaveLength(0)
  })
  it('ignores telemetry-only publications and coalesces actual metadata changes', async () => {
    const data = contextFixture(),
      listener = vi.fn()
    const dispose = data.contexts.observe(listener)
    for (let index = 0; index < 40; index++)
      for (const callback of data.listeners[2]!) callback()
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
    data.change('title')
    data.change('exit')
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(data.contexts.revision).toBe(1)
    data.change('close')
    dispose()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
  })
  it('observes main selection and registration identity without withdrawing ordinary admitted contexts', async () => {
    const data = contextFixture(),
      listener = vi.fn()
    const admitted = data.contexts.admit(
      { id: 1, generation: 1 },
      { surface: 'left', workspaceId: 'workspace' },
    )
    const state = data.sources.projectState()
    let current = state
    vi.spyOn(data.sources, 'projectState').mockImplementation(() => current)
    const dispose = data.contexts.observe(listener)
    try {
      current = {
        ...state,
        activeProjectId: 'other-project',
        activeWorkspaceId: 'other-workspace',
      }
      for (const changed of data.listeners[0]!) changed()
      await Promise.resolve()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(admitted.current()).toBe(true)
      current = {
        ...current,
        projects: state.projects.map((project) => ({
          ...project,
          registeredRoot: localPath('/replacement'),
        })),
      }
      for (const changed of data.listeners[0]!) changed()
      await Promise.resolve()
      expect(listener).toHaveBeenCalledTimes(2)
      expect(admitted.current()).toBe(true)
    } finally {
      dispose()
    }
    expect(data.listeners.flat()).toHaveLength(0)
  })
  it('bounds qualified metadata by encoded bytes even below the session count limit', () => {
    const source = contextFixture().contexts.sessions({ id: 1, generation: 1 })[0]!
    const sessions = Array.from(
      { length: EXTENSION_LIMITS.sessions + 1 },
      (_, index) => ({
        ...source,
        id: `instance-${index}`,
        title: '界'.repeat(160),
      }),
    )
    const admitted = boundedExtensionSessions(sessions)
    expect(admitted.length).toBeGreaterThan(0)
    expect(admitted.length).toBeLessThan(EXTENSION_LIMITS.sessions)
    expect(Buffer.byteLength(JSON.stringify(admitted))).toBeLessThanOrEqual(
      EXTENSION_LIMITS.contextBytes - 128,
    )
    expect(admitted).toEqual(sessions.slice(0, admitted.length))
    expect(
      Buffer.byteLength(JSON.stringify([...admitted, sessions[admitted.length]])),
    ).toBeGreaterThan(EXTENSION_LIMITS.contextBytes - 128)
  })
})

it('bounds initial input plus repeated long workspace roots without changing identities or grant roots', () => {
  const root = { ...contextFixture().root, path: `/${'x'.repeat(4096)}` }
  const workspace = { id: 'workspace', name: 'Workspace', host: 'local', root }
  const value = boundedExtensionContext({
    surface: 'viewer',
    visible: true,
    workspace,
    session: { id: 'session', title: 'Terminal', workspace },
    input: { exact: 'x'.repeat(6120) },
  })
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(
    EXTENSION_LIMITS.contextBytes,
  )
  expect(value.input).toEqual({ exact: 'x'.repeat(6120) })
  expect(value.workspace?.id).toBe('workspace')
  expect(value.session?.id).toBe('session')
  expect(value.workspace?.root).toBeUndefined()
  expect(value.session?.workspace.root).toBeUndefined()
  const sessions = boundedExtensionSessions(
    Array.from({ length: 128 }, (_, index) => ({
      id: `session-${index}`,
      title: 'Terminal',
      workspace,
    })),
  )
  expect(
    Buffer.byteLength(JSON.stringify({ surface: 'updater', visible: true, sessions })),
  ).toBeLessThanOrEqual(EXTENSION_LIMITS.contextBytes)
  expect(sessions.length).toBeGreaterThan(0)
  expect(sessions.length).toBeLessThan(128)
})
