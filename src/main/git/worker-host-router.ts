import type { ExecResult, WorkerHostCall } from '../../shared'
import {
  GitMutationAuthorization,
  type GitMutationAuthority,
} from './mutation-authorization'
import { dispatchWorkerHostCall } from './worker-host-broker'

export interface GitWorkerAuthorityPort {
  authorityForPath(hostId: string, path: string): GitMutationAuthority | undefined
}

export interface GitWorkerHostRouterOptions {
  readonly authority: GitWorkerAuthorityPort
  readonly authorizations: GitMutationAuthorization
  readonly dispatch?: typeof dispatchWorkerHostCall
}

/** Routes untrusted worker calls through exact mutation grants, then the Git broker. */
export class GitWorkerHostRouter {
  constructor(private readonly options: GitWorkerHostRouterOptions) {}

  route(call: WorkerHostCall): Promise<ExecResult | string> {
    return Promise.resolve().then(() => {
      const path =
        call.operation === 'readTextFile' ? call.path.path : (call.args[1] ?? '')
      const authority = this.options.authority.authorityForPath(call.hostId, path) ?? null
      const permissions = this.options.authorizations.permissionsFor(call, authority)
      return (this.options.dispatch ?? dispatchWorkerHostCall)(
        call,
        authority,
        permissions,
      )
    })
  }
}
