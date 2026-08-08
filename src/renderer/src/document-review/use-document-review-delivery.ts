import { useCallback, useEffect, useRef, useState } from 'react'

import {
  unwrapOperation,
  type DocumentReviewDeliveryDestination,
  type DocumentReviewDeliveryPayload,
  type DocumentReviewDeliverySelection,
  type PreparedDocumentReviewDelivery,
} from '../../../shared'
import { consumedSendError, deliveryError } from './document-review-delivery-feedback'
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
  readonly notice?: string
  readonly copied: boolean
  readonly inserted: boolean
  readonly sent: boolean
  readonly previewBatch: (batchId: string) => void
  readonly handoffBatch: (batchId: string) => void
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
  readonly notice?: string
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
      const destination = destinations[0]
      const prepared =
        destination && destination.capability !== 'copy-only'
          ? unwrapOperation(
              await window.hvir.invoke('document-review:prepare-delivery', {
                ...scope,
                selection,
                terminalId: destination.terminalId,
              }),
            )
          : undefined
      if (operationGeneration.current !== generation) return
      previewModel.current = current.current?.state.model
      setState({
        open: true,
        loading: false,
        destinations,
        selection,
        selectedTerminalId: destination?.terminalId,
        selectedDestination: prepared?.destination ?? destination,
        payload,
        prepared,
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
        error: deliveryError(reason),
        copied: false,
        inserted: false,
        sent: false,
      })
    })
  }, [])

  const selectDestination = useCallback(
    (terminalId: string): void => {
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
          notice: undefined,
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
          notice: undefined,
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
        notice: undefined,
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
          notice: undefined,
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
          error: deliveryError(reason),
        }))
      })
    },
    [state.destinations, state.selection],
  )

  const copy = useCallback((): void => {
    const payload = state.payload
    if (!payload) return
    void writeReviewClipboard(payload.body).then(
      () => setState((value) => ({ ...value, copied: true, error: undefined })),
      (reason: unknown) =>
        setState((value) => ({
          ...value,
          copied: false,
          error: deliveryError(reason),
        })),
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
          notice: `Inserted into ${prepared.destination.title}. Submit it in the terminal when ready.`,
        }))
      })
      .catch((reason: unknown) => {
        if (operationGeneration.current !== generation) return
        setState((value) => ({
          ...value,
          loading: false,
          error: deliveryError(reason),
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
              notice: `Sent to ${prepared.destination.title}.`,
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
          error: deliveryError(reason),
        }))
      })
  }, [state.inserted, state.prepared, state.sent])

  const handoffBatch = useCallback((batchId: string): void => {
    const selection: DocumentReviewDeliverySelection = { kind: 'batch', batchId }
    const generation = (operationGeneration.current += 1)
    previewModel.current = undefined
    setState({
      open: false,
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
      const destination = destinations[0]
      if (!destination) {
        throw new Error('Open a terminal in this workspace before sending the review')
      }
      if (destination.capability === 'copy-only') {
        await writeReviewClipboard(payload.body)
        if (operationGeneration.current !== generation) return
        setState({
          open: false,
          loading: false,
          destinations,
          selection,
          selectedTerminalId: destination.terminalId,
          selectedDestination: destination,
          copied: true,
          inserted: false,
          sent: false,
          notice: `Copied review for ${destination.title}; this terminal cannot receive it safely.`,
        })
        return
      }
      const prepared = unwrapOperation(
        await window.hvir.invoke('document-review:prepare-delivery', {
          ...scope,
          selection,
          terminalId: destination.terminalId,
        }),
      )
      if (operationGeneration.current !== generation) return
      previewModel.current = current.current?.state.model
      if (prepared.destination.capability === 'insert') {
        unwrapOperation(
          await window.hvir.invoke('document-review:insert-delivery', {
            preparedId: prepared.id,
          }),
        )
        if (operationGeneration.current !== generation) return
        setState({
          open: false,
          loading: false,
          destinations,
          selection,
          selectedTerminalId: prepared.destination.terminalId,
          selectedDestination: prepared.destination,
          copied: false,
          inserted: true,
          sent: false,
          notice: `Inserted into ${prepared.destination.title}. Submit it in the terminal when ready.`,
        })
        return
      }
      const sent = unwrapOperation(
        await window.hvir.invoke('document-review:send-now-delivery', {
          preparedId: prepared.id,
        }),
      )
      if (sent.outcome !== 'sent') {
        throw new Error(consumedSendError(sent))
      }
      const adopted = current.current?.adoptAuthoritative(sent.snapshot) ?? false
      if (operationGeneration.current !== generation) return
      previewModel.current = sent.snapshot.model
      if (!adopted) {
        throw new Error(
          'Review was submitted, but the local workspace changed. Reopen it before sending again.',
        )
      }
      setState({
        open: false,
        loading: false,
        destinations,
        selection,
        selectedTerminalId: prepared.destination.terminalId,
        selectedDestination: prepared.destination,
        copied: false,
        inserted: false,
        sent: true,
        notice: `Sent to ${prepared.destination.title}.`,
      })
    })().catch((reason: unknown) => {
      if (operationGeneration.current !== generation) return
      setState((value) => ({
        ...value,
        loading: false,
        error: deliveryError(reason),
        notice: undefined,
      }))
    })
  }, [])

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
      notice: undefined,
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
    previewBatch: (batchId) => preview({ kind: 'batch', batchId }),
    handoffBatch,
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
