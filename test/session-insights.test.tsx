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
  it.each([1, 5, 20, 237])('keeps the exact positive count %i', (count) => {
    expect(compactionMarkerPresentation(count)).toEqual({ kind: 'summary', count })
  })

  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'hides an invalid or nonpositive count %s',
    (count) => {
      expect(compactionMarkerPresentation(count)).toEqual({ kind: 'empty', count: 0 })
    },
  )

  it.each([undefined, 'pending', 'unavailable', 'unsupported', 'zero'] as const)(
    'leaves no indicator or separator on either surface for %s',
    (state) => {
      const row = projectedRow(0)
      const fact: SessionsProjectionRow['compactions'] =
        state === undefined
          ? undefined
          : state === 'zero'
            ? row.compactions
            : state === 'unsupported'
              ? { status: state }
              : { status: state, reason: 'source-unavailable' }
      const session = terminalSession(0)
      const telemetry = session.telemetry!
      act(() =>
        root.render(
          <>
            <TerminalRail
              {...terminalRailProps(staticProjection(row))}
              sessions={[
                {
                  ...session,
                  status: 'pid 4321',
                  telemetry:
                    state === undefined
                      ? undefined
                      : {
                          ...telemetry,
                          facets: { ...telemetry.facets, compactions: fact },
                        },
                },
              ]}
            />
            <article className="session-card">
              <SessionsOverviewCard
                row={{ ...row, compactions: fact }}
                group="none"
                opening={false}
              />
            </article>
          </>,
        ),
      )
      expect(document.querySelector('.compaction-markers')).toBeNull()
      expect(document.querySelector('.terminal-list-meta')?.textContent).toBe(
        'Missing (codex-default)',
      )
    },
  )

  it.each([1, 5, 237])('renders one circle and ×%i on both surfaces', (count) => {
    const row = projectedRow(count)
    act(() =>
      root.render(
        <>
          <TerminalRail
            {...terminalRailProps(staticProjection(row))}
            sessions={[
              { ...terminalSession(count), status: 'pid 4321', attention: 'idle' },
            ]}
            providers={[
              {
                id: asHarnessProviderId('codex'),
                displayName: 'Codex',
                default: true,
                capabilities: terminalSession(count).capabilities,
                terminalInput: {
                  modifiedKeyProtocol: 'csi-u',
                  metaEnterAliasesControl: false,
                },
                profileGuidance: { reservedArguments: [] },
              },
            ]}
          />
          <article className="session-card">
            <SessionsOverviewCard row={row} group="none" opening={false} />
          </article>
        </>,
      ),
    )
    const markers = [...document.querySelectorAll<HTMLElement>('.compaction-markers')]
    expect(markers).toHaveLength(2)
    for (const marker of markers) {
      expect(marker.textContent?.trim()).toBe(`×${count}`)
      expect(marker.querySelectorAll('.compaction-marker')).toHaveLength(1)
      expect(marker.getAttribute('aria-label')).toContain(`${count} observed compaction`)
    }
    expect(markers[0]?.closest('.terminal-list-meta')).not.toBeNull()
    expect(document.querySelector('.terminal-list-meta')?.textContent).not.toContain(
      'pid',
    )
    expect(document.querySelectorAll('.provider-context')).toHaveLength(2)
    expect(document.querySelector('.terminal-attention-badge')?.textContent).toBe('ready')
  })

  it.each([
    ['pid 4321', ''],
    ['Resumed · pid 4321', 'Resumed'],
    ['Reattached · pid 4321', 'Reattached'],
    ['Forked · pid 4321', 'Forked'],
    ['Starting…', 'Starting…'],
    ['Resuming…', 'Resuming…'],
    ['disconnected', 'disconnected'],
    ['Exited (1)', 'Exited (1)'],
    [
      'Resume unavailable · session data is missing',
      'Resume unavailable · session data is missing',
    ],
  ])('preserves meaningful status from %s', (status, expected) => {
    act(() =>
      root.render(
        <TerminalRail
          {...terminalRailProps(staticProjection(projectedRow(1)))}
          sessions={[{ ...terminalSession(1), status, identityStatus: 'unavailable' }]}
        />,
      ),
    )
    expect(document.querySelector('.terminal-list-profile')?.textContent).toBe(
      `Missing (codex-default)${expected ? ` · ${expected}` : ''} · resume unavailable`,
    )
    expect(document.querySelector('.terminal-list-meta')?.textContent).not.toContain(
      'pid',
    )
  })

  it('retains a positive stale, gapped observation and its details', async () => {
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: {
        invoke: vi.fn(() => Promise.resolve(true)),
        on: vi.fn(() => () => undefined),
      },
    })
    const row = projectedRow(237)
    const fact = {
      status: 'stale' as const,
      observedAt: 1,
      reason: 'source-stale' as const,
      value: { observedCount: 237, periodStartedAt: 1, coverage: 'gapped' as const },
    }
    const session = terminalSession(237)
    act(() =>
      root.render(
        <TerminalRail
          {...terminalRailProps(staticProjection({ ...row, compactions: fact }))}
          sessions={[
            {
              ...session,
              telemetry: {
                ...session.telemetry!,
                facets: { ...session.telemetry!.facets, compactions: fact },
              },
            },
          ]}
        />,
      ),
    )
    expect(document.querySelector('.compaction-markers')?.textContent?.trim()).toBe(
      '×237',
    )
    const button = document.querySelector<HTMLButtonElement>('.terminal-list-main')!
    await act(async () => {
      button.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
      )
      await flushMicrotasks()
    })
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Observed compactions237')
    expect(dialog.textContent).toContain('Current app period · gaps observed')
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
      document.querySelector<HTMLElement>('.terminal-list-row')?.dispatchEvent(
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
      document.querySelector<HTMLElement>('.terminal-list-row')?.dispatchEvent(
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
