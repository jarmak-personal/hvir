import {
  asHostId,
  hostPath,
  type DiffBase,
  type HostPath,
  type ViewMode,
} from '../../../shared'
import type { ViewerPaneId, ViewerTab } from './tab-state'

const TAB_STORAGE_VERSION = 1
export const DRAFT_STORAGE_CHARACTER_LIMIT = 2 * 1024 * 1024

interface StoredTabs {
  readonly version: number
  readonly activeId?: string
  readonly tabs: readonly StoredTab[]
}

interface StoredTab {
  readonly hostId: string
  readonly path: string
  readonly pane?: ViewerPaneId
  readonly pinned: boolean
  readonly mode: ViewMode
  readonly diffBase: DiffBase
  readonly diffRevision?: string
  readonly scrollTop: number
  readonly draft?: string
  readonly mtimeMs?: number
}

export interface RestoredViewerTabs {
  readonly tabs: readonly ViewerTab[]
  readonly activeId?: string
}

export interface WorkspaceLayout {
  readonly version: 1
  readonly treeWidth?: number
  readonly terminalHeight?: number
  readonly viewerSplit?: boolean
  readonly viewerPrimaryWidth?: number
}

export type WorkspaceLayoutUpdate = Omit<Partial<WorkspaceLayout>, 'version'>

export function decodeViewerTabs(root: HostPath, raw: string | null): RestoredViewerTabs {
  try {
    if (!raw) return { tabs: [] }
    const parsed: unknown = JSON.parse(raw)
    if (!isStoredTabs(parsed)) return { tabs: [] }
    const tabs = parsed.tabs.flatMap((item): ViewerTab[] => {
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
          id: viewerTabId(path),
          path,
          pane: item.pane === 'secondary' ? 'secondary' : 'primary',
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
    const activeId = tabs.some((tab) => tab.id === parsed.activeId)
      ? parsed.activeId
      : tabs[0]?.id
    return { tabs, activeId }
  } catch {
    return { tabs: [] }
  }
}

export function encodeViewerTabs(
  tabs: readonly ViewerTab[],
  activeId?: string,
  includeDrafts = true,
): string {
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
        pane: tab.pane,
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
  return JSON.stringify(stored)
}

export function restoreViewerTabs(root: HostPath): RestoredViewerTabs {
  try {
    return decodeViewerTabs(root, localStorage.getItem(viewerStorageKey(root)))
  } catch {
    return { tabs: [] }
  }
}

export function persistViewerTabs(
  root: HostPath,
  tabs: readonly ViewerTab[],
  activeId?: string,
  includeDrafts = true,
): void {
  try {
    localStorage.setItem(
      viewerStorageKey(root),
      encodeViewerTabs(tabs, activeId, includeDrafts),
    )
  } catch {
    // Storage is a recovery aid, never a reason to make the live viewer fail.
  }
}

export function restoreWorkspaceLayout(root: HostPath): WorkspaceLayout {
  try {
    return decodeWorkspaceLayout(
      localStorage.getItem(`hvir:layout:${root.hostId}:${root.path}`),
    )
  } catch {
    return { version: 1 }
  }
}

export function persistWorkspaceLayout(
  root: HostPath,
  update: WorkspaceLayoutUpdate,
): void {
  try {
    localStorage.setItem(
      `hvir:layout:${root.hostId}:${root.path}`,
      JSON.stringify({ ...restoreWorkspaceLayout(root), ...update }),
    )
  } catch {
    // Layout recovery is best effort and never blocks the live workbench.
  }
}

export function decodeWorkspaceLayout(raw: string | null): WorkspaceLayout {
  try {
    const parsed: unknown = JSON.parse(raw ?? 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { version: 1 }
    }
    const layout = parsed as Record<string, unknown>
    return {
      version: 1,
      treeWidth: finiteNumber(layout['treeWidth']),
      terminalHeight: finiteNumber(layout['terminalHeight']),
      viewerSplit:
        typeof layout['viewerSplit'] === 'boolean' ? layout['viewerSplit'] : undefined,
      viewerPrimaryWidth: finiteNumber(layout['viewerPrimaryWidth']),
    }
  } catch {
    return { version: 1 }
  }
}

export function viewerStorageKey(root: HostPath): string {
  return `hvir:tabs:${root.hostId}:${root.path}`
}

export function viewerTabId(path: HostPath): string {
  return `${path.hostId}:${path.path}`
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function insideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? '/' : `${root}/`)
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
