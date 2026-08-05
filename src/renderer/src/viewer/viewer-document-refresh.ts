import { hostPathEquals, type HostPath } from '../../../shared'
import type { ViewerTab } from './tab-state'

export interface Action {
  readonly type: 'document-refresh'
  readonly id: string
  readonly update:
    | { readonly type: 'watch-event'; readonly path: HostPath }
    | { readonly type: 'rendered-dependencies'; readonly paths: readonly HostPath[] }
}

export function apply(tab: ViewerTab, update: Action['update']): ViewerTab {
  return update.type === 'watch-event'
    ? refreshViewerTab(tab, update.path)
    : setRenderedDependencies(tab, update.paths)
}

function refreshViewerTab(tab: ViewerTab, path: HostPath): ViewerTab {
  const version = (tab.refresh?.version ?? 0) + 1
  const relevant = tab.refresh?.changes.filter(
    (change) =>
      !hostPathEquals(change.path, path) &&
      (hostPathEquals(change.path, tab.path) ||
        tab.renderedDependencies?.some((dependency) =>
          hostPathEquals(dependency, change.path),
        )),
  )
  return {
    ...tab,
    refresh: {
      version,
      changes: [...(relevant ?? []), { version, path }],
    },
  }
}

function setRenderedDependencies(tab: ViewerTab, paths: readonly HostPath[]): ViewerTab {
  const unique = new Map(paths.map((path) => [hostPathKey(path), path]))
  const renderedDependencies = [...unique.values()]
  if (samePaths(tab.renderedDependencies ?? [], renderedDependencies)) return tab
  const refresh = tab.refresh
    ? {
        ...tab.refresh,
        changes: tab.refresh.changes.filter(
          (change) =>
            hostPathEquals(change.path, tab.path) ||
            renderedDependencies.some((dependency) =>
              hostPathEquals(dependency, change.path),
            ),
        ),
      }
    : undefined
  return {
    ...tab,
    renderedDependencies,
    refresh,
  }
}

function samePaths(left: readonly HostPath[], right: readonly HostPath[]): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => {
      const candidate = right[index]
      return candidate !== undefined && hostPathEquals(path, candidate)
    })
  )
}

function hostPathKey(path: HostPath): string {
  return `${path.hostId}:${path.path}`
}
