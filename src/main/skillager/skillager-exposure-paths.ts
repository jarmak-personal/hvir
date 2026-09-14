import {
  containsHostPath,
  dirnameHostPath,
  hostPathEquals,
  type HostPath,
} from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { SkillagerError } from './skillager-port'

/** ProjectHost owns canonical filesystem classification; no local fs authority is added. */
export async function validateExposureDestination(
  host: Pick<ProjectHost, 'realpath'>,
  root: HostPath,
  signal: AbortSignal,
): Promise<void> {
  if (root.hostId !== 'local' || !hostPathEquals(await host.realpath(root), root))
    throw new SkillagerError(
      'unavailable',
      'The selected local workspace location changed. Select its registered location again.',
    )
  signal.throwIfAborted()
}
export async function validateExposureTarget(
  host: Pick<ProjectHost, 'realpath'>,
  target: HostPath,
  root: HostPath,
  signal: AbortSignal,
): Promise<void> {
  let path = target
  for (;;) {
    signal.throwIfAborted()
    try {
      const canonical = await host.realpath(path)
      if (!containsHostPath(root, canonical) || !hostPathEquals(path, canonical))
        throw new SkillagerError(
          'unavailable',
          'The selected exposure resolves through a changed or outside workspace path.',
        )
      return
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'ENOENT' ||
        hostPathEquals(path, root)
      )
        throw error
      path = dirnameHostPath(path)
      if (!containsHostPath(root, path)) throw error
    }
  }
}
