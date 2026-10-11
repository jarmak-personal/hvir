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

export interface PinnedWorkspaceConnectionContext extends AdmittedExtensionContext {
  readonly observeCurrent: (listener: () => void) => () => void
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
    // Launch metadata is nonsecret identity, not current workspace authorization.
    const workspace = this.sources
      .projectState()
      .projects.flatMap((project) => project.workspaces)
      .find((entry) => hostPathEquals(entry.root, info.workspaceRoot))
    return workspace
      ? { workspace: workspace.id, session: sessionIdentity(info) }
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
      const state = this.sources.projectState()
      return JSON.stringify({
        selection: [state.activeProjectId, state.activeWorkspaceId],
        registrations: state.projects.map((project) => [
          project.id,
          project.registeredRoot,
        ]),
        workspaces: state.projects.flatMap((project) =>
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

  /** Finite setup pins main selection; ordinary admitted view contexts remain independent. */
  pinWorkspaceConnection(
    context: AdmittedExtensionContext,
  ): PinnedWorkspaceConnectionContext {
    const workspace = context.value.workspace,
      root = context.root
    const state = this.sources.projectState()
    const project = state.projects.find(
      (entry) =>
        entry.id === state.activeProjectId &&
        entry.workspaces.some((entry) => entry.id === workspace?.id),
    )
    if (!workspace || !root || !project)
      throw new Error('Program connection requires the current registered project')
    const registration = project.registeredRoot,
      projectId = project.id
    let withdrawn = false
    const current = (): boolean => {
      if (withdrawn) return false
      const state = this.sources.projectState()
      const registered = state.projects.find((entry) => entry.id === projectId)
      const member = registered?.workspaces.find((entry) => entry.id === workspace.id)
      const valid =
        context.current() &&
        state.activeProjectId === projectId &&
        state.activeWorkspaceId === workspace.id &&
        !!registered &&
        hostPathEquals(registered.registeredRoot, registration) &&
        registered.activeWorkspaceId === workspace.id &&
        registered.connectionState === 'connected' &&
        !!member &&
        !member.closed &&
        !member.missing &&
        hostPathEquals(member.root, root)
      withdrawn = !valid
      return valid
    }
    if (!current()) throw new Error('Program connection project changed')
    return {
      ...context,
      current,
      observeCurrent: (listener) => {
        const changed = (): void => {
          if (!current()) listener()
        }
        const dispose = this.sources.observeProjects(changed)
        changed()
        return dispose
      },
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
          value: {
            id,
            name: workspace.name.slice(0, 80),
            host: workspace.root.hostId,
            root: workspace.root,
          },
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

/** Optional path metadata must never overflow the transport or truncate an identity. */
export function boundedExtensionContext(value: ExtensionContext): ExtensionContext {
  const bytes = (context: ExtensionContext) => Buffer.byteLength(JSON.stringify(context))
  if (bytes(value) <= EXTENSION_LIMITS.contextBytes) return value
  const withoutRoot = (
    workspace: ExtensionWorkspaceContext,
  ): ExtensionWorkspaceContext => {
    const { root: _root, ...metadata } = workspace
    return metadata
  }
  const reduced = {
    ...value,
    ...(value.session
      ? { session: { ...value.session, workspace: withoutRoot(value.session.workspace) } }
      : {}),
    ...(value.workspace ? { workspace: withoutRoot(value.workspace) } : {}),
  }
  if (bytes(reduced) > EXTENSION_LIMITS.contextBytes)
    throw new Error('Extension context exceeds the public metadata budget')
  return reduced
}
