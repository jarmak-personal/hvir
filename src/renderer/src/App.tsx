import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

import {
  asHostId,
  defaultViewMode,
  hostPath,
  hostPathEquals,
  type DiffBase,
  type HostPath,
  type ViewMode,
  type WatchEvent,
} from '../../shared'
import { PaneResizer } from './layout/PaneResizer'
import { TerminalView } from './terminal/TerminalView'
import { FileTree } from './tree/FileTree'
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
            tab.id === id ? { ...tab, file: undefined, loading: false, error } : tab,
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
    return () => {
      cancelled = true
      if (watchRefreshTimer !== undefined) window.clearTimeout(watchRefreshTimer)
      void stopWatch()
    }
  }, [])

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

  const openFile = (path: HostPath, pinned: boolean): void => {
    const id = tabId(path)
    setTabs((current) => {
      const existing = current.find((tab) => tab.id === id)
      if (existing) {
        return pinned
          ? current.map((tab) => (tab.id === id ? { ...tab, pinned: true } : tab))
          : current
      }
      const created: ViewerTab = {
        id,
        path,
        pinned,
        mode: defaultViewMode(path),
        diffBase: 'head',
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
    <main className="workbench" ref={workbenchRef}>
      <FileTree
        root={root}
        refreshVersion={watchVersion}
        selected={activeTab?.path}
        onOpen={openFile}
      />
      <PaneResizer
        orientation="vertical"
        className="tree-resizer"
        label="Resize file tree"
        onDrag={(clientX) => {
          const left = workbenchRef.current?.getBoundingClientRect().left ?? 0
          setTreeWidth(clientX - left)
        }}
        onNudge={(delta) => {
          const current = workbenchRef.current?.querySelector<HTMLElement>('.tree-panel')
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
  )
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
