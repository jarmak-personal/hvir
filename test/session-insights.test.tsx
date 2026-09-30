// @vitest-environment happy-dom

import {
  act,
  useEffect,
  useSyncExternalStore,
  type ComponentProps,
  type ReactElement,
} from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CompactionMarkers } from '../src/renderer/src/harness/CompactionMarkers'
import { compactionMarkerPresentation } from '../src/renderer/src/harness/compaction-marker-presentation'
import { SessionDetailsPopover } from '../src/renderer/src/harness/SessionDetailsPopover'
import { useSessionDetailsPopover } from '../src/renderer/src/harness/use-session-details-popover'
import { useSessionsDetailsUsage } from '../src/renderer/src/harness/use-session-details-usage'
import { SessionsOverviewCard } from '../src/renderer/src/sessions/SessionsOverviewCard'
import type { SessionsProjectionCoordinator } from '../src/renderer/src/sessions/sessions-projection-coordinator'
import { TerminalRail } from '../src/renderer/src/terminal/TerminalRail'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsProjectHandle,
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  contextHarnessSnapshot,
  localPath,
  sessionsWorkspaceQualifier,
  type SessionsProjectionRow,
  type SessionsProjectionSnapshot,
} from '../src/shared'
import type { TerminalSession } from '../src/renderer/src/terminal/terminal-workspace-model'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('compaction marker presentation', () => {
  it('keeps zero empty and switches exact 20 and 200+ totals at narrow widths', () => {
    expect(compactionMarkerPresentation(0, 100)).toEqual({ kind: 'empty', count: 0 })
    expect(compactionMarkerPresentation(1, 10)).toEqual({ kind: 'circles', count: 1 })
    expect(compactionMarkerPresentation(5, 50)).toEqual({ kind: 'circles', count: 5 })
    expect(compactionMarkerPresentation(5, 50, 12)).toEqual({
      kind: 'summary',
      count: 5,
    })
    expect(compactionMarkerPresentation(20, 100)).toEqual({ kind: 'summary', count: 20 })
    expect(compactionMarkerPresentation(237, 800)).toEqual({
      kind: 'summary',
      count: 237,
    })
  })

  it('distinguishes known zero from unavailable without rendering a zero circle', () => {
    act(() =>
      root.render(
        <CompactionMarkers
          fact={{
            status: 'available',
            value: { observedCount: 0, periodStartedAt: 1, coverage: 'continuous' },
          }}
        />,
      ),
    )
    expect(document.querySelector('.compaction-marker')).toBeNull()
    expect(
      document.querySelector('.compaction-markers')?.getAttribute('aria-label'),
    ).toContain('0 observed')

    act(() =>
      root.render(
        <CompactionMarkers
          fact={{ status: 'unavailable', reason: 'source-unavailable' }}
        />,
      ),
    )
    expect(document.querySelector('.compaction-marker-unknown')?.textContent).toBe('–')

    act(() => root.render(<CompactionMarkers fact={{ status: 'unsupported' }} />))
    expect(
      document.querySelector('.compaction-markers')?.getAttribute('aria-label'),
    ).toContain('unsupported')
  })

  it('renders matching facts with independent overflow in a rail row and Sessions card', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const width = this.classList.contains('session-card-compactions') ? 400 : 40
      return DOMRect.fromRect({ width, height: 10 })
    })
    const row = projectedRow(20)
    act(() =>
      root.render(
        <>
          <TerminalRail
            label="main"
            visible
            compact={false}
            onCompact={vi.fn()}
            terminalTheme="app"
            recoveryReady
            available
            menuOpen={false}
            sessionsProjection={staticProjection(row)}
            moveMenuOpen={false}
            moveTargets={[]}
            launchMenuEntries={[]}
            split={false}
            sessions={[terminalSession(20)]}
            activeId="terminal-one"
            providers={[
              {
                id: asHarnessProviderId('codex'),
                displayName: 'Codex',
                default: true,
                capabilities: {
                  sessionIdentity: 'preassigned',
                  exactResume: true,
                  contextPresentation: 'pressure',
                  compactionObservation: true,
                },
                terminalInput: {
                  modifiedKeyProtocol: 'csi-u',
                  metaEnterAliasesControl: false,
                },
                profileGuidance: { reservedArguments: [] },
              },
            ]}
            profiles={[]}
            onSplit={vi.fn()}
            onOpenSettings={vi.fn()}
            onToggleMenu={vi.fn()}
            onToggleMoveMenu={vi.fn()}
            onPlanMove={vi.fn()}
            onDismissNewTargets={vi.fn()}
            onAddSession={vi.fn()}
            onAddHarness={vi.fn()}
            onRefreshProbes={vi.fn()}
            onOpenHarnessSettings={vi.fn()}
            onFocusSession={vi.fn()}
            onMoveSession={vi.fn()}
            onCloseSession={vi.fn()}
          />
          <article className="session-card">
            <SessionsOverviewCard row={row} group="none" opening={false} />
          </article>
        </>,
      ),
    )

    const markers = [...document.querySelectorAll<HTMLElement>('.compaction-markers')]
    expect(markers).toHaveLength(2)
    expect(markers.map((marker) => marker.getAttribute('aria-label'))).toEqual([
      '20 observed compactions during this app observation period',
      '20 observed compactions during this app observation period',
    ])
    expect(markers[0]?.dataset.state).toBe('summary')
    expect(markers[0]?.textContent).toContain('×20')
    expect(markers[1]?.dataset.state).toBe('circles')
    expect(markers[1]?.querySelectorAll('.compaction-marker')).toHaveLength(20)
  })
})

