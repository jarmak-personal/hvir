import { hostPathEquals } from '../../../shared/host-path'
import type { SkillagerMetadata } from '../../../shared/skillager'
import { skillagerSourceKey } from '../../../shared/skillager-source-identity'
import type {
  SkillagerLibraryLineage,
  SkillagerSyncOrigin,
} from '../../../shared/skillager-library-sync'

/** Load the public relation once; selected details never infer a copy from a name. */
export function skillagerLineageIndex(lineages: readonly SkillagerLibraryLineage[]) {
  const canonical = new Map<string, SkillagerLibraryLineage>()
  const origins = new Map<string, SkillagerLibraryLineage[]>()
  const nativeOrigins = new Map<
    string,
    { lineage: SkillagerLibraryLineage; origin: SkillagerSyncOrigin } | null
  >()
  for (const lineage of lineages) {
    canonical.set(
      skillagerSourceKey(lineage.canonical.libraryId, lineage.canonical.skillId)!,
      lineage,
    )
    const ids = new Set<string>()
    for (const origin of lineage.origins) {
      ids.add(origin.skillId)
      if (origin.native) {
        const key = JSON.stringify([
          origin.skillId,
          origin.sourceType,
          [origin.path.hostId, origin.path.path],
          origin.native.agent,
          origin.native.scope,
          origin.native.projectRoot
            ? [origin.native.projectRoot.hostId, origin.native.projectRoot.path]
            : null,
        ])
        nativeOrigins.set(key, nativeOrigins.has(key) ? null : { lineage, origin })
      }
    }
    for (const id of ids) {
      const rows = origins.get(id) ?? []
      rows.push(lineage)
      origins.set(id, rows)
    }
  }
  const lookup = (metadata: SkillagerMetadata): readonly SkillagerLibraryLineage[] => {
    const key = skillagerSourceKey(metadata.source.libraryId, metadata.id)
    const owned = key ? canonical.get(key) : undefined
    if (owned) return [owned]
    if (metadata.source.ownership === 'library') return []
    return (origins.get(metadata.id) ?? []).filter((lineage) =>
      lineage.origins.some(
        (origin) =>
          origin.skillId === metadata.id &&
          origin.sourceType === metadata.source.type &&
          (metadata.projectSkill
            ? hostPathEquals(origin.path, metadata.projectSkill.path) &&
              origin.native?.agent === metadata.projectSkill.agent
            : (!metadata.source.collection ||
                origin.provenance.collection === metadata.source.collection) &&
              (!metadata.source.package ||
                origin.provenance.package === metadata.source.package)),
      ),
    )
  }
  return Object.assign(lookup, {
    native: (
      metadata: SkillagerMetadata,
      root: import('../../../shared/host-path').HostPath,
    ) =>
      nativeOrigins.get(
        JSON.stringify([
          metadata.id,
          metadata.source.type,
          metadata.projectSkill
            ? [metadata.projectSkill.path.hostId, metadata.projectSkill.path.path]
            : null,
          metadata.projectSkill?.agent,
          'project',
          [root.hostId, root.path],
        ]),
      ),
  })
}
