export function parseProjectRepository(value: string): [string, string] {
  const parts = value.split('/').map((part) => part.trim())
  if (parts.length !== 2 || parts.some((part) => part === '')) {
    throw new Error('HVIR_REPOSITORY must use owner/name syntax.')
  }
  return [parts[0]!, parts[1]!]
}

export function parseProjectNumber(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('HVIR_PROJECT_NUMBER must be a positive integer.')
  }
  return parsed
}
