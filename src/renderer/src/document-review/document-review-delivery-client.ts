import {
  unwrapOperation,
  type DocumentReviewDeliveryDestination,
  type DocumentReviewDeliveryPayload,
  type DocumentReviewDeliverySelection,
  type DocumentReviewWorkspaceSnapshot,
  type PreparedDocumentReviewDelivery,
  type ReviewWorkspaceIdentity,
} from '../../../shared'
import { consumedSendError } from './document-review-delivery-feedback'

export interface RendererDocumentReviewDeliveryScope {
  readonly workspace: ReviewWorkspaceIdentity
  readonly workspaceGeneration: number
}

export interface LoadedDocumentReviewDelivery {
  readonly payload: DocumentReviewDeliveryPayload
  readonly destinations: readonly DocumentReviewDeliveryDestination[]
  readonly firstDestination?: DocumentReviewDeliveryDestination
}

export type SubmittedDocumentReviewDelivery =
  | {
      readonly outcome: 'sent'
      readonly snapshot: DocumentReviewWorkspaceSnapshot
    }
  | {
      readonly outcome: 'send-authority-consumed' | 'adoption-rejected'
      readonly error: string
    }

export type DirectDocumentReviewHandoff =
  | { readonly outcome: 'cancelled' }
  | {
      readonly outcome: 'copied' | 'inserted' | 'sent'
      readonly destinations: readonly DocumentReviewDeliveryDestination[]
      readonly destination: DocumentReviewDeliveryDestination
    }
  | {
      readonly outcome: 'blocked'
      readonly destinations: readonly DocumentReviewDeliveryDestination[]
      readonly destination: DocumentReviewDeliveryDestination
      readonly error: string
    }

export async function loadDocumentReviewDelivery(
  scope: RendererDocumentReviewDeliveryScope,
  selection: DocumentReviewDeliverySelection,
): Promise<LoadedDocumentReviewDelivery> {
  const [payload, destinations] = await Promise.all([
    window.hvir
      .invoke('document-review:preview-delivery', { ...scope, selection })
      .then(unwrapOperation),
    window.hvir
      .invoke('document-review:delivery-destinations', scope)
      .then(unwrapOperation),
  ])
  return { payload, destinations, firstDestination: destinations[0] }
}

export function prepareDocumentReviewDelivery(
  scope: RendererDocumentReviewDeliveryScope,
  selection: DocumentReviewDeliverySelection,
  terminalId: string,
): Promise<PreparedDocumentReviewDelivery> {
  return window.hvir
    .invoke('document-review:prepare-delivery', {
      ...scope,
      selection,
      terminalId,
    })
    .then(unwrapOperation)
}

export function insertPreparedDocumentReviewDelivery(preparedId: string): Promise<void> {
  return window.hvir
    .invoke('document-review:insert-delivery', { preparedId })
    .then((result) => {
      unwrapOperation(result)
    })
}

export async function submitPreparedDocumentReviewDelivery(
  preparedId: string,
  adopt: (snapshot: DocumentReviewWorkspaceSnapshot) => boolean,
): Promise<SubmittedDocumentReviewDelivery> {
  const result = unwrapOperation(
    await window.hvir.invoke('document-review:send-now-delivery', { preparedId }),
  )
  if (result.outcome === 'send-authority-consumed') {
    return { outcome: result.outcome, error: consumedSendError(result) }
  }
  return adopt(result.snapshot)
    ? { outcome: 'sent', snapshot: result.snapshot }
    : {
        outcome: 'adoption-rejected',
        error:
          'Review was submitted at the PTY boundary, but the local view changed; reopen the workspace to refresh lifecycle state before preparing another send.',
      }
}

export function copyDocumentReviewPayload(body: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error('Clipboard writing is unavailable'))
  }
  return navigator.clipboard.writeText(body)
}

export async function performDirectDocumentReviewHandoff(
  scope: RendererDocumentReviewDeliveryScope,
  selection: DocumentReviewDeliverySelection,
  adopt: (snapshot: DocumentReviewWorkspaceSnapshot) => boolean,
  isCurrent: () => boolean,
): Promise<DirectDocumentReviewHandoff> {
  const { payload, destinations, firstDestination } = await loadDocumentReviewDelivery(
    scope,
    selection,
  )
  if (!isCurrent()) return { outcome: 'cancelled' }
  if (!firstDestination) {
    throw new Error('Open a terminal in this workspace before sending the review')
  }
  if (firstDestination.capability === 'copy-only') {
    await copyDocumentReviewPayload(payload.body)
    return isCurrent()
      ? { outcome: 'copied', destinations, destination: firstDestination }
      : { outcome: 'cancelled' }
  }
  const prepared = await prepareDocumentReviewDelivery(
    scope,
    selection,
    firstDestination.terminalId,
  )
  if (!isCurrent()) return { outcome: 'cancelled' }
  if (prepared.destination.capability === 'insert') {
    await insertPreparedDocumentReviewDelivery(prepared.id)
    return isCurrent()
      ? { outcome: 'inserted', destinations, destination: prepared.destination }
      : { outcome: 'cancelled' }
  }
  const submitted = await submitPreparedDocumentReviewDelivery(prepared.id, adopt)
  if (!isCurrent()) return { outcome: 'cancelled' }
  return submitted.outcome === 'sent'
    ? { outcome: 'sent', destinations, destination: prepared.destination }
    : {
        outcome: 'blocked',
        destinations,
        destination: prepared.destination,
        error: submitted.error,
      }
}
