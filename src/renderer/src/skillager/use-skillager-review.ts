import { exposureDestinations, eligibleSkillagerUpdate } from './skillager-exposure-model'
import { hostPathEquals } from '../../../shared/host-path'
import type { ProjectState } from '../../../shared/workspace-types'
import type { SkillagerExposureRequest } from '../../../shared/skillager-exposure'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostPath } from '../../../shared/host-path'
import type {
  SkillagerAgent,
  SkillagerConnection,
  SkillagerRequest,
  SkillagerResult,
} from '../../../shared/skillager'
import type {
  SkillagerHistory,
  SkillagerReview,
  SkillagerReviewContent,
  SkillagerReviewDiff,
} from '../../../shared/skillager-review'
import type { SkillagerDetailTab } from './skillager-model'

export interface SkillagerReviewState {
  readonly loading?: boolean
  readonly accepting?: boolean
  readonly detail?: SkillagerReview
  readonly history?: SkillagerHistory
  readonly content?: SkillagerReviewContent
  readonly diff?: SkillagerReviewDiff
  readonly message?: string
  readonly failed?: boolean
  readonly mode?: 'rendered' | 'source' | 'diff'
  readonly used?: boolean
}
interface Options {
  readonly connection?: SkillagerConnection
  readonly root?: HostPath
  readonly projectState?: ProjectState
  readonly agent: SkillagerAgent
  readonly tabs: readonly SkillagerDetailTab[]
  readonly onAccepted: () => void
}
interface Lease {
  readonly request: SkillagerRequest
  readonly context: string
  serial: number
  reviewId?: string
}

