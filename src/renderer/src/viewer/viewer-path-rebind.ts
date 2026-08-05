import {
  containsHostPath,
  hostPathEquals,
  joinHostPath,
  type HostPath,
} from '../../../shared'
import type { ViewerPaneId, ViewerTab } from './tab-state'
import type { ViewerWorkspaceModel } from './viewer-workspace-model'
import { viewerTabId } from './viewer-workspace-persistence'

export interface ViewerPathRebindCapability {
  readonly canRebindPath: (source: HostPath, destination: HostPath) => boolean
  readonly rebindPath: (source: HostPath, destination: HostPath) => boolean
}

export function canRebindViewerPath(
  model: ViewerWorkspaceModel,
  source: HostPath,
  destination: HostPath,
): boolean {
  const affected = new Set(
    model.tabs
      .filter((tab) => containsHostPath(source, tab.path))
      .map((tab) => viewerTabId(reboundHostPath(tab.path, source, destination))),
  )
  return !model.tabs.some(
    (tab) => !containsHostPath(source, tab.path) && affected.has(tab.id) && tab.dirty,
  )
}

export function reboundHostPath(
  path: HostPath,
  source: HostPath,
  destination: HostPath,
): HostPath {
  if (!containsHostPath(source, path)) return path
  if (hostPathEquals(path, source)) return destination
  const suffix = path.path.slice(source.path === '/' ? 1 : source.path.length + 1)
  return joinHostPath(destination, ...suffix.split('/'))
}

export function rebindViewerPath(
  model: ViewerWorkspaceModel,
  source: HostPath,
  destination: HostPath,
): ViewerWorkspaceModel {
  if (
    !model.root ||
    source.hostId !== model.root.hostId ||
    destination.hostId !== model.root.hostId ||
    !containsHostPath(model.root, source) ||
    !containsHostPath(model.root, destination) ||
    hostPathEquals(source, destination) ||
    !canRebindViewerPath(model, source, destination)
  ) {
    return model
  }
  const affected = model.tabs.filter((tab) => containsHostPath(source, tab.path))
  if (affected.length === 0) return model
  const idMap = new Map(
    affected.map((tab) => {
      const path = reboundHostPath(tab.path, source, destination)
      return [tab.id, { id: viewerTabId(path), path }] as const
    }),
  )
  const movingIds = new Set(idMap.keys())
  const destinationIds = new Set([...idMap.values()].map((entry) => entry.id))
  const tabs = model.tabs
    .filter((tab) => movingIds.has(tab.id) || !destinationIds.has(tab.id) || tab.dirty)
    .map((tab) => {
      const rebound = idMap.get(tab.id)
      if (!rebound) return tab
      return {
        ...tab,
        id: rebound.id,
        path: rebound.path,
        file: tab.file ? { ...tab.file, path: rebound.path } : tab.file,
      }
    })
  const readGenerations = { ...model.readGenerations }
  for (const [oldId, rebound] of idMap) {
    const generation =
      Math.max(readGenerations[oldId] ?? 0, readGenerations[rebound.id] ?? 0) + 1
    delete readGenerations[oldId]
    readGenerations[rebound.id] = generation
  }
  const remapId = (id: string | undefined): string | undefined =>
    id ? (idMap.get(id)?.id ?? id) : undefined
  const activeId = remapId(model.activeId)
  const active = tabs.find((tab) => tab.id === activeId)
  const remappedByPane = {
    primary: remapId(model.activeByPane.primary),
    secondary: remapId(model.activeByPane.secondary),
  }
  return {
    ...model,
    tabs,
    activeId: active?.id,
    activePane: active?.pane ?? model.activePane,
    activeByPane: activeIds(tabs, active?.id, remappedByPane),
    readGenerations,
  }
}

function activeIds(
  tabs: readonly ViewerTab[],
  activeId?: string,
  retained: Readonly<Record<ViewerPaneId, string | undefined>> = {
    primary: undefined,
    secondary: undefined,
  },
): Readonly<Record<ViewerPaneId, string | undefined>> {
  const active = tabs.find((tab) => tab.id === activeId)
  const retainedIn = (pane: ViewerPaneId): string | undefined =>
    tabs.find((tab) => tab.id === retained[pane] && tab.pane === pane)?.id
  return {
    primary:
      retainedIn('primary') ??
      (active?.pane === 'primary'
        ? active.id
        : tabs.find((tab) => tab.pane === 'primary')?.id),
    secondary:
      retainedIn('secondary') ??
      (active?.pane === 'secondary'
        ? active.id
        : tabs.find((tab) => tab.pane === 'secondary')?.id),
  }
}
