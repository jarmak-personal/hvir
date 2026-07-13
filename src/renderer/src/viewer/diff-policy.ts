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
