import {
  containsHostPath,
  hostPath,
  hostPathEquals,
  repositoryImageMimeType,
  type HostPath,
  type ReadFileRequest,
} from '../../shared'
import {
  isTemporaryDocument,
  temporaryDocumentRoot,
} from '../../shared/temporary-document'
import type { ProjectHost } from '../project-host'

export interface DocumentReadAuthority {
  activeProject(): { readonly root: HostPath; readonly host: ProjectHost }
  reconstructHostPath(path: HostPath): HostPath
  projectPath(
    path: HostPath,
    root: HostPath,
    host: ProjectHost,
    options: { readonly returnCanonical: true },
  ): Promise<HostPath>
}

/** Read-only exception; project mutation authority never calls this owner. */
export async function authorizeDocumentRead(
  authority: DocumentReadAuthority,
  request: ReadFileRequest,
  kind: 'document' | 'asset' = 'document',
): Promise<{
  readonly path: HostPath
  readonly root: HostPath
  readonly host: ProjectHost
  readonly temporary: boolean
  readonly assertCurrent: () => void
}> {
  const { root, host } = authority.activeProject()
  const candidate = authority.reconstructHostPath(request.path)
  const temporary = !containsHostPath(root, candidate)
  const assertCurrent = (): void => {
    const active = authority.activeProject()
    if (active.host !== host || !hostPathEquals(active.root, root)) {
      throw new Error('Document workspace is no longer active')
    }
    if (host.connectionState !== 'connected')
      throw new Error('Document host is disconnected')
  }
  if (!temporary) {
    const path = await authority.projectPath(candidate, root, host, {
      returnCanonical: true,
    })
    return { path, root, host, temporary, assertCurrent }
  }
  if (
    !request.workspaceRoot ||
    !hostPathEquals(authority.reconstructHostPath(request.workspaceRoot), root)
  ) {
    throw new Error('Temporary document requires its originating active workspace')
  }
  if (candidate.hostId !== root.hostId) throw new Error('Path belongs to another host')
  const temporaryRoot = temporaryDocumentRoot(candidate)
  if (
    !temporaryRoot ||
    (kind === 'document'
      ? !isTemporaryDocument(candidate)
      : !repositoryImageMimeType(candidate.path))
  ) {
    throw new Error('Only temporary Markdown, HTML, and image assets can be viewed')
  }
  assertCurrent()
  const canonicalRoot = await host.realpath(hostPath(root.hostId, '/tmp'))
  // /private/tmp is accepted only when it is the host's canonical /tmp alias.
  if (
    !['/tmp', '/private/tmp'].includes(canonicalRoot.path) ||
    canonicalRoot.hostId !== root.hostId ||
    (temporaryRoot.path === '/private/tmp' && canonicalRoot.path !== '/private/tmp')
  ) {
    throw new Error('Host temporary root is not supported')
  }
  const path = await host.realpath(candidate)
  if (!containsHostPath(canonicalRoot, path) || hostPathEquals(canonicalRoot, path)) {
    throw new Error('Path escapes the temporary root through a symlink')
  }
  assertCurrent()
  return { path, root, host, temporary, assertCurrent }
}
