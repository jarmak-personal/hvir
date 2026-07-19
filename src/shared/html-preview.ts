import type { HostPath } from './host-path'

/** HTML previews execute only inside an opaque-origin sandboxed frame. */
export const HTML_PREVIEW_SCHEME = 'hvir-preview'
export const HTML_SANDBOX = 'allow-scripts'

/** Applied as a response header by the custom protocol, before any HTML runs. */
export const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export interface CreateHtmlPreviewRequest {
  readonly path: HostPath
  readonly content: string
}

export interface CreateHtmlPreviewResponse {
  readonly id: string
  readonly url: string
}

export interface ReleaseHtmlPreviewRequest {
  readonly id: string
}
