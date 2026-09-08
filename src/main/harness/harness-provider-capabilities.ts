import type {
  ComposerSubmitMode,
  HarnessProfile,
  HarnessProviderCapabilities,
} from '../../shared'
import type { HarnessProvider } from './harness-provider-contract'

export function harnessProviderCapabilities(
  provider: HarnessProvider,
): HarnessProviderCapabilities {
  return {
    sessionIdentity: provider.sessionIdentity,
    exactResume: provider.supportsResume,
    contextPresentation: provider.manifest.contextPresentation,
    contextPressure: provider.manifest.contextPressure,
  }
}

/** Trusted capabilities bound to one successful provider launch. */
export function harnessLaunchCapabilities(
  provider: HarnessProvider,
  launch?: {
    readonly profile: HarnessProfile
    readonly composerSubmitMode: ComposerSubmitMode
    readonly probedCapabilities?: HarnessProviderCapabilities
  },
): HarnessProviderCapabilities {
  const probed =
    launch?.probedCapabilities ?? provider.probe.effectiveCapabilities(undefined)
  const insert = provider.documentReviewInsert
  let base: HarnessProviderCapabilities = {
    sessionIdentity: probed.sessionIdentity,
    exactResume: probed.exactResume,
    contextPresentation: probed.contextPresentation,
    ...(probed.exactFork === true ? { exactFork: true as const } : {}),
  }
  if (launch && insert && insert.revision === probed.reviewInsertContractRevision) {
    const candidate = { ...base, reviewInsertContractRevision: insert.revision }
    if (
      insert.supportsLaunch({
        profile: launch.profile,
        effectiveCapabilities: candidate,
      })
    ) {
      base = candidate
    }
  }
  const sendNow = provider.documentReviewSendNow
  if (!launch || !sendNow) return base
  if (sendNow.revision !== probed.reviewSendNowContractRevision) return base
  const effective = { ...base, reviewSendNowContractRevision: sendNow.revision }
  return sendNow.supportsLaunch({
    profile: launch.profile,
    composerSubmitMode: launch.composerSubmitMode,
    effectiveCapabilities: effective,
  })
    ? effective
    : base
}
