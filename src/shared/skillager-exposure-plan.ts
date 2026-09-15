import type { HostPath } from './host-path'
import type { SkillagerRequest, SkillagerWorkspaceExposure } from './skillager'
import type {
  SkillagerDestination,
  SkillagerExposureCompletion,
  SkillagerExposureEffect,
  SkillagerExposureMode,
  SkillagerExposurePreview,
  SkillagerExposureRequest,
} from './skillager-exposure'

export type SkillagerPlanReplacement =
  { readonly origin_id: string } | { readonly exposure_id: string }
export type SkillagerPlanRequest = {
  readonly schema: 'skillager.exposure-request.v1'
} & (
  | {
      readonly action: 'adopt-native'
      readonly origin_id: string
      readonly source: SkillagerPlanSource
      readonly mode: SkillagerExposureMode
    }
  | {
      readonly action: 'remove-native'
      readonly origin_id: string
      readonly source: SkillagerPlanSource
    }
  | {
      readonly action: 'group'
      readonly name: string
      readonly library_id: string
      readonly members: readonly string[]
      readonly replace: readonly SkillagerPlanReplacement[]
    }
  | {
      readonly action: 'set-members'
      readonly router_id: string
      readonly library_id: string
      readonly members: readonly string[]
      readonly replace: readonly SkillagerPlanReplacement[]
      readonly departures: readonly {
        readonly skill_id: string
        readonly mode: SkillagerExposureMode | 'remove'
      }[]
    }
  | {
      readonly action: 'ungroup'
      readonly router_id: string
      readonly mode: SkillagerExposureMode
    }
)
export interface SkillagerPlanSource {
  readonly library_id: string
  readonly skill_id: string
}
/** Public occurrence selected in the originating project; paths are comparison evidence only. */
export interface SkillagerNativeSelection {
  readonly originId: string
  readonly lineageId: string
  readonly sourceIdentity: string
  readonly skillId: string
  readonly path: HostPath
}
export interface SkillagerExposureLineageRequest extends SkillagerRequest {
  readonly destination: SkillagerDestination
}
export interface SkillagerLifecycleRequest extends SkillagerRequest {
  readonly action: 'plan'
  readonly destination: SkillagerDestination
  readonly plan: SkillagerPlanRequest
  readonly origins: readonly SkillagerNativeSelection[]
  readonly exposures: readonly SkillagerWorkspaceExposure[]
}
export interface SkillagerRouterRemovalRequest extends SkillagerRequest {
  readonly action: 'remove-router'
  readonly destination: SkillagerDestination
  readonly exposure: SkillagerWorkspaceExposure
}
export type SkillagerExposureActionRequest =
  SkillagerExposureRequest | SkillagerLifecycleRequest | SkillagerRouterRemovalRequest
export interface SkillagerPlanTarget {
  readonly id: string
  readonly path: HostPath
  readonly kind: 'parent' | 'tags' | 'direct' | 'router' | 'native-origin'
  readonly action: 'create' | 'replace' | 'remove' | 'keep'
  readonly exposureId?: string
  readonly skillId?: string
  readonly originId?: string
  readonly before: { readonly hash: string; readonly mode: number } | null
  readonly after: { readonly hash: string; readonly mode: number } | null
  readonly effects: readonly (Omit<SkillagerExposureEffect, 'action'> & {
    readonly action: SkillagerPlanTarget['action']
  })[]
}
export interface SkillagerPlanPreview {
  readonly kind: 'plan'
  readonly previewId: string
  readonly request: SkillagerLifecycleRequest
  readonly targets: readonly SkillagerPlanTarget[]
  /** Complete inert public approval/lineage and tag/staging disclosures. No instruction bodies. */
  readonly sources: readonly string[]
  readonly group: string | null
  readonly staging: string
}
export interface SkillagerRouterRemovalPreview {
  readonly kind: 'remove-router'
  readonly previewId: string
  readonly request: SkillagerRouterRemovalRequest
  readonly target: HostPath
  readonly beforeMode: number
  readonly effects: readonly SkillagerExposureEffect[]
}
export interface SkillagerPlanCompletion {
  readonly kind: 'plan'
  readonly status: 'applied' | 'partial' | 'refused'
  readonly reason?: string
  readonly targets: readonly {
    readonly id: string
    readonly path: HostPath
    readonly status:
      'applied' | 'unchanged' | 'refused' | 'rolled_back' | 'recovery_required'
    readonly observedHash: string | null
    readonly reason?: string
    readonly recoveryPath?: HostPath
  }[]
}
export interface SkillagerRouterRemovalCompletion {
  readonly kind: 'remove-router'
  readonly status: 'removed'
  readonly target: HostPath
}
export type SkillagerExposureActionPreview =
  SkillagerExposurePreview | SkillagerPlanPreview | SkillagerRouterRemovalPreview
export type SkillagerExposureActionCompletion =
  SkillagerExposureCompletion | SkillagerPlanCompletion | SkillagerRouterRemovalCompletion

export type SkillagerPreviewFor<T extends SkillagerExposureActionRequest> =
  T extends SkillagerLifecycleRequest
    ? SkillagerPlanPreview
    : T extends SkillagerRouterRemovalRequest
      ? SkillagerRouterRemovalPreview
      : SkillagerExposurePreview
