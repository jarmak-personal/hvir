import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { SkillagerLibrary } from '../../shared/skillager'
import { SkillagerError } from './skillager-port'

export function skillagerLibrarySkillRoot(
  library: SkillagerLibrary,
  id: string,
): HostPath {
  if (!/^lib\/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(id) || id.length > 68)
    throw new SkillagerError('invalid-request', 'Select an owned personal-library skill.')
  return joinHostPath(library.skillsRoot, id.slice(4))
}
