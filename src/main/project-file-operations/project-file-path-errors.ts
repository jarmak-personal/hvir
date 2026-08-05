/** Shared errno/message recognition for project-file operation paths. */
export function isMissingProjectPathError(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | undefined)?.code
  const message = reason instanceof Error ? reason.message : ''
  return code === 'ENOENT' || code === 2 || /no such file|not found/i.test(message)
}
