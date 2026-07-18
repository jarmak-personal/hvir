import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'

export interface WebViewState {
  readonly id: string
  /** Dedupe key — one pane per forwarded server port. */
  readonly linkKey: string
  readonly title: string
  readonly url: string
  readonly tunnelId?: string
}

/**
 * `window.open` targets that must reach the OS browser instead of a web pane.
 * The workbench routes loopback `window.open` calls into panes; this named
 * target is the escape hatch for the pane's own "open in browser" button.
 */
export const EXTERNAL_OPEN_TARGET = 'hvir-external'

/**
 * A server view rendered inside the viewer pane. The guest is an Electron
 * <webview> — a top-level page, so apps that (rightly) send
 * X-Frame-Options/frame-ancestors still render — pointed at a loopback URL
 * (the SSH tunnel's local end). Main confines guests to `http://127.0.0.1`
 * and strips preload/node access via will-attach-webview.
 *
 * The toolbar's path field is editable so endpoints without in-app
 * navigation (for example an experimental `/reef` route) stay reachable;
 * the origin is pinned to the tunnel.
 */
export function WebPane({
  view,
  focused,
  onToggleFocus,
  onTitle,
}: {
  readonly view: WebViewState
  readonly focused: boolean
  readonly onToggleFocus: () => void
  readonly onTitle: (title: string) => void
}): ReactElement {
  const [reloadGeneration, setReloadGeneration] = useState(0)
  const guestRef = useRef<(HTMLElement & { src?: string }) | null>(null)
  const editingRef = useRef(false)
  const onTitleRef = useRef(onTitle)
  onTitleRef.current = onTitle
  const origin = useMemo(() => new URL(view.url).origin, [view.url])
  const [pathInput, setPathInput] = useState(() => pathOf(view.url))

  // Re-clicking a link for this pane's port with a different path updates
  // view.url; navigate the live guest imperatively rather than trusting
  // attribute diffing on the custom element.
  useEffect(() => {
    setPathInput(pathOf(view.url))
    const guest = guestRef.current
    if (guest && guest.src !== view.url) guest.src = view.url
  }, [view.url])

  // Follow the guest's own navigation so the field always shows where it is,
  // and let the page title name the pane's tab.
  useEffect(() => {
    const guest = guestRef.current
    if (!guest) return
    const followNavigation = (event: Event): void => {
      const url = (event as Event & { url?: string }).url
      if (!url || editingRef.current) return
      try {
        const parsed = new URL(url)
        if (parsed.origin === origin) {
          setPathInput(parsed.pathname + parsed.search + parsed.hash)
        }
      } catch {
        // Non-URL navigation targets never reach the guest; ignore.
      }
    }
    const followTitle = (event: Event): void => {
      const title = (event as Event & { title?: string }).title?.trim()
      if (title) onTitleRef.current(title)
    }
    guest.addEventListener('did-navigate', followNavigation)
    guest.addEventListener('did-navigate-in-page', followNavigation)
    guest.addEventListener('page-title-updated', followTitle)
    return () => {
      guest.removeEventListener('did-navigate', followNavigation)
      guest.removeEventListener('did-navigate-in-page', followNavigation)
      guest.removeEventListener('page-title-updated', followTitle)
    }
  }, [origin, reloadGeneration])

  const navigate = (): void => {
    const trimmed = pathInput.trim()
    const target = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
    const guest = guestRef.current
    if (guest) guest.src = `${origin}${target}`
  }

  return (
    <div className="web-pane">
      <div className="web-pane-toolbar">
        <span className="web-pane-origin" title={origin}>
          {origin}
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
          onClick={() => setReloadGeneration((generation) => generation + 1)}
        >
          ⟳
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
          title="Open in browser"
          onClick={() =>
            window.open(`${origin}${pathInput || '/'}`, EXTERNAL_OPEN_TARGET)
          }
        >
          ↗
        </button>
      </div>
      <webview
        key={reloadGeneration}
        ref={guestRef}
        className="web-pane-frame"
        src={view.url}
        partition="persist:hvir-dashboards"
        allowpopups
      />
    </div>
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
