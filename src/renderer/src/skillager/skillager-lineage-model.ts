import { hostPathEquals } from '../../../shared/host-path'
import type { SkillagerMetadata } from '../../../shared/skillager'
import { skillagerSourceKey } from '../../../shared/skillager-source-identity'
import type { SkillagerLibraryLineage } from '../../../shared/skillager-library-sync'

/** Load the public relation once; selected details never infer a copy from a name. */
export function skillagerLineageIndex(lineages: readonly SkillagerLibraryLineage[]) {
  const canonical = new Map<string, SkillagerLibraryLineage>()
  const origins = new Map<string, SkillagerLibraryLineage[]>()
  for (const lineage of lineages) {
    canonical.set(
      skillagerSourceKey(lineage.canonical.libraryId, lineage.canonical.skillId)!,
      lineage,
    )
    for (const id of new Set(lineage.origins.map((origin) => origin.skillId))) {
      const rows = origins.get(id) ?? []
      rows.push(lineage)
      origins.set(id, rows)
    }
  }
  return (metadata: SkillagerMetadata): readonly SkillagerLibraryLineage[] => {
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
}
