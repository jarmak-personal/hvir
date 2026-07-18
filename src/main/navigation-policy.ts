/** Only these explicit external schemes may leave hvir for the OS browser. */
export function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const protocol = new URL(rawUrl).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:'
  } catch {
    return false
  }
}

/**
 * Dashboard webviews may only show the local end of a tunnel. Everything a
 * web pane renders comes through `127.0.0.1`, whether the service is local or
 * forwarded over SSH.
 */
export function isLoopbackHttpUrl(rawUrl: string): boolean {
  try {
    const candidate = new URL(rawUrl)
    return candidate.protocol === 'http:' && candidate.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

/** Workbench reloads may revisit its entry document, never an arbitrary child path. */
export function isWorkbenchDocument(rawUrl: string, entryUrl: string): boolean {
  try {
    const candidate = new URL(rawUrl)
    const entry = new URL(entryUrl)
    return (
      candidate.protocol === entry.protocol &&
      candidate.host === entry.host &&
      normalizedPath(candidate.pathname) === normalizedPath(entry.pathname)
    )
  } catch {
    return false
  }
}

function normalizedPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}
