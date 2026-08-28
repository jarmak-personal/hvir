// @vitest-environment happy-dom

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionsOverview } from '../src/renderer/src/sessions/SessionsOverview'
import {
  MAX_SESSIONS_PROJECTION_ROWS,
  SESSIONS_PROJECTION_VERSION,
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsPtyHandle,
  asSessionsProjectHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  asSessionsWorkspaceRuntimeId,
  localPath,
  sessionsWorkspaceQualifier,
  type SessionsObservationSnapshot,
  type SessionsOpenRequest,
  type SessionsOpenResponse,
  type SessionsTerminalResolutionResponse,
  type SessionsUsageDemandTarget,
  type SessionsUsageSnapshot,
} from '../src/shared'
import type {
  SessionsTerminalSurfaceLease,
  SessionsTerminalSurfacePort,
} from '../src/renderer/src/sessions/sessions-terminal-surface'
let host: HTMLDivElement
let root: Root
let focused = true

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
  focused = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('SessionsOverview', () => {
  it('discloses policy, supports keyboard/filter/reset, hides opaque handles, and releases background demand', async () => {
    const api = installApi()
    await renderOverview({
      observation: {
        snapshot: () => rendererSessions().slice(0, 1),
        subscribe: () => () => undefined,
      },
    })
    expect(host.querySelector('main')?.getAttribute('aria-label')).toBe('Sessions')
    expect(host.textContent).not.toContain('Usage')
    expect(api.usageObserve).not.toHaveBeenCalled()
    expect(host.querySelectorAll('.session-card')).toHaveLength(2)
    expect(host.querySelector('.sessions-group h2')?.textContent).toBe(
      'Project One / main',
    )
    expect(host.querySelector('.sessions-pagination div')).toBeNull()
    expect(host.textContent).toContain(
      'All sessions · Grouped by workspace · Sorted by attention and activity',
    )
    expect(host.innerHTML).not.toContain('terminal-private-agent')
    expect(host.innerHTML).not.toContain('terminal-private-shell')
    expect(host.textContent).toContain('Agent')
    expect(host.textContent).toContain('Shell')
    expect(host.textContent).not.toContain('Lifecycle')
    expect(host.textContent).not.toContain('HostLocal · Connected')
    expect(host.textContent).toContain('AttentionBell')
    expect(
      host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'),
    ).toBe('12')
    expect(host.textContent).not.toContain('TelemetryAvailable')
    expect(host.textContent).not.toContain('Limited facts')
    expect(host.textContent).not.toContain('Quiet state')
    expect(host.textContent).not.toContain('Unsupported')
    expect(host.textContent).not.toContain('Unavailable · Not materialized')
    const shellCard = [...host.querySelectorAll<HTMLElement>('.session-card')].find(
      (card) => card.textContent?.includes('Shell terminal'),
    )!
    expect(shellCard.querySelectorAll('.session-fact')).toHaveLength(0)
    expect(shellCard.querySelector('.session-fact-summary')).toBeNull()
    expect(
      [...shellCard.querySelectorAll<HTMLButtonElement>('button')].map((action) =>
        action.textContent?.trim(),
      ),
    ).toEqual(['Open'])

    const agentCard = [...host.querySelectorAll<HTMLElement>('.session-card')].find(
      (card) => card.textContent?.includes('Agent terminal'),
    )!
    expect(agentCard.querySelector('.session-fact.actionable')?.textContent).toBe(
      'AttentionBell',
    )
    expect(agentCard.querySelectorAll('.session-fact.available')).toHaveLength(1)

    const cards = [...host.querySelectorAll<HTMLElement>('.session-card')]
    act(() => {
      cards[0]?.click()
      cards[0]?.focus()
      cards[0]?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      )
    })
    expect(document.activeElement).toBe(cards[1])

    act(() => button('Shells').click())
    expect(host.querySelectorAll('.session-card')).toHaveLength(1)
    expect(host.textContent).toContain('Shell terminal')
    act(() => button('Working').click())
    expect(host.textContent).toContain('No sessions match')
    expect(host.textContent).toContain('Working · Grouped by workspace')
    act(() => button('Reset filters').click())
    expect(host.querySelectorAll('.session-card')).toHaveLength(2)

    focused = false
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await settle()
    })
    expect(host.textContent).toContain('Updates paused')
    expect(api.release).toHaveBeenCalledExactlyOnceWith(1)
    expect(api.listenerCount()).toBe(0)

    focused = true
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await settle()
    })
    expect(api.observe).toHaveBeenLastCalledWith(3)
    expect(host.querySelectorAll('.session-card')).toHaveLength(2)
  })

  it('sends the exact opaque Open qualifiers and transfers successful focus to the terminal owner', async () => {
    const api = installApi()
    const onOpened = vi.fn()
    const onFocusOpened = vi.fn(() => Promise.resolve(true))
    await renderOverview({ onOpened, onFocusOpened })

    await act(async () => {
      const card = host.querySelector<HTMLElement>('.session-card')
      card?.focus()
      card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(api.open).toHaveBeenCalledWith({
      demandGeneration: 1,
      sourceRevision: 7,
      handle: 'terminal-private-agent',
      projectId: 'opaque-project',
      workspaceId: 'opaque-workspace',
      workspaceQualifier: '11:0:0',
      livePty: {
        handle: 'live-instance-agent',
        rendererOwnerId: 4,
        rendererGeneration: 6,
      },
    })
    expect(onOpened).toHaveBeenCalledOnce()
    expect(onFocusOpened).toHaveBeenCalledExactlyOnceWith(
      'terminal-private-agent',
      '11:0:0',
      {
        handle: 'live-instance-agent',
        rendererOwnerId: 4,
        rendererGeneration: 6,
      },
    )
  })

  it('keeps one interactive surface current through StrictMode replay and restores overview focus', async () => {
    let current = snapshot(1)
    const workspace = document.createElement('div')
    const engine = document.createElement('div')
    engine.className = 'terminal-engine-host'
    engine.tabIndex = 0
    workspace.append(engine)
    const input = vi.fn()
    engine.addEventListener('keydown', input)
    const lease = componentLease(engine, workspace)
    const acquire = vi.fn(() => acquired(lease.value))
    const surface = availableSurface(acquire)
    const frame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0)
        return 1
      })
    const api = installApi({
      snapshot: (demandGeneration) => ({ ...current, demandGeneration }),
    })
    await renderOverview({ surface }, true)
    expect(api.observe.mock.calls).toEqual([[1], [3]])
    expect(api.release).toHaveBeenCalledExactlyOnceWith(1)
    expect(api.listenerCount()).toBe(1)
    await act(async () => {
      button('Interact', '.session-card').click()
      await settle()
    })
    expect(api.resolveTerminal).toHaveBeenCalledWith({
      demandGeneration: 3,
      sourceRevision: 7,
      handle: 'terminal-private-agent',
      projectId: 'opaque-project',
      workspaceId: 'opaque-workspace',
      workspaceQualifier: '11:0:0',
      livePty: {
        handle: 'live-instance-agent',
        rendererOwnerId: 4,
        rendererGeneration: 6,
      },
    })
    expect(host.querySelector('.sessions-terminal-detail h1')?.textContent).toBe(
      'Agent terminal',
    )
    expect(host.querySelector('.sessions-terminal-detail')?.getAttribute('role')).toBe(
      'dialog',
    )
    expect(host.querySelector('.sessions-overview')?.hasAttribute('inert')).toBe(true)
    expect(host.querySelectorAll('.sessions-detail-terminal')).toHaveLength(1)
    expect(host.querySelectorAll('.terminal-engine-host')).toHaveLength(1)
    expect(lease.focus).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(engine)
    current = {
      ...current,
      revision: 8,
      sessions: current.sessions.map((session, index) =>
        index === 0
          ? {
              ...session,
              telemetry: {
                ...session.telemetry,
                model: { status: 'available' as const, value: { id: 'model-new' } },
              },
            }
          : session,
      ),
    }
    await act(async () => {
      api.emit({ demandGeneration: 3, revision: 8 })
      await settle()
    })
    expect(lease.renew).toHaveBeenCalledOnce()
    expect(acquire).toHaveBeenCalledOnce()
    expect(lease.attach).toHaveBeenCalledOnce()
    expect(lease.release).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(engine)
    act(() => {
      engine.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    })
    expect(input).toHaveBeenCalledOnce()
    await act(async () => {
      button('Close').click()
      await settle()
    })
    expect(lease.release).toHaveBeenCalledOnce()
    expect(workspace.querySelector('.terminal-engine-host')).toBe(engine)
    expect(host.querySelector('.sessions-terminal-detail')).toBeNull()
    expect(host.querySelector('.sessions-overview')?.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(host.querySelector('.session-card'))
    await act(async () => {
      root.render(<div>Workspace</div>)
      await settle()
    })
    expect(api.release.mock.calls).toEqual([[1], [3]])
    expect(api.listenerCount()).toBe(0)
    expect(lease.release).toHaveBeenCalledOnce()
    frame.mockRestore()
  })

  it('distinguishes the true empty state from a filtered empty state', async () => {
    installApi({
      snapshot: (demandGeneration) => ({
        ...snapshot(demandGeneration),
        sessions: [],
      }),
    })
    await renderOverview({
      observation: { snapshot: () => [], subscribe: () => () => undefined },
    })

    expect(host.textContent).toContain('No hvir sessions')
    expect(host.textContent).not.toContain('No sessions match')
    expect(host.querySelector('button')?.textContent).not.toBe('Reset filters')
  })

  it('rejects a late Open completion after the destination lifetime ends', async () => {
    let complete!: (response: SessionsOpenResponse) => void
    const pending = new Promise<SessionsOpenResponse>((resolve) => {
      complete = resolve
    })
    installApi({ open: () => pending })
    const onOpened = vi.fn()
    const onFocusOpened = vi.fn(() => Promise.resolve(true))
    await renderOverview({ onOpened, onFocusOpened })

    await act(async () => {
      button('Open', '.session-card').click()
      await settle()
    })
    await act(async () => {
      root.render(<div>Workspace</div>)
      await settle()
    })
    await act(async () => {
      complete(openedResponse())
      await settle()
    })

    expect(onOpened).not.toHaveBeenCalled()
    expect(onFocusOpened).not.toHaveBeenCalled()
  })

  it('moves focus to a deterministic neighbor when the selected row disappears', async () => {
    let current = snapshot(1)
    const api = installApi({
      snapshot: (demandGeneration) => ({ ...current, demandGeneration }),
    })
    await renderOverview({
      observation: { snapshot: () => [], subscribe: () => () => undefined },
    })
    const cards = [...host.querySelectorAll<HTMLElement>('.session-card')]
    act(() => cards[1]?.focus())

    current = { ...current, revision: 8, sessions: current.sessions.slice(0, 1) }
    await act(async () => {
      api.emit({ demandGeneration: 1, revision: 8 })
      await settle()
    })

    expect(host.querySelectorAll('.session-card')).toHaveLength(1)
    expect(document.activeElement).toBe(host.querySelector('.session-card'))
  })

  it('mounts a bounded accessible page at projection capacity and moves keyboard focus across pages', async () => {
    installApi({ snapshot: capacitySnapshot })
    await renderOverview({
      observation: {
        snapshot: capacityRendererSessions,
        subscribe: () => () => undefined,
      },
    })

    expect(host.textContent).toContain(
      `Showing 1–40 of ${MAX_SESSIONS_PROJECTION_ROWS} sessions`,
    )
    expect(host.textContent).toContain('Page 1 of 13')
    expect(host.querySelectorAll('[role="list"]')).toHaveLength(1)
    expect(host.querySelectorAll('[role="listitem"]')).toHaveLength(40)
    expect(host.querySelectorAll('.session-card[tabindex="0"]')).toHaveLength(1)

    const last = host.querySelectorAll<HTMLElement>('.session-card')[39]
    await act(async () => {
      last?.focus()
      last?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      )
      await settle()
    })

    expect(host.textContent).toContain(
      `Showing 41–80 of ${MAX_SESSIONS_PROJECTION_ROWS} sessions`,
    )
    expect(host.querySelectorAll('.session-card')).toHaveLength(40)
    expect(document.activeElement).toBe(host.querySelector('.session-card'))
  })


  it('replaces Opening feedback when an unavailable Open completes after a projection revision', async () => {
    let current = snapshot(1)
    let complete!: (response: SessionsOpenResponse) => void
    const pending = new Promise<SessionsOpenResponse>((resolve) => {
      complete = resolve
    })
    const api = installApi({
      snapshot: (demandGeneration) => ({ ...current, demandGeneration }),
      open: () => pending,
    })
    await renderOverview()

    await act(async () => {
      button('Open', '.session-card').click()
      await settle()
    })
    expect(host.textContent).toContain('Opening exact terminal…')
    current = {
      ...current,
      revision: 8,
      workspaces: current.workspaces.map((workspace) => ({
        ...workspace,
        projectName: 'Project One updated',
      })),
    }
    await act(async () => {
      api.emit({ demandGeneration: 1, revision: 8 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await settle()
    })
    await act(async () => {
      complete({ outcome: 'unavailable', reason: 'terminal-unavailable' })
      await settle()
    })

    expect(host.textContent).not.toContain('Opening exact terminal…')
    expect(host.textContent).toContain(
      'Sessions changed. Review the refreshed row before opening it.',
    )
  })

  it('preserves free-text identifiers and presents missing provider capability truthfully', async () => {
    installApi({
      snapshot: (demandGeneration) => {
        const current = snapshot(demandGeneration)
        return {
          ...current,
          providers: [],
          workspaces: current.workspaces.map((workspace) => ({
            ...workspace,
            host: { ...workspace.host, label: 'gpu-east-1' },
          })),
          sessions: current.sessions.map((session, index) =>
            index === 0
              ? {
                  ...session,
                  telemetry: {
                    ...session.telemetry,
                    model: { status: 'available', value: { id: 'gpt-5.6-sol' } },
                  },
                }
              : session,
          ),
        }
      },
    })
    await renderOverview()

    expect(host.textContent).not.toContain('Hostgpu-east-1 · Connected')
    expect(host.textContent).toContain('Modelgpt-5.6-sol')
    expect(host.textContent).toContain('Terminal')
    expect(host.textContent).not.toContain('Gpu east 1')
    expect(host.textContent).not.toContain('Gpt 5.6 sol')
  })
})

