import type { BrowserWindow } from 'electron'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import { verifyWorkbenchHealthFault } from './workbench-health'
export function verifyWorkbenchHealthScenario(
  win: BrowserWindow,
  resources: RendererResourceScopes,
  ready: (owner: RendererOwner, generation: number) => boolean,
): Promise<string> {
  return verifyWorkbenchHealthFault(win, () => {
    const owner = resources.currentOwner(win.webContents.id)
    if (!ready(owner, owner.generation))
      throw new Error('window manager rejected smoke renderer readiness')
  })
}
