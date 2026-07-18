import {
  defaultViewMode,
  type DiffBase,
  type FileOpenContext,
  type HostPath,
  type ReadFileResponse,
  type ViewMode,
  type WriteFileResponse,
} from '../../../shared'
import type { ViewerNavigationPosition, ViewerPaneId, ViewerTab } from './tab-state'
import { viewerTabId } from './viewer-workspace-persistence'

export interface ViewerWorkspaceModel {
  readonly root?: HostPath
  readonly generation: number
  readonly tabs: readonly ViewerTab[]
  readonly activeId?: string
  readonly activePane: ViewerPaneId
  readonly activeByPane: Readonly<Record<ViewerPaneId, string | undefined>>
  readonly split: boolean
  readonly restored: boolean
  readonly readGenerations: Readonly<Record<string, number>>
}

export interface ViewerOpenRequest {
  readonly path: HostPath
  readonly pinned: boolean
  readonly context?: FileOpenContext
  readonly diffBase?: DiffBase
  readonly diffRevision?: string
  readonly position?: ViewerNavigationPosition
}

export type ViewerWorkspaceAction =
  | {
      readonly type: 'workspace-activated'
      readonly root: HostPath
      readonly generation: number
      readonly tabs: readonly ViewerTab[]
      readonly activeId?: string
      readonly split: boolean
    }
  | { readonly type: 'open'; readonly request: ViewerOpenRequest }
  | { readonly type: 'activate'; readonly id: string; readonly pane?: ViewerPaneId }
  | { readonly type: 'focus-pane'; readonly pane: ViewerPaneId; readonly id?: string }
  | { readonly type: 'close'; readonly id: string }
  | { readonly type: 'pin'; readonly id: string }
  | { readonly type: 'set-mode'; readonly id: string; readonly mode: ViewMode }
  | { readonly type: 'cycle-active-mode' }
  | { readonly type: 'set-diff-base'; readonly id: string; readonly diffBase: DiffBase }
  | { readonly type: 'set-content'; readonly id: string; readonly content: string }
  | { readonly type: 'set-scroll'; readonly id: string; readonly scrollTop: number }
  | { readonly type: 'navigation-handled'; readonly id: string; readonly serial: number }
  | { readonly type: 'reload-requested'; readonly id: string }
  | { readonly type: 'watch-conflict'; readonly id: string }
  | {
      readonly type: 'read-started'
      readonly id: string
      readonly workspaceGeneration: number
      readonly readGeneration: number
    }
  | {
      readonly type: 'read-succeeded'
      readonly id: string
      readonly workspaceGeneration: number
      readonly readGeneration: number
      readonly file: ReadFileResponse
    }
  | {
      readonly type: 'read-failed'
      readonly id: string
      readonly workspaceGeneration: number
      readonly readGeneration: number
      readonly error: string
    }
  | { readonly type: 'save-started'; readonly id: string }
  | {
      readonly type: 'save-succeeded'
      readonly id: string
      readonly savedContent: string
      readonly written: WriteFileResponse
    }
  | { readonly type: 'save-failed'; readonly id: string; readonly error: string }
  | { readonly type: 'reorder'; readonly draggedId: string; readonly targetId: string }
  | { readonly type: 'move'; readonly id: string; readonly pane: ViewerPaneId }
  | { readonly type: 'split-opened' }
  | { readonly type: 'split-closed' }

export const initialViewerWorkspaceModel: ViewerWorkspaceModel = {
  generation: 0,
  tabs: [],
  activePane: 'primary',
  activeByPane: { primary: undefined, secondary: undefined },
  split: false,
  restored: false,
  readGenerations: {},
}

