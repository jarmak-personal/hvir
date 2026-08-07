import { useCallback, useEffect, useRef, useState } from 'react'

import {
  unwrapOperation,
  type DocumentReviewDeliveryDestination,
  type DocumentReviewDeliveryPayload,
  type DocumentReviewDeliverySelection,
  type DocumentReviewSendNowResult,
  type PreparedDocumentReviewDelivery,
} from '../../../shared'
import type { DocumentReviewWorkspaceBinding } from './use-document-review-interaction'

export interface DocumentReviewDeliveryInteraction {
  readonly open: boolean
  readonly loading: boolean
  readonly destinations: readonly DocumentReviewDeliveryDestination[]
  readonly selectedTerminalId?: string
  readonly selectedDestination?: DocumentReviewDeliveryDestination
  readonly payload?: DocumentReviewDeliveryPayload
  readonly prepared?: PreparedDocumentReviewDelivery
  readonly error?: string
  readonly copied: boolean
  readonly inserted: boolean
  readonly sent: boolean
  readonly previewComment: (commentId: string) => void
  readonly previewBatch: (batchId: string) => void
  readonly selectDestination: (terminalId: string) => void
  readonly copy: () => void
  readonly insert: () => void
  readonly sendNow: () => void
  readonly close: () => void
}

interface DeliveryState {
  readonly open: boolean
  readonly loading: boolean
  readonly destinations: readonly DocumentReviewDeliveryDestination[]
  readonly selection?: DocumentReviewDeliverySelection
  readonly selectedTerminalId?: string
  readonly selectedDestination?: DocumentReviewDeliveryDestination
  readonly payload?: DocumentReviewDeliveryPayload
  readonly prepared?: PreparedDocumentReviewDelivery
  readonly error?: string
  readonly copied: boolean
  readonly inserted: boolean
  readonly sent: boolean
}

const CLOSED: DeliveryState = {
  open: false,
  loading: false,
  destinations: [],
  copied: false,
  inserted: false,
  sent: false,
}

