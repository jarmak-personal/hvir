import type { HostPath } from '../shared'
import type { PtySupervisor } from './pty/pty-supervisor'
import type { RendererResourceScopes } from './renderer-resource-scopes'
import type { TerminalSessionStore } from './terminal/session-registry'
import type { WebPaneRouteRegistry } from './web-pane/web-pane-route-registry'

export function createWorkspaceCleanup({
  ptys,
  resources,
  sessions,
  webPanes,
}: {
  readonly ptys: PtySupervisor
  readonly resources: RendererResourceScopes
  readonly sessions: Pick<TerminalSessionStore, 'list' | 'forget'>
  readonly webPanes: WebPaneRouteRegistry
}) {
  return {
    revokeWorkspace: (root: HostPath): Promise<void> => resources.revokeWorkspace(root),
    closeWorkspaceWebPanes: (root: HostPath): Promise<void> =>
      webPanes.closeWorkspace(root),
    workspaceTerminalIds: (root: HostPath): readonly string[] => [
      ...new Set([
        ...sessions.list(root).map((session) => session.id),
        ...ptys.workspaceSessionIds(root),
      ]),
    ],
    closeWorkspaceTerminals: (root: HostPath): void => ptys.disposeWorkspace(root),
    forgetWorkspaceSessions: async (root: HostPath): Promise<void> => {
      await Promise.all(
        sessions.list(root).map((session) => sessions.forget(root, session.id)),
      )
    },
  }
}
