import type { RendererOwner } from '../renderer-resource-scopes'

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
  }
}

/** A recovery dialog can mutate only the renderer generation that opened it. */
export function ownsUnresponsiveRecovery(
  current: RendererOwner,
  observed: RendererOwner,
): boolean {
  return current.id === observed.id && current.generation === observed.generation
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
    },
  }
}
