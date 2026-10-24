import type { MermaidRenderRequest } from '../presentation/mermaid-contract'
import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import {
  type CreateHtmlPreviewRequest,
  type CreateHtmlPreviewResponse,
  type ReleaseHtmlPreviewRequest,
} from '../html-preview'

export const previewIpc = {
  invoke: {
    'mermaid:render': invoke<MermaidRenderRequest, string>(),
    'html-preview:create': invoke<CreateHtmlPreviewRequest, CreateHtmlPreviewResponse>(),
  },
  send: {
    'mermaid:cancel': payload<{ readonly id: string }>(),
    'html-preview:release': payload<ReleaseHtmlPreviewRequest>(),
  },
  event: {},
} satisfies IpcFeatureContract
