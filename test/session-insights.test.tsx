// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CompactionMarkers } from '../src/renderer/src/harness/CompactionMarkers'
import { compactionMarkerPresentation } from '../src/renderer/src/harness/compaction-marker-presentation'
import { SessionDetailsPopover } from '../src/renderer/src/harness/SessionDetailsPopover'
import { useSessionDetailsPopover } from '../src/renderer/src/harness/use-session-details-popover'
import { useTerminalDetailsUsage } from '../src/renderer/src/harness/use-session-details-usage'
import type { SessionsProjectionCoordinator } from '../src/renderer/src/sessions/sessions-projection-coordinator'
import {
  asSessionsPtyHandle,
  asSessionsTerminalHandle,
  type SessionsProjectionSnapshot,
} from '../src/shared'

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

    act(() => root.render(<CompactionMarkers fact={{ status: 'unavailable' }} />))
    expect(document.querySelector('.compaction-marker-unknown')?.textContent).toBe('–')

    act(() => root.render(<CompactionMarkers fact={{ status: 'unsupported' }} />))
    expect(
      document.querySelector('.compaction-markers')?.getAttribute('aria-label'),
    ).toContain('unsupported')
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
  const usage = useTerminalDetailsUsage(terminalId, active, projection)
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
): SessionsProjectionCoordinator {
  let active = false
  let listener: (() => void) | undefined
  const inactive: SessionsProjectionSnapshot = {
    version: 1,
    demandGeneration: 0,
    revision: 0,
    sourceRevision: 0,
    status: 'inactive',
    rows: [],
  }
  const available = {
    version: 1,
    demandGeneration: 1,
    revision: 1,
    sourceRevision: 1,
    status: 'available',
    rows: [
      {
        handle: terminal,
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
