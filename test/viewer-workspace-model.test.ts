import { describe, expect, it } from 'vitest'

import {
  initialViewerWorkspaceModel,
  viewerWorkspaceReducer,
  type ViewerWorkspaceAction,
  type ViewerWorkspaceModel,
} from '../src/renderer/src/viewer/viewer-workspace-model'
import { selectPaneActiveTab } from '../src/renderer/src/viewer/viewer-workspace-selectors'
import { canRebindViewerPath } from '../src/renderer/src/viewer/viewer-path-rebind'
import {
  decodeViewerTabs,
  encodeViewerTabs,
  viewerTabId,
} from '../src/renderer/src/viewer/viewer-workspace-persistence'
import { asHostId, hostPath, localPath, type ReadFileResponse } from '../src/shared'

describe('viewer workspace model', () => {
  it('applies preview, pin, split, move, and close policy without UI mounts', () => {
    let model = activate('/repo', 1)
    model = reduce(model, open('/repo/a.ts', false))
    model = reduce(model, open('/repo/b.ts', false))
    expect(model.tabs.map((tab) => tab.path.path)).toEqual(['/repo/b.ts'])

    const b = viewerTabId(localPath('/repo/b.ts'))
    model = reduce(model, { type: 'pin', id: b })
    model = reduce(model, open('/repo/a.ts', false))
    const a = viewerTabId(localPath('/repo/a.ts'))
    expect(model.tabs.map((tab) => tab.path.path)).toEqual(['/repo/b.ts', '/repo/a.ts'])
    expect(model.activeId).toBe(a)

    model = reduce(model, { type: 'move', id: a, pane: 'secondary' })
    expect(model.split).toBe(true)
    expect(selectPaneActiveTab(model, 'secondary')?.id).toBe(a)
    model = reduce(model, { type: 'close', id: a })
    expect(model.split).toBe(false)
    expect(model.activeId).toBe(b)
  })

  it('rejects stale reads from older tab and workspace generations', () => {
    const a = viewerTabId(localPath('/repo/a.ts'))
    let model = reduce(activate('/repo', 1), open('/repo/a.ts', true))
    model = reduce(model, readStarted(a, 1, 1))
    model = reduce(model, readStarted(a, 1, 2))
    const staleTabRead = reduce(model, readSucceeded(a, 1, 1, 'stale'))
    expect(staleTabRead).toBe(model)

    model = reduce(model, readSucceeded(a, 1, 2, 'current'))
    expect(model.tabs[0]?.file?.content).toBe('current')
    const nextWorkspace = activate('/other', 2)
    const staleWorkspaceRead = reduce(
      nextWorkspace,
      readSucceeded(a, 1, 2, 'late workspace'),
    )
    expect(staleWorkspaceRead).toBe(nextWorkspace)
  })

  it('preserves dirty content, marks watch conflicts, and clears only matching saves', () => {
    const id = viewerTabId(localPath('/repo/a.ts'))
    let model = reduce(activate('/repo', 1), open('/repo/a.ts', true))
    model = reduce(model, readStarted(id, 1, 1))
    model = reduce(model, readSucceeded(id, 1, 1, 'before'))
    model = reduce(model, { type: 'set-content', id, content: 'draft' })
    model = reduce(model, { type: 'watch-conflict', id })
    expect(model.tabs[0]).toMatchObject({ dirty: true, conflict: true })

    model = reduce(model, {
      type: 'save-succeeded',
      id,
      savedContent: 'older draft',
      written: { path: localPath('/repo/a.ts'), size: 11, mtimeMs: 2 },
    })
    expect(model.tabs[0]).toMatchObject({ dirty: true, conflict: true })
    model = reduce(model, {
      type: 'save-succeeded',
      id,
      savedContent: 'draft',
      written: { path: localPath('/repo/a.ts'), size: 5, mtimeMs: 3 },
    })
    expect(model.tabs[0]).toMatchObject({ dirty: false, conflict: false })
  })

  it('rebinds directory descendants in place and rejects an old-path read completion', () => {
    const source = localPath('/repo/dir')
    const destination = localPath('/repo/renamed')
    const dirtyPath = localPath('/repo/dir/a.ts')
    const cleanPath = localPath('/repo/dir/nested/b.ts')
    const dirtyId = viewerTabId(dirtyPath)
    const cleanId = viewerTabId(cleanPath)
    let model = reduce(activate('/repo', 1), open(dirtyPath.path, true))
    model = reduce(model, readStarted(dirtyId, 1, 1))
    model = reduce(model, {
      ...readSucceeded(dirtyId, 1, 1, 'original'),
      file: file(dirtyPath, 'original'),
    })
    model = reduce(model, { type: 'set-content', id: dirtyId, content: 'draft' })
    model = reduce(model, {
      type: 'set-position',
      id: dirtyId,
      position: { mode: 'source', line: 27, scrollTop: 320 },
    })
    model = reduce(model, { type: 'move', id: dirtyId, pane: 'secondary' })
    model = reduce(model, open(cleanPath.path, true))
    model = reduce(model, readStarted(cleanId, 1, 3))

    model = reduce(model, { type: 'rebind-path', source, destination })

    const reboundDirtyId = viewerTabId(localPath('/repo/renamed/a.ts'))
    const reboundCleanId = viewerTabId(localPath('/repo/renamed/nested/b.ts'))
    const reboundDirty = model.tabs.find((tab) => tab.id === reboundDirtyId)
    expect(reboundDirty).toMatchObject({
      id: reboundDirtyId,
      path: localPath('/repo/renamed/a.ts'),
      pane: 'secondary',
      dirty: true,
      position: { mode: 'source', line: 27, scrollTop: 320 },
    })
    expect(reboundDirty?.file).toMatchObject({
      path: localPath('/repo/renamed/a.ts'),
      content: 'draft',
    })
    expect(model.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: reboundCleanId,
          path: localPath('/repo/renamed/nested/b.ts'),
        }),
      ]),
    )
    expect(model.activeId).toBe(reboundCleanId)
    expect(model.activeByPane.secondary).toBe(reboundCleanId)
    expect(model.readGenerations).not.toHaveProperty(dirtyId)
    expect(model.readGenerations[reboundCleanId]).toBe(4)

    const stale = reduce(model, {
      ...readSucceeded(cleanId, 1, 3, 'late old path'),
      file: file(cleanPath, 'late old path'),
    })
    expect(stale).toBe(model)
  })

  it('refuses to discard a dirty destination buffer during path rebinding', () => {
    const source = localPath('/repo/source.ts')
    const destination = localPath('/repo/destination.ts')
    const sourceId = viewerTabId(source)
    const destinationId = viewerTabId(destination)
    let model = reduce(activate('/repo', 1), open(source.path, true))
    model = reduce(model, readStarted(sourceId, 1, 1))
    model = reduce(model, readSucceeded(sourceId, 1, 1, 'source'))
    model = reduce(model, open(destination.path, true))
    model = reduce(model, readStarted(destinationId, 1, 1))
    model = reduce(model, {
      ...readSucceeded(destinationId, 1, 1, 'destination'),
      file: file(destination, 'destination'),
    })
    model = reduce(model, {
      type: 'set-content',
      id: destinationId,
      content: 'unsaved destination',
    })

    expect(canRebindViewerPath(model, source, destination)).toBe(false)
    expect(reduce(model, { type: 'rebind-path', source, destination })).toBe(model)
    expect(model.tabs.find((tab) => tab.id === destinationId)).toMatchObject({
      dirty: true,
      file: { content: 'unsaved destination' },
    })
  })

  it('remaps the remembered non-focused pane tab without selecting its first tab', () => {
    const firstSecondary = localPath('/repo/first.ts')
    const affected = localPath('/repo/directory/affected.ts')
    const primary = localPath('/repo/primary.ts')
    let model = reduce(activate('/repo', 1), open(firstSecondary.path, true))
    model = reduce(model, {
      type: 'move',
      id: viewerTabId(firstSecondary),
      pane: 'secondary',
    })
    model = reduce(model, { type: 'focus-pane', pane: 'primary' })
    model = reduce(model, open(affected.path, true))
    model = reduce(model, {
      type: 'move',
      id: viewerTabId(affected),
      pane: 'secondary',
    })
    model = reduce(model, { type: 'focus-pane', pane: 'primary' })
    model = reduce(model, open(primary.path, true))

    model = reduce(model, {
      type: 'rebind-path',
      source: localPath('/repo/directory'),
      destination: localPath('/repo/renamed'),
    })

    expect(model.activeId).toBe(viewerTabId(primary))
    expect(model.activeByPane.secondary).toBe(
      viewerTabId(localPath('/repo/renamed/affected.ts')),
    )
    expect(model.activeByPane.secondary).not.toBe(viewerTabId(firstSecondary))
  })
})

