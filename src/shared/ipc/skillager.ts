import type {
  SkillagerContentRequest,
  SkillagerContentSession,
  SkillagerContentFileRequest,
} from '../skillager-content'
import type {
  SkillagerExposureActionRequest,
  SkillagerExposureLineageRequest,
  SkillagerExposureActionPreview,
  SkillagerExposureActionCompletion,
} from '../skillager-exposure-plan'
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
import type {
  SkillagerSyncStatus,
  SkillagerSyncCompletion,
  SkillagerSyncPreparation,
  SkillagerSyncRequest,
} from '../skillager-library-sync'
import type { StartPtyResponse } from '../ipc/terminal'
import type {
  SkillagerProjectObservation,
  SkillagerProjectSetup,
  SkillagerProjectStart,
} from '../skillager-project'
import { invoke, type IpcFeatureContract } from '../ipc-contract'
import type {
  SkillagerConnection,
  SkillagerMetadataResult,
  SkillagerProbe,
  SkillagerRequest,
  SkillagerBrowseRequest,
  SkillagerResult,
  SkillagerSearchRequest,
  SkillagerSetupCompletion,
} from '../skillager'

export const skillagerIpc = {
  invoke: {
    'skillager:open-document': invoke<
      SkillagerContentRequest,
      SkillagerResult<SkillagerContentSession>
    >(),
    'skillager:read-document': invoke<
      SkillagerContentFileRequest,
      SkillagerResult<SkillagerReviewContent>
    >(),
    'skillager:release-document': invoke<{ readonly contentId: string }, void>(),
    'skillager:cancel-document': invoke<{ readonly requestId: number }, void>(),
    'skillager:sync-status': invoke<
      SkillagerRequest,
      SkillagerResult<SkillagerSyncPreparation>
    >(),
    'skillager:sync-approved': invoke<
      SkillagerSyncRequest,
      SkillagerResult<SkillagerSyncCompletion>
    >(),
    'skillager:cancel-sync': invoke<{ readonly requestId: number }, void>(),
    'skillager:project-metadata': invoke<
      SkillagerBrowseRequest,
      SkillagerResult<SkillagerProjectObservation>
    >(),
    'skillager:prepare-project-setup': invoke<
      SkillagerRequest,
      SkillagerResult<SkillagerProjectSetup>
    >(),
    'skillager:start-project-setup': invoke<
      SkillagerProjectStart,
      SkillagerResult<Extract<StartPtyResponse, { outcome: 'started' }>>
    >(),
    'skillager:release-project-setup': invoke<{ readonly setupId: string }, void>(),
    'skillager:exposure-lineage': invoke<
      SkillagerExposureLineageRequest,
      SkillagerResult<SkillagerSyncStatus>
    >(),
    'skillager:preview-exposure': invoke<
      SkillagerExposureActionRequest,
      SkillagerResult<SkillagerExposureActionPreview>
    >(),
    'skillager:apply-exposure': invoke<
      { readonly previewId: string },
      SkillagerResult<SkillagerExposureActionCompletion>
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
    'skillager:choose-library-folder': invoke<
      { readonly probeId: string },
      SkillagerResult<SkillagerProbe>
    >(),
    'skillager:initialize-library': invoke<
      { readonly selectionId: string; readonly gitHistory: boolean },
      SkillagerResult<SkillagerSetupCompletion>
    >(),
    'skillager:reconcile-library': invoke<
      { readonly probeId: string },
      SkillagerResult<SkillagerProbe>
    >(),
    'skillager:connect': invoke<
      { readonly probeId: string },
      SkillagerResult<SkillagerConnection>
    >(),
    'skillager:disconnect': invoke<Record<string, never>, void>(),
    'skillager:inventory': invoke<
      SkillagerBrowseRequest,
      SkillagerResult<SkillagerMetadataResult>
    >(),
    'skillager:search': invoke<
      SkillagerSearchRequest,
      SkillagerResult<SkillagerMetadataResult>
    >(),
    'skillager:cancel': invoke<
      { readonly kind: 'search' | 'inventory' | 'project'; readonly requestId: number },
      void
    >(),
  },
  send: {},
  event: {},
} as const satisfies IpcFeatureContract