describe('session details popover interaction', () => {
  it('opens only on context gestures, stays open across pointer leave, and restores focus', () => {
    act(() => root.render(<Fixture />))
    const origin = document.querySelector<HTMLButtonElement>('[data-origin]')!
    origin.focus()
    void act(() => origin.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    void act(() =>
      origin.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 30,
          clientY: 40,
        }),
      ),
    )
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('10 / 100 assumed · 10%')
    expect(dialog.textContent).toContain('12')
    expect(dialog.textContent).toContain('23')
    expect(dialog.textContent).toContain('34')
    expect(dialog.textContent).toContain('45')
    expect(dialog.textContent).toContain('Reasoning output detail')
    expect(dialog.textContent).toContain('6')
    void act(() => dialog.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    void act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(origin)

    void act(() =>
      origin.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'F10',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    expect(
      document.querySelector<HTMLButtonElement>('[aria-label="Close session details"]'),
    ).toBe(document.activeElement)
  })

  it('keeps a rail request open while its projection lease becomes available', async () => {
    const calls: string[] = []
    const projection = unavailableProjectionThenAvailable(projectedRow(0), calls)
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke: vi.fn(() => Promise.resolve(true)),
        on: vi.fn(() => () => undefined),
      },
    })
    act(() => root.render(<TerminalRail {...terminalRailProps(projection)} />))

    await act(async () => {
      document
        .querySelector<HTMLElement>('.terminal-list-row')
        ?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 30,
            clientY: 40,
          }),
        )
      await flushMicrotasks()
    })

    expect(calls).toEqual(['projection:acquire'])
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Terminal one',
    )
  })

  it('dismisses an unavailable rail request and releases its projection lease', async () => {
    const calls: string[] = []
    const projection = unavailableProjection(calls)
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke: vi.fn(() => Promise.resolve(true)),
        on: vi.fn(() => () => undefined),
      },
    })
    act(() => root.render(<TerminalRail {...terminalRailProps(projection)} />))

    await act(async () => {
      document
        .querySelector<HTMLElement>('.terminal-list-row')
        ?.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 30,
            clientY: 40,
          }),
        )
      await flushMicrotasks()
    })

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(calls).toEqual(['projection:acquire', 'projection:release'])
  })
})

