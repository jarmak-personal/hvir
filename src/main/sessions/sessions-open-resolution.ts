import {
  hostPathEquals,
  type ProjectState,
  type SessionsObservationSnapshot,
  type SessionsOpenRequest,
  type SessionsOpenUnavailableReason,
  type SessionsObservedSession,
} from '../../shared'
import type { RendererOwner } from '../renderer-resource-scopes'
import type { SessionsProjectionIdentityScope } from './sessions-projection-identities'

export type SessionsResolvedOpen =
  | {
      readonly outcome: 'resolved'
      readonly projectId: string
      readonly workspaceId: string
      readonly handle: SessionsOpenRequest['handle']
      readonly workspaceQualifier: SessionsOpenRequest['workspaceQualifier']
      readonly livePty: NonNullable<SessionsOpenRequest['livePty']>
    }
  | { readonly outcome: 'unavailable'; readonly reason: SessionsOpenUnavailableReason }

export function resolveSessionsOpen({
  owner,
  request,
  activeDemandGeneration,
  sourceRevision,
  observation,
  identities,
  projectState,
}: {
  readonly owner: RendererOwner
  readonly request: SessionsOpenRequest
  readonly activeDemandGeneration?: number
  readonly sourceRevision: number
  readonly observation?: Omit<
    SessionsObservationSnapshot,
    'demandGeneration' | 'revision'
  >
  readonly identities?: SessionsProjectionIdentityScope
  readonly projectState: ProjectState
}): SessionsResolvedOpen {
  if (
    activeDemandGeneration !== request.demandGeneration ||
    request.sourceRevision !== sourceRevision ||
    !observation ||
    !identities
  ) {
    return { outcome: 'unavailable', reason: 'stale-projection' }
  }
  const observed = observation.sessions.find(
    (session) => session.handle === request.handle,
  )
  const workspace = observation.workspaces.find(
    (candidate) =>
      candidate.projectId === request.projectId &&
      candidate.workspaceId === request.workspaceId &&
      candidate.qualifier === request.workspaceQualifier,
  )
  if (!observed || observed.workspaceId !== request.workspaceId) {
    return { outcome: 'unavailable', reason: 'session-unavailable' }
  }
  if (!workspace || workspace.closed || workspace.missing) {
    return { outcome: 'unavailable', reason: 'workspace-unavailable' }
  }
  if (workspace.host.connectionState !== 'connected') {
    return { outcome: 'unavailable', reason: 'connection-unavailable' }
  }
  if (
    observed.lifecycle !== 'live' ||
    !request.livePty ||
    !sameLivePty(observed.livePty, request.livePty) ||
    request.livePty.rendererOwnerId !== owner.id ||
    request.livePty.rendererGeneration !== owner.generation
  ) {
    return { outcome: 'unavailable', reason: 'terminal-unavailable' }
  }
  const projectRoot = identities.resolveProject(request.projectId)
  const workspaceRoot = identities.resolveWorkspace(request.workspaceId)
  const project = projectRoot
    ? projectState.projects.find((candidate) =>
        hostPathEquals(candidate.registeredRoot, projectRoot),
      )
    : undefined
  const target = workspaceRoot
    ? project?.workspaces.find((candidate) =>
        hostPathEquals(candidate.root, workspaceRoot),
      )
    : undefined
  if (!project || !target || target.closed || target.missing) {
    return { outcome: 'unavailable', reason: 'workspace-unavailable' }
  }
  return {
    outcome: 'resolved',
    projectId: project.id,
    workspaceId: target.id,
    handle: request.handle,
    workspaceQualifier: request.workspaceQualifier,
    livePty: request.livePty,
  }
}

function sameLivePty(
  left: SessionsObservedSession['livePty'],
  right: NonNullable<SessionsOpenRequest['livePty']>,
): boolean {
  return (
    left?.handle === right.handle &&
    left.rendererOwnerId === right.rendererOwnerId &&
    left.rendererGeneration === right.rendererGeneration
  )
}