export function viewerWorkspaceReducer(
  model: ViewerWorkspaceModel,
  action: ViewerWorkspaceAction,
): ViewerWorkspaceModel {
  switch (action.type) {
    case 'workspace-activated': {
      const active = action.tabs.find((tab) => tab.id === action.activeId)
      const activePane = active?.pane ?? 'primary'
      return {
        root: action.root,
        generation: action.generation,
        tabs: action.tabs,
        activeId: active?.id ?? action.tabs[0]?.id,
        activePane,
        activeByPane: activeIds(action.tabs, active?.id),
        split: action.split || action.tabs.some((tab) => tab.pane === 'secondary'),
        restored: true,
        readGenerations: {},
      }
    }
    case 'open': {
      if (!model.root || action.request.path.hostId !== model.root.hostId) return model
      const id = viewerTabId(action.request.path)
      const existing = model.tabs.find((tab) => tab.id === id)
      const pane = existing?.pane ?? (model.split ? model.activePane : 'primary')
      const context = action.request.context ?? 'file-tree'
      const tabs = existing
        ? updateTab(model.tabs, id, (tab) => ({
            ...tab,
            pinned: action.request.pinned || tab.pinned,
            mode: action.request.position
              ? 'source'
              : context === 'file-tree'
                ? tab.mode
                : defaultViewMode(action.request.path, context),
            diffBase:
              context === 'git' ? (action.request.diffBase ?? 'head') : tab.diffBase,
            diffRevision: context === 'git' ? action.request.diffRevision : undefined,
            navigation: action.request.position,
          }))
        : openNewTab(model.tabs, {
            id,
            path: action.request.path,
            pane,
            pinned: action.request.pinned,
            mode: action.request.position
              ? 'source'
              : defaultViewMode(action.request.path, context),
            diffBase: action.request.diffBase ?? 'head',
            diffRevision: action.request.diffRevision,
            scrollTop: 0,
            navigation: action.request.position,
            loading: true,
            dirty: false,
            conflict: false,
          })
      return activate({ ...model, tabs }, id, pane)
    }
    case 'activate': {
      const tab = model.tabs.find((candidate) => candidate.id === action.id)
      if (!tab) return model
      return activate(model, tab.id, action.pane ?? tab.pane)
    }
    case 'focus-pane': {
      const activeId = action.id ?? model.activeByPane[action.pane]
      return {
        ...model,
        activePane: action.pane,
        ...(activeId ? { activeId } : {}),
        activeByPane: action.id
          ? { ...model.activeByPane, [action.pane]: action.id }
          : model.activeByPane,
      }
    }
    case 'close':
      return closeTab(model, action.id)
    case 'pin':
      return mapTab(model, action.id, (tab) => ({ ...tab, pinned: true }))
    case 'set-mode':
      return mapTab(model, action.id, (tab) => ({ ...tab, mode: action.mode }))
    case 'cycle-active-mode':
      return model.activeId
        ? mapTab(model, model.activeId, (tab) => ({
            ...tab,
            mode: nextMode(tab.mode),
          }))
        : model
    case 'set-diff-base':
      return mapTab(model, action.id, (tab) => ({
        ...tab,
        diffBase: action.diffBase,
      }))
    case 'set-content':
      return mapTab(model, action.id, (tab) =>
        tab.file
          ? {
              ...tab,
              pinned: true,
              dirty: true,
              file: {
                ...tab.file,
                content: action.content,
                size: new TextEncoder().encode(action.content).byteLength,
              },
            }
          : tab,
      )
    case 'set-scroll':
      return mapTab(model, action.id, (tab) => ({
        ...tab,
        scrollTop: action.scrollTop,
      }))
    case 'navigation-handled':
      return mapTab(model, action.id, (tab) =>
        tab.navigation?.serial === action.serial
          ? { ...tab, navigation: undefined }
          : tab,
      )
    case 'reload-requested':
      return mapTab(model, action.id, (tab) => ({
        ...tab,
        dirty: false,
        conflict: false,
      }))
    case 'watch-conflict':
      return mapTab(model, action.id, (tab) => ({ ...tab, conflict: true }))
    case 'read-started':
      if (action.workspaceGeneration !== model.generation) return model
      return {
        ...mapTab(model, action.id, (tab) => ({
          ...tab,
          loading: !tab.file,
          error: undefined,
        })),
        readGenerations: {
          ...model.readGenerations,
          [action.id]: action.readGeneration,
        },
      }
    case 'read-succeeded':
      if (!currentRead(model, action)) return model
      return mapTab(model, action.id, (tab) =>
        tab.dirty
          ? tab
          : {
              ...tab,
              file: action.file,
              loading: false,
              error: undefined,
              conflict: false,
            },
      )
    case 'read-failed':
      if (!currentRead(model, action)) return model
      return mapTab(model, action.id, (tab) =>
        tab.dirty
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
            : { ...tab, file: undefined, loading: false, error: action.error },
      )
    case 'save-started':
      return mapTab(model, action.id, (tab) => ({ ...tab, error: undefined }))
    case 'save-succeeded':
      return mapTab(model, action.id, (tab) => {
        if (!tab.file) return tab
        const unchangedSinceSave = tab.file.content === action.savedContent
        return {
          ...tab,
          error: undefined,
          dirty: unchangedSinceSave ? false : tab.dirty,
          conflict: unchangedSinceSave ? false : tab.conflict,
          file: {
            ...tab.file,
            size: unchangedSinceSave ? action.written.size : tab.file.size,
            mtimeMs: action.written.mtimeMs,
          },
        }
      })
    case 'save-failed':
      return mapTab(model, action.id, (tab) => ({
        ...tab,
        error: action.error,
        conflict: tab.conflict || /file changed/i.test(action.error),
      }))
    case 'reorder':
      return {
        ...model,
        tabs: reorderTabs(model.tabs, action.draggedId, action.targetId),
      }
    case 'move':
      return moveTab(model, action.id, action.pane)
    case 'split-opened':
      return { ...model, split: true }
    case 'split-closed': {
      const tabs = model.tabs.map((tab) =>
        tab.pane === 'secondary' ? { ...tab, pane: 'primary' as const } : tab,
      )
      return {
        ...model,
        tabs,
        split: false,
        activePane: 'primary',
        activeByPane: {
          primary: model.activeId ?? model.activeByPane.primary,
          secondary: undefined,
        },
      }
    }
  }
}

