import {
  containsHostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
} from '../../../shared/host-path'
import {
  SKILLAGER_ACCEPTED_TRUST,
  type SkillagerLibrary,
  type SkillagerMetadata,
} from '../../../shared/skillager'
import type { SkillagerContentSelection } from '../../../shared/skillager-content'
import type { SkillagerLibraryLineage } from '../../../shared/skillager-library-sync'
import {
  skillagerSourceKey,
  skillagerLibraryName,
} from '../../../shared/skillager-source-identity'
import { skillagerLineageIndex } from './skillager-lineage-model'

/** The selected occurrence is independent of the definition that matched the query. */
export function skillagerContentSelection(
  row: SkillagerMetadata,
  library: SkillagerLibrary,
  workspace: HostPath,
  currentFile = false,
): SkillagerContentSelection | undefined {
  const occurrence = row.search?.occurrence
  const copy = row.routerMembership ?? row.workspace
  const kind = occurrence
    ? occurrence.kind === 'source'
      ? 'project-original'
      : occurrence.kind === 'router-member'
        ? 'router'
        : occurrence.kind
    : copy
      ? copy.mode === 'router'
        ? 'router'
        : copy.mode === 'stub'
          ? 'stub'
          : 'full'
      : row.projectSkill
        ? 'project-original'
        : row.source.ownership === 'library'
          ? 'library'
          : undefined
  if (!kind) return
  const libraryId = row.source.libraryId
  const name = skillagerLibraryName(row.id)
  const root =
    occurrence?.path ??
    copy?.target ??
    row.projectSkill?.path ??
    (kind === 'library' && name ? joinHostPath(library.skillsRoot, name) : undefined)
  if (
    !root ||
    (kind === 'library'
      ? !name ||
        libraryId !== library.id ||
        !hostPathEquals(root, joinHostPath(library.skillsRoot, name))
      : !containsHostPath(workspace, root) || hostPathEquals(root, workspace))
  )
    return
  const path = occurrence?.entrypoint ?? joinHostPath(root, 'SKILL.md')
  if (!hostPathEquals(path, joinHostPath(root, 'SKILL.md'))) return
  return {
    kind,
    skillId: row.id,
    libraryId: kind === 'library' ? library.id : undefined,
    root,
    path,
    agent: occurrence?.agent ?? copy?.agent ?? row.projectSkill?.agent,
    expectedHash:
      !currentFile &&
      occurrence &&
      ['library', 'project-original'].includes(kind) &&
      SKILLAGER_ACCEPTED_TRUST.some((trust) => trust === row.trust)
        ? row.contentHash
        : undefined,
  }
}
export function skillagerContentLabel(selection: SkillagerContentSelection): string {
  return {
    library: 'Your library',
    'project-original': 'Project original',
    full: 'Installed Full',
    stub: 'Installed Stub',
    router: 'Installed Router',
  }[selection.kind]
}

/** Navigation only from an exact public UUID/skill relation, never an unqualified name. */
export function skillagerCanonicalContent(
  row: SkillagerMetadata,
  library: SkillagerLibrary,
  rows: ReadonlyMap<string, SkillagerMetadata>,
  lineages: readonly SkillagerLibraryLineage[],
  workspace: HostPath,
): SkillagerMetadata | undefined {
  const copy = row.routerMembership ?? row.workspace
  const member = copy?.router?.memberSources?.find((item) => item.skillId === row.id)
  const lineage = row.projectSkill
    ? skillagerLineageIndex(lineages).native(row, workspace)?.lineage
    : undefined
  const relation =
    row.search?.canonical ??
    (copy
      ? {
          libraryId: member?.sourceLibraryId ?? copy.sourceLibraryId,
          skillId: member?.skillId ?? copy.skillId,
        }
      : undefined) ??
    lineage?.canonical
  if (
    !relation ||
    relation.libraryId !== library.id ||
    !relation.skillId ||
    !skillagerLibraryName(relation.skillId)
  )
    return
  if (!row.search && !copy && row.source.ownership === 'library') return
  if (row.search?.occurrence.kind === 'library') return
  const known = rows.get(skillagerSourceKey(library.id, relation.skillId)!)
  return (
    known ?? {
      id: relation.skillId,
      name: row.name,
      description: '',
      trust: 'unknown',
      source: { type: 'library', ownership: 'library', libraryId: library.id },
      tags: [],
      matchReasons: [],
      exposure: 'unknown',
    }
  )
}
