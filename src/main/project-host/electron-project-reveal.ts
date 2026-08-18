import type { Shell } from 'electron'

import type { HostPath } from '../../shared'

/** Adapt Electron's one local file-manager action without exposing an arbitrary shell. */
export function electronReveal(
  electronShell: Pick<Shell, 'showItemInFolder'>,
): (path: HostPath) => void {
  return (path) => electronShell.showItemInFolder(path.path)
}
