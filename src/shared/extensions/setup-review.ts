import type { HostPath } from '../host-path'
import type { ExtensionConnectorApproval } from './connectors'
import type { ExtensionSourceGrant } from './source-access'

export type SetupRowState =
  | 'ready'
  | 'unchanged'
  | 'blocked'
  | 'saved'
  | 'declined'
  | 'failed'
  | 'interrupted-uncertain'
export interface ExtensionSetupRow {
  readonly id: string
  readonly title: string
  readonly kind: 'program' | 'source' | 'agent'
  readonly state: SetupRowState
  readonly selected: boolean
  readonly location?: HostPath
  readonly program?: ExtensionConnectorApproval
  readonly source?: ExtensionSourceGrant
  readonly previousPrograms?: readonly ExtensionConnectorApproval[]
  readonly previousSources?: readonly ExtensionSourceGrant[]
  readonly agentAccess?: boolean
  /** Post-settlement owner observation; never disk durability, execution readiness or a write receipt. */
  readonly retainedSetting?: boolean
  readonly explanation?: string
}
/** Display-only immutable snapshots. No prepared permission tokens cross this transport. */
export interface ExtensionSetupReview {
  readonly request: string
  readonly installationId: string
  readonly name: string
  readonly file: string
  readonly expires: number
  readonly phase: 'preparing' | 'ready' | 'saving' | 'stopping' | 'finished' | 'ended'
  readonly rows: readonly ExtensionSetupRow[]
  readonly capacityError?: string
  readonly explanation?: string
}
