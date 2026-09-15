import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostPath } from '../../../shared/host-path'
import type {
  SkillagerAgent,
  SkillagerConnection,
  SkillagerMetadata,
  SkillagerRequest,
  SkillagerResult,
} from '../../../shared/skillager'
import type {
  SkillagerContentSelection,
  SkillagerContentSession,
} from '../../../shared/skillager-content'
import type { SkillagerReviewContent } from '../../../shared/skillager-review'
import { skillagerContentSelection } from './skillager-content-model'
import { skillagerMetadataKey } from './skillager-model'

interface Options {
  readonly connection?: SkillagerConnection
  readonly root?: HostPath
  readonly agent: SkillagerAgent
  readonly activeId?: string
  readonly visible: boolean
  readonly projectConnection?: string
}
interface State {
  readonly id?: string
  readonly loading?: boolean
  readonly selection?: SkillagerContentSelection
  readonly content?: SkillagerReviewContent
  readonly message?: string
  readonly stale?: boolean
  readonly currentFile?: boolean
  readonly source?: boolean
}
interface Lease {
  readonly request: SkillagerRequest
  readonly context: string
  readonly id: string
  contentId?: string
  serial: number
}

/** Only activate() admits a body read. Observation and retained metadata never do. */
export function useSkillagerContent(options: Options) {
  const [activation, setActivation] = useState<{
    metadata: SkillagerMetadata
    sequence: number
    currentFile: boolean
  }>()
  const [state, setState] = useState<State>({})
  const sequence = useRef(0),
    consumed = useRef(0),
    lease = useRef<Lease>(undefined)
  const context = JSON.stringify([
    options.connection?.connectionId,
    options.root,
    options.agent,
    options.projectConnection,
  ])
  const latest = useRef({ options, context })
  latest.current = { options, context }
  const release = useCallback(() => {
    const owned = lease.current
    lease.current = undefined
    if (!owned) return
    void window.hvir
      .invoke('skillager:cancel-document', { requestId: owned.request.requestId })
      .catch(() => undefined)
    if (owned.contentId)
      void window.hvir
        .invoke('skillager:release-document', { contentId: owned.contentId })
        .catch(() => undefined)
  }, [])
  const current = useCallback(
    (owned: Lease) =>
      lease.current === owned &&
      owned.context === latest.current.context &&
      latest.current.options.visible &&
      latest.current.options.activeId === owned.id,
    [],
  )
  const activate = useCallback(
    (metadata: SkillagerMetadata, currentFile = false) =>
      setActivation({ metadata, currentFile, sequence: ++sequence.current }),
    [],
  )
  useEffect(() => {
    release()
    setState({})
    const { connection, root, activeId, visible, agent } = latest.current.options
    if (
      !activation ||
      !connection ||
      !root ||
      !visible ||
      activeId !== skillagerMetadataKey(activation.metadata) ||
      activation.sequence === consumed.current
    )
      return
    consumed.current = activation.sequence
    const selection = skillagerContentSelection(
      activation.metadata,
      connection.library,
      root,
      activation.currentFile,
    )
    if (!selection) {
      setState({
        id: activeId,
        message:
          'This source is outside the connected library and current project. Its file is unavailable here.',
      })
      return
    }
    const owned: Lease = {
      context,
      id: activeId,
      serial: 0,
      request: {
        connectionId: connection.connectionId,
        workspaceRoot: root,
        agent: selection.agent ?? agent,
        requestId: ++sequence.current,
      },
    }
    lease.current = owned
    setState({
      id: activeId,
      selection,
      loading: true,
      currentFile: activation.currentFile,
    })
    void window.hvir
      .invoke('skillager:open-document', { ...owned.request, selection })
      .then((result: SkillagerResult<SkillagerContentSession>) => {
        if (result.ok) owned.contentId = result.value.contentId
        if (!current(owned)) {
          if (owned.contentId)
            void window.hvir
              .invoke('skillager:release-document', { contentId: owned.contentId })
              .catch(() => undefined)
          return
        }
        setState(
          result.ok
            ? {
                id: activeId,
                selection,
                content: result.value.content,
                currentFile: activation.currentFile,
              }
            : {
                id: activeId,
                selection,
                message: result.message,
                stale: result.reason === 'stale-review',
              },
        )
      })
      .catch(() => {
        if (current(owned))
          setState({
            id: activeId,
            selection,
            message: 'Could not read this skill file. Open it again.',
          })
      })
    return release
  }, [activation, context, options.activeId, options.visible, release, current])

  const read = useCallback(
    async (
      entry: string,
      documentEntry?: string,
    ): Promise<SkillagerResult<SkillagerReviewContent> | undefined> => {
      const owned = lease.current
      if (!owned?.contentId || !current(owned)) return
      const serial = documentEntry === undefined ? ++owned.serial : owned.serial
      if (documentEntry === undefined)
        setState((value) => ({ ...value, loading: true, message: undefined }))
      try {
        const result = await window.hvir.invoke('skillager:read-document', {
          ...owned.request,
          contentId: owned.contentId,
          entry,
          documentEntry,
        })
        if (!current(owned) || serial !== owned.serial) return
        if (documentEntry === undefined)
          setState((value) =>
            result.ok
              ? { ...value, loading: false, content: result.value, source: false }
              : { ...value, loading: false, message: result.message },
          )
        return result
      } catch {
        if (current(owned) && documentEntry === undefined)
          setState((value) => ({
            ...value,
            loading: false,
            message: 'Could not read this skill file.',
          }))
        return
      }
    },
    [current],
  )
  return {
    state,
    activate,
    read: useCallback((entry: string) => read(entry), [read]),
    asset: useCallback(
      (document: string, entry: string) => read(entry, document),
      [read],
    ),
    mode: (source: boolean) => setState((value) => ({ ...value, source })),
    reopen: () => {
      if (activation) activate(activation.metadata, true)
    },
  }
}
export type SkillagerContentController = ReturnType<typeof useSkillagerContent>
