import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import {
  asHostId,
  dirnameHostPath,
  defaultViewMode,
  hostPath,
  hostPathEquals,
  type DiffBase,
  type FileOpenContext,
  type HostPath,
  type HostConnectionState,
  type HostWatchTier,
  type ProjectHostOption,
  type ConnectedHost,
  type BrowseHostResponse,
  type ProjectState,
  type SshPromptRequest,
  type ViewMode,
  type WatchEvent,
} from '../../shared'
import { PaneResizer } from './layout/PaneResizer'
import { TerminalView } from './terminal/TerminalView'
import { FileTree } from './tree/FileTree'
import { GitPanel } from './git/GitPanel'
import { FileViewer } from './viewer/FileViewer'
import { TabStrip } from './viewer/TabStrip'
import type { ViewerTab } from './viewer/tab-state'

const TREE_MIN_WIDTH = 160
const TREE_MAX_WIDTH = 520
const MAIN_MIN_WIDTH = 420
const VIEWER_MIN_HEIGHT = 180
const TERMINAL_MIN_HEIGHT = 160
const DIVIDER_SIZE = 5
const TAB_STORAGE_VERSION = 1

export function App(): ReactElement {
  const workbenchRef = useRef<HTMLElement>(null)
  const tabsRef = useRef<readonly ViewerTab[]>([])
  const activeIdRef = useRef<string | undefined>(undefined)
  const watchHandler = useRef<(event: WatchEvent) => void>(() => undefined)
  const pendingScroll = useRef<
    { readonly id: string; readonly scrollTop: number } | undefined
  >(undefined)
  const scrollFrame = useRef<number | undefined>(undefined)
  const persistedState = useRef<
    | {
        readonly root: HostPath
        readonly tabs: readonly ViewerTab[]
        readonly activeId?: string
      }
    | undefined
  >(undefined)
  const [root, setRoot] = useState<HostPath>()
  const [rootError, setRootError] = useState<string>()
  const [watchVersion, setWatchVersion] = useState(0)
  const [tabs, setTabs] = useState<readonly ViewerTab[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [restored, setRestored] = useState(false)
  const [railMode, setRailMode] = useState<'files' | 'git'>('files')
  const [changedCount, setChangedCount] = useState(0)
  const [connectionState, setConnectionState] = useState<HostConnectionState>('connected')
  const [watchTier, setWatchTier] = useState<HostWatchTier>('native')
  const [hosts, setHosts] = useState<readonly ProjectHostOption[]>([])
  const [showAddProject, setShowAddProject] = useState(false)
  const [sshPrompt, setSshPrompt] = useState<SshPromptRequest>()
  tabsRef.current = tabs
  activeIdRef.current = activeId

  const loadFile = useCallback((path: HostPath): void => {
    const id = tabId(path)
    setTabs((current) =>
      current.map((tab) =>
        tab.id === id ? { ...tab, loading: !tab.file, error: undefined } : tab,
      ),
    )
    void window.hvir.invoke('fs:read', { path }).then(
      (file) => {
        setTabs((current) =>
          current.map((tab) =>
            tab.id === id
              ? {
                  ...tab,
                  file,
                  loading: false,
                  error: undefined,
                  conflict: false,
                }
              : tab,
          ),
        )
      },
      (reason: unknown) => {
        const error = reason instanceof Error ? reason.message : String(reason)
        setTabs((current) =>
          current.map((tab) =>
            tab.id === id
              ? tab.diffRevision
                ? {
                    ...tab,
                    file: {
                      path: tab.path,
                      content: '',
                      size: 0,
                      mtimeMs: 0,
                      binary: false,
                    },
                    loading: false,
                    error: undefined,
                  }
                : { ...tab, file: undefined, loading: false, error }
              : tab,
          ),
        )
      },
    )
  }, [])

  useEffect(() => {
    let cancelled = false
    let watchRefreshTimer: number | undefined
    void window.hvir.invoke('project:root', undefined).then(
      ({ root: projectRoot }) => {
        if (!cancelled) setRoot(projectRoot)
      },
      (error: unknown) => {
        if (!cancelled)
          setRootError(error instanceof Error ? error.message : String(error))
      },
    )
    const stopWatch = window.hvir.on('project:watch', (event) => {
      if (watchRefreshTimer === undefined) {
        watchRefreshTimer = window.setTimeout(() => {
          watchRefreshTimer = undefined
          setWatchVersion((version) => version + 1)
        }, 250)
      }
      watchHandler.current(event)
    })
    const stopState = window.hvir.on('project:state', (state) => {
      setConnectionState(state.connectionState)
      setWatchTier(state.watchTier)
    })
    const stopPrompt = window.hvir.on('ssh:prompt', setSshPrompt)
    return () => {
      cancelled = true
      if (watchRefreshTimer !== undefined) window.clearTimeout(watchRefreshTimer)
      void stopWatch()
      void stopState()
      void stopPrompt()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.hvir.invoke('project:hosts', undefined).then(
      (nextHosts) => {
        if (!cancelled) setHosts(nextHosts)
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [showAddProject])

  useEffect(() => {
    if (!root) return
    const restoredState = restoreTabs(root)
    setTabs(restoredState.tabs)
    setActiveId(restoredState.activeId)
    setRestored(true)
    for (const tab of restoredState.tabs) loadFile(tab.path)
  }, [loadFile, root])

  useEffect(() => {
    if (!root || !restored) return
    persistedState.current = { root, tabs, activeId }
    const timer = window.setTimeout(() => persistTabs(root, tabs, activeId), 250)
    return () => window.clearTimeout(timer)
  }, [activeId, restored, root, tabs])

  useEffect(() => {
    const flushPersistence = (): void => {
      const state = persistedState.current
      if (state) persistTabs(state.root, state.tabs, state.activeId)
    }
    window.addEventListener('pagehide', flushPersistence)
    return () => {
      window.removeEventListener('pagehide', flushPersistence)
      if (scrollFrame.current !== undefined) {
        window.cancelAnimationFrame(scrollFrame.current)
      }
    }
  }, [])

  useEffect(() => {
    const cycle = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        !(event.ctrlKey || event.metaKey) ||
        !event.shiftKey ||
        event.key.toLowerCase() !== 'm'
      ) {
        return
      }
      if (event.target instanceof Element && event.target.closest('.terminal-panel')) {
        return
      }
      const id = activeIdRef.current
      if (!id) return
      event.preventDefault()
      setTabs((current) =>
        current.map((tab) =>
          tab.id === id ? { ...tab, mode: nextMode(tab.mode) } : tab,
        ),
      )
    }
    window.addEventListener('keydown', cycle, true)
    return () => window.removeEventListener('keydown', cycle, true)
  }, [])

  watchHandler.current = (event): void => {
    const tab = tabsRef.current.find((candidate) =>
      hostPathEquals(candidate.path, event.path),
    )
    if (!tab) return
    if (tab.dirty) {
      setTabs((current) =>
        current.map((candidate) =>
          candidate.id === tab.id ? { ...candidate, conflict: true } : candidate,
        ),
      )
    } else {
      loadFile(tab.path)
    }
  }

  const openFile = (
    path: HostPath,
    pinned: boolean,
    context: FileOpenContext = 'file-tree',
    diffBase: DiffBase = 'head',
    diffRevision?: string,
  ): void => {
    const id = tabId(path)
    setTabs((current) => {
      const existing = current.find((tab) => tab.id === id)
      if (existing) {
        return current.map((tab) =>
          tab.id === id
            ? {
                ...tab,
                pinned: pinned || tab.pinned,
                mode: context === 'git' ? 'diff' : tab.mode,
                diffBase: context === 'git' ? diffBase : tab.diffBase,
                diffRevision: context === 'git' ? diffRevision : tab.diffRevision,
              }
            : tab,
        )
      }
      const created: ViewerTab = {
        id,
        path,
        pinned,
        mode: defaultViewMode(path, context),
        diffBase,
        diffRevision,
        scrollTop: 0,
        loading: true,
        dirty: false,
        conflict: false,
      }
      const previewIndex = current.findIndex((tab) => !tab.pinned && !tab.dirty)
      if (previewIndex < 0) return [...current, created]
      const next = [...current]
      next[previewIndex] = created
      return next
    })
    setActiveId(id)
    loadFile(path)
  }

  const closeTab = (id: string): void => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id)
      if (index < 0) return current
      const next = current.filter((tab) => tab.id !== id)
      if (activeIdRef.current === id) {
        setActiveId(next[Math.min(index, next.length - 1)]?.id)
      }
      return next
    })
  }

  const updateTab = (id: string, update: (tab: ViewerTab) => ViewerTab): void => {
    setTabs((current) => current.map((tab) => (tab.id === id ? update(tab) : tab)))
  }

  const updateActive = (update: (tab: ViewerTab) => ViewerTab): void => {
    const id = activeIdRef.current
    if (id) updateTab(id, update)
  }

  const scheduleScrollPersistence = (id: string, scrollTop: number): void => {
    pendingScroll.current = { id, scrollTop }
    if (scrollFrame.current !== undefined) return
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = undefined
      const pending = pendingScroll.current
      pendingScroll.current = undefined
      if (pending) {
        updateTab(pending.id, (tab) => ({ ...tab, scrollTop: pending.scrollTop }))
      }
    })
  }

  const saveActive = (): void => {
    const tab = tabsRef.current.find((candidate) => candidate.id === activeIdRef.current)
    if (!tab?.file || tab.file.binary || tab.conflict) return
    const savedContent = tab.file.content
    void window.hvir.invoke('fs:write', { path: tab.path, content: savedContent }).then(
      (written) => {
        setTabs((current) =>
          current.map((candidate) => {
            if (candidate.id !== tab.id || !candidate.file) return candidate
            const unchangedSinceSave = candidate.file.content === savedContent
            return {
              ...candidate,
              dirty: unchangedSinceSave ? false : candidate.dirty,
              conflict: unchangedSinceSave ? false : candidate.conflict,
              file: {
                ...candidate.file,
                size: unchangedSinceSave ? written.size : candidate.file.size,
                mtimeMs: written.mtimeMs,
              },
            }
          }),
        )
      },
      (reason: unknown) => {
        const error = reason instanceof Error ? reason.message : String(reason)
        setTabs((current) =>
          current.map((candidate) =>
            candidate.id === tab.id ? { ...candidate, error } : candidate,
          ),
        )
      },
    )
  }

  const activeTab = tabs.find((tab) => tab.id === activeId)

  const setTreeWidth = (width: number): void => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const max = Math.max(
      TREE_MIN_WIDTH,
      Math.min(TREE_MAX_WIDTH, workbench.clientWidth - DIVIDER_SIZE - MAIN_MIN_WIDTH),
    )
    workbench.style.setProperty('--tree-track', `${clamp(width, TREE_MIN_WIDTH, max)}px`)
  }

  const setTerminalHeight = (height: number): void => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const max = Math.max(
      TERMINAL_MIN_HEIGHT,
      workbench.clientHeight - DIVIDER_SIZE - VIEWER_MIN_HEIGHT,
    )
    workbench.style.setProperty(
      '--terminal-track',
      `${clamp(height, TERMINAL_MIN_HEIGHT, max)}px`,
    )
  }

  if (rootError) return <div className="startup-error">{rootError}</div>
  if (!root) return <div className="startup-loading">Starting hvir…</div>

  return (
    <>
      <main
        className={`workbench${connectionState === 'connected' ? '' : ' project-stale'}`}
        ref={workbenchRef}
      >
        {railMode === 'files' ? (
          <FileTree
            root={root}
            refreshVersion={watchVersion}
            selected={activeTab?.path}
            onOpen={openFile}
            onShowGit={() => setRailMode('git')}
            changedCount={changedCount}
            connectionState={connectionState}
            watchTier={watchTier}
            sessionLabel={root.hostId === 'local' ? 'Local' : `ssh:${root.hostId}`}
            onChangeSession={() => setShowAddProject(true)}
          />
        ) : (
          <GitPanel
            root={root}
            refreshVersion={watchVersion}
            onShowFiles={() => setRailMode('files')}
            onChangedCount={setChangedCount}
            onOpen={(path, base, revision) => openFile(path, true, 'git', base, revision)}
            connectionState={connectionState}
            watchTier={watchTier}
            sessionLabel={root.hostId === 'local' ? 'Local' : `ssh:${root.hostId}`}
            onChangeSession={() => setShowAddProject(true)}
          />
        )}
        <PaneResizer
          orientation="vertical"
          className="tree-resizer"
          label="Resize file tree"
          onDrag={(clientX) => {
            const left = workbenchRef.current?.getBoundingClientRect().left ?? 0
            setTreeWidth(clientX - left)
          }}
          onNudge={(delta) => {
            const current =
              workbenchRef.current?.querySelector<HTMLElement>('.tree-panel')
            if (current) setTreeWidth(current.getBoundingClientRect().width + delta)
          }}
          onReset={() => workbenchRef.current?.style.removeProperty('--tree-track')}
        />
        <section className="viewer-panel" aria-label="File viewer">
          <TabStrip
            tabs={tabs}
            activeId={activeId}
            onActivate={setActiveId}
            onClose={closeTab}
            onPin={(id) =>
              setTabs((current) =>
                current.map((tab) => (tab.id === id ? { ...tab, pinned: true } : tab)),
              )
            }
            onReorder={(draggedId, targetId) => {
              setTabs((current) => reorderTabs(current, draggedId, targetId))
            }}
          />
          <FileViewer
            key={activeTab?.id ?? 'empty'}
            tab={activeTab}
            onMode={(mode) => updateActive((tab) => ({ ...tab, mode }))}
            onDiffBase={(diffBase) => updateActive((tab) => ({ ...tab, diffBase }))}
            onContent={(content) =>
              updateActive((tab) =>
                tab.file
                  ? {
                      ...tab,
                      pinned: true,
                      dirty: true,
                      file: {
                        ...tab.file,
                        content,
                        size: new TextEncoder().encode(content).byteLength,
                      },
                    }
                  : tab,
              )
            }
            onSave={saveActive}
            onReload={() => {
              if (!activeTab) return
              updateTab(activeTab.id, (tab) => ({
                ...tab,
                dirty: false,
                conflict: false,
              }))
              loadFile(activeTab.path)
            }}
            onScroll={(scrollTop) =>
              activeTab && scheduleScrollPersistence(activeTab.id, scrollTop)
            }
            onOpenPath={(path) => {
              if (activeTab) {
                updateTab(activeTab.id, (tab) => ({ ...tab, pinned: true }))
              }
              openFile(path, true)
            }}
          />
        </section>
        <PaneResizer
          orientation="horizontal"
          className="terminal-resizer"
          label="Resize terminal"
          onDrag={(clientY) => {
            const bottom = workbenchRef.current?.getBoundingClientRect().bottom ?? 0
            setTerminalHeight(bottom - clientY)
          }}
          onNudge={(delta) => {
            const current =
              workbenchRef.current?.querySelector<HTMLElement>('.terminal-panel')
            if (current) setTerminalHeight(current.getBoundingClientRect().height + delta)
          }}
          onReset={() => workbenchRef.current?.style.removeProperty('--terminal-track')}
        />
        <TerminalView cwd={root} />
      </main>
      {showAddProject ? (
        <SessionDialog
          hosts={hosts}
          currentRoot={root}
          onCancel={() => setShowAddProject(false)}
          onConnect={(hostId) => window.hvir.invoke('project:connect-host', { hostId })}
          onBrowse={(hostId, path) =>
            window.hvir.invoke('project:browse-host', { hostId, path })
          }
          onOpen={(hostId, path) => window.hvir.invoke('project:open', { hostId, path })}
          onOpened={(state) => {
            persistTabs(root, tabsRef.current, activeIdRef.current)
            setRestored(false)
            setRoot(state.root)
            setConnectionState(state.connectionState)
            setWatchTier(state.watchTier)
            setTabs([])
            setActiveId(undefined)
            setChangedCount(0)
            setShowAddProject(false)
          }}
        />
      ) : null}
      {sshPrompt ? (
        <SshPromptDialog
          prompt={sshPrompt}
          onAnswer={(answers) => {
            void window.hvir.invoke('ssh:prompt-response', {
              id: sshPrompt.id,
              answers,
            })
            setSshPrompt(undefined)
          }}
        />
      ) : null}
    </>
  )
}

