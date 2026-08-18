import { isLocal, type FileType, type HostPath } from '../../../shared'

export function canRevealInFileManager(root: HostPath, type: FileType): boolean {
  return isLocal(root) && (type === 'file' || type === 'dir' || type === 'symlink')
}

export function fileManagerRevealLabel(
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
): string {
  return /Mac/.test(platform) ? 'Reveal in Finder' : 'Show in File Manager'
}
