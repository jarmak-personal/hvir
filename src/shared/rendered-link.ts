import { dirnameHostPath, hostPath, joinHostPath, type HostPath } from './host-path'

export type RenderedLinkTarget =
  | { readonly kind: 'anchor'; readonly fragment: string }
  | { readonly kind: 'file'; readonly path: HostPath; readonly fragment?: string }
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'blocked' }

const REPOSITORY_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

/** MIME allow-list for image assets that may cross the ProjectHost IPC seam. */
export function repositoryImageMimeType(path: string): string | undefined {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase()
  return extension ? REPOSITORY_IMAGE_MIME_TYPES[extension] : undefined
}

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
