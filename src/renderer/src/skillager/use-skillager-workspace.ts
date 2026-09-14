import { revealSkillagerFolder } from './skillager-files-reveal'
import { unwrapOperation } from '../../../shared'
import { useSkillagerLibrarySync } from './use-skillager-library-sync'
import { useSkillagerProject, type SkillagerSetupTerminal } from './use-skillager-project'
import { useSkillagerExposure } from './use-skillager-exposure'
import type { ProjectState } from '../../../shared/workspace-types'
import { useSkillagerReview } from './use-skillager-review'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { hostPathEquals, localPath, type HostPath } from '../../../shared/host-path'
import {
  SKILLAGER_REFRESH_MS,
  SKILLAGER_AGENTS,
  type SkillagerAgent,
  type SkillagerBrowseAgent,
  type SkillagerConnection,
  type SkillagerMetadata,
  type SkillagerMetadataResult,
  type SkillagerProbe,
  type SkillagerResult,
  type SkillagerSearchScope,
  type SkillagerSearchContext,
} from '../../../shared/skillager'
import {
  canonicalSkillagerMetadata,
  type SkillagerCanonicalObservation,
  skillagerObservationDemand,
  skillagerTabs,
  skillagerProjectRows,
  skillagerMetadataKey,
} from './skillager-model'

interface Options {
  readonly onRevealDirectory?: (path: HostPath) => void
  readonly onSetupTerminal?: SkillagerSetupTerminal
  readonly enabled: boolean
  readonly projectState?: ProjectState
  readonly sidebarVisible: boolean
  readonly viewerVisible: boolean
  readonly onActivate: () => void
  readonly onDisabled: () => void
}

interface ReadState {
  readonly loading: boolean
  readonly result?: SkillagerResult<SkillagerMetadataResult>
}

const emptyRead: ReadState = { loading: false }

