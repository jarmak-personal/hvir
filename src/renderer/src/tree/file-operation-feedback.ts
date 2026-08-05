import type { ProjectFileOperationResult } from '../../../shared'
import type { FileActionFeedback } from './use-file-create-actions'

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
