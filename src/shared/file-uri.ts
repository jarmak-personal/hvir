/** A file URI identifies a path on the originating host, never a host switch. */
export function fileUriPath(target: string): string | undefined {
  try {
    const uri = new URL(target)
    if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost'))
      return undefined
    const path = decodeURIComponent(uri.pathname)
    return path.startsWith('/') && !path.includes('\0') ? path : undefined
  } catch {
    return undefined
  }
}
