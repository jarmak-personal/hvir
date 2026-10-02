import { createHash } from 'node:crypto'
import { hostPathEquals, type ProjectState, type HostPath } from '../../shared'
import {
  EXTENSION_LIMITS,
  type ExtensionContext,
  type ExtensionSessionContext,
  type ExtensionWorkspaceContext,
} from '../../shared/extensions/contract'
import type { ExtensionSurfaceRequest } from '../../shared/extensions/workbench'
import type { PtyObservationSource } from '../pty/pty-supervisor'
import type { RendererOwner } from '../renderer-resource-scopes'
import type {
  TerminalSessionObservationSource,
  TerminalSessionStore,
} from '../terminal/session-registry'

export interface ExtensionContextSources {
  readonly projectState: () => ProjectState
  readonly ptys: PtyObservationSource
  readonly sessions: Pick<TerminalSessionStore, 'get'> & TerminalSessionObservationSource
  readonly observeProjects: (listener: () => void) => () => void
}
export interface AdmittedExtensionContext {
  readonly value: ExtensionContext
  readonly root?: HostPath
  readonly current: () => boolean
}

/** Read-only metadata adaptation. Existing project and PTY owners retain identity and authority. */
export class ExtensionContextOwner {
  constructor(private readonly sources: ExtensionContextSources) {}

  sessions(owner: RendererOwner): readonly ExtensionSessionContext[] {
    return boundedExtensionSessions(
      this.sources.ptys
        .observationSnapshot()
        .flatMap(({ info }) => {
          if (info.ownerId !== owner.id || info.ownerGeneration !== owner.generation)
            return []
          const workspace = this.workspaceForRoot(info.workspaceRoot)
          if (!workspace) return []
          const stored = this.sources.sessions.get(info.id)
          return [
            {
              id: sessionIdentity(info),
              title: (stored?.title ?? 'Terminal').slice(0, 80),
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
    const disposers = [
      this.sources.ptys.observe(listener),
      this.sources.sessions.observe(listener),
      this.sources.observeProjects(listener),
    ]
    return () => {
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

function sessionIdentity(info: import('../pty/pty-supervisor').ManagedPty): string {
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
