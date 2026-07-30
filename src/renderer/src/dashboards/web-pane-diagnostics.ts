import type { HostPath, WebPaneDiagnosticEvent } from '../../../shared'

export const MAX_WEB_PANE_DIAGNOSTICS = 50
export const MAX_WEB_PANE_DIAGNOSTIC_TEXT = 1_000

export interface WebPaneDiagnosticRow {
  readonly at: number
  readonly kind: string
  readonly message: string
  readonly url?: string
}

export function reviewedWebPaneConsoleDiagnostic(
  level: number | undefined,
  message: string | undefined,
): Extract<WebPaneDiagnosticEvent, { kind: 'console' }> | undefined {
  if ((level ?? 0) < 2 || !message) return undefined
  return {
    kind: 'console',
    level: level === 3 ? 'error' : 'warning',
    message,
  }
}

export function appendWebPaneDiagnostic(
  current: readonly WebPaneDiagnosticRow[],
  event: WebPaneDiagnosticEvent | Omit<WebPaneDiagnosticRow, 'at'>,
  at = Date.now(),
): readonly WebPaneDiagnosticRow[] {
  return [
    ...current,
    {
      at,
      kind: event.kind,
      message: event.message.slice(0, MAX_WEB_PANE_DIAGNOSTIC_TEXT),
      url:
        event.kind !== 'console' && 'url' in event && event.url
          ? redactedWebPaneDiagnosticUrl(event.url)
          : undefined,
    },
  ].slice(-MAX_WEB_PANE_DIAGNOSTICS)
}

export function redactedWebPaneDiagnosticUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '[invalid URL]'
  }
}

export function webPaneDiagnosticReport(
  view: {
    readonly origin: string
    readonly workspaceRoot: HostPath
    readonly sourceTerminalId: string
  },
  diagnostics: readonly WebPaneDiagnosticRow[],
): string {
  return [
    `hvir web pane: ${view.origin}`,
    `workspace host: ${view.workspaceRoot.hostId}`,
    `source terminal: ${view.sourceTerminalId}`,
    ...diagnostics.map(
      (row) =>
        `${new Date(row.at).toISOString()} ${row.kind}: ${row.message}${row.url ? ` (${redactedWebPaneDiagnosticUrl(row.url)})` : ''}`,
    ),
  ].join('\n')
}
