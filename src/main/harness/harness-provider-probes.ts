import type {
  HarnessSessionIdentity,
  HarnessContextPresentation,
  HarnessContextPressurePolicy,
} from '../../shared'
import type {
  HarnessProbeContract,
  HarnessDocumentReviewInsertContract,
  HarnessDocumentReviewSendNowContract,
} from './harness-provider-contract'
import { hasControlCharacter } from './harness-text-validation'

export function staticProbe(
  sessionIdentity: HarnessSessionIdentity,
  exactResume: boolean,
  contextPresentation: HarnessContextPresentation,
  contextPressure?: HarnessContextPressurePolicy,
): HarnessProbeContract {
  return {
    parseVersion: () => undefined,
    effectiveCapabilities: () => ({
      sessionIdentity,
      exactResume,
      contextPresentation,
      contextPressure,
    }),
  }
}

export function versionProbe(
  sessionIdentity: HarnessSessionIdentity,
  exactResume: boolean,
  contextPresentation: HarnessContextPresentation,
  capabilities: {
    readonly contextPressure?: HarnessContextPressurePolicy
    readonly reviewInsert?: HarnessDocumentReviewInsertContract
    readonly reviewSendNow?: HarnessDocumentReviewSendNowContract
    readonly supportsReviewSendNowVersion?: (version: string | undefined) => boolean
    readonly supportsExactForkVersion?: (version: string | undefined) => boolean
  } = {},
): HarnessProbeContract {
  return {
    versionArgs: ['--version'],
    parseVersion: (output) => {
      const first = output.trim().split(/\r?\n/, 1)[0]?.trim()
      return first && first.length <= 160 && !hasControlCharacter(first)
        ? first
        : undefined
    },
    effectiveCapabilities: (version) => ({
      sessionIdentity,
      exactResume,
      contextPresentation,
      contextPressure: capabilities.contextPressure,
      ...(capabilities.supportsExactForkVersion?.(version)
        ? { exactFork: true as const }
        : {}),
      reviewInsertContractRevision: capabilities.reviewInsert?.revision,
      reviewSendNowContractRevision:
        capabilities.reviewSendNow && capabilities.supportsReviewSendNowVersion?.(version)
          ? capabilities.reviewSendNow.revision
          : undefined,
    }),
  }
}