describe('viewer workspace persistence', () => {
  it('round-trips host-qualified tabs, panes, selection, and safe drafts', () => {
    const root = hostPath(asHostId('ssh:ship'), '/repo')
    const path = hostPath(root.hostId, '/repo/src/a.ts')
    const id = viewerTabId(path)
    const raw = encodeViewerTabs(
      [
        {
          id,
          path,
          pane: 'secondary',
          pinned: true,
          mode: 'source',
          diffBase: 'head',
          position: { mode: 'source', line: 3, scrollTop: 42 },
          file: file(path, 'draft'),
          loading: false,
          dirty: true,
          conflict: true,
        },
      ],
      id,
    )
    const restored = decodeViewerTabs(root, raw)

    expect(restored.activeId).toBe(id)
    expect(restored.tabs[0]).toMatchObject({
      id,
      path,
      pane: 'secondary',
      pinned: true,
      position: { mode: 'source', line: 3, scrollTop: 42 },
      dirty: true,
      conflict: false,
    })
    expect(restored.tabs[0]?.file?.content).toBe('draft')
  })

  it('rejects foreign-host and outside-root records and can omit drafts', () => {
    const root = localPath('/repo')
    const foreign = JSON.stringify({
      version: 1,
      activeId: 'foreign',
      tabs: [
        {
          hostId: 'ssh:ship',
          path: '/repo/a.ts',
          pinned: true,
          mode: 'source',
          diffBase: 'head',
          position: { mode: 'source', line: 1, scrollTop: 0 },
        },
        {
          hostId: 'local',
          path: '/outside/a.ts',
          pinned: true,
          mode: 'source',
          diffBase: 'head',
          position: { mode: 'source', line: 1, scrollTop: 0 },
        },
      ],
    })
    expect(decodeViewerTabs(root, foreign).tabs).toEqual([])

    const path = localPath('/repo/a.ts')
    const withoutDrafts = encodeViewerTabs(
      [
        {
          id: viewerTabId(path),
          path,
          pane: 'primary',
          pinned: true,
          mode: 'source',
          diffBase: 'head',
          position: { mode: 'source', line: 1, scrollTop: 0 },
          file: file(path, 'discard me'),
          loading: false,
          dirty: true,
          conflict: false,
        },
      ],
      undefined,
      false,
    )
    expect(decodeViewerTabs(root, withoutDrafts).tabs[0]).toMatchObject({
      dirty: false,
      loading: true,
      file: undefined,
    })
  })

  it('migrates a version 1 pixel offset into the tab position', () => {
    const root = localPath('/repo')
    const restored = decodeViewerTabs(
      root,
      JSON.stringify({
        version: 1,
        tabs: [
          {
            hostId: 'local',
            path: '/repo/a.ts',
            pinned: true,
            mode: 'source',
            diffBase: 'head',
            scrollTop: 88,
          },
        ],
      }),
    )

    expect(restored.tabs[0]?.position).toEqual({
      mode: 'source',
      line: 1,
      scrollTop: 88,
    })
  })

  it('keeps one logical position through every direct mode transition', () => {
    const id = viewerTabId(localPath('/repo/readme.md'))
    const modes = ['rendered', 'source', 'diff'] as const
    for (const from of modes) {
      for (const to of modes) {
        if (from === to) continue
        let model = reduce(activate('/repo', 1), open('/repo/readme.md', true))
        model = reduce(model, { type: 'set-mode', id, mode: from })
        model = reduce(model, {
          type: 'set-position',
          id,
          position: { mode: from, line: 37, scrollTop: 640 },
        })
        model = reduce(model, { type: 'set-mode', id, mode: to })

        expect(model.tabs[0]).toMatchObject({
          mode: to,
          position: { mode: from, line: 37, scrollTop: 640 },
        })
      }
    }
  })

  it('forgets a document position when its tab closes', () => {
    const id = viewerTabId(localPath('/repo/a.ts'))
    let model = reduce(activate('/repo', 1), open('/repo/a.ts', true))
    model = reduce(model, {
      type: 'set-position',
      id,
      position: { mode: 'source', line: 19, scrollTop: 320 },
    })
    model = reduce(model, { type: 'close', id })
    model = reduce(model, open('/repo/a.ts', true))

    expect(model.tabs[0]?.position).toEqual({ mode: 'source', line: 1, scrollTop: 0 })
  })
})

