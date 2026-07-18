import type { ForwardRefExoticComponent, RefAttributes } from 'react'
import type { WebPaneDiagnosticEvent } from '../../../shared'

export interface WebPaneSurfaceHandle {
  navigate(url: string): void
  back(): void
  forward(): void
  reload(): void
}

export interface WebPaneSurfaceProps {
  readonly paneId: string
  readonly partition: string
  readonly initialUrl: string
  readonly onNavigate: (url: string) => void
  readonly onTitle: (title: string) => void
  readonly onDiagnostic: (event: WebPaneDiagnosticEvent) => void
}

/** Swappable guest boundary; product state never depends on a webview element. */
export type WebPaneSurface = ForwardRefExoticComponent<
  WebPaneSurfaceProps & RefAttributes<WebPaneSurfaceHandle>
>
