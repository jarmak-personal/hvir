import {
  containsHostPath,
  isProjectFileEntryName,
  joinHostPath,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'

export async function proveRealProjectDirectory(
  host: ProjectHost,
  workspaceRoot: HostPath,
  canonicalRoot: HostPath,
  directory: HostPath,
): Promise<HostPath> {
  if (!containsHostPath(workspaceRoot, directory)) {
    throw new Error('The destination directory escapes the workspace')
  }
  const suffix =
    directory.path === workspaceRoot.path
      ? ''
      : directory.path.slice(
          workspaceRoot.path === '/' ? 1 : workspaceRoot.path.length + 1,
        )
  let candidate = canonicalRoot
  if ((await host.stat(candidate)).type !== 'dir') {
    throw new Error('The workspace root is not a real directory')
  }
  for (const segment of suffix ? suffix.split('/') : []) {
    if (!isProjectFileEntryName(segment)) {
      throw new Error('The destination directory is not a normalized project path')
    }
    candidate = joinHostPath(candidate, segment)
    if ((await host.stat(candidate)).type !== 'dir') {
      throw new Error('The destination traverses a non-directory or symbolic link')
    }
  }
  return candidate
}

export function assertNormalizedAbsoluteProjectPath(path: HostPath): void {
  if (
    !path ||
    typeof path.hostId !== 'string' ||
    typeof path.path !== 'string' ||
    !path.path.startsWith('/') ||
    path.path.includes('\0') ||
    path.path.includes('//') ||
    (path.path !== '/' && path.path.endsWith('/')) ||
    path.path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid host-qualified project path')
  }
}

export function projectFilePathKey(path: HostPath): string {
  return `${path.hostId}\0${path.path}`
}

export function isMissingProjectPathError(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | undefined)?.code
  const message = reason instanceof Error ? reason.message : ''
  return code === 'ENOENT' || code === 2 || /no such file|not found/i.test(message)
}

export function boundedProjectFileReason(reason: unknown, fallback: string): string {
  const message = reason instanceof Error ? reason.message : fallback
  return (message || fallback).slice(0, 240)
}
