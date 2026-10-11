/** Initial input is a bounded data snapshot; authority stays in main-owned caller provenance. */
export function validateExtensionViewInput(value: unknown): unknown {
  if (value === undefined) return undefined
  const serialized = JSON.stringify(value)
  if (!serialized || new TextEncoder().encode(serialized).length > 6144)
    throw new Error('Initial contribution input exceeds 6144 bytes')
  return JSON.parse(serialized) as unknown
}
