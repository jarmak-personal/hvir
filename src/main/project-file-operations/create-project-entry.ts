import {
  joinHostPath,
  type HostPath,
  type ProjectFileCreateKind,
  type ProjectFileItemResult,
} from '../../shared'
import { isProjectPathExistsError, type ProjectHost } from '../project-host'
import {
  boundedProjectFileReason,
  isMissingProjectPathError,
  proveRealProjectDirectory,
} from './project-file-confinement'

export async function createProjectEntry(options: {
  readonly host: ProjectHost
  readonly workspaceRoot: HostPath
  readonly canonicalRoot: HostPath
  readonly destinationDirectory: HostPath
  readonly name: string
  readonly kind: ProjectFileCreateKind
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
}): Promise<ProjectFileItemResult> {
  const destination = joinHostPath(options.destinationDirectory, options.name)
  let authorityInvalid = false
  const assertCurrent = (): void => {
    try {
      options.assertCurrent()
    } catch (reason) {
      authorityInvalid = true
      throw reason
    }
  }
  try {
    assertCurrent()
    const canonicalDirectory = await proveRealProjectDirectory(
      options.host,
      options.workspaceRoot,
      options.canonicalRoot,
      options.destinationDirectory,
    )
    assertCurrent()
    const canonicalDestination = joinHostPath(canonicalDirectory, options.name)
    try {
      await options.host.stat(canonicalDestination)
      return conflict(destination)
    } catch (reason) {
      if (!isMissingProjectPathError(reason)) throw reason
    }
    assertCurrent()
    if (options.kind === 'file') {
      await options.host.createFileExclusive(canonicalDestination, {
        mode: 0o644,
        signal: options.signal,
      })
    } else {
      await options.host.createDirectoryExclusive(canonicalDestination, {
        mode: 0o755,
        signal: options.signal,
      })
    }
    return {
      itemId: 'create:0',
      destination,
      status: 'completed',
      effect: options.kind === 'file' ? 'created-file' : 'created-directory',
    }
  } catch (reason) {
    if (isProjectPathExistsError(reason)) return conflict(destination)
    if (
      options.signal.aborted ||
      authorityInvalid ||
      (reason instanceof Error && reason.name === 'AbortError')
    ) {
      return {
        itemId: 'create:0',
        destination,
        status: 'cancelled',
        effect: 'none',
        reason: boundedProjectFileReason(
          options.signal.reason ?? reason,
          'The operation was cancelled',
        ),
      }
    }
    return {
      itemId: 'create:0',
      destination,
      status: 'failed',
      effect: 'none',
      reason: boundedProjectFileReason(reason, 'The entry could not be created'),
    }
  }
}

function conflict(destination: HostPath): ProjectFileItemResult {
  return {
    itemId: 'create:0',
    destination,
    status: 'conflicted',
    effect: 'none',
    reason: 'The destination already exists',
  }
}
