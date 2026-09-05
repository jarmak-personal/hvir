import type { HarnessLaunchMode, HarnessProviderCapabilities } from '../../shared'
import type { ProjectHost } from '../project-host/project-host'
import type {
  HarnessProvider,
  HarnessResumeValidationContext,
} from './harness-provider-contract'
import { harnessProviderCapabilities } from './harness-provider-capabilities'

export type HarnessLaunchDecision =
  | { readonly outcome: 'launch'; readonly mode: HarnessLaunchMode }
  | { readonly outcome: 'resume-unavailable'; readonly reason: 'artifact-missing' }
  | {
      readonly outcome: 'fork-unavailable'
      readonly reason: 'parent-artifact-missing'
    }

export async function selectHarnessLaunch(
  host: ProjectHost,
  provider: HarnessProvider,
  requestedMode: HarnessLaunchMode,
  context: HarnessResumeValidationContext,
  effectiveCapabilities: HarnessProviderCapabilities = harnessProviderCapabilities(
    provider,
  ),
): Promise<HarnessLaunchDecision> {
  if (requestedMode === 'fork') {
    if (!provider.fork || effectiveCapabilities.exactFork !== true) {
      throw new Error(`${provider.manifest.displayName} does not support exact forks`)
    }
    if (!provider.resumeValidation) return { outcome: 'launch', mode: 'fork' }
  }
  if (requestedMode === 'fresh' || !provider.resumeValidation) {
    return { outcome: 'launch', mode: requestedMode }
  }
  const availability = await provider.resumeValidation.availability(host, context)
  if (availability === 'available') return { outcome: 'launch', mode: requestedMode }
  if (availability === 'missing') {
    if (requestedMode === 'fork') {
      return { outcome: 'fork-unavailable', reason: 'parent-artifact-missing' }
    }
    return { outcome: 'resume-unavailable', reason: 'artifact-missing' }
  }
  throw new Error(
    `${provider.manifest.displayName} session state could not be verified; recovery was not started`,
  )
}
