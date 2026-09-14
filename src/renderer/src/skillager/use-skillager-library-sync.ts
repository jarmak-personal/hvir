import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostPath } from '../../../shared/host-path'
import type {
  SkillagerAgent,
  SkillagerConnection,
  SkillagerRequest,
} from '../../../shared/skillager'
import type {
  SkillagerSyncCompletion,
  SkillagerSyncStatus,
} from '../../../shared/skillager-library-sync'

interface Options {
  readonly connection?: SkillagerConnection
  readonly root?: HostPath
  readonly agent: SkillagerAgent
  readonly activeId?: string
  readonly visible: boolean
  readonly onCompleted: () => void
}
interface State {
  readonly busy?: 'checking' | 'syncing'
  readonly uncertain?: boolean
  readonly message?: string
  readonly report?: SkillagerSyncStatus
  readonly completion?: SkillagerSyncCompletion
}
interface Lease {
  request: SkillagerRequest
  submitted: boolean
}

/** One gesture checks then syncs; reconciliation never continues into another write. */
export function useSkillagerLibrarySync(options: Options) {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [state, setState] = useState<State>({})
  const stateRef = useRef(state)
  stateRef.current = state
  const sequence = useRef(0),
    lease = useRef<Lease>(undefined)
  const released = useRef<Promise<void>>(Promise.resolve())
  const identity = JSON.stringify([
    options.connection?.connectionId,
    options.root,
    options.agent,
  ])
  const context = JSON.stringify([identity, options.visible, options.activeId])
  const contextRef = useRef(context)
  contextRef.current = context
  const release = useCallback(() => {
    const current = lease.current
    lease.current = undefined
    if (!current) return
    released.current = Promise.allSettled([
      released.current,
      window.hvir.invoke('skillager:cancel-sync', {
        requestId: current.request.requestId,
      }),
    ]).then(() => undefined)
    if (current.submitted)
      setState((state) => ({
        ...state,
        busy: undefined,
        uncertain: true,
        message: 'Sync completion is uncertain. Check current state before another sync.',
      }))
    else setState((state) => ({ ...state, busy: undefined }))
  }, [])
  useEffect(() => {
    setState({})
    return release
  }, [identity, release])
  useEffect(() => {
    release()
    return release
  }, [context, release])

  const run = useCallback(
    async (write: boolean) => {
      const options = optionsRef.current
      if (!options.connection || !options.root || !options.visible || lease.current)
        return
      const owned: Lease = {
        request: {
          connectionId: options.connection.connectionId,
          workspaceRoot: options.root,
          agent: options.agent,
          requestId: ++sequence.current,
        },
        submitted: false,
      }
      const at = contextRef.current
      const reconciliation = Boolean(stateRef.current.uncertain)
      lease.current = owned
      const current = () =>
        lease.current === owned && contextRef.current === at && optionsRef.current.visible
      setState((state) => ({ ...state, busy: 'checking', message: undefined }))
      try {
        await released.current
        if (!current()) return
        const checked = await window.hvir.invoke('skillager:sync-status', owned.request)
        if (!current()) return
        if (!checked.ok) {
          setState((state) => ({ ...state, busy: undefined, message: checked.message }))
          return
        }
        const { report, observationId, requiresNewSync } = checked.value
        const ready =
          Boolean(observationId) &&
          report.status === 'observed' &&
          report.coverage.complete
        const mustCheck = (reconciliation || requiresNewSync) && !ready
        setState((state) => ({
          ...state,
          report,
          busy: undefined,
          uncertain: mustCheck,
          message: !ready
            ? (
                report.reason ?? 'The current state could not be fully checked.'
              ).replaceAll('-', ' ')
            : reconciliation || requiresNewSync
              ? 'Current state checked. Choose Sync approved skills to start a new sync.'
              : 'Current library lineage checked.',
        }))
        if (!ready || !write || reconciliation || requiresNewSync) return
        if (!current()) return
        owned.request = { ...owned.request, requestId: ++sequence.current }
        owned.submitted = true
        setState((state) => ({
          ...state,
          busy: 'syncing',
          message: undefined,
          completion: undefined,
        }))
        const applied = await window.hvir.invoke('skillager:sync-approved', {
          ...owned.request,
          observationId: observationId!,
        })
        if (!current()) return
        owned.submitted = false
        optionsRef.current.onCompleted()
        if (applied.ok)
          setState((state) => ({
            ...state,
            busy: undefined,
            completion: applied.value,
            report: undefined,
            uncertain:
              applied.value.status === 'uncertain' ||
              applied.value.items.some((item) => item.recoveryPath),
          }))
        else
          setState((state) => ({
            ...state,
            busy: undefined,
            report: undefined,
            uncertain: applied.reason === 'uncertain',
            message: applied.message,
          }))
      } catch {
        if (current()) {
          if (owned.submitted) optionsRef.current.onCompleted()
          setState((state) => ({
            ...state,
            busy: undefined,
            uncertain: state.uncertain || owned.submitted,
            message: owned.submitted
              ? 'Sync completion is uncertain. Check current state before another sync.'
              : 'Could not check approved skills.',
          }))
        }
      } finally {
        if (current()) {
          owned.submitted = false
          release()
        }
      }
    },
    [release],
  )
  return {
    state,
    context,
    enabled: Boolean(options.connection && options.root && options.visible),
    sync: () => run(true),
    check: () => run(false),
    cancel: release,
  }
}
export type SkillagerLibrarySyncController = ReturnType<typeof useSkillagerLibrarySync>