function activate(root: string, generation: number): ViewerWorkspaceModel {
  return reduce(initialViewerWorkspaceModel, {
    type: 'workspace-activated',
    root: localPath(root),
    generation,
    tabs: [],
    split: false,
  })
}

function open(path: string, pinned: boolean): ViewerWorkspaceAction {
  return { type: 'open', request: { path: localPath(path), pinned } }
}

function readStarted(
  id: string,
  workspaceGeneration: number,
  readGeneration: number,
): ViewerWorkspaceAction {
  return {
    type: 'read-started',
    id,
    workspaceGeneration,
    readGeneration,
  }
}

function readSucceeded(
  id: string,
  workspaceGeneration: number,
  readGeneration: number,
  content: string,
): Extract<ViewerWorkspaceAction, { readonly type: 'read-succeeded' }> {
  return {
    type: 'read-succeeded',
    id,
    workspaceGeneration,
    readGeneration,
    file: file(localPath('/repo/a.ts'), content),
  }
}

function file(path: ReturnType<typeof localPath>, content: string): ReadFileResponse {
  return {
    path,
    content,
    size: content.length,
    mtimeMs: 1,
    binary: false,
  }
}

function reduce(
  model: ViewerWorkspaceModel,
  action: ViewerWorkspaceAction,
): ViewerWorkspaceModel {
  return viewerWorkspaceReducer(model, action)
}
