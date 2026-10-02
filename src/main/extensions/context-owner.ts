import { createHash } from 'node:crypto'
import { hostPathEquals, type HostPath } from '../../shared'
import {
  EXTENSION_LIMITS,
  type ExtensionContext,
  type ExtensionSessionContext,
  type ExtensionWorkspaceContext,
} from '../../shared/extensions/contract'
import type { ExtensionSurfaceRequest } from '../../shared/extensions/workbench'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { LiveSessionMetadataSources } from '../terminal/live-session-metadata'

export interface AdmittedExtensionContext {
  readonly value: ExtensionContext
  readonly root?: HostPath
  readonly current: () => boolean
}

/** Read-only metadata adaptation. Existing project and PTY owners retain identity and authority. */
export class ExtensionContextOwner {
  revision = 0
  constructor(private readonly sources: LiveSessionMetadataSources) {
    if (!sources) throw new Error('Extension context admission is unavailable')
  }

  sessions(owner: RendererOwner): readonly ExtensionSessionContext[] {
    const titles = new Map(
      this.sources.sessions.observationSnapshot().map((entry) => [entry.id, entry.title]),
    )
    return boundedExtensionSessions(
      this.sources.ptys
        .observationSnapshot()
        .flatMap(({ info }) => {
          if (info.ownerId !== owner.id || info.ownerGeneration !== owner.generation)
            return []
          const workspace = this.workspaceForRoot(info.workspaceRoot)
          if (!workspace) return []
          return [
            {
              id: sessionIdentity(info),
              title: (titles.get(info.id) ?? 'Terminal').slice(0, 80),
              workspace: workspace.value,
            },
          ]
        })
        .slice(0, EXTENSION_LIMITS.sessions),
    )
  }

  terminalIds(owner: RendererOwner): Readonly<Record<string, string>> {
    return Object.fromEntries(
      this.sources.ptys
        .observationSnapshot()
        .filter(
          (entry) =>
            entry.info.ownerId === owner.id &&
            entry.info.ownerGeneration === owner.generation,
        )
        .map((entry) => [sessionIdentity(entry.info), entry.info.id]),
    )
  }

  sessionsForAll(): readonly string[] {
    return this.sources.ptys
      .observationSnapshot()
      .filter((entry) => this.workspaceForRoot(entry.info.workspaceRoot))
      .map((entry) => sessionIdentity(entry.info))
  }

  workspaces(): readonly ExtensionWorkspaceContext[] {
    return this.sources.projectState().projects.flatMap((project) =>
      project.workspaces.flatMap((entry) => {
        const workspace = this.workspace(entry.id)
        return workspace ? [workspace.value] : []
      }),
    )
  }

  sessionsForAgents(): readonly ExtensionSessionContext[] {
    const owners = new Map<string, RendererOwner>()
    for (const { info } of this.sources.ptys.observationSnapshot())
      owners.set(`${info.ownerId}:${info.ownerGeneration}`, {
        id: info.ownerId,
        generation: info.ownerGeneration,
      })
    return boundedExtensionSessions(
      [...owners.values()].flatMap((owner) => this.sessions(owner)),
    )
  }

  /** Exact live target lookup supplies a presentation qualifier, never an agent credential. */
  sessionOwner(id: string): RendererOwner | undefined {
    const entry = this.sources.ptys
      .observationSnapshot()
      .find(
        ({ info }) =>
          sessionIdentity(info) === id && this.workspaceForRoot(info.workspaceRoot),
      )
    return entry
      ? { id: entry.info.ownerId, generation: entry.info.ownerGeneration }
      : undefined
  }

  /** Shared protected launch identity, computed from supervisor-owned immutable spawn metadata. */
  launchTarget(
    info: import('../pty/pty-contract').PtyAgentTarget,
  ): { workspace: string; session: string } | undefined {
    const workspace = this.workspaceForRoot(info.workspaceRoot)
    return workspace
      ? { workspace: workspace.value.id, session: sessionIdentity(info) }
      : undefined
  }