function SessionDialog({
  hosts,
  currentRoot,
  onCancel,
  onConnect,
  onBrowse,
  onOpen,
  onOpened,
}: {
  readonly hosts: readonly ProjectHostOption[]
  readonly currentRoot: HostPath
  readonly onCancel: () => void
  readonly onConnect: (hostId: string) => Promise<ConnectedHost>
  readonly onBrowse: (hostId: string, path: string) => Promise<BrowseHostResponse>
  readonly onOpen: (hostId: string, path: string) => Promise<ProjectState>
  readonly onOpened: (state: ProjectState) => void
}): ReactElement {
  const [stage, setStage] = useState<'host' | 'folder'>('host')
  const [hostId, setHostId] = useState(
    hosts.some((host) => host.hostId === currentRoot.hostId)
      ? currentRoot.hostId
      : (hosts[0]?.hostId ?? 'local'),
  )
  const [connected, setConnected] = useState<ConnectedHost>()
  const [path, setPath] = useState('')
  const [directories, setDirectories] = useState<BrowseHostResponse['directories']>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const selectedHost = hosts.find((host) => host.hostId === hostId)

  const browse = async (targetPath: string): Promise<void> => {
    if (!connected) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await onBrowse(connected.host.hostId, targetPath)
      setPath(result.path.path)
      setDirectories(result.directories)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const connect = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await onConnect(hostId)
      setConnected(result)
      setPath(result.suggestedPath)
      setStage('folder')
      const listing = await onBrowse(result.host.hostId, result.suggestedPath)
      setPath(listing.path.path)
      setDirectories(listing.directories)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const open = async (): Promise<void> => {
    if (!connected || !path.trim()) return
    setBusy(true)
    setError(undefined)
    try {
      const state = await onOpen(connected.host.hostId, path.trim())
      rememberFolder(connected.host.hostId, state.root.path)
      onOpened(state)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <section className="project-dialog session-dialog" aria-label="Change session">
        <h2>
          {stage === 'host'
            ? 'Connect to a host'
            : `Open folder on ${connected?.host.label ?? hostId}`}
        </h2>
        {error ? <p className="dialog-error">{error}</p> : null}
        {stage === 'host' ? (
          <div className="session-hosts" role="listbox" aria-label="Hosts">
            {hosts.map((host) => (
              <button
                type="button"
                role="option"
                aria-selected={hostId === host.hostId}
                className={`session-host-option${hostId === host.hostId ? ' selected' : ''}`}
                key={host.hostId}
                onClick={() => setHostId(host.hostId)}
              >
                <span className={`connection-state ${host.connectionState}`} />
                <span>
                  <strong>{host.kind === 'ssh' ? `ssh:${host.label}` : 'Local'}</strong>
                  <small>
                    {host.kind === 'ssh' ? host.connectionState : 'this machine'}
                  </small>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <>
            <form
              className="folder-path-form"
              onSubmit={(event) => {
                event.preventDefault()
                void browse(path)
              }}
            >
              <input
                aria-label="Folder path"
                autoFocus
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
              <button type="submit" disabled={busy}>
                Go
              </button>
            </form>
            {connected ? (
              <div className="recent-folders">
                {recentFolders(connected.host.hostId).map((folder) => (
                  <button type="button" key={folder} onClick={() => void browse(folder)}>
                    {folder}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="folder-browser" aria-label="Folders">
              <button
                type="button"
                className="folder-row"
                disabled={path === '/' || busy}
                onClick={() =>
                  connected &&
                  void browse(
                    dirnameHostPath(hostPath(asHostId(connected.host.hostId), path)).path,
                  )
                }
              >
                <span>..</span>
                <small>Parent folder</small>
              </button>
              {directories.map((directory) => (
                <button
                  type="button"
                  className="folder-row"
                  key={directory.name}
                  disabled={busy}
                  onClick={() =>
                    void browse(`${path.replace(/\/$/, '')}/${directory.name}`)
                  }
                >
                  <span>{directory.name}</span>
                  <small>Folder</small>
                </button>
              ))}
              {directories.length === 0 && !busy ? <p>No subfolders</p> : null}
              {busy ? <p>Loading…</p> : null}
            </div>
          </>
        )}
        <div className="dialog-actions">
          {stage === 'folder' ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setStage('host')
                setConnected(undefined)
                setError(undefined)
              }}
            >
              Back
            </button>
          ) : null}
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void (stage === 'host' ? connect() : open())}
          >
            {busy
              ? 'Working…'
              : stage === 'host'
                ? selectedHost?.kind === 'local' ||
                  selectedHost?.connectionState === 'connected'
                  ? 'Choose folder'
                  : 'Connect'
                : 'Open this folder'}
          </button>
        </div>
      </section>
    </div>
  )
}

function SshPromptDialog({
  prompt,
  onAnswer,
}: {
  readonly prompt: SshPromptRequest
  readonly onAnswer: (answers?: readonly string[]) => void
}): ReactElement {
  const [answers, setAnswers] = useState(() => prompt.prompts.map(() => ''))
  return (
    <div className="modal-backdrop">
      <form
        className="project-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          onAnswer(answers)
        }}
      >
        <h2>{prompt.title}</h2>
        {prompt.instructions ? <p>{prompt.instructions}</p> : null}
        {prompt.prompts.map((item, index) => (
          <label key={`${item.text}:${index}`}>
            {item.text}
            <input
              autoFocus={index === 0}
              type={item.echo ? 'text' : 'password'}
              value={answers[index]}
              onChange={(event) =>
                setAnswers((current) =>
                  current.map((answer, at) =>
                    at === index ? event.target.value : answer,
                  ),
                )
              }
            />
          </label>
        ))}
        <div className="dialog-actions">
          <button type="button" onClick={() => onAnswer(undefined)}>
            Cancel
          </button>
          <button type="submit">Continue</button>
        </div>
      </form>
    </div>
  )
}

function recentFolders(hostId: string): readonly string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`hvir:recent-folders:${hostId}`) ?? '[]',
    )
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').slice(0, 5)
      : []
  } catch {
    return []
  }
}

