import { invoke, payload, type IpcFeatureContract } from '../ipc-contract'
import {
  type CreateHtmlPreviewRequest,
  type CreateHtmlPreviewResponse,
  type ReleaseHtmlPreviewRequest,
} from '../html-preview'

export const previewIpc = {
  invoke: {
    'html-preview:create': invoke<CreateHtmlPreviewRequest, CreateHtmlPreviewResponse>(),
  },
  send: {
    'html-preview:release': payload<ReleaseHtmlPreviewRequest>(),
  },
  event: {},
} satisfies IpcFeatureContract