function installApi(
  options: {
    readonly snapshot?: (demandGeneration: number) => SessionsObservationSnapshot
    readonly open?: (request: unknown) => Promise<SessionsOpenResponse>
    readonly resolveTerminal?: (
      request: unknown,
    ) => Promise<SessionsTerminalResolutionResponse>
    readonly usageSnapshot?: (
      demandGeneration: number,
      targets: readonly SessionsUsageDemandTarget[],
    ) => SessionsUsageSnapshot
  } = {},
) {
  const listeners = new Set<(payload: unknown) => void>()
  const usageListeners = new Set<(payload: unknown) => void>()
  const readSnapshot = options.snapshot ?? snapshot
  const observe = vi.fn((generation: number) => Promise.resolve(readSnapshot(generation)))
  const release = vi.fn((_generation: number) => Promise.resolve())
  const open = vi.fn(
    options.open ?? ((_request: unknown) => Promise.resolve(openedResponse())),
  )
  const resolveTerminal = vi.fn(
    options.resolveTerminal ??
      ((request: unknown) => {
        const exact = request as SessionsOpenRequest
        return Promise.resolve({
          outcome: 'resolved' as const,
          handle: exact.handle,
          workspaceQualifier: exact.workspaceQualifier,
          workspaceRuntimeId: asSessionsWorkspaceRuntimeId('workspace-runtime'),
          livePty: exact.livePty,
        })
      }),
  )
  let usageTargets: readonly SessionsUsageDemandTarget[] = []
  const readUsageSnapshot =
    options.usageSnapshot ??
    ((demandGeneration: number, targets: readonly SessionsUsageDemandTarget[]) => ({
      version: SESSIONS_PROJECTION_VERSION,
      demandGeneration,
      revision: 1,
      sampledAt: 10_000,
      rows: targets.map((target) => ({
        handle: target.handle,
        usage: { status: 'pending' as const, reason: 'observation-pending' as const },
      })),
    }))
  const usageObserve = vi.fn(
    (request: {
      demandGeneration: number
      targets: readonly SessionsUsageDemandTarget[]
    }) => {
      usageTargets = request.targets
      return Promise.resolve(readUsageSnapshot(request.demandGeneration, usageTargets))
    },
  )
  const usageSnapshot = vi.fn((demandGeneration: number) =>
    Promise.resolve(readUsageSnapshot(demandGeneration, usageTargets)),
  )
  const usageRelease = vi.fn((_demandGeneration: number) => Promise.resolve())
  const api = {
    observe,
    release,
    open,
    resolveTerminal,
    emit: (payload: unknown) => {
      for (const listener of listeners) listener(payload)
    },
    usageEmit: (payload: unknown) => {
      for (const listener of usageListeners) listener(payload)
    },
    usageObserve,
    usageSnapshot,
    usageRelease,
    usageListenerCount: () => usageListeners.size,
    listenerCount: () => listeners.size,
    invoke: vi.fn((channel: string, request: { demandGeneration: number }) => {
      if (channel === 'sessions:observe') return observe(request.demandGeneration)
      if (channel === 'sessions:snapshot')
        return Promise.resolve(readSnapshot(request.demandGeneration))
      if (channel === 'sessions:release') return release(request.demandGeneration)
      if (channel === 'sessions:usage-observe') return usageObserve(request as never)
      if (channel === 'sessions:usage-snapshot')
        return usageSnapshot(request.demandGeneration)
      if (channel === 'sessions:usage-release')
        return usageRelease(request.demandGeneration)
      if (channel === 'sessions:open') return open(request)
      if (channel === 'sessions:resolve-terminal') return resolveTerminal(request)
      return Promise.reject(new Error(`Unexpected channel ${channel}`))
    }),
    on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
      const selected =
        channel === 'sessions:changed'
          ? listeners
          : channel === 'sessions:usage-changed'
            ? usageListeners
            : undefined
      selected?.add(listener)
      return () => selected?.delete(listener)
    }),
  }
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: api,
  })
  return api
}

