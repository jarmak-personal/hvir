import type { SkillagerMetadata, SkillagerWorkspaceExposure } from './skillager'

/** Main's read lane counts proven memberships once; only returned canonical sources retain counters. */
export function withSkillagerRouterMemberships(
  rows: readonly SkillagerMetadata[],
  exposures: readonly SkillagerWorkspaceExposure[] | undefined,
): readonly SkillagerMetadata[] {
  const counts = new Map<string, number>()
  for (const row of rows)
    if (row.source.ownership === 'library' && row.source.libraryId)
      counts.set(JSON.stringify([row.source.libraryId, row.id]), 0)
  for (const router of exposures ?? [])
    for (const member of router.router?.memberSources ?? []) {
      if (!member.sourceLibraryId) continue
      const key = JSON.stringify([member.sourceLibraryId, member.skillId])
      const count = counts.get(key)
      if (count !== undefined) counts.set(key, count + 1)
    }
  return rows.map((row) =>
    row.source.ownership === 'library'
      ? {
          ...row,
          workspaceRouterCount: exposures
            ? counts.get(JSON.stringify([row.source.libraryId, row.id]))
            : undefined,
        }
      : row,
  )
}
