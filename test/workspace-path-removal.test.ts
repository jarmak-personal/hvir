// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared'
import { workspacePathRemoval } from '../src/renderer/src/viewer/workspace-path-removal'
import { RetainedViewerWorkspaceCache } from '../src/renderer/src/viewer/retained-viewer-workspace-cache'
import { initialViewerWorkspaceModel } from '../src/renderer/src/viewer/viewer-workspace-model'
import {
  persistViewerTabs,
  restoreViewerTabs,
  viewerStorageKey,
} from '../src/renderer/src/viewer/viewer-workspace-persistence'
import type { ViewerTab } from '../src/renderer/src/viewer/tab-state'
import { initialViewerPosition } from '../src/renderer/src/viewer/viewer-position'

afterEach(() => localStorage.clear())
const a = localPath('/a'),
  b = localPath('/b'),
  target = localPath('/a/skill')
function tab(path: string, dirty = false): ViewerTab {
  return {
    id: path,
    path: localPath(path),
    pane: 'primary',
    pinned: true,
    mode: 'source',
    diffBase: 'head',
    position: initialViewerPosition('source'),
    loading: false,
    dirty,
    conflict: false,
    file: { path: localPath(path), content: 'draft', size: 5, mtimeMs: 1, binary: false },
  }
}
it('reviews inactive retained dirty buffers and retires only clean target tabs, leaving active Files B intact', () => {
  const retained = new RetainedViewerWorkspaceCache()
  const dirty = tab('/a/skill/SKILL.md', true),
    clean = tab('/a/skill/extra.md')
  retained.set(viewerStorageKey(a), {
    tabs: [dirty, clean, tab('/a/other.md')],
    activeId: dirty.id,
  })
  const model = { ...initialViewerWorkspaceModel, root: b, tabs: [tab('/b/SKILL.md')] }
  const active = { reviewPathRemoval: vi.fn(), closeCleanPath: vi.fn() }
  const removal = workspacePathRemoval(() => model, retained, active)
  expect(removal.reviewWorkspacePathRemoval(a, target)).toEqual({
    openCount: 2,
    dirtyPaths: [dirty.path],
  })
  expect(removal.closeWorkspaceCleanPath(a, target)).toEqual({
    openCount: 2,
    dirtyPaths: [dirty.path],
    closedCount: 1,
  })
  expect(retained.peek(viewerStorageKey(a))?.tabs.map((entry) => entry.id)).toEqual([
    dirty.id,
    '/a/other.md',
  ])
  expect(restoreViewerTabs(a).tabs.map((entry) => entry.path.path)).toEqual([
    dirty.path.path,
    '/a/other.md',
  ])
  expect(model.tabs[0]!.path.path).toBe('/b/SKILL.md')
  expect(active.closeCleanPath).not.toHaveBeenCalled()
  expect(active.reviewPathRemoval).not.toHaveBeenCalled()
})
it('checks persisted inactive drafts when no warm workspace remains', () => {
  const dirty = tab('/a/skill/SKILL.md', true)
  persistViewerTabs(a, [dirty], dirty.id)
  const removal = workspacePathRemoval(
    () => ({ ...initialViewerWorkspaceModel, root: b }),
    new RetainedViewerWorkspaceCache(),
    { reviewPathRemoval: vi.fn(), closeCleanPath: vi.fn() },
  )
  expect(removal.reviewWorkspacePathRemoval(a, target).dirtyPaths).toEqual([dirty.path])
  expect(removal.closeWorkspaceCleanPath(a, target).closedCount).toBe(0)
})
it('delegates the active exact workspace and refuses a mismatched target', () => {
  const active = {
    reviewPathRemoval: vi.fn(() => ({ openCount: 0, dirtyPaths: [] })),
    closeCleanPath: vi.fn(() => ({ openCount: 0, dirtyPaths: [], closedCount: 0 })),
  }
  const removal = workspacePathRemoval(
    () => ({ ...initialViewerWorkspaceModel, root: a }),
    new RetainedViewerWorkspaceCache(),
    active,
  )
  removal.reviewWorkspacePathRemoval(a, target)
  removal.closeWorkspaceCleanPath(a, target)
  expect(active.reviewPathRemoval).toHaveBeenCalledWith(target)
  expect(active.closeCleanPath).toHaveBeenCalledWith(target)
  expect(() => removal.reviewWorkspacePathRemoval(b, target)).toThrow(/escapes/)
})
