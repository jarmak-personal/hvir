export function extensionObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object')
  return value as Record<string, unknown>
}

export function extensionText(value: unknown, name: string, max = 120): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    throw new Error(`Invalid ${name}`)
  }
  return value
}

export function extensionId(value: unknown): string {
  const text = extensionText(value, 'identity', 80)
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(text))
    throw new Error('Invalid extension identity')
  return text
}

export function extensionAssetPath(value: unknown): string {
  const text = extensionText(value, 'asset path', 240)
  if (
    text.startsWith('/') ||
    text.includes('\\') ||
    text.includes('%') ||
    text.includes('?') ||
    text.includes('#') ||
    text.includes(':') ||
    text.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Asset paths must stay inside the package')
  }
  return text
}
