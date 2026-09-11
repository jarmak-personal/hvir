import type {
  SkillagerExposureRequest,
  SkillagerExposurePreview,
  SkillagerExposureCompletion,
} from '../skillager-exposure'
import type {
  SkillagerAcceptance,
  SkillagerHistory,
  SkillagerReview,
  SkillagerReviewContent,
  SkillagerReviewDiff,
  SkillagerReviewRequest,
  SkillagerSkillRequest,
} from '../skillager-review'
import type { HostPath } from '../host-path'
import { invoke, type IpcFeatureContract } from '../ipc-contract'
import type {
  SkillagerConnection,
  SkillagerMetadataResult,
  SkillagerProbe,
  SkillagerRequest,
  SkillagerResult,
  SkillagerSearchRequest,
} from '../skillager'

export const skillagerIpc = {
  invoke: {
    'skillager:preview-exposure': invoke<
      SkillagerExposureRequest,
      SkillagerResult<SkillagerExposurePreview>
    >(),
    'skillager:apply-exposure': invoke<
      { readonly previewId: string },
      SkillagerResult<SkillagerExposureCompletion>
    >(),
    'skillager:release-exposure': invoke<{ readonly previewId: string }, void>(),
    'skillager:cancel-exposure': invoke<{ readonly requestId: number }, void>(),
    'skillager:cancel-review': invoke<{ readonly requestId: number }, void>(),
    'skillager:review': invoke<SkillagerSkillRequest, SkillagerResult<SkillagerReview>>(),
    'skillager:history': invoke<
      SkillagerSkillRequest,
      SkillagerResult<SkillagerHistory>
    >(),
    'skillager:review-content': invoke<
      SkillagerReviewRequest & {
        readonly entry: string
        readonly documentEntry?: string
      },
      SkillagerResult<SkillagerReviewContent>
    >(),
    'skillager:review-diff': invoke<
      SkillagerReviewRequest & { readonly fromHash?: string },
      SkillagerResult<SkillagerReviewDiff>
    >(),
    'skillager:accept-review': invoke<
      SkillagerReviewRequest,
      SkillagerResult<SkillagerAcceptance>
    >(),
    'skillager:release-review': invoke<{ readonly reviewId: string }, void>(),
    'skillager:configure': invoke<{ readonly enabled: boolean }, void>(),
    'skillager:probe': invoke<
      { readonly executable?: HostPath },
      SkillagerResult<SkillagerProbe>
    >(),
    'skillager:connect': invoke<
      { readonly probeId: string },
      SkillagerResult<SkillagerConnection>
    >(),
    'skillager:disconnect': invoke<Record<string, never>, void>(),
    'skillager:inventory': invoke<
      SkillagerRequest,
      SkillagerResult<SkillagerMetadataResult>
    >(),
    'skillager:search': invoke<
      SkillagerSearchRequest,
      SkillagerResult<SkillagerMetadataResult>
    >(),
    'skillager:cancel': invoke<
      { readonly kind: 'search' | 'inventory'; readonly requestId: number },
      void
    >(),
  },
  send: {},
  event: {},
} as const satisfies IpcFeatureContract
