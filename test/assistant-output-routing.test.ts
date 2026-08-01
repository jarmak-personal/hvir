import { describe, expect, it, vi } from 'vitest'

import type {
  HarnessAssistantOutputRuntime,
  HarnessProvider,
} from '../src/main/harness/harness-provider'
import {
  LOCAL_HOST_ID,
  asHarnessProviderId,
  type AssistantOutputEvent,
} from '../src/shared'
import {
  createPtySupervisorFixture,
  PTY_FIXTURE_OWNER_ID,
  plainShellProvider,
} from './fixtures/pty-supervisor-fixture'

class TestAssistantOutputRuntime implements HarnessAssistantOutputRuntime {
  readonly launchSpec = { file: 'codex', args: ['--remote', 'unix:///tmp/test'] }
  readonly listeners = new Set<(event: AssistantOutputEvent) => void>()
  readonly setMode = vi.fn<(enabled: boolean) => Promise<boolean>>(() =>
    Promise.resolve(true),
  )
  readonly admitSession = vi.fn<(sessionId: string) => boolean>(() => true)
  readonly revoke = vi.fn()
  readonly dispose = vi.fn()

  observe(cb: (event: AssistantOutputEvent) => void): () => void {
    this.listeners.add(cb)
    cb({
      kind: 'availability',
      state: 'available',
      hostId: LOCAL_HOST_ID,
      providerId: asHarnessProviderId('codex'),
      generation: 1,
    })
    return () => {
      this.listeners.delete(cb)
    }
  }

  emit(event: AssistantOutputEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function fixture() {
  const runtime = new TestAssistantOutputRuntime()
  const provider: HarnessProvider = {
    ...plainShellProvider,
    manifest: {
      id: asHarnessProviderId('codex'),
      displayName: 'Codex',
      contextPresentation: 'pressure',
    },
    supportsResume: true,
    sessionIdentity: 'preassigned',
    assistantOutput: {
      prepare: vi.fn(() => Promise.resolve(runtime)),
    },
    launch: () => ({ file: 'codex', args: [] }),
    resume: () => ({ file: 'codex', args: ['resume'] }),
  }
  return {
    runtime,
    harness: createPtySupervisorFixture({ provider }),
  }
}

function output(
  kind: 'start' | 'delta' | 'end',
  order: number,
  extra: Record<string, unknown> = {},
): AssistantOutputEvent {
  return {
    kind,
    hostId: LOCAL_HOST_ID,
    providerId: asHarnessProviderId('codex'),
    generation: 1,
    sessionId: 'fixture-session',
    turnId: 'turn-1',
    messageId: 'message-1',
    order,
    ...(kind === 'delta' ? { text: 'body' } : {}),
    ...extra,
  } as AssistantOutputEvent
}

describe('PTY assistant-output ownership', () => {
  it('lets the provider admit its runtime when the launch-menu probe was absent', async () => {
    const { harness } = fixture()
    const managed = await harness.spawn({
      effectiveCapabilities: {
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'pressure',
      },
    })

    expect(managed.capabilities.assistantOutput).toBe('structured')
    expect(harness.snapshot().spawns[0]).toMatchObject({
      file: 'codex',
      args: ['--remote', 'unix:///tmp/test'],
    })
  })

  it('qualifies events and mode changes by the exact terminal owner', async () => {
    const { harness, runtime } = fixture()
    await harness.spawn({
      effectiveCapabilities: {
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'pressure',
        assistantOutput: 'structured',
      },
    })
    const accepted: AssistantOutputEvent[] = []
    harness.supervisor.attach('fixture-session', PTY_FIXTURE_OWNER_ID, {
      onAssistantOutput: (event) => accepted.push(event),
    })

    runtime.emit(output('start', 1))
    runtime.emit(output('delta', 2))
    runtime.emit(output('end', 3))
    expect(accepted.map((event) => event.kind)).toEqual([
      'availability',
      'start',
      'delta',
      'end',
    ])
    expect(
      await harness.supervisor.setAssistantOutputMode(
        'fixture-session',
        PTY_FIXTURE_OWNER_ID,
        true,
      ),
    ).toBe(true)
    expect(() =>
      harness.supervisor.setAssistantOutputMode('fixture-session', 999, true),
    ).toThrow(/belongs to another renderer/)
  })

  it('revokes a mismatched source session before it reaches the renderer', async () => {
    const { harness, runtime } = fixture()
    await harness.spawn({
      effectiveCapabilities: {
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'pressure',
        assistantOutput: 'structured',
      },
    })
    const accepted: AssistantOutputEvent[] = []
    harness.supervisor.attach('fixture-session', PTY_FIXTURE_OWNER_ID, {
      onAssistantOutput: (event) => accepted.push(event),
    })

    runtime.emit(output('start', 1, { sessionId: 'another-session' }))

    expect(accepted.map((event) => event.kind)).toEqual(['availability'])
    expect(runtime.revoke).toHaveBeenCalledWith('source-lost')
  })

  it('rejects a stale lifecycle generation from the same session', async () => {
    const { harness, runtime } = fixture()
    await harness.spawn({
      effectiveCapabilities: {
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'pressure',
        assistantOutput: 'structured',
      },
    })
    const accepted: AssistantOutputEvent[] = []
    harness.supervisor.attach('fixture-session', PTY_FIXTURE_OWNER_ID, {
      onAssistantOutput: (event) => accepted.push(event),
    })

    runtime.emit(output('start', 1, { generation: 0 }))

    expect(accepted.map((event) => event.kind)).toEqual(['availability'])
    expect(runtime.revoke).toHaveBeenCalledWith('source-lost')
  })

  it('restores the native launch when exact session admission fails', async () => {
    const { harness, runtime } = fixture()
    runtime.admitSession.mockReturnValueOnce(false)

    const managed = await harness.spawn({
      effectiveCapabilities: {
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'pressure',
        assistantOutput: 'structured',
      },
    })

    expect(managed.capabilities.assistantOutput).toBeUndefined()
    expect(harness.snapshot().spawns[0]).toMatchObject({
      file: 'codex',
      args: [],
    })
    expect(runtime.dispose).toHaveBeenCalled()
  })

  it('does not replay or continue a rich body across renderer rollover', async () => {
    const { harness, runtime } = fixture()
    await harness.spawn({
      ownerGeneration: 1,
      effectiveCapabilities: {
        sessionIdentity: 'preassigned',
        exactResume: true,
        contextPresentation: 'pressure',
        assistantOutput: 'structured',
      },
    })
    const first: AssistantOutputEvent[] = []
    harness.supervisor.attach(
      'fixture-session',
      PTY_FIXTURE_OWNER_ID,
      {
        onData: () => undefined,
        onAssistantOutput: (event) => first.push(event),
      },
      1,
    )
    runtime.emit(output('start', 1))
    expect(
      harness.supervisor.transferRendererSession(
        'fixture-session',
        PTY_FIXTURE_OWNER_ID,
        1,
        18,
        2,
      ),
    ).toBe(true)
    runtime.emit(output('delta', 2))

    const second: AssistantOutputEvent[] = []
    harness.supervisor.attach(
      'fixture-session',
      18,
      { onAssistantOutput: (event) => second.push(event) },
      2,
    )
    runtime.emit(output('end', 3))
    runtime.emit(
      output('start', 4, {
        turnId: 'turn-2',
        messageId: 'message-2',
      }),
    )

    expect(first.map((event) => event.kind)).toEqual(['availability', 'start'])
    expect(second.map((event) => event.kind)).toEqual(['availability', 'start'])
    expect(runtime.setMode).toHaveBeenCalledWith(false)
  })
})
