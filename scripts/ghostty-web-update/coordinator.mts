import {
  planGhosttyWebUpdate,
  selectNewestPublishedRelease,
  type GhosttyWebRelease,
  type PinnedGhosttyWebArtifact,
  type UpdateDeliveryState,
  type ValidatedGhosttyWebRelease,
} from './policy.mts'

export interface GhosttyWebReleaseSource {
  listReleases(): Promise<readonly GhosttyWebRelease[]>
  validateRelease(release: GhosttyWebRelease): Promise<ValidatedGhosttyWebRelease>
}

export interface GhosttyWebCandidateWorkspace {
  readCurrentPin(): Promise<PinnedGhosttyWebArtifact>
  prepareCandidate(release: ValidatedGhosttyWebRelease): Promise<PreparedCandidate>
}

export interface PreparedCandidate {
  readonly changedFiles: readonly string[]
  readonly release: ValidatedGhosttyWebRelease
}

export interface GhosttyWebDelivery {
  inspect(): Promise<UpdateDeliveryState>
  publish(
    current: PinnedGhosttyWebArtifact,
    candidate: PreparedCandidate,
    delivery: UpdateDeliveryState,
  ): Promise<{ readonly pullRequestNumber: number; readonly url: string }>
}

export type GhosttyWebUpdateResult =
  | {
      readonly outcome: 'no-op'
      readonly currentTag: string
      readonly selectedTag: string
      readonly reason: 'main-current' | 'open-current'
    }
  | {
      readonly outcome: 'suppressed'
      readonly currentTag: string
      readonly selectedTag: string
      readonly rejectedTag: string
    }
  | {
      readonly outcome: 'published'
      readonly currentTag: string
      readonly selectedTag: string
      readonly pullRequestNumber: number
      readonly url: string
    }

export type PreparedGhosttyWebUpdateResult =
  | Exclude<GhosttyWebUpdateResult, { readonly outcome: 'published' }>
  | {
      readonly outcome: 'prepared'
      readonly current: PinnedGhosttyWebArtifact
      readonly candidate: PreparedCandidate
      readonly delivery: UpdateDeliveryState
    }

/**
 * Coordinates one fail-closed update attempt. Every release and candidate check completes
 * before the delivery port receives authority to change the remote branch or pull request.
 */
export async function runGhosttyWebUpdate(input: {
  readonly candidate: GhosttyWebCandidateWorkspace
  readonly delivery: GhosttyWebDelivery
  readonly releases: GhosttyWebReleaseSource
}): Promise<GhosttyWebUpdateResult> {
  const prepared = await prepareGhosttyWebUpdate(input)
  if (prepared.outcome !== 'prepared') return prepared
  const published = await input.delivery.publish(
    prepared.current,
    prepared.candidate,
    prepared.delivery,
  )
  return {
    outcome: 'published',
    currentTag: prepared.current.tag,
    selectedTag: prepared.candidate.release.tag,
    ...published,
  }
}

export async function prepareGhosttyWebUpdate(input: {
  readonly candidate: GhosttyWebCandidateWorkspace
  readonly delivery: Pick<GhosttyWebDelivery, 'inspect'>
  readonly releases: GhosttyWebReleaseSource
}): Promise<PreparedGhosttyWebUpdateResult> {
  const [current, releases, delivery] = await Promise.all([
    input.candidate.readCurrentPin(),
    input.releases.listReleases(),
    input.delivery.inspect(),
  ])
  const selected = selectNewestPublishedRelease(releases)
  const plan = planGhosttyWebUpdate(current.tag, selected.tag.name, delivery)
  if (plan.action === 'no-op') {
    return {
      outcome: 'no-op',
      currentTag: current.tag,
      selectedTag: selected.tag.name,
      reason: plan.reason,
    }
  }
  if (plan.action === 'suppressed') {
    return {
      outcome: 'suppressed',
      currentTag: current.tag,
      selectedTag: selected.tag.name,
      rejectedTag: plan.rejectedTag,
    }
  }

  const validated = await input.releases.validateRelease(selected)
  if (validated.tag !== selected.tag.name) {
    throw new Error('Validated ghostty-web release identity changed during discovery.')
  }
  const candidate = await input.candidate.prepareCandidate(validated)
  return {
    outcome: 'prepared',
    current,
    candidate,
    delivery,
  }
}
