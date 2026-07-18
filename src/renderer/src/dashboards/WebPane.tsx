import { useEffect, useRef, useState, type ReactElement } from 'react'

import type {
  HostPath,
  WebPaneBlockedNavigation,
  WebPaneDiagnosticEvent,
} from '../../../shared'
import { ElectronWebPaneSurface } from './ElectronWebPaneSurface'
import type { WebPaneSurface, WebPaneSurfaceHandle } from './web-pane-surface'
import { webPaneUrlFromInput } from './web-pane-url'

const MAX_DIAGNOSTICS = 50
const MAX_DIAGNOSTIC_TEXT = 1_000

export interface WebViewState {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly origin: string
  readonly partition: string
  readonly workspaceRoot: HostPath
  readonly sourceTerminalId: string
  readonly blockedNavigation?: WebPaneBlockedNavigation
  readonly routeDiagnostic?: {
    readonly revision: number
    readonly event: WebPaneDiagnosticEvent
  }
}

interface DiagnosticRow {
  readonly at: number
  readonly kind: string
  readonly message: string
  readonly url?: string
}

/** Product chrome around the swappable, hostile-content guest surface. */
export function WebPane({
  view,
  focused,
  onToggleFocus,
  onTitle,
  onBlockedNavigation,
  onOpenBrowser,
  onRevealTerminal,
  Surface = ElectronWebPaneSurface,
}: {
  readonly view: WebViewState
  readonly focused: boolean
  readonly onToggleFocus: () => void
  readonly onTitle: (title: string) => void
  readonly onBlockedNavigation: (navigation: WebPaneBlockedNavigation) => void
  readonly onOpenBrowser: (url: string) => void
  readonly onRevealTerminal: () => void
  readonly Surface?: WebPaneSurface
}): ReactElement {
  const surfaceRef = useRef<WebPaneSurfaceHandle>(null)
  const editingRef = useRef(false)
  const [pathInput, setPathInput] = useState(() => pathOf(view.url))
  const [diagnostics, setDiagnostics] = useState<readonly DiagnosticRow[]>([])
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const browserHandoffAvailable = view.workspaceRoot.hostId === 'local'

  useEffect(() => {
    setPathInput(pathOf(view.url))
    surfaceRef.current?.navigate(view.url)
  }, [view.url])

  useEffect(() => {
    if (!view.blockedNavigation) return
    appendDiagnostic(setDiagnostics, {
      kind: 'blocked-navigation',
      message: `Blocked ${view.blockedNavigation.kind} navigation`,
      url: view.blockedNavigation.url,
    })
  }, [view.blockedNavigation])

  useEffect(() => {
    if (view.routeDiagnostic) {
      appendDiagnostic(setDiagnostics, view.routeDiagnostic.event)
    }
  }, [view.routeDiagnostic])

  const navigate = (): void => {
    surfaceRef.current?.navigate(webPaneUrlFromInput(view.origin, pathInput))
  }
  const currentUrl = webPaneUrlFromInput(view.origin, pathInput)

  return (
    <div className="web-pane">
      <div className="web-pane-toolbar">
        <button
          type="button"
          aria-label="Back"
          title="Back"
          onClick={() => surfaceRef.current?.back()}
        >
          ←
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward"
          onClick={() => surfaceRef.current?.forward()}
        >
          →
        </button>
        <span className="web-pane-origin" title={view.origin}>
          {view.origin}
        </span>
        <form
          className="web-pane-path"
          onSubmit={(event) => {
            event.preventDefault()
            editingRef.current = false
            navigate()
          }}
        >
          <input
            aria-label={`Path on ${view.title}`}
            value={pathInput}
            spellCheck={false}
            onFocus={() => {
              editingRef.current = true
            }}
            onBlur={() => {
              editingRef.current = false
            }}
            onChange={(event) => setPathInput(event.target.value)}
            placeholder="/"
          />
        </form>
        <button
          type="button"
          aria-label={`Reload ${view.title}`}
          title="Reload"
          onClick={() => surfaceRef.current?.reload()}
        >
          ⟳
        </button>
        <button
          type="button"
          aria-label="Reveal source terminal"
          title="Back to terminal"
          onClick={onRevealTerminal}
        >
          &gt;_
        </button>
        <button
          type="button"
          aria-label="Web pane diagnostics"
          aria-pressed={diagnosticsOpen}
          title="Diagnostics"
          onClick={() => setDiagnosticsOpen((open) => !open)}
        >
          {diagnostics.length > 0 ? `!${diagnostics.length}` : 'ⓘ'}
        </button>
        <button
          type="button"
          aria-label={
            focused
              ? `Restore the workbench around ${view.title}`
              : `Expand ${view.title} to the full window`
          }
          aria-pressed={focused}
          title={focused ? 'Restore workbench' : 'Full page'}
          onClick={onToggleFocus}
        >
          {focused ? '⇲' : '⛶'}
        </button>
        <button
          type="button"
          aria-label={`Open ${view.title} in the browser`}
          title={
            browserHandoffAvailable
              ? 'Open in browser'
              : 'Browser handoff for SSH panes needs a compatibility route'
          }
          disabled={!browserHandoffAvailable}
          onClick={() => onOpenBrowser(currentUrl)}
        >
          ↗
        </button>
      </div>
      {view.blockedNavigation ? (
        <div className="web-pane-navigation-blocked" role="status">
          <span>
            {view.blockedNavigation.kind === 'external'
              ? `This link leaves hvir for ${hostnameOf(view.blockedNavigation.url)}.`
              : `This link uses another local server (${originOf(view.blockedNavigation.url)}).`}
          </span>
          <button
            type="button"
            onClick={() => onBlockedNavigation(view.blockedNavigation!)}
          >
            {view.blockedNavigation.kind === 'external'
              ? 'Open in system browser'
              : 'Open as web pane'}
          </button>
        </div>
      ) : null}
      {diagnosticsOpen ? (
        <section className="web-pane-diagnostics" aria-label="Web pane diagnostics">
          <div>
            <strong>Recent pane events</strong>
            <button
              type="button"
              disabled={diagnostics.length === 0}
              onClick={() =>
                void navigator.clipboard.writeText(diagnosticReport(view, diagnostics))
              }
            >
              Copy report
            </button>
          </div>
          {diagnostics.length === 0 ? (
            <p>No failures or console warnings recorded.</p>
          ) : (
            <ol>
              {diagnostics.map((row, index) => (
                <li key={`${row.at}:${index}`}>
                  <code>{row.kind}</code> {row.message}
                  {row.url ? ` — ${redactedDiagnosticUrl(row.url)}` : ''}
                </li>
              ))}
            </ol>
          )}
        </section>
      ) : null}
      <Surface
        ref={surfaceRef}
        paneId={view.id}
        partition={view.partition}
        initialUrl={view.url}
        onNavigate={(url) => {
          try {
            const parsed = new URL(url)
            if (parsed.origin === view.origin && !editingRef.current) {
              setPathInput(parsed.pathname + parsed.search + parsed.hash)
            }
          } catch {
            // Main blocks invalid top-level targets before they reach this seam.
          }
        }}
        onTitle={onTitle}
        onDiagnostic={(event) => appendDiagnostic(setDiagnostics, event)}
      />
    </div>
  )
}

