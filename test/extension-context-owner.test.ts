import { describe, expect, it, vi } from 'vitest'
import { EXTENSION_LIMITS } from '../src/shared/extensions/contract'
import { boundedExtensionSessions } from '../src/main/extensions/context-owner'
import { contextFixture } from './fixtures/extension-context'

describe('extension metadata from existing context owners', () => {
  it('resolves an exact live shell independently of Sessions observation and rejects foreign renderer or stale targets', () => {
    const data = contextFixture(),
      owner = { id: 1, generation: 1 }
    expect(data.contexts.sessions(owner)).toEqual([
      {
        id: data.contexts.sessions(owner)[0]!.id,
        title: 'Ordinary shell',
        workspace: { id: 'workspace', name: 'Workspace', host: 'local' },
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
  it('subscribes to project, registry, and live PTY changes and releases every source', () => {
    const data = contextFixture(),
      listener = vi.fn()
    const dispose = data.contexts.observe(listener)
    data.change('title')
    data.change('exit')
    data.change('close')
    expect(listener).toHaveBeenCalledTimes(3)
    dispose()
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
