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
