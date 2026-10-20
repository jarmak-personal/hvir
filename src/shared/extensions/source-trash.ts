import type { HostPath } from '../host-path'

/** Trusted chrome only; its identity is never returned to the requesting guest. */
export interface ExtensionSourceTrashProposal {
  readonly id: string
  readonly name: string
  readonly workspaceId: string
  readonly root: HostPath
  readonly path: HostPath
}

export type ExtensionSourceTrashResult = {
  readonly outcome: 'completed' | 'cancelled' | 'refused' | 'uncertain'
  readonly reason?: string
}
