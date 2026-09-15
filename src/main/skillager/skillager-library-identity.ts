import { skillagerLibraryName } from '../../shared/skillager-source-identity'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { SkillagerLibrary } from '../../shared/skillager'
import { SkillagerError } from './skillager-port'

export function skillagerLibrarySkillRoot(
  library: SkillagerLibrary,
  id: string,
): HostPath {
  const name = skillagerLibraryName(id)
  if (!name)
    throw new SkillagerError('invalid-request', 'Select an owned personal-library skill.')
  return joinHostPath(library.skillsRoot, name)
}