function rememberFolder(hostId: string, path: string): void {
  const next = [path, ...recentFolders(hostId).filter((folder) => folder !== path)].slice(
    0,
    5,
  )
  localStorage.setItem(`hvir:recent-folders:${hostId}`, JSON.stringify(next))
}

interface StoredTabs {
  readonly version: number
  readonly activeId?: string
  readonly tabs: readonly {
    readonly hostId: string
    readonly path: string
    readonly pinned: boolean
    readonly mode: ViewMode
    readonly diffBase: DiffBase
    readonly diffRevision?: string
    readonly scrollTop: number
  }[]
}

function restoreTabs(root: HostPath): { tabs: readonly ViewerTab[]; activeId?: string } {
  try {
    const raw = localStorage.getItem(storageKey(root))
    if (!raw) return { tabs: [] }
    const parsed: unknown = JSON.parse(raw)
    if (!isStoredTabs(parsed)) return { tabs: [] }
    const stored = parsed
    const tabs = stored.tabs.flatMap((item): ViewerTab[] => {
      if (
        item.hostId !== root.hostId ||
        typeof item.path !== 'string' ||
        !insideRoot(item.path, root.path) ||
        !isViewMode(item.mode) ||
        !isDiffBase(item.diffBase)
      ) {
        return []
      }
      const path = hostPath(asHostId(item.hostId), item.path)
      return [
        {
          id: tabId(path),
          path,
          pinned: Boolean(item.pinned),
          mode: item.mode,
          diffBase: item.diffBase,
          diffRevision:
            typeof item.diffRevision === 'string' ? item.diffRevision : undefined,
          scrollTop: Number.isFinite(item.scrollTop) ? item.scrollTop : 0,
          loading: true,
          dirty: false,
          conflict: false,
        },
      ]
    })
    const activeId = tabs.some((tab) => tab.id === stored.activeId)
      ? stored.activeId
      : tabs[0]?.id
    return { tabs, activeId }
  } catch {
    return { tabs: [] }
  }
}

