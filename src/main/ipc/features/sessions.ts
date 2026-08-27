import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type SessionsIpcDeps = Pick<IpcDeps, 'rendererResources' | 'sessionsObservation'>

export function registerSessionsIpc(ipc: IpcRegistrar, deps: SessionsIpcDeps): void {
  ipc.handle('sessions:observe', (request, context) => {
    const owner = context.owner()
    deps.rendererResources.assertCurrent(owner)
    const snapshot = deps.sessionsObservation.acquire(owner, request.demandGeneration)
    try {
      deps.rendererResources.register(
        owner,
        { lifetime: 'renderer', type: 'sessions-observation' },
        () => {
          deps.sessionsObservation.release(owner, request.demandGeneration)
        },
      )
      return snapshot
    } catch (error) {
      deps.sessionsObservation.release(owner, request.demandGeneration)
      throw error
    }
  })

  ipc.handle('sessions:snapshot', (request, context) =>
    deps.sessionsObservation.snapshot(context.owner(), request.demandGeneration),
  )

  ipc.handle('sessions:release', async (request, context) => {
    const owner = context.owner()
    // Qualify the release at the observation owner before touching the renderer
    // resource. A duplicate from an older demand must not revoke a newer lease.
    if (!deps.sessionsObservation.release(owner, request.demandGeneration)) return
    await deps.rendererResources.disposeResource(owner, 'sessions-observation')
  })
}
