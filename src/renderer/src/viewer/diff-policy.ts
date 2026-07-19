import type { DiffBase } from '../../../shared'

/**
 * Only live-file comparisons may include an unsaved editor buffer. Historical
 * and branch-point diffs describe immutable Git revisions and must not change
 * meaning when the working tab is edited.
 */
export function usesUnsavedContent(
  dirty: boolean,
  base: DiffBase,
  revision?: string,
): boolean {
  return dirty && revision === undefined && base !== 'branch-point'
}

/**
 * A collapsed diff is only an approximation of the document location. Keep the
 * incoming canonical line until the user deliberately navigates this diff, and
 * never derive a location from an empty diff.
 */
export function shouldPublishDiffPosition(
  hasChanges: boolean,
  userNavigated: boolean,
): boolean {
  return hasChanges && userNavigated
}
