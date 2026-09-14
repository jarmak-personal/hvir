import type {
  SkillagerMetadata,
  SkillagerWorkspaceExposure,
} from '../../../shared/skillager'
import {
  type SkillagerCanonicalObservation,
  skillagerMetadataKey,
  skillagerRouterMember,
} from './skillager-model'

export interface SkillagerExplorerRow {
  readonly key: string
  readonly metadata: SkillagerMetadata
  readonly depth: number
  readonly parent?: string
  readonly expandable: boolean
}
interface Segment {
  readonly start: number
  readonly key: string
  readonly metadata: SkillagerMetadata
  readonly copies: readonly SkillagerWorkspaceExposure[]
  readonly members: readonly string[]
  readonly expanded: boolean
}
export const SKILLAGER_EXPANDED_ROW_LIMIT = 40_000

/** Retain public membership references; construct only the admitted window, even with many expanded routers. */
export function skillagerExplorerRows(
  sources: readonly SkillagerMetadata[],
  canonical: SkillagerCanonicalObservation,
  expanded: ReadonlySet<string>,
) {
  const segments: Segment[] = []
  const parents = new Map<string, Segment>()
  let remaining = SKILLAGER_EXPANDED_ROW_LIMIT - sources.length
  const refused: string[] = []
  let length = 0
  for (const metadata of sources) {
    const key = skillagerMetadataKey(metadata)
    const copies = metadata.workspaceCopies ?? []
    const members = metadata.workspace?.router?.skillIds ?? []
    const requested = expanded.has(key),
      size = copies.length + members.length
    const admitted = requested && size <= remaining
    if (requested && !admitted) refused.push(key)
    if (admitted) remaining -= size
    const segment: Segment = {
      start: length,
      key,
      metadata,
      copies,
      members,
      expanded: admitted,
    }
    segments.push(segment)
    parents.set(key, segment)
    length += 1 + (segment.expanded ? segment.copies.length + segment.members.length : 0)
  }
  const at = (index: number): SkillagerExplorerRow | undefined => {
    if (index < 0 || index >= length) return undefined
    let low = 0,
      high = segments.length
    while (low + 1 < high) {
      const middle = (low + high) >>> 1
      if (segments[middle]!.start > index) high = middle
      else low = middle
    }
    const segment = segments[low]!,
      child = index - segment.start - 1
    if (child < 0)
      return {
        key: segment.key,
        metadata: segment.metadata,
        depth: 0,
        expandable: segment.copies.length + segment.members.length > 0,
      }
    const copy = segment.copies[child]
    const metadata = copy
      ? {
          ...segment.metadata,
          workspaceCopies: undefined,
          workspace: copy,
          exposure: copy.mode,
        }
      : skillagerRouterMember(
          segment.metadata.workspace!,
          segment.members[child - segment.copies.length]!,
          canonical,
          segment.metadata,
        )
    return {
      key: skillagerMetadataKey(metadata),
      metadata,
      parent: segment.key,
      depth: 1,
      expandable: false,
    }
  }
  const slice = (start: number, end: number): readonly SkillagerExplorerRow[] => {
    const result: SkillagerExplorerRow[] = []
    for (let index = Math.max(0, start); index < Math.min(length, end); index++)
      result.push(at(index)!)
    return result
  }
  // Resolve a previously focused child using its own parent, without expanding unrelated memberships.
  const indexOf = (key: string, previous?: SkillagerExplorerRow): number => {
    const top = parents.get(key)
    if (top) return top.start
    const owner = previous?.parent ? parents.get(previous.parent) : undefined
    if (!owner?.expanded) return -1
    const copy = previous?.metadata.workspace
    const child = copy
      ? owner.copies.findIndex(
          (candidate) =>
            candidate.id === copy.id &&
            candidate.agent === copy.agent &&
            candidate.target.hostId === copy.target.hostId &&
            candidate.target.path === copy.target.path,
        )
      : owner.members.indexOf(previous!.metadata.id)
    return child < 0 ? -1 : owner.start + 1 + child + (copy ? 0 : owner.copies.length)
  }
  return { length, sourceCount: segments.length, refused, at, slice, indexOf }
}
