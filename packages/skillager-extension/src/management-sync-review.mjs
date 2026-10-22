/* global crypto, TextEncoder */
/** Bind the complete public metadata shown to a human; this is not a Skillager tree hash. */
export function metadataEncoding(value) {
  const canonical = (item) =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, canonical(item[key])]),
          )
        : item
  return JSON.stringify(canonical(value))
}
export async function syncReviewHash(value) {
  const bytes = new TextEncoder().encode(metadataEncoding(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
