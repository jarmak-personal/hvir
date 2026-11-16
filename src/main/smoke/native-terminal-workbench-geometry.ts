import type { BrowserWindow } from 'electron'
import type { NativeTerminalGeometry } from '../../shared/native-terminal'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import { nativeSelectionBrowser, paneScript } from './native-terminal-selection-browser'

/** The workbench Surface demands frames after its update acknowledges PTY resize.
 * Native geometry can precede that boundary; this observation never waits. */
export function nativeWorkbenchGeometryReadiness(
  win: BrowserWindow,
  ptys: PtySupervisor,
  native: NativeTerminalApplication,
  managed: ManagedPty,
): () => Promise<NativeTerminalGeometry | undefined> {
  const sessionId = managed.id,
    instanceId = managed.instanceId,
    pid = managed.pid,
    ownerId = managed.ownerId,
    ownerGeneration = managed.ownerGeneration,
    handle = native.sessions.get(sessionId)?.handle,
    contents = win.webContents,
    frame = contents.mainFrame,
    browser = nativeSelectionBrowser(win, native, managed)
  let viewId: string | undefined
  const assertCurrent = () => {
    if (
      win.isDestroyed() ||
      contents.isDestroyed() ||
      frame.isDestroyed() ||
      win.webContents !== contents ||
      contents.mainFrame !== frame
    )
      throw new Error('native-workbench-geometry-document')
    const live = ptys.get(sessionId),
      record = native.sessions.get(sessionId)
    if (
      !handle ||
      !live ||
      live.id !== sessionId ||
      live.instanceId !== instanceId ||
      live.pid !== pid ||
      live.ownerId !== ownerId ||
      live.ownerGeneration !== ownerGeneration ||
      !record ||
      record.handle !== handle ||
      record.retiring ||
      record.unavailable ||
      record.session.sessionId !== sessionId ||
      record.session.instanceId !== instanceId ||
      record.session.ownerId !== ownerId ||
      record.session.ownerGeneration !== ownerGeneration
    )
      throw new Error('native-workbench-geometry-owner')
  }
  assertCurrent()
  return async function read(): Promise<NativeTerminalGeometry | undefined> {
    assertCurrent()
    // Pin the DOM view before an inspection can be refused as known unsent.
    if (viewId === undefined) {
      const observed: unknown = await contents.executeJavaScript(
        `(()=>{${paneScript(sessionId, true)}return viewId;})()`,
      )
      assertCurrent()
      if (observed === undefined) return undefined
      if (typeof observed !== 'string' || !observed)
        throw new Error('native-workbench-geometry-view')
      viewId = observed
    }
    const layout = await browser.layoutWhenReady()
    assertCurrent()
    if (!layout) return undefined
    if (layout.bounds.viewId !== viewId) throw new Error('native-workbench-geometry-view')
    const drawn = native.targets.drawn(viewId, frame)
    const { geometry, bounds } = layout
    if (
      !drawn ||
      drawn.geometrySerial !== geometry.serial ||
      Math.fround(bounds.dpr) !== geometry.backingScale ||
      Math.round(bounds.width * bounds.dpr) !== geometry.width ||
      Math.round(bounds.height * bounds.dpr) !== geometry.height ||
      bounds.canvasWidth !== geometry.width ||
      bounds.canvasHeight !== geometry.height ||
      Math.round(bounds.canvasCssWidth * bounds.dpr) !== geometry.width ||
      Math.round(bounds.canvasCssHeight * bounds.dpr) !== geometry.height
    )
      return undefined
    return Object.freeze({ ...geometry })
  }
}