export function useSkillagerReview(options: Options) {
  const [states, setStates] = useState<Readonly<Record<string, SkillagerReviewState>>>({})
  const optionsRef = useRef(options)
  optionsRef.current = options
  const sequence = useRef(0),
    leases = useRef(new Map<string, Lease>())
  const context = `${options.connection?.connectionId}:${options.root?.hostId}:${options.root?.path}:${options.agent}:${options.projectState?.connectionState}`
  const contextRef = useRef(context)
  contextRef.current = context
  const publish = useCallback(
    (id: string, patch: Partial<SkillagerReviewState>) =>
      setStates((current) => ({ ...current, [id]: { ...current[id], ...patch } })),
    [],
  )
  const release = useCallback((id: string) => {
    const lease = leases.current.get(id)
    if (!lease) return
    leases.current.delete(id)
    void window.hvir
      .invoke('skillager:cancel-review', { requestId: lease.request.requestId })
      .catch(() => undefined)
    if (lease.reviewId)
      void window.hvir
        .invoke('skillager:release-review', { reviewId: lease.reviewId })
        .catch(() => undefined)
  }, [])
  useEffect(() => {
    const owned = leases.current
    setStates({})
    return () => {
      for (const id of [...owned.keys()]) release(id)
    }
  }, [context, release])
  useEffect(() => {
    const ids = new Set(options.tabs.map((tab) => tab.id))
    for (const id of [...leases.current.keys()]) if (!ids.has(id)) release(id)
    setStates((current) => {
      const retained = Object.entries(current).filter(([id]) => ids.has(id))
      return retained.length === Object.keys(current).length
        ? current
        : Object.fromEntries(retained)
    })
  }, [options.tabs, release])

  const start = useCallback(
    (tab: SkillagerDetailTab): Lease | undefined => {
      const { connection, root, agent } = optionsRef.current
      if (
        !connection ||
        !root ||
        tab.metadata.source.ownership !== 'library' ||
        (optionsRef.current.projectState &&
          optionsRef.current.projectState.connectionState !== 'connected')
      )
        return
      release(tab.id)
      const lease = {
        context: contextRef.current,
        serial: 0,
        request: {
          connectionId: connection.connectionId,
          workspaceRoot: root,
          agent,
          requestId: ++sequence.current,
        },
      }
      leases.current.set(tab.id, lease)
      return lease
    },
    [release],
  )
  const current = (id: string, lease: Lease): boolean =>
    leases.current.get(id) === lease && lease.context === contextRef.current
  const failure = useCallback(
    (id: string, result: { readonly message: string }) =>
      publish(id, {
        loading: false,
        accepting: false,
        failed: true,
        message: result.message,
      }),
    [publish],
  )

  const review = useCallback(
    async (tab: SkillagerDetailTab, update = false) => {
      const lease = start(tab)
      if (!lease) return
      const selected = optionsRef.current
      const destination = update
        ? exposureDestinations(selected.projectState).find(
            (item) => selected.root && hostPathEquals(item.root, selected.root),
          )
        : undefined
      if (update && (!destination || !eligibleSkillagerUpdate(tab.metadata))) {
        release(tab.id)
        return
      }
      const updateRequest: SkillagerExposureRequest | undefined = update
        ? {
            ...lease.request,
            destination: destination!,
            skillId: tab.metadata.id,
            action: 'update',
            exposure: tab.metadata.workspace,
            mode: tab.metadata.workspace!.mode as 'native' | 'stub',
          }
        : undefined
      setStates((value) => ({ ...value, [tab.id]: { loading: true } }))
      try {
        const result = await window.hvir.invoke('skillager:review', {
          ...lease.request,
          skillId: tab.metadata.id,
          update: updateRequest,
        })
        if (!current(tab.id, lease)) {
          if (result.ok)
            void window.hvir
              .invoke('skillager:release-review', { reviewId: result.value.reviewId })
              .catch(() => undefined)
          return
        }
        if (!result.ok) return failure(tab.id, result)
        lease.reviewId = result.value.reviewId
        publish(tab.id, {
          loading: false,
          detail: result.value,
          history: result.value.history,
          mode: result.value.update ? 'diff' : 'rendered',
          diff: result.value.update?.diff,
        })
      } catch {
        if (current(tab.id, lease))
          failure(tab.id, { message: 'Could not prepare this review.' })
      }
    },
    [start, publish, failure, release],
  )

  const history = useCallback(
    async (tab: SkillagerDetailTab) => {
      let lease = leases.current.get(tab.id)
      if (!lease) lease = start(tab)
      if (!lease) return
      const owned = lease
      publish(tab.id, { loading: true, message: undefined })
      try {
        const result = await window.hvir.invoke('skillager:history', {
          ...owned.request,
          skillId: tab.metadata.id,
        })
        if (!current(tab.id, owned)) return
        if (!result.ok) return failure(tab.id, result)
        publish(tab.id, { loading: false, history: result.value })
      } catch {
        if (current(tab.id, owned))
          failure(tab.id, { message: 'Could not read library history.' })
      }
    },
    [start, publish, failure],
  )

  const content = useCallback(
    async (id: string, entry: string) => {
      const lease = leases.current.get(id)
      if (!lease?.reviewId) return
      const serial = ++lease.serial
      publish(id, { loading: true, message: undefined })
      try {
        const result = await window.hvir.invoke('skillager:review-content', {
          ...lease.request,
          reviewId: lease.reviewId,
          entry,
        })
        if (!current(id, lease) || serial !== lease.serial) return
        if (!result.ok) return failure(id, result)
        publish(id, {
          loading: false,
          content: result.value,
          diff: undefined,
          mode: 'rendered',
        })
      } catch {
        if (current(id, lease) && serial === lease.serial)
          failure(id, { message: 'The reviewed file is unavailable.' })
      }
    },
    [publish, failure],
  )

  const diff = useCallback(
    async (id: string, fromHash?: string) => {
      const lease = leases.current.get(id)
      if (!lease?.reviewId) return
      const serial = ++lease.serial
      publish(id, { loading: true, message: undefined })
      try {
        const result = await window.hvir.invoke('skillager:review-diff', {
          ...lease.request,
          reviewId: lease.reviewId,
          fromHash,
        })
        if (!current(id, lease) || serial !== lease.serial) return
        if (!result.ok) return failure(id, result)
        publish(id, { loading: false, diff: result.value, mode: 'diff' })
      } catch {
        if (current(id, lease) && serial === lease.serial)
          failure(id, { message: 'Library diff is unavailable.' })
      }
    },
    [publish, failure],
  )

  const accept = useCallback(
    async (id: string) => {
      const lease = leases.current.get(id)
      if (!lease?.reviewId) return
      publish(id, { accepting: true, used: true, message: undefined })
      try {
        const result = await window.hvir.invoke('skillager:accept-review', {
          ...lease.request,
          reviewId: lease.reviewId,
        })
        if (lease.context === contextRef.current) optionsRef.current.onAccepted()
        if (!current(id, lease)) return
        if (!result.ok) {
          failure(id, result)
          if (result.reason === 'busy') publish(id, { used: false })
          return
        }
        publish(id, {
          accepting: false,
          failed: false,
          message: 'Library version accepted. Workspace copies are unchanged.',
        })
      } catch {
        if (lease.context === contextRef.current) optionsRef.current.onAccepted()
        if (current(id, lease))
          failure(id, {
            message:
              'Acceptance completion is uncertain. Refresh library state before another review.',
          })
      }
    },
    [failure, publish],
  )

  const asset = useCallback(
    async (
      id: string,
      documentEntry: string,
      entry: string,
    ): Promise<SkillagerResult<SkillagerReviewContent> | undefined> => {
      const lease = leases.current.get(id)
      if (!lease?.reviewId) return
      const result = await window.hvir.invoke('skillager:review-content', {
        ...lease.request,
        reviewId: lease.reviewId,
        documentEntry,
        entry,
      })
      return current(id, lease) ? result : undefined
    },
    [],
  )
  return {
    states,
    review,
    history,
    content,
    diff,
    accept,
    asset,
    mode: (id: string, mode: 'rendered' | 'source') => publish(id, { mode }),
  }
}
export type SkillagerReviewController = ReturnType<typeof useSkillagerReview>
