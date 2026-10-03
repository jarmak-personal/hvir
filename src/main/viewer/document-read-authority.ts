import {
  containsHostPath,
  dirnameHostPath,
  hostPathEquals,
  repositoryImageMimeType,
  type HostPath,
  type ReadFileRequest,
} from '../../shared'
import type { ProjectHost } from '../project-host'

export interface DocumentReadAuthority {
  activeProject(): { readonly root: HostPath; readonly host: ProjectHost }
  reconstructHostPath(path: HostPath): HostPath
  canonicalRoot(root: HostPath, host: ProjectHost): Promise<HostPath>
  projectPath(
    path: HostPath,
    root: HostPath,
    host: ProjectHost,
    options: { readonly returnCanonical: true },
  ): Promise<HostPath>
}

/** Agent presentation has explicit pinned registered-root authority, never human-click exceptions. */
export async function authorizeAgentDocument(
  host: ProjectHost,
  root: HostPath,
  candidate: HostPath,
  current: () => void,
): Promise<HostPath> {
  current()
  if (
    !candidate.path.startsWith('/') ||
    candidate.path.includes('\0') ||
    !containsHostPath(root, candidate)
  )
    throw new Error('Document escapes its registered workspace')
  const canonicalRoot = await host.realpath(root)
  current()
  const canonical = await host.realpath(candidate)
  current()
  if (!containsHostPath(canonicalRoot, canonical))
    throw new Error('Document escapes its registered workspace through a symlink')
  const stat = await host.stat(canonical)
  current()
  if (stat.type !== 'file' || stat.size > 64 * 1024 * 1024)
    throw new Error('Document is not an admitted regular file')
  return canonical
}

/** Explicit viewing authority; project mutations never call this owner. */
export async function authorizeDocumentRead(
  authority: DocumentReadAuthority,
  request: ReadFileRequest,
  kind: 'document' | 'asset' = 'document',
): Promise<{
  readonly path: HostPath
  readonly root: HostPath
  readonly host: ProjectHost
  readonly external: boolean
  readonly assertCurrent: () => void
}> {
  const { root, host } = authority.activeProject()
  const candidate = authority.reconstructHostPath(request.path)
  if (candidate.hostId !== root.hostId) throw new Error('Path belongs to another host')
  const assertCurrent = (): void => {
    const active = authority.activeProject()
    if (active.host !== host || !hostPathEquals(active.root, root)) {
      throw new Error('Document workspace is no longer active')
    }
    if (host.connectionState !== 'connected')
      throw new Error('Document host is disconnected')
  }
  const contextual = request.workspaceRoot !== undefined
  if (
    contextual &&
    !hostPathEquals(authority.reconstructHostPath(request.workspaceRoot), root)
  ) {
    throw new Error('Document requires its originating active workspace')
  }
  assertCurrent()
  // Existing project-only callers retain their confined authority. Explicit viewer
  // reads carry their origin even for lexical project paths that may be symlinks.
  if (!contextual) {
    const path = await authority.projectPath(candidate, root, host, {
      returnCanonical: true,
    })
    assertCurrent()
    return { path, root, host, external: false, assertCurrent }
  }
  const canonicalRoot = await authority.canonicalRoot(root, host)
  const path = authority.reconstructHostPath(await host.realpath(candidate))
  if (path.hostId !== root.hostId)
    throw new Error('Resolved path belongs to another host')
  let external =
    !containsHostPath(canonicalRoot, path) || !containsHostPath(root, candidate)
  if (kind === 'asset') {
    if (!repositoryImageMimeType(path.path))
      throw new Error('Only image assets can be previewed')
    if (!request.documentPath) throw new Error('Image read requires its source document')
    const document = authority.reconstructHostPath(request.documentPath)
    if (document.hostId !== root.hostId)
      throw new Error('Document belongs to another host')
    const canonicalDocument = authority.reconstructHostPath(await host.realpath(document))
    if (canonicalDocument.hostId !== root.hostId)
      throw new Error('Document belongs to another host')
    // Contextual assets belong to ephemeral viewers, even if an alias resolves
    // inside the project. They never create project polling interests.
    external = true
    const assetRoot = dirnameHostPath(canonicalDocument)
    if (!containsHostPath(assetRoot, path))
      throw new Error('Image escapes the document asset directory')
  }
  assertCurrent()
  return { path, root, host, external, assertCurrent }
}