function componentLease(engine: HTMLElement, workspace: HTMLElement) {
  let container: HTMLElement | undefined
  const attach = vi.fn((next: HTMLElement) => {
    container = next
    next.append(engine)
    return true
  })
  const detach = vi.fn((current: HTMLElement) => {
    if (container === current) container = undefined
  })
  const setVisible = vi.fn((current: HTMLElement) => container === current)
  const focus = vi.fn((current: HTMLElement) => {
    if (container !== current) return false
    engine.focus()
    return true
  })
  const release = vi.fn(() => {
    container = undefined
    workspace.append(engine)
  })
  const renew = vi.fn(() => true)
  const value: SessionsTerminalSurfaceLease = {
    renew,
    attach,
    detach,
    setVisible,
    focus,
    subscribe: () => () => undefined,
    release,
  }
  return { value, renew, attach, detach, setVisible, focus, release }
}

function openedResponse(): SessionsOpenResponse {
  return {
    outcome: 'opened',
    state: projectState(),
    handle: asSessionsTerminalHandle('terminal-private-agent'),
    workspaceQualifier: sessionsWorkspaceQualifier(11, 0, 0),
    livePty: {
      handle: asSessionsPtyHandle('live-instance-agent'),
      rendererOwnerId: 4,
      rendererGeneration: 6,
    },
  }
}

