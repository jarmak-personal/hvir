import type { HostPath } from '../../shared/host-path'
import type { ProjectState } from '../../shared/workspace-types'
import type { IpcInvokeChannel, IpcSendChannel } from '../../shared/ipc'
import type { ProjectHost } from '../project-host/project-host'
import type { RendererResourceScopes } from '../renderer-resource-scopes'

export interface IpcContractDiagnostic {
  readonly channel: IpcInvokeChannel | IpcSendChannel
  readonly outcome: 'non-main-frame' | 'renderer-revoked'
  readonly timing: 'under-1ms' | 'under-10ms' | '10ms-or-more'
}

/** Authority consumes registered project scope; it does not depend on feature IPC deps. */
export interface IpcProjectAuthorityPort {
  readonly getProject: () => { readonly host: ProjectHost; readonly root: HostPath }
  readonly getProjectState: () => ProjectState
  readonly getRegisteredWorkspaceRoot: (root: HostPath) => HostPath | undefined
}

export interface IpcRouterAuthorityPort extends IpcProjectAuthorityPort {
  readonly rendererResources: RendererResourceScopes
  readonly recordIpcContractDiagnostic: (event: IpcContractDiagnostic) => void
}
