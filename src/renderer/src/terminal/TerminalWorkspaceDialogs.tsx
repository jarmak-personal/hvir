import type { ReactElement } from 'react'

import type {
  HarnessProfile,
  HarnessProfileProbe,
  HarnessProviderDescriptor,
  HostPath,
  TerminalMovePlan,
  TerminalRecoverySession,
} from '../../../shared'
import { HarnessRiskDialog } from './HarnessRiskDialog'
import { TerminalMoveDialog } from './TerminalMoveDialog'
import { TerminalRecoveryDialog } from './TerminalRecoveryDialog'

export function TerminalWorkspaceDialogs({
  visible,
  risk,
  move,
  recovery,
}: {
  readonly visible: boolean
  readonly risk?: {
    readonly profile: HarnessProfile
    readonly providers: readonly HarnessProviderDescriptor[]
    readonly root: HostPath
    readonly acceptProfiles: (
      update: (current: readonly HarnessProfile[]) => readonly HarnessProfile[],
    ) => void
    readonly launch: (
      profile: HarnessProfile,
      provider: HarnessProviderDescriptor,
    ) => void
    readonly onCancel: () => void
  }
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
    readonly onCancel: () => void
    readonly onResume: (ids: ReadonlySet<string>) => void
    readonly onRebind: (
      record: TerminalRecoverySession,
      profile: HarnessProfile,
    ) => Promise<void>
  }
}): ReactElement | null {
  if (!visible) return null
  return (
    <>
      {risk ? (
        <HarnessRiskDialog
          profile={risk.profile}
          provider={providerDescriptor(risk.providers, risk.profile)}
          onCancel={risk.onCancel}
          onLaunch={async () => {
            const acknowledged = await window.hvir.invoke('harness:acknowledge-risk', {
              root: risk.root,
              id: risk.profile.id,
              launchRevision: risk.profile.launchRevision,
            })
            risk.acceptProfiles((current) =>
              current.map((profile) =>
                profile.id === acknowledged.id ? acknowledged : profile,
              ),
            )
            const provider = providerDescriptor(risk.providers, acknowledged)
            if (provider) risk.launch(acknowledged, provider)
            risk.onCancel()
          }}
        />
      ) : null}
      {move ? <TerminalMoveDialog {...move} /> : null}
      {recovery?.ready ? (
        <TerminalRecoveryDialog
          sessions={recovery.sessions}
          providers={recovery.providers}
          profiles={recovery.profiles}
          probes={recovery.probes}
          onCancel={recovery.onCancel}
          onResume={recovery.onResume}
          onRebind={recovery.onRebind}
        />
      ) : null}
    </>
  )
}

function providerDescriptor(
  providers: readonly HarnessProviderDescriptor[],
  profile: HarnessProfile,
): HarnessProviderDescriptor | undefined {
  return providers.find((provider) => provider.id === profile.providerId)
}
