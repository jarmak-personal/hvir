/** Contributor install owner; application imports are forbidden. */
export function applyNodePtyPatch(repositoryRoot?: string): Promise<{
  state: 'patched' | 'verified'
  version: string
}>
