// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkbenchHealthControl } from '../src/renderer/src/health/WorkbenchHealthControl'
import type {
  DiagnosticEvidenceState,
  HvirApi,
  WorkbenchHealthSnapshot,
} from '../src/shared'

const OCCURRENCE = '019c0000-0000-7000-8000-000000000090'
const CORRELATION = '019c0000-0000-7000-8000-000000000091'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('WorkbenchHealthControl', () => {
  it('shows distinct health state and acknowledges only by explicit action', async () => {
    const acknowledge = vi.fn(() => acknowledgedSnapshot())
    const listeners = new Set<(snapshot: WorkbenchHealthSnapshot) => void>()
    const invoke = vi.fn((channel: string) => {
      if (channel === 'workbench-health:acknowledge') {
        return Promise.resolve(acknowledge())
      }
      if (channel === 'diagnostic-evidence:get') {
        return Promise.resolve(diagnosticEvidence())
      }
      if (channel === 'diagnostic-evidence:delete') {
        return Promise.resolve({
          ok: true,
          outcome: 'deleted',
          state: diagnosticEvidence(),
        })
      }
      return Promise.resolve(openSnapshot())
    })
    const api = {
      diagnostics: {
        recordRenderContainment: vi.fn(),
      },
      invoke,
      send: vi.fn(),
      on: vi.fn(
        (channel: string, callback: (snapshot: WorkbenchHealthSnapshot) => void) => {
          if (channel === 'workbench-health:state') listeners.add(callback)
          return () => listeners.delete(callback)
        },
      ),
    } as unknown as HvirApi
    Object.defineProperty(window, 'hvir', { configurable: true, value: api })

    await act(async () => {
      root.render(<WorkbenchHealthControl />)
      await Promise.resolve()
    })
    const toggle = host.querySelector<HTMLButtonElement>('.workbench-health-toggle')!
    expect(toggle.getAttribute('aria-label')).toContain('1 unresolved fault')

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(acknowledge).not.toHaveBeenCalled()

    act(() => toggle.click())
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      'Renderer exited unexpectedly',
    )
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(CORRELATION)
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      'Classification: crashed',
    )
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      '/local/app-data/runtime-diagnostics.jsonl',
    )
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      '4 × 1 MiB, retained for 7 days',
    )

    await act(async () => {
      button('Acknowledge').click()
      await Promise.resolve()
    })
    expect(acknowledge).toHaveBeenCalledOnce()
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('acknowledged')

    act(() => {
      for (const listener of listeners) listener(unavailableSnapshot())
    })
    expect(toggle.getAttribute('aria-label')).toContain('evidence unavailable')

    await act(async () => {
      button('Delete local evidence').click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('diagnostic-evidence:delete', undefined)
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      'Local diagnostic evidence deleted',
    )
  })
})

function openSnapshot(): WorkbenchHealthSnapshot {
  return snapshot('open')
}

function acknowledgedSnapshot(): WorkbenchHealthSnapshot {
  return snapshot('acknowledged')
}

function unavailableSnapshot(): WorkbenchHealthSnapshot {
  return { version: 1, evidence: 'unavailable', dropped: 0, items: [] }
}

function diagnosticEvidence(): DiagnosticEvidenceState {
  return {
    version: 1,
    availability: 'durable',
    recent: { maxEvents: 256, maxBytes: 248 * 1024 },
    journal: {
      location: '/local/app-data/runtime-diagnostics.jsonl',
      maxSegments: 4,
      maxSegmentBytes: 1024 * 1024,
      retentionHours: 168,
    },
  }
}

function snapshot(state: 'open' | 'acknowledged'): WorkbenchHealthSnapshot {
  return {
    version: 1,
    evidence: 'durable',
    dropped: 0,
    items: [
      {
        occurrenceId: OCCURRENCE,
        kind: 'renderer-process-exited',
        classification: 'crashed',
        owner: 'window-manager',
        ownerId: 7,
        ownerGeneration: 2,
        severity: 'critical',
        state,
        firstObservedAt: '2026-07-22T12:00:00.000Z',
        lastObservedAt: '2026-07-22T12:00:00.000Z',
        count: 1,
        correlation: CORRELATION,
      },
    ],
  }
}

function button(label: string): HTMLButtonElement {
  const candidate = [...host.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  )
  if (!(candidate instanceof HTMLButtonElement)) throw new Error(`Missing ${label}`)
  return candidate
}
