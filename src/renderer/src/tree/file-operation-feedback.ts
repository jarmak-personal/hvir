import type { ProjectFileOperationResult } from '../../../shared'
import type { ViewerPathRemovalResult } from '../viewer/viewer-path-removal'

export interface FileActionFeedback {
  readonly kind: 'success' | 'error'
  readonly message: string
  readonly details?: readonly string[]
}

export function projectFileResultHasEffect(
  result: ProjectFileOperationResult | undefined,
): boolean {
  return (
    result?.outcome === 'completed' && result.items.some((item) => item.effect !== 'none')
  )
}

export function organizationFeedback(
  result: ProjectFileOperationResult | undefined,
): FileActionFeedback {
  if (!result || result.outcome !== 'completed') {
    return { kind: 'error', message: 'The file operation ended without a result.' }
  }
  const item = result.items[0]
  if (!item) return { kind: 'error', message: 'The file operation returned no item.' }
  const action =
    item.effect === 'renamed-entry'
      ? 'renamed'
      : item.effect === 'moved-entry'
        ? 'moved'
        : item.effect === 'duplicated-file' || item.effect === 'duplicated-directory'
          ? 'duplicated'
          : item.effect === 'copied-file' || item.effect === 'copied-directory'
            ? 'copied; source retained'
            : item.status
  const recovery = item.sourceDisposition?.path?.path
  return {
    kind: item.status === 'completed' ? 'success' : 'error',
    message: `Entry ${action}.`,
    details: [
      `${item.destination.path}: ${item.status}${item.reason ? ` — ${item.reason}` : ''}${recovery ? ` — source at ${recovery}` : ''}`,
    ],
  }
}

export function copyFeedback(
  result: ProjectFileOperationResult | undefined,
): FileActionFeedback {
  if (!result || result.outcome !== 'completed') {
    return { kind: 'error', message: 'The copy operation ended without a result.' }
  }
  const completed = result.items.filter((item) => item.status === 'completed').length
  const problems = result.items.length - completed
  return {
    kind: problems === 0 ? 'success' : 'error',
    message:
      problems === 0
        ? `${completed} ${completed === 1 ? 'entry' : 'entries'} copied.`
        : `${completed} copied; ${problems} not copied.`,
    details: result.items.map((item) => {
      const name = item.destination.path.split('/').at(-1) || item.destination.path
      return `${name}: ${item.status}${item.reason ? ` — ${item.reason}` : ''}`
    }),
  }
}

export function externalMoveFeedback(
  result: ProjectFileOperationResult | undefined,
): FileActionFeedback {
  if (!result || result.outcome !== 'completed') {
    return { kind: 'error', message: 'The external move ended without a result.' }
  }
  const moved = result.items.filter((item) =>
    ['moved-external-file', 'moved-external-directory'].includes(item.effect),
  ).length
  const retained = result.items.filter(
    (item) =>
      ['copied-file', 'copied-directory'].includes(item.effect) &&
      item.sourceDisposition?.outcome === 'retained',
  ).length
  const copiedUnknown = result.items.filter(
    (item) =>
      ['copied-file', 'copied-directory'].includes(item.effect) &&
      item.sourceDisposition?.outcome === 'unknown',
  ).length
  const unknown = result.items.filter(
    (item) => item.effect === 'external-move-state-unknown',
  ).length
  const notCopied = result.items.length - moved - retained - copiedUnknown - unknown
  const parts = [
    moved ? `${moved} moved` : '',
    retained ? `${retained} copied with source retained` : '',
    copiedUnknown ? `${copiedUnknown} copied with source outcome unknown` : '',
    unknown ? `${unknown} outcome unknown` : '',
    notCopied ? `${notCopied} not copied` : '',
  ].filter(Boolean)
  return {
    kind: moved === result.items.length ? 'success' : 'error',
    message: `${parts.join('; ') || 'No entries moved'}.`,
    details: result.items.map((item) => {
      const name = item.destination.path.split('/').at(-1) || item.destination.path
      const source = item.sourceDisposition?.outcome
      return `${name}: ${item.status}${source ? ` — source ${source}` : ''}${item.reason ? ` — ${item.reason}` : ''}`
    }),
  }
}

export function deletionFeedback(
  result: ProjectFileOperationResult | undefined,
  viewerCleanup?: ViewerPathRemovalResult,
): FileActionFeedback {
  if (!result || result.outcome !== 'completed') {
    return { kind: 'error', message: 'The deletion ended without a result.' }
  }
  const item = result.items[0]
  if (!item) return { kind: 'error', message: 'The deletion returned no item.' }
  const partial = item.sourceDisposition
  const retainedDirty = viewerCleanup?.dirtyPaths.length ?? 0
  const details = [
    `${item.source?.path ?? item.destination.path}: ${item.status}${item.reason ? ` — ${item.reason}` : ''}`,
    ...(partial?.outcome === 'partially-removed'
      ? [
          `${partial.removedEntries ?? 0} of ${partial.totalEntries ?? 0} entries removed; retained state remains at ${partial.path?.path ?? item.destination.path}.`,
        ]
      : []),
    ...(partial?.outcome === 'unknown'
      ? [
          `The Trash request was submitted, but source state at ${partial.path?.path ?? item.destination.path} no longer matches the confirmed entry. Recovery was not confirmed.`,
        ]
      : []),
    ...(retainedDirty > 0
      ? [
          `${retainedDirty} tab${retainedDirty === 1 ? '' : 's'} became dirty after confirmation and ${retainedDirty === 1 ? 'was' : 'were'} retained with unsaved content.`,
        ]
      : []),
  ]
  return {
    kind: item.status === 'completed' ? 'success' : 'error',
    message:
      item.effect === 'trashed-entry'
        ? 'Entry moved to Trash.'
        : item.effect === 'permanently-deleted-entry'
          ? 'Entry deleted permanently.'
          : item.effect === 'partially-deleted-entry'
            ? 'Entry was only partially deleted.'
            : item.effect === 'deletion-state-unknown'
              ? 'Deletion outcome could not be verified.'
              : 'Entry was not deleted.',
    details,
  }
}
