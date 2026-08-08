import type { DocumentReviewSendNowResult } from '../../../shared'

export function deliveryError(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function consumedSendError(
  result: Extract<DocumentReviewSendNowResult, { outcome: 'send-authority-consumed' }>,
): string {
  const guidance =
    'Send authority was consumed to prevent a duplicate. Copy remains available; preview and prepare again before another send.'
  return result.ptyAcceptance === 'confirmed'
    ? `The complete review write was accepted at the PTY boundary, but hvir could not finish the sent-state update: ${result.reason}. This does not prove agent receipt. ${guidance}`
    : `PTY write completion is indeterminate: ${result.reason}. The review may have been submitted, but this does not prove agent receipt. ${guidance}`
}