function appendDiagnostic(
  update: (
    value: (current: readonly DiagnosticRow[]) => readonly DiagnosticRow[],
  ) => void,
  event: WebPaneDiagnosticEvent | Omit<DiagnosticRow, 'at'>,
): void {
  update((current) =>
    [
      ...current,
      {
        at: Date.now(),
        kind: event.kind,
        message: event.message.slice(0, MAX_DIAGNOSTIC_TEXT),
        url: 'url' in event ? event.url : undefined,
      },
    ].slice(-MAX_DIAGNOSTICS),
  )
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.pathname + parsed.search + parsed.hash
  } catch {
    return '/'
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'unknown origin'
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'another site'
  }
}

function redactedDiagnosticUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '[invalid URL]'
  }
}

function diagnosticReport(
  view: WebViewState,
  diagnostics: readonly DiagnosticRow[],
): string {
  return [
    `hvir web pane: ${view.origin}`,
    `workspace host: ${view.workspaceRoot.hostId}`,
    `source terminal: ${view.sourceTerminalId}`,
    ...diagnostics.map(
      (row) =>
        `${new Date(row.at).toISOString()} ${row.kind}: ${row.message}${row.url ? ` (${redactedDiagnosticUrl(row.url)})` : ''}`,
    ),
  ].join('\n')
}
