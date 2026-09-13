import { useSkillagerActions } from './use-skillager-actions'
import { useCallback, useEffect, useRef, useState } from 'react'
import { hostPathEquals } from '../../../shared/host-path'
import type {
  SkillagerAgent,
  SkillagerConnection,
  SkillagerMetadata,
} from '../../../shared/skillager'
import type {
  SkillagerDestination,
  SkillagerExposureMode,
  SkillagerExposurePreview,
  SkillagerExposureRequest,
} from '../../../shared/skillager-exposure'
import type { ProjectState } from '../../../shared/workspace-types'
import {
  exposureActions,
  eligibleSkillagerUpdate,
  exposureDestinationCurrent,
  exposureDestinations,
  type ExposureAction,
} from './skillager-exposure-model'

interface Options {
  readonly connection?: SkillagerConnection
  readonly projectState?: ProjectState
  readonly agent: SkillagerAgent
  readonly detailId?: string
  readonly visible: boolean
  readonly sidebarVisible: boolean
  readonly detailsVisible: boolean
  readonly onCompleted: () => void
}
interface ActionState {
  readonly metadata: SkillagerMetadata
  readonly action: ExposureAction
  readonly reviewId?: string
  readonly destination?: SkillagerDestination
  readonly agent: SkillagerAgent
  readonly mode: SkillagerExposureMode
  readonly preview?: SkillagerExposurePreview
  readonly loading?: boolean
  readonly applying?: boolean
  readonly used?: boolean
  readonly message?: string
  readonly failed?: boolean
}
interface Lease {
  readonly request: SkillagerExposureRequest
  previewId?: string
  used?: boolean
}
export function useSkillagerExposure(options: Options) {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [state, setState] = useState<ActionState>()
  const stateRef = useRef(state)
  stateRef.current = state
  const lease = useRef<Lease>(undefined),
    sequence = useRef(0)
  const released = useRef<Promise<void>>(Promise.resolve())
  const destinations = exposureDestinations(options.projectState)
  const context = `${options.connection?.connectionId}\0${options.projectState?.root.hostId}\0${options.projectState?.root.path}\0${options.agent}\0${options.visible}\0${options.detailId}`
  const contextRef = useRef(context)
  contextRef.current = context
  const release = useCallback(() => {
    const current = lease.current
    lease.current = undefined
    if (!current) return
    released.current = Promise.allSettled([
      released.current,
      window.hvir.invoke('skillager:cancel-exposure', {
        requestId: current.request.requestId,
      }),
      ...(current.previewId
        ? [
            window.hvir.invoke('skillager:release-exposure', {
              previewId: current.previewId,
            }),
          ]
        : []),
    ]).then(() => undefined)
  }, [])
  const close = useCallback(() => {
    release()
    setState(undefined)
  }, [release])
  useEffect(() => {
    close()
    return release
  }, [context, close, release])
  useEffect(() => {
    if (
      state?.destination &&
      !exposureDestinationCurrent(destinations, state.destination)
    )
      close()
  }, [destinations, state?.destination, close])
  const start = useCallback(
    (metadata: SkillagerMetadata, action: ExposureAction, reviewId?: string) => {
      const current = optionsRef.current
      if (
        !current.connection ||
        !current.projectState ||
        !current.visible ||
        (action === 'update'
          ? !reviewId || !eligibleSkillagerUpdate(metadata)
          : exposureActions(metadata).find((item) => item.action === action)?.disabled)
      )
        return
      const destination =
        action === 'add'
          ? undefined
          : exposureDestinations(current.projectState).find((item) =>
              hostPathEquals(item.root, current.projectState!.root),
            )
      if (action !== 'add' && !destination) return
      release()
      setState({
        metadata,
        action,
        reviewId,
        destination,
        agent: current.agent,
        mode:
          action === 'change'
            ? metadata.workspace?.mode === 'stub'
              ? 'native'
              : 'stub'
            : (action === 'remove' || action === 'update') &&
                metadata.workspace?.mode === 'stub'
              ? 'stub'
              : 'native',
      })
    },
    [release],
  )
  const choose = useCallback(
    (patch: {
      destination?: SkillagerDestination
      agent?: SkillagerAgent
      mode?: SkillagerExposureMode
    }) => {
      release()
      setState((current) =>
        current
          ? {
              ...current,
              ...patch,
              mode:
                (patch.destination ?? current.destination)?.root.hostId !== 'local'
                  ? 'native'
                  : (patch.mode ?? current.mode),
              preview: undefined,
              used: false,
              message: undefined,
            }
          : undefined,
      )
    },
    [release],
  )
  const preview = useCallback(async () => {
    const current = stateRef.current,
      options = optionsRef.current
    if (
      !current?.destination ||
      !options.connection ||
      !options.projectState ||
      lease.current ||
      current.loading ||
      current.applying
    )
      return
    const at = contextRef.current
    const owned: Lease = {
      request: {
        connectionId: options.connection.connectionId,
        workspaceRoot: options.projectState.root,
        requestId: ++sequence.current,
        destination: current.destination,
        agent: current.agent,
        skillId: current.metadata.id,
        mode: current.mode,
        action: current.action,
        reviewId: current.reviewId,
        exposure: current.action === 'add' ? undefined : current.metadata.workspace,
      },
    }
    lease.current = owned
    setState({ ...current, loading: true, message: undefined })
    try {
      await released.current
      if (
        lease.current !== owned ||
        contextRef.current !== at ||
        !optionsRef.current.visible ||
        !exposureDestinationCurrent(
          exposureDestinations(optionsRef.current.projectState),
          owned.request.destination,
        )
      )
        return
      const result = await window.hvir.invoke('skillager:preview-exposure', owned.request)
      if (lease.current !== owned || contextRef.current !== at) {
        if (result.ok)
          void window.hvir
            .invoke('skillager:release-exposure', { previewId: result.value.previewId })
            .catch(() => undefined)
        return
      }
      if (result.ok) {
        owned.previewId = result.value.previewId
        setState({ ...current, preview: result.value, loading: false })
      } else {
        release()
        setState({ ...current, loading: false, failed: true, message: result.message })
      }
    } catch {
      if (lease.current === owned && contextRef.current === at) {
        release()
        setState({
          ...current,
          loading: false,
          failed: true,
          message: 'Could not prepare this workspace action.',
        })
      }
    }
  }, [release])
  const apply = useCallback(async () => {
    const owned = lease.current,
      current = stateRef.current,
      at = contextRef.current
    if (
      !owned?.previewId ||
      !current?.preview ||
      owned.used ||
      current.used ||
      current.applying
    )
      return
    owned.used = true
    setState({ ...current, used: true, applying: true, message: undefined })
    try {
      const result = await window.hvir.invoke('skillager:apply-exposure', {
        previewId: owned.previewId,
      })
      if (lease.current !== owned || contextRef.current !== at) return
      if (result.ok) {
        optionsRef.current.onCompleted()
        setState({
          ...current,
          used: true,
          message:
            (current.action === 'update'
              ? `Updated ${result.value.skillId} for ${current.agent} at ${result.value.target.hostId}:${result.value.target.path}.`
              : current.action === 'change'
                ? `Changed ${result.value.skillId} to ${result.value.mode === 'native' ? 'Full skill' : 'Stub'} at ${result.value.target.hostId}:${result.value.target.path}.`
                : `${result.value.status === 'removed' ? 'Removed' : 'Added'} ${result.value.skillId} ${result.value.status === 'removed' ? 'from' : 'to'} ${result.value.target.hostId}:${result.value.target.path}.`) +
            (result.value.notice ? ` ${result.value.notice}` : ''),
        })
      } else {
        if (result.reason === 'busy') owned.used = false
        else optionsRef.current.onCompleted()
        setState({
          ...current,
          used: result.reason !== 'busy',
          failed: true,
          message: result.message,
        })
      }
    } catch {
      if (lease.current === owned && contextRef.current === at) {
        optionsRef.current.onCompleted()
        setState({
          ...current,
          used: true,
          failed: true,
          message:
            'Completion is uncertain. Refresh the workspace state before starting a new preview; do not retry this confirmation.',
        })
      }
    }
  }, [])
  const menu = useSkillagerActions({
    context,
    sidebarVisible: options.sidebarVisible,
    detailsVisible: options.detailsVisible,
    blocked: Boolean(state) || !options.connection || !options.visible,
    onSelect: start,
  })
  return { state, context, menu, destinations, start, close, choose, preview, apply }
}
export type SkillagerExposureController = ReturnType<typeof useSkillagerExposure>
