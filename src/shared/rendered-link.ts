import { dirnameHostPath, hostPath, joinHostPath, type HostPath } from './host-path'

export type RenderedLinkTarget =
  | { readonly kind: 'anchor'; readonly fragment: string }
  | { readonly kind: 'file'; readonly path: HostPath; readonly fragment?: string }
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'blocked' }

/** Resolve an untrusted rendered-document href without involving browser navigation. */
export function resolveRenderedLink(
  documentPath: HostPath,
  rawHref: string,
): RenderedLinkTarget {
  const href = rawHref.trim()
  if (!href) return { kind: 'blocked' }
  if (href.startsWith('#')) {
    return { kind: 'anchor', fragment: decode(href.slice(1)) ?? href.slice(1) }
  }
  if (/^(https?:|mailto:)/i.test(href)) return { kind: 'external', url: href }
  if (href.startsWith('//')) return { kind: 'external', url: `https:${href}` }
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return { kind: 'blocked' }

  const hashAt = href.indexOf('#')
  const pathAndQuery = hashAt < 0 ? href : href.slice(0, hashAt)
  const rawFragment = hashAt < 0 ? undefined : href.slice(hashAt + 1)
  const queryAt = pathAndQuery.indexOf('?')
  const rawPath = queryAt < 0 ? pathAndQuery : pathAndQuery.slice(0, queryAt)
  const decodedPath = decode(rawPath)
  if (!decodedPath || decodedPath.includes('\0')) return { kind: 'blocked' }
  const path = decodedPath.startsWith('/')
    ? hostPath(documentPath.hostId, decodedPath)
    : joinHostPath(dirnameHostPath(documentPath), decodedPath)
  const fragment = rawFragment === undefined ? undefined : decode(rawFragment)
  return { kind: 'file', path, fragment: fragment ?? rawFragment }
}

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}
