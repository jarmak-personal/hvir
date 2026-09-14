import { skillagerLineageIndex } from './skillager-lineage-model'
import { hostPathEquals, type HostPath } from '../../../shared/host-path'
import type { SkillagerMetadata } from '../../../shared/skillager'
import type { SkillagerSyncStatus } from '../../../shared/skillager-library-sync'
import type { SkillagerNativeSelection } from '../../../shared/skillager-exposure-plan'

/** Build once per explicit observed report; each exact native lookup is constant-time. */
export function skillagerNativeSelector(
  report: SkillagerSyncStatus | undefined,
  root: HostPath,
  libraryId: string,
): (metadata: SkillagerMetadata) => SkillagerNativeSelection | undefined {
  if (
    root.hostId !== 'local' ||
    report?.status !== 'observed' ||
    !report.coverage.complete ||
    !report.context ||
    !hostPathEquals(report.context, root) ||
    report.library?.id !== libraryId
  )
    return () => undefined
  const index = skillagerLineageIndex(report.lineages)
  return (metadata) => {
    const native = metadata.projectSkill
    if (!native || native.managed || !native.agent) return
    const selected = index.native(metadata, root)
    if (!selected) return
    const { lineage, origin } = selected
    if (
      lineage.canonical.libraryId !== libraryId ||
      lineage.preservation !== 'verified' ||
      lineage.canonical.acceptance !== 'accepted' ||
      origin.observation.status !== 'current'
    )
      return
    return {
      originId: origin.id,
      lineageId: lineage.id,
      sourceIdentity: lineage.sourceIdentity,
      skillId: lineage.canonical.skillId,
      path: origin.path,
    }
  }
}
