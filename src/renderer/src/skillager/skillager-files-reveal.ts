import {
  containsHostPath,
  hostPathEquals,
  type HostPath,
} from '../../../shared/host-path'
import type { ResolveEntryResponse } from '../../../shared'

/** Skills hands off one exact project folder; Files alone owns subsequent deletion. */
export async function revealSkillagerFolder(
  root: HostPath,
  path: HostPath,
  signal: AbortSignal,
  ports: {
    readonly current: () => boolean
    readonly resolve: (path: HostPath) => Promise<ResolveEntryResponse>
    readonly reveal: (path: HostPath) => void
  },
): Promise<void> {
  signal.throwIfAborted()
  if (!ports.current() || !containsHostPath(root, path) || hostPathEquals(root, path))
    throw new Error('The selected skill folder is outside the current project.')
  const entry = await ports.resolve(path)
  signal.throwIfAborted()
  if (!ports.current() || entry.type !== 'dir' || !hostPathEquals(entry.path, path))
    throw new Error('The selected project folder changed.')
  ports.reveal(path)
}
