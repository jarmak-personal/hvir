/** Exact public canonical identity. Unqualified metadata never provides an association key. */
export function skillagerSourceKey(
  libraryId: string | undefined,
  skillId: string | undefined,
): string | undefined {
  return libraryId && skillId ? JSON.stringify([libraryId, skillId]) : undefined
}

/** A public personal-library ID maps to exactly one canonical child directory. */
export function skillagerLibraryName(id: string): string | undefined {
  return id.length <= 68 && /^lib\/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(id)
    ? id.slice(4)
    : undefined
}
