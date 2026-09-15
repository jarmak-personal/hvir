import { repositoryImageMimeType } from '../../shared'
import type { HostPath } from '../../shared/host-path'
import type { SkillagerReviewContent } from '../../shared/skillager-review'
import type { SkillagerReviewPreviewPort } from './skillager-review-port'
import { SkillagerError } from './skillager-port'

/** Present bytes already admitted by their own ordinary-document or verified-review owner. */
export function skillagerFileContent(
  entry: string,
  path: HostPath,
  bytes: Uint8Array,
  asset: boolean,
  previewRoot: HostPath,
  previews: Map<string, { readonly id: string; readonly url: string }>,
  protocol: SkillagerReviewPreviewPort,
): SkillagerReviewContent {
  const result = { entry, path, size: bytes.byteLength }
  const mime = repositoryImageMimeType(path.path)
  if (mime) return { ...result, image: { mime, bytes } }
  if (asset)
    throw new SkillagerError(
      'invalid-request',
      'Only image assets may load automatically.',
    )
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return result
  }
  if (text.includes('\0')) return result
  if (/\.html?$/i.test(path.path)) {
    let preview = previews.get(entry)
    if (!preview) {
      preview = protocol.create(text, previewRoot)
      previews.set(entry, preview)
    }
    return { ...result, text, htmlUrl: preview.url }
  }
  return { ...result, text }
}
