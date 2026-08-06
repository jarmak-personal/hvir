import type { Shell } from 'electron'

import type { HostPath } from '../../shared'

export function electronTrash(
  electronShell: Pick<Shell, 'trashItem'>,
): (path: HostPath) => Promise<void> {
  return (path) => electronShell.trashItem(path.path)
}