export function useDocumentReviewDelivery(
  binding: DocumentReviewWorkspaceBinding | undefined,
): DocumentReviewDeliveryInteraction {
  const [state, setState] = useState<DeliveryState>(CLOSED)
  const current = useRef(binding)
  const operationGeneration = useRef(0)
  const previewModel = useRef<unknown>(undefined)
  current.current = binding

  const close = useCallback((): void => {
    operationGeneration.current += 1
    previewModel.current = undefined
    setState(CLOSED)
  }, [])

  const preview = useCallback((selection: DocumentReviewDeliverySelection): void => {
    const generation = (operationGeneration.current += 1)
    previewModel.current = undefined
    setState({
      open: true,
      loading: true,
      destinations: [],
      selection,
      copied: false,
      inserted: false,
      sent: false,
    })
    const target = current.current
    void (async () => {
      await target?.flush()
      const scope = readyScope(current.current)
      if (!scope) throw new Error('Document review is still restoring this workspace')
      const [payload, destinations] = await Promise.all([
        window.hvir
          .invoke('document-review:preview-delivery', { ...scope, selection })
          .then(unwrapOperation),
        window.hvir
          .invoke('document-review:delivery-destinations', scope)
          .then(unwrapOperation),
      ])
      if (operationGeneration.current !== generation) return
      previewModel.current = current.current?.state.model
      setState({
        open: true,
        loading: false,
        destinations,
        selection,
        payload,
        copied: false,
        inserted: false,
        sent: false,
      })
    })().catch((reason: unknown) => {
      if (operationGeneration.current !== generation) return
      setState({
        open: true,
        loading: false,
        destinations: [],
        selection,
        error: errorMessage(reason),
        copied: false,
        inserted: false,
        sent: false,
      })
    })
  }, [])

  const selectDestination = useCallback((terminalId: string): void => {
    const selection = state.selection
    const destination = state.destinations.find(
      (candidate) => candidate.terminalId === terminalId,
    )
    if (!selection || (terminalId && !destination)) return
    if (!terminalId) {
      operationGeneration.current += 1
      setState((value) => ({
        ...value,
        selectedTerminalId: undefined,
        selectedDestination: undefined,
        prepared: undefined,
        error: undefined,
        inserted: false,
      }))
      return
    }
    if (destination?.capability === 'copy-only') {
      operationGeneration.current += 1
      setState((value) => ({
        ...value,
        loading: false,
        selectedTerminalId: terminalId,
        selectedDestination: destination,
        prepared: undefined,
        error: undefined,
        inserted: false,
      }))
      return
    }
    const generation = (operationGeneration.current += 1)
    setState((value) => ({
      ...value,
      loading: true,
      selectedTerminalId: terminalId,
      selectedDestination: destination,
      prepared: undefined,
      error: undefined,
      inserted: false,
      sent: false,
    }))
    const target = current.current
    void (async () => {
      await target?.flush()
      const scope = readyScope(current.current)
      if (!scope) throw new Error('Document review is still restoring this workspace')
      const prepared = unwrapOperation(
        await window.hvir.invoke('document-review:prepare-delivery', {
          ...scope,
          selection,
          terminalId,
        }),
      )
      if (operationGeneration.current !== generation) return
      previewModel.current = current.current?.state.model
      setState((value) => ({
        ...value,
        loading: false,
        selectedDestination: prepared.destination,
        payload: prepared.payload,
        prepared,
        error: undefined,
        inserted: false,
        sent: false,
      }))
    })().catch((reason: unknown) => {
      if (operationGeneration.current !== generation) return
      setState((value) => ({
        ...value,
        loading: false,
        selectedTerminalId: undefined,
        selectedDestination: undefined,
        prepared: undefined,
        error: errorMessage(reason),
      }))
    })
  }, [state.destinations, state.selection])

  const copy = useCallback((): void => {
    const payload = state.payload
    if (!payload) return
    void writeReviewClipboard(payload.body).then(
      () => setState((value) => ({ ...value, copied: true, error: undefined })),
      (reason: unknown) =>
        setState((value) => ({ ...value, copied: false, error: errorMessage(reason) })),
    )
  }, [state.payload])

  const insert = useCallback((): void => {
    const prepared = state.prepared
    if (!prepared || prepared.destination.capability === 'copy-only') return
    const generation = (operationGeneration.current += 1)
    setState((value) => ({ ...value, loading: true, error: undefined }))
    void window.hvir
      .invoke('document-review:insert-delivery', { preparedId: prepared.id })
      .then((result) => {
        unwrapOperation(result)
        if (operationGeneration.current !== generation) return
        setState((value) => ({
          ...value,
          loading: false,
          inserted: true,
        }))
      })
      .catch((reason: unknown) => {
        if (operationGeneration.current !== generation) return
        setState((value) => ({
          ...value,
          loading: false,
          error: errorMessage(reason),
        }))
      })
  }, [state.prepared])

  const sendNow = useCallback((): void => {
    const prepared = state.prepared
    if (
      !prepared ||
      prepared.destination.capability !== 'send-now' ||
      state.inserted ||
      state.sent
    ) {
      return
    }
    const generation = (operationGeneration.current += 1)
    setState((value) => ({ ...value, loading: true, error: undefined }))
    void window.hvir
      .invoke('document-review:send-now-delivery', { preparedId: prepared.id })
      .then((response) => {
        const result = unwrapOperation(response)
        if (result.outcome === 'sent') {
          // Durable owner-scoped truth must outlive presentation closure. The
          // controller still rejects a different, revoked, or locally changed
          // workspace; this operation generation gates only panel state.
          const adopted = current.current?.adoptAuthoritative(result.snapshot) ?? false
          if (operationGeneration.current !== generation) return
          previewModel.current = result.snapshot.model
          if (adopted) {
            setState((value) => ({
              ...value,
              loading: false,
              prepared: undefined,
              sent: true,
            }))
            return
          }
          setState((value) => ({
            ...value,
            loading: false,
            prepared: undefined,
            error:
              'Review was submitted at the PTY boundary, but the local view changed; reopen the workspace to refresh lifecycle state before preparing another send.',
          }))
          return
        }
        if (operationGeneration.current !== generation) return
        setState((value) => ({
          ...value,
          loading: false,
          prepared: undefined,
          error: consumedSendError(result),
        }))
      })
      .catch((reason: unknown) => {
        if (operationGeneration.current !== generation) return
        setState((value) => ({
          ...value,
          loading: false,
          error: errorMessage(reason),
        }))
      })
  }, [state.inserted, state.prepared, state.sent])

  useEffect(() => {
    if (!state.payload || previewModel.current === binding?.state.model) return
    operationGeneration.current += 1
    previewModel.current = undefined
    setState((value) => ({
      ...value,
      selectedTerminalId: undefined,
      selectedDestination: undefined,
      payload: undefined,
      prepared: undefined,
      error: 'The review changed. Preview the selection again.',
      copied: false,
      inserted: false,
      sent: false,
    }))
  }, [binding?.state.model, state.payload])

  useEffect(
    () => () => {
      operationGeneration.current += 1
      previewModel.current = undefined
    },
    [],
  )

  return {
    ...state,
    previewComment: (commentId) => preview({ kind: 'comment', commentId }),
    previewBatch: (batchId) => preview({ kind: 'batch', batchId }),
    selectDestination,
    copy,
    insert,
    sendNow,
    close,
  }
}

function readyScope(binding: DocumentReviewWorkspaceBinding | undefined) {
  const { state } = binding ?? {}
  return state?.status === 'ready' && state.workspace && state.workspaceGeneration
    ? {
        workspace: state.workspace,
        workspaceGeneration: state.workspaceGeneration,
      }
    : undefined
}

function writeReviewClipboard(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    return Promise.reject(new Error('Clipboard writing is unavailable'))
  }
  return navigator.clipboard.writeText(value)
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function consumedSendError(
  result: Extract<
    DocumentReviewSendNowResult,
    { outcome: 'send-authority-consumed' }
  >,
): string {
  const guidance =
    'Send authority was consumed to prevent a duplicate. Copy remains available; preview and prepare again before another send.'
  return result.ptyAcceptance === 'confirmed'
    ? `The complete review write was accepted at the PTY boundary, but hvir could not finish the sent-state update: ${result.reason}. This does not prove agent receipt. ${guidance}`
    : `PTY write completion is indeterminate: ${result.reason}. The review may have been submitted, but this does not prove agent receipt. ${guidance}`
}
