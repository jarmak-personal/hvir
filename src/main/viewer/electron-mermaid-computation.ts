import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, session, webContents } from 'electron'
import type { MermaidRenderRequest } from '../../shared/presentation/mermaid-contract'
import {
  assertMermaidOutput,
  MERMAID_LIMITS,
} from '../../shared/presentation/mermaid-contract'
import type { MermaidComputation, MermaidComputationPort } from './mermaid-render-owner'
import { isMermaidComputationAsset } from './mermaid-computation-assets'

/** One partition/process per job. No preload, project reads, page IPC, or live surface. */
export class ElectronMermaidComputation implements MermaidComputationPort {
  private readonly partitionPrefix = randomUUID()
  private readonly slots = new Set<number>()
  start(request: MermaidRenderRequest): MermaidComputation {
    const slot = Array.from(
      { length: MERMAID_LIMITS.activeJobs },
      (_, index) => index,
    ).find((index) => !this.slots.has(index))
    if (slot === undefined) throw new Error('Diagram computation capacity reached')
    const isolatedSession = session.fromPartition(
      `diagram-${this.partitionPrefix}-${slot}`,
      { cache: false },
    )
    let window: BrowserWindow | undefined
    let disposed = false
    let separate = false
    let computing = false
    let rejectStopped: (error: Error) => void = () => undefined
    const fail = (): void => rejectStopped(new Error('Diagram computation stopped'))
    const denyDownload = (event: Electron.Event): void => event.preventDefault()
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      fail()
      if (window && !window.isDestroyed()) {
        const guest = window.webContents
        if (!guest.isDestroyed() && separate && computing) guest.forcefullyCrashRenderer()
        window.destroy()
      }
      isolatedSession.removeListener('will-download', denyDownload)
      isolatedSession.webRequest.onBeforeRequest((_details, callback) =>
        callback({ cancel: true }),
      )
      this.slots.delete(slot)
    }
    try {
      this.slots.add(slot)
      const entry = process.env.ELECTRON_RENDERER_URL
        ? new URL('mermaid.html', process.env.ELECTRON_RENDERER_URL).href
        : pathToFileURL(join(__dirname, '../renderer/mermaid.html')).href
      isolatedSession.setPermissionCheckHandler(() => false)
      isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      )
      isolatedSession.setDevicePermissionHandler(() => false)
      isolatedSession.setDisplayMediaRequestHandler((_request, callback) => callback({}))
      isolatedSession.on('will-download', denyDownload)
      isolatedSession.webRequest.onBeforeRequest((details, callback) => {
        // Vite's immutable dependency query is admitted only for module requests.
        const url = new URL(details.url)
        if (process.env.ELECTRON_RENDERER_URL && /^(?:\?v=[a-f0-9]+)?$/.test(url.search))
          url.search = ''
        callback({ cancel: !isMermaidComputationAsset(url.href, entry) })
      })
      window = new BrowserWindow({
        show: false,
        focusable: false,
        skipTaskbar: true,
        webPreferences: {
          session: isolatedSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          backgroundThrottling: false,
        },
      })
      const guest = window.webContents
      guest.setWindowOpenHandler(() => ({ action: 'deny' }))
      guest.on('will-navigate', (event) => event.preventDefault())
      guest.on('will-redirect', (event) => event.preventDefault())
      guest.on('will-attach-webview', (event) => event.preventDefault())
      const stopped = new Promise<never>((_resolve, reject) => {
        rejectStopped = reject
      })
      guest.once('render-process-gone', fail)
      guest.once('destroyed', fail)
      const result = Promise.race([
        stopped,
        (async () => {
          await window.loadURL(entry)
          if (disposed) throw new Error('Diagram computation cancelled')
          const pid = guest.getOSProcessId()
          if (
            !pid ||
            webContents
              .getAllWebContents()
              .some(
                (other) =>
                  other !== guest &&
                  !other.isDestroyed() &&
                  other.getOSProcessId() === pid,
              )
          )
            throw new Error('Diagram computation process isolation unavailable')
          separate = true
          computing = true
          try {
            const svg: unknown = await guest.executeJavaScript(
              `window.renderDiagram(${JSON.stringify(request)})`,
            )
            assertMermaidOutput(svg)
            return svg
          } finally {
            computing = false
          }
        })(),
      ])
      return { result, dispose }
    } catch (error) {
      dispose()
      throw error
    }
  }
}