async function renderOverview(
  overrides: Partial<Parameters<typeof SessionsOverview>[0]> = {},
  strict = false,
): Promise<void> {
  await act(async () => {
    const overview = (
      <SessionsOverview
        observation={{
          snapshot: rendererSessions,
          subscribe: () => () => undefined,
        }}
        surface={availableSurface(() => ({
          outcome: 'unavailable',
          reason: 'runtime-not-ready',
        }))}
        onOpened={vi.fn()}
        onFocusOpened={vi.fn(() => Promise.resolve(true))}
        onOpenFailed={vi.fn()}
        {...overrides}
      />
    )
    root.render(strict ? <StrictMode>{overview}</StrictMode> : overview)
    await settle()
  })
}


function acquired(lease: SessionsTerminalSurfaceLease) {
  return { outcome: 'acquired' as const, lease }
}

function availableSurface(
  acquire: SessionsTerminalSurfacePort['acquire'],
): SessionsTerminalSurfacePort {
  return {
    acquire,
  }
}

function rendererSessions() {
  const workspaceQualifier = sessionsWorkspaceQualifier(11, 0, 0)
  return [
    {
      handle: asSessionsTerminalHandle('terminal-private-agent'),
      workspaceQualifier,
      providerId: asHarnessProviderId('codex'),
      profileId: asHarnessProfileId('codex-default'),
      title: 'Agent terminal',
      dormant: false,
      resumeOnStart: false,
      exited: false,
      recoveryUnavailable: false,
      attention: 'bell' as const,
    },
    {
      handle: asSessionsTerminalHandle('terminal-private-shell'),
      workspaceQualifier,
      providerId: asHarnessProviderId('plain-shell'),
      profileId: asHarnessProfileId('plain-shell-default'),
      title: 'Shell terminal',
      dormant: false,
      resumeOnStart: false,
      exited: false,
      recoveryUnavailable: false,
    },
  ]
}

