import { describe, expect, it } from 'vitest'

import { RetainedViewerWorkspaceCache } from '../src/renderer/src/viewer/retained-viewer-workspace-cache'
import type { ViewerTab } from '../src/renderer/src/viewer/tab-state'
import type { RestoredViewerTabs } from '../src/renderer/src/viewer/viewer-workspace-persistence'
import { localPath } from '../src/shared'

describe('retained viewer workspace cache', () => {
  it('keeps clean bodies below and at the file-count budget, then evicts the oldest', () => {
    const cache = new RetainedViewerWorkspaceCache({
      workspaces: 10,
      cleanFiles: 2,
      cleanBytes: 100,
    })
    cache.set('one', workspace(cleanTab('/one', 1)))
    expect(cache.stats().cleanFiles).toBe(1)
    cache.set('two', workspace(cleanTab('/two', 1)))
    expect(cache.stats().cleanFiles).toBe(2)
    cache.set('three', workspace(cleanTab('/three', 1)))

    expect(cache.stats().cleanFiles).toBe(2)
    expect(cache.take('one')?.tabs[0]).toMatchObject({
      path: localPath('/one'),
      file: undefined,
      loading: true,
    })
  })

  it('keeps clean bodies below and at the byte budget, then evicts the oldest', () => {
    const cache = new RetainedViewerWorkspaceCache({
      workspaces: 10,
      cleanFiles: 10,
      cleanBytes: 10,
    })
    cache.set('one', workspace(cleanTab('/one', 4)))
    expect(cache.stats().cleanBytes).toBe(4)
    cache.set('two', workspace(cleanTab('/two', 6)))
    expect(cache.stats().cleanBytes).toBe(10)
    cache.set('three', workspace(cleanTab('/three', 1)))

    expect(cache.stats().cleanBytes).toBe(7)
    expect(cache.take('one')?.tabs[0]?.file).toBeUndefined()
  })

  it('keeps workspace metadata below and at its bound, then removes the oldest clean entry', () => {
    const cache = new RetainedViewerWorkspaceCache({
      workspaces: 2,
      cleanFiles: 10,
      cleanBytes: 100,
    })
    cache.set('one', workspace(cleanTab('/one', 1)))
    expect(cache.stats().workspaces).toBe(1)
    cache.set('two', workspace(cleanTab('/two', 1)))
    expect(cache.stats().workspaces).toBe(2)
    cache.set('three', workspace(cleanTab('/three', 1)))

    expect(cache.stats().workspaces).toBe(2)
    expect(cache.take('one')).toBeUndefined()
  })

  it('never discards dirty drafts even above every clean-cache budget', () => {
    const cache = new RetainedViewerWorkspaceCache({
      workspaces: 0,
      cleanFiles: 0,
      cleanBytes: 0,
    })
    const dirty = dirtyTab('/draft', 'minor edit')
    cache.set('dirty', workspace(dirty))

    expect(cache.stats()).toEqual({ workspaces: 1, cleanFiles: 0, cleanBytes: 0 })
    expect(cache.take('dirty')?.tabs[0]).toMatchObject({
      dirty: true,
      file: { content: 'minor edit' },
    })
  })

  it('removes a returned workspace from warm retention', () => {
    const cache = new RetainedViewerWorkspaceCache({
      workspaces: 2,
      cleanFiles: 2,
      cleanBytes: 10,
    })
    cache.set('one', workspace(cleanTab('/one', 1)))

    expect(cache.take('one')).toBeDefined()
    expect(cache.take('one')).toBeUndefined()
    expect(cache.stats().workspaces).toBe(0)
  })
})

function workspace(...tabs: readonly ViewerTab[]): RestoredViewerTabs {
  return { tabs, activeId: tabs[0]?.id }
}

function cleanTab(path: string, size: number): ViewerTab {
  const qualified = localPath(path)
  return {
    id: `local:${path}`,
    path: qualified,
    pane: 'primary',
    pinned: true,
    mode: 'source',
    diffBase: 'head',
    position: { mode: 'source', line: 1, scrollTop: 0 },
    file: {
      path: qualified,
      content: 'x'.repeat(size),
      size,
      mtimeMs: 1,
      binary: false,
    },
    loading: false,
    dirty: false,
    conflict: false,
  }
}

function dirtyTab(path: string, content: string): ViewerTab {
  return {
    ...cleanTab(path, content.length),
    dirty: true,
    file: {
      ...cleanTab(path, content.length).file!,
      content,
    },
  }
}
