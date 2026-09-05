import { containsHostPath, hostPath, type HostPath } from './host-path'
import { renderedFileType } from './viewer-types'

/** Lexical candidates only. Main must separately prove canonical containment. */
export function temporaryDocumentRoot(path: HostPath): HostPath | undefined {
  return ['/tmp', '/private/tmp']
    .map((root) => hostPath(path.hostId, root))
    .find((root) => path.path !== root.path && containsHostPath(root, path))
}

export function isTemporaryDocument(path: HostPath): boolean {
  const type = renderedFileType(path)
  return Boolean(temporaryDocumentRoot(path) && (type === 'markdown' || type === 'html'))
}
