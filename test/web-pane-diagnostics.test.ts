import { describe, expect, it } from 'vitest'

import {
  MAX_WEB_PANE_DIAGNOSTICS,
  MAX_WEB_PANE_DIAGNOSTIC_TEXT,
  appendWebPaneDiagnostic,
  redactedWebPaneDiagnosticUrl,
  reviewedWebPaneConsoleDiagnostic,
  webPaneDiagnosticReport,
  type WebPaneDiagnosticRow,
} from '../src/renderer/src/dashboards/web-pane-diagnostics'
import { localPath } from '../src/shared'

describe('web pane diagnostic policy', () => {
  it('bounds retained rows and copies only the closed diagnostic fields', () => {
    let rows: readonly WebPaneDiagnosticRow[] = []
    for (let index = 0; index < MAX_WEB_PANE_DIAGNOSTICS + 5; index++) {
      const event = {
        kind: 'console' as const,
        level: 'warning' as const,
        message: `${index}:${'x'.repeat(MAX_WEB_PANE_DIAGNOSTIC_TEXT + 20)}`,
        body: 'excluded body',
        cookie: 'excluded cookie',
        header: 'excluded header',
        formValue: 'excluded form',
        dom: 'excluded DOM',
        credentials: 'excluded credentials',
        url: 'http://user:secret@localhost/private?token=hidden#form-value',
      }
      rows = appendWebPaneDiagnostic(rows, event, index)
    }

    expect(rows).toHaveLength(MAX_WEB_PANE_DIAGNOSTICS)
    expect(rows[0]?.message.startsWith('5:')).toBe(true)
    expect(rows.at(-1)?.message).toHaveLength(MAX_WEB_PANE_DIAGNOSTIC_TEXT)
    expect(rows.every((row) => row.url === undefined)).toBe(true)
    expect(JSON.stringify(rows)).not.toMatch(
      /excluded (body|cookie|header|form|DOM|credentials)|user|secret|token|hidden|form-value/,
    )
  })

  it('accepts only reviewed warning and error console levels', () => {
    expect(reviewedWebPaneConsoleDiagnostic(0, 'guest trace')).toBeUndefined()
    expect(reviewedWebPaneConsoleDiagnostic(1, 'guest info')).toBeUndefined()
    expect(reviewedWebPaneConsoleDiagnostic(2, 'guest warning')).toEqual({
      kind: 'console',
      level: 'warning',
      message: 'guest warning',
    })
    expect(reviewedWebPaneConsoleDiagnostic(3, 'guest failure')).toEqual({
      kind: 'console',
      level: 'error',
      message: 'guest failure',
    })
    expect(reviewedWebPaneConsoleDiagnostic(3, '')).toBeUndefined()
  })

  it('redacts credentials, query values, and fragments from reviewed reports', () => {
    const report = webPaneDiagnosticReport(
      {
        origin: 'http://localhost:5173',
        workspaceRoot: localPath('/repo'),
        sourceTerminalId: 'terminal-1',
      },
      [
        {
          at: 0,
          kind: 'request-failure',
          message: 'Navigation blocked',
          url: 'http://user:secret@localhost:5173/private?token=hidden#form-value',
        },
      ],
    )

    expect(redactedWebPaneDiagnosticUrl('not a url')).toBe('[invalid URL]')
    expect(report).toContain('http://localhost:5173/private')
    expect(report).not.toMatch(/user|secret|token|hidden|form-value/)
  })
})
