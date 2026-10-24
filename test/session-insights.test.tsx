// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { compactionMarkerPresentation } from '../src/renderer/src/harness/compaction-marker-presentation'
import { SessionsOverviewCard } from '../src/renderer/src/sessions/SessionsOverviewCard'
import { TerminalRail } from '../src/renderer/src/terminal/TerminalRail'
import { terminalStartedStatus } from '../src/renderer/src/terminal/terminal-runtime-launch'
import {
  asHostId,
  hostPath,
  asHarnessProfileId,
  asHarnessProviderId,
  asSessionsProjectHandle,
  asSessionsTerminalHandle,
  asSessionsWorkspaceHandle,
  contextHarnessSnapshot,
  localPath,
  sessionsWorkspaceQualifier,
  type SessionsProjectionRow,
  type StartPtyResponse,
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
  it.each(['local', 'ssh'] as const)(
    'offers Rename without activating or opening details for %s sessions',
    (hostKind) => {
      const props = terminalRailProps()
      const session = { ...terminalSession(1), customName: 'Named session' }
      const invoke = vi.fn(() => Promise.resolve())
      Object.defineProperty(window, 'hvir', {
        configurable: true,
        value: { invoke, on: vi.fn(() => () => undefined) },
      })
      act(() =>
        root.render(
          <TerminalRail
            {...props}
            sessions={[
              {
                ...session,
                cwd: hostPath(
                  asHostId(hostKind === 'local' ? 'local' : 'ssh:fixture'),
                  '/repo',
                ),
              },
            ]}
          />,
        ),
      )
      const button = document.querySelector<HTMLButtonElement>('.terminal-list-main')!
      act(() => {
        button.focus()
        button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
        button.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }),
        )
        button.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
        )
      })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      const rename = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!
      expect(rename.textContent).toBe('Rename…')
      expect(document.activeElement).toBe(rename)
      expect(props.onFocusSession).not.toHaveBeenCalled()
      act(() => rename.click())
      expect(
        document.querySelector<HTMLInputElement>('[role="dialog"] input')?.value,
      ).toBe('Named session')
      const cancel = [
        ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
      ].find((entry) => entry.textContent === 'Cancel')!
      act(() => cancel.click())
      expect(invoke).not.toHaveBeenCalled()
      expect(props.onFocusSession).not.toHaveBeenCalled()
      act(() => button.click())
      expect(props.onFocusSession).toHaveBeenCalledWith(session.id)
      expect(document.querySelector('.compaction-markers')?.textContent?.trim()).toBe(
        '×1',
      )
    },
  )

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
              {...terminalRailProps()}
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

  it.each([1, 5, 237])('renders one icon and ×%i on both surfaces', (count) => {
    const row = projectedRow(count)
    act(() =>
      root.render(
        <>
          <TerminalRail
            {...terminalRailProps()}
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

  it.each(
    [
      { mode: 'fresh', result: {}, context: {}, label: '' },
      {
        mode: 'reattached',
        result: { reattached: true },
        context: {},
        label: 'Reattached',
      },
      { mode: 'resumed', result: { resumed: true }, context: {}, label: 'Resumed' },
      {
        mode: 'replacement',
        result: {},
        context: { replacement: { sessionId: 'new', replacesSessionId: 'old' } },
        label: 'New session',
      },
      { mode: 'fork', result: {}, context: { fork: true }, label: 'Forked' },
      {
        mode: 'resume fallback',
        result: {},
        context: { resume: true },
        label: 'New session',
      },
      {
        mode: 'manual restart',
        result: {},
        context: { manualRestart: true },
        label: 'Restarted',
      },
      { mode: 'reconnect', result: {}, context: { reconnect: true }, label: 'New shell' },
    ].flatMap((variant) => [4321, -1].map((pid) => ({ ...variant, pid }))),
  )('hides the real $mode launch PID $pid while retaining its status', (variant) => {
    const session = terminalSession(1)
    const result: Extract<StartPtyResponse, { outcome: 'started' }> = {
      outcome: 'started',
      id: session.id,
      instanceId: 'pty-one',
      pid: variant.pid,
      resumed: false,
      reattached: false,
      identityStatus: 'identified',
      capabilities: session.capabilities,
      ...variant.result,
    }
    const status = terminalStartedStatus(result, {
      fork: false,
      resume: false,
      manualRestart: false,
      reconnect: false,
      ...variant.context,
    })
    act(() =>
      root.render(
        <TerminalRail
          {...terminalRailProps()}
          sessions={[{ ...session, status, identityStatus: 'unavailable' }]}
        />,
      ),
    )
    expect(document.querySelector('.terminal-list-profile')?.textContent).toBe(
      `Missing (codex-default)${variant.label ? ` · ${variant.label}` : ''} · resume unavailable`,
    )
    expect(document.querySelector('.terminal-list-meta')?.textContent).not.toContain(
      'pid',
    )
    expect(document.querySelector('.compaction-markers')?.textContent?.trim()).toBe('×1')
  })

  it.each([
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
          {...terminalRailProps()}
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

  it('retains a positive stale, gapped inline observation', () => {
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
          {...terminalRailProps()}
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
  })
})

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

function terminalRailProps(): ComponentProps<typeof TerminalRail> {
  return {
    label: 'main',
    visible: true,
    compact: false,
    onCompact: vi.fn(),
    terminalTheme: 'app',
    recoveryReady: true,
    available: true,
    menuOpen: false,
    moveMenuOpen: false,
    moveTargets: [],
    launchMenuEntries: [],
    split: false,
    sessions: [terminalSession(0)],
    activeId: 'terminal-one',
    providers: [],
    profiles: [],
    onSplit: vi.fn(),
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
