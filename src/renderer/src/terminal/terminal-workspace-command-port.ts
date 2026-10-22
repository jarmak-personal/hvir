import type { TerminalCommandRequest } from '../../../shared/ipc/terminal'
import type { HarnessProfileId } from '../../../shared'
import type { TerminalSession } from './terminal-workspace-model'

export interface TerminalWorkspaceController {
  readonly launchSession?: (
    profileId: HarnessProfileId,
    launchRevision: number,
    command?: TerminalCommandRequest,
  ) => string | undefined
  readonly hasSession: (id: string) => boolean
  readonly selectSession: (id: string) => boolean
  readonly transferOut: (id: string) => TerminalSession | undefined
  readonly transferIn: (session: TerminalSession) => void
}
