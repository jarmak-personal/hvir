import { useCallback, useEffect, useRef, useState } from 'react'

import {
  type DocumentReviewDeliveryDestination,
  type DocumentReviewDeliveryPayload,
  type DocumentReviewDeliverySelection,
  type PreparedDocumentReviewDelivery,
} from '../../../shared'
import {
  copyDocumentReviewPayload,
  insertPreparedDocumentReviewDelivery,
  loadDocumentReviewDelivery,
  performDirectDocumentReviewHandoff,
  prepareDocumentReviewDelivery,
  submitPreparedDocumentReviewDelivery,
} from './document-review-delivery-client'
import {
  copiedReviewNotice,
  deliveryError,
  insertedReviewNotice,
  sentReviewNotice,
} from './document-review-delivery-feedback'
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
  readonly directHandoffBlocked: boolean
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
  readonly directHandoffBlocked: boolean
}

const CLOSED: DeliveryState = {
  open: false,
  loading: false,
  destinations: [],
  copied: false,
  inserted: false,
  sent: false,
  directHandoffBlocked: false,
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
    setState((value) => ({
      ...CLOSED,
      directHandoffBlocked: value.directHandoffBlocked,
    }))
  }, [])

  const preview = useCallback(
    (selection: DocumentReviewDeliverySelection): void => {
      const generation = (operationGeneration.current += 1)
      const wasDirectHandoffBlocked = state.directHandoffBlocked
      previewModel.current = undefined
      setState({
        open: true,
        loading: true,
        destinations: [],
        selection,
        copied: false,
        inserted: false,
        sent: false,
        directHandoffBlocked: wasDirectHandoffBlocked,
      })
      const target = current.current
      void (async () => {
        await target?.flush()
        const scope = readyScope(current.current)
        if (!scope) throw new Error('Document review is still restoring this workspace')
        const loaded = await loadDocumentReviewDelivery(scope, selection)
        if (operationGeneration.current !== generation) return
        const { payload, destinations, firstDestination } = loaded
        if (!firstDestination || firstDestination.capability === 'copy-only') {
          previewModel.current = current.current?.state.model
          setState({
            open: true,
            loading: false,
            destinations,
            selection,
            selectedTerminalId: firstDestination?.terminalId,
            selectedDestination: firstDestination,
            payload,
            copied: false,
            inserted: false,
            sent: false,
            directHandoffBlocked: firstDestination ? false : wasDirectHandoffBlocked,
          })
          return
        }
        try {
          const prepared = await prepareDocumentReviewDelivery(
            scope,
            selection,
            firstDestination.terminalId,
          )
          if (operationGeneration.current !== generation) return
          previewModel.current = current.current?.state.model
          setState({
            open: true,
            loading: false,
            destinations,
            selection,
            selectedTerminalId: prepared.destination.terminalId,
            selectedDestination: prepared.destination,
            payload: prepared.payload,
            prepared,
            copied: false,
            inserted: false,
            sent: false,
            directHandoffBlocked: false,
          })
        } catch (reason) {
          if (operationGeneration.current !== generation) return
          previewModel.current = current.current?.state.model
          setState({
            open: true,
            loading: false,
            destinations,
            selection,
            payload,
            error: deliveryError(reason),
            copied: false,
            inserted: false,
            sent: false,
            directHandoffBlocked: wasDirectHandoffBlocked,
          })
        }
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
          directHandoffBlocked: wasDirectHandoffBlocked,
        })
      })
    },
    [state.directHandoffBlocked],
  )

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
          directHandoffBlocked: false,
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
        const prepared = await prepareDocumentReviewDelivery(scope, selection, terminalId)
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
          directHandoffBlocked: false,
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
    void copyDocumentReviewPayload(payload.body).then(
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
    void insertPreparedDocumentReviewDelivery(prepared.id)
      .then(() => {
        if (operationGeneration.current !== generation) return
        setState((value) => ({
          ...value,
          loading: false,
          inserted: true,
          notice: insertedReviewNotice(prepared.destination),
          directHandoffBlocked: false,
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
    void submitPreparedDocumentReviewDelivery(
      prepared.id,
      (snapshot) => current.current?.adoptAuthoritative(snapshot) ?? false,
    )
      .then((result) => {
        // Durable owner-scoped truth must outlive presentation closure. The
        // operation generation gates only presentation state.
        if (operationGeneration.current !== generation) return
        if (result.outcome === 'sent') {
          previewModel.current = result.snapshot.model
          setState((value) => ({
            ...value,
            loading: false,
            prepared: undefined,
            sent: true,
            notice: sentReviewNotice(prepared.destination),
            directHandoffBlocked: false,
          }))
          return
        }
        setState((value) => ({
          ...value,
          loading: false,
          prepared: undefined,
          error: result.error,
          directHandoffBlocked: true,
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

  const handoffBatch = useCallback(
    (batchId: string): void => {
      if (state.directHandoffBlocked) return
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
        directHandoffBlocked: false,
      })
      const target = current.current
      void (async () => {
        await target?.flush()
        const scope = readyScope(current.current)
        if (!scope) throw new Error('Document review is still restoring this workspace')
        const handoff = await performDirectDocumentReviewHandoff(
          scope,
          selection,
          (snapshot) => current.current?.adoptAuthoritative(snapshot) ?? false,
          () => operationGeneration.current === generation,
        )
        if (handoff.outcome === 'cancelled') return
        if (handoff.outcome === 'blocked') {
          setState({
            open: false,
            loading: false,
            destinations: handoff.destinations,
            selection,
            selectedTerminalId: handoff.destination.terminalId,
            selectedDestination: handoff.destination,
            copied: false,
            inserted: false,
            sent: false,
            error: handoff.error,
            directHandoffBlocked: true,
          })
          return
        }
        setState({
          open: false,
          loading: false,
          destinations: handoff.destinations,
          selection,
          selectedTerminalId: handoff.destination.terminalId,
          selectedDestination: handoff.destination,
          copied: handoff.outcome === 'copied',
          inserted: handoff.outcome === 'inserted',
          sent: handoff.outcome === 'sent',
          notice:
            handoff.outcome === 'copied'
              ? copiedReviewNotice(handoff.destination)
              : handoff.outcome === 'inserted'
                ? insertedReviewNotice(handoff.destination)
                : sentReviewNotice(handoff.destination),
          directHandoffBlocked: false,
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
    },
    [state.directHandoffBlocked],
  )

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
