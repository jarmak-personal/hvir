import type {
  SkillagerMetadata,
  SkillagerWorkspaceExposure,
} from '../../shared/skillager'

import { skillagerSourceKey } from '../../shared/skillager-source-identity'

/** Main's read lane counts proven memberships once; only returned canonical sources retain counters. */
export function withSkillagerRouterMemberships(
  rows: readonly SkillagerMetadata[],
  exposures: readonly SkillagerWorkspaceExposure[] | undefined,
): readonly SkillagerMetadata[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = skillagerSourceKey(row.source.libraryId, row.id)
    if (row.source.ownership === 'library' && key) counts.set(key, 0)
  }
  for (const router of exposures ?? [])
    for (const member of router.router?.memberSources ?? []) {
      const key = skillagerSourceKey(member.sourceLibraryId, member.skillId)
      if (!key) continue
      const count = counts.get(key)
      if (count !== undefined) counts.set(key, count + 1)
    }
  return rows.map((row) => {
    const key = skillagerSourceKey(row.source.libraryId, row.id)
    return row.source.ownership === 'library'
      ? {
          ...row,
          workspaceRouterCount: exposures && key ? counts.get(key) : undefined,
        }
      : row
  })
}
