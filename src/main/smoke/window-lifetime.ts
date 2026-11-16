import { verifyRendererReadiness } from './renderer-readiness'
import type { ElectronSmokeDependencies } from './bootstrap-contract'
import type { BrowserWindow } from 'electron'
import type { SmokeCleanup } from './cleanup'

/** Own the scenario window, its native readiness and observed renderer replacements. */
export async function createSmokeWindow(
  ports: Pick<
    ElectronSmokeDependencies,
    'createWindow' | 'webPaneRoutes' | 'rendererResources'
  >,
  cleanup: SmokeCleanup,
  ready: (phase: 'window-ready' | 'renderer-ready', window: BrowserWindow) => void,
): Promise<{
  readonly window: BrowserWindow
  readonly discardedGenerations: () => number
  readonly generation: number
}> {
  let discarded = 0
  const window = ports.createWindow(() => {
    discarded++
  })
  cleanup.defer('smoke window', async () => {
    if (window.isDestroyed()) return
    const ownerId = window.webContents.id
    // Window destruction also starts owner revocation, but its event callback
    // cannot await it. Settle that real lifecycle before later smoke resources
    // (Supervisor/native host) retire producers used by captured cleanup.
    const failures: unknown[] = []
    try {
      await ports.rendererResources.revokeOwner(ownerId)
    } catch (error) {
      failures.push(error)
    }
    try {
      await ports.webPaneRoutes.closeOwner(ownerId)
    } catch (error) {
      failures.push(error)
    } finally {
      window.destroy()
    }
    if (failures.length)
      throw new AggregateError(failures, 'Smoke window owner cleanup failed')
  })
  await new Promise<void>((resolve) => window.once('ready-to-show', resolve))
  const generation = ports.rendererResources.currentOwner(
    window.webContents.id,
  ).generation
  ready('window-ready', window)
  console.log('[smoke] window ready-to-show OK')
  await verifyRendererReadiness(window)
  ready('renderer-ready', window)
  return { window, generation, discardedGenerations: () => discarded }
}
