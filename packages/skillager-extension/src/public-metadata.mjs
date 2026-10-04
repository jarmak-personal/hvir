/* global TextEncoder */
/** Bounded public CLI metadata; no catalog or filesystem implementation. */
export function metadataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Skillager metadata is unavailable')
  return value
}
export function metadataText(value, maximum = 4096) {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    new TextEncoder().encode(JSON.stringify(value)).length > maximum * 4 + 2
  )
    throw new Error('Skillager metadata is unavailable')
  return value
}
export function metadataSourcePath(value) {
  const path = metadataText(value)
  if (new TextEncoder().encode(JSON.stringify(path)).length > 4098)
    throw new Error(
      'Source path exceeds the 4096-byte encoded identity bound; no path was truncated or substituted',
    )
  return path
}