function snapshot(demandGeneration: number): SessionsObservationSnapshot {
  const unsupported = { status: 'unsupported' as const }
  const workspaceQualifier = sessionsWorkspaceQualifier(11, 0, 0)
  return {
    version: SESSIONS_PROJECTION_VERSION,
    demandGeneration,
    revision: 7,
    activeProject: asSessionsProjectHandle('opaque-project'),
    providers: [
      {
        id: asHarnessProviderId('codex'),
        displayName: 'Codex',
        telemetrySupported: true,
        usageSupported: true,
        sessionKind: 'agent',
      },
      {
        id: asHarnessProviderId('plain-shell'),
        displayName: 'Shell',
        telemetrySupported: false,
        usageSupported: false,
        sessionKind: 'shell',
      },
    ],
    workspaces: [
      {
        projectId: asSessionsProjectHandle('opaque-project'),
        projectName: 'Project One',
        workspaceId: asSessionsWorkspaceHandle('opaque-workspace'),
        qualifier: workspaceQualifier,
        workspaceName: 'main',
        main: true,
        closed: false,
        missing: false,
        host: {
          id: 'local',
          label: 'Local',
          kind: 'local',
          connectionState: 'connected',
        },
      },
    ],
    sessions: [
      {
        handle: asSessionsTerminalHandle('terminal-private-agent'),
        workspaceId: asSessionsWorkspaceHandle('opaque-workspace'),
        providerId: asHarnessProviderId('codex'),
        profile: {
          status: 'available',
          value: { id: asHarnessProfileId('codex-default') },
        },
        title: 'Agent terminal',
        lifecycle: 'live',
        livePty: {
          handle: asSessionsPtyHandle('live-instance-agent'),
          rendererOwnerId: 4,
          rendererGeneration: 6,
        },
        telemetry: {
          model: { status: 'available', value: { id: 'model-safe' } },
          context: { status: 'available', value: { usedTokens: 120, usedPercent: 12 } },
          turn: { status: 'available', value: { state: 'idle' } },
          freshness: { status: 'available', value: { staleAfterMs: 30_000 } },
        },
      },
      {
        handle: asSessionsTerminalHandle('terminal-private-shell'),
        workspaceId: asSessionsWorkspaceHandle('opaque-workspace'),
        providerId: asHarnessProviderId('plain-shell'),
        profile: {
          status: 'available',
          value: { id: asHarnessProfileId('plain-shell-default') },
        },
        title: 'Shell terminal',
        lifecycle: 'retained',
        telemetry: {
          model: unsupported,
          context: unsupported,
          turn: unsupported,
          freshness: unsupported,
        },
      },
    ],
  }
}

