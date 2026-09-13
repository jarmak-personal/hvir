/** Exact public canonical identity. Unqualified metadata never provides an association key. */
export function skillagerSourceKey(
  libraryId: string | undefined,
  skillId: string | undefined,
): string | undefined {
  return libraryId && skillId ? JSON.stringify([libraryId, skillId]) : undefined
}