describe('session details usage demand', () => {
  it('acquires only while active and releases usage before its borrowed projection', async () => {
    const terminal = asSessionsTerminalHandle('terminal-one')
    const pty = asSessionsPtyHandle('pty-one')
    const calls: string[] = []
    const projection = projectionStub(terminal, pty, calls)
    const invoke = vi.fn(
      (channel: string, request: { demandGeneration: number }): Promise<unknown> => {
        calls.push(channel)
        if (channel === 'sessions:usage-observe') {
          return Promise.resolve({
            version: 1,
            demandGeneration: request.demandGeneration,
            revision: 1,
            sampledAt: 10,
            rows: [
              {
                handle: terminal,
                usage: {
                  status: 'exact',
                  observedAt: 10,
                  value: { freshInputTokens: 99 },
                },
              },
            ],
          })
        }
        return Promise.resolve(true)
      },
    )
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke,
        on: vi.fn(() => () => undefined),
      },
    })

    await act(async () => {
      root.render(
        <TerminalUsageFixture active terminalId={terminal} projection={projection} />,
      )
      await flushMicrotasks()
    })
    expect(document.querySelector('output')?.textContent).toBe('99')
    expect(calls.slice(0, 2)).toEqual(['projection:acquire', 'sessions:usage-observe'])
    expect(calls).not.toContain('sessions:observe')
    expect(calls).not.toContain('sessions:open')

    await act(async () => {
      root.render(
        <TerminalUsageFixture
          active={false}
          terminalId={terminal}
          projection={projection}
        />,
      )
      await flushMicrotasks()
    })
    expect(calls.slice(-2)).toEqual(['sessions:usage-release', 'projection:release'])
  })

  it('does not demand usage for a disconnected projected host', async () => {
    const terminal = asSessionsTerminalHandle('terminal-disconnected')
    const pty = asSessionsPtyHandle('pty-disconnected')
    const calls: string[] = []
    const projection = projectionStub(terminal, pty, calls, 'disconnected')
    const invoke = vi.fn(() => Promise.resolve(true))
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { invoke, on: vi.fn(() => () => undefined) },
    })

    await act(async () => {
      root.render(
        <TerminalUsageFixture active terminalId={terminal} projection={projection} />,
      )
      await flushMicrotasks()
    })

    expect(calls).toEqual(['projection:acquire'])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects a late usage result after demand and identity are revoked', async () => {
    const terminal = asSessionsTerminalHandle('terminal-late')
    const pty = asSessionsPtyHandle('pty-late')
    const calls: string[] = []
    const projection = projectionStub(terminal, pty, calls)
    let resolveObserve: ((value: unknown) => void) | undefined
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke: vi.fn(
          (channel: string, request: { demandGeneration: number }): Promise<unknown> => {
            calls.push(channel)
            if (channel !== 'sessions:usage-observe') return Promise.resolve(true)
            return new Promise((resolve) => {
              resolveObserve = resolve
            }).then(() => ({
              version: 1,
              demandGeneration: request.demandGeneration,
              revision: 1,
              sampledAt: 10,
              rows: [
                {
                  handle: terminal,
                  usage: {
                    status: 'exact',
                    observedAt: 10,
                    value: { freshInputTokens: 77 },
                  },
                },
              ],
            }))
          },
        ),
        on: vi.fn(() => () => undefined),
      },
    })

    await act(async () => {
      root.render(
        <TerminalUsageFixture active terminalId={terminal} projection={projection} />,
      )
      await flushMicrotasks()
    })
    await act(async () => {
      root.render(
        <TerminalUsageFixture
          active={false}
          terminalId={terminal}
          projection={projection}
        />,
      )
      resolveObserve?.(true)
      await flushMicrotasks()
    })

    expect(document.querySelector('output')?.textContent).toBe('')
    expect(calls.slice(-2)).toEqual(['sessions:usage-release', 'projection:release'])
  })
})

function Fixture(): ReactElement {
  const controller = useSessionDetailsPopover('fixture')
  return (
    <>
      <button
        data-origin
        type="button"
        onContextMenu={(event) => controller.openFromPointer(event, 'one')}
        onKeyDown={(event) => controller.openFromKeyboard(event, 'one')}
      >
        Session
      </button>
      <SessionDetailsPopover
        controller={controller}
        details={
          controller.request
            ? {
                title: 'Session',
                provider: 'Codex',
                profile: 'Default',
                model: { status: 'available', value: { id: 'gpt' } },
                workspace: 'Worktree',
                host: 'Local',
                state: 'live',
                context: {
                  status: 'available',
                  value: { usedTokens: 10 },
                },
                compactions: {
                  status: 'available',
                  value: { observedCount: 1, periodStartedAt: 1, coverage: 'continuous' },
                },
                freshness: { status: 'available', value: { staleAfterMs: 30_000 } },
                usage: {
                  status: 'exact',
                  value: {
                    freshInputTokens: 12,
                    cacheReadInputTokens: 23,
                    cacheWriteInputTokens: 34,
                    outputTokens: 45,
                    reasoningTokens: 6,
                  },
                  observedAt: 2,
                },
                pressurePolicy: {
                  assumedWindowTokens: 100,
                  warningPercent: 40,
                  criticalPercent: 70,
                },
              }
            : undefined
        }
      />
    </>
  )
}

