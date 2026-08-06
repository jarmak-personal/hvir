import type { HostPath } from '../../../shared'

export type PathCopyKind = 'relative' | 'absolute'

export const PATH_COPY_LABELS: Readonly<Record<PathCopyKind, string>> = {
  relative: 'Copy Relative Path',
  absolute: 'Copy Absolute Path',
}

export function pathCopyValue(
  workspaceRoot: HostPath,
  target: HostPath,
  kind: PathCopyKind,
): string {
  if (workspaceRoot.hostId !== target.hostId) {
    throw new Error('The path is not on the active workspace host')
  }
  if (target.path === workspaceRoot.path) {
    return kind === 'absolute' ? target.path : '.'
  }

  const prefix = workspaceRoot.path === '/' ? '/' : `${workspaceRoot.path}/`
  if (!target.path.startsWith(prefix)) {
    throw new Error('The path is outside the active workspace')
  }
  return kind === 'absolute' ? target.path : target.path.slice(prefix.length)
}

export async function copyHostPath(
  workspaceRoot: HostPath,
  target: HostPath,
  kind: PathCopyKind,
  writeText: (value: string) => Promise<void>,
): Promise<string> {
  const value = pathCopyValue(workspaceRoot, target, kind)
  await writeText(value)
  return value
}

export function writeApplicationClipboard(value: string): Promise<void> {
  return navigator.clipboard?.writeText
    ? navigator.clipboard.writeText(value)
    : Promise.reject(new Error('Clipboard writing is unavailable'))
}
