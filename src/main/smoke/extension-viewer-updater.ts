import type { BrowserWindow } from 'electron'
import type { ExtensionItemValue } from '../../shared/extensions/contract'
import { focusSmokeWindow } from './window-focus'

/** Real viewer demand owns refresh even while the terminal rail is compact. */
export async function verifyExtensionViewerUpdaterRenewal({
  win,
  viewerId,
  controls,
  dom,
  observation,
  failure,
}: {
  win: BrowserWindow
  viewerId: string
  controls: {
    click(name: string): Promise<void>
    wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  }
  dom(this: void, expression: string): Promise<boolean>
  observation(
    this: void,
  ): Pick<ExtensionItemValue, 'availability' | 'observedAt'> | undefined
  failure(this: void, baseline: number | undefined): void
}): Promise<void> {
  if (
    !(await dom(
      'document.querySelector(\'button[aria-label="Restore terminal rail"]\') !== null',
    ))
  )
    throw new Error(
      'Visible-viewer independent demand lacked compact-rail positive control',
    )
  const viewerObserved = observation()!.observedAt!
  try {
    await controls.wait(
      () => (observation()?.observedAt ?? 0) > viewerObserved,
      'visible viewer refresh with compact rail',
    )
  } catch (error) {
    try {
      failure(viewerObserved)
    } catch {
      /* Failure evidence cannot replace the original renewal error. */
    }
    throw error
  }
  await controls.click('Sessions')
  await controls.wait(
    () =>
      observation()?.availability === 'stale' &&
      dom(
        `document.querySelector('[data-extension-view="${viewerId}"]')?.hidden === true`,
      ),
    'last ordinary contribution hidden with compact rail',
  )
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const viewerFrozen = observation()!.observedAt
  await new Promise((resolve) => setTimeout(resolve, 2200))
  if (observation()!.observedAt !== viewerFrozen)
    throw new Error('Hidden last viewer retained updater refresh')
  await focusSmokeWindow(win, 'window')
  await win.webContents.executeJavaScript(
    "document.querySelector('.project-tab-main').click()",
  )
  try {
    await controls.wait(
      () =>
        observation()?.availability === 'current' &&
        observation()!.observedAt! > viewerFrozen!,
      'visible ordinary viewer demand renewed',
    )
  } catch (error) {
    try {
      failure(viewerFrozen)
    } catch {
      /* Failure evidence cannot replace the original renewal error. */
    }
    throw error
  }
}