function TerminalUsageFixture({
  active,
  terminalId,
  projection,
}: {
  readonly active: boolean
  readonly terminalId: string
  readonly projection: SessionsProjectionCoordinator
}): ReactElement {
  const snapshot = useSyncExternalStore(
    projection.subscribe,
    projection.snapshot,
    projection.snapshot,
  )
  const row =
    snapshot.status === 'available'
      ? snapshot.rows.find((candidate) => String(candidate.handle) === terminalId)
      : undefined
  const usage = useSessionsDetailsUsage(row, snapshot, active)
  useEffect(() => {
    if (active) return projection.acquire()
  }, [active, projection])
  const value =
    usage?.status === 'exact' || usage?.status === 'partial' || usage?.status === 'stale'
      ? usage.value.freshInputTokens
      : undefined
  return <output>{value}</output>
}

function projectionStub(
  terminal: ReturnType<typeof asSessionsTerminalHandle>,
  pty: ReturnType<typeof asSessionsPtyHandle>,
  calls: string[],
  connectionState: 'connected' | 'disconnected' = 'connected',
): SessionsProjectionCoordinator {
  let active = false
  let listener: (() => void) | undefined
  const inactive: SessionsProjectionSnapshot = {
    version: 1,
    demandGeneration: 0,
    revision: 0,
    sourceRevision: 0,
    status: 'inactive',
    workspaces: [],
    rows: [],
  }
  const available = {
    version: 1,
    demandGeneration: 1,
    revision: 1,
    sourceRevision: 1,
    status: 'available',
    workspaces: [],
    rows: [
      {
        handle: terminal,
        connectionState,
        livePty: { handle: pty, rendererOwnerId: 1, rendererGeneration: 2 },
      },
    ],
  } as unknown as SessionsProjectionSnapshot
  return {
    subscribe: (next: () => void) => {
      listener = next
      return () => {
        listener = undefined
      }
    },
    snapshot: () => (active ? available : inactive),
    acquire: () => {
      calls.push('projection:acquire')
      active = true
      queueMicrotask(() => listener?.())
      return () => {
        calls.push('projection:release')
        active = false
      }
    },
  } as unknown as SessionsProjectionCoordinator
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function projectedRow(count: number): SessionsProjectionRow {
  return {
    handle: asSessionsTerminalHandle('terminal-one'),
    project: { id: asSessionsProjectHandle('project-one'), name: 'hvir' },
    workspace: {
      id: asSessionsWorkspaceHandle('workspace-one'),
      name: 'main',
      main: true,
      qualifier: sessionsWorkspaceQualifier(1, 0, 0),
    },
    host: {
      id: 'local',
      label: 'Local',
      kind: 'local',
      connectionState: 'connected',
    },
    provider: {
      id: asHarnessProviderId('codex'),
      name: 'Codex',
      kind: 'agent',
      contextPressure: {
        assumedWindowTokens: 100,
        warningPercent: 40,
        criticalPercent: 70,
      },
    },
    profile: {
      status: 'available',
      value: {
        id: asHarnessProfileId('codex-default'),
        displayName: 'Codex default',
      },
    },
    title: 'Terminal one',
    lifecycle: 'live',
    connectionState: 'connected',
    attention: { status: 'available', value: 'none' },
    working: { status: 'available', value: false },
    model: { status: 'available', value: { id: 'gpt-5' } },
    context: { status: 'available', value: { usedTokens: 10, windowTokens: 100 } },
    compactions: {
      status: 'available',
      value: { observedCount: count, periodStartedAt: 1, coverage: 'continuous' },
    },
    turn: { status: 'available', value: { state: 'idle' } },
    telemetryFreshness: { status: 'available', value: { staleAfterMs: 30_000 } },
    usage: { status: 'pending', reason: 'identity-pending' },
  }
}

function terminalSession(count: number): TerminalSession {
  const telemetry = contextHarnessSnapshot({
    providerId: asHarnessProviderId('codex'),
    context: { usedTokens: 10, windowTokens: 100 },
    sessionId: 'terminal-one',
    provenance: 'test',
  })
  return {
    id: 'terminal-one',
    providerId: asHarnessProviderId('codex'),
    profileId: asHarnessProfileId('codex-default'),
    launchRevision: 1,
    capabilities: {
      sessionIdentity: 'preassigned',
      exactResume: true,
      contextPresentation: 'pressure',
      compactionObservation: true,
    },
    fallbackTitle: 'Codex · main',
    title: 'Terminal one',
    status: 'running',
    identityStatus: 'identified',
    resumeOnStart: false,
    pane: 'primary',
    cwd: localPath('/repo'),
    telemetry: {
      ...telemetry,
      facets: {
        ...telemetry.facets,
        compactions: {
          status: 'available',
          value: { observedCount: count, periodStartedAt: 1, coverage: 'continuous' },
        },
      },
    },
  }
}

function staticProjection(row: SessionsProjectionRow): SessionsProjectionCoordinator {
  const snapshot: SessionsProjectionSnapshot = {
    version: 1,
    demandGeneration: 1,
    revision: 1,
    sourceRevision: 1,
    status: 'available',
    workspaces: [],
    rows: [row],
  }
  return {
    subscribe: () => () => undefined,
    snapshot: () => snapshot,
    acquire: () => () => undefined,
  } as unknown as SessionsProjectionCoordinator
}

function unavailableProjectionThenAvailable(
  row: SessionsProjectionRow,
  calls: string[],
): SessionsProjectionCoordinator {
  let active = false
  let listener: (() => void) | undefined
  const unavailable: SessionsProjectionSnapshot = {
    version: 1,
    demandGeneration: 0,
    revision: 0,
    sourceRevision: 0,
    status: 'unavailable',
    workspaces: [],
    rows: [],
  }
  const available: SessionsProjectionSnapshot = {
    version: 1,
    demandGeneration: 1,
    revision: 1,
    sourceRevision: 1,
    status: 'available',
    workspaces: [],
    rows: [row],
  }
  return {
    subscribe: (next: () => void) => {
      listener = next
      return () => {
        listener = undefined
      }
    },
    snapshot: () => (active ? available : unavailable),
    acquire: () => {
      calls.push('projection:acquire')
      active = true
      queueMicrotask(() => listener?.())
      return () => {
        calls.push('projection:release')
        active = false
      }
    },
  } as unknown as SessionsProjectionCoordinator
}

function unavailableProjection(calls: string[]): SessionsProjectionCoordinator {
  const snapshot: SessionsProjectionSnapshot = {
    version: 1,
    demandGeneration: 1,
    revision: 1,
    sourceRevision: 1,
    status: 'unavailable',
    workspaces: [],
    rows: [],
  }
  return {
    subscribe: () => () => undefined,
    snapshot: () => snapshot,
    acquire: () => {
      calls.push('projection:acquire')
      return () => calls.push('projection:release')
    },
  } as unknown as SessionsProjectionCoordinator
}

function terminalRailProps(
  sessionsProjection: SessionsProjectionCoordinator,
): ComponentProps<typeof TerminalRail> {
  return {
    label: 'main',
    visible: true,
    compact: false,
    onCompact: vi.fn(),
    terminalTheme: 'app',
    recoveryReady: true,
    available: true,
    menuOpen: false,
    sessionsProjection,
    moveMenuOpen: false,
    moveTargets: [],
    launchMenuEntries: [],
    split: false,
    sessions: [terminalSession(0)],
    activeId: 'terminal-one',
    providers: [],
    profiles: [],
    onSplit: vi.fn(),
    onOpenSettings: vi.fn(),
    onToggleMenu: vi.fn(),
    onToggleMoveMenu: vi.fn(),
    onPlanMove: vi.fn(),
    onDismissNewTargets: vi.fn(),
    onAddSession: vi.fn(),
    onAddHarness: vi.fn(),
    onRefreshProbes: vi.fn(),
    onOpenHarnessSettings: vi.fn(),
    onFocusSession: vi.fn(),
    onMoveSession: vi.fn(),
    onCloseSession: vi.fn(),
  }
}
