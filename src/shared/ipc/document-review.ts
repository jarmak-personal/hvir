import { invoke, type IpcFeatureContract } from '../ipc-contract'
import {
  type DocumentReviewRestoreRequest,
  type DocumentReviewDeliveryDestination,
  type DocumentReviewDeliveryPayload,
  type DocumentReviewDeliveryScopeRequest,
  type DocumentReviewInsertRequest,
  type DocumentReviewInsertResult,
  type DocumentReviewPrepareRequest,
  type DocumentReviewPreviewRequest,
  type DocumentReviewRevalidateRequest,
  type DocumentReviewRevalidation,
  type DocumentReviewSaveRequest,
  type DocumentReviewSendNowRequest,
  type DocumentReviewSendNowResult,
  type DocumentReviewWorkspaceSnapshot,
  type PreparedDocumentReviewDelivery,
} from '../document-review'
import { type OperationResult } from '../operation-result'

export const documentReviewIpc = {
  invoke: {
    'document-review:restore': invoke<
      DocumentReviewRestoreRequest,
      OperationResult<DocumentReviewWorkspaceSnapshot>
    >(),
    'document-review:save': invoke<
      DocumentReviewSaveRequest,
      OperationResult<DocumentReviewWorkspaceSnapshot>
    >(),
    'document-review:revalidate': invoke<
      DocumentReviewRevalidateRequest,
      OperationResult<DocumentReviewRevalidation>
    >(),
    'document-review:delivery-destinations': invoke<
      DocumentReviewDeliveryScopeRequest,
      OperationResult<readonly DocumentReviewDeliveryDestination[]>
    >(),
    'document-review:preview-delivery': invoke<
      DocumentReviewPreviewRequest,
      OperationResult<DocumentReviewDeliveryPayload>
    >(),
    'document-review:prepare-delivery': invoke<
      DocumentReviewPrepareRequest,
      OperationResult<PreparedDocumentReviewDelivery>
    >(),
    'document-review:insert-delivery': invoke<
      DocumentReviewInsertRequest,
      OperationResult<DocumentReviewInsertResult>
    >(),
    'document-review:send-now-delivery': invoke<
      DocumentReviewSendNowRequest,
      OperationResult<DocumentReviewSendNowResult>
    >(),
  },
  send: {},
  event: {},
} satisfies IpcFeatureContract
