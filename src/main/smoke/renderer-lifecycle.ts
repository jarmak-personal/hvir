import type { BrowserWindow } from 'electron'

import type { ProjectHost } from '../project-host'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { WebPaneRouteRegistry } from '../web-pane/web-pane-route-registry'
import type { HostPath } from '../../shared'

export async function verifyRendererLifecycleCleanup(options: {
  readonly win: BrowserWindow
  readonly initialGeneration: number
  readonly resources: RendererResourceScopes
  readonly routes: WebPaneRouteRegistry
  readonly supervisor: PtySupervisor
  readonly root: HostPath
  readonly host: ProjectHost
}): Promise<void> {
  const { win, initialGeneration, resources, routes, supervisor, root, host } = options
  const owner = resources.currentOwner(win.webContents.id)
  if (owner.generation <= initialGeneration) {
    throw new Error('renderer reload did not advance its resource generation')
  }
  const route = await routes.open({
    ownerId: owner.id,
    ownerGeneration: owner.generation,
    sourceTerminalId: supervisor.list()[0]?.id ?? 'smoke-recovery-shell',
    workspaceRoot: root,
    host,
    url: 'http://localhost:61337/renderer-destruction',
  })
  if (!routes.has(route.paneId, owner.id, owner.generation)) {
    throw new Error('renderer-owned web route was not registered')
  }

  const destroyed = new Promise<void>((resolve) =>
    win.webContents.once('destroyed', () => resolve()),
  )
  win.destroy()
  await timeout(destroyed, 'window webContents was not destroyed')
  await waitFor(
    () => !routes.has(route.paneId, owner.id, owner.generation),
    'webContents destruction left an owner web route alive',
  )
  if (supervisor.list().length !== 0) {
    throw new Error('window close left an orphaned PTY')
  }
}

async function timeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 15_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}
