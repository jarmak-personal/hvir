import type { HvirApi } from '../../../shared'

type GhosttyFilePasteApi = Pick<HvirApi, 'invoke' | 'resolveTerminalClipboardFilePaste'>

/** Select the browser File fallback or the owner-scoped native clipboard edge. */
export function resolveGhosttyTerminalFilePaste(
  api: GhosttyFilePasteApi,
  file: File | undefined,
): string | undefined | Promise<string | undefined> {
  return file
    ? api.resolveTerminalClipboardFilePaste(file)
    : api.invoke('terminal:resolve-file-clipboard', {})
}
