import {
  basenameHostPath,
  dirnameHostPath,
  joinHostPath,
  type HostPath,
  type ProjectFileItemResult,
  type ProjectFileOrganizationRequest,
  type ProjectFileSourceDisposition,
} from '../../shared'

export function projectEntryDestination(
  request: ProjectFileOrganizationRequest,
): HostPath {
  const directory =
    request.action === 'rename'
      ? dirnameHostPath(request.source)
      : request.destinationDirectory
  const name = request.action === 'move' ? basenameHostPath(request.source) : request.name
  return joinHostPath(directory, name)
}

export function retainedSource(path: HostPath): ProjectFileSourceDisposition {
  return { outcome: 'retained', path }
}

export function visibleSourceDisposition(
  disposition: ProjectFileSourceDisposition,
  visibleSource: HostPath,
): ProjectFileSourceDisposition {
  return disposition.outcome === 'removed'
    ? disposition
    : { ...disposition, path: visibleSource }
}

export function projectEntryConflict(
  source: HostPath,
  destination: HostPath,
): ProjectFileItemResult {
  return projectEntryResult(
    source,
    destination,
    'conflicted',
    'The destination already exists',
  )
}

export function projectEntrySkipped(
  source: HostPath,
  destination: HostPath,
  reason: string,
): ProjectFileItemResult {
  return projectEntryResult(source, destination, 'skipped', reason)
}

export function projectEntryFailed(
  source: HostPath,
  destination: HostPath,
  reason: string,
): ProjectFileItemResult {
  return projectEntryResult(source, destination, 'failed', reason)
}

export function projectEntryCancelled(
  source: HostPath,
  destination: HostPath,
  reason: string,
): ProjectFileItemResult {
  return {
    ...projectEntryResult(source, destination, 'failed', reason),
    status: 'cancelled',
  }
}

function projectEntryResult(
  source: HostPath,
  destination: HostPath,
  status: 'conflicted' | 'skipped' | 'failed',
  reason: string,
): ProjectFileItemResult {
  return {
    itemId: 'organize:0',
    source,
    destination,
    status,
    effect: 'none',
    sourceDisposition: retainedSource(source),
    reason,
  }
}
