import type { ReactElement } from 'react'

import type {
  HarnessProfile,
  HarnessProfileProbe,
  HarnessProviderDescriptor,
  TerminalMovePlan,
  TerminalRecoverySession,
} from '../../../shared'
import { TerminalMoveDialog } from './TerminalMoveDialog'
import { TerminalRecoveryDialog } from './TerminalRecoveryDialog'

export function TerminalWorkspaceDialogs({
  visible,
  move,
  recovery,
}: {
  readonly visible: boolean
  readonly move?: {
    readonly plan: TerminalMovePlan
    readonly onCancel: () => void
    readonly onMove: () => Promise<void>
  }
  readonly recovery?: {
    readonly ready: boolean
    readonly sessions: readonly TerminalRecoverySession[]
    readonly providers: readonly HarnessProviderDescriptor[]
    readonly profiles: readonly HarnessProfile[]
    readonly probes: readonly HarnessProfileProbe[]
    readonly onDismiss: () => void
    readonly onSkip: () => Promise<void>
    readonly onResume: (ids: ReadonlySet<string>) => Promise<void>
    readonly onRebind: (
      record: TerminalRecoverySession,
      profile: HarnessProfile,
    ) => Promise<void>
  }
}): ReactElement | null {
  if (!visible) return null
  return (
    <>
      {move ? <TerminalMoveDialog {...move} /> : null}
      {recovery?.ready ? (
        <TerminalRecoveryDialog
          sessions={recovery.sessions}
          providers={recovery.providers}
          profiles={recovery.profiles}
          probes={recovery.probes}
          onDismiss={recovery.onDismiss}
          onSkip={recovery.onSkip}
          onResume={recovery.onResume}
          onRebind={recovery.onRebind}
        />
      ) : null}
    </>
  )
}