function persistTabs(
  root: HostPath,
  tabs: readonly ViewerTab[],
  activeId?: string,
): void {
  const stored: StoredTabs = {
    version: TAB_STORAGE_VERSION,
    activeId,
    tabs: tabs.map((tab) => ({
      hostId: tab.path.hostId,
      path: tab.path.path,
      pinned: tab.pinned,
      mode: tab.mode,
      diffBase: tab.diffBase,
      diffRevision: tab.diffRevision,
      scrollTop: tab.scrollTop,
    })),
  }
  localStorage.setItem(storageKey(root), JSON.stringify(stored))
}

function storageKey(root: HostPath): string {
  return `hvir:tabs:${root.hostId}:${root.path}`
}

function tabId(path: HostPath): string {
  return `${path.hostId}:${path.path}`
}

function insideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
}

function nextMode(mode: ViewMode): ViewMode {
  if (mode === 'rendered') return 'source'
  if (mode === 'source') return 'diff'
  return 'rendered'
}

function isViewMode(value: unknown): value is ViewMode {
  return value === 'rendered' || value === 'source' || value === 'diff'
}

function isDiffBase(value: unknown): value is DiffBase {
  return value === 'working-tree' || value === 'head' || value === 'branch-point'
}

function isStoredTabs(value: unknown): value is StoredTabs {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { version?: unknown; tabs?: unknown }
  return candidate.version === TAB_STORAGE_VERSION && Array.isArray(candidate.tabs)
}

function reorderTabs(
  tabs: readonly ViewerTab[],
  draggedId: string,
  targetId: string,
): readonly ViewerTab[] {
  const from = tabs.findIndex((tab) => tab.id === draggedId)
  const to = tabs.findIndex((tab) => tab.id === targetId)
  if (from < 0 || to < 0 || from === to) return tabs
  const next = [...tabs]
  const [dragged] = next.splice(from, 1)
  if (!dragged) return tabs
  next.splice(to, 0, dragged)
  return next
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
