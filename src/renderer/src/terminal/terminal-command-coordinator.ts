import {
  asHarnessProfileId,
  hostPathEquals,
  unwrapOperation,
  type HvirApi,
  type ProjectState,
} from '../../../shared'
import type { TerminalCommandRequest } from '../../../shared/ipc/terminal'
import type { TerminalWorkspaceController } from './terminal-workspace-command-port'

interface CommandPorts {
  readonly api: Pick<HvirApi, 'invoke'>
  state(): ProjectState | undefined
  accept(state: ProjectState): void
  prepare(workspace: string, forLaunch: boolean, signal: AbortSignal): Promise<void>
  release(workspace: string): void
  controller(workspace: string): TerminalWorkspaceController | undefined
}

/** Renderer materialization carries an opaque admission; it never receives command bytes. */
export class TerminalCommandCoordinator {
  private readonly pending = new Map<string, AbortController>()
  private disposed = false
  constructor(private readonly ports: CommandPorts) {}
  revoke(ticket: string): void {
    this.pending.get(ticket)?.abort()
  }
  dispose(): void {
    this.disposed = true
    for (const controller of this.pending.values()) controller.abort()
  }
  async open(request: TerminalCommandRequest): Promise<void> {
    if (this.disposed) throw new Error('Terminal command view was disposed')
    if (this.pending.has(request.ticket)) return
    const controller = new AbortController()
    this.pending.set(request.ticket, controller)
    try {
      await this.materialize(request, controller.signal)
    } finally {
      this.pending.delete(request.ticket)
    }
  }
  private async materialize(
    request: TerminalCommandRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const target = () => {
      signal.throwIfAborted()
      const state = this.ports.state()
      const project = state?.projects.find((entry) =>
        entry.workspaces.some((workspace) => workspace.id === request.workspaceId),
      )
      const workspace = project?.workspaces.find(
        (entry) => entry.id === request.workspaceId,
      )
      if (
        !project ||
        !workspace ||
        workspace.closed ||
        workspace.missing ||
        project.connectionState !== 'connected' ||
        !hostPathEquals(workspace.root, request.root)
      )
        throw new Error('Terminal command destination was revoked')
      return project
    }
    const project = target()
    const profiles = await this.ports.api.invoke('harness:profiles', {
      root: request.root,
    })
    const profile = profiles.find((entry) => entry.id === 'plain-shell-default')
    if (!profile) throw new Error('Default shell is unavailable')
    target()
    const state = unwrapOperation(
      await this.ports.api.invoke('project:switch', {
        projectId: project.id,
        workspaceId: request.workspaceId,
      }),
    )
    target()
    this.ports.accept(state)
    try {
      await this.ports.prepare(request.workspaceId, true, signal)
      target()
      if (
        !this.ports
          .controller(request.workspaceId)
          ?.launchSession?.(
            asHarnessProfileId('plain-shell-default'),
            profile.launchRevision,
            request,
          )
      )
        throw new Error('Terminal command destination is no longer ready')
    } finally {
      this.ports.release(request.workspaceId)
    }
  }
}
