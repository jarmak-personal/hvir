import { useCallback, useEffect, useRef, useState } from 'react'

import {
  unwrapOperation,
  type DocumentReviewDeliveryDestination,
  type DocumentReviewDeliverySelection,
  type PreparedDocumentReviewDelivery,
} from '../../../shared'
import type { DocumentReviewWorkspaceBinding } from './use-document-review-interaction'

export interface DocumentReviewDeliveryInteraction {
  readonly open: boolean
  readonly loading: boolean
  readonly destinations: readonly DocumentReviewDeliveryDestination[]
  readonly selectedTerminalId?: string
  readonly prepared?: PreparedDocumentReviewDelivery
  readonly error?: string
  readonly message?: string
  readonly inserted: boolean
  readonly previewComment: (commentId: string) => void
  readonly previewBatch: (batchId: string) => void
  readonly selectDestination: (terminalId: string) => void
  readonly copy: () => void
  readonly insert: () => void
  readonly close: () => void
}

interface DeliveryState {
  readonly open: boolean
  readonly loading: boolean
  readonly destinations: readonly DocumentReviewDeliveryDestination[]
  readonly selection?: DocumentReviewDeliverySelection
  readonly selectedTerminalId?: string
  readonly prepared?: PreparedDocumentReviewDelivery
  readonly error?: string
  readonly message?: string
  readonly inserted: boolean
}

const CLOSED: DeliveryState = {
  open: false,
  loading: false,
  destinations: [],
  inserted: false,
}

export function useDocumentReviewDelivery(
  binding: DocumentReviewWorkspaceBinding | undefined,
): DocumentReviewDeliveryInteraction {
  const [state, setState] = useState<DeliveryState>(CLOSED)
  const current = useRef(binding)
  const operationGeneration = useRef(0)
  const preparedModel = useRef<unknown>(undefined)
  current.current = binding

  const close = useCallback((): void => {
    operationGeneration.current += 1
    preparedModel.current = undefined
    setState(CLOSED)
  }, [])

  const preview = useCallback((selection: DocumentReviewDeliverySelection): void => {
    const generation = (operationGeneration.current += 1)
    preparedModel.current = undefined
    setState({
      open: true,
      loading: true,
      destinations: [],
      selection,
      inserted: false,
    })
    const target = current.current
    void (async () => {
      await target?.flush()
      const scope = readyScope(current.current)
      if (!scope) throw new Error('Document review is still restoring this workspace')
      const destinations = unwrapOperation(
        await window.hvir.invoke('document-review:delivery-destinations', scope),
      )
      if (operationGeneration.current !== generation) return
      setState({
        open: true,
        loading: false,
        destinations,
        selection,
        inserted: false,
      })
    })().catch((reason: unknown) => {
      if (operationGeneration.current !== generation) return
      setState({
        open: true,
        loading: false,
        destinations: [],
        selection,
        error: errorMessage(reason),
        inserted: false,
      })
    })
  }, [])

  const selectDestination = useCallback((terminalId: string): void => {
    const selection = state.selection
    if (!selection) return
    if (!terminalId) {
      operationGeneration.current += 1
      preparedModel.current = undefined
      setState((value) => ({
        ...value,
        selectedTerminalId: undefined,
        prepared: undefined,
        error: undefined,
        message: undefined,
        inserted: false,
      }))
      return
    }
    const generation = (operationGeneration.current += 1)
    preparedModel.current = undefined
    setState((value) => ({
      ...value,
      loading: true,
      selectedTerminalId: terminalId,
      prepared: undefined,
      error: undefined,
      message: undefined,
      inserted: false,
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
      preparedModel.current = current.current?.state.model
      setState((value) => ({
        ...value,
        loading: false,
        prepared,
        error: undefined,
        message: undefined,
        inserted: false,
      }))
    })().catch((reason: unknown) => {
      if (operationGeneration.current !== generation) return
      setState((value) => ({
        ...value,
        loading: false,
        selectedTerminalId: undefined,
        prepared: undefined,
        error: errorMessage(reason),
      }))
    })
  }, [state.selection])

  const copy = useCallback((): void => {
    const prepared = state.prepared
    if (!prepared) return
    void writeReviewClipboard(prepared.payload.body).then(
      () => setState((value) => ({ ...value, message: 'Exact preview copied.' })),
      (reason: unknown) =>
        setState((value) => ({ ...value, error: errorMessage(reason) })),
    )
  }, [state.prepared])

  const insert = useCallback((): void => {
    const prepared = state.prepared
    if (!prepared || prepared.destination.capability !== 'insert') return
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
          message: 'Inserted into the composer. Review comments remain draft.',
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

  useEffect(() => {
    if (!state.prepared || preparedModel.current === binding?.state.model) return
    operationGeneration.current += 1
    preparedModel.current = undefined
    setState((value) => ({
      ...value,
      selectedTerminalId: undefined,
      prepared: undefined,
      error: 'The review changed. Choose the destination again to prepare a new preview.',
      message: undefined,
      inserted: false,
    }))
  }, [binding?.state.model, state.prepared])

  useEffect(
    () => () => {
      operationGeneration.current += 1
      preparedModel.current = undefined
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
