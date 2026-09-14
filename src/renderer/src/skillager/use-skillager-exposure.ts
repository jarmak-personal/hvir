import { useSkillagerActions } from './use-skillager-actions'
import { useCallback, useEffect, useRef, useState } from 'react'
import { hostPathEquals, type HostPath } from '../../../shared/host-path'
import type {
  SkillagerAgent,
  SkillagerConnection,
  SkillagerMetadata,
} from '../../../shared/skillager'
import type {
  SkillagerDestination,
  SkillagerExposureMode,
  SkillagerExposureRequest,
} from '../../../shared/skillager-exposure'
import type {
  SkillagerExposureActionPreview,
  SkillagerExposureActionRequest,
  SkillagerExposureLineageRequest,
  SkillagerExposureActionCompletion,
} from '../../../shared/skillager-exposure-plan'
import type { ProjectState } from '../../../shared/workspace-types'
import {
  exposureActions,
  eligibleSkillagerUpdate,
  exposureDestinationCurrent,
  exposureDestinations,
  type ExposureAction,
} from './skillager-exposure-model'
import {
  curationChoice,
  curationPlan,
  type SkillagerCurationChoice,
  type CurationAction,
} from './skillager-curation-model'
import { isNativeProjectSkill } from './skillager-model'

interface Options {
  readonly connection?: SkillagerConnection
  readonly projectState?: ProjectState
  readonly agent: SkillagerAgent
  readonly detailId?: string
  readonly visible: boolean
  readonly sidebarVisible: boolean
  readonly detailsVisible: boolean
  readonly rows?: readonly SkillagerMetadata[]
  readonly projectRows?: readonly SkillagerMetadata[]
  readonly onCompleted: () => void
  readonly onFiles?: (path: HostPath, signal: AbortSignal) => Promise<void>
  readonly onUpdateReview?: (metadata: SkillagerMetadata) => void
}
interface ActionState {
  readonly metadata: SkillagerMetadata
  readonly action: ExposureAction
  readonly reviewId?: string
  readonly destination?: SkillagerDestination
  readonly agent: SkillagerAgent
  readonly mode: SkillagerExposureMode
  readonly curation?: SkillagerCurationChoice
  readonly preview?: SkillagerExposureActionPreview
  readonly completion?: SkillagerExposureActionCompletion
  readonly loading?: boolean
  readonly applying?: boolean
  readonly used?: boolean
  readonly message?: string
  readonly failed?: boolean
}
interface Lease {
  readonly request: SkillagerExposureActionRequest | SkillagerExposureLineageRequest
  previewId?: string
  used?: boolean
}
/** One feature action, with separate public lineage preparation and exact confirmation. */
export function useSkillagerExposure(options: Options) {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [state, setState] = useState<ActionState>()
  const stateRef = useRef(state)
  stateRef.current = state
  const lease = useRef<Lease>(undefined),
    sequence = useRef(0),
    reveal = useRef<AbortController>(undefined)
  const released = useRef<Promise<void>>(Promise.resolve())
  const destinations = exposureDestinations(options.projectState)
  const context = JSON.stringify([
    options.connection?.connectionId,
    options.projectState?.root,
    options.visible,
    options.detailId,
  ])
  const contextRef = useRef(context)
  contextRef.current = context
  const release = useCallback(() => {
    reveal.current?.abort()
    reveal.current = undefined
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
  const actions = useCallback(
    (metadata: SkillagerMetadata) =>
      exposureActions(
        metadata,
        optionsRef.current.projectState?.root.hostId === 'local',
        optionsRef.current.connection?.library.id,
      ),
    [],
  )
  const prepare = useCallback(
    async (metadata: SkillagerMetadata, action: ExposureAction, reviewId?: string) => {
      const options = optionsRef.current
      if (!options.connection || !options.projectState || !options.visible) return
      if (
        action === 'update'
          ? !reviewId || !eligibleSkillagerUpdate(metadata)
          : action !== 'change' &&
            !actions(metadata).some((item) => item.action === action && !item.disabled)
      )
        return
      if (action === 'review-update') {
        options.onUpdateReview?.(metadata)
        return
      }
      const destination = exposureDestinations(options.projectState).find((item) =>
        hostPathEquals(item.root, options.projectState!.root),
      )
      if (!destination && action !== 'add') return
      release()
      const copy = metadata.routerMembership ?? metadata.workspace
      const agent = copy?.agent ?? metadata.projectSkill?.agent ?? options.agent
      const mode =
        action === 'stub'
          ? 'stub'
          : action === 'full'
            ? 'native'
            : action === 'change'
              ? copy?.mode === 'stub'
                ? 'native'
                : 'stub'
              : copy?.mode === 'stub'
                ? 'stub'
                : 'native'
      const curation =
        ['group', 'edit-members', 'ungroup'].includes(action) ||
        Boolean(metadata.routerMembership) ||
        Boolean(isNativeProjectSkill(metadata) && action !== 'files')
      const next: ActionState = {
        metadata,
        action,
        reviewId,
        destination,
        agent,
        mode,
        curation: curation ? curationChoice(metadata) : undefined,
      }
      setState(next)
      const at = contextRef.current
      if (action === 'files') {
        if (!metadata.projectSkill || !options.onFiles) {
          setState({ ...next, failed: true, message: 'Files navigation is unavailable.' })
          return
        }
        const controller = new AbortController()
        reveal.current = controller
        setState({ ...next, loading: true })
        try {
          await options.onFiles(metadata.projectSkill.path, controller.signal)
          if (reveal.current === controller) close()
        } catch {
          if (reveal.current === controller && contextRef.current === at)
            setState({
              ...next,
              failed: true,
              message:
                'The exact current-project folder could not be revealed. Refresh its project metadata and try again.',
            })
        }
        return
      }
      if (
        !curation ||
        !destination ||
        (copy?.router && action !== 'group' && action !== 'edit-members')
      )
        return
      const owned: Lease = {
        request: {
          connectionId: options.connection.connectionId,
          workspaceRoot: options.projectState.root,
          destination,
          agent,
          requestId: ++sequence.current,
        },
      }
      lease.current = owned
      setState({ ...next, loading: true })
      try {
        await released.current
        if (lease.current !== owned || contextRef.current !== at) return
        const result = await window.hvir.invoke(
          'skillager:exposure-lineage',
          owned.request,
        )
        if (lease.current !== owned || contextRef.current !== at) return
        setState({
          ...next,
          curation: curationChoice(
            metadata,
            result.ok ? result.value : undefined,
            destination,
            options.connection.library.id,
          ),
          message: result.ok ? undefined : result.message,
        })
      } catch {
        if (lease.current === owned && contextRef.current === at)
          setState({
            ...next,
            message:
              'Native preservation is unavailable. Canonical and managed-target actions keep their own eligibility.',
          })
      } finally {
        if (lease.current === owned) lease.current = undefined
      }
    },
    [actions, close, release],
  )
  const start = useCallback(
    (metadata: SkillagerMetadata, action: ExposureAction, reviewId?: string): void => {
      void prepare(metadata, action, reviewId)
    },
    [prepare],
  )
  const choose = useCallback(
    (patch: {
      destination?: SkillagerDestination
      agent?: SkillagerAgent
      mode?: SkillagerExposureMode
      curation?: SkillagerCurationChoice
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
              completion: undefined,
              used: false,
              message: undefined,
              failed: false,
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
      current.applying ||
      current.action === 'files'
    )
      return
    const at = contextRef.current
    let request: SkillagerExposureActionRequest
    try {
      const base = {
        connectionId: options.connection.connectionId,
        workspaceRoot: options.projectState.root,
        requestId: ++sequence.current,
        destination: current.destination,
        agent: current.agent,
      }
      if (current.action === 'remove' && current.metadata.workspace?.router)
        request = {
          ...base,
          action: 'remove-router',
          exposure: current.metadata.workspace,
        }
      else if (current.curation)
        request = {
          ...base,
          action: 'plan',
          ...curationPlan(
            current.metadata,
            current.action as CurationAction | 'remove',
            current.mode,
            current.curation,
            current.destination,
            current.agent,
            options.connection.library.id,
            options.projectRows ?? [],
          ),
        }
      else
        request = {
          ...base,
          skillId: current.metadata.id,
          mode: current.mode,
          action:
            current.action === 'full' || current.action === 'stub'
              ? 'change'
              : (current.action as SkillagerExposureRequest['action']),
          reviewId: current.reviewId,
          exposure: current.action === 'add' ? undefined : current.metadata.workspace,
        }
    } catch (error) {
      setState({
        ...current,
        failed: true,
        message:
          error instanceof Error ? error.message : 'The selected action is unavailable.',
      })
      return
    }
    const owned: Lease = { request }
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
          request.destination,
        )
      )
        return
      const result = await window.hvir.invoke('skillager:preview-exposure', request)
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
          message: 'Could not prepare this project action.',
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
          completion: result.value,
          message: completionMessage(result.value, current),
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
            'Completion is uncertain. Project actions remain unavailable for this hvir session; Refresh and reconnect cannot establish every target, tag or recovery outcome. This confirmation cannot be retried.',
        })
      }
    }
  }, [])
  const menu = useSkillagerActions({
    context,
    sidebarVisible: options.sidebarVisible,
    detailsVisible: options.detailsVisible,
    blocked: Boolean(state) || !options.connection || !options.visible,
    onSelect: (metadata, action) => void start(metadata, action),
  })
  return {
    state,
    context,
    menu: { ...menu, actions },
    destinations,
    rows: options.rows ?? [],
    projectRows: options.projectRows ?? [],
    libraryId: options.connection?.library.id,
    start,
    close,
    choose,
    preview,
    apply,
  }
}
function completionMessage(
  result: SkillagerExposureActionCompletion,
  state: ActionState,
): string {
  if ('kind' in result)
    return result.kind === 'remove-router'
      ? `Removed router from ${result.target.path}. Its curated tag remains.`
      : result.status === 'applied'
        ? 'Confirmed project changes applied.'
        : 'Project changes only partially completed. Inspect every target outcome below.'
  const action =
    state.action === 'update'
      ? `Updated ${result.skillId} for ${state.agent}`
      : ['change', 'full', 'stub'].includes(state.action)
        ? `Changed ${result.skillId} to ${result.mode === 'native' ? 'Full skill' : 'Stub'}`
        : `${result.status === 'removed' ? 'Removed' : 'Added'} ${result.skillId}`
  return (
    `${action} at ${result.target.hostId}:${result.target.path}.` +
    (result.notice ? ` ${result.notice}` : '')
  )
}
export type SkillagerExposureController = ReturnType<typeof useSkillagerExposure>