function activate(
  model: ViewerWorkspaceModel,
  id: string,
  pane: ViewerPaneId,
): ViewerWorkspaceModel {
  return {
    ...model,
    activeId: id,
    activePane: pane,
    activeByPane: { ...model.activeByPane, [pane]: id },
  }
}

function activeIds(
  tabs: readonly ViewerTab[],
  activeId?: string,
): Readonly<Record<ViewerPaneId, string | undefined>> {
  const active = tabs.find((tab) => tab.id === activeId)
  return {
    primary:
      active?.pane === 'primary'
        ? active.id
        : tabs.find((tab) => tab.pane === 'primary')?.id,
    secondary:
      active?.pane === 'secondary'
        ? active.id
        : tabs.find((tab) => tab.pane === 'secondary')?.id,
  }
}

function openNewTab(
  tabs: readonly ViewerTab[],
  created: ViewerTab,
): readonly ViewerTab[] {
  const previewIndex = tabs.findIndex(
    (tab) => tab.pane === created.pane && !tab.pinned && !tab.dirty,
  )
  if (previewIndex < 0) return [...tabs, created]
  const next = [...tabs]
  next[previewIndex] = created
  return next
}

function closeTab(model: ViewerWorkspaceModel, id: string): ViewerWorkspaceModel {
  const index = model.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return model
  const closing = model.tabs[index]
  if (!closing) return model
  const tabs = model.tabs.filter((tab) => tab.id !== id)
  const nextInPane =
    tabs.slice(index).find((tab) => tab.pane === closing.pane) ??
    [...tabs].reverse().find((tab) => tab.pane === closing.pane)
  const nextActive =
    model.activeId === id
      ? (nextInPane ?? tabs[Math.min(index, tabs.length - 1)])
      : undefined
  const closesLastSecondary =
    closing.pane === 'secondary' && !tabs.some((tab) => tab.pane === 'secondary')
  const activeByPane = {
    ...model.activeByPane,
    ...(model.activeByPane[closing.pane] === id
      ? { [closing.pane]: nextInPane?.id }
      : {}),
    ...(nextActive ? { [nextActive.pane]: nextActive.id } : {}),
    ...(closesLastSecondary ? { secondary: undefined } : {}),
  }
  return {
    ...model,
    tabs,
    activeId: nextActive?.id ?? (model.activeId === id ? undefined : model.activeId),
    activePane: closesLastSecondary ? 'primary' : (nextActive?.pane ?? model.activePane),
    activeByPane,
    split: closesLastSecondary ? false : model.split,
  }
}

function moveTab(
  model: ViewerWorkspaceModel,
  id: string,
  pane: ViewerPaneId,
): ViewerWorkspaceModel {
  const moving = model.tabs.find((tab) => tab.id === id)
  if (!moving || moving.pane === pane) return model
  const tabs = updateTab(model.tabs, id, (tab) => ({ ...tab, pane }))
  return {
    ...model,
    tabs,
    activeId: id,
    activePane: pane,
    activeByPane: {
      ...model.activeByPane,
      [moving.pane]:
        model.activeByPane[moving.pane] === id
          ? tabs.find((tab) => tab.pane === moving.pane)?.id
          : model.activeByPane[moving.pane],
      [pane]: id,
    },
    split: pane === 'secondary' ? true : model.split,
  }
}

function mapTab(
  model: ViewerWorkspaceModel,
  id: string,
  update: (tab: ViewerTab) => ViewerTab,
): ViewerWorkspaceModel {
  const tabs = updateTab(model.tabs, id, update)
  return tabs === model.tabs ? model : { ...model, tabs }
}

function updateTab(
  tabs: readonly ViewerTab[],
  id: string,
  update: (tab: ViewerTab) => ViewerTab,
): readonly ViewerTab[] {
  const index = tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return tabs
  const next = [...tabs]
  const current = next[index]
  if (!current) return tabs
  next[index] = update(current)
  return next
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

function currentRead(
  model: ViewerWorkspaceModel,
  action: {
    readonly id: string
    readonly workspaceGeneration: number
    readonly readGeneration: number
  },
): boolean {
  return (
    action.workspaceGeneration === model.generation &&
    model.readGenerations[action.id] === action.readGeneration
  )
}

function nextMode(mode: ViewMode): ViewMode {
  if (mode === 'rendered') return 'source'
  if (mode === 'source') return 'diff'
  return 'rendered'
}
