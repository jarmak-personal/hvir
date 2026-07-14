import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react'

import {
  asHostId,
  basenameHostPath,
  defaultViewMode,
  hostPath,
  hostPathEquals,
  unwrapOperation,
  type DiffBase,
  type FileOpenContext,
  type GitChanges,
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
import { TerminalWorkspace } from './terminal/TerminalWorkspace'
import { FileTree, SessionBar } from './tree/FileTree'
import { DirectoryTree } from './tree/DirectoryTree'
import { isGitIgnoreRulePath } from './tree/git-ignore-refresh'
import { GitPanel } from './git/GitPanel'
import { GitGraphView } from './git/GitGraphView'
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
const DRAFT_STORAGE_CHARACTER_LIMIT = 2 * 1024 * 1024

export function App(): ReactElement {
  const workbenchRef = useRef<HTMLElement>(null)
  const tabsRef = useRef<readonly ViewerTab[]>([])
  const activeIdRef = useRef<string | undefined>(undefined)
  const gitGraphActiveRef = useRef(false)
  const fileReadGenerations = useRef(new Map<string, number>())
  const discardDirtyOnUnload = useRef(false)
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
  const [ignoredRefreshVersion, setIgnoredRefreshVersion] = useState(0)
  const [contentVersion, setContentVersion] = useState(0)
  const [gitVersion, setGitVersion] = useState(0)
  const [tabs, setTabs] = useState<readonly ViewerTab[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [gitGraphOpen, setGitGraphOpen] = useState(false)
  const [gitGraphActive, setGitGraphActive] = useState(false)
  const [gitGraphRequest, setGitGraphRequest] = useState<{
    readonly serial: number
    readonly hash?: string
  }>({ serial: 0 })
  const [restored, setRestored] = useState(false)
  const [railMode, setRailMode] = useState<'files' | 'git'>('files')
  const [gitChanges, setGitChanges] = useState<GitChanges>()
  const [connectionState, setConnectionState] = useState<HostConnectionState>('connected')
  const [watchTier, setWatchTier] = useState<HostWatchTier>('native')
  const [hosts, setHosts] = useState<readonly ProjectHostOption[]>([])
  const [showAddProject, setShowAddProject] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [sessionError, setSessionError] = useState<string>()
  const [sshPrompts, setSshPrompts] = useState<readonly SshPromptRequest[]>([])
  tabsRef.current = tabs
  activeIdRef.current = activeId
  gitGraphActiveRef.current = gitGraphActive
  const changedCount = gitChanges?.workingTree.length ?? 0

  const loadFile = useCallback((path: HostPath): void => {
    const id = tabId(path)
    const generation = (fileReadGenerations.current.get(id) ?? 0) + 1
    fileReadGenerations.current.set(id, generation)
    setTabs((current) =>
      current.map((tab) =>
        tab.id === id ? { ...tab, loading: !tab.file, error: undefined } : tab,
      ),
    )
    void window.hvir
      .invoke('fs:read', { path })
      .then(unwrapOperation)
      .then(
        (file) => {
          if (fileReadGenerations.current.get(id) !== generation) return
          setTabs((current) =>
            current.map((tab) =>
              tab.id === id
                ? tab.dirty
                  ? tab
                  : {
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
          if (fileReadGenerations.current.get(id) !== generation) return
          const error = reason instanceof Error ? reason.message : String(reason)
          setTabs((current) =>
            current.map((tab) =>
              tab.id === id
                ? tab.dirty
                  ? tab
                  : tab.diffRevision
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
    let ignoredRefreshTimer: number | undefined
    let contentRefreshTimer: number | undefined
    let gitRefreshTimer: number | undefined
    void window.hvir.invoke('project:root', undefined).then(
      ({ root: projectRoot, connectionState: state, watchTier: tier }) => {
        if (!cancelled) {
          setRoot(projectRoot)
          setConnectionState(state)
          setWatchTier(tier)
        }
      },
      (error: unknown) => {
        if (!cancelled)
          setRootError(error instanceof Error ? error.message : String(error))
      },
    )
    const stopWatch = window.hvir.on('project:watch', (event) => {
      const gitMetadataEvent =
        event.synthetic !== 'refresh' && /(^|\/)\.git(?:\/|$)/.test(event.path.path)
      const ignoreRulesEvent =
        event.synthetic !== 'refresh' && isGitIgnoreRulePath(event.path.path)
      if (gitMetadataEvent && gitRefreshTimer === undefined) {
        gitRefreshTimer = window.setTimeout(() => {
          gitRefreshTimer = undefined
          setGitVersion((version) => version + 1)
        }, 250)
      }
      if (ignoreRulesEvent && ignoredRefreshTimer === undefined) {
        ignoredRefreshTimer = window.setTimeout(() => {
          ignoredRefreshTimer = undefined
          setIgnoredRefreshVersion((version) => version + 1)
        }, 250)
      }
      if (watchRefreshTimer === undefined) {
        watchRefreshTimer = window.setTimeout(() => {
          watchRefreshTimer = undefined
          setWatchVersion((version) => version + 1)
        }, 250)
      }
      if (event.synthetic !== 'refresh' && contentRefreshTimer === undefined) {
        contentRefreshTimer = window.setTimeout(() => {
          contentRefreshTimer = undefined
          setContentVersion((version) => version + 1)
        }, 250)
      }
      watchHandler.current(event)
    })
    const stopState = window.hvir.on('project:state', (state) => {
      setConnectionState(state.connectionState)
      setWatchTier(state.watchTier)
      if (state.connectionState === 'connected') setSessionError(undefined)
      if (state.connectionState === 'disconnected') {
        setSshPrompts((current) =>
          current.filter((prompt) => prompt.hostId !== state.root.hostId),
        )
      }
    })
    const stopPrompt = window.hvir.on('ssh:prompt', (prompt) => {
      setSshPrompts((current) =>
        current.some((candidate) => candidate.id === prompt.id)
          ? current
          : [...current, prompt],
      )
    })
    const stopPromptCancel = window.hvir.on('ssh:prompt-cancel', ({ hostId }) => {
      setSshPrompts((current) => current.filter((prompt) => prompt.hostId !== hostId))
    })
    return () => {
      cancelled = true
      if (watchRefreshTimer !== undefined) window.clearTimeout(watchRefreshTimer)
      if (ignoredRefreshTimer !== undefined) window.clearTimeout(ignoredRefreshTimer)
      if (contentRefreshTimer !== undefined) window.clearTimeout(contentRefreshTimer)
      if (gitRefreshTimer !== undefined) window.clearTimeout(gitRefreshTimer)
      void stopWatch()
      void stopState()
      void stopPrompt()
      void stopPromptCancel()
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
      if (state) {
        persistTabs(state.root, state.tabs, state.activeId, !discardDirtyOnUnload.current)
      }
    }
    const protectDirtyBuffers = (event: BeforeUnloadEvent): void => {
      const dirtyCount = tabsRef.current.filter((tab) => tab.dirty).length
      if (
        dirtyCount === 0 ||
        window.confirm(
          `${dirtyCount} tab${dirtyCount === 1 ? ' has' : 's have'} unsaved changes. Close hvir and discard them?`,
        )
      ) {
        discardDirtyOnUnload.current = dirtyCount > 0
        return
      }
      discardDirtyOnUnload.current = false
      event.preventDefault()
      // Electron silently cancels a close when beforeunload sets returnValue;
      // the explicit confirmation above supplies the UI it does not provide.
      event.returnValue = 'Unsaved changes'
    }
    window.addEventListener('pagehide', flushPersistence)
    window.addEventListener('beforeunload', protectDirtyBuffers)
    return () => {
      window.removeEventListener('pagehide', flushPersistence)
      window.removeEventListener('beforeunload', protectDirtyBuffers)
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
      if (gitGraphActiveRef.current) return
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
    setGitGraphActive(false)
    const id = tabId(path)
    const existing = tabsRef.current.find((tab) => tab.id === id)
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
                diffRevision: context === 'git' ? diffRevision : undefined,
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
    // Reopening a dirty tab is navigation, not a reload. Its in-memory buffer
    // is authoritative until the user saves or explicitly chooses reload.
    if (!existing?.dirty) loadFile(path)
  }

  const closeTab = (id: string): void => {
    const closing = tabsRef.current.find((tab) => tab.id === id)
    if (
      closing?.dirty &&
      !window.confirm(`Close ${basenameHostPath(closing.path)} without saving?`)
    ) {
      return
    }
    fileReadGenerations.current.set(id, (fileReadGenerations.current.get(id) ?? 0) + 1)
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
    updateTab(tab.id, (candidate) => ({ ...candidate, error: undefined }))
    void window.hvir
      .invoke('fs:write', {
        path: tab.path,
        content: savedContent,
        ...(tab.file.mtimeMs > 0 ? { expectedMtimeMs: tab.file.mtimeMs } : {}),
      })
      .then(unwrapOperation)
      .then(
        (written) => {
          setTabs((current) =>
            current.map((candidate) => {
              if (candidate.id !== tab.id || !candidate.file) return candidate
              const unchangedSinceSave = candidate.file.content === savedContent
              return {
                ...candidate,
                error: undefined,
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
              candidate.id === tab.id
                ? {
                    ...candidate,
                    error,
                    conflict: candidate.conflict || /file changed/i.test(error),
                  }
                : candidate,
            ),
          )
        },
      )
  }

  const activeTab = tabs.find((tab) => tab.id === activeId)

  const openGitGraph = (hash?: string): void => {
    setGitGraphOpen(true)
    setGitGraphActive(true)
    setGitGraphRequest((current) => ({
      serial: current.serial + 1,
      ...(hash ? { hash } : {}),
    }))
  }

  const changeSession = (): void => {
    const dirtyCount = tabsRef.current.filter((tab) => tab.dirty).length
    if (
      dirtyCount > 0 &&
      !window.confirm(
        `${dirtyCount} tab${dirtyCount === 1 ? ' has' : 's have'} unsaved changes. Switching sessions will discard them. Continue?`,
      )
    ) {
      return
    }
    setShowAddProject(true)
  }

  const disconnectSession = async (): Promise<void> => {
    if (!root || root.hostId === 'local') return
    setSessionBusy(true)
    setSessionError(undefined)
    try {
      const host = unwrapOperation(
        await window.hvir.invoke('project:disconnect-host', {
          hostId: root.hostId,
        }),
      )
      setSshPrompts((current) =>
        current.filter((prompt) => prompt.hostId !== root.hostId),
      )
      setConnectionState(host.connectionState)
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSessionBusy(false)
    }
  }

  const reconnectSession = async (): Promise<void> => {
    if (!root || root.hostId === 'local') return
    setSessionBusy(true)
    setSessionError(undefined)
    try {
      const connected = unwrapOperation(
        await window.hvir.invoke('project:connect-host', {
          hostId: root.hostId,
        }),
      )
      setConnectionState(connected.host.connectionState)
      setWatchTier(connected.host.watchTier)
      for (const tab of tabsRef.current) {
        if (!tab.dirty) loadFile(tab.path)
      }
    } catch (reason) {
      setSessionError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSessionBusy(false)
    }
  }

  const setTreeWidth = (width: number): void => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const terminalRailWidth =
      workbench.querySelector<HTMLElement>('.terminal-rail')?.getBoundingClientRect()
        .width ?? 0
    const max = Math.max(
      TREE_MIN_WIDTH,
      Math.min(
        TREE_MAX_WIDTH,
        workbench.clientWidth - DIVIDER_SIZE - MAIN_MIN_WIDTH - terminalRailWidth,
      ),
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
        <aside className="tree-panel" aria-label="Project rail">
          <SessionBar
            label={root.hostId === 'local' ? 'Local' : `ssh:${root.hostId}`}
            remote={root.hostId !== 'local'}
            connectionState={connectionState}
            watchTier={watchTier}
            onChange={changeSession}
            onDisconnect={() => void disconnectSession()}
            onReconnect={() => void reconnectSession()}
            busy={sessionBusy}
            error={sessionError}
          />
          <nav className="rail-nav" aria-label="Project views">
            <button
              type="button"
              className={railMode === 'files' ? 'active' : ''}
              aria-current={railMode === 'files' ? 'page' : undefined}
              onClick={() => setRailMode('files')}
            >
              Files
            </button>
            <button
              type="button"
              className={railMode === 'git' ? 'active' : ''}
              aria-current={railMode === 'git' ? 'page' : undefined}
              onClick={() => setRailMode('git')}
            >
              Git{changedCount > 0 ? ` ${changedCount}` : ''}
            </button>
            <button type="button" disabled title="Harness view lands in Phase 6">
              Harness
            </button>
          </nav>
          <div className="rail-content">
            <FileTree
              key={`files:${root.hostId}:${root.path}`}
              root={root}
              refreshVersion={watchVersion}
              ignoredRefreshVersion={ignoredRefreshVersion}
              changedFiles={gitChanges?.workingTree}
              selected={activeTab?.path}
              onOpen={openFile}
              connected={connectionState === 'connected'}
              hidden={railMode !== 'files'}
            />
            <GitPanel
              key={`git:${root.hostId}:${root.path}`}
              root={root}
              refreshVersion={contentVersion}
              historyRefreshVersion={gitVersion}
              onChanges={setGitChanges}
              onOpenChange={(path, base, untracked) =>
                openFile(path, true, untracked ? 'git-untracked' : 'git', base)
              }
              onOpenHistory={(path, revision) =>
                openFile(path, true, 'git', 'head', revision)
              }
              onOpenGraph={openGitGraph}
              connectionState={connectionState}
              hidden={railMode !== 'git'}
              historyPaused={gitGraphActive}
            />
          </div>
        </aside>
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
            activeId={gitGraphActive ? undefined : activeId}
            onActivate={(id) => {
              setActiveId(id)
              setGitGraphActive(false)
            }}
            onClose={closeTab}
            onPin={(id) =>
              setTabs((current) =>
                current.map((tab) => (tab.id === id ? { ...tab, pinned: true } : tab)),
              )
            }
            onReorder={(draggedId, targetId) => {
              setTabs((current) => reorderTabs(current, draggedId, targetId))
            }}
            graphOpen={gitGraphOpen}
            graphActive={gitGraphActive}
            onActivateGraph={() => setGitGraphActive(true)}
            onCloseGraph={() => {
              setGitGraphOpen(false)
              setGitGraphActive(false)
            }}
          />
          {gitGraphOpen ? (
            <div className="workspace-view" hidden={!gitGraphActive}>
              <GitGraphView
                root={root}
                refreshVersion={gitVersion}
                connectionState={connectionState}
                requestedHash={gitGraphRequest.hash}
                requestSerial={gitGraphRequest.serial}
                onOpen={(path, base, revision) =>
                  openFile(path, true, 'git', base, revision)
                }
              />
            </div>
          ) : null}
          <div className="workspace-view" hidden={gitGraphActive}>
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
              refreshVersion={contentVersion}
            />
          </div>
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
        <TerminalWorkspace
          key={`terminals:${root.hostId}:${root.path}`}
          cwd={root}
          connectionState={connectionState}
        />
      </main>
      {showAddProject ? (
        <SessionDialog
          hosts={hosts}
          currentRoot={root}
          suspended={sshPrompts.length > 0}
          onCancel={() => setShowAddProject(false)}
          onConnect={connectProjectHost}
          onBrowse={browseProjectHost}
          onDisconnect={disconnectProjectHost}
          onOpen={openProjectHost}
          onOpened={(state) => {
            persistTabs(root, tabsRef.current, activeIdRef.current, false)
            setRestored(false)
            setRoot(state.root)
            setConnectionState(state.connectionState)
            setWatchTier(state.watchTier)
            setTabs([])
            setActiveId(undefined)
            setGitGraphOpen(false)
            setGitGraphActive(false)
            setGitChanges(undefined)
            setSessionError(undefined)
            setShowAddProject(false)
          }}
        />
      ) : null}
      {sshPrompts[0] ? (
        <SshPromptDialog
          key={sshPrompts[0].id}
          prompt={sshPrompts[0]}
          onAnswer={(answers) => {
            const answered = sshPrompts[0]
            if (!answered) return
            void window.hvir.invoke('ssh:prompt-response', {
              id: answered.id,
              answers,
            })
            setSshPrompts((current) =>
              current.filter((candidate) => candidate.id !== answered.id),
            )
          }}
        />
      ) : null}
    </>
  )
}

function SessionDialog({
  hosts,
  currentRoot,
  suspended,
  onCancel,
  onConnect,
  onBrowse,
  onDisconnect,
  onOpen,
  onOpened,
}: {
  readonly hosts: readonly ProjectHostOption[]
  readonly currentRoot: HostPath
  readonly suspended: boolean
  readonly onCancel: () => void
  readonly onConnect: (hostId: string) => Promise<ConnectedHost>
  readonly onBrowse: (hostId: string, path: string) => Promise<BrowseHostResponse>
  readonly onDisconnect: (hostId: string) => Promise<ProjectHostOption>
  readonly onOpen: (hostId: string, path: string) => Promise<ProjectState>
  readonly onOpened: (state: ProjectState) => void
}): ReactElement {
  const dialogRef = useRef<HTMLElement>(null)
  const [stage, setStage] = useState<'host' | 'folder'>('host')
  const [hostId, setHostId] = useState(
    hosts.some((host) => host.hostId === currentRoot.hostId)
      ? currentRoot.hostId
      : (hosts[0]?.hostId ?? 'local'),
  )
  const [connected, setConnected] = useState<ConnectedHost>()
  const [pathInput, setPathInput] = useState('')
  const [selectedPath, setSelectedPath] = useState<string>()
  const [revealedPath, setRevealedPath] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const selectedHost = hosts.find((host) => host.hostId === hostId)

  const releaseUnopenedHost = async (): Promise<void> => {
    if (connected?.host.kind === 'ssh' && connected.host.hostId !== currentRoot.hostId) {
      await onDisconnect(connected.host.hostId)
    }
  }

  const cancel = async (): Promise<void> => {
    setBusy(true)
    try {
      await releaseUnopenedHost()
    } finally {
      onCancel()
    }
  }

  const back = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await releaseUnopenedHost()
      setStage('host')
      setConnected(undefined)
      setPathInput('')
      setSelectedPath(undefined)
      setRevealedPath(undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const selectPath = async (targetPath: string): Promise<void> => {
    if (!connected) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await onBrowse(connected.host.hostId, targetPath)
      setPathInput(result.path.path)
      setSelectedPath(result.path.path)
      setRevealedPath(result.path.path)
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
      setStage('folder')
      const listing = await onBrowse(result.host.hostId, result.suggestedPath)
      setPathInput(listing.path.path)
      setSelectedPath(listing.path.path)
      setRevealedPath(listing.path.path)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const open = async (): Promise<void> => {
    if (!connected || !selectedPath) return
    setBusy(true)
    setError(undefined)
    try {
      const state = await onOpen(connected.host.hostId, selectedPath)
      rememberFolder(connected.host.hostId, state.root.path)
      onOpened(state)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }

  const connectedHostId = connected?.host.hostId
  const loadPickerEntries = useCallback(
    async (directory: HostPath) => {
      if (!connectedHostId) return []
      return (await onBrowse(connectedHostId, directory.path)).directories
    },
    [connectedHostId, onBrowse],
  )

  useModalKeyboard(dialogRef, () => void cancel(), !busy, !suspended)

  return (
    <div className="modal-backdrop">
      <section
        className="project-dialog session-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal={suspended ? undefined : true}
        aria-hidden={suspended || undefined}
        inert={suspended || undefined}
        aria-labelledby="session-dialog-title"
        tabIndex={-1}
      >
        <h2 id="session-dialog-title">
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
                void selectPath(pathInput)
              }}
            >
              <input
                aria-label="Folder path"
                autoFocus
                value={pathInput}
                onChange={(event) => {
                  setPathInput(event.target.value)
                  setSelectedPath(undefined)
                }}
              />
              <button type="submit" disabled={busy}>
                Go
              </button>
            </form>
            {connected ? (
              <div className="recent-folders">
                {recentFolders(connected.host.hostId).map((folder) => (
                  <button
                    type="button"
                    key={folder}
                    onClick={() => void selectPath(folder)}
                  >
                    {folder}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="folder-browser" aria-label="Folders">
              <div className="folder-selection">
                <small>Selected folder</small>
                <code>{selectedPath ?? 'Choose a folder from the tree'}</code>
              </div>
              {connectedHostId ? (
                <DirectoryTree
                  root={hostPath(asHostId(connectedHostId), '/')}
                  rootLabel="/"
                  loadEntries={loadPickerEntries}
                  selected={
                    selectedPath
                      ? hostPath(asHostId(connectedHostId), selectedPath)
                      : undefined
                  }
                  expandedPath={
                    revealedPath
                      ? hostPath(asHostId(connectedHostId), revealedPath)
                      : undefined
                  }
                  showFiles={false}
                  onSelectDirectory={(directory) => {
                    setPathInput(directory.path)
                    setSelectedPath(directory.path)
                    setRevealedPath(directory.path)
                  }}
                />
              ) : null}
            </div>
          </>
        )}
        <div className="dialog-actions">
          {stage === 'folder' ? (
            <button type="button" disabled={busy} onClick={() => void back()}>
              Back
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={() => void cancel()}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || (stage === 'folder' && !selectedPath)}
            onClick={() => void (stage === 'host' ? connect() : open())}
          >
            {busy
              ? 'Working…'
              : stage === 'host'
                ? selectedHost?.kind === 'local' ||
                  selectedHost?.connectionState === 'connected'
                  ? 'Choose folder'
                  : 'Connect'
                : 'Open selected folder'}
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
  const dialogRef = useRef<HTMLFormElement>(null)
  const [answers, setAnswers] = useState(() => prompt.prompts.map(() => ''))
  const [verifiedChangedKey, setVerifiedChangedKey] = useState(false)
  const changedKey = prompt.kind === 'host-key-changed'
  useModalKeyboard(dialogRef, () => onAnswer(undefined))
  return (
    <div className="modal-backdrop">
      <form
        className="project-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-prompt-title"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault()
          onAnswer(prompt.kind === 'host-key' || changedKey ? ['yes'] : answers)
        }}
      >
        <h2 id="ssh-prompt-title">{prompt.title}</h2>
        {prompt.instructions ? <p>{prompt.instructions}</p> : null}
        {(prompt.kind === 'host-key' || changedKey) && prompt.fingerprint ? (
          <div className={changedKey ? 'ssh-host-key-changed' : undefined}>
            {changedKey && prompt.previousFingerprint ? (
              <label>
                Saved fingerprint
                <code className="ssh-host-fingerprint">{prompt.previousFingerprint}</code>
              </label>
            ) : null}
            <label>
              {changedKey ? 'Presented fingerprint' : 'Fingerprint'}
              <code className="ssh-host-fingerprint">{prompt.fingerprint}</code>
            </label>
            {changedKey ? (
              <label className="ssh-host-key-confirm">
                <input
                  type="checkbox"
                  checked={verifiedChangedKey}
                  onChange={(event) => setVerifiedChangedKey(event.target.checked)}
                />
                I verified this host key through a trusted channel.
              </label>
            ) : null}
          </div>
        ) : (
          prompt.prompts.map((item, index) => (
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
          ))
        )}
        <div className="dialog-actions">
          <button type="button" onClick={() => onAnswer(undefined)}>
            Cancel
          </button>
          <button
            type="submit"
            autoFocus={prompt.kind === 'host-key'}
            disabled={changedKey && !verifiedChangedKey}
          >
            {changedKey
              ? 'Replace Saved Key'
              : prompt.kind === 'host-key'
                ? 'Trust Host'
                : 'Continue'}
          </button>
        </div>
      </form>
    </div>
  )
}

function useModalKeyboard(
  dialogRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  dismissEnabled = true,
  active = true,
): void {
  const dismissRef = useRef(onDismiss)
  const enabledRef = useRef(dismissEnabled)
  const activeRef = useRef(active)
  dismissRef.current = onDismiss
  enabledRef.current = dismissEnabled
  activeRef.current = active

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previousFocus = document.activeElement
    const focusableSelector =
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    const focusFirst = window.requestAnimationFrame(() => {
      if (!activeRef.current) return
      const preferred = dialog.querySelector<HTMLElement>('[autofocus]')
      const first = dialog.querySelector<HTMLElement>(focusableSelector)
      ;(preferred ?? first ?? dialog).focus()
    })
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!activeRef.current) return
      if (event.key === 'Escape' && enabledRef.current) {
        event.preventDefault()
        dismissRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(focusableSelector),
      ].filter((element) => element.offsetParent !== null)
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const current = focusable.indexOf(document.activeElement as HTMLElement)
      const next = event.shiftKey
        ? current <= 0
          ? focusable.at(-1)
          : focusable[current - 1]
        : current < 0 || current === focusable.length - 1
          ? focusable[0]
          : focusable[current + 1]
      event.preventDefault()
      next?.focus()
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.cancelAnimationFrame(focusFirst)
      document.removeEventListener('keydown', handleKeyDown, true)
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus()
      }
    }
  }, [dialogRef])
}

function connectProjectHost(hostId: string): Promise<ConnectedHost> {
  return window.hvir.invoke('project:connect-host', { hostId }).then(unwrapOperation)
}

function browseProjectHost(hostId: string, path: string): Promise<BrowseHostResponse> {
  return window.hvir.invoke('project:browse-host', { hostId, path }).then(unwrapOperation)
}

function disconnectProjectHost(hostId: string): Promise<ProjectHostOption> {
  return window.hvir.invoke('project:disconnect-host', { hostId }).then(unwrapOperation)
}

function openProjectHost(hostId: string, path: string): Promise<ProjectState> {
  return window.hvir.invoke('project:open', { hostId, path }).then(unwrapOperation)
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
    readonly draft?: string
    readonly mtimeMs?: number
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
      const draft =
        typeof item.draft === 'string' &&
        item.draft.length <= DRAFT_STORAGE_CHARACTER_LIMIT
          ? item.draft
          : undefined
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
          file:
            draft === undefined
              ? undefined
              : {
                  path,
                  content: draft,
                  size: new TextEncoder().encode(draft).byteLength,
                  mtimeMs:
                    typeof item.mtimeMs === 'number' &&
                    Number.isFinite(item.mtimeMs) &&
                    item.mtimeMs > 0
                      ? item.mtimeMs
                      : 0,
                  binary: false,
                },
          loading: draft === undefined,
          dirty: draft !== undefined,
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
  includeDrafts = true,
): void {
  let remainingDraftCharacters = includeDrafts ? DRAFT_STORAGE_CHARACTER_LIMIT : 0
  const stored: StoredTabs = {
    version: TAB_STORAGE_VERSION,
    activeId,
    tabs: tabs.map((tab) => {
      const draft = tab.dirty ? tab.file?.content : undefined
      const draftCharacters = draft?.length ?? 0
      const storedDraft = draftCharacters <= remainingDraftCharacters ? draft : undefined
      remainingDraftCharacters -= storedDraft === undefined ? 0 : draftCharacters
      return {
        hostId: tab.path.hostId,
        path: tab.path.path,
        pinned: tab.pinned,
        mode: tab.mode,
        diffBase: tab.diffBase,
        diffRevision: tab.diffRevision,
        scrollTop: tab.scrollTop,
        draft: storedDraft,
        mtimeMs: storedDraft === undefined ? undefined : tab.file?.mtimeMs,
      }
    }),
  }
  try {
    localStorage.setItem(storageKey(root), JSON.stringify(stored))
  } catch {
    // Storage is a recovery aid, never a reason to make the live viewer fail.
  }
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
