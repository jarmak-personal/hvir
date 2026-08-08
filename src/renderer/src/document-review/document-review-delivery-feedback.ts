import type {
  DocumentReviewDeliveryDestination,
  DocumentReviewSendNowResult,
} from '../../../shared'

export function deliveryError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function consumedSendError(
  result: Extract<DocumentReviewSendNowResult, { outcome: 'send-authority-consumed' }>,
): string {
  const guidance =
    'Send authority was consumed to prevent a duplicate. Copy remains available; preview and prepare again before another send.'
  return result.ptyAcceptance === 'confirmed'
    ? `The complete review write was accepted at the PTY boundary, but hvir could not finish clearing the delivered review: ${result.reason}. This does not prove agent receipt. ${guidance}`
    : `PTY write completion is indeterminate: ${result.reason}. The review may have been submitted, but this does not prove agent receipt. ${guidance}`
}

export function insertedReviewNotice(
  destination: DocumentReviewDeliveryDestination,
): string {
  return `Inserted into ${destination.title}. Submit it in the terminal when ready.`
}

export function sentReviewNotice(destination: DocumentReviewDeliveryDestination): string {
  return `Sent to ${destination.title}.`
}

export function copiedReviewNotice(
  destination: DocumentReviewDeliveryDestination,
): string {
  return `Copied review for ${destination.title}; this terminal cannot receive it safely.`
}
