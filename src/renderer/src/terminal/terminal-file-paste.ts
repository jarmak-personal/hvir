import type { HvirApi } from '../../../shared'

type TerminalFilePasteApi = Pick<HvirApi, 'invoke' | 'resolveTerminalClipboardFilePaste'>

/** Select the browser File fallback or the owner-scoped native clipboard edge. */
export function resolveTerminalFilePaste(
  api: TerminalFilePasteApi,
  file: File | undefined,
): string | undefined | Promise<string | undefined> {
  return file
    ? api.resolveTerminalClipboardFilePaste(file)
    : api.invoke('terminal:resolve-file-clipboard', {})
}
