// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DiagnosticReportDialog } from '../src/renderer/src/diagnostics/DiagnosticReportDialog'
import { DIAGNOSTIC_REPORT_NOTICE, type DiagnosticReportState } from '../src/shared'

const REPORT_ID = '019c0000-0000-7000-8000-000000000091'
const DATA_URL = 'data:image/png;base64,AQ=='

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(REPORT_ID)
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

describe('DiagnosticReportDialog', () => {
  it('previews exactly before explicit copy/save and masks owned surfaces on capture', async () => {
    const onClose = vi.fn()
    const invoke = vi.fn((channel: string) => {
      if (channel === 'diagnostic-report:create') {
        return Promise.resolve({ ok: true, state: reportState() })
      }
      if (channel === 'diagnostic-report:capture') {
        return Promise.resolve({ ok: true, state: reportState(true) })
      }
      if (channel === 'diagnostic-report:delete') {
        return Promise.resolve({ ok: true, outcome: 'deleted' })
      }
      return Promise.resolve({ ok: true, outcome: 'copied' })
    })
    Object.defineProperty(window, 'hvir', {
      configurable: true,
      value: { invoke },
    })
    ownedSurface('terminal', rectangle(0, 220, 320, 80))
    ownedSurface('web-pane', rectangle(320, 0, 100, 300))
    ownedSurface('viewer', rectangle(10, 20, 300, 200))
    ownedSurface('project-navigation', rectangle(1, 2, 30, 40))
    legacySelectorSurface('viewer', rectangle(400, 20, 20, 20))
    legacySelectorSurface('project-navigation', rectangle(400, 40, 20, 20))

    await act(async () => {
      root.render(<DiagnosticReportDialog onClose={onClose} />)
      await Promise.resolve()
    })

    expect(invoke).toHaveBeenCalledWith('diagnostic-report:create', {
      reportId: REPORT_ID,
    })
    expect(invoke).not.toHaveBeenCalledWith(
      'diagnostic-report:capture',
      expect.anything(),
    )
    expect(host.textContent).toContain('No screenshot is captured by default.')
    expect(host.querySelector('pre')?.textContent).toBe(
      JSON.stringify(reportState().artifact.report, null, 2),
    )

    await act(async () => {
      button('Copy exact artifact').click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('diagnostic-report:copy', {
      reportId: REPORT_ID,
    })

    await act(async () => {
      button('Capture masked screenshot').click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('diagnostic-report:capture', {
      reportId: REPORT_ID,
      masks: [
        { surface: 'terminal', x: 0, y: 220, width: 320, height: 80 },
        { surface: 'web-pane', x: 320, y: 0, width: 100, height: 300 },
        { surface: 'viewer', x: 10, y: 20, width: 300, height: 200 },
        { surface: 'project-navigation', x: 1, y: 2, width: 30, height: 40 },
      ],
    })
    expect(host.querySelector('img')?.getAttribute('src')).toBe(DATA_URL)
    expect(host.textContent).toContain('terminal, web-pane, viewer, project-navigation')
    expect(host.textContent).toContain(
      'Masks are based on the workbench layout measured immediately before capture',
    )

    await act(async () => {
      button('Delete temporary report').click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('diagnostic-report:delete', {
      reportId: REPORT_ID,
    })
    expect(onClose).toHaveBeenCalledOnce()
  })
})

function reportState(withScreenshot = false): DiagnosticReportState {
  return {
    artifact: {
      report: {
        version: 1,
        reportId: REPORT_ID,
        notice: DIAGNOSTIC_REPORT_NOTICE,
        createdAt: '2026-07-22T12:00:00.000Z',
        application: {
          version: '0.1.4',
          electronVersion: '37.2.6',
          chromeVersion: '138.0.7204.251',
          platform: 'linux',
          architecture: 'x64',
          mode: 'packaged',
        },
        renderer: {
          ownerId: 7,
          ownerGeneration: 3,
          surface: 'workbench-health',
        },
        diagnostics: { schemaVersion: 1, events: [], dropped: [] },
        health: { version: 1, evidence: 'durable', items: [], dropped: 0 },
      },
      ...(withScreenshot
        ? {
            screenshot: {
              mediaType: 'image/png' as const,
              width: 1,
              height: 1,
              bytes: 1,
              sha256: '1'.repeat(64),
              dataUrl: DATA_URL,
              masked: [
                'terminal' as const,
                'web-pane' as const,
                'viewer' as const,
                'project-navigation' as const,
              ],
            },
          }
        : {}),
    },
    storage: { location: 'Application data', retentionHours: 24 },
  }
}

function ownedSurface(
  surface: 'project-navigation' | 'viewer' | 'terminal' | 'web-pane',
  bounds: DOMRect,
): void {
  const element = document.createElement('div')
  element.dataset['diagnosticCapture'] = surface
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(bounds)
  document.body.append(element)
}

function legacySelectorSurface(
  surface: 'project-navigation' | 'viewer',
  bounds: DOMRect,
): void {
  const element = document.createElement('div')
  if (surface === 'viewer') element.dataset['viewerPane'] = 'primary'
  else element.className = 'tree-panel'
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(bounds)
  document.body.append(element)
}

function rectangle(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    right: x + width,
    bottom: y + height,
    left: x,
    toJSON: () => ({}),
  }
}

function button(label: string): HTMLButtonElement {
  const candidate = [...host.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === label,
  )
  if (!(candidate instanceof HTMLButtonElement)) throw new Error(`Missing ${label}`)
  return candidate
}
