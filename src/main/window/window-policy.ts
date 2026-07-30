import type { RendererOwner } from '../renderer-resource-scopes'

const WORKBENCH_SCROLLBAR_FEATURES = [
  'OverlayScrollbar',
  'OverlayScrollbarFlashAfterAnyScrollUpdate',
  'OverlayScrollbarFlashWhenMouseEnter',
] as const

export interface WorkbenchWindowOptions {
  readonly width: number
  readonly height: number
  readonly useContentSize: boolean
  readonly show: boolean
  readonly backgroundColor: string
  readonly autoHideMenuBar: boolean
  readonly webPreferences: {
    readonly preload: string
    readonly sandbox: boolean
    readonly contextIsolation: boolean
    readonly nodeIntegration: boolean
    readonly webviewTag: boolean
    readonly additionalArguments: string[]
  }
}

/** A recovery dialog can mutate only the renderer generation that opened it. */
export function ownsUnresponsiveRecovery(
  current: RendererOwner,
  observed: RendererOwner,
): boolean {
  return current.id === observed.id && current.generation === observed.generation
}

/** A readiness signal can complete only the exact generation encoded by its preload. */
export function ownsRendererReadiness(
  current: RendererOwner,
  reportedGeneration: number,
): boolean {
  return (
    Number.isSafeInteger(reportedGeneration) && reportedGeneration === current.generation
  )
}

/** The single security baseline used for every workbench BrowserWindow. */
export function workbenchWindowOptions(preload: string): WorkbenchWindowOptions {
  return {
    width: 1280,
    height: 800,
    useContentSize: true,
    show: false,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Webview guests support anti-framing pages and are confined by the route registry.
      webviewTag: true,
      // Keep this renderer-only: isolated web-pane guests retain their own presentation.
      additionalArguments: [
        `--enable-features=${WORKBENCH_SCROLLBAR_FEATURES.join(',')}`,
      ],
    },
  }
}
