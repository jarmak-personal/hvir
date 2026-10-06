import type { ExtensionInstallation } from '../../shared/extensions/workbench'
import type { AcceptedInstallation, PackageRemoval } from './installation-state'

/** Pure import admission; scanning, current intent and effects remain with the writer. */
export function assertImportInactive(id: string, activeIds: readonly string[]): void {
  if (activeIds.includes(id))
    throw new Error(
      'This extension identity is enabled. Use its existing Reload or Replace control.',
    )
}

export function assertImportAvailable(
  name: string,
  id: string,
  state: {
    readonly capacity: boolean
    readonly installations: readonly Pick<
      ExtensionInstallation,
      'source' | 'sourceIdentity' | 'manifest'
    >[]
    readonly accepted: readonly Pick<AcceptedInstallation, 'source' | 'packageId'>[]
    readonly removals: readonly Pick<PackageRemoval, 'source'>[]
  },
): void {
  if (state.capacity)
    throw new Error('Remove an unused package before adding another extension')
  if (state.installations.some((entry) => entry.source === name && entry.sourceIdentity))
    throw new Error(
      'A package with this filename already exists. Remove it explicitly or choose a different filename.',
    )
  if (
    state.installations.some(
      (entry) => entry.manifest?.id === id && entry.sourceIdentity,
    ) ||
    state.removals.some(
      (entry) =>
        entry.source === name ||
        state.accepted.some(
          (saved) => saved.source === entry.source && saved.packageId === id,
        ),
    )
  )
    throw new Error(
      'This extension identity is already present or removal is unfinished. Finish Remove before adding it again.',
    )
}
