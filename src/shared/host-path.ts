/**
 * Host-qualified paths (ADR-010).
 *
 * Every path in hvir is a `(host, path)` pair — never a bare string, even in
 * local-only code. `HostPath` is an *opaque* type: a bare `string` is not
 * assignable to it, and a plain `{ hostId, path }` object literal is not either.
 * The only way to make one is {@link hostPath}, which normalizes the path. This
 * makes "a bare string path" a compile error at every boundary.
 */

declare const brand: unique symbol

/** An opaque identifier for a host. `'local'` is the default host. */
export type HostId = string & { readonly __hostId: 'HostId' }

export interface HostPath {
  readonly hostId: HostId
  /** Absolute, POSIX-normalized path on that host. */
  readonly path: string
  /** Phantom brand — exists only in the type, never at runtime. */
  readonly [brand]: never
}

/** The default host. Local projects are just the degenerate case (ADR-010). */
export const LOCAL_HOST_ID = 'local' as HostId

/** Tag a raw string as a HostId. Use at trust boundaries (config, IPC decode). */
export function asHostId(id: string): HostId {
  return id as HostId
}

/** The one constructor for a HostPath. Normalizes the path component. */
export function hostPath(hostId: HostId, path: string): HostPath {
  return { hostId, path: normalizePosix(path) } as unknown as HostPath
}

/** Build a HostPath on the local host. */
export function localPath(path: string): HostPath {
  return hostPath(LOCAL_HOST_ID, path)
}

export function isLocal(p: HostPath): boolean {
  return p.hostId === LOCAL_HOST_ID
}

export function hostPathEquals(a: HostPath, b: HostPath): boolean {
  return a.hostId === b.hostId && a.path === b.path
}

/** Join segments onto a HostPath, staying on the same host. */
export function joinHostPath(base: HostPath, ...segments: string[]): HostPath {
  const joined = [base.path, ...segments].join('/')
  return hostPath(base.hostId, joined)
}

export function dirnameHostPath(p: HostPath): HostPath {
  const idx = p.path.lastIndexOf('/')
  if (idx <= 0) return hostPath(p.hostId, idx === 0 ? '/' : '.')
  return hostPath(p.hostId, p.path.slice(0, idx))
}

export function basenameHostPath(p: HostPath): string {
  const idx = p.path.lastIndexOf('/')
  return idx < 0 ? p.path : p.path.slice(idx + 1)
}

/** Human-readable form for UI/logs, e.g. `local:/home/x` or `web1:/srv/app`. */
export function displayHostPath(p: HostPath): string {
  return `${p.hostId}:${p.path}`
}

/**
 * Minimal POSIX path normalization, dependency-free so `@shared` stays
 * importable by the renderer (no `node:path`). Collapses `//`, resolves `.`
 * and `..`, and drops trailing slashes (except the root).
 */
function normalizePosix(input: string): string {
  const isAbsolute = input.startsWith('/')
  const out: string[] = []
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop()
      } else if (!isAbsolute) {
        out.push('..')
      }
      // for an absolute path, `..` above root is a no-op
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  if (isAbsolute) return '/' + joined
  return joined === '' ? '.' : joined
}
