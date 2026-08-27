// @vitest-environment happy-dom

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SessionsOverview } from '../src/renderer/src/sessions/SessionsOverview'
import { SessionsUsageLens } from '../src/renderer/src/sessions/SessionsUsageLens'
import { joinSessionsProjection } from '../src/renderer/src/sessions/sessions-projection-coordinator'
import {
  MAX_SESSIONS_PROJECTION_ROWS,
  SESSIONS_PROJECTION_VERSION,
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsPtyHandle,
  asSessionsProjectHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  localPath,
  sessionsWorkspaceQualifier,
  type SessionsObservationSnapshot,
  type SessionsOpenRequest,
  type SessionsOpenResponse,
  type SessionsProjectionSnapshot,
  type SessionsTerminalResolutionResponse,
  type SessionsUsageDemandTarget,
  type SessionsUsageSnapshot,
} from '../src/shared'
import type { SessionsTerminalSurfaceLease } from '../src/renderer/src/sessions/sessions-terminal-surface'

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
  it('survives StrictMode effect replay with one current projection demand', async () => {
    const api = installApi()

    await act(async () => {
      root.render(
        <StrictMode>
          <SessionsOverview
            observation={{
              snapshot: rendererSessions,
              subscribe: () => () => undefined,
            }}
            surface={{ acquire: () => undefined }}
            onReturn={vi.fn()}
            onOpened={vi.fn()}
            onFocusOpened={vi.fn(() => Promise.resolve(true))}
            onOpenFailed={vi.fn()}
          />
        </StrictMode>,
      )
      await settle()
    })

    expect(host.querySelectorAll('.session-card')).toHaveLength(2)
    expect(api.observe.mock.calls).toEqual([[1], [3]])
    expect(api.release).toHaveBeenCalledExactlyOnceWith(1)
    expect(api.listenerCount()).toBe(1)

    await act(async () => {
      root.render(<div>Workspace</div>)
      await settle()
    })

    expect(api.release.mock.calls).toEqual([[1], [3]])
    expect(api.listenerCount()).toBe(0)
  })

  it('discloses policy, supports keyboard/filter/reset, hides opaque handles, and releases background demand', async () => {
    const api = installApi()
    await renderOverview({
      observation: {
        snapshot: () => rendererSessions().slice(0, 1),
        subscribe: () => () => undefined,
      },
    })

    expect(host.querySelector('h1')?.textContent).toBe('Sessions')
    expect(host.querySelectorAll('.session-card')).toHaveLength(2)
    expect(host.textContent).toContain(
      'All sessions · Grouped by project · Sorted by attention and activity',
    )
    expect(host.innerHTML).not.toContain('terminal-private-agent')
    expect(host.innerHTML).not.toContain('terminal-private-shell')
    expect(host.textContent).toContain('Agent harness')
    expect(host.textContent).toContain('Non-agent shell')
    expect(host.textContent).toContain('LifecycleLive')
    expect(host.textContent).toContain('HostLocal · Connected')
    expect(host.textContent).toContain('AttentionBell')
    expect(host.textContent).toContain('Context12% used')
    expect(host.textContent).toContain('TelemetryAvailable')
    expect(host.textContent).toContain(
      'Limited factsProvider turn, Model, Context, Telemetry, and Usage capability — Unsupported',
    )

    const shellCard = [...host.querySelectorAll<HTMLElement>('.session-card')].find(
      (card) => card.textContent?.includes('Shell terminal'),
    )!
    expect(shellCard.querySelectorAll('.session-fact')).toHaveLength(2)
    expect(shellCard.querySelectorAll('.session-fact-summary')).toHaveLength(2)
    expect(shellCard.textContent).toContain(
      'Attention and Working — Unavailable · Not materialized',
    )
    expect(shellCard.textContent).toContain(
      'Provider turn, Model, Context, Telemetry, and Usage capability — Unsupported',
    )

    const agentCard = [...host.querySelectorAll<HTMLElement>('.session-card')].find(
      (card) => card.textContent?.includes('Agent terminal'),
    )!
    expect(agentCard.querySelector('.session-fact.actionable')?.textContent).toBe(
      'AttentionBell',
    )
    expect(agentCard.textContent).toContain(
      'Quiet stateWorking — Not working; Provider turn — Idle',
    )
    expect(agentCard.querySelectorAll('.session-fact.available').length).toBeGreaterThan(
      2,
    )

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
    expect(host.textContent).toContain('Working · Grouped by project')
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

  it('attaches one actual provider-neutral surface in detail and restores accessible overview focus', async () => {
    const workspace = document.createElement('div')
    const engine = document.createElement('div')
    engine.className = 'terminal-engine-host'
    engine.tabIndex = 0
    workspace.append(engine)
    const lease = componentLease(engine, workspace)
    const surface = { acquire: vi.fn(() => lease.value) }
    const frame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0)
        return 1
      })
    const api = installApi()
    await renderOverview({ surface })

    await act(async () => {
      button('Interact', '.session-card').click()
      await settle()
    })
    expect(api.resolveTerminal).toHaveBeenCalledWith({
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
    expect(host.querySelector('h1')?.textContent).toBe('Agent terminal')
    expect(host.querySelectorAll('.sessions-detail-terminal')).toHaveLength(1)
    expect(host.querySelectorAll('.terminal-engine-host')).toHaveLength(1)
    expect(host.innerHTML).not.toContain('terminal-private-agent')
    expect(host.innerHTML).not.toContain('live-instance-agent')
    expect(lease.focus).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(engine)

    await act(async () => {
      button('Back to Sessions').click()
      await settle()
    })
    expect(lease.release).toHaveBeenCalledOnce()
    expect(workspace.querySelector('.terminal-engine-host')).toBe(engine)
    expect(host.querySelector('h1')?.textContent).toBe('Sessions')
    expect(document.activeElement).toBe(host.querySelector('.session-card'))
    frame.mockRestore()
  })

  it('keeps bounded detail feedback when exact surface acquisition loses its runtime', async () => {
    installApi()
    await renderOverview({ surface: { acquire: () => undefined } })

    await act(async () => {
      button('Interact', '.session-card').click()
      await settle()
    })
    expect(host.textContent).toContain(
      'This session no longer has the same live terminal.',
    )
    expect(
      host.querySelector('.sessions-detail-terminal')?.getAttribute('aria-label'),
    ).toBe('Agent terminal terminal')
    expect(host.querySelectorAll('.terminal-engine-host')).toHaveLength(0)
    expect(button('Back to Sessions')).toBeInstanceOf(HTMLButtonElement)
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

  it('ranks provider-neutral totals, exposes categories, preserves focused identity on reorder, and releases on blur', async () => {
    let revision = 1
    let totals = new Map([
      [asSessionsTerminalHandle('terminal-private-agent'), 200],
      [asSessionsTerminalHandle('terminal-private-shell'), 100],
    ])
    const api = installApi({
      snapshot: (demandGeneration) => {
        const value = snapshot(demandGeneration)
        return {
          ...value,
          providers: value.providers.map((provider) => ({
            ...provider,
            usageSupported: true,
          })),
          sessions: value.sessions.map((session) =>
            session.handle === 'terminal-private-shell'
              ? {
                  ...session,
                  lifecycle: 'live' as const,
                  livePty: {
                    handle: asSessionsPtyHandle('live-instance-shell'),
                    rendererOwnerId: 4,
                    rendererGeneration: 6,
                  },
                }
              : session,
          ),
        }
      },
      usageSnapshot: (demandGeneration, targets) => ({
        version: SESSIONS_PROJECTION_VERSION,
        demandGeneration,
        revision,
        sampledAt: revision * 10_000,
        rows: targets.map((target) => {
          const total = totals.get(target.handle) ?? 0
          return {
            handle: target.handle,
            usage: {
              status: 'exact' as const,
              observedAt: revision * 10_000,
              value: {
                freshInputTokens: total / 2,
                cacheReadInputTokens: total / 4,
                cacheWriteInputTokens: 0,
                outputTokens: total / 4,
                reasoningTokens: total / 8,
                normalizedTokenTotal: total,
              },
            },
          }
        }),
      }),
    })
    await renderOverview()
    await act(async () => {
      button('Usage').click()
      await settle()
    })

    expect(host.textContent).toContain('Token usage')
    expect(host.textContent).toContain('Recent is establishing baselines')
    expect(host.textContent).toContain('Baseline')
    expect(host.textContent).not.toContain('Rank 1')
    expect(
      [...host.querySelectorAll('.sessions-visually-hidden')].some((label) =>
        label.textContent?.includes(
          'exact cumulative total is 200 tokens and is shown separately',
        ),
      ),
    ).toBe(true)

    act(() => button('Session total').click())
    expect(host.textContent).toContain('Exact cumulative totals are ranked')
    expect(
      host.querySelectorAll('.sessions-usage-bar[data-scale="ranked"]'),
    ).toHaveLength(2)
    expect(host.textContent).toContain('Reasoning (part of output)')
    expect(host.querySelectorAll('.sessions-usage-ranking > li')).toHaveLength(2)
    expect(
      [...host.querySelectorAll('.sessions-visually-hidden')].some((label) =>
        label.textContent?.includes('200 tokens for this session'),
      ),
    ).toBe(true)
    expect(host.querySelector('.sessions-usage-ranking strong[aria-label]')).toBeNull()
    const agent = [
      ...host.querySelectorAll<HTMLElement>('.sessions-usage-ranking > li'),
    ].find((row) => row.textContent?.includes('Agent terminal'))!
    act(() => agent.focus())

    totals = new Map([
      [asSessionsTerminalHandle('terminal-private-agent'), 50],
      [asSessionsTerminalHandle('terminal-private-shell'), 300],
    ])
    revision = 2
    await act(async () => {
      api.usageEmit({ demandGeneration: 1, revision })
      await settle()
    })
    expect(host.querySelector('.sessions-usage-ranking > li h3')?.textContent).toBe(
      'Shell terminal',
    )
    expect(document.activeElement?.textContent).toContain('Agent terminal')

    focused = false
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      await settle()
    })
    expect(api.usageRelease).toHaveBeenCalledExactlyOnceWith(1)
    expect(api.usageSnapshot).toHaveBeenCalled()
  })

  it('reacquires Usage after React Strict Mode replays setup, cleanup, and setup', async () => {
    const api = installApi()
    const observed = snapshot(4)
    const rows = joinSessionsProjection(observed, rendererSessions())
    const projection: SessionsProjectionSnapshot = {
      version: SESSIONS_PROJECTION_VERSION,
      demandGeneration: observed.demandGeneration,
      revision: 1,
      sourceRevision: observed.revision,
      status: 'available' as const,
      rows,
    }

    await act(async () => {
      root.render(
        <StrictMode>
          <SessionsUsageLens
            projection={projection}
            rows={rows}
            foreground
            selected={rows[0]?.handle}
            onSelect={vi.fn()}
          />
        </StrictMode>,
      )
      await settle()
    })

    expect(
      api.usageObserve.mock.calls.map(([request]) => request.demandGeneration),
    ).toEqual([1, 3])
    expect(api.usageRelease).toHaveBeenCalledExactlyOnceWith(1)
    expect(api.usageListenerCount()).toBe(1)
    expect(host.textContent).toContain('Token usage')

    await act(async () => {
      root.render(<div>Workspace</div>)
      await settle()
    })
    expect(api.usageRelease.mock.calls).toEqual([[1], [3]])
    expect(api.usageListenerCount()).toBe(0)
  })

  it('keeps quiet, unsupported, and unavailable rows with reliable accessible values', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const base = snapshot(1)
    const unavailableHandle = asSessionsTerminalHandle('terminal-unavailable')
    const unavailablePty = asSessionsPtyHandle('live-instance-unavailable')
    installApi({
      snapshot: (demandGeneration) => ({
        ...base,
        demandGeneration,
        sessions: [
          ...base.sessions,
          {
            ...base.sessions[0]!,
            handle: unavailableHandle,
            title: 'Unavailable terminal',
            livePty: {
              handle: unavailablePty,
              rendererOwnerId: 4,
              rendererGeneration: 6,
            },
          },
        ],
      }),
      usageSnapshot: (demandGeneration, targets) => ({
        version: SESSIONS_PROJECTION_VERSION,
        demandGeneration,
        revision: 1,
        sampledAt: Date.now(),
        rows: targets.map((target) => ({
          handle: target.handle,
          usage:
            target.handle === unavailableHandle
              ? ({ status: 'unavailable', reason: 'source-unavailable' } as const)
              : ({
                  status: 'exact',
                  observedAt: Date.now(),
                  value: {
                    freshInputTokens: 0,
                    cacheReadInputTokens: 0,
                    cacheWriteInputTokens: 0,
                    outputTokens: 0,
                    normalizedTokenTotal: 0,
                  },
                } as const),
        })),
      }),
    })
    await renderOverview({
      observation: {
        snapshot: () => [
          ...rendererSessions(),
          {
            ...rendererSessions()[0]!,
            handle: unavailableHandle,
            title: 'Unavailable terminal',
          },
        ],
        subscribe: () => () => undefined,
      },
    })
    await act(async () => {
      button('Usage').click()
      await settle()
      button('1 minute').click()
      for (let sample = 0; sample < 6; sample += 1) {
        vi.advanceTimersByTime(10_000)
        await settle()
      }
    })

    expect(host.querySelectorAll('.sessions-usage-ranking > li')).toHaveLength(3)
    expect(host.textContent).toContain('No activity in 1 minute')
    expect(host.textContent).toContain('Unsupported · capability state')
    expect(host.textContent).toContain('Unavailable · Source unavailable')
    expect(
      [...host.querySelectorAll('.sessions-visually-hidden')].map(
        (label) => label.textContent,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('0 tokens in the last 1 minute'),
        expect.stringContaining(
          'Unsupported usage; exact Recent total unavailable; unranked',
        ),
        expect.stringContaining(
          'Unavailable usage; exact Recent total unavailable; unranked',
        ),
      ]),
    )
    expect(host.querySelectorAll('.sessions-usage-ranking > li.compact')).toHaveLength(2)
    expect(
      host.querySelectorAll('.sessions-usage-ranking > li.compact .sessions-usage-bar'),
    ).toHaveLength(0)
    expect(
      host.querySelectorAll('.sessions-usage-ranking > li.compact details'),
    ).toHaveLength(0)
    vi.useRealTimers()
  })

  it('visualizes a positive partial Recent observation without assigning a rank', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let sample = 0
    installApi({
      usageSnapshot: (demandGeneration, targets) => ({
        version: SESSIONS_PROJECTION_VERSION,
        demandGeneration,
        revision: sample + 1,
        sampledAt: Date.now(),
        rows: targets.map((target) => ({
          handle: target.handle,
          usage: {
            status: 'partial' as const,
            observedAt: Date.now(),
            value: {
              freshInputTokens: 20 + sample * 10,
              outputTokens: 5 + sample * 5,
            },
          },
        })),
      }),
    })
    const observed = snapshot(1)
    const rows = joinSessionsProjection(observed, rendererSessions()).slice(0, 1)
    const projection: SessionsProjectionSnapshot = {
      version: SESSIONS_PROJECTION_VERSION,
      demandGeneration: observed.demandGeneration,
      revision: 1,
      sourceRevision: observed.revision,
      status: 'available',
      rows,
    }
    await act(async () => {
      root.render(
        <SessionsUsageLens
          projection={projection}
          rows={rows}
          foreground
          selected={rows[0]?.handle}
          onSelect={vi.fn()}
        />,
      )
      await settle()
    })
    sample = 1
    await act(async () => {
      vi.advanceTimersByTime(10_000)
      await settle()
    })

    expect(host.textContent).toContain('Recent observations are partial')
    expect(host.textContent).toContain('15 observed')
    expect(host.textContent).toContain('Not ranked')
    expect(host.textContent).toContain('Coverage: Partial coverage · 3% of 5 minutes')
    expect(host.textContent).toContain(
      'Cumulative freshness: Partial · observed just now',
    )
    expect(host.textContent).toContain('Last activity: just now')
    expect(host.textContent).not.toContain('Rank 1')
    expect(host.querySelector('.sessions-visually-hidden')?.textContent).toContain(
      '15 observed tokens in the last 5 minutes; partial coverage; exact Recent total unavailable; unranked',
    )
    const bar = host.querySelector<HTMLElement>(
      '.sessions-usage-bar[data-scale="observed"]',
    )
    expect(bar).not.toBeNull()
    expect(bar?.querySelector<HTMLElement>('.fresh-input')?.style.width).toBe(
      '66.66666666666666%',
    )
    expect(bar?.querySelector<HTMLElement>('.output')?.style.width).toBe(
      '33.33333333333333%',
    )
  })

  it('keeps the Usage ranking mount bounded at projection capacity', async () => {
    installApi({ snapshot: capacitySnapshot })
    await renderOverview({
      observation: {
        snapshot: capacityRendererSessions,
        subscribe: () => () => undefined,
      },
    })
    await act(async () => {
      button('Usage').click()
      await settle()
    })

    expect(host.textContent).toContain(
      `Showing 1–40 of ${MAX_SESSIONS_PROJECTION_ROWS} sessions`,
    )
    expect(host.querySelectorAll('.sessions-usage-ranking > li')).toHaveLength(40)
    expect(
      host.querySelectorAll('.sessions-usage-ranking > li[tabindex="0"]'),
    ).toHaveLength(1)

    const last = host.querySelectorAll<HTMLElement>('.sessions-usage-ranking > li')[39]
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
    expect(host.querySelectorAll('.sessions-usage-ranking > li')).toHaveLength(40)
    expect(document.activeElement).toBe(
      host.querySelector('.sessions-usage-ranking > li'),
    )
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

    expect(host.textContent).toContain('Hostgpu-east-1 · Connected')
    expect(host.textContent).toContain('Modelgpt-5.6-sol')
    expect(host.textContent).toContain('Provider capability unavailable')
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
  const value: SessionsTerminalSurfaceLease = {
    renew: vi.fn(() => true),
    attach,
    detach,
    setVisible,
    focus,
    subscribe: () => () => undefined,
    release,
  }
  return { value, attach, detach, setVisible, focus, release }
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
): Promise<void> {
  await act(async () => {
    root.render(
      <SessionsOverview
        observation={{
          snapshot: rendererSessions,
          subscribe: () => () => undefined,
        }}
        surface={{ acquire: () => undefined }}
        onReturn={vi.fn()}
        onOpened={vi.fn()}
        onFocusOpened={vi.fn(() => Promise.resolve(true))}
        onOpenFailed={vi.fn()}
        {...overrides}
      />,
    )
    await settle()
  })
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