export function useSkillagerWorkspace(input: Options) {
  const options = { ...input, root: input.projectState?.root }
  const optionsRef = useRef(options)
  optionsRef.current = options
  const generation = useRef(0)
  const selectedExecutable = useRef<string>(undefined)
  const requests = useRef({ search: 0, inventory: 0 })
  const inventoryPending = useRef(false)
  const [probe, setProbe] = useState<SkillagerResult<SkillagerProbe>>()
  const [probing, setProbing] = useState(false)
  const [connection, setConnection] = useState<SkillagerConnection>()
  const [connecting, setConnecting] = useState(false)
  const [connectionError, setConnectionError] = useState<string>()
  const [setupBusy, setSetupBusy] = useState<'choose' | 'initialize' | 'reconcile'>()
  const [gitHistory, setGitHistory] = useState(true)
  const connectionRef = useRef(connection)
  connectionRef.current = connection
  const [agent, setAgent] = useState<SkillagerAgent>(SKILLAGER_AGENTS[0].id)
  const [projectExpanded, setProjectExpanded] = useState(true)
  const [libraryExpanded, setLibraryExpanded] = useState(true)
  const [browseAgent, setBrowseAgent] = useState<SkillagerBrowseAgent>('all')
  const [scope, setScope] = useState<SkillagerSearchScope>('workspace')
  const [includeInstalled, setIncludeInstalled] = useState(false)
  const [separateCopies, setSeparateCopies] = useState(false)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [submittedContext, setSubmittedContext] = useState<SkillagerSearchContext>()
  const [search, setSearch] = useState<ReadState>(emptyRead)
  const [inventory, setInventory] = useState<ReadState>(emptyRead)
  const [tabs, dispatchTabs] = useReducer(skillagerTabs, { tabs: [] })
  const [foreground, setForeground] = useState(
    () => document.visibilityState === 'visible' && document.hasFocus(),
  )

  const cancel = useCallback((kind: 'search' | 'inventory') => {
    const requestId = ++requests.current[kind]
    if (kind === 'inventory') inventoryPending.current = false
    void window.hvir
      .invoke('skillager:cancel', { kind, requestId })
      .catch(() => undefined)
  }, [])

  const clear = useCallback(() => {
    generation.current++
    cancel('search')
    cancel('inventory')
    setConnection(undefined)
    setConnecting(false)
    connectionRef.current = undefined
    setSearch(emptyRead)
    setInventory(emptyRead)
    setSubmitted('')
    setConnectionError(undefined)
    setSetupBusy(undefined)
    setGitHistory(true)
    setProjectExpanded(true)
    setLibraryExpanded(true)
    setBrowseAgent('all')
    setIncludeInstalled(false)
    setSeparateCopies(false)
    setSubmittedContext(undefined)
    dispatchTabs({ type: 'clear' })
  }, [cancel])

  const check = useCallback(
    async (executable?: string) => {
      if (executable !== undefined) selectedExecutable.current = executable
      const selected = selectedExecutable.current?.trim()
      clear()
      setProbe(undefined)
      setProbing(true)
      const at = generation.current
      try {
        const result = await window.hvir.invoke('skillager:probe', {
          executable: selected ? localPath(selected) : undefined,
        })
        if (generation.current === at && optionsRef.current.enabled) setProbe(result)
      } catch {
        if (generation.current === at)
          setProbe({
            ok: false,
            reason: 'command-failed',
            message: 'Could not check Skillager.',
          })
      } finally {
        if (generation.current === at) setProbing(false)
      }
    },
    [clear],
  )

  useEffect(() => {
    const enabled = options.enabled
    const lifecycle = generation
    clear()
    setProbe(undefined)
    setProbing(false)
    setConnecting(false)
    let disposed = false
    void window.hvir
      .invoke('skillager:configure', { enabled })
      .then(() => {
        if (!disposed && enabled) void check()
      })
      .catch(() => undefined)
    if (!enabled) optionsRef.current.onDisabled()
    return () => {
      disposed = true
      lifecycle.current++
      void window.hvir
        .invoke('skillager:configure', { enabled: false })
        .catch(() => undefined)
    }
  }, [options.enabled, check, clear])

  const connect = useCallback(async () => {
    if (!probe?.ok || !probe.value.library) return
    const at = generation.current
    setConnecting(true)
    setConnectionError(undefined)
    try {
      const result = await window.hvir.invoke('skillager:connect', {
        probeId: probe.value.probeId,
      })
      if (at !== generation.current || !optionsRef.current.enabled) return
      if (result.ok) {
        setConnection(result.value)
        connectionRef.current = result.value
      } else setConnectionError(result.message)
    } catch {
      if (at === generation.current) setConnectionError('Could not connect to Skillager.')
    } finally {
      if (at === generation.current) setConnecting(false)
    }
  }, [probe])

  const setupLibrary = useCallback(
    async (action: 'choose' | 'initialize' | 'reconcile') => {
      if (!probe?.ok || setupBusy || !optionsRef.current.enabled) return
      const at = generation.current
      setSetupBusy(action)
      setConnectionError(undefined)
      const uncertain = () =>
        setProbe((current) =>
          current?.ok
            ? {
                ok: true,
                value: {
                  ...current.value,
                  setup: { ...current.value.setup, needsReconciliation: true },
                },
              }
            : current,
        )
      try {
        if (action === 'initialize') {
          const target = probe.value.setup?.target
          if (!target) return
          const result = await window.hvir.invoke('skillager:initialize-library', {
            selectionId: target.selectionId,
            gitHistory,
          })
          if (at !== generation.current || !optionsRef.current.enabled) return
          if (result.ok) {
            setProbe({ ok: true, value: result.value.probe })
            setConnection(result.value.connection)
            connectionRef.current = result.value.connection
          } else {
            setConnectionError(result.message)
            if (result.reason === 'uncertain') uncertain()
          }
        } else {
          const result = await window.hvir.invoke(
            action === 'choose'
              ? 'skillager:choose-library-folder'
              : 'skillager:reconcile-library',
            { probeId: probe.value.probeId },
          )
          if (at !== generation.current || !optionsRef.current.enabled) return
          if (result.ok) setProbe(result)
          else setConnectionError(result.message)
        }
      } catch {
        if (at === generation.current && optionsRef.current.enabled) {
          setConnectionError(
            action === 'initialize'
              ? 'Library setup could not be verified. Check library status before continuing.'
              : 'Could not complete the library setup action.',
          )
          if (action === 'initialize') uncertain()
        }
      } finally {
        if (at === generation.current) setSetupBusy(undefined)
      }
    },
    [probe, setupBusy, gitHistory],
  )

  const disconnect = useCallback(() => {
    clear()
    setProbe(undefined)
    void window.hvir.invoke('skillager:disconnect', {}).catch(() => undefined)
  }, [clear])

  const refresh = useCallback(
    async (replace = true) => {
      const current = connectionRef.current
      const root = optionsRef.current.root
      if (!current || !root || !optionsRef.current.enabled) return
      if (inventoryPending.current) {
        if (!replace) return
        cancel('inventory')
      }
      inventoryPending.current = true
      const requestId = ++requests.current.inventory
      const at = generation.current
      setInventory((state) => ({ ...state, loading: true }))
      try {
        const result = await window.hvir.invoke('skillager:inventory', {
          connectionId: current.connectionId,
          requestId,
          workspaceRoot: root,
          agent,
          browseAgent: 'all',
        })
        if (requestId !== requests.current.inventory || at !== generation.current) return
        setInventory({ loading: false, result })
        if (!result.ok && result.reason === 'library-changed') disconnect()
      } catch {
        if (requestId === requests.current.inventory && at === generation.current) {
          setInventory({
            loading: false,
            result: {
              ok: false,
              reason: 'unavailable',
              message: 'Library metadata is unavailable. Try again.',
            },
          })
        }
      } finally {
        if (requestId === requests.current.inventory) inventoryPending.current = false
      }
    },
    [agent, disconnect, cancel],
  )

  const submit = useCallback(
    async (
      submittedQuery = query.trim(),
      context: SkillagerSearchContext = {
        scope,
        browseAgent,
        view: separateCopies ? 'copies' : 'skills',
        includeInstalled,
      },
    ) => {
      const current = connectionRef.current
      const root = optionsRef.current.root
      if (
        !current ||
        !root ||
        !submittedQuery ||
        !optionsRef.current.sidebarVisible ||
        (context.scope === 'workspace' &&
          optionsRef.current.projectState?.connectionState !== 'connected')
      )
        return
      const requestId = ++requests.current.search
      const at = generation.current
      setSubmitted(submittedQuery)
      setSubmittedContext(context)
      setSearch({ loading: true })
      try {
        const result = await window.hvir.invoke('skillager:search', {
          connectionId: current.connectionId,
          requestId,
          workspaceRoot: root,
          agent,
          ...context,
          query: submittedQuery,
        })
        if (requestId !== requests.current.search || at !== generation.current) return
        setSearch({ loading: false, result })
        if (!result.ok && result.reason === 'library-changed') disconnect()
      } catch {
        if (requestId === requests.current.search && at === generation.current)
          setSearch({
            loading: false,
            result: {
              ok: false,
              reason: 'unavailable',
              message: 'Search is unavailable. Try again.',
            },
          })
      }
    },
    [agent, browseAgent, scope, query, includeInstalled, separateCopies, disconnect],
  )

  useEffect(() => {
    cancel('search')
    setSearch(emptyRead)
    setSubmitted('')
  }, [
    options.root?.hostId,
    options.root?.path,
    options.sidebarVisible,
    options.projectState?.connectionState,
    cancel,
  ])

  useEffect(() => {
    cancel('inventory')
    setInventory(emptyRead)
    dispatchTabs({ type: 'clear' })
    setScope(options.root?.hostId === 'local' ? 'workspace' : 'library')
  }, [options.root?.hostId, options.root?.path, cancel])

  useEffect(() => {
    if (!options.enabled) return
    const update = (): void =>
      setForeground(document.visibilityState === 'visible' && document.hasFocus())
    update()
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [options.enabled])

  const localProject = options.root?.hostId === 'local'
  const activeDetail = tabs.tabs.find((tab) => tab.id === tabs.activeId)
  const observing = skillagerObservationDemand(
    options.enabled,
    Boolean(connection) && options.projectState?.connectionState === 'connected',
    foreground,
    options.sidebarVisible,
    Boolean(activeDetail) && options.viewerVisible,
  )
  const disconnectedReadDemand = skillagerObservationDemand(
    options.enabled,
    Boolean(connection) && options.projectState?.connectionState !== 'connected',
    foreground,
    options.sidebarVisible && (libraryExpanded || (!localProject && projectExpanded)),
    Boolean(
      activeDetail &&
      (!localProject
        ? !activeDetail.metadata.projectSkill
        : activeDetail.metadata.source.ownership === 'library'),
    ) && options.viewerVisible,
  )
  const projectDemand =
    observing &&
    localProject &&
    ((options.sidebarVisible && projectExpanded) ||
      Boolean(
        activeDetail &&
        options.viewerVisible &&
        (activeDetail.metadata.projectSkill ||
          activeDetail.metadata.workspace ||
          activeDetail.metadata.routerMembership),
      ))
  const project = useSkillagerProject({
    connection,
    root: options.root,
    agent,
    openTerminal: options.onSetupTerminal,
    demand: projectDemand,
  })
  const requiresLibraryMetadata = Boolean(
    projectDemand && project.result?.ok && project.result.value.requiresLibraryMetadata,
  )
  const inventoryDemand = skillagerObservationDemand(
    options.enabled,
    Boolean(connection) && options.projectState?.connectionState === 'connected',
    foreground,
    (options.sidebarVisible && (libraryExpanded || (!localProject && projectExpanded))) ||
      requiresLibraryMetadata,
    Boolean(
      activeDetail &&
      (!localProject
        ? !activeDetail.metadata.projectSkill
        : activeDetail.metadata.source.ownership === 'library' &&
          !activeDetail.metadata.workspace &&
          !activeDetail.metadata.routerMembership),
    ) && options.viewerVisible,
  )
  const library = inventory.result?.ok ? inventory.result.value : undefined
  const canonicalRows = useMemo(
    () => canonicalSkillagerMetadata(library?.rows ?? []),
    [library],
  )
  const canonical = useMemo<SkillagerCanonicalObservation>(
    () => ({
      rows: canonicalRows,
      checkedAt: library?.checkedAt,
      freshness: !observing
        ? 'stale'
        : inventory.loading
          ? 'checking'
          : library
            ? 'fresh'
            : 'unavailable',
    }),
    [canonicalRows, library, observing, inventory.loading],
  )
  const projectResult = localProject ? project.result : inventory.result
  const projectRows = useMemo(
    () => (projectResult?.ok ? skillagerProjectRows(projectResult.value, canonical) : []),
    [projectResult, canonical],
  )
  useEffect(() => {
    if (library) dispatchTabs({ type: 'observe', result: library, canonical })
    if (canonical.freshness !== 'fresh')
      dispatchTabs({
        type: 'invalidate',
        scope: 'library',
        freshness: canonical.freshness,
      })
  }, [library, canonical])
  useEffect(() => {
    if (project.result?.ok)
      dispatchTabs({ type: 'observe-project', result: project.result.value, canonical })
    else if (project.result?.reason === 'library-changed') disconnect()
    if ((project.result && !project.result.ok) || project.loading || !projectDemand)
      dispatchTabs({
        type: 'invalidate',
        scope: 'project',
        freshness: project.loading ? 'checking' : projectDemand ? 'unavailable' : 'stale',
      })
  }, [project.result, project.loading, projectDemand, canonical, disconnect])
  useEffect(() => {
    if (!inventoryDemand) {
      cancel('inventory')
      setInventory((state) => ({ ...state, loading: false }))
      dispatchTabs({ type: 'invalidate', scope: 'library', freshness: 'stale' })
      // A visibility/connection action may read the local Personal library even
      // while SSH is unavailable. Only connected observation owns a timer.
      if (disconnectedReadDemand) void refresh(false)
      return
    }
    void refresh(false)
    const timer = window.setInterval(() => void refresh(false), SKILLAGER_REFRESH_MS)
    return () => {
      window.clearInterval(timer)
      cancel('inventory')
    }
  }, [
    inventoryDemand,
    connection?.connectionId,
    options.root?.hostId,
    options.root?.path,
    disconnectedReadDemand,
    refresh,
    cancel,
  ])

  const select = useCallback((metadata: SkillagerMetadata) => {
    dispatchTabs({ type: 'select', metadata })
    optionsRef.current.onActivate()
  }, [])
  const activate = useCallback((id: string) => {
    dispatchTabs({ type: 'activate', id })
    optionsRef.current.onActivate()
  }, [])
  const deactivate = useCallback(() => dispatchTabs({ type: 'deactivate' }), [])
  const close = useCallback((id: string) => dispatchTabs({ type: 'close', id }), [])
  const clearSearch = useCallback(() => {
    cancel('search')
    setQuery('')
    setSubmitted('')
    setSubmittedContext(undefined)
    setSearch(emptyRead)
  }, [cancel])

  const refreshProject = project.refresh
  const refreshProjectMetadata = useCallback(async () => {
    await Promise.all([refreshProject(), inventoryDemand ? refresh() : Promise.resolve()])
  }, [refreshProject, inventoryDemand, refresh])
  const afterAcceptance = useCallback(() => {
    cancel('inventory')
    cancel('search')
    setSearch(emptyRead)
    void refresh()
    if (submitted) void submit(submitted, submittedContext)
    void refreshProject()
  }, [cancel, refresh, submit, submitted, submittedContext, refreshProject])
  const reviews = useSkillagerReview({
    connection,
    root: options.root,
    projectState: options.projectState,
    agent,
    tabs: tabs.tabs,
    activeId: tabs.activeId,
    onAccepted: afterAcceptance,
  })

  const librarySyncVisible =
    options.enabled &&
    options.projectState?.connectionState === 'connected' &&
    (options.sidebarVisible || (Boolean(tabs.activeId) && options.viewerVisible))
  const librarySync = useSkillagerLibrarySync({
    connection:
      options.enabled && options.projectState?.connectionState === 'connected'
        ? connection
        : undefined,
    root: options.root,
    agent,
    visible: librarySyncVisible,
    onCompleted: () => {
      if (librarySyncVisible) afterAcceptance()
    },
  })

  const [updateSelection, setUpdateSelection] = useState<SkillagerMetadata>()
  useEffect(() => {
    if (!updateSelection || tabs.activeId !== skillagerMetadataKey(updateSelection))
      return
    setUpdateSelection(undefined)
    void reviews.review({ id: tabs.activeId, metadata: updateSelection }, true)
  }, [updateSelection, tabs.activeId, reviews])
  const exposures = useSkillagerExposure({
    rows: library?.rows ?? [],
    projectRows,
    onUpdateReview: (metadata) => {
      select(metadata)
      setUpdateSelection(metadata)
    },
    onFiles: async (path, signal) => {
      const selected = optionsRef.current.root
      const selectedConnection = connectionRef.current
      const reveal = optionsRef.current.onRevealDirectory
      if (!selected || !selectedConnection || !reveal)
        throw new Error('Files navigation is unavailable.')
      await revealSkillagerFolder(selected, path, signal, {
        current: () =>
          Boolean(
            optionsRef.current.enabled &&
            connectionRef.current === selectedConnection &&
            optionsRef.current.projectState?.connectionState === 'connected' &&
            optionsRef.current.root &&
            hostPathEquals(selected, optionsRef.current.root),
          ),
        resolve: (path) =>
          window.hvir.invoke('fs:resolve-entry', { path }).then(unwrapOperation),
        reveal,
      })
    },
    connection,
    detailId: tabs.activeId,
    sidebarVisible: options.sidebarVisible,
    detailsVisible: Boolean(tabs.activeId) && options.viewerVisible,
    projectState: options.projectState,
    agent,
    visible:
      options.enabled &&
      options.projectState?.connectionState === 'connected' &&
      (options.sidebarVisible || (Boolean(tabs.activeId) && options.viewerVisible)),
    onCompleted: afterAcceptance,
  })

  return {
    librarySync,
    project,
    canonical,
    projectRows,
    refreshProjectMetadata,
    projectExpanded,
    setProjectExpanded,
    libraryExpanded,
    setLibraryExpanded,
    browseAgent,
    setBrowseAgent,
    includeInstalled,
    setIncludeInstalled,
    separateCopies,
    setSeparateCopies,
    exposures,
    reviews,
    enabled: options.enabled,
    observing,
    sidebarVisible: options.sidebarVisible,
    viewerVisible: options.viewerVisible,
    probe,
    probing,
    check,
    connect,
    connecting,
    connectionError,
    setupBusy,
    setupLibrary,
    gitHistory,
    setGitHistory,
    connection,
    disconnect,
    inventory,
    refresh,
    query,
    setQuery,
    submitted,
    submittedContext,
    search,
    submit,
    scope,
    setScope,
    agent,
    setAgent,
    tabs: options.enabled ? tabs.tabs : [],
    activeId: options.enabled ? tabs.activeId : undefined,
    active: options.enabled
      ? tabs.tabs.find((tab) => tab.id === tabs.activeId)
      : undefined,
    select,
    activate,
    deactivate,
    close,
    clearSearch,
  }
}

export type SkillagerController = ReturnType<typeof useSkillagerWorkspace>
