import type { WebContents } from 'electron'
import type { ManagedPty, PtySpawnRequest, PtySupervisor } from '../pty/pty-supervisor'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'
import { attachRendererPty, registerRendererPty } from './renderer-pty-lifecycle'
import { terminalStartedResponse } from './terminal-start-response'

export interface TerminalSessionStartDeps {
  readonly rendererResources: RendererResourceScopes
  readonly ptySupervisor: PtySupervisor
}

/** One spawn/attachment transaction shared by ordinary and explicitly prepared starts. */
export async function startTerminalSession(
  deps: TerminalSessionStartDeps,
  request: {
    readonly owner: RendererOwner
    readonly sender: WebContents
    readonly spawn: PtySpawnRequest & { readonly sessionId: string }
    readonly record: (managed: ManagedPty) => void | Promise<void>
    readonly onSpawned?: (managed: ManagedPty) => void
    readonly assertCurrent?: () => void
    readonly signal?: AbortSignal
  },
) {
  const { owner, spawn, signal } = request
  const assertCurrent = (): void => {
    deps.rendererResources.assertCurrent(owner)
    if (signal?.aborted) throw new Error('Terminal start cancelled')
    request.assertCurrent?.()
  }
  assertCurrent()
  const lease = registerRendererPty(
    deps,
    owner,
    spawn.workspaceRoot ?? spawn.cwd,
    spawn.sessionId,
  )
  const cancel = (): void => {
    void lease.dispose()
  }
  signal?.addEventListener('abort', cancel, { once: true })
  let detach: () => void | Promise<void> = () => undefined
  try {
    assertCurrent()
    const managed = await deps.ptySupervisor.spawn(spawn)
    assertCurrent()
    request.onSpawned?.(managed)
    detach = attachRendererPty(deps, managed, lease, owner, request.sender)
    await request.record(managed)
    assertCurrent()
    return terminalStartedResponse(managed, false)
  } catch (error) {
    await detach()
    await lease.dispose()
    throw error
  } finally {
    // Once returned, the ordinary terminal lease owns this session. Feature
    // revocation must not kill an already handed-off interactive terminal.
    signal?.removeEventListener('abort', cancel)
  }
}