function capacitySnapshot(demandGeneration: number): SessionsObservationSnapshot {
  const base = snapshot(demandGeneration)
  const fixture = base.sessions[0]!
  return {
    ...base,
    sessions: Array.from({ length: MAX_SESSIONS_PROJECTION_ROWS }, (_, index) => ({
      ...fixture,
      handle: asSessionsTerminalHandle(`capacity-${index}`),
      title: `Capacity session ${index}`,
      lifecycle: 'retained' as const,
      livePty: undefined,
    })),
  }
}

function capacityRendererSessions() {
  const fixture = rendererSessions()[0]!
  return Array.from({ length: MAX_SESSIONS_PROJECTION_ROWS }, (_, index) => ({
    ...fixture,
    handle: asSessionsTerminalHandle(`capacity-${index}`),
    title: `Capacity session ${index}`,
    attention: undefined,
  }))
}

function projectState() {
  const root = localPath('/repo')
  return {
    revision: 12,
    root,
    connectionState: 'connected' as const,
    watchTier: 'native' as const,
    activeProjectId: 'project-real',
    activeWorkspaceId: 'workspace-real',
    projects: [
      {
        id: 'project-real',
        registeredRoot: root,
        displayName: 'Project One',
        connectionState: 'connected' as const,
        watchTier: 'native' as const,
        activeWorkspaceId: 'workspace-real',
        workspaces: [
          {
            id: 'workspace-real',
            root,
            name: 'main',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}

function button(text: string, within?: string): HTMLButtonElement {
  const rootElement = within ? host.querySelector(within) : host
  const match = [
    ...(rootElement?.querySelectorAll<HTMLButtonElement>('button') ?? []),
  ].find((candidate) => candidate.textContent?.trim() === text)
  if (!match) throw new Error(`Missing button ${text}`)
  return match
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
