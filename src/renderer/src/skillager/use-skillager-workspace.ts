import { useSkillagerExposure } from './use-skillager-exposure'
import type { ProjectState } from '../../../shared/workspace-types'
import { useSkillagerReview } from './use-skillager-review'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { localPath } from '../../../shared/host-path'
import {
  SKILLAGER_REFRESH_MS,
  SKILLAGER_AGENTS,
  type SkillagerAgent,
  type SkillagerConnection,
  type SkillagerMetadata,
  type SkillagerMetadataResult,
  type SkillagerProbe,
  type SkillagerResult,
  type SkillagerSearchScope,
} from '../../../shared/skillager'
import { skillagerObservationDemand, skillagerTabs } from './skillager-model'

interface Options {
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
  const [scope, setScope] = useState<SkillagerSearchScope>('library')
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [search, setSearch] = useState<ReadState>(emptyRead)
  const [inventory, setInventory] = useState<ReadState>(emptyRead)
  const [tabs, dispatchTabs] = useReducer(skillagerTabs, { tabs: [] })
  const [foreground, setForeground] = useState(
    () => document.visibilityState === 'visible' && document.hasFocus(),
  )

  const cancel = useCallback((kind: 'search' | 'inventory') => {
    const requestId = ++requests.current[kind]
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

  const refresh = useCallback(async () => {
    const current = connectionRef.current
    const root = optionsRef.current.root
    if (!current || !root || !optionsRef.current.enabled) return
    const requestId = ++requests.current.inventory
    const at = generation.current
    setInventory((state) => ({ ...state, loading: true }))
    dispatchTabs({ type: 'invalidate', freshness: 'checking' })
    try {
      const result = await window.hvir.invoke('skillager:inventory', {
        connectionId: current.connectionId,
        requestId,
        workspaceRoot: root,
        agent,
      })
      if (requestId !== requests.current.inventory || at !== generation.current) return
      setInventory({ loading: false, result })
      if (result.ok) {
        dispatchTabs({ type: 'observe', result: result.value })
        if (optionsRef.current.projectState?.connectionState !== 'connected')
          dispatchTabs({ type: 'invalidate', freshness: 'stale' })
      } else dispatchTabs({ type: 'invalidate', freshness: 'unavailable' })
      if (!result.ok && result.reason === 'library-changed') disconnect()
    } catch {
      if (requestId === requests.current.inventory && at === generation.current) {
        dispatchTabs({ type: 'invalidate', freshness: 'unavailable' })
        setInventory({
          loading: false,
          result: {
            ok: false,
            reason: 'unavailable',
            message: 'Library metadata is unavailable. Try again.',
          },
        })
      }
    }
  }, [agent, disconnect])

  const submit = useCallback(
    async (submittedQuery = query.trim()) => {
      const current = connectionRef.current
      const root = optionsRef.current.root
      if (
        !current ||
        !root ||
        !submittedQuery ||
        !optionsRef.current.sidebarVisible ||
        (scope === 'workspace' &&
          optionsRef.current.projectState?.connectionState !== 'connected')
      )
        return
      const requestId = ++requests.current.search
      const at = generation.current
      setSubmitted(submittedQuery)
      setSearch({ loading: true })
      try {
        const result = await window.hvir.invoke('skillager:search', {
          connectionId: current.connectionId,
          requestId,
          workspaceRoot: root,
          agent,
          scope,
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
    [agent, scope, query, disconnect],
  )

  useEffect(() => {
    cancel('search')
    setSearch(emptyRead)
    setSubmitted('')
  }, [
    options.root?.hostId,
    options.root?.path,
    agent,
    scope,
    options.sidebarVisible,
    options.projectState?.connectionState,
    cancel,
  ])

  useEffect(() => {
    cancel('inventory')
    setInventory(emptyRead)
    dispatchTabs({ type: 'clear' })
    if (options.root?.hostId !== 'local') setScope('library')
  }, [options.root?.hostId, options.root?.path, agent, cancel])

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

  const observing = skillagerObservationDemand(
    options.enabled,
    Boolean(connection) && options.projectState?.connectionState === 'connected',
    foreground,
    options.sidebarVisible,
    Boolean(tabs.activeId) && options.viewerVisible,
  )
  const disconnectedReadDemand = skillagerObservationDemand(
    options.enabled,
    Boolean(connection) && options.projectState?.connectionState !== 'connected',
    foreground,
    options.sidebarVisible,
    Boolean(tabs.activeId) && options.viewerVisible,
  )
  useEffect(() => {
    if (!observing) {
      cancel('inventory')
      setInventory((state) => ({ ...state, loading: false }))
      dispatchTabs({ type: 'invalidate', freshness: 'stale' })
      // A visibility/connection action may read the local Personal library even
      // while SSH is unavailable. Only connected observation owns a timer.
      if (disconnectedReadDemand) void refresh()
      return
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), SKILLAGER_REFRESH_MS)
    return () => {
      window.clearInterval(timer)
      cancel('inventory')
    }
  }, [
    observing,
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
    setSearch(emptyRead)
  }, [cancel])

  const afterAcceptance = useCallback(() => {
    cancel('search')
    setSearch(emptyRead)
    void refresh()
    if (submitted) void submit(submitted)
  }, [cancel, refresh, submit, submitted])
  const reviews = useSkillagerReview({
    connection,
    root: options.root,
    projectState: options.projectState,
    agent,
    tabs: tabs.tabs,
    onAccepted: afterAcceptance,
  })

  const exposures = useSkillagerExposure({
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
