import {
  asSessionsProjectHandle,
  asSessionsWorkspaceHandle,
  type HostPath,
  type SessionsProjectHandle,
  type SessionsWorkspaceHandle,
} from '../../shared'

export interface SessionsProjectionIdentityScope {
  project(root: HostPath): SessionsProjectHandle
  workspace(root: HostPath): SessionsWorkspaceHandle
  clear(): void
}

/** Demand-lifetime opaque identities; source host/path values never cross the projection. */
export function createSessionsProjectionIdentityScope(): SessionsProjectionIdentityScope {
  const projects = new Map<string, SessionsProjectHandle>()
  const workspaces = new Map<string, SessionsWorkspaceHandle>()
  let nextProject = 0
  let nextWorkspace = 0

  return {
    project: (root) => {
      const key = sessionsProjectionRootKey(root.hostId, root.path)
      const current = projects.get(key)
      if (current) return current
      const created = asSessionsProjectHandle(`sessions-project-${(nextProject += 1)}`)
      projects.set(key, created)
      return created
    },
    workspace: (root) => {
      const key = sessionsProjectionRootKey(root.hostId, root.path)
      const current = workspaces.get(key)
      if (current) return current
      const created = asSessionsWorkspaceHandle(
        `sessions-workspace-${(nextWorkspace += 1)}`,
      )
      workspaces.set(key, created)
      return created
    },
    clear: () => {
      projects.clear()
      workspaces.clear()
      nextProject = 0
      nextWorkspace = 0
    },
  }
}

export function sessionsProjectionRootKey(hostId: string, path: string): string {
  return `${hostId}\u0000${path}`
}
