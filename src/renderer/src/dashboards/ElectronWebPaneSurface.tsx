import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type ComponentType,
  type ReactElement,
  type Ref,
} from 'react'

import type {
  WebPaneSurface,
  WebPaneSurfaceHandle,
  WebPaneSurfaceProps,
} from './web-pane-surface'

interface WebViewElement extends HTMLElement {
  src: string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
}

const WebViewTag = 'webview' as unknown as ComponentType<{
  readonly ref: Ref<WebViewElement>
  readonly className: string
  readonly name: string
  readonly src: string
  readonly partition: string
}>

/** The only renderer module allowed to know that v1 uses Electron <webview>. */
export const ElectronWebPaneSurface: WebPaneSurface = forwardRef<
  WebPaneSurfaceHandle,
  WebPaneSurfaceProps
>(function ElectronWebPaneSurface(
  { paneId, partition, initialUrl, onNavigate, onTitle, onDiagnostic },
  forwardedRef,
): ReactElement {
  const guestRef = useRef<WebViewElement | null>(null)
  const callbacks = useRef({ onNavigate, onTitle, onDiagnostic })
  callbacks.current = { onNavigate, onTitle, onDiagnostic }

  useImperativeHandle(
    forwardedRef,
    () => ({
      navigate: (url) => {
        const guest = guestRef.current
        if (guest) guest.src = url
      },
      back: () => {
        const guest = guestRef.current
        if (guest?.canGoBack()) guest.goBack()
      },
      forward: () => {
        const guest = guestRef.current
        if (guest?.canGoForward()) guest.goForward()
      },
      reload: () => guestRef.current?.reload(),
    }),
    [],
  )

  useEffect(() => {
    const guest = guestRef.current
    if (!guest) return
    const navigation = (event: Event): void => {
      const url = (event as Event & { url?: string }).url
      if (url) callbacks.current.onNavigate(url)
    }
    const title = (event: Event): void => {
      const value = (event as Event & { title?: string }).title?.trim()
      if (value) callbacks.current.onTitle(value)
    }
    const failed = (event: Event): void => {
      const detail = event as Event & {
        errorCode?: number
        errorDescription?: string
        validatedURL?: string
        isMainFrame?: boolean
      }
      if (detail.isMainFrame === false || detail.errorCode === -3) return
      callbacks.current.onDiagnostic({
        kind: 'navigation-error',
        message: detail.errorDescription ?? `Navigation failed (${detail.errorCode})`,
        url: detail.validatedURL,
      })
    }
    const consoleMessage = (event: Event): void => {
      const detail = event as Event & { level?: number; message?: string }
      if ((detail.level ?? 0) < 2 || !detail.message) return
      callbacks.current.onDiagnostic({
        kind: 'console',
        level: detail.level === 3 ? 'error' : 'warning',
        message: detail.message,
      })
    }
    const crashed = (event: Event): void => {
      const reason = (event as Event & { reason?: string }).reason ?? 'unknown reason'
      callbacks.current.onDiagnostic({
        kind: 'crash',
        message: `Guest renderer exited: ${reason}`,
      })
    }
    guest.addEventListener('did-navigate', navigation)
    guest.addEventListener('did-navigate-in-page', navigation)
    guest.addEventListener('page-title-updated', title)
    guest.addEventListener('did-fail-load', failed)
    guest.addEventListener('console-message', consoleMessage)
    guest.addEventListener('render-process-gone', crashed)
    return () => {
      guest.removeEventListener('did-navigate', navigation)
      guest.removeEventListener('did-navigate-in-page', navigation)
      guest.removeEventListener('page-title-updated', title)
      guest.removeEventListener('did-fail-load', failed)
      guest.removeEventListener('console-message', consoleMessage)
      guest.removeEventListener('render-process-gone', crashed)
    }
  }, [])

  return (
    <WebViewTag
      ref={guestRef}
      className="web-pane-frame"
      name={paneId}
      src={initialUrl}
      partition={partition}
    />
  )
})