  admit(
    owner: RendererOwner,
    request: ExtensionSurfaceRequest,
  ): AdmittedExtensionContext {
    if (!['viewer', 'left', 'top', 'popup'].includes(request.surface))
      throw new Error('Invalid extension surface')
    const workspace = request.workspaceId
      ? this.workspace(request.workspaceId)
      : undefined
    if (request.workspaceId && !workspace)
      throw new Error('Workspace context is unavailable')
    const session = request.sessionId
      ? this.sessions(owner).find((entry) => entry.id === request.sessionId)
      : undefined
    if (
      request.sessionId &&
      (!session || (workspace && session.workspace.id !== workspace.value.id))
    )
      throw new Error('Session context is stale or unavailable')
    const targetWorkspace =
      workspace ?? (session ? this.workspace(session.workspace.id) : undefined)
    const root = targetWorkspace?.root
    const value: ExtensionContext = {
      surface: request.surface,
      visible: false,
      ...(targetWorkspace ? { workspace: targetWorkspace.value } : {}),
      ...(session ? { session } : {}),
    }
    return {
      value,
      ...(root ? { root } : {}),
      current: () => {
        if (targetWorkspace) {
          const current = this.workspace(targetWorkspace.value.id)
          if (!current || !hostPathEquals(current.root, targetWorkspace.root))
            return false
        }
        if (session)
          return this.sessions(owner).some(
            (entry) =>
              entry.id === session.id && entry.workspace.id === session.workspace.id,
          )
        return true
      },
    }
  }

  observe(listener: () => void): () => void {
    const signature = () => {
      const titles = new Map(
        this.sources.sessions
          .observationSnapshot()
          .map((entry) => [entry.id, entry.title]),
      )
      return JSON.stringify({
        workspaces: this.sources
          .projectState()
          .projects.flatMap((project) =>
            project.workspaces.map((workspace) => [
              workspace.id,
              workspace.root,
              workspace.name,
              workspace.closed,
              workspace.missing,
              project.connectionState,
            ]),
          ),
        sessions: this.sources.ptys
          .observationSnapshot()
          .map(({ info }) => [
            info.id,
            info.instanceId,
            info.ownerId,
            info.ownerGeneration,
            info.workspaceRoot,
            titles.get(info.id),
          ]),
      })
    }
    let previous = signature(),
      pending = false,
      disposed = false
    const changed = () => {
      if (pending || disposed) return
      pending = true
      queueMicrotask(() => {
        pending = false
        if (disposed) return
        const current = signature()
        if (current === previous) return
        previous = current
        this.revision++
        listener()
      })
    }
    const disposers = [
      this.sources.ptys.observe(changed),
      this.sources.sessions.observe(changed),
      this.sources.observeProjects(changed),
    ]
    return () => {
      disposed = true
      for (const dispose of disposers.reverse()) void dispose()
    }
  }

  private workspace(
    id: string,
  ): { value: ExtensionWorkspaceContext; root: HostPath } | undefined {
    for (const project of this.sources.projectState().projects) {
      const workspace = project.workspaces.find((entry) => entry.id === id)
      if (
        workspace &&
        !workspace.closed &&
        !workspace.missing &&
        project.connectionState === 'connected'
      )
        return {
          value: { id, name: workspace.name.slice(0, 80), host: workspace.root.hostId },
          root: workspace.root,
        }
    }
    return undefined
  }
  private workspaceForRoot(
    root: HostPath,
  ): { value: ExtensionWorkspaceContext; root: HostPath } | undefined {
    for (const project of this.sources.projectState().projects) {
      const workspace = project.workspaces.find((entry) =>
        hostPathEquals(entry.root, root),
      )
      if (workspace) return this.workspace(workspace.id)
    }
    return undefined
  }
}

function sessionIdentity(info: import('../pty/pty-contract').PtyAgentTarget): string {
  const context = createHash('sha256')
    .update(
      JSON.stringify([
        info.ownerId,
        info.ownerGeneration,
        info.workspaceRoot.hostId,
        info.workspaceRoot.path,
      ]),
    )
    .digest('hex')
    .slice(0, 16)
  return `${info.instanceId}-${context}`
}

/** Keep metadata inside the public bridge budget even at the count limit. */
export function boundedExtensionSessions(
  sessions: readonly ExtensionSessionContext[],
): readonly ExtensionSessionContext[] {
  const admitted: ExtensionSessionContext[] = []
  for (const session of sessions.slice(0, EXTENSION_LIMITS.sessions)) {
    if (
      Buffer.byteLength(JSON.stringify([...admitted, session])) >
      EXTENSION_LIMITS.contextBytes - 128
    )
      break
    admitted.push(session)
  }
  return admitted
}
